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
    validGroups TEXT
  );
`);

// ---------- Migrate users / votes to classroom-scoped schema ----------
function migrateSchema() {
  const userCols = db.prepare("PRAGMA table_info(users)").all();
  const userTableExists = userCols.length > 0;
  const userHasCid = userCols.some(c => c.name === 'classroomId');

  if (!userTableExists) {
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        classroomId TEXT NOT NULL,
        studentId TEXT NOT NULL,
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
        UNIQUE(classroomId, studentId)
      );
    `);
  } else if (!userHasCid) {
    console.log('Migrating users → classroom-scoped schema...');
    db.exec(`
      CREATE TABLE users_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        classroomId TEXT NOT NULL,
        studentId TEXT NOT NULL,
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
        UNIQUE(classroomId, studentId)
      );
    `);
    db.exec(`
      INSERT INTO users_new (classroomId, studentId, name, groupNum, registeredAt, selfie, selfieAt, attendance, attendanceUpdatedAt, attendanceSubmittedAt)
      SELECT 'ge-207', studentId, name, groupNum, registeredAt, selfie, selfieAt, attendance, attendanceUpdatedAt, attendanceSubmittedAt FROM users;
    `);
    db.exec(`DROP TABLE users;`);
    db.exec(`ALTER TABLE users_new RENAME TO users;`);
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

// ---------- Default GE 207 classroom ----------
function ensureDefaultClassroom() {
  const cnt = db.prepare('SELECT COUNT(*) c FROM classrooms').get().c;
  if (cnt > 0) return;
  let oldVotingOpen = 0;
  try {
    const r = db.prepare(`SELECT value FROM settings WHERE key = 'votingOpen'`).get();
    if (r) oldVotingOpen = r.value === '1' ? 1 : 0;
  } catch (e) {}
  db.prepare(`INSERT INTO classrooms
    (id, code, name, description, university, createdAt, registrationOpen, votingOpen, peerReviewEnabled, classDates, attendancePercent, validGroups)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, 1, ?, 5, ?)`).run(
    'ge-207',
    'GE 207',
    'รายวิชา GE 207',
    'รายวิชาศึกษาทั่วไป — มหาวิทยาลัยกรุงเทพ',
    'มหาวิทยาลัยกรุงเทพ',
    new Date().toISOString(),
    oldVotingOpen,
    JSON.stringify(DEFAULT_CLASS_DATES),
    JSON.stringify(DEFAULT_GROUPS)
  );
  console.log('Created default classroom: GE 207 (id=ge-207)');
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
function rowToClassroom(r) {
  if (!r) return null;
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
    validGroups: r.validGroups ? JSON.parse(r.validGroups) : DEFAULT_GROUPS
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
    studentId: r.studentId,
    firstName,
    lastName,
    nickname: r.nickname || '',
    name: r.name || ((firstName || lastName) ? `${firstName} ${lastName}`.trim() : ''),
    group: r.groupNum || '',
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

module.exports = {
  DATA_DIR, UPLOADS_DIR,
  DEFAULT_CLASS_DATES, DEFAULT_GROUPS,
  slugify,

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
      (id, code, name, description, university, createdAt, registrationOpen, votingOpen, peerReviewEnabled, classDates, attendancePercent, validGroups)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      c.id, c.code, c.name,
      c.description || '',
      c.university || 'มหาวิทยาลัยกรุงเทพ',
      c.createdAt,
      c.registrationOpen ? 1 : 0,
      c.votingOpen ? 1 : 0,
      c.peerReviewEnabled ? 1 : 0,
      JSON.stringify(c.classDates || DEFAULT_CLASS_DATES),
      c.attendancePercent ?? 5,
      JSON.stringify(c.validGroups || DEFAULT_GROUPS)
    );
    return this.getClassroom(c.id);
  },
  updateClassroom(id, fields) {
    const updates = [];
    const values = [];
    const intFields = ['registrationOpen', 'votingOpen', 'peerReviewEnabled', 'attendancePercent'];
    const strFields = ['code', 'name', 'description', 'university'];
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
  getUser(classroomId, studentId) {
    return rowToUser(db.prepare('SELECT * FROM users WHERE classroomId = ? AND studentId = ?').get(classroomId, studentId));
  },
  addUser(classroomId, u) {
    db.prepare(`INSERT INTO users (classroomId, studentId, firstName, lastName, nickname, name, groupNum, registeredAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      classroomId, u.studentId,
      u.firstName || '', u.lastName || '', u.nickname || '',
      u.name || `${u.firstName || ''} ${u.lastName || ''}`.trim(),
      u.group || '', u.registeredAt
    );
    return this.getUser(classroomId, u.studentId);
  },
  setUserGroup(classroomId, studentId, group) {
    db.prepare('UPDATE users SET groupNum = ? WHERE classroomId = ? AND studentId = ?')
      .run(group || '', classroomId, studentId);
  },
  setSelfie(classroomId, studentId, selfie, ts) {
    db.prepare('UPDATE users SET selfie = ?, selfieAt = ? WHERE classroomId = ? AND studentId = ?')
      .run(selfie, ts, classroomId, studentId);
  },
  setAttendance(classroomId, studentId, attendance, ts, submitted = false) {
    if (submitted) {
      db.prepare('UPDATE users SET attendance = ?, attendanceSubmittedAt = ? WHERE classroomId = ? AND studentId = ?')
        .run(JSON.stringify(attendance), ts, classroomId, studentId);
    } else {
      db.prepare('UPDATE users SET attendance = ?, attendanceUpdatedAt = ? WHERE classroomId = ? AND studentId = ?')
        .run(JSON.stringify(attendance), ts, classroomId, studentId);
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
      votes: this.getAllVotes(classroomId)
    };
  }
};
