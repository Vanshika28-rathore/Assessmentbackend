const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

async function runOTPsMigration() {
    try {
        console.log('Running OTPs table migration...');
        
        // Read the SQL file
        const sqlPath = path.join(__dirname, 'create-otps-table.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        
        // Execute the migration
        await query(sql);
        
        console.log('✅ OTPs table migration completed successfully');
        
        // Verify the table was created
        const result = await query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'otps'
            ORDER BY ordinal_position
        `);
        
        if (result.rows.length > 0) {
            console.log('✅ Verified: otps table exists with columns:');
            result.rows.forEach(row => {
                console.log(`  - ${row.column_name}: ${row.data_type}`);
            });
        } else {
            console.log('❌ Warning: otps table not found after migration');
        }
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    }
}

// Run if called directly
if (require.main === module) {
    runOTPsMigration()
        .then(() => {
            console.log('Migration script completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Migration script failed:', error);
            process.exit(1);
        });
}

module.exports = { runOTPsMigration };