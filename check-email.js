#!/usr/bin/env node

/**
 * Check if an email is registered and optionally delete it
 * Usage: node check-email.js <email>
 */

require('dotenv').config();
const { query } = require('./config/db');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

async function checkEmail(email) {
    try {
        console.log(`\n🔍 Checking email: ${email}\n`);
        
        // Check if email exists
        const result = await query(
            'SELECT id, full_name, email, roll_number, institute, created_at FROM students WHERE email = $1',
            [email.toLowerCase().trim()]
        );

        if (result.rows.length === 0) {
            console.log('✅ Email is NOT registered. You can use this email for registration.\n');
            process.exit(0);
        }

        const student = result.rows[0];
        console.log('❌ Email is ALREADY registered:');
        console.log('=====================================');
        console.log(`ID: ${student.id}`);
        console.log(`Name: ${student.full_name}`);
        console.log(`Email: ${student.email}`);
        console.log(`Roll Number: ${student.roll_number}`);
        console.log(`Institute: ${student.institute}`);
        console.log(`Created: ${student.created_at}`);
        console.log('=====================================\n');

        // Ask if user wants to delete
        rl.question('Do you want to DELETE this registration? (yes/no): ', async (answer) => {
            if (answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y') {
                try {
                    await query('DELETE FROM students WHERE id = $1', [student.id]);
                    console.log('\n✅ Registration deleted successfully!\n');
                    console.log('You can now register with this email.\n');
                } catch (error) {
                    console.error('\n❌ Error deleting registration:', error.message);
                }
            } else {
                console.log('\n❌ Registration NOT deleted. Please use a different email.\n');
            }
            rl.close();
            process.exit(0);
        });

    } catch (error) {
        console.error('❌ Error:', error.message);
        rl.close();
        process.exit(1);
    }
}

// Get email from command line argument
const email = process.argv[2];

if (!email) {
    console.log('\n❌ Please provide an email address');
    console.log('Usage: node check-email.js <email>\n');
    console.log('Example: node check-email.js praveenkumar70441@gmail.com\n');
    process.exit(1);
}

checkEmail(email);