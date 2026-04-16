const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyAdmin = require('../middleware/verifyAdmin');
const { verifySession } = require('../middleware/verifySession');

// Submit feedback (student) - Requires student authentication
router.post('/', verifySession, async (req, res) => {
    try {
        const { testId, rating, difficulty, feedbackText, submissionReason } = req.body;
        const studentId = req.studentId; // From verifySession middleware

        // Validate required fields
        if (!studentId || !testId) {
            return res.status(400).json({
                success: false,
                message: 'Student ID and Test ID are required'
            });
        }

        // Ensure testId is an integer
        const testIdInt = parseInt(testId);
        if (isNaN(testIdInt)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid Test ID format'
            });
        }

        // Validate rating if provided (must be 1-5)
        if (rating !== null && rating !== undefined) {
            const ratingInt = parseInt(rating);
            if (isNaN(ratingInt) || ratingInt < 1 || ratingInt > 5) {
                return res.status(400).json({
                    success: false,
                    message: 'Rating must be between 1 and 5'
                });
            }
        }

        // Insert or update feedback (upsert)
        const result = await pool.query(
            `INSERT INTO test_feedback (student_id, test_id, rating, difficulty, feedback_text, submission_reason)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (student_id, test_id) 
             DO UPDATE SET 
                rating = EXCLUDED.rating,
                difficulty = EXCLUDED.difficulty,
                feedback_text = EXCLUDED.feedback_text,
                submission_reason = EXCLUDED.submission_reason,
                created_at = NOW()
             RETURNING *`,
            [studentId, testIdInt, rating, difficulty, feedbackText, submissionReason]
        );

        res.json({
            success: true,
            message: 'Feedback submitted successfully',
            feedback: result.rows[0]
        });
    } catch (error) {
        console.error('Error submitting feedback:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to submit feedback'
        });
    }
});

// Get feedback for a specific test (admin)
router.get('/test/:testId', verifyAdmin, async (req, res) => {
    try {
        const { testId } = req.params;

        const result = await pool.query(
            `SELECT 
                tf.*,
                s.full_name as student_name,
                s.email as student_email
             FROM test_feedback tf
             LEFT JOIN students s ON tf.student_id = s.firebase_uid
             WHERE tf.test_id = $1
             ORDER BY tf.created_at DESC`,
            [testId]
        );

        // Calculate statistics
        const feedbacks = result.rows;
        const stats = {
            totalFeedbacks: feedbacks.length,
            averageRating: feedbacks.length > 0 
                ? (feedbacks.reduce((sum, f) => sum + (f.rating || 0), 0) / feedbacks.filter(f => f.rating).length).toFixed(1)
                : 0,
            difficultyBreakdown: {
                Easy: feedbacks.filter(f => f.difficulty === 'Easy').length,
                Medium: feedbacks.filter(f => f.difficulty === 'Medium').length,
                Hard: feedbacks.filter(f => f.difficulty === 'Hard').length
            },
            ratingBreakdown: {
                1: feedbacks.filter(f => f.rating === 1).length,
                2: feedbacks.filter(f => f.rating === 2).length,
                3: feedbacks.filter(f => f.rating === 3).length,
                4: feedbacks.filter(f => f.rating === 4).length,
                5: feedbacks.filter(f => f.rating === 5).length
            }
        };

        res.json({
            success: true,
            feedbacks: feedbacks,
            stats: stats
        });
    } catch (error) {
        console.error('Error fetching feedback:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch feedback'
        });
    }
});

// Get feedback by student (admin only)
router.get('/student/:studentId', verifyAdmin, async (req, res) => {
    try {
        const { studentId } = req.params;

        const result = await pool.query(
            `SELECT 
                tf.*,
                t.title as test_title
             FROM test_feedback tf
             LEFT JOIN tests t ON tf.test_id = t.id
             WHERE tf.student_id = $1
             ORDER BY tf.created_at DESC`,
            [studentId]
        );

        res.json({
            success: true,
            feedbacks: result.rows
        });
    } catch (error) {
        console.error('Error fetching student feedback:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch student feedback'
        });
    }
});

module.exports = router;
