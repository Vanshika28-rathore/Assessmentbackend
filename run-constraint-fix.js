const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function runMigration() {
  try {
    console.log('Reading migration file...');
    const migrationSQL = fs.readFileSync(
      path.join(__dirname, 'migrations', 'fix-test-attempts-constraint.sql'),
      'utf8'
    );
    
    console.log('Executing migration...');
    await pool.query(migrationSQL);
    
    console.log('✅ Migration executed successfully!');
    
    // Verify the constraint was created
    const result = await pool.query(`
      SELECT conname 
      FROM pg_constraint 
      WHERE conname = 'test_attempts_student_test_application_unique'
    `);
    
    if (result.rows.length > 0) {
      console.log('✅ Constraint verified:', result.rows[0].conname);
    } else {
      console.log('❌ WARNING: Constraint not found after migration!');
    }
    
  } catch (err) {
    console.error('❌ Error running migration:', err.message);
    console.error('Full error:', err);
  } finally {
    await pool.end();
  }
}

runMigration();
