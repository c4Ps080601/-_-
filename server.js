'use strict';
/**
 * server.js — 续写批改站 HTTP 服务（Electron 主进程内嵌）
 * 本地用户名进入、作文提交/批改/查询、教师终评、设置与导出。
 */
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const store = require('./store');
const grader = require('./grader');
const settings = require('./settings');
const pdfExport = require('./pdf-export');

const APP_VERSION = (require('./package.json').version || '1.0.0');

// 独立运行（node server.js）时没有 Electron 主进程初始化设置，自动落到数据目录
if (!settings.getSettingsFile()) {
  settings.init(process.env.EG_SETTINGS_FILE || path.join(store.getDataDir(), 'settings.json'));
}

const config = settings.getConfig();
const PORT = parseInt(process.env.PORT || config.port || '3210', 10);
const TEACHER_CODE = process.env.TEACHER_CODE || config.teacherCode || 'TEACHER2026';
const CLASS_CODE = process.env.CLASS_CODE || config.classCode || 'SUR2026';

store.load();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ---------- 图片上传（OCR 用，暂存于 userData） ---------- */
const UPLOAD_DIR = path.join(store.getDataDir(), 'uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      fs.mkdirSync(UPLOAD_DIR, { recursive: true });
      cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
      const ext = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[file.mimetype] || '.jpg';
      cb(null, Date.now() + '-' + crypto.randomBytes(4).toString('hex') + ext);
    }
  }),
  limits: { files: 4, fileSize: 12 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('仅支持 JPG/PNG/WebP 格式图片'));
  }
});

/* 识别图片中的原文/段首句/续写 */
app.post('/api/ocr', requireAuth, upload.array('images', 4), async (req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: '请先选择图片' });
  try {
    if (req.body.saveDraft === 'true' && !/^[a-zA-Z0-9_-]{1,80}$/.test(req.body.clientId || '')) return res.status(400).json({ error: '草稿标识无效' });
    const fields = await grader.recognizeImages(req.files.map(f => f.path));
    let draft = null;
    if (req.body.saveDraft === 'true' && store.findUserById(req.user.id)) {
      const parts = [fields.originalText];
      if (fields.starter1) parts.push('Paragraph 1: ' + fields.starter1);
      if (fields.starter2) parts.push('Paragraph 2: ' + fields.starter2);
      if (fields.taskRequirements) parts.push('【本题要求】\n' + fields.taskRequirements);
      if (fields.keywords && fields.keywords.length) parts.push('【明确识别的划线关键词】\n' + fields.keywords.join(', '));
      draft = store.createDraft({ userId: req.user.id, clientId: req.body.clientId, originalText: parts.filter(Boolean).join('\n\n'), essayText: [fields.para1, fields.para2].filter(Boolean).join('\n\n') });
    }
    res.json({ fields, draft: draft ? decorate(draft) : null });
  } catch (e) {
    res.status(502).json({ error: '识别失败：' + ((e && e.message) || e) });
  } finally {
    for (const file of req.files || []) { try { fs.unlinkSync(file.path); } catch (e) { /* 文件已经被清理 */ } }
  }
});

/* ---------- cookie 工具 ---------- */
function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function authUser(req) {
  return store.getUserByToken(parseCookies(req).eg_session);
}

function requireAuth(req, res, next) {
  const user = authUser(req);
  if (!user) return res.status(401).json({ error: '未登录或会话已过期' });
  req.user = user;
  next();
}

function requireTeacher(req, res, next) {
  if (req.user.role !== 'teacher') return res.status(403).json({ error: '仅教师可用' });
  next();
}

/* ---------- 校验 ---------- */
function validUsername(u) {
  return /^[a-zA-Z0-9_\u4e00-\u9fa5]{2,24}$/.test(u);
}

/* ---------- 健康检查 ---------- */
app.get('/api/health', (req, res) => {
  res.json({ ok: true, time: Date.now() });
});

