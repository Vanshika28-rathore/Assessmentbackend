const express = require('express');
const router = express.Router();
const { pool, cachedQuery, clearCache } = require('../config/db');
// const { cache } = require('../config/redis'); // DISABLED: Redis
// const { cacheMiddleware } = require('../middleware/cache'); // DISABLED: Redis
const verifyAdmin = require('../middleware/verifyAdmin');
const verifyToken = require('../middleware/verifyToken'); // Only for register
const { verifySession } = require('../middleware/verifySession'); // For all other routes

/**
 * GET /api/student/tests
 * Fetch tests assigned to the logged-in student
 */
router.get('/tests', verifySession, async (req, res) => {
    try {
        const firebase_uid = req.firebaseUid;

        // First, get the student ID and institute from firebase_uid
        const studentResult = await pool.query(
            'SELECT id, institute FROM students WHERE firebase_uid = $1',
            [firebase_uid]
        );

        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student profile not found'
            });
        }

        const studentId = studentResult.rows[0].id;
        const studentInstitute = studentResult.rows[0].institute;

        // Auto-assign any mock tests that are not yet assigned to this student
        try {
            await pool.query(`
                INSERT INTO test_assignments (test_id, student_id, is_active)
                SELECT t.id, $1, true
                FROM tests t
                WHERE t.is_mock_test = true
                  AND NOT EXISTS (
                    SELECT 1 FROM test_assignments ta
                    WHERE ta.test_id = t.id AND ta.student_id = $1
                  )
            `, [studentId]);
        } catch (autoAssignErr) {
            console.error('Warning: Could not auto-assign mock tests:', autoAssignErr.message);
        }

        // Fetch tests assigned to this student via test_assignments table
        const assignedTestsResult = await pool.query(`
            SELECT 
                t.id, 
                t.title, 
                t.description,
                t.job_role,
                t.created_at,
                t.duration,
                t.max_attempts,
                t.start_datetime,
                t.end_datetime,
                COALESCE(t.is_mock_test, false) as is_mock_test,
                (SELECT COUNT(*) FROM questions q WHERE q.test_id = t.id) as question_count,
                ta.assigned_at,
                (SELECT COUNT(*) FROM results r
                 INNER JOIN exams e ON r.exam_id = e.id
                 WHERE r.student_id = $1 
                 AND e.name LIKE '%' || t.title || '%') as attempts_taken
            FROM tests t
            INNER JOIN test_assignments ta ON t.id = ta.test_id
            WHERE ta.student_id = $1 AND ta.is_active = true
            ORDER BY COALESCE(t.is_mock_test, false) DESC, ta.assigned_at DESC
        `, [studentId]);

        // Transform assigned tests data
        const assignedTests = assignedTestsResult.rows.map(test => {
            const attemptsTaken = parseInt(test.attempts_taken) || 0;
            const maxAttempts = test.max_attempts || 1;
            const attemptsRemaining = Math.max(0, maxAttempts - attemptsTaken);
            const hasAttemptsLeft = attemptsRemaining > 0;

            // Check if test is within available time window
            // Convert all times to UTC timestamps for accurate comparison
            const nowUTC = Date.now(); // Current time in milliseconds (UTC)
            const startDate = test.start_datetime ? new Date(test.start_datetime) : null;
            const endDate = test.end_datetime ? new Date(test.end_datetime) : null;
            const startUTC = startDate ? startDate.getTime() : null;
            const endUTC = endDate ? endDate.getTime() : null;
            
            console.log(`[Test ${test.id}] Checking availability:`);
            console.log(`  Current time (UTC): ${new Date(nowUTC).toISOString()}`);
            console.log(`  Start time (UTC): ${startDate ? startDate.toISOString() : 'null'}`);
            console.log(`  End time (UTC): ${endDate ? endDate.toISOString() : 'null'}`);
            
            let isAvailable = true;
            let availabilityMessage = '';
            let testStatus = 'available';
            
            if (startUTC && nowUTC < startUTC) {
                isAvailable = false;
                testStatus = 'upcoming';
                availabilityMessage = `Available from ${startDate.toLocaleString()}`;
                console.log(`  Status: UPCOMING (${nowUTC} < ${startUTC})`);
            } else if (endUTC && nowUTC > endUTC) {
                isAvailable = false;
                testStatus = 'expired';
                availabilityMessage = `Expired on ${endDate.toLocaleString()}`;
                console.log(`  Status: EXPIRED (${nowUTC} > ${endUTC})`);
            } else {
                console.log(`  Status: AVAILABLE`);
            }

            return {
                id: test.id,
                title: test.title,
                description: test.description,
                jobRole: test.job_role,
                questions: parseInt(test.question_count),
                duration: test.duration || 60,
                maxAttempts: maxAttempts,
                attemptsTaken: attemptsTaken,
                attemptsRemaining: attemptsRemaining,
                hasAttemptsLeft: hasAttemptsLeft,
                startDateTime: test.start_datetime,
                endDateTime: test.end_datetime,
                isAvailable: isAvailable,
                availabilityMessage: availabilityMessage,
                testStatus: testStatus,
                isMockTest: test.is_mock_test === true,
                subject: test.is_mock_test === true ? 'Practice' : 'General',
                difficulty: test.is_mock_test === true ? 'Easy-Medium' : 'Medium',
                color: test.is_mock_test === true ? 'bg-green-50 border-green-200' : 'bg-blue-50 border-blue-200',
                alreadyTaken: attemptsTaken >= maxAttempts,
                assignedAt: test.assigned_at,
                isAssigned: true
            };
        });

        // Fetch job roles for all tests (if table exists)
        const testIds = assignedTests.map(t => t.id);
        console.log('=== FETCHING JOB ROLES ===');
        console.log('Test IDs:', testIds);
        
        if (testIds.length > 0) {
            try {
                const jobRolesResult = await pool.query(`
                    SELECT test_id, job_role, job_description, is_default
                    FROM test_job_roles
                    WHERE test_id = ANY($1)
                    ORDER BY test_id, is_default DESC, job_role ASC
                `, [testIds]);

                console.log('Job roles query result:', jobRolesResult.rows.length, 'rows');
                console.log('Job roles data:', JSON.stringify(jobRolesResult.rows, null, 2));

                // Group job roles by test_id
                const jobRolesByTest = {};
                jobRolesResult.rows.forEach(role => {
                    if (!jobRolesByTest[role.test_id]) {
                        jobRolesByTest[role.test_id] = [];
                    }
                    jobRolesByTest[role.test_id].push({
                        jobRole: role.job_role,
                        jobDescription: role.job_description,
                        isDefault: role.is_default
                    });
                });

                console.log('Grouped job roles:', JSON.stringify(jobRolesByTest, null, 2));

                // Add job roles to each test
                const testsWithJobRoles = assignedTests.map(test => ({
                    ...test,
                    jobRoles: jobRolesByTest[test.id] || []
                }));

                console.log('Tests with job roles:', testsWithJobRoles.map(t => ({ id: t.id, title: t.title, jobRolesCount: t.jobRoles.length })));
                console.log('Sending assigned tests to student:', testsWithJobRoles.length);

                res.json({
                    success: true,
                    tests: testsWithJobRoles
                });
                return;
            } catch (error) {
                // Table might not exist yet, continue without job roles
                console.log('Job roles table error:', error.message);
                console.log('Error details:', error);
            }
        }

        console.log('Sending assigned tests to student:', assignedTests.length);

        res.json({
            success: true,
            tests: assignedTests
        });
    } catch (error) {
        console.error('Error fetching tests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch tests'
        });
    }
});

