const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const ATTENDANCE_PERCENT_PER_DAY = 5;

console.log(`Data directory: ${db.DATA_DIR}`);
console.log(`Uploads directory: ${db.UPLOADS_DIR}`);

app.use(express.json({ limit: '10mb' }));
app.use('/uploads', express.static(db.UPLOADS_DIR));

// ===== Page routes (must come before express.static for path-based pages) =====
function sendPage(file) {
  return (req, res) => res.sendFile(path.join(__dirname, 'public', file));
}

app.get('/', sendPage('index.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/c/:cid', sendPage('c-register.html'));
app.get('/c/:cid/selfie', sendPage('selfie.html'));
app.get('/c/:cid/vote', sendPage('vote.html'));
app.get('/c/:cid/dashboard', sendPage('dashboard.html'));
app.get('/c/:cid/admin', sendPage('admin.html'));

app.use(express.static(path.join(__dirname, 'public')));

// ===== Helpers =====
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

function requireAdmin(req, res, next) {
  const auth = req.headers['x-admin-auth'];
  if (auth !== `${ADMIN_USER}:${ADMIN_PASS}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function loadClassroom(req, res, next) {
  const c = db.getClassroom(req.params.cid);
  if (!c) return res.status(404).json({ error: 'ไม่พบห้องเรียน' });
  req.classroom = c;
  next();
}

function displayName(u) {
  if (u.nickname) return u.nickname;
  if (u.firstName || u.lastName) return `${u.firstName} ${u.lastName}`.trim();
  return u.name || u.studentId;
}

function fullName(u) {
  if (u.firstName || u.lastName) return `${u.firstName} ${u.lastName}`.trim();
  return u.name || '';
}

// ==================== Public APIs ====================

app.get('/api/classrooms', (req, res) => {
  const list = db.getClassrooms().map(c => ({
    id: c.id,
    code: c.code,
    name: c.name,
    description: c.description,
    university: c.university,
    registrationOpen: c.registrationOpen,
    peerReviewEnabled: c.peerReviewEnabled,
    studentCount: db.getUsers(c.id).length
  }));
  res.json({ classrooms: list });
});

app.get('/api/c/:cid', loadClassroom, (req, res) => {
  res.json({ classroom: req.classroom });
});

function pickBalancedGroup(classroomId, validGroups) {
  const counts = {};
  validGroups.forEach(g => counts[g] = 0);
  db.getUsers(classroomId).forEach(u => {
    if (u.group && counts[u.group] !== undefined) counts[u.group]++;
  });
  const min = Math.min(...Object.values(counts));
  const candidates = validGroups.filter(g => counts[g] === min);
  return candidates[Math.floor(Math.random() * candidates.length)];
}

app.post('/api/c/:cid/register', loadClassroom, (req, res) => {
  const c = req.classroom;
  if (!c.registrationOpen) {
    return res.status(403).json({ error: 'ห้องเรียนนี้ปิดรับลงทะเบียน' });
  }
  const { studentId, firstName, lastName, nickname, group } = req.body || {};
  if (!studentId || !firstName || !lastName) {
    return res.status(400).json({ error: 'กรุณากรอกชื่อ นามสกุล และรหัสนักศึกษา' });
  }
  const sid = String(studentId).trim();
  const fn = String(firstName).trim();
  const ln = String(lastName).trim();
  const nick = String(nickname || '').trim();
  const grpStr = group ? String(group).trim() : '';

  // Determine group based on assignment mode
  let assignedGroup = '';
  if (c.peerReviewEnabled) {
    const mode = c.groupAssignmentMode || 'self';
    if (mode === 'self') {
      if (!grpStr) return res.status(400).json({ error: 'กรุณาเลือกกลุ่ม' });
      if (!c.validGroups.includes(grpStr)) {
        return res.status(400).json({ error: `กลุ่มต้องเป็น ${c.validGroups.join(', ')}` });
      }
      assignedGroup = grpStr;
    } else if (mode === 'random') {
      // ignore client input, randomly assign balanced
      assignedGroup = pickBalancedGroup(c.id, c.validGroups);
    } else if (mode === 'admin') {
      // leave unassigned
      assignedGroup = '';
    }
  }

  const existing = db.getUser(c.id, sid);
  if (existing) {
    if ((existing.firstName === fn || (!existing.firstName && existing.name && existing.name.split(/\s+/)[0] === fn))
        && (existing.lastName === ln || (!existing.lastName && existing.name && existing.name.split(/\s+/).slice(1).join(' ') === ln))) {
      // Same person logging in again — only update group if mode='self' and provided
      if (c.peerReviewEnabled && c.groupAssignmentMode === 'self' && grpStr && grpStr !== existing.group) {
        db.setUserGroup(c.id, sid, grpStr);
      }
      const fresh = db.getUser(c.id, sid);
      return res.json({ ok: true, user: fresh, message: 'เข้าสู่ระบบสำเร็จ' });
    }
    return res.status(409).json({ error: 'รหัสนักศึกษานี้ถูกใช้ลงทะเบียนแล้วด้วยข้อมูลอื่น' });
  }

  const user = db.addUser(c.id, {
    studentId: sid,
    firstName: fn,
    lastName: ln,
    nickname: nick,
    group: assignedGroup,
    registeredAt: new Date().toISOString()
  });
  let message = 'ลงทะเบียนสำเร็จ';
  if (c.peerReviewEnabled) {
    if (c.groupAssignmentMode === 'random' && assignedGroup) {
      message = `ลงทะเบียนสำเร็จ ระบบสุ่มให้คุณอยู่กลุ่ม ${assignedGroup}`;
    } else if (c.groupAssignmentMode === 'admin') {
      message = 'ลงทะเบียนสำเร็จ ผู้สอนจะกำหนดกลุ่มให้ภายหลัง';
    }
  }
  res.json({ ok: true, user, message });
});

app.post('/api/c/:cid/selfie', loadClassroom, (req, res) => {
  const { studentId, image } = req.body || {};
  if (!studentId || !image) return res.status(400).json({ error: 'ข้อมูลไม่ครบ' });
  const m = String(image).match(/^data:image\/(jpeg|jpg|png|webp);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'รูปไม่ถูกต้อง' });
  const sid = String(studentId).trim();
  const user = db.getUser(req.classroom.id, sid);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  let ext = m[1]; if (ext === 'jpeg') ext = 'jpg';
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'รูปมีขนาดใหญ่เกินไป' });
  const filename = `${req.classroom.id}_${sid}.${ext}`;
  fs.writeFileSync(path.join(db.UPLOADS_DIR, filename), buf);
  const url = `/uploads/${filename}`;
  db.setSelfie(req.classroom.id, sid, url, new Date().toISOString());
  res.json({ ok: true, url });
});

app.get('/api/c/:cid/voting-status', loadClassroom, (req, res) => {
  res.json({
    votingOpen: req.classroom.votingOpen,
    peerReviewEnabled: req.classroom.peerReviewEnabled
  });
});

app.get('/api/c/:cid/class-dates', loadClassroom, (req, res) => {
  res.json({ dates: req.classroom.classDates });
});

app.get('/api/c/:cid/me/:studentId', loadClassroom, (req, res) => {
  const user = db.getUser(req.classroom.id, req.params.studentId);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  res.json({
    user,
    hasVoted: db.hasVoted(req.classroom.id, user.studentId),
    attendance: Array.isArray(user.attendance) ? user.attendance : [],
    votingOpen: req.classroom.votingOpen,
    peerReviewEnabled: req.classroom.peerReviewEnabled
  });
});

app.post('/api/c/:cid/attendance', loadClassroom, (req, res) => {
  const { studentId, attendance } = req.body || {};
  if (!studentId || !Array.isArray(attendance)) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  const sid = String(studentId).trim();
  const user = db.getUser(req.classroom.id, sid);
  if (!user) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (db.hasVoted(req.classroom.id, sid)) {
    return res.status(409).json({ error: 'คุณยืนยันคะแนนแล้ว ไม่สามารถแก้ไขการเข้าเรียนได้' });
  }
  const validIds = req.classroom.classDates.map(d => d.id);
  const cleaned = validIds.filter(id => attendance.includes(id));
  db.setAttendance(req.classroom.id, sid, cleaned, new Date().toISOString(), false);
  res.json({ ok: true, attendance: cleaned });
});

app.get('/api/c/:cid/peers/:studentId', loadClassroom, (req, res) => {
  const me = db.getUser(req.classroom.id, req.params.studentId);
  if (!me) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (!req.classroom.votingOpen) return res.status(403).json({ error: 'ระบบยังไม่เปิดให้โหวต' });
  const peers = db.getUsers(req.classroom.id)
    .filter(u => u.group === me.group && u.studentId !== me.studentId)
    .sort((a, b) => a.studentId.localeCompare(b.studentId))
    .map(p => ({
      studentId: p.studentId,
      name: displayName(p),
      fullName: fullName(p),
      selfie: p.selfie || null
    }));
  res.json({ me, peers, alreadyVoted: db.hasVoted(req.classroom.id, me.studentId) });
});

app.post('/api/c/:cid/vote', loadClassroom, (req, res) => {
  const c = req.classroom;
  const { voterId, scores, attendance } = req.body || {};
  if (!voterId || !Array.isArray(scores)) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  if (!c.votingOpen) return res.status(403).json({ error: 'ระบบยังไม่เปิดให้โหวต' });
  const voter = db.getUser(c.id, voterId);
  if (!voter) return res.status(404).json({ error: 'ไม่พบผู้โหวต' });
  if (db.hasVoted(c.id, voterId)) return res.status(409).json({ error: 'คุณยืนยันคะแนนไปแล้ว' });
  const peers = db.getUsers(c.id).filter(u => u.group === voter.group && u.studentId !== voterId);
  const peerIds = new Set(peers.map(p => p.studentId));
  for (const s of scores) {
    if (!peerIds.has(s.targetId)) return res.status(400).json({ error: `ไม่พบ ${s.targetId} ในกลุ่ม` });
    if (!Number.isInteger(s.score) || s.score < 1 || s.score > 5) {
      return res.status(400).json({ error: 'คะแนนต้องเป็น 1-5' });
    }
  }
  if (scores.length !== peers.length) return res.status(400).json({ error: 'กรุณาโหวตให้ครบทุกคน' });
  const ts = new Date().toISOString();
  db.addVotes(c.id, voterId, voter.group, scores, ts);
  const validIds = c.classDates.map(d => d.id);
  if (Array.isArray(attendance)) {
    db.setAttendance(c.id, voterId, validIds.filter(id => attendance.includes(id)), ts, true);
  } else if (!Array.isArray(voter.attendance)) {
    db.setAttendance(c.id, voterId, [], ts, true);
  } else {
    db.setAttendance(c.id, voterId, voter.attendance, ts, true);
  }
  res.json({ ok: true, message: 'บันทึกคะแนนและการเข้าเรียนเรียบร้อย' });
});

app.get('/api/c/:cid/dashboard', loadClassroom, (req, res) => {
  const c = req.classroom;
  const users = db.getUsers(c.id);
  const voters = db.votersSet(c.id);
  const grouped = {};
  c.validGroups.forEach(g => grouped[g] = []);
  let votedCount = 0;
  users.forEach(u => {
    if (!grouped[u.group]) grouped[u.group] = [];
    const hasVoted = voters.has(u.studentId);
    if (hasVoted) votedCount++;
    grouped[u.group].push({
      studentId: u.studentId,
      name: displayName(u),
      fullName: fullName(u),
      selfie: u.selfie || null,
      hasVoted
    });
  });
  Object.keys(grouped).forEach(g => {
    grouped[g].sort((a, b) => a.studentId.localeCompare(b.studentId));
  });
  res.json({
    classroom: { id: c.id, code: c.code, name: c.name, university: c.university },
    grouped,
    total: users.length,
    votedCount,
    groups: c.validGroups,
    votingOpen: c.votingOpen,
    peerReviewEnabled: c.peerReviewEnabled
  });
});

// ==================== Admin APIs ====================

app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    return res.json({ ok: true, token: `${ADMIN_USER}:${ADMIN_PASS}` });
  }
  res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
});

// --- Classroom CRUD (super-admin) ---

app.get('/api/admin/classrooms', requireAdmin, (req, res) => {
  const list = db.getClassrooms().map(c => ({
    ...c,
    studentCount: db.getUsers(c.id).length,
    voteCount: db.getAllVotes(c.id).length
  }));
  res.json({ classrooms: list });
});

app.post('/api/admin/classrooms', requireAdmin, (req, res) => {
  const { code, name, description, university, peerReviewEnabled, groupCount, groupAssignmentMode } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อวิชา' });
  let id = db.slugify(code);
  let suffix = 1;
  while (db.classroomIdExists(id)) {
    id = `${db.slugify(code)}-${++suffix}`;
  }
  // Compute validGroups from groupCount (default 4)
  const n = Number.isFinite(+groupCount) && +groupCount > 0 ? Math.min(20, Math.floor(+groupCount)) : 4;
  const validGroups = Array.from({ length: n }, (_, i) => String(i + 1));
  const mode = ['self', 'random', 'admin'].includes(groupAssignmentMode) ? groupAssignmentMode : 'self';
  const c = db.createClassroom({
    id,
    code: String(code).trim(),
    name: String(name).trim(),
    description: String(description || '').trim(),
    university: String(university || 'มหาวิทยาลัยกรุงเทพ').trim(),
    createdAt: new Date().toISOString(),
    registrationOpen: true,
    votingOpen: false,
    peerReviewEnabled: peerReviewEnabled !== false,
    validGroups,
    groupAssignmentMode: mode
  });
  res.json({ ok: true, classroom: c });
});

app.patch('/api/admin/classrooms/:cid/groups', requireAdmin, loadClassroom, (req, res) => {
  const { groupCount, groupAssignmentMode } = req.body || {};
  const fields = {};
  if (groupCount !== undefined) {
    const n = Number.isFinite(+groupCount) && +groupCount > 0 ? Math.min(20, Math.floor(+groupCount)) : 4;
    fields.validGroups = Array.from({ length: n }, (_, i) => String(i + 1));
  }
  if (groupAssignmentMode !== undefined && ['self', 'random', 'admin'].includes(groupAssignmentMode)) {
    fields.groupAssignmentMode = groupAssignmentMode;
  }
  const updated = db.updateClassroom(req.classroom.id, fields);
  res.json({ ok: true, classroom: updated });
});

// Randomize groups for ALL students in a classroom (balanced)
app.post('/api/c/:cid/admin/randomize-groups', requireAdmin, loadClassroom, (req, res) => {
  const c = req.classroom;
  if (!c.peerReviewEnabled) return res.status(400).json({ error: 'ห้องนี้ไม่ได้เปิด Peer Review' });
  const users = db.getUsers(c.id);
  if (users.length === 0) return res.json({ ok: true, assigned: 0 });
  // Build balanced random distribution
  const groups = c.validGroups;
  const total = users.length;
  const baseSize = Math.floor(total / groups.length);
  const remainder = total % groups.length;
  // Each group gets baseSize, first `remainder` groups get +1
  const slots = [];
  groups.forEach((g, i) => {
    const size = baseSize + (i < remainder ? 1 : 0);
    for (let k = 0; k < size; k++) slots.push(g);
  });
  // Shuffle slots
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  // Shuffle users to randomize who gets which slot
  const shuffledUsers = [...users];
  for (let i = shuffledUsers.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledUsers[i], shuffledUsers[j]] = [shuffledUsers[j], shuffledUsers[i]];
  }
  shuffledUsers.forEach((u, idx) => {
    db.setUserGroup(c.id, u.studentId, slots[idx]);
  });
  res.json({ ok: true, assigned: total });
});

app.patch('/api/admin/classrooms/:cid', requireAdmin, loadClassroom, (req, res) => {
  const updated = db.updateClassroom(req.classroom.id, req.body || {});
  res.json({ ok: true, classroom: updated });
});

app.delete('/api/admin/classrooms/:cid', requireAdmin, loadClassroom, (req, res) => {
  db.deleteClassroom(req.classroom.id);
  res.json({ ok: true });
});

// --- Per-classroom admin (drill-down) ---

app.get('/api/c/:cid/admin/users', requireAdmin, loadClassroom, (req, res) => {
  const c = req.classroom;
  const users = db.getUsers(c.id).sort((a, b) => {
    if (a.group !== b.group) return (a.group || '').localeCompare(b.group || '');
    return a.studentId.localeCompare(b.studentId);
  });
  const grouped = {};
  users.forEach(u => {
    const g = u.group || '(ไม่มีกลุ่ม)';
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push(u);
  });
  res.json({
    users,
    grouped,
    classroom: c,
    classDates: c.classDates
  });
});

app.get('/api/c/:cid/admin/votes/:studentId', requireAdmin, loadClassroom, (req, res) => {
  const c = req.classroom;
  const target = db.getUser(c.id, req.params.studentId);
  if (!target) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const received = db.getVotesForTarget(c.id, target.studentId);
  const detailed = received.map(v => {
    const voter = db.getUser(c.id, v.voterId);
    return {
      voterId: v.voterId,
      voterName: voter ? displayName(voter) : '(ไม่พบ)',
      score: v.score,
      timestamp: v.timestamp
    };
  });
  const mode = calcMode(received.map(v => v.score));
  res.json({
    user: target,
    votes: detailed,
    count: received.length,
    mode: mode.display,
    modes: mode.modes
  });
});

app.get('/api/c/:cid/admin/scores', requireAdmin, loadClassroom, (req, res) => {
  const c = req.classroom;
  const users = db.getUsers(c.id);
  const allVotes = db.getAllVotes(c.id);
  const result = users.map(u => {
    const received = allVotes.filter(v => v.targetId === u.studentId).map(v => v.score);
    const mode = calcMode(received);
    const att = Array.isArray(u.attendance) ? u.attendance : [];
    return {
      studentId: u.studentId,
      name: displayName(u),
      fullName: fullName(u),
      nickname: u.nickname,
      group: u.group,
      voteCount: received.length,
      modeScore: mode.display,
      scores: received,
      attendance: att,
      attendanceCount: att.length,
      attendanceScore: att.length * ATTENDANCE_PERCENT_PER_DAY,
      selfie: u.selfie || null
    };
  }).sort((a, b) => {
    if (a.group !== b.group) return (a.group || '').localeCompare(b.group || '');
    return a.studentId.localeCompare(b.studentId);
  });
  res.json({
    scores: result,
    classDates: c.classDates,
    attendancePercent: ATTENDANCE_PERCENT_PER_DAY
  });
});

app.post('/api/c/:cid/admin/toggle-voting', requireAdmin, loadClassroom, (req, res) => {
  const next = !req.classroom.votingOpen;
  db.updateClassroom(req.classroom.id, { votingOpen: next });
  res.json({ ok: true, votingOpen: next });
});

app.post('/api/c/:cid/admin/toggle-registration', requireAdmin, loadClassroom, (req, res) => {
  const next = !req.classroom.registrationOpen;
  db.updateClassroom(req.classroom.id, { registrationOpen: next });
  res.json({ ok: true, registrationOpen: next });
});

app.post('/api/c/:cid/admin/set-group', requireAdmin, loadClassroom, (req, res) => {
  const { studentId, group } = req.body || {};
  if (!studentId) return res.status(400).json({ error: 'studentId required' });
  const c = req.classroom;
  if (group && !c.validGroups.includes(String(group))) {
    return res.status(400).json({ error: `กลุ่มต้องเป็น ${c.validGroups.join(', ')}` });
  }
  db.setUserGroup(c.id, studentId, group || '');
  res.json({ ok: true });
});

app.get('/api/c/:cid/admin/export', requireAdmin, loadClassroom, (req, res) => {
  const c = req.classroom;
  const users = db.getUsers(c.id);
  const allVotes = db.getAllVotes(c.id);
  const dateHeaders = c.classDates.map(d => d.label);
  const rows = [[
    'StudentID', 'FirstName', 'LastName', 'Nickname', 'Group',
    'VoteCount', 'ModeScore', 'AllScores',
    ...dateHeaders, 'AttendanceCount', 'AttendanceScore(%)', 'SelfieURL'
  ]];
  const sorted = [...users].sort((a, b) => {
    if (a.group !== b.group) return (a.group || '').localeCompare(b.group || '');
    return a.studentId.localeCompare(b.studentId);
  });
  sorted.forEach(u => {
    const received = allVotes.filter(v => v.targetId === u.studentId).map(v => v.score);
    const mode = calcMode(received);
    const att = Array.isArray(u.attendance) ? u.attendance : [];
    const attCols = c.classDates.map(d => att.includes(d.id) ? 1 : 0);
    rows.push([
      u.studentId, u.firstName || '', u.lastName || '', u.nickname || '', u.group || '',
      received.length, mode.display, received.join('|'),
      ...attCols,
      att.length, att.length * ATTENDANCE_PERCENT_PER_DAY,
      u.selfie || ''
    ]);
  });
  const csv = rows.map(r => r.map(cell => {
    const s = String(cell);
    return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\n');
  const out = '﻿' + csv;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${c.id}-scores-${Date.now()}.csv"`);
  res.send(out);
});

app.get('/api/c/:cid/admin/export-json', requireAdmin, loadClassroom, (req, res) => {
  const exportData = {
    exportedAt: new Date().toISOString(),
    attendancePercent: ATTENDANCE_PERCENT_PER_DAY,
    ...db.rawDump(req.classroom.id)
  };
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.classroom.id}-${Date.now()}.json"`);
  res.send(JSON.stringify(exportData, null, 2));
});

app.post('/api/c/:cid/admin/reset', requireAdmin, loadClassroom, (req, res) => {
  const { what } = req.body || {};
  if (what === 'votes') db.resetVotes(req.classroom.id);
  else if (what === 'all') db.resetAll(req.classroom.id);
  else return res.status(400).json({ error: 'invalid reset target' });
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`Peer Review ทำงานที่ http://localhost:${PORT}`);
});
