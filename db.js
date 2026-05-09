const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DB_PATH = path.join(DATA_DIR, 'peerreview.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const DEFAULT_CLASS_DATES = [
  { id: '2026-03-28', label: 'Mar 28, 2026' },
  { id: '2026-04-04', label: 'Apr 4, 2026' },
  { id: '2026-04-18', label: 'Apr 18, 2026' },
  { id: '2026-04-25', label: 'Apr 25, 2026' },
  { id: '2026-05-02', label: 'May 2, 2026' }
];
const DEFAULT_GROUPS = ['1', '2', '3', '4'];

const DEFAULT_PROFILE_FIELDS = [
  { key: 'name',       label: 'ชื่อ - นามสกุล',  enabled: true,  required: false, showOnDashboard: true  },
  { key: 'nickname',   label: 'ชื่อเล่น',          enabled: true,  required: false, showOnDashboard: false },
  { key: 'studentId',  label: 'รหัสนักศึกษา',     enabled: true,  required: false, showOnDashboard: true  },
  { key: 'faculty',    label: 'คณะ',               enabled: false, required: false, showOnDashboard: false },
  { key: 'department', label: 'สาขา',              enabled: false, required: false, showOnDashboard: false },
  { key: 'university', label: 'มหาวิทยาลัย',      enabled: false, required: false, showOnDashboard: false },
  { key: 'company',    label: 'บริษัท',           enabled: false, required: false, showOnDashboard: false },
  { key: 'position',   label: 'ตำแหน่ง',          enabled: false, required: false, showOnDashboard: false },
];

// ---------- Classrooms table ----------
db.exec(`
  CREATE TABLE IF NOT EXISTS classrooms (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    university TEXT,
    createdAt TEXT NOT NULL,
    registrationOpen INTEGER DEFAULT 1,
    votingOpen INTEGER DEFAULT 0,
    peerReviewEnabled INTEGER DEFAULT 1,
    classDates TEXT,
    attendancePercent INTEGER DEFAULT 5,
    validGroups TEXT,
    groupAssignmentMode TEXT DEFAULT 'self'
  );
`);
// Migrate: add columns to existing classrooms tables
function gen4digit() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
try {
  const ccols = db.prepare("PRAGMA table_info(classrooms)").all().map(c => c.name);
  if (!ccols.includes('groupAssignmentMode')) {
    db.exec(`ALTER TABLE classrooms ADD COLUMN groupAssignmentMode TEXT DEFAULT 'self'`);
    db.exec(`UPDATE classrooms SET groupAssignmentMode = 'self' WHERE groupAssignmentMode IS NULL`);
  }
  if (!ccols.includes('enrollCode')) {
    db.exec(`ALTER TABLE classrooms ADD COLUMN enrollCode TEXT`);
    // Generate codes for existing classrooms
    const empties = db.prepare(`SELECT id FROM classrooms WHERE enrollCode IS NULL OR enrollCode = ''`).all();
    empties.forEach(c => {
      db.prepare(`UPDATE classrooms SET enrollCode = ? WHERE id = ?`).run(gen4digit(), c.id);
    });
  }
  if (!ccols.includes('profileFields')) {
    db.exec(`ALTER TABLE classrooms ADD COLUMN profileFields TEXT`);
  }
  if (!ccols.includes('isPublic')) {
    db.exec(`ALTER TABLE classrooms ADD COLUMN isPublic INTEGER DEFAULT 1`);
    db.exec(`UPDATE classrooms SET isPublic = 1 WHERE isPublic IS NULL`);
  }
} catch (e) { /* ignore */ }

// Migrate users table: add new profile columns
try {
  const ucols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
  if (!ucols.includes('faculty'))    db.exec(`ALTER TABLE users ADD COLUMN faculty TEXT`);
  if (!ucols.includes('department')) db.exec(`ALTER TABLE users ADD COLUMN department TEXT`);
  if (!ucols.includes('university')) db.exec(`ALTER TABLE users ADD COLUMN university TEXT`);
  if (!ucols.includes('company'))    db.exec(`ALTER TABLE users ADD COLUMN company TEXT`);
  if (!ucols.includes('position'))   db.exec(`ALTER TABLE users ADD COLUMN position TEXT`);
} catch (e) { /* ignore */ }

