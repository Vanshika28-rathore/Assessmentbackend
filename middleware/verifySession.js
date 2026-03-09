const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';
const JWT_EXPIRY = '7d'; // 7 days

/**
 * Generate JWT session token after Firebase authentication
 */
const generateSessionToken = (user) => {
  const payload = {
    uid: user.uid || user.firebase_uid,
    email: user.email,
    role: user.role || 'student',
    studentId: user.id || user.student_id,
    type: 'session'
  };

  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
};

/**
 * Middleware to verify JWT session token
 * Use this for all routes except login/register
 */
const verifySession = async (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: No token provided',
      });
    }

    // Extract token
    const token = authHeader.split('Bearer ')[1];

    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Unauthorized: Invalid token format',
      });
    }

    // Verify JWT token
    const decoded = jwt.verify(token, JWT_SECRET);

    // Check if it's a session token (or accept tokens without type for backward compatibility)
    if (decoded.type && decoded.type !== 'session') {
      return res.status(401).json({
        success: false,
        message: 'Invalid token type',
      });
    }

    // Attach decoded token to request object
    req.user = decoded;
    req.firebaseUid = decoded.uid || decoded.firebase_uid;
    req.studentId = decoded.studentId || decoded.id;

    next();
  } catch (error) {
    console.error('Session verification error:', error);

    // Handle specific JWT errors
    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        message: 'Session expired. Please login again.',
        code: 'SESSION_EXPIRED'
      });
    }

    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        success: false,
        message: 'Invalid session token',
      });
    }

    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Invalid token',
      error: error.message,
    });
  }
};

module.exports = {
  verifySession,
  generateSessionToken,
  JWT_SECRET,
  JWT_EXPIRY
};
