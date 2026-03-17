const { pool } = require('./config/db');

async function fix() {
    const client = await pool.connect();
    try {
        // Check if table exists
        const tableCheck = await client.query(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'system_settings'
        `);

        if (tableCheck.rows.length === 0) {
            console.log('system_settings table MISSING — creating...');
            await client.query(`
                CREATE TABLE system_settings (
                    id                    SERIAL PRIMARY KEY,
                    retry_timer_minutes   INTEGER DEFAULT 5,
                    maintenance_mode      BOOLEAN DEFAULT false,
                    maintenance_message   TEXT DEFAULT '',
                    updated_at            TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
                )
            `);
            console.log('✅ Table created');
        } else {
            console.log('system_settings table EXISTS');
            // Show existing columns
            const cols = await client.query(`
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'system_settings' ORDER BY ordinal_position
            `);
            console.log('Columns:', cols.rows.map(r => r.column_name).join(', '));
        }

        // Ensure a default row id=1 exists
        const rowCheck = await client.query('SELECT id FROM system_settings WHERE id = 1');
        if (rowCheck.rows.length === 0) {
            await client.query(`
                INSERT INTO system_settings (id, retry_timer_minutes, maintenance_mode, maintenance_message)
                VALUES (1, 5, false, '')
            `);
            console.log('✅ Default settings row inserted');
        } else {
            console.log('✅ Default row id=1 already exists');
        }

        console.log('\nDone — /api/settings/public should now return 200.');
    } catch (err) {
        console.error('Error:', err.message);
    } finally {
        client.release();
        pool.end();
    }
}

fix();