// Test script for coding questions API
const axios = require('axios');

const BASE_URL = 'http://localhost:5000/api';

async function testCodingQuestionsAPI() {
  console.log('Testing Coding Questions API...\n');

  try {
    // Test 1: Health check
    console.log('1. Testing API health check:');
    const healthResponse = await axios.get(`${BASE_URL}/coding-questions/test`);
    console.log('✅ Health check:', healthResponse.data);
    console.log('');

    // Test 2: Save coding questions (requires auth token)
    console.log('2. Testing save coding questions:');
    const testData = {
      codingQuestions: [
        {
          title: "Add Two Numbers",
          description: "Write a function to add two numbers",
          language: "python",
          timeLimit: 2,
          memoryLimit: 256,
          publicTestCases: [
            { input: "1 2", output: "3", explanation: "1 + 2 = 3" },
            { input: "5 7", output: "12", explanation: "5 + 7 = 12" }
          ],
          hiddenTestCases: [
            { input: "10 20", output: "30" },
            { input: "0 0", output: "0" }
          ]
        }
      ]
    };

    // Note: This will fail without proper auth token
    try {
      const saveResponse = await axios.post(`${BASE_URL}/coding-questions/test/1`, testData);
      console.log('✅ Save response:', saveResponse.data);
    } catch (authError) {
      console.log('⚠️  Save test skipped (requires authentication):', authError.response?.status);
    }

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

// Run the test
testCodingQuestionsAPI();