/* ---------- 认证 ---------- */
app.post('/api/auth/register', (req, res) => {
  const { username, password, name, code } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: '用户名需为 2-24 位字母/数字/下划线/中文' });
  if (!password || String(password).length < 6) return res.status(400).json({ error: '密码至少 6 位' });
  if (store.findUserByUsername(username)) return res.status(409).json({ error: '用户名已被注册' });

  // 注册不再要求注册码：留空默认为学生；教师填写教师码注册为教师
  let role = 'student';
  if (code) {
    if (code === TEACHER_CODE) role = 'teacher';
    else if (code === CLASS_CODE) role = 'student';
    else return res.status(403).json({ error: '注册码错误（学生无需填写，教师请填写教师码）' });
  }

  const user = store.createUser({ username, password, name, role });
  const token = store.createSession(user.id);
  res.cookie('eg_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: store.publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = store.findUserByUsername(username || '');
  if (!user || !store.verifyPassword(user, password || '')) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }
  const token = store.createSession(user.id);
  res.cookie('eg_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: store.publicUser(user) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req).eg_session;
  if (token) store.destroySession(token);
  res.clearCookie('eg_session');
  res.json({ ok: true });
});

/* 免注册进入：输入用户名即创建/登录（教师用户名见 config.json teacherUsernames） */
app.post('/api/enter', (req, res) => {
  const name = String((req.body && req.body.username) || '').trim();
  if (!validUsername(name)) return res.status(400).json({ error: '用户名需为 2-24 位字母/数字/下划线/中文' });
  let user = store.findUserByUsername(name);
  if (!user) {
    const teacherNames = (config.teacherUsernames || ['教师']).map(s => String(s).trim());
    const role = teacherNames.includes(name) ? 'teacher' : 'student';
    user = store.createUser({
      username: name,
      password: crypto.randomBytes(16).toString('hex'),
      name,
      role
    });
  }
  const token = store.createSession(user.id);
  res.cookie('eg_session', token, { httpOnly: true, sameSite: 'lax', maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ user: store.publicUser(user) });
});

app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: store.publicUser(req.user) });
});

