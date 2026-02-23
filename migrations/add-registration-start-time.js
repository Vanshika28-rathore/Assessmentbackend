const { pool } = require('../config/db');

async function addRegistrationStartTime() {
    const client = await pool.connect();
    
    try {
        console.log('🔧 Adding registration start time column...');
        
        await client.query('BEGIN');
        
        // Add registration_start_time column
        console.log('Adding registration_start_time column...');
        await client.query(`
            ALTER TABLE institutes 
            ADD COLUMN IF NOT EXISTS registration_start_time TIMESTAMPTZ
        `);
        
        // Add comment for documentation
        await client.query(`
            COMMENT ON COLUMN institutes.registration_start_time IS 'Start time for student registration window (IST timezone stored as UTC)';
        `);
        
        await client.query('COMMIT');
        
        console.log('✅ Registration start time column added successfully!');
        console.log('📋 Summary:');
        console.log('   - Added registration_start_time column (TIMESTAMPTZ)');
        console.log('   - Registration window: start_time to deadline');
        
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
    addRegistrationStartTime()
        .then(() => {
            console.log('Migration completed. Exiting...');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Migration failed:', error);
            process.exit(1);
        });
}

module.exports = addRegistrationStartTime;
