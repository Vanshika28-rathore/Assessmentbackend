const express = require('express');
const router = express.Router();
const { query, pool } = require('../config/db');
const verifyToken = require('../middleware/verifyToken'); // Only for login/register
const { verifySession } = require('../middleware/verifySession'); // For protected routes
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key-change-in-production';

// COMMENTED OUT - OTP and Email Service imports
// const otpService = require('../services/otpService');
// const emailService = require('../services/emailService');

/**
 * COMMENTED OUT - POST /api/send-otp
 * Send OTP to email for verification
 */
// router.post('/send-otp', async (req, res) => {
//     try {
//         const { email, fullName } = req.body;

//         console.log('[SEND OTP] Request received:', { email, fullName });

//         if (!email || !fullName) {
//             return res.status(400).json({
//                 success: false,
//                 message: 'Email and full name are required',
//             });
//         }

//         // Validate email format
//         const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
//         if (!emailRegex.test(email)) {
//             return res.status(400).json({
//                 success: false,
//                 message: 'Invalid email format',
//             });
//         }

//         // Check if email is already registered
//         const existingUser = await query(
//             'SELECT id FROM students WHERE email = $1',
//             [email.toLowerCase().trim()]
//         );

//         if (existingUser.rows.length > 0) {
//             return res.status(409).json({
//                 success: false,
//                 message: 'This email is already registered. Please login instead.',
//             });
//         }

//         // Generate OTP
//         const otp = otpService.generateOTP();
//         console.log('[SEND OTP] Generated OTP:', otp);

//         // Store OTP in database
//         const storeResult = await otpService.storeOTP(email, otp);
//         if (!storeResult.success) {
//             return res.status(429).json({
//                 success: false,
//                 message: storeResult.message,
//             });
//         }

//         // Send OTP email
//         const emailResult = await emailService.sendOTPEmail(email, otp, fullName);
//         if (!emailResult.success) {
//             return res.status(500).json({
//                 success: false,
//                 message: 'Failed to send OTP email. Please try again.',
//             });
//         }

//         console.log('[SEND OTP] Success:', { email });

//         return res.json({
//             success: true,
//             message: 'OTP sent to your email address',
//         });

//     } catch (error) {
//         console.error('[SEND OTP] Error:', error);
//         return res.status(500).json({
//             success: false,
//             message: 'Internal server error',
//             error: error.message,
//         });
//     }
// });

/**
 * COMMENTED OUT - POST /api/verify-otp
 * Verify OTP before registration
 */
// router.post('/verify-otp', async (req, res) => {
//     try {
//         const { email, otp } = req.body;

//         console.log('[VERIFY OTP] Request received:', { email, otp: otp ? '******' : 'missing' });

//         if (!email || !otp) {
//             return res.status(400).json({
//                 success: false,
//                 message: 'Email and OTP are required',
//             });
//         }

//         // Verify OTP
//         const verifyResult = await otpService.verifyOTP(email, otp);
        
//         if (!verifyResult.success) {
//             return res.status(400).json({
//                 success: false,
//                 message: verifyResult.message,
//             });
//         }

//         console.log('[VERIFY OTP] Success:', { email });

//         return res.json({
//             success: true,
//             message: 'OTP verified successfully',
//         });

//     } catch (error) {
//         console.error('[VERIFY OTP] Error:', error);
//         return res.status(500).json({
//             success: false,
//             message: 'Internal server error',
//             error: error.message,
//         });
//     }
// });

/**
 * POST /api/register
 * Register a new student in PostgreSQL after Firebase registration and OTP verification
 * Frontend should register user in Firebase first, verify OTP, then call this endpoint
 */
