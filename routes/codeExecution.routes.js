const express = require('express');
const codeExecutionController = require('../controllers/codeExecution.controller.js');
const verifyToken = require('../middleware/verifyToken.js'); // Only for register
const { verifySession } = require('../middleware/verifySession.js'); // For student routes

const router = express.Router();

// Health check endpoint (no auth)
router.get('/health', codeExecutionController.healthCheck);

// Run code endpoint (auth required)
router.post('/run', verifySession, codeExecutionController.runCode);

// Run code with test cases endpoint (auth required)
router.post('/run-tests', verifySession, codeExecutionController.runCodeWithTestCases);

// Test endpoint
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Code execution API is working',
    endpoints: {
      health: 'GET /api/code/health',
      run: 'POST /api/code/run',
      runTests: 'POST /api/code/run-tests',
      test: 'GET /api/code/test'
    }
  });
});

module.exports = router;
