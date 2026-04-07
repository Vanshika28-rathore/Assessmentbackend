const pool = require('../config/db');
const fs = require('fs');
const path = require('path');

async function runMigration() {
    try {
        console.log('Starting coding questions migration...');

        // Read the SQL file
        const sqlPath = path.join(__dirname, 'create-coding-questions-table.sql');
        const sql = fs.readFileSync(sqlPath, 'utf8');

        // Execute the SQL
        await pool.query(sql);

        console.log('✅ Coding questions tables created successfully!');
        console.log('Tables created:');
        console.log('  - coding_questions');
        console.log('  - coding_test_cases');
        console.log('  - student_coding_submissions');

        process.exit(0);
    } catch (error) {
        console.error('❌ Migration failed:', error);
        process.exit(1);
    }
}

runMigration();
