-- ============================================================
-- STEP 1: Diagnose current status distribution
-- ============================================================
SELECT status, COUNT(*) AS count
FROM job_applications
GROUP BY status
ORDER BY count DESC;

-- ============================================================
-- STEP 2: Fix wrongly-rejected students where passed_assessment = true
-- and violations <= 5 (simplest case)
-- ============================================================
UPDATE job_applications ja
SET status = 'shortlisted',
    passed_assessment = true,
    updated_at = CURRENT_TIMESTAMP
WHERE ja.status = 'rejected'
  AND ja.passed_assessment = true
  AND (
      SELECT COUNT(*)
      FROM proctoring_violations pv
      WHERE pv.student_id = ja.student_id::varchar
        AND pv.test_id IN (
            SELECT test_id FROM job_opening_tests WHERE job_opening_id = ja.job_opening_id
        )
  ) <= 5;

-- ============================================================
-- STEP 3: Fix applications stuck at assessment_completed
-- ============================================================
UPDATE job_applications ja
SET status = CASE
    WHEN ja.passed_assessment = true
         AND (
             SELECT COUNT(*)
             FROM proctoring_violations pv
             WHERE pv.student_id = ja.student_id::varchar
               AND pv.test_id IN (
                   SELECT test_id FROM job_opening_tests WHERE job_opening_id = ja.job_opening_id
               )
         ) <= 5
    THEN 'shortlisted'
    ELSE 'rejected'
END,
updated_at = CURRENT_TIMESTAMP
WHERE ja.status = 'assessment_completed'
  AND ja.passed_assessment IS NOT NULL;

-- ============================================================
-- STEP 4: Fix students stuck at assessment_assigned/submitted/screening
-- who have completed all tests ASSIGNED TO THEM
-- Uses per-student assigned test count, not total job tests
-- ============================================================
UPDATE job_applications ja
SET status = CASE
    WHEN COALESCE(
        (
            SELECT bool_and(ta.percentage >= t.passing_percentage)
            FROM test_attempts ta
            INNER JOIN tests t ON ta.test_id = t.id
            WHERE ta.job_application_id = ja.id
              AND ta.student_id = ja.student_id
        ), false
    ) = true
    AND (
        SELECT COUNT(*)
        FROM proctoring_violations pv
        WHERE pv.student_id = ja.student_id::varchar
          AND pv.test_id IN (
              SELECT test_id FROM job_opening_tests WHERE job_opening_id = ja.job_opening_id
          )
    ) <= 5
    THEN 'shortlisted'
    ELSE 'rejected'
END,
passed_assessment = COALESCE(
    (
        SELECT bool_and(ta.percentage >= t.passing_percentage)
        FROM test_attempts ta
        INNER JOIN tests t ON ta.test_id = t.id
        WHERE ta.job_application_id = ja.id
          AND ta.student_id = ja.student_id
    ), false
),
assessment_score = (
    SELECT AVG(ta.percentage)
    FROM test_attempts ta
    WHERE ta.job_application_id = ja.id
      AND ta.student_id = ja.student_id
),
test_completed_at = CURRENT_TIMESTAMP,
updated_at = CURRENT_TIMESTAMP
WHERE ja.status IN ('assessment_assigned', 'submitted', 'screening')
  AND (
      -- Student completed all tests assigned to them for this job
      SELECT COUNT(DISTINCT ta.test_id)
      FROM test_attempts ta
      WHERE ta.job_application_id = ja.id
        AND ta.student_id = ja.student_id
  ) >= (
      -- Count only tests this student is actually assigned to
      SELECT COUNT(DISTINCT jot.test_id)
      FROM job_opening_tests jot
      INNER JOIN test_assignments tasgn ON tasgn.test_id = jot.test_id
          AND tasgn.student_id = ja.student_id
          AND tasgn.is_active = true
      WHERE jot.job_opening_id = ja.job_opening_id
  )
  AND (
      SELECT COUNT(DISTINCT jot.test_id)
      FROM job_opening_tests jot
      INNER JOIN test_assignments tasgn ON tasgn.test_id = jot.test_id
          AND tasgn.student_id = ja.student_id
          AND tasgn.is_active = true
      WHERE jot.job_opening_id = ja.job_opening_id
  ) > 0;

