
-- JOB APPLICATIONS MODULE MIGRATION
-- Integrates job postings with assessment workflow
-- ============================================

-- Main job applications table
CREATE TABLE IF NOT EXISTS job_applications (
    id SERIAL PRIMARY KEY,
    job_opening_id INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    
    -- Application data
    resume_url TEXT,  -- Can reuse student.resume_link or upload new
    cover_letter TEXT,
    status VARCHAR(50) DEFAULT 'submitted',  
    -- Status flow: submitted → screening → assessment_assigned → assessment_completed → shortlisted → rejected
    
    -- Eligibility check
    is_eligible BOOLEAN DEFAULT true,
    eligibility_notes TEXT,
    
    -- Assessment tracking
    test_assigned_at TIMESTAMPTZ,
    test_completed_at TIMESTAMPTZ,
    assessment_score DECIMAL(5,2),
    passed_assessment BOOLEAN,
    
    -- Metadata
    applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    reviewed_by INTEGER REFERENCES admins(id),
    reviewed_at TIMESTAMPTZ,
    
    UNIQUE(job_opening_id, student_id)  -- One application per student per job
);

-- Link job openings to tests (many-to-many)
CREATE TABLE IF NOT EXISTS job_opening_tests (
    id SERIAL PRIMARY KEY,
    job_opening_id INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    is_mandatory BOOLEAN DEFAULT true,
    weightage INTEGER DEFAULT 100,  -- For multiple tests
    passing_criteria INTEGER DEFAULT 50,  -- Percentage
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(job_opening_id, test_id)
);

-- Structured eligibility criteria (optional - for automated validation)
CREATE TABLE IF NOT EXISTS job_eligibility_rules (
    id SERIAL PRIMARY KEY,
    job_opening_id INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
    rule_type VARCHAR(50) NOT NULL,  -- cgpa, branch, degree, year, backlog, institute
    operator VARCHAR(20) NOT NULL,   -- gte, lte, eq, in, not_in
    value TEXT NOT NULL,             -- JSON or simple value
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Add new columns to job_openings table
ALTER TABLE job_openings 
    ALTER COLUMN application_link DROP NOT NULL;

ALTER TABLE job_openings 
    ADD COLUMN IF NOT EXISTS application_mode VARCHAR(20) DEFAULT 'external';
    -- Values: 'external' (redirects to company site) | 'internal' (apply on platform)

ALTER TABLE job_openings 
    ADD COLUMN IF NOT EXISTS min_cgpa DECIMAL(3,2),
    ADD COLUMN IF NOT EXISTS allowed_branches TEXT,  -- JSON array or comma-separated
    ADD COLUMN IF NOT EXISTS max_active_backlogs INTEGER;

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_job_applications_student ON job_applications(student_id);
CREATE INDEX IF NOT EXISTS idx_job_applications_job ON job_applications(job_opening_id);
CREATE INDEX IF NOT EXISTS idx_job_applications_status ON job_applications(status);
CREATE INDEX IF NOT EXISTS idx_job_applications_applied_at ON job_applications(applied_at DESC);
CREATE INDEX IF NOT EXISTS idx_job_opening_tests_job ON job_opening_tests(job_opening_id);
CREATE INDEX IF NOT EXISTS idx_job_opening_tests_test ON job_opening_tests(test_id);
CREATE INDEX IF NOT EXISTS idx_job_eligibility_rules_job ON job_eligibility_rules(job_opening_id);

-- Comments for documentation
COMMENT ON TABLE job_applications IS 'Tracks student applications to job openings with assessment integration';
COMMENT ON TABLE job_opening_tests IS 'Many-to-many relationship linking job openings to assessments';
COMMENT ON TABLE job_eligibility_rules IS 'Structured eligibility criteria for automated validation';

COMMENT ON COLUMN job_applications.status IS 'Application lifecycle: submitted → screening → assessment_assigned → assessment_completed → shortlisted → rejected';
COMMENT ON COLUMN job_applications.resume_url IS 'Can be student profile resume or uploaded specifically for this application';
COMMENT ON COLUMN job_applications.assessment_score IS 'Aggregated score from all linked test results';

COMMENT ON COLUMN job_openings.application_mode IS 'external: redirect to company URL | internal: apply on platform';
COMMENT ON COLUMN job_opening_tests.is_mandatory IS 'Whether this test must be completed for application to proceed';
COMMENT ON COLUMN job_opening_tests.passing_criteria IS 'Minimum percentage required to pass this test';