-- Fix test_attempts unique constraint for ON CONFLICT support
-- This migration ensures the proper unique constraint exists

-- Drop old constraint if it exists
ALTER TABLE test_attempts DROP CONSTRAINT IF EXISTS test_attempts_student_id_test_id_key;

-- Add the correct unique constraint that includes job_application_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'test_attempts_student_test_application_unique'
    ) THEN
        ALTER TABLE test_attempts ADD CONSTRAINT test_attempts_student_test_application_unique 
            UNIQUE (student_id, test_id, job_application_id);
    END IF;
END $$;

-- Create index for faster lookups if not exists
CREATE INDEX IF NOT EXISTS idx_test_attempts_student ON test_attempts(student_id);
CREATE INDEX IF NOT EXISTS idx_test_attempts_test ON test_attempts(test_id);
CREATE INDEX IF NOT EXISTS idx_test_attempts_job_application ON test_attempts(job_application_id);
CREATE INDEX IF NOT EXISTS idx_test_attempts_student_test ON test_attempts(student_id, test_id);
