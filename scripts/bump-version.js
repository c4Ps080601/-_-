'use strict';
/**
 * bump-version.js — 打包前自动递增版本号
 * 默认递增补丁号（1.1.0 -> 1.1.1）；--minor 递增次版本（1.1.0 -> 1.2.0）；--major 递增主版本。
 */
const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const parts = String(pkg.version || '1.0.0').split('.').map(n => parseInt(n, 10) || 0);
while (parts.length < 3) parts.push(0);

const args = process.argv.slice(2);
const has = name => args.some(a => a === name || a === '--' + name || a === '-' + name.charAt(0));
if (has('major')) {
  parts[0] += 1;
  parts[1] = 0;
  parts[2] = 0;
} else if (has('minor')) {
  parts[1] += 1;
  parts[2] = 0;
} else {
  parts[2] += 1;
}

pkg.version = parts.join('.');
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
console.log('[bump-version] 版本号 -> ' + pkg.version);
