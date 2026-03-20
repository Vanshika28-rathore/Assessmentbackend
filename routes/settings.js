const express = require('express');
const router = express.Router();
const { pool } = require('../config/db');
const verifyAdmin = require('../middleware/verifyAdmin');
const { logger } = require('../config/logger');

const DEFAULT_TEST_JOB_ROLE = 'General Assessment Candidate';
const DEFAULT_TEST_JOB_DESCRIPTION = 'This assessment evaluates candidate readiness across core technical and problem-solving skills relevant to the role.';

let settingsColumnsEnsured = false;

async function ensureSettingsColumns() {
    if (settingsColumnsEnsured) return;

    await pool.query(`
        ALTER TABLE system_settings
        ADD COLUMN IF NOT EXISTS default_test_job_role TEXT,
        ADD COLUMN IF NOT EXISTS default_test_job_description TEXT
    `);

    settingsColumnsEnsured = true;
}

function normalizeSettingsRow(row = {}) {
    return {
        ...row,
        default_test_job_role: typeof row.default_test_job_role === 'string' && row.default_test_job_role.trim()
            ? row.default_test_job_role.trim()
            : DEFAULT_TEST_JOB_ROLE,
        default_test_job_description: typeof row.default_test_job_description === 'string' && row.default_test_job_description.trim()
            ? row.default_test_job_description.trim()
            : DEFAULT_TEST_JOB_DESCRIPTION
    };
}

// GET /api/settings/public - Get public system settings
router.get('/public', async (req, res) => {
    try {
        await ensureSettingsColumns();
        const result = await pool.query('SELECT retry_timer_minutes, maintenance_mode, maintenance_message FROM system_settings WHERE id = 1');
        if (result.rows.length === 0) {
            return res.status(200).json({
                success: true,
                settings: { retry_timer_minutes: 5, maintenance_mode: false, maintenance_message: '' }
            });
        }
        res.status(200).json({
            success: true,
            settings: result.rows[0]
        });
    } catch (error) {
        logger.error({ error: error.message }, 'Error fetching public settings');
        res.status(500).json({ success: false, message: 'Server error fetching settings' });
    }
});

// GET /api/settings - Get all settings (admin only)
router.get('/', verifyAdmin, async (req, res) => {
    try {
        await ensureSettingsColumns();
        const result = await pool.query('SELECT * FROM system_settings WHERE id = 1');
        res.status(200).json({
            success: true,
            settings: result.rows.length > 0
                ? normalizeSettingsRow(result.rows[0])
                : {
                    retry_timer_minutes: 5,
                    maintenance_mode: false,
                    maintenance_message: '',
                    default_test_job_role: DEFAULT_TEST_JOB_ROLE,
                    default_test_job_description: DEFAULT_TEST_JOB_DESCRIPTION
                }
        });
    } catch (error) {
        logger.error({ error: error.message }, 'Error fetching all settings');
        res.status(500).json({ success: false, message: 'Server error fetching settings' });
    }
});

// PUT /api/settings - Update settings (admin only)
router.put('/', verifyAdmin, async (req, res) => {
    try {
        await ensureSettingsColumns();
        const {
            retry_timer_minutes,
            maintenance_mode,
            maintenance_message,
            default_test_job_role,
            default_test_job_description
        } = req.body;

        const normalizedDefaultJobRole = typeof default_test_job_role === 'string' && default_test_job_role.trim()
            ? default_test_job_role.trim()
            : DEFAULT_TEST_JOB_ROLE;
        const normalizedDefaultJobDescription = typeof default_test_job_description === 'string' && default_test_job_description.trim()
            ? default_test_job_description.trim()
            : DEFAULT_TEST_JOB_DESCRIPTION;

        const result = await pool.query(
            `UPDATE system_settings 
             SET retry_timer_minutes = $1, 
                 maintenance_mode = $2, 
                 maintenance_message = $3, 
                 default_test_job_role = $4,
                 default_test_job_description = $5,
                 updated_at = CURRENT_TIMESTAMP 
             WHERE id = 1 
             RETURNING *`,
            [retry_timer_minutes, maintenance_mode, maintenance_message, normalizedDefaultJobRole, normalizedDefaultJobDescription]
        );

        if (result.rows.length === 0) {
            // Need to insert if missing
            const insertResult = await pool.query(
                `INSERT INTO system_settings (id, retry_timer_minutes, maintenance_mode, maintenance_message, default_test_job_role, default_test_job_description) 
                 VALUES (1, $1, $2, $3, $4, $5) RETURNING *`,
                [retry_timer_minutes, maintenance_mode, maintenance_message, normalizedDefaultJobRole, normalizedDefaultJobDescription]
            );
            return res.status(200).json({ success: true, settings: normalizeSettingsRow(insertResult.rows[0]), message: 'Settings updated successfully' });
        }

        res.status(200).json({
            success: true,
            settings: normalizeSettingsRow(result.rows[0]),
            message: 'Settings updated successfully'
        });
    } catch (error) {
        logger.error({ error: error.message }, 'Error updating settings');
        res.status(500).json({ success: false, message: 'Server error updating settings' });
    }
});

module.exports = router;