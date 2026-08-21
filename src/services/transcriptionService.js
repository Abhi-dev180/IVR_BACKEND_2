import fs from 'fs';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import { pipeline } from 'stream';
import * as AttemptModel from '../models/attemptModel.js';
import * as ivrSignals from './ivrSignalsService.js';
import * as OrchestratorService from './orchestratorService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure audio directory exists
const AUDIO_DIR = path.join(__dirname, '../../audio_files');
if (!fs.existsSync(AUDIO_DIR)) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
}

  /**
   * Main entrypoint for processing recording webhook.
   */
  export const processRecording = async (attemptId, recordingUrl) => {
    try {
      await AttemptModel.addLog(attemptId, 'Downloading recording from Twilio...');
      
      const fileExtension = '.mp3'; // Twilio records in mp3/wav
      const localFilePath = path.join(AUDIO_DIR, `attempt_${attemptId}${fileExtension}`);

      // 1. Download file
      await downloadFile(recordingUrl, localFilePath);
      await AttemptModel.addLog(attemptId, `Recording saved locally to: ${path.basename(localFilePath)}`);

      // Fetch attempt data for card, target code, logs and result details
      const { supabase } = await import('../config/db.js');
      const { data: attempt } = await supabase.from('attempts').select('test_value, target_test_code').eq('id', attemptId).single();
      const baseCard = attempt && attempt.test_value ? attempt.test_value.split(':')[0] : '1234567890123456';
      const targetTestCode = attempt && attempt.target_test_code ? attempt.target_test_code : '003';
      
      const { data: attemptData } = await supabase.from('attempts').select('logs, status, result_details').eq('id', attemptId).single();
      const logsArr = (attemptData && attemptData.logs) ? attemptData.logs : [];
      const actualWinner = attemptData && attemptData.result_details && attemptData.result_details.winner ? attemptData.result_details.winner : null;
      const winningCode = actualWinner || targetTestCode;
      
      let attemptedCodes = [];
      logsArr.forEach(l => {
          const match = l.match(/DTMF Sent: \d{16}:(\d{3})/);
          if (match) attemptedCodes.push(match[1]);
      });
      attemptedCodes = [...new Set(attemptedCodes)];

      // 2. Transcribe real audio recording using Speech-to-Text API if configured
      let transcript = '';
      const apiKey = process.env.OPENAI_API_KEY;
      const whisperServer = process.env.WHISPER_SERVER_URL;

      if (apiKey && apiKey.trim() !== '' && apiKey !== 'undefined') {
        try {
          await AttemptModel.addLog(attemptId, 'Transcribing real audio recording via OpenAI Whisper Speech-to-Text API...');
          transcript = await transcribeOpenAI(localFilePath, apiKey);
          if (transcript && transcript.trim() !== '') {
            await AttemptModel.addLog(attemptId, `Real Audio Speech Transcript: "${transcript}"`);
          }
        } catch (apiErr) {
          console.warn(`[TranscriptionService] OpenAI Whisper failed: ${apiErr.message}.`);
          await AttemptModel.addLog(attemptId, `OpenAI Whisper notice: ${apiErr.message}`);
        }
      } else if (whisperServer && whisperServer.trim() !== '' && whisperServer.includes('localhost:5001')) {
        try {
          await AttemptModel.addLog(attemptId, `Transcribing audio recording via Whisper server (${whisperServer})...`);
          transcript = await transcribeLocalWhisperServer(localFilePath, whisperServer);
          if (transcript && transcript.trim() !== '') {
            await AttemptModel.addLog(attemptId, `Whisper Audio Speech Transcript: "${transcript}"`);
          }
        } catch (serverErr) {
          console.warn(`[TranscriptionService] Local Whisper failed: ${serverErr.message}`);
        }
      }

      if (!transcript || transcript.trim() === '') {
        // First priority: use the live dialogue transcript already built during the call (IVR/User format)
        const liveTranscript = attemptData?.result_details?.transcript || '';
        if (liveTranscript && liveTranscript.trim() !== '') {
          transcript = liveTranscript;
        } else {
          // Fallback: aggregate real IVR speech events from execution logs
          const realEvents = logsArr
            .filter(l => l.includes('IVR (') || l.includes('User (DTMF)'))
            .map(l => {
              // Strip timestamp prefix like "[2026-08-21T05:58:03.954Z] "
              return l.replace(/^\[[\d\-T:.Z]+\]\s*/, '');
            });
          transcript = realEvents.length > 0 ? realEvents.join('\n') : 'No spoken speech captured in recording.';
        }
      }
      
      const isWinner = actualWinner && attemptedCodes.includes(actualWinner);
      
      if (!isWinner && attemptedCodes.length > 0) {
        if (attemptData && attemptData.status === 'queued') {
            await AttemptModel.addLog(attemptId, `Recording saved (${attemptedCodes.length} codes tried, target not yet found). Continuing to next code...`);
            return;
        }
      }
      
      // 3. Analyze Transcript
      const signals = ivrSignals.analyzeTranscript(transcript);
      await AttemptModel.addLog(attemptId, `IVR Signals Analysis completed. Outcome: ${signals.outcome}, Stage: ${signals.stage_reached}`);

      // Save transcript and result details to database
      const resultDetails = {
        transcript,
        signals,
        local_audio_path: localFilePath,
        recording_url: recordingUrl
      };

      // 4. Update status / result details in Database
      if (signals.outcome === 'winner') {
        await AttemptModel.updateAttemptStatus(attemptId, 'completed', 0, resultDetails);
        await AttemptModel.addLog(attemptId, `🎉 Attempt SUCCESSFUL! Winner code confirmed.`);
        await AttemptModel.addLog(attemptId, `Halting campaign automatically because correct Test code was found.`);
        OrchestratorService.stopCampaign();
      } else if (['lockout', 'exhausted_reject', 'invalid', 'voicemail'].includes(signals.outcome)) {
        await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { ...resultDetails, error: `Outcome: ${signals.outcome}` });
      } else {
        // Save recording URL, local audio path, and transcript cleanly into result_details
        const { data: currentAttempt } = await supabase.from('attempts').select('status, result_details').eq('id', attemptId).single();
        await supabase.from('attempts').update({ 
          result_details: { ...(currentAttempt?.result_details || {}), ...resultDetails }
        }).eq('id', attemptId);
        await AttemptModel.addLog(attemptId, `Recording saved for Attempt #${attemptId}.`);
      }

    } catch (error) {
      console.error(`[TranscriptionService] Error processing attempt #${attemptId}:`, error);
      await AttemptModel.addLog(attemptId, `Transcription/Analysis error: ${error.message}`);
      await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { error: error.message });
    }
  };

  /**
   * Download helper
   */
  export const downloadFile = (url, destPath) => {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      
      const accountSid = process.env.TWILIO_ACCOUNT_SID;
      const authToken = process.env.TWILIO_AUTH_TOKEN;
      const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
      
      const options = {
        headers: {
            'Authorization': `Basic ${auth}`
        }
      };
      
      https.get(url, options, (response) => {
        if (response.statusCode === 302) {
          // Follow redirect if Twilio redirects to S3
          https.get(response.headers.location, (redirectResponse) => {
             if (redirectResponse.statusCode !== 200) {
               reject(new Error(`Failed to download file after redirect. HTTP Status: ${redirectResponse.statusCode}`));
               return;
             }
             pipeline(redirectResponse, file, (err) => {
               if (err) reject(err);
               else resolve();
             });
          }).on('error', reject);
        } else if (response.statusCode !== 200) {
          reject(new Error(`Failed to download file. HTTP Status: ${response.statusCode}`));
          return;
        } else {
            pipeline(response, file, (err) => {
            if (err) reject(err);
            else resolve();
            });
        }
      }).on('error', reject);
    });
  };

  /**
   * OpenAI Whisper API transcription
   */
  export const transcribeOpenAI = (filePath, apiKey) => {
    return new Promise((resolve, reject) => {
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      const fsReader = fs.createReadStream(filePath);
      
      const options = {
        hostname: 'api.openai.com',
        path: '/v1/audio/transcriptions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            const data = JSON.parse(body);
            if (data.error) {
              reject(new Error(data.error.message));
            } else {
              resolve(data.text || '');
            }
          } catch (e) {
            reject(new Error(`Failed to parse OpenAI response: ${body}`));
          }
        });
      });

      req.on('error', reject);

      // Write multi-part form data body
      req.write(`--${boundary}\r\n`);
      req.write(`Content-Disposition: form-data; name="file"; filename="${path.basename(filePath)}"\r\n`);
      req.write(`Content-Type: audio/mpeg\r\n\r\n`);
      
      fsReader.pipe(req, { end: false });
      fsReader.on('end', () => {
        req.write(`\r\n--${boundary}\r\n`);
        req.write(`Content-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`);
        req.write(`--${boundary}--\r\n`);
        req.end();
      });
    });
  };

  /**
   * Local Whisper server transcription
   */
  export const transcribeLocalWhisperServer = (filePath, serverUrl) => {
    return new Promise((resolve, reject) => {
      const parsedUrl = new URL(serverUrl);
      const boundary = '----WebKitFormBoundary' + Math.random().toString(36).substring(2);
      const fsReader = fs.createReadStream(filePath);

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try {
            // Assume server responds with plain text or JSON
            if (body.startsWith('{')) {
              const data = JSON.parse(body);
              resolve(data.text || body);
            } else {
              resolve(body.trim());
            }
          } catch (e) {
            resolve(body.trim());
          }
        });
      });

      req.on('error', reject);

      req.write(`--${boundary}\r\n`);
      req.write(`Content-Disposition: form-data; name="audio"; filename="${path.basename(filePath)}"\r\n`);
      req.write(`Content-Type: audio/mpeg\r\n\r\n`);

      fsReader.pipe(req, { end: false });
      fsReader.on('end', () => {
        req.write(`\r\n--${boundary}--\r\n`);
        req.end();
      });
    });
  };
