const { pool } = require('../config/db');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function runMigration() {
  try {
    const sql = fs.readFileSync(path.join(__dirname, 'create-interviews-table.sql'), 'utf8');
    
    await pool.query(sql);
    console.log('✅ Interviews table created successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await pool.end();
  }
}

runMigration();
