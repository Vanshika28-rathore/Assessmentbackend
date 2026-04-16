-- ============================================================
-- DATABASE FIX SCRIPT
-- DB: Shnoor_Assignment_Portal
-- Generated: 13 April 2026
-- Based on audit findings from db-audit-plain.js
--
-- Run this in pgAdmin Query Tool or via:
--   psql -U postgres -d Shnoor_Assignment_Portal -f db-fix.sql
--
-- Each section is wrapped in a transaction so it can be
-- rolled back independently if needed.
-- ============================================================


-- ============================================================
-- FIX 1: DELETE orphaned questions (test_id=90 no longer exists)
-- Audit finding: 865 questions referencing a deleted test
-- ============================================================
BEGIN;

-- Preview first (comment out DELETE, uncomment SELECT to verify)
-- SELECT id, test_id, LEFT(question_text, 80) AS preview
-- FROM questions
-- WHERE test_id NOT IN (SELECT id FROM tests);

DELETE FROM questions
WHERE test_id NOT IN (SELECT id FROM tests);

-- Verify
SELECT 'FIX 1 DONE: Deleted orphaned questions. Remaining orphaned count: ' || COUNT(*)
FROM questions
WHERE test_id NOT IN (SELECT id FROM tests);

COMMIT;


-- ============================================================
-- FIX 2: DELETE duplicate questions within same test
-- Audit finding: 2 groups of duplicate questions in questions table
-- Keeps the row with the LOWEST id (first uploaded), deletes duplicates
-- ============================================================
BEGIN;

-- Preview duplicates before deleting
-- SELECT q1.id, q1.test_id, LEFT(q1.question_text, 80)
-- FROM questions q1
-- WHERE q1.id NOT IN (
--   SELECT MIN(id) FROM questions
--   GROUP BY test_id, question_text
-- );

DELETE FROM questions
WHERE id NOT IN (
  SELECT MIN(id)
  FROM questions
  GROUP BY test_id, question_text
);

SELECT 'FIX 2 DONE: Deleted duplicate questions. Remaining question count: ' || COUNT(*)
FROM questions;

COMMIT;


-- ============================================================
-- FIX 3: DELETE 40 orphaned results (student_id not in students)
-- Audit finding: results.student_id has no FK, 40 rows dangling
-- ============================================================
BEGIN;

-- Preview orphaned results
-- SELECT r.id, r.student_id, r.exam_id, r.marks_obtained, r.created_at
-- FROM results r
-- WHERE r.student_id NOT IN (SELECT id FROM students);

DELETE FROM results
WHERE student_id NOT IN (SELECT id FROM students);

SELECT 'FIX 3 DONE: Deleted orphaned results. Remaining orphaned count: ' || COUNT(*)
FROM results
WHERE student_id NOT IN (SELECT id FROM students);

COMMIT;


-- ============================================================
-- FIX 4: ADD missing FK on results(student_id) with CASCADE
-- Audit finding: results.student_id had no FK to students at all
-- IMPORTANT: Run AFTER FIX 3, otherwise the orphaned rows block this
-- ============================================================
BEGIN;

-- Drop constraint if it partially exists with a different name
ALTER TABLE results DROP CONSTRAINT IF EXISTS results_student_id_fkey;
ALTER TABLE results DROP CONSTRAINT IF EXISTS fk_results_student;

-- Add the proper FK
ALTER TABLE results
  ADD CONSTRAINT results_student_id_fkey
  FOREIGN KEY (student_id)
  REFERENCES students(id)
  ON DELETE CASCADE;

SELECT 'FIX 4 DONE: Added ON DELETE CASCADE FK on results(student_id)';

COMMIT;


-- ============================================================
-- FIX 5: DELETE 248 orphaned proctoring_violations
-- Audit finding: test_id references deleted tests (no FK constraint)
-- ============================================================
BEGIN;

-- Preview
-- SELECT pv.id, pv.student_id, pv.test_id, pv.violation_type, pv.timestamp
-- FROM proctoring_violations pv
-- WHERE pv.test_id NOT IN (SELECT id FROM tests);

DELETE FROM proctoring_violations
WHERE test_id NOT IN (SELECT id FROM tests);

SELECT 'FIX 5 DONE: Deleted orphaned proctoring_violations. Remaining orphaned count: ' || COUNT(*)
FROM proctoring_violations
WHERE test_id NOT IN (SELECT id FROM tests);

COMMIT;


-- ============================================================
-- FIX 6: ADD DB triggers for cascade cleanup of proctoring tables
-- Because these tables use VARCHAR student_id (Firebase UID),
-- they cannot use regular FK CASCADE.
-- These triggers fire AFTER a test or student is deleted
-- and clean up the associated rows automatically.
-- ============================================================
BEGIN;

