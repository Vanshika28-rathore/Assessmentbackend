-- Create coding_questions table
CREATE TABLE IF NOT EXISTS coding_questions (
    id SERIAL PRIMARY KEY,
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    title VARCHAR(500) NOT NULL,
    description TEXT NOT NULL,
    time_limit DECIMAL(5,2) DEFAULT 2.0,
    memory_limit INTEGER DEFAULT 256,
    question_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create coding_test_cases table for public test cases
CREATE TABLE IF NOT EXISTS coding_test_cases (
    id SERIAL PRIMARY KEY,
    coding_question_id INTEGER NOT NULL REFERENCES coding_questions(id) ON DELETE CASCADE,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    explanation TEXT,
    is_hidden BOOLEAN DEFAULT FALSE,
    test_case_order INTEGER DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_coding_questions_test_id ON coding_questions(test_id);
CREATE INDEX IF NOT EXISTS idx_coding_test_cases_question_id ON coding_test_cases(coding_question_id);
CREATE INDEX IF NOT EXISTS idx_coding_test_cases_is_hidden ON coding_test_cases(is_hidden);

-- Create student_coding_submissions table for tracking student submissions
CREATE TABLE IF NOT EXISTS student_coding_submissions (
    id SERIAL PRIMARY KEY,
    student_id VARCHAR(50) NOT NULL,
    coding_question_id INTEGER NOT NULL REFERENCES coding_questions(id) ON DELETE CASCADE,
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    code TEXT,
    language VARCHAR(50),
    status VARCHAR(50) DEFAULT 'pending',
    test_cases_passed INTEGER DEFAULT 0,
    total_test_cases INTEGER DEFAULT 0,
    submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, coding_question_id, test_id)
);

CREATE INDEX IF NOT EXISTS idx_student_coding_submissions_student ON student_coding_submissions(student_id);
CREATE INDEX IF NOT EXISTS idx_student_coding_submissions_test ON student_coding_submissions(test_id);
