#!/usr/bin/env node

/**
 * Run Admin Profile Migration
 * Adds updated_at column to admins table for profile update tracking
 */

require('dotenv').config();
const { runAdminUpdatedAtMigration } = require('./migrations/run-admin-updated-at');

async function main() {
    console.log('🚀 Starting Admin Profile Migration...');
    console.log('=====================================');
    
    try {
        await runAdminUpdatedAtMigration();
        console.log('=====================================');
        console.log('✅ Admin Profile Migration completed successfully!');
        console.log('');
        console.log('The admins table now has an updated_at column for tracking profile changes.');
        
    } catch (error) {
        console.log('=====================================');
        console.error('❌ Migration failed:', error.message);
        console.log('');
        console.log('Please check your database connection and try again.');
        process.exit(1);
    }
}

main();