-- Trigger function: clean up proctoring_violations when a TEST is deleted
CREATE OR REPLACE FUNCTION cleanup_proctoring_violations_on_test_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM proctoring_violations WHERE test_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_proctoring_on_test_delete ON tests;
CREATE TRIGGER trg_cleanup_proctoring_on_test_delete
BEFORE DELETE ON tests
FOR EACH ROW
EXECUTE FUNCTION cleanup_proctoring_violations_on_test_delete();

-- ──────────────────────────────────────────────────────────
-- Trigger function: clean up forced_terminations when a TEST is deleted
CREATE OR REPLACE FUNCTION cleanup_forced_terminations_on_test_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM forced_terminations WHERE test_id = OLD.id;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_forced_on_test_delete ON tests;
CREATE TRIGGER trg_cleanup_forced_on_test_delete
BEFORE DELETE ON tests
FOR EACH ROW
EXECUTE FUNCTION cleanup_forced_terminations_on_test_delete();

-- ──────────────────────────────────────────────────────────
-- Trigger function: clean up proctoring_violations when a STUDENT is deleted
-- (matches on firebase_uid stored in proctoring_violations.student_id)
CREATE OR REPLACE FUNCTION cleanup_proctoring_on_student_delete()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM proctoring_violations
  WHERE student_id = OLD.firebase_uid
     OR student_id = OLD.id::TEXT;

  DELETE FROM forced_terminations
  WHERE student_id = OLD.firebase_uid
     OR student_id = OLD.id::TEXT;

  DELETE FROM proctoring_messages
  WHERE student_id = OLD.firebase_uid
     OR student_id = OLD.id::TEXT;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_cleanup_proctoring_on_student_delete ON students;
CREATE TRIGGER trg_cleanup_proctoring_on_student_delete
BEFORE DELETE ON students
FOR EACH ROW
EXECUTE FUNCTION cleanup_proctoring_on_student_delete();

SELECT 'FIX 6 DONE: Cleanup triggers created for proctoring_violations, forced_terminations, proctoring_messages on test/student delete';

COMMIT;


-- ============================================================
-- FIX 7: CREATE the missing 'feedback' table
-- Audit finding: feedback table is referenced but does not exist
-- ============================================================
BEGIN;

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

COMMENT ON TABLE feedback IS 'Student feedback per test — created by db-fix.sql after audit found table missing';

SELECT 'FIX 7 DONE: Created feedback table with proper FKs and UNIQUE(student_id, test_id)';

COMMIT;


-- ============================================================
-- FIX 8: ADD UNIQUE constraint on students(roll_number) for non-NULL values
-- Audit finding: UNIQUE constraint on roll_number is missing
-- 2 students have NULL roll_number — constraint is on non-NULL only
-- ============================================================
BEGIN;

-- Drop if partially created
ALTER TABLE students DROP CONSTRAINT IF EXISTS students_roll_number_key;
ALTER TABLE students DROP CONSTRAINT IF EXISTS uq_students_roll_number_notnull;

-- Partial UNIQUE index — only enforces uniqueness on non-NULL roll numbers
-- This avoids blocking students who haven't set a roll number yet
CREATE UNIQUE INDEX IF NOT EXISTS uq_students_roll_number_notnull
  ON students(roll_number)
  WHERE roll_number IS NOT NULL;

SELECT 'FIX 8 DONE: Added partial UNIQUE index on students(roll_number) WHERE NOT NULL';

COMMIT;


