'use strict';
/**
 * store.js — 本地 JSON 数据层（用户、会话、作文提交）
 * 数据量级：一个班几十个学生、每人数十篇作文，JSON 足够。
 * 写盘采用「临时文件 + rename」保证原子性，避免断电/崩溃写坏数据。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 桌面版由 Electron 主进程设置 EG_DATA_DIR 指向 userData；网页版回退到项目内 data/
const DATA_DIR = process.env.EG_DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000; // 30 天

function emptyDb() {
  return {
    users: [],
    sessions: [],
    submissions: [],
    seq: { user: 0, submission: 0 }
  };
}

let db = null;

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    try {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
      db = emptyDb();
    }
  } else {
    db = emptyDb();
  }
  if (!db.users) db.users = [];
  if (!db.sessions) db.sessions = [];
  if (!db.submissions) db.submissions = [];
  if (!db.seq) db.seq = { user: 0, submission: 0 };
  cleanupExpiredSessions();
  return db;
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

function getDataDir() {
  return DATA_DIR;
}

/* 清空全部本地数据（用户/会话/作文），用于设置页「清理本地数据」 */
function clearAll() {
  db = emptyDb();
  save();
  return db;
}

/* ---------- 密码 ---------- */
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

/* ---------- 用户 ---------- */
function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, createdAt: u.createdAt };
}

function findUserByUsername(username) {
  return db.users.find(u => u.username.toLowerCase() === String(username).toLowerCase()) || null;
}

function findUserById(id) {
  return db.users.find(u => u.id === id) || null;
}

function createUser({ username, password, name, role }) {
  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: 'u' + (++db.seq.user),
    username: String(username).trim(),
    name: String(name || username).trim() || String(username).trim(),
    role: role === 'teacher' ? 'teacher' : 'student',
    salt,
    hash: hashPassword(password, salt),
    createdAt: Date.now()
  };
  db.users.push(user);
  save();
  return user;
}

