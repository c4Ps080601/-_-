'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'essay-list-refresh-'));
process.env.EG_DATA_DIR = path.join(dir, 'data');
process.env.EG_SETTINGS_FILE = path.join(dir, 'settings.json');
const { app } = require('../server'), store = require('../store');
const { _electron } = require('playwright');

test('我的作文：轮询不重建卡片，状态、评分、增删排序及迟到响应正确同步', { timeout: 45000 }, async () => {
  const user = store.createUser({ username: '列表回归测试', name: '教师', password: 'test', role: 'teacher' });
  for (let i = 0; i < 25; i++) store.createDraft({ userId: user.id, title: 'Test ' + i, originalText: 'Original', essayText: 'A short essay.' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.on('listening', r));
  const main = path.join(dir, 'main.cjs');
  fs.writeFileSync(main, `const {app,BrowserWindow}=require('electron'); app.setPath('userData',${JSON.stringify(path.join(dir, 'electron'))}); app.whenReady().then(()=>new BrowserWindow({show:false,width:1200,height:800}).loadURL('about:blank')); app.on('window-all-closed',()=>app.quit());`);
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let electron;
  try {
    electron = await _electron.launch({ executablePath: require('electron'), args: [main], env });
    const page = await electron.firstWindow(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('#form-enter input').fill(user.username);
    await page.locator('#form-enter').evaluate(form => form.requestSubmit());
    await page.waitForFunction(() => document.querySelectorAll('.sub-item').length === 25);
    await page.waitForTimeout(600);
    const id = await page.evaluate(() => {
      window.savedRows = [...document.querySelectorAll('.sub-item')];
      window.listMutations = 0;
      window.listObserver = new MutationObserver(m => window.listMutations += m.length);
      window.listObserver.observe(document.querySelector('#submission-list'), { subtree: true, childList: true, attributes: true, characterData: true });
      document.querySelector('.main').scrollTop = 180;
      window.savedScroll = document.querySelector('.main').scrollTop;
      const range = document.createRange(); range.selectNodeContents(window.savedRows[0].querySelector('.sub-title'));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      window.savedSelection = getSelection().toString();
      return window.savedRows[0].dataset.id;
    });
    // 跨越两个真实的3秒轮询周期，检测DOM、动画引发的重建和文本选择丢失。
    await page.waitForTimeout(6700);
    assert.deepEqual(await page.evaluate(() => ({ mutations: listMutations, sameNodes: savedRows.every((r,i) => r === document.querySelectorAll('.sub-item')[i]), scroll: document.querySelector('.main').scrollTop === savedScroll, selection: getSelection().toString() === savedSelection })), { mutations: 0, sameNodes: true, scroll: true, selection: true });
    store.setSubmissionStatus(id, 'grading');
    await page.waitForFunction(id => document.querySelector(`.sub-item[data-id="${id}"]`).textContent.includes('批改中'), id);
    assert.equal(await page.locator(`.recent-item[data-id="${id}"] .recent-status`).textContent(), '批改中');
    assert.ok(await page.evaluate(() => savedRows.every((r,i) => r === document.querySelectorAll('.sub-item')[i])));
    store.setSubmissionResult(id, { score: 20 });
    await page.waitForFunction(id => document.querySelector(`.sub-item[data-id="${id}"] .score-badge`).textContent.startsWith('20'), id);
    store.setTeacherAdjust(id, 21, '教师调整');
    await page.waitForFunction(id => document.querySelector(`.sub-item[data-id="${id}"] .score-badge`).textContent.includes('21教师'), id);

    const fresh = store.createDraft({ userId: user.id, title: 'New draft', originalText: 'New', essayText: 'New essay.' });
    await page.waitForFunction(() => document.querySelectorAll('.sub-item').length === 26);
    assert.ok(await page.evaluate(() => savedRows.every(r => r.isConnected)));
    await page.locator(`.sub-item[data-id="${fresh.id}"]`).dispatchEvent('click');
    await page.waitForFunction(id => location.hash === '#/draft/' + id, fresh.id);
    await page.locator('[data-view="dashboard"]').dispatchEvent('click');
    await page.waitForSelector('#view-dashboard:not(.hidden)');
    store.deleteSubmission(fresh.id);
    await page.waitForFunction(() => document.querySelectorAll('.sub-item').length === 25);

    // 验证重排使用原节点，以及旧加载响应不能覆盖较新的轮询结果。
    assert.equal(await page.evaluate(async () => {
      clearInterval(recentPollTimer);
      const actual = await api('/api/submissions');
      const rows = [...document.querySelectorAll('.sub-item')];
      renderList([...actual.submissions].reverse(), true);
      const reordered = rows.every(r => r.isConnected);
      renderList(actual.submissions, true);
      const realFetch = window.fetch;
      let release;
      window.fetch = () => new Promise(r => release = r);
      const old = loadDashboard();
      window.fetch = async () => new Response(JSON.stringify(actual), { status: 200 });
      await refreshRecent();
      release(new Response(JSON.stringify({ submissions: [] }), { status: 200 }));
      await old;
      window.fetch = realFetch;
      return reordered && document.querySelectorAll('.sub-item').length === 25;
    }), true);
    for (const s of store.listSubmissions(user)) store.deleteSubmission(s.id);
    await page.evaluate(() => refreshRecent());
    assert.equal(await page.locator('#submission-list .empty').count(), 1);
    assert.equal(await page.evaluate(async () => { listMutations = 0; await refreshRecent(); return listMutations; }), 0);
    assert.deepEqual(errors, []);
  } finally {
    if (electron) await electron.close();
    await new Promise(r => server.close(r));
  }
});
