const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/verifyAdmin');
const { generateViolationsExcel } = require('../services/violationsExportService');

// Get all AI violations for a specific test
router.get('/violations/test/:testId', verifyAdmin, async (req, res) => {
    try {
        const { testId } = req.params;
        
        const result = await pool.query(
            `SELECT 
                pv.*,
                s.full_name as student_name,
                s.email as student_email,
                t.title as test_title
            FROM proctoring_violations pv
            LEFT JOIN students s ON pv.student_id = s.firebase_uid
            LEFT JOIN tests t ON pv.test_id = t.id
            WHERE pv.test_id = $1
            ORDER BY pv.timestamp DESC`,
            [testId]
        );
        
        res.json({
            success: true,
            violations: result.rows
        });
    } catch (error) {
        console.error('Error fetching violations:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch violations'
        });
    }
});

// Get all AI violations for a specific student
router.get('/violations/student/:studentId', verifyAdmin, async (req, res) => {
    try {
        const { studentId } = req.params;
        
        const result = await pool.query(
            `SELECT 
                pv.*,
                t.title as test_title
            FROM proctoring_violations pv
            LEFT JOIN tests t ON pv.test_id = t.id
            WHERE pv.student_id = $1
            ORDER BY pv.timestamp DESC`,
            [studentId]
        );
        
        res.json({
            success: true,
            violations: result.rows
        });
    } catch (error) {
        console.error('Error fetching student violations:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch student violations'
        });
    }
});

// Get violation summary for a test
router.get('/violations/summary/:testId', verifyAdmin, async (req, res) => {
    try {
        const { testId } = req.params;
        
        const result = await pool.query(
            `SELECT 
                violation_type,
                severity,
                COUNT(*) as count,
                COUNT(DISTINCT student_id) as affected_students
            FROM proctoring_violations
            WHERE test_id = $1 AND violation_type != 'microphone_silent'
            GROUP BY violation_type, severity
            ORDER BY count DESC`,
            [testId]
        );
        
        res.json({
            success: true,
            summary: result.rows
        });
    } catch (error) {
        console.error('Error fetching violation summary:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch violation summary'
        });
    }
});

// Get students with high violation counts
router.get('/violations/flagged/:testId', verifyAdmin, async (req, res) => {
    try {
        const { testId } = req.params;
        
        const result = await pool.query(
            `SELECT 
                pv.student_id,
                s.full_name as student_name,
                s.email as student_email,
                s.phone as student_phone,
                COUNT(CASE WHEN pv.violation_type != 'microphone_silent' THEN 1 END) as total_violations,
                COUNT(CASE WHEN pv.severity = 'high' AND pv.violation_type != 'microphone_silent' THEN 1 END) as high_severity_count,
                COUNT(CASE WHEN pv.severity = 'medium' AND pv.violation_type != 'microphone_silent' THEN 1 END) as medium_severity_count,
                MAX(pv.timestamp) as last_violation
            FROM proctoring_violations pv
            LEFT JOIN students s ON pv.student_id = s.firebase_uid
            WHERE pv.test_id = $1
            GROUP BY pv.student_id, s.full_name, s.email, s.phone
            HAVING COUNT(CASE WHEN pv.severity = 'high' AND pv.violation_type != 'microphone_silent' THEN 1 END) >= 3
            ORDER BY high_severity_count DESC, total_violations DESC`,
            [testId]
        );
        
        res.json({
            success: true,
            flaggedStudents: result.rows
        });
    } catch (error) {
        console.error('Error fetching flagged students:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch flagged students'
        });
    }
});

// Get violations grouped by student (for table view)
router.get('/violations/by-student/:testId', verifyAdmin, async (req, res) => {
    try {
        const { testId } = req.params;
        
        const result = await pool.query(
            `SELECT 
                pv.student_id,
                s.full_name as student_name,
                s.email as student_email,
                s.phone as student_phone,
                COUNT(CASE WHEN pv.violation_type = 'no_face' THEN 1 END) as no_face_count,
                COUNT(CASE WHEN pv.violation_type = 'multiple_faces' THEN 1 END) as multiple_faces_count,
                COUNT(CASE WHEN pv.violation_type = 'phone_detected' THEN 1 END) as phone_detected_count,
                COUNT(CASE WHEN pv.violation_type = 'looking_down' THEN 1 END) as looking_down_count,
                COUNT(CASE WHEN pv.violation_type = 'video_blur' THEN 1 END) as video_blur_count,
                COUNT(CASE WHEN pv.violation_type = 'loud_noise' THEN 1 END) as loud_noise_count,
                COUNT(CASE WHEN pv.violation_type = 'voice_detected' THEN 1 END) as voice_detected_count,
                COUNT(CASE WHEN pv.violation_type != 'microphone_silent' THEN 1 END) as total_violations,
                MAX(pv.timestamp) as last_violation
            FROM proctoring_violations pv
            LEFT JOIN students s ON pv.student_id = s.firebase_uid
            WHERE pv.test_id = $1
            GROUP BY pv.student_id, s.full_name, s.email, s.phone
            ORDER BY total_violations DESC`,
            [testId]
        );
        
        res.json({
            success: true,
            students: result.rows
        });
    } catch (error) {
        console.error('Error fetching violations by student:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch violations by student'
        });
    }
});

// Export violations report to Excel
router.get('/violations/export/:testId', verifyAdmin, async (req, res) => {
    try {
        const { testId } = req.params;
        
        const { buffer, filename } = await generateViolationsExcel(testId);
        
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send(buffer);
    } catch (error) {
        console.error('Error exporting violations:', error);
        
        if (error.message === 'Test not found') {
            return res.status(404).json({
                success: false,
                message: 'Test not found'
            });
        }
        
        if (error.message === 'No violations found for this test') {
            return res.status(404).json({
                success: false,
                message: 'No violations found for this test'
            });
        }
        
        res.status(500).json({
            success: false,
            message: 'Failed to export violations report'
        });
    }
});

module.exports = router;
