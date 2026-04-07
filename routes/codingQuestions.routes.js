const express = require('express');
const codingQuestionsController = require('../controllers/codingQuestions.controller.js');
const verifyAdmin = require('../middleware/verifyAdmin.js');
const verifyToken = require('../middleware/verifyToken.js'); // Only for register
const { verifySession } = require('../middleware/verifySession.js'); // For student routes
const pool = require('../config/db.js');

const router = express.Router();

// Save coding questions for a test (Admin only)
router.post('/test/:testId', verifyAdmin, (req, res) => codingQuestionsController.saveCodingQuestions(req, res));

// Get coding questions for a test (Admin only)
router.get('/test/:testId', verifyAdmin, (req, res) => codingQuestionsController.getCodingQuestions(req, res));

// Submit coding solution - runs against all test cases and saves result (Student)
router.post('/submit', verifySession, async (req, res) => {
    try {
        const { studentId, codingQuestionId, testId, code, language } = req.body;

        if (!studentId || !codingQuestionId || !testId || !code || !language) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Get coding question details including marks
        const questionResult = await pool.query(
            `SELECT marks FROM coding_questions WHERE id = $1`,
            [codingQuestionId]
        );

        if (questionResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Coding question not found'
            });
        }

        const totalMarks = questionResult.rows[0].marks || 10;

        // Get all test cases (public + hidden) for this question
        const testCasesResult = await pool.query(
            `SELECT input, output, is_hidden, explanation FROM coding_test_cases 
             WHERE coding_question_id = $1 
             ORDER BY test_case_order ASC, id ASC`,
            [codingQuestionId]
        );

        const allTestCases = testCasesResult.rows;

        if (allTestCases.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No test cases found for this question'
            });
        }

        // Separate public and hidden test cases
        const publicTestCases = allTestCases.filter(tc => !tc.is_hidden);
        const hiddenTestCases = allTestCases.filter(tc => tc.is_hidden);

        // Import code execution controller
        const codeExecutionController = require('../controllers/codeExecution.controller');

        // Run code against all test cases
        const mockReq = {
            body: {
                code,
                language,
                testCases: allTestCases.map(tc => ({ input: tc.input, output: tc.output }))
            }
        };

        let evaluationResult = null;
        const mockRes = {
            json: (data) => {
                evaluationResult = data;
            },
            status: function(code) {
                this.statusCode = code;
                return this;
            }
        };

        await codeExecutionController.runCodeWithTestCases(mockReq, mockRes);

        if (!evaluationResult || !evaluationResult.success) {
            return res.status(500).json({
                success: false,
                message: 'Code execution failed',
                error: evaluationResult?.error
            });
        }

        const { data } = evaluationResult;
        const passedCount = data.summary.passedTestCases;
        const totalCount = data.summary.totalTestCases;
        const status = data.passed ? 'passed' : 'failed';

        // Calculate marks earned based on test cases passed
        const marksEarned = (passedCount / totalCount) * totalMarks;

        // Separate test results into public and hidden
        const publicResults = data.testResults.slice(0, publicTestCases.length).map((result, idx) => ({
            ...result,
            input: publicTestCases[idx].input,
            expectedOutput: publicTestCases[idx].output,
            explanation: publicTestCases[idx].explanation,
            isHidden: false
        }));

        const hiddenResults = data.testResults.slice(publicTestCases.length).map((result, idx) => ({
            passed: result.passed,
            isHidden: true,
            testNumber: idx + 1
            // Don't include input, output, or actual output for hidden test cases
        }));

        // Save submission with results to database
        await pool.query(
            `INSERT INTO student_coding_submissions 
             (student_id, coding_question_id, test_id, code, language, status, test_cases_passed, total_test_cases, marks_earned)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (student_id, coding_question_id, test_id)
             DO UPDATE SET 
                code = $4, 
                language = $5, 
                status = $6, 
                test_cases_passed = $7, 
                total_test_cases = $8,
                marks_earned = $9,
                submitted_at = CURRENT_TIMESTAMP`,
            [studentId, codingQuestionId, testId, code, language, status, passedCount, totalCount, marksEarned]
        );

        res.json({
            success: true,
            message: 'Code submitted and evaluated successfully',
            result: {
                passed: data.passed,
                testCasesPassed: passedCount,
                totalTestCases: totalCount,
                percentage: data.summary.percentage,
                totalMarks: totalMarks,
                marksEarned: parseFloat(marksEarned.toFixed(2)),
                publicTestResults: publicResults,
                hiddenTestResults: hiddenResults,
                publicTestCasesPassed: publicResults.filter(r => r.passed).length,
                hiddenTestCasesPassed: hiddenResults.filter(r => r.passed).length
            }
        });
    } catch (error) {
        console.error('Error submitting code:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit code',
            error: error.message
        });
    }
});

// Test endpoint
router.get('/test', (req, res) => {
  res.json({ 
    message: 'Coding questions API is working',
    endpoints: {
      save: 'POST /api/coding-questions/test/:testId',
      get: 'GET /api/coding-questions/test/:testId',
      submit: 'POST /api/coding-questions/submit'
    }
  });
});

module.exports = router;