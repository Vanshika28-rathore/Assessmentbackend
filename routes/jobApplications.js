// routes/jobApplications.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const { verifySession } = require('../middleware/verifySession');
const verifyAdmin = require('../middleware/verifyAdmin');
const { sendApplicationConfirmationEmail, sendTestAssignmentEmail } = require('../config/email');

// ============================================================================
// STUDENT ROUTES - Application Submission and Tracking
// ============================================================================

/**
 * POST /api/job-applications/apply/:jobId
 * Student applies to a job opening
 * - Auto-assigns linked tests
 * - Checks eligibility (optional)
 * - Sends confirmation email
 */
router.post('/apply/:jobId', verifySession, async (req, res) => {
    const { jobId } = req.params;
    const { resume_url, cover_letter } = req.body;

    try {
        // 1. Get student details from email (Firebase token doesn't have DB id)
        const studentEmail = req.user.email;
        const studentData = await query(
            `SELECT id, email, full_name, resume_link FROM students WHERE email = $1`,
            [studentEmail]
        );

        if (studentData.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student profile not found. Please complete your profile first.'
            });
        }

        const student = studentData.rows[0];
        const studentId = student.id;
        const finalResumeUrl = resume_url || student.resume_link;

        // 2. Check if job exists and accepts internal applications
        const jobCheck = await query(
            `SELECT jo.*, 
                    (jo.registration_deadline > CURRENT_TIMESTAMP) AS is_open
             FROM job_openings jo
             WHERE jo.id = $1 AND jo.is_published = true`,
            [jobId]
        );

        if (jobCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job opening not found or not published'
            });
        }

        const job = jobCheck.rows[0];

        if (!job.is_open) {
            return res.status(400).json({
                success: false,
                message: 'Registration deadline has passed'
            });
        }

        // Allow internal enrollment for all jobs
        // Removed application_mode check - all jobs support enrollment

        // 3. Check if already applied
        const existingApp = await query(
            `SELECT id FROM job_applications WHERE job_opening_id = $1 AND student_id = $2`,
            [jobId, studentId]
        );

        if (existingApp.rows.length > 0) {
            return res.status(400).json({
                success: false,
                message: 'You have already applied to this job opening'
            });
        }

        // 4. TODO: Eligibility validation based on job_eligibility_rules
        // For now, we'll set is_eligible = true
        // Later you can add logic to check CGPA, branch, etc.

        // 5. Create application
        const applicationResult = await query(
            `INSERT INTO job_applications 
                (job_opening_id, student_id, resume_url, cover_letter, 
                 status, is_eligible, applied_at)
             VALUES ($1, $2, $3, $4, 'submitted', true, CURRENT_TIMESTAMP)
             RETURNING id`,
            [jobId, studentId, finalResumeUrl, cover_letter]
        );

        const applicationId = applicationResult.rows[0].id;

        // 6. Auto-assign linked tests
        const linkedTests = await query(
            `SELECT test_id, is_mandatory 
             FROM job_opening_tests 
             WHERE job_opening_id = $1`,
            [jobId]
        );

        if (linkedTests.rows.length > 0) {
            // Insert test assignments
            for (const testLink of linkedTests.rows) {
                await query(
                    `INSERT INTO test_assignments (test_id, student_id, is_active)
                     VALUES ($1, $2, true)
                     ON CONFLICT (test_id, student_id) DO NOTHING`,
                    [testLink.test_id, studentId]
                );
            }

            // Update application with test assignment timestamp
            await query(
                `UPDATE job_applications 
                 SET test_assigned_at = CURRENT_TIMESTAMP, status = 'assessment_assigned'
                 WHERE id = $1`,
                [applicationId]
            );

            // Send test assignment email (non-blocking - enrollment succeeds even if email fails)
            try {
                await sendTestAssignmentEmail(
                    student.email,
                    student.full_name,
                    job.company_name,
                    job.job_role,
                    linkedTests.rows.length
                );
            } catch (emailError) {
                console.error('[JOB_APPLICATIONS] Email send failed (non-critical):', emailError.message);
            }
        }

        // 7. Send application confirmation email (non-blocking)
        try {
            await sendApplicationConfirmationEmail(
                student.email,
                student.full_name,
                job.company_name,
                job.job_role
            );
        } catch (emailError) {
            console.error('[JOB_APPLICATIONS] Confirmation email failed (non-critical):', emailError.message);
        }

        res.status(201).json({
            success: true,
            message: 'Application submitted successfully',
            data: {
                applicationId,
                testsAssigned: linkedTests.rows.length,
                status: linkedTests.rows.length > 0 ? 'assessment_assigned' : 'submitted'
            }
        });

    } catch (error) {
        console.error('[JOB_APPLICATIONS] Error submitting application:', error);

        // Handle unique constraint violation
        if (error.code === '23505') {
            return res.status(400).json({
                success: false,
                message: 'You have already applied to this job opening'
            });
        }

        res.status(500).json({
            success: false,
            message: 'Failed to submit application'
        });
    }
});

