const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';

const CLASS_DATES = [
  { id: '2026-03-28', label: 'Mar 28, 2026' },
  { id: '2026-04-04', label: 'Apr 4, 2026' },
  { id: '2026-04-18', label: 'Apr 18, 2026' },
  { id: '2026-04-25', label: 'Apr 25, 2026' },
  { id: '2026-05-02', label: 'May 2, 2026' }
];
const ATTENDANCE_PERCENT_PER_DAY = 5;
const VALID_GROUPS = ['1', '2', '3', '4'];

console.log(`Data directory: ${db.DATA_DIR}`);
console.log(`Uploads directory: ${db.UPLOADS_DIR}`);

app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(db.UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

function calcMode(scores) {
  if (!scores.length) return { modes: [], display: '-' };
  const freq = {};
  scores.forEach(s => { freq[s] = (freq[s] || 0) + 1; });
  const max = Math.max(...Object.values(freq));
  const modes = Object.keys(freq)
    .filter(k => freq[k] === max)
    .map(Number)
    .sort((a, b) => a - b);
  return { modes, display: modes.join(', ') };
}

// ==================== Public APIs ====================

app.post('/api/register', (req, res) => {
  const { studentId, name, group } = req.body || {};
  if (!studentId || !name || !group) {
    return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  }
  const grpStr = String(group).trim();
  if (!VALID_GROUPS.includes(grpStr)) {
    return res.status(400).json({ error: 'กลุ่มต้องเป็น 1, 2, 3, หรือ 4' });
  }
  const sid = String(studentId).trim();
  const nameStr = String(name).trim();
  const existing = db.getUser(sid);
  if (existing) {
    if (existing.name === nameStr && existing.group === grpStr) {
      return res.json({ ok: true, user: existing, message: 'เข้าสู่ระบบสำเร็จ' });
    }
    return res.status(409).json({ error: 'รหัสนักศึกษานี้ถูกลงทะเบียนแล้วด้วยข้อมูลอื่น' });
  }
  const user = db.addUser({
    studentId: sid,
    name: nameStr,
    group: grpStr,
    registeredAt: new Date().toISOString()
  });
  res.json({ ok: true, user, message: 'ลงทะเบียนสำเร็จ' });
});

app.post('/api/selfie', (req, res) => {
  const { studentId, image } = req.body || {};
  if (!studentId || !image) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  }
  const m = String(image).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'รูปไม่ถูกต้อง' });
  const sid = String(studentId).trim();
  const user = db.getUser(sid);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  let ext = m[1];
  if (ext === 'jpeg') ext = 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: 'รูปมีขนาดใหญ่เกินไป' });
  }
  const filename = `${sid}.${ext}`;
  fs.writeFileSync(path.join(db.UPLOADS_DIR, filename), buf);
  const url = `/uploads/${filename}`;
  db.setSelfie(sid, url, new Date().toISOString());
  res.json({ ok: true, url });
});

app.get('/api/voting-status', (req, res) => {
  res.json({ votingOpen: db.getVotingOpen() });
});

app.get('/api/class-dates', (req, res) => {
  res.json({ dates: CLASS_DATES });
});

app.get('/api/me/:studentId', (req, res) => {
  const user = db.getUser(req.params.studentId);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  res.json({
    user,
    hasVoted: db.hasVoted(user.studentId),
    attendance: Array.isArray(user.attendance) ? user.attendance : [],
    votingOpen: db.getVotingOpen()
  });
});

app.post('/api/attendance', (req, res) => {
  const { studentId, attendance } = req.body || {};
  if (!studentId || !Array.isArray(attendance)) {
    return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  }
  const sid = String(studentId).trim();
  const user = db.getUser(sid);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (db.hasVoted(sid)) {
    return res.status(409).json({ error: 'คุณยืนยันคะแนนแล้ว ไม่สามารถแก้ไขการเข้าเรียนได้' });
  }
  const cleaned = CLASS_DATES.map(d => d.id).filter(id => attendance.includes(id));
  db.setAttendance(sid, cleaned, new Date().toISOString(), false);
  res.json({ ok: true, attendance: cleaned });
});