/**
 * GET /api/student/test/:testId
 * Fetch a specific test and its questions (only if assigned to student)
 */
router.get('/test/:testId', verifySession, async (req, res) => {
    const { testId } = req.params;
    const firebaseUid = req.firebaseUid;

    try {
        // Get student ID and institute
        const studentResult = await pool.query(
            'SELECT id, institute FROM students WHERE firebase_uid = $1',
            [firebaseUid]
        );

        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const studentId = studentResult.rows[0].id;
        const studentInstitute = studentResult.rows[0].institute;

        // 1. Fetch Test Details first
        const testResult = await pool.query('SELECT * FROM tests WHERE id = $1', [testId]);

        if (testResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Test not found' });
        }

        const test = testResult.rows[0];

        // Check if test is assigned to this student
        const assignmentCheck = await pool.query(
            'SELECT * FROM test_assignments WHERE test_id = $1 AND student_id = $2 AND is_active = true',
            [testId, studentId]
        );

        const isAssigned = assignmentCheck.rows.length > 0;

        // Only allow access if test is assigned to this student
        if (!isAssigned) {
            return res.status(403).json({
                success: false,
                message: 'This test is not assigned to you. Please contact your administrator.'
            });
        }

        // Check if test is within available time window
        const now = new Date();
        const startDate = test.start_datetime ? new Date(test.start_datetime) : null;
        const endDate = test.end_datetime ? new Date(test.end_datetime) : null;
        
        if (startDate && now < startDate) {
            return res.status(403).json({
                success: false,
                message: `This test is not yet available. It will be available from ${startDate.toLocaleString()}`,
                notYetAvailable: true
            });
        }
        
        if (endDate && now > endDate) {
            return res.status(403).json({
                success: false,
                message: `This test has expired. It was available until ${endDate.toLocaleString()}`,
                expired: true
            });
        }

        // Check how many attempts the student has made
        const attemptsCheck = await pool.query(`
            SELECT COUNT(*) as attempts_count
            FROM results r
            INNER JOIN exams e ON r.exam_id = e.id
            WHERE r.student_id = $1 AND e.name LIKE '%' || $2 || '%'
        `, [studentId, test.title]);

        const attemptsTaken = parseInt(attemptsCheck.rows[0]?.attempts_count) || 0;
        const maxAttempts = test.max_attempts || 1;

        // Block access only if max attempts exceeded AND no saved progress
        if (attemptsTaken >= maxAttempts) {
            // Check if there's saved progress
            const progressCheck = await pool.query(`
                SELECT id FROM exam_progress
                WHERE student_id = $1 AND test_id = $2
            `, [studentId, testId]);

            // If no progress and attempts exceeded, block access
            if (progressCheck.rows.length === 0) {
                return res.status(403).json({
                    success: false,
                    message: 'You have used all your attempts for this test',
                    alreadyTaken: true,
                    attemptsTaken: attemptsTaken,
                    maxAttempts: maxAttempts
                });
            }
        }

        // 2. Fetch Questions (excluding correct_option to prevent cheating)
        // Note: Don't cache shuffled questions as each student gets different order
        const questionsResult = await pool.query(
            `SELECT 
                id, 
                question_text as question, 
                option_a, 
                option_b, 
                option_c, 
                option_d,
                marks
            FROM questions 
            WHERE test_id = $1
            ORDER BY MD5(CONCAT(id::text, $2::text)) ASC`,
            [testId, studentId] // Use studentId as seed for consistent shuffling
        );

        // Transform questions to frontend format with shuffled options
        const questions = questionsResult.rows.map(q => {
            const originalOptions = [q.option_a, q.option_b, q.option_c, q.option_d].filter(opt => opt !== null && opt !== '');
            
            // Create deterministic shuffle seed for this student + question
            const shuffleSeed = parseInt(require('crypto').createHash('md5')
                .update(`${q.id}_${studentId}`)
                .digest('hex')
                .substring(0, 8), 16);
            
            // Shuffle options using seeded random
            const shuffledOptions = [...originalOptions];
            for (let i = shuffledOptions.length - 1; i > 0; i--) {
                const j = Math.floor(((shuffleSeed + i) * 2654435761) % (i + 1));
                [shuffledOptions[i], shuffledOptions[j]] = [shuffledOptions[j], shuffledOptions[i]];
            }
            
            return {
                id: q.id,
                question: q.question,
                options: shuffledOptions,
                marks: q.marks
            };
        });

        // DISABLED: CODE EXECUTION FEATURE
        // Fetch coding questions for this test
        // let codingQuestions = [];
        // try {
        //     const codingQuestionsResult = await pool.query(
        //         `SELECT id, title, description, time_limit, memory_limit, marks 
        //          FROM coding_questions 
        //          WHERE test_id = $1 
        //          ORDER BY question_order ASC, id ASC`,
        //         [testId]
        //     );

        //     console.log(`[Student Test] Found ${codingQuestionsResult.rows.length} coding questions for test ${testId}`);

        //     // Get public test cases for each coding question
        //     codingQuestions = await Promise.all(
        //         codingQuestionsResult.rows.map(async (question) => {
        //             const testCasesResult = await pool.query(
        //                 `SELECT input, output, explanation 
        //                  FROM coding_test_cases 
        //                  WHERE coding_question_id = $1 AND is_hidden = false
        //                  ORDER BY test_case_order ASC, id ASC`,
        //                 [question.id]
        //             );

        //             return {
        //                 id: question.id,
        //                 title: question.title,
        //                 description: question.description,
        //                 timeLimit: parseFloat(question.time_limit),
        //                 memoryLimit: question.memory_limit,
        //                 marks: question.marks || 10,
        //                 testCases: testCasesResult.rows
        //             };
        //         })
        //     );

        //     console.log('[Student Test] Coding questions prepared:', codingQuestions.length);
        // } catch (codingError) {
        //     console.error('[Student Test] Error fetching coding questions (table may not exist):', codingError.message);
        //     // Continue without coding questions if table doesn't exist
        //     codingQuestions = [];
        // }

        // 3. Check for saved progress
        const progressResult = await pool.query(`
            SELECT answers, current_question, marked_for_review, visited_questions, time_remaining, warning_count
            FROM exam_progress
            WHERE student_id = $1 AND test_id = $2
        `, [studentId, testId]);

        let savedProgress = null;
        if (progressResult.rows.length > 0) {
            const progress = progressResult.rows[0];
            console.log('Raw progress from DB:', progress);
            console.log('Answers type:', typeof progress.answers);
            console.log('Answers value:', progress.answers);
            
            savedProgress = {
                answers: progress.answers || {},
                currentQuestion: progress.current_question || 0,
                markedForReview: progress.marked_for_review || [],
                visitedQuestions: progress.visited_questions || [0],
                timeRemaining: progress.time_remaining,
                warningCount: progress.warning_count || 0
            };
        }

        res.json({
            success: true,
            test: {
                id: test.id,
                title: test.title,
                description: test.description,
                duration: test.duration || 60,
                questions: questions,
                // codingQuestions: codingQuestions,
                isAssigned: isAssigned
            },
            savedProgress: savedProgress
        });

    } catch (error) {
        console.error('Error fetching test details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch test details'
        });
    }
});

