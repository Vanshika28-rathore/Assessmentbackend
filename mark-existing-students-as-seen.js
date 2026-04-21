const { pool } = require('./config/db');

async function markExistingStudentsAsSeen() {
    console.log('🔄 Marking all existing students as having seen the onboarding video...\n');
    
    try {
        // First, count how many students will be affected
        const countResult = await pool.query(`
            SELECT COUNT(*) as total 
            FROM students 
            WHERE has_seen_onboarding_video = false OR has_seen_onboarding_video IS NULL
        `);
        
        const totalToUpdate = parseInt(countResult.rows[0].total);
        
        if (totalToUpdate === 0) {
            console.log('✅ All students already marked as seen. No updates needed.');
            return;
        }
        
        console.log(`Found ${totalToUpdate} students who haven't seen the video yet.`);
        console.log('Updating...\n');
        
        // Update all existing students to mark video as seen
        const result = await pool.query(`
            UPDATE students 
            SET has_seen_onboarding_video = true 
            WHERE has_seen_onboarding_video = false OR has_seen_onboarding_video IS NULL
            RETURNING id
        `);
        
        console.log(`✅ Successfully updated ${result.rows.length} students!`);
        console.log('All existing students will NOT see the onboarding video.');
        console.log('Only NEW students (registered after this) will see it on first login.\n');
        
        // Show sample of updated students
        const sampleResult = await pool.query(`
            SELECT id, full_name, email, has_seen_onboarding_video 
            FROM students 
            ORDER BY id 
            LIMIT 5
        `);
        
        console.log('Sample of updated students:');
        sampleResult.rows.forEach(s => {
            console.log(`  - ${s.full_name} (${s.email}): has_seen = ${s.has_seen_onboarding_video}`);
        });
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error);
    } finally {
        await pool.end();
    }
}

markExistingStudentsAsSeen();
