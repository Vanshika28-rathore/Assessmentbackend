const codeExecutionService = require("../services/codeExecution.service.js");

class CodeExecutionController {
  async runCode(req, res) {
    try {
      console.log('Received code execution request');
      
      const { code, language, input } = req.body;
      
      if (!code || !language) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields: code and language' 
        });
      }
      
      if (code.length > 10000) {
        return res.status(400).json({ 
          success: false, 
          error: 'Code too large (max 10000 characters)' 
        });
      }
      
      console.log(`Executing ${language} code (${code.length} chars)`);
      
      let result;
      if (input !== undefined && input !== null) {
        // Execute with input
        result = await codeExecutionService.executeCodeWithInput(code, language, input);
      } else {
        // Execute without input
        result = await codeExecutionService.executeCode(code, language);
      }
      
      console.log(`Execution completed: ${result.success ? 'SUCCESS' : 'FAILED'}`);
      
      res.json({
        success: true,
        data: result
      });
      
    } catch (error) {
      console.error('Controller error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Internal server error: ' + error.message 
      });
    }
  }

  async runCodeWithTestCases(req, res) {
    try {
      console.log('Received code execution with test cases request');
      
      const { code, language, testCases } = req.body;
      
      if (!code || !language || !testCases) {
        return res.status(400).json({ 
          success: false, 
          error: 'Missing required fields: code, language, and testCases' 
        });
      }
      
      if (code.length > 10000) {
        return res.status(400).json({ 
          success: false, 
          error: 'Code too large (max 10000 characters)' 
        });
      }

      if (!Array.isArray(testCases) || testCases.length === 0) {
        return res.status(400).json({ 
          success: false, 
          error: 'testCases must be a non-empty array' 
        });
      }
      
      console.log(`Executing ${language} code against ${testCases.length} test cases`);
      
      const result = await codeExecutionService.evaluateWithTestCases(code, language, testCases);
      
      console.log(`Evaluation completed: ${result.summary.passedTestCases}/${result.summary.totalTestCases} passed`);
      
      res.json({
        success: true,
        data: result
      });
      
    } catch (error) {
      console.error('Controller error:', error);
      res.status(500).json({ 
        success: false, 
        error: 'Internal server error: ' + error.message 
      });
    }
  }
  
  async healthCheck(req, res) {
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execPromise = util.promisify(exec);
      
      const version = await execPromise('docker --version');
      
      res.json({ 
        status: 'healthy',
        service: 'code-execution',
        docker: version.stdout.trim(),
        timestamp: new Date().toISOString(),
        supportedLanguages: ['python', 'javascript', 'java', 'cpp']
      });
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        error: 'Docker not available: ' + error.message,
        message: 'Please start Docker Desktop'
      });
    }
  }
}

const codeExecutionController = new CodeExecutionController();
module.exports = codeExecutionController;
