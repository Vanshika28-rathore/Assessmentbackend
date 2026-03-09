/**
 * MCQ Exam Portal - Complete Database Setup Script
 * 
 * This script creates the complete database schema for the MCQ exam portal.
 * Run this script after cloning the repository to set up all required tables,
 * indexes, triggers, and seed data.
 * 
 * FEATURES INCLUDED:
 * ==================
 * 
 * Core Tables:
 * - students: Student profiles with extended fields (phone, address, college, course, etc.)
 * - admins: Admin authentication with bcrypt password hashing
 * - institutes: Institute/university management with registration control
 * - tests: Test templates with scheduling, duration, passing criteria, and audit fields
 * - test_job_roles: Multiple job roles per test with descriptions
 * - questions: MCQ questions with 4 options, correct answers, and format support (paragraph/line/code)
 * - exams: Exam instances (legacy support)
 * - results: Exam results tracking
 * 
 * Student Features:
 * - student_responses: Individual question responses with correctness tracking
 * - test_attempts: Complete test submission records with scores
 * - test_assignments: Test-to-student assignment mapping
 * - institute_test_assignments: Test-to-institute assignment mapping
 * - exam_progress: Auto-save functionality with progress tracking
 * - test_feedback: Student feedback on tests with ratings, difficulty, and comments
 * 
 * Coding Features:
 * - coding_questions: Coding problems with time/memory limits and marks
 * - coding_test_cases: Test cases for coding questions (public and hidden)
 * - student_coding_submissions: Student code submissions with execution results and marks
 * 
 * Proctoring Features:
 * - proctoring_sessions: Live proctoring session tracking
 * - proctoring_violations: AI-detected cheating violations
 * - proctoring_messages: Messages sent to students during proctoring
 * 
 * Interview Features:
 * - interviews: Interview scheduling and management with status tracking
 * 
 * Authentication Features:
 * - otps: OTP system for email verification and password reset
 * 
 * System Features:
 * - system_settings: System-wide settings (maintenance mode, retry timer)
 * 
 * Performance Optimizations:
 * - Comprehensive indexes for all foreign keys
 * - Composite indexes for common query patterns
 * - Optimized for 300+ concurrent users
 * - Query planner optimization with ANALYZE
 * 
 * Seed Data:
 * - Default admin account (admin@example.com / admin123)
 * - Default institutes (Not Specified, Other)
 * - Default system settings (retry timer: 5 minutes, maintenance mode: off)
 * 
 * PREREQUISITES:
 * ==============
 * 1. PostgreSQL 12+ installed and running
 * 2. Node.js and npm installed
 * 3. Required npm packages: pg, bcryptjs, dotenv
 * 4. .env file configured with database credentials:
 *    - DB_USER
 *    - DB_HOST
 *    - DB_NAME
 *    - DB_PASSWORD
 *    - DB_PORT (optional, defaults to 5432)
 * 
 * USAGE:
 * ======
 * 1. Clone the repository
 * 2. Navigate to backend directory: cd backend
 * 3. Install dependencies: npm install
 * 4. Configure .env file with your database credentials
 * 5. Run this script: node setup-database.js
 * 
 * The script will create all tables, indexes, and seed data automatically.
 * It's safe to run multiple times (uses IF NOT EXISTS checks).
 * 
 * @author MCQ Exam Portal Team
 * @version 4.0.0
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
});

const createTables = async () => {
    const client = await pool.connect();
    try {
        console.log('🔌 Connected to database...');

        // 1. Create Institutes Table (must be created before students)
        console.log('Creating institutes table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS institutes (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL UNIQUE,
                display_name VARCHAR(255) NOT NULL,
                created_by VARCHAR(255) DEFAULT 'admin',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                registration_deadline TIMESTAMPTZ,
                registration_status VARCHAR(20) DEFAULT 'open',
                registration_start_time TIMESTAMPTZ
            );
        `);

        // Add check constraint for registration_status
        await client.query(`
            DO $$ BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'institutes_registration_status_check') THEN
                    ALTER TABLE institutes ADD CONSTRAINT institutes_registration_status_check 
                    CHECK (registration_status IN ('open', 'closed', 'paused'));
                END IF;
            END $$;
        `);

        // Indices for institutes
        await client.query(`CREATE INDEX IF NOT EXISTS idx_institutes_name ON institutes(LOWER(name));`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_institutes_registration_status ON institutes(registration_status);`);

        // 2. Create Students Table
        console.log('Creating students table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS students (
                id SERIAL PRIMARY KEY,
                firebase_uid VARCHAR(255) UNIQUE NOT NULL,
                full_name VARCHAR(255) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                roll_number VARCHAR(100) UNIQUE NOT NULL,
                institute VARCHAR(255) NOT NULL,
                phone VARCHAR(20),
                address TEXT,
                college_name VARCHAR(255),
                course VARCHAR(100),
                specialization VARCHAR(100),
                resume_link VARCHAR(500),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Indices for students
        await client.query(`CREATE INDEX IF NOT EXISTS idx_students_firebase_uid ON students(firebase_uid);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_students_email ON students(email);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_students_roll_number ON students(roll_number);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_students_institute ON students(LOWER(institute));`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_students_created_at ON students(created_at);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_students_resume_link ON students(resume_link) WHERE resume_link IS NOT NULL;`);

        // 2. Create Admins Table
        console.log('Creating admins table...');
        // Note: Matching schema required by adminAuth.js (email, full_name, password_hash)
        await client.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                full_name VARCHAR(255),
                phone VARCHAR(20),
                address TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add missing columns if they don't exist (for existing databases)
        await client.query(`
            DO $ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='admins' AND column_name='phone') THEN
                    ALTER TABLE admins ADD COLUMN phone VARCHAR(20);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='admins' AND column_name='address') THEN
                    ALTER TABLE admins ADD COLUMN address TEXT;
                END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='admins' AND column_name='updated_at') THEN
                    ALTER TABLE admins ADD COLUMN updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
                END IF;
            END $;
        `);

        // 3. Create Tests Table
        console.log('Creating tests table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS tests (
                id SERIAL PRIMARY KEY,
                title VARCHAR(255) NOT NULL,
                description TEXT,
                duration INTEGER DEFAULT 60,
                max_attempts INTEGER DEFAULT 1,
                start_datetime TIMESTAMPTZ,
                end_datetime TIMESTAMPTZ,
                status VARCHAR(20) DEFAULT 'draft',
                is_published BOOLEAN DEFAULT false,
                passing_percentage INTEGER DEFAULT 50,
                is_mock_test BOOLEAN DEFAULT false,
                job_role TEXT,
                created_by VARCHAR(255) DEFAULT 'admin',
                updated_by VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);


        // Indices for tests
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tests_status ON tests(status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tests_is_published ON tests(is_published);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tests_dates ON tests(start_datetime, end_datetime);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tests_active ON tests(status, start_datetime, end_datetime) WHERE status = 'published';`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tests_created_at ON tests(created_at);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tests_created_by ON tests(created_by);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_tests_updated_by ON tests(updated_by);`);

        // 4. Create Test Job Roles Table
        console.log('Creating test_job_roles table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS test_job_roles (
                id SERIAL PRIMARY KEY,
                test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
                job_role VARCHAR(255) NOT NULL,
                job_description TEXT,
                is_default BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(test_id, job_role)
            );
        `);

        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_job_roles_test_id ON test_job_roles(test_id);`);

        // 5. Create Questions Table
        console.log('Creating questions table...');
        await client.query(`
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
                format VARCHAR(20) DEFAULT 'paragraph',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add format column if it doesn't exist (for existing databases)
        await client.query(`
            DO $ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='questions' AND column_name='format') THEN
                    ALTER TABLE questions ADD COLUMN format VARCHAR(20) DEFAULT 'paragraph';
                END IF;
            END $;
        `);

        // Add check constraint for format values
        await client.query(`
            DO $ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'questions_format_check') THEN
                    ALTER TABLE questions ADD CONSTRAINT questions_format_check 
                    CHECK (format IN ('paragraph', 'line', 'code'));
                END IF;
            END $;
        `);

        // Create index on test_id for faster lookups
        await client.query(`CREATE INDEX IF NOT EXISTS idx_questions_test_id ON questions(test_id);`);

        // 6. Create Exams Table
        console.log('Creating exams table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS exams (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                date DATE DEFAULT CURRENT_DATE,
                duration INTEGER DEFAULT 60,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Indices for exams
        await client.query(`CREATE INDEX IF NOT EXISTS idx_exams_date ON exams(date);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_exams_created_at ON exams(created_at);`);

        // 7. Create Results Table
        console.log('Creating results table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS results (
                id SERIAL PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                exam_id INTEGER NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
                marks_obtained NUMERIC(10, 2) NOT NULL,
                total_marks NUMERIC(10, 2) NOT NULL,
                status VARCHAR(20),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Indices for results
        await client.query(`CREATE INDEX IF NOT EXISTS idx_results_student_id ON results(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_results_exam_id ON results(exam_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_results_student_exam ON results(student_id, exam_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_results_created_at ON results(created_at);`);

        // 8. Create Student Responses Table (for tracking student answers)
        console.log('Creating student_responses table...');
        await client.query(`
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
        `);

        // Indices for student_responses
        await client.query(`CREATE INDEX IF NOT EXISTS idx_student_responses_student ON student_responses(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_student_responses_test ON student_responses(test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_student_responses_question ON student_responses(question_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_student_responses_student_test ON student_responses(student_id, test_id);`);

        // 9. Create Test Attempts Table (to track overall test submissions)
        console.log('Creating test_attempts table...');
        await client.query(`
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
        `);

        // Indices for test_attempts
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_attempts_student ON test_attempts(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_attempts_test ON test_attempts(test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_attempts_student_test ON test_attempts(student_id, test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_attempts_submitted_at ON test_attempts(submitted_at);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_attempts_test_date ON test_attempts(test_id, submitted_at);`);

        // 10. Create Test Assignments Table (for assigning tests to students)
        console.log('Creating test_assignments table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS test_assignments (
                id SERIAL PRIMARY KEY,
                test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
                student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                UNIQUE(test_id, student_id)
            );
        `);

        // Create indices for test_assignments
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_assignments_student ON test_assignments(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_assignments_test ON test_assignments(test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_assignments_active ON test_assignments(is_active);`);

        // 11. Create Exam Progress Table (for saving progress)
        console.log('Creating exam_progress table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS exam_progress (
                id SERIAL PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
                answers JSONB,
                time_remaining INTEGER,
                tab_switch_count INTEGER DEFAULT 0,
                current_question INTEGER DEFAULT 0,
                marked_for_review INTEGER[] DEFAULT '{}',
                visited_questions INTEGER[] DEFAULT '{0}',
                warning_count INTEGER DEFAULT 0,
                last_saved TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(student_id, test_id)
            );
        `);

        // Indices for exam_progress
        await client.query(`CREATE INDEX IF NOT EXISTS idx_exam_progress_student_test ON exam_progress(student_id, test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_exam_progress_student ON exam_progress(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_exam_progress_test ON exam_progress(test_id);`);

        // Create trigger function for exam_progress updated_at
        await client.query(`
            CREATE OR REPLACE FUNCTION update_exam_progress_timestamp()
            RETURNS TRIGGER AS $$
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $$ LANGUAGE plpgsql;
        `);

        // Create trigger for exam_progress
        await client.query(`DROP TRIGGER IF EXISTS update_exam_progress_timestamp_trigger ON exam_progress;`);
        await client.query(`
            CREATE TRIGGER update_exam_progress_timestamp_trigger
            BEFORE UPDATE ON exam_progress
            FOR EACH ROW
            EXECUTE FUNCTION update_exam_progress_timestamp();
        `);

        // 12. Create Proctoring Sessions Table
        console.log('Creating proctoring_sessions table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS proctoring_sessions (
                id SERIAL PRIMARY KEY,
                student_id INTEGER REFERENCES students(id) ON DELETE CASCADE,
                test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP,
                duration_minutes INTEGER,
                connection_status VARCHAR(50) DEFAULT 'active',
                notes TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create indices for proctoring_sessions
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_student ON proctoring_sessions(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_test ON proctoring_sessions(test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_status ON proctoring_sessions(connection_status);`);

        // 13. Create Proctoring Violations Table
        console.log('Creating proctoring_violations table...');
        await client.query(`
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
        `);

        // Create indices for proctoring_violations
        await client.query(`CREATE INDEX IF NOT EXISTS idx_student_violations ON proctoring_violations(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_violations ON proctoring_violations(test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_violation_timestamp ON proctoring_violations(timestamp);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_severity ON proctoring_violations(severity);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_violations_type ON proctoring_violations(violation_type);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_violations_composite ON proctoring_violations(student_id, test_id, violation_type);`);

        // 13a. Create Proctoring Messages Table
        console.log('Creating proctoring_messages table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS proctoring_messages (
                id SERIAL PRIMARY KEY,
                admin_id VARCHAR(255) NOT NULL,
                student_id VARCHAR(255) NOT NULL,
                test_id VARCHAR(255),
                message TEXT NOT NULL,
                message_type VARCHAR(50) DEFAULT 'warning',
                priority VARCHAR(20) DEFAULT 'medium',
                session_id VARCHAR(255),
                message_timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                read_status BOOLEAN DEFAULT FALSE,
                read_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add check constraints for message_type and priority
        await client.query(`
            DO $ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proctoring_messages_message_type_check') THEN
                    ALTER TABLE proctoring_messages ADD CONSTRAINT proctoring_messages_message_type_check 
                    CHECK (message_type IN ('warning', 'instruction', 'alert', 'info'));
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'proctoring_messages_priority_check') THEN
                    ALTER TABLE proctoring_messages ADD CONSTRAINT proctoring_messages_priority_check 
                    CHECK (priority IN ('low', 'medium', 'high'));
                END IF;
            END $;
        `);

        // Create indices for proctoring_messages
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_messages_student_id ON proctoring_messages(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_messages_admin_id ON proctoring_messages(admin_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_messages_test_id ON proctoring_messages(test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_messages_session_id ON proctoring_messages(session_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_messages_message_timestamp ON proctoring_messages(message_timestamp);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_proctoring_messages_read_status ON proctoring_messages(read_status);`);

        // Create trigger function for proctoring_messages updated_at
        await client.query(`
            CREATE OR REPLACE FUNCTION update_proctoring_messages_timestamp()
            RETURNS TRIGGER AS $
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $ LANGUAGE plpgsql;
        `);

        // Create trigger for proctoring_messages
        await client.query(`DROP TRIGGER IF EXISTS update_proctoring_messages_timestamp_trigger ON proctoring_messages;`);
        await client.query(`
            CREATE TRIGGER update_proctoring_messages_timestamp_trigger
            BEFORE UPDATE ON proctoring_messages
            FOR EACH ROW
            EXECUTE FUNCTION update_proctoring_messages_timestamp();
        `);

        // 13b. Create Interviews Table
        console.log('Creating interviews table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS interviews (
                id SERIAL PRIMARY KEY,
                student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
                test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
                scheduled_time TIMESTAMP NOT NULL,
                duration INTEGER DEFAULT 60,
                status VARCHAR(20) DEFAULT 'scheduled',
                peer_id VARCHAR(255),
                admin_notes TEXT,
                technical_score INTEGER,
                communication_score INTEGER,
                recommendation VARCHAR(20) DEFAULT 'on_hold',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add check constraints for status and recommendation
        await client.query(`
            DO $ 
            BEGIN
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interviews_status_check') THEN
                    ALTER TABLE interviews ADD CONSTRAINT interviews_status_check 
                    CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled'));
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interviews_recommendation_check') THEN
                    ALTER TABLE interviews ADD CONSTRAINT interviews_recommendation_check 
                    CHECK (recommendation IN ('selected', 'rejected', 'on_hold'));
                END IF;
            END $;
        `);

        // Create indices for interviews
        await client.query(`CREATE INDEX IF NOT EXISTS idx_interviews_student_id ON interviews(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_interviews_test_id ON interviews(test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_interviews_scheduled_time ON interviews(scheduled_time);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_interviews_status ON interviews(status);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_interviews_created_at ON interviews(created_at);`);

        // Create trigger function for interviews updated_at
        await client.query(`
            CREATE OR REPLACE FUNCTION update_interviews_updated_at()
            RETURNS TRIGGER AS $
            BEGIN
                NEW.updated_at = CURRENT_TIMESTAMP;
                RETURN NEW;
            END;
            $ LANGUAGE plpgsql;
        `);

        // Create trigger for interviews
        await client.query(`DROP TRIGGER IF EXISTS trigger_update_interviews_updated_at ON interviews;`);
        await client.query(`
            CREATE TRIGGER trigger_update_interviews_updated_at
            BEFORE UPDATE ON interviews
            FOR EACH ROW
            EXECUTE FUNCTION update_interviews_updated_at();
        `);

        // 13c. Create OTPs Table
        console.log('Creating otps table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS otps (
                id SERIAL PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                otp_hash VARCHAR(255) NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                attempts INTEGER DEFAULT 0,
                is_used BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Create indices for otps
        await client.query(`CREATE INDEX IF NOT EXISTS idx_otps_email ON otps(email);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_otps_expires_at ON otps(expires_at);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_otps_created_at ON otps(created_at);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_otps_is_used ON otps(is_used);`);

        // 14. Create Institute Test Assignments Table
        console.log('Creating institute_test_assignments table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS institute_test_assignments (
                id SERIAL PRIMARY KEY,
                institute_id INTEGER REFERENCES institutes(id) ON DELETE CASCADE,
                test_id INTEGER REFERENCES tests(id) ON DELETE CASCADE,
                assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                is_active BOOLEAN DEFAULT true,
                UNIQUE(institute_id, test_id)
            );
        `);

        // Create indices for institute_test_assignments
        await client.query(`CREATE INDEX IF NOT EXISTS idx_institute_test_assignments_institute ON institute_test_assignments(institute_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_institute_test_assignments_test ON institute_test_assignments(test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_institute_test_assignments_active ON institute_test_assignments(is_active);`);

        // 15. Create Test Feedback Table
        console.log('Creating test_feedback table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS test_feedback (
                id SERIAL PRIMARY KEY,
                student_id VARCHAR(255) NOT NULL,
                test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
                rating INTEGER CHECK (rating >= 1 AND rating <= 5),
                difficulty VARCHAR(20),
                feedback_text TEXT,
                submission_reason VARCHAR(50),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(student_id, test_id)
            );
        `);

        // Create indices for test_feedback
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_feedback_student_id ON test_feedback(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_test_feedback_test_id ON test_feedback(test_id);`);

        // 16. Create System Settings Table
        console.log('Creating system_settings table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS system_settings (
                id SERIAL PRIMARY KEY,
                retry_timer_minutes INTEGER DEFAULT 5,
                maintenance_mode BOOLEAN DEFAULT false,
                maintenance_message TEXT DEFAULT 'The system is currently undergoing scheduled maintenance. Please check back later.',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Insert default system settings
        await client.query(`
            INSERT INTO system_settings (id, retry_timer_minutes, maintenance_mode)
            VALUES (1, 5, false)
            ON CONFLICT (id) DO NOTHING;
        `);

        // 17. Create Coding Questions Table
        console.log('Creating coding_questions table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS coding_questions (
                id SERIAL PRIMARY KEY,
                test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
                title VARCHAR(500) NOT NULL,
                description TEXT NOT NULL,
                marks INTEGER DEFAULT 10,
                time_limit DECIMAL(5,2) DEFAULT 2.0,
                memory_limit INTEGER DEFAULT 256,
                question_order INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Add marks column if it doesn't exist (for existing databases)
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='coding_questions' AND column_name='marks') THEN
                    ALTER TABLE coding_questions ADD COLUMN marks INTEGER DEFAULT 10;
                END IF;
            END $$;
        `);

        // Create index for coding_questions
        await client.query(`CREATE INDEX IF NOT EXISTS idx_coding_questions_test_id ON coding_questions(test_id);`);

        // 18. Create Coding Test Cases Table
        console.log('Creating coding_test_cases table...');
        await client.query(`
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
        `);

        // Create indices for coding_test_cases
        await client.query(`CREATE INDEX IF NOT EXISTS idx_coding_test_cases_question_id ON coding_test_cases(coding_question_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_coding_test_cases_is_hidden ON coding_test_cases(is_hidden);`);

        // 19. Create Student Coding Submissions Table
        console.log('Creating student_coding_submissions table...');
        await client.query(`
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
                marks_earned DECIMAL(5,2) DEFAULT 0,
                submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(student_id, coding_question_id, test_id)
            );
        `);

        // Add marks_earned column if it doesn't exist (for existing databases)
        await client.query(`
            DO $$ 
            BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                              WHERE table_name='student_coding_submissions' AND column_name='marks_earned') THEN
                    ALTER TABLE student_coding_submissions ADD COLUMN marks_earned DECIMAL(5,2) DEFAULT 0;
                END IF;
            END $$;
        `);

        // Create indices for student_coding_submissions
        await client.query(`CREATE INDEX IF NOT EXISTS idx_student_coding_submissions_student ON student_coding_submissions(student_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_student_coding_submissions_test ON student_coding_submissions(test_id);`);
        await client.query(`CREATE INDEX IF NOT EXISTS idx_student_coding_submissions_question ON student_coding_submissions(coding_question_id);`);

        // 20. Seed Default Admin
        const defaultAdminEmail = 'admin@example.com';
        const defaultAdminPassword = 'admin123';
        const defaultAdminName = 'System Admin';

        const adminCheck = await client.query('SELECT * FROM admins WHERE email = $1', [defaultAdminEmail]);

        if (adminCheck.rows.length === 0) {
            console.log(`Seeding default admin (${defaultAdminEmail})...`);
            const salt = await bcrypt.genSalt(10);
            const hash = await bcrypt.hash(defaultAdminPassword, salt);

            await client.query(
                'INSERT INTO admins (email, password_hash, full_name) VALUES ($1, $2, $3)',
                [defaultAdminEmail, hash, defaultAdminName]
            );
            console.log(`✅ Default admin created: ${defaultAdminEmail} / ${defaultAdminPassword}`);
        } else {
            console.log('ℹ️ Default admin already exists.');
        }

        // 21. Seed Default Institutes
        console.log('Seeding default institutes...');
        const defaultInstitutes = [
            { name: 'not specified', display_name: 'Not Specified' },
            { name: 'other', display_name: 'Other' }
        ];

        for (const institute of defaultInstitutes) {
            await client.query(`
                INSERT INTO institutes (name, display_name, created_by)
                VALUES ($1, $2, 'system')
                ON CONFLICT (name) DO NOTHING
            `, [institute.name, institute.display_name]);
        }

        // 22. Run ANALYZE for query planner optimization
        console.log('Analyzing tables for query optimization...');
        const tables = [
            'students', 'admins', 'tests', 'test_job_roles', 'questions', 
            'exams', 'results', 'student_responses', 'test_attempts', 
            'test_assignments', 'exam_progress', 'proctoring_sessions', 
            'proctoring_violations', 'proctoring_messages', 'interviews', 'otps',
            'institutes', 'institute_test_assignments', 'test_feedback', 
            'system_settings', 'coding_questions', 'coding_test_cases',
            'student_coding_submissions'
        ];
        
        for (const table of tables) {
            await client.query(`ANALYZE ${table};`);
        }

        console.log('✅ Database setup completed successfully!');
        console.log('📊 Database includes:');
        console.log('   - Students table with profile fields (phone, address, college, course, specialization)');
        console.log('   - Institutes table with registration control (deadline, status, start time)');
        console.log('   - Tests table with job roles, scheduling, passing percentage, and audit fields');
        console.log('   - Test job roles table for multiple job roles per test');
        console.log('   - Questions with format support (paragraph, line, code)');
        console.log('   - Exam management and results tracking');
        console.log('   - Test assignments for student-test mapping');
        console.log('   - Institute test assignments for institute-test mapping');
        console.log('   - Progress tracking with auto-save functionality');
        console.log('   - Proctoring sessions, violations, and messages');
        console.log('   - Interviews scheduling and management');
        console.log('   - OTP system for email verification');
        console.log('   - Feedback system for student test feedback (test_feedback table)');
        console.log('   - System settings for maintenance mode and retry timer');
        console.log('   - Coding questions with test cases and submissions');
        console.log('   - Performance indexes for 300+ concurrent users');
        console.log('   - Default admin account (admin@example.com / admin123)');

    } catch (err) {
        console.error('❌ Error creating tables:', err);
        throw err;
    } finally {
        client.release();
        pool.end();
    }
};

createTables();
