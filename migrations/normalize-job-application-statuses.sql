-- ============================================================
-- STEP 1: Diagnose current status distribution
-- ============================================================
SELECT status, COUNT(*) AS count
FROM job_applications
GROUP BY status
ORDER BY count DESC;

-- ============================================================
-- STEP 2: Fix test_attempts rows where job_application_id is NULL
-- Only update rows that don't already have a non-null duplicate
-- ============================================================
UPDATE test_attempts ta
SET job_application_id = ja.id
FROM job_applications ja
WHERE ta.job_application_id IS NULL
  AND ta.student_id = ja.student_id
  AND ta.test_id IN (
      SELECT test_id FROM job_opening_tests WHERE job_opening_id = ja.job_opening_id
  )
  -- Skip if a row with this (student_id, test_id, job_application_id) already exists
  AND NOT EXISTS (
      SELECT 1 FROM test_attempts ta2
      WHERE ta2.student_id = ja.student_id
        AND ta2.test_id = ta.test_id
        AND ta2.job_application_id = ja.id
        AND ta2.id != ta.id
  );

-- ============================================================
-- STEP 2b: Delete remaining NULL job_application_id rows
-- that are true duplicates (already have a proper linked row)
-- ============================================================
DELETE FROM test_attempts
WHERE job_application_id IS NULL
  AND EXISTS (
      SELECT 1 FROM test_attempts ta2
      WHERE ta2.student_id = test_attempts.student_id
        AND ta2.test_id = test_attempts.test_id
        AND ta2.job_application_id IS NOT NULL
  );

-- ============================================================
-- STEP 3: Fix applications stuck at assessment_completed
-- Sets shortlisted if passed_assessment=true, rejected if false
-- ============================================================
UPDATE job_applications
SET status = CASE 
    WHEN passed_assessment = true THEN 'shortlisted'
    WHEN passed_assessment = false THEN 'rejected'
    ELSE status
END,
updated_at = CURRENT_TIMESTAMP
WHERE status = 'assessment_completed'
  AND passed_assessment IS NOT NULL;

-- ============================================================
-- STEP 4: Normalize remaining legacy statuses → assessment_assigned
-- ============================================================
UPDATE job_applications
SET status = 'assessment_assigned',
    updated_at = CURRENT_TIMESTAMP
WHERE status IN ('submitted', 'screening');

-- ============================================================
-- STEP 5: Verify final state
-- ============================================================
SELECT status, COUNT(*) AS count
FROM job_applications
GROUP BY status
ORDER BY count DESC;