app.get('/api/peers/:studentId', (req, res) => {
  const me = db.getUser(req.params.studentId);
  if (!me) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (!db.getVotingOpen()) return res.status(403).json({ error: 'ระบบยังไม่เปิดให้โหวต' });
  const peers = db.getUsers()
    .filter(u => u.group === me.group && u.studentId !== me.studentId)
    .sort((a, b) => a.studentId.localeCompare(b.studentId))
    .map(p => ({ studentId: p.studentId, name: p.name }));
  res.json({ me, peers, alreadyVoted: db.hasVoted(me.studentId) });
});

app.post('/api/vote', (req, res) => {
  const { voterId, scores, attendance } = req.body || {};
  if (!voterId || !Array.isArray(scores)) {
    return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  }
  if (!db.getVotingOpen()) return res.status(403).json({ error: 'ระบบยังไม่เปิดให้โหวต' });
  const voter = db.getUser(voterId);
  if (!voter) return res.status(404).json({ error: 'ไม่พบผู้โหวต' });
  if (db.hasVoted(voterId)) {
    return res.status(409).json({ error: 'คุณยืนยันคะแนนไปแล้ว' });
  }
  const peers = db.getUsers().filter(u => u.group === voter.group && u.studentId !== voterId);
  const peerIds = new Set(peers.map(p => p.studentId));
  for (const s of scores) {
    if (!peerIds.has(s.targetId)) {
      return res.status(400).json({ error: `ไม่พบ ${s.targetId} ในกลุ่ม` });
    }
    if (!Number.isInteger(s.score) || s.score < 1 || s.score > 5) {
      return res.status(400).json({ error: 'คะแนนต้องเป็น 1-5' });
    }
  }
  if (scores.length !== peers.length) {
    return res.status(400).json({ error: 'กรุณาโหวตให้ครบทุกคน' });
  }
  const ts = new Date().toISOString();
  db.addVotes(voterId, voter.group, scores, ts);
  if (Array.isArray(attendance)) {
    const cleaned = CLASS_DATES.map(d => d.id).filter(id => attendance.includes(id));
    db.setAttendance(voterId, cleaned, ts, true);
  } else if (!Array.isArray(voter.attendance)) {
    db.setAttendance(voterId, [], ts, true);
  } else {
    db.setAttendance(voterId, voter.attendance, ts, true);
  }
  res.json({ ok: true, message: 'บันทึกคะแนนและการเข้าเรียนเรียบร้อย' });
});

app.get('/api/dashboard', (req, res) => {
  const users = db.getUsers();
  const voters = db.votersSet();
  const grouped = {};
  VALID_GROUPS.forEach(g => grouped[g] = []);
  let votedCount = 0;
  users.forEach(u => {
    if (grouped[u.group]) {
      const hasVoted = voters.has(u.studentId);
      if (hasVoted) votedCount++;
      grouped[u.group].push({
        studentId: u.studentId,
        name: u.name,
        selfie: u.selfie || null,
        hasVoted
      });
    }
  });
  Object.keys(grouped).forEach(g => {
    grouped[g].sort((a, b) => a.studentId.localeCompare(b.studentId));
  });
  res.json({
    grouped,
    total: users.length,
    votedCount,
    groups: VALID_GROUPS,
    votingOpen: db.getVotingOpen()
  });
});

// ==================== Admin APIs ====================

