const { pool } = require('./config/db');

async function updateMockTestDetails() {
    console.log('🔄 Updating mock test with Software Development Intern details...\n');
    
    const jobRole = 'Software Development Intern';
    const jobDescription = `Key Responsibilities:
Assist in designing, developing, and deploying CRM applications
Work with Java / MERN / React / PHP, MongoDB / MySQL to build scalable and robust solutions
Collaborate with senior developers and team members to define project requirements and system designs
Debug, test, and maintain applications to ensure strong functionality and optimization
Write clean, maintainable, and well-documented code
Participate in code reviews and contribute to improving coding standards
Stay updated with emerging technologies and propose innovative solutions

Required Skills & Qualifications:
Bachelor's degree (B.E/B.Tech) in Computer Science, Information Technology, or related field
Strong understanding of Core Java and PHP
Basic knowledge of databases (MySQL, MongoDB)
Familiarity with object-oriented programming (OOPs) and software development principles
Good problem-solving and debugging skills
Ability to work in a team and learn quickly in a dynamic environment

Good to Have:
Knowledge of web technologies (HTML, CSS, JavaScript, AJAX, Node, Express, React & REST APIs)
Familiarity with version control systems (Git, GitHub/GitLab)
Understanding of MVC frameworks (Laravel, Spring, etc.)
Understanding of designing skills and tools like Figma
Understanding of Cloud Concepts (Deployment of applications) in AWS / Google Cloud

Perks & Benefits:
Stipend of ₹10,000-₹12,000 per month during the 3-month internship period
Pre-Placement Offer (PPO) is 6 LPA.
Mentorship from experienced professionals in CRM application development
Exposure to real-world projects and enterprise systems

Please Note: No Backlogs at the time of applying for the position; otherwise, the application will be rejected.`;
    
    try {
        // Find the mock test
        const mockTestResult = await pool.query(`
            SELECT id, title 
            FROM tests 
            WHERE is_mock_test = true 
            ORDER BY id 
            LIMIT 1
        `);
        
        if (mockTestResult.rows.length === 0) {
            console.log('❌ No mock test found. Please create a mock test first.');
            return;
        }
        
        const mockTest = mockTestResult.rows[0];
        console.log(`Found mock test: "${mockTest.title}" (ID: ${mockTest.id})\n`);
        
        // Update the mock test with new job role and description
        await pool.query(`
            UPDATE tests 
            SET job_role = $1,
                description = $2
            WHERE id = $3
        `, [jobRole, jobDescription, mockTest.id]);
        
        console.log('✅ Successfully updated mock test!');
        console.log(`   Job Role: ${jobRole}`);
        console.log(`   Description: ${jobDescription.substring(0, 100)}...\n`);
        
        // Verify the change
        const verifyResult = await pool.query(`
            SELECT id, title, job_role, description 
            FROM tests 
            WHERE id = $1
        `, [mockTest.id]);
        
        console.log('📋 Verification:');
        console.log(`   ID: ${verifyResult.rows[0].id}`);
        console.log(`   Title: ${verifyResult.rows[0].title}`);
        console.log(`   Job Role: ${verifyResult.rows[0].job_role}`);
        console.log(`   Description Length: ${verifyResult.rows[0].description.length} characters`);
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error);
    } finally {
        await pool.end();
    }
}

updateMockTestDetails();