// ---------- Migrate users / votes to classroom-scoped schema ----------
function migrateSchema() {
  const userCols = db.prepare("PRAGMA table_info(users)").all();
  const userTableExists = userCols.length > 0;
  const userHasCid = userCols.some(c => c.name === 'classroomId');
  const userHasPhone = userCols.some(c => c.name === 'phone');

  if (!userTableExists) {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        classroomId TEXT NOT NULL,
        phone TEXT,
        studentId TEXT,
        firstName TEXT,
        lastName TEXT,
        nickname TEXT,
        name TEXT,
        groupNum TEXT,
        registeredAt TEXT NOT NULL,
        selfie TEXT,
        selfieAt TEXT,
        attendance TEXT,
        attendanceUpdatedAt TEXT,
        attendanceSubmittedAt TEXT
      );
    `);
  } else if (!userHasCid) {
    console.log('Migrating users → classroom-scoped schema...');
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        classroomId TEXT NOT NULL,
        phone TEXT,
        studentId TEXT,
        firstName TEXT,
        lastName TEXT,
        nickname TEXT,
        name TEXT,
        groupNum TEXT,
        registeredAt TEXT NOT NULL,
        selfie TEXT,
        selfieAt TEXT,
        attendance TEXT,
        attendanceUpdatedAt TEXT,
        attendanceSubmittedAt TEXT
      );
    `);
    db.exec(`
      INSERT INTO users_new (classroomId, phone, studentId, name, groupNum, registeredAt, selfie, selfieAt, attendance, attendanceUpdatedAt, attendanceSubmittedAt)
      SELECT 'ge-207', studentId, studentId, name, groupNum, registeredAt, selfie, selfieAt, attendance, attendanceUpdatedAt, attendanceSubmittedAt FROM users;
    `);
    db.exec(`DROP TABLE users;`);
    db.exec(`ALTER TABLE users_new RENAME TO users;`);
  } else if (!userHasPhone) {
    // Existing users table with classroomId but no phone — add column and copy from studentId
    db.exec(`ALTER TABLE users ADD COLUMN phone TEXT`);
    db.exec(`UPDATE users SET phone = studentId WHERE (phone IS NULL OR phone = '') AND studentId IS NOT NULL AND studentId != ''`);
  }

  const voteCols = db.prepare("PRAGMA table_info(votes)").all();
  const voteHasCid = voteCols.some(c => c.name === 'classroomId');
  if (voteCols.length === 0) {
    db.exec(`
      CREATE TABLE votes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        classroomId TEXT NOT NULL,
        voterId TEXT NOT NULL,
        targetId TEXT NOT NULL,
        score INTEGER NOT NULL,
        groupNum TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
    `);
  } else if (!voteHasCid) {
    db.exec(`ALTER TABLE votes ADD COLUMN classroomId TEXT`);
    db.exec(`UPDATE votes SET classroomId = 'ge-207' WHERE classroomId IS NULL`);
  }
}
migrateSchema();

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_users_classroom ON users(classroomId);
  CREATE INDEX IF NOT EXISTS idx_votes_classroom ON votes(classroomId);
  CREATE INDEX IF NOT EXISTS idx_votes_voter ON votes(voterId);
  CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(targetId);