/**
 * GET /api/job-applications/my-applications
 * Get all applications for logged-in student with status, scores, and job details
 */
router.get('/my-applications', verifySession, async (req, res) => {
    try {
        // Get student ID from email (Firebase token doesn't have DB id)
        const studentEmail = req.user.email;
        const studentData = await query(
            `SELECT id FROM students WHERE email = $1`,
            [studentEmail]
        );

        if (studentData.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student profile not found'
            });
        }

        const studentId = studentData.rows[0].id;

        const applications = await query(
            `SELECT 
                ja.id AS application_id,
                ja.status,
                ja.applied_at,
                ja.test_assigned_at,
                ja.test_completed_at,
                ja.assessment_score,
                ja.passed_assessment,
                ja.cover_letter,
                ja.resume_url,
                jo.id AS job_opening_id,
                jo.company_name,
                jo.job_role,
                jo.job_description,
                jo.registration_deadline,
                jo.eligibility_criteria,
                -- Count linked tests
                COALESCE(test_counts.total_tests, 0) AS total_tests,
                COALESCE(test_counts.completed_tests, 0) AS completed_tests
             FROM job_applications ja
             INNER JOIN job_openings jo ON ja.job_opening_id = jo.id
             LEFT JOIN LATERAL (
                SELECT 
                    COUNT(jot.test_id) AS total_tests,
                    COUNT(ta.id) AS completed_tests
                FROM job_opening_tests jot
                LEFT JOIN test_attempts ta ON ta.test_id = jot.test_id 
                    AND ta.student_id = ja.student_id
                    AND ta.job_application_id = ja.id
                WHERE jot.job_opening_id = jo.id
             ) AS test_counts ON true
             WHERE ja.student_id = $1
             ORDER BY ja.applied_at DESC`,
            [studentId]
        );

        res.json({
            success: true,
            data: applications.rows
        });

    } catch (error) {
        console.error('[JOB_APPLICATIONS] Error fetching applications:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch your applications'
        });
    }
});

/**
 * GET /api/job-applications/application/:applicationId
 * Get detailed information about a specific application
 */
router.get('/application/:applicationId', verifySession, async (req, res) => {
    const { applicationId } = req.params;

    try {
        // Get student ID from email (Firebase token doesn't have DB id)
        const studentEmail = req.user.email;
        const studentData = await query(
            `SELECT id FROM students WHERE email = $1`,
            [studentEmail]
        );

        if (studentData.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student profile not found'
            });
        }

        const studentId = studentData.rows[0].id;

        const application = await query(
            `SELECT 
                ja.*,
                jo.company_name,
                jo.job_role,
                jo.job_description,
                jo.eligibility_criteria,
                jo.registration_deadline
             FROM job_applications ja
             INNER JOIN job_openings jo ON ja.job_opening_id = jo.id
             WHERE ja.id = $1 AND ja.student_id = $2`,
            [applicationId, studentId]
        );

        if (application.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Application not found'
            });
        }

        // Get linked tests with completion status
        const tests = await query(
            `SELECT 
                t.id AS test_id,
                t.name AS test_name,
                t.instructions,
                ta.assigned_at,
                CASE WHEN r.marks_obtained IS NOT NULL AND r.total_marks > 0 
                     THEN ROUND((r.marks_obtained / r.total_marks * 100)::numeric, 2)
                     ELSE NULL 
                END AS score,
                r.created_at AS submitted_at,
                NULL AS time_taken_minutes
             FROM job_opening_tests jot
             INNER JOIN tests t ON jot.test_id = t.id
             LEFT JOIN test_assignments ta ON t.id = ta.test_id AND ta.student_id = $2
             LEFT JOIN results r ON t.id = r.exam_id AND r.student_id = $2
             WHERE jot.job_opening_id = $1`,
            [application.rows[0].job_opening_id, studentId]
        );

        res.json({
            success: true,
            data: {
                ...application.rows[0],
                linked_tests: tests.rows
            }
        });

    } catch (error) {
        console.error('[JOB_APPLICATIONS] Error fetching application details:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch application details'
        });
    }
});

// ============================================================================
// ADMIN ROUTES - Application Management and Recruitment Dashboard
// ============================================================================

/**
 * GET /api/job-applications/admin/job/:jobId/applicants
 * Admin views all applicants for a specific job with scores and status
 */
