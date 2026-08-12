import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as PhoneLineModel from '../models/phoneLineModel.js';
import { broadcast } from './websocketService.js';
import { supabase } from '../config/db.js';

// Initialize Twilio client if keys are present
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

let isCampaignRunning = false;
let workerInterval = null;
const MAX_RETRIES = 3;

let campaignLineId = null;

export const isRunning = () => {
    return isCampaignRunning;
};

export const startCampaign = async (phoneNumberId) => {
    if (isCampaignRunning) return;
    isCampaignRunning = true;
    campaignLineId = phoneNumberId ? parseInt(phoneNumberId) : null;
    broadcast('campaign_status', { running: true });
    console.log(`[Orchestrator] Campaign started. Selected Line ID: ${campaignLineId || 'All'}`);
    
    // Run the orchestrator loop
    workerInterval = setInterval(async () => {
      try {
        await tick();
      } catch (err) {
        console.error('[Orchestrator] Error in worker tick:', err);
      }
    }, 2000);
};

export const stopCampaign = async () => {
    if (!isCampaignRunning) return;
    isCampaignRunning = false;
    campaignLineId = null; // Reset
    if (workerInterval) {
      clearInterval(workerInterval);
      workerInterval = null;
    }
    broadcast('campaign_status', { running: false });
    console.log('[Orchestrator] Campaign stopped.');
    
    // Hang up all active calls immediately
    await terminateActiveCalls();
};

export const terminateActiveCalls = async () => {
    console.log('[Orchestrator] Terminating active calls...');
    try {
      const { data: activeAttempts, error } = await supabase
        .from('attempts')
        .select('*')
        .eq('status', 'active');

      if (error || !activeAttempts || activeAttempts.length === 0) return;

      for (const attempt of activeAttempts) {
        await AttemptModel.addLog(attempt.id, 'Call manually hung up / aborted by operator.');
        
        // If it is a real Twilio call, update status to completed to force hang up
        if (client && attempt.call_sid && !attempt.call_sid.startsWith('MOCK_SID')) {
          try {
            await client.calls(attempt.call_sid).update({ status: 'completed' });
          } catch (err) {
            console.error(`Failed to force hangup Call SID ${attempt.call_sid} on Twilio:`, err.message);
          }
        }

        // Set state to failed/aborted
        await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 0, {
          error: 'Call terminated by operator'
        });
      }
    } catch (err) {
      console.error('[Orchestrator] Error terminating active calls:', err);
    }
};

export const tick = async () => {
    if (!isCampaignRunning) return;

    // 1. Get all phone lines
    const lines = await PhoneLineModel.getAllPhoneLines();
    const idleLines = lines.filter(l => l.status === 'idle' && (!campaignLineId || l.id === campaignLineId));

    if (idleLines.length === 0) {
      return; // All lines are busy
    }

    // 2. Process attempts for each idle line
    for (const line of idleLines) {
      // Claim the next queued or retry attempt
      const attempt = await AttemptModel.claimNextQueuedAttempt(line.id);
      if (!attempt) {
        // No queued attempts. Check if we have failed attempts that should be retried.
        await checkAndScheduleRetries();
        break; 
      }

      console.log(`[Orchestrator] Assigning Attempt #${attempt.id} to Phone Line ${line.phone_number}`);
      
      // Place the call
      executeCall(attempt, line);
    }
};

export const executeCall = async (attempt, line) => {
    const host = process.env.SERVER_URL || 'http://localhost:5000';

    if (!client) {
      // MOCK MODE
      console.log(`[Mock Mode] Simulating call from ${line.phone_number} to ${attempt.target_phone_number}`);
      await AttemptModel.addLog(attempt.id, `[Mock] Initiating call to target: ${attempt.target_phone_number}...`);

      setTimeout(async () => {
        const mockSid = `MOCK_SID_${Math.random().toString(36).substring(7).toUpperCase()}`;
        await AttemptModel.updateCallSid(attempt.id, mockSid);
        await AttemptModel.addLog(attempt.id, '[Mock] Call connected. Waiting 5s for IVR prompt...');

        setTimeout(async () => {
          await AttemptModel.addLog(attempt.id, `[Mock] IVR Prompt received. Transmitting 16-digit DTMF: ${attempt.test_value}`);

          setTimeout(async () => {
            // Decide outcome: 70% Success, 20% Failed, 10% Inconclusive/Pending
            const rand = Math.random();
            if (rand < 0.70) {
              await AttemptModel.addLog(attempt.id, '[Mock] Success: Expected confirmation tone detected.');
              await AttemptModel.updateAttemptStatus(attempt.id, 'completed', 15, { result: 'success' });
            } else if (rand < 0.90) {
              await AttemptModel.addLog(attempt.id, '[Mock] Failure: Busy tone or failed response phrase.');
              await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 12, { result: 'failed', error: 'Invalid response phrase' });
            } else {
              await AttemptModel.addLog(attempt.id, '[Mock] Inconclusive: Call timed out / pending.');
              await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 20, { result: 'inconclusive', error: 'Pending IVR response' });
            }
          }, 3000);

        }, 3000);

      }, 1000);

    } else {
      // REAL TWILIO CALL
      try {
        const call = await client.calls.create({
          url: `${host}/api/call/twiml/${attempt.id}`,
          to: attempt.target_phone_number,
          from: line.phone_number,
          statusCallback: `${host}/api/call/status-callback/${attempt.id}`,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallbackMethod: 'POST',
          record: true,
          recordingStatusCallback: `${host}/api/call/recording-callback/${attempt.id}`,
          recordingStatusCallbackMethod: 'POST'
        });

        await AttemptModel.updateCallSid(attempt.id, call.sid);
        await AttemptModel.addLog(attempt.id, `Call successfully placed via Twilio. SID: ${call.sid}`);
      } catch (err) {
        console.error(`[Orchestrator] Twilio Call failed for Attempt #${attempt.id}:`, err);
        await AttemptModel.addLog(attempt.id, `Twilio error: ${err.message}`);
        await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 0, { error: err.message });
      }
    }
};

export const checkAndScheduleRetries = async () => {
    // Look for attempts in the current run that have failed and have remaining retries
    const { data: failedAttempts, error: fetchErr } = await supabase
      .from('attempts')
      .select('*')
      .eq('status', 'failed')
      .lt('retry_count', MAX_RETRIES);

    if (fetchErr) {
      console.error('[Orchestrator] Error fetching attempts for retry:', fetchErr);
      return;
    }

    if (!failedAttempts || failedAttempts.length === 0) return;

    const rescheduled = [];
    const logMsg = `[${new Date().toISOString()}] Automatically rescheduled for retry.`;

    for (const attempt of failedAttempts) {
      const newLogs = [...(attempt.logs || []), logMsg];
      const { data: updatedAttempt, error: updateErr } = await supabase
        .from('attempts')
        .update({
          status: 'retry',
          logs: newLogs,
          updated_at: new Date().toISOString()
        })
        .eq('id', attempt.id)
        .select()
        .single();
      
      if (!updateErr && updatedAttempt) {
        rescheduled.push(updatedAttempt);
      }
    }

    if (rescheduled.length > 0) {
      console.log(`[Orchestrator] Rescheduled ${rescheduled.length} failed attempts for retry.`);
      rescheduled.forEach(attempt => broadcast('attempt_update', attempt));
    }
};
