import twilio from 'twilio';
import * as MockIvrModel from '../models/mockIvrModel.js';

// Admin endpoint to set the 16-digit code and generate random CVV
export const setMockIvrConfig = async (req, res) => {
    const { sixteenDigit } = req.body;
    if (!sixteenDigit || !/^\d{16}$/.test(sixteenDigit)) {
        return res.status(400).json({ error: 'Valid 16-digit code is required.' });
    }

    // Generate random 3-digit CVV
    const randomCvv = Math.floor(Math.random() * 1000).toString().padStart(3, '0');
    
    try {
        const config = await MockIvrModel.saveConfig(sixteenDigit, randomCvv);
        return res.status(200).json({ message: 'Mock IVR Config updated successfully', config });
    } catch (error) {
        console.error('Error saving mock IVR config:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
};

export const getMockIvrConfig = async (req, res) => {
    try {
        const config = await MockIvrModel.getConfig();
        return res.status(200).json(config || {});
    } catch (error) {
        return res.status(500).json({ error: 'Internal server error' });
    }
};

// Twilio Webhooks
export const handleIncomingCall = async (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    
    const gather = twiml.gather({
        input: 'dtmf',
        numDigits: 16,
        action: '/api/mock-ivr/gather-card',
        method: 'POST',
        timeout: 20
    });
    
    gather.say('Welcome to the test bank. Please enter your 16 digit card number.');
    
    twiml.say('We didn\'t receive any input. Goodbye!');
    twiml.hangup();

    res.type('text/xml');
    return res.send(twiml.toString());
};

export const handleGatherCard = async (req, res) => {
    const { Digits } = req.body;
    const twiml = new twilio.twiml.VoiceResponse();
    
    const config = await MockIvrModel.getConfig();
    
    if (config && Digits === config.sixteenDigit) {
        const gather = twiml.gather({
            input: 'dtmf',
            numDigits: 3,
            action: '/api/mock-ivr/gather-cvv',
            method: 'POST',
            timeout: 20
        });
        gather.say('Card accepted. Please enter your 3 digit CVV.');
    } else {
        twiml.say('Invalid card number. Goodbye.');
        twiml.hangup();
    }
    
    res.type('text/xml');
    return res.send(twiml.toString());
};

export const handleGatherCvv = async (req, res) => {
    const { Digits } = req.body;
    const twiml = new twilio.twiml.VoiceResponse();
    
    const config = await MockIvrModel.getConfig();
    
    if (config && Digits === config.cvv) {
        twiml.say('CVV correct. Please enter your expiration date.');
        twiml.pause({ length: 3 }); // Pause to simulate wait for expiration date
        twiml.say('Thank you, your details are verified.');
        twiml.hangup();
    } else {
        const gather = twiml.gather({
            input: 'dtmf',
            numDigits: 3,
            action: '/api/mock-ivr/gather-cvv',
            method: 'POST',
            timeout: 20
        });
        gather.say('Incorrect.');
        twiml.say('We didn\'t receive any input. Goodbye!');
        twiml.hangup();
    }
    
    res.type('text/xml');
    return res.send(twiml.toString());
};
