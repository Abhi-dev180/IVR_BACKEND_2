import { supabase } from '../config/db.js';
import { broadcast } from '../services/websocketService.js';
import * as PhoneLineModel from './phoneLineModel.js';

// Create a new test attempt
export const createAttempt = async (testValue) => {
    const initialLog = `[${new Date().toISOString()}] Attempt created. Status: queued.`;
    const { data, error } = await supabase
      .from('attempts')
      .insert({ test_value: testValue, status: 'queued', logs: [initialLog] })
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
    broadcast('attempt_update', updatedAttempt);

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
    broadcast('attempt_update', updatedAttempt);
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
    broadcast('attempt_update', updatedAttempt);
    return updatedAttempt;
  };

  // Create a batch of attempts from JSON targets
  export const createAttemptBatch = async (targets, batchId) => {
    const inserted = [];
    
    for (const t of targets) {
      const logMsg = `[${new Date().toISOString()}] Attempt created in batch: ${batchId}. Status: queued.`;
      const { data, error } = await supabase
        .from('attempts')
        .insert({
          target_phone_number: t.phone_number,
          test_value: t.test_value,
          batch_id: batchId,
          status: 'queued',
          logs: [logMsg]
        })
        .select()
        .single();
      
      if (error) throw error;
      inserted.push(data);
    }
    
    inserted.forEach(attempt => broadcast('attempt_update', attempt));
    return inserted;
  };

  // Claim next queued or retry attempt
  export const claimNextQueuedAttempt = async (lineId) => {
    // 1. First look for new uncalled queued attempts
    let { data: attempt, error: fetchErr } = await supabase
      .from('attempts')
      .select('*')
      .eq('status', 'queued')
      .order('id', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (fetchErr) throw fetchErr;

    // 2. If no new queued attempts exist, look for retry attempts
    if (!attempt) {
      const { data: retryAttempt, error: retryErr } = await supabase
        .from('attempts')
        .select('*')
        .eq('status', 'retry')
        .order('id', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (retryErr) throw retryErr;
      attempt = retryAttempt;
    }

    if (!attempt) return null;
    // Assign to line
    return await assignAttemptToLine(attempt.id, lineId);
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
        result_details: resultDetails,
        updated_at: new Date().toISOString(),
        logs: newLogs
      })
      .eq('id', attemptId)
      .select()
      .single();

    if (attemptErr) throw attemptErr;

    // If completing or failing, free the phone line
    if (['completed', 'failed'].includes(status) && updatedAttempt && updatedAttempt.phone_line_id) {
      const { data: line, error: lineFetchErr } = await supabase
        .from('phone_lines')
        .select('attempts_processed')
        .eq('id', updatedAttempt.phone_line_id)
        .single();
      
      if (!lineFetchErr && line) {
        await PhoneLineModel.updateLineStatus(updatedAttempt.phone_line_id, 'idle', null, {
          attempts_processed: (line.attempts_processed || 0) + 1
        });
      }
    }

    broadcast('attempt_update', updatedAttempt);
    return updatedAttempt;
  };
