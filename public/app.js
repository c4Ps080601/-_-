'use strict';
/* 续写批改站 — 前端逻辑 */

const $ = sel => document.querySelector(sel);
const $$ = sel => document.querySelectorAll(sel);

let ME = null;
let pollTimer = null;
let recentPollTimer = null, recentSequence = 0;

/* ---------- 工具 ---------- */
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden', 'out');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.classList.add('hidden'), 180);
  }, ms);
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* 润色版：把模型用 ** 标记的修改词句渲染成高亮（已 esc，安全） */
function paragraphHTML(text, options = {}) {
  return String(text || '').split(/\n\s*\n/).filter(p => p.trim()).map((p, i) => {
    const plain = options.edits ? p.replace(/\*\*/g, '') : p;
    const given = (options.starters || [])[i];
    const first = options.boldStarts ? (given && plain.startsWith(given) ? given : (plain.match(/^[\s\S]*?[.!?](?=\s|$)/) || [''])[0]) : '';
    let offset = 0;
    const chunks = options.edits ? p.split(/\*\*([^*]+)\*\*/g) : [p];
    const html = chunks.map((chunk, n) => {
      const boldLength = Math.max(0, Math.min(chunk.length, first.length - offset));
      offset += chunk.length;
      const content = (boldLength ? '<strong class="paragraph-starter">' + esc(chunk.slice(0, boldLength)) + '</strong>' : '') + esc(chunk.slice(boldLength));
      return options.edits && n % 2 ? '<b class="polish-hl">' + content + '</b>' : content;
    }).join('');
    return '<p class="reading-paragraph">' + html + '</p>';
  }).join('');
}

function polishedHTML(text, starters) {
  return paragraphHTML(text, { edits: true, boldStarts: true, starters });
}

function givenStarters(text) {
  return [1, 2].map(n => {
    const match = String(text || '').match(new RegExp('(?:^|\\n)\\s*(?:Paragraph\\s*' + n + '|段首句\\s*' + n + ')\\s*[:：]\\s*([^\\n]+)', 'i'));
    return match ? match[1].trim() : '';
  });
}

function displayBand(score) {
  if (score === 0) return '0分';
  return ['第一档', '第二档', '第三档', '第四档', '第五档'][Math.ceil(score / 5) - 1] || '';
}

async function api(path, opts = {}) {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const resp = await fetch(path, {
    // FormData 必须交给浏览器自动生成 multipart/form-data 及 boundary，不能强制 JSON
    headers: isForm ? undefined : { 'Content-Type': 'application/json' },
    ...opts,
    body: isForm ? opts.body : (opts.body ? JSON.stringify(opts.body) : undefined)
  });
  let data = null;
  try { data = await resp.json(); } catch (e) { /* ignore */ }
  if (!resp.ok) {
    const msg = (data && data.error) || `请求失败 (${resp.status})`;
    throw Object.assign(new Error(msg), { status: resp.status });
  }
  return data;
}

function scoreClass(score) {
  if (score == null) return 'pending';
  if (score >= 21) return 's21';
  if (score >= 18) return 's18';
  if (score >= 15) return 's15';
  return 'low';
}

