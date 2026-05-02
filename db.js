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

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    studentId TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    groupNum TEXT NOT NULL,
    registeredAt TEXT NOT NULL,
    selfie TEXT,
    selfieAt TEXT,
    attendance TEXT,
    attendanceUpdatedAt TEXT,
    attendanceSubmittedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    voterId TEXT NOT NULL,
    targetId TEXT NOT NULL,
    score INTEGER NOT NULL,
    groupNum TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_votes_voter ON votes(voterId);
  CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(targetId);

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );
`);

// One-time migration from data.json (only if DB is empty)
function migrateFromJson() {
  const oldFile = path.join(__dirname, 'data.json');
  if (!fs.existsSync(oldFile)) return;
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const voteCount = db.prepare('SELECT COUNT(*) as c FROM votes').get().c;
  if (userCount > 0 || voteCount > 0) return;
  try {
    const data = JSON.parse(fs.readFileSync(oldFile, 'utf8'));
    const tx = db.transaction(() => {
      const insUser = db.prepare(`INSERT INTO users
        (studentId, name, groupNum, registeredAt, selfie, selfieAt, attendance, attendanceUpdatedAt, attendanceSubmittedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      (data.users || []).forEach(u => insUser.run(
        u.studentId, u.name, u.group, u.registeredAt,
        u.selfie || null, u.selfieAt || null,
        u.attendance ? JSON.stringify(u.attendance) : null,
        u.attendanceUpdatedAt || null,
        u.attendanceSubmittedAt || null
      ));
      const insVote = db.prepare(`INSERT INTO votes (voterId, targetId, score, groupNum, timestamp) VALUES (?, ?, ?, ?, ?)`);
      (data.votes || []).forEach(v => insVote.run(v.voterId, v.targetId, v.score, v.group, v.timestamp));
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('votingOpen', ?)`)
        .run(data.votingOpen ? '1' : '0');
    });
    tx();
    fs.renameSync(oldFile, oldFile + '.migrated');
    console.log('Migrated data.json → SQLite');
  } catch (e) {
    console.error('Migration failed:', e.message);
  }
}
migrateFromJson();

function rowToUser(r) {
  if (!r) return null;
  const u = {
    studentId: r.studentId,
    name: r.name,
    group: r.groupNum,
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
    voterId: v.voterId,
    targetId: v.targetId,
    score: v.score,
    group: v.groupNum,
    timestamp: v.timestamp
  };
}

module.exports = {
  DATA_DIR,
  UPLOADS_DIR,

  getUsers() {
    return db.prepare('SELECT * FROM users').all().map(rowToUser);
  },

  getUser(studentId) {
    return rowToUser(db.prepare('SELECT * FROM users WHERE studentId = ?').get(studentId));
  },

  addUser(u) {
    db.prepare(`INSERT INTO users (studentId, name, groupNum, registeredAt) VALUES (?, ?, ?, ?)`)
      .run(u.studentId, u.name, u.group, u.registeredAt);
    return this.getUser(u.studentId);
  },

  setSelfie(studentId, selfie, ts) {
    db.prepare('UPDATE users SET selfie = ?, selfieAt = ? WHERE studentId = ?')
      .run(selfie, ts, studentId);
  },

  setAttendance(studentId, attendance, ts, submitted = false) {
    if (submitted) {
      db.prepare(`UPDATE users SET attendance = ?, attendanceSubmittedAt = ? WHERE studentId = ?`)
        .run(JSON.stringify(attendance), ts, studentId);
    } else {
      db.prepare(`UPDATE users SET attendance = ?, attendanceUpdatedAt = ? WHERE studentId = ?`)
        .run(JSON.stringify(attendance), ts, studentId);
    }
  },

  hasVoted(voterId) {
    return !!db.prepare('SELECT 1 FROM votes WHERE voterId = ? LIMIT 1').get(voterId);
  },

  votersSet() {
    return new Set(db.prepare('SELECT DISTINCT voterId FROM votes').all().map(r => r.voterId));
  },

  addVotes(voterId, group, scores, ts) {
    const stmt = db.prepare(`INSERT INTO votes (voterId, targetId, score, groupNum, timestamp) VALUES (?, ?, ?, ?, ?)`);
    const tx = db.transaction(() => {
      scores.forEach(s => stmt.run(voterId, s.targetId, s.score, group, ts));
    });
    tx();
  },

  getVotesForTarget(targetId) {
    return db.prepare('SELECT * FROM votes WHERE targetId = ?').all(targetId).map(rowToVote);
  },

  getAllVotes() {
    return db.prepare('SELECT * FROM votes').all().map(rowToVote);
  },

  countVotes() {
    return db.prepare('SELECT COUNT(*) as c FROM votes').get().c;
  },

  getVotingOpen() {
    const r = db.prepare(`SELECT value FROM settings WHERE key = 'votingOpen'`).get();
    return r ? r.value === '1' : false;
  },

  setVotingOpen(open) {
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('votingOpen', ?)`)
      .run(open ? '1' : '0');
  },

  resetVotes() {
    db.prepare('DELETE FROM votes').run();
    db.prepare(`UPDATE users SET attendance = NULL, attendanceUpdatedAt = NULL, attendanceSubmittedAt = NULL`).run();
  },

  resetAll() {
    db.prepare('DELETE FROM votes').run();
    db.prepare('DELETE FROM users').run();
    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('votingOpen', '0')`).run();
    try {
      fs.readdirSync(UPLOADS_DIR).forEach(f => {
        if (f !== '.gitkeep') fs.unlinkSync(path.join(UPLOADS_DIR, f));
      });
    } catch (e) { /* ignore */ }
  },

  rawDump() {
    return {
      users: this.getUsers(),
      votes: this.getAllVotes(),
      votingOpen: this.getVotingOpen()
    };
  }
};
