const rateLimit = require('express-rate-limit');

// API rate limiter - Per IP address
// Optimized for 230 students: 230 students × 150 requests/hour = 34,500
const apiLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: process.env.NODE_ENV === 'production' ? 40000 : 10000, // Increased for 230+ students
  message: {
    success: false,
    message: 'Too many requests from this IP, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path.startsWith('/health') || req.path.startsWith('/metrics'),
});

// Authentication rate limiter - Per IP address
// Optimized for 230 students logging in within 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Increased for 230+ students from same network
  message: {
    success: false,
    message: 'Too many authentication attempts, please try again after some time.',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

// Test submission rate limiter - Per IP address
// Optimized for 230 students submitting within 1 hour window
const submissionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 25000, // 230 students × 100 submissions (answers + progress saves)
  message: {
    success: false,
    message: 'Too many requests, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Proctoring frame rate limiter - Per IP per second
// Optimized for 230 students at 2 fps = 460 req/s
const proctoringLimiter = rateLimit({
  windowMs: 1000, // 1 second
  max: 1000, // Increased from 500 to handle 230 students at 2fps + buffer
  message: {
    success: false,
    message: 'Frame rate exceeded, please reduce proctoring frame rate.',
  },
  standardHeaders: false,
  legacyHeaders: false,
  skipFailedRequests: true,
});

// Admin operations rate limiter - Per IP address
const adminLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 1000, // 1000 admin operations per hour
  message: {
    success: false,
    message: 'Too many admin operations, please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  apiLimiter,
  authLimiter,
  submissionLimiter,
  proctoringLimiter,
  adminLimiter,
};