/* ---------- 视图路由 ---------- */
function showView(name) {
  $$('.view').forEach(v => v.classList.add('hidden'));
  $('#view-' + name).classList.remove('hidden');
  $$('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === (name === 'result' ? 'dashboard' : name)));
  $$('.recent-item').forEach(b => b.classList.toggle('active', location.hash === '#/result/' + b.dataset.id || location.hash === '#/draft/' + b.dataset.id));
  clearInterval(pollTimer);
  $('.main').scrollTop = 0;
}

function route() {
  if (!ME) { showLogin(); return; }
  Drafts.leave();
  const hash = location.hash || '#/dashboard';
  if (hash.startsWith('#/result/')) {
    showView('result');
    loadResult(hash.split('/')[2]);
  } else if (hash.startsWith('#/draft/')) {
    showView('submit'); Drafts.load(hash.split('/')[2]);
  } else if (hash === '#/submit') {
    showView('submit');
    Drafts.activate();
  } else {
    location.hash = '#/dashboard';
    showView('dashboard');
    loadDashboard();
  }
}

/* ---------- 登录 ---------- */
function showLogin() {
  $('#view-app').classList.add('hidden');
  $('#view-login').classList.remove('hidden');
}

function showApp(user) {
  ME = user;
  $('#view-login').classList.add('hidden');
  $('#view-app').classList.remove('hidden');
  $('#user-name').textContent = user.name;
  const rb = $('#user-role');
  rb.textContent = user.role === 'teacher' ? '教师' : '学生';
  rb.classList.toggle('teacher', user.role === 'teacher');
  $('#user-avatar').textContent = Array.from(user.name).slice(0, 2).join('');
  if (!location.hash || location.hash === '#/login') location.hash = '#/dashboard';
  route();
  refreshRecent();
  clearInterval(recentPollTimer);
  recentPollTimer = setInterval(refreshRecent, 3000);
  document.dispatchEvent(new Event('eg:entered'));
}

function renderRecent(list) {
  const visible = list.slice(0, 8);
  for (const s of list) if ((['pending','grading'].includes(s.status) || location.hash.endsWith('/' + s.id)) && !visible.some(v => v.id === s.id)) visible.push(s);
  const html = visible.map(s => {
    const score = s.teacherScore != null ? s.teacherScore : s.result && s.result.score;
    const state = s.status === 'draft' ? '草稿' : s.status === 'grading' ? '批改中' : s.status === 'pending' ? '排队中' : s.status === 'error' ? '批改失败' : score != null ? score + '/25' : '已批改';
    return `<button type="button" class="recent-item${location.hash === '#/result/' + s.id || location.hash === '#/draft/' + s.id ? ' active' : ''}" data-id="${esc(s.id)}" data-status="${esc(s.status)}"><span class="recent-title">${esc(s.title)}</span><span class="recent-meta">${s.wordCount} 词 · <span class="recent-status ${esc(s.status)}">${state}</span></span></button>`;
  }).join('') || '<p class="muted">暂无作文</p>';
  if ($('#recent-list').innerHTML === html) return;
  $('#recent-list').innerHTML = html;
  $$('.recent-item').forEach(b => b.addEventListener('click', () => { location.hash = '#/' + (b.dataset.status === 'draft' ? 'draft/' : 'result/') + b.dataset.id; }));
}

async function refreshRecent() {
  const owner = ME?.id, sequence = ++recentSequence; if (!owner) return;
  try { const { submissions } = await api('/api/submissions'); if (ME?.id !== owner || sequence !== recentSequence) return; renderRecent(submissions); if (location.hash === '#/dashboard') renderList(submissions, ME.role === 'teacher'); } catch (e) { /* 下次刷新重试 */ }
}

/* ---------- 仪表盘 ---------- */
function statusBadge(s) {
  if (s.status === 'draft') return '<span class="status-badge">草稿</span>';
  if (s.status === 'done') return '<span class="status-badge done">已批改</span>';
  if (s.status === 'grading') return '<span class="status-badge grading">批改中</span>';
  if (s.status === 'error') return '<span class="status-badge error">批改失败</span>';
  const pos = s.queuePos != null && s.queuePos >= 0 ? ` · 前面 ${s.queuePos} 篇` : '';
  return `<span class="status-badge">排队中${pos}</span>`;
}

function scoreBadge(s) {
  if (s.status === 'draft') return '<div class="score-badge pending">草稿</div>';
  const finalScore = s.teacherScore != null ? s.teacherScore : (s.result && s.result.score);
  if (s.status === 'done' && finalScore != null) {
    return `<div class="score-badge ${scoreClass(finalScore)}">${finalScore}<span class="small">${s.teacherScore != null ? '教师' : '/25'}</span></div>`;
  }
  if (s.status === 'grading') return '<div class="score-badge pending">…</div>';
  if (s.status === 'error') return '<div class="score-badge error">失败</div>';
  return '<div class="score-badge pending">排队</div>';
}

function renderList(list, isTeacher) {
  const el = $('#submission-list');
  const count = `共 ${list.length} 篇`;
  if ($('#list-count').textContent !== count) $('#list-count').textContent = count;
  if (!list.length) {
    const empty = `<div class="empty">还没有作文。点击「提交作文」上传你的第一篇读后续写吧 ✍️</div>`;
    if (el.innerHTML !== empty) el.innerHTML = empty;
    return;
  }
  // 轮询仅同步变化的卡片，保留节点、焦点及滚动位置，避免反复触发入场动画。
  const existing = new Map(Array.from(el.querySelectorAll('.sub-item'), item => [item.dataset.id, item]));
  const initial = existing.size === 0;
  el.querySelector('.empty')?.remove();
  let cursor = el.firstElementChild;
  list.forEach((s, i) => {
    const template = document.createElement('template');
    template.innerHTML = `<div class="sub-item" data-id="${esc(s.id)}">
      <div class="sub-main">
        <div class="sub-title">${esc(s.title)}</div>
        <div class="sub-meta">
          ${isTeacher ? esc(s.authorName) + ' · ' : ''}${fmtDate(s.createdAt)} · ${s.wordCount} 词
        </div>
        <div style="margin-top:4px">${statusBadge(s)}</div>
      </div>
      ${scoreBadge(s)}
    </div>`;
    const next = template.content.firstElementChild;
    let item = existing.get(String(s.id));
    if (item) {
      existing.delete(String(s.id));
      if (item.innerHTML !== next.innerHTML) item.innerHTML = next.innerHTML;
    } else {
      item = next;
      if (initial) item.style.animationDelay = Math.min(i * 45, 405) + 'ms';
      else item.style.animation = 'none';
      item.addEventListener('click', () => { location.hash = '#/' + (item.dataset.status === 'draft' ? 'draft/' : 'result/') + item.dataset.id; });
    }
    if (item.dataset.status !== s.status) item.dataset.status = s.status;
    if (item !== cursor) el.insertBefore(item, cursor);
    cursor = item.nextElementSibling;
  });
  for (const item of existing.values()) item.remove();
}

async function loadDashboard() {
  const owner = ME?.id, isTeacher = ME?.role === 'teacher';
  const sequence = ++recentSequence;
  try {
    const { submissions } = await api('/api/submissions');
    if (ME?.id !== owner || sequence !== recentSequence || location.hash !== '#/dashboard') return;
    renderList(submissions, isTeacher);
    renderRecent(submissions);
  } catch (e) {
    if (ME?.id === owner && sequence === recentSequence && location.hash === '#/dashboard') $('#submission-list').innerHTML = `<div class="empty">加载失败：${esc(e.message)}</div>`;
  }
}

/* ---------- 提交 ---------- */
/* --- 图片压缩（最长边 1600，JPEG 0.85） --- */
async function compressImage(file) {
  const url = URL.createObjectURL(file);
  const img = await new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => { URL.revokeObjectURL(url); res(i); };
    i.onerror = () => { URL.revokeObjectURL(url); rej(new Error('图片读取失败')); };
    i.src = url;
  });
  const MAX = 1600;
  let { width: w, height: h } = img;
  const ratio = Math.min(1, MAX / w, MAX / h); w = Math.max(1, Math.round(w * ratio)); h = Math.max(1, Math.round(h * ratio));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
  return new Promise((res, rej) => c.toBlob(blob => blob ? res(blob) : rej(new Error('图片压缩失败')), 'image/jpeg', 0.85));
}

