const { Pool } = require('pg');
require('dotenv').config();

let connectionString = process.env.DATABASE_URL;

// Automatically map 'db' host to 'localhost' for local Windows execution
if (process.platform === 'win32' && connectionString && connectionString.includes('@db:')) {
  connectionString = connectionString.replace('@db:', '@localhost:');
}

const isLocalhost = connectionString && (connectionString.includes('localhost') || connectionString.includes('127.0.0.1'));

const pool = new Pool({
  connectionString,
  ssl: isLocalhost ? false : {
    rejectUnauthorized: false
  }
});

const initializeDatabase = async () => {
  const client = await pool.connect();
  try {
    console.log('Initializing database tables...');
    
    // Create phone_lines table
    await client.query(`
      CREATE TABLE IF NOT EXISTS phone_lines (
        id SERIAL PRIMARY KEY,
        phone_number VARCHAR(50) UNIQUE NOT NULL,
        status VARCHAR(50) DEFAULT 'idle',
        current_attempt_id INTEGER,
        max_attempts INTEGER DEFAULT 100,
        attempts_processed INTEGER DEFAULT 0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Create attempts table
    await client.query(`
      CREATE TABLE IF NOT EXISTS attempts (
        id SERIAL PRIMARY KEY,
        phone_line_id INTEGER REFERENCES phone_lines(id) ON DELETE SET NULL,
        target_phone_number VARCHAR(50),
        batch_id VARCHAR(100),
        test_value VARCHAR(50) NOT NULL,
        status VARCHAR(50) DEFAULT 'queued',
        call_sid VARCHAR(100) UNIQUE,
        logs TEXT[] DEFAULT '{}',
        duration INTEGER DEFAULT 0,
        result_details JSONB DEFAULT '{}',
        retry_count INTEGER DEFAULT 0,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Dynamic schema migration in case table already exists
    await client.query(`
      ALTER TABLE attempts ADD COLUMN IF NOT EXISTS target_phone_number VARCHAR(50);
      ALTER TABLE attempts ADD COLUMN IF NOT EXISTS batch_id VARCHAR(100);
      ALTER TABLE attempts ADD COLUMN IF NOT EXISTS retry_count INTEGER DEFAULT 0;
      ALTER TABLE attempts ADD COLUMN IF NOT EXISTS error_message TEXT;
    `);

    console.log('Database tables verified/created successfully.');
  } catch (error) {
    console.error('Error initializing database:', error);
  } finally {
    client.release();
  }
};

module.exports = {
  pool,
  initializeDatabase
};
