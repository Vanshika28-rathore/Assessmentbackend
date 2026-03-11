-- MCQ Exam Portal Database Schema
-- PostgreSQL Database

-- ============================================
-- 1. STUDENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS students (
    id SERIAL PRIMARY KEY,
    firebase_uid VARCHAR(255) UNIQUE NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    roll_number VARCHAR(100) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for students
CREATE INDEX IF NOT EXISTS idx_students_firebase_uid ON students(firebase_uid);
CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);
CREATE INDEX IF NOT EXISTS idx_students_roll_number ON students(roll_number);

-- ============================================
-- 2. ADMINS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 3. TESTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS tests (
    id SERIAL PRIMARY KEY,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    duration INTEGER DEFAULT 60, -- Duration in minutes
    max_attempts INTEGER DEFAULT 1, -- Number of attempts allowed
    start_datetime TIMESTAMPTZ, -- Exam start date and time (timezone-aware)
    end_datetime TIMESTAMPTZ, -- Exam end date and time (timezone-aware)
    status VARCHAR(20) DEFAULT 'draft', -- Test status: draft, published, archived
    is_published BOOLEAN DEFAULT false, -- Legacy field for backward compatibility
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 4. QUESTIONS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS questions (
    id SERIAL PRIMARY KEY,
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    question_text TEXT NOT NULL,
    option_a TEXT NOT NULL,
    option_b TEXT NOT NULL,
    option_c TEXT,
    option_d TEXT,
    correct_option VARCHAR(1) NOT NULL,
    marks INTEGER DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for questions
CREATE INDEX IF NOT EXISTS idx_questions_test_id ON questions(test_id);

-- ============================================
-- 5. EXAMS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS exams (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    date DATE DEFAULT CURRENT_DATE,
    duration INTEGER DEFAULT 60,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 6. RESULTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS results (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
    marks_obtained NUMERIC(10, 2) NOT NULL,
    total_marks NUMERIC(10, 2) NOT NULL,
    status VARCHAR(20),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for results
CREATE INDEX IF NOT EXISTS idx_results_student_id ON results(student_id);
CREATE INDEX IF NOT EXISTS idx_results_exam_id ON results(exam_id);

-- ============================================
-- 7. STUDENT RESPONSES TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS student_responses (
    id SERIAL PRIMARY KEY,
    student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
    test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
    question_id INTEGER REFERENCES questions(id) ON DELETE CASCADE,
    selected_option VARCHAR(1),
    is_correct BOOLEAN,
    marks_obtained INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, question_id)
);

-- ============================================
-- 8. TEST ATTEMPTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS test_attempts (
    id SERIAL PRIMARY KEY,
    student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
    test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
    total_marks INTEGER DEFAULT 0,
    obtained_marks INTEGER DEFAULT 0,
    percentage DECIMAL(5,2),
    time_taken INTEGER,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, test_id)
);

-- ============================================
-- 9. EXAM PROGRESS TABLE (for saving progress)
-- ============================================
CREATE TABLE IF NOT EXISTS exam_progress (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    answers JSONB,
    time_remaining INTEGER,
    tab_switch_count INTEGER DEFAULT 0,
    last_saved TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, test_id)
);

-- Indexes for exam_progress
CREATE INDEX IF NOT EXISTS idx_exam_progress_student_test ON exam_progress(student_id, test_id);

-- ============================================
-- SEED DEFAULT ADMIN
-- ============================================
-- Default admin credentials:
-- Email: admin@example.com
-- Password: admin123
-- Note: Password hash is for 'admin123' using bcrypt with salt rounds 10

INSERT INTO admins (email, password_hash, full_name)
VALUES (
    'admin@example.com',
    '$2a$10$YourHashedPasswordHere',
    'System Admin'
)
ON CONFLICT (email) DO NOTHING;

-- ============================================
-- NOTES
-- ============================================
-- 1. The 'tests' table stores test templates created by admin
-- 2. The 'exams' table stores actual exam instances when students take tests
-- 3. Multiple students can take the same test, creating multiple exam records
-- 4. Results are linked to exams (not tests) to track individual attempts
-- 5. Questions are linked to tests (templates)
-- 6. exam_progress stores in-progress exam state for resume functionality


-- Add missing columns to exam_progress table
ALTER TABLE exam_progress 
ADD COLUMN IF NOT EXISTS current_question INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS marked_for_review INTEGER[] DEFAULT '{}',
ADD COLUMN IF NOT EXISTS visited_questions INTEGER[] DEFAULT '{0}',
ADD COLUMN IF NOT EXISTS warning_count INTEGER DEFAULT 0,
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;

-- Update the last_saved column to be updated automatically
CREATE OR REPLACE FUNCTION update_exam_progress_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS update_exam_progress_timestamp_trigger ON exam_progress;
CREATE TRIGGER update_exam_progress_timestamp_trigger
BEFORE UPDATE ON exam_progress
FOR EACH ROW
EXECUTE FUNCTION update_exam_progress_timestamp();


-- Add passing_percentage column to tests table
ALTER TABLE tests 
ADD COLUMN IF NOT EXISTS passing_percentage INTEGER DEFAULT 50;

-- Add comment
COMMENT ON COLUMN tests.passing_percentage IS 'Minimum percentage required to pass the test (default: 50)';


-- Add resume_link column (nullable to support existing students)
ALTER TABLE students 
ADD COLUMN IF NOT EXISTS resume_link VARCHAR(500);

-- Add comment for documentation
COMMENT ON COLUMN students.resume_link IS 'Public URL to student resume (Google Drive, Dropbox, etc.)';

-- Create index for faster queries (optional, useful if filtering by resume presence)
CREATE INDEX IF NOT EXISTS idx_students_resume_link ON students(resume_link) WHERE resume_link IS NOT NULL;




-- Create proctoring_violations table for AI-detected cheating attempts
CREATE TABLE IF NOT EXISTS proctoring_violations (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(255) NOT NULL,
    test_id INTEGER NOT NULL,
    violation_type VARCHAR(50) NOT NULL,
    severity VARCHAR(20) NOT NULL,
    message TEXT,
    timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for faster queries
CREATE INDEX IF NOT EXISTS idx_student_violations ON proctoring_violations(student_id);
CREATE INDEX IF NOT EXISTS idx_test_violations ON proctoring_violations(test_id);
CREATE INDEX IF NOT EXISTS idx_violation_timestamp ON proctoring_violations(timestamp);
CREATE INDEX IF NOT EXISTS idx_severity ON proctoring_violations(severity);

-- Add comments
COMMENT ON TABLE proctoring_violations IS 'Stores AI-detected cheating violations during exams';
COMMENT ON COLUMN proctoring_violations.violation_type IS 'Type: multiple_faces, no_face, phone_detected, looking_down';
COMMENT ON COLUMN proctoring_violations.severity IS 'Severity: high, medium, low';



CREATE TABLE IF NOT EXISTS system_settings (
    id SERIAL PRIMARY KEY,
    retry_timer_minutes INTEGER DEFAULT 5,
    maintenance_mode BOOLEAN DEFAULT false,
    maintenance_message TEXT DEFAULT 'The system is currently undergoing scheduled maintenance. Please check back later.',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert default settings if empty
INSERT INTO system_settings (id, retry_timer_minutes, maintenance_mode)
VALUES (1, 5, false)
ON CONFLICT (id) DO NOTHING;


-- ============================================
-- STUDENT MESSAGES TABLE
-- Stores support messages from students through chatbot
-- ============================================

CREATE TABLE IF NOT EXISTS student_messages (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) DEFAULT 'Anonymous',
    email VARCHAR(255),
    message TEXT NOT NULL,
    topic VARCHAR(100) DEFAULT 'General',
    image_path VARCHAR(500),
    status VARCHAR(20) DEFAULT 'unread', -- unread, read, archived
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    read_at TIMESTAMPTZ
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_student_messages_status ON student_messages(status);
CREATE INDEX IF NOT EXISTS idx_student_messages_created_at ON student_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_student_messages_topic ON student_messages(topic);

-- Comment on table
COMMENT ON TABLE student_messages IS 'Stores support messages from students via the chatbot contact feature';
COMMENT ON COLUMN student_messages.status IS 'Message status: unread, read, archived';
COMMENT ON COLUMN student_messages.image_path IS 'Relative path to uploaded screenshot image';


AI Overview
This content details Node.js/Express backend setup for real-time proctoring, student support, and interview signaling, including SQL migration scripts for the student_messages table.

Gemini
Ask about your files
Summarize this folder
Analyze each file in this folder
What can Gemini do with folders in Google Drive
Gemini in Workspace can make mistakes. Learn more
-- Student Support Conversations Migration
-- For two-way chat between students and admin

-- ============================================
-- SUPPORT CONVERSATIONS TABLE
-- Stores conversation threads between students and admin
-- ============================================

-- First, add columns to existing student_messages table if needed
ALTER TABLE student_messages 
ADD COLUMN IF NOT EXISTS student_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS college VARCHAR(255),
ADD COLUMN IF NOT EXISTS conversation_id INTEGER,
ADD COLUMN IF NOT EXISTS sender_type VARCHAR(20) DEFAULT 'student',
ADD COLUMN IF NOT EXISTS parent_message_id INTEGER REFERENCES student_messages(id);

-- Create index for faster student queries
CREATE INDEX IF NOT EXISTS idx_student_messages_student_id ON student_messages(student_id);
CREATE INDEX IF NOT EXISTS idx_student_messages_college ON student_messages(college);
CREATE INDEX IF NOT EXISTS idx_student_messages_conversation ON student_messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_student_messages_sender ON student_messages(sender_type);

-- Comment on new columns
COMMENT ON COLUMN student_messages.student_id IS 'Student ID for authenticated student messages';
COMMENT ON COLUMN student_messages.college IS 'College/Institute name of the student';
COMMENT ON COLUMN student_messages.conversation_id IS 'Groups related messages in a conversation thread';
COMMENT ON COLUMN student_messages.sender_type IS 'Sender type: student or admin';
COMMENT ON COLUMN student_messages.parent_message_id IS 'Reference to parent message for threaded replies';






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