CREATE TABLE IF NOT EXISTS ai_interviews (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(255),
    student_name VARCHAR(255) NOT NULL DEFAULT 'Anonymous',
    resume_text TEXT,
    chat_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    rating INTEGER,
    feedback_comment TEXT,
    assessment_summary JSONB DEFAULT '{}'::jsonb,
    scored_questions JSONB DEFAULT '[]'::jsonb,
    ignored_questions JSONB DEFAULT '[]'::jsonb,
    correct_count INTEGER DEFAULT 0,
    total_scored_questions INTEGER DEFAULT 0,
    shortlisted BOOLEAN DEFAULT false,
    result_status VARCHAR(40) DEFAULT 'disqualified',
    proctoring_counts JSONB DEFAULT '{}'::jsonb,
    proctoring_events JSONB DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_interviews_created_at ON ai_interviews (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_interviews_student_id ON ai_interviews (student_id);
CREATE INDEX IF NOT EXISTS idx_ai_interviews_shortlisted ON ai_interviews (shortlisted);
CREATE INDEX IF NOT EXISTS idx_ai_interviews_result_status ON ai_interviews (result_status);
