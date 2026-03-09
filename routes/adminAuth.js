const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { query } = require('../config/db');
const verifyAdmin = require('../middleware/verifyAdmin');

// Load env vars if not already loaded (though server.js usually does)
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET || 'fallback_secret_key';

/**
 * POST /api/admin/login
 * Authenticate admin and return JWT
 */
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        console.log('[ADMIN LOGIN] Attempt:', { email, passwordLength: password?.length });

        if (!email || !password) {
            console.log('[ADMIN LOGIN] Missing credentials');
            return res.status(400).json({
                success: false,
                message: 'Email and password are required',
            });
        }

        // 1. Check if admin exists
        const result = await query(
            'SELECT * FROM admins WHERE email = $1',
            [email]
        );

        console.log('[ADMIN LOGIN] Query result:', { found: result.rows.length > 0, email });

        if (result.rows.length === 0) {
            console.log('[ADMIN LOGIN] Admin not found');
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
            });
        }

        const admin = result.rows[0];
        console.log('[ADMIN LOGIN] Admin found:', { id: admin.id, email: admin.email, hashPreview: admin.password_hash?.substring(0, 20) });

        // 2. Validate password
        const isMatch = await bcrypt.compare(password, admin.password_hash);
        console.log('[ADMIN LOGIN] Password match:', isMatch);
        
        if (!isMatch) {
            console.log('[ADMIN LOGIN] Password mismatch');
            return res.status(401).json({
                success: false,
                message: 'Invalid credentials',
            });
        }

        // 3. Generate JWT with type: 'session'
        const token = jwt.sign(
            { id: admin.id, email: admin.email, role: 'admin', type: 'session' },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        console.log('[ADMIN LOGIN] Success:', { email: admin.email });

        return res.json({
            success: true,
            message: 'Login successful',
            token,
            admin: {
                id: admin.id,
                email: admin.email,
                full_name: admin.full_name,
            },
        });

    } catch (error) {
        console.error('[ADMIN LOGIN] Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message,
        });
    }
});

/**
 * POST /api/admin/register
 * Create a new admin (Protected route)
 */
router.post('/register', verifyAdmin, async (req, res) => {
    try {
        const { email, password, full_name } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: 'Email and password are required',
            });
        }

        // Check availability
        const check = await query('SELECT * FROM admins WHERE email = $1', [email]);
        if (check.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Email already exists',
            });
        }

        // Hash password
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        // Insert
        const result = await query(
            'INSERT INTO admins (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name, created_at',
            [email, hash, full_name || null]
        );

        return res.status(201).json({
            success: true,
            message: 'Admin created successfully',
            admin: result.rows[0],
        });

    } catch (error) {
        console.error('Admin register error:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
});

/**
 * GET /api/admin/me
 * Verify token and return admin info
 */
router.get('/me', verifyAdmin, (req, res) => {
    res.json({
        success: true,
        admin: req.admin,
    });
});

/**
 * PUT /api/admin/profile
 * Update admin profile information
 */
router.put('/profile', verifyAdmin, async (req, res) => {
    try {
        const { email, full_name, phone, address } = req.body;
        const adminId = req.admin.id;

        if (!email) {
            return res.status(400).json({
                success: false,
                message: 'Email is required',
            });
        }

        // Check if email is already taken by another admin
        const emailCheck = await query(
            'SELECT id FROM admins WHERE email = $1 AND id != $2',
            [email, adminId]
        );

        if (emailCheck.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: 'Email is already taken by another admin',
            });
        }

        // Update admin profile
        const result = await query(
            'UPDATE admins SET email = $1, full_name = $2, phone = $3, address = $4, updated_at = CURRENT_TIMESTAMP WHERE id = $5 RETURNING id, email, full_name, phone, address, updated_at',
            [email, full_name || null, phone || null, address || null, adminId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Admin not found',
            });
        }

        console.log('[ADMIN PROFILE UPDATE] Success:', { adminId, email });

        return res.json({
            success: true,
            message: 'Profile updated successfully',
            admin: result.rows[0],
        });

    } catch (error) {
        console.error('[ADMIN PROFILE UPDATE] Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message,
        });
    }
});

/**
 * PUT /api/admin/change-password
 * Change admin password
 */
router.put('/change-password', verifyAdmin, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        const adminId = req.admin.id;

        if (!currentPassword || !newPassword) {
            return res.status(400).json({
                success: false,
                message: 'Current password and new password are required',
            });
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: 'New password must be at least 6 characters long',
            });
        }

        // Get current admin data
        const adminResult = await query(
            'SELECT password_hash FROM admins WHERE id = $1',
            [adminId]
        );

        if (adminResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Admin not found',
            });
        }

        const admin = adminResult.rows[0];

        // Verify current password
        const isCurrentPasswordValid = await bcrypt.compare(currentPassword, admin.password_hash);
        if (!isCurrentPasswordValid) {
            return res.status(401).json({
                success: false,
                message: 'Current password is incorrect',
            });
        }

        // Hash new password
        const salt = await bcrypt.genSalt(10);
        const newPasswordHash = await bcrypt.hash(newPassword, salt);

        // Update password
        await query(
            'UPDATE admins SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2',
            [newPasswordHash, adminId]
        );

        console.log('[ADMIN PASSWORD CHANGE] Success:', { adminId });

        return res.json({
            success: true,
            message: 'Password changed successfully',
        });

    } catch (error) {
        console.error('[ADMIN PASSWORD CHANGE] Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Internal server error',
        });
    }
});

module.exports = router;
