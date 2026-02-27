const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const verifyAdmin = require('../middleware/verifyAdmin');

/**
 * GET /api/institutes/public
 * Fetch active institutes for student registration (public endpoint)
 */
router.get('/public', async (req, res) => {
    try {
        console.log('=== GET /api/institutes/public called ===');
        
        // Ensure the institutes table exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS institutes (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                display_name VARCHAR(255) NOT NULL,
                created_by VARCHAR(255) DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            );
        `);

        // Get all active institutes
        const result = await pool.query(`
            SELECT id, display_name, name
            FROM institutes
            WHERE is_active = true
            ORDER BY display_name ASC
        `);

        console.log('Active institutes found:', result.rows.length);

        res.json({
            success: true,
            institutes: result.rows
        });
    } catch (error) {
        console.error('Error fetching public institutes:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch institutes',
            error: error.message
        });
    }
});

/**
 * GET /api/institutes
 * Fetch all institutes (admin only)
 */
router.get('/', verifyAdmin, async (req, res) => {
    try {
        console.log('=== GET /api/institutes called ===');
        
        // First, ensure the institutes table exists
        await pool.query(`
            CREATE TABLE IF NOT EXISTS institutes (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                display_name VARCHAR(255) NOT NULL,
                created_by VARCHAR(255) DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true
            );
        `);
        
        await pool.query(`CREATE INDEX IF NOT EXISTS idx_institutes_name ON institutes(LOWER(name));`);
        
        console.log('Institutes table ensured');

        // Create the institute_test_assignments table if it doesn't exist
        await pool.query(`
            CREATE TABLE IF NOT EXISTS institute_test_assignments (
                id SERIAL PRIMARY KEY,
                institute_id INTEGER REFERENCES institutes(id) ON DELETE CASCADE,
                test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                UNIQUE(institute_id, test_id)
            )
        `);
        
        console.log('institute_test_assignments table ensured');

        // Check if we have any institutes, if not, create from existing student data
        const existingInstitutes = await pool.query('SELECT COUNT(*) as count FROM institutes');
        console.log('Existing institutes count:', existingInstitutes.rows[0].count);

        if (existingInstitutes.rows[0].count === '0') {
            console.log('No institutes found, migrating from student data...');
            
            // Auto-create missing institute records for existing students
            await pool.query(`
                INSERT INTO institutes (name, display_name, created_by)
                SELECT DISTINCT 
                    LOWER(TRIM(institute_value)) as name,
                    TRIM(institute_value) as display_name,
                    'auto_migration' as created_by
                FROM (
                    SELECT COALESCE(NULLIF(TRIM(s.institute), ''), NULLIF(TRIM(s.college_name), ''), 'Not Specified') as institute_value
                    FROM students s
                    WHERE (s.institute IS NOT NULL AND TRIM(s.institute) != '') 
                       OR (s.college_name IS NOT NULL AND TRIM(s.college_name) != '')
                ) AS combined_institutes
                WHERE NOT EXISTS (
                    SELECT 1 FROM institutes i 
                    WHERE i.name = LOWER(TRIM(institute_value))
                )
                ON CONFLICT (name) DO NOTHING
            `);

            // Add default institutes
            await pool.query(`
                INSERT INTO institutes (name, display_name, created_by)
                VALUES 
                    ('not specified', 'Not Specified', 'system'),
                    ('other', 'Other', 'system')
                ON CONFLICT (name) DO NOTHING
            `);

            console.log('Migration completed');
        }

        // Update students with missing institute data
        await pool.query(`
            UPDATE students 
            SET institute = COALESCE(NULLIF(TRIM(institute), ''), NULLIF(TRIM(college_name), ''), 'not specified')
            WHERE institute IS NULL OR TRIM(institute) = ''
        `);

        console.log('Student institute data updated');

        // Get all institutes with student counts
        const result = await pool.query(`
            SELECT 
                i.id,
                i.name,
                i.display_name,
                i.created_at,
                i.is_active,
                i.registration_status,
                i.registration_start_time,
                i.registration_deadline,
                CASE 
                    WHEN i.registration_status = 'closed' THEN false
                    WHEN i.registration_status = 'paused' THEN false
                    WHEN i.registration_start_time IS NOT NULL AND i.registration_start_time > NOW() THEN false
                    WHEN i.registration_deadline IS NULL THEN true
                    WHEN i.registration_deadline > NOW() THEN true
                    ELSE false
                END as is_registration_open,
                COUNT(DISTINCT s.id) as student_count,
                (
                    SELECT COUNT(DISTINCT test_id) 
                    FROM (
                        SELECT ita.test_id
                        FROM institute_test_assignments ita
                        WHERE ita.institute_id = i.id
                        UNION
                        SELECT ta.test_id
                        FROM test_assignments ta
                        JOIN students st ON ta.student_id = st.id
                        WHERE LOWER(st.institute) = i.name
                    ) combined_tests
                ) as assigned_tests_count
            FROM institutes i
            LEFT JOIN students s ON LOWER(s.institute) = i.name
            WHERE i.is_active = true
            GROUP BY i.id, i.name, i.display_name, i.created_at, i.is_active, i.registration_status, i.registration_start_time, i.registration_deadline
            ORDER BY i.created_at DESC
        `);

        console.log('Query executed successfully');
        console.log('Institutes found:', result.rows.length);

        res.json({
            success: true,
            institutes: result.rows
        });
    } catch (error) {
        console.error('Error fetching institutes:', error);
        console.error('Error stack:', error.stack);
        console.error('Error code:', error.code);
        console.error('Error detail:', error.detail);
        
        // Provide more specific error information
        let errorMessage = 'Failed to fetch institutes';
        if (error.code === '42P01') {
            errorMessage = 'Database table missing - please run database setup';
        } else if (error.code === '28P01') {
            errorMessage = 'Database authentication failed';
        } else if (error.code === 'ECONNREFUSED') {
            errorMessage = 'Database connection refused';
        }
        
        res.status(500).json({
            success: false,
            message: errorMessage,
            error: error.message,
            code: error.code
        });
    }
});

/**
 * POST /api/institutes
 * Create a new institute (admin only)
 */
router.post('/', verifyAdmin, async (req, res) => {
    try {
        const { instituteName } = req.body;

        if (!instituteName || instituteName.trim() === '') {
            return res.status(400).json({
                success: false,
                message: 'Institute name is required'
            });
        }

        const trimmedName = instituteName.trim();
        const normalizedName = trimmedName.toLowerCase();

        // Check if institute already exists
        const existingInstitute = await pool.query(
            'SELECT * FROM institutes WHERE name = $1',
            [normalizedName]
        );

        if (existingInstitute.rows.length > 0) {
            const institute = existingInstitute.rows[0];
            
            // If institute exists but is inactive, reactivate it
            if (!institute.is_active) {
                const result = await pool.query(
                    'UPDATE institutes SET is_active = true, display_name = $1 WHERE id = $2 RETURNING id, name, display_name, created_at, is_active',
                    [trimmedName, institute.id]
                );
                
                return res.status(200).json({
                    success: true,
                    message: 'Institute reactivated successfully',
                    institute: result.rows[0]
                });
            }
            
            // If active, return conflict error
            return res.status(409).json({
                success: false,
                message: 'Institute already exists',
                institute: institute
            });
        }

        // Insert new institute
        const result = await pool.query(`
            INSERT INTO institutes (name, display_name)
            VALUES ($1, $2)
            RETURNING id, name, display_name, created_at, is_active
        `, [normalizedName, trimmedName]);

        const newInstitute = result.rows[0];

        res.status(201).json({
            success: true,
            message: 'Institute created successfully',
            institute: newInstitute
        });
    } catch (error) {
        console.error('Error creating institute:', error);
        
        // Handle unique constraint violation
        if (error.code === '23505') {
            return res.status(409).json({
                success: false,
                message: 'Institute already exists'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to create institute',
            error: error.message
        });
    }
});

/**
 * GET /api/institutes/:instituteName/students
 * Get all students from a specific institute (admin only)
 */
router.get('/:instituteName/students', verifyAdmin, async (req, res) => {
    try {
        const { instituteName } = req.params;
        
        // Auto-create institute record if it doesn't exist but has students
        await pool.query(`
            INSERT INTO institutes (name, display_name, created_by)
            SELECT DISTINCT 
                LOWER(TRIM($1)) as name,
                TRIM($1) as display_name,
                'auto_migration' as created_by
            WHERE EXISTS (
                SELECT 1 FROM students s 
                WHERE LOWER(s.institute) = LOWER(TRIM($1))
            )
            AND NOT EXISTS (
                SELECT 1 FROM institutes i 
                WHERE i.name = LOWER(TRIM($1))
            )
        `, [instituteName]);
        
        const result = await pool.query(`
            SELECT 
                s.id,
                s.full_name,
                s.email,
                s.roll_number,
                s.institute,
                s.created_at,
                COUNT(DISTINCT ta.test_id) FILTER (WHERE ta.is_active = true) as assigned_tests_count
            FROM students s
            LEFT JOIN test_assignments ta ON s.id = ta.student_id
            WHERE LOWER(s.institute) = LOWER($1)
            GROUP BY s.id, s.full_name, s.email, s.roll_number, s.institute, s.created_at
            ORDER BY s.full_name ASC
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
 * POST /api/institutes/:instituteId/assign-test
 * Assign a test to an institute (admin only)
 * This creates an institute-level assignment that applies to all current and future students
 */
router.post('/:instituteId/assign-test', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { instituteId } = req.params;
        const { test_id } = req.body;

        if (!test_id) {
            return res.status(400).json({
                success: false,
                message: 'test_id is required'
            });
        }

        await client.query('BEGIN');

        // Verify institute exists
        const instituteResult = await client.query(
            'SELECT id, name FROM institutes WHERE id = $1 AND is_active = true',
            [instituteId]
        );

        if (instituteResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Institute not found'
            });
        }

        const instituteName = instituteResult.rows[0].name;

        // Verify test exists
        const testCheck = await client.query('SELECT id, title FROM tests WHERE id = $1', [test_id]);
        if (testCheck.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        const testTitle = testCheck.rows[0].title;

        // Create institute_test_assignments table if it doesn't exist
        await client.query(`
            CREATE TABLE IF NOT EXISTS institute_test_assignments (
                id SERIAL PRIMARY KEY,
                institute_id INTEGER REFERENCES institutes(id) ON DELETE CASCADE,
                test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                UNIQUE(institute_id, test_id)
            )
        `);

        // Check if test is already assigned to this institute
        const existingAssignment = await client.query(
            'SELECT id FROM institute_test_assignments WHERE institute_id = $1 AND test_id = $2',
            [instituteId, test_id]
        );

        if (existingAssignment.rows.length > 0) {
            await client.query('ROLLBACK');
            return res.status(409).json({
                success: false,
                message: `Test "${testTitle}" is already assigned to this institute`,
                already_assigned: true
            });
        }

        // Create the institute-level assignment
        await client.query(`
            INSERT INTO institute_test_assignments (institute_id, test_id)
            VALUES ($1, $2)
        `, [instituteId, test_id]);

        // Also assign to all existing students in this institute
        const studentsResult = await client.query(
            'SELECT id FROM students WHERE LOWER(institute) = $1',
            [instituteName]
        );

        let assignedToStudents = 0;
        if (studentsResult.rows.length > 0) {
            const studentIds = studentsResult.rows.map(row => row.id);

            // Create test_assignments table if not exists
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

            // Assign test to all existing students
            const insertPromises = studentIds.map(student_id =>
                client.query(`
                    INSERT INTO test_assignments (test_id, student_id)
                    VALUES ($1, $2)
                    ON CONFLICT (test_id, student_id) 
                    DO NOTHING
                `, [test_id, student_id])
            );

            await Promise.all(insertPromises);
            assignedToStudents = studentIds.length;
        }

        await client.query('COMMIT');

        res.json({
            success: true,
            message: assignedToStudents > 0 
                ? `Test "${testTitle}" assigned to institute and ${assignedToStudents} existing student(s). Future students will automatically receive this test.`
                : `Test "${testTitle}" assigned to institute. Students who register with this institute will automatically receive this test.`,
            assigned_count: assignedToStudents,
            institute_assignment: true
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error assigning test to institute:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to assign test to institute',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * DELETE /api/institutes/:id
 * Soft delete an institute (admin only)
 * Note: This doesn't delete students, just marks institute as inactive
 */
router.delete('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Soft delete the institute (allowed even with students)
        const result = await pool.query(
            'UPDATE institutes SET is_active = false WHERE id = $1 RETURNING *',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Institute not found'
            });
        }

        res.json({
            success: true,
            message: 'Institute deleted successfully'
        });
    } catch (error) {
        console.error('Error deleting institute:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete institute',
            error: error.message
        });
    }
});