/**
 * POST /api/student/save-progress
 * Save exam progress
 */
router.post('/save-progress', verifySession, async (req, res) => {
    const { testId, answers, currentQuestion, markedForReview, visitedQuestions, timeRemaining, warningCount } = req.body;
    const firebaseUid = req.firebaseUid;

    console.log('=== SAVE PROGRESS REQUEST ===');
    console.log('Firebase UID:', firebaseUid);
    console.log('Test ID:', testId);
    console.log('Current Question:', currentQuestion);
    console.log('Time Remaining:', timeRemaining);
    console.log('Warning Count:', warningCount);

    try {
        // Get student ID
        const studentResult = await pool.query(
            'SELECT id FROM students WHERE firebase_uid = $1',
            [firebaseUid]
        );

        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const studentId = studentResult.rows[0].id;
        console.log('Student ID:', studentId);
        console.log('Answers to save:', answers);
        console.log('Answers type:', typeof answers);

        // Upsert progress - PostgreSQL JSONB column will handle JSON conversion
        const result = await pool.query(`
            INSERT INTO exam_progress (student_id, test_id, answers, current_question, marked_for_review, visited_questions, time_remaining, warning_count)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (student_id, test_id)
            DO UPDATE SET
                answers = $3,
                current_question = $4,
                marked_for_review = $5,
                visited_questions = $6,
                time_remaining = $7,
                warning_count = $8,
                updated_at = CURRENT_TIMESTAMP
            RETURNING id
        `, [studentId, testId, answers, currentQuestion, markedForReview, visitedQuestions, timeRemaining, warningCount]);

        console.log('Progress saved with ID:', result.rows[0].id);

        res.json({
            success: true,
            message: 'Progress saved',
            progressId: result.rows[0].id
        });

    } catch (error) {
        console.error('Error saving progress:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to save progress',
            error: error.message
        });
    }
});

