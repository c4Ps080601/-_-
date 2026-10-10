'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
process.env.EG_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'essay-rubric-test-'));
const rubric = require('../rubric');
const settings = require('../settings');
settings.getAIConfig = () => ({ ...require('../providers').normalizeConfig({ provider: 'deepseek' }), apiKey: 'unit-test-no-real-key' });
const grader = require('../grader');

const sub = () => ({ originalText: 'A story.\n\nParagraph 1: One day he arrived.\n\nParagraph 2: Then she smiled.\n\n【本题要求】150词左右', essayText: 'One day he arrived. He was kind.\n\nThen she smiled. They went home.' });
const result = () => ({
  score: 20, title: 'A Kind Encounter', summary: '第四档，情节完整，表达有效。',
  assessment: { plotStatus: 'reasonable', continuationComplete: true, reason: '两段完成相遇与回应，因果连贯。', taskNotes: [] },
  dimensions: { plot: { score: 8, comment: '任务完成较好' }, language: { score: 5, comment: '表达有变化' }, grammar: { score: 4, comment: '总体准确' }, coherence: { score: 3, comment: '整体连贯' } },
  highlights: [], errors: [], uncertainIssues: [], improvements: [], suggestions: [],
  polishedParagraphs: ['One day he arrived. He was very kind.', 'Then she smiled. They went home.']
});
function score(r, n) {
  r.score = n; r.summary = '主要任务情况见维度评语。';
  let rest = n;
  for (const [key, max] of Object.entries({ plot: 10, language: 6, grammar: 5, coherence: 4 })) {
    r.dimensions[key].score = Math.min(max, rest); rest -= r.dimensions[key].score;
  }
}
function errorsFixture(n) {
  const s = sub(); s.essayText = Array.from({ length: n }, (_, i) => 'err' + i).join(' ') + '.';
  const r = result(); r.polishedParagraphs = [s.essayText];
  r.errors = Array.from({ length: n }, (_, i) => ({ original: 'err' + i, fix: 'fixed' + i, occurrences: [1], type: 'spelling', severity: 'minor', note: '测试独立拼写问题' }));
  return { s, r };
}
test('整体总分保留，档位派生，修改高亮只包含真实改变', () => {
  const raw = result(); raw.band = '第一档';
  const r = rubric.validateResult(raw, sub());
  assert.equal(r.score, 20); assert.equal(r.band, '第四档');
  assert.equal(r.errorCount, 0); assert.equal(r.rubricVersion, rubric.RUBRIC_VERSION);
  assert.equal(r.polished, 'One day he arrived. He was **very** kind.\n\nThen she smiled. They went home.');
  assert.equal(raw.polished, undefined);
});
test('和数不符要求修复，不用四维和覆盖总分', () => {
  const r = result(); r.dimensions.plot.score = 9;
  assert.throws(() => rubric.validateResult(r, sub()), /整体score=20，四维和=21/);
  assert.equal(r.score, 20); assert.equal(r.dimensions.plot.score, 9);
});
test('拒绝负分、超限、小数与非数值', () => {
  for (const bad of [-1, 26, 19.5, NaN, '20']) {
    const r = result(); r.score = bad; assert.throws(() => rubric.validateResult(r, sub()), /score须/);
  }
  for (const bad of [-1, 11, 8.5]) {
    const r = result(); r.dimensions.plot.score = bad;
    assert.throws(() => rubric.validateResult(r, sub()), /dimensions.plot.score/);
  }
});
test('10–11处允许20分，12–13处封顶19，14处封顶17；不会修改维度消化差额', () => {
  for (const n of [10, 11]) {
    const { s, r } = errorsFixture(n);
    assert.equal(rubric.validateResult(r, s).score, 20);
  }
  for (const [n, cap] of [[12, 19], [13, 19], [14, 17]]) {
    const { s, r } = errorsFixture(n);
    assert.throws(() => rubric.validateResult(r, s), new RegExp('总分≤' + cap));
    assert.equal(r.score, 20); assert.equal(r.dimensions.grammar.score, 4);
    score(r, cap); assert.equal(rubric.validateResult(r, s).score, cap);
  }
});
test('合理完整保底15；14处错误仍不能低于15', () => {
  const { s, r } = errorsFixture(14); score(r, 14);
  assert.throws(() => rubric.validateResult(r, s), /保底15/);
  score(r, 15); assert.equal(rubric.validateResult(r, s).score, 15);
  r.assessment.plotStatus = 'minor_flaws'; score(r, 14);
  assert.throws(() => rubric.validateResult(r, s), /保底15/);
});
test('实质偏离与严重偏离采用不同限制，轻微瑕疵允许20', () => {
  const r = result(); r.assessment.plotStatus = 'minor_flaws'; assert.equal(rubric.validateResult(r, sub()).score, 20);
  r.assessment.plotStatus = 'deviated'; assert.throws(() => rubric.validateResult(r, sub()), /≤15/);
  score(r, 15); assert.equal(rubric.validateResult(r, sub()).score, 15);
  r.assessment.plotStatus = 'severely_deviated'; assert.throws(() => rubric.validateResult(r, sub()), /≤10/);
});
test('重复订正和同一位置重复条目合并，独立位置均保留', () => {
  const s = sub(); s.essayText = 'He recieve it. She recieve it.';
  const r = result(); r.polishedParagraphs = ['He received it. She received it.'];
  const e = { original: 'recieve', fix: 'received', occurrences: [1], type: 'spelling', severity: 'minor', note: '拼写' };
  r.errors = [e, { ...e, occurrences: [1, 2] }];
  const actual = rubric.validateResult(r, s);
  assert.equal(actual.errorCount, 1); assert.equal(actual.errors[0].locations.length, 2);
});
test('不同长短引文与不同人名的同一实际订正合并，引用位置和原始依据可追溯', () => {
  const s = sub(); s.essayText = 'His grandpa’s hat. Wait, grandpa Lee. She said grandpa Chen.';
  const r = result(); r.polishedParagraphs = ['His grandpa’s hat. Wait, Grandpa Lee. She said Grandpa Chen.'];
  const error = (original, fix, occurrences = [1]) => ({ original, fix, occurrences, type: 'spelling', severity: 'minor', note: '称呼与名字连用的大写' });
  r.errors = [error('Wait, grandpa Lee', 'Wait, Grandpa Lee'), error('said grandpa Chen', 'said Grandpa Chen'), error('grandpa', 'Grandpa', [2])];
  const actual = rubric.validateResult(r, s);
  assert.equal(actual.errorCount, 1); assert.equal(actual.errors[0].original, 'grandpa'); assert.equal(actual.errors[0].fix, 'Grandpa');
  assert.deepEqual(actual.errors[0].occurrences, [2, 3]); assert.equal(actual.errors[0].sourceQuotes.length, 3);
  for (const loc of actual.errors[0].locations) assert.equal(s.essayText.slice(loc.start, loc.end), 'grandpa');
});
test('同一位置的整句和词引用计一次，词边界保护不把不同词的大写问题合并', () => {
  const s = sub(); s.essayText = 'Wait, grandpa Lee. We met grace.';
  const r = result(); r.polishedParagraphs = ['Wait, Grandpa Lee. We met Grace.'];
  r.errors = [['Wait, grandpa Lee', 'Wait, Grandpa Lee'], ['grandpa', 'Grandpa'], ['grace', 'Grace']].map(([original, fix]) => ({ original, fix, occurrences: [1], type: 'spelling', severity: 'minor', note: '大写' }));
  const actual = rubric.validateResult(r, s);
  assert.equal(actual.errorCount, 2); assert.deepEqual(actual.errors.map(e => e.original), ['grandpa', 'grace']);
});
test('补删冠词保留词锚点，不把不同名词的问题合并；空格订正保留完整词', () => {
  const s = sub(); s.essayText = 'I bought book. He found map. She liked alot of it.';
  const r = result(); r.polishedParagraphs = ['I bought a book. He found a map. She liked a lot of it.'];
  r.errors = [['I bought book', 'I bought a book'], ['He found map', 'He found a map'], ['alot', 'a lot']].map(([original, fix]) => ({ original, fix, occurrences: [1], type: 'grammar', severity: 'minor', note: '独立订正' }));
  const actual = rubric.validateResult(r, s);
  assert.equal(actual.errorCount, 3);
  assert.deepEqual(actual.errors.map(e => [e.original, e.fix]), [['book', 'a book'], ['map', 'a map'], ['alot', 'a lot']]);
  assert.deepEqual(rubric.correctionCore('in the school', 'in school'), { original: 'the school', fix: 'school', offset: 3 });
});
test('不同动词时态问题仍独立计数，不能按大类合并', () => {
  const s = sub(); s.essayText = 'Yesterday he go home and see her.';
  const r = result(); r.polishedParagraphs = ['Yesterday he went home and saw her.'];
  r.errors = [['he go home', 'he went home'], ['and see her', 'and saw her']].map(([original, fix]) => ({ original, fix, occurrences: [1], type: 'grammar', severity: 'minor', note: '过去时' }));
  assert.equal(rubric.validateResult(r, s).errorCount, 2);
});
test('包含多个问题的整句订正与各独立问题重复时要求模型拆分，不叠加计错', () => {
  const s = sub(); s.essayText = 'How could him slipped in?';
  const r = result(); r.polishedParagraphs = ['How could he slip in?'];
  r.errors = [['him', 'he'], ['How could him slipped in?', 'How could he slip in?']].map(([original, fix]) => ({ original, fix, occurrences: [1], type: 'grammar', severity: 'minor', note: '订正' }));
  assert.throws(() => rubric.validateResult(r, s), /最小独立问题/);
});
test('先按订正核心去重再执行12项封顶，不用重复长引文压分', () => {
  const { s, r } = errorsFixture(11);
  r.errors.push({ ...r.errors[10], original: 'err10.', fix: 'fixed10.' });
  assert.equal(rubric.validateResult(r, s).score, 20);
  assert.equal(rubric.validateResult(r, s).errorCount, 11);
});
test('模型声明的数量须与核心归并数一致，冲突要求同步复核而非程序抬分', () => {
  const { s, r } = errorsFixture(1);
  r.errors.push({ ...r.errors[0], original: 'err0.', fix: 'fixed0.' }); r.errorCount = 2;
  assert.throws(() => rubric.validateResult(r, s), /归并后为1项/);
  assert.equal(r.score, 20); r.errorCount = 1;
  assert.equal(rubric.validateResult(r, s).errorCount, 1);
});
test('him和slipped为两处独立错误，could不因划线计数', () => {
  const s = sub(); s.essayText = 'How could him slipped in?';
  const r = result(); r.polishedParagraphs = ['How could he slip in?'];
  r.errors = ['him', 'slipped'].map((original, i) => ({ original, fix: ['he', 'slip'][i], occurrences: [1], type: 'grammar', severity: 'minor', note: ['主语代词形式', '情态动词后用原形'][i] }));
  assert.equal(rubric.validateResult(r, s).errorCount, 2);
});
test('同一位置不同替代修法不能制造两条计分错误', () => {
  const { s, r } = errorsFixture(1);
  r.errors.push({ ...r.errors[0], fix: 'another-fix' });
  assert.throws(() => rubric.validateResult(r, s), /替代修法重复计错/);
});
test('引用须来自原稿、序号有效，原文等于订正不能计错', () => {
  const { s, r } = errorsFixture(1);
  r.errors[0].original = 'invented'; assert.throws(() => rubric.validateResult(r, s), /不存在/);
  r.errors[0].original = 'err0'; r.errors[0].occurrences = [2]; assert.throws(() => rubric.validateResult(r, s), /不存在/);
  r.errors[0].occurrences = [1]; r.errors[0].fix = 'err0'; assert.throws(() => rubric.validateResult(r, s), /相同/);
});
test('存疑和表达提升不计错、不触发封顶', () => {
  const s = sub(); s.essayText += ' [?]';
  const r = result(); r.polishedParagraphs[1] += ' [?]';
  r.uncertainIssues = [{ quote: '[?]', occurrence: 1, reason: '无法确认手写词', possibleFix: '' }];
  r.improvements = [{ quote: 'kind', occurrence: 1, alternative: 'thoughtful', benefit: '需要强调体贴时可采用' }];
  assert.equal(rubric.validateResult(r, s).errorCount, 0);
  r.errors = [{ original: '[?]', fix: 'word', occurrences: [1], type: 'spelling', severity: 'minor', note: '疑点' }];
  assert.throws(() => rubric.validateResult(r, s), /OCR疑点/);
});
test('同一确定错误不能同时列成存疑或原句可成立的建议', () => {
  const { s, r } = errorsFixture(1);
  r.uncertainIssues = [{ quote: 'err0', occurrence: 1, reason: '存疑', possibleFix: '' }];
  assert.throws(() => rubric.validateResult(r, s), /明确分类/);
  r.uncertainIssues = []; r.improvements = [{ quote: 'err0', occurrence: 1, alternative: 'better', benefit: '建议' }];
  assert.throws(() => rubric.validateResult(r, s), /含已确认错误/);
});
test('省略OCR标记的子串也不能计错或认证语言亮点，其他已知词仍可订正', () => {
  const s = sub(); s.essayText = 'He recieve an unknownword[?].';
  const r = result(); r.polishedParagraphs = ['He received an unknownword[?].'];
  r.errors = [{ original: 'unknownword', fix: 'word', occurrences: [1], type: 'spelling', severity: 'minor', note: '猜测拼写' }];
  assert.throws(() => rubric.validateResult(r, s), /OCR疑点/);
  r.errors[0] = { ...r.errors[0], original: 'recieve', fix: 'received', note: '已知拼写错误' };
  assert.equal(rubric.validateResult(r, s).errorCount, 1);
  r.highlights = [{ quote: 'unknownword', occurrence: 1, kind: 'language', note: '未核实词' }];
  assert.throws(() => rubric.validateResult(r, s), /识别疑点/);
});
test('润色不得猜词、去除OCR标记、减少疑点次数或把疑点移至另一段', () => {
  const s = sub(); s.essayText = 'One day he arrived. He saw vagueword[?] and vagueword[?].\n\nThen she smiled. They went home.';
  const r = result();
  for (const bad of ['He saw a light.', 'He saw vagueword and vagueword.', 'He saw vagueword[?].', 'He saw otherword[?] and otherword[?].']) {
    r.polishedParagraphs[0] = 'One day he arrived. ' + bad;
    assert.throws(() => rubric.validateResult(r, s), /保留未核实/);
  }
  r.polishedParagraphs[0] = 'One day he arrived. He saw vagueword[?] and vagueword[?].';
  assert.equal(rubric.validateResult(r, s).score, 20);
  r.polishedParagraphs[0] = 'One day he arrived. He saw something.';
  r.polishedParagraphs[1] += ' vagueword[?] and vagueword[?].';
  assert.throws(() => rubric.validateResult(r, s), /保留未核实/);
});
test('引语标点订正必须包含待替换句号，避免保留句号后再添逗号', () => {
  const s = sub(); s.essayText = '“Hello.” said the teacher.';
  const r = result(); r.polishedParagraphs = ['“Hello,” said the teacher.'];
  r.errors = [{ original: '” said', fix: ', ” said', occurrences: [1], type: 'grammar', severity: 'minor', note: '引语与叙述标点' }];
  assert.throws(() => rubric.validateResult(r, s), /新增逗号/);
  r.errors[0].original = '.” said'; r.errors[0].fix = ',” said';
  assert.equal(rubric.validateResult(r, s).errorCount, 1);
});
test('语言亮点错误重叠不能被无错误字样绕过；独立正确片段仍保留', () => {
  const { s, r } = errorsFixture(1); s.essayText += ' a warm smile'; r.polishedParagraphs = [s.essayText];
  r.highlights = [{ quote: 'err0', occurrence: 1, kind: 'language', note: '无语法错误' }];
  assert.throws(() => rubric.validateResult(r, s), /包含确定错误/);
  r.highlights[0].quote = 'a warm smile'; assert.equal(rubric.validateResult(r, s).highlights.length, 1);
  r.highlights[0].quote = 'err0'; r.highlights[0].kind = 'plot';
  r.highlights[0].note = '设计意图成立，具体语言问题另列'; assert.equal(rubric.validateResult(r, s).highlightDetails[0].kind, 'plot');
});
test('润色必须保留段落及给定开头，不接收模型任意加粗', () => {
  const r = result(); r.polishedParagraphs[0] = 'One day he came. He was kind.';
  assert.throws(() => rubric.validateResult(r, sub()), /逐字保留/);
  r.polishedParagraphs = ['One day he arrived. **He** was kind.', 'Then she smiled. They went home.'];
  assert.throws(() => rubric.validateResult(r, sub()), /纯文本/);
  r.polishedParagraphs = ['One day he arrived. Then she smiled.'];
  assert.throws(() => rubric.validateResult(r, sub()), /段落数量/);
});
test('总评档位冲突必须修复，22不是硬上限', () => {
  const r = result(); r.summary = '第五档，表现优秀'; assert.throws(() => rubric.validateResult(r, sub()), /summary/);
  score(r, 23); assert.equal(rubric.validateResult(r, sub()).score, 23);
});
test('结构化输入保留题目要求，文字稿不携带卷面推断', () => {
  const prompt = grader.buildUserPrompt(sub()); const input = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.equal(input.starter1, 'One day he arrived.'); assert.equal(input.starter2, 'Then she smiled.');
  assert.match(input.originalText, /150词左右/); assert.equal(input.handwritingAvailable, false);
  assert.equal(input.essayParagraphs.length, 2);
});
test('修改对比保留全文及空白，不高亮未改内容', () => {
  for (const [before, after] of [['Hello world.', 'Hello world!'], ['He is kind.', 'He was very kind.'], ['a b c', 'a c'], ['A red hat.', 'A red hat.']]) {
    const marked = rubric.markChanges(before, after);
    assert.equal(marked.replace(/\*\*/g, ''), after);
    if (before === after) assert.equal(marked, after);
  }
});
const reply = value => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: typeof value === 'string' ? value : JSON.stringify(value), reasoning_content: 'ignored' } }] }), { status: 200 });
test('成立的倒装可保留为语言亮点，同时允许不计错的表达建议', () => {
  const s = sub();
  s.essayText = 'Spreading through the hall was a sense of relief.';
  const r = result(); r.polishedParagraphs = [s.essayText];
  r.highlights = [{ quote: s.essayText, occurrence: 1, kind: 'language', note: '前置突出变化，主语后置，收束情绪。' }];
  r.improvements = [{ quote: 'a sense of relief', occurrence: 1, alternative: 'a welcome sense of relief', benefit: '加强众人期待已久的情绪，原表达成立。' }];
  const actual = rubric.validateResult(r, s);
  assert.equal(actual.errorCount, 0); assert.equal(actual.score, 20);
  assert.equal(actual.highlightDetails.length, 1); assert.equal(actual.improvements.length, 1);
});
test('11项确定错误加称呼和隐喻建议仍为11项，不触发12项封顶', () => {
  const { s, r } = errorsFixture(11);
  s.essayText += ' Thank you, young fellow. Kindness wrapped them in warmth.';
  r.polishedParagraphs = [s.essayText]; r.errorCount = 11;
  r.improvements = [
    { quote: 'young fellow', occurrence: 1, alternative: 'young man', benefit: '在这段对话中使称呼更中性，原称呼成立。' },
    { quote: 'wrapped them in warmth', occurrence: 1, alternative: 'lit up their evening', benefit: '提供光照意象以呼应夜景，原隐喻成立。' }
  ];
  const actual = rubric.validateResult(r, s);
  assert.equal(actual.errorCount, 11); assert.equal(actual.improvements.length, 2);
  assert.equal(actual.score, 20); assert.deepEqual(actual.dimensions, r.dimensions);
});
async function mocked(replies, run) {
  const originalFetch = global.fetch; const requests = [];
  global.fetch = async (url, opts) => {
    assert.equal(opts.headers.Authorization, 'Bearer unit-test-no-real-key');
    const body = JSON.parse(opts.body); requests.push(structuredClone(body));
    assert.equal(body.model, 'deepseek-flash'); assert.equal(body.thinking.type, 'enabled');
    assert.equal(body.response_format.type, 'json_object');
    const next = replies.shift(); if (next instanceof Error) throw next;
    assert.ok(next, 'Unexpected extra request'); return next;
  };
  try { await run(requests); } finally { global.fetch = originalFetch; }
}
test('评分冲突携带原响应和具体原因请求修复，保持High', async () => {
  const bad = result(); bad.dimensions.plot.score++;
  await mocked([reply(bad), reply(result())], async requests => {
    const r = await grader.gradeSubmission(sub()); assert.equal(r.score, 20);
    assert.equal(requests.length, 2); assert.equal(requests[0].reasoning_effort, 'high');
    assert.equal(requests[1].reasoning_effort, 'high');
    assert.equal(requests[0].top_p, 0.95); assert.equal(requests[1].top_p, 0.95);
    assert.equal('temperature' in requests[0], false);
    assert.equal(requests[1].messages.at(-2).role, 'assistant');
    assert.match(requests[1].messages.at(-1).content, /四维和=21/);
  });
});
test('网络失败重试原请求，不谎称JSON格式错误', async () => {
  await mocked([new TypeError('fetch failed'), reply(result())], async requests => {
    await grader.gradeSubmission(sub()); assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].messages, requests[1].messages);
  });
});

