import 'dotenv/config';
import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as PhoneLineModel from '../models/phoneLineModel.js';
import { broadcast } from './websocketService.js';
import { supabase } from '../config/db.js';

import fs from 'fs';
import path from 'path';

// Lazy initialize Twilio client
const getTwilioClient = () => {
  let accountSid = process.env.TWILIO_ACCOUNT_SID;
  let authToken = process.env.TWILIO_AUTH_TOKEN;
  
  let debugLog = `--- Twilio Auth Debug ---\nInitial env SID: ${accountSid}\nInitial env Token: ${authToken}\n`;
  if (!accountSid || !authToken || accountSid.trim() === '' || authToken.trim() === '' || accountSid === 'undefined' || authToken === 'undefined') {
      try {
          const envPath = path.resolve(process.cwd(), '.env');
          debugLog += `CWD: ${process.cwd()}\nEnv Path: ${envPath}\nExists: ${fs.existsSync(envPath)}\n`;
          if (fs.existsSync(envPath)) {
              const envContent = fs.readFileSync(envPath, 'utf8');
              const sidMatch = envContent.match(/^TWILIO_ACCOUNT_SID=(.*)$/m);
              const tokenMatch = envContent.match(/^TWILIO_AUTH_TOKEN=(.*)$/m);
              debugLog += `SID Match: ${!!sidMatch}\nToken Match: ${!!tokenMatch}\n`;
              if (sidMatch && sidMatch[1].trim()) accountSid = sidMatch[1].trim();
              if (tokenMatch && tokenMatch[1].trim()) authToken = tokenMatch[1].trim();
              console.log('[DEBUG] Force loaded Twilio credentials from .env file directly.');
          }
      } catch (err) {
          debugLog += `Error: ${err.message}\n`;
          console.error('[DEBUG] Failed to force load .env', err);
      }
  }
  
  debugLog += `Final SID: ${accountSid}\nFinal Token length: ${authToken ? authToken.length : 0}\n`;
  fs.writeFileSync(path.resolve(process.cwd(), 'debug_twilio.txt'), debugLog);
  
  return accountSid && authToken && accountSid !== 'undefined' ? twilio(accountSid, authToken) : null;
};

let isCampaignRunning = false;
let isTickRunning = false; // Mutex to prevent double-call race condition
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
      if (isTickRunning) return; // Skip if previous tick still running
      isTickRunning = true;
      try {
        await tick();
      } catch (err) {
        console.error('[Orchestrator] Error in worker tick:', err);
      } finally {
        isTickRunning = false;
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
    
    // Cancel any pending attempts so they don't block the next run
    await cancelPendingAttempts();
};

export const cancelPendingAttempts = async () => {
    console.log('[Orchestrator] Canceling pending (queued/retry) attempts...');
    try {
        const { error } = await supabase
            .from('attempts')
            .update({ 
                status: 'canceled', 
                retry_count: 999, // Ensure they are never picked up by checkAndScheduleRetries
                logs: ['[System] Campaign stopped. Attempt canceled.'] 
            })
            .in('status', ['queued', 'retry']);
            
        if (error) {
            console.error('[Orchestrator] Failed to cancel pending attempts:', error);
        }
    } catch (err) {
        console.error('[Orchestrator] Error canceling pending attempts:', err);
    }
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
        const client = getTwilioClient();
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

    // STRICT 1-AT-A-TIME: Check if any call is currently active
    const { count: activeCount } = await supabase
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .in('status', ['active']);

    if (activeCount && activeCount > 0) {
      return; // A call is already in progress — wait for it to finish
    }

    // 1. Get all phone lines (only process 1 at a time)
    const lines = await PhoneLineModel.getAllPhoneLines();
    const idleLine = lines.find(l => l.status === 'idle' && (!campaignLineId || l.id === campaignLineId));

    if (!idleLine) {
      return; // No idle line available
    }

    // 2. Claim the next single queued attempt
    const attempt = await AttemptModel.claimNextQueuedAttempt(idleLine.id);
    if (!attempt) {
      // No queued attempts. Check if campaign should stop.
      await checkAndScheduleRetries();
      
      const { count, error } = await supabase
        .from('attempts')
        .select('*', { count: 'exact', head: true })
        .in('status', ['queued', 'retry', 'active']);
        
      if (!error && count === 0) {
        console.log('[Orchestrator] All queues are completely empty. Auto-stopping campaign.');
        await stopCampaign();
      }
      return;
    }

    console.log(`[Orchestrator] Assigning Attempt #${attempt.id} to Phone Line ${idleLine.phone_number}`);
    
    // Place the call (awaited so line is marked busy BEFORE next tick fires)
    await executeCall(attempt, idleLine);
};

export const executeCall = async (attempt, line) => {
    const host = process.env.SERVER_URL || 'http://localhost:5000';
    const client = getTwilioClient();

    if (!client) {
      const errMsg = 'Twilio credentials are missing! Mock mode has been removed. Please add TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN to .env or Render dashboard.';
      console.error(`[Orchestrator] ${errMsg}`);
      await AttemptModel.addLog(attempt.id, `FATAL ERROR: ${errMsg}`);
      await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 0, { error: errMsg });
      return;
    }

    // REAL TWILIO CALL
    try {
      const call = await client.calls.create({
        url: `${host}/api/call/twiml/${attempt.id}`,
        to: attempt.target_phone_number || '+18009838472',
        from: line.phone_number,
        statusCallback: `${host}/api/call/status-callback/${attempt.id}`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        record: true,
        recordingChannels: 'dual',
        recordingStatusCallback: `${host}/api/call/recording-callback/${attempt.id}`,
        recordingStatusCallbackMethod: 'POST'
      });

      await AttemptModel.updateCallSid(attempt.id, call.sid);
      await AttemptModel.addLog(attempt.id, `Call initiated to Target IVR (${attempt.target_phone_number || '+18009838472'}) from ${line.phone_number}. Twilio Call SID: ${call.sid}`);
    } catch (err) {
      console.error(`[Orchestrator] Twilio Call failed for Attempt #${attempt.id}:`, err);
      await AttemptModel.addLog(attempt.id, `Twilio error: ${err.message}`);
      await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 0, { error: err.message });
    }
};

export const checkAndScheduleRetries = async () => {
    // Retries disabled for 1-by-1 per-call strategy: Each failed test code attempt stays permanently 'failed'.
    // The system advances sequentially to the next code (001 -> 002 -> 003...) as a new call attempt.
    return;
};
