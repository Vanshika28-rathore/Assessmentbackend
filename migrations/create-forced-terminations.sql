-- Create forced_terminations table for tracking admin-initiated test stops
-- This table logs all instances where an admin manually stops a student's test due to cheating

CREATE TABLE IF NOT EXISTS forced_terminations (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(255) NOT NULL,
    test_id INTEGER NOT NULL,
    admin_id VARCHAR(255) NOT NULL,
    admin_name VARCHAR(255),
    reason TEXT NOT NULL,
    violation_summary TEXT,
    termination_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    student_notified BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_forced_terminations_student_id ON forced_terminations(student_id);
CREATE INDEX IF NOT EXISTS idx_forced_terminations_test_id ON forced_terminations(test_id);
CREATE INDEX IF NOT EXISTS idx_forced_terminations_admin_id ON forced_terminations(admin_id);
CREATE INDEX IF NOT EXISTS idx_forced_terminations_timestamp ON forced_terminations(termination_timestamp);

-- Add comments for documentation
COMMENT ON TABLE forced_terminations IS 'Logs all admin-initiated test terminations due to suspected cheating';
COMMENT ON COLUMN forced_terminations.student_id IS 'ID of the student whose test was stopped';
COMMENT ON COLUMN forced_terminations.test_id IS 'ID of the test that was terminated';
COMMENT ON COLUMN forced_terminations.admin_id IS 'ID of the admin who stopped the test';
COMMENT ON COLUMN forced_terminations.reason IS 'Admin-provided reason for stopping the test';
COMMENT ON COLUMN forced_terminations.violation_summary IS 'Summary of violations at time of termination';
COMMENT ON COLUMN forced_terminations.student_notified IS 'Whether the student received the termination notification';

-- Add columns to results table to track forced terminations
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='results' AND column_name='termination_reason') THEN
        ALTER TABLE results ADD COLUMN termination_reason VARCHAR(50);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='results' AND column_name='terminated_by') THEN
        ALTER TABLE results ADD COLUMN terminated_by VARCHAR(255);
    END IF;
    
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name='results' AND column_name='is_forced_termination') THEN
        ALTER TABLE results ADD COLUMN is_forced_termination BOOLEAN DEFAULT FALSE;
    END IF;
END $$;

-- Create index on termination reason
CREATE INDEX IF NOT EXISTS idx_results_termination_reason ON results(termination_reason) WHERE termination_reason IS NOT NULL;