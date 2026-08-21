import { supabase } from '../config/db.js';

// Helper to broadcast attempts with joined phone_number
const broadcastWithPhone = async (attemptId) => {
  const { data: fullAttempt } = await supabase
    .from('attempts')
    .select('*, phone_lines(phone_number)')
    .eq('id', attemptId)
    .single();
    
  if (fullAttempt) {
    const formatted = {
      ...fullAttempt,
      phone_number: fullAttempt.phone_lines ? fullAttempt.phone_lines.phone_number : null
    };
    broadcast('attempt_update', formatted);
    return formatted;
  }
  return null;
};
import { broadcast } from '../services/websocketService.js';
import * as PhoneLineModel from './phoneLineModel.js';

// Create a new test attempt
export const createAttempt = async (testValue, targetPhoneNumber) => {
    const initialLog = `[${new Date().toISOString()}] Attempt created. Status: queued.`;
    const { data, error } = await supabase
      .from('attempts')
      .insert({ test_value: testValue, target_phone_number: targetPhoneNumber, status: 'queued', logs: [initialLog] })
      .select()
      .single();
    
    if (error) {
      console.error('Error in createAttempt:', error);
      throw error;
    }
    
    broadcast('attempt_update', data);
    return data;
  };

  // Get attempts (with left-joined phone line numbers)
  export const getAttempts = async () => {
    const { data, error } = await supabase
      .from('attempts')
      .select('*, phone_lines(phone_number)')
      .order('updated_at', { ascending: false })
      .limit(1000);
    
    if (error) {
      console.error('Error in getAttempts:', error);
      throw error;
    }

    return (data || []).map(item => ({
      ...item,
      phone_number: item.phone_lines ? item.phone_lines.phone_number : null
    }));
  };

  // Assign attempt to a line
  export const assignAttemptToLine = async (attemptId, lineId) => {
    // Set phone line status to busy
    await PhoneLineModel.updateLineStatus(lineId, 'busy', attemptId);

    // Fetch attempt to get current logs
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const logMsg = `[${new Date().toISOString()}] Call assigned to line ID ${lineId}.`;
    const newLogs = [...(attempt.logs || []), logMsg];

    // Update attempt status to active and link line
    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        status: 'active',
        phone_line_id: lineId,
        updated_at: new Date().toISOString(),
        logs: newLogs
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;
    await broadcastWithPhone(updatedAttempt.id);

    return updatedAttempt;
  };

  // Update Call SID for an attempt
  export const updateCallSid = async (attemptId, callSid) => {
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const logMsg = `[${new Date().toISOString()}] Call initiated. Twilio Call SID: ${callSid}.`;
    const newLogs = [...(attempt.logs || []), logMsg];

    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        call_sid: callSid,
        updated_at: new Date().toISOString(),
        logs: newLogs
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;
    await broadcastWithPhone(updatedAttempt.id);
    return updatedAttempt;
  };

  // Find attempt by Call SID
  export const findAttemptByCallSid = async (callSid) => {
    const { data, error } = await supabase
      .from('attempts')
      .select('*')
      .eq('call_sid', callSid)
      .maybeSingle();
    
    if (error) throw error;
    return data;
  };

  // Add a log message to an attempt
  export const addLog = async (attemptId, logMessage) => {
    console.log(`[Attempt #${attemptId}] ${logMessage}`);
    const formattedLog = `[${new Date().toISOString()}] ${logMessage}`;

    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const newLogs = [...(attempt.logs || []), formattedLog];

    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        logs: newLogs,
        updated_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;
    await broadcastWithPhone(updatedAttempt.id);
    return updatedAttempt;
  };

  // Add multiple log messages to an attempt at once
  export const addLogs = async (attemptId, logMessagesArray) => {
    if (!logMessagesArray || logMessagesArray.length === 0) return null;
    
    logMessagesArray.forEach(msg => console.log(`[Attempt #${attemptId}] ${msg}`));
    const formattedLogs = logMessagesArray.map(msg => `[${new Date().toISOString()}] ${msg}`);

    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('logs')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const newLogs = [...(attempt.logs || []), ...formattedLogs];

    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        logs: newLogs,
        updated_at: new Date().toISOString()
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;
    await broadcastWithPhone(updatedAttempt.id);
    return updatedAttempt;
  };

  // Update test value and broadcast
  export const updateTestValue = async (attemptId, newTestValue) => {
    const { data: updatedAttempt, error } = await supabase
      .from('attempts')
      .update({ test_value: newTestValue, updated_at: new Date().toISOString() })
      .eq('id', attemptId)
      .select()
      .single();

    if (error) throw error;
    await broadcastWithPhone(updatedAttempt.id);
    return updatedAttempt;
  };

  // Create a batch of attempts from JSON targets
  export const createAttemptBatch = async (targets, batchId) => {
    const recordsToInsert = targets.map(t => ({
      target_phone_number: t.phone_number,
      test_value: t.test_value,
      target_test_code: t.target_test_code || null,
      batch_id: batchId,
      status: 'queued',
      logs: [`[${new Date().toISOString()}] Attempt created in batch: ${batchId}. Status: queued.`]
    }));

    const { data, error } = await supabase
      .from('attempts')
      .insert(recordsToInsert)
      .select();

    if (error) throw error;

    data.forEach(attempt => broadcast('attempt_update', attempt));
    return data;
  };

  // Claim next queued or retry attempt using PostgreSQL FOR UPDATE SKIP LOCKED
  export const claimNextQueuedAttempt = async (lineId) => {
    // We call the stored procedure to atomically lock and claim an attempt
    const { data: attempt, error: fetchErr } = await supabase
      .rpc('claim_next_attempt', { p_line_id: lineId });

    if (fetchErr) {
      console.warn('⚠️ RPC claim_next_attempt failed or missing. Falling back to non-atomic claim:', fetchErr.message);
      
      // Fallback: standard select and assign (less safe for high concurrency, but ensures system works without SQL script)
      let { data: fbAttempt } = await supabase
        .from('attempts')
        .select('*')
        .eq('status', 'queued')
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (!fbAttempt) {
        const { data: retryAttempt } = await supabase
          .from('attempts')
          .select('*')
          .eq('status', 'retry')
          .order('id', { ascending: true })
          .limit(1)
          .maybeSingle();
        fbAttempt = retryAttempt;
      }

      if (!fbAttempt) return null;

      // CRITICAL: Immediately mark as active BEFORE returning to prevent another tick from claiming same attempt
      const { error: lockErr } = await supabase
        .from('attempts')
        .update({ status: 'active', updated_at: new Date().toISOString() })
        .eq('id', fbAttempt.id)
        .eq('status', fbAttempt.status); // Only update if still in expected state (optimistic lock)
      
      if (lockErr) {
        console.warn('[AttemptModel] Failed to lock attempt, skipping:', lockErr.message);
        return null; // Another tick already claimed it
      }

      return await assignAttemptToLine(fbAttempt.id, lineId);
    }

    // Extract single attempt if RPC returned an array
    const claimedAttempt = Array.isArray(attempt) ? attempt[0] : attempt;

    if (!claimedAttempt || !claimedAttempt.id) return null;

    // Fetch the updated attempt details to get full logs etc.
    const { data: fullAttempt } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', claimedAttempt.id)
      .single();

    if (fullAttempt) {
      await broadcastWithPhone(fullAttempt.id);
      return fullAttempt;
    }
    
    return claimedAttempt;
  };

  // Update attempt status and duration
  export const updateAttemptStatus = async (attemptId, status, duration = 0, resultDetails = {}) => {
    const { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('*')
      .eq('id', attemptId)
      .single();
    if (fetchErr) throw fetchErr;

    const logMsg = `[${new Date().toISOString()}] Status updated to: ${status}.`;
    const newLogs = [...(attempt.logs || []), logMsg];

    const { data: updatedAttempt, error: attemptErr } = await supabase
      .from('attempts')
      .update({
        status: status,
        duration: duration,
        result_details: { ...(attempt.result_details || {}), ...resultDetails },
        updated_at: new Date().toISOString(),
        logs: newLogs
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;

    // If completing, failing, forcing a retry, or re-queuing a dropped call, free the phone line
    if (['completed', 'failed', 'retry', 'queued'].includes(status)) {
      const lineId = updatedAttempt?.phone_line_id;
      const { data: line } = await supabase
        .from('phone_lines')
        .select('id, attempts_processed')
        .or(`current_attempt_id.eq.${attemptId}${lineId ? `,id.eq.${lineId}` : ''}`)
        .maybeSingle();
      
      if (line) {
        await PhoneLineModel.updateLineStatus(line.id, 'idle', null, {
          attempts_processed: (line.attempts_processed || 0) + 1
        });
        console.log(`[AttemptModel] Freed Phone Line ID ${line.id} back to idle.`);
      }
    }

    await broadcastWithPhone(updatedAttempt.id);

    return updatedAttempt;
  };


