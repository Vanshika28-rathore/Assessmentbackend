const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
// const { cache } = require('../config/redis'); // DISABLED: Redis
// const { cacheMiddleware } = require('../middleware/cache'); // DISABLED: Redis
const verifyAdmin = require('../middleware/verifyAdmin');

/**
 * GET /api/tests/check-name/:name
 * Check if a test name is available
 */
router.get('/check-name/:name', verifyAdmin, async (req, res) => {
    try {
        const { name } = req.params;
        
        const result = await pool.query(
            'SELECT id FROM tests WHERE LOWER(title) = LOWER($1)',
            [name]
        );
        
        res.json({
            success: true,
            available: result.rows.length === 0,
            message: result.rows.length === 0 
                ? 'Test name is available' 
                : 'Test name already exists'
        });
    } catch (error) {
        console.error('Error checking test name:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to check test name',
            error: error.message
        });
    }
});

/**
 * GET /api/tests
 * Fetch all tests with question counts
 */
router.get('/', verifyAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                t.id,
                t.title,
                t.description,
                t.job_role,
                t.created_at,
                t.status,
                t.duration,
                t.max_attempts,
                t.start_datetime,
                t.end_datetime,
                COUNT(q.id) as question_count
            FROM tests t
            LEFT JOIN questions q ON t.id = q.test_id
            GROUP BY t.id, t.title, t.description, t.job_role, t.created_at, t.status, t.duration, t.max_attempts, t.start_datetime, t.end_datetime
            ORDER BY t.created_at DESC
        `);

        res.json({
            success: true,
            tests: result.rows
        });
    } catch (error) {
        console.error('Error fetching tests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch tests',
            error: error.message
        });
    }
});

/**
 * GET /api/tests/institutes
 * Fetch all institutes with their student counts (only active institutes)
 * NOTE: This route MUST come before /:id route to avoid "institutes" being treated as an ID
 */
router.get('/institutes', verifyAdmin, async (req, res) => {
    try {
        // First, ensure institutes table exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS institutes (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                display_name VARCHAR(255) NOT NULL,
                created_by VARCHAR(255) DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            )
        `);

        // Simple query to get institutes from students table
        const result = await pool.query(`
            SELECT 
                LOWER(institute) as institute,
                COUNT(*) as student_count
            FROM students
            WHERE institute IS NOT NULL AND institute != ''
            GROUP BY LOWER(institute)
            ORDER BY LOWER(institute) ASC
        `);

        res.json({
            success: true,
            institutes: result.rows
        });
    } catch (error) {
        console.error('Error fetching institutes:', error);
        console.error('Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch institutes',
            error: error.message
        });
    }
});

/**
 * GET /api/tests/institutes/:instituteName/students
 * Fetch all students from a specific institute
 * NOTE: This route MUST come before /:id route to avoid conflicts
 */
router.get('/institutes/:instituteName/students', verifyAdmin, async (req, res) => {
    try {
        const { instituteName } = req.params;
        
        const result = await pool.query(`
            SELECT 
                id,
                full_name,
                email,
                roll_number,
                institute,
                created_at
            FROM students
            WHERE LOWER(institute) = LOWER($1)
            ORDER BY full_name ASC
        `, [instituteName]);

        res.json({
            success: true,
            institute: instituteName,
            students: result.rows
        });
    } catch (error) {
        console.error('Error fetching students:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch students',
            error: error.message
        });
    }
});

/**
 * GET /api/tests/:id
 * Fetch a specific test with all its details and questions
 */
