import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as PhoneLineModel from '../models/phoneLineModel.js';
import * as OrchestratorService from '../services/orchestratorService.js';
import fs from 'fs';

// Initialize Twilio client if keys are present
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = accountSid && authToken ? twilio(accountSid, authToken) : null;

// Get dashboard status
export const getDashboardStatus = async (req, res) => {
    try {
      const lines = await PhoneLineModel.getAllPhoneLines();
      const attempts = await AttemptModel.getAttempts();
      const campaignRunning = OrchestratorService.isRunning();
      
      // Augment busy lines with the target number they are currently calling
      lines.forEach(line => {
        if (line.status === 'busy' && line.current_attempt_id) {
          const activeAttempt = attempts.find(a => a.id === line.current_attempt_id);
          if (activeAttempt) {
            line.target_phone_number = activeAttempt.target_phone_number;
          }
        }
      });

      return res.status(200).json({ lines, attempts, campaignRunning });
    } catch (error) {
      console.error('Error fetching dashboard status:', error);
      return res.status(500).json({ error: error.message });
    }
  };

  // Initialize a phone line
  export const addPhoneLine = async (req, res) => {
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
  };



  // Start Single-Call Test code Brute Force Campaign
  export const startTestCodeBruteForce = async (req, res) => {
    const { phoneNumberId, sixteenDigit, toPhoneNumber, maxRetries } = req.body;
    try {
      const batchId = `Test code_${Date.now()}`;
      
      // Deterministically generate a target Test code based on the 16-digit card number
      let hash = 0;
      for (let i = 0; i < sixteenDigit.length; i++) {
          hash = (hash * 31 + sixteenDigit.charCodeAt(i)) % 1000;
      }
      // Ensure the hash is between 1 and 999
      if (hash === 0) hash = 1; 
      const randomTestCode = hash.toString().padStart(3, '0');

      // Create ONLY ONE target attempt.
      // We encode the starting Test code index in the test_value, e.g., '1234567812345678:001'
      const targets = [{
        phone_number: '+12495075171',
        test_value: `${sixteenDigit}:001`,
        target_test_code: randomTestCode
      }];
      
      // Auto-configure the Test IVR via Supabase
      const { supabase } = await import('../config/db.js');
      const { error: dbErr } = await supabase
        .from('mock_ivr_configs')
        .upsert({ id: 1, sixteenDigit: sixteenDigit, testCode: randomTestCode }, { onConflict: 'id' });
      if (dbErr) console.error('Failed to configure Test IVR:', dbErr);
      
      // Ensure no old/stuck queued attempts from previous runs get picked up
      await OrchestratorService.cancelPendingAttempts();

      await AttemptModel.createAttemptBatch(targets, batchId);
      OrchestratorService.startCampaign(phoneNumberId, maxRetries);

      return res.status(200).json({ message: 'Single-Call Test code Brute Force Campaign started.', batchId, targetCount: targets.length });
    } catch (error) {
      console.error('Error starting Test code campaign:', error);
      return res.status(500).json({ error: error.message });
    }
  };

  // Stop campaign
  export const stopCampaign = async (req, res) => {
    try {
      OrchestratorService.stopCampaign();
      return res.status(200).json({ message: 'Campaign stopped successfully.' });
    } catch (error) {
      console.error('Error stopping campaign:', error);
      return res.status(500).json({ error: error.message });
    }
  };

  // Delete a phone line
  export const deletePhoneLine = async (req, res) => {
    const { lineId } = req.params;
    try {
      await PhoneLineModel.deletePhoneLine(parseInt(lineId));
      return res.status(200).json({ message: 'Phone line deleted successfully.' });
    } catch (error) {
      console.error('Error deleting phone line:', error);
      return res.status(500).json({ error: error.message });
    }
  };

  // Edit/Update a phone line's phone number
  export const updatePhoneLine = async (req, res) => {
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
  };