/**
 * GET /api/institutes/:id/assigned-tests
 * Get all tests assigned to a specific institute (admin only)
 */
router.get('/:id/assigned-tests', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Verify institute exists
        const instituteResult = await pool.query(
            'SELECT id, name, display_name FROM institutes WHERE id = $1 AND is_active = true',
            [id]
        );

        if (instituteResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Institute not found'
            });
        }

        const institute = instituteResult.rows[0];

        // Get all tests assigned to this institute (both institute-level and student-level)
        const result = await pool.query(`
            SELECT DISTINCT
                t.id,
                t.title,
                COUNT(DISTINCT q.id) as question_count,
                t.duration as duration_minutes,
                CASE 
                    WHEN ita.id IS NOT NULL THEN true 
                    ELSE false 
                END as is_institute_level
            FROM tests t
            LEFT JOIN institute_test_assignments ita 
                ON t.id = ita.test_id 
                AND ita.institute_id = $1
            LEFT JOIN students s ON LOWER(s.institute) = $2
            LEFT JOIN test_assignments ta 
                ON t.id = ta.test_id 
                AND s.id = ta.student_id
            LEFT JOIN questions q ON t.id = q.test_id
            WHERE (ita.id IS NOT NULL OR ta.id IS NOT NULL)
            GROUP BY t.id, t.title, t.duration, ita.id
            ORDER BY t.title ASC
        `, [id, institute.name]);

        res.json({
            success: true,
            institute: institute,
            tests: result.rows
        });
    } catch (error) {
        console.error('Error fetching assigned tests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch assigned tests',
            error: error.message
        });
    }
});

