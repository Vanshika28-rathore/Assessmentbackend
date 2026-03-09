const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');
require('dotenv').config();

// Import configurations
const { pool } = require('./config/db');
// const { redisClient, cache } = require('./config/redis'); // DISABLED: Redis causing connection issues
require('./config/firebase'); // Initialize Firebase Admin SDK
const { logger, expressLogger } = require('./config/logger');

// Import routes
const authRoutes = require('./routes/auth');
const adminAuthRoutes = require('./routes/adminAuth');
const uploadRoutes = require('./routes/upload');
const studentRoutes = require('./routes/student');
const exportRoutes = require('./routes/export');
const testRoutes = require('./routes/test');
const healthRoutes = require('./routes/health');
const institutesRoutes = require('./routes/institutes');
const proctoringRoutes = require('./routes/proctoring');
const feedbackRoutes = require('./routes/feedback');
const settingsRoutes = require('./routes/settings');
// DISABLED: Coding questions and code execution features
// const codeExecutionRoutes = require('./routes/codeExecution.routes');
// const codingQuestionsRoutes = require('./routes/codingQuestions.routes');
const interviewsRoutes = require('./routes/interviews.routes');

// Import middleware
const { authLimiter, apiLimiter, submissionLimiter, proctoringLimiter } = require('./middleware/rateLimiter');
const { checkMaintenance } = require('./middleware/maintenance');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Socket.IO CORS configuration - Allow multiple origins
const allowedSocketOrigins = [
    process.env.FRONTEND_URL,
    process.env.CLIENT_URL,
    'http://localhost:5173',
    'http://localhost:5174',
    'https://assessment-shnoor-com.onrender.com',
    'https://assessments.shnoor.com'
].filter(Boolean);

const io = new Server(server, {
    cors: {
        origin: allowedSocketOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['websocket', 'polling'],
    allowEIO3: true,
    upgradeTimeout: 30000, // Allow 30 seconds for transport upgrade
    maxHttpBufferSize: 1e8 // 100 MB
});
const PORT = process.env.PORT || 5000;

// Trust proxy - Required for Render deployment to get correct client IP
app.set('trust proxy', 1);

// Middleware
app.use(helmet()); // Security headers

// CORS configuration - Allow multiple origins
const allowedOrigins = [
    process.env.FRONTEND_URL,
    process.env.CLIENT_URL,
    'http://localhost:5173',
    'http://localhost:5174',
    'https://assessment-shnoor-com.onrender.com',
    'https://assessments.shnoor.com'
].filter(Boolean); // Remove undefined values

app.use(cors({
    origin: function (origin, callback) {
        // Allow requests with no origin (like mobile apps or curl requests)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
}));

// Handle OPTIONS requests explicitly (CORS preflight)
app.options('*', cors());

app.use(express.json()); // Parse JSON bodies
app.use(express.urlencoded({ extended: true })); // Parse URL-encoded bodies
app.use(expressLogger); // Structured logging with Pino

// Apply rate limiting
app.use('/api/auth', authLimiter); // Auth endpoints
app.use('/api/admin/auth', authLimiter); // Admin auth endpoints
app.use('/api/student/submit-exam', submissionLimiter); // Submission endpoints
app.use('/api/student/save-progress', submissionLimiter); // Progress save endpoints
app.use('/api', apiLimiter); // General API endpoints



// API Routes
app.use('/api', checkMaintenance, authRoutes); // Protect student auth with maintenance check
app.use('/api/admin', adminAuthRoutes); // Admin bypasses maintenance
app.use('/api/upload', checkMaintenance, uploadRoutes);
app.use('/api/student', checkMaintenance, studentRoutes);
app.use('/api/export', exportRoutes); // Admin action, bypasses maintenance check usually (or requires admin token anyway)
app.use('/api/tests', checkMaintenance, testRoutes);
app.use('/api/institutes', institutesRoutes);
app.use('/api/proctoring', proctoringRoutes);
app.use('/api/feedback', checkMaintenance, feedbackRoutes);
app.use('/api/settings', settingsRoutes);
// DISABLED: Coding questions and code execution features
// app.use('/api/code', codeExecutionRoutes);
// app.use('/api/coding-questions', codingQuestionsRoutes);
app.use('/api/interviews', interviewsRoutes);

// Health monitoring routes
app.use('/', healthRoutes);

// 404 handler
app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: 'Route not found',
    });
});

