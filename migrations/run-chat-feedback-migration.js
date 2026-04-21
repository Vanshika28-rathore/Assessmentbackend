const { pool } = require('../config/db');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const client = await pool.connect();
  
  try {
    console.log('🔄 Starting chat feedback migration...');
    
    // Read the SQL file
    const sqlPath = path.join(__dirname, 'add-chat-feedback.sql');
    const sql = fs.readFileSync(sqlPath, 'utf8');
    
    // Execute the migration
    await client.query(sql);
    
    console.log('✅ Migration completed successfully!');
    console.log('');
    console.log('New columns added to student_messages table:');
    console.log('  - conversation_status');
    console.log('  - closed_at');
    console.log('  - closed_by');
    console.log('  - feedback_rating');
    console.log('  - feedback_helpful');
    console.log('  - feedback_response_time');
    console.log('  - feedback_comments');
    console.log('  - feedback_submitted_at');
    console.log('');
    console.log('✅ Indexes created successfully!');
    console.log('');
    
    // Verify columns exist
    const verifyResult = await client.query(`
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_name = 'student_messages' 
        AND column_name IN (
          'conversation_status',
          'closed_at',
          'closed_by',
          'feedback_rating',
          'feedback_helpful',
          'feedback_response_time',
          'feedback_comments',
          'feedback_submitted_at'
        )
      ORDER BY column_name
    `);
    
    console.log('📋 Verification:');
    verifyResult.rows.forEach(row => {
      console.log(`  ✓ ${row.column_name} (${row.data_type})`);
    });
    
    if (verifyResult.rows.length === 8) {
      console.log('');
      console.log('🎉 All columns verified successfully!');
      console.log('');
      console.log('Next steps:');
      console.log('  1. Restart your backend server');
      console.log('  2. Test the new features in the admin panel');
    } else {
      console.log('');
      console.log('⚠️  Warning: Expected 8 columns but found', verifyResult.rows.length);
    }
    
  } catch (error) {
    console.error('❌ Migration failed:', error.message);
    console.error('');
    console.error('Error details:', error);
    process.exit(1);
  } finally {
    client.release();
    process.exit(0);
  }
}

// Run the migration
runMigration();