/**
 * DELETE /api/institutes/:id/unassign-test/:testId
 * Unassign a test from an institute (admin only)
 * This removes both institute-level and student-level assignments
 */
router.delete('/:id/unassign-test/:testId', verifyAdmin, async (req, res) => {
    const client = await pool.connect();
    try {
        const { id, testId } = req.params;

        await client.query('BEGIN');

        // Verify institute exists
        const instituteResult = await client.query(
            'SELECT id, name, display_name FROM institutes WHERE id = $1 AND is_active = true',
            [id]
        );

        if (instituteResult.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({
                success: false,
                message: 'Institute not found'
            });
        }

        const instituteName = instituteResult.rows[0].name;

        // Remove institute-level assignment
        await client.query(
            'DELETE FROM institute_test_assignments WHERE institute_id = $1 AND test_id = $2',
            [id, testId]
        );

        // Remove student-level assignments for all students in this institute
        const deleteResult = await client.query(`
            DELETE FROM test_assignments 
            WHERE test_id = $1 
            AND student_id IN (
                SELECT id FROM students WHERE LOWER(institute) = $2
            )
        `, [testId, instituteName]);

        await client.query('COMMIT');

        res.json({
            success: true,
            message: 'Test unassigned successfully from institute',
            removed_student_assignments: deleteResult.rowCount
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Error unassigning test:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unassign test',
            error: error.message
        });
    } finally {
        client.release();
    }
});

