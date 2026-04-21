const { pool } = require('./config/db');

async function testOnboardingColumn() {
    console.log('🔍 Testing onboarding video column...\n');
    
    try {
        // Check if column exists
        console.log('1. Checking if has_seen_onboarding_video column exists...');
        const columnCheck = await pool.query(`
            SELECT column_name, data_type, column_default
            FROM information_schema.columns 
            WHERE table_name = 'students' 
            AND column_name = 'has_seen_onboarding_video'
        `);
        
        if (columnCheck.rows.length === 0) {
            console.log('   ❌ Column does NOT exist!');
            console.log('   Run the migration: node run-onboarding-migration.js');
            return;
        }
        
        console.log('   ✅ Column exists');
        console.log('   Type:', columnCheck.rows[0].data_type);
        console.log('   Default:', columnCheck.rows[0].column_default);
        
        // Check sample students
        console.log('\n2. Checking sample students...');
        const students = await pool.query(`
            SELECT id, full_name, email, has_seen_onboarding_video 
            FROM students 
            LIMIT 5
        `);
        
        if (students.rows.length === 0) {
            console.log('   ⚠️  No students found in database');
        } else {
            console.log(`   Found ${students.rows.length} students:`);
            students.rows.forEach(s => {
                console.log(`   - ${s.full_name} (${s.email}): has_seen = ${s.has_seen_onboarding_video}`);
            });
        }
        
        // Check if there's an active video
        console.log('\n3. Checking for active onboarding video...');
        const videoCheck = await pool.query(`
            SELECT id, video_url, uploaded_at, is_active 
            FROM onboarding_videos 
            WHERE is_active = true
        `);
        
        if (videoCheck.rows.length === 0) {
            console.log('   ⚠️  No active onboarding video found');
        } else {
            console.log('   ✅ Active video found:');
            console.log('   URL:', videoCheck.rows[0].video_url);
            console.log('   Uploaded:', videoCheck.rows[0].uploaded_at);
        }
        
        console.log('\n✅ All checks completed!');
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error);
    } finally {
        await pool.end();
    }
}

testOnboardingColumn();
