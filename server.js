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

app.use(express.json({ limit: '12mb' }));

// Disable HTML caching so users always get latest pages
app.use((req, res, next) => {
  if (req.method === 'GET' && (req.path === '/' || req.path === '/admin' ||
      req.path.startsWith('/c/') || req.path.endsWith('.html'))) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
  next();
});

app.use('/uploads', express.static(db.UPLOADS_DIR));

// ===== Page routes (must come before express.static for path-based pages) =====
function sendPage(file) {
  return (req, res) => res.sendFile(path.join(__dirname, 'public', file), {
    headers: {
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    }
  });
}

app.get('/', sendPage('index.html'));
app.get('/admin', sendPage('admin.html'));
app.get('/c/:cid', sendPage('c-register.html'));
app.get('/c/:cid/selfie', sendPage('selfie.html'));
app.get('/c/:cid/feed', sendPage('feed.html'));
app.get('/c/:cid/profile', sendPage('profile.html'));
app.get('/c/:cid/calendar', sendPage('calendar.html'));
app.get('/c/:cid/vote', sendPage('vote.html'));
app.get('/c/:cid/assignments', sendPage('assignments.html'));
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
  const list = db.getClassrooms()
    .filter(c => c.isPublic)
    .map(c => ({
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

function normalizePhone(s) {
  return String(s || '').replace(/[^\d+]/g, '').trim();
}

// Check if a phone is already registered in this classroom
app.post('/api/c/:cid/check-phone', loadClassroom, (req, res) => {
  const phone = normalizePhone(req.body && req.body.phone);
  if (!phone) return res.status(400).json({ error: 'กรุณากรอกเบอร์มือถือ' });
  const u = db.getUserByPhone(req.classroom.id, phone);
  if (u) {
    res.json({ exists: true, user: { phone: u.phone, firstName: u.firstName, lastName: u.lastName, nickname: u.nickname, studentId: u.studentId, group: u.group } });
  } else {
    res.json({ exists: false });
  }
});

// Validate enroll code without registering — used in step 2 of registration UI
app.post('/api/c/:cid/validate-enroll-code', loadClassroom, (req, res) => {
  const code = String((req.body && req.body.enrollCode) || '').trim();
  if (!code) return res.status(400).json({ error: 'กรุณากรอกรหัสคลาส' });
  if (code !== req.classroom.enrollCode) {
    return res.status(403).json({ error: 'รหัสคลาสไม่ถูกต้อง' });
  }
  res.json({ ok: true });
});

app.post('/api/c/:cid/register', loadClassroom, (req, res) => {
  const c = req.classroom;
  if (!c.registrationOpen) {
    return res.status(403).json({ error: 'ห้องเรียนนี้ปิดรับลงทะเบียน' });
  }
  const body = req.body || {};
  const { phone, studentId, firstName, lastName, nickname, group, enrollCode,
          faculty, department, university, company, position } = body;
  const ph = normalizePhone(phone);
  if (!ph) return res.status(400).json({ error: 'กรุณากรอกเบอร์มือถือ' });
  // No enroll code required — anyone with the link can register

  // Note: phone uniqueness is NOT enforced — any phone may register multiple times
  // (each registration creates a separate user record)

  // Validate required fields based on classroom profileFields config
  const fn = String(firstName || '').trim();
  const ln = String(lastName || '').trim();
  const sid = String(studentId || '').trim();
  const nick = String(nickname || '').trim();
  const fac = String(faculty || '').trim();
  const dept = String(department || '').trim();
  const uni = String(university || '').trim() || (c.university || '');
  const co = String(company || '').trim();
  const pos = String(position || '').trim();
  const grpStr = group ? String(group).trim() : '';

  const fieldVals = {
    name: (fn || ln) ? 'has' : '',
    nickname: nick, studentId: sid, faculty: fac, department: dept,
    university: uni, company: co, position: pos
  };
  for (const f of (c.profileFields || [])) {
    if (!f.enabled || !f.required) continue;
    if (!fieldVals[f.key]) {
      return res.status(400).json({ error: `กรุณากรอก ${f.label}` });
    }
  }

  let assignedGroup = '';
  if (c.peerReviewEnabled) {
    const mode = c.groupAssignmentMode || 'self';
    if (mode === 'self') {
      // Allow empty group — student can set later via Profile
      if (grpStr) {
        if (!c.validGroups.includes(grpStr)) {
          return res.status(400).json({ error: `กลุ่มต้องเป็น ${c.validGroups.join(', ')}` });
        }
        assignedGroup = grpStr;
      }
    } else if (mode === 'random') {
      assignedGroup = pickBalancedGroup(c.id, c.validGroups);
    } else if (mode === 'admin') {
      assignedGroup = '';
    }
  }

  try {
    const user = db.addUser(c.id, {
      phone: ph,
      studentId: sid,
      firstName: fn,
      lastName: ln,
      nickname: nick,
      group: assignedGroup,
      faculty: fac,
      department: dept,
      university: uni,
      company: co,
      position: pos,
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
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update profile fields
app.patch('/api/c/:cid/me/:phone', loadClassroom, (req, res) => {
  const u = db.getUser(req.classroom.id, req.params.phone);
  if (!u) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const fields = req.body || {};
  // Only allow specific fields. Group is NOT allowed here — set at registration only,
  // or by admin via /api/c/:cid/admin/set-group
  const allowed = {};
  ['firstName', 'lastName', 'nickname', 'studentId',
   'faculty', 'department', 'university', 'company', 'position'].forEach(k => {
    if (fields[k] !== undefined) allowed[k] = String(fields[k]).trim();
  });
  const updated = db.updateUser(req.classroom.id, req.params.phone, allowed);
  res.json({ ok: true, user: updated });
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
    .filter(u => u.group === me.group && u.id !== me.id)
    .sort((a, b) => (a.studentId || a.phone || '').localeCompare(b.studentId || b.phone || ''))
    .map(p => ({
      studentId: p.studentId,
      phone: p.phone,
      name: displayName(p),
      fullName: fullName(p),
      selfie: p.selfie || null
    }));
  const voterId = me.phone || me.studentId;
  res.json({ me, peers, alreadyVoted: db.hasVoted(req.classroom.id, voterId) });
});

app.post('/api/c/:cid/vote', loadClassroom, (req, res) => {
  const c = req.classroom;
  const { voterId, scores, attendance } = req.body || {};
  if (!voterId || !Array.isArray(scores)) return res.status(400).json({ error: 'ข้อมูลไม่ถูกต้อง' });
  if (!c.votingOpen) return res.status(403).json({ error: 'ระบบยังไม่เปิดให้โหวต' });
  const voter = db.getUser(c.id, voterId);
  if (!voter) return res.status(404).json({ error: 'ไม่พบผู้โหวต' });
  const voterKey = voter.phone || voter.studentId;
  if (db.hasVoted(c.id, voterKey)) return res.status(409).json({ error: 'คุณยืนยันคะแนนไปแล้ว' });
  const peers = db.getUsers(c.id).filter(u => u.group === voter.group && u.id !== voter.id);
  const peerKeys = new Set();
  peers.forEach(p => { if (p.phone) peerKeys.add(p.phone); if (p.studentId) peerKeys.add(p.studentId); });
  for (const s of scores) {
    if (!peerKeys.has(s.targetId)) return res.status(400).json({ error: `ไม่พบ ${s.targetId} ในกลุ่ม` });
    if (!Number.isInteger(s.score) || s.score < 1 || s.score > 5) {
      return res.status(400).json({ error: 'คะแนนต้องเป็น 1-5' });
    }
  }
  if (scores.length !== peers.length) return res.status(400).json({ error: 'กรุณาโหวตให้ครบทุกคน' });
  const ts = new Date().toISOString();
  db.addVotes(c.id, voterKey, voter.group, scores, ts);
  const validIds = c.classDates.map(d => d.id);
  if (Array.isArray(attendance)) {
    db.setAttendance(c.id, voterKey, validIds.filter(id => attendance.includes(id)), ts, true);
  } else if (!Array.isArray(voter.attendance)) {
    db.setAttendance(c.id, voterKey, [], ts, true);
  } else {
    db.setAttendance(c.id, voterKey, voter.attendance, ts, true);
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
    const hasVoted = voters.has(u.phone) || voters.has(u.studentId);
    if (hasVoted) votedCount++;
    grouped[u.group].push({
      studentId: u.studentId,
      phone: u.phone,
      firstName: u.firstName,
      lastName: u.lastName,
      nickname: u.nickname,
      faculty: u.faculty,
      department: u.department,
      university: u.university,
      company: u.company,
      position: u.position,
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
    peerReviewEnabled: c.peerReviewEnabled,
    profileFields: c.profileFields
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
  const { code, name, description, university, peerReviewEnabled, groupCount, groupAssignmentMode, profileFields } = req.body || {};
  if (!code || !name) return res.status(400).json({ error: 'กรุณากรอกรหัสและชื่อวิชา' });
  let id = db.slugify(code);
  let suffix = 1;
  while (db.classroomIdExists(id)) {
    id = `${db.slugify(code)}-${++suffix}`;
  }
  const n = Number.isFinite(+groupCount) && +groupCount > 0 ? Math.min(20, Math.floor(+groupCount)) : 4;
  const validGroups = Array.from({ length: n }, (_, i) => String(i + 1));
  const mode = ['self', 'random', 'admin'].includes(groupAssignmentMode) ? groupAssignmentMode : 'self';
  // Validate profileFields structure
  let pf = null;
  if (Array.isArray(profileFields)) {
    pf = profileFields.map(f => ({
      key: String(f.key || ''),
      enabled: !!f.enabled,
      required: !!f.required,
      showOnDashboard: !!f.showOnDashboard
    })).filter(f => f.key);
  }
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
    groupAssignmentMode: mode,
    profileFields: pf
  });
  res.json({ ok: true, classroom: c });
});

// Update profileFields config of a classroom
app.patch('/api/admin/classrooms/:cid/profile-fields', requireAdmin, loadClassroom, (req, res) => {
  const { profileFields, university } = req.body || {};
  const fields = {};
  if (Array.isArray(profileFields)) {
    fields.profileFields = profileFields.map(f => ({
      key: String(f.key || ''),
      enabled: !!f.enabled,
      required: !!f.required,
      showOnDashboard: !!f.showOnDashboard
    })).filter(f => f.key);
  }
  if (university !== undefined) fields.university = String(university);
  const updated = db.updateClassroom(req.classroom.id, fields);
  res.json({ ok: true, classroom: updated });
});

app.post('/api/admin/classrooms/:cid/regenerate-enroll-code', requireAdmin, loadClassroom, (req, res) => {
  const code = db.regenerateEnrollCode(req.classroom.id);
  res.json({ ok: true, enrollCode: code });
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
  const allVotes = db.getAllVotes(c.id);
  const received = allVotes.filter(v => v.targetId === target.phone || v.targetId === target.studentId);
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
    const received = allVotes.filter(v => v.targetId === u.phone || v.targetId === u.studentId).map(v => v.score);
    const mode = calcMode(received);
    const att = Array.isArray(u.attendance) ? u.attendance : [];
    return {
      studentId: u.studentId,
      phone: u.phone,
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
    return (a.studentId || a.phone || '').localeCompare(b.studentId || b.phone || '');
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

// Admin: update any user's fields (inline edit from users table)
app.patch('/api/c/:cid/admin/users/:userKey', requireAdmin, loadClassroom, (req, res) => {
  const u = db.getUser(req.classroom.id, req.params.userKey);
  if (!u) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const fields = req.body || {};
  const allowed = {};
  ['firstName', 'lastName', 'nickname', 'studentId',
   'faculty', 'department', 'university', 'company', 'position'].forEach(k => {
    if (fields[k] !== undefined) allowed[k] = String(fields[k]).trim();
  });
  if (fields.group !== undefined) {
    const c = req.classroom;
    const g = String(fields.group || '').trim();
    if (g && c.peerReviewEnabled && !c.validGroups.includes(g)) {
      return res.status(400).json({ error: `กลุ่มต้องเป็น ${c.validGroups.join(', ')}` });
    }
    allowed.group = g;
  }
  const updated = db.updateUser(req.classroom.id, req.params.userKey, allowed);
  res.json({ ok: true, user: updated });
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
    'Phone', 'StudentID', 'FirstName', 'LastName', 'Nickname', 'Group',
    'VoteCount', 'ModeScore', 'AllScores',
    ...dateHeaders, 'AttendanceCount', 'AttendanceScore(%)', 'SelfieURL'
  ]];
  const sorted = [...users].sort((a, b) => {
    if (a.group !== b.group) return (a.group || '').localeCompare(b.group || '');
    return (a.studentId || a.phone || '').localeCompare(b.studentId || b.phone || '');
  });
  sorted.forEach(u => {
    const received = allVotes.filter(v => v.targetId === u.phone || v.targetId === u.studentId).map(v => v.score);
    const mode = calcMode(received);
    const att = Array.isArray(u.attendance) ? u.attendance : [];
    const attCols = c.classDates.map(d => att.includes(d.id) ? 1 : 0);
    rows.push([
      u.phone || '', u.studentId || '', u.firstName || '', u.lastName || '', u.nickname || '', u.group || '',
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

// ==================== Feed (classroom hub) APIs ====================

app.get('/api/c/:cid/feed/:studentId', loadClassroom, (req, res) => {
  const c = req.classroom;
  const me = db.getUser(c.id, req.params.studentId);
  if (!me) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const allUsers = db.getUsers(c.id);
  const myGroup = me.group || null;
  const grouped = {};
  c.validGroups.forEach(g => grouped[g] = []);
  allUsers.forEach(u => {
    const g = u.group || '(ยังไม่มีกลุ่ม)';
    if (!grouped[g]) grouped[g] = [];
    grouped[g].push({
      studentId: u.studentId,
      name: displayName(u),
      fullName: fullName(u),
      nickname: u.nickname,
      selfie: u.selfie || null,
      isMe: u.studentId === me.studentId
    });
  });
  Object.keys(grouped).forEach(g => grouped[g].sort((a, b) => a.studentId.localeCompare(b.studentId)));
  res.json({
    classroom: { id: c.id, code: c.code, name: c.name, university: c.university,
                 peerReviewEnabled: c.peerReviewEnabled, votingOpen: c.votingOpen },
    me,
    myGroup,
    grouped,
    groups: c.validGroups,
    assignmentCount: db.getAssignments(c.id).filter(a => a.isOpen).length
  });
});

// ==================== Assignment APIs ====================

app.get('/api/c/:cid/assignments', loadClassroom, (req, res) => {
  const list = db.getAssignments(req.classroom.id);
  res.json({ assignments: list });
});

app.get('/api/c/:cid/assignments/:aid/submission/:studentId', loadClassroom, (req, res) => {
  const a = db.getAssignment(req.params.aid);
  if (!a || a.classroomId !== req.classroom.id) return res.status(404).json({ error: 'ไม่พบงาน' });
  const me = db.getUser(req.classroom.id, req.params.studentId);
  if (!me) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  let sub;
  if (a.type === 'group') {
    sub = me.group ? db.getSubmissionByGroup(a.id, me.group) : null;
  } else {
    sub = db.getSubmissionByStudent(a.id, me.phone || me.studentId);
  }
  let submitter = null;
  if (sub && sub.studentId) {
    const u = db.getUser(req.classroom.id, sub.studentId);
    if (u) submitter = displayName(u);
  }
  res.json({ assignment: a, submission: sub, submitter });
});

app.post('/api/c/:cid/assignments/:aid/submit', loadClassroom, (req, res) => {
  const c = req.classroom;
  const a = db.getAssignment(req.params.aid);
  if (!a || a.classroomId !== c.id) return res.status(404).json({ error: 'ไม่พบงาน' });
  if (!a.isOpen) return res.status(403).json({ error: 'งานนี้ปิดรับการส่งแล้ว' });
  const { studentId, content, link, fileData, fileName } = req.body || {};
  if (!studentId) return res.status(400).json({ error: 'ไม่ทราบรหัสนักศึกษา' });
  const me = db.getUser(c.id, studentId);
  if (!me) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  if (a.type === 'group' && !me.group) {
    return res.status(400).json({ error: 'งานกลุ่ม — คุณยังไม่มีกลุ่ม' });
  }
  // Optional file upload (base64)
  let fileUrl, savedName;
  if (fileData && fileName) {
    const m = String(fileData).match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return res.status(400).json({ error: 'รูปแบบไฟล์ไม่ถูกต้อง' });
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'ไฟล์ใหญ่เกิน 10 MB' });
    const safeName = String(fileName).replace(/[^\w฀-๿.\-]+/g, '_').slice(-80);
    savedName = `sub_${c.id}_${a.id}_${studentId}_${Date.now()}_${safeName}`;
    fs.writeFileSync(path.join(db.SUBMISSIONS_DIR, savedName), buf);
    fileUrl = `/uploads/submissions/${savedName}`;
  }
  if (!content && !link && !fileUrl) {
    return res.status(400).json({ error: 'กรุณาใส่ข้อความ ลิงก์ หรือแนบไฟล์' });
  }
  const sub = db.upsertSubmission({
    assignmentId: a.id,
    classroomId: c.id,
    studentId: me.phone || me.studentId,
    groupNum: a.type === 'group' ? me.group : '',
    type: a.type,
    content: content || '',
    link: link || '',
    fileUrl: fileUrl,
    fileName: fileName || '',
    submittedAt: new Date().toISOString()
  });
  res.json({ ok: true, submission: sub });
});

// Admin

app.get('/api/c/:cid/admin/assignments', requireAdmin, loadClassroom, (req, res) => {
  const list = db.getAssignments(req.classroom.id).map(a => {
    const subs = db.getSubmissionsForAssignment(a.id);
    return { ...a, submissionCount: subs.length };
  });
  res.json({ assignments: list });
});

app.post('/api/c/:cid/admin/assignments', requireAdmin, loadClassroom, (req, res) => {
  const { title, description, type, dueDate, isOpen, classDateId, maxScore } = req.body || {};
  if (!title) return res.status(400).json({ error: 'กรุณากรอกชื่องาน' });
  const a = db.createAssignment({
    classroomId: req.classroom.id,
    title: String(title).trim(),
    description: String(description || '').trim(),
    type: type === 'group' ? 'group' : 'individual',
    dueDate: dueDate || '',
    classDateId: classDateId || '',
    maxScore: maxScore != null ? Number(maxScore) : 10,
    createdAt: new Date().toISOString(),
    isOpen: isOpen !== false
  });
  res.json({ ok: true, assignment: a });
});

app.patch('/api/c/:cid/admin/assignments/:aid', requireAdmin, loadClassroom, (req, res) => {
  const a = db.getAssignment(req.params.aid);
  if (!a || a.classroomId !== req.classroom.id) return res.status(404).json({ error: 'ไม่พบงาน' });
  const updated = db.updateAssignment(a.id, req.body || {});
  res.json({ ok: true, assignment: updated });
});

app.delete('/api/c/:cid/admin/assignments/:aid', requireAdmin, loadClassroom, (req, res) => {
  const a = db.getAssignment(req.params.aid);
  if (!a || a.classroomId !== req.classroom.id) return res.status(404).json({ error: 'ไม่พบงาน' });
  db.deleteAssignment(a.id);
  res.json({ ok: true });
});

// Materials per class date (admin upload, public download)
app.post('/api/c/:cid/admin/class-dates/:dateId/materials', requireAdmin, loadClassroom, (req, res) => {
  const c = req.classroom;
  const { fileData, fileName } = req.body || {};
  if (!fileData || !fileName) return res.status(400).json({ error: 'ขาดข้อมูลไฟล์' });
  const m = String(fileData).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return res.status(400).json({ error: 'รูปแบบไฟล์ไม่ถูกต้อง' });
  const buf = Buffer.from(m[2], 'base64');
  if (buf.length > 20 * 1024 * 1024) return res.status(413).json({ error: 'ไฟล์ใหญ่เกิน 20 MB' });
  const safeName = String(fileName).replace(/[^\w฀-๿.\-]+/g, '_').slice(-80);
  const savedName = `mat_${c.id}_${req.params.dateId}_${Date.now()}_${safeName}`;
  fs.writeFileSync(path.join(db.MATERIALS_DIR, savedName), buf);
  const url = `/uploads/materials/${savedName}`;
  const dates = (c.classDates || []).slice();
  let idx = dates.findIndex(d => d.id === req.params.dateId);
  if (idx < 0) {
    dates.push({ id: req.params.dateId, label: req.params.dateId, materials: [] });
    idx = dates.length - 1;
  }
  if (!Array.isArray(dates[idx].materials)) dates[idx].materials = [];
  const mat = { name: fileName, url, uploadedAt: new Date().toISOString() };
  dates[idx].materials.push(mat);
  db.updateClassroom(c.id, { classDates: dates });
  res.json({ ok: true, material: mat });
});

app.delete('/api/c/:cid/admin/class-dates/:dateId/materials/:idx', requireAdmin, loadClassroom, (req, res) => {
  const c = req.classroom;
  const dates = (c.classDates || []).slice();
  const dIdx = dates.findIndex(d => d.id === req.params.dateId);
  if (dIdx < 0) return res.status(404).json({ error: 'ไม่พบวัน' });
  const mIdx = parseInt(req.params.idx);
  const mats = dates[dIdx].materials || [];
  if (mIdx < 0 || mIdx >= mats.length) return res.status(404).json({ error: 'ไม่พบไฟล์' });
  try { fs.unlinkSync(path.join(db.MATERIALS_DIR, path.basename(mats[mIdx].url))); } catch (e) {}
  mats.splice(mIdx, 1);
  dates[dIdx].materials = mats;
  db.updateClassroom(c.id, { classDates: dates });
  res.json({ ok: true });
});

// Admin: get assignments for a specific date
app.get('/api/c/:cid/admin/class-dates/:dateId/assignments', requireAdmin, loadClassroom, (req, res) => {
  const list = db.getAssignmentsByDate(req.classroom.id, req.params.dateId);
  res.json({ assignments: list });
});

// Admin: grade a submission
app.patch('/api/c/:cid/admin/submissions/:id', requireAdmin, loadClassroom, (req, res) => {
  const id = parseInt(req.params.id);
  const sub = db.getSubmissionById(id);
  if (!sub || sub.classroomId !== req.classroom.id) {
    return res.status(404).json({ error: 'ไม่พบการส่งงาน' });
  }
  const { score, feedback } = req.body || {};
  let scoreVal = null;
  if (score !== undefined && score !== null && score !== '') {
    scoreVal = Number(score);
    if (!isFinite(scoreVal)) return res.status(400).json({ error: 'คะแนนไม่ถูกต้อง' });
  }
  const updated = db.gradeSubmission(id, scoreVal, feedback || '', 'admin');
  res.json({ ok: true, submission: updated });
});

// Student: combined calendar view (dates + assignments + my submissions)
app.get('/api/c/:cid/student-calendar/:phone', loadClassroom, (req, res) => {
  const c = req.classroom;
  const me = db.getUser(c.id, req.params.phone);
  if (!me) return res.status(404).json({ error: 'ไม่พบผู้ใช้' });
  const myKey = me.phone || me.studentId;
  const assignments = db.getAssignments(c.id);
  const enriched = assignments.map(a => {
    let mySubmission = null;
    if (a.type === 'group' && me.group) {
      mySubmission = db.getSubmissionByGroup(a.id, me.group);
    } else {
      mySubmission = db.getSubmissionByStudent(a.id, myKey);
    }
    let submitterName = null;
    if (mySubmission && mySubmission.studentId && mySubmission.studentId !== myKey) {
      const u = db.getUser(c.id, mySubmission.studentId);
      if (u) submitterName = displayName(u);
    }
    return { ...a, mySubmission, submitterName };
  });
  res.json({
    classroom: { id: c.id, code: c.code, name: c.name, university: c.university,
                 peerReviewEnabled: c.peerReviewEnabled, validGroups: c.validGroups },
    me,
    classDates: c.classDates || [],
    assignments: enriched
  });
});

app.get('/api/c/:cid/admin/assignments/:aid/submissions', requireAdmin, loadClassroom, (req, res) => {
  const a = db.getAssignment(req.params.aid);
  if (!a || a.classroomId !== req.classroom.id) return res.status(404).json({ error: 'ไม่พบงาน' });
  const subs = db.getSubmissionsForAssignment(a.id);
  const enriched = subs.map(s => {
    const u = db.getUser(req.classroom.id, s.studentId);
    return {
      ...s,
      submitterName: u ? displayName(u) : '(ไม่พบ)',
      submitterFullName: u ? fullName(u) : '',
      submitterSelfie: u ? (u.selfie || null) : null
    };
  });
  res.json({ assignment: a, submissions: enriched });
});

app.listen(PORT, () => {
  console.log(`Peer Review ทำงานที่ http://localhost:${PORT}`);
});
