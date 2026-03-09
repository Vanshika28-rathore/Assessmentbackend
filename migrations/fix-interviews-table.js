const db = require('../config/db');

async function fixInterviewsTable() {
  const client = await db.getClient();
  
  try {
    console.log('Starting interviews table migration...');
    
    // Drop existing table and recreate
    await client.query('DROP TABLE IF EXISTS interviews CASCADE');
    console.log('✅ Dropped existing interviews table');
    
    // Create table without institute_id
    await client.query(`
      CREATE TABLE interviews (
        id SERIAL PRIMARY KEY,
        student_id INTEGER NOT NULL,
        test_id INTEGER NOT NULL,
        scheduled_time TIMESTAMP NOT NULL,
        duration INTEGER DEFAULT 60,
        status VARCHAR(20) DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'in_progress', 'completed', 'cancelled')),
        peer_id VARCHAR(255),
        admin_notes TEXT,
        technical_score INTEGER,
        communication_score INTEGER,
        recommendation VARCHAR(20) DEFAULT 'on_hold' CHECK (recommendation IN ('selected', 'rejected', 'on_hold')),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (student_id) REFERENCES students(id) ON DELETE CASCADE,
        FOREIGN KEY (test_id) REFERENCES tests(id) ON DELETE CASCADE
      )
    `);
    console.log('✅ Created interviews table');
    
    // Create indexes
    await client.query('CREATE INDEX idx_interviews_scheduled_time ON interviews(scheduled_time)');
    await client.query('CREATE INDEX idx_interviews_status ON interviews(status)');
    console.log('✅ Created indexes');
    
    // Create trigger function
    await client.query(`
      CREATE OR REPLACE FUNCTION update_interviews_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = CURRENT_TIMESTAMP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    console.log('✅ Created trigger function');
    
    // Create trigger
    await client.query(`
      CREATE TRIGGER trigger_update_interviews_updated_at
      BEFORE UPDATE ON interviews
      FOR EACH ROW
      EXECUTE FUNCTION update_interviews_updated_at()
    `);
    console.log('✅ Created trigger');
    
    console.log('✅ Migration completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    process.exit(0);
  }
}

fixInterviewsTable();
