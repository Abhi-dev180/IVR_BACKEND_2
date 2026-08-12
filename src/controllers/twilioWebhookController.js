import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as transcriptionService from '../services/transcriptionService.js';
import { supabase } from '../config/db.js';

// Generate TwiML for when the call is answered (Interactive Verification Bot Flow)
export const getTwiML = async (req, res) => {
  const { attemptId } = req.params;
  try {
    const attempt = await AttemptModel.addLog(attemptId, 'Call connected. Initiating interactive gather prompt.');

    const twiml = new twilio.twiml.VoiceResponse();

    // 1st Gather attempt (20 seconds timeout)
    const gather1 = twiml.gather({
      action: `/api/call/verify-gather/${attemptId}`,
      numDigits: 16,
      timeout: 20,
      method: 'POST'
    });
    gather1.say("Hi, I am the automated verification bot. Please enter your 16-digit card number.");

    // 2nd Gather attempt (runs if first times out)
    const gather2 = twiml.gather({
      action: `/api/call/verify-gather/${attemptId}`,
      numDigits: 16,
      timeout: 20,
      method: 'POST'
    });
    gather2.say("We did not receive your input. Please enter your 16-digit card number now.");

    // Hangup if still no input after another 20s (Total 40s)
    twiml.say("No response received. Goodbye.");
    twiml.hangup();

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

// Webhook for handling interactive DTMF inputs from gather
export const handleGatherCallback = async (req, res) => {
  const { attemptId } = req.params;
  const { Digits } = req.body;

  try {
    await AttemptModel.addLog(attemptId, `User submitted DTMF card digits: ${Digits}`);

    // Fetch target attempt to verify
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', attemptId)
      .single();

    if (fetchErr || !attempt) {
      throw new Error(`Attempt #${attemptId} not found.`);
    }

    const twiml = new twilio.twiml.VoiceResponse();

    if (Digits === attempt.test_value) {
      // Success match
      await AttemptModel.addLog(attemptId, `🎉 Card verification successful! Input matched test value: ${attempt.test_value}`);
      await AttemptModel.updateAttemptStatus(attemptId, 'completed', 0, {
        input_digits: Digits,
        result: 'success',
        note: 'Interactive verification successful'
      });

      twiml.say("Thank you. Your card number has been successfully verified. Goodbye.");
    } else {
      // Mismatch
      await AttemptModel.addLog(attemptId, `❌ Card verification failed! Input (${Digits}) did not match expected: ${attempt.test_value}`);
      await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, {
        input_digits: Digits,
        result: 'failed',
        error: 'Digits mismatch'
      });

      twiml.say("Sorry, the card number entered does not match our records. Goodbye.");
    }

    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  } catch (error) {
    console.error('Error handling gather callback:', error);
    const twiml = new twilio.twiml.VoiceResponse();
    twiml.say("An error occurred during verification. Goodbye.");
    twiml.hangup();
    res.type('text/xml');
    return res.send(twiml.toString());
  }
};
