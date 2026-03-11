-- Create interview chat messages table
CREATE TABLE IF NOT EXISTS interview_chat_messages (
    id SERIAL PRIMARY KEY,
    interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
    sender_type VARCHAR(10) NOT NULL CHECK (sender_type IN ('admin', 'student')),
    sender_name VARCHAR(255) NOT NULL,
    message TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_interview_chat_interview_id ON interview_chat_messages(interview_id);
CREATE INDEX IF NOT EXISTS idx_interview_chat_created_at ON interview_chat_messages(created_at);

-- Add the table to the setup script