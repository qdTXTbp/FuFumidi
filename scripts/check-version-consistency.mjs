#!/usr/bin/env node
// P0-7 版本一致性门禁：四源必须一致
//   ① 根 package.json（Electron app.getVersion 的最终来源）
//   ② frontend/package.json（构建产物注入源 __APP_VERSION__）
//   ③ frontend/src/core/changelog.js（必须有当前版本条目，更新后弹窗才能显示）
//   ④ frontend/src/core/version.js + vite.config.js（版本必须由构建注入，禁止再写死）
// 用法：node scripts/check-version-consistency.mjs [--json] [--warn-only]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const warnOnly = argv.includes('--warn-only');

const errors = [];
const warnings = [];
const info = {};

function read(p) { return fs.readFileSync(p, 'utf8'); }
function readJson(p) { try { return JSON.parse(read(p)); } catch (e) { return null; } }

const rootPkg = readJson(path.join(ROOT, 'package.json'));
const fePkg = readJson(path.join(ROOT, 'frontend', 'package.json'));
if (!rootPkg) errors.push('package.json 无法解析');
if (!fePkg) errors.push('frontend/package.json 无法解析');
const version = rootPkg && rootPkg.version;
info.version = version;

if (fePkg && fePkg.version !== version) {
  errors.push('frontend/package.json 版本 (' + fePkg.version + ') 与根 package.json (' + version + ') 不一致');
}

// changelog 必须有当前版本号条目
const changelogPath = path.join(ROOT, 'frontend', 'src', 'core', 'changelog.js');
let changelogVersionList = [];
try {
  const text = read(changelogPath);
  changelogVersionList = [...text.matchAll(/^\s*'([0-9]+\.[0-9]+\.[0-9]+(?:-[^']+)?)'\s*:/gm)].map((m) => m[1]);
  info.changelogVersions = changelogVersionList;
  if (!changelogVersionList.includes(version)) {
    errors.push('changelog.js 缺当前版本 ' + version + ' 条目（现有: ' + changelogVersionList.slice(0, 5).join(', ') + '…）');
  }
} catch (e) {
  errors.push('changelog.js 读取失败：' + (e && e.message || e));
}

// version.js 禁止写死版本号，必须用构建注入
const versionJsPath = path.join(ROOT, 'frontend', 'src', 'core', 'version.js');
try {
  const text = read(versionJsPath);
  if (!text.includes('__APP_VERSION__')) errors.push('version.js 未使用构建注入的 __APP_VERSION__');
  const hard = text.match(/_cached\s*=\s*'v?[0-9]+\.[0-9]+\.[0-9]+'/);
  if (hard) errors.push('version.js 仍写死版本号：' + hard[0]);
} catch (e) {
  errors.push('version.js 读取失败：' + (e && e.message || e));
}

// vite 必须注入 __APP_VERSION__ / __BUILD_TIME__
try {
  const vite = read(path.join(ROOT, 'frontend', 'vite.config.js'));
  if (!vite.includes('__APP_VERSION__')) errors.push('vite.config.js 未注入 __APP_VERSION__');
  if (!vite.includes('__BUILD_TIME__')) warnings.push('vite.config.js 未注入 __BUILD_TIME__（关于页不会显示构建时间）');
} catch (e) {
  errors.push('vite.config.js 读取失败：' + (e && e.message || e));
}

// 发布说明文件（可选：缺了只警告，开发分支上通常还没写）
const notes = path.join(ROOT, 'scripts', 'release-notes-v' + version + '.md');
info.releaseNotes = fs.existsSync(notes);
if (!info.releaseNotes) warnings.push('缺少发布说明 scripts/release-notes-v' + version + '.md（发布前补）');

if (asJson) {
  console.log(JSON.stringify({ ok: !errors.length, version, errors, warnings, info }, null, 2));
} else {
  console.log('版本一致性检查（P0-7）');
  console.log('  根 package.json        ' + version);
  console.log('  frontend/package.json  ' + (fePkg && fePkg.version));
  console.log('  changelog 条目          ' + (changelogVersionList.includes(version) ? '有 ' + version : '缺 ' + version));
  console.log('  version.js 构建注入     ' + (errors.some((e) => e.includes('__APP_VERSION__')) ? '缺失' : 'OK'));
  if (warnings.length) for (const w of warnings) console.log('  ⚠ ' + w);
  if (errors.length) for (const e of errors) console.log('  ✗ ' + e);
  else console.log('  ✓ 四源一致');
}
process.exit(errors.length && !warnOnly ? 1 : 0);
