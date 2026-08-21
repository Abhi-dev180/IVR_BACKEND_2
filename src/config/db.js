import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();
import bcrypt from 'bcryptjs';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey || supabaseKey.includes('YOUR_SUPABASE_SERVICE_ROLE_KEY')) {
  console.warn('\n======================================================');
  console.warn('WARNING: Missing or default SUPABASE_SERVICE_ROLE_KEY.');
  console.warn('Please fill in SUPABASE_SERVICE_ROLE_KEY in backend/.env');
  console.warn('======================================================\n');
}

const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder', {
  auth: {
    persistSession: false
  }
});

const initializeDatabase = async () => {
  console.log('Supabase HTTP client initialized successfully.');

  try {
    const { error: lineError } = await supabase
      .from('phone_lines')
      .update({ status: 'idle', current_attempt_id: null })
      .neq('id', 0); // Target all lines safely

    if (lineError) {
      console.error('Failed to reset phone lines status on boot:', lineError);
    } else {
      console.log('Successfully reset all phone lines status to idle on startup.');
    }

    // Crash Recovery: Reset stuck 'active' attempts to 'retry'
    const { error: attemptError } = await supabase
      .from('attempts')
      .update({ status: 'retry' })
      .eq('status', 'active');

    if (attemptError) {
      console.error('Failed to reset stuck attempts on boot:', attemptError);
    } else {
      console.log('Successfully swept stuck active attempts to retry.');
    }
  } catch (err) {
    console.error('Error during crash recovery on startup:', err);
  }

  // Verify admins table exists and seed default admin
  try {
    const { data: admins, error: selectError } = await supabase
      .from('admins')
      .select('*')
      .limit(1);

    if (selectError) {
      console.warn('\n======================================================');
      console.warn('WARNING: Could not fetch from "admins" table. It may not exist!');
      console.warn('Error details:', selectError.message);
      console.warn('Please run the following SQL command in your Supabase SQL Editor:');
      console.warn(`
        CREATE TABLE IF NOT EXISTS admins (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'admin',
          created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now())
        );
      `);
      console.warn('======================================================\n');
    } else {
      // Check if admin is already seeded
      const { data: adminCount, error: countErr } = await supabase
        .from('admins')
        .select('*', { count: 'exact', head: true });

      if (!countErr && (adminCount === 0 || adminCount === null)) {
        console.log('Seeding default administrator account...');
        const defaultHash = await bcrypt.hash('admin123', 10);
        const { error: insertError } = await supabase
          .from('admins')
          .insert({
            email: 'admin@gmail.com',
            password_hash: defaultHash,
            role: 'admin'
          });

        if (insertError) {
          console.error('Failed to seed default admin:', insertError.message);
        } else {
          console.log('Default admin seeded: admin@gmail.com / admin123');
        }
      }
    }
  } catch (err) {
    console.error('Error during database schema checks:', err);
  }

  // Auto-resume campaign if there are pending queued/retry attempts left over from a previous run
  try {
    const { count } = await supabase
      .from('attempts')
      .select('*', { count: 'exact', head: true })
      .in('status', ['queued', 'retry']);

    if (count && count > 0) {
      console.log(`[Startup] Found ${count} pending attempt(s). Auto-resuming campaign...`);
      // Dynamically import to avoid circular dependency
      const OrchestratorService = await import('../services/orchestratorService.js');
      OrchestratorService.startCampaign(null, 3);
    } else {
      console.log('[Startup] No pending attempts found. Waiting for new campaign.');
    }
  } catch (err) {
    console.error('[Startup] Error during auto-resume check:', err);
  }
};

export { supabase, initializeDatabase };
