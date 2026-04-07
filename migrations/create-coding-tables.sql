-- Create coding questions table
CREATE TABLE IF NOT EXISTS exam_coding_questions (
    coding_id SERIAL PRIMARY KEY,
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    language VARCHAR(50) DEFAULT 'java',
    time_limit INTEGER DEFAULT 2,
    memory_limit INTEGER DEFAULT 256,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create test cases table
CREATE TABLE IF NOT EXISTS exam_test_cases (
    testcase_id SERIAL PRIMARY KEY,
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    coding_id INTEGER NOT NULL REFERENCES exam_coding_questions(coding_id) ON DELETE CASCADE,
    input TEXT,
    expected_output TEXT,
    is_hidden BOOLEAN DEFAULT FALSE,
    explanation TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_coding_questions_test_id ON exam_coding_questions(test_id);
CREATE INDEX IF NOT EXISTS idx_test_cases_coding_id ON exam_test_cases(coding_id);
CREATE INDEX IF NOT EXISTS idx_test_cases_test_id ON exam_test_cases(test_id);