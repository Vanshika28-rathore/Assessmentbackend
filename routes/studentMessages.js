const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../config/db');
const verifyAdmin = require('../middleware/verifyAdmin');
const { verifySession } = require('../middleware/verifySession');
const { logger } = require('../config/logger');

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, '../uploads/student-messages');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, 'msg-' + uniqueSuffix + path.extname(file.originalname));
    }
});

const fileFilter = (req, file, cb) => {
    const allowedTypes = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only JPEG, PNG, GIF, and WebP are allowed.'), false);
    }
};

const upload = multer({
    storage,
    fileFilter,
    limits: {
        fileSize: 5 * 1024 * 1024 // 5MB limit
    }
});

/**
 * POST /api/student-messages
 * Submit a new student support message
 */
router.post('/', upload.single('image'), async (req, res) => {
    try {
        const { name, email, message, topic, studentId, college } = req.body;
        
        if (!message || !message.trim()) {
            return res.status(400).json({
                success: false,
                message: 'Message is required'
            });
        }

        const imagePath = req.file ? `/uploads/student-messages/${req.file.filename}` : null;

        const result = await pool.query(
            `INSERT INTO student_messages 
             (name, email, message, topic, image_path, status, created_at, student_id, college, sender_type)
             VALUES ($1, $2, $3, $4, $5, 'unread', NOW(), $6, $7, 'student')
             RETURNING id, created_at, image_path`,
            [
                name?.trim() || 'Anonymous',
                email?.trim() || null,
                message.trim(),
                topic || 'General',
                imagePath,
                studentId || null,
                college || null
            ]
        );

        logger.info({
            event: 'student_message_created',
            messageId: result.rows[0].id,
            topic,
            studentId,
            college,
            hasImage: !!imagePath
        });

        // Emit socket notification to admins
        const io = req.app.get('io');
        if (io) {
            // Notify admins
            io.to('admin-support-room').emit('support:new-student-message', {
                id: result.rows[0].id,
                studentName: name?.trim() || 'Anonymous',
                studentId: studentId || null,
                college: college || null,
                messagePreview: message.trim().substring(0, 100) + (message.length > 100 ? '...' : ''),
                topic: topic || 'General',
                createdAt: result.rows[0].created_at,
                imagePath: result.rows[0].image_path,
                hasImage: !!imagePath
            });
            
            // Echo back to student for real-time display
            if (studentId) {
                const roomName = `support-student-${studentId}`;
                io.to(roomName).emit('support:student-message-echo', {
                    id: result.rows[0].id,
                    studentId: studentId,
                    messagePreview: message.trim(),
                    createdAt: result.rows[0].created_at,
                    imagePath: result.rows[0].image_path
                });
            }
        }

        res.json({
            success: true,
            message: 'Your message has been sent successfully',
            data: {
                id: result.rows[0].id,
                createdAt: result.rows[0].created_at,
                imagePath: result.rows[0].image_path
            }
        });
    } catch (error) {
        logger.error({ err: error, event: 'student_message_create_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to send message. Please try again.'
        });
    }
});

/**
 * GET /api/student-messages
 * Get all student messages (Admin only)
 */