let ocrFiles = [];

function renderOcrPreview() {
  const el = $('#ocr-preview');
  el.querySelectorAll('img').forEach(img => URL.revokeObjectURL(img.src));
  el.innerHTML = '';
  ocrFiles.forEach((f, i) => {
    const d = document.createElement('div');
    d.className = 'ocr-thumb';
    const img = document.createElement('img');
    img.src = URL.createObjectURL(f);
    d.appendChild(img);
    const rm = document.createElement('button');
    rm.type = 'button';
    rm.className = 'ocr-rm';
    rm.textContent = '×';
    rm.addEventListener('click', () => { ocrFiles.splice(i, 1); renderOcrPreview(); });
    d.appendChild(rm);
    el.appendChild(d);
  });
}

function clearOcrFiles() { ocrFiles = []; $('#ocr-files').value = ''; renderOcrPreview(); }

async function runOcr() {
  if (window.ocrRunning) return;
  const btn = $('#btn-ocr');
  const msg = $('#ocr-msg');
  msg.className = 'form-msg';
  msg.textContent = '';
  if (!ocrFiles.length) { msg.textContent = '请先选择图片'; return; }
  const context = Drafts.ocrContext(), files = [...ocrFiles];
  window.ocrRunning = true;
  btn.disabled = true;
  btn.classList.add('loading');
  btn.textContent = '识别中，请稍候…';
  try {
    const fd = new FormData();
    for (const f of files) fd.append('images', await compressImage(f), f.name.replace(/\.[^.]*$/, '') + '.jpg');
    fd.append('saveDraft', 'true'); fd.append('clientId', context.clientId);
    const { draft } = await api('/api/ocr', { method: 'POST', body: fd });
    if (!draft) throw new Error('识别稿未能保存，请重试。');
    Drafts.acceptOCR(draft, context);
    if (ME?.id === context.owner) {
      msg.className = 'form-msg'; msg.style.color = 'var(--ok)';
      msg.textContent = '识别完成，草稿已加入最近作文。请核对文字后提交批改。';
    }
  } catch (e) {
    if (ME?.id === context.owner) { msg.className = 'form-msg error'; msg.textContent = e.message; }
  } finally {
    window.ocrRunning = false;
    btn.disabled = false;
    btn.classList.remove('loading');
    btn.textContent = '🔍 识别图片并填入表单';
  }
}

