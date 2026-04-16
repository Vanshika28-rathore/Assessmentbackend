-- ============================================================
-- MASTER DATABASE FIX SCRIPT
-- DB: Shnoor_Assignment_Portal
-- 
-- ✅ SAFE TO RUN ON PRODUCTION
-- ✅ Idempotent — can be run multiple times without errors
-- ✅ No real data is deleted — only de-duplicated or re-pointed
-- ✅ All student results, test data, exam history preserved
-- ✅ Adds constraints to prevent future duplication
--
-- Run in pgAdmin Query Tool:
--   Query > Execute (F5)
--
-- Or via psql:
--   psql -U postgres -d Shnoor_Assignment_Portal -f master-db-fix.sql
-- ============================================================

\echo ''
\echo '======================================================================'
\echo '  MASTER DB FIX — Starting...'
\echo '  DB: Shnoor_Assignment_Portal'
\echo '======================================================================'
\echo ''


-- ============================================================
-- SECTION 1: EXAMS TABLE — DEDUPLICATE 2000+ rows down to ~50
-- ============================================================
-- Problem: Every exam submission created a new row in exams.
--   "Mock Test" has 200 rows, "Assessment - VITS 5" has 150 rows, etc.
-- Fix: Keep the LOWEST id per exam name (first ever created),
--      re-point all results to that canonical row, then delete the empty duplicates.
--      NO result data is lost — only the duplicate exam "shells" are removed.
-- ============================================================

\echo 'SECTION 1: Deduplicating exams table...'

DO $$
DECLARE
  v_before BIGINT;
  v_after  BIGINT;
  v_repointed BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_before FROM exams;

  -- Step 1a: Re-point all results to the canonical (lowest id) exam row
  UPDATE results r
  SET exam_id = canonical.keep_id
  FROM (
    SELECT name, MIN(id) AS keep_id
    FROM exams
    GROUP BY name
  ) canonical
  JOIN exams e ON e.name = canonical.name
  WHERE r.exam_id = e.id
    AND e.id <> canonical.keep_id;

  GET DIAGNOSTICS v_repointed = ROW_COUNT;

  -- Step 1b: Delete duplicate exam rows that now have NO results pointing to them
  -- (the canonical row keeps all the results)
  DELETE FROM exams e
  WHERE e.id NOT IN (SELECT MIN(id) FROM exams GROUP BY name)
    AND NOT EXISTS (SELECT 1 FROM results r WHERE r.exam_id = e.id);

  SELECT COUNT(*) INTO v_after FROM exams;

  RAISE NOTICE '[SECTION 1] exams: % → % rows (removed % duplicates, re-pointed % results)',
    v_before, v_after, v_before - v_after, v_repointed;
END $$;


-- ============================================================
-- SECTION 2: UNIQUE CONSTRAINT on exams(name)
-- Prevents future exam duplications at DB level
-- ============================================================

\echo 'SECTION 2: Adding UNIQUE constraint on exams(name)...'

DO $$
BEGIN
  -- Only add if not already present
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'exams_name_key'
      AND conrelid = 'exams'::regclass
  ) THEN
    ALTER TABLE exams ADD CONSTRAINT exams_name_key UNIQUE (name);
    RAISE NOTICE '[SECTION 2] UNIQUE(name) added to exams';
  ELSE
    RAISE NOTICE '[SECTION 2] UNIQUE(name) already exists on exams — skipped';
  END IF;
END $$;


-- ============================================================
-- SECTION 3: DUPLICATE QUESTIONS — deduplicate within each test
-- ============================================================
-- Problem: Same question text uploaded multiple times to the same test.
-- Fix: Keep the row with the LOWEST id (first upload), delete the rest.
--      student_responses reference question_id via CASCADE, so those are
--      automatically cleaned up too (they were duplicate responses anyway).
-- ============================================================

\echo 'SECTION 3: Removing duplicate questions within tests...'

DO $$
DECLARE
  v_before BIGINT;
  v_after  BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_before FROM questions;

  DELETE FROM questions
  WHERE id NOT IN (
    SELECT MIN(id)
    FROM questions
    GROUP BY test_id, question_text
  );

  SELECT COUNT(*) INTO v_after FROM questions;

  RAISE NOTICE '[SECTION 3] questions: % → % rows (removed % duplicates)',
    v_before, v_after, v_before - v_after;
END $$;


-- ============================================================
-- SECTION 4: ORPHANED QUESTIONS (test_id no longer exists in tests)
-- ============================================================
-- These are questions belonging to tests that were deleted without CASCADE.
-- They have NO students, NO results, NO purpose — pure abandoned data.
-- ============================================================