/**
 * POST /api/student/submit-exam
 * Submit exam answers, calculate results, and store in database
 * 
 * CRITICAL FIX: If student has exam progress (already started exam), 
 * skip token validation to prevent "login again" errors during long exams
 */
router.post('/submit-exam', async (req, res) => {
    const { testId, answers, examId, submissionReason, warningCount, timeRemaining, studentId: clientStudentId } = req.body;

    console.log('=== SUBMIT EXAM REQUEST ===');
    console.log('Test ID:', testId);
    console.log('Client Student ID:', clientStudentId);
    console.log('Submission Reason:', submissionReason);
    console.log('Warning Count:', warningCount);
    console.log('Time Remaining:', timeRemaining);

    try {
        let studentId;
        let firebaseUid;

        // CRITICAL FIX: Check if student has exam progress (already started exam)
        // If yes, skip token validation to prevent expiry issues
        if (clientStudentId && testId) {
            const progressCheck = await pool.query(`
                SELECT ep.student_id, s.firebase_uid
                FROM exam_progress ep
                JOIN students s ON s.id = ep.student_id
                WHERE ep.student_id = $1 AND ep.test_id = $2
            `, [clientStudentId, testId]);

            if (progressCheck.rows.length > 0) {
                // Student has progress - skip token validation
                studentId = progressCheck.rows[0].student_id;
                firebaseUid = progressCheck.rows[0].firebase_uid;
                console.log('✅ Student has exam progress - skipping token validation');
                console.log('Student ID:', studentId);
            }
        }

        // If no progress found, validate token normally
        if (!studentId) {
            const authHeader = req.headers.authorization;
            
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                return res.status(401).json({
                    success: false,
                    message: 'Unauthorized: No token provided',
                });
            }

            const token = authHeader.split('Bearer ')[1];
            
            if (!token) {
                return res.status(401).json({
                    success: false,
                    message: 'Unauthorized: Invalid token format',
                });
            }

            try {
                const admin = require('../config/firebase');
                const decodedToken = await admin.auth().verifyIdToken(token);
                firebaseUid = decodedToken.uid;
                
                // Get student ID from Firebase UID
                const studentResult = await pool.query(
                    'SELECT id FROM students WHERE firebase_uid = $1',
                    [firebaseUid]
                );

                if (studentResult.rows.length === 0) {
                    return res.status(404).json({
                        success: false,
                        message: 'Student not found'
                    });
                }

                studentId = studentResult.rows[0].id;
                console.log('✅ Token validated - Student ID:', studentId);
            } catch (tokenError) {
                console.error('Token verification error:', tokenError);
                return res.status(401).json({
                    success: false,
                    message: 'Token expired or invalid. Please try again.',
                    code: 'TOKEN_EXPIRED'
                });
            }
        }

        console.log('Student ID from DB:', studentId);

        // 2. Validate input
        if (!testId || !answers || typeof answers !== 'object') {
            return res.status(400).json({
                success: false,
                message: 'Invalid submission data'
            });
        }

        // 3. Get test details to check max attempts and availability
        const testDetails = await pool.query(`
            SELECT title, max_attempts, start_datetime, end_datetime FROM tests WHERE id = $1
        `, [testId]);

        if (testDetails.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        const testTitle = testDetails.rows[0].title;
        const maxAttempts = testDetails.rows[0].max_attempts || 1;
        const startDateTime = testDetails.rows[0].start_datetime;
        const endDateTime = testDetails.rows[0].end_datetime;

        // REMOVED: Timezone check during submission
        // If student already started the test, they should be able to submit it
        // The availability check is done when starting the test, not during submission
        console.log('Test availability check skipped during submission (already validated at test start)');

        // Check how many attempts the student has already made
        const existingAttemptsCheck = await pool.query(`
            SELECT COUNT(*) as attempt_count
            FROM results r
            INNER JOIN exams e ON r.exam_id = e.id
            WHERE r.student_id = $1 AND e.name LIKE '%' || $2 || '%'
        `, [studentId, testTitle]);

        const attemptsTaken = parseInt(existingAttemptsCheck.rows[0]?.attempt_count) || 0;

        if (attemptsTaken >= maxAttempts) {
            return res.status(400).json({
                success: false,
                message: `You have used all ${maxAttempts} attempt(s) for this test.`,
                alreadyTaken: true,
                attemptsTaken: attemptsTaken,
                maxAttempts: maxAttempts
            });
        }

        // 4. Fetch all questions with correct answers (shuffled same as during test)
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
            ORDER BY MD5(CONCAT(id::text, $2::text)) ASC
        `, [testId, studentId]);

        if (questionsResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        // 3. Calculate marks for MCQ questions
        let totalMarks = 0;
        let marksObtained = 0;
        const questionResults = [];

        questionsResult.rows.forEach((question, index) => {
            totalMarks += question.marks || 1;
            
            // Reconstruct shuffled options to find correct mapping
            const originalOptions = [question.option_a, question.option_b, question.option_c, question.option_d].filter(opt => opt !== null && opt !== '');
            
            const shuffleSeed = parseInt(require('crypto').createHash('md5')
                .update(`${question.id}_${studentId}`)
                .digest('hex')
                .substring(0, 8), 16);
            
            // Create option mapping
            const optionMapping = ['A', 'B', 'C', 'D'].slice(0, originalOptions.length);
            const shuffledMapping = [...optionMapping];
            for (let i = shuffledMapping.length - 1; i > 0; i--) {
                const j = Math.floor(((shuffleSeed + i) * 2654435761) % (i + 1));
                [shuffledMapping[i], shuffledMapping[j]] = [shuffledMapping[j], shuffledMapping[i]];
            }
            
            // Get student's answer for this question
            const studentAnswer = answers[index]; // answers is object with index as key
            
            // Check if answer is correct (considering shuffled options)
            let isCorrect = false;
            if (studentAnswer !== undefined && studentAnswer !== null) {
                // studentAnswer is the index from frontend (0, 1, 2, 3)
                // We need to map this back to original option to check correctness
                const originalOptionIndex = ['A', 'B', 'C', 'D'].indexOf(question.correct_option.toUpperCase());
                
                // Find where the correct option ended up after shuffling
                const correctShuffledIndex = shuffledMapping.indexOf(question.correct_option.toUpperCase());
                
                isCorrect = studentAnswer === correctShuffledIndex;
                
                if (isCorrect) {
                    marksObtained += question.marks || 1;
                }
            }

            questionResults.push({
                questionId: question.id,
                questionText: question.question_text,
                studentAnswer: studentAnswer,
                correctAnswer: shuffledMapping.indexOf(question.correct_option.toUpperCase()),
                isCorrect: isCorrect,
                marks: question.marks || 1
            });
        });

        // DISABLED: CODE EXECUTION FEATURE
        // 3.5. Add marks from coding questions
        // try {
        //     // Get all coding questions for this test
        //     const codingQuestionsResult = await pool.query(
        //         `SELECT id, marks FROM coding_questions WHERE test_id = $1`,
        //         [testId]
        //     );

        //     // Get student's coding submissions
        //     const codingSubmissionsResult = await pool.query(
        //         `SELECT coding_question_id, marks_earned 
        //          FROM student_coding_submissions 
        //          WHERE student_id = $1 AND test_id = $2`,
        //         [studentId, testId]
        //     );

        //     // Add coding question marks to total
        //     codingQuestionsResult.rows.forEach(cq => {
        //         totalMarks += cq.marks || 10;
                
        //         // Find if student submitted this coding question
        //         const submission = codingSubmissionsResult.rows.find(s => s.coding_question_id === cq.id);
        //         if (submission && submission.marks_earned) {
        //             marksObtained += parseFloat(submission.marks_earned);
        //         }
        //     });

        //     console.log('Coding questions total marks:', codingQuestionsResult.rows.reduce((sum, cq) => sum + (cq.marks || 10), 0));
        //     console.log('Coding questions marks obtained:', codingSubmissionsResult.rows.reduce((sum, s) => sum + parseFloat(s.marks_earned || 0), 0));
        // } catch (codingError) {
        //     console.error('Error calculating coding question marks (table may not exist):', codingError.message);
        //     // Continue with MCQ marks only if coding marks calculation fails
        // }

        // 4. Calculate percentage and determine pass/fail (50% passing criteria)
        const percentage = (marksObtained / totalMarks) * 100;
        const status = percentage >= 50 ? 'Pass' : 'Fail';

        // 5. Find or create exam record
        let finalExamId = examId;
        
        if (!finalExamId) {
            // Create a new exam record if not provided
            const testInfo = await pool.query('SELECT title FROM tests WHERE id = $1', [testId]);
            const examName = testInfo.rows[0]?.title || 'Exam';
            
            const examResult = await pool.query(`
                INSERT INTO exams (name, date, duration)
                VALUES ($1, CURRENT_DATE, 60)
                RETURNING id
            `, [examName]);
            
            finalExamId = examResult.rows[0].id;
        }

        // 6. Store result in database
        const resultInsert = await pool.query(`
            INSERT INTO results (student_id, exam_id, marks_obtained, total_marks, status)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id
        `, [studentId, finalExamId, marksObtained, totalMarks, status]);

        // 7. Clear saved progress after successful submission
        try {
            await pool.query(`
                DELETE FROM exam_progress
                WHERE student_id = $1 AND test_id = $2
            `, [studentId, testId]);
            console.log('✅ Cleared exam progress for student:', studentId, 'test:', testId);
        } catch (progressError) {
            // Don't fail submission if progress deletion fails
            console.error('⚠️ Failed to clear exam progress (non-critical):', progressError.message);
        }

        // 8. Return success response
        res.json({
            success: true,
            message: 'Exam submitted successfully',
            result: {
                resultId: resultInsert.rows[0].id,
                studentId: studentId,
                testId: testId,
                marksObtained: marksObtained,
                totalMarks: totalMarks,
                percentage: percentage.toFixed(2),
                status: status,
                totalQuestions: questionsResult.rows.length,
                correctAnswers: questionResults.filter(q => q.isCorrect).length
            }
        });

    } catch (error) {
        console.error('Error submitting exam:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            testId,
            studentId,
            answersCount: Object.keys(answers || {}).length
        });
        res.status(500).json({
            success: false,
            message: 'Failed to submit exam',
            error: error.message
        });
    }
});

