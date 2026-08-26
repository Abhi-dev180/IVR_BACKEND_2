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

  if (!accountSid || !authToken || accountSid.trim() === '' || accountSid === 'undefined') {
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf8');
        const sidMatch = envContent.match(/^TWILIO_ACCOUNT_SID=(.*)$/m);
        const tokenMatch = envContent.match(/^TWILIO_AUTH_TOKEN=(.*)$/m);
        if (sidMatch && sidMatch[1].trim()) accountSid = sidMatch[1].trim();
        if (tokenMatch && tokenMatch[1].trim()) authToken = tokenMatch[1].trim();
      }
    } catch (err) {
      console.error('[MultiCallOrchestrator] Error reading .env:', err);
    }
  }
  return accountSid && authToken && accountSid !== 'undefined' ? twilio(accountSid, authToken) : null;
};

let isMultiCallRunning = false;
let activeLineIds = [];
let maxRetries = 3;

export const isRunning = () => isMultiCallRunning;
export const getActiveLineIds = () => activeLineIds;

// Helper to assign a permanent target test code from current 20-code batch
const getOrAssignTargetCode = async (sixteenDigit) => {
  let assignedTargetCode = null;

  try {
    const { data: existingConfig } = await supabase
      .from('mock_ivr_configs')
      .select('*')
      .limit(1)
      .maybeSingle();

    if (existingConfig && (existingConfig.sixteenDigit === sixteenDigit || existingConfig.sixteen_digit === sixteenDigit) && (existingConfig.testCode || existingConfig.test_code)) {
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
        .like('test_value', `${sixteenDigit}:%`)
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
      const { data: allConfigs } = await supabase.from('mock_ivr_configs').select('testCode');
      const { data: allAttempts } = await supabase.from('attempts').select('target_test_code');

      const usedCodes = new Set();
      (allConfigs || []).forEach(c => { if (c.testCode) usedCodes.add(parseInt(c.testCode, 10)); });
      (allAttempts || []).forEach(a => { if (a.target_test_code) usedCodes.add(parseInt(a.target_test_code, 10)); });

      let batchStart = 1;
      while (true) {
        const batchEnd = batchStart + 19;
        const unusedInBatch = [];
        for (let num = batchStart; num <= batchEnd; num++) {
          if (!usedCodes.has(num)) {
            unusedInBatch.push(num);
          }
        }

        if (unusedInBatch.length > 0) {
          const randomIndex = Math.floor(Math.random() * unusedInBatch.length);
          const chosenCode = unusedInBatch[randomIndex];
          assignedTargetCode = chosenCode.toString().padStart(3, '0');
          break;
        }

        batchStart += 20;
      }
    } catch (e) {
      assignedTargetCode = '001';
    }
  }

  return assignedTargetCode || '001';
};

// Start Simultaneous Multi-Call Parallel Campaign
export const startMultiCallCampaign = async ({ lineIds, sixteenDigits, toPhoneNumber, maxRetriesVal = 3 }) => {
  if (isMultiCallRunning) {
    throw new Error('A multi-call campaign is already running.');
  }

  if (!lineIds || !Array.isArray(lineIds) || lineIds.length === 0) {
    throw new Error('Please select at least one outgoing phone line.');
  }

  const cards = Array.isArray(sixteenDigits) ? sixteenDigits : (sixteenDigits ? sixteenDigits.split(',').map(s => s.trim()).filter(Boolean) : ['4520340092380255']);
  const targetPhone = toPhoneNumber || '+18009838472';
  
  isMultiCallRunning = true;
  activeLineIds = lineIds.map(id => parseInt(id, 10));
  maxRetries = maxRetriesVal;

  broadcast('multi_call_status', { running: true, lineCount: activeLineIds.length });
  console.log(`[MultiCallOrchestrator] Starting Simultaneous Multi-Call Campaign across ${activeLineIds.length} phone lines.`);

  const batchId = `MultiCall_${Date.now()}`;
  const lines = await PhoneLineModel.getAllPhoneLines();
  const selectedLines = lines.filter(l => activeLineIds.includes(l.id));

  if (selectedLines.length === 0) {
    isMultiCallRunning = false;
    activeLineIds = [];
    throw new Error('None of the selected phone lines were found.');
  }

  // 🚀 SIMULTANEOUS PARALLEL EXECUTION: Dial all selected phone lines concurrently!
  const callPromises = selectedLines.map(async (line, index) => {
    try {
      const cardNum = cards[index % cards.length];
      const targetTestCode = await getOrAssignTargetCode(cardNum);

      // Determine starting code number for this card
      let startCodeNum = 1;
      const { data: existingAttempts } = await supabase
        .from('attempts')
        .select('test_value, result_details')
        .like('test_value', `${cardNum}:%`);

      if (existingAttempts && existingAttempts.length > 0) {
        let maxCode = 0;
        existingAttempts.forEach(row => {
          if (row.result_details?.codeTestedInCall && row.result_details?.highestCodeNumTested) {
            if (row.result_details.highestCodeNumTested > maxCode) maxCode = row.result_details.highestCodeNumTested;
          } else if (row.test_value && row.test_value.includes(':')) {
            const code = parseInt(row.test_value.split(':')[1], 10);
            if (!isNaN(code) && code > maxCode) maxCode = code;
          }
        });
        if (maxCode > 0) {
          startCodeNum = maxCode + 1;
        }
      }

      const firstCodeStr = startCodeNum.toString().padStart(3, '0');

      // Create and assign active attempt for this line immediately
      const { data: attempt, error: createErr } = await supabase
        .from('attempts')
        .insert([{
          batch_id: batchId,
          phone_line_id: line.id,
          target_phone_number: targetPhone,
          test_value: `${cardNum}:${firstCodeStr}`,
          target_test_code: targetTestCode,
          status: 'active',
          logs: [`[${new Date().toISOString()}] Simultaneous multi-call initiated on line ${line.phone_number}.`]
        }])
        .select()
        .single();

      if (createErr) throw createErr;

      // Immediately mark phone line busy
      await PhoneLineModel.updateLineStatus(line.id, 'busy', attempt.id);

      // Auto-configure Test IVR via Supabase
      await supabase
        .from('mock_ivr_configs')
        .upsert({ id: 1, sixteenDigit: cardNum, testCode: targetTestCode }, { onConflict: 'id' });

      // Execute Twilio call concurrently
      await executeMultiCall(attempt, line);
    } catch (err) {
      console.error(`[MultiCallOrchestrator] Error initiating call on line ${line.phone_number}:`, err.message);
    }
  });

  // Launch all Twilio calls simultaneously in parallel!
  await Promise.all(callPromises);
  return { batchId, activeCallsCount: selectedLines.length };
};

