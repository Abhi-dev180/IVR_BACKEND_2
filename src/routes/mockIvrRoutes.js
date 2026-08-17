import express from 'express';
import * as mockIvrController from '../controllers/mockIvrController.js';

const router = express.Router();

// Admin / Dashboard APIs
router.post('/config', mockIvrController.setMockIvrConfig);
router.get('/config', mockIvrController.getMockIvrConfig);

// Twilio Webhooks
router.post('/incoming', mockIvrController.handleIncomingCall);
router.post('/gather-card', mockIvrController.handleGatherCard);
router.post('/gather-cvv', mockIvrController.handleGatherCvv);

export default router;
