-- ============================================================
-- EXAMS TABLE DEDUPLICATION SCRIPT
-- Run this in pgAdmin Query Tool (connected to your production DB)
--
-- Problem: Every exam submission creates a NEW row in 'exams'
-- instead of reusing an existing one. Result: 2114 rows for ~50 tests.
--
-- Fix strategy:
--   1. For each unique exam name, keep the LOWEST id (first ever created)
--   2. Re-point all results rows to the kept id
--   3. Delete the duplicate exam rows
--   4. Add UNIQUE constraint so this never happens again
-- ============================================================


-- ── STEP 0: Preview — see what will be kept vs deleted ──────────────────
-- Run this first to verify it looks correct before deleting anything

SELECT
  e.name,
  COUNT(*) AS total_duplicates,
  MIN(e.id) AS will_keep_id,
  COUNT(r.id) AS total_results_linked
FROM exams e
LEFT JOIN results r ON r.exam_id = e.id
GROUP BY e.name
ORDER BY total_duplicates DESC;

-- Expected: each name appears once, with total_duplicates showing how many
-- exam rows will be collapsed into 1. Total results should stay intact.


-- ── STEP 1: Re-point all results to the canonical (lowest id) exam row ──
BEGIN;

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

-- Check: how many results were re-pointed
SELECT 'Results re-pointed: ' || COUNT(*) 
FROM results r
WHERE r.exam_id IN (
  SELECT id FROM exams
  WHERE id NOT IN (SELECT MIN(id) FROM exams GROUP BY name)
);

COMMIT;


-- ── STEP 2: Delete all duplicate exam rows (non-canonical ones) ─────────
BEGIN;

DELETE FROM exams
WHERE id NOT IN (
  SELECT MIN(id) FROM exams GROUP BY name
);

SELECT 'Remaining exam rows after dedup: ' || COUNT(*) FROM exams;

COMMIT;


-- ── STEP 3: Add UNIQUE constraint on exams(name) ─────────────────────────
-- This prevents future duplicates at the DB level
BEGIN;

ALTER TABLE exams DROP CONSTRAINT IF EXISTS exams_name_key;
ALTER TABLE exams ADD CONSTRAINT exams_name_key UNIQUE (name);

SELECT 'UNIQUE constraint added on exams(name)';

COMMIT;


-- ── STEP 4: Verify the final state ──────────────────────────────────────
SELECT 
  e.id,
  e.name,
  e.date,
  COUNT(r.id) AS result_count
FROM exams e
LEFT JOIN results r ON r.exam_id = e.id
GROUP BY e.id, e.name, e.date
ORDER BY e.name;

SELECT 'Total exam rows: ' || COUNT(*) FROM exams;
SELECT 'Total results rows: ' || COUNT(*) FROM results;
SELECT 'Orphaned results (no exam): ' || COUNT(*) 
FROM results r 
WHERE NOT EXISTS (SELECT 1 FROM exams e WHERE e.id = r.exam_id);