/**
 * GET /api/institutes/:instituteName/students-with-details
 * Get all students from a specific institute with full details including resume links (admin only)
 */
router.get('/:instituteName/students-with-details', verifyAdmin, async (req, res) => {
    try {
        const { instituteName } = req.params;
        
        const result = await pool.query(`
            SELECT 
                s.id,
                s.full_name,
                s.email,
                s.roll_number,
                s.institute,
                s.phone,
                s.address,
                s.course,
                s.specialization,
                s.resume_link,
                s.created_at,
                COUNT(DISTINCT ta.test_id) as assigned_tests_count,
                COUNT(DISTINCT tar.id) as completed_tests_count
            FROM students s
            LEFT JOIN test_assignments ta ON s.id = ta.student_id
            LEFT JOIN test_attempts tar ON s.id = tar.student_id
            WHERE LOWER(s.institute) = LOWER($1)
            GROUP BY s.id, s.full_name, s.email, s.roll_number, s.institute, 
                     s.phone, s.address, s.course, s.specialization, s.resume_link, s.created_at
            ORDER BY s.full_name ASC
        `, [instituteName]);

        res.json({
            success: true,
            institute: instituteName,
            students: result.rows
        });
    } catch (error) {
        console.error('Error fetching students with details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch students',
            error: error.message
        });
    }
});