router.post('/register', verifyToken, async (req, res) => {
    const client = await pool.connect();
    try {
        const { full_name, email, roll_number, institute, phone, address, course, specialization, resume_link } = req.body;
        const firebase_uid = req.firebaseUid;

        console.log('[REGISTRATION] Starting registration for:', { institute, email, roll_number });

        if (!full_name || !email || !roll_number || !institute || !resume_link) {
            return res.status(400).json({
                success: false,
                message: 'Missing required fields: full_name, email, roll_number, institute, resume_link',
            });
        }

        const normalizedInstitute = institute.trim().toLowerCase();
        const displayInstitute = institute.trim();

        console.log('[REGISTRATION] Normalized institute:', normalizedInstitute);

        await client.query('BEGIN');

        // REMOVED: 6 ALTER TABLE commands that were running on EVERY registration
        // These should be run once during deployment/migration, not per registration
        // This alone saves 5-15 seconds per registration

        // Check if user already exists
        const existingUser = await client.query(
            'SELECT * FROM students WHERE firebase_uid = $1 OR email = $2 OR roll_number = $3',
            [firebase_uid, email, roll_number]
        );

        if (existingUser.rows.length > 0) {
            await client.query('ROLLBACK');
            const existing = existingUser.rows[0];

            if (existing.firebase_uid === firebase_uid) {
                return res.status(409).json({
                    success: false,
                    message: 'User already registered with this Firebase account',
                });
            }

            if (existing.email === email) {
                return res.status(409).json({
                    success: false,
                    message: 'Email already registered',
                });
            }

            if (existing.roll_number === roll_number) {
                return res.status(409).json({
                    success: false,
                    message: 'Roll number already registered',
                });
            }
        }

        // Check if institute exists and verify registration is allowed
        console.log('[REGISTRATION] Checking institute status...');
        const instituteCheck = await client.query(
            'SELECT name, display_name, registration_status, registration_start_time, registration_deadline FROM institutes WHERE name = $1 AND is_active = true',
            [normalizedInstitute]
        );

        console.log('[REGISTRATION] Institute check result:', instituteCheck.rows);

        let instituteData;

        if (instituteCheck.rows.length === 0) {
            console.log('[REGISTRATION] Institute not found, creating new one');
            // Institute doesn't exist - create it with default 'open' status and no deadline
            const newInstitute = await client.query(
                `INSERT INTO institutes (name, display_name, created_by, registration_status) 
                 VALUES ($1, $2, 'student_registration', 'open')
                 ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name
                 RETURNING name, display_name, registration_status, registration_start_time, registration_deadline`,
                [normalizedInstitute, displayInstitute]
            );
            instituteData = newInstitute.rows[0];
            console.log('[REGISTRATION] New institute created:', instituteData);
        } else {
            instituteData = instituteCheck.rows[0];
            console.log('[REGISTRATION] Existing institute found:', instituteData);
        }

        // Now check registration status and deadline for ALL cases (existing or newly created)
        console.log('[REGISTRATION] Checking registration status:', instituteData.registration_status);
        
        // Check 1: Registration status must be 'open'
        if (instituteData.registration_status === 'closed') {
            console.log('[REGISTRATION] BLOCKED - Institute is closed');
            await client.query('ROLLBACK');
            return res.status(403).json({
                success: false,
                message: 'Registration is closed for this institute. Please contact your administrator.',
            });
        }
        
        if (instituteData.registration_status === 'paused') {
            console.log('[REGISTRATION] BLOCKED - Institute is paused');
            await client.query('ROLLBACK');
            return res.status(403).json({
                success: false,
                message: 'Registration is temporarily paused for this institute. Please try again later.',
            });
        }
        
        // Check 2: Registration start time (if set)
        if (instituteData.registration_start_time) {
            const now = new Date();
            const startTime = new Date(instituteData.registration_start_time);
            
            console.log('[REGISTRATION] Checking start time:', { now, startTime });
            
            if (now < startTime) {
                console.log('[REGISTRATION] BLOCKED - Registration not yet started');
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: `Registration has not started yet for this institute. Registration opens on ${startTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`,
                });
            }
        }
        
        // Check 3: Registration deadline (if set)
        if (instituteData.registration_deadline) {
            const now = new Date();
            const deadline = new Date(instituteData.registration_deadline);
            
            console.log('[REGISTRATION] Checking deadline:', { now, deadline });
            
            if (now > deadline) {
                console.log('[REGISTRATION] BLOCKED - Deadline passed');
                await client.query('ROLLBACK');
                return res.status(403).json({
                    success: false,
                    message: `Registration deadline has passed for this institute. Deadline was ${deadline.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST.`,
                });
            }
        }

        console.log('[REGISTRATION] All checks passed, proceeding with registration');

        // Insert new student into database
        const result = await client.query(
            `INSERT INTO students (firebase_uid, full_name, email, roll_number, institute, phone, address, course, specialization, resume_link) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
             RETURNING id, firebase_uid, full_name, email, roll_number, institute, phone, address, course, specialization, resume_link, created_at`,
            [firebase_uid, full_name, email, roll_number, normalizedInstitute, phone || null, address || null, course || null, specialization || null, resume_link]
        );

        const newUser = result.rows[0];

        // REMOVED: CREATE TABLE IF NOT EXISTS for test_assignments and institute_test_assignments
        // These should be in migration, not per registration
        
        // Check if the institute exists in the institutes table
        const instituteRecord = await client.query(
            'SELECT id FROM institutes WHERE name = $1 AND is_active = true',
            [normalizedInstitute]
        );

        let testsToAssign = [];

        // Method 1: Check for institute-level test assignments (new approach)
        if (instituteRecord.rows.length > 0) {
            const instituteId = instituteRecord.rows[0].id;
            const instituteTests = await client.query(
                `SELECT test_id
                 FROM institute_test_assignments
                 WHERE institute_id = $1 AND is_active = true`,
                [instituteId]
            );
            testsToAssign = instituteTests.rows.map(row => row.test_id);
        }

        // Method 2: Fallback - check if any student from the same institute has assignments (old approach)
        if (testsToAssign.length === 0) {
            const instituteTests = await client.query(
                `SELECT DISTINCT ta.test_id
                 FROM test_assignments ta
                 JOIN students s ON ta.student_id = s.id
                 WHERE LOWER(s.institute) = $1 AND ta.is_active = true`,
                [normalizedInstitute]
            );
            testsToAssign = instituteTests.rows.map(row => row.test_id);
        }

        // Auto-assign those tests to the new student
        if (testsToAssign.length > 0) {
            for (const testId of testsToAssign) {
                await client.query(
                    `INSERT INTO test_assignments (test_id, student_id, is_active)
                     VALUES ($1, $2, true)
                     ON CONFLICT (test_id, student_id) DO NOTHING`,
                    [testId, newUser.id]
                );
            }
        }

        // Auto-assign ALL mock tests to every new student (regardless of institute)
        try {
            const mockTestsResult = await client.query(
                'SELECT id FROM tests WHERE is_mock_test = true'
            );
            for (const mockTest of mockTestsResult.rows) {
                await client.query(
                    `INSERT INTO test_assignments (test_id, student_id, is_active)
                     VALUES ($1, $2, true)
                     ON CONFLICT (test_id, student_id) DO NOTHING`,
                    [mockTest.id, newUser.id]
                );
            }
            if (mockTestsResult.rows.length > 0) {
                console.log(`${mockTestsResult.rows.length} mock test(s) auto-assigned to new student: ${full_name}`);
            }
        } catch (mockErr) {
            console.error('Warning: Could not auto-assign mock test:', mockErr.message);
            // Don't fail registration if mock test assignment fails
        }

        await client.query('COMMIT');

        return res.status(201).json({
            success: true,
            message: 'Registration successful',
            user: {
                id: newUser.id,
                firebase_uid: newUser.firebase_uid,
                full_name: newUser.full_name,
                email: newUser.email,
                roll_number: newUser.roll_number,
                institute: newUser.institute,
                phone: newUser.phone,
                address: newUser.address,
                course: newUser.course,
                specialization: newUser.specialization,
                resume_link: newUser.resume_link,
                created_at: newUser.created_at,
            },
        });
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('Registration error:', error);
        console.error('Error stack:', error.stack);
        console.error('Error code:', error.code);
        console.error('Error detail:', error.detail);

        // Handle database-specific errors
        if (error.code === '23505') { // Unique violation
            return res.status(409).json({
                success: false,
                message: 'User with this information already exists',
            });
        }

        return res.status(500).json({
            success: false,
            message: 'Internal server error during registration',
            error: error.message,
            errorCode: error.code,
            errorDetail: error.detail
        });
    } finally {
        client.release();
    }
});