/**
 * GET /api/student/my-results
 * Fetch all results for the logged-in student
 */
router.get('/my-results', verifySession, async (req, res) => {
    const firebaseUid = req.firebaseUid;

    try {
        // Get student ID from database
        const studentResult = await pool.query(
            'SELECT id FROM students WHERE firebase_uid = $1',
            [firebaseUid]
        );

        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const studentId = studentResult.rows[0].id;

        const results = await pool.query(`
            SELECT 
                r.id,
                r.marks_obtained,
                r.total_marks,
                r.created_at,
                e.name as exam_name,
                e.date as exam_date,
                ROUND((r.marks_obtained / r.total_marks * 100), 2) as percentage,
                CASE 
                    WHEN (r.marks_obtained / r.total_marks * 100) >= 50 THEN 'Pass'
                    ELSE 'Fail'
                END as status
            FROM results r
            INNER JOIN exams e ON r.exam_id = e.id
            WHERE r.student_id = $1
            ORDER BY r.created_at DESC
        `, [studentId]);

        res.json({
            success: true,
            results: results.rows
        });

    } catch (error) {
        console.error('Error fetching student results:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch results'
        });
    }
});

/**
 * POST /api/student/create
 * Create a new student manually (admin only)
 * Automatically assigns all tests that are assigned to the student's institute
 */
