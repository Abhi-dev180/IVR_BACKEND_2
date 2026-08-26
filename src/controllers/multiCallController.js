import * as MultiCallOrchestratorService from '../services/multiCallOrchestratorService.js';
import * as PhoneLineModel from '../models/phoneLineModel.js';

// Start Simultaneous Multi-Call Parallel Campaign
export const startMultiCallCampaign = async (req, res) => {
  const { lineIds, sixteenDigits, toPhoneNumber, maxRetries } = req.body;
  try {
    if (!lineIds || !Array.isArray(lineIds) || lineIds.length === 0) {
      return res.status(400).json({ error: 'Please select at least one outgoing phone line.' });
    }

    const result = await MultiCallOrchestratorService.startMultiCallCampaign({
      lineIds,
      sixteenDigits,
      toPhoneNumber: toPhoneNumber || '+18009838472',
      maxRetriesVal: parseInt(maxRetries) || 3
    });

    return res.status(200).json({
      message: `Simultaneous Multi-Call Campaign started across ${result.activeCallsCount} phone lines.`,
      batchId: result.batchId,
      activeCallsCount: result.activeCallsCount
    });
  } catch (error) {
    console.error('[MultiCallController] Error starting multi-call campaign:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Stop Simultaneous Multi-Call Campaign
export const stopMultiCallCampaign = async (req, res) => {
  try {
    await MultiCallOrchestratorService.stopMultiCallCampaign();
    return res.status(200).json({ message: 'Simultaneous Multi-Call Campaign stopped successfully.' });
  } catch (error) {
    console.error('[MultiCallController] Error stopping multi-call campaign:', error);
    return res.status(500).json({ error: error.message });
  }
};

// Get Multi-Call Campaign Status
export const getMultiCallStatus = async (req, res) => {
  try {
    const running = MultiCallOrchestratorService.isRunning();
    const activeLineIds = MultiCallOrchestratorService.getActiveLineIds();
    return res.status(200).json({ running, activeLineIds, activeCallsCount: activeLineIds.length });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
