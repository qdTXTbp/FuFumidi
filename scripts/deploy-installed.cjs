#!/usr/bin/env node
/**
 * 把当前源码的改动**覆盖到已安装版**（用于直接在安装版上修复 / 验证）。
 *
 *   node scripts/deploy-installed.cjs
 *
 * ★ 为什么不用 build.js 的 fufumidi-full.asar 直接覆盖：
 *   那份 asar 是给**在线更新器**用的，@electron/asar pack . 会把 resources/python（1.3GB）、
 *   models、release/ 等全打进去 —— 实测 2.1GB，装进安装版会让启动变慢、更新器失配。
 *   安装版真正需要的是 electron-builder 那套 files 过滤后的 50MB asar。
 *
 * 所以这里的做法是「在干净基线上做外科手术」：
 *   1. 关掉安装版；
 *   2. 以 release/win-unpacked/resources/app.asar（同版本干净副本）为基线解包；
 *   3. 用工作区的当前源码覆盖 app 代码（main/**、main.js、preload.js…）与整个 renderer/dist；
 *   4. 重新打 asar（与项目一致：--unpack-dir=engine --unpack="*.node"）；
 *   5. 覆盖安装版的 app.asar 与 app.asar.unpacked/engine（Python 改动只在这里生效）。
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INSTALL = process.env.FUFUMIDI_INSTALL || 'E:\\Midi\\FuFumidi';
const RES = path.join(INSTALL, 'resources');
const ASAR = path.join(RES, 'app.asar');
const UNPACK = path.join(RES, 'app.asar.unpacked');
const BASE = path.join(ROOT, 'release', 'win-unpacked', 'resources', 'app.asar');
const TMP = path.join(ROOT, 'dist', 'deploy-asar');
const OUT = path.join(ROOT, 'dist', 'deploy.asar');
const ASAR_BIN = path.join(ROOT, 'node_modules', '.bin', 'asar.cmd');
// 这些目录不在 app 代码里：junction（FuFumidiData）、打包产物（release*/dist）、
// 依赖（node_modules）、引擎（engine 走 unpacked 单独同步）、Rust/Tauri 产物
const SKIP_DIRS = new Set(['node_modules', 'engine', '.git', 'FuFumidiData', 'release', 'release-base',
  'dist', 'gpu-package', 'rust-core', 'src-tauri', 'frontend', 'test', 'tools', 'cloud-sync']);

if (!fs.existsSync(BASE)) { console.error('找不到干净基线：' + BASE + '（先跑一次 electron-builder --dir）'); process.exit(1); }
if (!fs.existsSync(RES)) { console.error('找不到安装版：' + RES); process.exit(1); }

// ---- 1) 关掉安装版（asar 被占用就写不进去）
try { execSync('taskkill /IM FuFumidi.exe /F', { stdio: 'ignore' }); } catch (e) { /* 没在跑 */ }
let free = false;
for (let i = 0; i < 24 && !free; i++) {
  try { fs.renameSync(ASAR, ASAR + '.probe'); fs.renameSync(ASAR + '.probe', ASAR); free = true; }
  catch (e) { execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 500"', { stdio: 'ignore' }); }
}
if (!free) { console.error('app.asar 仍被占用（安装版没关掉？）'); process.exit(1); }
console.log('[1/5] 安装版已关闭');

// ---- 2) 解包干净基线
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
execSync('"' + ASAR_BIN + '" extract "' + BASE + '" "' + TMP + '"', { stdio: 'inherit' });
console.log('[2/5] 基线解包完成');

// ---- 3) 覆盖：renderer/dist 整目录替换；其余同名文件逐个覆盖
const distSrc = path.join(ROOT, 'renderer', 'dist');
const distDst = path.join(TMP, 'renderer', 'dist');
if (fs.existsSync(distSrc)) { fs.rmSync(distDst, { recursive: true, force: true }); fs.cpSync(distSrc, distDst, { recursive: true }); }
let copied = 0, changed = [], skipped = [];
function overlay(relDir) {
  const src = path.join(ROOT, relDir);
  if (!fs.existsSync(src)) return;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;                        // junction/软链（如 FuFumidiData）不是文件
    const rel = path.join(relDir, e.name);
    if (e.isDirectory()) {
      if (relDir === '' && SKIP_DIRS.has(e.name)) continue;
      if (rel === path.join('renderer', 'dist')) continue;   // 上面整目录替换过了
      if (rel === path.join('renderer', 'node_modules')) continue;
      overlay(rel);
    } else {
      const full = path.join(ROOT, rel);                     // ★ 一定要注意是 full，不是 src（src 是父目录）
      const dst = path.join(TMP, rel);
      if (!fs.existsSync(dst)) continue;                     // 只覆盖基线里已有的文件
      let sst = null, st = null;
      try { sst = fs.statSync(full); st = fs.statSync(dst); } catch (e) { continue; }
      if (!sst.isFile()) { skipped.push(rel + '(src-dir)'); continue; }
      if (!st.isFile()) { skipped.push(rel); continue; }      // 基线里是目录（asar 的 unpack 占位）
      const a = fs.readFileSync(full);
      const b = fs.readFileSync(dst);
      if (!a.equals(b)) { fs.copyFileSync(full, dst); changed.push(rel); }
      copied++;
    }
  }
}
overlay('');
console.log('[3/5] 覆盖 ' + copied + ' 个文件，其中内容有变化 ' + changed.length + ' 个：' + changed.slice(0, 12).join(', ') + (changed.length > 12 ? ' …' : ''));
if (skipped.length) console.log('     跳过（基线里不是文件）：' + skipped.slice(0, 8).join(', '));

// ---- 4) 重新打包
fs.rmSync(OUT, { force: true });
execSync('"' + ASAR_BIN + '" pack "' + TMP + '" "' + OUT + '" --unpack-dir=engine --unpack="*.node"', { stdio: 'inherit' });
console.log('[4/5] 新 asar：' + (fs.statSync(OUT).size / 1048576).toFixed(1) + ' MB');

// ---- 5) 覆盖安装版
fs.copyFileSync(OUT, ASAR);
const dstEngine = path.join(UNPACK, 'engine');
const srcEngine = path.join(ROOT, 'engine');
fs.rmSync(dstEngine, { recursive: true, force: true });
fs.cpSync(srcEngine, dstEngine, { recursive: true, filter: (s) => !s.includes('__pycache__') });
// 注意：unpacked 与 asar 是配套的，engine 必须两边一致（asar 里 engine 只是占位）
console.log('[5/5] 已覆盖 app.asar（' + (fs.statSync(ASAR).size / 1048576).toFixed(1) + ' MB）与 app.asar.unpacked/engine');
console.log('完成 —— 双击 ' + path.join(INSTALL, 'FuFumidi.exe') + ' 即可看到改动。');