router.get('/', verifyAdmin, async (req, res) => {
    try {
        const { status, topic, college, page = 1, limit = 20 } = req.query;
        const offset = (page - 1) * limit;

        // Get conversations grouped by student_id with latest message info.
        // Pre-aggregate counts in a CTE instead of correlated subqueries (was O(n^2) per conversation)
        let query = `
            WITH msg_stats AS (
                SELECT
                    COALESCE(student_id, 'anonymous_' || id::text) AS conv_id,
                    COUNT(*) AS message_count,
                    COUNT(*) FILTER (WHERE status = 'unread' AND sender_type = 'student') AS unread_count
                FROM student_messages
                WHERE sender_type = 'student'
                GROUP BY COALESCE(student_id, 'anonymous_' || id::text)
            ),
            latest_messages AS (
                SELECT DISTINCT ON (COALESCE(student_id, 'anonymous_' || id::text))
                    COALESCE(student_id, 'anonymous_' || id::text) as conversation_id,
                    id, name, email, message, topic, image_path, status, created_at, read_at,
                    student_id, college, sender_type,
                    ms.message_count,
                    ms.unread_count
                FROM student_messages
                JOIN msg_stats ms ON ms.conv_id = COALESCE(student_id, 'anonymous_' || id::text)
                WHERE sender_type = 'student'
                ORDER BY COALESCE(student_id, 'anonymous_' || id::text), created_at DESC
            )
            SELECT * FROM latest_messages
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (status && status !== 'all') {
            if (status === 'unread') {
                query += ` AND unread_count > 0`;
            } else {
                query += ` AND status = $${paramIndex++}`;
                params.push(status);
            }
        }

        if (topic) {
            query += ` AND topic = $${paramIndex++}`;
            params.push(topic);
        }

        if (college) {
            query += ` AND LOWER(college) = LOWER($${paramIndex++})`;
            params.push(college);
        }

        query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await pool.query(query, params);

        // Get total count of conversations
        let countQuery = `
            WITH conversations AS (
                SELECT DISTINCT COALESCE(student_id, 'anonymous_' || id::text) as conversation_id,
                    MAX(CASE WHEN sender_type = 'student' THEN status END) as latest_status,
                    MAX(topic) as topic,
                    MAX(college) as college,
                    COUNT(CASE WHEN status = 'unread' AND sender_type = 'student' THEN 1 END) as unread_count
                FROM student_messages
                WHERE sender_type = 'student'
                GROUP BY COALESCE(student_id, 'anonymous_' || id::text)
            )
            SELECT COUNT(*) FROM conversations WHERE 1=1
        `;
        const countParams = [];
        let countParamIndex = 1;

        if (status && status !== 'all') {
            if (status === 'unread') {
                countQuery += ` AND unread_count > 0`;
            } else {
                countQuery += ` AND latest_status = $${countParamIndex++}`;
                countParams.push(status);
            }
        }
        if (topic) {
            countQuery += ` AND topic = $${countParamIndex++}`;
            countParams.push(topic);
        }
        if (college) {
            countQuery += ` AND LOWER(college) = LOWER($${countParamIndex++})`;
            countParams.push(college);
        }

        const countResult = await pool.query(countQuery, countParams);
        const total = parseInt(countResult.rows[0].count);

        // Get list of unique colleges for filter dropdown
        const collegesResult = await pool.query(`
            SELECT DISTINCT college FROM student_messages 
            WHERE college IS NOT NULL AND college != '' 
            ORDER BY college
        `);
        const colleges = collegesResult.rows.map(r => r.college);

        res.json({
            success: true,
            messages: result.rows,
            colleges,
            pagination: {
                total,
                page: parseInt(page),
                limit: parseInt(limit),
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        logger.error({ err: error, event: 'student_messages_fetch_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to fetch messages'
        });
    }
});

/**
 * GET /api/student-messages/unread-count
 * Get unread message count (Admin only)
 */
router.get('/unread-count', verifyAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT COUNT(*) FROM student_messages WHERE status = 'unread' AND sender_type = 'student'"
        );

        res.json({
            success: true,
            count: parseInt(result.rows[0].count)
        });
    } catch (error) {
        logger.error({ err: error, event: 'unread_count_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to fetch unread count'
        });
    }
});

/**
 * GET /api/student-messages/student-unread-count
 * Get unread admin reply count for a student (Student only)
 */
router.get('/student-unread-count', verifySession, async (req, res) => {
    try {
        // Get student ID from Firebase auth
        const firebaseUid = req.firebaseUid;
        
        // Find student by Firebase UID to get roll_number
        const studentResult = await pool.query(
            'SELECT roll_number FROM students WHERE firebase_uid = $1',
            [firebaseUid]
        );

        if (studentResult.rows.length === 0) {
            return res.json({
                success: true,
                count: 0
            });
        }

        const studentId = studentResult.rows[0].roll_number;

        // Count unread admin replies for this student
        const result = await pool.query(
            `SELECT COUNT(*) FROM student_messages 
             WHERE student_id = $1 AND sender_type = 'admin' AND status = 'unread'`,
            [studentId]
        );

        res.json({
            success: true,
            count: parseInt(result.rows[0].count)
        });
    } catch (error) {
        logger.error({ err: error, event: 'student_unread_count_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to fetch unread count'
        });
    }
});

/**
 * POST /api/student-messages/mark-student-read
 * Mark all admin replies as read for a student (Student only)
 */
router.post('/mark-student-read', verifySession, async (req, res) => {
    try {
        // Get student ID from Firebase auth
        const firebaseUid = req.firebaseUid;
        
        // Find student by Firebase UID to get roll_number
        const studentResult = await pool.query(
            'SELECT roll_number FROM students WHERE firebase_uid = $1',
            [firebaseUid]
        );

        if (studentResult.rows.length === 0) {
            return res.json({
                success: true,
                message: 'No messages to mark as read'
            });
        }

        const studentId = studentResult.rows[0].roll_number;

        // Mark all admin replies as read for this student
        const result = await pool.query(
            `UPDATE student_messages 
             SET status = 'read', read_at = NOW()
             WHERE student_id = $1 AND sender_type = 'admin' AND status = 'unread'
             RETURNING id`,
            [studentId]
        );

        res.json({
            success: true,
            message: `${result.rowCount} messages marked as read`
        });
    } catch (error) {
        logger.error({ err: error, event: 'mark_student_read_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to mark messages as read'
        });
    }
});

/**
 * PATCH /api/student-messages/:id/read
 * Mark a message as read (Admin only)
 */
router.patch('/:id/read', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            `UPDATE student_messages 
             SET status = 'read', read_at = NOW()
             WHERE id = $1
             RETURNING id, status, read_at`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        res.json({
            success: true,
            message: 'Message marked as read',
            data: result.rows[0]
        });
    } catch (error) {
        logger.error({ err: error, event: 'mark_read_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to mark message as read'
        });
    }
});

/**
 * PATCH /api/student-messages/:id/archive
 * Archive a message (Admin only)
 */
router.patch('/:id/archive', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        const result = await pool.query(
            `UPDATE student_messages 
             SET status = 'archived'
             WHERE id = $1
             RETURNING id, status`,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        res.json({
            success: true,
            message: 'Message archived',
            data: result.rows[0]
        });
    } catch (error) {
        logger.error({ err: error, event: 'archive_message_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to archive message'
        });
    }
});

/**
 * DELETE /api/student-messages/:id
 * Delete a message (Admin only)
 */
router.delete('/:id', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Get image path before deleting
        const messageResult = await pool.query(
            'SELECT image_path FROM student_messages WHERE id = $1',
            [id]
        );

        if (messageResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        // Delete from database
        await pool.query('DELETE FROM student_messages WHERE id = $1', [id]);

        // Delete associated image if exists
        const imagePath = messageResult.rows[0].image_path;
        if (imagePath) {
            const fullPath = path.join(__dirname, '..', imagePath);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        }

        logger.info({ event: 'student_message_deleted', messageId: id });

        res.json({
            success: true,
            message: 'Message deleted'
        });
    } catch (error) {
        logger.error({ err: error, event: 'delete_message_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to delete message'
        });
    }
});

/**
 * DELETE /api/student-messages/conversation/:studentId
 * Delete full conversation for a student (Admin only)
 */
router.delete('/conversation/:studentId', verifyAdmin, async (req, res) => {
    const { studentId } = req.params;

    if (!studentId || !studentId.trim()) {
        return res.status(400).json({
            success: false,
            message: 'Student ID is required'
        });
    }

    const normalizedStudentId = studentId.trim();

    try {
        const messagesResult = await pool.query(
            `SELECT id, image_path
             FROM student_messages
             WHERE student_id = $1`,
            [normalizedStudentId]
        );

        if (messagesResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Conversation not found'
            });
        }

        await pool.query('DELETE FROM student_messages WHERE student_id = $1', [normalizedStudentId]);

        for (const row of messagesResult.rows) {
            if (!row.image_path) continue;

            const fullPath = path.join(__dirname, '..', row.image_path);
            if (fs.existsSync(fullPath)) {
                try {
                    fs.unlinkSync(fullPath);
                } catch (fileErr) {
                    logger.warn({
                        err: fileErr,
                        event: 'conversation_image_delete_failed',
                        studentId: normalizedStudentId,
                        messageId: row.id,
                        imagePath: row.image_path
                    });
                }
            }
        }

        logger.info({
            event: 'student_conversation_deleted',
            studentId: normalizedStudentId,
            deletedMessages: messagesResult.rows.length
        });

        res.json({
            success: true,
            message: 'Conversation deleted successfully',
            deletedCount: messagesResult.rows.length
        });
    } catch (error) {
        logger.error({ err: error, event: 'delete_conversation_error', studentId: normalizedStudentId });
        res.status(500).json({
            success: false,
            message: 'Failed to delete conversation'
        });
    }
});

/**
 * PATCH /api/student-messages/conversation/:studentId/read
 * Mark all unread student messages in a conversation as read (Admin only)
 */
router.patch('/conversation/:studentId/read', verifyAdmin, async (req, res) => {
    try {
        const { studentId } = req.params;

        const result = await pool.query(
            `UPDATE student_messages 
             SET status = 'read', read_at = NOW()
             WHERE student_id = $1 AND sender_type = 'student' AND status = 'unread'
             RETURNING id`,
            [studentId]
        );

        // Emit updated unread count to all admins
        const io = req.app.get('io');
        if (io) {
            const countResult = await pool.query(
                "SELECT COUNT(*) FROM student_messages WHERE status = 'unread' AND sender_type = 'student'"
            );
            io.to('admin-support-room').emit('support:unread-count-update', {
                count: parseInt(countResult.rows[0].count)
            });
        }

        res.json({
            success: true,
            updated: result.rowCount
        });
    } catch (error) {
        logger.error({ err: error, event: 'mark_conversation_read_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to mark conversation as read'
        });
    }
});

/**
 * POST /api/student-messages/mark-all-read
 * Mark all messages as read (Admin only)
 */
router.post('/mark-all-read', verifyAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE student_messages 
             SET status = 'read', read_at = NOW()
             WHERE status = 'unread' AND sender_type = 'student'
             RETURNING id`
        );

        // Notify all admin sockets that unread count is now 0
        const io = req.app.get('io');
        if (io) {
            io.to('admin-support-room').emit('support:unread-count-update', { count: 0 });
        }

        res.json({
            success: true,
            message: `${result.rowCount} messages marked as read`
        });
    } catch (error) {
        logger.error({ err: error, event: 'mark_all_read_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to mark messages as read'
        });
    }
});

