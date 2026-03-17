-- ============================================
-- JOB OPENINGS MODULE MIGRATION
-- ============================================

-- Main job postings table
CREATE TABLE IF NOT EXISTS job_openings (
    id SERIAL PRIMARY KEY,
    company_name VARCHAR(255) NOT NULL,
    job_role VARCHAR(255) NOT NULL,
    job_description TEXT NOT NULL,
    registration_deadline TIMESTAMPTZ NOT NULL,
    eligibility_criteria TEXT NOT NULL,
    application_link VARCHAR(500) NOT NULL,
    admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
    status VARCHAR(20) DEFAULT 'draft',           -- draft | active | expired
    is_published BOOLEAN DEFAULT false,
    published_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Track which students were notified per job
CREATE TABLE IF NOT EXISTS job_notifications (
    id SERIAL PRIMARY KEY,
    job_opening_id INTEGER NOT NULL REFERENCES job_openings(id) ON DELETE CASCADE,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    email_status VARCHAR(20) DEFAULT 'sent',      -- sent | failed
    email_sent_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(job_opening_id, student_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_job_openings_status      ON job_openings(status);
CREATE INDEX IF NOT EXISTS idx_job_openings_published   ON job_openings(is_published);
CREATE INDEX IF NOT EXISTS idx_job_openings_deadline    ON job_openings(registration_deadline);
CREATE INDEX IF NOT EXISTS idx_job_notifications_job    ON job_notifications(job_opening_id);
CREATE INDEX IF NOT EXISTS idx_job_notifications_student ON job_notifications(student_id);