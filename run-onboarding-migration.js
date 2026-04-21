const { pool } = require('./config/db');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    try {
        console.log('Running onboarding video migration...');
        
        const sqlPath = path.join(__dirname, 'migrations', 'add-onboarding-video.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');
        
        await pool.query(sql);
        
        console.log('✅ Onboarding video migration completed successfully!');
        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error.message);
        console.error(error);
        process.exit(1);
    }
}

runMigration();
