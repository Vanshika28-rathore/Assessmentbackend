const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

async function checkConstraint() {
  try {
    const result = await pool.query(`
      SELECT conname 
      FROM pg_constraint 
      WHERE conname = 'test_attempts_student_test_application_unique'
    `);
    
    console.log('Constraint exists:', result.rows.length > 0 ? 'YES' : 'NO');
    if (result.rows.length > 0) {
      console.log('Constraint name:', result.rows[0].conname);
    } else {
      console.log('ERROR: Constraint NOT found! Migration needs to be run.');
    }
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await pool.end();
  }
}

checkConstraint();
