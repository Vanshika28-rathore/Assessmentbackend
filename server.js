const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');
const { Server } = require('socket.io');
const { ExpressPeerServer } = require('peer');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '.env') });


// Import configurations
const { pool } = require('./config/db');
// const { redisClient, cache } = require('./config/redis'); // DISABLED: Redis causing connection issues
require('./config/firebase'); // Initialize Firebase Admin SDK
const { logger, expressLogger } = require('./config/logger');

// Import cleanup job
const cleanupOldMessages = require('./jobs/cleanupOldMessages');

// Import routes
const authRoutes = require('./routes/auth');
const adminAuthRoutes = require('./routes/adminAuth');
const uploadRoutes = require('./routes/upload');
const studentRoutes = require('./routes/student');
const exportRoutes = require('./routes/export');
const testRoutes = require('./routes/testRoutes');
const healthRoutes = require('./routes/health');
const institutesRoutes = require('./routes/institutes');
const proctoringRoutes = require('./routes/proctoring');
const feedbackRoutes = require('./routes/feedback');
const settingsRoutes = require('./routes/settings');
const jobOpeningsRoutes = require('./routes/jobOpenings');
const jobApplicationsRoutes = require('./routes/jobApplications');
const studentMessagesRoutes = require('./routes/studentMessages');
const codeExecutionRoutes = require('./routes/codeExecution.routes');
const codingQuestionsRoutes = require('./routes/codingQuestions.routes');
const interviewsRoutes = require('./routes/interviews.routes');
const aiInterviewRoutes = require('./routes/aiInterview.routes');

// Import middleware
const { authLimiter, apiLimiter, submissionLimiter, proctoringLimiter, adminLimiter } = require('./middleware/rateLimiter');
const { checkMaintenance } = require('./middleware/maintenance');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Socket.IO CORS configuration - Allow multiple origins
const allowedSocketOrigins = [
    process.env.FRONTEND_URL,
    process.env.CLIENT_URL,
    'http://localhost:4173',
    'http://localhost:4174',
    'http://localhost:5173',
    'http://localhost:5174',
    'https://assessment-shnoor-com.onrender.com',
    'https://assessments.shnoor.com',
    'https://d3v3kobu4jrvb4.cloudfront.net'
].filter(Boolean);

const io = new Server(server, {
    cors: {
        origin: allowedSocketOrigins,
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000,
    pingInterval: 25000,
    transports: ['polling'],
    allowEIO3: true,
    upgradeTimeout: 30000, // Allow 30 seconds for transport upgrade
    maxHttpBufferSize: 1e8, // 100 MB
    allowRequest: (req, callback) => {
        callback(null, true); // Allow all requests
    }

});
const PORT = process.env.PORT || 5000;

// Trust proxy - Required for Render deployment to get correct client IP
app.set('trust proxy', 1);

// Serve static files for uploaded images BEFORE helmet (to avoid CSP issues)
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
    setHeaders: (res) => {
        res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
}));

// Middleware

app.use(helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            imgSrc: ["'self'", "data:", "blob:", "http://localhost:*", "https://*"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'", "https:"],
            fontSrc: ["'self'", "https:", "data:"],
            connectSrc: ["'self'", "http://localhost:*", "https://*", "wss://*", "ws://*"],
        }
    }
})); // Security headers

