const admin = require('../config/firebase');

/**
 * Middleware to verify Firebase ID token
 * Expects Authorization header: "Bearer <token>"
 */
const verifyToken = async (req, res, next) => {
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

        // Verify token with Firebase Admin
        const decodedToken = await admin.auth().verifyIdToken(token);

        // Attach decoded token to request object for use in route handlers
        req.user = decodedToken;
        req.firebaseUid = decodedToken.uid;
        req.firebaseEmail = decodedToken.email; // Extract email for admin check

        next();
    } catch (error) {
        console.error('Token verification error:', error);

        // Handle specific Firebase errors
        if (error.code === 'auth/id-token-expired') {
            return res.status(401).json({
                success: false,
                message: 'Token expired. Please login again.',
            });
        }

        if (error.code === 'auth/argument-error') {
            return res.status(401).json({
                success: false,
                message: 'Invalid token format',
            });
        }

        return res.status(401).json({
            success: false,
            message: 'Unauthorized: Invalid token',
            error: error.message,
        });
    }
};

module.exports = verifyToken;
