-- Add job_application_id to test_attempts table to track which application the test was taken for
-- This allows the same test to be taken multiple times for different job applications

ALTER TABLE test_attempts 
ADD COLUMN IF NOT EXISTS job_application_id INTEGER REFERENCES job_applications(id) ON DELETE SET NULL;

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_test_attempts_job_application ON test_attempts(job_application_id);

-- Drop the UNIQUE constraint on (student_id, test_id) since students can now take the same test for different applications
ALTER TABLE test_attempts DROP CONSTRAINT IF EXISTS test_attempts_student_id_test_id_key;

-- Add new UNIQUE constraint that includes job_application_id
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conname = 'test_attempts_student_test_application_unique'
    ) THEN
        BEGIN
            ALTER TABLE test_attempts ADD CONSTRAINT test_attempts_student_test_application_unique
                UNIQUE (student_id, test_id, job_application_id);
        EXCEPTION
            WHEN duplicate_object THEN
                NULL;
        END;
    END IF;
END $$;