// CORS configuration - Allow multiple origins
const allowedOrigins = [
    process.env.FRONTEND_URL,
   process.env.CLIENT_URL,
    'http://localhost:4173',
    'http://localhost:4174',
    'http://localhost:5173',
    'http://localhost:5174',
    'https://assessment-shnoor-com.onrender.com',
    'https://assessments.shnoor.com',
    'https://d3v3kobu4jrvb4.cloudfront.net'
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
app.use('/api/admin', authLimiter, adminLimiter); // Admin auth endpoints with admin rate limiting
app.use('/api/student/submit-exam', submissionLimiter); // Submission endpoints
app.use('/api/student/save-progress', submissionLimiter); // Progress save endpoints
app.use('/api', apiLimiter); // General API endpoints (fallback)

// Make socket.io accessible to routes for real-time notifications
app.set('io', io);

// API Routes
app.use('/api', authRoutes); // Protect student auth with maintenance check
app.use('/api/admin', adminAuthRoutes); // Admin bypasses maintenance
app.use('/api/upload', checkMaintenance, uploadRoutes);
app.use('/api/student', checkMaintenance, studentRoutes);
app.use('/api/export', exportRoutes); // Admin action, bypasses maintenance check usually (or requires admin token anyway)
app.use('/api/tests', checkMaintenance, testRoutes);
app.use('/api/institutes', institutesRoutes);
app.use('/api/proctoring', proctoringRoutes);
app.use('/api/feedback', checkMaintenance, feedbackRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/job-openings', jobOpeningsRoutes); // Job Openings & Off-Campus Hiring
app.use('/api/job-applications', jobApplicationsRoutes); // Job Applications & Recruitment
app.use('/api/student-messages', studentMessagesRoutes);
app.use('/api/code', codeExecutionRoutes);
app.use('/api/coding-questions', codingQuestionsRoutes);
app.use('/api/interviews', interviewsRoutes);
app.use('/api/ai-interview', aiInterviewRoutes);

app.get('/', (req, res) => {
    res.json({
        status: "Backend running",
        service: "MCQ Exam Portal API"
    });
});


const { WebSocketServer } = require('ws');

app.get("/", async (request, reply) => {
  return { message: "Backend running" };
});

// PeerJS signaling server
const peerServer = ExpressPeerServer(server, {
    path: '/',
    allow_discovery: false,
    createWebSocketServer: (options) => new WebSocketServer(options),
});
app.use('/peerjs', peerServer);

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

// Run critical migrations automatically on startup
async function runPendingMigrations() {
    try {
        const fs = require('fs');
        const sqlPath = path.join(__dirname, 'migrations', 'add-job-application-to-test-attempts.sql');
        if (fs.existsSync(sqlPath)) {
            const sql = fs.readFileSync(sqlPath, 'utf8');
            await pool.query(sql);
            console.log('✅ Verified critical DB migration: add-job-application-to-test-attempts.sql');
        }
    } catch (err) {
        console.error('❌ Failed to run auto-migration:', err.message);
    }
}

// Auto-repair script to run immediately after migrations, ensuring Production DB heals old corrupted "Submitted" states automatically.
async function autoRepairBrokenStatuses() {
    try {
        const appsRes = await pool.query(`
            SELECT id, student_id, job_opening_id, status 
            FROM job_applications 
            WHERE status IN ('submitted', 'assessment_assigned', 'assessment_completed')
        `);
        if (appsRes.rows.length === 0) return;
        console.log(`[Auto-Repair] Found ${appsRes.rows.length} pending applications to inspect...`);
        let fixedCount = 0;

        for (const app of appsRes.rows) {
            const { id: applicationId, student_id: studentId, job_opening_id: jobOpeningId } = app;
            const jotRes = await pool.query(`SELECT test_id FROM job_opening_tests WHERE job_opening_id = $1`, [jobOpeningId]);
            const jobTestIds = jotRes.rows.map(r => r.test_id);
            if (jobTestIds.length === 0) continue;

            let hasTests = false;
            for (const testId of jobTestIds) {
                const testRes = await pool.query(`SELECT title FROM tests WHERE id = $1`, [testId]);
                if (testRes.rows.length === 0) continue;

                const rRes = await pool.query(`
                    SELECT r.* 
                    FROM results r JOIN exams e ON r.exam_id = e.id 
                    WHERE r.student_id = $1 AND e.name LIKE $2
                `, [studentId, `%${testRes.rows[0].title}%`]);

                if (rRes.rows.length > 0) {
                    hasTests = true;
                    const r = rRes.rows[rRes.rows.length - 1];
                    const percentage = r.total_marks > 0 ? (r.marks_obtained / r.total_marks) * 100 : 0;

                    await pool.query(`
                        INSERT INTO test_attempts (student_id, test_id, job_application_id, total_marks, obtained_marks, percentage, submitted_at)
                        VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
                        ON CONFLICT (student_id, test_id, job_application_id) DO UPDATE SET
                            total_marks = EXCLUDED.total_marks, obtained_marks = EXCLUDED.obtained_marks,
                            percentage = EXCLUDED.percentage, submitted_at = EXCLUDED.submitted_at
                    `, [studentId, testId, applicationId, Math.round(r.total_marks || 0), Math.round(r.marks_obtained || 0), percentage]);
                }
            }

            if (!hasTests) continue;

            const testResultsCheck = await pool.query(`
                SELECT t.title as test_name, t.passing_percentage, ta.percentage as student_percentage,
                        CASE WHEN ta.percentage >= t.passing_percentage THEN true ELSE false END as passed
                FROM test_attempts ta INNER JOIN tests t ON ta.test_id = t.id
                WHERE ta.job_application_id = $1 AND ta.student_id = $2
            `, [applicationId, studentId]);

            if (testResultsCheck.rows.length >= jobTestIds.length) {
                const violationsCheck = await pool.query(`
                    SELECT COUNT(*) as total_violations
                    FROM proctoring_violations pv
                    WHERE pv.student_id = $2::varchar
                      AND pv.test_id IN (
                          SELECT test_id FROM job_opening_tests WHERE job_opening_id = $3
                      )
                `, [applicationId, studentId, jobOpeningId]);

                const allTestsPassed = testResultsCheck.rows.every(row => row.passed);
                const isFlagged = (parseInt(violationsCheck.rows[0]?.total_violations) || 0) > 5;
                const newStatus = (allTestsPassed && !isFlagged) ? 'shortlisted' : 'rejected';
                const avgScore = testResultsCheck.rows.reduce((sum, row) => sum + parseFloat(row.student_percentage || 0), 0) / (testResultsCheck.rows.length || 1);

                await pool.query(`
                    UPDATE job_applications
                    SET status = $1, test_completed_at = CURRENT_TIMESTAMP, assessment_score = $2, passed_assessment = $3
                    WHERE id = $4
                `, [newStatus, avgScore, (allTestsPassed && !isFlagged), applicationId]);
                fixedCount++;
            }
        }
        if (fixedCount > 0) console.log(`✅ [Auto-Repair] Successfully healed ${fixedCount} corrupted job applications!`);
    } catch (err) {
        console.error('❌ [Auto-Repair] Failed during automatic state repair:', err.message);
    }
}

// Start server
runPendingMigrations().then(() => autoRepairBrokenStatuses()).then(() => {
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
        console.log(`🔗 PeerJS: http://localhost:${PORT}/peerjs`);

        // Signal PM2 that app is ready
        if (process.send) {
            process.send('ready');
        }
    });
});

