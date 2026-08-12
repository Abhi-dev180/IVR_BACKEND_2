const express = require('express');
const router = express.Router();
const CampaignController = require('../controllers/campaignController');
const TwilioWebhookController = require('../controllers/twilioWebhookController');
const AuthController = require('../controllers/authController');
const authMiddleware = require('../middleware/authMiddleware');

// Auth routes
router.post('/auth/login', AuthController.login);
router.post('/auth/register', AuthController.register);

// Dashboard metrics & status
router.get('/status', authMiddleware, CampaignController.getDashboardStatus);

// Phone line registration, editing & deleting
router.post('/line', authMiddleware, CampaignController.addPhoneLine);
router.put('/line/:lineId', authMiddleware, CampaignController.updatePhoneLine);
router.delete('/line/:lineId', authMiddleware, CampaignController.deletePhoneLine);

// Trigger a QA test call
router.post('/trigger', authMiddleware, CampaignController.triggerCall);

// Campaign controls
router.post('/campaign/start', authMiddleware, CampaignController.startCampaign);
router.post('/campaign/stop', authMiddleware, CampaignController.stopCampaign);

// Twilio dynamic TwiML response (Must remain public for Twilio)
router.post('/twiml/:attemptId', TwilioWebhookController.getTwiML);
router.get('/twiml/:attemptId', TwilioWebhookController.getTwiML); // support GET if manually testing

// Twilio webhook status callback
router.post('/status-callback/:attemptId', TwilioWebhookController.handleStatusCallback);

// Twilio webhook recording callback
router.post('/recording-callback/:attemptId', TwilioWebhookController.handleRecordingCallback);

// Twilio webhook interactive gather callback
router.post('/verify-gather/:attemptId', TwilioWebhookController.handleGatherCallback);

module.exports = router;
