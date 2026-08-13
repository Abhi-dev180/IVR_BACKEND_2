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
let maxRetries = 3;

let campaignLineId = null;

export const isRunning = () => {
    return isCampaignRunning;
};

export const startCampaign = async (phoneNumberId, maxRetriesVal = 3) => {
    if (isCampaignRunning) return;
    isCampaignRunning = true;
    maxRetries = maxRetriesVal;
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
        
        // Auto-stop campaign if there are absolutely no active, queued, or retry attempts left
        const { count, error } = await supabase
          .from('attempts')
          .select('*', { count: 'exact', head: true })
          .in('status', ['queued', 'retry', 'active']);
          
        if (!error && count === 0) {
          console.log('[Orchestrator] All queues are completely empty. Auto-stopping campaign.');
          await stopCampaign();
        }
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
      console.log(`[Orchestrator] Twilio credentials missing. Simulating Mock Call for Attempt #${attempt.id}...`);
      await AttemptModel.addLog(attempt.id, 'Running in Mock Mode. Simulating call...');
      
      setTimeout(async () => {
        await AttemptModel.updateCallSid(attempt.id, `MOCK_SID_${Date.now()}`);
        
        // Simulate different outcomes based on the test value for testing UI
        if (attempt.test_value && attempt.test_value.endsWith('FAILED')) {
          await AttemptModel.addLog(attempt.id, 'Mock Call: Invalid card number rejected by IVR.');
          await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 5, { error: 'Invalid card rejected' });
        } else if (attempt.test_value && attempt.test_value.endsWith('NOANSWER')) {
          await AttemptModel.addLog(attempt.id, 'Mock Call: The target IVR number did not answer.');
          await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 10, { error: 'No Answer' });
        } else {
          await AttemptModel.addLog(attempt.id, 'Mock Call Answered. Simulating wait...');
          setTimeout(async () => {
            await AttemptModel.addLog(attempt.id, `Mock DTMF Sent: ${attempt.test_value}`);
            await AttemptModel.updateAttemptStatus(attempt.id, 'completed', 15, { note: 'Mock successful run' });
          }, 3000);
        }
      }, 1500);

      return;
    }

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
};

export const checkAndScheduleRetries = async () => {
    // Look for attempts in the current run that have failed and have remaining retries
    const { data: failedAttempts, error: fetchErr } = await supabase
      .from('attempts')
      .select('*')
      .eq('status', 'failed')
      .lt('retry_count', maxRetries);

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
