import { supabase } from '../config/db.js';
import { broadcast } from '../services/websocketService.js';

// Add/register a new phone line
export const addPhoneLine = async (phoneNumber, maxAttempts = 100) => {
    const { data, error } = await supabase
      .from('phone_lines')
      .upsert({ phone_number: phoneNumber, max_attempts: maxAttempts, status: 'idle' }, { onConflict: 'phone_number' })
      .select()
      .single();
    
    if (error) {
      console.error('Error in addPhoneLine:', error);
      throw error;
    }
    
    broadcast('line_update', data);
    return data;
  };

  // Get all registered phone lines
  export const getAllPhoneLines = async () => {
    const { data, error } = await supabase
      .from('phone_lines')
      .select('*')
      .order('id', { ascending: true });
    
    if (error) {
      console.error('Error in getAllPhoneLines:', error);
      throw error;
    }
    return data || [];
  };

  // Update phone line status (idle/busy)
  export const updateLineStatus = async (lineId, status, currentAttemptId = null, additionalUpdates = {}) => {
    const { data, error } = await supabase
      .from('phone_lines')
      .update({
        status,
        current_attempt_id: currentAttemptId,
        updated_at: new Date().toISOString(),
        ...additionalUpdates
      })
      .eq('id', lineId)
      .select()
      .single();

    if (error) {
      console.error(`Error updating line status for ID ${lineId}:`, error);
      throw error;
    }

    broadcast('line_update', data);
    return data;
  };

  // Delete a phone line
  export const deletePhoneLine = async (lineId) => {
    const { data, error } = await supabase
      .from('phone_lines')
      .delete()
      .eq('id', lineId)
      .select()
      .maybeSingle();

    if (error) {
      console.error(`Error deleting line ID ${lineId}:`, error);
      throw error;
    }
    
    // Broadcast delete event (payload null or containing the deleted id)
    broadcast('line_delete', { id: lineId });
    return data;
  };

  // Edit/Update a phone line's phone number
  export const updatePhoneLine = async (lineId, phoneNumber) => {
    const { data, error } = await supabase
      .from('phone_lines')
      .update({ phone_number: phoneNumber, updated_at: new Date().toISOString() })
      .eq('id', lineId)
      .select()
      .single();

    if (error) {
      console.error(`Error updating line ID ${lineId}:`, error);
      throw error;
    }

    broadcast('line_update', data);
    return data;
  };
