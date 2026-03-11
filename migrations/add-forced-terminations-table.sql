-- Migration: Add forced_terminations table for admin force-stop functionality
-- Created: 2024-03-11

CREATE TABLE IF NOT EXISTS forced_terminations (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(255) NOT NULL,
    test_id INTEGER NOT NULL,
    admin_id VARCHAR(255) NOT NULL,
    admin_name VARCHAR(255) NOT NULL,
    reason TEXT NOT NULL,
    violation_summary TEXT,
    student_notified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_forced_terminations_student_id ON forced_terminations(student_id);
CREATE INDEX IF NOT EXISTS idx_forced_terminations_test_id ON forced_terminations(test_id);
CREATE INDEX IF NOT EXISTS idx_forced_terminations_admin_id ON forced_terminations(admin_id);
CREATE INDEX IF NOT EXISTS idx_forced_terminations_created_at ON forced_terminations(created_at);

-- Add foreign key constraints if the referenced tables exist
-- Note: Uncomment these if you want strict referential integrity
-- ALTER TABLE forced_terminations 
-- ADD CONSTRAINT fk_forced_terminations_test_id 
-- FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE;

COMMENT ON TABLE forced_terminations IS 'Records of tests that were forcibly terminated by administrators';
COMMENT ON COLUMN forced_terminations.student_id IS 'ID of the student whose test was terminated';
COMMENT ON COLUMN forced_terminations.test_id IS 'ID of the test that was terminated';
COMMENT ON COLUMN forced_terminations.admin_id IS 'ID of the admin who terminated the test';
COMMENT ON COLUMN forced_terminations.admin_name IS 'Name of the admin who terminated the test';
COMMENT ON COLUMN forced_terminations.reason IS 'Reason provided by admin for termination';
COMMENT ON COLUMN forced_terminations.violation_summary IS 'Summary of violations that led to termination';
COMMENT ON COLUMN forced_terminations.student_notified IS 'Whether the student was successfully notified of termination';