// Socket.io - Live Proctoring with Sample-Based Monitoring
const activeSessions = new Map(); // studentId -> { socketId, testId, studentName, startTime, isMonitored }
const adminSockets = new Set(); // Set of admin socket IDs
const monitoredStudents = new Set(); // Set of student IDs currently being monitored

// Socket.io - Support Message Tracking
const studentSupportSockets = new Map(); // rollNumber -> socketId for support message notifications
// Make these accessible to routes
app.set('studentSupportSockets', studentSupportSockets);

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
        sampleRate: (selected.length / allStudents.length * 100).toFixed(1) + '%'
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

// Cleanup old messages daily at 2 AM
const scheduleCleanup = () => {
    const now = new Date();
    const next2AM = new Date(now);
    next2AM.setHours(2, 0, 0, 0);
    
    // If it's past 2 AM today, schedule for tomorrow
    if (now > next2AM) {
        next2AM.setDate(next2AM.getDate() + 1);
    }
    
    const timeUntilCleanup = next2AM - now;
    
    logger.info({
        nextCleanup: next2AM.toISOString(),
        hoursUntil: (timeUntilCleanup / (1000 * 60 * 60)).toFixed(2)
    }, 'Scheduled daily message cleanup');
    
    setTimeout(() => {
        cleanupOldMessages()
            .then(result => {
                logger.info(result, 'Daily cleanup completed');
            })
            .catch(error => {
                logger.error({ err: error }, 'Daily cleanup failed');
            });
        
        // Schedule next cleanup (24 hours later)
        scheduleCleanup();
    }, timeUntilCleanup);
};

// Start cleanup scheduler
scheduleCleanup();

