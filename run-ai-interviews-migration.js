const fs = require('fs');
const { pool } = require('./config/db');
const path = require('path');

async function runMigration() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'create-ai-interviews-table.sql'), 'utf-8');
    console.log('Running AI interviews migration...');
    await pool.query(sql);
    console.log('✓ ai_interviews table created successfully.');
  } catch (e) {
    console.error('Migration error:', e.message);
  } finally {
    pool.end();
  }
}

runMigration();
