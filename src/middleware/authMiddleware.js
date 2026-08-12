const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'super_secret_twilio_ivr_key';

module.exports = (req, res, next) => {
  // Get token from Authorization header
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    return res.status(401).json({ error: 'Access denied. No authorization header provided.' });
  }

  // Expecting format: Bearer <token>
  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ error: 'Access denied. Invalid token format.' });
  }

  const token = parts[1];

  try {
    // Verify token
    const decoded = jwt.verify(token, JWT_SECRET);
    req.admin = decoded; // Attach admin payload
    next();
  } catch (error) {
    console.error('JWT Verification failed:', error.message);
    return res.status(403).json({ error: 'Access denied. Invalid or expired token.' });
  }
};