function initSubmitForm() {
  const form = $('#form-submit');
  const ta = form.querySelector('textarea[name="essayText"]');
  ta.addEventListener('input', () => {
    const words = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
    $('#word-count').textContent = `${words} 词`;
  });
  $('#ocr-files').addEventListener('change', e => {
    const files = Array.from(e.target.files || []);
    // 去重（同文件名 + 大小 + 修改时间视为同一张）
    const seen = new Set(ocrFiles.map(f => f.name + '|' + f.size + '|' + f.lastModified));
    const fresh = files.filter(f => !seen.has(f.name + '|' + f.size + '|' + f.lastModified));
    const total = ocrFiles.concat(fresh);
    if (total.length > 4) {
      ocrFiles = total.slice(0, 4);
      toast('最多 4 张，超出部分已忽略', 3000);
    } else {
      ocrFiles = total;
    }
    renderOcrPreview();
    e.target.value = ''; // 清空输入框，保证下次选择同一文件也能触发
  });
  $('#btn-ocr').addEventListener('click', runOcr);
  form.addEventListener('submit', e => { e.preventDefault(); Drafts.submit(); });
}

/* ---------- 结果页 ---------- */
function dimsHTML(d) {
  const items = [
    ['情节与衔接', 'plot', 10],
    ['语言表达', 'language', 6],
    ['语法准确', 'grammar', 5],
    ['篇章连贯', 'coherence', 4]
  ];
  return `<div class="dim-grid">${items.map(([name, key, max]) => {
    const v = d[key] || {};
    const pct = Math.max(0, Math.min(100, (v.score || 0) / max * 100));
    return `<div class="dim-card">
      <div class="dim-name">${name}</div>
      <div class="dim-score">${v.score != null ? v.score : '—'}<span class="muted" style="font-size:0.75rem">/${max}</span></div>
      <div class="dim-bar"><i data-pct="${pct}"></i></div>
      <div class="dim-comment">${esc(v.comment || '')}</div>
    </div>`;
  }).join('')}</div>`;
}

function workspaceToolbar(s, completed) {
  const status = completed ? '已批改' : ({ error: '批改失败', grading: '批改中', pending: '排队中', draft: '草稿' }[s.status] || '待批改');
  return `<div class="workspace-toolbar"><div class="workspace-heading"><h1>${esc(s.title)}</h1><p>${esc(s.authorName)} · ${fmtDate(s.createdAt)} · ${s.wordCount} 词 <span class="status-badge ${completed ? 'done' : ''}">${status}</span></p></div><div class="toolbar-actions">${completed ? '<button class="btn ghost" id="btn-export-pdf">导出 PDF</button><button class="btn ghost" id="btn-export-longimage">导出长图</button><button class="btn primary" id="btn-regrade">重新批改</button>' : '<button class="btn ghost" onclick="location.hash=\'#/dashboard\'">返回列表</button>'}</div></div>`;
}

function originalMaterialHTML(text) {
  return String(text || '（未提供）').split(/\n\s*\n/).filter(p => p.trim()).map(p => {
    if (/^\s*(?:Paragraph\s*[12]|段首句\s*[12]|【)/i.test(p)) return '<div class="material-note">' + esc(p) + '</div>';
    return paragraphHTML(p);
  }).join('');
}

