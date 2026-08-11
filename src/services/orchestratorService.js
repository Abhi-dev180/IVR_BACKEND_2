const twilio = require('twilio');
const AttemptModel = require('../models/attemptModel');
const { broadcast } = require('./websocketService');

// Initialize Twilio client if keys are present
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

let isCampaignRunning = false;
let workerInterval = null;
const MAX_RETRIES = 3;

const OrchestratorService = {
  isRunning() {
    return isCampaignRunning;
  },

  async startCampaign() {
    if (isCampaignRunning) return;
    isCampaignRunning = true;
    broadcast('campaign_status', { running: true });
    console.log('[Orchestrator] Campaign started.');
    
    // Run the orchestrator loop
    workerInterval = setInterval(async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error('[Orchestrator] Error in worker tick:', err);
      }
    }, 2000);
  },

  async stopCampaign() {
    if (!isCampaignRunning) return;
    isCampaignRunning = false;
    if (workerInterval) {
      clearInterval(workerInterval);
      workerInterval = null;
    }
    broadcast('campaign_status', { running: false });
    console.log('[Orchestrator] Campaign stopped.');
  },

  async tick() {
    if (!isCampaignRunning) return;

    // 1. Get all phone lines
    const lines = await AttemptModel.getAllPhoneLines();
    const idleLines = lines.filter(l => l.status === 'idle');

    if (idleLines.length === 0) {
      return; // All lines are busy
    }

    // 2. Process attempts for each idle line
    for (const line of idleLines) {
      // Claim the next queued or retry attempt
      const attempt = await AttemptModel.claimNextQueuedAttempt(line.id);
      if (!attempt) {
        // No queued attempts. Check if we have failed attempts that should be retried.
        await this.checkAndScheduleRetries();
        break; 
      }

      console.log(`[Orchestrator] Assigning Attempt #${attempt.id} to Phone Line ${line.phone_number}`);
      
      // Place the call
      this.executeCall(attempt, line);
    }
  },

  async executeCall(attempt, line) {
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
          statusCallbackMethod: 'POST'
        });

        await AttemptModel.updateCallSid(attempt.id, call.sid);
        await AttemptModel.addLog(attempt.id, `Call successfully placed via Twilio. SID: ${call.sid}`);
      } catch (err) {
        console.error(`[Orchestrator] Twilio Call failed for Attempt #${attempt.id}:`, err);
        await AttemptModel.addLog(attempt.id, `Twilio error: ${err.message}`);
        await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 0, { error: err.message });
      }
    }
  },

  async checkAndScheduleRetries() {
    // Look for attempts in the current run that have failed and have remaining retries
    const query = `
      UPDATE attempts
      SET status = 'retry', logs = array_append(logs, $1)
      WHERE status = 'failed' 
        AND retry_count < $2
      RETURNING *;
    `;
    const logMsg = `[${new Date().toISOString()}] Automatically rescheduled for retry.`;
    const res = await AttemptModel.pool.query(query, [logMsg, MAX_RETRIES]);
    
    if (res.rows.length > 0) {
      console.log(`[Orchestrator] Rescheduled ${res.rows.length} failed attempts for retry.`);
      res.rows.forEach(attempt => broadcast('attempt_update', attempt));
    }
  }
};

module.exports = OrchestratorService;
