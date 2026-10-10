'use strict';
/**
 * main.js — Electron 主进程
 * 启动 Express 服务（127.0.0.1:3210），然后打开桌面窗口加载本机前端。
 */
const { app, BrowserWindow, ipcMain, dialog, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let server = null;
let serverStarted = false;
let activePort = null;

/* 兜底：任何未捕获异常写入 userData/error.log 并弹窗提示，避免"无窗口静默失败" */
function installErrorGuard() {
  process.on('uncaughtException', (err) => {
    try {
      const logFile = path.join(app.getPath('userData'), 'error.log');
      fs.appendFileSync(logFile,
        `\n[${new Date().toISOString()}] uncaughtException\n` +
        ((err && err.stack) || String(err)) + '\n');
      console.error('[essay-grader] uncaughtException:', err);
      const { dialog } = require('electron');
      dialog.showErrorBox('续写批改站出错了',
        '程序遇到错误，详情已写入：\n' + logFile + '\n\n' + ((err && err.message) || String(err)));
    } catch (e) { /* 尽量兜底 */ }
  });
  process.on('unhandledRejection', (reason) => {
    try {
      const logFile = path.join(app.getPath('userData'), 'error.log');
      fs.appendFileSync(logFile,
        `\n[${new Date().toISOString()}] unhandledRejection\n` + String(reason) + '\n');
    } catch (e) { /* 忽略 */ }
  });
}

function setupRuntime() {
  // 数据存放于 userData，不写安装目录
  let userData = app.getPath('userData');
  // 测试/多实例时可覆盖 userData 位置
  if (process.env.EG_USER_DATA_DIR) {
    userData = process.env.EG_USER_DATA_DIR;
    try { app.setPath('userData', userData); } catch (e) { /* 忽略 */ }
  }
  process.env.EG_DATA_DIR = path.join(userData, 'data');
  const settings = require('./settings');
  settings.init(path.join(userData, 'settings.json'));
  settings.initEncryption(safeStorage);
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 1000,
    minHeight: 700,
    title: '续写批改站公开版',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    backgroundColor: require('./settings').getTheme() === 'dark' ? '#191918' : '#f5f3ed',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  mainWindow.loadURL('http://127.0.0.1:' + port);
  if (mainWindow.webContents) {
    mainWindow.webContents.on('did-fail-load', (e, code, desc) => {
      try {
        const logFile = path.join(app.getPath('userData'), 'error.log');
        fs.appendFileSync(logFile,
          `\n[${new Date().toISOString()}] did-fail-load ${code} ${desc}\n`);
      } catch (err) { /* 忽略 */ }
    });
  }
  mainWindow.on('closed', () => { mainWindow = null; });
}

function startBackend() {
  if (serverStarted) return;
  serverStarted = true;
  const config = require('./settings').getConfig();
  const basePort = parseInt(config.port || '3210', 10);
  const { startServer } = require('./server');
  const tryListen = (port) => {
    activePort = port;
    server = startServer({ port, host: '127.0.0.1' }, () => createWindow(port));
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && port < basePort + 20) {
        console.log(`[essay-grader] 端口 ${port} 已被占用，改用端口 ${port + 1}`);
        tryListen(port + 1);
      } else {
        console.error('[essay-grader] 本地服务启动失败:', err && err.message);
      }
    });
  };
  tryListen(basePort);
}

/* 导出批改结果 PDF：生成后弹出系统「另存为」对话框 */
ipcMain.handle('export-pdf', async (event, { id } = {}) => {
  try {
    const store = require('./store');
    const pdfExport = require('./pdf-export');
    const sub = store.getSubmission(String(id || ''));
    if (!sub) return { ok: false, error: '作文不存在' };
    if (sub.status !== 'done' || !sub.result) {
      return { ok: false, error: '作文尚未批改完成，无法导出' };
    }
    const buf = await pdfExport.generateSubmissionPdf(sub);
    const safe = String(sub.title || '批改结果').replace(/[\\/:*?"<>|]/g, '_');
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const filePath = dialog.showSaveDialogSync(win, {
      title: '导出批改结果',
      defaultPath: safe + '.pdf',
      filters: [{ name: 'PDF 文件', extensions: ['pdf'] }]
    });
    if (!filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, buf);
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: '导出失败：' + ((e && e.message) || e) };
  }
});

/* 保存渲染进程生成的长图（base64）到用户选择的路径 */
ipcMain.handle('save-long-image', async (event, { id, dataUrl } = {}) => {
  try {
    const store = require('./store');
    const sub = store.getSubmission(String(id || ''));
    const m = String(dataUrl || '').match(/^data:image\/(png|jpeg);base64,(.+)$/);
    if (!m) return { ok: false, error: '图片数据无效' };
    const buf = Buffer.from(m[2], 'base64');
    const safe = String(sub ? sub.title : '批改结果').replace(/[\\/:*?"<>|]/g, '_');
    const win = BrowserWindow.fromWebContents(event.sender) || mainWindow;
    const filePath = dialog.showSaveDialogSync(win, {
      title: '导出长图',
      defaultPath: safe + '-长图.png',
      filters: [{ name: 'PNG 图片', extensions: ['png'] }]
    });
    if (!filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, buf);
    return { ok: true, path: filePath };
  } catch (e) {
    return { ok: false, error: '导出长图失败：' + ((e && e.message) || e) };
  }
});

/* 渲染进程错误日志（诊断导出等偶发问题用） */
ipcMain.handle('log-error', (event, { message } = {}) => {
  try {
    const logFile = path.join(app.getPath('userData'), 'error.log');
    fs.appendFileSync(logFile,
      `\n[${new Date().toISOString()}] [renderer] ${String(message || '')}\n`);
  } catch (e) { /* 忽略 */ }
  return { ok: true };
});

// 公开版固定使用独立数据目录，不导入自用版密钥或作文。
if (!process.env.EG_USER_DATA_DIR) app.setPath('userData', path.join(app.getPath('appData'), 'essay-grader-public'));

// 隔离数据目录必须在获取单实例锁之前生效，否则测试实例会误聚焦现有软件。
if (process.env.EG_USER_DATA_DIR) {
  fs.mkdirSync(process.env.EG_USER_DATA_DIR, { recursive: true });
  app.setPath('userData', process.env.EG_USER_DATA_DIR);
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    installErrorGuard();
    setupRuntime();
    startBackend();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('before-quit', () => {
    if (server) {
      try { server.close(); } catch (e) { /* ignore */ }
    }
  });
}
