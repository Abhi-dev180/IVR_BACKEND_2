const twilio = require('twilio');
const AttemptModel = require('../models/attemptModel');
const PhoneLineModel = require('../models/phoneLineModel');
const OrchestratorService = require('../services/orchestratorService');

// Initialize Twilio client if keys are present
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

const CampaignController = {
  // Get dashboard status
  async getDashboardStatus(req, res) {
    try {
      const lines = await PhoneLineModel.getAllPhoneLines();
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
      const line = await PhoneLineModel.addPhoneLine(phoneNumber, maxAttempts);
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
      const lines = await PhoneLineModel.getAllPhoneLines();
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
        statusCallbackMethod: 'POST',
        record: true,
        recordingStatusCallback: `${host}/api/call/recording-callback/${attempt.id}`,
        recordingStatusCallbackMethod: 'POST'
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
    const { phoneNumberId } = req.body;
    try {
      const targets = require('../config/test_targets.json');
      const batchId = `batch-${Date.now()}`;
      
      // Load batch into database
      await AttemptModel.createAttemptBatch(targets, batchId);
      
      // Start orchestrator loop using the selected line
      OrchestratorService.startCampaign(phoneNumberId);

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

  // Delete a phone line
  async deletePhoneLine(req, res) {
    const { lineId } = req.params;
    try {
      await PhoneLineModel.deletePhoneLine(parseInt(lineId));
      return res.status(200).json({ message: 'Phone line deleted successfully.' });
    } catch (error) {
      console.error('Error deleting phone line:', error);
      return res.status(500).json({ error: error.message });
    }
  },

  // Edit/Update a phone line's phone number
  async updatePhoneLine(req, res) {
    const { lineId } = req.params;
    const { phoneNumber } = req.body;

    if (!phoneNumber || !/^\+?[1-9]\d{1,14}$/.test(phoneNumber)) {
      return res.status(400).json({ error: 'Invalid E.164 phone number format.' });
    }

    try {
      const line = await PhoneLineModel.updatePhoneLine(parseInt(lineId), phoneNumber);
      return res.status(200).json({ message: 'Phone line updated successfully.', line });
    } catch (error) {
      console.error('Error updating phone line:', error);
      return res.status(500).json({ error: error.message });
    }
  }
};

module.exports = CampaignController;
