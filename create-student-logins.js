require('dotenv').config();

const admin = require('./config/firebase');
const { pool } = require('./config/db');

const TARGET_STUDENTS = [
  {
    email: 'susmithatavva84@gmail.com',
    password: '12345678',
    full_name: 'Susmitha Tavva'
  },
  {
    email: 't.susmitha7989@gmail.com',
    password: '12345678',
    full_name: 'T Susmitha'
  }
];

const DEFAULTS = {
  institute: 'shnoor',
  course: 'B.Tech',
  specialization: 'CSE',
  address: 'N/A',
  phone: null,
  resume_link: 'https://example.com/resume.pdf'
};

async function ensureFirebaseUser(student) {
  let userRecord;

  try {
    userRecord = await admin.auth().getUserByEmail(student.email);
    await admin.auth().updateUser(userRecord.uid, {
      password: student.password,
      displayName: student.full_name,
      emailVerified: true,
      disabled: false
    });
    console.log(`🔄 Firebase user updated: ${student.email}`);
    return userRecord.uid;
  } catch (err) {
    const userNotFound = err && (err.code === 'auth/user-not-found' || String(err.message || '').includes('user-not-found'));

    if (!userNotFound) {
      throw err;
    }

    userRecord = await admin.auth().createUser({
      email: student.email,
      password: student.password,
      displayName: student.full_name,
      emailVerified: true,
      disabled: false
    });

    console.log(`✅ Firebase user created: ${student.email}`);
    return userRecord.uid;
  }
}

async function getStudentColumns() {
  const result = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_name = 'students'`
  );

  return new Set(result.rows.map((row) => row.column_name));
}

function buildInsertPayload(columns, student, firebaseUid, rollNumber) {
  const payload = {
    email: student.email,
    full_name: student.full_name,
    firebase_uid: firebaseUid,
    roll_number: rollNumber,
    institute: DEFAULTS.institute,
    phone: DEFAULTS.phone,
    address: DEFAULTS.address,
    course: DEFAULTS.course,
    specialization: DEFAULTS.specialization,
    resume_link: DEFAULTS.resume_link
  };

  const keys = Object.keys(payload).filter((key) => columns.has(key));

  return {
    keys,
    values: keys.map((key) => payload[key])
  };
}

async function ensureStudentRow(student, firebaseUid, columns, index) {
  const existing = await pool.query(
    'SELECT id, roll_number FROM students WHERE email = $1',
    [student.email]
  );

  if (existing.rows.length > 0) {
    const setParts = [];
    const values = [];
    let p = 1;

    if (columns.has('firebase_uid')) {
      setParts.push(`firebase_uid = $${p++}`);
      values.push(firebaseUid);
    }

    if (columns.has('full_name')) {
      setParts.push(`full_name = $${p++}`);
      values.push(student.full_name);
    }

    if (columns.has('updated_at')) {
      setParts.push('updated_at = CURRENT_TIMESTAMP');
    }

    if (setParts.length > 0) {
      values.push(student.email);
      await pool.query(
        `UPDATE students
         SET ${setParts.join(', ')}
         WHERE email = $${p}`,
        values
      );
    }

    console.log(`🔄 Student row updated: ${student.email}`);
    return;
  }

  const rollNumber = `AUTO${Date.now()}${index + 1}`;
  const { keys, values } = buildInsertPayload(columns, student, firebaseUid, rollNumber);

  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  await pool.query(
    `INSERT INTO students (${keys.join(', ')})
     VALUES (${placeholders})`,
    values
  );

  console.log(`✅ Student row inserted: ${student.email}`);
}

(async () => {
  try {
    const columns = await getStudentColumns();

    for (let i = 0; i < TARGET_STUDENTS.length; i += 1) {
      const student = TARGET_STUDENTS[i];
      const firebaseUid = await ensureFirebaseUser(student);
      await ensureStudentRow(student, firebaseUid, columns, i);
    }

    console.log('\n🎉 Done: Both student logins are ready.');
    console.log('Emails:');
    TARGET_STUDENTS.forEach((s) => console.log(`- ${s.email}`));
    console.log('Password: 12345678');
  } catch (error) {
    console.error('❌ Failed to provision student logins:', error.message);
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();