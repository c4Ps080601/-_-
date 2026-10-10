'use strict';
/**
 * afterPack — 打包完成后给主程序 exe 注入图标与版本信息。
 * 使用 rcedit（来自 electron-builder 的 winCodeSign 缓存），找不到时阻止构建，避免交付默认图标。
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

function findRcedit() {
  const candidates = [];
  const roots = [];
  if (process.env.ELECTRON_BUILDER_CACHE) roots.push(process.env.ELECTRON_BUILDER_CACHE);
  roots.push(path.join(__dirname, '..', 'work', 'electron-builder-cache'));
  roots.push(path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'electron-builder', 'Cache'));
  for (const root of roots) {
    const dir = path.join(root, 'winCodeSign');
    if (!fs.existsSync(dir)) continue;
    for (const sub of fs.readdirSync(dir)) {
      const p = path.join(dir, sub, 'rcedit-ia32.exe');
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
  const pkg = path.join(__dirname, '..', 'node_modules', 'rcedit', 'bin', process.arch === 'x64' ? 'rcedit-x64.exe' : 'rcedit-ia32.exe');
  if (fs.existsSync(pkg)) candidates.push(pkg);
  return candidates[0] || null;
}

exports.default = async function afterPack(context) {
  try {
    const exe = path.join(context.appOutDir, context.packager.appInfo.productFilename + '.exe');
    const icon = path.join(context.packager.projectDir, 'build', 'icon.ico');
    const rcedit = findRcedit();
    if (!rcedit) {
      throw new Error('rcedit不可用，无法验证原图标');
    }
    if (!fs.existsSync(exe) || !fs.existsSync(icon)) {
      console.log('[after-pack] exe 或 icon 不存在，跳过');
      return;
    }
    const args = [
      exe,
      '--set-icon', icon,
      '--set-version-string', 'ProductName', '续写批改站',
      '--set-version-string', 'FileDescription', '续写批改站 - 读后续写批改',
      '--set-version-string', 'CompanyName', 'Essay Grader',
      '--set-product-version', context.packager.appInfo.version,
      '--set-file-version', context.packager.appInfo.version
    ];
    execFileSync(rcedit, args, { stdio: 'pipe' });
    console.log('[after-pack] 已注入图标与版本信息:', exe);
  } catch (e) {
    throw e;
  }
};
