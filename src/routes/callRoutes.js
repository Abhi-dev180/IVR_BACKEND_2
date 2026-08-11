const express = require('express');
const router = express.Router();
const CallController = require('../controllers/callController');

// Dashboard metrics & status
router.get('/status', CallController.getDashboardStatus);

// Phone line registration
router.post('/line', CallController.addPhoneLine);

// Trigger a QA test call
router.post('/trigger', CallController.triggerCall);

// Campaign controls
router.post('/campaign/start', CallController.startCampaign);
router.post('/campaign/stop', CallController.stopCampaign);

// Twilio dynamic TwiML response
router.post('/twiml/:attemptId', CallController.getTwiML);
router.get('/twiml/:attemptId', CallController.getTwiML); // support GET if manually testing

// Twilio webhook status callback
router.post('/status-callback/:attemptId', CallController.handleStatusCallback);

module.exports = router;
