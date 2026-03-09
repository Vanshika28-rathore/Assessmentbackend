const express = require('express');
const router = express.Router();
const db = require('../config/db');
const jwt = require('jsonwebtoken');
const firebaseAdmin = require('../config/firebase');
const verifyAdmin = require('../middleware/verifyAdmin');
const verifyToken = require('../middleware/verifyToken');

// Accept either admin JWT or student JWT session token
const verifyAnyUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: 'Unauthorized: No token provided' });
  }

  const token = authHeader.split('Bearer ')[1];
  if (!token) {
    return res.status(401).json({ success: false, message: 'Unauthorized: Invalid token format' });
  }

  // Try JWT verification (works for both admin and student session tokens)
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key');
    
    if (decoded.role === 'admin') {
      req.admin = decoded;
      req.authType = 'admin';
    } else if (decoded.role === 'student') {
      req.user = decoded;
      req.firebaseUid = decoded.firebase_uid;
      req.userId = decoded.id;
      req.authType = 'student';
    }
    
    return next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Unauthorized: Invalid or expired session',
      error: error.message
    });
  }
};

const resolveStudentDbIdFromFirebase = async (req) => {
  const firebaseUid = req.firebaseUid || req.user?.uid;
  const email = req.user?.email || null;

  if (!firebaseUid && !email) return null;

  const result = await db.pool.query(
    `SELECT id
     FROM students
     WHERE ($1::text IS NOT NULL AND firebase_uid = $1)
        OR ($2::text IS NOT NULL AND email = $2)
     LIMIT 1`,
    [firebaseUid || null, email]
  );

  return result.rows[0]?.id ?? null;
};

// Schedule interview (Admin only)
router.post('/schedule', verifyAdmin, async (req, res) => {
  console.log('=== SCHEDULE INTERVIEW ROUTE HIT ===');
  console.log('Request body:', req.body);
  console.log('Admin:', req.admin);
  
  try {
    const { student_id, test_id, scheduled_time, duration } = req.body;

    if (!student_id || !test_id || !scheduled_time) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: student_id, test_id, scheduled_time'
      });
    }

    // Verify student exists.
    // Accept either the internal DB student id OR (fallback) roll number.
    let resolvedStudentId = null;

    const byId = await db.pool.query('SELECT id FROM students WHERE id = $1', [student_id]);
    if (byId.rows.length > 0) {
      resolvedStudentId = byId.rows[0].id;
    } else {
      const byRoll = await db.pool.query('SELECT id FROM students WHERE roll_number = $1', [String(student_id)]);
      if (byRoll.rows.length > 0) {
        resolvedStudentId = byRoll.rows[0].id;
      }
    }

    if (!resolvedStudentId) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const result = await db.pool.query(
      'INSERT INTO interviews (student_id, test_id, scheduled_time, duration) VALUES ($1, $2, $3, $4) RETURNING id',
      [resolvedStudentId, test_id, scheduled_time, duration || 60]
    );

    return res.json({ success: true, interview_id: result.rows[0].id });
  } catch (error) {
    console.error('Schedule interview error:', error);
    return res.status(500).json({ success: false, message: 'Failed to schedule interview', error: error.message });
  }
});

