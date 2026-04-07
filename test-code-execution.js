// Simple test script to verify code execution service
const codeExecutionService = require('./services/codeExecution.service.js');

async function testCodeExecution() {
  console.log('Testing Code Execution Service...\n');

  // Test Python
  console.log('1. Testing Python execution:');
  const pythonCode = 'print("Hello from Python!")';
  const pythonResult = await codeExecutionService.executeCode(pythonCode, 'python');
  console.log('Result:', pythonResult);
  console.log('');

  // Test JavaScript
  console.log('2. Testing JavaScript execution:');
  const jsCode = 'console.log("Hello from JavaScript!");';
  const jsResult = await codeExecutionService.executeCode(jsCode, 'javascript');
  console.log('Result:', jsResult);
  console.log('');

  // Test with test cases
  console.log('3. Testing with test cases (Python):');
  const testCode = `
n = int(input())
print(n * 2)
`;
  const testCases = [
    { input: '5', expected_output: '10' },
    { input: '3', expected_output: '6' }
  ];
  
  const testResult = await codeExecutionService.evaluateWithTestCases(testCode, 'python', testCases);
  console.log('Test Result:', JSON.stringify(testResult, null, 2));
}

// Run the test
testCodeExecution().catch(console.error);