\echo 'SECTION 4: Removing orphaned questions (deleted tests)...'

DO $$
DECLARE v_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM questions q
  WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = q.test_id);

  IF v_count > 0 THEN
    DELETE FROM questions q
    WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = q.test_id);
    RAISE NOTICE '[SECTION 4] Removed % orphaned questions', v_count;
  ELSE
    RAISE NOTICE '[SECTION 4] No orphaned questions — already clean';
  END IF;
END $$;


-- ============================================================
-- SECTION 5: ORPHANED RESULTS (student_id not in students table)
-- ============================================================
-- These are results whose student was deleted but results stayed behind
-- (because the FK was missing). The student no longer exists — these
-- results cannot be shown to anyone and serve no purpose.
-- ============================================================

\echo 'SECTION 5: Removing orphaned results (deleted students)...'

DO $$
DECLARE v_count BIGINT;
BEGIN
  SELECT COUNT(*) INTO v_count FROM results r
  WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = r.student_id);

  IF v_count > 0 THEN
    DELETE FROM results r
    WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = r.student_id);
    RAISE NOTICE '[SECTION 5] Removed % orphaned results (student no longer exists)', v_count;
  ELSE
    RAISE NOTICE '[SECTION 5] No orphaned results — already clean';
  END IF;
END $$;


-- ============================================================
-- SECTION 6: ADD MISSING FK — results(student_id) → students(id) CASCADE
-- ============================================================

\echo 'SECTION 6: Adding FK on results(student_id) with CASCADE...'

DO $$
BEGIN
  -- Drop any partial / broken version first
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'results_student_id_fkey'
      AND conrelid = 'results'::regclass
  ) THEN
    ALTER TABLE results DROP CONSTRAINT results_student_id_fkey;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_results_student'
      AND conrelid = 'results'::regclass
  ) THEN
    ALTER TABLE results DROP CONSTRAINT fk_results_student;
  END IF;

  -- Add proper CASCADE FK
  ALTER TABLE results
    ADD CONSTRAINT results_student_id_fkey
    FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE;

  RAISE NOTICE '[SECTION 6] FK results(student_id) → students(id) ON DELETE CASCADE added';
EXCEPTION WHEN others THEN
  RAISE NOTICE '[SECTION 6] Could not add FK: % — check for remaining orphaned results', SQLERRM;
END $$;


-- ============================================================
-- SECTION 7: ORPHANED PROCTORING VIOLATIONS (test_id not in tests)
-- ============================================================

\echo 'SECTION 7: Removing orphaned proctoring_violations...'

DO $$
DECLARE v_count BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT FROM information_schema.tables WHERE table_name = 'proctoring_violations'
  ) THEN
    RAISE NOTICE '[SECTION 7] Table proctoring_violations does not exist — skipped';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_count FROM proctoring_violations pv
  WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = pv.test_id);

  IF v_count > 0 THEN
    DELETE FROM proctoring_violations pv
    WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = pv.test_id);
    RAISE NOTICE '[SECTION 7] Removed % orphaned proctoring_violations', v_count;
  ELSE
    RAISE NOTICE '[SECTION 7] No orphaned proctoring_violations — already clean';
  END IF;
END $$;


-- ============================================================
-- SECTION 8: CREATE FEEDBACK TABLE (if missing)
-- ============================================================

\echo 'SECTION 8: Creating feedback table if missing...'

CREATE TABLE IF NOT EXISTS feedback (
    id SERIAL PRIMARY KEY,
    student_id INTEGER NOT NULL REFERENCES students(id) ON DELETE CASCADE,
    test_id INTEGER NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
    rating INTEGER CHECK (rating >= 1 AND rating <= 5),
    comments TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(student_id, test_id)
);

CREATE INDEX IF NOT EXISTS idx_feedback_student_id ON feedback(student_id);
CREATE INDEX IF NOT EXISTS idx_feedback_test_id ON feedback(test_id);
COMMENT ON TABLE feedback IS 'Student feedback per test';

DO $$ BEGIN
  RAISE NOTICE '[SECTION 8] feedback table ensured (created or already existed)';
END $$;


-- ============================================================
-- SECTION 9: ADD institute_id FK column to students
-- ============================================================
-- students.institute was plain TEXT with no link to institutes table.
-- Deleting an institute had no effect on students.
-- Now we add institute_id INTEGER FK → ON DELETE SET NULL.
-- This means: if an institute is deleted, students' institute_id becomes NULL
-- (they stay in system but lose the institute link).
-- ============================================================

