/**
 * ============================================================
 * DATABASE AUDIT SCRIPT
 * ============================================================
 * Checks ALL tables for:
 *  1. Row counts (overview)
 *  2. Duplicate entries (tests, questions, students, etc.)
 *  3. Orphaned records (data whose parent was deleted)
 *  4. Missing CASCADE / dangling FK references
 *  5. Missing UNIQUE constraints that should exist
 * 
 * Run: node db-audit.js
 * ============================================================
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

const SEPARATOR = '─'.repeat(70);
const BOLD   = '\x1b[1m';
const RED    = '\x1b[31m';
const GREEN  = '\x1b[32m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const RESET  = '\x1b[0m';

function log(msg)  { console.log(msg); }
function ok(msg)   { console.log(`${GREEN}  ✔  ${msg}${RESET}`); }
function warn(msg) { console.log(`${YELLOW}  ⚠  ${msg}${RESET}`); }
function err(msg)  { console.log(`${RED}  ✘  ${msg}${RESET}`); }
function info(msg) { console.log(`${CYAN}  ℹ  ${msg}${RESET}`); }
function hdr(title){ console.log(`\n${BOLD}${SEPARATOR}\n  ${title}\n${SEPARATOR}${RESET}`); }

async function query(sql, params = []) {
  const res = await pool.query(sql, params);
  return res.rows;
}

async function tableExists(table) {
  const rows = await query(
    `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1) AS exists`,
    [table]
  );
  return rows[0].exists;
}

// ─────────────────────────────────────────────────────────────
// SECTION 1 — Table row counts
// ─────────────────────────────────────────────────────────────
async function checkRowCounts() {
  hdr('SECTION 1 — Row Counts per Table');

  const tables = [
    'students', 'admins', 'tests', 'questions',
    'exams', 'results', 'student_responses', 'test_attempts',
    'exam_progress', 'institutes', 'institute_test_assignments',
    'test_assignments', 'test_job_roles', 'feedback',
    'coding_questions', 'coding_test_cases', 'student_coding_submissions',
    'proctoring_violations', 'proctoring_messages', 'forced_terminations',
    'system_settings', 'student_messages', 'interviews', 'interview_chat_messages',
    'job_openings', 'job_notifications', 'job_applications',
    'job_opening_tests', 'job_eligibility_rules', 'otps',
  ];

  for (const tbl of tables) {
    const exists = await tableExists(tbl);
    if (!exists) {
      warn(`Table '${tbl}' does NOT exist in the database`);
      continue;
    }
    const rows = await query(`SELECT COUNT(*) AS cnt FROM "${tbl}"`);
    info(`${tbl.padEnd(35)} → ${rows[0].cnt} rows`);
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 2 — Duplicate detection
// ─────────────────────────────────────────────────────────────
async function checkDuplicates() {
  hdr('SECTION 2 — Duplicate Detection');

  // 2a. Duplicate tests (same title + start_datetime + duration)
  const dupTests = await query(`
    SELECT title, start_datetime, duration, COUNT(*) AS cnt
    FROM tests
    GROUP BY title, start_datetime, duration
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
  `);
  if (dupTests.length) {
    err(`Duplicate TESTS found (${dupTests.length} groups):`);
    dupTests.forEach(r => log(`     title="${r.title}"  start=${r.start_datetime}  count=${r.cnt}`));
  } else {
    ok('No duplicate tests found');
  }

  // 2b. Duplicate questions (same test_id + question_text)
  const dupQs = await query(`
    SELECT test_id, question_text, COUNT(*) AS cnt
    FROM questions
    GROUP BY test_id, question_text
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 20
  `);
  if (dupQs.length) {
    err(`Duplicate QUESTIONS found (${dupQs.length} groups, showing top 20):`);
    dupQs.forEach(r => log(`     test_id=${r.test_id}  count=${r.cnt}  text="${String(r.question_text).substring(0,60)}..."`));
  } else {
    ok('No duplicate questions found');
  }

  // 2c. Duplicate students (same email / roll_number)
  const dupEmail = await query(`
    SELECT email, COUNT(*) AS cnt FROM students
    GROUP BY email HAVING COUNT(*) > 1
  `);
  if (dupEmail.length) {
    err(`Duplicate student EMAILS found:`);
    dupEmail.forEach(r => log(`     email=${r.email}  count=${r.cnt}`));
  } else ok('No duplicate student emails');

  const dupRoll = await query(`
    SELECT roll_number, COUNT(*) AS cnt FROM students
    GROUP BY roll_number HAVING COUNT(*) > 1
  `);
  if (dupRoll.length) {
    err(`Duplicate student ROLL NUMBERS found:`);
    dupRoll.forEach(r => log(`     roll=${r.roll_number}  count=${r.cnt}`));
  } else ok('No duplicate student roll_numbers');

  // 2d. Duplicate test_attempts (same student+test without job_application)
  const dupAttempts = await query(`
    SELECT student_id, test_id, COUNT(*) AS cnt
    FROM test_attempts
    WHERE job_application_id IS NULL
    GROUP BY student_id, test_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 10
  `);
  if (dupAttempts.length) {
    err(`Duplicate TEST_ATTEMPTS (no job_application_id) found:`);
    dupAttempts.forEach(r => log(`     student=${r.student_id}  test=${r.test_id}  count=${r.cnt}`));
  } else ok('No duplicate test_attempts (without job_application_id)');

  // 2e. Duplicate student_responses (same student+question — UNIQUE should exist)
  const dupResp = await query(`
    SELECT student_id, question_id, COUNT(*) AS cnt
    FROM student_responses
    GROUP BY student_id, question_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 10
  `);
  if (dupResp.length) {
    err(`Duplicate STUDENT_RESPONSES found (violates UNIQUE constraint?):`);
    dupResp.forEach(r => log(`     student=${r.student_id}  question=${r.question_id}  count=${r.cnt}`));
  } else ok('No duplicate student_responses');

  // 2f. Duplicate exam_progress (same student+test)
  const dupProg = await query(`
    SELECT student_id, test_id, COUNT(*) AS cnt
    FROM exam_progress
    GROUP BY student_id, test_id
    HAVING COUNT(*) > 1
    ORDER BY cnt DESC
    LIMIT 10
  `);
  if (dupProg.length) {
    err(`Duplicate EXAM_PROGRESS rows found:`);
    dupProg.forEach(r => log(`     student=${r.student_id}  test=${r.test_id}  count=${r.cnt}`));
  } else ok('No duplicate exam_progress rows');

  // 2g. Duplicate feedback (same student+test)
  const exists = await tableExists('feedback');
  if (exists) {
    const dupFb = await query(`
      SELECT student_id, test_id, COUNT(*) AS cnt
      FROM feedback
      GROUP BY student_id, test_id
      HAVING COUNT(*) > 1
    `);
    if (dupFb.length) {
      err(`Duplicate FEEDBACK rows found:`);
      dupFb.forEach(r => log(`     student=${r.student_id}  test=${r.test_id}  count=${r.cnt}`));
    } else ok('No duplicate feedback entries');
  }

  // 2h. Duplicate coding submissions (same student+question+test)
  if (await tableExists('student_coding_submissions')) {
    const dupCoding = await query(`
      SELECT student_id, coding_question_id, test_id, COUNT(*) AS cnt
      FROM student_coding_submissions
      GROUP BY student_id, coding_question_id, test_id
      HAVING COUNT(*) > 1
    `);
    if (dupCoding.length) {
      err(`Duplicate STUDENT_CODING_SUBMISSIONS found:`);
      dupCoding.forEach(r => log(`     student=${r.student_id}  q=${r.coding_question_id}  test=${r.test_id}  count=${r.cnt}`));
    } else ok('No duplicate coding submissions');
  }

  // 2i. Duplicate job_applications (same student+job)
  if (await tableExists('job_applications')) {
    const dupJa = await query(`
      SELECT student_id, job_opening_id, COUNT(*) AS cnt
      FROM job_applications
      GROUP BY student_id, job_opening_id
      HAVING COUNT(*) > 1
    `);
    if (dupJa.length) {
      err(`Duplicate JOB_APPLICATIONS found:`);
      dupJa.forEach(r => log(`     student=${r.student_id}  job=${r.job_opening_id}  count=${r.cnt}`));
    } else ok('No duplicate job_applications');
  }

  // 2j. Duplicate OTPs for same email (only unused ones matter)
  if (await tableExists('otps')) {
    const dupOtps = await query(`
      SELECT email, COUNT(*) AS cnt
      FROM otps
      WHERE is_used = false AND expires_at > NOW()
      GROUP BY email
      HAVING COUNT(*) > 1
    `);
    if (dupOtps.length) {
      warn(`Multiple ACTIVE OTPs for the same email:`);
      dupOtps.forEach(r => log(`     email=${r.email}  count=${r.cnt}`));
    } else ok('No duplicate active OTPs');
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 3 — Orphaned / dangling records
// ─────────────────────────────────────────────────────────────
async function checkOrphans() {
  hdr('SECTION 3 — Orphaned Records (Broken FK References)');

  const checks = [
    // questions → tests
    {
      label: 'questions with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM questions q
            WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = q.test_id)`
    },
    // results → students
    {
      label: 'results with non-existent student_id',
      sql: `SELECT COUNT(*) AS cnt FROM results r
            WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = r.student_id)`
    },
    // results → exams
    {
      label: 'results with non-existent exam_id',
      sql: `SELECT COUNT(*) AS cnt FROM results r
            WHERE NOT EXISTS (SELECT 1 FROM exams e WHERE e.id = r.exam_id)`
    },
    // student_responses → students
    {
      label: 'student_responses with non-existent student_id',
      sql: `SELECT COUNT(*) AS cnt FROM student_responses sr
            WHERE sr.student_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM students s WHERE s.id = sr.student_id)`
    },
    // student_responses → tests
    {
      label: 'student_responses with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM student_responses sr
            WHERE sr.test_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = sr.test_id)`
    },
    // student_responses → questions
    {
      label: 'student_responses with non-existent question_id',
      sql: `SELECT COUNT(*) AS cnt FROM student_responses sr
            WHERE sr.question_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM questions q WHERE q.id = sr.question_id)`
    },
    // test_attempts → students
    {
      label: 'test_attempts with non-existent student_id',
      sql: `SELECT COUNT(*) AS cnt FROM test_attempts ta
            WHERE ta.student_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM students s WHERE s.id = ta.student_id)`
    },
    // test_attempts → tests
    {
      label: 'test_attempts with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM test_attempts ta
            WHERE ta.test_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = ta.test_id)`
    },
    // exam_progress → students
    {
      label: 'exam_progress with non-existent student_id',
      sql: `SELECT COUNT(*) AS cnt FROM exam_progress ep
            WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = ep.student_id)`
    },
    // exam_progress → tests
    {
      label: 'exam_progress with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM exam_progress ep
            WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = ep.test_id)`
    },
    // test_assignments → tests
    {
      label: 'test_assignments with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM test_assignments ta
            WHERE ta.test_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = ta.test_id)`
    },
    // test_assignments → students
    {
      label: 'test_assignments with non-existent student_id',
      sql: `SELECT COUNT(*) AS cnt FROM test_assignments ta
            WHERE ta.student_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM students s WHERE s.id = ta.student_id)`
    },
    // institute_test_assignments → institutes
    {
      label: 'institute_test_assignments with non-existent institute_id',
      sql: `SELECT COUNT(*) AS cnt FROM institute_test_assignments ita
            WHERE ita.institute_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM institutes i WHERE i.id = ita.institute_id)`
    },
    // institute_test_assignments → tests
    {
      label: 'institute_test_assignments with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM institute_test_assignments ita
            WHERE ita.test_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = ita.test_id)`
    },
    // students with institute name not in institutes table
    {
      label: 'students whose "institute" is not in institutes table',
      sql: `SELECT COUNT(*) AS cnt FROM students s
            WHERE s.institute IS NOT NULL
            AND TRIM(s.institute) != ''
            AND NOT EXISTS (
              SELECT 1 FROM institutes i WHERE LOWER(i.name) = LOWER(TRIM(s.institute))
            )`
    },
  ];

  // Conditionally add checks for tables that may exist
  const conditionalChecks = [
    {
      table: 'feedback',
      label: 'feedback with non-existent student_id',
      sql: `SELECT COUNT(*) AS cnt FROM feedback f
            WHERE f.student_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM students s WHERE s.id = f.student_id)`
    },
    {
      table: 'feedback',
      label: 'feedback with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM feedback f
            WHERE f.test_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = f.test_id)`
    },
    {
      table: 'coding_questions',
      label: 'coding_questions with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM coding_questions cq
            WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = cq.test_id)`
    },
    {
      table: 'coding_test_cases',
      label: 'coding_test_cases with non-existent coding_question_id',
      sql: `SELECT COUNT(*) AS cnt FROM coding_test_cases ctc
            WHERE NOT EXISTS (SELECT 1 FROM coding_questions cq WHERE cq.id = ctc.coding_question_id)`
    },
    {
      table: 'student_coding_submissions',
      label: 'student_coding_submissions with non-existent coding_question_id',
      sql: `SELECT COUNT(*) AS cnt FROM student_coding_submissions scs
            WHERE NOT EXISTS (SELECT 1 FROM coding_questions cq WHERE cq.id = scs.coding_question_id)`
    },
    {
      table: 'student_coding_submissions',
      label: 'student_coding_submissions with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM student_coding_submissions scs
            WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = scs.test_id)`
    },
    {
      table: 'interviews',
      label: 'interviews with non-existent student_id',
      sql: `SELECT COUNT(*) AS cnt FROM interviews iv
            WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = iv.student_id)`
    },
    {
      table: 'interviews',
      label: 'interviews with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM interviews iv
            WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = iv.test_id)`
    },
    {
      table: 'interview_chat_messages',
      label: 'interview_chat_messages with non-existent interview_id',
      sql: `SELECT COUNT(*) AS cnt FROM interview_chat_messages icm
            WHERE NOT EXISTS (SELECT 1 FROM interviews iv WHERE iv.id = icm.interview_id)`
    },
    {
      table: 'job_applications',
      label: 'job_applications with non-existent job_opening_id',
      sql: `SELECT COUNT(*) AS cnt FROM job_applications ja
            WHERE NOT EXISTS (SELECT 1 FROM job_openings jo WHERE jo.id = ja.job_opening_id)`
    },
    {
      table: 'job_applications',
      label: 'job_applications with non-existent student_id',
      sql: `SELECT COUNT(*) AS cnt FROM job_applications ja
            WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = ja.student_id)`
    },
    {
      table: 'job_notifications',
      label: 'job_notifications with non-existent job_opening_id',
      sql: `SELECT COUNT(*) AS cnt FROM job_notifications jn
            WHERE NOT EXISTS (SELECT 1 FROM job_openings jo WHERE jo.id = jn.job_opening_id)`
    },
    {
      table: 'job_notifications',
      label: 'job_notifications with non-existent student_id',
      sql: `SELECT COUNT(*) AS cnt FROM job_notifications jn
            WHERE NOT EXISTS (SELECT 1 FROM students s WHERE s.id = jn.student_id)`
    },
    {
      table: 'job_opening_tests',
      label: 'job_opening_tests with non-existent job_opening_id',
      sql: `SELECT COUNT(*) AS cnt FROM job_opening_tests jot
            WHERE NOT EXISTS (SELECT 1 FROM job_openings jo WHERE jo.id = jot.job_opening_id)`
    },
    {
      table: 'job_opening_tests',
      label: 'job_opening_tests with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM job_opening_tests jot
            WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = jot.test_id)`
    },
    {
      table: 'job_eligibility_rules',
      label: 'job_eligibility_rules with non-existent job_opening_id',
      sql: `SELECT COUNT(*) AS cnt FROM job_eligibility_rules jer
            WHERE NOT EXISTS (SELECT 1 FROM job_openings jo WHERE jo.id = jer.job_opening_id)`
    },
    {
      table: 'test_job_roles',
      label: 'test_job_roles with non-existent test_id',
      sql: `SELECT COUNT(*) AS cnt FROM test_job_roles tjr
            WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = tjr.test_id)`
    },
    {
      table: 'proctoring_violations',
      label: 'proctoring_violations with test_id not in tests',
      sql: `SELECT COUNT(*) AS cnt FROM proctoring_violations pv
            WHERE NOT EXISTS (SELECT 1 FROM tests t WHERE t.id = pv.test_id)`
    },
    {
      table: 'test_attempts',
      label: 'test_attempts with non-existent job_application_id',
      sql: `SELECT COUNT(*) AS cnt FROM test_attempts ta
            WHERE ta.job_application_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM job_applications ja WHERE ja.id = ta.job_application_id)`
    },
  ];

  // Run standard checks
  for (const c of checks) {
    try {
      const rows = await query(c.sql);
      const cnt = parseInt(rows[0].cnt);
      if (cnt > 0) err(`${cnt} orphaned rows — ${c.label}`);
      else ok(`${c.label}`);
    } catch (e) {
      warn(`Could not check: ${c.label} — ${e.message}`);
    }
  }

  // Run conditional checks
  for (const c of conditionalChecks) {
    if (!(await tableExists(c.table))) {
      warn(`Skipping check (table '${c.table}' not found): ${c.label}`);
      continue;
    }
    try {
      const rows = await query(c.sql);
      const cnt = parseInt(rows[0].cnt);
      if (cnt > 0) err(`${cnt} orphaned rows — ${c.label}`);
      else ok(`${c.label}`);
    } catch (e) {
      warn(`Could not check: ${c.label} — ${e.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 4 — Foreign Key Constraint Audit
// ─────────────────────────────────────────────────────────────
async function checkForeignKeys() {
  hdr('SECTION 4 — Foreign Key Constraint Audit (CASCADE check)');

  const fkRows = await query(`
    SELECT
      tc.table_name AS child_table,
      kcu.column_name AS child_column,
      ccu.table_name AS parent_table,
      ccu.column_name AS parent_column,
      rc.delete_rule
    FROM information_schema.table_constraints AS tc
    JOIN information_schema.key_column_usage AS kcu
      ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
    JOIN information_schema.constraint_column_usage AS ccu
      ON ccu.constraint_name = tc.constraint_name
      AND ccu.table_schema = tc.table_schema
    JOIN information_schema.referential_constraints AS rc
      ON rc.constraint_name = tc.constraint_name
    WHERE tc.constraint_type = 'FOREIGN KEY'
    ORDER BY tc.table_name, kcu.column_name
  `);

  if (!fkRows.length) {
    warn('No foreign key constraints found at all!');
    return;
  }

  // Tables / columns that SHOULD have ON DELETE CASCADE
  const shouldCascade = [
    // child_table → child_column (parent)
    { child: 'questions',                  col: 'test_id',            parent: 'tests' },
    { child: 'student_responses',          col: 'student_id',         parent: 'students' },
    { child: 'student_responses',          col: 'test_id',            parent: 'tests' },
    { child: 'student_responses',          col: 'question_id',        parent: 'questions' },
    { child: 'test_attempts',              col: 'student_id',         parent: 'students' },
    { child: 'test_attempts',              col: 'test_id',            parent: 'tests' },
    { child: 'exam_progress',              col: 'student_id',         parent: 'students' },
    { child: 'exam_progress',              col: 'test_id',            parent: 'tests' },
    { child: 'test_assignments',           col: 'test_id',            parent: 'tests' },
    { child: 'test_assignments',           col: 'student_id',         parent: 'students' },
    { child: 'institute_test_assignments', col: 'institute_id',       parent: 'institutes' },
    { child: 'institute_test_assignments', col: 'test_id',            parent: 'tests' },
    { child: 'feedback',                   col: 'student_id',         parent: 'students' },
    { child: 'feedback',                   col: 'test_id',            parent: 'tests' },
    { child: 'coding_questions',           col: 'test_id',            parent: 'tests' },
    { child: 'coding_test_cases',          col: 'coding_question_id', parent: 'coding_questions' },
    { child: 'student_coding_submissions', col: 'coding_question_id', parent: 'coding_questions' },
    { child: 'student_coding_submissions', col: 'test_id',            parent: 'tests' },
    { child: 'results',                    col: 'student_id',         parent: 'students' },
    { child: 'results',                    col: 'exam_id',            parent: 'exams' },
    { child: 'interviews',                 col: 'student_id',         parent: 'students' },
    { child: 'interviews',                 col: 'test_id',            parent: 'tests' },
    { child: 'interview_chat_messages',    col: 'interview_id',       parent: 'interviews' },
    { child: 'job_notifications',          col: 'job_opening_id',     parent: 'job_openings' },
    { child: 'job_notifications',          col: 'student_id',         parent: 'students' },
    { child: 'job_applications',           col: 'job_opening_id',     parent: 'job_openings' },
    { child: 'job_applications',           col: 'student_id',         parent: 'students' },
    { child: 'job_opening_tests',          col: 'job_opening_id',     parent: 'job_openings' },
    { child: 'job_opening_tests',          col: 'test_id',            parent: 'tests' },
    { child: 'job_eligibility_rules',      col: 'job_opening_id',     parent: 'job_openings' },
    { child: 'test_job_roles',             col: 'test_id',            parent: 'tests' },
  ];

  // Build a lookup from actual FK constraints
  const fkMap = {};
  for (const r of fkRows) {
    const key = `${r.child_table}.${r.child_column}`;
    fkMap[key] = { parent: r.parent_table, deleteRule: r.delete_rule };
  }

  for (const sc of shouldCascade) {
    const key = `${sc.child}.${sc.col}`;
    const actual = fkMap[key];
    if (!actual) {
      err(`MISSING FK: ${sc.child}.${sc.col} → ${sc.parent}  (no constraint found)`);
    } else if (actual.deleteRule !== 'CASCADE') {
      warn(`NOT CASCADE: ${sc.child}.${sc.col} → ${actual.parent}  (delete_rule = ${actual.deleteRule})  — SHOULD be CASCADE`);
    } else {
      ok(`CASCADE OK: ${sc.child}.${sc.col} → ${actual.parent}`);
    }
  }

  // Also flag tables that have no FK at all when they should
  const noFkTables = ['forced_terminations', 'proctoring_violations'];
  for (const t of noFkTables) {
    if (!(await tableExists(t))) continue;
    const hasFk = fkRows.some(r => r.child_table === t);
    if (!hasFk) {
      warn(`Table '${t}' has NO foreign key constraints — it stores test_id/student_id as plain VARCHAR, so CASCADE won't work automatically`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 5 — Missing UNIQUE constraint check
// ─────────────────────────────────────────────────────────────
async function checkUniqueConstraints() {
  hdr('SECTION 5 — Missing UNIQUE Constraints');

  // Get all unique constraints
  const uniques = await query(`
    SELECT
      tc.table_name,
      string_agg(kcu.column_name, ', ' ORDER BY kcu.ordinal_position) AS columns
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.constraint_type IN ('UNIQUE', 'PRIMARY KEY')
    GROUP BY tc.table_name, tc.constraint_name
  `);

  const expectedUniques = [
    { table: 'student_responses',    cols: ['student_id', 'question_id'] },
    { table: 'test_attempts',        cols: ['student_id', 'test_id', 'job_application_id'] },
    { table: 'exam_progress',        cols: ['student_id', 'test_id'] },
    { table: 'test_assignments',     cols: ['test_id', 'student_id'] },
    { table: 'institute_test_assignments', cols: ['institute_id', 'test_id'] },
    { table: 'feedback',             cols: ['student_id', 'test_id'] },
    { table: 'job_notifications',    cols: ['job_opening_id', 'student_id'] },
    { table: 'job_applications',     cols: ['job_opening_id', 'student_id'] },
    { table: 'job_opening_tests',    cols: ['job_opening_id', 'test_id'] },
    { table: 'test_job_roles',       cols: ['test_id', 'job_role'] },
    { table: 'student_coding_submissions', cols: ['student_id', 'coding_question_id', 'test_id'] },
    { table: 'students',             cols: ['email'] },
    { table: 'students',             cols: ['roll_number'] },
    { table: 'institutes',           cols: ['name'] },
    { table: 'admins',               cols: ['email'] },
  ];

  for (const eu of expectedUniques) {
    if (!(await tableExists(eu.table))) {
      warn(`Skipping UNIQUE check — table '${eu.table}' not found`);
      continue;
    }
    const colSet = eu.cols.sort().join(', ');
    const found = uniques.some(u =>
      u.table_name === eu.table &&
      u.columns.split(', ').sort().join(', ') === colSet
    );
    if (!found) {
      err(`MISSING UNIQUE constraint on ${eu.table}(${eu.cols.join(', ')})`);
    } else {
      ok(`UNIQUE exists on ${eu.table}(${eu.cols.join(', ')})`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 6 — Cascade consistency when parent is soft-deleted
// ─────────────────────────────────────────────────────────────
async function checkSoftDeleteConsistency() {
  hdr('SECTION 6 — Soft-Delete / is_active Consistency');

  // Students belonging to inactive institutes
  if (await tableExists('institutes')) {
    const rows = await query(`
      SELECT COUNT(*) AS cnt
      FROM students s
      JOIN institutes i ON LOWER(i.name) = LOWER(TRIM(s.institute))
      WHERE i.is_active = false
    `);
    const cnt = parseInt(rows[0].cnt);
    if (cnt > 0) {
      warn(`${cnt} students belong to INACTIVE institutes (they can still log in)`);
    } else {
      ok('No students linked to inactive institutes');
    }
  }

  // Tests that are archived but still have active assignments
  const archivedTests = await query(`
    SELECT COUNT(*) AS cnt
    FROM test_assignments ta
    JOIN tests t ON t.id = ta.test_id
    WHERE t.status = 'archived'
    AND ta.is_active = true
  `);
  const archCnt = parseInt(archivedTests[0].cnt);
  if (archCnt > 0) {
    warn(`${archCnt} active test_assignments point to ARCHIVED tests`);
  } else {
    ok('No active assignments on archived tests');
  }

  // institute_test_assignments for inactive institutes
  if (await tableExists('institutes')) {
    const inaRows = await query(`
      SELECT COUNT(*) AS cnt
      FROM institute_test_assignments ita
      JOIN institutes i ON i.id = ita.institute_id
      WHERE i.is_active = false AND ita.is_active = true
    `);
    const inaCnt = parseInt(inaRows[0].cnt);
    if (inaCnt > 0) {
      warn(`${inaCnt} active institute_test_assignments for INACTIVE institutes`);
    } else {
      ok('No active institute_test_assignments for inactive institutes');
    }
  }
}

// ─────────────────────────────────────────────────────────────
// SECTION 7 — Summary & Recommendations
// ─────────────────────────────────────────────────────────────
function printRecommendations() {
  hdr('SECTION 7 — Summary & What You Need to Fix');

  log(`
${BOLD}KEY ISSUES & RECOMMENDED FIXES:${RESET}

  ${YELLOW}1. DUPLICATES in tests / questions:${RESET}
     → These usually happen because insert logic doesn't check uniqueness.
     → Fix: Add UNIQUE constraint on tests(title, start_datetime) or use
       INSERT ... ON CONFLICT DO NOTHING in your create-test API route.

  ${YELLOW}2. proctoring_violations / forced_terminations use VARCHAR student_id:${RESET}
     → They store Firebase UID strings, not integer student IDs.
     → ON DELETE CASCADE won't fire from the students table.
     → Fix: Add a trigger or application-level cleanup when a student is deleted.

  ${YELLOW}3. CASCADE on institutes → students:${RESET}
     → students.institute is a plain text column, NOT a FK.
     → Deleting an institute does NOT delete linked students automatically.
     → If you want: Add institute_id INTEGER FK to students, then add CASCADE.

  ${YELLOW}4. exams table:${RESET}
     → The 'exams' table has NO FK back to 'tests'. Results reference exams.
     → This is a legacy table — consider whether you still need it or whether
       test_attempts replaces it.

  ${YELLOW}5. test_attempts UNIQUE constraint changed:${RESET}
     → The old UNIQUE(student_id, test_id) was dropped for job_application support.
     → Make sure the new UNIQUE(student_id, test_id, job_application_id) exists.

  ${GREEN}What already has proper CASCADE:${RESET}
     → questions       → tests (ON DELETE CASCADE)           ✔
     → student_responses  → students/tests/questions (CASCADE)  ✔
     → test_attempts   → students/tests (CASCADE)            ✔
     → exam_progress   → students/tests (CASCADE)            ✔
     → feedback        → students/tests (CASCADE)            ✔
     → coding_test_cases → coding_questions (CASCADE)        ✔
     → interviews      → students/tests (CASCADE)            ✔
     → interview_chat_messages → interviews (CASCADE)        ✔
     → job_applications → job_openings/students (CASCADE)    ✔

  ${CYAN}Run this script, look at the ✘ (red) lines, then ask to generate
  the actual SQL fix script based on real findings.${RESET}
`);
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
  log(`\n${BOLD}╔══════════════════════════════════════════════════════════════════════╗`);
  log(`║          DATABASE AUDIT — ${new Date().toLocaleString('en-IN')}           `);
  log(`║          DB: ${process.env.DB_NAME}  HOST: ${process.env.DB_HOST}`);
  log(`╚══════════════════════════════════════════════════════════════════════╝${RESET}`);

  try {
    await checkRowCounts();
    await checkDuplicates();
    await checkOrphans();
    await checkForeignKeys();
    await checkUniqueConstraints();
    await checkSoftDeleteConsistency();
    printRecommendations();
  } catch (e) {
    console.error(`\n${RED}FATAL ERROR:${RESET}`, e.message);
  } finally {
    await pool.end();
    log(`\n${GREEN}Audit complete.${RESET}\n`);
  }
}

main();