function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-auth'];
  if (auth !== `${ADMIN_USER}:${ADMIN_PASS}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ ok: true, token: `${ADMIN_USER}:${ADMIN_PASS}` });
  }
  res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const users = db.getUsers().sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.studentId.localeCompare(b.studentId);
  });
  const grouped = {};
  users.forEach(u => {
    if (!grouped[u.group]) grouped[u.group] = [];
    grouped[u.group].push(u);
  });
  res.json({
    users,
    grouped,
    votingOpen: db.getVotingOpen(),
    classDates: CLASS_DATES
  });
});

app.get('/api/admin/votes/:studentId', requireAdmin, (req, res) => {
  const target = db.getUser(req.params.studentId);
  if (!target) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const received = db.getVotesForTarget(target.studentId);
  const detailed = received.map(v => {
    const voter = db.getUser(v.voterId);
    return {
      voterId: v.voterId,
      voterName: voter ? voter.name : '(ไม่พบ)',
      score: v.score,
      timestamp: v.timestamp
    };
  });
  const scoreList = received.map(v => v.score);
  const mode = calcMode(scoreList);
  res.json({
    user: target,
    votes: detailed,
    count: received.length,
    mode: mode.display,
    modes: mode.modes
  });
});

app.get('/api/admin/scores', requireAdmin, (req, res) => {
  const users = db.getUsers();
  const allVotes = db.getAllVotes();
  const result = users.map(u => {
    const received = allVotes.filter(v => v.targetId === u.studentId).map(v => v.score);
    const mode = calcMode(received);
    const attendance = Array.isArray(u.attendance) ? u.attendance : [];
    return {
      studentId: u.studentId,
      name: u.name,
      group: u.group,
      voteCount: received.length,
      modeScore: mode.display,
      scores: received,
      attendance,
      attendanceCount: attendance.length,
      attendanceScore: attendance.length * ATTENDANCE_PERCENT_PER_DAY,
      selfie: u.selfie || null
    };
  }).sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.studentId.localeCompare(b.studentId);
  });
  res.json({
    scores: result,
    classDates: CLASS_DATES,
    attendancePercent: ATTENDANCE_PERCENT_PER_DAY
  });
});

app.post('/api/admin/toggle-voting', requireAdmin, (req, res) => {
  const next = !db.getVotingOpen();
  db.setVotingOpen(next);
  res.json({ ok: true, votingOpen: next });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const users = db.getUsers();
  const allVotes = db.getAllVotes();
  const dateHeaders = CLASS_DATES.map(d => d.label);
  const rows = [[
    'StudentID', 'Name', 'Group', 'VoteCount', 'ModeScore', 'AllScores',
    ...dateHeaders, 'AttendanceCount', 'AttendanceScore(%)', 'SelfieURL'
  ]];
  const sorted = [...users].sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.studentId.localeCompare(b.studentId);
  });
  sorted.forEach(u => {
    const received = allVotes.filter(v => v.targetId === u.studentId).map(v => v.score);
    const mode = calcMode(received);
    const attendance = Array.isArray(u.attendance) ? u.attendance : [];
    const attendCols = CLASS_DATES.map(d => attendance.includes(d.id) ? 1 : 0);
    rows.push([
      u.studentId, u.name, u.group, received.length, mode.display,
      received.join('|'), ...attendCols,
      attendance.length, attendance.length * ATTENDANCE_PERCENT_PER_DAY,
      u.selfie || ''
    ]);
  });
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const out = '﻿' + csv;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="peer-review-scores-${Date.now()}.csv"`);
  res.send(out);
});

app.get('/api/admin/export-json', requireAdmin, (req, res) => {
  const exportData = {
    exportedAt: new Date().toISOString(),
    classDates: CLASS_DATES,
    attendancePercent: ATTENDANCE_PERCENT_PER_DAY,
    validGroups: VALID_GROUPS,
    ...db.rawDump()
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="peer-review-data-${Date.now()}.json"`);
  res.send(JSON.stringify(exportData, null, 2));
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const { what } = req.body || {};
  if (what === 'votes') {
    db.resetVotes();
  } else if (what === 'all') {
    db.resetAll();
  } else {
    return res.status(400).json({ error: 'invalid reset target' });
  }
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Peer Review ทำงานที่ http://localhost:${PORT}`);
});