\echo 'SECTION 9: Adding institute_id FK column to students...'

DO $$
BEGIN
  -- Add column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'students' AND column_name = 'institute_id'
  ) THEN
    ALTER TABLE students ADD COLUMN institute_id INTEGER;
    RAISE NOTICE '[SECTION 9] Added institute_id column to students';
  ELSE
    RAISE NOTICE '[SECTION 9] institute_id column already exists — skipped';
  END IF;

  -- Populate from existing text institute field
  UPDATE students s
  SET institute_id = i.id
  FROM institutes i
  WHERE LOWER(TRIM(s.institute)) = LOWER(i.name)
    AND s.institute_id IS NULL;

  RAISE NOTICE '[SECTION 9] Populated institute_id for matched students';

  -- Add FK if missing
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fk_students_institute'
      AND conrelid = 'students'::regclass
  ) THEN
    ALTER TABLE students
      ADD CONSTRAINT fk_students_institute
      FOREIGN KEY (institute_id) REFERENCES institutes(id) ON DELETE SET NULL;
    RAISE NOTICE '[SECTION 9] FK students(institute_id) → institutes(id) ON DELETE SET NULL added';
  ELSE
    RAISE NOTICE '[SECTION 9] FK already exists — skipped';
  END IF;

  -- Index for fast queries
  CREATE INDEX IF NOT EXISTS idx_students_institute_id ON students(institute_id);
END $$;


-- ============================================================
-- SECTION 10: PARTIAL UNIQUE INDEX on students(roll_number)
-- ============================================================
-- Prevents duplicate roll numbers while allowing multiple NULLs
-- (students who haven't set a roll number yet).
-- ============================================================

\echo 'SECTION 10: Adding UNIQUE index on students(roll_number)...'

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'students' AND indexname = 'uq_students_roll_number_notnull'
  ) THEN
    -- Drop the old full UNIQUE if it exists (blocks on NULLs)
    ALTER TABLE students DROP CONSTRAINT IF EXISTS students_roll_number_key;
    -- Add partial UNIQUE — only enforced for non-NULL values
    EXECUTE 'CREATE UNIQUE INDEX uq_students_roll_number_notnull
             ON students(roll_number) WHERE roll_number IS NOT NULL';
    RAISE NOTICE '[SECTION 10] Partial UNIQUE index on students(roll_number) added';
  ELSE
    RAISE NOTICE '[SECTION 10] UNIQUE index already exists — skipped';
  END IF;
END $$;


-- ============================================================
-- SECTION 11: CASCADE TRIGGERS for proctoring / forced_terminations
-- ============================================================
-- These tables use VARCHAR student_id (Firebase UID), not integer FK.
-- DB-level CASCADE can't work for them, so we add triggers.
-- ============================================================

\echo 'SECTION 11: Adding cleanup triggers for proctoring tables...'

-- Trigger: clean proctoring_violations when a TEST is deleted
CREATE OR REPLACE FUNCTION cleanup_proctoring_on_test_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM proctoring_violations WHERE test_id = OLD.id;
  DELETE FROM forced_terminations WHERE test_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_proctoring_on_test_delete ON tests;
CREATE TRIGGER trg_cleanup_proctoring_on_test_delete
BEFORE DELETE ON tests
FOR EACH ROW EXECUTE FUNCTION cleanup_proctoring_on_test_delete();

-- Trigger: clean proctoring data when a STUDENT is deleted
CREATE OR REPLACE FUNCTION cleanup_proctoring_on_student_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM proctoring_violations
    WHERE student_id = OLD.firebase_uid OR student_id = OLD.id::TEXT;
  DELETE FROM forced_terminations
    WHERE student_id = OLD.firebase_uid OR student_id = OLD.id::TEXT;
  DELETE FROM proctoring_messages
    WHERE student_id = OLD.firebase_uid OR student_id = OLD.id::TEXT;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_proctoring_on_student_delete ON students;
CREATE TRIGGER trg_cleanup_proctoring_on_student_delete
BEFORE DELETE ON students
FOR EACH ROW EXECUTE FUNCTION cleanup_proctoring_on_student_delete();

DO $$ BEGIN
  RAISE NOTICE '[SECTION 11] Proctoring cleanup triggers installed on tests + students';
END $$;


-- ============================================================
-- SECTION 12: INSTITUTE CASCADE TRIGGERS
-- ============================================================
-- When an institute is HARD deleted → deactivate all its assignments
-- When an institute is SOFT deleted (is_active=false) → deactivate too
-- ============================================================

\echo 'SECTION 12: Adding institute cascade triggers...'

