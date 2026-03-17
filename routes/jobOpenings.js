// routes/jobOpenings.js
const express = require('express');
const router = express.Router();
const { query } = require('../config/db');
const verifyAdmin = require('../middleware/verifyAdmin');
const { sendJobOpeningEmail } = require('../config/email');

// ---------------------------------------------------------------------------
// PUBLIC: GET /api/job-openings/public/active
// Returns published, non-expired jobs — accessible by students without auth
// ---------------------------------------------------------------------------
router.get('/public/active', async (req, res) => {
    try {
        const result = await query(
            `SELECT id, company_name, job_role, job_description,
                    registration_deadline, eligibility_criteria, application_link,
                    published_at
             FROM job_openings
             WHERE is_published = true
               AND status = 'active'
               AND registration_deadline > CURRENT_TIMESTAMP
             ORDER BY published_at DESC`
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[JOB] Error fetching active jobs:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch job openings' });
    }
});

// ---------------------------------------------------------------------------
// PUBLIC: GET /api/job-openings/public/all
// Returns all published jobs (including closed/expired) for student visibility
// ---------------------------------------------------------------------------
router.get('/public/all', async (req, res) => {
    try {
        const result = await query(
            `SELECT id, company_name, job_role, job_description,
                    registration_deadline, eligibility_criteria, application_link,
                    published_at, status, is_published
             FROM job_openings
             WHERE is_published = true
             ORDER BY published_at DESC NULLS LAST, created_at DESC`
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[JOB] Error fetching all published jobs:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch job openings' });
    }
});

// ---------------------------------------------------------------------------
// ADMIN: GET /api/job-openings
// Returns all jobs (all statuses) with notification counts
// ---------------------------------------------------------------------------
router.get('/', verifyAdmin, async (req, res) => {
    try {
        const result = await query(
            `SELECT jo.*,
                    a.full_name AS admin_name,
                    COUNT(jn.id) FILTER (WHERE jn.email_status = 'sent')   AS emails_sent,
                    COUNT(jn.id) FILTER (WHERE jn.email_status = 'failed') AS emails_failed
             FROM job_openings jo
             LEFT JOIN admins a ON jo.admin_id = a.id
             LEFT JOIN job_notifications jn ON jn.job_opening_id = jo.id
             GROUP BY jo.id, a.full_name
             ORDER BY jo.created_at DESC`
        );
        res.json({ success: true, data: result.rows });
    } catch (error) {
        console.error('[JOB] Error fetching all jobs:', error);
        res.status(500).json({ success: false, message: 'Failed to fetch job openings' });
    }
});

// ---------------------------------------------------------------------------
// ADMIN: POST /api/job-openings
// Create a new job opening (saved as draft, not yet published)
// ---------------------------------------------------------------------------
router.post('/', verifyAdmin, async (req, res) => {
    try {
        const {
            company_name, job_role, job_description,
            registration_deadline, eligibility_criteria, application_link
        } = req.body;

        if (!company_name || !job_role || !job_description ||
            !registration_deadline || !eligibility_criteria || !application_link) {
            return res.status(400).json({
                success: false,
                message: 'All fields are required: company_name, job_role, job_description, registration_deadline, eligibility_criteria, application_link'
            });
        }

        const result = await query(
            `INSERT INTO job_openings
               (company_name, job_role, job_description, registration_deadline,
                eligibility_criteria, application_link, admin_id, status, is_published)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'draft',false)
             RETURNING *`,
            [company_name, job_role, job_description, registration_deadline,
             eligibility_criteria, application_link, req.admin.id]
        );

        res.status(201).json({
            success: true,
            message: 'Job opening created (draft). Use /publish to send emails.',
            data: result.rows[0]
        });
    } catch (error) {
        console.error('[JOB] Error creating job:', error);
        res.status(500).json({ success: false, message: 'Failed to create job opening' });
    }
});

// ---------------------------------------------------------------------------
// ADMIN: POST /api/job-openings/:id/publish
// Publishes a draft and sends email notifications to all students in batches
// ---------------------------------------------------------------------------
router.post('/:id/publish', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // 1. Fetch the job
        const jobResult = await query('SELECT * FROM job_openings WHERE id = $1', [id]);
        if (jobResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Job opening not found' });
        }

        const job = jobResult.rows[0];
        if (job.is_published) {
            return res.status(400).json({ success: false, message: 'Job opening is already published' });
        }

        // 2. Fetch all student emails
        const studentsResult = await query(
            'SELECT id, email FROM students ORDER BY id'
        );

        if (studentsResult.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'No students found to notify' });
        }

        const students = studentsResult.rows;
        const BATCH_SIZE = 50; // Resend supports up to 50 recipients per call
        let emailsSent = 0;
        let emailsFailed = 0;

        // 3. Send in batches with a 1-second pause between to respect rate limits
        for (let i = 0; i < students.length; i += BATCH_SIZE) {
            const batch = students.slice(i, i + BATCH_SIZE);
            const emailList = batch.map(s => s.email);

            const emailResult = await sendJobOpeningEmail(emailList, job);
            const status = emailResult.success ? 'sent' : 'failed';

            if (emailResult.success) emailsSent += batch.length;
            else emailsFailed += batch.length;

            // Log each student notification
            for (const student of batch) {
                await query(
                    `INSERT INTO job_notifications (job_opening_id, student_id, email_status)
                     VALUES ($1, $2, $3)
                     ON CONFLICT (job_opening_id, student_id)
                     DO UPDATE SET email_status = EXCLUDED.email_status, email_sent_at = CURRENT_TIMESTAMP`,
                    [id, student.id, status]
                );
            }

            // Throttle between batches (skip delay after last batch)
            if (i + BATCH_SIZE < students.length) {
                await new Promise(resolve => setTimeout(resolve, 1200));
            }
        }

        // 4. Mark job as published
        await query(
            `UPDATE job_openings
             SET is_published = true, status = 'active', published_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
             WHERE id = $1`,
            [id]
        );

        res.json({
            success: true,
            message: 'Job opening published and email notifications sent.',
            stats: {
                totalStudents: students.length,
                emailsSent,
                emailsFailed
            }
        });
    } catch (error) {
        console.error('[JOB] Error publishing job:', error);
        res.status(500).json({ success: false, message: 'Failed to publish job opening' });
    }
});