/* ---------- 作文提交 ---------- */
function draftFields(body) {
  return { title: String(body.title || ''), originalText: String(body.originalText || ''), essayText: String(body.essayText || '') };
}
function submissionProblem(fields) {
  if (!fields.essayText.trim()) return '请填写续写内容';
  if (store.countWords(fields.essayText) < 30) return '续写内容太短（至少30词）';
  if (!fields.originalText.trim()) return '请填写原文（含段首句）';
  return '';
}
function ownedDraft(req, res) {
  const sub = store.getSubmission(req.params.id);
  if (!sub) { res.status(404).json({ error: '草稿不存在' }); return null; }
  if (sub.userId !== req.user.id) { res.status(403).json({ error: '只能编辑自己的草稿' }); return null; }
  return sub;
}
app.post('/api/drafts', requireAuth, (req, res) => {
  const body = req.body || {}, fields = draftFields(body);
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(body.clientId || '')) return res.status(400).json({ error: '草稿标识无效' });
  if (!Object.values(fields).some(s => s.trim())) return res.status(400).json({ error: '空白内容无需保存' });
  const draft = store.createDraft({ ...fields, userId: req.user.id, clientId: body.clientId });
  res.json({ submission: decorate(draft) });
});
app.put('/api/drafts/:id', requireAuth, (req, res) => {
  if (!ownedDraft(req, res)) return;
  try { res.json({ submission: decorate(store.reviseDraft(req.params.id, draftFields(req.body || {}), req.body.revision)) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/drafts/:id/submit', requireAuth, (req, res) => {
  const sub = ownedDraft(req, res); if (!sub) return;
  // 请求重发或重复点击返回同一记录，不能重复排队或再次扣费。
  if (sub.status !== 'draft') return res.json({ submission: decorate(sub) });
  const fields = draftFields(req.body || {}), problem = submissionProblem(fields);
  if (problem) return res.status(400).json({ error: problem });
  try {
    store.reviseDraft(sub.id, fields, req.body.revision, true);
    grader.enqueue(sub.id);
    res.json({ submission: decorate(sub) });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.post('/api/submissions', requireAuth, (req, res) => {
  const { title, originalText, essayText } = req.body || {};
  if (!essayText || !String(essayText).trim()) return res.status(400).json({ error: '请填写续写内容' });
  if (store.countWords(essayText) < 30) return res.status(400).json({ error: '续写内容太短（至少 30 词）' });
  if (!originalText || !String(originalText).trim()) {
    return res.status(400).json({ error: '请填写原文（含段首句），批改需要结合原文判断衔接' });
  }

  const sub = store.createSubmission({ userId: req.user.id, title, originalText, essayText });
  grader.enqueue(sub.id);
  res.json({ submission: decorate(sub) });
});

app.get('/api/submissions', requireAuth, (req, res) => {
  const list = store.listSubmissions(req.user);
  res.json({ submissions: list.map(decorate) });
});

app.get('/api/submissions/:id', requireAuth, (req, res) => {
  const sub = store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: '作文不存在' });
  if (req.user.role !== 'teacher' && sub.userId !== req.user.id) {
    return res.status(403).json({ error: '无权查看他人作文' });
  }
  res.json({ submission: decorate(sub) });
});

/* 教师调整分数 */
app.patch('/api/submissions/:id', requireAuth, requireTeacher, (req, res) => {
  const sub = store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: '作文不存在' });
  const { teacherScore, teacherNote } = req.body || {};
  let score = null;
  if (teacherScore !== undefined && teacherScore !== null && teacherScore !== '') {
    score = Number(teacherScore);
    if (!Number.isFinite(score) || score < 0 || score > 25) {
      return res.status(400).json({ error: '分数需在 0-25 之间' });
    }
  }
  store.setTeacherAdjust(sub.id, score, teacherNote || null);
  res.json({ submission: decorate(store.getSubmission(sub.id)) });
});

/* 重新批改 */
app.post('/api/submissions/:id/regrade', requireAuth, (req, res) => {
  const sub = store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: '作文不存在' });
  if (req.user.role !== 'teacher' && sub.userId !== req.user.id) {
    return res.status(403).json({ error: '无权操作' });
  }
  if (sub.status === 'draft') return res.status(409).json({ error: '请先在草稿中核对文字并提交批改' });
  if (sub.status === 'pending' || sub.status === 'grading') return res.json({ submission: decorate(sub) });
  store.setSubmissionStatus(sub.id, 'pending');
  grader.enqueue(sub.id);
  res.json({ submission: decorate(store.getSubmission(sub.id)) });
});

app.delete('/api/submissions/:id', requireAuth, (req, res) => {
  const sub = store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: '作文不存在' });
  if (req.user.role !== 'teacher' && sub.userId !== req.user.id) {
    return res.status(403).json({ error: '无权删除' });
  }
  store.deleteSubmission(sub.id);
  res.json({ ok: true });
});