/**
 * POST /api/login
 * Verify Firebase token and return user profile (student or admin) with JWT session token
 * Frontend should authenticate with Firebase first, then call this endpoint
 */
router.post('/login', verifyToken, async (req, res) => {
    try {
        const firebase_uid = req.firebaseUid; // From verifyToken middleware
        const email = req.firebaseEmail; // From verifyToken middleware

        console.log('[LOGIN] Attempting login for:', { firebase_uid, email });

        // Check if user is an admin (by email)
        const adminResult = await query(
            'SELECT id, email, full_name, created_at FROM admins WHERE email = $1',
            [email]
        );

        if (adminResult.rows.length > 0) {
            const admin = adminResult.rows[0];
            console.log('[LOGIN] Admin found:', { id: admin.id, email: admin.email });

            // Generate JWT session token for admin (valid for 24 hours)
            const sessionToken = jwt.sign(
                { 
                    id: admin.id,
                    email: admin.email, 
                    role: 'admin',
                    type: 'session'
                },
                JWT_SECRET,
                { expiresIn: '24h' }
            );

            return res.status(200).json({
                success: true,
                message: 'Admin login successful',
                token: sessionToken,
                role: 'admin',
                user: {
                    id: admin.id,
                    email: admin.email,
                    full_name: admin.full_name,
                    created_at: admin.created_at,
                },
            });
        }

        // Check if user is a student
        const studentResult = await query(
            'SELECT id, firebase_uid, full_name, email, roll_number, institute, phone, address, course, specialization, created_at FROM students WHERE firebase_uid = $1',
            [firebase_uid]
        );

        if (studentResult.rows.length === 0) {
            console.log('[LOGIN] User not found in students or admins');
            return res.status(404).json({
                success: false,
                message: 'User profile not found. Please register first.',
            });
        }

        const student = studentResult.rows[0];
        console.log('[LOGIN] Student found:', { id: student.id, email: student.email });

        // Generate JWT session token for student (valid for 7 days)
        const sessionToken = jwt.sign(
            { 
                id: student.id, 
                firebase_uid: student.firebase_uid,
                email: student.email, 
                role: 'student',
                type: 'session'
            },
            JWT_SECRET,
            { expiresIn: '7d' }
        );

        return res.status(200).json({
            success: true,
            message: 'Student login successful',
            token: sessionToken,
            role: 'student',
            user: {
                id: student.id,
                firebase_uid: student.firebase_uid,
                full_name: student.full_name,
                email: student.email,
                roll_number: student.roll_number,
                institute: student.institute,
                phone: student.phone,
                address: student.address,
                course: student.course,
                specialization: student.specialization,
                created_at: student.created_at,
            },
        });
    } catch (error) {
        console.error('[LOGIN] Error:', error);

        return res.status(500).json({
            success: false,
            message: 'Internal server error during login',
            error: error.message,
        });
    }
});

/**
 * GET /api/profile
 * Get current user's profile (protected route example)
 */
router.get('/profile', verifySession, async (req, res) => {
    try {
        const firebase_uid = req.firebaseUid;

        const result = await query(
            'SELECT id, firebase_uid, full_name, email, roll_number, institute, phone, address, course, specialization, created_at FROM students WHERE firebase_uid = $1',
            [firebase_uid]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found',
            });
        }

        return res.status(200).json({
            success: true,
            user: result.rows[0],
        });
    } catch (error) {
        console.error('Profile fetch error:', error);

        return res.status(500).json({
            success: false,
            message: 'Error fetching profile',
            error: error.message,
        });
    }
});

module.exports = router;