// Get all interviews (Admin)
router.get('/list', verifyAdmin, async (req, res) => {
  try {
    const { status, date } = req.query;
    
    let query = `
      SELECT i.*, s.full_name as student_name, s.email as student_email, 
             s.institute as institute_name, t.title as test_title
      FROM interviews i
      JOIN students s ON i.student_id = s.id
      JOIN tests t ON i.test_id = t.id
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;

    if (status) {
      query += ` AND i.status = $${paramIndex}`;
      params.push(status);
      paramIndex++;
    }

    if (date) {
      query += ` AND DATE(i.scheduled_time) = $${paramIndex}`;
      params.push(date);
      paramIndex++;
    }

    query += ' ORDER BY i.scheduled_time ASC';

    const result = await db.pool.query(query, params);
    res.json({ success: true, interviews: result.rows });
  } catch (error) {
    console.error('Get interviews error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch interviews' });
  }
});

// Get student's interviews
router.get('/my-interviews', verifyAnyUser, async (req, res) => {
  try {
    if (req.authType !== 'student') {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    const student_id = await resolveStudentDbIdFromFirebase(req);
    if (!student_id) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const result = await db.pool.query(
      `SELECT i.*, t.title as test_title, s.institute as institute_name
       FROM interviews i
       JOIN tests t ON i.test_id = t.id
       JOIN students s ON i.student_id = s.id
       WHERE i.student_id = $1
       ORDER BY i.scheduled_time DESC`,
      [student_id]
    );

    res.json({ 
      success: true, 
      interviews: result.rows,
      student_id: student_id // Include student_id for socket room joining
    });
  } catch (error) {
    console.error('Get my interviews error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch interviews' });
  }
});

// Join interview (Update peer ID - student only)
router.post('/:id/join', verifyAnyUser, async (req, res) => {
  try {
    const { id } = req.params;
    const { peer_id } = req.body;

    if (req.authType !== 'student') {
      return res.status(403).json({ success: false, message: 'Only students can register peer ID' });
    }

    const studentId = await resolveStudentDbIdFromFirebase(req);
    if (!studentId) {
      return res.status(404).json({ success: false, message: 'Student not found' });
    }

    const allowed = await db.pool.query('SELECT id FROM interviews WHERE id = $1 AND student_id = $2', [id, studentId]);
    if (allowed.rows.length === 0) {
      return res.status(403).json({ success: false, message: 'Forbidden' });
    }

    await db.pool.query(
      'UPDATE interviews SET peer_id = $1 WHERE id = $2',
      [peer_id, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Join interview error:', error);
    res.status(500).json({ success: false, message: 'Failed to join interview' });
  }
});

// Start call (Admin only) - marks interview as in progress
router.post('/:id/start', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    await db.pool.query(
      `UPDATE interviews
       SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND status = 'scheduled'`,
      [id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Start interview error:', error);
    res.status(500).json({ success: false, message: 'Failed to start interview' });
  }
});

// End interview and save feedback (Admin)
router.post('/:id/end', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { admin_notes, technical_score, communication_score, recommendation } = req.body;

    await db.pool.query(
      `UPDATE interviews 
       SET status = 'completed', admin_notes = $1, technical_score = $2, 
           communication_score = $3, recommendation = $4
       WHERE id = $5`,
      [admin_notes, technical_score, communication_score, recommendation, id]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('End interview error:', error);
    res.status(500).json({ success: false, message: 'Failed to end interview' });
  }
});

// Get interview details
router.get('/:id', verifyAnyUser, async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.pool.query(
      `SELECT i.*, s.full_name as student_name, s.email as student_email,
              s.institute as institute_name, t.title as test_title
       FROM interviews i
       JOIN students s ON i.student_id = s.id
       JOIN tests t ON i.test_id = t.id
       WHERE i.id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Interview not found' });
    }

    // Students can only view their own interview
    if (req.authType === 'student') {
      const studentId = await resolveStudentDbIdFromFirebase(req);
      if (!studentId) {
        return res.status(404).json({ success: false, message: 'Student not found' });
      }
      if (String(result.rows[0].student_id) !== String(studentId)) {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }

      // Students can only enter after scheduled time
      if (
        result.rows[0].status === 'scheduled' &&
        result.rows[0].scheduled_time &&
        new Date(result.rows[0].scheduled_time).getTime() > Date.now()
      ) {
        return res.status(403).json({
          success: false,
          message: 'Interview not started yet. Please join at the scheduled time.'
        });
      }
    }

    res.json({ success: true, interview: result.rows[0] });
  } catch (error) {
    console.error('Get interview error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch interview' });
  }
});

module.exports = router;
