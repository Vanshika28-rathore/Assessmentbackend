const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
    user: process.env.DB_USER,
    host: process.env.DB_HOST,
    database: process.env.DB_NAME,
    password: process.env.DB_PASSWORD,
    port: process.env.DB_PORT || 5432,
});

async function runProctoringMessagesMigration() {
    try {
        console.log('🚀 Starting proctoring messages table migration...');
        
        // Read the SQL file
        const sqlFile = path.join(__dirname, 'add-proctoring-messages.sql');
        const sql = fs.readFileSync(sqlFile, 'utf8');
        
        // Execute the SQL
        await pool.query(sql);
        
        console.log('✅ Proctoring messages table created successfully!');
        console.log('📋 Features added:');
        console.log('   - Real-time admin-student messaging');
        console.log('   - Message types: warning, instruction, alert, info');
        console.log('   - Priority levels: low, medium, high');
        console.log('   - Message read status tracking');
        console.log('   - Session-based message storage');
        console.log('   - Proper indexing for efficient queries');
        
    } catch (error) {
        console.error('❌ Error running proctoring messages migration:', error.message);
        console.error(error.stack);
    } finally {
        await pool.end();
        process.exit(0);
    }
}

// Run the migration if this file is executed directly
if (require.main === module) {
    runProctoringMessagesMigration();
}

module.exports = { runProctoringMessagesMigration };