router.post('/create', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { full_name, email, roll_number, institute } = req.body;

        // Validate required fields
        if (!full_name || !email || !institute) {
            return res.status(400).json({
                success: false,
                message: 'Full name, email, and institute are required'
            });
        }

        // Validate email format
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({
                success: false,
                message: 'Please enter a valid email address'
            });
        }

        await client.query('BEGIN');

        // Check if student with same email already exists
        const existingStudent = await client.query(
            'SELECT id FROM students WHERE email = $1',
            [email]
        );

        if (existingStudent.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                message: 'Student with this email already exists'
            });
        }

        const normalizedInstitute = institute.trim().toLowerCase();
        const displayInstitute = institute.trim();

        // Insert new student (without firebase_uid - manual creation)
        const result = await client.query(
            `INSERT INTO students (full_name, email, roll_number, institute, created_at, updated_at)
             VALUES ($1, $2, $3, $4, NOW(), NOW())
             RETURNING id, full_name, email, roll_number, institute, created_at`,
            [full_name, email, roll_number || null, normalizedInstitute]
        );

        const newStudent = result.rows[0];

        // No auto-assignment of tests for manually created students
        // Admin will assign tests manually as needed

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'Student created successfully. No tests assigned - admin can assign tests manually.',
            student: newStudent
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error creating student:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create student',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * DELETE /api/student/bulk
 * Delete multiple students at once (admin only)
 * Also deletes users from Firebase Authentication
 */