// Execute single Twilio call within multi-call parallel campaign
export const executeMultiCall = async (attempt, line) => {
  let host = process.env.SERVER_URL || 'https://ivr-backend-2.onrender.com';
  if (!host || host.includes('kpn9') || host.includes('localhost')) {
    host = 'https://ivr-backend-2.onrender.com';
  }
  const client = getTwilioClient();

  if (!client) {
    const errMsg = 'Twilio credentials missing!';
    console.error(`[MultiCallOrchestrator] ${errMsg}`);
    await AttemptModel.addLog(attempt.id, `FATAL ERROR: ${errMsg}`);
    await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 0, { error: errMsg });
    return;
  }

  const callerLineNumber = line.phone_number;
  const testCode = attempt.test_value ? attempt.test_value.split(':')[1] : '001';
  const url = `${host}/api/call/voice/${attempt.id}?testCode=${testCode}`;
  const statusCallback = `${host}/api/call/status-callback/${attempt.id}`;
  const recordingCallback = `${host}/api/call/recording-callback/${attempt.id}`;

  try {
    await AttemptModel.addLog(attempt.id, `Initiating parallel Twilio call from ${callerLineNumber} to ${attempt.target_phone_number}...`);
    
    const call = await client.calls.create({
      url,
      to: attempt.target_phone_number,
      from: callerLineNumber,
      statusCallback,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
      statusCallbackMethod: 'POST',
      record: true,
      recordingStatusCallback: recordingCallback,
      recordingStatusCallbackMethod: 'POST'
    });

    await AttemptModel.updateCallSid(attempt.id, call.sid);
    console.log(`[MultiCallOrchestrator] Parallel Call initiated! Call SID: ${call.sid} on Line: ${callerLineNumber}`);
  } catch (error) {
    console.error(`[MultiCallOrchestrator] Failed to initiate call on line ${callerLineNumber}:`, error.message);
    await AttemptModel.addLog(attempt.id, `Call initiation failed: ${error.message}`);
    await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 0, { error: error.message });
  }
};

// Stop Simultaneous Multi-Call Campaign
export const stopMultiCallCampaign = async () => {
  if (!isMultiCallRunning) return;
  isMultiCallRunning = false;

  console.log('[MultiCallOrchestrator] Stopping Simultaneous Multi-Call Campaign...');
  
  // Reset selected lines back to idle
  if (activeLineIds.length > 0) {
    try {
      await supabase
        .from('phone_lines')
        .update({ status: 'idle', current_attempt_id: null })
        .in('id', activeLineIds);
    } catch (err) {
      console.error('[MultiCallOrchestrator] Error resetting phone lines:', err);
    }
  }

  activeLineIds = [];
  broadcast('multi_call_status', { running: false });

  // Hang up any active multi-call attempts
  try {
    const client = getTwilioClient();
    if (client) {
      const { data: activeAttempts } = await supabase
        .from('attempts')
        .select('id, call_sid')
        .eq('status', 'active')
        .not('call_sid', 'is', null);

      if (activeAttempts && activeAttempts.length > 0) {
        for (const attempt of activeAttempts) {
          try {
            await client.calls(attempt.call_sid).update({ status: 'completed' });
            await AttemptModel.updateAttemptStatus(attempt.id, 'failed', 0, { error: 'Multi-Call Campaign stopped by user' });
          } catch (e) {
            console.warn(`[MultiCallOrchestrator] Could not hangup CallSid ${attempt.call_sid}:`, e.message);
          }
        }
      }
    }
  } catch (err) {
    console.error('[MultiCallOrchestrator] Error terminating active calls:', err);
  }
};
