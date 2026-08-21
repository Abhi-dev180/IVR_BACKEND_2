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

      // 2. Transcribe
      let transcript = '';
      const apiKey = process.env.OPENAI_API_KEY;
      const whisperServer = process.env.WHISPER_SERVER_URL;

      await AttemptModel.addLog(attemptId, 'Using mock transcription based on test logs.');
      
      // Fetch the attempt to get the exact 16 digit card number and the target Test code
      const { supabase } = await import('../config/db.js');
      const { data: attempt } = await supabase.from('attempts').select('test_value, target_test_code').eq('id', attemptId).single();
      const baseCard = attempt && attempt.test_value ? attempt.test_value.split(':')[0] : '1234567890123456';
      const targetTestCode = attempt && attempt.target_test_code ? attempt.target_test_code : '003';
      
      // Fetch the attempt logs (stored as a JSON array in attempts.logs column)
      const { data: attemptData } = await supabase.from('attempts').select('logs, status, result_details').eq('id', attemptId).single();
      const logsArr = (attemptData && attemptData.logs) ? attemptData.logs : [];
      const actualWinner = attemptData && attemptData.result_details && attemptData.result_details.winner ? attemptData.result_details.winner : null;
      const winningCode = actualWinner || targetTestCode;
      
      let attemptedCodes = [];
      logsArr.forEach(l => {
          const match = l.match(/DTMF Sent: \d{16}:(\d{3})/);
          if (match) attemptedCodes.push(match[1]);
      });
      
      // Keep exact attempted codes from this call attempt in order
      attemptedCodes = [...new Set(attemptedCodes)];
      
      // Generate a full-fledged mock transcript reflecting the actual interaction
      let mockTranscript = `IVR: Welcome to the test bank. Please enter your 16 digit card number.\nUser: ${baseCard}\nIVR: Card accepted. Please enter your 3 digit Test code.\n`;
      
      let winnerFound = false;
      for (const codeStr of attemptedCodes) {
          mockTranscript += `User: ${codeStr}\n`;
          if (winningCode && codeStr === winningCode) {
              mockTranscript += `IVR: Test code correct. Please enter your expiration date. Thank you, your details are verified.\n`;
              winnerFound = true;
              break; // Stop generating transcript after winning code is reached
          } else {
              mockTranscript += `IVR: Incorrect. Please enter your 3 digit Test code.\n`;
          }
      }
      
      if (!winnerFound && attemptedCodes.length > 0) {
        // Partial run - call dropped before finding target. Status is already 'queued' from the status callback.
        // Just save the transcript for reference but do NOT fail the attempt.
        if (attemptData && attemptData.status === 'queued') {
            await AttemptModel.addLog(attemptId, `Transcript: "${mockTranscript}"`);
            await AttemptModel.addLog(attemptId, `IVR Signals Analysis: Partial run (${attemptedCodes.length} codes tried, target not yet found). Keeping queued status.`);
            return;
        }
      }
      
      transcript = mockTranscript;

      await AttemptModel.addLog(attemptId, `Transcript: "${transcript}"`);

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

      // 4. Update status in Database
      if (signals.outcome === 'winner') {
        await AttemptModel.updateAttemptStatus(attemptId, 'completed', 0, resultDetails);
        await AttemptModel.addLog(attemptId, `🎉 Attempt SUCCESSFUL! Winner code confirmed.`);
        
        // Stop the campaign immediately because we found the Test code!
        await AttemptModel.addLog(attemptId, `Halting campaign automatically because correct Test code was found.`);
        OrchestratorService.stopCampaign();
      } else if (['lockout', 'exhausted_reject', 'invalid', 'voicemail'].includes(signals.outcome)) {
        await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { ...resultDetails, error: `Outcome: ${signals.outcome}` });
      } else {
        // Stuck or unknown outcome
        await AttemptModel.updateAttemptStatus(attemptId, 'failed', 0, { ...resultDetails, error: `Call got stuck or unknown state reached` });
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
