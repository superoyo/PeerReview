const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

const ADMIN_USER = 'admin';
const ADMIN_PASS = 'admin123';

const CLASS_DATES = [
  { id: '2026-03-28', label: 'Mar 28, 2026' },
  { id: '2026-04-04', label: 'Apr 4, 2026' },
  { id: '2026-04-18', label: 'Apr 18, 2026' },
  { id: '2026-04-25', label: 'Apr 25, 2026' },
  { id: '2026-05-02', label: 'May 2, 2026' }
];
const VALID_DATE_IDS = new Set(CLASS_DATES.map(d => d.id));
const ATTENDANCE_PERCENT_PER_DAY = 5;
const VALID_GROUPS = ['1', '2', '3', '4'];

const UPLOADS_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    const initial = { users: [], votes: [], votingOpen: false };
    fs.writeFileSync(DATA_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

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
  const data = loadData();
  const existing = data.users.find(u => u.studentId === String(studentId).trim());
  if (existing) {
    if (existing.name === name.trim() && existing.group === grpStr) {
      return res.json({ ok: true, user: existing, message: 'เข้าสู่ระบบสำเร็จ' });
    }
    return res.status(409).json({ error: 'รหัสนักศึกษานี้ถูกลงทะเบียนแล้วด้วยข้อมูลอื่น' });
  }
  const user = {
    studentId: String(studentId).trim(),
    name: name.trim(),
    group: grpStr,
    registeredAt: new Date().toISOString()
  };
  data.users.push(user);
  saveData(data);
  res.json({ ok: true, user, message: 'ลงทะเบียนสำเร็จ' });
});

