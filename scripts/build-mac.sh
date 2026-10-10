#!/usr/bin/env bash
# 续写批改站 macOS 构建脚本（必须在 macOS 上运行）
set -e
cd "$(dirname "$0")/.."

echo "==> 安装依赖（含 Electron macOS 版）"
npm install

echo "==> 本地试运行（可选）：npm run dev"

echo "==> 构建 dmg + zip（同时产出 arm64 与 x64）"
npm run dist:mac

echo "==> 构建通用包（可选，一条命令同时支持 Intel 与 Apple Silicon）：npm run dist:mac:universal"

echo "==> 产物：dist/ 下的 .dmg 与 .zip"
echo "==> 未签名应用首次打开：右键点图标 -> 打开；或在终端执行：xattr -cr /Applications/续写批改站.app"
