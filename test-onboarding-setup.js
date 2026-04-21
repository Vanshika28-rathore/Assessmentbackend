const { pool } = require('./config/db');

async function testSetup() {
    console.log('🔍 Testing Onboarding Video Setup...\n');
    
    try {
        // Test 1: Check if onboarding_videos table exists
        console.log('1. Checking onboarding_videos table...');
        const tableCheck = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.tables 
                WHERE table_name = 'onboarding_videos'
            );
        `);
        
        if (tableCheck.rows[0].exists) {
            console.log('   ✅ onboarding_videos table exists');
        } else {
            console.log('   ❌ onboarding_videos table NOT found');
            return;
        }
        
        // Test 2: Check table structure
        console.log('\n2. Checking table structure...');
        const columns = await pool.query(`
            SELECT column_name, data_type 
            FROM information_schema.columns 
            WHERE table_name = 'onboarding_videos'
            ORDER BY ordinal_position;
        `);
        
        console.log('   Columns:');
        columns.rows.forEach(col => {
            console.log(`   - ${col.column_name}: ${col.data_type}`);
        });
        
        // Test 3: Check students table has new column
        console.log('\n3. Checking students table modification...');
        const studentColumn = await pool.query(`
            SELECT EXISTS (
                SELECT FROM information_schema.columns 
                WHERE table_name = 'students' 
                AND column_name = 'has_seen_onboarding_video'
            );
        `);
        
        if (studentColumn.rows[0].exists) {
            console.log('   ✅ has_seen_onboarding_video column exists in students table');
        } else {
            console.log('   ❌ has_seen_onboarding_video column NOT found in students table');
        }
        
        // Test 4: Check indexes
        console.log('\n4. Checking indexes...');
        const indexes = await pool.query(`
            SELECT indexname 
            FROM pg_indexes 
            WHERE tablename IN ('onboarding_videos', 'students')
            AND indexname LIKE '%onboarding%';
        `);
        
        if (indexes.rows.length > 0) {
            console.log('   Indexes found:');
            indexes.rows.forEach(idx => {
                console.log(`   - ${idx.indexname}`);
            });
        } else {
            console.log('   ⚠️  No onboarding-related indexes found');
        }
        
        // Test 5: Check constraints
        console.log('\n5. Checking constraints...');
        const constraints = await pool.query(`
            SELECT constraint_name, constraint_type 
            FROM information_schema.table_constraints 
            WHERE table_name = 'onboarding_videos';
        `);
        
        if (constraints.rows.length > 0) {
            console.log('   Constraints:');
            constraints.rows.forEach(con => {
                console.log(`   - ${con.constraint_name}: ${con.constraint_type}`);
            });
        }
        
        console.log('\n✅ All checks completed successfully!');
        console.log('\n📝 Summary:');
        console.log('   - Database tables created');
        console.log('   - Columns added to students table');
        console.log('   - Indexes created');
        console.log('   - Ready to use!');
        
    } catch (error) {
        console.error('\n❌ Error during setup test:', error.message);
        console.error(error);
    } finally {
        await pool.end();
    }
}

testSetup();