router.get('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        
        // Fetch test details
        const testResult = await pool.query(`
            SELECT 
                t.id,
                t.title,
                t.description,
                t.job_role,
                t.created_at,
                t.status,
                t.duration,
                t.max_attempts,
                t.passing_percentage,
                t.start_datetime,
                t.end_datetime,
                t.created_by,
                t.updated_by,
                t.updated_at
            FROM tests t
            WHERE t.id = $1
        `, [id]);

        if (testResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        const test = testResult.rows[0];

        // Fetch questions for this test
        const questionsResult = await pool.query(`
            SELECT 
                id,
                question_text,
                option_a,
                option_b,
                option_c,
                option_d,
                correct_option,
                marks
            FROM questions
            WHERE test_id = $1
            ORDER BY id ASC
        `, [id]);

        // Fetch job roles for this test
        let jobRoles = [];
        try {
            const jobRolesResult = await pool.query(`
                SELECT 
                    job_role,
                    job_description,
                    is_default
                FROM test_job_roles
                WHERE test_id = $1
                ORDER BY is_default DESC, job_role ASC
            `, [id]);
            
            jobRoles = jobRolesResult.rows.map(r => ({
                job_role: r.job_role,
                job_description: r.job_description,
                is_default: r.is_default
            }));
        } catch (error) {
            // Table might not exist, use default from test
            if (test.job_role) {
                jobRoles = [{
                    job_role: test.job_role,
                    job_description: test.description || '',
                    is_default: true
                }];
            }
        }

        // DISABLED: Fetch coding questions for this test
        // let codingQuestions = [];
        // try {
        //     const codingQuestionsResult = await pool.query(`
        //         SELECT * FROM coding_questions 
        //         WHERE test_id = $1 
        //         ORDER BY question_order ASC, id ASC
        //     `, [id]);

        //     // Get test cases for each coding question
        //     codingQuestions = await Promise.all(
        //         codingQuestionsResult.rows.map(async (question) => {
        //             const testCasesResult = await pool.query(`
        //                 SELECT * FROM coding_test_cases 
        //                 WHERE coding_question_id = $1 
        //                 ORDER BY test_case_order ASC, id ASC
        //             `, [question.id]);

        //             const publicTestCases = testCasesResult.rows
        //                 .filter(tc => !tc.is_hidden)
        //                 .map(tc => ({
        //                     input: tc.input,
        //                     output: tc.output,
        //                     explanation: tc.explanation
        //                 }));

        //             const hiddenTestCases = testCasesResult.rows
        //                 .filter(tc => tc.is_hidden)
        //                 .map(tc => ({
        //                     input: tc.input,
        //                     output: tc.output
        //                 }));

        //             return {
        //                 id: question.id,
        //                 title: question.title,
        //                 description: question.description,
        //                 timeLimit: parseFloat(question.time_limit),
        //                 memoryLimit: question.memory_limit,
        //                 publicTestCases,
        //                 hiddenTestCases
        //             };
        //         })
        //     );
        // } catch (error) {
        //     console.error('Error fetching coding questions:', error);
        //     // Continue without coding questions if table doesn't exist
        // }

        res.json({
            success: true,
            test: {
                ...test,
                questions: questionsResult.rows,
                jobRoles: jobRoles,
                // codingQuestions: codingQuestions
            }
        });
    } catch (error) {
        console.error('Error fetching test details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch test details',
            error: error.message
        });
    }
});

/**
 * PUT /api/tests/:id/status
 * Update test status (draft/published/archived)
 */
router.put('/:id/status', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        // Validate status
        if (!['draft', 'published', 'archived'].includes(status)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid status. Must be draft, published, or archived'
            });
        }

        const result = await pool.query(
            'UPDATE tests SET status = $1 WHERE id = $2 RETURNING *',
            [status, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        // Invalidate cache
        // await cache.delPattern('cache:*'); // DISABLED: Redis

        res.json({
            success: true,
            message: `Test status updated to ${status}`,
            test: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating test status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update test status',
            error: error.message
        });
    }
});

/**
 * PUT /api/tests/:id/job-details
 * Update job role and description for a test
 */
router.put('/:id/job-details', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { job_role, description } = req.body;

        if (!job_role || job_role.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Job role is required'
            });
        }

        const result = await pool.query(
            'UPDATE tests SET job_role = $1, description = $2 WHERE id = $3 RETURNING *',
            [job_role.trim(), description ? description.trim() : '', id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        res.json({
            success: true,
            message: 'Job details updated successfully',
            test: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating job details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update job details',
            error: error.message
        });
    }
});