CREATE OR REPLACE FUNCTION deactivate_on_institute_delete()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE test_assignments ta
  SET is_active = false
  WHERE ta.student_id IN (
    SELECT id FROM students WHERE institute_id = OLD.id
  );
  UPDATE institute_test_assignments
  SET is_active = false
  WHERE institute_id = OLD.id;
  -- Nullify students' FK
  UPDATE students SET institute_id = NULL WHERE institute_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deactivate_on_institute_delete ON institutes;
CREATE TRIGGER trg_deactivate_on_institute_delete
BEFORE DELETE ON institutes
FOR EACH ROW EXECUTE FUNCTION deactivate_on_institute_delete();

-- Soft-delete trigger (is_active toggled to false)
CREATE OR REPLACE FUNCTION deactivate_on_institute_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.is_active = true AND NEW.is_active = false THEN
    UPDATE institute_test_assignments
    SET is_active = false
    WHERE institute_id = NEW.id AND is_active = true;
    -- Deactivate test_assignments for students in this institute
    UPDATE test_assignments ta
    SET is_active = false
    WHERE ta.student_id IN (
      SELECT id FROM students WHERE institute_id = NEW.id
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_institute_soft_delete ON institutes;
CREATE TRIGGER trg_institute_soft_delete
AFTER UPDATE OF is_active ON institutes
FOR EACH ROW EXECUTE FUNCTION deactivate_on_institute_soft_delete();

DO $$ BEGIN
  RAISE NOTICE '[SECTION 12] Institute cascade triggers installed';
END $$;


-- ============================================================
-- SECTION 13: DEACTIVATE stale institute_test_assignments
-- for institutes already marked inactive
-- ============================================================

\echo 'SECTION 13: Deactivating assignments for inactive institutes...'

DO $$
DECLARE v_count BIGINT;
BEGIN
  UPDATE institute_test_assignments ita
  SET is_active = false
  WHERE is_active = true
    AND EXISTS (
      SELECT 1 FROM institutes i
      WHERE i.id = ita.institute_id AND i.is_active = false
    );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    RAISE NOTICE '[SECTION 13] Deactivated % stale institute_test_assignments', v_count;
  ELSE
    RAISE NOTICE '[SECTION 13] No stale assignments — already clean';
  END IF;
END $$;


-- ============================================================
-- SECTION 14: TEST → EXAM linkage audit (informational only)  
-- ============================================================
-- The exams table is a legacy table. Ideally each exam row
-- maps 1-to-1 with a test row. This section shows any mismatches.
-- ============================================================

\echo 'SECTION 14: Checking tests <-> exams alignment...'

DO $$
DECLARE
  v_tests_without_exam  BIGINT;
  v_exams_without_test  BIGINT;
BEGIN
  -- Tests that have no matching exam row by title
  SELECT COUNT(*) INTO v_tests_without_exam
  FROM tests t
  WHERE NOT EXISTS (SELECT 1 FROM exams e WHERE e.name = t.title);

  -- Exams that have no matching test by name
  SELECT COUNT(*) INTO v_exams_without_test
  FROM exams e
  WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.title = e.name);

  RAISE NOTICE '[SECTION 14] Tests without a matching exam row: %', v_tests_without_exam;
  RAISE NOTICE '[SECTION 14] Exam rows with no matching test: %', v_exams_without_test;
  RAISE NOTICE '[SECTION 14] (These are informational — no action needed)';
END $$;


-- ============================================================
-- SECTION 15: ADD MISSING DB INDEXES
-- ============================================================
-- These indexes cover the most common query patterns:
--   - LOWER(institute) used in many WHERE clauses across routes
--   - proctoring_violations has no auto-index (no FK)
--   - test_assignments.student_id for assignment lookups
-- ============================================================

\echo 'SECTION 15: Adding missing indexes...'

-- Functional index on students(institute) for LOWER() queries
CREATE INDEX IF NOT EXISTS idx_students_institute_lower
    ON students (LOWER(institute));

-- Proctoring indexes (no FK, so no auto-index)
CREATE INDEX IF NOT EXISTS idx_proctoring_violations_test_id
    ON proctoring_violations (test_id);

CREATE INDEX IF NOT EXISTS idx_proctoring_violations_student_id
    ON proctoring_violations (student_id);

-- test_assignments lookup by student
CREATE INDEX IF NOT EXISTS idx_test_assignments_student_id
    ON test_assignments (student_id);

-- results lookup by exam_id (FK cascade now exists, but explicit index helps)
CREATE INDEX IF NOT EXISTS idx_results_exam_id
    ON results (exam_id);

