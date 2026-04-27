CREATE TABLE IF NOT EXISTS ai_interviews (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(255),
    student_name VARCHAR(255) NOT NULL DEFAULT 'Anonymous',
    resume_text TEXT,
    chat_history JSONB NOT NULL DEFAULT '[]'::jsonb,
    rating INTEGER,
    feedback_comment TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_interviews_created_at ON ai_interviews (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_interviews_student_id ON ai_interviews (student_id);