/**
 * PUT /api/tests/:id/details
 * Update test metadata (job role, description, dates, duration, etc.)
 * Works for both draft and published tests - does NOT modify questions
 */
router.put('/:id/details', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { 
            job_role, 
            description, 
            start_datetime, 
            end_datetime,
            duration,
            passing_percentage,
            max_attempts
        } = req.body;

        console.log('=== UPDATE TEST DETAILS REQUEST ===');
        console.log('Test ID:', id);
        console.log('Job Role:', job_role);
        console.log('Duration:', duration);
        console.log('Start DateTime:', start_datetime);
        console.log('End DateTime:', end_datetime);

        // Validation
        if (!job_role || job_role.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Job role is required'
            });
        }

        if (duration && (duration < 1 || duration > 300)) {
            return res.status(400).json({
                success: false,
                message: 'Duration must be between 1 and 300 minutes'
            });
        }

        if (passing_percentage !== undefined && (passing_percentage < 0 || passing_percentage > 100)) {
            return res.status(400).json({
                success: false,
                message: 'Passing percentage must be between 0 and 100'
            });
        }

        if (max_attempts && (max_attempts < 1 || max_attempts > 10)) {
            return res.status(400).json({
                success: false,
                message: 'Max attempts must be between 1 and 10'
            });
        }

        // Check if test exists
        const testCheck = await pool.query(
            'SELECT id, title, status FROM tests WHERE id = $1',
            [id]
        );

        if (testCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        // Get admin user from token
        const adminUser = req.user?.email || req.user?.username || 'admin';

        // Update test metadata only (no questions modification)
        const result = await pool.query(`
            UPDATE tests 
            SET 
                job_role = $1, 
                description = $2, 
                duration = $3, 
                max_attempts = $4, 
                passing_percentage = $5, 
                start_datetime = $6, 
                end_datetime = $7,
                updated_by = $9,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $8
            RETURNING 
                id, title, job_role, description, duration, max_attempts, passing_percentage,
                start_datetime AT TIME ZONE 'Asia/Kolkata' as start_datetime,
                end_datetime AT TIME ZONE 'Asia/Kolkata' as end_datetime,
                status, created_at, created_by, updated_by, updated_at
        `, [
            job_role.trim(),
            description ? description.trim() : '',
            parseInt(duration) || 60,
            parseInt(max_attempts) || 1,
            parseInt(passing_percentage) || 50,
            start_datetime || null,
            end_datetime || null,
            id,
            adminUser
        ]);

        console.log('✅ Test details updated successfully');

        res.json({
            success: true,
            message: 'Test details updated successfully',
            test: result.rows[0]
        });
    } catch (error) {
        console.error('❌ Error updating test details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update test details',
            error: error.message
        });
    }
});

/**
 * PUT /api/tests/:id
 * Update test details, questions, and job roles (only for draft tests)
 */
