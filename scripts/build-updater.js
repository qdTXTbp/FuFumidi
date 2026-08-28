#!/usr/bin/env node
// ============================================================
// electron-builder 之前生成 kachina 更新器（FuFumidi.update.exe）
// 背景：electron-builder 的 extraFiles 从 release/update/FuFumidi.update.exe 复制更新器；
// 若该文件不存在（全新环境 / 清理过 release/），安装包会缺少更新器 → 无法自动更新（v3.1.2 事故）。
// 该脚本保证任何环境先产出更新器，再跑 NSIS 打包。
// ============================================================
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const builder = path.join(root, 'tools', 'kachina-builder.exe');
const config = path.join(root, 'build', 'kachina.config.json');
const leftImg = path.join(root, 'build', 'updater-left.webp');
const outDir = path.join(root, 'release', 'update');
const out = path.join(outDir, 'FuFumidi.update.exe');

if (!fs.existsSync(builder)) {
  console.error('[build-updater] 缺失 kachina-builder.exe：' + builder);
  console.error('请从 GitHub Releases 获取 tools/kachina-builder.exe（与 scripts/build-kachina.ps1 要求一致）。');
  process.exit(1);
}
if (!fs.existsSync(config)) {
  console.error('[build-updater] 缺失 kachina.config.json：' + config);
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

const args = ['pack', '-c', config, '-o', out, '--icon', path.join(root, 'build', 'icon.ico')];
if (fs.existsSync(leftImg)) { args.push('-t', leftImg); }

console.log('[build-updater] generating FuFumidi.update.exe ...');
const r = spawnSync(builder, args, { stdio: 'inherit', cwd: root });
if (r.status !== 0) {
  console.error('[build-updater] 更新器生成失败（exit ' + r.status + '）');
  process.exit(r.status || 1);
}
console.log('[build-updater] ok: ' + out + ' (' + (fs.statSync(out).size / 1024).toFixed(1) + ' KB)');
