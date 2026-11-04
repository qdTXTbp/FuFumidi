#!/usr/bin/env node
// ============================================================
// 品牌资产门禁（logo / 图标 / 立绘 / 安装器图）
// ============================================================
// 用户 2026-08 拍板的品牌规则（见 docs/BRAND.md）：
//   · 图标 = 头像特写 + 透明底，不做白底圆角卡；
//   · 立绘进应用内（侧栏品牌位 / 首页吉祥物 / 文档 nav）；
//   · 所有品牌图只从母图 docs/assets/brand/立绘-定稿-带描边.png 经 scripts/gen-logo.py 生成。
// 本门禁保证「换运行时/重写期间 logo 不会被悄悄改掉或漏打包」：
// 记录每个品牌资产的 SHA-256；任何变化必须 --update 并走用户确认。
//
// 用法：
//   node scripts/check-brand-assets.mjs            # 校验（漂移退出 1）
//   node scripts/check-brand-assets.mjs --update   # 重记 manifest（品牌变更时用）
//   node scripts/check-brand-assets.mjs --json      # 机器可读
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MANIFEST = path.join(HERE, 'brand-manifest.json');
const argv = process.argv.slice(2);
const UPDATE = argv.includes('--update');
const JSON_OUT = argv.includes('--json');

// 角色说明写进 docs/BRAND.md；这里只维护「必须守恒」的文件清单。
const ASSETS = [
  'build/icon.ico',
  'build/icon.png',
  'build/installerHeader.bmp',
  'build/installerSidebar.bmp',
  'frontend/src/assets/logo.png',
  'frontend/src/assets/mascot.png',
  'docs/assets/logo.png',
  'docs/assets/brand/FuFumidi.ico',
  'docs/assets/brand/徽记-512.png',
  'docs/assets/brand/立绘-定稿-带描边.png',
  'docs/assets/brand/立绘-定稿-透明.png',
  'docs/assets/brand/立绘-深靛-512.png',
  'docs/assets/brand/立绘-白底-512.png',
];

function sha256(file) {
  const buf = fs.readFileSync(file);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Tauri 壳必须复用安装包/任务栏同一枚品牌图标（build/icon.ico），
// 不允许另起一套。这里做字节级 equality，而不是再登记一份 manifest。
const SHELL_ICON = 'shells/tauri/icons/icon.ico';
const shellIconMismatch = [];

const current = {};
const missing = [];
for (const rel of ASSETS) {
  const p = path.join(ROOT, rel);
  try { current[rel] = sha256(p); } catch (e) { missing.push(rel); }
}

try {
  if (sha256(path.join(ROOT, SHELL_ICON)) !== current['build/icon.ico']) shellIconMismatch.push(SHELL_ICON);
} catch (e) { shellIconMismatch.push(SHELL_ICON); }

if (UPDATE) {
  const payload = {
    format: 'fufumidi-brand-manifest',
    version: 1,
    note: '品牌资产守恒清单；变更需用户确认并更新 docs/BRAND.md 的变更记录',
    updatedAt: new Date().toISOString(),
    files: current,
  };
  fs.mkdirSync(path.dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, updated: true, count: Object.keys(current).length, shellIconMismatch }));
  else console.log('[brand] manifest 已更新：' + Object.keys(current).length + ' 个文件');
  process.exit(0);
}

let manifest = null;
try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) { manifest = null; }
if (!manifest) {
  console.error('[brand] FAIL: 缺少 scripts/brand/brand-manifest.json（先 node scripts/check-brand-assets.mjs --update）');
  process.exit(1);
}
const expected = manifest.files || {};
const changed = [];
const added = [];
for (const rel of Object.keys(current)) {
  if (!(rel in expected)) added.push(rel);
  else if (expected[rel] !== current[rel]) changed.push(rel);
}
const removed = Object.keys(expected).filter((rel) => !(rel in current));
const ok = missing.length === 0 && changed.length === 0 && removed.length === 0 && added.length === 0 && shellIconMismatch.length === 0;
if (JSON_OUT) console.log(JSON.stringify({ ok, missing, changed, removed, added, shellIconMismatch, checked: Object.keys(current).length }));
else {
  console.log('[brand] 校验 ' + Object.keys(current).length + ' 个品牌资产 / manifest ' + Object.keys(expected).length);
  if (missing.length) console.log('  缺失: ' + missing.join(', '));
  if (changed.length) console.log('  变更: ' + changed.join(', '));
  if (removed.length) console.log('  manifest 有、磁盘无: ' + removed.join(', '));
  if (added.length) console.log('  新增未登记: ' + added.join(', '));
  if (shellIconMismatch.length) console.log('  Tauri 壳图标与 build/icon.ico 不一致: ' + shellIconMismatch.join(', '));
  if (ok) console.log('[brand] OK: 品牌资产未变（logo / 图标 / 立绘 / 安装器图一致，Tauri 壳复用同一图标）');
}
if (!ok) {
  console.error('[brand] FAIL: 品牌资产漂移。logo/图标只允许由 scripts/gen-logo.py 从母图重生成，且需用户确认；确认后跑 npm run brand:update 并提交 manifest。');
  process.exit(1);
}