// Global error handler
app.use((err, req, res, next) => {
    logger.error({
        err,
        req: {
            method: req.method,
            url: req.url,
            headers: req.headers,
        }
    }, 'Global error handler');

    res.status(err.status || 500).json({
        success: false,
        message: err.message || 'Internal server error',
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
});

// Start server
server.listen(PORT, () => {
    logger.info({
        port: PORT,
        env: process.env.NODE_ENV || 'development',
        pid: process.pid,
        nodeVersion: process.version,
    }, 'Server started successfully');
    
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`🔗 API: http://localhost:${PORT}`);
    console.log(`🔌 Socket.io: Ready for proctoring connections`);
    console.log(`💚 Health: http://localhost:${PORT}/health`);
    console.log(`📈 Metrics: http://localhost:${PORT}/metrics`);
    
    // Signal PM2 that app is ready
    if (process.send) {
        process.send('ready');
    }
});

// Socket.io - Live Proctoring with Sample-Based Monitoring
const activeSessions = new Map(); // studentId -> { socketId, testId, studentName, startTime, isMonitored }
const adminSockets = new Set(); // Set of admin socket IDs
const monitoredStudents = new Set(); // Set of student IDs currently being monitored

// Proctoring configuration
const PROCTORING_CONFIG = {
    SAMPLE_RATE: parseFloat(process.env.PROCTORING_SAMPLE_RATE) || 0.15, // 15% of students
    FRAME_RATE: parseInt(process.env.PROCTORING_FRAME_RATE) || 2, // 2 FPS
    ROTATION_INTERVAL: parseInt(process.env.PROCTORING_ROTATION_MINUTES) || 5, // 5 minutes
    MIN_MONITORED: 5, // Minimum students to monitor
    MAX_MONITORED: 60, // Maximum students to monitor
};

/**
 * Select random students for monitoring based on sample rate
 * @param {number} totalStudents - Total number of active students
 * @returns {number} - Number of students to monitor
 */
function calculateMonitoredCount(totalStudents) {
    const calculated = Math.ceil(totalStudents * PROCTORING_CONFIG.SAMPLE_RATE);
    return Math.max(
        PROCTORING_CONFIG.MIN_MONITORED,
        Math.min(calculated, PROCTORING_CONFIG.MAX_MONITORED)
    );
}

/**
 * Randomly select students for monitoring
 */
function selectStudentsForMonitoring() {
    const allStudents = Array.from(activeSessions.keys());
    const monitorCount = calculateMonitoredCount(allStudents.length);
    
    // Clear previous selection
    monitoredStudents.clear();
    
    // Randomly select students
    const shuffled = allStudents.sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, monitorCount);
    
    selected.forEach(studentId => {
        monitoredStudents.add(studentId);
        const session = activeSessions.get(studentId);
        if (session) {
            session.isMonitored = true;
        }
    });
    
    // Mark non-monitored students
    allStudents.forEach(studentId => {
        if (!monitoredStudents.has(studentId)) {
            const session = activeSessions.get(studentId);
            if (session) {
                session.isMonitored = false;
            }
        }
    });
    
    logger.info({
        totalStudents: allStudents.length,
        monitoredCount: selected.length,
        sampleRate: (selected.length/allStudents.length*100).toFixed(1) + '%'
    }, 'Proctoring monitoring pool updated');
    
    // Notify all students about their monitoring status
    allStudents.forEach(studentId => {
        const session = activeSessions.get(studentId);
        if (session && session.socketId) {
            io.to(session.socketId).emit('monitoring-status', {
                isMonitored: monitoredStudents.has(studentId),
                frameRate: PROCTORING_CONFIG.FRAME_RATE,
            });
        }
    });
    
    // Notify admins about monitoring pool update
    io.to('admin-room').emit('monitoring-pool-updated', {
        totalStudents: allStudents.length,
        monitoredCount: selected.length,
        monitoredStudents: selected,
        sampleRate: PROCTORING_CONFIG.SAMPLE_RATE,
        nextRotation: new Date(Date.now() + PROCTORING_CONFIG.ROTATION_INTERVAL * 60 * 1000),
    });
}