io.on('connection', (socket) => {
    logger.info({
        socketId: socket.id,
        transport: socket.conn.transport.name,
        remoteAddress: socket.conn.remoteAddress
    }, 'Socket.io client connected');

    // Connection timeout handling
    const connectionTimeout = setTimeout(() => {
        if (!socket.studentId && !socket.isAdmin && !socket.interviewRole && !socket.studentDashboardId && !socket.rollNumber && !socket.isAdminSupport) {
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

    // ============================================
    // SUPPORT MESSAGE NOTIFICATION EVENTS
    // ============================================

    // Student joins support notifications (for receiving admin reply notifications)
    socket.on('student:join-support', (data) => {
        const { rollNumber, studentName } = data;
        if (!rollNumber) {
            logger.warn({ socketId: socket.id }, 'Student tried to join support without rollNumber');
            return;
        }

        const rollNumberStr = String(rollNumber);
        studentSupportSockets.set(rollNumberStr, socket.id);
        socket.join(`support-student-${rollNumberStr}`);
        socket.rollNumber = rollNumberStr;

        // Debug: List all rooms this socket is in
        const rooms = Array.from(socket.rooms);
        logger.info({
            rollNumber: rollNumberStr,
            studentName,
            socketId: socket.id,
            rooms: rooms,
            roomJoined: `support-student-${rollNumberStr}`
        }, 'Student joined support notifications');

        // Send confirmation back to student
        socket.emit('student:support-joined', {
            success: true,
            room: `support-student-${rollNumberStr}`,
            socketId: socket.id
        });
    });

    // Admin joins support notifications room (for receiving student message notifications)
    socket.on('admin:join-support', () => {
        socket.join('admin-support-room');
        socket.isAdminSupport = true;

        logger.info({ socketId: socket.id }, 'Admin joined support notification room');

        // Confirm join
        socket.emit('admin:support-joined', { success: true });
    });

    // ============================================
    // END SUPPORT MESSAGE NOTIFICATION EVENTS
    // ============================================

    // Frame-based proctoring - Receive frame from student (ONLY if monitored)
    socket.on('proctoring:frame', (data) => {
        const { studentId, studentName, testId, testTitle, frame, timestamp, aiViolations } = data;
        const studentIdStr = String(studentId);
        const isAIInterview = Number(testId) === -1 || String(testTitle || '').toLowerCase().includes('ai interview');

        // Relay from monitored exam students; always relay AI interview sessions.
        if (monitoredStudents.has(studentIdStr) || isAIInterview) {
            // Relay frame to all admins in monitoring room
            io.to('admin-room').emit('proctoring:frame', {
                studentId: studentIdStr,
                studentName,
                testId,
                testTitle,
                frame,
                timestamp,
                aiViolations // Include AI violation counts
            });
        }
    });

    // Audio chunk relay for live proctoring (admin decides per-student playback)
    socket.on('proctoring:audio', (data) => {
        const { studentId, studentName, testId, testTitle, audioDataUrl, timestamp } = data;

        if (!studentId || !audioDataUrl) {
            return;
        }

        // Relay to admins; playback remains disabled by default on admin UI until manually enabled per student.
        io.to('admin-room').emit('proctoring:audio', {
            studentId,
            studentName,
            testId,
            testTitle,
            audioDataUrl,
            timestamp,
        });
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


    // Admin force-stops a student's test (for suspected cheating)
    socket.on('admin:force-stop-test', async (data) => {
        const { studentId, testId, reason, adminId, adminName, violationSummary } = data;

        console.log('========================================');
        console.log('🛑 FORCE-STOP REQUEST RECEIVED');
        console.log('Student ID:', studentId);
        console.log('Test ID:', testId);
        console.log('Admin ID:', adminId);
        console.log('Reason:', reason);
        console.log('========================================');

        logger.warn({
            studentId,
            testId,
            adminId,
            reason: reason?.substring(0, 50) + '...'
        }, '🛑 Admin force-stopping student test');

        // Validate admin authorization
        console.log('Checking admin authorization... socket.isAdmin =', socket.isAdmin);
        if (!socket.isAdmin) {
            console.log('❌ UNAUTHORIZED - Admin flag not set');
            logger.warn({ socketId: socket.id }, 'Unauthorized force-stop attempt');
            socket.emit('admin:force-stop-failed', {
                studentId,
                error: 'Unauthorized: Admin access required'
            });
            return;
        }
        console.log('✅ Admin authorized');

        // Validate required fields
        if (!studentId || !testId || !reason || !adminId) {
            console.log('❌ MISSING REQUIRED FIELDS');
            logger.warn({ studentId, testId }, 'Force-stop missing required fields');
            socket.emit('admin:force-stop-failed', {
                studentId,
                error: 'Missing required fields'
            });
            return;
        }
        console.log('✅ All required fields present');

        // Find active student session
        const studentIdStr = String(studentId);
        console.log('Looking for student session:', studentIdStr);
        console.log('Active sessions:', Array.from(activeSessions.keys()));
        const studentSession = activeSessions.get(studentIdStr);

        if (!studentSession) {
            console.log('❌ STUDENT NOT IN ACTIVE SESSION');
            logger.warn({ studentId: studentIdStr }, 'Cannot force-stop: Student not in active session');
            socket.emit('admin:force-stop-failed', {
                studentId: studentIdStr,
                error: 'Student is not currently taking a test'
            });
            return;
        }
        console.log('✅ Student session found:', studentSession);

        try {
            console.log('📝 Inserting termination record into database...');
            // 1. Store forced termination record in database
            const terminationResult = await pool.query(
                `INSERT INTO forced_terminations 
                (student_id, test_id, admin_id, admin_name, reason, violation_summary, student_notified) 
                VALUES ($1, $2, $3, $4, $5, $6, $7)
                RETURNING id`,
                [studentId, testId, adminId, adminName || 'Admin', reason, violationSummary || '', false]
            );

            const terminationId = terminationResult.rows[0].id;
            console.log('✅ Termination record created with ID:', terminationId);

            logger.info({
                terminationId,
                studentId,
                testId,
                adminId
            }, 'Forced termination record created');

            console.log('📤 Sending force-stop command to student socket:', studentSession.socketId);
            // 2. Send force-stop command to specific student
            io.to(studentSession.socketId).emit('proctoring:force-stopped', {
                testId: testId,
                reason: reason,
                adminName: adminName || 'Admin',
                timestamp: new Date().toISOString(),
                terminationId: terminationId
            });
            console.log('✅ Force-stop command sent to student');

            console.log('📝 Updating student_notified flag...');
            // 3. Update termination record to mark student as notified
            await pool.query(
                `UPDATE forced_terminations SET student_notified = TRUE WHERE id = $1`,
                [terminationId]
            );
            console.log('✅ Student marked as notified');

            console.log('📤 Sending success response to admin...');
            // 4. Confirm success to admin
            socket.emit('admin:force-stop-success', {
                studentId: studentIdStr,
                studentName: studentSession.studentName,
                testId: testId,
                terminationId: terminationId,
                timestamp: new Date().toISOString()
            });
            console.log('✅ Success response sent to admin');

            console.log('📢 Notifying other admins...');
            // 5. Notify all other admins about the action
            socket.to('admin-room').emit('admin:test-forcibly-stopped', {
                studentId: studentIdStr,
                studentName: studentSession.studentName,
                testId: testId,
                testTitle: studentSession.testTitle,
                adminName: adminName || 'Admin',
                reason: reason,
                timestamp: new Date().toISOString()
            });
            console.log('✅ Other admins notified');

            logger.info({
                terminationId,
                studentId,
                studentName: studentSession.studentName,
                testId,
                adminId,
                adminName
            }, '✅ Test force-stopped successfully');

            console.log('========================================');
            console.log('✅ FORCE-STOP COMPLETED SUCCESSFULLY');
            console.log('========================================');

        } catch (error) {
            console.log('========================================');
            console.log('❌ DATABASE ERROR');
            console.error('Error details:', error);
            console.log('========================================');
            logger.error({ error, studentId, testId, adminId }, 'Error force-stopping test');
            socket.emit('admin:force-stop-failed', {
                studentId: studentIdStr,
                error: 'Database error - failed to record termination'
            });
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

        logger.info({ interviewId, peerId, role, socketId: socket.id }, 'User joined interview room');
        console.log(`Socket ${socket.id} (${role}) joined room interview-${interviewId} with peer ID ${peerId}`);

        // Store participant info for reconnection handling
        if (!socket.interviewParticipants) {
            socket.interviewParticipants = new Map();
        }
        socket.interviewParticipants.set(socket.id, { peerId, role, interviewId });

        // Notify other participant that someone joined
        socket.to(`interview-${interviewId}`).emit('interview:peer-joined', {
            peerId,
            role,
            socketId: socket.id
        });

        // Send current participants to the newly joined user
        const roomSockets = io.sockets.adapter.rooms.get(`interview-${interviewId}`);
        console.log(`Current sockets in room interview-${interviewId}:`, roomSockets ? Array.from(roomSockets) : 'No sockets');

        if (roomSockets) {
            const participants = [];
            roomSockets.forEach(socketId => {
                const participantSocket = io.sockets.sockets.get(socketId);
                if (participantSocket && participantSocket.id !== socket.id) {
                    participants.push({
                        peerId: participantSocket.peerId,
                        role: participantSocket.interviewRole,
                        socketId: participantSocket.id
                    });
                }
            });

            if (participants.length > 0) {
                socket.emit('interview:existing-participants', { participants });
            }
        }
    });

    // Signal peer ID to other participant
    socket.on('interview:signal-peer', (data) => {
        const { interviewId, peerId } = data;

        logger.info({ interviewId, peerId, role: socket.interviewRole }, 'Signaling peer ID');

        // Broadcast to other participants in the interview room
        socket.to(`interview-${interviewId}`).emit('interview:peer-available', {
            peerId,
            role: socket.interviewRole,
            socketId: socket.id
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

                // Notify student in interview room (if they're already there)
                console.log(`Sending call-started event to interview room: interview-${interviewId}`);
                const roomSockets = io.sockets.adapter.rooms.get(`interview-${interviewId}`);
                console.log(`Sockets in room interview-${interviewId}:`, roomSockets ? Array.from(roomSockets) : 'No sockets');

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

                // Confirm to admin that call was initiated
                socket.emit('interview:call-initiated', {
                    success: true,
                    interviewId,
                    timestamp: new Date().toISOString()
                });
            }
        } catch (error) {
            logger.error({ error, interviewId, studentId }, 'Error sending call notification');
            socket.emit('interview:call-failed', {
                success: false,
                error: error.message,
                interviewId
            });
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

    // Get room status - who's currently in the room
    socket.on('interview:get-room-status', (data) => {
        const { interviewId } = data;

        console.log(`Getting room status for interview-${interviewId}`);

        const roomSockets = io.sockets.adapter.rooms.get(`interview-${interviewId}`);
        const participants = [];

        if (roomSockets) {
            roomSockets.forEach(socketId => {
                const participantSocket = io.sockets.sockets.get(socketId);
                if (participantSocket && participantSocket.id !== socket.id && participantSocket.interviewRole) {
                    participants.push({
                        peerId: participantSocket.peerId,
                        role: participantSocket.interviewRole,
                        socketId: participantSocket.id
                    });
                }
            });
        }

        console.log(`Room status for interview-${interviewId}:`, participants);

        socket.emit('interview:room-status', {
            interviewId,
            participants
        });
    });

    // Student joined interview room - notify admin
    socket.on('interview:student-joined-room', (data) => {
        const { interviewId, peerId, studentId } = data;

        logger.info({ interviewId, peerId, studentId }, 'Student joined interview room');

        // Notify admin in the interview room
        socket.to(`interview-${interviewId}`).emit('interview:student-joined-room', {
            peerId,
            studentId,
            timestamp: new Date().toISOString()
        });
    });

    // Handle WebRTC signaling
    socket.on('interview:webrtc-signal', (data) => {
        const { interviewId, targetSocketId, signal, type } = data;

        logger.info({
            interviewId,
            targetSocketId,
            type,
            from: socket.interviewRole
        }, 'WebRTC signal received');

        // Forward signal to specific target socket
        if (targetSocketId) {
            socket.to(targetSocketId).emit('interview:webrtc-signal', {
                signal,
                type,
                fromSocketId: socket.id,
                fromRole: socket.interviewRole
            });
        } else {
            // Broadcast to all other participants in room
            socket.to(`interview-${interviewId}`).emit('interview:webrtc-signal', {
                signal,
                type,
                fromSocketId: socket.id,
                fromRole: socket.interviewRole
            });
        }
    });

    // Chat message in interview room
    socket.on('interview:send-chat', async (data) => {
        const { interviewId, sender, senderName, text, timestamp } = data;

        logger.info({
            interviewId,
            sender,
            senderName,
            text: text.substring(0, 50),
            socketId: socket.id,
            room: `interview-${interviewId}`
        }, 'Chat message received, broadcasting to room');

        try {
            // Store chat message in database for persistence
            await pool.query(
                `INSERT INTO interview_chat_messages (interview_id, sender_type, sender_name, message, created_at)
                 VALUES ($1, $2, $3, $4, $5)`,
                [interviewId, sender, senderName, text, timestamp]
            );

            // Broadcast to other participant in the interview room
            socket.to(`interview-${interviewId}`).emit('interview:chat-message', {
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

            logger.info({ interviewId }, 'Chat message stored and broadcasted');
        } catch (error) {
            logger.error({ error, interviewId }, 'Error storing chat message');
            socket.emit('interview:chat-sent', {
                success: false,
                error: error.message,
                timestamp
            });
        }
    });

    // Get chat history for interview room
    socket.on('interview:get-chat-history', async (data) => {
        const { interviewId } = data;

        try {
            const result = await pool.query(
                `SELECT sender_type, sender_name, message, created_at
                 FROM interview_chat_messages
                 WHERE interview_id = $1
                 ORDER BY created_at ASC`,
                [interviewId]
            );

            socket.emit('interview:chat-history', {
                success: true,
                messages: result.rows
            });
        } catch (error) {
            logger.error({ error, interviewId }, 'Error fetching chat history');
            socket.emit('interview:chat-history', {
                success: false,
                error: error.message,
                messages: []
            });
        }
    });

    // Connection status updates
    socket.on('interview:connection-status', (data) => {
        const { interviewId, status, quality } = data;

        // Broadcast connection status to other participants
        socket.to(`interview-${interviewId}`).emit('interview:peer-connection-status', {
            peerId: socket.peerId,
            role: socket.interviewRole,
            status,
            quality,
            timestamp: new Date().toISOString()
        });
    });

    // Leave interview room
    socket.on('interview:leave', (data) => {
        const { interviewId } = data;

        logger.info({ interviewId, role: socket.interviewRole }, 'User left interview room');

        // Notify other participant
        socket.to(`interview-${interviewId}`).emit('interview:peer-left', {
            role: socket.interviewRole,
            peerId: socket.peerId,
            socketId: socket.id
        });

        socket.leave(`interview-${interviewId}`);

        // Clear interview-related data
        socket.interviewId = null;
        socket.interviewRole = null;
        socket.peerId = null;
    });

    // Reconnection handling
    socket.on('interview:reconnect', async (data) => {
        const { interviewId, peerId, role } = data;

        logger.info({ interviewId, peerId, role }, 'User reconnecting to interview');

        // Rejoin the room
        socket.join(`interview-${interviewId}`);
        socket.interviewId = interviewId;
        socket.interviewRole = role;
        socket.peerId = peerId;

        // Notify other participants about reconnection
        socket.to(`interview-${interviewId}`).emit('interview:peer-reconnected', {
            peerId,
            role,
            socketId: socket.id
        });

        // Send current participants to the reconnected user
        const roomSockets = io.sockets.adapter.rooms.get(`interview-${interviewId}`);
        if (roomSockets) {
            const participants = [];
            roomSockets.forEach(socketId => {
                const participantSocket = io.sockets.sockets.get(socketId);
                if (participantSocket && participantSocket.id !== socket.id) {
                    participants.push({
                        peerId: participantSocket.peerId,
                        role: participantSocket.interviewRole,
                        socketId: participantSocket.id
                    });
                }
            });

            socket.emit('interview:existing-participants', { participants });
        }

        // Send chat history
        try {
            const result = await pool.query(
                `SELECT sender_type, sender_name, message, created_at
                 FROM interview_chat_messages
                 WHERE interview_id = $1
                 ORDER BY created_at ASC`,
                [interviewId]
            );

            socket.emit('interview:chat-history', {
                success: true,
                messages: result.rows
            });
        } catch (error) {
            logger.error({ error, interviewId }, 'Error fetching chat history on reconnect');
        }
    });

    // ===== SIMPLE-PEER HANDLERS =====

    // Join interview room (simple-peer version)
    socket.on('join-interview', (data) => {
        const { interviewId, role, userId } = data;

        logger.info({
            socketId: socket.id,
            interviewId,
            role,
            userId
        }, 'User joining interview room (simple-peer)');

        socket.join(`interview-${interviewId}`);
        socket.interviewId = interviewId;
        socket.interviewRole = role;
        socket.userId = userId;

        // Notify other participants
        socket.to(`interview-${interviewId}`).emit('user-joined', {
            socketId: socket.id,
            role,
            userId
        });

        logger.info({
            socketId: socket.id,
            interviewId,
            role
        }, 'User successfully joined interview room (simple-peer)');
    });

    // Handle WebRTC signaling for simple-peer
    socket.on('webrtc-signal', (data) => {
        const { interviewId, signal, role } = data;

        logger.info({
            interviewId,
            signalType: signal.type,
            from: role,
            socketId: socket.id
        }, 'WebRTC signal received (simple-peer)');

        // Forward signal to other participants in the interview room
        socket.to(`interview-${interviewId}`).emit('webrtc-signal', {
            signal,
            role,
            fromSocketId: socket.id
        });
    });

    // Handle call initiation
    socket.on('initiate-call', (data) => {
        const { interviewId, role } = data;

        logger.info({
            interviewId,
            role,
            socketId: socket.id
        }, 'Call initiated (simple-peer)');

        // Notify other participants
        socket.to(`interview-${interviewId}`).emit('call-initiated', {
            role,
            fromSocketId: socket.id
        });
    });

    // Handle chat messages (simple-peer version)
    socket.on('send-chat', async (data) => {
        const { interviewId, role, message, timestamp } = data;

        logger.info({
            interviewId,
            role,
            messageLength: message.length,
            socketId: socket.id
        }, 'Chat message received (simple-peer)');

        try {
            // Store message in database
            const query = `
                INSERT INTO interview_chat_messages (interview_id, sender_type, sender_name, message, created_at)
                VALUES ($1, $2, $3, $4, $5)
                RETURNING *
            `;

            const senderName = role === 'admin' ? 'Interviewer' : 'Student';
            const result = await pool.query(query, [
                interviewId,
                role,
                senderName,
                message,
                timestamp || new Date().toISOString()
            ]);

            const savedMessage = result.rows[0];

            // Broadcast to all participants in the interview room
            io.to(`interview-${interviewId}`).emit('chat-message', {
                id: savedMessage.id,
                role: savedMessage.sender_type,
                senderName: savedMessage.sender_name,
                message: savedMessage.message,
                timestamp: savedMessage.created_at
            });

        } catch (error) {
            logger.error({
                error: error.message,
                interviewId,
                socketId: socket.id
            }, 'Failed to save chat message (simple-peer)');

            socket.emit('chat-error', {
                error: 'Failed to send message'
            });
        }
    });

    // Get chat history (simple-peer version)
    socket.on('get-chat-history', async (data) => {
        const { interviewId } = data;

        try {
            const query = `
                SELECT * FROM interview_chat_messages 
                WHERE interview_id = $1 
                ORDER BY created_at ASC
            `;

            const result = await pool.query(query, [interviewId]);

            socket.emit('chat-history', {
                messages: result.rows.map(row => ({
                    id: row.id,
                    role: row.sender_type,
                    senderName: row.sender_name,
                    message: row.message,
                    timestamp: row.created_at
                }))
            });

        } catch (error) {
            logger.error({
                error: error.message,
                interviewId,
                socketId: socket.id
            }, 'Failed to fetch chat history (simple-peer)');

            socket.emit('chat-history', { messages: [] });
        }
    });

    // Handle interview end (simple-peer version)
    socket.on('end-interview', (data) => {
        const { interviewId } = data;

        logger.info({
            interviewId,
            socketId: socket.id,
            role: socket.interviewRole
        }, 'Interview ended (simple-peer)');

        // Notify other participants
        socket.to(`interview-${interviewId}`).emit('interview-ended', {
            endedBy: socket.interviewRole
        });
    });

    // Handle leaving interview (simple-peer version)
    socket.on('leave-interview', (data) => {
        const { interviewId, role } = data;

        logger.info({
            interviewId,
            role,
            socketId: socket.id
        }, 'User leaving interview (simple-peer)');

        socket.leave(`interview-${interviewId}`);

        // Notify other participants
        socket.to(`interview-${interviewId}`).emit('user-left', {
            role,
            socketId: socket.id
        });
    });

    // ===== END SIMPLE-PEER HANDLERS =====

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

        // Clean up support socket if present
        if (socket.rollNumber) {
            studentSupportSockets.delete(socket.rollNumber);
            logger.debug({ rollNumber: socket.rollNumber }, 'Cleaned up support socket');
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




