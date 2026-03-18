const express = require('express');
const router = express.Router();
const multer = require('multer');
const xlsx = require('xlsx');
const csv = require('csv-parser');
const stream = require('stream');
const { pool } = require('../config/db');
const verifyAdmin = require('../middleware/verifyAdmin');

// Configure Multer (Memory Storage)
const storage = multer.memoryStorage();
const upload = multer({
    storage: storage,
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

const normalizeJobRoles = (jobRoles) => {
    if (!Array.isArray(jobRoles)) return [];
    return jobRoles
        .map((role) => ({
            job_role: typeof role?.job_role === 'string' ? role.job_role.trim() : '',
            job_description: typeof role?.job_description === 'string' ? role.job_description.trim() : ''
        }))
        .filter((role) => role.job_role !== '' || role.job_description !== '');
};

/**
 * POST /api/admin/upload/questions
 * Upload a bulk file of questions
 */
router.post('/questions', verifyAdmin, upload.single('file'), async (req, res) => {
    const client = await pool.connect();
    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const { testName, jobRoles, testDescription, duration, maxAttempts, passingPercentage, startDateTime, endDateTime, status } = req.body;
        if (!testName) {
            return res.status(400).json({ success: false, message: 'Test Name is required' });
        }

        // Parse jobRoles if it's a string (from FormData)
        let parsedJobRoles = [];
        if (jobRoles) {
            try {
                parsedJobRoles = typeof jobRoles === 'string' ? JSON.parse(jobRoles) : jobRoles;
            } catch (e) {
                parsedJobRoles = [{ job_role: jobRoles, job_description: testDescription || '' }];
            }
        }
        const normalizedJobRoles = normalizeJobRoles(parsedJobRoles);

        console.log('=== BULK UPLOAD REQUEST ===');
        console.log('Test Name:', testName);
        console.log('Job Roles:', normalizedJobRoles);
        console.log('Duration:', duration, 'Type:', typeof duration);
        console.log('Max Attempts:', maxAttempts, 'Type:', typeof maxAttempts);
        console.log('Passing Percentage:', passingPercentage, 'Type:', typeof passingPercentage);
        console.log('Start DateTime:', startDateTime);
        console.log('End DateTime:', endDateTime);
        console.log('Status:', status);

        let data = [];

        // Check file type
        // Note: mimetype for CSV can vary (text/csv, application/vnd.ms-excel, etc.)
        const isCsv = req.file.originalname.toLowerCase().endsWith('.csv') || req.file.mimetype === 'text/csv';

        if (isCsv) {
            // Parse CSV using csv-parser
            const bufferStream = new stream.PassThrough();
            bufferStream.end(req.file.buffer);

            await new Promise((resolve, reject) => {
                bufferStream
                    .pipe(csv())
                    .on('data', (row) => data.push(row))
                    .on('end', resolve)
                    .on('error', reject);
            });
        } else {
            // Parse Excel using xlsx
            try {
                const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];
                data = xlsx.utils.sheet_to_json(sheet);
            } catch (e) {
                return res.status(400).json({ success: false, message: 'Invalid Excel file format' });
            }
        }



        if (data.length === 0) {
            return res.status(400).json({ success: false, message: 'File is empty' });
        }

        // Start Transaction
        await client.query('BEGIN');

        // Check for duplicate test name
        const duplicateCheck = await client.query(
            'SELECT id FROM tests WHERE LOWER(title) = LOWER($1)',
            [testName]
        );
        
        if (duplicateCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                success: false, 
                message: `A test with the name "${testName}" already exists. Please use a different name.` 
            });
        }

        // 1. Create Test with additional details
        const defaultJobRole = normalizedJobRoles.length > 0 ? normalizedJobRoles[0].job_role : '';
        const defaultJobDescription = normalizedJobRoles.length > 0 ? normalizedJobRoles[0].job_description : testDescription || '';
        
        const testResult = await client.query(
            `INSERT INTO tests (title, job_role, description, duration, max_attempts, passing_percentage, start_datetime, end_datetime, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [
                testName,
                defaultJobRole,
                defaultJobDescription, 
                parseInt(duration) || 60,
                parseInt(maxAttempts) || 1,
                parseInt(passingPercentage) || 50,
                startDateTime || null,
                endDateTime || null,
                status || 'draft'
            ]
        );
        const testId = testResult.rows[0].id;

        // 1.5. Insert multiple job roles if provided
        if (normalizedJobRoles.length > 0) {
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

            for (let i = 0; i < normalizedJobRoles.length; i++) {
                const role = normalizedJobRoles[i];
                await client.query(`
                    INSERT INTO test_job_roles (test_id, job_role, job_description, is_default)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (test_id, job_role) DO NOTHING
                `, [testId, role.job_role, role.job_description || '', i === 0]);
            }
        }

        // 2. Insert Questions
        let insertedCount = 0;
        for (const row of data) {
            // Normalize keys to handle case sensitivity and spaces
            const getVal = (key) => {
                const normalizedKey = key.toLowerCase().replace(/\s+/g, '');
                for (const k of Object.keys(row)) {
                    if (k.toLowerCase().replace(/\s+/g, '') === normalizedKey) return row[k];
                }
                return undefined;
            };

            const questionText = getVal('question');
            const optionA = getVal('optiona');
            const optionB = getVal('optionb');
            const optionC = getVal('optionc');
            const optionD = getVal('optiond');
            const correctOption = getVal('correctoption'); // matches 'Correct Option' -> 'correctoption'
            const marks = getVal('marks') || 1;

            if (questionText && optionA && optionB && correctOption) {
                await client.query(
                    `INSERT INTO questions 
                    (test_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        testId,
                        questionText,
                        optionA,
                        optionB,
                        optionC || '',
                        optionD || '',
                        correctOption.toString().replace(/[^A-D]/gi, '').toUpperCase(), // Clean input to just A, B, C, or D
                        marks
                    ]
                );
                insertedCount++;
            } else {
                // console.warn('Skipping invalid row:', row);
            }
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Successfully created test "${testName}" with ${insertedCount} questions.`,
            testId: testId,
            questionsCount: insertedCount
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Upload Error:', error);
        res.status(500).json({
            success: false,
            message: 'Upload failed',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * POST /api/admin/upload/question
 * Add a single question to a test
 * Body: { testId, questionText, optionA, optionB, optionC, optionD, correctOption, marks }
 */
router.post('/question', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const {
            testId,
            testName,
            testDescription,
            questionText,
            optionA,
            optionB,
            optionC,
            optionD,
            correctOption,
            marks
        } = req.body;

        // Validation
        if (!questionText || !optionA || !optionB || !correctOption) {
            return res.status(400).json({
                success: false,
                message: 'Question text, Option A, Option B, and Correct Option are required'
            });
        }

        // Validate correct option is A, B, C, or D
        const cleanCorrectOption = correctOption.toString().toUpperCase().trim();
        if (!['A', 'B', 'C', 'D'].includes(cleanCorrectOption)) {
            return res.status(400).json({
                success: false,
                message: 'Correct option must be A, B, C, or D'
            });
        }

        await client.query('BEGIN');

        let finalTestId = testId;

        // If no testId provided, create a new test
        if (!finalTestId) {
            if (!testName) {
                await client.query('ROLLBACK');
                return res.status(400).json({
                    success: false,
                    message: 'Either testId or testName is required'
                });
            }

            // Check for duplicate test name
            const duplicateCheck = await client.query(
                'SELECT id FROM tests WHERE LOWER(title) = LOWER($1)',
                [testName]
            );
            
            if (duplicateCheck.rows.length > 0) {
                await client.query('ROLLBACK');
                return res.status(400).json({ 
                    success: false, 
                    message: `A test with the name "${testName}" already exists. Please use a different name.` 
                });
            }

            const testResult = await client.query(
                'INSERT INTO tests (title, description) VALUES ($1, $2) RETURNING id',
                [testName, testDescription || '']
            );
            finalTestId = testResult.rows[0].id;
        } else {
            // Verify test exists
            const testCheck = await client.query('SELECT id FROM tests WHERE id = $1', [finalTestId]);
            if (testCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                return res.status(404).json({
                    success: false,
                    message: 'Test not found'
                });
            }
        }

        // Insert the question
        const result = await client.query(
            `INSERT INTO questions 
            (test_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks) 
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8) 
            RETURNING id`,
            [
                finalTestId,
                questionText,
                optionA,
                optionB,
                optionC || '',
                optionD || '',
                cleanCorrectOption,
                marks || 1
            ]
        );

        await client.query('COMMIT');

        res.status(201).json({
            success: true,
            message: 'Question added successfully',
            questionId: result.rows[0].id,
            testId: finalTestId
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Single Question Upload Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add question',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * POST /api/upload/manual
 * Create a test with manually entered questions
 * Body: { testName, testDescription, questions: [{question, optiona, optionb, optionc, optiond, correctoption, marks}] }
 */
router.post('/manual', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { testName, jobRoles, testDescription, duration, maxAttempts, passingPercentage, startDateTime, endDateTime, status, questions } = req.body;

        // Parse jobRoles if needed
        let parsedJobRoles = [];
        if (jobRoles) {
            parsedJobRoles = Array.isArray(jobRoles) ? jobRoles : JSON.parse(jobRoles);
        }
        const normalizedJobRoles = normalizeJobRoles(parsedJobRoles);

        console.log('=== MANUAL UPLOAD REQUEST ===');
        console.log('Test Name:', testName);
        console.log('Job Roles:', normalizedJobRoles);
        console.log('Duration:', duration, 'Type:', typeof duration);
        console.log('Max Attempts:', maxAttempts, 'Type:', typeof maxAttempts);
        console.log('Passing Percentage:', passingPercentage, 'Type:', typeof passingPercentage);
        console.log('Start DateTime:', startDateTime);
        console.log('End DateTime:', endDateTime);
        console.log('Status:', status);
        console.log('Questions count:', questions?.length);

        if (!testName || !questions || questions.length === 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Test name and at least one question are required' 
            });
        }

        await client.query('BEGIN');

        // Check for duplicate test name
        const duplicateCheck = await client.query(
            'SELECT id FROM tests WHERE LOWER(title) = LOWER($1)',
            [testName]
        );
        
        if (duplicateCheck.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(400).json({ 
                success: false, 
                message: `A test with the name "${testName}" already exists. Please use a different name.` 
            });
        }

        // Create test with additional details
        const defaultJobRole = normalizedJobRoles.length > 0 ? normalizedJobRoles[0].job_role : '';
        const defaultJobDescription = normalizedJobRoles.length > 0 ? normalizedJobRoles[0].job_description : testDescription || '';
        
        const testResult = await client.query(
            `INSERT INTO tests (title, job_role, description, duration, max_attempts, passing_percentage, start_datetime, end_datetime, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [
                testName,
                defaultJobRole,
                defaultJobDescription, 
                parseInt(duration) || 60,
                parseInt(maxAttempts) || 1,
                parseInt(passingPercentage) || 50,
                startDateTime || null,
                endDateTime || null,
                status || 'draft'
            ]
        );
        const testId = testResult.rows[0].id;

        // Insert multiple job roles if provided
        if (normalizedJobRoles.length > 0) {
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

            for (let i = 0; i < normalizedJobRoles.length; i++) {
                const role = normalizedJobRoles[i];
                await client.query(`
                    INSERT INTO test_job_roles (test_id, job_role, job_description, is_default)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (test_id, job_role) DO NOTHING
                `, [testId, role.job_role, role.job_description || '', i === 0]);
            }
        }

        // Insert questions
        let insertedCount = 0;
        for (const q of questions) {
            if (q.question && q.optiona && q.optionb && q.correctoption) {
                await client.query(
                    `INSERT INTO questions 
                    (test_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        testId,
                        q.question,
                        q.optiona,
                        q.optionb,
                        q.optionc || '',
                        q.optiond || '',
                        q.correctoption.toString().toUpperCase(),
                        q.marks || 1
                    ]
                );
                insertedCount++;
            }
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Successfully created test "${testName}" with ${insertedCount} questions.`,
            testId: testId,
            questionsCount: insertedCount
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Manual Upload Error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to create test',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * PUT /api/upload/questions/:testId
 * Update test questions by uploading a new file (replaces all existing questions)
 * Only works for draft tests
 */
router.put('/questions/:testId', verifyAdmin, upload.single('file'), async (req, res) => {
    const client = await pool.connect();
    try {
        const { testId } = req.params;

        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        const { testName, jobRoles, testDescription, duration, maxAttempts, passingPercentage, startDateTime, endDateTime } = req.body;

        // Parse jobRoles if it's a string (from FormData)
        let parsedJobRoles = [];
        if (jobRoles) {
            try {
                parsedJobRoles = typeof jobRoles === 'string' ? JSON.parse(jobRoles) : jobRoles;
            } catch (e) {
                parsedJobRoles = [{ job_role: jobRoles, job_description: testDescription || '' }];
            }
        }
        const normalizedJobRoles = normalizeJobRoles(parsedJobRoles);

        console.log('=== BULK UPDATE REQUEST ===');
        console.log('Test ID:', testId);
        console.log('Test Name:', testName);

        // Check if test exists and is draft
        const testCheck = await client.query(
            'SELECT id, status FROM tests WHERE id = $1',
            [testId]
        );

        if (testCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        if (testCheck.rows[0].status !== 'draft') {
            return res.status(400).json({
                success: false,
                message: 'Only draft tests can be edited'
            });
        }

        let data = [];

        // Check file type
        const isCsv = req.file.originalname.toLowerCase().endsWith('.csv') || req.file.mimetype === 'text/csv';

        if (isCsv) {
            // Parse CSV
            const bufferStream = new stream.PassThrough();
            bufferStream.end(req.file.buffer);

            await new Promise((resolve, reject) => {
                bufferStream
                    .pipe(csv())
                    .on('data', (row) => data.push(row))
                    .on('end', resolve)
                    .on('error', reject);
            });
        } else {
            // Parse Excel
            try {
                const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];
                data = xlsx.utils.sheet_to_json(sheet);
            } catch (e) {
                return res.status(400).json({ success: false, message: 'Invalid Excel file format' });
            }
        }

        if (data.length === 0) {
            return res.status(400).json({ success: false, message: 'File is empty' });
        }

        // Start Transaction
        await client.query('BEGIN');

        // Update test details
        const defaultJobRole = normalizedJobRoles.length > 0 ? normalizedJobRoles[0].job_role : '';
        const defaultJobDescription = normalizedJobRoles.length > 0 ? normalizedJobRoles[0].job_description : testDescription || '';
        
        await client.query(
            `UPDATE tests 
             SET title = $1, job_role = $2, description = $3, duration = $4, max_attempts = $5, 
                 passing_percentage = $6, start_datetime = $7, end_datetime = $8
             WHERE id = $9`,
            [
                testName,
                defaultJobRole,
                defaultJobDescription, 
                parseInt(duration) || 60,
                parseInt(maxAttempts) || 1,
                parseInt(passingPercentage) || 50,
                startDateTime || null,
                endDateTime || null,
                testId
            ]
        );

        // Update job roles
        if (normalizedJobRoles.length > 0) {
            await client.query('DELETE FROM test_job_roles WHERE test_id = $1', [testId]);

            for (let i = 0; i < normalizedJobRoles.length; i++) {
                const role = normalizedJobRoles[i];
                await client.query(`
                    INSERT INTO test_job_roles (test_id, job_role, job_description, is_default)
                    VALUES ($1, $2, $3, $4)
                    ON CONFLICT (test_id, job_role) DO NOTHING
                `, [testId, role.job_role, role.job_description || '', i === 0]);
            }
        } else {
            await client.query('DELETE FROM test_job_roles WHERE test_id = $1', [testId]);
        }

        // Delete all existing questions
        await client.query('DELETE FROM questions WHERE test_id = $1', [testId]);

        // Insert new questions from file
        let insertedCount = 0;
        for (const row of data) {
            const getVal = (key) => {
                const normalizedKey = key.toLowerCase().replace(/\s+/g, '');
                for (const k of Object.keys(row)) {
                    if (k.toLowerCase().replace(/\s+/g, '') === normalizedKey) return row[k];
                }
                return undefined;
            };

            const questionText = getVal('question');
            const optionA = getVal('optiona');
            const optionB = getVal('optionb');
            const optionC = getVal('optionc');
            const optionD = getVal('optiond');
            const correctOption = getVal('correctoption');
            const marks = getVal('marks') || 1;

            if (questionText && optionA && optionB && correctOption) {
                await client.query(
                    `INSERT INTO questions 
                    (test_id, question_text, option_a, option_b, option_c, option_d, correct_option, marks) 
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                    [
                        testId,
                        questionText,
                        optionA,
                        optionB,
                        optionC || '',
                        optionD || '',
                        correctOption.toString().replace(/[^A-D]/gi, '').toUpperCase(),
                        marks
                    ]
                );
                insertedCount++;
            }
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: `Successfully updated test "${testName}" with ${insertedCount} questions.`,
            testId: testId,
            questionsCount: insertedCount
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Bulk Update Error:', error);
        res.status(500).json({
            success: false,
            message: 'Update failed',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * POST /api/upload/students
 * Bulk upload students from CSV file
 * CSV columns: fullname, contact, email, institute, password (optional - will be auto-generated)
 */
router.post('/students', verifyAdmin, upload.single('file'), async (req, res) => {
    const client = await pool.connect();
    const admin = require('../config/firebase');
    const { sendCredentialsEmail } = require('../config/email');

    try {
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'No file uploaded' });
        }

        console.log('=== BULK STUDENT UPLOAD REQUEST ===');
        console.log('File:', req.file.originalname);

        let data = [];
        const isCsv = req.file.originalname.toLowerCase().endsWith('.csv') || req.file.mimetype === 'text/csv';

        // Parse file
        if (isCsv) {
            const bufferStream = new stream.PassThrough();
            bufferStream.end(req.file.buffer);

            await new Promise((resolve, reject) => {
                bufferStream
                    .pipe(csv())
                    .on('data', (row) => data.push(row))
                    .on('end', resolve)
                    .on('error', reject);
            });
        } else {
            try {
                const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
                const sheetName = workbook.SheetNames[0];
                const sheet = workbook.Sheets[sheetName];
                data = xlsx.utils.sheet_to_json(sheet);
            } catch (e) {
                return res.status(400).json({ success: false, message: 'Invalid Excel file format' });
            }
        }

        if (data.length === 0) {
            return res.status(400).json({ success: false, message: 'File is empty' });
        }

        console.log(`Processing ${data.length} students...`);

        // Validate columns
        const requiredColumns = ['fullname', 'email', 'institute'];
        const firstRow = data[0];
        const columns = Object.keys(firstRow).map(k => k.toLowerCase().trim());
        const missingColumns = requiredColumns.filter(col => {
            return !columns.some(c => c.includes(col.toLowerCase()));
        });

        if (missingColumns.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Missing required columns: ${missingColumns.join(', ')}. Required columns are: fullname, email, institute, contact (optional)`
            });
        }

        await client.query('BEGIN');

        // Ensure students table has all required columns
        await client.query(`
            ALTER TABLE students 
            ADD COLUMN IF NOT EXISTS institute VARCHAR(255),
            ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
            ADD COLUMN IF NOT EXISTS roll_number VARCHAR(100);
        `);

        // Remove unique constraint from roll_number if it exists
        await client.query(`
            ALTER TABLE students DROP CONSTRAINT IF EXISTS students_roll_number_key;
        `);

        // Make firebase_uid nullable temporarily for bulk upload
        await client.query(`
            ALTER TABLE students ALTER COLUMN firebase_uid DROP NOT NULL;
        `);

        const results = {
            success: [],
            errors: [],
            total: data.length
        };

        for (let i = 0; i < data.length; i++) {
            const row = data[i];
            try {
                // Normalize column names (handle different case and spacing)
                const normalizedRow = {};
                Object.keys(row).forEach(key => {
                    const normalizedKey = key.toLowerCase().trim();
                    normalizedRow[normalizedKey] = row[key];
                });

                // Extract data with flexible column name matching
                const fullname = normalizedRow.fullname || normalizedRow['full name'] || normalizedRow.name || '';
                const email = normalizedRow.email || normalizedRow['email address'] || '';
                const institute = normalizedRow.institute || normalizedRow.university || normalizedRow.college || '';
                const contact = normalizedRow.contact || normalizedRow.phone || normalizedRow.mobile || '';

                // Validate required fields
                if (!fullname || !email || !institute) {
                    results.errors.push({
                        row: i + 1,
                        email: email || 'N/A',
                        error: 'Missing required fields (fullname, email, or institute)'
                    });
                    continue;
                }

                // Validate email format
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(email)) {
                    results.errors.push({
                        row: i + 1,
                        email,
                        error: 'Invalid email format'
                    });
                    continue;
                }

                // Generate password: firstname@2026
                const firstName = fullname.trim().split(' ')[0];
                const password = `${firstName}@2026`;

                // Check if student already exists in database
                const existingStudent = await client.query(
                    'SELECT id, firebase_uid, email FROM students WHERE email = $1',
                    [email]
                );

                if (existingStudent.rows.length > 0) {
                    results.errors.push({
                        row: i + 1,
                        email,
                        error: 'Student with this email already exists'
                    });
                    continue;
                }

                // Normalize institute name
                const normalizedInstitute = institute.trim().toLowerCase();
                const displayInstitute = institute.trim();

                // Ensure institute exists in institutes table
                await client.query(
                    `INSERT INTO institutes (name, display_name, created_by)
                     VALUES ($1, $2, 'bulk_upload')
                     ON CONFLICT (name) DO NOTHING`,
                    [normalizedInstitute, displayInstitute]
                );

                // Create Firebase user
                let firebaseUid = null;
                try {
                    const firebaseUser = await admin.auth().createUser({
                        email: email,
                        password: password,
                        displayName: fullname,
                        emailVerified: false
                    });
                    firebaseUid = firebaseUser.uid;
                    console.log(`✅ Firebase user created: ${email}`);
                } catch (firebaseError) {
                    if (firebaseError.code === 'auth/email-already-exists') {
                        // Try to get existing Firebase user
                        try {
                            const existingFirebaseUser = await admin.auth().getUserByEmail(email);
                            firebaseUid = existingFirebaseUser.uid;
                            console.log(`⚠️  Using existing Firebase user: ${email}`);
                        } catch (getError) {
                            results.errors.push({
                                row: i + 1,
                                email,
                                error: `Firebase error: ${firebaseError.message}`
                            });
                            continue;
                        }
                    } else {
                        results.errors.push({
                            row: i + 1,
                            email,
                            error: `Firebase error: ${firebaseError.message}`
                        });
                        continue;
                    }
                }

                // Insert student into database
                const studentResult = await client.query(
                    `INSERT INTO students (firebase_uid, full_name, email, institute, phone, roll_number, created_at, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
                     RETURNING id, full_name, email, institute`,
                    [firebaseUid, fullname, email, normalizedInstitute, contact || null, email]
                );

                const student = studentResult.rows[0];

                // Send credentials email (non-blocking)
                sendCredentialsEmail(email, fullname, password, displayInstitute)
                    .then(result => {
                        if (result.success) {
                            console.log(`✅ Credentials email sent to ${email}`);
                        } else {
                            console.warn(`⚠️  Failed to send email to ${email}: ${result.message || result.error}`);
                        }
                    })
                    .catch(err => {
                        console.error(`❌ Error sending email to ${email}:`, err.message);
                    });

                results.success.push({
                    row: i + 1,
                    email,
                    fullname,
                    institute: displayInstitute,
                    password
                });

                console.log(`✅ Student created: ${email}`);

            } catch (rowError) {
                console.error(`Error processing row ${i + 1}:`, rowError);
                results.errors.push({
                    row: i + 1,
                    email: row.email || 'N/A',
                    error: rowError.message
                });
            }
        }

        await client.query('COMMIT');

        console.log('=== BULK UPLOAD COMPLETE ===');
        console.log(`Success: ${results.success.length}`);
        console.log(`Errors: ${results.errors.length}`);

        res.json({
            success: true,
            message: `Bulk upload completed. ${results.success.length} students created, ${results.errors.length} errors.`,
            results: results
        });

    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Bulk upload error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to upload students',
            error: error.message
        });
    } finally {
        client.release();
    }
});

module.exports = router;