// Rotate monitored students every N minutes
let rotationInterval = setInterval(() => {
    if (activeSessions.size > 0) {
        logger.info('Rotating monitored students');
        selectStudentsForMonitoring();
    }
}, PROCTORING_CONFIG.ROTATION_INTERVAL * 60 * 1000);

io.on('connection', (socket) => {
    logger.info({ 
        socketId: socket.id, 
        transport: socket.conn.transport.name,
        remoteAddress: socket.conn.remoteAddress 
    }, 'Socket.io client connected');

    // Connection timeout handling
    const connectionTimeout = setTimeout(() => {
        if (!socket.studentId && !socket.isAdmin && !socket.interviewRole && !socket.studentDashboardId) {
            logger.warn({ socketId: socket.id }, 'Socket connection timeout - no identification received');
            socket.emit('connection-timeout', { message: 'Connection timeout - please refresh and try again' });
            socket.disconnect(true);
        }
    }, 30000); // 30 seconds to identify

    // Error handling
    socket.on('error', (error) => {
        logger.error({ 
            socketId: socket.id, 
            studentId: socket.studentId,
            error: error.message,
            stack: error.stack 
        }, 'Socket.io error occurred');
        
        // Emit error to client for handling
        socket.emit('socket-error', { 
            message: 'Connection error occurred', 
            shouldReconnect: true 
        });
    });

    // Connection health check
    socket.on('ping', (callback) => {
        if (typeof callback === 'function') {
            callback('pong');
        }
    });

    // Handle reconnection
    socket.on('reconnect-request', (data) => {
        logger.info({ 
            socketId: socket.id, 
            studentId: data?.studentId 
        }, 'Client requesting reconnection');
        
        socket.emit('reconnect-approved', { 
            message: 'Reconnection approved',
            timestamp: new Date().toISOString()
        });
    });

    // Student joins proctoring session
    socket.on('student:join-proctoring', (data) => {
        const { studentId, studentName, testId, testTitle } = data;
        
        // Store with string key for consistent lookup
        const studentIdStr = String(studentId);
        
        activeSessions.set(studentIdStr, {
            socketId: socket.id,
            studentId: studentIdStr,
            studentName,
            testId,
            testTitle,
            startTime: new Date(),
            isMonitored: false,
        });

        socket.join(`student-${studentIdStr}`);
        socket.studentId = studentIdStr;

        logger.info({ studentId: studentIdStr, studentName, testId, testTitle }, 'Student joined proctoring');

        // Reselect monitored students when new student joins
        selectStudentsForMonitoring();

        // Notify all admins about new student
        io.to('admin-room').emit('student:joined', {
            studentId: studentIdStr,
            studentName,
            testId,
            testTitle,
            startTime: new Date(),
            isMonitored: monitoredStudents.has(studentIdStr),
        });
    });

    // Admin joins monitoring room
    socket.on('admin:join-monitoring', () => {
        socket.join('admin-room');
        adminSockets.add(socket.id);
        socket.isAdmin = true;

        logger.info({ socketId: socket.id }, 'Admin joined monitoring room');

        // Send list of active sessions to admin
        const sessions = Array.from(activeSessions.values()).map(session => ({
            studentId: session.studentId,
            studentName: session.studentName,
            testId: session.testId,
            testTitle: session.testTitle,
            startTime: session.startTime,
            isMonitored: session.isMonitored,
        }));

        socket.emit('active-sessions', sessions);
        
        // Send monitoring configuration
        socket.emit('monitoring-config', {
            sampleRate: PROCTORING_CONFIG.SAMPLE_RATE,
            frameRate: PROCTORING_CONFIG.FRAME_RATE,
            rotationInterval: PROCTORING_CONFIG.ROTATION_INTERVAL,
            totalStudents: activeSessions.size,
            monitoredCount: monitoredStudents.size,
        });
    });

    // Admin requests to refresh monitoring pool
    socket.on('admin:refresh-monitoring', () => {
        if (socket.isAdmin) {
            logger.info({ socketId: socket.id }, 'Admin requested monitoring pool refresh');
            selectStudentsForMonitoring();
        }
    });

    // Frame-based proctoring - Receive frame from student (ONLY if monitored)
    socket.on('proctoring:frame', (data) => {
        const { studentId, studentName, testId, testTitle, frame, timestamp, aiViolations } = data;
        
        // Only relay frames from monitored students
        if (monitoredStudents.has(studentId)) {
            // Relay frame to all admins in monitoring room
            io.to('admin-room').emit('proctoring:frame', {
                studentId,
                studentName,
                testId,
                testTitle,
                frame,
                timestamp,
                aiViolations // Include AI violation counts
            });
        }
    });

    // AI Violation detected - Store and alert admins
    socket.on('proctoring:ai-violation', async (data) => {
        const { studentId, testId, violation, timestamp } = data;
        
        logger.warn({ 
            studentId, 
            testId, 
            violationType: violation.type,
            severity: violation.severity 
        }, 'AI Violation detected');

        try {
            // Store violation in database
            await pool.query(
                `INSERT INTO proctoring_violations 
                (student_id, test_id, violation_type, severity, message, timestamp) 
                VALUES ($1, $2, $3, $4, $5, $6)`,
                [studentId, testId, violation.type, violation.severity, violation.message, new Date(timestamp)]
            );

            // Notify all admins in real-time
            io.to('admin-room').emit('ai-violation-alert', {
                studentId,
                testId,
                violation,
                timestamp
            });

            logger.info({ studentId, testId }, 'AI violation stored and admins notified');
        } catch (error) {
            logger.error({ error, studentId, testId }, 'Error storing AI violation');
        }
    });

    // ============================================
    // PROCTORING MESSAGING EVENTS
    // ============================================

    // Admin sends message to student
    socket.on('admin:send-message', async (data) => {
        const { studentId, message, messageType = 'warning', priority = 'medium', adminId = 'admin', testId } = data;

        logger.info({ studentId, messageType, priority, adminId }, 'Received admin:send-message event');

        // Validate required fields
        if (!studentId || !message) {
            logger.warn({ studentId }, 'admin:send-message - Missing required fields');
            socket.emit('admin:message-failed', { studentId, error: 'Missing required fields: studentId, message' });
            return;
        }

        // Find active student session - ensure string comparison
        const studentIdStr = String(studentId);
        const studentSession = activeSessions.get(studentIdStr);

        logger.info({ 
            studentIdStr, 
            hasSession: !!studentSession,
            activeSessions: Array.from(activeSessions.keys())
        }, 'Checking student session');

        if (!studentSession) {
            logger.warn({ studentId: studentIdStr, adminId }, 'Attempted to send message to inactive student');
            socket.emit('admin:message-failed', { studentId: studentIdStr, error: 'Student not in active session' });
            return;
        }

        try {
            // Create message data
            const messageData = {
                id: Date.now(),
                adminId,
                studentId,
                testId: testId || studentSession.testId,
                message,
                messageType,
                priority,
                sessionId: `${studentId}-${studentSession.testId}-${Date.now()}`,
                timestamp: new Date()
            };

            // Store message in database
            await pool.query(
                `INSERT INTO proctoring_messages 
                (admin_id, student_id, test_id, message, message_type, priority, session_id, message_timestamp) 
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING id`,
                [adminId, studentId, messageData.testId, message, messageType, priority, messageData.sessionId, messageData.timestamp]
            );

            // Send message to specific student using their session socket ID
            io.to(studentSession.socketId).emit('proctoring:message-received', messageData);

            // Confirm delivery to admin
            socket.emit('admin:message-delivered', { 
                ...messageData, 
                success: true,
                studentName: studentSession.studentName
            });

            logger.info({ 
                adminId, 
                studentId, 
                studentName: studentSession.studentName,
                messageType, 
                priority,
                messagePreview: message.substring(0, 50) + '...'
            }, 'Message sent to student');

        } catch (error) {
            logger.error({ error, studentId, adminId }, 'Error sending message to student');
            socket.emit('admin:message-failed', { studentId, error: 'Failed to send message - database error' });
        }
    });

    // Student acknowledges message receipt
    socket.on('student:message-read', async (data) => {
        const { messageId, studentId } = data;

        if (!messageId || !studentId) {
            return;
        }

        try {
            // Update read status in database
            await pool.query(
                `UPDATE proctoring_messages 
                SET read_status = TRUE, read_at = CURRENT_TIMESTAMP 
                WHERE id = $1 AND student_id = $2`,
                [messageId, studentId]
            );

            // Notify all admins that message was read
            io.to('admin-room').emit('student:message-read', {
                messageId,
                studentId,
                readAt: new Date()
            });

            logger.info({ messageId, studentId }, 'Student acknowledged message receipt');
        } catch (error) {
            logger.error({ error, messageId, studentId }, 'Error updating message read status');
        }
    });

    // Admin requests message history for a student
    socket.on('admin:get-message-history', async (data) => {
        const { studentId, testId } = data;

        if (!socket.isAdmin) {
            socket.emit('admin:message-history-error', { error: 'Unauthorized' });
            return;
        }

        try {
            const result = await pool.query(
                `SELECT id, admin_id, message, message_type, priority, message_timestamp, read_status, read_at
                FROM proctoring_messages 
                WHERE student_id = $1 AND ($2::VARCHAR IS NULL OR test_id = $2)
                ORDER BY message_timestamp DESC 
                LIMIT 50`,
                [studentId, testId || null]
            );

            socket.emit('admin:message-history', {
                studentId,
                testId,
                messages: result.rows
            });
        } catch (error) {
            logger.error({ error, studentId, testId }, 'Error fetching message history');
            socket.emit('admin:message-history-error', { error: 'Failed to fetch message history' });
        }
    });

    // ============================================
    // END PROCTORING MESSAGING EVENTS
    // ============================================

    // Student leaves proctoring
    socket.on('student:leave-proctoring', (data) => {
        if (data && data.studentId) {
            logger.info({ studentId: data.studentId, studentName: data.studentName }, 'Student leaving proctoring');
            
            // Notify admins
            io.to('admin-room').emit('student:left', {
                studentId: data.studentId,
                studentName: data.studentName,
            });

            // Clean up session
            if (activeSessions.has(data.studentId)) {
                activeSessions.delete(data.studentId);
            }
            
            monitoredStudents.delete(data.studentId);
            
            // Reselect monitored students after student leaves
            if (activeSessions.size > 0) {
                selectStudentsForMonitoring();
            }
        }
    });

    // ============================================
    // INTERVIEW SIGNALING HANDLERS
    // ============================================
    
    // Student joins dashboard room for notifications
    socket.on('student:join-dashboard', (data) => {
        const { studentId } = data;
        socket.join(`student-dashboard-${studentId}`);
        socket.studentDashboardId = studentId;
        logger.info({ studentId }, 'Student joined dashboard room for interview notifications');
    });
    
    // Join interview room
    socket.on('interview:join', (data) => {
        const { interviewId, peerId, role } = data; // role: 'admin' or 'student'
        
        socket.join(`interview-${interviewId}`);
        socket.interviewId = interviewId;
        socket.interviewRole = role;
        socket.peerId = peerId;
        
        logger.info({ interviewId, peerId, role }, 'User joined interview room');
        
        // Notify other participant
        socket.to(`interview-${interviewId}`).emit('interview:peer-joined', {
            peerId,
            role
        });
    });
    
    // Signal peer ID to other participant
    socket.on('interview:signal-peer', (data) => {
        const { interviewId, peerId } = data;
        
        logger.info({ interviewId, peerId }, 'Signaling peer ID');
        
        // Broadcast to other participants in the interview room
        socket.to(`interview-${interviewId}`).emit('interview:peer-available', {
            peerId,
            role: socket.interviewRole
        });
    });
    
    // Admin starts call - notify student on dashboard AND in interview room
    socket.on('interview:start-call', async (data) => {
        const { interviewId, studentId } = data;
        
        logger.info({ interviewId, studentId }, 'Admin starting call');
        
        try {
            // Get interview details for notification
            const result = await pool.query(
                `SELECT i.id, i.student_id, t.title as test_title, s.institute as institute_name
                 FROM interviews i
                 JOIN tests t ON i.test_id = t.id
                 JOIN students s ON i.student_id = s.id
                 WHERE i.id = $1`,
                [interviewId]
            );
            
            if (result.rows.length > 0) {
                const interview = result.rows[0];
                
                // Update interview status to in_progress
                await pool.query(
                    `UPDATE interviews SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [interviewId]
                );
                
                // Notify student in interview room
                socket.to(`interview-${interviewId}`).emit('interview:call-started', {
                    interviewId,
                    timestamp: new Date().toISOString()
                });
                
                // Notify student on dashboard (if they're on dashboard page)
                io.to(`student-dashboard-${interview.student_id}`).emit('interview:incoming-call', {
                    interviewId: interview.id,
                    testTitle: interview.test_title,
                    instituteName: interview.institute_name
                });
                
                logger.info({ 
                    interviewId, 
                    studentId: interview.student_id,
                    testTitle: interview.test_title 
                }, 'Call notification sent to student');
            }
        } catch (error) {
            logger.error({ error, interviewId, studentId }, 'Error sending call notification');
        }
    });
    
    // Student is ready to receive call - notify admin to initiate PeerJS call
    socket.on('interview:student-ready', (data) => {
        const { interviewId, peerId } = data;
        
        logger.info({ interviewId, peerId }, 'Student ready to receive call');
        
        // Notify admin in the interview room
        socket.to(`interview-${interviewId}`).emit('interview:student-ready', {
            peerId,
            timestamp: new Date().toISOString()
        });
    });
    
    // Chat message in interview room
    socket.on('interview:send-chat', (data) => {
        const { interviewId, sender, senderName, text, timestamp } = data;
        
        logger.info({ 
            interviewId, 
            sender, 
            senderName, 
            text: text.substring(0, 50),
            socketId: socket.id,
            room: `interview-${interviewId}`
        }, 'Chat message received, broadcasting to room');
        
        // Broadcast to other participant in the interview room
        const sent = socket.to(`interview-${interviewId}`).emit('interview:chat-message', {
            sender,
            senderName,
            text,
            timestamp
        });
        
        // Confirm to sender
        socket.emit('interview:chat-sent', {
            success: true,
            timestamp
        });
        
        logger.info({ interviewId, sent }, 'Chat message broadcasted');
    });
    
    // Leave interview room
    socket.on('interview:leave', (data) => {
        const { interviewId } = data;
        
        logger.info({ interviewId, role: socket.interviewRole }, 'User left interview room');
        
        // Notify other participant
        socket.to(`interview-${interviewId}`).emit('interview:peer-left', {
            role: socket.interviewRole
        });
        
        socket.leave(`interview-${interviewId}`);
    });

    // Keepalive ping
    socket.on('ping', () => {
        socket.emit('pong');
    });

    // Disconnect handling with comprehensive cleanup
    socket.on('disconnect', (reason) => {
        logger.debug({ 
            socketId: socket.id, 
            studentId: socket.studentId,
            isAdmin: socket.isAdmin,
            reason 
        }, 'Socket.io client disconnected');

        // Clear any pending timeouts
        clearTimeout(connectionTimeout);

        if (socket.isAdmin) {
            adminSockets.delete(socket.id);
            logger.info({ socketId: socket.id, reason }, 'Admin left monitoring room');
            
            // Notify remaining admins
            io.to('admin-room').emit('admin:left', {
                socketId: socket.id,
                timestamp: new Date(),
                reason
            });
            
        } else if (socket.studentId) {
            const session = activeSessions.get(socket.studentId);
            if (session) {
                logger.info({ 
                    studentId: socket.studentId, 
                    studentName: session.studentName,
                    reason,
                    duration: new Date() - session.startTime
                }, 'Student disconnected');
                
                // Remove from monitoring if they were being monitored
                monitoredStudents.delete(socket.studentId);
                
                // Notify admins with disconnect reason
                io.to('admin-room').emit('student:left', {
                    studentId: socket.studentId,
                    studentName: session.studentName,
                    reason,
                    timestamp: new Date(),
                    sessionDuration: new Date() - session.startTime
                });

                // Clean up session
                activeSessions.delete(socket.studentId);
                
                // Reselect monitored students after someone leaves
                if (activeSessions.size > 0) {
                    selectStudentsForMonitoring();
                }
            }
        }
    });

    // Handle connection errors specifically
    socket.on('connect_error', (error) => {
        logger.error({ 
            socketId: socket.id,
            studentId: socket.studentId,
            error: error.message 
        }, 'Socket.io connection error');
    });

    // Handle client-side errors
    socket.on('client-error', (errorData) => {
        logger.error({ 
            socketId: socket.id,
            studentId: socket.studentId,
            clientError: errorData 
        }, 'Client-side error reported');
        
        // Optionally notify admins of client issues
        if (socket.studentId) {
            io.to('admin-room').emit('student:error', {
                studentId: socket.studentId,
                error: errorData,
                timestamp: new Date()
            });
        }
    });
});

// Connection Health Monitoring System
const CONNECTION_HEALTH_INTERVAL = 30000; // 30 seconds
const CONNECTION_TIMEOUT_THRESHOLD = 60000; // 60 seconds

setInterval(() => {
    const now = new Date();
    const staleConnections = [];
    
    // Check for stale connections
    activeSessions.forEach((session, studentId) => {
        const socket = io.sockets.sockets.get(session.socketId);
        
        if (!socket || !socket.connected) {
            staleConnections.push(studentId);
        } else if (session.lastPing && (now - session.lastPing) > CONNECTION_TIMEOUT_THRESHOLD) {
            // Connection seems stale, ping it
            socket.emit('health-check', { timestamp: now.toISOString() });
            
            // If no response in 10 seconds, consider it stale
            setTimeout(() => {
                const currentSession = activeSessions.get(studentId);
                if (currentSession && (!currentSession.lastPing || (new Date() - currentSession.lastPing) > CONNECTION_TIMEOUT_THRESHOLD)) {
                    logger.warn({ studentId, socketId: session.socketId }, 'Removing stale connection');
                    staleConnections.push(studentId);
                }
            }, 10000);
        }
    });
    
    // Clean up stale connections
    staleConnections.forEach(studentId => {
        const session = activeSessions.get(studentId);
        if (session) {
            logger.info({ studentId, studentName: session.studentName }, 'Cleaning up stale connection');
            
            // Notify admins
            io.to('admin-room').emit('student:left', {
                studentId,
                studentName: session.studentName,
                reason: 'connection_timeout',
                timestamp: new Date()
            });
            
            // Remove from monitoring and sessions
            monitoredStudents.delete(studentId);
            activeSessions.delete(studentId);
        }
    });
    
    // Reselect monitored students if any were removed
    if (staleConnections.length > 0 && activeSessions.size > 0) {
        selectStudentsForMonitoring();
    }
    
    // Log connection health stats periodically
    if (activeSessions.size > 0) {
        logger.debug({
            totalSessions: activeSessions.size,
            monitoredStudents: monitoredStudents.size,
            adminSockets: adminSockets.size,
            staleConnectionsRemoved: staleConnections.length
        }, 'Connection health check completed');
    }
}, CONNECTION_HEALTH_INTERVAL);

// Add engine-level error handling
io.engine.on('connection_error', (err) => {
    logger.error({
        error: err.message,
        code: err.code,
        context: err.context
    }, 'Socket.IO engine connection error');
});

// Graceful shutdown
const gracefulShutdown = (signal) => {
    logger.info({ signal }, 'Shutdown signal received, closing server gracefully');
    
    server.close(() => {
        logger.info('HTTP server closed');
        
        pool.end(() => {
            logger.info('Database pool closed');
            process.exit(0);
        });
    });
    
    // Force shutdown after 30 seconds
    setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
    }, 30000);
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

module.exports = app;
