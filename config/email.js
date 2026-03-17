const { Resend } = require('resend');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

// Initialize Resend client
let resendClient = null;

function getResendClient() {
    if (!resendClient) {
        const rawApiKey = process.env.RESEND_API_KEY || '';
        const normalizedApiKey = rawApiKey.trim().replace(/^['\"]|['\"]$/g, '');

        // Check if Resend API key is configured
        if (!normalizedApiKey) {
            console.warn('⚠️  Email service not configured. Please set RESEND_API_KEY in .env file');
            return null;
        }

        if (rawApiKey !== normalizedApiKey) {
            console.warn('⚠️  RESEND_API_KEY had extra quotes/whitespace; normalized automatically');
        }

        const maskedKey = `${normalizedApiKey.slice(0, 6)}...${normalizedApiKey.slice(-4)}`;
        console.log(`ℹ️  Resend key loaded (masked=${maskedKey}, length=${normalizedApiKey.length})`);

        resendClient = new Resend(normalizedApiKey);
        console.log('✅ Resend email service configured');
    }
    return resendClient;
}

/**
 * Send student credentials via email using Resend
 * @param {string} email - Student's email address
 * @param {string} fullName - Student's full name
 * @param {string} password - Student's password
 * @param {string} institute - Student's institute
 */
async function sendCredentialsEmail(email, fullName, password, institute) {
    try {
        const resend = getResendClient();
        
        if (!resend) {
            console.warn(`⚠️  Email not sent to ${email} - Resend API not configured`);
            return {
                success: false,
                message: 'Email service not configured'
            };
        }

        const emailData = {
            from: process.env.RESEND_FROM_EMAIL || 'LMS-SHNOOR <LMS-SHNOOR@lms.shnoor.com>',
            to: [email],
            subject: 'Your Assessment Portal Login Credentials',
            html: `
                <!DOCTYPE html>
                <html>
                <head>
                    <style>
                        body {
                            font-family: Arial, sans-serif;
                            line-height: 1.6;
                            color: #333;
                        }
                        .container {
                            max-width: 600px;
                            margin: 0 auto;
                            padding: 20px;
                            background-color: #f9f9f9;
                        }
                        .header {
                            background-color: #4CAF50;
                            color: white;
                            padding: 20px;
                            text-align: center;
                            border-radius: 5px 5px 0 0;
                        }
                        .content {
                            background-color: white;
                            padding: 30px;
                            border-radius: 0 0 5px 5px;
                        }
                        .credentials {
                            background-color: #f0f0f0;
                            padding: 15px;
                            border-left: 4px solid #4CAF50;
                            margin: 20px 0;
                        }
                        .credentials strong {
                            color: #4CAF50;
                        }
                        .button {
                            display: inline-block;
                            padding: 12px 30px;
                            background-color: #4CAF50;
                            color: white;
                            text-decoration: none;
                            border-radius: 5px;
                            margin-top: 20px;
                        }
                        .footer {
                            text-align: center;
                            margin-top: 20px;
                            color: #666;
                            font-size: 12px;
                        }
                    </style>
                </head>
                <body>
                    <div class="container">
                        <div class="header">
                            <h1>Welcome to Assessment Portal</h1>
                        </div>
                        <div class="content">
                            <h2>Hello ${fullName}!</h2>
                            <p>Your account has been created successfully. Below are your login credentials for the Assessment Portal.</p>
                            
                            <div class="credentials">
                                <p><strong>Email:</strong> ${email}</p>
                                <p><strong>Password:</strong> ${password}</p>
                                <p><strong>Institute:</strong> ${institute}</p>
                            </div>
                            
                            <p><strong>Important:</strong> Please keep these credentials safe. You can change your password after logging in.</p>
                            
                            <a href="${process.env.CLIENT_URL || 'http://localhost:5173'}" class="button">Login Now</a>
                            
                            <p style="margin-top: 30px;">If you have any questions or need assistance, please contact your administrator.</p>
                        </div>
                        <div class="footer">
                            <p>This is an automated email. Please do not reply to this message.</p>
                        </div>
                    </div>
                </body>
                </html>
            `
        };

        console.log(`📧 Attempting to send email to ${email}...`);
        const result = await resend.emails.send(emailData);
        console.log(`✅ Email sent successfully to ${email}`);
        console.log(`Response:`, JSON.stringify(result, null, 2));
        
        return {
            success: true,
            messageId: result.id || result.data?.id || 'sent'
        };
    } catch (error) {
        console.error(`❌ Error sending email to ${email}:`);
        console.error(`Error details:`, error);
        console.error(`Error message:`, error.message);
        if (error.response) {
            console.error(`Response status:`, error.response.status);
            console.error(`Response data:`, error.response.data);
        }
        return {
            success: false,
            error: error.message || 'Failed to send email'
        };
    }
}

/**
 * Test email configuration
 */
async function testEmailConfig() {
    const resend = getResendClient();
    
    if (!resend) {
        return {
            success: false,
            message: 'Resend API not configured'
        };
    }

    try {
        console.log('✅ Resend email service is ready to send messages');
        return {
            success: true,
            message: 'Resend email service is ready'
        };
    } catch (error) {
        console.error('❌ Email service verification failed:', error.message);
        return {
            success: false,
            message: error.message
        };
    }
}

/**
 * Notify registered students about a new job opening
 * @param {string} email
 * @param {string} fullName
 * @param {string} companyName
 * @param {string} jobRole
 * @param {string} deadline
 */
async function sendJobOpeningEmail(email, fullName, companyName, jobRole, deadline) {
    try {
        const resend = getResendClient();
        if (!resend) {
            console.warn(`⚠️  Job opening email not sent to ${email} - Resend API not configured`);
            return { success: false, message: 'Email service not configured' };
        }

        const deadlineStr = deadline ? new Date(deadline).toLocaleString() : 'TBD';
        const portalUrl = process.env.CLIENT_URL || 'http://localhost:5173';

        const result = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'LMS-SHNOOR <LMS-SHNOOR@lms.shnoor.com>',
            to: [email],
            subject: `New Job Opening: ${jobRole} at ${companyName}`,
            html: `
                <!DOCTYPE html><html><head><style>
                body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
                .container{max-width:600px;margin:0 auto;padding:20px;background:#f9f9f9}
                .header{background:#6366f1;color:white;padding:20px;text-align:center;border-radius:5px 5px 0 0}
                .content{background:white;padding:30px;border-radius:0 0 5px 5px}
                .info{background:#f0f0f0;padding:15px;border-left:4px solid #6366f1;margin:20px 0}
                .button{display:inline-block;padding:12px 30px;background:#6366f1;color:white;text-decoration:none;border-radius:5px;margin-top:20px}
                .footer{text-align:center;margin-top:20px;color:#666;font-size:12px}
                </style></head><body>
                <div class="container">
                    <div class="header"><h1>New Job Opportunity</h1></div>
                    <div class="content">
                        <h2>Hello ${fullName}!</h2>
                        <p>A new job opening has been posted that you may be interested in.</p>
                        <div class="info">
                            <p><strong>Company:</strong> ${companyName}</p>
                            <p><strong>Role:</strong> ${jobRole}</p>
                            <p><strong>Registration Deadline:</strong> ${deadlineStr}</p>
                        </div>
                        <p>Log in to the portal to view the full details and apply before the deadline.</p>
                        <a href="${portalUrl}/job-board" class="button">View Job & Apply</a>
                    </div>
                    <div class="footer"><p>This is an automated email. Please do not reply.</p></div>
                </div>
                </body></html>`
        });

        console.log(`✅ Job opening email sent to ${email}`);
        return { success: true, messageId: result.id || result.data?.id || 'sent' };
    } catch (error) {
        console.error(`❌ Error sending job opening email to ${email}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Send application confirmation email to a student
 * @param {string} email
 * @param {string} fullName
 * @param {string} companyName
 * @param {string} jobRole
 */
async function sendApplicationConfirmationEmail(email, fullName, companyName, jobRole) {
    try {
        const resend = getResendClient();
        if (!resend) {
            console.warn(`⚠️  Confirmation email not sent to ${email} - Resend API not configured`);
            return { success: false, message: 'Email service not configured' };
        }

        const portalUrl = process.env.CLIENT_URL || 'http://localhost:5173';

        const result = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'LMS-SHNOOR <LMS-SHNOOR@lms.shnoor.com>',
            to: [email],
            subject: `Application Received – ${jobRole} at ${companyName}`,
            html: `
                <!DOCTYPE html><html><head><style>
                body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
                .container{max-width:600px;margin:0 auto;padding:20px;background:#f9f9f9}
                .header{background:#10b981;color:white;padding:20px;text-align:center;border-radius:5px 5px 0 0}
                .content{background:white;padding:30px;border-radius:0 0 5px 5px}
                .info{background:#f0f0f0;padding:15px;border-left:4px solid #10b981;margin:20px 0}
                .button{display:inline-block;padding:12px 30px;background:#10b981;color:white;text-decoration:none;border-radius:5px;margin-top:20px}
                .footer{text-align:center;margin-top:20px;color:#666;font-size:12px}
                </style></head><body>
                <div class="container">
                    <div class="header"><h1>Application Confirmation</h1></div>
                    <div class="content">
                        <h2>Hello ${fullName}!</h2>
                        <p>Your application has been received successfully.</p>
                        <div class="info">
                            <p><strong>Company:</strong> ${companyName}</p>
                            <p><strong>Role:</strong> ${jobRole}</p>
                            <p><strong>Status:</strong> Submitted</p>
                        </div>
                        <p>You can track your application status from your dashboard.</p>
                        <a href="${portalUrl}/student/my-applications" class="button">Track Application</a>
                    </div>
                    <div class="footer"><p>This is an automated email. Please do not reply.</p></div>
                </div>
                </body></html>`
        });

        console.log(`✅ Application confirmation email sent to ${email}`);
        return { success: true, messageId: result.id || result.data?.id || 'sent' };
    } catch (error) {
        console.error(`❌ Error sending confirmation email to ${email}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Notify student that assessment tests have been assigned after applying
 * @param {string} email
 * @param {string} fullName
 * @param {string} companyName
 * @param {string} jobRole
 * @param {number} testCount
 */
async function sendTestAssignmentEmail(email, fullName, companyName, jobRole, testCount) {
    try {
        const resend = getResendClient();
        if (!resend) {
            console.warn(`⚠️  Test assignment email not sent to ${email} - Resend API not configured`);
            return { success: false, message: 'Email service not configured' };
        }

        const portalUrl = process.env.CLIENT_URL || 'http://localhost:5173';

        const result = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'LMS-SHNOOR <LMS-SHNOOR@lms.shnoor.com>',
            to: [email],
            subject: `Assessment Tests Assigned – ${jobRole} at ${companyName}`,
            html: `
                <!DOCTYPE html><html><head><style>
                body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
                .container{max-width:600px;margin:0 auto;padding:20px;background:#f9f9f9}
                .header{background:#f59e0b;color:white;padding:20px;text-align:center;border-radius:5px 5px 0 0}
                .content{background:white;padding:30px;border-radius:0 0 5px 5px}
                .info{background:#fffbeb;padding:15px;border-left:4px solid #f59e0b;margin:20px 0}
                .button{display:inline-block;padding:12px 30px;background:#f59e0b;color:white;text-decoration:none;border-radius:5px;margin-top:20px}
                .footer{text-align:center;margin-top:20px;color:#666;font-size:12px}
                </style></head><body>
                <div class="container">
                    <div class="header"><h1>Assessment Tests Assigned</h1></div>
                    <div class="content">
                        <h2>Hello ${fullName}!</h2>
                        <p>You have been assigned <strong>${testCount} assessment test(s)</strong> as part of the selection process for the following position:</p>
                        <div class="info">
                            <p><strong>Company:</strong> ${companyName}</p>
                            <p><strong>Role:</strong> ${jobRole}</p>
                            <p><strong>Tests Assigned:</strong> ${testCount}</p>
                        </div>
                        <p>Please complete the assessment(s) before the deadline to be considered for the role.</p>
                        <a href="${portalUrl}/dashboard" class="button">Start Assessment</a>
                    </div>
                    <div class="footer"><p>This is an automated email. Please do not reply.</p></div>
                </div>
                </body></html>`
        });

        console.log(`✅ Test assignment email sent to ${email}`);
        return { success: true, messageId: result.id || result.data?.id || 'sent' };
    } catch (error) {
        console.error(`❌ Error sending test assignment email to ${email}:`, error.message);
        return { success: false, error: error.message };
    }
}

async function sendInterviewScheduleEmail(email, fullName, companyName, jobRole, scheduledTime, duration, testTitle) {
    try {
        const resend = getResendClient();
        if (!resend) {
            console.warn(`⚠️  Interview schedule email not sent to ${email} - Resend API not configured`);
            return { success: false, message: 'Email service not configured' };
        }

        const portalUrl = process.env.CLIENT_URL || 'http://localhost:5173';
        const interviewDateTime = scheduledTime
            ? new Date(scheduledTime).toLocaleString('en-IN', {
                year: 'numeric',
                month: 'short',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                hour12: true,
                timeZone: 'Asia/Kolkata'
            })
            : 'TBD';

        const configuredSender = process.env.RESEND_FROM_EMAIL || 'LMS-SHNOOR <LMS-SHNOOR@lms.shnoor.com>';
        const fallbackSender = 'Assessment Portal <onboarding@resend.dev>';

        let result = await resend.emails.send({
            from: configuredSender,
            to: [email],
            subject: `Shortlisted! Interview Scheduled – ${jobRole} at ${companyName}`,
            html: `
                <!DOCTYPE html><html><head><style>
                body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
                .container{max-width:600px;margin:0 auto;padding:20px;background:#f9f9f9}
                .header{background:#2563eb;color:white;padding:20px;text-align:center;border-radius:5px 5px 0 0}
                .content{background:white;padding:30px;border-radius:0 0 5px 5px}
                .info{background:#eff6ff;padding:15px;border-left:4px solid #2563eb;margin:20px 0}
                .button{display:inline-block;padding:12px 30px;background:#2563eb;color:white;text-decoration:none;border-radius:5px;margin-top:20px}
                .footer{text-align:center;margin-top:20px;color:#666;font-size:12px}
                </style></head><body>
                <div class="container">
                    <div class="header"><h1>You are Shortlisted!</h1></div>
                    <div class="content">
                        <h2>Hello ${fullName}!</h2>
                        <p>Congratulations! You have been <strong>shortlisted</strong> for the next stage of recruitment.</p>
                        <div class="info">
                            <p><strong>Company:</strong> ${companyName}</p>
                            <p><strong>Role:</strong> ${jobRole}</p>
                            <p><strong>Interview Time (IST):</strong> ${interviewDateTime}</p>
                            <p><strong>Duration:</strong> ${duration || 60} minutes</p>
                            <p><strong>Assessment/Test:</strong> ${testTitle || 'Assessment'}</p>
                        </div>
                        <p>Please be available at the scheduled time and keep your login credentials ready.</p>
                        <a href="${portalUrl}/dashboard" class="button">Open Student Dashboard</a>
                    </div>
                    <div class="footer"><p>This is an automated email. Please do not reply.</p></div>
                </div>
                </body></html>`
        });

        if (result?.error) {
            console.error(`❌ Interview email send failed with configured sender (${configuredSender}):`, result.error);

            if (configuredSender !== fallbackSender) {
                console.warn(`⚠️ Retrying interview email with fallback sender: ${fallbackSender}`);

                result = await resend.emails.send({
                    from: fallbackSender,
                    to: [email],
                    subject: `Shortlisted! Interview Scheduled – ${jobRole} at ${companyName}`,
                    html: `
                <!DOCTYPE html><html><head><style>
                body{font-family:Arial,sans-serif;line-height:1.6;color:#333}
                .container{max-width:600px;margin:0 auto;padding:20px;background:#f9f9f9}
                .header{background:#2563eb;color:white;padding:20px;text-align:center;border-radius:5px 5px 0 0}
                .content{background:white;padding:30px;border-radius:0 0 5px 5px}
                .info{background:#eff6ff;padding:15px;border-left:4px solid #2563eb;margin:20px 0}
                .button{display:inline-block;padding:12px 30px;background:#2563eb;color:white;text-decoration:none;border-radius:5px;margin-top:20px}
                .footer{text-align:center;margin-top:20px;color:#666;font-size:12px}
                </style></head><body>
                <div class="container">
                    <div class="header"><h1>You are Shortlisted!</h1></div>
                    <div class="content">
                        <h2>Hello ${fullName}!</h2>
                        <p>Congratulations! You have been <strong>shortlisted</strong> for the next stage of recruitment.</p>
                        <div class="info">
                            <p><strong>Company:</strong> ${companyName}</p>
                            <p><strong>Role:</strong> ${jobRole}</p>
                            <p><strong>Interview Time (IST):</strong> ${interviewDateTime}</p>
                            <p><strong>Duration:</strong> ${duration || 60} minutes</p>
                            <p><strong>Assessment/Test:</strong> ${testTitle || 'Assessment'}</p>
                        </div>
                        <p>Please be available at the scheduled time and keep your login credentials ready.</p>
                        <a href="${portalUrl}/dashboard" class="button">Open Student Dashboard</a>
                    </div>
                    <div class="footer"><p>This is an automated email. Please do not reply.</p></div>
                </div>
                </body></html>`
                });
            }
        }

        if (result?.error) {
            return { success: false, error: result.error.message || 'Resend API returned an error' };
        }

        console.log(`✅ Interview schedule email sent to ${email}`);
        return { success: true, messageId: result.id || result.data?.id || 'sent' };
    } catch (error) {
        console.error(`❌ Error sending interview schedule email to ${email}:`, error.message);
        return { success: false, error: error.message };
    }
}

module.exports = {
    sendCredentialsEmail,
    testEmailConfig,
    sendJobOpeningEmail,
    sendApplicationConfirmationEmail,
    sendTestAssignmentEmail,
    sendInterviewScheduleEmail
};