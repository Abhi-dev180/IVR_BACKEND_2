const { pool } = require('../config/db');
const { broadcast } = require('../services/websocketService');

const AttemptModel = {
  // Add a new phone line
  async addPhoneLine(phoneNumber, maxAttempts = 100) {
    const query = `
      INSERT INTO phone_lines (phone_number, max_attempts, status)
      VALUES ($1, $2, 'idle')
      ON CONFLICT (phone_number) DO UPDATE
      SET max_attempts = $2
      RETURNING *;
    `;
    const res = await pool.query(query, [phoneNumber, maxAttempts]);
    const row = res.rows[0];
    broadcast('line_update', row);
    return row;
  },

  // Get all phone lines
  async getAllPhoneLines() {
    const res = await pool.query('SELECT * FROM phone_lines ORDER BY id ASC');
    return res.rows;
  },

  // Create a new test attempt
  async createAttempt(testValue) {
    const query = `
      INSERT INTO attempts (test_value, status, logs)
      VALUES ($1, 'queued', $2)
      RETURNING *;
    `;
    const initialLog = `[${new Date().toISOString()}] Attempt created. Status: queued.`;
    const res = await pool.query(query, [testValue, [initialLog]]);
    const row = res.rows[0];
    broadcast('attempt_update', row);
    return row;
  },

  // Get attempts
  async getAttempts() {
    const res = await pool.query(`
      SELECT a.*, p.phone_number 
      FROM attempts a
      LEFT JOIN phone_lines p ON a.phone_line_id = p.id
      ORDER BY a.updated_at DESC
      LIMIT 100
    `);
    return res.rows;
  },

  // Assign attempt to an idle phone line (Milestone 1 basic single outbound flow)
  async assignAttemptToLine(attemptId, lineId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      // Update phone line status to busy
      await client.query(`
        UPDATE phone_lines 
        SET status = 'busy', current_attempt_id = $1, updated_at = NOW()
        WHERE id = $2
      `, [attemptId, lineId]);

      // Update attempt status to active and link line
      const res = await client.query(`
        UPDATE attempts 
        SET status = 'active', phone_line_id = $1, updated_at = NOW(),
            logs = array_append(logs, $2)
        WHERE id = $3
        RETURNING *
      `, [lineId, `[${new Date().toISOString()}] Call assigned to line ID ${lineId}.`, attemptId]);

      await client.query('COMMIT');
      
      const updatedAttempt = res.rows[0];
      broadcast('attempt_update', updatedAttempt);
      
      // Fetch and broadcast line status
      const lineRes = await pool.query('SELECT * FROM phone_lines WHERE id = $1', [lineId]);
      if (lineRes.rows[0]) {
        broadcast('line_update', lineRes.rows[0]);
      }

      return updatedAttempt;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // Update Call SID for an attempt
  async updateCallSid(attemptId, callSid) {
    const query = `
      UPDATE attempts 
      SET call_sid = $1, updated_at = NOW(),
          logs = array_append(logs, $2)
      WHERE id = $3
      RETURNING *;
    `;
    const logMsg = `[${new Date().toISOString()}] Call initiated. Twilio Call SID: ${callSid}.`;
    const res = await pool.query(query, [callSid, logMsg, attemptId]);
    const row = res.rows[0];
    broadcast('attempt_update', row);
    return row;
  },

  // Find attempt by Call SID
  async findAttemptByCallSid(callSid) {
    const res = await pool.query('SELECT * FROM attempts WHERE call_sid = $1', [callSid]);
    return res.rows[0];
  },

  // Add a log message to an attempt
  async addLog(attemptId, logMessage) {
    const query = `
      UPDATE attempts 
      SET logs = array_append(logs, $1), updated_at = NOW()
      WHERE id = $2
      RETURNING *;
    `;
    const formattedLog = `[${new Date().toISOString()}] ${logMessage}`;
    const res = await pool.query(query, [formattedLog, attemptId]);
    const row = res.rows[0];
    broadcast('attempt_update', row);
    return row;
  },

  // Create a batch of attempts from JSON targets
  async createAttemptBatch(targets, batchId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = [];
      for (const t of targets) {
        const query = `
          INSERT INTO attempts (target_phone_number, test_value, batch_id, status, logs)
          VALUES ($1, $2, $3, 'queued', $4)
          RETURNING *;
        `;
        const logMsg = `[${new Date().toISOString()}] Attempt created in batch: ${batchId}. Status: queued.`;
        const res = await client.query(query, [t.phone_number, t.test_value, batchId, [logMsg]]);
        inserted.push(res.rows[0]);
      }
      await client.query('COMMIT');
      
      inserted.forEach(attempt => broadcast('attempt_update', attempt));
      return inserted;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // Get next claimable attempt using skip locked
  async claimNextQueuedAttempt(lineId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      
      const attemptRes = await client.query(`
        SELECT * FROM attempts 
        WHERE status IN ('queued', 'retry') 
        ORDER BY id ASC 
        LIMIT 1 
        FOR UPDATE SKIP LOCKED
      `);
      
      const attempt = attemptRes.rows[0];
      if (!attempt) {
        await client.query('COMMIT');
        return null;
      }
      
      await client.query(`
        UPDATE phone_lines 
        SET status = 'busy', current_attempt_id = $1, updated_at = NOW()
        WHERE id = $2
      `, [attempt.id, lineId]);

      const logMsg = `[${new Date().toISOString()}] Claimed by line ID ${lineId}. Status: active.`;
      const res = await client.query(`
        UPDATE attempts 
        SET status = 'active', phone_line_id = $1, updated_at = NOW(),
            logs = array_append(logs, $2), retry_count = retry_count + 1
        WHERE id = $3
        RETURNING *
      `, [lineId, logMsg, attempt.id]);

      await client.query('COMMIT');
      
      const updatedAttempt = res.rows[0];
      broadcast('attempt_update', updatedAttempt);
      
      const lineRes = await pool.query('SELECT * FROM phone_lines WHERE id = $1', [lineId]);
      if (lineRes.rows[0]) {
        broadcast('line_update', lineRes.rows[0]);
      }

      return updatedAttempt;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  },

  // Update attempt status and duration
  async updateAttemptStatus(attemptId, status, duration = 0, resultDetails = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const logMsg = `[${new Date().toISOString()}] Status updated to: ${status}.`;
      
      const res = await client.query(`
        UPDATE attempts 
        SET status = $1, duration = $2, result_details = $3, updated_at = NOW(),
            logs = array_append(logs, $4)
        WHERE id = $5
        RETURNING *;
      `, [status, duration, resultDetails, logMsg, attemptId]);

      // If completing or failing, free the phone line
      if (['completed', 'failed'].includes(status)) {
        const attempt = res.rows[0];
        if (attempt && attempt.phone_line_id) {
          await client.query(`
            UPDATE phone_lines 
            SET status = 'idle', current_attempt_id = NULL, 
                attempts_processed = attempts_processed + 1, updated_at = NOW()
            WHERE id = $1
          `, [attempt.phone_line_id]);
        }
      }

      await client.query('COMMIT');
      
      const updatedAttempt = res.rows[0];
      broadcast('attempt_update', updatedAttempt);
      
      if (['completed', 'failed'].includes(status) && updatedAttempt && updatedAttempt.phone_line_id) {
        const lineRes = await pool.query('SELECT * FROM phone_lines WHERE id = $1', [updatedAttempt.phone_line_id]);
        if (lineRes.rows[0]) {
          broadcast('line_update', lineRes.rows[0]);
        }
      }

      return updatedAttempt;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
};

module.exports = AttemptModel;