/**
 * POST /api/student-messages/conversation/:studentId/close
 * Close conversation and request feedback from student (Admin only)
 */
router.post('/conversation/:studentId/close', verifyAdmin, async (req, res) => {
    try {
        const { studentId } = req.params;
        const adminData = req.adminData || {};
        const adminId = adminData.id || adminData.email || 'admin';

        logger.info({
            event: 'close_conversation_attempt',
            studentId,
            adminId
        });

        // First check if conversation exists
        const checkResult = await pool.query(
            `SELECT COUNT(*) as count FROM student_messages WHERE student_id = $1`,
            [studentId]
        );

        if (parseInt(checkResult.rows[0].count) === 0) {
            logger.warn({
                event: 'conversation_not_found',
                studentId
            });
            return res.status(404).json({
                success: false,
                message: 'No conversation found for this student'
            });
        }

        // Update all messages in this conversation to closed status
        const result = await pool.query(
            `UPDATE student_messages 
             SET conversation_status = 'closed', 
                 closed_at = NOW(), 
                 closed_by = $1
             WHERE student_id = $2 AND (conversation_status = 'open' OR conversation_status IS NULL)
             RETURNING id`,
            [adminId, studentId]
        );

        if (result.rowCount === 0) {
            logger.warn({
                event: 'conversation_already_closed',
                studentId
            });
            return res.status(400).json({
                success: false,
                message: 'Conversation is already closed'
            });
        }

        // Emit socket notification to student requesting feedback
        const io = req.app.get('io');
        if (io) {
            const roomName = `support-student-${studentId}`;
            logger.info({
                event: 'emitting_conversation_closed',
                roomName,
                studentId,
                socketsInRoom: io.sockets.adapter.rooms.get(roomName)?.size || 0
            });
            
            const emitData = {
                studentId,
                closedAt: new Date(),
                closedBy: adminId,
                requestFeedback: true
            };
            
            logger.info({
                event: 'conversation_closed_emit_data',
                data: emitData
            });
            
            io.to(roomName).emit('support:conversation-closed', emitData);
            
            // Also log all active support rooms for debugging
            const allRooms = Array.from(io.sockets.adapter.rooms.keys())
                .filter(r => r.startsWith('support-student'));
            logger.info({
                event: 'active_support_rooms',
                rooms: allRooms
            });
        } else {
            logger.warn({
                event: 'socket_io_not_available',
                studentId
            });
        }

        logger.info({
            event: 'conversation_closed',
            studentId,
            adminId,
            messagesUpdated: result.rowCount
        });

        res.json({
            success: true,
            message: 'Conversation closed successfully',
            updatedCount: result.rowCount
        });
    } catch (error) {
        logger.error({ err: error, event: 'close_conversation_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to close conversation'
        });
    }
});

