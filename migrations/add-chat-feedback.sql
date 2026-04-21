-- Add feedback and conversation management fields to student_messages table

-- Add conversation status and feedback fields
ALTER TABLE student_messages 
ADD COLUMN IF NOT EXISTS conversation_status VARCHAR(20) DEFAULT 'open',
ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ,
ADD COLUMN IF NOT EXISTS closed_by VARCHAR(255),
ADD COLUMN IF NOT EXISTS feedback_rating INTEGER CHECK (feedback_rating >= 1 AND feedback_rating <= 5),
ADD COLUMN IF NOT EXISTS feedback_helpful BOOLEAN,
ADD COLUMN IF NOT EXISTS feedback_response_time VARCHAR(50),
ADD COLUMN IF NOT EXISTS feedback_comments TEXT,
ADD COLUMN IF NOT EXISTS feedback_submitted_at TIMESTAMPTZ;

-- Create indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_student_messages_conversation_status ON student_messages(conversation_status);
CREATE INDEX IF NOT EXISTS idx_student_messages_feedback_rating ON student_messages(feedback_rating);
CREATE INDEX IF NOT EXISTS idx_student_messages_closed_at ON student_messages(closed_at DESC);

-- Add comments for documentation
COMMENT ON COLUMN student_messages.conversation_status IS 'Conversation status: open, closed';
COMMENT ON COLUMN student_messages.closed_at IS 'Timestamp when conversation was closed by admin';
COMMENT ON COLUMN student_messages.closed_by IS 'Admin ID who closed the conversation';
COMMENT ON COLUMN student_messages.feedback_rating IS 'Student feedback rating (1-5 stars)';
COMMENT ON COLUMN student_messages.feedback_helpful IS 'Was the admin help useful? (Yes/No)';
COMMENT ON COLUMN student_messages.feedback_response_time IS 'Student feedback on response time: very_fast, fast, average, slow, very_slow';
COMMENT ON COLUMN student_messages.feedback_comments IS 'Additional feedback comments from student';
COMMENT ON COLUMN student_messages.feedback_submitted_at IS 'Timestamp when feedback was submitted';
