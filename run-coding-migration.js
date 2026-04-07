const { pool } = require('./config/db');
const fs = require('fs');
const path = require('path');

async function runCodingMigration() {
  const client = await pool.connect();
  
  try {
    console.log('🚀 Running coding questions migration...');
    
    // Read the SQL file
    const sqlPath = path.join(__dirname, 'migrations', 'create-coding-tables.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Execute the SQL
    await client.query(sql);
    
    console.log('✅ Coding questions tables created successfully!');
    
    // Verify tables exist
    const tablesResult = await client.query(`
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name IN ('exam_coding_questions', 'exam_test_cases')
      ORDER BY table_name
    `);
    
    console.log('📋 Created tables:', tablesResult.rows.map(r => r.table_name));
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migration
runCodingMigration()
  .then(() => {
    console.log('🎉 Migration completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('💥 Migration failed:', error);
    process.exit(1);
  });