// ---------------------------------------------------------------------------
// ADMIN: PUT /api/job-openings/:id
// Update a job opening (draft only; re-publishing is not auto-triggered)
// ---------------------------------------------------------------------------
router.put('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const {
            company_name, job_role, job_description,
            registration_deadline, eligibility_criteria, application_link
        } = req.body;

        const result = await query(
            `UPDATE job_openings
             SET company_name         = $1,
                 job_role             = $2,
                 job_description      = $3,
                 registration_deadline = $4,
                 eligibility_criteria = $5,
                 application_link     = $6,
                 updated_at           = CURRENT_TIMESTAMP
             WHERE id = $7
             RETURNING *`,
            [company_name, job_role, job_description,
             registration_deadline, eligibility_criteria, application_link, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Job opening not found' });
        }

        res.json({ success: true, message: 'Job opening updated', data: result.rows[0] });
    } catch (error) {
        console.error('[JOB] Error updating job:', error);
        res.status(500).json({ success: false, message: 'Failed to update job opening' });
    }
});

// ---------------------------------------------------------------------------
// ADMIN: DELETE /api/job-openings/:id
// ---------------------------------------------------------------------------
router.delete('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;
        const result = await query(
            'DELETE FROM job_openings WHERE id = $1 RETURNING id, company_name, job_role',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Job opening not found' });
        }

        res.json({ success: true, message: 'Job opening deleted', data: result.rows[0] });
    } catch (error) {
        console.error('[JOB] Error deleting job:', error);
        res.status(500).json({ success: false, message: 'Failed to delete job opening' });
    }
});

// ============================================================================
// TEST LINKING - Link job openings to assessments
// ============================================================================

/**
 * POST /api/job-openings/:id/link-test
 * Link a test to a job opening (admin only)
 */
router.post('/:id/link-test', verifyAdmin, async (req, res) => {
    try {
        const jobId = req.params.id;
        const { test_id, is_mandatory, passing_criteria, weightage } = req.body;

        if (!test_id) {
            return res.status(400).json({
                success: false,
                message: 'test_id is required'
            });
        }

        // Verify job exists
        const jobCheck = await query('SELECT id FROM job_openings WHERE id = $1', [jobId]);
        if (jobCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Job opening not found'
            });
        }

        // Verify test exists
        const testCheck = await query('SELECT id, name FROM tests WHERE id = $1', [test_id]);
        if (testCheck.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }

        // Link test to job
        const result = await query(
            `INSERT INTO job_opening_tests 
                (job_opening_id, test_id, is_mandatory, passing_criteria, weightage)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (job_opening_id, test_id) 
             DO UPDATE SET 
                is_mandatory = EXCLUDED.is_mandatory,
                passing_criteria = EXCLUDED.passing_criteria,
                weightage = EXCLUDED.weightage
             RETURNING *`,
            [
                jobId,
                test_id,
                is_mandatory !== undefined ? is_mandatory : true,
                passing_criteria || 50,
                weightage || 100
            ]
        );

        res.status(201).json({
            success: true,
            message: 'Test linked to job opening successfully',
            data: {
                ...result.rows[0],
                test_name: testCheck.rows[0].name
            }
        });

    } catch (error) {
        console.error('[JOB] Error linking test:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to link test to job opening'
        });
    }
});

/**
 * GET /api/job-openings/:id/linked-tests
 * Get all tests linked to a job opening
 */
router.get('/:id/linked-tests', verifyAdmin, async (req, res) => {
    try {
        const jobId = req.params.id;

        const result = await query(
            `SELECT 
                jot.id AS link_id,
                jot.job_opening_id,
                jot.test_id,
                jot.is_mandatory,
                jot.passing_criteria,
                jot.weightage,
                jot.created_at,
                t.title AS test_name,
                t.duration AS time_limit,
                COUNT(q.id) AS question_count,
                COALESCE(SUM(q.marks), 0) AS total_marks
             FROM job_opening_tests jot
             INNER JOIN tests t ON jot.test_id = t.id
             LEFT JOIN questions q ON t.id = q.test_id
             WHERE jot.job_opening_id = $1
             GROUP BY jot.id, jot.job_opening_id, jot.test_id, jot.is_mandatory, jot.passing_criteria, jot.weightage, jot.created_at, t.title, t.duration
             ORDER BY jot.created_at ASC`,
            [jobId]
        );

        res.json({
            success: true,
            data: result.rows
        });

    } catch (error) {
        console.error('[JOB] Error fetching linked tests:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch linked tests'
        });
    }
});

/**
 * DELETE /api/job-openings/:id/unlink-test/:testId
 * Remove test link from job opening
 */
router.delete('/:id/unlink-test/:testId', verifyAdmin, async (req, res) => {
    try {
        const { id: jobId, testId } = req.params;

        const result = await query(
            `DELETE FROM job_opening_tests 
             WHERE job_opening_id = $1 AND test_id = $2
             RETURNING *`,
            [jobId, testId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Test link not found'
            });
        }

        res.json({
            success: true,
            message: 'Test unlinked from job opening successfully',
            data: result.rows[0]
        });

    } catch (error) {
        console.error('[JOB] Error unlinking test:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to unlink test'
        });
    }
});

module.exports = router;