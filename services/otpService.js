const crypto = require('crypto');
const { query } = require('../config/db');

/**
 * OTP Service
 * Handles OTP generation, storage, and verification using PostgreSQL
 */

class OTPService {
    constructor() {
        // Configuration
        this.OTP_LENGTH = 6;
        this.OTP_EXPIRY_MS = 5 * 60 * 1000; // 5 minutes
        this.MAX_ATTEMPTS = 3;
        this.RATE_LIMIT_MS = 60 * 1000; // 1 minute between resends
    }

    /**
     * Generate a random 6-digit OTP
     */
    generateOTP() {
        return crypto.randomInt(100000, 999999).toString();
    }

    /**
     * Hash OTP with email for security
     */
    hashOTP(otp, email) {
        return crypto
            .createHash('sha256')
            .update(`${otp}:${email}`)
            .digest('hex');
    }

    /**
     * Store OTP in database
     * @param {string} email - User's email address
     * @param {string} otp - The OTP to store
     * @returns {Object} - { success: boolean, message: string, otpId?: number }
     */
    async storeOTP(email, otp) {
        const normalizedEmail = email.toLowerCase().trim();
        
        try {
            // Check rate limiting
            const existingResult = await query(
                `SELECT id, created_at FROM otps 
                 WHERE email = $1 AND created_at > NOW() - INTERVAL '1 minute'
                 ORDER BY created_at DESC LIMIT 1`,
                [normalizedEmail]
            );

            if (existingResult.rows.length > 0) {
                const timeSinceCreation = Date.now() - new Date(existingResult.rows[0].created_at).getTime();
                const remainingSeconds = Math.ceil((this.RATE_LIMIT_MS - timeSinceCreation) / 1000);
                return {
                    success: false,
                    message: `Please wait ${remainingSeconds} seconds before requesting a new OTP`,
                };
            }

            const hashedOtp = this.hashOTP(otp, normalizedEmail);
            const expiresAt = new Date(Date.now() + this.OTP_EXPIRY_MS);

            // Insert new OTP
            const result = await query(
                `INSERT INTO otps (email, otp_hash, expires_at, attempts, created_at)
                 VALUES ($1, $2, $3, 0, NOW())
                 RETURNING id`,
                [normalizedEmail, hashedOtp, expiresAt]
            );

            return { 
                success: true, 
                message: 'OTP stored successfully',
                otpId: result.rows[0].id
            };
        } catch (error) {
            console.error('[OTP Service] Error storing OTP:', error);
            return {
                success: false,
                message: 'Failed to store OTP'
            };
        }
    }

    /**
     * Verify OTP
     * @param {string} email - User's email address
     * @param {string} otp - The OTP to verify
     * @returns {Object} - { success: boolean, message: string }
     */
    async verifyOTP(email, otp) {
        const normalizedEmail = email.toLowerCase().trim();

        try {
            // Get the most recent OTP for this email
            const result = await query(
                `SELECT id, otp_hash, expires_at, attempts, is_used
                 FROM otps
                 WHERE email = $1
                 ORDER BY created_at DESC
                 LIMIT 1`,
                [normalizedEmail]
            );

            if (result.rows.length === 0) {
                return {
                    success: false,
                    message: 'OTP not found or expired. Please request a new one.',
                };
            }

            const stored = result.rows[0];

            // Check if already used
            if (stored.is_used) {
                return {
                    success: false,
                    message: 'OTP has already been used. Please request a new one.',
                };
            }

            // Check expiry
            if (new Date() > new Date(stored.expires_at)) {
                await query('DELETE FROM otps WHERE id = $1', [stored.id]);
                return {
                    success: false,
                    message: 'OTP has expired. Please request a new one.',
                };
            }

            // Check max attempts
            if (stored.attempts >= this.MAX_ATTEMPTS) {
                await query('DELETE FROM otps WHERE id = $1', [stored.id]);
                return {
                    success: false,
                    message: 'Too many failed attempts. Please request a new OTP.',
                };
            }

            // Verify OTP
            const hashedInputOtp = this.hashOTP(otp, normalizedEmail);
            
            if (hashedInputOtp !== stored.otp_hash) {
                // Increment attempts
                await query(
                    'UPDATE otps SET attempts = attempts + 1 WHERE id = $1',
                    [stored.id]
                );
                
                return {
                    success: false,
                    message: `Invalid OTP. ${this.MAX_ATTEMPTS - stored.attempts - 1} attempts remaining.`,
                };
            }

            // Success - mark as used
            await query(
                'UPDATE otps SET is_used = true WHERE id = $1',
                [stored.id]
            );
            
            return {
                success: true,
                message: 'OTP verified successfully',
            };
        } catch (error) {
            console.error('[OTP Service] Error verifying OTP:', error);
            return {
                success: false,
                message: 'Failed to verify OTP'
            };
        }
    }

    /**
     * Clear expired OTPs (cleanup function)
     */
    async clearExpiredOTPs() {
        try {
            await query('DELETE FROM otps WHERE expires_at < NOW()');
        } catch (error) {
            console.error('[OTP Service] Error clearing expired OTPs:', error);
        }
    }

    /**
     * Get remaining time for OTP
     */
    async getRemainingTime(email) {
        const normalizedEmail = email.toLowerCase().trim();
        
        try {
            const result = await query(
                `SELECT expires_at FROM otps 
                 WHERE email = $1 AND is_used = false
                 ORDER BY created_at DESC LIMIT 1`,
                [normalizedEmail]
            );
            
            if (result.rows.length === 0) {
                return 0;
            }
            
            const remaining = new Date(result.rows[0].expires_at).getTime() - Date.now();
            return Math.max(0, Math.ceil(remaining / 1000)); // Return seconds
        } catch (error) {
            console.error('[OTP Service] Error getting remaining time:', error);
            return 0;
        }
    }
}

// Export singleton instance
module.exports = new OTPService();