function renderResult(s, isTeacher, isOwner) {
  const r = s.result;
  const body = $('#result-body');
  const finalScore = s.teacherScore != null ? s.teacherScore : (r ? r.score : null);
  const starters = givenStarters(s.originalText);
  const band = displayBand(finalScore);

  // 原文和学生稿保持在左侧，报告和参考稿位于右侧。
  const essayCard = `
    <section class="workspace-panel reading-panel" aria-label="原文与续写">
      <header class="panel-header"><h2>原文与续写</h2></header>
      <div class="panel-scroll" tabindex="0" aria-label="阅读原文与学生续写">
      <div class="essay-block">
        <h3 class="essay-label">原文阅读与段首句</h3>
        <div class="essay-content">${originalMaterialHTML(s.originalText)}</div>
      </div>
      <div class="essay-block">
        <h3 class="essay-label">学生续写（${s.wordCount} 词）</h3>
        <div class="essay-content">${paragraphHTML(s.essayText || '', { boldStarts: true, starters })}</div>
      </div>
      </div>
    </section>`;

  if (s.status === 'error') {
    body.innerHTML = workspaceToolbar(s, false) + '<div class="result-columns">' + essayCard + `<section class="workspace-panel"><header class="panel-header"><h2>批改报告</h2></header><div class="panel-scroll status-panel">
      <h2>批改失败</h2>
      <p class="muted" style="margin:10px 0">${esc(s.error || '未知错误')}</p>
      <button class="btn primary" id="btn-regrade">重新批改</button>
    </div></section></div>`;
    $('#btn-regrade').addEventListener('click', regrade);
    return;
  }

  if (!r || s.status === 'pending' || s.status === 'grading') {
    const pos = s.queuePos != null && s.queuePos >= 0 ? `（前面还有 ${s.queuePos} 篇）` : '';
    body.innerHTML = workspaceToolbar(s, false) + '<div class="result-columns">' + essayCard + `<section class="workspace-panel"><header class="panel-header"><h2>批改报告</h2></header><div class="panel-scroll status-panel">
      <div class="spinner-ring"></div>
      <h2 style="margin:10px 0">${s.status === 'grading' ? '正在批改中…' : '排队等待批改' + pos}</h2>
      <p class="muted">批改需要一些时间，完成后会自动显示结果。</p>
    </div></section></div>`;
    return;
  }

  body.innerHTML = workspaceToolbar(s, true) + '<div class="result-columns">' + essayCard + `
    <section class="workspace-panel report-panel" aria-label="批改报告">
    <header class="panel-header"><h2>批改报告</h2><span class="report-band">${esc(band)}</span></header>
    <div class="panel-scroll" tabindex="0" aria-label="阅读批改报告">
    <div class="result-head">
      <div class="result-score">${finalScore}<span class="outof">/25</span></div>
      <div class="result-info">
        <span class="result-band">${esc(band)}</span>
        <div class="result-title">${esc(s.title)}</div>
        <div class="result-meta">${esc(s.authorName)} · ${fmtDate(s.createdAt)} · ${s.wordCount} 词
          ${s.teacherScore != null ? ' · <b>教师终评</b>' : ''}</div>
        <div class="result-summary">${esc(r.summary || '')}</div>
      </div>
    </div>

    ${dimsHTML(r.dimensions || {})}
    <p class="muted score-explanation">四维用于解释AI整体评分。${s.teacherScore != null ? '教师终评另行显示，四维仍对应AI原评分。' : ''}</p>
    ${(r.assessment && r.assessment.taskNotes || []).length ? `<div class="section"><h3>题目与输入核对</h3>${r.assessment.taskNotes.map(n => `<div class="sug-item">${esc(n)}</div>`).join('')}</div>` : ''}

    <div class="section">
      <h3>☆ 表达与情节亮点</h3>
      ${(r.highlights || []).map(h => `<div class="hl-item">${esc(h)}</div>`).join('') || '<p class="muted">无明显亮点</p>'}
    </div>

    <div class="section">
      <h3>! 确定错误（计分 ${r.errorCount != null ? r.errorCount : (r.errors || []).length} 处）</h3>
      ${(r.errors || []).map(err => `
        <div class="err-item">
          <div>${esc(err.original)} <span class="type">${esc(err.type || '其他')}</span></div>
          <div class="fix">→ ${esc(err.fix || '')}</div>
          ${err.sourceQuotes && err.sourceQuotes[0] && err.sourceQuotes[0].original !== err.original ? `<div class="muted" style="margin-top:4px">原句示例：${esc(err.sourceQuotes[0].original)}</div>` : ''}
          ${err.note ? `<div class="muted" style="margin-top:4px">${esc(err.note)}</div>` : ''}
          ${err.locations && err.locations.length > 1 ? `<div class="muted">同一问题出现 ${err.locations.length} 次，合并计1处。</div>` : ''}
        </div>`).join('') || '<p class="muted">未列出确定错误</p>'}
    </div>

    ${(r.uncertainIssues || []).length ? `<div class="section"><h3>待核实问题（不计入自动扣分与封顶）</h3>${r.uncertainIssues.map(q => `<div class="review-item"><div>${esc(q.quote)}</div><div class="muted">${esc(q.reason)}</div>${q.possibleFix ? `<div>核实后可考虑：${esc(q.possibleFix)}</div>` : ''}</div>`).join('')}</div>` : ''}
    ${(r.improvements || []).length ? `<div class="section"><h3>表达优化（原句成立，不扣分）</h3>${r.improvements.map(q => `<div class="review-item"><div>${esc(q.quote)}</div><div>→ ${esc(q.alternative)}</div><div class="muted">${esc(q.benefit)}</div></div>`).join('')}</div>` : ''}

    <div class="section">
      <h3>◇ 改进建议</h3>
      ${(r.suggestions || []).map(sg => `<div class="sug-item">${esc(sg)}</div>`).join('') || ''}
    </div>

    <div class="section">
      <h3>润色后参考
        <button class="btn ghost small copy-btn" id="btn-copy">复制</button>
      </h3>
      <p class="muted reference-note">保留原情节，订正确定错误并优化表达；高亮显示改动。</p>
      <div class="polished-box" id="polished-text">${polishedHTML(r.polished || '', starters)}</div>
    </div>

    <div class="section result-actions">
      <button class="btn ghost" id="btn-copy-all">复制全部结果</button>
      <button class="btn danger" id="btn-delete">删除</button>
      <button class="btn ghost" onclick="location.hash='#/dashboard'">返回列表</button>
    </div>

    ${isTeacher ? `
    <div class="section card teacher-box">
      <h3>教师终评（可覆盖 AI 分数）</h3>
      <div class="row">
        <input type="number" id="teacher-score" min="0" max="25" placeholder="分数 0-25" value="${s.teacherScore != null ? s.teacherScore : ''}" />
        <button class="btn primary" id="btn-teacher-save">保存终评</button>
      </div>
      <textarea id="teacher-note" rows="2" placeholder="给学生的评语（可选）">${esc(s.teacherNote || '')}</textarea>
    </div>` : ''}</div></section></div>`;

  $('#btn-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(String(r.polished || '').replace(/\*\*/g, ''));
      toast('已复制润色版 📋');
    } catch (e) {
      toast('复制失败，请手动选择复制');
    }
  });
  $('#btn-copy-all').addEventListener('click', async () => {
    try {
      const dims = r.dimensions || {};
      const lines = [];
      lines.push('【续写批改结果】' + s.title);
      lines.push('总分：' + finalScore + '/25（' + band + '）');
      lines.push('总评：' + (r.summary || ''));
      lines.push('');
      lines.push('情节：' + (dims.plot ? dims.plot.score : '—') + '/10');
      lines.push('语言：' + (dims.language ? dims.language.score : '—') + '/6');
      lines.push('语法：' + (dims.grammar ? dims.grammar.score : '—') + '/5');
      lines.push('连贯：' + (dims.coherence ? dims.coherence.score : '—') + '/4');
      if ((r.highlights || []).length) lines.push('', '✨ 亮点：' + r.highlights.join('；'));
      if ((r.errors || []).length) {
        lines.push('', '🔧 确定错误（计分' + (r.errorCount != null ? r.errorCount : r.errors.length) + '处）：');
        for (const err of r.errors) {
          lines.push('- ' + err.original + ' → ' + (err.fix || '') + '（' + (err.type || '其他') + '）' + (err.note ? '：' + err.note : ''));
          if (err.sourceQuotes && err.sourceQuotes[0] && err.sourceQuotes[0].original !== err.original) lines.push('  原句示例：' + err.sourceQuotes[0].original);
        }
      }
      if ((r.assessment && r.assessment.taskNotes || []).length) lines.push('', '题目与输入核对：', ...r.assessment.taskNotes);
      if ((r.uncertainIssues || []).length) {
        lines.push('', '待核实问题（不计入自动扣分与封顶）：');
        for (const q of r.uncertainIssues) lines.push('- ' + q.quote + '：' + q.reason + (q.possibleFix ? '；核实后可考虑：' + q.possibleFix : ''));
      }
      if ((r.improvements || []).length) {
        lines.push('', '表达优化（原句可成立，不计错）：');
        for (const q of r.improvements) lines.push('- ' + q.quote + ' → ' + q.alternative + '：' + q.benefit);
      }
      if ((r.suggestions || []).length) lines.push('', '📝 改进建议：' + r.suggestions.join('；'));
      if (r.polished) lines.push('', '🖋 润色版：', r.polished.replace(/\*\*/g, ''));
      if (s.teacherScore != null) {
        lines.push('', '🎯 教师终评：' + s.teacherScore + '/25' + (s.teacherNote ? '（' + s.teacherNote + '）' : ''));
      }
      await navigator.clipboard.writeText(lines.join('\n'));
      toast('已复制全部批改结果 📋');
    } catch (e) {
      toast('复制失败，请手动选择复制');
    }
  });
  $('#btn-export-pdf').addEventListener('click', async () => {
    try {
      if (window.desktop && window.desktop.exportPdf) {
        const r = await window.desktop.exportPdf(s.id);
        if (r && r.ok) toast('PDF 已导出：' + r.path);
        else if (r && r.error) toast(r.error, 4000);
        /* canceled = 用户取消，静默 */
      } else {
        window.location.href = '/api/submissions/' + s.id + '/pdf';
      }
    } catch (e) {
      toast((e && e.message) || '导出失败', 4000);
    }
  });
  $('#btn-export-longimage').addEventListener('click', async () => {
    const btn = $('#btn-export-longimage');
    if (btn.disabled) return;
    btn.disabled = true;
    const orig = btn.textContent;
    btn.textContent = '导出中…';
    const describeErr = e => {
      if (!e) return '未知原因';
      if (e.message) return e.message;
      const s = String(e);
      return s && s !== '[object Object]' && s !== '[object Event]' ? s : '页面渲染异常（内容较多时偶发）';
    };
    const fail = msg => {
      const full = '导出长图失败：' + msg;
      toast(full, 5000);
      try {
        if (window.desktop && window.desktop.logError) window.desktop.logError(full);
        console.error('[export-longimage]', msg);
      } catch (e2) { /* 忽略 */ }
    };
    try {
      if (!window.htmlToImage) throw new Error('长图组件未加载');
      const source = document.querySelector('#result-body');
      if (!source) throw new Error('未找到可导出的内容');
      const clone = source.cloneNode(true);
      clone.removeAttribute('id');
      clone.classList.add('export-mode');
      // 导出副本不能重播入场动画，否则截图会记录初始的透明状态。
      for (const el of [clone, ...clone.querySelectorAll('*')]) {
        el.style.setProperty('animation', 'none', 'important');
        el.style.setProperty('transition', 'none', 'important');
      }
      clone.querySelectorAll('.dim-bar i').forEach(el => {
        el.style.transform = `scaleX(${(el.dataset.pct || 0) / 100})`;
      });
      if (s.teacherScore != null || s.teacherNote) {
        const feedback = document.createElement('div');
        feedback.className = 'section export-teacher-feedback';
        feedback.innerHTML = '<h3>教师终评</h3>' + (s.teacherScore != null ? '<p>教师评分：' + esc(s.teacherScore) + '/25</p>' : '') + (s.teacherNote ? '<p class="export-teacher-note">' + esc(s.teacherNote) + '</p>' : '');
        clone.querySelector('.report-panel .panel-scroll').appendChild(feedback);
      }
      clone.querySelectorAll('[id]').forEach(el => el.removeAttribute('id'));
      Object.assign(clone.style, { position: 'fixed', left: '-20000px', top: '0', width: '1200px', display: 'flex', flexDirection: 'column' });
      document.body.appendChild(clone);
      let dataUrl = null;
      let lastErr = null;
      try {
        await document.fonts.ready;
        const height = clone.scrollHeight;
        const ratio = height > 9000 ? 1 : height > 6000 ? 1.5 : 2;
        for (const pixelRatio of [...new Set([ratio, 1])]) {
          try {
            dataUrl = await window.htmlToImage.toPng(clone, {
              pixelRatio, cacheBust: false,
              backgroundColor: getComputedStyle(document.body).backgroundColor,
              width: 1200, height,
              style: { position: 'static', left: 'auto', top: 'auto', margin: '0' }
            });
            if (dataUrl) break;
          } catch (e) { lastErr = e; }
        }
      } finally { clone.remove(); }
      if (!dataUrl) throw new Error(describeErr(lastErr) || '页面渲染失败');
      if (window.desktop && window.desktop.saveLongImage) {
        const r = await window.desktop.saveLongImage(s.id, dataUrl);
        if (r && r.ok) { toast('长图已导出：' + r.path); return; }
        if (r && r.canceled) return;
        throw new Error((r && r.error) || '保存失败');
      }
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = (s.title || '批改结果') + '-长图.png';
      document.body.appendChild(a);
      a.click();
      a.remove();
      toast('长图已生成，请查看下载');
    } catch (e) {
      fail(describeErr(e));
    } finally {
      btn.disabled = false;
      btn.textContent = orig;
    }
  });
  $('#btn-regrade').addEventListener('click', regrade);
  $('#btn-delete').addEventListener('click', async () => {
    if (!confirm('确定删除这篇作文吗？')) return;
    try {
      await api('/api/submissions/' + s.id, { method: 'DELETE' });
      toast('已删除');
      location.hash = '#/dashboard';
    } catch (e) { toast(e.message, 4000); }
  });
  // 进度条动画：渲染完成后从 0 展开到目标值（scaleX，不触发 layout）
  requestAnimationFrame(() => requestAnimationFrame(() => {
    $$('.dim-bar i').forEach(el => {
      el.style.transform = `scaleX(${(el.dataset.pct || 0) / 100})`;
    });
  }));

  const ts = $('#teacher-score'), tn = $('#teacher-note');
  if (ts) {
    $('#btn-teacher-save').addEventListener('click', async () => {
      try {
        await api('/api/submissions/' + s.id, {
          method: 'PATCH',
          body: { teacherScore: ts.value, teacherNote: tn.value }
        });
        toast('已保存教师终评 ✅');
        loadResult(s.id);
        refreshRecent();
      } catch (e) { toast(e.message, 4000); }
    });
  }
}