/**
 * POST /api/student-messages/conversation/:studentId/feedback
 * Submit feedback for a closed conversation (Student only)
 */
router.post('/conversation/:studentId/feedback', verifySession, async (req, res) => {
    try {
        const { studentId } = req.params;
        const { rating, helpful, responseTime, comments } = req.body;

        // Validate rating
        if (!rating || rating < 1 || rating > 5) {
            return res.status(400).json({
                success: false,
                message: 'Rating must be between 1 and 5'
            });
        }

        // Get student ID from Firebase auth
        const firebaseUid = req.firebaseUid;
        const studentResult = await pool.query(
            'SELECT roll_number FROM students WHERE firebase_uid = $1',
            [firebaseUid]
        );

        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const verifiedStudentId = studentResult.rows[0].roll_number;

        // Verify student ID matches
        if (verifiedStudentId !== studentId) {
            return res.status(403).json({
                success: false,
                message: 'Unauthorized to submit feedback for this conversation'
            });
        }

        // Update feedback for all messages in this conversation
        const result = await pool.query(
            `UPDATE student_messages 
             SET feedback_rating = $1,
                 feedback_helpful = $2,
                 feedback_response_time = $3,
                 feedback_comments = $4,
                 feedback_submitted_at = NOW()
             WHERE student_id = $5 AND conversation_status = 'closed'
             RETURNING id`,
            [rating, helpful, responseTime, comments, studentId]
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                success: false,
                message: 'Conversation not found or not closed'
            });
        }

        logger.info({
            event: 'feedback_submitted',
            studentId,
            rating,
            helpful,
            responseTime
        });

        res.json({
            success: true,
            message: 'Feedback submitted successfully',
            updatedCount: result.rowCount
        });
    } catch (error) {
        logger.error({ err: error, event: 'submit_feedback_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to submit feedback'
        });
    }
});

