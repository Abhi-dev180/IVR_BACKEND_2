const PHRASES = {
  card: [
    "please enter or say your card number",
    "enter or say your card number",
    "please enter your card number",
    "enter your 16 digit card number",
    "enter your sixteen digit card number"
  ],
  card_timeout: [
    "i'm sorry, i did not receive your response",
    "i am sorry, i did not receive your response",
    "did not receive your response"
  ],
  activate: [
    "press one to activate",
    "press 1 to activate",
    "to activate your credit card",
    "to activate your card",
    "if you'd like to activate",
    "would like to activate",
    "press or save one now",
    "press or say one now",
    "press or save 1 now",
    "press or say 1 now",
    "like to activate your credit card",
    "like to activate your card",
    "activate your credit card, press",
    "activate your credit card press",
    "activate your card, press",
    "activate your card press"
  ],
  code: [
    "please enter the three digit security code",
    "please enter the three-digit security code",
    "enter the three digit security code",
    "please enter or say the three digit",
    "please enter or say the three-digit",
    "enter or say the three digit",
    "enter or say the three-digit",
    "three digit security code"
  ],
  invalid: [
    "you have entered an invalid three digit",
    "you have entered an invalid three-digit",
    "entered an invalid three digit",
    "entered an invalid three-digit",
    "invalid three digit security code",
    "invalid three-digit security code"
  ],
  lockout: [
    "please call us back",
    "cannot activate your credit card",
    "we cannot activate your credit card",
    "please call us back with your card in hand",
    "call us back with your card in hand"
  ],
  exhausted_reject: [
    "we cannot validate the security code",
    "cannot validate the security code",
    "we are unable to validate",
    "we're unable to validate",
    "unable to validate the security code",
    "we cannot process your request",
    "cannot process your request at this time",
    "we are unable to process",
    "we're unable to process",
    "please try again later"
  ],
  expiry: [
    "expiry date",
    "expiration date",
    "four digit expiry",
    "four-digit expiry",
    "expiry date of",
    "enter or say the four digit expiry",
    "enter the four digit expiry",
    "credit card expiry",
    "please enter the credit card expiry",
    "enter the credit card expiry",
    "four digit expiry date of the new card to be activated",
    "please enter or say the four digit expiry date",
    "enter or say the four digit expiry date",
    "enter or say two digits for the month",
    "credit card expiry date is required",
    "enter or save the four digit expiry",
    "enter or save the four digit expiry date",
    "please enter or save the four digit",
    "four digit expiry date of the new card",
    "month and year"
  ],
  error: [
    "invalid card number",
    "invalid card",
    "invalid number",
    "entered an invalid",
    "i'm sorry, i did not",
    "did not receive your response",
    "not a valid",
    "cannot be processed",
    "please try again",
    "incorrect",
    "i'm sorry i did not",
    "i am sorry i did not",
    "sorry i did not",
    "did not receive",
    "i'm sorry i did",
    "sorry i did"
  ],
  voicemail: [
    "leave a message",
    "not available right now",
    "voice mail",
    "after the tone",
    "please leave",
    "mailbox",
    "person you're trying to reach is not available",
    "person you are trying to reach is not available",
    "reach is not available",
    "please record your message",
    "forwarded to voicemail",
    "forward it to voicemail",
    "at the tone",
    "you may hang up"
  ]
};

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Compile phrase arrays into global case-insensitive RegExps
const PATTERNS = {};
Object.keys(PHRASES).forEach(key => {
  const escaped = PHRASES[key].map(escapeRegExp).join('|');
  PATTERNS[key] = new RegExp(escaped, 'gi');
});

// Stage Constants
export const STAGE_LANGUAGE = "LANGUAGE";
export const STAGE_CARD = "CARD";
export const STAGE_ACTIVATE = "ACTIVATE";
export const STAGE_CODE = "CODE";
export const STAGE_EXPIRY = "EXPIRY";
export const STAGE_VOICEMAIL = "VOICEMAIL";

/**
 * Run deterministic phrase analysis on a transcript text.
 * @param {string} text - The transcribed IVR text.
 * @returns {object} - Analyzed signals and outcome decision.
 */
export function analyzeTranscript(text) {
  if (!text) {
    return {
      card_prompts: 0,
      card_timeouts: 0,
      activate_hits: 0,
      code_prompts: 0,
      invalid_codes: 0,
      lockout: false,
      expiry_prompt: false,
      exhausted_reject: false,
      voicemail: false,
      error_hits: 0,
      stage_reached: "no_transcript",
      outcome: "unknown"
    };
  }

  // Count matches helper
  const countMatches = (regex) => {
    regex.lastIndex = 0;
    const matches = text.match(regex);
    return matches ? matches.length : 0;
  };

  // Search helper
  const testMatch = (regex) => {
    regex.lastIndex = 0;
    return regex.test(text);
  };

  const card_prompts = countMatches(PATTERNS.card);
  const card_timeouts = countMatches(PATTERNS.card_timeout);
  const activate_hits = countMatches(PATTERNS.activate);
  const code_prompts = countMatches(PATTERNS.code);
  const invalid_codes = countMatches(PATTERNS.invalid);
  const error_hits = countMatches(PATTERNS.error);
  
  const lockout = testMatch(PATTERNS.lockout);
  const expiry_prompt = testMatch(PATTERNS.expiry);
  let exhausted_reject = testMatch(PATTERNS.exhausted_reject);
  const voicemail = testMatch(PATTERNS.voicemail);

  if (lockout) {
    exhausted_reject = false;
  }

  // Determine stage reached
  let stage = STAGE_LANGUAGE;
  if (voicemail && !(card_prompts || code_prompts || expiry_prompt)) {
    stage = STAGE_VOICEMAIL;
  } else if (expiry_prompt) {
    stage = STAGE_EXPIRY;
  } else if (invalid_codes > 0 || code_prompts > 0) {
    stage = STAGE_CODE;
  } else if (activate_hits > 0) {
    stage = STAGE_ACTIVATE;
  } else if (card_prompts > 0) {
    stage = STAGE_CARD;
  }

  // Determine outcome
  let outcome = "unknown";
  if (expiry_prompt && !lockout) {
    outcome = "winner";
  } else if (lockout) {
    outcome = "lockout";
  } else if (exhausted_reject) {
    outcome = "exhausted_reject";
  } else if (voicemail) {
    outcome = "voicemail";
  } else if (invalid_codes > 0) {
    outcome = "invalid";
  } else if ([STAGE_CARD, STAGE_ACTIVATE, STAGE_CODE].includes(stage)) {
    outcome = "stuck";
  }

  return {
    card_prompts,
    card_timeouts,
    activate_hits,
    code_prompts,
    invalid_codes,
    lockout,
    expiry_prompt,
    exhausted_reject,
    voicemail,
    error_hits,
    stage_reached: stage,
    outcome
  };
}