async function loadResult(id) {
  const owner = ME?.id;
  const current = () => ME?.id === owner && location.hash === '#/result/' + id;
  try {
    const { submission } = await api('/api/submissions/' + id);
    if (!current()) return;
    if (submission.status === 'draft') { location.hash = '#/draft/' + id; return; }
    const isTeacher = ME.role === 'teacher';
    const isOwner = submission.userId === ME.id;
    renderResult(submission, isTeacher, isOwner);
    if (submission.status === 'pending' || submission.status === 'grading') {
      clearInterval(pollTimer);
      pollTimer = setInterval(async () => {
        try {
          const { submission: s2 } = await api('/api/submissions/' + id);
          if (!current()) return;
          renderResult(s2, isTeacher, isOwner);
          if (s2.status === 'done' || s2.status === 'error') {
            clearInterval(pollTimer);
            refreshRecent();
            toast(s2.status === 'done' ? '批改完成 ✅' : '批改失败');
          }
        } catch (e) { /* 轮询失败静默重试 */ }
      }, 2500);
    }
  } catch (e) {
    if (current()) $('#result-body').innerHTML = `<div class="card"><h2>出错了</h2><p class="muted">${esc(e.message)}</p></div>`;
  }
}

async function regrade() {
  const id = location.hash.split('/')[2];
  const button = $('#btn-regrade'); if (button?.disabled) return; if (button) button.disabled = true;
  try {
    await api('/api/submissions/' + id + '/regrade', { method: 'POST' });
    toast('已重新排队批改');
    loadResult(id);
    refreshRecent();
  } catch (e) { toast(e.message, 4000); }
  finally { if (button) button.disabled = false; }
}