function verifyPassword(user, password) {
  const h = hashPassword(password, user.salt);
  const a = Buffer.from(user.hash, 'hex');
  const b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function changePassword(user, newPassword) {
  user.salt = crypto.randomBytes(16).toString('hex');
  user.hash = hashPassword(newPassword, user.salt);
  save();
}

/* ---------- 会话 ---------- */
function createSession(userId) {
  cleanupExpiredSessions();
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions.push({ token, userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
  save();
  return token;
}

function getUserByToken(token) {
  if (!token) return null;
  const s = db.sessions.find(x => x.token === token && x.expiresAt > Date.now());
  if (!s) return null;
  return findUserById(s.userId);
}

function destroySession(token) {
  db.sessions = db.sessions.filter(x => x.token !== token);
  save();
}

function cleanupExpiredSessions() {
  const before = db.sessions.length;
  db.sessions = db.sessions.filter(x => x.expiresAt > Date.now());
  if (db.sessions.length !== before) save();
}

/* ---------- 作文提交 ---------- */
function countWords(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).filter(Boolean).length;
}

/* 标题自动提炼：从原文/续写里取前几个有信息量的实词（零成本，提交时立即生效） */
const TITLE_STOPWORDS = new Set([
  'a','an','the','and','or','but','of','to','in','on','at','for','with','by','from','into','about',
  'my','your','his','her','its','our','their','me','us','him','them',
  'i','we','you','he','she','it','they','am','is','are','was','were','be','been','being',
  'had','have','has','do','does','did','not','no','so','as','if','then','than','that','this','there',
  'when','while','just','very','really','quite','saw','said','went','got','felt','looked','turned','came',
  'one','two','back','up','down','out','off','again','also','too','can','could','would','should','will'
]);

function makeTitle(originalText, essayText) {
  const src = String(originalText || '') + ' ' + String(essayText || '');
  const words = src.toLowerCase()
    .replace(/[^a-z\s'-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !TITLE_STOPWORDS.has(w));
  const seen = new Set();
  const picks = [];
  for (const w of words) {
    const k = w.replace(/['-]/g, '');
    if (!seen.has(k)) { seen.add(k); picks.push(w); }
    if (picks.length >= 4) break;
  }
  if (picks.length) return picks.map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
  return '未命名作文';
}

function createSubmission({ userId, title, originalText, essayText, status = 'pending', clientId = null }) {
  const sub = {
    id: 's' + (++db.seq.submission),
    userId,
    title: String(title || '').trim() || makeTitle(originalText, essayText),
    originalText: String(originalText || ''),
    essayText: String(essayText || ''),
    wordCount: countWords(essayText),
    status,                      // draft | pending | grading | done | error
    clientId,
    draftRevision: status === 'draft' ? 1 : null,
    queuePos: null,
    result: null,                 // AI 评分结果对象
    error: null,
    teacherScore: null,           // 老师可手动调整
    teacherNote: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    gradedAt: null
  };
  db.submissions.push(sub);
  save();
  return sub;
}

function createDraft(data) {
  const existing = db.submissions.find(s => s.userId === data.userId && s.clientId === data.clientId);
  if (existing) return existing;
  return createSubmission({ ...data, status: 'draft' });
}

function reviseDraft(id, fields, revision, submit = false) {
  const sub = getSubmission(id);
  if (!sub || sub.status !== 'draft') throw Object.assign(new Error('草稿已提交或不存在'), { status: 409 });
  if (!Number.isInteger(revision) || revision !== sub.draftRevision) throw Object.assign(new Error('草稿已在别处更新，当前内容已保留，请重新打开或另存为新草稿'), { status: 409 });
  sub.title = String(fields.title || '').trim() || makeTitle(fields.originalText, fields.essayText);
  sub.originalText = String(fields.originalText || '');
  sub.essayText = String(fields.essayText || '');
  sub.wordCount = countWords(sub.essayText);
  sub.draftRevision++;
  sub.updatedAt = Date.now();
  if (submit) { sub.status = 'pending'; sub.result = null; sub.error = null; }
  save();
  return sub;
}

function setSubmissionTitle(id, title) {
  const s = getSubmission(id);
  if (!s || !title) return;
  s.title = String(title).trim();
  save();
}

function getSubmission(id) {
  return db.submissions.find(s => s.id === id) || null;
}

function listSubmissions(user) {
  const all = db.submissions.slice().sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));
  return all.filter(s => user.role === 'teacher' || s.userId === user.id);
}

function setSubmissionStatus(id, status, queuePos) {
  const s = getSubmission(id);
  if (!s) return;
  s.status = status;
  if (queuePos !== undefined) s.queuePos = queuePos;
  save();
}

function setSubmissionResult(id, result) {
  const s = getSubmission(id);
  if (!s) return;
  s.status = 'done';
  s.result = result;
  s.error = null;
  s.gradedAt = Date.now();
  s.queuePos = null;
  save();
}

function setSubmissionError(id, error) {
  const s = getSubmission(id);
  if (!s) return;
  s.status = 'error';
  s.error = String(error).slice(0, 500);
  s.queuePos = null;
  save();
}

function deleteSubmission(id) {
  const before = db.submissions.length;
  db.submissions = db.submissions.filter(s => s.id !== id);
  if (db.submissions.length !== before) save();
}

function setTeacherAdjust(id, teacherScore, teacherNote) {
  const s = getSubmission(id);
  if (!s) return;
  s.teacherScore = teacherScore === null || teacherScore === undefined || teacherScore === '' ? null : Number(teacherScore);
  s.teacherNote = teacherNote === null || teacherNote === undefined || teacherNote === '' ? null : String(teacherNote);
  save();
}

module.exports = {
  load,
  save,
  getDataDir,
  clearAll,
  findUserByUsername,
  findUserById,
  createUser,
  verifyPassword,
  changePassword,
  publicUser,
  createSession,
  getUserByToken,
  destroySession,
  createSubmission,
  createDraft,
  reviseDraft,
  getSubmission,
  listSubmissions,
  setSubmissionStatus,
  setSubmissionTitle,
  setSubmissionResult,
  setSubmissionError,
  deleteSubmission,
  setTeacherAdjust,

  countWords,
  makeTitle
};
