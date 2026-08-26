import express from 'express';
const router = express.Router();
import * as CampaignController from '../controllers/campaignController.js';
import * as CallController from '../controllers/callController.js';
import * as TwilioWebhookController from '../controllers/twilioWebhookController.js';
import * as AuthController from '../controllers/authController.js';
import authMiddleware from '../middleware/authMiddleware.js';

// Auth routes
router.post('/auth/login', AuthController.login);
router.post('/auth/register', AuthController.register);

// Dashboard metrics & status
router.get('/status', authMiddleware, CampaignController.getDashboardStatus);

// Phone line registration, editing & deleting
router.post('/line', authMiddleware, CampaignController.addPhoneLine);
router.put('/line/:lineId', authMiddleware, CampaignController.updatePhoneLine);
router.delete('/line/:lineId', authMiddleware, CampaignController.deletePhoneLine);

import * as MultiCallController from '../controllers/multiCallController.js';

// Campaign controls (Single Call)
router.post('/campaign/start-test-code', authMiddleware, CampaignController.startTestCodeBruteForce);
router.post('/campaign/stop', authMiddleware, CampaignController.stopCampaign);

// Simultaneous Multi-Call Parallel Campaign routes
router.post('/multi-campaign/start', authMiddleware, MultiCallController.startMultiCallCampaign);
router.post('/multi-campaign/stop', authMiddleware, MultiCallController.stopMultiCallCampaign);
router.get('/multi-campaign/status', authMiddleware, MultiCallController.getMultiCallStatus);

// Debug control
router.post('/debug/clear-lines', async (req, res) => {
  const { supabase } = await import('../config/db.js');
  await supabase.from('phone_lines').update({ status: 'idle', current_attempt_id: null }).neq('id', 0);
  await supabase.from('attempts').update({ status: 'failed' }).in('status', ['active', 'queued']);
  import('../services/orchestratorService.js').then(module => module.stopCampaign());
  res.json({ message: 'Lines and stuck attempts cleared.' });
});

// Twilio dynamic TwiML response (Must remain public for Twilio)
router.post('/twiml/:attemptId', TwilioWebhookController.getTwiML);
router.get('/twiml/:attemptId', TwilioWebhookController.getTwiML); // support GET if manually testing

// Twilio webhook status callback
router.post('/status-callback/:attemptId', TwilioWebhookController.handleStatusCallback);

// Audio playback streaming endpoint (Public for audio element & download)
router.get('/audio/:attemptId', CallController.streamAttemptAudio);

// Twilio webhook recording callback
router.post('/recording-callback/:attemptId', TwilioWebhookController.handleRecordingCallback);

// Twilio webhook interactive listen callback (DEPRECATED)
router.post('/listen/:attemptId', TwilioWebhookController.handleInteractiveListen);

// Twilio webhook continuous try loop (legacy, kept for backwards compatibility)
router.post('/try/:attemptId', TwilioWebhookController.handleTryCode);

// Twilio speech-listening stage webhooks (active flow)
router.post('/listen-greeting/:attemptId', TwilioWebhookController.handleListenGreeting);
router.get('/listen-greeting/:attemptId', TwilioWebhookController.handleListenGreeting);
router.post('/listen-card/:attemptId', TwilioWebhookController.handleListenCard);
router.get('/listen-card/:attemptId', TwilioWebhookController.handleListenCard);
router.post('/listen-code/:attemptId', TwilioWebhookController.handleListenCode);
router.get('/listen-code/:attemptId', TwilioWebhookController.handleListenCode);

// Twilio Studio Webhook endpoint (uses CallSid)
router.post('/studio-webhook', TwilioWebhookController.handleStudioWebhook);

export default router;