/**
 * GET /api/student-messages/analytics/feedback
 * Get feedback analytics (Admin only)
 */
router.get('/analytics/feedback', verifyAdmin, async (req, res) => {
    try {
        // Get overall statistics
        const statsResult = await pool.query(`
            SELECT 
                COUNT(DISTINCT student_id) FILTER (WHERE conversation_status = 'closed') as total_closed_conversations,
                COUNT(DISTINCT student_id) FILTER (WHERE feedback_rating IS NOT NULL) as conversations_with_feedback,
                ROUND(AVG(feedback_rating), 2) as average_rating,
                COUNT(*) FILTER (WHERE feedback_helpful = true) as helpful_count,
                COUNT(*) FILTER (WHERE feedback_helpful = false) as not_helpful_count,
                COUNT(*) FILTER (WHERE feedback_rating = 5) as five_star_count,
                COUNT(*) FILTER (WHERE feedback_rating = 4) as four_star_count,
                COUNT(*) FILTER (WHERE feedback_rating = 3) as three_star_count,
                COUNT(*) FILTER (WHERE feedback_rating = 2) as two_star_count,
                COUNT(*) FILTER (WHERE feedback_rating = 1) as one_star_count
            FROM student_messages
            WHERE sender_type = 'student'
        `);

        // Get response time distribution
        const responseTimeResult = await pool.query(`
            SELECT 
                feedback_response_time,
                COUNT(*) as count
            FROM student_messages
            WHERE feedback_response_time IS NOT NULL
            GROUP BY feedback_response_time
            ORDER BY 
                CASE feedback_response_time
                    WHEN 'very_fast' THEN 1
                    WHEN 'fast' THEN 2
                    WHEN 'average' THEN 3
                    WHEN 'slow' THEN 4
                    WHEN 'very_slow' THEN 5
                END
        `);

        // Get recent feedback with comments
        const recentFeedbackResult = await pool.query(`
            SELECT DISTINCT ON (student_id)
                student_id,
                name,
                college,
                feedback_rating,
                feedback_helpful,
                feedback_response_time,
                feedback_comments,
                feedback_submitted_at,
                closed_at
            FROM student_messages
            WHERE feedback_rating IS NOT NULL
            ORDER BY student_id, feedback_submitted_at DESC
            LIMIT 20
        `);

        // Calculate feedback response rate
        const stats = statsResult.rows[0];
        const feedbackResponseRate = stats.total_closed_conversations > 0
            ? ((stats.conversations_with_feedback / stats.total_closed_conversations) * 100).toFixed(1)
            : 0;

        res.json({
            success: true,
            analytics: {
                overview: {
                    totalClosedConversations: parseInt(stats.total_closed_conversations) || 0,
                    conversationsWithFeedback: parseInt(stats.conversations_with_feedback) || 0,
                    feedbackResponseRate: parseFloat(feedbackResponseRate),
                    averageRating: parseFloat(stats.average_rating) || 0,
                    helpfulCount: parseInt(stats.helpful_count) || 0,
                    notHelpfulCount: parseInt(stats.not_helpful_count) || 0
                },
                ratingDistribution: {
                    fiveStar: parseInt(stats.five_star_count) || 0,
                    fourStar: parseInt(stats.four_star_count) || 0,
                    threeStar: parseInt(stats.three_star_count) || 0,
                    twoStar: parseInt(stats.two_star_count) || 0,
                    oneStar: parseInt(stats.one_star_count) || 0
                },
                responseTimeDistribution: responseTimeResult.rows,
                recentFeedback: recentFeedbackResult.rows
            }
        });
    } catch (error) {
        logger.error({ err: error, event: 'fetch_analytics_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to fetch analytics'
        });
    }
});

