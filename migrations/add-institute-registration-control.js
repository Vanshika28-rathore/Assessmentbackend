const { pool } = require('../config/db');

async function addInstituteRegistrationControl() {
    const client = await pool.connect();
    
    try {
        console.log('🔧 Starting institute registration control migration...');
        
        await client.query('BEGIN');
        
        // Add registration_deadline column (TIMESTAMPTZ for timezone support)
        console.log('Adding registration_deadline column...');
        await client.query(`
            ALTER TABLE institutes 
            ADD COLUMN IF NOT EXISTS registration_deadline TIMESTAMPTZ
        `);
        
        // Add registration_status column with default 'open'
        console.log('Adding registration_status column...');
        await client.query(`
            ALTER TABLE institutes 
            ADD COLUMN IF NOT EXISTS registration_status VARCHAR(20) DEFAULT 'open'
        `);
        
        // Add check constraint for valid status values
        console.log('Adding status constraint...');
        await client.query(`
            DO $$ 
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint 
                    WHERE conname = 'institutes_registration_status_check'
                ) THEN
                    ALTER TABLE institutes 
                    ADD CONSTRAINT institutes_registration_status_check 
                    CHECK (registration_status IN ('open', 'closed', 'paused'));
                END IF;
            END $$;
        `);
        
        // Add comments for documentation
        await client.query(`
            COMMENT ON COLUMN institutes.registration_deadline IS 'Deadline for student registration (IST timezone stored as UTC)';
        `);
        
        await client.query(`
            COMMENT ON COLUMN institutes.registration_status IS 'Registration status: open, closed, paused';
        `);
        
        // Create index for faster queries
        console.log('Creating index...');
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_institutes_registration_status 
            ON institutes(registration_status);
        `);
        
        await client.query('COMMIT');
        
        console.log('✅ Institute registration control migration completed successfully!');
        console.log('📋 Summary:');
        console.log('   - Added registration_deadline column (TIMESTAMPTZ)');
        console.log('   - Added registration_status column (open/closed/paused)');
        console.log('   - Added constraint for valid status values');
        console.log('   - Created index for performance');
        
    } catch (error) {
        await client.query('ROLLBACK');
        console.error('❌ Migration failed:', error);
        throw error;
    } finally {
        client.release();
    }
}

// Run migration if called directly
if (require.main === module) {
    addInstituteRegistrationControl()
        .then(() => {
            console.log('Migration completed. Exiting...');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Migration failed:', error);
            process.exit(1);
        });
}

module.exports = addInstituteRegistrationControl;
