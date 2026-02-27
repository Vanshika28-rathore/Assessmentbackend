const { Resend } = require('resend');

// Initialize Resend with API key from environment
const resend = new Resend(process.env.RESEND_API_KEY);

/**
 * Email Service for sending OTP emails using Resend
 */
class EmailService {
    /**
     * Send OTP email to user
     * @param {string} recipientEmail - User's email address
     * @param {string} otp - The 6-digit OTP code
     * @param {string} recipientName - User's full name (optional)
     * @returns {Object} - { success: boolean, message: string, data?: any }
     */
    async sendOTPEmail(recipientEmail, otp, recipientName = 'Student') {
        try {
            const emailContent = this.generateOTPEmailHTML(otp, recipientName);
            
            console.log('[EmailService] Attempting to send OTP email to:', recipientEmail);
            
            const response = await resend.emails.send({
                from: process.env.RESEND_FROM_EMAIL || 'SHNOOR Assessment <LMS-SHNOOR@lms.shnoor.com>',
                to: recipientEmail,
                subject: 'Email Verification - Your OTP Code',
                html: emailContent,
            });

            console.log('[EmailService] Resend API Response:', JSON.stringify(response, null, 2));
            
            // Check if Resend returned an error
            if (response.error) {
                console.error('[EmailService] Resend API returned error:', response.error);
                throw new Error(response.error.message || 'Failed to send email');
            }
            
            // Check if we got a valid response with data
            if (!response.data && !response.id) {
                throw new Error('No response data from Resend API');
            }
            
            console.log('[EmailService] OTP Email sent successfully:', {
                email: recipientEmail,
                messageId: response.id || response.data?.id,
            });

            return {
                success: true,
                message: 'OTP email sent successfully',
                data: response,
            };
        } catch (error) {
            console.error('[EmailService] Error sending OTP email:', error);
            console.error('[EmailService] Error details:', {
                message: error.message,
                stack: error.stack,
            });
            
            return {
                success: false,
                message: error.message || 'Failed to send OTP email',
                error: error.message,
            };
        }
    }

    /**
     * Generate HTML content for OTP email
     */
    generateOTPEmailHTML(otp, recipientName) {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Email Verification</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; background-color: #f8fafc; color: #1e293b;">
    <div style="max-width: 600px; margin: 40px auto; background-color: #ffffff; border-radius: 8px; box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1); overflow: hidden;">
        <!-- Header -->
        <div style="background: linear-gradient(135deg, #1e293b 0%, #334155 100%); padding: 30px 20px; text-align: center;">
            <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 600; letter-spacing: -0.5px;">
                SHNOOR International
            </h1>
            <p style="margin: 8px 0 0 0; color: #cbd5e1; font-size: 12px; text-transform: uppercase; letter-spacing: 2px; font-weight: 500;">
                Assessment Platform
            </p>
        </div>

        <!-- Content -->
        <div style="padding: 40px 30px;">
            <h2 style="margin: 0 0 16px 0; color: #1e293b; font-size: 22px; font-weight: 600;">
                Email Verification Required
            </h2>
            
            <p style="margin: 0 0 24px 0; color: #64748b; font-size: 15px; line-height: 1.6;">
                Hello <strong style="color: #1e293b;">${recipientName}</strong>,
            </p>
            
            <p style="margin: 0 0 24px 0; color: #64748b; font-size: 15px; line-height: 1.6;">
                Thank you for registering with SHNOOR Assessment Platform. To complete your registration, please verify your email address using the One-Time Password (OTP) below:
            </p>

            <!-- OTP Box -->
            <div style="background-color: #f1f5f9; border: 2px solid #e2e8f0; border-radius: 8px; padding: 24px; text-align: center; margin: 32px 0;">
                <div style="color: #64748b; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; font-weight: 600; margin-bottom: 12px;">
                    Your Verification Code
                </div>
                <div style="font-size: 36px; font-weight: 700; color: #1e293b; letter-spacing: 8px; font-family: 'Courier New', monospace;">
                    ${otp}
                </div>
                <div style="color: #94a3b8; font-size: 13px; margin-top: 12px;">
                    Valid for 5 minutes
                </div>
            </div>

            <div style="background-color: #fef3c7; border-left: 4px solid #f59e0b; padding: 16px; border-radius: 4px; margin: 24px 0;">
                <p style="margin: 0; color: #92400e; font-size: 14px; line-height: 1.6;">
                    <strong>⚠️ Security Notice:</strong> Never share this OTP with anyone. SHNOOR staff will never ask for your verification code.
                </p>
            </div>

            <p style="margin: 24px 0 0 0; color: #64748b; font-size: 14px; line-height: 1.6;">
                If you didn't request this verification code, please ignore this email or contact our support team if you have concerns.
            </p>
        </div>

        <!-- Footer -->
        <div style="background-color: #f8fafc; padding: 24px 30px; border-top: 1px solid #e2e8f0; text-align: center;">
            <p style="margin: 0 0 8px 0; color: #94a3b8; font-size: 13px;">
                © 2026 SHNOOR International Assessment Platform
            </p>
            <p style="margin: 0; color: #cbd5e1; font-size: 12px;">
                Secure, Proctored Examination Environment
            </p>
        </div>
    </div>

    <!-- Footer Note -->
    <div style="max-width: 600px; margin: 20px auto; text-align: center;">
        <p style="margin: 0; color: #94a3b8; font-size: 12px;">
            This is an automated email. Please do not reply to this message.
        </p>
    </div>
</body>
</html>
        `;
    }
}

// Export singleton instance
module.exports = new EmailService();