'use strict';
/* 设置、持久化外观与字号、数据管理、OCR 拖拽上传。 */
(function () {
  const $ = s => document.querySelector(s);

  function toast(msg, ms) {
    const t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.classList.remove('hidden', 'out');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.classList.add('hidden'), 180);
    }, ms || 2600);
  }

  /* ---------- 设置弹窗 ---------- */
  function buildSettingsUI() {
    if ($('#settings-modal')) return;
    const modal = document.createElement('div');
    modal.id = 'settings-modal';
    modal.className = 'modal-mask hidden';
    modal.innerHTML = `
      <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="settings-title">
        <div class="modal-head">
          <h3 id="settings-title">设置</h3>
          <button type="button" class="modal-close" id="settings-close" aria-label="关闭设置">×</button>
        </div>
        <div class="modal-body">
          <h4 class="settings-section-title">外观</h4>
          <div class="theme-switch" id="set-theme" aria-label="外观模式">
            <button type="button" class="theme-btn" data-theme="light"><span class="theme-swatch light-swatch" aria-hidden="true"></span>浅色</button>
            <button type="button" class="theme-btn" data-theme="dark"><span class="theme-swatch dark-swatch" aria-hidden="true"></span>深色</button>
          </div>
          <div class="set-row"><span class="set-key">字体大小</span>
            <span class="set-val font-scale-row" id="set-fontscale">
              <button type="button" class="fs-btn" data-scale="0.85">小</button>
              <button type="button" class="fs-btn active" data-scale="1">标准</button>
              <button type="button" class="fs-btn" data-scale="1.15">大</button>
              <button type="button" class="fs-btn" data-scale="1.3">特大</button>
            </span>
          </div>
          <p class="hint">外观与字号立即生效，自动保存，下次启动保留。</p>
          <div class="font-preview"><p class="reading-paragraph"><strong>The room grew quiet.</strong> A gentle warmth spread through the crowd.</p></div>
          <h4 class="settings-section-title">模型与API</h4>
          <p class="hint">填写自己的API Key，费用由所选服务商账户承担。密钥在本机加密保存，软件不将密钥上传给开发者；模型调用时会发送给所选服务商用于认证。不同本机用户名共享接口设置。</p>
          <div id="api-grade"></div>
          <label class="api-shared"><input type="checkbox" id="api-same-ocr" /> 图片识别使用与批改相同的配置（该模型须支持图片）</label>
          <div id="api-ocr"></div>
          <p class="hint" id="api-storage-status"></p>
          <h4 class="settings-section-title">当前批改模型</h4>
          <div class="set-row"><span class="set-key">批改模型</span><span class="set-val" id="set-model"></span></div>
          <div class="set-row"><span class="set-key">制作模型</span><span class="set-val">GPT-6.1 Sol</span></div>
          <h4 class="settings-section-title">本地数据</h4>
          <div class="set-row"><span class="set-key">版本</span><span class="set-val" id="set-version"></span></div>
          <div class="set-row"><span class="set-key">数据目录</span><span class="set-val" id="set-datadir"></span></div>
          <div class="set-row"><span class="set-key">本地数据</span><span class="set-val" id="set-dbinfo"></span></div>
          <div class="set-actions">
            <button type="button" class="btn ghost small" id="btn-open-dir">打开数据目录</button>
            <button type="button" class="btn danger small" id="btn-clear-data">清理全部本地数据</button>
          </div>

        </div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" id="settings-cancel">取消</button>
          <button type="button" class="btn primary" id="settings-save">保存</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    bindFontScale();
    $('#set-theme').querySelectorAll('.theme-btn').forEach(b => b.addEventListener('click', () => {
      applyTheme(b.dataset.theme);
      savePreference({ theme: b.dataset.theme });
    }));

    const close = () => {
      modal.classList.add('hidden');
      $('#view-app').inert = false;
      modal.querySelectorAll('input[type=password]').forEach(el => { el.value = ''; });
      $('#btn-settings').focus();
    };
    $('#settings-close').addEventListener('click', close);
    $('#settings-cancel').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    modal.addEventListener('keydown', e => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'Tab') return;
      const controls = [...modal.querySelectorAll('button,input,select,textarea,a[href]')].filter(el => !el.disabled && el.offsetParent !== null);
      const first = controls[0], last = controls[controls.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });

    $('#settings-save').addEventListener('click', async () => {
      const btn = $('#settings-save');
      btn.disabled = true;
      try {
        await api('/api/settings', { method: 'PUT', body: { ai: { grade: readAPIForm('grade'), ocr: $('#api-same-ocr').checked ? { sameAsGrade: true } : readAPIForm('ocr') } } });
        toast('设置已保存 ✅');
        close();
      } catch (e) {
        toast((e && e.message) || '保存失败', 4000);
      } finally {
        btn.disabled = false;
      }
    });

    $('#btn-open-dir').addEventListener('click', async () => {
      try { await api('/api/settings/open-data-dir', { method: 'POST' }); }
      catch (e) { toast((e && e.message) || '无法打开数据目录', 4000); }
    });

    $('#btn-clear-data').addEventListener('click', async () => {
      if (!confirm('确定要清空全部本地数据吗？\n（所有用户、作文与批改记录都会被删除，且无法恢复）')) return;
      if (!confirm('再次确认：该操作不可撤销，确定清空？')) return;
      try {
        await api('/api/settings/clear-data', { method: 'POST' });
        toast('本地数据已清空');
        await loadSettingsInfo();
        location.hash = '#/login';
        location.reload();
      } catch (e) {
        toast((e && e.message) || '清理失败', 4000);
      }
    });
  }

  async function loadSettingsInfo() {
    try {
      const s = await api('/api/settings');
      renderAPIForms(s.ai);
      $('#set-model').textContent = s.model;
      $('#set-model').title = '接口模型 ID：' + s.model;
      $('#set-version').textContent = s.version;
      applyTheme(s.theme);
      applyFontScale(s.fontScale);
      const fsRow = $('#set-fontscale');
      if (fsRow) {
        fsRow.querySelectorAll('.fs-btn').forEach(b =>
          b.classList.toggle('active', Number(b.dataset.scale) === Number(s.fontScale || 1)));
      }
      $('#set-datadir').textContent = s.dataDir;
      $('#set-dbinfo').textContent = '用户 ' + s.counts.users + ' 人 · 作文 ' + s.counts.submissions + ' 篇 · db.json ' + (s.dbSize / 1024).toFixed(1) + ' KB';
    } catch (e) { /* 未登录时忽略 */ }
  }

  function openSettings() {
    buildSettingsUI();
    $('#settings-modal').classList.remove('hidden');
    $('#view-app').inert = true;
    $('#settings-close').focus();
    loadSettingsInfo();
  }


  let presets = [];
  const escapeHTML = text => String(text ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function readAPIForm(stage) {
    const el = $('#api-' + stage);
    const config = Object.fromEntries(['provider','baseUrl','protocol','model','effort','jsonMode','apiKey'].map(key => [key, el.querySelector('[data-field="' + key + '"]').value]));
    config.clearKey = el.querySelector('[data-field="clearKey"]').checked;
    return config;
  }
  function renderAPIForms(ai) {
    presets = ai.presets;
    for (const stage of ['grade', 'ocr']) {
      const c = ai[stage], box = $('#api-' + stage);
      box.innerHTML = '<fieldset class="api-config"><legend>' + (stage === 'grade' ? '文字稿批改' : '图片识别') + '</legend>' +
        '<label>服务商<select data-field="provider">' + presets.map(p => '<option value="' + p.id + '">' + escapeHTML(p.name) + '</option>').join('') + '</select></label>' +
        '<label>模型ID<input data-field="model" type="text" autocomplete="off" placeholder="填写服务商控制台中的模型ID；识别须选视觉模型" /></label>' +
        '<label>API Key<input data-field="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="' + (c.hasKey ? '已配置；留空保留，更换时输入新密钥' : c.storedKey ? '旧密钥无法解密，请重新填写' : '尚未配置，请填写自己的API Key') + '" /></label>' +
        '<label class="api-clear"><input data-field="clearKey" type="checkbox" /> 删除此配置中已保存的密钥</label>' +
        '<details><summary>高级设置：地址、协议与思考</summary>' +
        '<label>API基础地址<input data-field="baseUrl" type="url" autocomplete="off" placeholder="https://服务商地址/v1" /></label>' +
        '<label>接口协议<select data-field="protocol"><option value="chat">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic">Claude Messages</option></select></label>' +
        '<label>思考强度<select data-field="effort"><option value="auto">自动（优先兼容）</option><option value="off">关闭（模型须支持）</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="max">Max</option></select></label>' +
        '<label>JSON输出<select data-field="jsonMode"><option value="auto">自动</option><option value="prompt">仅使用提示词约束（兼容性优先）</option><option value="object">接口JSON模式（模型须支持）</option></select></label></details>' +
        '<p class="hint">模型能力与思考参数因服务商而异。出现参数错误时先选“自动”思考与“仅使用提示词约束”。自定义地址将接收您提交的密钥和作文，请确认可信。</p>' +
        '<button type="button" class="btn ghost small api-test">测试已保存的连接（可能产生少量费用）</button><p class="hint api-test-msg" role="status"></p></fieldset>';
      for (const key of ['provider','baseUrl','protocol','model','effort','jsonMode']) box.querySelector('[data-field="' + key + '"]').value = c[key];
      box.querySelector('[data-field="provider"]').addEventListener('change', e => {
        const p = presets.find(p => p.id === e.target.value);
        for (const key of ['baseUrl','protocol']) box.querySelector('[data-field="' + key + '"]').value = p[key];
        box.querySelector('[data-field="model"]').value = p[stage + 'Model'] || '';
        box.querySelector('[data-field="apiKey"]').value = '';
        box.querySelector('[data-field="apiKey"]').placeholder = '更换服务商后请填写该服务商的密钥';
        box.querySelector('[data-field="clearKey"]').checked = false;
        box.querySelector('[data-field="effort"]').value = 'auto';
        box.querySelector('[data-field="jsonMode"]').value = 'auto';
      });
      box.querySelector('.api-test').addEventListener('click', async e => {
        const button = e.target, msg = box.querySelector('.api-test-msg'); button.disabled = true; msg.textContent = '正在测试已保存的配置…';
        try { const result = await api('/api/ai-test', { method: 'POST', body: { stage } }); msg.textContent = result.message; }
        catch (err) { msg.textContent = err.message; }
        finally { button.disabled = false; }
      });
    }
    $('#api-same-ocr').checked = ai.sameOCR;
    const toggle = () => { $('#api-ocr').hidden = $('#api-same-ocr').checked; };
    $('#api-same-ocr').onchange = toggle; toggle();
    $('#api-storage-status').textContent = ai.secureStorageAvailable ? '本机系统加密可用。不会回显已保存的密钥。' : '系统加密服务不可用，当前无法保存密钥。请重启桌面软件。';
  }
  function showFirstUse() {
    if ($('#first-use-modal')) return;
    const modal = document.createElement('div'); modal.id = 'first-use-modal'; modal.className = 'modal-mask';
    modal.innerHTML = '<div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="first-use-title"><div class="modal-head"><h3 id="first-use-title">首次使用提示</h3></div><div class="modal-body"><p>首次使用时，请先在设置中填写自己的API Key，并选择批改及图片识别模型。</p><p>密钥仅保存在您的本机，并使用系统加密保护。软件不会将密钥上传给开发者；调用模型时，密钥会发送给您选择的API服务商用于身份验证，相关费用由您的账户承担。</p><p>识别照片及批改文字稿也会发送给所选服务商。请使用可信接口，不要分享自己的密钥；本机加密不能保证被入侵的电脑仍安全。</p></div><div class="modal-foot"><button type="button" class="btn ghost" id="first-use-later">稍后设置</button><button type="button" class="btn primary" id="first-use-settings">前往设置</button></div></div>';
    document.body.appendChild(modal); $('#view-app').inert = true;
    const close = async open => { try { await api('/api/onboarding', { method: 'POST' }); modal.remove(); $('#view-app').inert = false; if (open) openSettings(); else $('#btn-settings').focus(); } catch (err) { toast(err.message); } };
    $('#first-use-settings').onclick = () => close(true); $('#first-use-later').onclick = () => close(false); $('#first-use-settings').focus();
    modal.addEventListener('keydown', e => { if (e.key === 'Tab') { e.preventDefault(); ($('#first-use-settings') === document.activeElement ? $('#first-use-later') : $('#first-use-settings')).focus(); } });
  }

  /* ---------- 字体大小 ---------- */
  const FONT_SCALES = [0.85, 1, 1.15, 1.3];
  function applyFontScale(scale) {
    const v = FONT_SCALES.includes(Number(scale)) ? Number(scale) : 1;
    document.documentElement.style.fontSize = (16 * v) + 'px';
    try { localStorage.setItem('eg_fontscale', String(v)); } catch (e) { /* 使用服务端保存 */ }
    document.querySelectorAll('.fs-btn').forEach(b => {
      const selected = Number(b.dataset.scale) === v;
      b.classList.toggle('active', selected); b.setAttribute('aria-pressed', String(selected));
    });
  }
  function applyTheme(theme) {
    const value = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = value;
    try { localStorage.setItem('eg_theme', value); } catch (e) { /* 使用服务端保存 */ }
    document.querySelectorAll('.theme-btn').forEach(b => {
      const selected = b.dataset.theme === value;
      b.classList.toggle('active', selected); b.setAttribute('aria-pressed', String(selected));
    });
  }
  let preferenceQueue = Promise.resolve();
  function savePreference(body) {
    preferenceQueue = preferenceQueue.then(() => api('/api/settings', { method: 'PUT', body })).catch(e => toast('外观或字号保存失败：' + e.message, 4000));
    return preferenceQueue;
  }
  function bindFontScale() {
    const row = $('#set-fontscale');
    if (!row) return;
    row.querySelectorAll('.fs-btn').forEach(b => {
      b.addEventListener('click', async () => {
        applyFontScale(b.dataset.scale);
        await savePreference({ fontScale: Number(b.dataset.scale) });
      });
    });
  }

  /* ---------- OCR 拖拽上传 ---------- */
  function setupOcrDragDrop() {
    const dz = document.querySelector('.dropzone');
    if (!dz) return;
    let counter = 0;
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault();
      e.stopPropagation();
      counter++;
      dz.classList.add('drag-over');
    }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => {
      e.preventDefault();
      e.stopPropagation();
      counter = Math.max(0, counter - 1);
      if (counter === 0) dz.classList.remove('drag-over');
    }));
    dz.addEventListener('drop', e => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || [])
        .filter(f => /^image\/(jpeg|png|webp)$/.test(f.type));
      if (!files.length) { toast('仅支持 JPG/PNG/WebP 格式图片', 3000); return; }
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
      toast('已添加图片，当前共 ' + ocrFiles.length + ' 张，点击「识别图片并填入表单」');
    });
    // 防止图片拖到窗口其他区域导致页面跳转
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => e.preventDefault());
  }

  function initDesktop() {
    $('#btn-settings').addEventListener('click', openSettings);
    setupOcrDragDrop();
    /* 进入应用后应用已保存的字体大小 */
    document.addEventListener('eg:entered', async () => {
      try {
        const s = await api('/api/settings');
        applyFontScale(s.fontScale);
        applyTheme(s.theme);
        if (!s.ai.onboardingSeen) showFirstUse();
      } catch (e) { /* 忽略 */ }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initDesktop);
  } else {
    initDesktop();
  }
})();
