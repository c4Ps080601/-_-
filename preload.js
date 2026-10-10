'use strict';
/* preload.js — 通过 contextBridge 暴露桌面能力（导出 PDF 另存为）给渲染进程 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  exportPdf: (id) => ipcRenderer.invoke('export-pdf', { id }),
  saveLongImage: (id, dataUrl) => ipcRenderer.invoke('save-long-image', { id, dataUrl }),
  logError: (message) => ipcRenderer.invoke('log-error', { message })
});