-- ============================================================
-- STEP 5: Normalize remaining legacy statuses → assessment_assigned
-- ============================================================
UPDATE job_applications
SET status = 'assessment_assigned',
    updated_at = CURRENT_TIMESTAMP
WHERE status IN ('submitted', 'screening');

-- ============================================================
-- STEP 6: THE KEY FIX — recalculate ALL rejected students from scratch
-- using live test_attempts + live violation counts + per-student assigned tests
-- ============================================================
UPDATE job_applications ja
SET status = 'shortlisted',
    passed_assessment = true,
    assessment_score = (
        SELECT AVG(ta.percentage)
        FROM test_attempts ta
        WHERE ta.job_application_id = ja.id
          AND ta.student_id = ja.student_id
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE ja.status = 'rejected'
  AND (
      -- Completed all tests assigned to them
      SELECT COUNT(DISTINCT ta.test_id)
      FROM test_attempts ta
      WHERE ta.job_application_id = ja.id
        AND ta.student_id = ja.student_id
  ) >= (
      SELECT COUNT(DISTINCT jot.test_id)
      FROM job_opening_tests jot
      INNER JOIN test_assignments tasgn ON tasgn.test_id = jot.test_id
          AND tasgn.student_id = ja.student_id
          AND tasgn.is_active = true
      WHERE jot.job_opening_id = ja.job_opening_id
  )
  AND (
      SELECT COUNT(DISTINCT jot.test_id)
      FROM job_opening_tests jot
      INNER JOIN test_assignments tasgn ON tasgn.test_id = jot.test_id
          AND tasgn.student_id = ja.student_id
          AND tasgn.is_active = true
      WHERE jot.job_opening_id = ja.job_opening_id
  ) > 0
  -- Actually passed all tests
  AND COALESCE(
      (
          SELECT bool_and(ta.percentage >= t.passing_percentage)
          FROM test_attempts ta
          INNER JOIN tests t ON ta.test_id = t.id
          WHERE ta.job_application_id = ja.id
            AND ta.student_id = ja.student_id
      ), false
  ) = true
  -- Not flagged (violations scoped to THIS job's tests only)
  AND (
      SELECT COUNT(*)
      FROM proctoring_violations pv
      WHERE pv.student_id = ja.student_id::varchar
        AND pv.test_id IN (
            SELECT test_id FROM job_opening_tests WHERE job_opening_id = ja.job_opening_id
        )
  ) <= 5;

-- ============================================================
-- STEP 7: Verify final state
-- ============================================================
SELECT status, COUNT(*) AS count
FROM job_applications
GROUP BY status
ORDER BY count DESC;

-- ============================================================
-- STEP 8: Full diagnostic — shows every student with actual pass/violation status
-- Run this to see exactly who should be shortlisted vs rejected
-- ============================================================
SELECT
    ja.id AS application_id,
    s.full_name,
    s.email,
    ja.status AS current_status,
    ja.passed_assessment,
    COALESCE(
        (SELECT bool_and(ta.percentage >= t.passing_percentage)
         FROM test_attempts ta INNER JOIN tests t ON ta.test_id = t.id
         WHERE ta.job_application_id = ja.id AND ta.student_id = ja.student_id),
        false
    ) AS actually_passed,
    (SELECT COUNT(*) FROM proctoring_violations pv
     WHERE pv.student_id = ja.student_id::varchar
       AND pv.test_id IN (SELECT test_id FROM job_opening_tests WHERE job_opening_id = ja.job_opening_id)
    ) AS job_violation_count,
    (SELECT COUNT(DISTINCT ta.test_id) FROM test_attempts ta WHERE ta.job_application_id = ja.id) AS tests_completed,
    (SELECT COUNT(DISTINCT jot.test_id)
     FROM job_opening_tests jot
     INNER JOIN test_assignments tasgn ON tasgn.test_id = jot.test_id
         AND tasgn.student_id = ja.student_id AND tasgn.is_active = true
     WHERE jot.job_opening_id = ja.job_opening_id
    ) AS tests_assigned_to_student
FROM job_applications ja
INNER JOIN students s ON s.id = ja.student_id
ORDER BY ja.status, s.full_name;
