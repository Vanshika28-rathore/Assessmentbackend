-- Create OTPs table for email verification
CREATE TABLE IF NOT EXISTS otps (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) NOT NULL,
    otp_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMP NOT NULL,
    attempts INTEGER DEFAULT 0,
    is_used BOOLEAN DEFAULT false,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email);
CREATE INDEX IF NOT EXISTS idx_otps_expires_at ON otps(expires_at);
CREATE INDEX IF NOT EXISTS idx_otps_created_at ON otps(created_at);

-- Add comments
COMMENT ON TABLE otps IS 'Stores OTPs for email verification during registration';
COMMENT ON COLUMN otps.email IS 'User email address (normalized to lowercase)';
COMMENT ON COLUMN otps.otp_hash IS 'Hashed OTP for security';
COMMENT ON COLUMN otps.expires_at IS 'OTP expiration timestamp (5 minutes from creation)';
COMMENT ON COLUMN otps.attempts IS 'Number of verification attempts (max 3)';
COMMENT ON COLUMN otps.is_used IS 'Whether the OTP has been used successfully';