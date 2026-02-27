#!/usr/bin/env node

/**
 * Run OTP Migration
 * Creates the otps table for email verification
 */

require('dotenv').config();
const { runOTPsMigration } = require('./migrations/run-otps-migration');

async function main() {
    console.log('🚀 Starting OTP Migration...');
    console.log('=====================================');
    
    try {
        await runOTPsMigration();
        console.log('=====================================');
        console.log('✅ OTP Migration completed successfully!');
        console.log('');
        console.log('The otps table is now ready for email verification.');
        
    } catch (error) {
        console.log('=====================================');
        console.error('❌ Migration failed:', error.message);
        console.log('');
        console.log('Please check your database connection and try again.');
        process.exit(1);
    }
}

main();