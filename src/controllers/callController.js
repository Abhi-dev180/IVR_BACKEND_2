import 'dotenv/config';
import twilio from 'twilio';
import * as AttemptModel from '../models/attemptModel.js';
import * as OrchestratorService from '../services/orchestratorService.js';
import * as transcriptionService from '../services/transcriptionService.js';
import { supabase } from '../config/db.js';
import fs from 'fs';
import path from 'path';

// Lazy initialize Twilio client
const getTwilioClient = () => {
  let accountSid = process.env.TWILIO_ACCOUNT_SID;
  let authToken = process.env.TWILIO_AUTH_TOKEN;
  
  if (!accountSid || !authToken || accountSid.trim() === '' || authToken.trim() === '') {
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
          console.error('[DEBUG] Failed to force load .env', err);
      }
  }
  
  return accountSid && authToken ? twilio(accountSid, authToken) : null;
};

// Get dashboard status
export const getDashboardStatus = async (req, res) => {
    try {
      const lines = await AttemptModel.getAllPhoneLines();
      const attempts = await AttemptModel.getAttempts();
      const campaignRunning = OrchestratorService.isRunning();
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
      const line = await AttemptModel.addPhoneLine(phoneNumber, maxAttempts);
      return res.status(200).json({ message: 'Phone line added/updated', line });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  };

  // Trigger an outbound call (Milestone 1 Core Flow)
  export const triggerCall = async (req, res) => {
    const { testValue, phoneNumberId, toPhoneNumber } = req.body;

    // Security: Validate digits to prevent injection or invalid requests
    if (!testValue || !/^\d{1,16}$/.test(testValue)) {
      return res.status(400).json({ error: 'Test value must be a sequence of up to 16 numeric digits.' });
    }
    if (!phoneNumberId || isNaN(parseInt(phoneNumberId))) {
      return res.status(400).json({ error: 'Invalid phone line ID.' });
    }
    if (toPhoneNumber && !/^\+?[1-9]\d{1,14}$/.test(toPhoneNumber)) {
      return res.status(400).json({ error: 'Invalid target phone number format.' });
    }

    try {
      // 1. Create a persistent test attempt
      const attempt = await AttemptModel.createAttempt(testValue, toPhoneNumber || '+1234567890');
      
      // 2. Fetch/Validate the phone line
      const lines = await AttemptModel.getAllPhoneLines();
      const line = lines.find(l => l.id === parseInt(phoneNumberId)) || lines[0];

      if (!line) {
        return res.status(400).json({ error: 'No phone line configured.' });
      }

      // Assign attempt to line
      const updatedAttempt = await AttemptModel.assignAttemptToLine(attempt.id, line.id);

      // Base callback URL
      const host = process.env.SERVER_URL || `${req.protocol}://${req.get('host')}`;

      // 3. Initiate Twilio outbound call
      const client = getTwilioClient();
      if (!client) {
        // Mock execution if Twilio details are not configured yet
        console.log('Twilio credentials missing. Running in mock/simulation mode.');
        await AttemptModel.addLog(attempt.id, 'Running in Mock Mode. Simulating call...');
        
        // Simulate call progression in a timeout for verification
        setTimeout(async () => {
          await AttemptModel.updateCallSid(attempt.id, `MOCK_SID_${Date.now()}`);
          await AttemptModel.addLog(attempt.id, 'Mock Call Answered. Simulating wait...');
          
          setTimeout(async () => {
            await AttemptModel.addLog(attempt.id, `Mock DTMF Sent: ${testValue}`);
            await AttemptModel.updateAttemptStatus(attempt.id, 'completed', 15, { note: 'Mock successful run' });
          }, 3000);
        }, 1500);

        return res.status(200).json({
          message: 'Call initiated in mock simulation mode.',
          attempt: updatedAttempt
        });
      }

      const call = await client.calls.create({
        url: `${host}/api/call/twiml/${attempt.id}`,
        to: toPhoneNumber || '+1234567890',
        from: line.phone_number,
        statusCallback: `${host}/api/call/status-callback/${attempt.id}`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        record: true,
        recordingChannels: 'dual',
        recordingStatusCallback: `${host}/api/call/recording-callback/${attempt.id}`,
        recordingStatusCallbackMethod: 'POST'
      });

      // Update Call SID
      await AttemptModel.updateCallSid(attempt.id, call.sid);

      return res.status(200).json({
        message: 'Twilio call initiated successfully.',
        attempt: { ...updatedAttempt, call_sid: call.sid }
      });
    } catch (error) {
      console.error('Error placing outbound call:', error);
      return res.status(500).json({ error: error.message });
    }
  };

  // Start campaign from targets
  export const startCampaign = async (req, res) => {
    try {
      const targets = req.body.targets || [];
      const batchId = `batch-${Date.now()}`;
      
      // Load batch into database
      if (targets.length > 0) {
        await AttemptModel.createAttemptBatch(targets, batchId);
      }
      
      // Start orchestrator loop
      OrchestratorService.startCampaign();

      return res.status(200).json({ message: 'Campaign started successfully.', batchId });
    } catch (error) {
      console.error('Error starting campaign:', error);
      return res.status(500).json({ error: error.message });
    }
  };

  export const stopCampaign = async (req, res) => {
    try {
      OrchestratorService.stopCampaign();
      return res.status(200).json({ message: 'Campaign stopped successfully.' });
    } catch (error) {
      console.error('Error stopping campaign:', error);
      return res.status(500).json({ error: error.message });
    }
  };

// Local recordings directory setup
const RECORDINGS_DIR = path.resolve(process.cwd(), 'recordings');
if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

// Helper to fetch and cache audio recording to local disk
export const cacheAudioToDisk = async (attemptId, recordingUrl) => {
  const localFilePath = path.join(RECORDINGS_DIR, `attempt_${attemptId}.mp3`);
  if (fs.existsSync(localFilePath)) return localFilePath;

  let accountSid = process.env.TWILIO_ACCOUNT_SID;
  let authToken = process.env.TWILIO_AUTH_TOKEN;

  let authHeader = '';
  if (accountSid && authToken && accountSid !== 'undefined' && authToken !== 'undefined') {
    authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  } else {
    authHeader = 'Basic QUM0NWQ5ZTNjNGI3OThiNjE3YWE4ZGNjOGU4MmQ3ZjNkOjk3NTIzNTQ0M2I3MGE1Yjk2NjYyOGUwODg0NTEwMzBi';
  }
  const mp3Url = recordingUrl.endsWith('.mp3') ? recordingUrl : `${recordingUrl}.mp3`;

  try {
    const audioRes = await fetch(mp3Url, { headers: { Authorization: authHeader } });
    if (audioRes.ok) {
      const buffer = Buffer.from(await audioRes.arrayBuffer());
      fs.writeFileSync(localFilePath, buffer);
      console.log(`[Audio Cache] Successfully cached Attempt #${attemptId} recording (${buffer.length} bytes)`);
      return localFilePath;
    } else {
      console.warn(`[Audio Cache] Twilio returned status ${audioRes.status} for ${mp3Url}`);
    }
  } catch (err) {
    console.error(`[Audio Cache Error] Attempt #${attemptId}:`, err);
  }
  return null;
};

// Controller to stream audio recording safely bypassing Twilio auth and rate limits
export const streamAttemptAudio = async (req, res) => {
  const { attemptId } = req.params;
  const localFilePath = path.join(RECORDINGS_DIR, `attempt_${attemptId}.mp3`);

  try {
    // 1. Stream directly if file is cached locally
    if (fs.existsSync(localFilePath)) {
      const stat = fs.statSync(localFilePath);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      });
      return fs.createReadStream(localFilePath).pipe(res);
    }

    // 2. Query Supabase for attempt recording details
    const { data: attempt } = await supabase.from('attempts').select('recording_url, call_sid, result_details').eq('id', attemptId).single();
    if (!attempt) return res.status(404).send('Attempt not found');

    // Filter to find the actual raw Twilio URL (api.twilio.com), ignoring self-referencing proxy URLs
    let rawUrl = attempt.result_details?.raw_recording_url;
    if (!rawUrl || !rawUrl.includes('api.twilio.com')) {
      if (attempt.recording_url && attempt.recording_url.includes('api.twilio.com')) {
        rawUrl = attempt.recording_url;
      } else if (attempt.result_details?.recording_url && attempt.result_details.recording_url.includes('api.twilio.com')) {
        rawUrl = attempt.result_details.recording_url;
      } else {
        rawUrl = null;
      }
    }

    // 3. Fallback: Query Twilio API for recording SID if URL missing
    if (!rawUrl && attempt.call_sid) {
      const client = getTwilioClient();
      if (client) {
        try {
          const list = await client.recordings.list({ callSid: attempt.call_sid, limit: 1 });
          if (list && list.length > 0) {
            const accountSid = process.env.TWILIO_ACCOUNT_SID;
            rawUrl = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${list[0].sid}.mp3`;
          }
        } catch (err) {
          console.error('[Audio Proxy] Twilio recording fetch error:', err.message);
        }
      }
    }

    if (!rawUrl) return res.status(404).send('Recording not available');

    // 4. Download & cache to disk
    const cachedPath = await cacheAudioToDisk(attemptId, rawUrl);
    if (cachedPath && fs.existsSync(cachedPath)) {
      const stat = fs.statSync(cachedPath);
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': stat.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      });
      return fs.createReadStream(cachedPath).pipe(res);
    }

    return res.status(500).send('Failed to retrieve recording audio file.');
  } catch (error) {
    console.error(`[Audio Proxy Error] Attempt #${attemptId}:`, error);
    return res.status(500).send('Error streaming audio recording.');
  }
};





  