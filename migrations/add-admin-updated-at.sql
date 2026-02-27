-- Add updated_at, phone, and address columns to admins table
ALTER TABLE admins 
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN IF NOT EXISTS phone VARCHAR(20),
ADD COLUMN IF NOT EXISTS address TEXT;

-- Update existing records to have updated_at = created_at
UPDATE admins 
SET updated_at = created_at 
WHERE updated_at IS NULL;

-- Add comments for documentation
COMMENT ON COLUMN admins.updated_at IS 'Timestamp when admin profile was last updated';
COMMENT ON COLUMN admins.phone IS 'Admin phone number';
COMMENT ON COLUMN admins.address IS 'Admin address';