router.get('/admin/job/:jobId/applicants', verifyAdmin, async (req, res) => {
    const { jobId } = req.params;
    const { status } = req.query; // Optional filter: submitted, assessment_assigned, etc.

    try {
        let statusFilter = '';
        let params = [jobId];

        if (status) {
            statusFilter = 'AND ja.status = $2';
            params.push(status);
        }

        const applicants = await query(
            `SELECT 
                ja.id AS application_id,
                ja.status,
                ja.applied_at,
                ja.test_assigned_at,
                ja.test_completed_at,
                ja.assessment_score,
                ja.passed_assessment,
                ja.resume_url,
                ja.cover_letter,
                s.id AS student_id,
                s.email,
                s.full_name,
                s.phone,
                s.course,
                s.specialization,
                s.institute,
                -- Count tests linked to this job
                COUNT(DISTINCT jot.test_id) AS total_tests,
                -- Count tests assigned to student  
                COUNT(DISTINCT ta.id) AS completed_tests,
                -- Use assessment score from job_applications
                ja.assessment_score AS avg_score
             FROM job_applications ja
             INNER JOIN students s ON ja.student_id = s.id
             LEFT JOIN job_opening_tests jot ON ja.job_opening_id = jot.job_opening_id
             LEFT JOIN test_assignments ta ON ta.test_id = jot.test_id AND ta.student_id = s.id AND ta.is_active = true
             WHERE ja.job_opening_id = $1 ${statusFilter}
             GROUP BY ja.id, s.id, ja.assessment_score
             ORDER BY ja.applied_at DESC`,
            params
        );

        res.json({
            success: true,
            data: applicants.rows
        });

    } catch (error) {
        console.error('[JOB_APPLICATIONS] Error fetching applicants:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch applicants'
        });
    }
});

/**
 * PATCH /api/job-applications/admin/application/:applicationId/status
 * Admin updates application status (shortlist, reject, etc.)
 */
router.patch('/admin/application/:applicationId/status', verifyAdmin, async (req, res) => {
    const { applicationId } = req.params;
    const { status, eligibility_notes } = req.body;
    const adminId = req.admin.id; // verifyAdmin sets req.admin, not req.user

    const validStatuses = [
        'submitted',
        'screening',
        'assessment_assigned',
        'assessment_completed',
        'shortlisted',
        'rejected'
    ];

    if (!validStatuses.includes(status)) {
        return res.status(400).json({
            success: false,
            message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
        });
    }

    try {
        const result = await query(
            `UPDATE job_applications
             SET status = $1,
                 eligibility_notes = COALESCE($2, eligibility_notes),
                 reviewed_by = $3,
                 reviewed_at = CURRENT_TIMESTAMP,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = $4
             RETURNING *`,
            [status, eligibility_notes, adminId, applicationId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Application not found'
            });
        }

        res.json({
            success: true,
            message: 'Application status updated',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('[JOB_APPLICATIONS] Error updating application status:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update application status'
        });
    }
});

/**
 * GET /api/job-applications/admin/stats/:jobId
 * Get application statistics for a job opening
 */
router.get('/admin/stats/:jobId', verifyAdmin, async (req, res) => {
    const { jobId } = req.params;

    try {
        const stats = await query(
            `SELECT 
                COUNT(*) AS total_applications,
                COUNT(*) FILTER (WHERE status = 'submitted') AS submitted,
                COUNT(*) FILTER (WHERE status = 'assessment_assigned') AS assessment_assigned,
                COUNT(*) FILTER (WHERE status = 'assessment_completed') AS assessment_completed,
                COUNT(*) FILTER (WHERE status = 'shortlisted') AS shortlisted,
                COUNT(*) FILTER (WHERE status = 'rejected') AS rejected,
                COUNT(*) FILTER (WHERE passed_assessment = true) AS passed_count,
                AVG(assessment_score) FILTER (WHERE assessment_score IS NOT NULL) AS avg_assessment_score
             FROM job_applications
             WHERE job_opening_id = $1`,
            [jobId]
        );

        res.json({
            success: true,
            data: stats.rows[0]
        });

    } catch (error) {
        console.error('[JOB_APPLICATIONS] Error fetching application stats:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch application statistics'
        });
    }
});

/**
 * GET /api/job-applications/admin/job/:jobId/test-results
 * Get detailed test results with violations for all applicants of a job
 */
