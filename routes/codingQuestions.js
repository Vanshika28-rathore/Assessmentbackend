const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const verifyAdmin = require('../middleware/verifyAdmin');

// Get all coding questions for a test
router.get('/test/:testId', verifyAdmin, async (req, res) => {
    try {
        const { testId } = req.params;

        // Get coding questions
        const questionsResult = await pool.query(
            `SELECT * FROM coding_questions 
             WHERE test_id = $1 
             ORDER BY question_order ASC, id ASC`,
            [testId]
        );

        // Get test cases for each question
        const questions = await Promise.all(
            questionsResult.rows.map(async (question) => {
                const testCasesResult = await pool.query(
                    `SELECT * FROM coding_test_cases 
                     WHERE coding_question_id = $1 
                     ORDER BY test_case_order ASC, id ASC`,
                    [question.id]
                );

                const publicTestCases = testCasesResult.rows
                    .filter(tc => !tc.is_hidden)
                    .map(tc => ({
                        input: tc.input,
                        output: tc.output,
                        explanation: tc.explanation
                    }));

                const hiddenTestCases = testCasesResult.rows
                    .filter(tc => tc.is_hidden)
                    .map(tc => ({
                        input: tc.input,
                        output: tc.output
                    }));

                return {
                    id: question.id,
                    title: question.title,
                    description: question.description,
                    timeLimit: parseFloat(question.time_limit),
                    memoryLimit: question.memory_limit,
                    marks: question.marks || 10,
                    publicTestCases,
                    hiddenTestCases
                };
            })
        );

        res.json({
            success: true,
            codingQuestions: questions
        });
    } catch (error) {
        console.error('Error fetching coding questions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch coding questions'
        });
    }
});

// Save coding questions for a test (used during test creation/update)
router.post('/test/:testId', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    
    try {
        const { testId } = req.params;
        const { codingQuestions } = req.body;

        console.log(`[Coding Questions] Saving ${codingQuestions?.length || 0} coding questions for test ${testId}`);

        await client.query('BEGIN');

        // Delete existing coding questions and their test cases (CASCADE will handle test cases)
        const deleteResult = await client.query('DELETE FROM coding_questions WHERE test_id = $1', [testId]);
        console.log(`[Coding Questions] Deleted ${deleteResult.rowCount} existing coding questions`);

        // Insert new coding questions
        for (let i = 0; i < codingQuestions.length; i++) {
            const question = codingQuestions[i];

            console.log(`[Coding Questions] Inserting question ${i + 1}: ${question.title}`);

            // Insert coding question
            const questionResult = await client.query(
                `INSERT INTO coding_questions 
                 (test_id, title, description, time_limit, memory_limit, marks, question_order)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 RETURNING id`,
                [testId, question.title, question.description, question.timeLimit, question.memoryLimit, question.marks || 10, i]
            );

            const codingQuestionId = questionResult.rows[0].id;
            console.log(`[Coding Questions] Inserted question with ID: ${codingQuestionId}`);

            // Insert public test cases
            for (let j = 0; j < question.publicTestCases.length; j++) {
                const testCase = question.publicTestCases[j];
                await client.query(
                    `INSERT INTO coding_test_cases 
                     (coding_question_id, input, output, explanation, is_hidden, test_case_order)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [codingQuestionId, testCase.input, testCase.output, testCase.explanation || null, false, j]
                );
            }
            console.log(`[Coding Questions] Inserted ${question.publicTestCases.length} public test cases`);

            // Insert hidden test cases
            for (let j = 0; j < question.hiddenTestCases.length; j++) {
                const testCase = question.hiddenTestCases[j];
                await client.query(
                    `INSERT INTO coding_test_cases 
                     (coding_question_id, input, output, explanation, is_hidden, test_case_order)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [codingQuestionId, testCase.input, testCase.output, null, true, j]
                );
            }
            console.log(`[Coding Questions] Inserted ${question.hiddenTestCases.length} hidden test cases`);
        }

        await client.query('COMMIT');
        console.log(`[Coding Questions] Successfully saved all coding questions for test ${testId}`);

        res.json({
            success: true,
            message: 'Coding questions saved successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[Coding Questions] Error saving coding questions:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save coding questions',
            error: error.message
        });
    } finally {
        client.release();
    }
});

// Get coding questions for student (without hidden test cases)
router.get('/test/:testId/student', async (req, res) => {
    try {
        const { testId } = req.params;

        // Get coding questions
        const questionsResult = await pool.query(
            `SELECT id, title, description, time_limit, memory_limit 
             FROM coding_questions 
             WHERE test_id = $1 
             ORDER BY question_order ASC, id ASC`,
            [testId]
        );

        // Get only public test cases for each question
        const questions = await Promise.all(
            questionsResult.rows.map(async (question) => {
                const testCasesResult = await pool.query(
                    `SELECT input, output, explanation 
                     FROM coding_test_cases 
                     WHERE coding_question_id = $1 AND is_hidden = false
                     ORDER BY test_case_order ASC, id ASC`,
                    [question.id]
                );

                return {
                    id: question.id,
                    title: question.title,
                    description: question.description,
                    timeLimit: parseFloat(question.time_limit),
                    memoryLimit: question.memory_limit,
                    testCases: testCasesResult.rows
                };
            })
        );

        res.json({
            success: true,
            codingQuestions: questions
        });
    } catch (error) {
        console.error('Error fetching coding questions for student:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch coding questions'
        });
    }
});

// Submit coding solution - runs against all test cases and saves result
router.post('/submit', async (req, res) => {
    try {
        const { studentId, codingQuestionId, testId, code, language } = req.body;

        if (!studentId || !codingQuestionId || !testId || !code || !language) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields'
            });
        }

        // Get the coding question to retrieve marks
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
            `SELECT input, output FROM coding_test_cases 
             WHERE coding_question_id = $1 
             ORDER BY test_case_order ASC, id ASC`,
            [codingQuestionId]
        );

        const testCases = testCasesResult.rows;

        if (testCases.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No test cases found for this question'
            });
        }

        // Import code execution controller
        const codeExecutionController = require('../controllers/codeExecution.controller');

        // Run code against all test cases
        const mockReq = {
            body: {
                code,
                language,
                testCases
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

        // Calculate marks earned proportionally based on test cases passed
        const marksEarned = Math.round((passedCount / totalCount) * totalMarks);

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
                marksEarned: marksEarned,
                totalMarks: totalMarks,
                testResults: data.testResults
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

module.exports = router;
