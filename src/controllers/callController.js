const twilio = require('twilio');
const AttemptModel = require('../models/attemptModel');
const OrchestratorService = require('../services/orchestratorService');

// Initialize Twilio client if keys are present
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

const CallController = {
  // Get dashboard status
  async getDashboardStatus(req, res) {
    try {
      const lines = await AttemptModel.getAllPhoneLines();
      const attempts = await AttemptModel.getAttempts();
      const campaignRunning = OrchestratorService.isRunning();
      return res.status(200).json({ lines, attempts, campaignRunning });
    } catch (error) {
      console.error('Error fetching dashboard status:', error);
      return res.status(500).json({ error: error.message });
    }
  },

  // Initialize a phone line
  async addPhoneLine(req, res) {
    const { phoneNumber, maxAttempts } = req.body;
    
    // Security: Validate phone number format (E.164)
    if (!phoneNumber || !/^\+?[1-9]\d{1,14}$/.test(phoneNumber)) {
      return res.status(400).json({ error: 'Invalid E.164 phone number format.' });
    }

    try {
      const line = await AttemptModel.addPhoneLine(phoneNumber, maxAttempts);
      return res.status(200).json({ message: 'Phone line added/updated', line });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  },

  // Trigger an outbound call (Milestone 1 Core Flow)
  async triggerCall(req, res) {
    const { testValue, phoneNumberId, toPhoneNumber } = req.body;

    // Security: Validate digits to prevent injection or invalid requests
    if (!testValue || !/^\d{1,16}$/.test(testValue)) {
      return res.status(400).json({ error: 'Test value must be a sequence of up to 16 numeric digits.' });
    }
    if (!phoneNumberId || isNaN(parseInt(phoneNumberId))) {
      return res.status(400).json({ error: 'Invalid phone line ID.' });
    }
    if (toPhoneNumber && !/^\+?[1-9]\d{1,14}$/.test(toPhoneNumber)) {
      return res.status(400).json({ error: 'Invalid target phone number format.' });
    }

    try {
      // 1. Create a persistent test attempt
      const attempt = await AttemptModel.createAttempt(testValue);
      
      // 2. Fetch/Validate the phone line
      const lines = await AttemptModel.getAllPhoneLines();
      const line = lines.find(l => l.id === parseInt(phoneNumberId)) || lines[0];

      if (!line) {
        return res.status(400).json({ error: 'No phone line configured.' });
      }

      // Assign attempt to line
      const updatedAttempt = await AttemptModel.assignAttemptToLine(attempt.id, line.id);

      // Base callback URL
      const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;

      // 3. Initiate Twilio outbound call
      if (!client) {
        // Mock execution if Twilio details are not configured yet
        console.log('Twilio credentials missing. Running in mock/simulation mode.');
        await AttemptModel.addLog(attempt.id, 'Running in Mock Mode. Simulating call...');
        
        // Simulate call progression in a timeout for verification
        setTimeout(async () => {
          await AttemptModel.updateCallSid(attempt.id, `MOCK_SID_${Date.now()}`);
          await AttemptModel.addLog(attempt.id, 'Mock Call Answered. Simulating wait...');
          
          setTimeout(async () => {
            await AttemptModel.addLog(attempt.id, `Mock DTMF Sent: ${testValue}`);
            await AttemptModel.updateAttemptStatus(attempt.id, 'completed', 15, { note: 'Mock successful run' });
          }, 3000);
        }, 1500);

        return res.status(200).json({
          message: 'Call initiated in mock simulation mode.',
          attempt: updatedAttempt
        });
      }

      // Real Twilio Outbound Call
      const call = await client.calls.create({
        url: `${host}/api/call/twiml/${attempt.id}`,
        to: toPhoneNumber || '+1234567890', // Default fictitious/test IVR number
        from: line.phone_number,
        statusCallback: `${host}/api/call/status-callback/${attempt.id}`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST'
      });

      // Update Call SID
      await AttemptModel.updateCallSid(attempt.id, call.sid);

      return res.status(200).json({
        message: 'Twilio call initiated successfully.',
        attempt: { ...updatedAttempt, call_sid: call.sid }
      });
    } catch (error) {
      console.error('Error placing outbound call:', error);
      return res.status(500).json({ error: error.message });
    }
  },

  // Start campaign from JSON targets
  async startCampaign(req, res) {
    try {
      const targets = require('../config/test_targets.json');
      const batchId = `batch-${Date.now()}`;
      
      // Load batch into database
      await AttemptModel.createAttemptBatch(targets, batchId);
      
      // Start orchestrator loop
      OrchestratorService.startCampaign();

      return res.status(200).json({ message: 'Campaign started successfully.', batchId });
    } catch (error) {
      console.error('Error starting campaign:', error);
      return res.status(500).json({ error: error.message });
    }
  },

  // Stop campaign
  async stopCampaign(req, res) {
    try {
      OrchestratorService.stopCampaign();
      return res.status(200).json({ message: 'Campaign stopped successfully.' });
    } catch (error) {
      console.error('Error stopping campaign:', error);
      return res.status(500).json({ error: error.message });
    }
  },

  // Generate TwiML for when the call is answered
  async getTwiML(req, res) {
    const { attemptId } = req.params;
    try {
      const attempt = await AttemptModel.addLog(attemptId, 'Call answered by remote IVR. Preparing TwiML instructions.');
      
      const twiml = new twilio.twiml.VoiceResponse();
      twiml.say('Hello. This is the automated QA testing platform. Waiting 5 seconds before submitting digits.');
      twiml.pause({ length: 5 });
      
      // Submit DTMF digits
      twiml.say(`Submitting test value digits: ${attempt.test_value}`);
      twiml.play({ digits: attempt.test_value });
      
      twiml.say('Digits submitted. Ending test call.');
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
  },

  // Webhook for tracking call status updates from Twilio
  async handleStatusCallback(req, res) {
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
  }
};

module.exports = CallController;
