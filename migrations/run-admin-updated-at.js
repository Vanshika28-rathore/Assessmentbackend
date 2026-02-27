const { query } = require('../config/db');
const fs = require('fs');
const path = require('path');

async function runAdminUpdatedAtMigration() {
    try {
        console.log('Running admin updated_at column migration...');
        
        // Read the SQL file
        const sqlPath = path.join(__dirname, 'add-admin-updated-at.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        
        // Execute the migration
        await query(sql);
        
        console.log('✅ Admin updated_at column migration completed successfully');
        
        // Verify the column was added
        const result = await query(`
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns 
            WHERE table_name = 'admins' AND column_name IN ('updated_at', 'phone', 'address')
            ORDER BY column_name
        `);
        
        if (result.rows.length > 0) {
            console.log('✅ Verified: Columns added to admins table');
            result.rows.forEach(row => {
                console.log(`  - ${row.column_name}: ${row.data_type}`);
            });
        } else {
            console.log('❌ Warning: Columns not found after migration');
        }
        
    } catch (error) {
        console.error('❌ Migration failed:', error);
        throw error;
    }
}

// Run if called directly
if (require.main === module) {
    runAdminUpdatedAtMigration()
        .then(() => {
            console.log('Migration script completed');
            process.exit(0);
        })
        .catch((error) => {
            console.error('Migration script failed:', error);
            process.exit(1);
        });
}

module.exports = { runAdminUpdatedAtMigration };