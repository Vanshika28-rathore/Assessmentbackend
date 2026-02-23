const { pool } = require('./config/db');

async function testDeadlineLogic() {
    try {
        // Get AMITY data
        const result = await pool.query(`
            SELECT 
                name,
                display_name,
                registration_status,
                registration_deadline
            FROM institutes 
            WHERE LOWER(name) = 'amity'
        `);
        
        if (result.rows.length === 0) {
            console.log('AMITY not found');
            process.exit(1);
        }
        
        const institute = result.rows[0];
        console.log('Institute data:', institute);
        console.log('\nDeadline check:');
        
        if (institute.registration_deadline) {
            const now = new Date();
            const deadline = new Date(institute.registration_deadline);
            
            console.log('Current time (UTC):', now.toISOString());
            console.log('Current time (IST):', now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
            console.log('Deadline (UTC):', deadline.toISOString());
            console.log('Deadline (IST):', deadline.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }));
            console.log('\nComparison:');
            console.log('now > deadline:', now > deadline);
            console.log('Difference (minutes):', (now - deadline) / 1000 / 60);
            
            if (now > deadline) {
                console.log('\n✅ SHOULD BLOCK: Deadline has passed');
            } else {
                console.log('\n❌ SHOULD ALLOW: Deadline not yet passed');
            }
        } else {
            console.log('No deadline set');
        }
        
        console.log('\nStatus check:');
        console.log('Status:', institute.registration_status);
        if (institute.registration_status === 'closed') {
            console.log('✅ SHOULD BLOCK: Status is closed');
        } else if (institute.registration_status === 'paused') {
            console.log('✅ SHOULD BLOCK: Status is paused');
        } else {
            console.log('❌ SHOULD ALLOW: Status is open');
        }
        
        process.exit(0);
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

testDeadlineLogic();
