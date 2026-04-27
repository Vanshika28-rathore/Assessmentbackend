-- =====================================================
-- 1) AI interview storage
-- =====================================================
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

UPDATE ai_interviews
SET
    rating = CASE
        WHEN jsonb_array_length(chat_history) >= 12 THEN 5
        WHEN jsonb_array_length(chat_history) >= 8 THEN 4
        WHEN jsonb_array_length(chat_history) >= 6 THEN 3
        WHEN jsonb_array_length(chat_history) >= 2 THEN 2
        ELSE NULL
    END,
    feedback_comment = CASE
        WHEN jsonb_array_length(chat_history) >= 12 THEN 'Strong interview engagement with clear, sufficiently detailed responses.'
        WHEN jsonb_array_length(chat_history) >= 8 THEN 'Good participation and mostly relevant responses across the interview.'
        WHEN jsonb_array_length(chat_history) >= 6 THEN 'Moderate performance. Answers were brief in places; improve depth and clarity.'
        WHEN jsonb_array_length(chat_history) >= 2 THEN 'Limited response depth. Encourage more complete and structured answers.'
        ELSE NULL
    END
WHERE (rating IS NULL OR feedback_comment IS NULL)
  AND chat_history IS NOT NULL;


-- =====================================================
-- 2) Student messages feedback + closure metadata
-- =====================================================
ALTER TABLE student_messages
ADD COLUMN IF NOT EXISTS conversation_status VARCHAR(20) DEFAULT 'open',
ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS closed_by VARCHAR(255),
ADD COLUMN IF NOT EXISTS feedback_rating INTEGER CHECK (feedback_rating >= 1 AND feedback_rating <= 5),
ADD COLUMN IF NOT EXISTS feedback_helpful BOOLEAN,
ADD COLUMN IF NOT EXISTS feedback_response_time VARCHAR(50),
ADD COLUMN IF NOT EXISTS feedback_comments TEXT,
ADD COLUMN IF NOT EXISTS feedback_submitted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_student_messages_conversation_status
    ON student_messages (conversation_status);

CREATE INDEX IF NOT EXISTS idx_student_messages_feedback_rating
    ON student_messages (feedback_rating);

CREATE INDEX IF NOT EXISTS idx_student_messages_closed_at
    ON student_messages (closed_at DESC);

COMMENT ON COLUMN student_messages.conversation_status IS 'Conversation status: open, closed';
COMMENT ON COLUMN student_messages.closed_at IS 'Timestamp when conversation was closed by admin';
COMMENT ON COLUMN student_messages.closed_by IS 'Admin ID who closed the conversation';
COMMENT ON COLUMN student_messages.feedback_rating IS 'Student feedback rating (1-5 stars)';
COMMENT ON COLUMN student_messages.feedback_helpful IS 'Was the admin help useful? (Yes/No)';
COMMENT ON COLUMN student_messages.feedback_response_time IS 'Student feedback on response time: very_fast, fast, average, slow, very_slow';
COMMENT ON COLUMN student_messages.feedback_comments IS 'Additional feedback comments from student';
COMMENT ON COLUMN student_messages.feedback_submitted_at IS 'Timestamp when feedback was submitted';