router.get('/admin/job/:jobId/test-results', verifyAdmin, async (req, res) => {
    const { jobId } = req.params;

    try {
        const results = await query(
            `SELECT 
                ja.id AS application_id,
                ja.status,
                s.id AS student_id,
                s.email,
                s.full_name,
                t.id AS test_id,
                t.title AS test_name,
                ta.obtained_marks,
                ta.total_marks,
                ta.percentage,
                ta.submitted_at,
                t.passing_percentage,
                CASE 
                    WHEN ta.percentage >= t.passing_percentage THEN true
                    ELSE false
                END AS passed,
                COALESCE(
                    (SELECT COUNT(*) 
                     FROM proctoring_violations pv 
                     WHERE pv.student_id = s.id::varchar 
                     AND pv.test_id = t.id
                     AND pv.violation_type = 'no_face'), 
                    0
                ) AS no_face_count,
                COALESCE(
                    (SELECT COUNT(*) 
                     FROM proctoring_violations pv 
                     WHERE pv.student_id = s.id::varchar 
                     AND pv.test_id = t.id
                     AND pv.violation_type = 'multi_face'), 
                    0
                ) AS multi_face_count,
                COALESCE(
                    (SELECT COUNT(*) 
                     FROM proctoring_violations pv 
                     WHERE pv.student_id = s.id::varchar 
                     AND pv.test_id = t.id
                     AND pv.violation_type = 'phone_detected'), 
                    0
                ) AS phone_count,
                COALESCE(
                    (SELECT COUNT(*) 
                     FROM proctoring_violations pv 
                     WHERE pv.student_id = s.id::varchar 
                     AND pv.test_id = t.id
                     AND pv.violation_type = 'noise_detected'), 
                    0
                ) AS noise_count,
                COALESCE(
                    (SELECT COUNT(*) 
                     FROM proctoring_violations pv 
                     WHERE pv.student_id = s.id::varchar 
                     AND pv.test_id = t.id
                     AND pv.violation_type = 'voice_detected'), 
                    0
                ) AS voice_count,
                COALESCE(
                    (SELECT COUNT(*) 
                     FROM proctoring_violations pv 
                     WHERE pv.student_id = s.id::varchar 
                     AND pv.test_id = t.id), 
                    0
                ) AS violation_count
             FROM job_applications ja
             INNER JOIN students s ON ja.student_id = s.id
             LEFT JOIN job_opening_tests jot ON ja.job_opening_id = jot.job_opening_id
             LEFT JOIN tests t ON jot.test_id = t.id
             LEFT JOIN test_attempts ta ON ta.test_id = t.id 
                AND ta.student_id = s.id 
                AND ta.job_application_id = ja.id
             WHERE ja.job_opening_id = $1
             ORDER BY s.full_name ASC, t.title ASC`,
            [jobId]
        );

        res.json({
            success: true,
            data: results.rows
        });

    } catch (error) {
        console.error('[JOB_APPLICATIONS] Error fetching test results:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch test results'
        });
    }
});

/**
 * GET /api/job-applications/:applicationId/tests
 * Get tests linked to a specific job application (for student)
 */
router.get('/:applicationId/tests', verifySession, async (req, res) => {
    try {
        const { applicationId } = req.params;
        const studentEmail = req.user.email;

        // Get student ID from email
        const studentResult = await query(
            'SELECT id FROM students WHERE email = $1',
            [studentEmail]
        );

        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const studentId = studentResult.rows[0].id;

        // Verify the application belongs to this student
        const appCheck = await query(
            'SELECT job_opening_id FROM job_applications WHERE id = $1 AND student_id = $2',
            [applicationId, studentId]
        );

        if (appCheck.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message: 'Access denied'
            });
        }

        const jobOpeningId = appCheck.rows[0].job_opening_id;

        // Get tests linked to this job with completion status FOR THIS SPECIFIC APPLICATION
        const result = await query(
            `SELECT 
                t.id AS test_id,
                t.title AS test_name,
                t.description,
                t.duration,
                t.passing_percentage,
                jot.is_mandatory,
                jot.passing_criteria,
                COUNT(q.id) AS question_count,
                COALESCE(SUM(q.marks), 0) AS total_marks,
                -- Check if student has completed this test FOR THIS SPECIFIC APPLICATION
                CASE 
                    WHEN EXISTS (
                        SELECT 1 FROM test_attempts ta
                        WHERE ta.test_id = t.id 
                        AND ta.student_id = $2
                        AND ta.job_application_id = $3
                    ) THEN true
                    ELSE false
                END AS is_completed,
                -- Get the score percentage if completed FOR THIS SPECIFIC APPLICATION
                (
                    SELECT ta.percentage
                    FROM test_attempts ta
                    WHERE ta.test_id = t.id 
                    AND ta.student_id = $2
                    AND ta.job_application_id = $3
                    ORDER BY ta.submitted_at DESC
                    LIMIT 1
                ) AS score_percentage
             FROM job_opening_tests jot
             INNER JOIN tests t ON jot.test_id = t.id
             LEFT JOIN questions q ON t.id = q.test_id
             WHERE jot.job_opening_id = $1
             GROUP BY t.id, t.title, t.description, t.duration, t.passing_percentage, jot.is_mandatory, jot.passing_criteria, jot.created_at
             ORDER BY jot.created_at ASC`,
            [jobOpeningId, studentId, applicationId]
        );

        res.json({
            success: true,
            tests: result.rows
        });

    } catch (error) {
        console.error('[JOB_APP] Error fetching application tests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch tests'
        });
    }
});

module.exports = router;