router.put('/:id', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { 
            testName, 
            jobRoles, 
            duration, 
            maxAttempts, 
            passingPercentage, 
            startDateTime, 
            endDateTime,
            questions 
        } = req.body;

        console.log('=== UPDATE TEST REQUEST ===');
        console.log('Test ID:', id);
        console.log('Test Name:', testName);
        console.log('Questions count:', questions?.length);

        await client.query('BEGIN');

        // Check if test exists and is draft
        const testCheck = await client.query(
            'SELECT id, status FROM tests WHERE id = $1',
            [id]
        );

        if (testCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        if (testCheck.rows[0].status !== 'draft') {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: 'Only draft tests can be edited'
            });
        }

        // Update test details
        const defaultJobRole = jobRoles && jobRoles.length > 0 ? jobRoles[0].job_role : '';
        const defaultJobDescription = jobRoles && jobRoles.length > 0 ? jobRoles[0].job_description : '';
        
        // Get admin user from token
        const adminUser = req.user?.email || req.user?.username || 'admin';
        
        await client.query(`
            UPDATE tests 
            SET title = $1, 
                job_role = $2, 
                description = $3, 
                duration = $4, 
                max_attempts = $5, 
                passing_percentage = $6, 
                start_datetime = $7, 
                end_datetime = $8,
                updated_by = $10,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $9
        `, [
            testName,
            defaultJobRole,
            defaultJobDescription,
            parseInt(duration) || 60,
            parseInt(maxAttempts) || 1,
            parseInt(passingPercentage) || 50,
            startDateTime || null,
            endDateTime || null,
            id,
            adminUser
        ]);

        // Update job roles
        if (jobRoles && jobRoles.length > 0) {
            // Delete existing job roles
            await client.query('DELETE FROM test_job_roles WHERE test_id = $1', [id]);

            // Insert new job roles
            for (let i = 0; i < jobRoles.length; i++) {
                const role = jobRoles[i];
                await client.query(`
                    INSERT INTO test_job_roles (test_id, job_role, job_description, is_default)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (test_id, job_role) DO NOTHING
                `, [id, role.job_role, role.job_description || '', i === 0]);
            }
        }

        // Update questions if provided
        if (questions && questions.length > 0) {
            // Delete existing questions
            await client.query('DELETE FROM questions WHERE test_id = $1', [id]);

            // Insert new questions
            for (const q of questions) {
                await client.query(`
                    INSERT INTO questions 
                    (test_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                `, [
                    id,
                    q.question_text || q.text,
                    q.option_a || q.options?.[0],
                    q.option_b || q.options?.[1],
                    q.option_c || q.options?.[2] || '',
                    q.option_d || q.options?.[3] || '',
                    q.correct_option || String.fromCharCode(65 + (q.correctOption || 0)),
                    q.marks || 1
                ]);
            }
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Test updated successfully',
            testId: id
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error updating test:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update test',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * DELETE /api/tests/bulk
 * Delete multiple tests at once
 */
router.delete('/bulk', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { test_ids } = req.body;

        if (!test_ids || !Array.isArray(test_ids) || test_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'test_ids array is required'
            });
        }

        console.log(`[BULK DELETE] Starting deletion for ${test_ids.length} tests`);
        
        await client.query('BEGIN');
        
        let deletedCount = 0;
        const errors = [];

        for (const testId of test_ids) {
            try {
                // Get test details
                const testResult = await client.query('SELECT title FROM tests WHERE id = $1', [testId]);
                
                if (testResult.rows.length === 0) {
                    errors.push({ testId, error: 'Test not found' });
                    continue;
                }
                
                const testTitle = testResult.rows[0].title;
                
                // Delete related data
                await client.query('DELETE FROM institute_test_assignments WHERE test_id = $1', [testId]);
                await client.query('DELETE FROM test_assignments WHERE test_id = $1', [testId]);
                await client.query('DELETE FROM test_job_roles WHERE test_id = $1', [testId]);
                
                // Delete exams and results
                const examsResult = await client.query('SELECT id FROM exams WHERE name = $1', [testTitle]);
                const examIds = examsResult.rows.map(row => row.id);
                
                if (examIds.length > 0) {
                    await client.query('DELETE FROM results WHERE exam_id = ANY($1)', [examIds]);
                    await client.query('DELETE FROM exams WHERE id = ANY($1)', [examIds]);
                }
                
                await client.query('DELETE FROM exam_progress WHERE test_id = $1', [testId]);
                await client.query('DELETE FROM questions WHERE test_id = $1', [testId]);
                await client.query('DELETE FROM tests WHERE id = $1', [testId]);
                
                deletedCount++;
            } catch (error) {
                errors.push({ testId, error: error.message });
            }
        }
        
        await client.query('COMMIT');
        console.log(`[BULK DELETE] Successfully deleted ${deletedCount} tests`);

        res.json({
            success: true,
            message: `Successfully deleted ${deletedCount} test(s)`,
            deleted_count: deletedCount,
            errors: errors.length > 0 ? errors : undefined
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[BULK DELETE] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete tests',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * DELETE /api/tests/:id
 * Delete a test and all related data (questions, exams, results, progress, assignments)
 */
router.delete('/:id', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        
        console.log(`[DELETE TEST] Starting deletion for test ID: ${id}`);
        
        await client.query('BEGIN');
        
        // Get test details first
        const testResult = await client.query('SELECT title FROM tests WHERE id = $1', [id]);
        
        if (testResult.rows.length === 0) {
            await client.query('ROLLBACK');
            console.log(`[DELETE TEST] Test not found: ${id}`);
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }
        
        const testTitle = testResult.rows[0].title;
        console.log(`[DELETE TEST] Deleting test: ${testTitle}`);
        
        // Delete institute test assignments first
        const instituteAssignmentsDeleted = await client.query('DELETE FROM institute_test_assignments WHERE test_id = $1', [id]);
        console.log(`[DELETE TEST] Deleted ${instituteAssignmentsDeleted.rowCount} institute test assignments`);
        
        // Delete test assignments (CASCADE will handle this, but being explicit)
        const assignmentsDeleted = await client.query('DELETE FROM test_assignments WHERE test_id = $1', [id]);
        console.log(`[DELETE TEST] Deleted ${assignmentsDeleted.rowCount} test assignments`);
        
        // Delete test job roles
        const jobRolesDeleted = await client.query('DELETE FROM test_job_roles WHERE test_id = $1', [id]);
        console.log(`[DELETE TEST] Deleted ${jobRolesDeleted.rowCount} test job roles`);
        
        // Find all exams with matching name
        const examsResult = await client.query('SELECT id FROM exams WHERE name = $1', [testTitle]);
        const examIds = examsResult.rows.map(row => row.id);
        console.log(`[DELETE TEST] Found ${examIds.length} related exams`);
        
        if (examIds.length > 0) {
            // Delete results for these exams
            const resultsDeleted = await client.query('DELETE FROM results WHERE exam_id = ANY($1)', [examIds]);
            console.log(`[DELETE TEST] Deleted ${resultsDeleted.rowCount} results`);
            
            // Delete the exams
            const examsDeleted = await client.query('DELETE FROM exams WHERE id = ANY($1)', [examIds]);
            console.log(`[DELETE TEST] Deleted ${examsDeleted.rowCount} exams`);
        }
        
        // Delete exam progress for this test
        const progressDeleted = await client.query('DELETE FROM exam_progress WHERE test_id = $1', [id]);
        console.log(`[DELETE TEST] Deleted ${progressDeleted.rowCount} exam progress records`);
        
        // Delete questions (CASCADE should handle this, but being explicit)
        const questionsDeleted = await client.query('DELETE FROM questions WHERE test_id = $1', [id]);
        console.log(`[DELETE TEST] Deleted ${questionsDeleted.rowCount} questions`);
        
        // Finally delete the test itself
        const testDeleted = await client.query('DELETE FROM tests WHERE id = $1', [id]);
        console.log(`[DELETE TEST] Deleted test: ${testDeleted.rowCount}`);
        
        await client.query('COMMIT');
        console.log(`[DELETE TEST] Successfully deleted test ID: ${id}`);

        // Invalidate cache
        // await cache.delPattern('cache:*'); // DISABLED: Redis

        res.json({
            success: true,
            message: 'Test and all related data deleted successfully'
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[DELETE TEST] Error deleting test:', error);
        console.error('[DELETE TEST] Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to delete test',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * POST /api/tests/:id/clone
 * Clone a test with all its questions
 * Creates a new test with the same settings and questions but no results or assignments
 */
router.post('/:id/clone', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id } = req.params;
        const { new_title } = req.body;

        if (!new_title || new_title.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'New test title is required'
            });
        }

        console.log(`[CLONE TEST] Starting clone for test ID: ${id}`);
        console.log(`[CLONE TEST] New title: ${new_title}`);

        await client.query('BEGIN');

        // Check if new title already exists
        const titleCheck = await client.query(
            'SELECT id FROM tests WHERE LOWER(title) = LOWER($1)',
            [new_title.trim()]
        );

        if (titleCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                message: 'A test with this name already exists'
            });
        }

        // Get original test details
        const originalTest = await client.query(
            'SELECT * FROM tests WHERE id = $1',
            [id]
        );

        if (originalTest.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Original test not found'
            });
        }

        const test = originalTest.rows[0];
        console.log(`[CLONE TEST] Original test: ${test.title}`);

        // Get admin user from token
        const adminUser = req.user?.email || req.user?.username || 'admin';

        // Create new test with same settings but draft status
        const newTest = await client.query(`
            INSERT INTO tests (
                title, description, duration, max_attempts, 
                start_datetime, end_datetime, status, passing_percentage, created_by
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'draft', $7, $8)
            RETURNING *
        `, [
            new_title.trim(),
            test.description,
            test.duration,
            test.max_attempts,
            test.start_datetime,
            test.end_datetime,
            test.passing_percentage || 50,
            adminUser
        ]);

        const newTestId = newTest.rows[0].id;
        console.log(`[CLONE TEST] Created new test with ID: ${newTestId}`);

        // Clone all questions
        const questions = await client.query(
            'SELECT * FROM questions WHERE test_id = $1 ORDER BY id',
            [id]
        );

        console.log(`[CLONE TEST] Cloning ${questions.rows.length} questions`);

        for (const question of questions.rows) {
            await client.query(`
                INSERT INTO questions (
                    test_id, question_text, option_a, option_b, 
                    option_c, option_d, correct_option, marks
                )
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
                newTestId,
                question.question_text,
                question.option_a,
                question.option_b,
                question.option_c,
                question.option_d,
                question.correct_option,
                question.marks
            ]);
        }

        await client.query('COMMIT');
        console.log(`[CLONE TEST] Successfully cloned test`);

        res.json({
            success: true,
            message: `Test cloned successfully as "${new_title}"`,
            test: newTest.rows[0],
            questions_cloned: questions.rows.length
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('[CLONE TEST] Error cloning test:', error);
        console.error('[CLONE TEST] Error stack:', error.stack);
        res.status(500).json({
            success: false,
            message: 'Failed to clone test',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * POST /api/tests/assign
 * Assign a test to specific students
 */
router.post('/assign', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { test_id, student_ids } = req.body;

        if (!test_id || !student_ids || !Array.isArray(student_ids) || student_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'test_id and student_ids array are required'
            });
        }

        // Verify test exists
        const testCheck = await client.query('SELECT id FROM tests WHERE id = $1', [test_id]);
        
        if (testCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        await client.query('BEGIN');

        // Create test_assignments table if it doesn't exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS test_assignments (
                id SERIAL PRIMARY KEY,
                test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
                student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                UNIQUE(test_id, student_id)
            )
        `);

        // Check which students already have this test assigned
        const existingAssignments = await client.query(`
            SELECT student_id FROM test_assignments 
            WHERE test_id = $1 AND student_id = ANY($2) AND is_active = true
        `, [test_id, student_ids]);

        const alreadyAssignedIds = existingAssignments.rows.map(row => row.student_id);
        const newAssignmentIds = student_ids.filter(id => !alreadyAssignedIds.includes(id));

        // If all students already have this test assigned
        if (newAssignmentIds.length === 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({
                success: false,
                message: student_ids.length === 1 
                    ? 'This test is already assigned to this student'
                    : `All ${student_ids.length} selected student(s) already have this test assigned`,
                already_assigned: student_ids.length,
                newly_assigned: 0
            });
        }

        // Insert assignments only for students who don't have it yet
        const insertPromises = newAssignmentIds.map(student_id =>
            client.query(`
                INSERT INTO test_assignments (test_id, student_id, is_active)
                VALUES ($1, $2, true)
            `, [test_id, student_id])
        );

        await Promise.all(insertPromises);
        await client.query('COMMIT');

        // Invalidate cache
        // await cache.delPattern('cache:*'); // DISABLED: Redis

        // Build response message
        let message = '';
        if (alreadyAssignedIds.length > 0) {
            message = `${alreadyAssignedIds.length} student(s) already have this test assigned. Assigning to ${newAssignmentIds.length} student(s).`;
        } else {
            message = `Test assigned to ${newAssignmentIds.length} student(s)`;
        }

        res.json({
            success: true,
            message: message,
            newly_assigned: newAssignmentIds.length,
            already_assigned: alreadyAssignedIds.length,
            total_requested: student_ids.length
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error assigning test:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to assign test',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * GET /api/tests/:testId/assignments
 * Get all students assigned to a specific test
 */
router.get('/:testId/assignments', verifyAdmin, async (req, res) => {
    try {
        const { testId } = req.params;
        
        const result = await pool.query(`
            SELECT 
                s.id,
                s.full_name,
                s.email,
                s.roll_number,
                s.institute,
                ta.assigned_at,
                ta.is_active
            FROM test_assignments ta
            JOIN students s ON ta.student_id = s.id
            WHERE ta.test_id = $1 AND ta.is_active = true
            ORDER BY s.institute, s.full_name
        `, [testId]);

        res.json({
            success: true,
            test_id: parseInt(testId),
            assignments: result.rows
        });
    } catch (error) {
        console.error('Error fetching assignments:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch assignments',
            error: error.message
        });
    }
});

/**
 * GET /api/tests/:testId/job-roles
 * Get all job roles for a specific test
 */
router.get('/:testId/job-roles', async (req, res) => {
    try {
        const { testId } = req.params;
        
        const result = await pool.query(`
            SELECT 
                id,
                job_role,
                job_description,
                is_default
            FROM test_job_roles
            WHERE test_id = $1
            ORDER BY is_default DESC, job_role ASC
        `, [testId]);

        res.json({
            success: true,
            test_id: parseInt(testId),
            job_roles: result.rows
        });
    } catch (error) {
        console.error('Error fetching job roles:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch job roles',
            error: error.message
        });
    }
});

/**
 * POST /api/tests/:testId/job-roles
 * Add or update multiple job roles for a test
 */
router.post('/:testId/job-roles', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { testId } = req.params;
        const { job_roles } = req.body;

        if (!job_roles || !Array.isArray(job_roles) || job_roles.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'job_roles array is required'
            });
        }

        // Verify test exists
        const testCheck = await client.query('SELECT id FROM tests WHERE id = $1', [testId]);
        if (testCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        await client.query('BEGIN');

        // Create table if it doesn't exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS test_job_roles (
                id SERIAL PRIMARY KEY,
                test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
                job_role VARCHAR(255) NOT NULL,
                job_description TEXT,
                is_default BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(test_id, job_role)
            )
        `);

        // Delete existing job roles for this test
        await client.query('DELETE FROM test_job_roles WHERE test_id = $1', [testId]);

        // Insert new job roles
        for (let i = 0; i < job_roles.length; i++) {
            const role = job_roles[i];
            await client.query(`
                INSERT INTO test_job_roles (test_id, job_role, job_description, is_default)
                VALUES ($1, $2, $3, $4)
            `, [testId, role.job_role, role.job_description || '', i === 0]);
        }

        // Update the default job role in tests table for backward compatibility
        if (job_roles.length > 0) {
            await client.query(
                'UPDATE tests SET job_role = $1, description = $2 WHERE id = $3',
                [job_roles[0].job_role, job_roles[0].job_description || '', testId]
            );
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Successfully added ${job_roles.length} job role(s)`,
            count: job_roles.length
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error adding job roles:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add job roles',
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router;