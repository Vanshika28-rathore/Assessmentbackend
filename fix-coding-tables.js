const { pool } = require('./config/db');
const fs = require('fs');
const path = require('path');

async function fixCodingTables() {
  const client = await pool.connect();
  
  try {
    console.log('🔧 Fixing coding questions tables...');
    
    // Drop existing tables
    console.log('Dropping existing tables...');
    await client.query('DROP TABLE IF EXISTS exam_test_cases CASCADE');
    await client.query('DROP TABLE IF EXISTS exam_coding_questions CASCADE');
    
    // Read and execute the SQL file
    const sqlPath = path.join(__dirname, 'migrations', 'create-coding-tables.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    console.log('Creating tables with correct foreign keys...');
    await client.query(sql);
    
    console.log('✅ Tables fixed successfully!');
    
    // Verify tables exist
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('exam_coding_questions', 'exam_test_cases')
      ORDER BY table_name
    `);
    
    console.log('📋 Tables:', tablesResult.rows.map(r => r.table_name));
    
  } catch (error) {
    console.error('❌ Fix failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run fix
fixCodingTables()
  .then(() => {
    console.log('🎉 Fix completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Fix failed:', error);
    process.exit(1);
  });