/**
 * PUT /api/institutes/students/:studentId
 * Update student information including resume link (admin only)
 */
router.put('/students/:studentId', verifyAdmin, async (req, res) => {
    try {
        const { studentId } = req.params;
        const { full_name, email, phone, address, course, specialization, resume_link } = req.body;

        // Validate required fields
        if (!full_name || !email) {
            return res.status(400).json({
                success: false,
                message: 'Full name and email are required'
            });
        }

        // Update student information
        const result = await pool.query(`
            UPDATE students 
            SET 
                full_name = $1,
                email = $2,
                phone = $3,
                address = $4,
                course = $5,
                specialization = $6,
                resume_link = $7,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $8
            RETURNING id, full_name, email, roll_number, institute, phone, address, course, specialization, resume_link, created_at, updated_at
        `, [full_name, email, phone || null, address || null, course || null, specialization || null, resume_link || null, studentId]);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        res.json({
            success: true,
            message: 'Student information updated successfully',
            student: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating student:', error);
        
        // Handle unique constraint violations
        if (error.code === '23505') {
            return res.status(409).json({
                success: false,
                message: 'Email already exists'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to update student information',
            error: error.message
        });
    }
});

/**
 * DELETE /api/institutes/students/:studentId
 * Delete a student (admin only)
 * This will cascade delete all related records (test assignments, attempts, etc.)
 * Also deletes the user from Firebase Authentication
 */
router.delete('/students/:studentId', verifyAdmin, async (req, res) => {
    try {
        const { studentId } = req.params;

        // First, get the student's firebase_uid before deleting
        const studentResult = await pool.query(
            'SELECT firebase_uid, full_name, email FROM students WHERE id = $1',
            [studentId]
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
            [studentId]
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
                    message: `Student ${student.full_name} deleted from database, but Firebase deletion failed`,
                    warning: 'Firebase user may still exist'
                });
            }
        }

        res.json({
            success: true,
            message: `Student ${student.full_name} deleted successfully from both database and Firebase`
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
 * GET /api/institutes/students/:studentId/resume
 * Get student resume link (admin only)
 */
router.get('/students/:studentId/resume', verifyAdmin, async (req, res) => {
    try {
        const { studentId } = req.params;

        const result = await pool.query(
            'SELECT id, full_name, email, resume_link FROM students WHERE id = $1',
            [studentId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const student = result.rows[0];

        if (!student.resume_link) {
            return res.status(404).json({
                success: false,
                message: 'Resume link not available for this student'
            });
        }

        res.json({
            success: true,
            student: {
                id: student.id,
                full_name: student.full_name,
                email: student.email,
                resume_link: student.resume_link
            }
        });
    } catch (error) {
        console.error('Error fetching student resume:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch student resume',
            error: error.message
        });
    }
});

/**
 * PUT /api/institutes/:id/registration-control
 * Update registration status and deadline for an institute
 */
router.put('/:id/registration-control', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const { registration_status, registration_start_time, registration_deadline } = req.body;

        // Validate status
        const validStatuses = ['open', 'closed', 'paused'];
        if (registration_status && !validStatuses.includes(registration_status)) {
            return res.status(400).json({
                success: false,
                message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
            });
        }

        // Build update query dynamically
        const updates = [];
        const values = [];
        let paramCount = 1;

        if (registration_status !== undefined) {
            updates.push(`registration_status = $${paramCount}`);
            values.push(registration_status);
            paramCount++;
        }

        if (registration_start_time !== undefined) {
            updates.push(`registration_start_time = $${paramCount}`);
            values.push(registration_start_time || null);
            paramCount++;
        }

        if (registration_deadline !== undefined) {
            updates.push(`registration_deadline = $${paramCount}`);
            values.push(registration_deadline || null);
            paramCount++;
        }

        if (updates.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'No fields to update'
            });
        }

        values.push(id);
        const query = `
            UPDATE institutes 
            SET ${updates.join(', ')}
            WHERE id = $${paramCount}
            RETURNING id, name, display_name, registration_status, registration_start_time, registration_deadline
        `;

        const result = await pool.query(query, values);

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Institute not found'
            });
        }

        res.json({
            success: true,
            message: 'Registration control updated successfully',
            institute: result.rows[0]
        });
    } catch (error) {
        console.error('Error updating registration control:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update registration control',
            error: error.message
        });
    }
});