test('同一文稿仍独立调用AI，不复用旧分数、不按教师样本固定为20', async () => {
  const first = result(); first.score = 19; first.dimensions.grammar.score = 3;
  const second = result(); second.score = 21; second.dimensions.plot.score = 9; second.summary = '第五档，全文任务完成充分。';
  await mocked([reply(first), reply(second)], async requests => {
    assert.equal((await grader.gradeSubmission(sub())).score, 19);
    assert.equal((await grader.gradeSubmission(sub())).score, 21);
    assert.equal(requests.length, 2); assert.deepEqual(requests[0], requests[1]);
  });
});
test('无效JSON修复；重复失败最多3次；余额错误不重复调用', async () => {
  await mocked([reply('invalid'), reply(result())], async requests => { await grader.gradeSubmission(sub()); assert.equal(requests.length, 2); });
  await mocked([reply({}), reply({}), reply({})], async requests => { await assert.rejects(grader.gradeSubmission(sub()), /一致性校验/); assert.equal(requests.length, 3); });
  await mocked([new Response('{}', { status: 402 })], async requests => { await assert.rejects(grader.gradeSubmission(sub()), /余额不足/); assert.equal(requests.length, 1); });
});
test('OCR保留中文要求、关键词、原始错误和识别疑点，并保持Low', async () => {
  const image = path.join(process.env.EG_DATA_DIR, 'input.png'); fs.writeFileSync(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  const value = { originalText: 'Story', starter1: 'First.', starter2: 'Next.', para1: 'nervos [?]', para2: 'End.', taskRequirements: '150词左右，使用5个以上划线关键词', keywords: ['hat', 'hat', 'wave'] };
  await mocked([reply(value)], async requests => {
    const r = await grader.recognizeImages([image]);
    assert.equal(r.para1, value.para1); assert.equal(r.taskRequirements, value.taskRequirements);
    assert.deepEqual(r.keywords, ['hat', 'wave']); assert.equal(requests[0].reasoning_effort, 'low');
    assert.equal('top_p' in requests[0], false);
    assert.match(requests[0].messages[0].content[1].image_url.url, /^data:image\/png;base64,/);
  });
});
test('OCR缺字段和空识别结果不能伪装成成功', () => {
  assert.throws(() => grader.validateOcr({}), /须为字符串/);
  assert.throws(() => grader.validateOcr({ originalText: '', starter1: '', starter2: '', para1: '', para2: '', taskRequirements: '', keywords: [] }), /未识别到/);
});

test('修改设置不会改变已经开始的批改或修复重试', async () => {
 const oldConfig=settings.getAIConfig,oldFetch=global.fetch;let current={...require('../providers').normalizeConfig({provider:'deepseek'}),apiKey:'unit-test-first-key'};const seen=[];
 settings.getAIConfig=()=>({...current});global.fetch=async(url,opts)=>{seen.push({model:JSON.parse(opts.body).model,key:opts.headers.Authorization});if(seen.length===1){current={...current,model:'deepseek-pro',apiKey:'unit-test-second-key'};return reply('invalid');}return reply(result());};
 try{assert.equal((await grader.gradeSubmission(sub())).model,'deepseek-flash');assert.deepEqual(seen,[{model:'deepseek-flash',key:'Bearer unit-test-first-key'},{model:'deepseek-flash',key:'Bearer unit-test-first-key'}]);}finally{settings.getAIConfig=oldConfig;global.fetch=oldFetch;}
});
