const { supabase } = require('../config/db');
const { broadcast } = require('../services/websocketService');

const PhoneLineModel = {
  // Add/register a new phone line
  async addPhoneLine(phoneNumber, maxAttempts = 100) {
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
  },

  // Get all registered phone lines
  async getAllPhoneLines() {
    const { data, error } = await supabase
      .from('phone_lines')
      .select('*')
      .order('id', { ascending: true });
    
    if (error) {
      console.error('Error in getAllPhoneLines:', error);
      throw error;
    }
    return data || [];
  },

  // Update phone line status (idle/busy)
  async updateLineStatus(lineId, status, currentAttemptId = null, additionalUpdates = {}) {
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
  },

  // Delete a phone line
  async deletePhoneLine(lineId) {
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
  },

  // Edit/Update a phone line's phone number
  async updatePhoneLine(lineId, phoneNumber) {
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
  }
};

module.exports = PhoneLineModel;