/**
 * GET /api/institutes/:id/registration-status
 * Get registration status for an institute (public endpoint for registration page)
 */
router.get('/:id/registration-status', async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            `SELECT 
                id, 
                display_name, 
                registration_status,
                registration_start_time,
                registration_deadline,
                CASE 
                    WHEN registration_status = 'closed' THEN false
                    WHEN registration_status = 'paused' THEN false
                    WHEN registration_start_time IS NOT NULL AND registration_start_time > NOW() THEN false
                    WHEN registration_deadline IS NULL THEN true
                    WHEN registration_deadline > NOW() THEN true
                    ELSE false
                END as is_registration_open
            FROM institutes 
            WHERE id = $1 AND is_active = true`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Institute not found'
            });
        }

        const institute = result.rows[0];
        let message = '';

        if (institute.registration_status === 'closed') {
            message = 'Registration is closed for this institute';
        } else if (institute.registration_status === 'paused') {
            message = 'Registration is temporarily paused';
        } else if (institute.registration_start_time && new Date() < new Date(institute.registration_start_time)) {
            message = `Registration will open on ${new Date(institute.registration_start_time).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
        } else if (institute.registration_deadline && new Date() > new Date(institute.registration_deadline)) {
            message = `Registration deadline has passed (${new Date(institute.registration_deadline).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST)`;
        } else if (institute.registration_deadline) {
            message = `Registration open until ${new Date(institute.registration_deadline).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`;
        } else {
            message = 'Registration is open';
        }

        res.json({
            success: true,
            institute: {
                id: institute.id,
                display_name: institute.display_name,
                registration_status: institute.registration_status,
                registration_start_time: institute.registration_start_time,
                registration_deadline: institute.registration_deadline,
                is_registration_open: institute.is_registration_open,
                message
            }
        });
    } catch (error) {
        console.error('Error fetching registration status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch registration status',
            error: error.message
        });
    }
});

module.exports = router;