'use strict';
/**
 * pdf-export.js — 把一篇作文的完整批改结果导出为 PDF（纯本地生成，不依赖网络）
 * 视觉与「续写批改站」网页端一致：渐变分数卡、四维进度条、分区卡片、紫色润色高亮、页码页脚。
 * 使用 pdfkit + 系统中文字体（SimHei / 微软雅黑 / 宋体）。
 */
const fs = require('fs');
const PDFDocument = require('pdfkit');
const store = require('./store');
const { bandFromScore } = require('./rubric');

const FONT_CANDIDATES = [
  { path: 'C:/Windows/Fonts/simhei.ttf' },
  { path: 'C:/Windows/Fonts/msyh.ttc', family: 'Microsoft YaHei' },
  { path: 'C:/Windows/Fonts/simsun.ttc', family: 'SimSun' },
  { path: 'C:/Windows/Fonts/msyh.ttf' },
  /* macOS 中文字体 */
  { path: '/System/Library/Fonts/PingFang.ttc', family: 'PingFang SC' },
  { path: '/System/Library/Fonts/Supplemental/Songti.ttc', family: 'Songti SC' },
  { path: '/System/Library/Fonts/STHeiti Light.ttc', family: 'STHeiti Light' },
  { path: '/System/Library/Fonts/Hiragino Sans GB.ttc', family: 'Hiragino Sans GB' },
  { path: '/System/Library/Fonts/Supplemental/Arial Unicode.ttf' }
];

/* 与网页端一致的配色 */
const INK = '#1f2437';
const MUTED = '#6b7280';
const FAINT = '#9aa0b5';
const PRIMARY = '#4f46e5';
const PRIMARY_END = '#7c3aed';
const PURPLE = '#4338ca';
const OK = '#0f766e';
const BAD = '#b91c1c';
const CARD_BG = '#f1f3f9';
const HL_BG = '#fffbeb';
const ERR_BG = '#fef2f2';
const LINE = '#e2e5f4';

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M_L = 48;
const M_R = 48;
const M_T = 46;
const M_B = 44;
const CW = PAGE_W - M_L - M_R;   // 内容宽 499.28