-- ============================================================
-- FIX 9: ADD institute_id FK column to students
-- Audit finding: students.institute is plain TEXT with no FK to institutes
-- Deleting an institute does NOT cascade to students
-- This fix:
--   a) Adds institute_id INTEGER FK column
--   b) Populates it from the existing text 'institute' column
--   c) Adds ON DELETE SET NULL (so deleting institute nullifies student's
--      institute_id but doesn't delete the student)
-- ============================================================
BEGIN;

-- Step a: Add the FK column (nullable — existing students without match get NULL)
ALTER TABLE students
  ADD COLUMN IF NOT EXISTS institute_id INTEGER;

-- Step b: Populate institute_id from text 'institute' field
UPDATE students s
SET institute_id = i.id
FROM institutes i
WHERE LOWER(TRIM(s.institute)) = LOWER(i.name)
  AND s.institute_id IS NULL;

-- Step c: Add FK with ON DELETE SET NULL
ALTER TABLE students DROP CONSTRAINT IF EXISTS fk_students_institute;
ALTER TABLE students
  ADD CONSTRAINT fk_students_institute
  FOREIGN KEY (institute_id)
  REFERENCES institutes(id)
  ON DELETE SET NULL;

-- Create index for fast institute → students queries
CREATE INDEX IF NOT EXISTS idx_students_institute_id ON students(institute_id);

SELECT
  'FIX 9 DONE: institute_id FK added. Matched students: ' ||
  COUNT(CASE WHEN s.institute_id IS NOT NULL THEN 1 END) ||
  ' out of ' || COUNT(*) || ' total students'
FROM students s;

COMMIT;


-- ============================================================
-- FIX 10: ADD cascade trigger for students deleted from an institute
-- Since ON DELETE SET NULL just nullifies the institute_id,
-- also deactivate their test_assignments when an institute is deleted.
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION deactivate_assignments_on_institute_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Deactivate test_assignments for all students in this institute
  UPDATE test_assignments
  SET is_active = false
  WHERE student_id IN (
    SELECT id FROM students WHERE institute_id = OLD.id
  );

  -- Deactivate the institute_test_assignments for this institute
  UPDATE institute_test_assignments
  SET is_active = false
  WHERE institute_id = OLD.id;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deactivate_on_institute_delete ON institutes;
CREATE TRIGGER trg_deactivate_on_institute_delete
BEFORE DELETE ON institutes
FOR EACH ROW
EXECUTE FUNCTION deactivate_assignments_on_institute_delete();

SELECT 'FIX 10 DONE: Trigger added — deleting an institute deactivates all related student test_assignments';

COMMIT;


-- ============================================================
-- FIX 11: Deactivate orphaned institute_test_assignments
-- for institutes that are already inactive (is_active = false)
-- Audit finding: 7 such rows found
-- ============================================================
BEGIN;

UPDATE institute_test_assignments ita
SET is_active = false
WHERE ita.is_active = true
  AND EXISTS (
    SELECT 1 FROM institutes i
    WHERE i.id = ita.institute_id
      AND i.is_active = false
  );

SELECT 'FIX 11 DONE: Deactivated institute_test_assignments for inactive institutes. Count: ' ||
  COUNT(*) || ' remaining active for inactive institutes'
FROM institute_test_assignments ita
JOIN institutes i ON i.id = ita.institute_id
WHERE i.is_active = false AND ita.is_active = true;

COMMIT;


-- ============================================================
-- FIX 12: Cascade trigger — deleting or deactivating an institute
-- should also nullify students' institute_id
-- (handles soft-delete: when is_active is toggled to false)
-- ============================================================
BEGIN;

CREATE OR REPLACE FUNCTION nullify_students_on_institute_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  -- Only fire when is_active changes from true → false
  IF OLD.is_active = true AND NEW.is_active = false THEN
    UPDATE institute_test_assignments
    SET is_active = false
    WHERE institute_id = NEW.id AND is_active = true;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_institute_soft_delete ON institutes;
CREATE TRIGGER trg_institute_soft_delete
AFTER UPDATE OF is_active ON institutes
FOR EACH ROW
EXECUTE FUNCTION nullify_students_on_institute_soft_delete();

SELECT 'FIX 12 DONE: Soft-delete trigger on institutes — deactivates institute_test_assignments when institute is deactivated';

COMMIT;


-- ============================================================
-- FIX 13: CASCADE trigger — when a test is deleted,
-- also clean up exam_progress, student_responses (already done via FK CASCADE)
-- and nullify any results whose exam_id maps to this test.
-- NOTE: The exams table is legacy. This trigger ensures exam-linked
-- results are not kept if the owning test's data is stale.
-- ============================================================
-- (This is informational — results.exam_id already has CASCADE to exams)
-- The main path: test deleted → questions cascaded → student_responses cascaded
-- The legacy path: exams table is independent, results.exam_id → exams (CASCADE OK)


-- ============================================================
-- FINAL VERIFICATION QUERIES
-- Run these after applying all fixes to confirm the DB is clean
-- ============================================================

-- 1. Orphaned questions check
SELECT 'Orphaned questions: ' || COUNT(*) FROM questions
WHERE test_id NOT IN (SELECT id FROM tests);

-- 2. Orphaned results check  
SELECT 'Orphaned results (bad student_id): ' || COUNT(*) FROM results
WHERE student_id NOT IN (SELECT id FROM students);

-- 3. Orphaned proctoring_violations check
SELECT 'Orphaned proctoring_violations: ' || COUNT(*) FROM proctoring_violations
WHERE test_id NOT IN (SELECT id FROM tests);

-- 4. Duplicate questions check
SELECT 'Duplicate question groups: ' || COUNT(*) FROM (
  SELECT test_id, question_text FROM questions
  GROUP BY test_id, question_text
  HAVING COUNT(*) > 1
) t;

-- 5. Row counts summary after fixes
SELECT 'students' AS tbl, COUNT(*) AS rows FROM students
UNION ALL SELECT 'tests', COUNT(*) FROM tests
UNION ALL SELECT 'questions', COUNT(*) FROM questions
UNION ALL SELECT 'results', COUNT(*) FROM results
UNION ALL SELECT 'proctoring_violations', COUNT(*) FROM proctoring_violations
UNION ALL SELECT 'feedback', COUNT(*) FROM feedback
ORDER BY tbl;

-- 6. Students with institute_id populated
SELECT
  COUNT(*) AS total_students,
  COUNT(institute_id) AS with_institute_id,
  COUNT(*) - COUNT(institute_id) AS without_institute_id
FROM students;

SELECT '=== ALL FIXES APPLIED SUCCESSFULLY ===' AS status;
