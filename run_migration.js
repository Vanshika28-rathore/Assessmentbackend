const fs = require('fs');
const { pool } = require('./config/db');
const path = require('path');

async function runMigration() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'migrations', 'add-job-application-to-test-attempts.sql'), 'utf-8');
    console.log("Running migration...");
    await pool.query(sql);
    console.log("Migration executed successfully.");
  } catch (e) {
    console.error("Migration Error:", e);
  } finally {
    pool.end();
  }
}

runMigration();