/**
 * POST /api/student-messages/bulk-delete
 * Delete multiple conversations (Admin only)
 */
router.post('/bulk-delete', verifyAdmin, async (req, res) => {
    try {
        const { studentIds } = req.body;

        if (!Array.isArray(studentIds) || studentIds.length === 0) {
            return res.status(400).json({
                success: false,
                message: 'Student IDs array is required'
            });
        }

        // Get all image paths before deleting
        const imagesResult = await pool.query(
            `SELECT id, image_path
             FROM student_messages
             WHERE student_id = ANY($1) AND image_path IS NOT NULL`,
            [studentIds]
        );

        // Delete from database
        const deleteResult = await pool.query(
            'DELETE FROM student_messages WHERE student_id = ANY($1) RETURNING id',
            [studentIds]
        );

        // Delete associated images
        let deletedImagesCount = 0;
        for (const row of imagesResult.rows) {
            if (!row.image_path) continue;

            const fullPath = path.join(__dirname, '..', row.image_path);
            if (fs.existsSync(fullPath)) {
                try {
                    fs.unlinkSync(fullPath);
                    deletedImagesCount++;
                } catch (fileErr) {
                    logger.warn({
                        err: fileErr,
                        event: 'bulk_delete_image_failed',
                        messageId: row.id,
                        imagePath: row.image_path
                    });
                }
            }
        }

        logger.info({
            event: 'bulk_conversations_deleted',
            studentIds,
            deletedMessages: deleteResult.rowCount,
            deletedImages: deletedImagesCount
        });

        res.json({
            success: true,
            message: `${studentIds.length} conversations deleted successfully`,
            deletedMessages: deleteResult.rowCount,
            deletedImages: deletedImagesCount
        });
    } catch (error) {
        logger.error({ err: error, event: 'bulk_delete_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to delete conversations'
        });
    }
});

/**
 * GET /api/student-messages/conversation
 * Get conversation history for a student (Student only)
 */
router.get('/conversation', verifySession, async (req, res) => {
    try {
        // Get student ID from Firebase auth
        const firebaseUid = req.firebaseUid;
        
        // Find student by Firebase UID - get roll_number which is used as student_id in messages
        const studentResult = await pool.query(
            'SELECT roll_number, full_name, institute FROM students WHERE firebase_uid = $1',
            [firebaseUid]
        );

        if (studentResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Student not found'
            });
        }

        const studentId = studentResult.rows[0].roll_number;

        // Get all messages for this student (both sent and received)
        const messagesResult = await pool.query(
            `SELECT id, message, image_path, sender_type, created_at
             FROM student_messages
             WHERE student_id = $1
             ORDER BY created_at ASC`,
            [studentId]
        );

        res.json({
            success: true,
            messages: messagesResult.rows
        });
    } catch (error) {
        logger.error({ err: error, event: 'fetch_conversation_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to fetch conversation'
        });
    }
});

/**
 * GET /api/student-messages/:id/thread
 * Get full conversation thread for a student message (Admin only)
 */
