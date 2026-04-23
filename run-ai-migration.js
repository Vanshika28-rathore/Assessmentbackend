const { query } = require('./config/db');

async function runMigration() {
    console.log('--- Starting AI Interview Migration ---');
    try {
        // Create table safely
        const createTableQuery = `
            CREATE TABLE IF NOT EXISTS ai_interviews (
                id SERIAL PRIMARY KEY,
                student_id VARCHAR(255), 
                student_name VARCHAR(255),
                resume_text TEXT,
                chat_history JSONB,
                rating INTEGER,
                feedback_comment TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `;
        
        await query(createTableQuery);
        console.log('✅ Table "ai_interviews" created or already exists.');
        
        // Create index for performance
        await query('CREATE INDEX IF NOT EXISTS idx_ai_interviews_student_id ON ai_interviews(student_id);');
        console.log('✅ Index created on student_id.');

    } catch (error) {
        console.error('❌ Migration failed:', error.message);
    } finally {
        console.log('--- Migration Finished ---');
        process.exit();
    }
}

runMigration();