/* ---------- 初始化 ---------- */
function init() {
  $('#form-enter').addEventListener('submit', async e => {
    e.preventDefault();
    const msg = $('#form-enter .form-msg');
    msg.textContent = '';
    const btn = $('#form-enter button[type="submit"]');
    const username = e.target.username.value.trim();
    if (!username) { msg.textContent = '请输入用户名'; return; }
    btn.disabled = true;
    try {
      const { user } = await api('/api/enter', { method: 'POST', body: { username } });
      try { localStorage.setItem('eg_last_user', user.name || username); } catch (err) { /* 忽略 */ }
      showApp(user);
    } catch (err) { msg.textContent = err.message; }
    finally { btn.disabled = false; }
  });

  $('#btn-logout').addEventListener('click', async () => {
    Drafts.logout();
    try { await api('/api/auth/logout', { method: 'POST' }); } catch (e) { /* ignore */ }
    ME = null;
    clearInterval(pollTimer);
    clearInterval(recentPollTimer); recentSequence++;
    location.hash = '#/login';
    showLogin();
  });

  $$('.nav-btn').forEach(b => b.addEventListener('click', () => { location.hash = '#/' + b.dataset.view; }));

  window.addEventListener('hashchange', route);
  initSubmitForm();
  Drafts.init();

  // 免注册：每次启动输入用户名进入，并预填上次的名字
  try {
    const last = localStorage.getItem('eg_last_user');
    if (last) $('#form-enter input[name="username"]').value = last;
  } catch (e) { /* 忽略 */ }
  showLogin();
}

document.addEventListener('DOMContentLoaded', init);