router.get('/:id/thread', verifyAdmin, async (req, res) => {
    try {
        const { id } = req.params;

        // Get the original message
        const messageResult = await pool.query(
            'SELECT * FROM student_messages WHERE id = $1',
            [id]
        );

        if (messageResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        const originalMessage = messageResult.rows[0];
        const studentId = originalMessage.student_id;

        if (!studentId) {
            // If no student_id, return just this message
            return res.json({
                success: true,
                student: {
                    name: originalMessage.name,
                    email: originalMessage.email,
                    college: originalMessage.college,
                    studentId: null
                },
                messages: [originalMessage]
            });
        }

        // Get all messages for this student
        const threadResult = await pool.query(
            `SELECT id, message, image_path, sender_type, created_at
             FROM student_messages
             WHERE student_id = $1
             ORDER BY created_at ASC`,
            [studentId]
        );

        res.json({
            success: true,
            student: {
                name: originalMessage.name,
                email: originalMessage.email,
                college: originalMessage.college,
                studentId
            },
            messages: threadResult.rows
        });
    } catch (error) {
        logger.error({ err: error, event: 'fetch_thread_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to fetch conversation thread'
        });
    }
});

/**
 * POST /api/student-messages/:id/reply
 * Admin reply to a student message (Admin only)
 */
router.post('/:id/reply', verifyAdmin, upload.single('image'), async (req, res) => {
    try {
        const { id } = req.params;
        const { message } = req.body;

        if ((!message || !message.trim()) && !req.file) {
            return res.status(400).json({
                success: false,
                message: 'Reply text or image is required'
            });
        }

        // Get the original message to find student details
        const messageResult = await pool.query(
            'SELECT * FROM student_messages WHERE id = $1',
            [id]
        );

        if (messageResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Message not found'
            });
        }

        const originalMessage = messageResult.rows[0];
        const imagePath = req.file ? `/uploads/student-messages/${req.file.filename}` : null;

        // Insert admin reply - set status to 'unread' so student sees it as new
        const result = await pool.query(
            `INSERT INTO student_messages 
             (name, email, message, topic, image_path, status, created_at, student_id, college, sender_type, parent_message_id)
             VALUES ($1, $2, $3, $4, $5, 'unread', NOW(), $6, $7, 'admin', $8)
             RETURNING id, created_at, image_path`,
            [
                'Admin',
                null,
                (message || '').trim(),
                originalMessage.topic,
                imagePath,
                originalMessage.student_id,
                originalMessage.college,
                id
            ]
        );

        // Mark original message as read if it was unread
        if (originalMessage.status === 'unread') {
            await pool.query(
                `UPDATE student_messages SET status = 'read', read_at = NOW() WHERE id = $1`,
                [id]
            );
        }

        logger.info({
            event: 'admin_reply_sent',
            originalMessageId: id,
            replyId: result.rows[0].id,
            studentId: originalMessage.student_id
        });

        // Emit socket notification to student if they're connected
        const io = req.app.get('io');
        if (io && originalMessage.student_id) {
            const roomName = `support-student-${originalMessage.student_id}`;
            
            // Debug: Check if there are any sockets in this room
            const room = io.sockets.adapter.rooms.get(roomName);
            const socketsInRoom = room ? room.size : 0;
            
            logger.info({
                event: 'socket_emit_admin_reply',
                roomName,
                studentId: originalMessage.student_id,
                replyId: result.rows[0].id,
                socketsInRoom: socketsInRoom,
                allRooms: Array.from(io.sockets.adapter.rooms.keys()).filter(r => r.startsWith('support-student'))
            });
            
            io.to(roomName).emit('support:new-admin-reply', {
                id: result.rows[0].id,
                messagePreview: message.trim().substring(0, 100) + (message.length > 100 ? '...' : ''),
                createdAt: result.rows[0].created_at,
                originalMessageId: id,
                hasImage: !!imagePath
            });
        } else {
            logger.warn({
                event: 'socket_emit_skipped',
                hasIo: !!io,
                studentId: originalMessage.student_id
            });
        }

        res.json({
            success: true,
            message: 'Reply sent successfully',
            data: {
                id: result.rows[0].id,
                createdAt: result.rows[0].created_at,
                imagePath: result.rows[0].image_path
            }
        });
    } catch (error) {
        logger.error({ err: error, event: 'admin_reply_error' });
        res.status(500).json({
            success: false,
            message: 'Failed to send reply'
        });
    }
});

module.exports = router;