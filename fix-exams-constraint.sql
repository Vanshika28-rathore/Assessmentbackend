-- Fix exams table unique constraint for ON CONFLICT support
-- Step 1: Remove duplicate exam names, keep only the oldest one

-- Delete duplicate exams, keeping only the one with the smallest ID
DELETE FROM exams a
USING exams b
WHERE a.id > b.id 
  AND a.name = b.name;

-- Step 2: Add unique constraint
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'exams_name_unique'
    ) THEN
        ALTER TABLE exams ADD CONSTRAINT exams_name_unique UNIQUE (name);
    END IF;
END $$;