function resolveFont() {
  for (const c of FONT_CANDIDATES) {
    try { if (fs.existsSync(c.path)) return c; } catch (e) { /* 下一个 */ }
  }
  return null;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* 剩余可用高度 */
function avail(doc) {
  return PAGE_H - M_B - doc.y;
}

function ensure(doc, h) {
  if (avail(doc) < h) {
    doc.addPage();
    doc.y = M_T;
  }
}

/* 把 **...** 渲染成紫色（其余正文深色） */
function richText(doc, text, opts = {}) {
  const size = opts.size || 10.5;
  const color = opts.color || INK;
  const width = opts.width || CW;
  const paragraphs = String(text || '').split(/\n\s*\n/).filter(p => p.trim());
  for (const paragraph of paragraphs) {
    const parts = paragraph.split(/\*\*([^*]+)\*\*/g)
      .map((part, i) => ({ part, changed: i % 2 === 1 })).filter(p => p.part);
    doc.x = M_L;
    parts.forEach(({ part, changed }, i) => {
      doc.fontSize(size).fillColor(changed ? PURPLE : color);
      doc.text(part, { continued: i < parts.length - 1, width, indent: size * 2, lineGap: 2 });
    });
    doc.moveDown(0.45);
  }
}

/* 分区标题：左侧色块 + 标题 + 分隔线 */
function sectionTitle(doc, text) {
  ensure(doc, 132);
  doc.moveDown(1.0);
  const y = doc.y;
  doc.roundedRect(M_L, y + 1, 4, 13, 2).fill(PRIMARY);
  doc.x = M_L + 12;
  doc.fontSize(13).fillColor(INK).text(text, { lineBreak: true });
  doc.moveDown(0.15);
  doc.moveTo(M_L, doc.y).lineTo(PAGE_W - M_R, doc.y)
    .strokeColor(LINE).lineWidth(0.8).stroke();
  doc.moveDown(0.35);
}

/* 渐变分数卡 */
function scorePanel(doc, sub, r, finalScore) {
  const summary = r.summary || '';
  const pad = 16;
  const scoreW = 118;
  const textW = CW - scoreW - pad * 2;
  doc.fontSize(10.5);
  const summaryH = doc.heightOfString(summary, { width: textW });
  const panelH = Math.max(86, pad * 2 + summaryH + 30);
  ensure(doc, panelH + 12);
  const y = doc.y;
  const grad = doc.linearGradient(M_L, y, M_L + CW, y + panelH);
  grad.stop(0, PRIMARY);
  grad.stop(1, PRIMARY_END);
  doc.roundedRect(M_L, y, CW, panelH, 12).fill(grad);
  /* 大分数 */
  doc.fontSize(38).fillColor('#ffffff')
    .text(String(finalScore), M_L + pad, y + pad, { width: scoreW, align: 'left' });
  doc.opacity(0.85);
  doc.fontSize(12).fillColor('#ffffff')
    .text('/ 25', M_L + pad + 62, y + pad + 24, { width: 70 });
  /* 右侧：档位 + 总评 */
  doc.fontSize(11).fillColor('#ffffff')
    .text('档位：' + bandFromScore(finalScore), M_L + scoreW + pad - 8, y + pad);
  doc.opacity(0.92);
  doc.fontSize(10).fillColor('#ffffff')
    .text('总评：' + summary, M_L + scoreW + pad - 8, y + pad + 20, { width: textW });
  if (sub.teacherScore != null) {
    doc.opacity(0.85);
    doc.fontSize(9.5).fillColor('#ffffff')
      .text('（教师终评覆盖 AI 分数）', M_L + scoreW + pad - 8, y + panelH - 22, { width: textW });
  }
  doc.opacity(1);
  doc.y = y + panelH + 14;
}

/* 四维明细：2x2 卡片 + 进度条 */
function dimGrid(doc, r) {
  sectionTitle(doc, '四维明细（解释AI整体评分）');
  const defs = [
    ['情节与衔接', 'plot', 10],
    ['语言表达', 'language', 6],
    ['语法准确', 'grammar', 5],
    ['篇章连贯', 'coherence', 4]
  ];
  const gap = 10;
  const cardW = (CW - gap) / 2;
  const pad = 12;
  const innerW = cardW - pad * 2;
  for (let row = 0; row < 2; row++) {
    const items = defs.slice(row * 2, row * 2 + 2);
    const cards = items.map(([name, key, max]) => {
      const d = (r.dimensions && r.dimensions[key]) || {};
      const comment = d.comment || '';
      doc.fontSize(9.5);
      const h = doc.heightOfString(comment, { width: innerW });
      return { name, key, max, d, comment, h: pad + 40 + 11 + h + pad };
    });
    const rowH = Math.max(...cards.map(c => c.h)) + 4;
    ensure(doc, rowH);
    const y0 = doc.y;
    cards.forEach((c, i) => {
      const x = M_L + i * (cardW + gap);
      const h = rowH - 4;
      doc.roundedRect(x, y0, cardW, h, 10).fill(CARD_BG);
      const cx = x + pad;
      doc.fontSize(10).fillColor(MUTED).text(c.name, cx, y0 + pad, { width: innerW });
      const scoreY = y0 + pad + 16;
      doc.fontSize(17).fillColor(INK)
        .text(String(c.d.score != null ? c.d.score : '—'), cx, scoreY - 3, { width: innerW, lineBreak: false });
      doc.fontSize(10).fillColor(MUTED)
        .text('/ ' + c.max, cx + 34, scoreY + 3, { lineBreak: true });
      /* 进度条 */
      const barY = y0 + pad + 40;
      const pct = Math.max(0, Math.min(1, (c.d.score || 0) / c.max));
      doc.roundedRect(cx, barY, innerW, 5, 3).fill('#e4e7f5');
      if (pct > 0) doc.roundedRect(cx, barY, Math.max(6, innerW * pct), 5, 3).fill(PRIMARY);
      doc.fontSize(9).fillColor(MUTED).text(c.comment, cx, barY + 11, { width: innerW });
    });
    doc.y = y0 + rowH;
  }
}

/* 浅灰正文块 */
function essayBox(doc, text) {
  const pad = 10;
  doc.fontSize(10.5);
  const h = doc.heightOfString(String(text || ''), { width: CW - pad * 2 }) + pad * 2;
  ensure(doc, Math.min(h, PAGE_H - M_T - M_B));
  const y = doc.y;
  doc.roundedRect(M_L, y, CW, h, 8).fill(CARD_BG);
  doc.fontSize(10.5).fillColor(INK)
    .text(String(text || ''), M_L + pad, y + pad, { width: CW - pad * 2 });
  doc.y = y + h + 10;
}

/* 列表项卡片：amber 亮点 / red 错误 */
function itemCard(doc, text, opts = {}) {
  const bg = opts.bg || HL_BG;
  const pad = 10;
  doc.fontSize(opts.size || 10);
  const h = doc.heightOfString(String(text || ''), { width: CW - pad * 2 - 8 }) + pad * 2;
  ensure(doc, h);
  const y = doc.y;
  doc.roundedRect(M_L, y, CW, h, 7).fill(bg);
  doc.rect(M_L, y + 2, 3, h - 4).fill(opts.accent || '#d97706');
  doc.fontSize(opts.size || 10).fillColor(opts.color || INK)
    .text(String(text || ''), M_L + pad + 4, y + pad, { width: CW - pad * 2 - 8 });
  doc.y = y + h + 5;
}

function generateSubmissionPdf(sub) {
  if (!sub || sub.status !== 'done' || !sub.result) {
    return Promise.reject(new Error('作文尚未批改完成，无法导出 PDF'));
  }
  const font = resolveFont();
  if (!font) return Promise.reject(new Error('未找到可用的中文字体，无法导出 PDF'));

  const r = sub.result;
  const owner = store.findUserById(sub.userId);
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  if (font.family) doc.font(font.path, font.family);
  else doc.font(font.path);

  const chunks = [];
  const done = new Promise((resolve, reject) => {
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  doc.y = M_T;

  /* 页眉 */
  doc.fontSize(19).fillColor(PRIMARY)
    .text('续写批改站 · 批改结果', M_L, M_T, { width: CW, align: 'center' });
  doc.moveDown(0.7);
  doc.moveTo(M_L, doc.y).lineTo(PAGE_W - M_R, doc.y)
    .strokeColor(LINE).lineWidth(1).stroke();
  doc.moveDown(0.4);

  /* 标题与元信息 */
  doc.fontSize(15).fillColor(INK).text(sub.title || '未命名作文', M_L, doc.y, { width: CW });
  doc.moveDown(0.15);
  doc.fontSize(9).fillColor(MUTED)
    .text(`${owner ? owner.name : '未知作者'} · ${fmtDate(sub.createdAt)} · ${sub.wordCount} 词`,
      M_L, doc.y, { width: CW });
  doc.moveDown(0.5);

  /* 分数总览 */
  const finalScore = sub.teacherScore != null ? sub.teacherScore : r.score;
  scorePanel(doc, sub, r, finalScore);

  /* 四维明细 */
  dimGrid(doc, r);

  /* 学生作文 */
  sectionTitle(doc, '学生作文（原文 + 段首句）');
  essayBox(doc, sub.originalText || '（未提供）');
  sectionTitle(doc, '学生续写');
  essayBox(doc, sub.essayText || '');

  /* 语言亮点 */
  sectionTitle(doc, '表达与情节亮点');
  if (r.highlights && r.highlights.length) {
    for (const h of r.highlights) itemCard(doc, h, { bg: HL_BG, accent: '#d97706', color: INK });
  } else {
    doc.fontSize(10.5).fillColor(MUTED).text('无明显亮点', M_L, doc.y, { width: CW });
    doc.moveDown(0.3);
  }

  /* 错误订正 */
  sectionTitle(doc, `确定错误（计分 ${r.errorCount != null ? r.errorCount : (r.errors || []).length} 处）`);
  if (r.errors && r.errors.length) {
    for (const e of r.errors) {
      const head = (e.original || '') + '  [' + (e.type || '其他') + ']';
      const fix = '→ ' + (e.fix || '');
      const context = e.sourceQuotes && e.sourceQuotes[0] && e.sourceQuotes[0].original !== e.original ? '原句示例：' + e.sourceQuotes[0].original + '\n' : '';
      const note = context + (e.note || '') + (e.locations && e.locations.length > 1 ? `（同一问题出现${e.locations.length}次，合并计1处。）` : '');
      const pad = 9;
      doc.fontSize(10);
      let h = doc.heightOfString(head, { width: CW - pad * 2 - 8 })
        + doc.heightOfString(fix, { width: CW - pad * 2 - 8 });
      if (note) h += doc.heightOfString(note, { width: CW - pad * 2 - 8 });
      h += pad * 2 + 4;
      ensure(doc, h);
      const y = doc.y;
      doc.roundedRect(M_L, y, CW, h, 7).fill(ERR_BG);
      doc.rect(M_L, y + 2, 3, h - 4).fill(BAD);
      const tx = M_L + pad + 4;
      const tw = CW - pad * 2 - 8;
      let ty = y + pad;
      doc.fontSize(10).fillColor(BAD).text(head, tx, ty, { width: tw });
      ty += doc.heightOfString(head, { width: tw }) + 2;
      doc.fontSize(10).fillColor(OK).text(fix, tx, ty, { width: tw });
      ty += doc.heightOfString(fix, { width: tw }) + 2;
      if (note) {
        doc.fontSize(9).fillColor(MUTED).text(note, tx, ty, { width: tw });
        ty += doc.heightOfString(note, { width: tw }) + 2;
      }
      doc.y = y + h + 5;
    }
  } else {
    doc.fontSize(10.5).fillColor(MUTED).text('未列出确定错误', M_L, doc.y, { width: CW });
    doc.moveDown(0.3);
  }

  if ((r.assessment && r.assessment.taskNotes || []).length) {
    sectionTitle(doc, '题目与输入核对');
    for (const note of r.assessment.taskNotes) itemCard(doc, note, { bg: CARD_BG, accent: MUTED });
  }
  if ((r.uncertainIssues || []).length) {
    sectionTitle(doc, '待核实问题（不计入自动扣分与封顶）');
    for (const q of r.uncertainIssues) itemCard(doc, q.quote + '\n' + q.reason + (q.possibleFix ? '\n核实后可考虑：' + q.possibleFix : ''), { bg: CARD_BG, accent: MUTED });
  }
  if ((r.improvements || []).length) {
    sectionTitle(doc, '表达优化（原句可成立，不计错）');
    for (const q of r.improvements) itemCard(doc, q.quote + '\n→ ' + q.alternative + '\n' + q.benefit, { bg: CARD_BG, accent: OK });
  }

  /* 改进建议 */
  sectionTitle(doc, '改进建议');
  if (r.suggestions && r.suggestions.length) {
    for (const sg of r.suggestions) {
      doc.fontSize(10).fillColor(INK)
        .text(sg, M_L, doc.y, { width: CW - 14 });
      doc.moveDown(0.22);
    }
  }

  /* 润色版 */
  sectionTitle(doc, '润色版（紫色为修改处）');
  richText(doc, r.polished || '', { size: 10.5 });

  /* 教师终评 */
  if (sub.teacherScore != null || sub.teacherNote) {
    sectionTitle(doc, '教师终评');
    if (sub.teacherScore != null) {
      doc.fontSize(11).fillColor(PRIMARY)
        .text('教师打分：' + sub.teacherScore + ' / 25', M_L, doc.y, { width: CW });
      doc.moveDown(0.2);
    }
    if (sub.teacherNote) {
      doc.fontSize(10.5).fillColor(INK).text(sub.teacherNote, M_L, doc.y, { width: CW });
      doc.moveDown(0.2);
    }
  }

  /* 页脚：页码 */
  const range = doc.bufferedPageRange();
  const total = range.count;
  for (let i = range.start; i < range.start + total; i++) {
    doc.switchToPage(i);
    doc.fontSize(8).fillColor(FAINT).text(
      `续写批改站 · 批改结果导出 · 第 ${i + 1} / ${total} 页`,
      M_L,
      PAGE_H - 30,
      { width: CW, align: 'center' }
    );
  }

  doc.end();
  return done;
}

module.exports = { generateSubmissionPdf };