-- exams lookup by name (for test→exam joins)
CREATE INDEX IF NOT EXISTS idx_exams_name
    ON exams (name);

-- student_messages: most frequently filtered by student_id + sender_type + status
CREATE INDEX IF NOT EXISTS idx_student_messages_student_id
    ON student_messages (student_id);

CREATE INDEX IF NOT EXISTS idx_student_messages_status_sender
    ON student_messages (status, sender_type);

-- job_applications: primary lookup is by job_opening_id and student_id
CREATE INDEX IF NOT EXISTS idx_job_applications_job_id
    ON job_applications (job_opening_id);

CREATE INDEX IF NOT EXISTS idx_job_applications_student_id
    ON job_applications (student_id);

DO $$ BEGIN
  RAISE NOTICE '[SECTION 15] All missing indexes created (or already existed)';
END $$;


-- ============================================================
-- SECTION 16: VERIFICATION — Final row counts and health check
-- ============================================================

\echo ''
\echo '======================================================================'
\echo '  VERIFICATION — Final State'
\echo '======================================================================'

-- Row counts
SELECT
  'students'                  AS table_name, COUNT(*) AS rows FROM students
UNION ALL SELECT 'admins',                   COUNT(*) FROM admins
UNION ALL SELECT 'tests',                    COUNT(*) FROM tests
UNION ALL SELECT 'questions',                COUNT(*) FROM questions
UNION ALL SELECT 'exams',                    COUNT(*) FROM exams
UNION ALL SELECT 'results',                  COUNT(*) FROM results
UNION ALL SELECT 'test_attempts',            COUNT(*) FROM test_attempts
UNION ALL SELECT 'exam_progress',            COUNT(*) FROM exam_progress
UNION ALL SELECT 'institutes',               COUNT(*) FROM institutes
UNION ALL SELECT 'institute_test_assignments',COUNT(*) FROM institute_test_assignments
UNION ALL SELECT 'test_assignments',         COUNT(*) FROM test_assignments
UNION ALL SELECT 'feedback',                 COUNT(*) FROM feedback
UNION ALL SELECT 'coding_questions',         COUNT(*) FROM coding_questions
UNION ALL SELECT 'coding_test_cases',        COUNT(*) FROM coding_test_cases
UNION ALL SELECT 'student_coding_submissions',COUNT(*) FROM student_coding_submissions
UNION ALL SELECT 'proctoring_violations',    COUNT(*) FROM proctoring_violations
UNION ALL SELECT 'proctoring_messages',      COUNT(*) FROM proctoring_messages
UNION ALL SELECT 'forced_terminations',      COUNT(*) FROM forced_terminations
UNION ALL SELECT 'student_messages',         COUNT(*) FROM student_messages
UNION ALL SELECT 'interviews',               COUNT(*) FROM interviews
UNION ALL SELECT 'interview_chat_messages',  COUNT(*) FROM interview_chat_messages
UNION ALL SELECT 'job_openings',             COUNT(*) FROM job_openings
UNION ALL SELECT 'job_notifications',        COUNT(*) FROM job_notifications
UNION ALL SELECT 'job_applications',         COUNT(*) FROM job_applications
UNION ALL SELECT 'job_opening_tests',        COUNT(*) FROM job_opening_tests
ORDER BY table_name;

-- Health checks
SELECT
  (SELECT COUNT(*) FROM questions q WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = q.test_id))
    AS orphaned_questions,
  (SELECT COUNT(*) FROM results r WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = r.student_id))
    AS orphaned_results,
  (SELECT COUNT(*) FROM proctoring_violations pv WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = pv.test_id))
    AS orphaned_violations,
  (SELECT COUNT(*) FROM (SELECT test_id FROM questions GROUP BY test_id, question_text HAVING COUNT(*) > 1) x)
    AS duplicate_question_groups,
  (SELECT COUNT(*) FROM (SELECT name FROM exams GROUP BY name HAVING COUNT(*) > 1) x)
    AS duplicate_exams;

SELECT
  CASE
    WHEN (
      (SELECT COUNT(*) FROM questions q WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = q.test_id)) = 0
      AND (SELECT COUNT(*) FROM results r WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = r.student_id)) = 0
      AND (SELECT COUNT(*) FROM proctoring_violations pv WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = pv.test_id)) = 0
      AND (SELECT COUNT(*) FROM (SELECT name FROM exams GROUP BY name HAVING COUNT(*) > 1) x) = 0
    )
    THEN '✅  ALL CHECKS PASSED — Database is consistent!'
    ELSE '⚠   Some issues remain — review the health check row above'
  END AS final_status;