router.delete('/bulk', verifyAdmin, async (req, res) => {
    try {
        const { student_ids } = req.body;

        if (!student_ids || !Array.isArray(student_ids) || student_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'student_ids array is required'
            });
        }

        console.log(`[BULK DELETE] Starting deletion for ${student_ids.length} students`);

        // Get students' firebase_uids before deleting
        const studentsResult = await pool.query(
            'SELECT id, firebase_uid, full_name, email FROM students WHERE id = ANY($1)',
            [student_ids]
        );

        const students = studentsResult.rows;
        const firebaseUids = students.filter(s => s.firebase_uid).map(s => s.firebase_uid);

        // Delete from database
        const deleteResult = await pool.query(
            'DELETE FROM students WHERE id = ANY($1) RETURNING *',
            [student_ids]
        );

        // Delete from Firebase
        let firebaseDeleteCount = 0;
        let firebaseErrors = 0;

        if (firebaseUids.length > 0) {
            const admin = require('../config/firebase');
            
            for (const uid of firebaseUids) {
                try {
                    await admin.auth().deleteUser(uid);
                    firebaseDeleteCount++;
                    console.log(`✅ Deleted Firebase user: ${uid}`);
                } catch (firebaseError) {
                    firebaseErrors++;
                    console.error(`⚠️ Failed to delete Firebase user ${uid}:`, firebaseError.message);
                }
            }
        }

        console.log(`[BULK DELETE] Successfully deleted ${deleteResult.rowCount} students`);

        res.json({
            success: true,
            message: `Successfully deleted ${deleteResult.rowCount} student(s)`,
            deleted_count: deleteResult.rowCount,
            firebase_deleted: firebaseDeleteCount,
            firebase_errors: firebaseErrors > 0 ? firebaseErrors : undefined
        });

    } catch (error) {
        console.error('[BULK DELETE] Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete students',
            error: error.message
        });
    }
});