app.post('/api/selfie', (req, res) => {
  const { studentId, image } = req.body || {};
  if (!studentId || !image) {
    return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  }
  const m = String(image).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'รูปไม่ถูกต้อง' });
  const data = loadData();
  const user = data.users.find(u => u.studentId === String(studentId).trim());
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  let ext = m[1];
  if (ext === 'jpeg') ext = 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) {
    return res.status(413).json({ error: 'รูปมีขนาดใหญ่เกินไป' });
  }
  const filename = `${user.studentId}.${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
  user.selfie = `/uploads/${filename}`;
  user.selfieAt = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, url: user.selfie });
});

app.get('/api/dashboard', (req, res) => {
  const data = loadData();
  const voterIds = new Set(data.votes.map(v => v.voterId));
  const grouped = {};
  VALID_GROUPS.forEach(g => grouped[g] = []);
  let votedCount = 0;
  data.users.forEach(u => {
    if (grouped[u.group]) {
      const hasVoted = voterIds.has(u.studentId);
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
    total: data.users.length,
    votedCount,
    groups: VALID_GROUPS,
    votingOpen: data.votingOpen
  });
});

app.get('/api/voting-status', (req, res) => {
  const data = loadData();
  res.json({ votingOpen: data.votingOpen });
});

app.get('/api/class-dates', (req, res) => {
  res.json({ dates: CLASS_DATES });
});

app.get('/api/me/:studentId', (req, res) => {
  const data = loadData();
  const user = data.users.find(u => u.studentId === req.params.studentId);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const hasVoted = data.votes.some(v => v.voterId === user.studentId);
  res.json({
    user,
    hasVoted,
    attendance: Array.isArray(user.attendance) ? user.attendance : [],
    votingOpen: data.votingOpen
  });
});

app.post('/api/attendance', (req, res) => {
  const { studentId, attendance } = req.body || {};
  if (!studentId || !Array.isArray(attendance)) {
    return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  }
  const data = loadData();
  const user = data.users.find(u => u.studentId === String(studentId).trim());
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (data.votes.some(v => v.voterId === user.studentId)) {
    return res.status(409).json({ error: 'คุณยืนยันคะแนนแล้ว ไม่สามารถแก้ไขการเข้าเรียนได้' });
  }
  user.attendance = CLASS_DATES.map(d => d.id).filter(id => attendance.includes(id));
  user.attendanceUpdatedAt = new Date().toISOString();
  saveData(data);
  res.json({ ok: true, attendance: user.attendance });
});

app.get('/api/peers/:studentId', (req, res) => {
  const data = loadData();
  const me = data.users.find(u => u.studentId === req.params.studentId);
  if (!me) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (!data.votingOpen) return res.status(403).json({ error: 'ระบบยังไม่เปิดให้โหวต' });
  const peers = data.users
    .filter(u => u.group === me.group && u.studentId !== me.studentId)
    .sort((a, b) => a.studentId.localeCompare(b.studentId))
    .map(p => ({ studentId: p.studentId, name: p.name }));
  const alreadyVoted = data.votes.some(v => v.voterId === me.studentId);
  res.json({ me, peers, alreadyVoted });
});

app.post('/api/vote', (req, res) => {
  const { voterId, scores, attendance } = req.body || {};
  if (!voterId || !Array.isArray(scores)) {
    return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  }
  const data = loadData();
  if (!data.votingOpen) return res.status(403).json({ error: 'ระบบยังไม่เปิดให้โหวต' });
  const voter = data.users.find(u => u.studentId === voterId);
  if (!voter) return res.status(404).json({ error: 'ไม่พบผู้โหวต' });
  if (data.votes.some(v => v.voterId === voterId)) {
    return res.status(409).json({ error: 'คุณยืนยันคะแนนไปแล้ว' });
  }
  const peers = data.users.filter(u => u.group === voter.group && u.studentId !== voterId);
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
  scores.forEach(s => {
    data.votes.push({
      voterId,
      targetId: s.targetId,
      score: s.score,
      group: voter.group,
      timestamp: ts
    });
  });
  if (Array.isArray(attendance)) {
    voter.attendance = CLASS_DATES.map(d => d.id).filter(id => attendance.includes(id));
  } else if (!Array.isArray(voter.attendance)) {
    voter.attendance = [];
  }
  voter.attendanceSubmittedAt = ts;
  saveData(data);
  res.json({ ok: true, message: 'บันทึกคะแนนและการเข้าเรียนเรียบร้อย' });
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
  const data = loadData();
  const users = [...data.users].sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.studentId.localeCompare(b.studentId);
  });
  const grouped = {};
  users.forEach(u => {
    if (!grouped[u.group]) grouped[u.group] = [];
    grouped[u.group].push(u);
  });
  res.json({ users, grouped, votingOpen: data.votingOpen, classDates: CLASS_DATES });
});

app.get('/api/admin/votes/:studentId', requireAdmin, (req, res) => {
  const data = loadData();
  const target = data.users.find(u => u.studentId === req.params.studentId);
  if (!target) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const received = data.votes.filter(v => v.targetId === target.studentId);
  const detailed = received.map(v => {
    const voter = data.users.find(u => u.studentId === v.voterId);
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
  const data = loadData();
  const result = data.users.map(u => {
    const received = data.votes.filter(v => v.targetId === u.studentId).map(v => v.score);
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
  const data = loadData();
  data.votingOpen = !data.votingOpen;
  saveData(data);
  res.json({ ok: true, votingOpen: data.votingOpen });
});

app.get('/api/admin/export', requireAdmin, (req, res) => {
  const data = loadData();
  const dateHeaders = CLASS_DATES.map(d => d.label);
  const rows = [[
    'StudentID', 'Name', 'Group', 'VoteCount', 'ModeScore', 'AllScores',
    ...dateHeaders, 'AttendanceCount', 'AttendanceScore(%)', 'SelfieURL'
  ]];
  const sorted = [...data.users].sort((a, b) => {
    if (a.group !== b.group) return a.group.localeCompare(b.group);
    return a.studentId.localeCompare(b.studentId);
  });
  sorted.forEach(u => {
    const received = data.votes.filter(v => v.targetId === u.studentId).map(v => v.score);
    const mode = calcMode(received);
    const attendance = Array.isArray(u.attendance) ? u.attendance : [];
    const attendCols = CLASS_DATES.map(d => attendance.includes(d.id) ? 1 : 0);
    rows.push([
      u.studentId,
      u.name,
      u.group,
      received.length,
      mode.display,
      received.join('|'),
      ...attendCols,
      attendance.length,
      attendance.length * ATTENDANCE_PERCENT_PER_DAY,
      u.selfie || ''
    ]);
  });
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  // BOM for Excel Thai support
  const out = '﻿' + csv;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="peer-review-scores-${Date.now()}.csv"`);
  res.send(out);
});

app.get('/api/admin/export-json', requireAdmin, (req, res) => {
  const data = loadData();
  const exportData = {
    exportedAt: new Date().toISOString(),
    classDates: CLASS_DATES,
    attendancePercent: ATTENDANCE_PERCENT_PER_DAY,
    validGroups: VALID_GROUPS,
    ...data
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="peer-review-data-${Date.now()}.json"`);
  res.send(JSON.stringify(exportData, null, 2));
});

app.post('/api/admin/reset', requireAdmin, (req, res) => {
  const { what } = req.body || {};
  const data = loadData();
  if (what === 'votes') {
    data.votes = [];
  } else if (what === 'all') {
    data.users = [];
    data.votes = [];
    data.votingOpen = false;
    try {
      fs.readdirSync(UPLOADS_DIR).forEach(f => {
        if (f !== '.gitkeep') fs.unlinkSync(path.join(UPLOADS_DIR, f));
      });
    } catch (e) { /* ignore */ }
  } else {
    return res.status(400).json({ error: 'invalid reset target' });
  }
  saveData(data);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Peer Review ทำงานที่ http://localhost:${PORT}`);
});