/* 导出整篇批改结果为 PDF（网页版兜底：直接下载） */
app.get('/api/submissions/:id/pdf', requireAuth, async (req, res) => {
  const sub = store.getSubmission(req.params.id);
  if (!sub) return res.status(404).json({ error: '作文不存在' });
  if (req.user.role !== 'teacher' && sub.userId !== req.user.id) {
    return res.status(403).json({ error: '无权查看他人作文' });
  }
  try {
    const buf = await pdfExport.generateSubmissionPdf(sub);
    const safe = String(sub.title || '批改结果').replace(/[\\/:*?"<>|]/g, '_');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safe)}.pdf`);
    res.send(buf);
  } catch (e) {
    res.status(400).json({ error: '导出失败：' + ((e && e.message) || e) });
  }
});

/* ---------- 设置（桌面版） ---------- */
app.get('/api/settings', requireAuth, (req, res) => {
  const info = settings.getApiKeyInfo();
  const dataDir = store.getDataDir();
  let dbSize = 0;
  let counts = { users: 0, submissions: 0 };
  try {
    dbSize = fs.statSync(path.join(dataDir, 'db.json')).size;
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    counts = { users: (db.users || []).length, submissions: (db.submissions || []).length };
  } catch (e) { /* 首次运行尚无 db.json，忽略 */ }
  res.json({
    apiKey: info,
    ai: settings.getPublicAISettings(),
    endpoint: settings.getEndpoint(),
    model: settings.getModel(),
    fontScale: settings.getFontScale(),
    theme: settings.getTheme(),
    dataDir,
    dbSize,
    counts,
    version: APP_VERSION
  });
});

app.put('/api/settings', requireAuth, (req, res) => {
  try { settings.updateSettings(req.body); res.json({ ok: true, ai: settings.getPublicAISettings(), fontScale: settings.getFontScale(), theme: settings.getTheme() }); }
  catch (e) { res.status(e.status || 400).json({ error: e.message }); }
});
app.post('/api/onboarding', requireAuth, (req, res) => {
  try { settings.acknowledgeOnboarding(); res.json({ ok: true }); }
  catch { res.status(500).json({ error: '无法保存首次使用提示状态，请检查本地目录权限' }); }
});
app.post('/api/ai-test', requireAuth, async (req, res) => {
  if (!['grade', 'ocr'].includes(req.body.stage)) return res.status(400).json({ error: '测试类型无效' });
  try {
    const stage = req.body.stage, config = settings.getAIConfig(stage);
    const text = await require('./providers').callModel([{ role: 'user', content: '连接测试。请只返回JSON：{"ok":true}' }], config, { timeoutMs: 30000, reasoningEffort: 'low' });
    res.json({ ok: true, message: '文本连接测试成功。图片能力需使用支持视觉输入的模型；该测试不验证评分质量。' });
  } catch (e) { res.status(400).json({ error: e.name === 'AbortError' ? '测试超时，请检查网络' : e instanceof TypeError ? '无法连接，请检查网络与API地址' : e.message }); }
});

/* 清空本地数据（用户/会话/作文/暂存图片；保留设置中的 API Key） */
app.post('/api/settings/clear-data', requireAuth, (req, res) => {
  try {
    store.clearAll();
    if (fs.existsSync(UPLOAD_DIR)) {
      for (const f of fs.readdirSync(UPLOAD_DIR)) {
        try { fs.unlinkSync(path.join(UPLOAD_DIR, f)); } catch (e) { /* 忽略单个文件失败 */ }
      }
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '清理失败，请重试' });
  }
});

/* 在系统文件管理器中打开数据目录 */
app.post('/api/settings/open-data-dir', requireAuth, (req, res) => {
  try {
    const { shell } = require('electron');
    shell.openPath(store.getDataDir());
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: '无法打开数据目录' });
  }
});

/* ---------- 序列化 ---------- */
function decorate(sub) {
  const owner = store.findUserById(sub.userId);
  return {
    ...sub,
    authorName: owner ? owner.name : '未知',
    queuePos: sub.status === 'pending' ? grader.queuePosition(sub.id) : null
  };
}

let jobsRecovered = false;
function startServer(opts = {}, onReady) {
  const port = opts.port || PORT;
  const host = opts.host || '127.0.0.1';
  const server = app.listen(port, host, () => {
    if (!jobsRecovered) { jobsRecovered = true; grader.recoverInterruptedJobs(); }
    console.log(`[essay-grader] 续写批改站已启动: http://${host}:${port}`);
    console.log(`[essay-grader] 数据目录: ${store.getDataDir()}`);
    if (typeof onReady === 'function') onReady(port);
  });
  return server;
}

/* 独立运行（node server.js）时保持网页版行为，便于调试 */
if (require.main === module) {
  const standalone = startServer({ port: PORT, host: '127.0.0.1' });
  standalone.on('error', err => {
    console.error('[essay-grader] 启动失败:', err && err.message);
    process.exitCode = 1;
  });
}

module.exports = { app, startServer };