/**
 * DELETE /api/student/:id
 * Delete a single student (admin only)
 * Also deletes the user from Firebase Authentication
 */
router.delete('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // First, get the student's firebase_uid before deleting
        const studentResult = await pool.query(
            'SELECT firebase_uid, full_name, email FROM students WHERE id = $1',
            [id]
        );

        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const student = studentResult.rows[0];
        const firebaseUid = student.firebase_uid;

        // Delete from database first
        await pool.query(
            'DELETE FROM students WHERE id = $1',
            [id]
        );

        // Then delete from Firebase if firebase_uid exists
        if (firebaseUid) {
            try {
                const admin = require('../config/firebase');
                await admin.auth().deleteUser(firebaseUid);
                console.log(`✅ Deleted Firebase user: ${firebaseUid}`);
            } catch (firebaseError) {
                // Log error but don't fail the request since DB deletion succeeded
                console.error('⚠️ Failed to delete Firebase user:', firebaseError.message);
                return res.json({
                    success: true,
                    message: 'Student deleted from database, but Firebase deletion failed',
                    warning: 'Firebase user may still exist'
                });
            }
        }

        res.json({
            success: true,
            message: 'Student deleted successfully from both database and Firebase'
        });

    } catch (error) {
        console.error('Error deleting student:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete student',
            error: error.message
        });
    }
});

/**
 * DELETE /api/student/institute/:instituteName/all
 * Delete all students from a specific institute (admin only)
 * Also deletes all users from Firebase Authentication
 */
router.delete('/institute/:instituteName/all', verifyAdmin, async (req, res) => {
    try {
        const { instituteName } = req.params;

        // First, get all students' firebase_uids before deleting
        const studentsResult = await pool.query(
            'SELECT id, firebase_uid, full_name, email FROM students WHERE LOWER(institute) = LOWER($1)',
            [instituteName]
        );

        if (studentsResult.rows.length === 0) {
            return res.json({
                success: true,
                message: `No students found in ${instituteName}`,
                deleted_count: 0
            });
        }

        const students = studentsResult.rows;
        const firebaseUids = students.filter(s => s.firebase_uid).map(s => s.firebase_uid);

        // Delete from database first
        const deleteResult = await pool.query(
            'DELETE FROM students WHERE LOWER(institute) = LOWER($1) RETURNING *',
            [instituteName]
        );

        // Then delete from Firebase
        let firebaseDeleteCount = 0;
        let firebaseErrors = 0;

        if (firebaseUids.length > 0) {
            const admin = require('../config/firebase');
            
            for (const uid of firebaseUids) {
                try {
                    await admin.auth().deleteUser(uid);
                    firebaseDeleteCount++;
                    console.log(`✅ Deleted Firebase user: ${uid}`);
                } catch (firebaseError) {
                    firebaseErrors++;
                    console.error(`⚠️ Failed to delete Firebase user ${uid}:`, firebaseError.message);
                }
            }
        }

        res.json({
            success: true,
            message: `Successfully deleted ${deleteResult.rowCount} student(s) from ${instituteName}`,
            deleted_count: deleteResult.rowCount,
            firebase_deleted: firebaseDeleteCount,
            firebase_errors: firebaseErrors
        });

    } catch (error) {
        console.error('Error deleting students:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete students',
            error: error.message
        });
    }
});

module.exports = router;