`);
// Drop legacy unique-phone index if exists, replace with non-unique index
try { db.exec(`DROP INDEX IF EXISTS idx_users_classroom_phone`); } catch (e) {}
try { db.exec(`CREATE INDEX IF NOT EXISTS idx_users_classroom_phone ON users(classroomId, phone)`); } catch (e) {}

// Detect legacy table-level UNIQUE constraints (from older schemas) and rebuild
// the users table without them. Allows duplicate phone / studentId.
try {
  const indexes = db.prepare("PRAGMA index_list(users)").all();
  const hasLegacyUnique = indexes.some(i => i.unique && String(i.name || '').startsWith('sqlite_autoindex'));
  if (hasLegacyUnique) {
    console.log('Removing legacy UNIQUE constraint on users table...');
    const cols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    db.exec(`
      CREATE TABLE users_clean (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        classroomId TEXT NOT NULL,
        phone TEXT,
        studentId TEXT,
        firstName TEXT,
        lastName TEXT,
        nickname TEXT,
        name TEXT,
        groupNum TEXT,
        registeredAt TEXT NOT NULL,
        selfie TEXT,
        selfieAt TEXT,
        attendance TEXT,
        attendanceUpdatedAt TEXT,
        attendanceSubmittedAt TEXT,
        faculty TEXT,
        department TEXT,
        university TEXT,
        company TEXT,
        position TEXT
      );
    `);
    const wantCols = ['id','classroomId','phone','studentId','firstName','lastName','nickname','name','groupNum','registeredAt','selfie','selfieAt','attendance','attendanceUpdatedAt','attendanceSubmittedAt','faculty','department','university','company','position'];
    const validCols = wantCols.filter(c => cols.includes(c));
    db.exec(`INSERT INTO users_clean (${validCols.join(',')}) SELECT ${validCols.join(',')} FROM users;`);
    db.exec(`DROP TABLE users;`);
    db.exec(`ALTER TABLE users_clean RENAME TO users;`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_classroom ON users(classroomId);`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_users_classroom_phone ON users(classroomId, phone);`);
    console.log('users table rebuilt without UNIQUE');
  }
} catch (e) { console.error('Legacy UNIQUE cleanup failed:', e.message); }

db.exec(`
  CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    classroomId TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    type TEXT NOT NULL DEFAULT 'individual',
    dueDate TEXT,
    createdAt TEXT NOT NULL,
    isOpen INTEGER DEFAULT 1,
    classDateId TEXT,
    maxScore REAL DEFAULT 10
  );
  CREATE INDEX IF NOT EXISTS idx_assignments_classroom ON assignments(classroomId);

  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    assignmentId INTEGER NOT NULL,
    classroomId TEXT NOT NULL,
    studentId TEXT NOT NULL,
    groupNum TEXT,
    content TEXT,
    link TEXT,
    fileUrl TEXT,
    fileName TEXT,
    submittedAt TEXT NOT NULL,
    score REAL,
    feedback TEXT,
    gradedAt TEXT,
    gradedBy TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_assignment ON submissions(assignmentId);
  CREATE INDEX IF NOT EXISTS idx_submissions_classroom ON submissions(classroomId);
`);

// Migrate columns if missing (must run before any index that references them)
try {
  const aCols = db.prepare("PRAGMA table_info(assignments)").all().map(c => c.name);
  if (!aCols.includes('classDateId')) db.exec(`ALTER TABLE assignments ADD COLUMN classDateId TEXT`);
  if (!aCols.includes('maxScore')) db.exec(`ALTER TABLE assignments ADD COLUMN maxScore REAL DEFAULT 10`);
  const sCols = db.prepare("PRAGMA table_info(submissions)").all().map(c => c.name);
  if (!sCols.includes('score')) db.exec(`ALTER TABLE submissions ADD COLUMN score REAL`);
  if (!sCols.includes('feedback')) db.exec(`ALTER TABLE submissions ADD COLUMN feedback TEXT`);
  if (!sCols.includes('gradedAt')) db.exec(`ALTER TABLE submissions ADD COLUMN gradedAt TEXT`);
  if (!sCols.includes('gradedBy')) db.exec(`ALTER TABLE submissions ADD COLUMN gradedBy TEXT`);
} catch (e) { console.error('migrate column failed:', e.message); }

// Indexes that reference potentially-migrated columns — run AFTER ALTER
try {
  db.exec(`CREATE INDEX IF NOT EXISTS idx_assignments_date ON assignments(classDateId);`);
} catch (e) { /* ignore */ }

const SUBMISSIONS_DIR = path.join(UPLOADS_DIR, 'submissions');
if (!fs.existsSync(SUBMISSIONS_DIR)) fs.mkdirSync(SUBMISSIONS_DIR, { recursive: true });
const MATERIALS_DIR = path.join(UPLOADS_DIR, 'materials');
if (!fs.existsSync(MATERIALS_DIR)) fs.mkdirSync(MATERIALS_DIR, { recursive: true });

// ---------- Default GE 207 classroom ----------
function ensureDefaultClassroom() {
  const cnt = db.prepare('SELECT COUNT(*) c FROM classrooms').get().c;
  if (cnt > 0) return;
  let oldVotingOpen = 0;
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = 'votingOpen'`).get();
    if (r) oldVotingOpen = r.value === '1' ? 1 : 0;
  } catch (e) {}
  const code = gen4digit();
  db.prepare(`INSERT INTO classrooms
    (id, code, name, description, university, createdAt, registrationOpen, votingOpen, peerReviewEnabled, classDates, attendancePercent, validGroups, enrollCode)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, ?, 5, ?, ?)`).run(
    'ge-207',
    'GE 207',
    'รายวิชา GE 207',
    'รายวิชาศึกษาทั่วไป — มหาวิทยาลัยกรุงเทพ',
    'มหาวิทยาลัยกรุงเทพ',
    new Date().toISOString(),
    oldVotingOpen,
    JSON.stringify(DEFAULT_CLASS_DATES),
    JSON.stringify(DEFAULT_GROUPS),
    code
  );
  console.log(`Created default classroom: GE 207 (id=ge-207, enrollCode=${code})`);
}
ensureDefaultClassroom();

