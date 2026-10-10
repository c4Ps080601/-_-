'use strict';
/* 先保存到本地恢复副本，再串行写入草稿；识别结果由后端先保存再回填。 */
window.Drafts = (() => {
  let editor = null, timer = null, saveQueue = Promise.resolve(), submitting = false, loadSerial = 0;
  const form = () => document.querySelector('#form-submit');
  const newId = () => crypto.randomUUID();
  const fields = () => Object.fromEntries(['title', 'originalText', 'essayText'].map(k => [k, form().querySelector('[name="' + k + '"]').value]));
  const key = s => 'eg_draft_' + s.userId + '_' + s.clientId;
  const activeKey = userId => 'eg_active_draft_' + userId;
  const same = (a, b) => a.originalText === b.originalText && a.essayText === b.essayText && (!a.title.trim() || a.title === b.title);
  function message(text, error = false) {
    const el = document.querySelector('#draft-status'); el.textContent = text; el.classList.toggle('error', error);
  }
  function remember(s) {
    if (s.readOnly || s.submitted) return;
    try { localStorage.setItem(key(s), JSON.stringify(s)); if (editor === s) localStorage.setItem(activeKey(s.userId), s.clientId); }
    catch (e) { if (editor === s) message('恢复副本暂存失败，正在尝试保存到草稿记录。', true); }
  }
  function forget(s) {
    try { localStorage.removeItem(key(s)); if (localStorage.getItem(activeKey(s.userId)) === s.clientId) localStorage.removeItem(activeKey(s.userId)); } catch (e) { /* 数据库仍保存全文 */ }
  }
  function cached(userId, clientId) {
    try { const s = JSON.parse(localStorage.getItem('eg_draft_' + userId + '_' + clientId)); return s && s.userId === userId && s.data && typeof s.data.originalText === 'string' && typeof s.data.essayText === 'string' && typeof s.data.title === 'string' ? s : null; } catch (e) { return null; }
  }
  function empty() { return { id: null, clientId: newId(), userId: ME.id, revision: 0, version: 0, savedVersion: 0, data: { title: '', originalText: '', essayText: '' } }; }
  function capture() {
    if (!editor || editor.readOnly || editor.submitted) return editor;
    const data = fields();
    if (JSON.stringify(data) !== JSON.stringify(editor.data)) { editor.data = data; editor.version++; remember(editor); }
    return editor;
  }
  function show(s) {
    editor = s; form().inert = false;
    for (const [k, value] of Object.entries(s.data)) form().querySelector('[name="' + k + '"]').value = value;
    form().querySelectorAll('input,textarea,button').forEach(el => { el.disabled = !!s.readOnly; });
    document.querySelector('#btn-ocr').disabled = !!s.readOnly || window.ocrRunning === true;
    document.querySelector('#btn-submit').textContent = '提交批改';
    document.querySelector('#btn-submit').classList.remove('loading');
    document.querySelector('#btn-delete-draft').classList.toggle('hidden', !s.id || !!s.readOnly);
    document.querySelector('#btn-save-copy').classList.toggle('hidden', !s.blocked);
    document.querySelector('#word-count').textContent = (s.data.essayText.trim() ? s.data.essayText.trim().split(/\s+/).length : 0) + ' 词';
    message(s.readOnly ? '这是其他用户的草稿，仅作者可编辑。' : s.blocked ? '草稿版本有冲突，当前文字已保留，可另存为新草稿。' : s.version > s.savedVersion ? '有未同步编辑，恢复副本已保留。' : s.id ? '草稿已保存，可随时切换页面。' : '填写文字或识别图片后自动保存草稿。', !!s.blocked);
    if (!s.readOnly) remember(s);
  }
  function schedule(s = capture()) {
    clearTimeout(timer);
    if (s && !s.readOnly && !s.submitted) timer = setTimeout(() => save(s).catch(() => {}), 500);
  }
  function save(s = capture()) {
    if (!s) return Promise.resolve(null);
    const operation = saveQueue.then(async () => {
      if (!ME || ME.id !== s.userId || s.readOnly || s.submitted || s.blocked) return null;
      if (!s.id && !Object.values(s.data).some(v => v.trim())) return null;
      if (s.id && s.savedVersion >= s.version) return s;
      const version = s.version, data = { ...s.data };
      let response = s.id ? await api('/api/drafts/' + s.id, { method: 'PUT', body: { ...data, revision: s.revision } }) : await api('/api/drafts', { method: 'POST', body: { ...data, clientId: s.clientId } });
      let saved = response.submission;
      if (saved.status !== 'draft') { s.submitted = true; forget(s); if (editor === s && ME?.id === s.userId) location.hash = '#/result/' + saved.id; return null; }
      s.id = saved.id; s.revision = saved.draftRevision;
      // 首次创建请求的响应丢失后重试，先找回同一记录，再同步最新文字。
      if (!same(data, saved)) { response = await api('/api/drafts/' + s.id, { method: 'PUT', body: { ...data, revision: s.revision } }); saved = response.submission; s.revision = saved.draftRevision; }
      s.savedVersion = version; remember(s);
      if (ME?.id === s.userId) {
        refreshRecent();
        if (editor === s) {
          message(s.version > version ? '正在保存最新编辑…' : '草稿已保存，可随时切换页面。');
          document.querySelector('#btn-delete-draft').classList.remove('hidden');
          if (location.hash === '#/submit') history.replaceState(null, '', '#/draft/' + s.id);
        }
      }
      return s;
    });
    saveQueue = operation.catch(e => {
      if (e.status === 409) s.blocked = true;
      remember(s);
      if (editor === s && ME?.id === s.userId) { message('草稿同步失败，当前文字已保留：' + e.message, true); document.querySelector('#btn-save-copy').classList.toggle('hidden', !s.blocked); }
    });
    return operation;
  }
  function activate() {
    loadSerial++;
    if (!editor || editor.userId !== ME.id || editor.submitted || editor.readOnly) {
      let restored = null; try { restored = cached(ME.id, localStorage.getItem(activeKey(ME.id))); } catch (e) { /* 新建 */ }
      show(restored && !restored.submitted ? restored : empty());
    } else show(editor);
    if (editor.id) { history.replaceState(null, '', '#/draft/' + editor.id); load(editor.id); }
    else if (editor.version > editor.savedVersion) schedule(editor);
  }
  async function load(id) {
    const previous = capture(), previousSave = save(previous);
    const serial = ++loadSerial, owner = ME.id; form().inert = true; message('正在打开草稿…');
    try {
      try { await previousSave; } catch (e) { /* 仍可从本地恢复编辑 */ }
      const { submission: sub } = await api('/api/submissions/' + id);
      if (!ME || ME.id !== owner || serial !== loadSerial || location.hash !== '#/draft/' + id) return;
      if (sub.status !== 'draft') { location.hash = '#/result/' + id; return; }
      let s = { id: sub.id, clientId: sub.clientId, userId: sub.userId, revision: sub.draftRevision, version: 0, savedVersion: 0, readOnly: sub.userId !== owner, data: { title: sub.title, originalText: sub.originalText, essayText: sub.essayText } };
      const local = sub.userId === owner && cached(owner, sub.clientId);
      if (local && local.version > local.savedVersion) {
        if (same(local.data, sub)) { local.savedVersion = local.version; local.revision = sub.draftRevision; }
        else if (local.revision !== sub.draftRevision) local.blocked = true;
        s = local;
      }
      clearOcrFiles(); show(s);
      if (s.version > s.savedVersion && !s.blocked) schedule(s);
    } catch (e) { if (serial === loadSerial) message('打开草稿失败：' + e.message, true); }
    finally { if (serial === loadSerial) form().inert = false; }
  }
  function startNew() {
    save(capture()).catch(() => {}); loadSerial++; clearOcrFiles(); show(empty());
    history.replaceState(null, '', '#/submit');
    document.querySelector('#ocr-msg').textContent = ''; form().querySelector('.form-msg').textContent = '';
  }
  function ocrContext() { return { editor: capture(), version: editor?.version, owner: ME.id, clientId: newId() }; }
  function acceptOCR(sub, context) {
    if (!ME || ME.id !== context.owner) return;
    refreshRecent();
    if (editor === context.editor && editor.version === context.version && (location.hash === '#/submit' || location.hash.startsWith('#/draft/'))) {
      clearTimeout(timer);
      show({ id: sub.id, clientId: sub.clientId, userId: sub.userId, revision: sub.draftRevision, version: 0, savedVersion: 0, data: { title: sub.title, originalText: sub.originalText, essayText: sub.essayText } });
      history.replaceState(null, '', '#/draft/' + sub.id);
    }
    toast('识别稿已保存到最近作文，可核对后提交批改。');
  }
  async function submit() {
    if (submitting || window.ocrRunning) return;
    const s = capture(); if (!s || s.readOnly) return;
    submitting = true; form().inert = true;
    const button = document.querySelector('#btn-submit'); button.disabled = true; button.classList.add('loading'); button.textContent = '提交中…';
    const msg = form().querySelector('.form-msg'); msg.textContent = '';
    try {
      clearTimeout(timer); await save(s);
      if (s.blocked || s.submitted || !s.id) { if (!s.submitted) throw Error('请先保存并核对草稿。'); return; }
      if (!ME || ME.id !== s.userId) return;
      const { submission } = await api('/api/drafts/' + s.id + '/submit', { method: 'POST', body: { ...s.data, revision: s.revision } });
      s.submitted = true; forget(s); refreshRecent();
      if (editor === s && ME?.id === s.userId) { editor = null; clearOcrFiles(); form().reset(); document.querySelector('#word-count').textContent = '0 词'; if (location.hash === '#/submit' || location.hash === '#/draft/' + s.id) location.hash = '#/result/' + submission.id; }
      toast('已提交批改，切换页面不会丢失原稿。');
    } catch (e) { if (editor === s) { msg.textContent = e.message; remember(s); } }
    finally { submitting = false; form().inert = false; button.disabled = false; button.classList.remove('loading'); button.textContent = '提交批改'; }
  }
  function init() {
    form().addEventListener('input', () => { const s = capture(); if (s) { message('正在保存…'); schedule(s); } });
    document.querySelector('#btn-new-draft').addEventListener('click', startNew);
    document.querySelector('#btn-save-copy').addEventListener('click', () => { const old = capture(); if (!old || old.readOnly) return; forget(old); show({ ...old, id: null, clientId: newId(), revision: 0, savedVersion: -1, blocked: false }); save(editor).catch(() => {}); });
    document.querySelector('#btn-delete-draft').addEventListener('click', async () => {
      const s = capture(); if (!s?.id || !confirm('确定删除这篇草稿吗？')) return;
      try { await saveQueue; await api('/api/submissions/' + s.id, { method: 'DELETE' }); s.submitted = true; forget(s); if (editor === s) { editor = null; startNew(); } refreshRecent(); } catch (e) { message('删除失败：' + e.message, true); }
    });
    window.addEventListener('beforeunload', capture);
    window.addEventListener('online', () => save(capture()).catch(() => {}));
  }
  function leave() { const s = capture(); if (s) save(s).catch(() => {}); }
  function logout() { leave(); editor = null; loadSerial++; clearTimeout(timer); clearOcrFiles(); form().reset(); }
  return { init, activate, load, submit, leave, logout, ocrContext, acceptOCR };
})();
