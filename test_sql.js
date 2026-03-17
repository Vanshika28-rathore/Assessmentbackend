const { pool } = require('./config/db');

async function check() {
    try {
        console.log("Testing test/:id route SQL");
        
        // 1. Fetch Test Details first
        const testId = 87; // from network tab
        const applicationId = 1;
        const studentId = 83; // from previous queries
        console.log("Fetching test details...");
        const testResult = await pool.query('SELECT * FROM tests WHERE id = $1', [testId]);
        console.dir(testResult.rows);

        console.log("\nChecking jobAppCheck...");
        const jobAppCheck = await pool.query(`
            SELECT ja.id, ja.status, jo.id as job_opening_id
            FROM job_applications ja
            INNER JOIN job_openings jo ON ja.job_opening_id = jo.id
            INNER JOIN job_opening_tests jot ON jot.job_opening_id = jo.id
            WHERE ja.id = $1 AND ja.student_id = $2 AND jot.test_id = $3
        `, [applicationId, studentId, testId]);
        console.dir(jobAppCheck.rows);

        console.log("\nChecking attemptCheck...");
        const attemptCheck = await pool.query(`
            SELECT id FROM test_attempts
            WHERE job_application_id = $1 AND student_id = $2 AND test_id = $3
        `, [applicationId, studentId, testId]);
        console.dir(attemptCheck.rows);

    } catch(err) {
        console.error("Caught SQL format error:");
        console.error(err);
    } finally {
        process.exit();
    }
}
check();