// ---------- Migrate from data.json (legacy) ----------
function migrateFromJson() {
  const oldFile = path.join(__dirname, 'data.json');
  if (!fs.existsSync(oldFile)) return;
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount > 0) return;
  try {
    const data = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    const cid = 'ge-207';
    const tx = db.transaction(() => {
      const insUser = db.prepare(`INSERT INTO users
        (classroomId, studentId, name, groupNum, registeredAt, selfie, selfieAt, attendance, attendanceUpdatedAt, attendanceSubmittedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      (data.users || []).forEach(u => insUser.run(
        cid, u.studentId, u.name, u.group, u.registeredAt,
        u.selfie || null, u.selfieAt || null,
        u.attendance ? JSON.stringify(u.attendance) : null,
        u.attendanceUpdatedAt || null,
        u.attendanceSubmittedAt || null
      ));
      const insVote = db.prepare('INSERT INTO votes (classroomId, voterId, targetId, score, groupNum, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
      (data.votes || []).forEach(v => insVote.run(cid, v.voterId, v.targetId, v.score, v.group, v.timestamp));
      if (data.votingOpen) {
        db.prepare('UPDATE classrooms SET votingOpen = 1 WHERE id = ?').run(cid);
      }
    });
    tx();
    fs.renameSync(oldFile, oldFile + '.migrated');
    console.log('Migrated data.json → SQLite');
  } catch (e) {
    console.error('Migration failed:', e.message);
  }
}
migrateFromJson();

// ---------- Helpers ----------
function mergeProfileFields(stored) {
  // Merge stored config with defaults — keep only valid keys, fill in missing keys
  const storedMap = {};
  if (Array.isArray(stored)) stored.forEach(f => { if (f && f.key) storedMap[f.key] = f; });
  return DEFAULT_PROFILE_FIELDS.map(d => {
    const s = storedMap[d.key];
    if (!s) return { ...d };
    return {
      ...d,
      enabled: !!s.enabled,
      required: !!s.required,
      showOnDashboard: s.showOnDashboard !== undefined ? !!s.showOnDashboard : d.showOnDashboard
    };
  });
}

function rowToClassroom(r) {
  if (!r) return null;
  let pf = null;
  if (r.profileFields) {
    try { pf = JSON.parse(r.profileFields); } catch (e) { pf = null; }
  }
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description || '',
    university: r.university || '',
    createdAt: r.createdAt,
    registrationOpen: !!r.registrationOpen,
    votingOpen: !!r.votingOpen,
    peerReviewEnabled: !!r.peerReviewEnabled,
    classDates: r.classDates ? JSON.parse(r.classDates) : DEFAULT_CLASS_DATES,
    attendancePercent: r.attendancePercent ?? 5,
    validGroups: r.validGroups ? JSON.parse(r.validGroups) : DEFAULT_GROUPS,
    groupAssignmentMode: r.groupAssignmentMode || 'self',
    enrollCode: r.enrollCode || '',
    profileFields: mergeProfileFields(pf),
    isPublic: r.isPublic == null ? true : !!r.isPublic
  };
}

function rowToUser(r) {
  if (!r) return null;
  let firstName = r.firstName || '';
  let lastName = r.lastName || '';
  // Legacy migration: if no firstName but has full name, split
  if (!firstName && r.name) {
    const parts = String(r.name).trim().split(/\s+/);
    firstName = parts[0] || '';
    lastName = parts.slice(1).join(' ') || '';
  }
  const u = {
    id: r.id,
    classroomId: r.classroomId,
    phone: r.phone || '',
    studentId: r.studentId || '',
    firstName,
    lastName,
    nickname: r.nickname || '',
    name: r.name || ((firstName || lastName) ? `${firstName} ${lastName}`.trim() : ''),
    group: r.groupNum || '',
    faculty: r.faculty || '',
    department: r.department || '',
    university: r.university || '',
    company: r.company || '',
    position: r.position || '',
    registeredAt: r.registeredAt
  };
  if (r.selfie) u.selfie = r.selfie;
  if (r.selfieAt) u.selfieAt = r.selfieAt;
  if (r.attendance) u.attendance = JSON.parse(r.attendance);
  if (r.attendanceUpdatedAt) u.attendanceUpdatedAt = r.attendanceUpdatedAt;
  if (r.attendanceSubmittedAt) u.attendanceSubmittedAt = r.attendanceSubmittedAt;
  return u;
}

function rowToVote(v) {
  return {
    classroomId: v.classroomId,
    voterId: v.voterId,
    targetId: v.targetId,
    score: v.score,
    group: v.groupNum,
    timestamp: v.timestamp
  };
}

function slugify(s) {
  return String(s).toLowerCase()
    .replace(/[^a-z0-9ก-๙]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'class';
}

function rowToAssignment(r) {
  if (!r) return null;
  return {
    id: r.id,
    classroomId: r.classroomId,
    title: r.title,
    description: r.description || '',
    type: r.type || 'individual',
    dueDate: r.dueDate || '',
    classDateId: r.classDateId || '',
    maxScore: r.maxScore != null ? r.maxScore : 10,
    createdAt: r.createdAt,
    isOpen: !!r.isOpen
  };
}
function rowToSubmission(r) {
  if (!r) return null;
  return {
    id: r.id,
    assignmentId: r.assignmentId,
    classroomId: r.classroomId,
    studentId: r.studentId,
    groupNum: r.groupNum || '',
    content: r.content || '',
    link: r.link || '',
    fileUrl: r.fileUrl || '',
    fileName: r.fileName || '',
    submittedAt: r.submittedAt,
    score: r.score != null ? r.score : null,
    feedback: r.feedback || '',
    gradedAt: r.gradedAt || '',
    gradedBy: r.gradedBy || ''
  };
}

module.exports = {
  DATA_DIR, UPLOADS_DIR,
  SUBMISSIONS_DIR, MATERIALS_DIR,
  DEFAULT_CLASS_DATES, DEFAULT_GROUPS, DEFAULT_PROFILE_FIELDS,
  slugify,
  gen4digit,

  // ===== Classrooms =====
  getClassrooms() {
    return db.prepare('SELECT * FROM classrooms ORDER BY createdAt DESC').all().map(rowToClassroom);
  },
  getClassroom(id) {
    return rowToClassroom(db.prepare('SELECT * FROM classrooms WHERE id = ?').get(id));
  },
  classroomIdExists(id) {
    return !!db.prepare('SELECT 1 FROM classrooms WHERE id = ?').get(id);
  },
  createClassroom(c) {
    db.prepare(`INSERT INTO classrooms
      (id, code, name, description, university, createdAt, registrationOpen, votingOpen, peerReviewEnabled, classDates, attendancePercent, validGroups, groupAssignmentMode, enrollCode, profileFields)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      c.id, c.code, c.name,
      c.description || '',
      c.university || 'มหาวิทยาลัยกรุงเทพ',
      c.createdAt,
      c.registrationOpen ? 1 : 0,
      c.votingOpen ? 1 : 0,
      c.peerReviewEnabled ? 1 : 0,
      JSON.stringify(c.classDates || DEFAULT_CLASS_DATES),
      c.attendancePercent ?? 5,
      JSON.stringify(c.validGroups || DEFAULT_GROUPS),
      c.groupAssignmentMode || 'self',
      c.enrollCode || gen4digit(),
      JSON.stringify(c.profileFields || DEFAULT_PROFILE_FIELDS)
    );
    return this.getClassroom(c.id);
  },
  regenerateEnrollCode(id) {
    const code = gen4digit();
    db.prepare('UPDATE classrooms SET enrollCode = ? WHERE id = ?').run(code, id);
    return code;
  },
  updateClassroom(id, fields) {
    const updates = [];
    const values = [];
    const intFields = ['registrationOpen', 'votingOpen', 'peerReviewEnabled', 'attendancePercent', 'isPublic'];
    const strFields = ['code', 'name', 'description', 'university', 'groupAssignmentMode', 'enrollCode'];
    strFields.forEach(k => {
      if (fields[k] !== undefined) { updates.push(`${k} = ?`); values.push(String(fields[k])); }
    });
    intFields.forEach(k => {
      if (fields[k] !== undefined) {
        updates.push(`${k} = ?`);
        const v = fields[k];
        values.push(typeof v === 'boolean' ? (v ? 1 : 0) : Number(v));
      }
    });
    if (fields.classDates !== undefined) {
      updates.push('classDates = ?'); values.push(JSON.stringify(fields.classDates));
    }
    if (fields.validGroups !== undefined) {
      updates.push('validGroups = ?'); values.push(JSON.stringify(fields.validGroups));
    }
    if (fields.profileFields !== undefined) {
      updates.push('profileFields = ?'); values.push(JSON.stringify(fields.profileFields));
    }
    if (!updates.length) return this.getClassroom(id);
    values.push(id);
    db.prepare(`UPDATE classrooms SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    return this.getClassroom(id);
  },
  deleteClassroom(id) {
    const users = db.prepare('SELECT selfie FROM users WHERE classroomId = ?').all(id);
    users.forEach(u => {
      if (u.selfie) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(u.selfie))); } catch (e) {}
      }
    });
    db.prepare('DELETE FROM votes WHERE classroomId = ?').run(id);
    db.prepare('DELETE FROM users WHERE classroomId = ?').run(id);
    db.prepare('DELETE FROM classrooms WHERE id = ?').run(id);
  },

  // ===== Users (scoped) =====
  getUsers(classroomId) {
    return db.prepare('SELECT * FROM users WHERE classroomId = ?').all(classroomId).map(rowToUser);
  },
  // Lookup by phone OR studentId (whichever matches first)
  getUser(classroomId, key) {
    if (!key) return null;
    return rowToUser(db.prepare(
      'SELECT * FROM users WHERE classroomId = ? AND (phone = ? OR studentId = ?)'
    ).get(classroomId, key, key));
  },
  getUserByPhone(classroomId, phone) {
    if (!phone) return null;
    return rowToUser(db.prepare('SELECT * FROM users WHERE classroomId = ? AND phone = ?').get(classroomId, phone));
  },
  addUser(classroomId, u) {
    const r = db.prepare(`INSERT INTO users (classroomId, phone, studentId, firstName, lastName, nickname, name, groupNum, registeredAt, faculty, department, university, company, position)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      classroomId, u.phone || '', u.studentId || '',
      u.firstName || '', u.lastName || '', u.nickname || '',
      u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      u.group || '', u.registeredAt,
      u.faculty || '', u.department || '', u.university || '',
      u.company || '', u.position || ''
    );
    // Return the just-inserted row (since same phone may exist multiple times)
    return rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid));
  },
  updateUser(classroomId, key, fields) {
    const sets = [], vals = [];
    ['firstName', 'lastName', 'nickname', 'studentId',
     'faculty', 'department', 'university', 'company', 'position'].forEach(k => {
      if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(String(fields[k])); }
    });
    if (fields.firstName !== undefined || fields.lastName !== undefined) {
      const u = this.getUser(classroomId, key);
      if (u) {
        const fn = fields.firstName !== undefined ? fields.firstName : u.firstName;
        const ln = fields.lastName !== undefined ? fields.lastName : u.lastName;
        sets.push('name = ?'); vals.push(`${fn} ${ln}`.trim());
      }
    }
    if (fields.group !== undefined) { sets.push('groupNum = ?'); vals.push(String(fields.group || '')); }
    if (!sets.length) return this.getUser(classroomId, key);
    vals.push(classroomId, key, key);
    db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE classroomId = ? AND (phone = ? OR studentId = ?)`).run(...vals);
    return this.getUser(classroomId, key);
  },
  setUserGroup(classroomId, key, group) {
    db.prepare('UPDATE users SET groupNum = ? WHERE classroomId = ? AND (phone = ? OR studentId = ?)')
      .run(group || '', classroomId, key, key);
  },
  setSelfie(classroomId, key, selfie, ts) {
    db.prepare('UPDATE users SET selfie = ?, selfieAt = ? WHERE classroomId = ? AND (phone = ? OR studentId = ?)')
      .run(selfie, ts, classroomId, key, key);
  },
  setAttendance(classroomId, key, attendance, ts, submitted = false) {
    if (submitted) {
      db.prepare('UPDATE users SET attendance = ?, attendanceSubmittedAt = ? WHERE classroomId = ? AND (phone = ? OR studentId = ?)')
        .run(JSON.stringify(attendance), ts, classroomId, key, key);
    } else {
      db.prepare('UPDATE users SET attendance = ?, attendanceUpdatedAt = ? WHERE classroomId = ? AND (phone = ? OR studentId = ?)')
        .run(JSON.stringify(attendance), ts, classroomId, key, key);
    }
  },

  // ===== Votes (scoped) =====
  hasVoted(classroomId, voterId) {
    return !!db.prepare('SELECT 1 FROM votes WHERE classroomId = ? AND voterId = ? LIMIT 1').get(classroomId, voterId);
  },
  votersSet(classroomId) {
    return new Set(
      db.prepare('SELECT DISTINCT voterId FROM votes WHERE classroomId = ?').all(classroomId).map(r => r.voterId)
    );
  },
  addVotes(classroomId, voterId, group, scores, ts) {
    const stmt = db.prepare('INSERT INTO votes (classroomId, voterId, targetId, score, groupNum, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
    const tx = db.transaction(() => {
      scores.forEach(s => stmt.run(classroomId, voterId, s.targetId, s.score, group, ts));
    });
    tx();
  },
  getVotesForTarget(classroomId, targetId) {
    return db.prepare('SELECT * FROM votes WHERE classroomId = ? AND targetId = ?').all(classroomId, targetId).map(rowToVote);
  },
  getAllVotes(classroomId) {
    return db.prepare('SELECT * FROM votes WHERE classroomId = ?').all(classroomId).map(rowToVote);
  },
  resetVotes(classroomId) {
    db.prepare('DELETE FROM votes WHERE classroomId = ?').run(classroomId);
    db.prepare('UPDATE users SET attendance = NULL, attendanceUpdatedAt = NULL, attendanceSubmittedAt = NULL WHERE classroomId = ?').run(classroomId);
  },
  resetAll(classroomId) {
    db.prepare('DELETE FROM votes WHERE classroomId = ?').run(classroomId);
    const users = db.prepare('SELECT selfie FROM users WHERE classroomId = ?').all(classroomId);
    users.forEach(u => {
      if (u.selfie) {
        try { fs.unlinkSync(path.join(UPLOADS_DIR, path.basename(u.selfie))); } catch (e) {}
      }
    });
    db.prepare('DELETE FROM users WHERE classroomId = ?').run(classroomId);
    db.prepare('UPDATE classrooms SET votingOpen = 0 WHERE id = ?').run(classroomId);
  },
  rawDump(classroomId) {
    return {
      classroom: this.getClassroom(classroomId),
      users: this.getUsers(classroomId),
      votes: this.getAllVotes(classroomId),
      assignments: this.getAssignments(classroomId),
      submissions: this.getAllSubmissions(classroomId)
    };
  },

  // ===== Assignments =====
  getAssignments(classroomId) {
    return db.prepare('SELECT * FROM assignments WHERE classroomId = ? ORDER BY createdAt DESC')
      .all(classroomId).map(rowToAssignment);
  },
  getAssignment(id) {
    return rowToAssignment(db.prepare('SELECT * FROM assignments WHERE id = ?').get(id));
  },
  createAssignment(a) {
    const r = db.prepare(`INSERT INTO assignments (classroomId, title, description, type, dueDate, createdAt, isOpen, classDateId, maxScore)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      a.classroomId, a.title, a.description || '',
      a.type || 'individual',
      a.dueDate || '',
      a.createdAt, a.isOpen ? 1 : 0,
      a.classDateId || '',
      a.maxScore != null ? a.maxScore : 10
    );
    return this.getAssignment(r.lastInsertRowid);
  },
  updateAssignment(id, fields) {
    const sets = [], vals = [];
    ['title', 'description', 'type', 'dueDate', 'classDateId'].forEach(k => {
      if (fields[k] !== undefined) { sets.push(`${k} = ?`); vals.push(String(fields[k])); }
    });
    if (fields.maxScore !== undefined) { sets.push('maxScore = ?'); vals.push(Number(fields.maxScore) || 0); }
    if (fields.isOpen !== undefined) { sets.push('isOpen = ?'); vals.push(fields.isOpen ? 1 : 0); }
    if (!sets.length) return this.getAssignment(id);
    vals.push(id);
    db.prepare(`UPDATE assignments SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    return this.getAssignment(id);
  },
  getAssignmentsByDate(classroomId, classDateId) {
    return db.prepare('SELECT * FROM assignments WHERE classroomId = ? AND classDateId = ? ORDER BY createdAt DESC')
      .all(classroomId, classDateId).map(rowToAssignment);
  },
  getSubmissionById(id) {
    return rowToSubmission(db.prepare('SELECT * FROM submissions WHERE id = ?').get(id));
  },
  gradeSubmission(submissionId, score, feedback, gradedBy) {
    db.prepare(`UPDATE submissions SET score = ?, feedback = ?, gradedAt = ?, gradedBy = ? WHERE id = ?`)
      .run(score, feedback || '', new Date().toISOString(), gradedBy || 'admin', submissionId);
    return this.getSubmissionById(submissionId);
  },
  deleteAssignment(id) {
    const subs = db.prepare('SELECT fileUrl FROM submissions WHERE assignmentId = ?').all(id);
    subs.forEach(s => {
      if (s.fileUrl) {
        try { fs.unlinkSync(path.join(SUBMISSIONS_DIR, path.basename(s.fileUrl))); } catch (e) {}
      }
    });
    db.prepare('DELETE FROM submissions WHERE assignmentId = ?').run(id);
    db.prepare('DELETE FROM assignments WHERE id = ?').run(id);
  },

  // ===== Submissions =====
  getAllSubmissions(classroomId) {
    return db.prepare('SELECT * FROM submissions WHERE classroomId = ? ORDER BY submittedAt DESC')
      .all(classroomId).map(rowToSubmission);
  },
  getSubmissionsForAssignment(assignmentId) {
    return db.prepare('SELECT * FROM submissions WHERE assignmentId = ? ORDER BY submittedAt DESC')
      .all(assignmentId).map(rowToSubmission);
  },
  getSubmissionByStudent(assignmentId, studentId) {
    return rowToSubmission(db.prepare('SELECT * FROM submissions WHERE assignmentId = ? AND studentId = ? ORDER BY submittedAt DESC LIMIT 1').get(assignmentId, studentId));
  },
  getSubmissionByGroup(assignmentId, groupNum) {
    return rowToSubmission(db.prepare('SELECT * FROM submissions WHERE assignmentId = ? AND groupNum = ? ORDER BY submittedAt DESC LIMIT 1').get(assignmentId, groupNum));
  },
  upsertSubmission(s) {
    let existing = null;
    if (s.type === 'group' && s.groupNum) {
      existing = db.prepare('SELECT id, fileUrl FROM submissions WHERE assignmentId = ? AND groupNum = ? AND classroomId = ?')
        .get(s.assignmentId, s.groupNum, s.classroomId);
    } else {
      existing = db.prepare('SELECT id, fileUrl FROM submissions WHERE assignmentId = ? AND studentId = ? AND classroomId = ?')
        .get(s.assignmentId, s.studentId, s.classroomId);
    }
    if (existing) {
      // Delete old file if a new one is provided
      if (s.fileUrl && existing.fileUrl && existing.fileUrl !== s.fileUrl) {
        try { fs.unlinkSync(path.join(SUBMISSIONS_DIR, path.basename(existing.fileUrl))); } catch (e) {}
      }
      const sets = ['studentId = ?', 'submittedAt = ?', 'content = ?', 'link = ?'];
      const vals = [s.studentId, s.submittedAt, s.content || '', s.link || ''];
      if (s.fileUrl !== undefined) {
        sets.push('fileUrl = ?', 'fileName = ?');
        vals.push(s.fileUrl || '', s.fileName || '');
      }
      vals.push(existing.id);
      db.prepare(`UPDATE submissions SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
      return rowToSubmission(db.prepare('SELECT * FROM submissions WHERE id = ?').get(existing.id));
    } else {
      const r = db.prepare(`INSERT INTO submissions
        (assignmentId, classroomId, studentId, groupNum, content, link, fileUrl, fileName, submittedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        s.assignmentId, s.classroomId, s.studentId, s.groupNum || '',
        s.content || '', s.link || '', s.fileUrl || '', s.fileName || '', s.submittedAt
      );
      return rowToSubmission(db.prepare('SELECT * FROM submissions WHERE id = ?').get(r.lastInsertRowid));
    }
  }
};
