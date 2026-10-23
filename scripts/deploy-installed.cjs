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
 *   4. 重新打 asar —— **过滤条件与 asarUnpack 清单直接读 electron-builder.yml**；
 *   5. 覆盖安装版的 app.asar 与 app.asar.unpacked（整目录替换）。
 *
 * ★ 这个脚本**不碰** resources/python：上游级补丁（engine/patches/muscriptor-events-fufumidi.1.py
 *   → 运行时的 Lib/site-packages/muscriptor/events.py）必须手工 copy，否则"代码改了、
 *   装到安装版里没生效"（2026-10-14 实测踩过一次）。改引擎证据逻辑时记得两条路一起走。
 *
 * ★ 2026-10 修掉的两个真实缺陷（尺寸审计实测）：
 *   a) 旧版打包只传 `--unpack-dir=engine --unpack="*.node"`，丢掉了 electron-builder.yml 的
 *      asarUnpack（soundfonts / js-synth / wallpapers）。结果是同一个文件既内联进 asar、
 *      又留在上一次的 app.asar.unpacked 里 —— 安装版实测多出 **36.9 MB** 重复（sf2 31.3 MB 两份，
 *      sha256 完全一致），另有 73 个「asar 里没有、unpacked 里还在」的陈旧文件。
 *   b) 旧版自己维护一份 SKIP_DIRS 排除表，与 electron-builder.yml 的 files 排除表**各写一遍**，
 *      必然漂移：docs/、build/、scripts/、package-lock.json、README*.md 这些被 files 排除的东西，
 *      因为「基线里没有就当成新文件拷进去」的逻辑，反而被塞进了安装版（实测 2.4 MB 开发残留）。
 *   现在两份清单只有 electron-builder.yml 这一个来源，安装版是发布版的忠实镜像 ——
 *   否则「在安装版上验证」验证的就不是要发出去的那个东西。
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
const OUT_UNPACK = OUT + '.unpacked';
const ASAR_BIN = path.join(ROOT, 'node_modules', '.bin', 'asar.cmd');

// ---------------------------------------------------------------- 读 electron-builder.yml
const YML = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');

/** 取出顶层键 name 下的列表项，去掉行内注释与引号 */
function ymlList(name) {
  const out = [];
  let inBlock = false;
  for (const line of YML.split(/\r?\n/)) {
    if (/^[A-Za-z_]/.test(line)) { inBlock = line.trimStart().startsWith(name + ':'); continue; }
    if (!inBlock) continue;
    const m = line.match(/^\s*-\s*(?:"([^"]*)"|'([^']*)'|([^#\s]+))/);
    if (m) out.push(m[1] || m[2] || m[3]);
  }
  return out;
}

const FILES_PATTERNS = ymlList('files');
const UNPACK_PATTERNS = ymlList('asarUnpack');
if (!FILES_PATTERNS.length) { console.error('electron-builder.yml 里读不到 files 列表'); process.exit(1); }

/** 单段 glob（只含 *）*/
const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
function segMatch(pat, seg) {
  if (pat === '*') return true;
  if (!pat.includes('*')) return pat === seg;
  return new RegExp('^' + pat.split('*').map(esc).join('[^/]*') + '$').test(seg);
}
/** 逐段匹配，支持 ** */
function globMatch(pattern, rel) {
  const p = pattern.split('/'), r = rel.split('/');
  const go = (i, j) => {
    if (i === p.length) return j === r.length;
    if (p[i] === '**') { for (let k = j; k <= r.length; k++) if (go(i + 1, k)) return true; return false; }
    if (j >= r.length) return false;
    if (!segMatch(p[i], r[j])) return false;
    return go(i + 1, j + 1);
  };
  return go(0, 0);
}

// files 列表里以 ! 开头的是排除项（相对仓库根、用 / 分隔）
const EXCLUDES = FILES_PATTERNS.filter((p) => p.startsWith('!')).map((p) => p.slice(1).replace(/\\/g, '/'));
function excluded(rel) {
  const norm = rel.split(path.sep).join('/');
  return EXCLUDES.some((p) => globMatch(p, norm));
}

// 这些目录既不在 app 代码里、又可能非常大（或是指向别处的 junction），一律不遍历。
// electron-builder.yml 的 files 已覆盖了其中大部分；这里保留一份硬兜底，防止清单被误删后
// 把 node_modules（365MB）或 FuFumidiData（junction 到 12GB 数据目录）拖进来。
const HARD_SKIP = new Set(['node_modules', '.git', 'FuFumidiData', 'dist']);
const HARD_SKIP_RE = /^(release|gpu-package)/;

if (!fs.existsSync(BASE)) { console.error('找不到干净基线：' + BASE + '（先跑一次 electron-builder --dir）'); process.exit(1); }
if (!fs.existsSync(RES)) { console.error('找不到安装版：' + RES); process.exit(1); }

// ---- 0) 前置：前端产物新鲜度
// 血泪教训（2026-10-12）：SettingsPanel.vue 是 <script setup>（**纯 JS，没有 lang="ts"**），
// 往里写 TS 语法（`as any` / `catch (e: any)`）时 `tsc --noEmit` 照样报 0，
// 但 vite 构建直接失败。而本脚本不看构建结果、照旧部署 ——
// 于是悄悄发了一版「旧前端 + 新引擎」的包，[7/7] 冒烟还照样通过（前端是旧的，当然不白屏）。
// 所以这里先比一次时间戳：frontend/src 比 renderer/dist 新就拒绝部署。
// （故意不自动构建：构建失败时自动构建同样会静默沿用旧产物，那正是要防的事。）
function newestMtime(dir, re) {
  let newest = 0;
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (re && !re.test(e.name)) continue;
      try { const m = fs.statSync(p).mtimeMs; if (m > newest) newest = m; } catch (err) {}
    }
  };
  walk(dir);
  return newest;
}
{
  const SRC = path.join(ROOT, 'frontend', 'src');
  const DIST = path.join(ROOT, 'renderer', 'dist', 'assets');
  const srcNewest = newestMtime(SRC, null);
  const distNewest = newestMtime(DIST, /\.js$/);
  if (!distNewest) {
    console.error('[前置] 找不到 renderer/dist/assets —— 先跑 `npm run build:ui`。');
    process.exit(1);
  }
  if (srcNewest > distNewest) {
    const mins = Math.max(1, Math.round((srcNewest - distNewest) / 60000));
    console.error('[前置] 前端产物过期：frontend/src 比 renderer/dist 新约 ' + mins + ' 分钟。');
    console.error('       界面改动还没进渲染层，直接部署会发出「旧前端 + 新引擎」的包。');
    console.error('       请先 `npm run build:ui`（注意看它的退出码），再重新部署。');
    process.exit(1);
  }
  console.log('[前置] 前端产物新鲜（renderer/dist 不旧于 frontend/src）');
}

// ---- 1) 关掉安装版（asar 被占用就写不进去）
try { execSync('taskkill /IM FuFumidi.exe /F', { stdio: 'ignore' }); } catch (e) { /* 没在跑 */ }
let free = false;
for (let i = 0; i < 24 && !free; i++) {
  try { fs.renameSync(ASAR, ASAR + '.probe'); fs.renameSync(ASAR + '.probe', ASAR); free = true; }
  catch (e) { execSync('powershell -NoProfile -Command "Start-Sleep -Milliseconds 500"', { stdio: 'ignore' }); }
}
if (!free) { console.error('app.asar 仍被占用（安装版没关掉？）'); process.exit(1); }
console.log('[1/7] 安装版已关闭');

// ---- 2) 解包干净基线
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
execSync('"' + ASAR_BIN + '" extract "' + BASE + '" "' + TMP + '"', { stdio: 'inherit' });
// @electron/asar 的 extract 是否连 unpacked 文件一起还原，各版本行为不一致。
// 这里用基线的 app.asar.unpacked 把缺的文件补齐（不覆盖已存在的），
// 否则重新打包后 unpacked 树会缩水 —— 安装版会丢掉内置音色库。
const BASE_UNPACK = BASE + '.unpacked';
if (fs.existsSync(BASE_UNPACK)) fs.cpSync(BASE_UNPACK, TMP, { recursive: true, force: false });
console.log('[2/7] 基线解包完成');
// ---- 3) 覆盖：renderer/dist 整目录替换；其余按 electron-builder.yml 的过滤逐个覆盖
const distSrc = path.join(ROOT, 'renderer', 'dist');
const distDst = path.join(TMP, 'renderer', 'dist');
if (fs.existsSync(distSrc)) { fs.rmSync(distDst, { recursive: true, force: true }); fs.cpSync(distSrc, distDst, { recursive: true }); }
let copied = 0, created = 0, changed = [], skipped = [];
function overlay(relDir) {
  const src = path.join(ROOT, relDir);
  if (!fs.existsSync(src)) return;
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;                        // junction/软链（如 FuFumidiData）不是文件
    const rel = relDir ? path.join(relDir, e.name) : e.name;
    if (relDir === '') {
      if (HARD_SKIP.has(e.name) || HARD_SKIP_RE.test(e.name)) continue;
    }
    if (e.isDirectory()) {
      const relU = rel.split(path.sep).join('/');
      if (excluded(rel) || excluded(relU + '/**')) continue;   // electron-builder.yml 说不打包的，这里也不拷
      if (relU === 'renderer/dist') continue;                  // 上面整目录替换过了
      if (relU === 'renderer/node_modules') continue;
      if (relU === 'engine') continue;                         // engine 走 unpacked 单独同步
      overlay(rel);
    } else {
      if (excluded(rel)) continue;
      // ★ 保险丝：打包产物与超大文件一律不进 asar
      if (/\.(asar|zip|exe|msi|7z|gz)$/i.test(e.name)) continue;
      try { if (fs.statSync(path.join(ROOT, rel)).size > 30 * 1024 * 1024) continue; } catch (err) {}
      const full = path.join(ROOT, rel);
      const dst = path.join(TMP, rel);
      if (!fs.existsSync(dst)) {
        // ★ 新增的源文件也要进 asar：只覆盖「基线里已有」的文件会让新模块永远部署不上去
        //   （实测 main/omr.js 丢失 → 安装版启动即弹 "Cannot find module ./main/omr"）。
        try {
          fs.mkdirSync(path.dirname(dst), { recursive: true });
          fs.copyFileSync(full, dst);
          changed.push(rel + '(new)');
          copied++; created++;
        } catch (e) { skipped.push(rel + '(new-failed)'); }
        continue;
      }
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
console.log('[3/7] 覆盖 ' + copied + ' 个文件（其中新增 ' + created + '），内容有变化 ' + changed.length + ' 个：' + changed.slice(0, 12).join(', ') + (changed.length > 12 ? ' …' : ''));
if (skipped.length) console.log('     跳过（基线里不是文件）：' + skipped.slice(0, 8).join(', '));

// ---- 3b) 清理：基线里有、但现在不该有的文件（源码已删除，或被 files 排除）
// 旧版只做「覆盖 + 新增」，从不删除 —— 于是删除掉的 vendor 文件永远留在安装版里
// （实测删了 19MB 死资源后安装版 asar 仍含旧文件，体积没降）。
let pruned = 0, prunedBytes = 0;
function pruneTmp(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = path.relative(TMP, full);
    const relU = rel.split(path.sep).join('/');
    if (e.isDirectory()) {
      if (excluded(rel) || excluded(relU + '/**')) { prunedBytes += dirSize(full); pruned++; fs.rmSync(full, { recursive: true, force: true }); continue; }
      pruneTmp(full);
      if (fs.readdirSync(full).length === 0) fs.rmSync(full, { recursive: true, force: true });
    } else if (excluded(rel) || !fs.existsSync(path.join(ROOT, rel))) {
      prunedBytes += fs.statSync(full).size; pruned++; fs.rmSync(full, { force: true });
    }
  }
}
function dirSize(dir) {
  let total = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}
pruneTmp(TMP);
console.log('[3b/7] 清理基线残留 ' + pruned + ' 项 / ' + (prunedBytes / 1048576).toFixed(1) + ' MB（源码已删除或被 electron-builder.yml 排除）');

// ---- 4) 重新打包：asarUnpack 清单直接来自 electron-builder.yml
fs.rmSync(OUT, { force: true });
fs.rmSync(OUT_UNPACK, { recursive: true, force: true });
// ★ asar CLI 的 --unpack 有两个坑，实测都踩到了：
//   1) commander 把它定义成**单值**选项，重复传只有最后一条生效；
//   2) 它用 minimatch 直接匹配**绝对路径**（node_modules/@electron/asar/lib/asar.js:147），
//      Windows 下路径是反斜杠，而 electron-builder.yml 里的 glob 是正斜杠 —— 一条也匹配不上，
//      结果 soundfonts / js-synth 全被内联进 asar（安装版因此比发布版大 30MB）。
//   解法：同一份 electron-builder.yml 规则在暂存树里筛出该 unpack 的文件，传它们的**文件名**
//   （minimatch 的 matchBase 让无斜杠模式按 basename 匹配）。规则来源仍只有一处。
const unpackGlobs = UNPACK_PATTERNS.filter((p) => p !== 'engine/**').map((p) => p.replace(/\\/g, '/'));
const nameCount = new Map();
(function countNames(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { countNames(full); continue; }
    nameCount.set(e.name, (nameCount.get(e.name) || 0) + 1);
  }
})(TMP);
const unpackNames = new Set(['*.node']);           // **/*.node：引擎原生模块，asar 内无法 dlopen
const notUnpacked = [];
(function collectUnpack(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { collectUnpack(full); continue; }
    const rel = path.relative(TMP, full).split(path.sep).join('/');
    if (!unpackGlobs.some((g) => globMatch(g, rel))) continue;
    // 重名文件不按 basename 解包：那会连带把别处的同名文件也解包出去
    if ((nameCount.get(e.name) || 0) === 1) unpackNames.add(e.name);
    else notUnpacked.push(rel);
  }
})(TMP);
const unpackExpr = '{' + [...unpackNames].join(',') + '}';
if (notUnpacked.length) console.log('     注意：以下文件因重名未解包（内联进 asar，功能不受影响）：' + notUnpacked.join(', '));
// ★★ 必须在打包**之前**把「最终的 engine」放进 TMP。
//   原因（REA 产物视角查出来的真问题）：asar pack 会为 --unpack 的文件算 integrity 哈希，
//   而旧流程是「打包 → 覆盖 app.asar → 再用源码 engine 替换 app.asar.unpacked/engine」，
//   于是**哈希是对 TMP/engine 算的、部署的却是源码 engine**，两者内容不同 → 完整性元数据过期。
//   REA 实测报出 6 个 integrity 矛盾（engine/deps.py 等），declared 12a4b89b… vs calculated a09d34eb…。
//   源码视角的审计永远看不到这个 —— 源码里没有 asar 头部这层概念。
//   现在改成：先把源码 engine 同步进 TMP（含 __pycache__ 过滤），再打包，
//   第 5 步直接用打包产物，不再二次替换 —— 算哈希的和部署的是同一份字节。
(function syncEngineIntoTmp() {
  const dst = path.join(TMP, 'engine');
  const src = path.join(ROOT, 'engine');
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true, filter: (s) => !s.includes('__pycache__') && !s.includes('.pytest_cache') });
  console.log('[3c/7] 已把源码 engine 同步进打包目录（保证 integrity 哈希与部署内容一致）');
})();
execSync('"' + ASAR_BIN + '" pack "' + TMP + '" "' + OUT + '" --unpack-dir=engine --unpack="' + unpackExpr + '"', { stdio: 'inherit' });
const isUnpacked = (rel) => globMatch('engine/**', rel) || unpackGlobs.some((g) => globMatch(g, rel));
console.log('[4/7] 新 asar：' + (fs.statSync(OUT).size / 1048576).toFixed(1) + ' MB（asarUnpack：' + UNPACK_PATTERNS.length + ' 条规则）');

// 尺寸护栏：内联进 asar 的最大文件逐个列出 —— 上一次 asar 从 200MB 涨到 2GB 就是靠这个发现的
function biggest(dir, list = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) biggest(p, list);
    else if (e.isFile()) list.push([fs.statSync(p).size, path.relative(TMP, p)]);
  }
  return list;
}
const listed = biggest(TMP).filter(([, p]) => !isUnpacked(p.split(path.sep).join('/'))).sort((a, b) => b[0] - a[0]).slice(0, 5);
console.log('     asar 里最大的 5 个内联文件：' + listed.map(([s, p]) => (s / 1048576).toFixed(1) + 'MB ' + p).join(' | '));

// ---- 5) 覆盖安装版：asar + unpacked 整目录替换（清掉上一轮的陈旧文件）
fs.copyFileSync(OUT, ASAR);
// engine 已经在打包前同步进 TMP（见 [3c/7]），这里**直接用打包产物**，
// 不再二次替换 —— 否则 asar pack 算出的 integrity 又会和部署内容对不上。
if (fs.existsSync(OUT_UNPACK)) {
  fs.rmSync(UNPACK, { recursive: true, force: true });
  fs.mkdirSync(UNPACK, { recursive: true });
  fs.cpSync(OUT_UNPACK, UNPACK, { recursive: true });
}
// 注意：unpacked 与 asar 是配套的，engine 必须两边一致（asar 里 engine 只是占位）
console.log('[5/7] 已覆盖 app.asar（' + (fs.statSync(ASAR).size / 1048576).toFixed(1) + ' MB）与 app.asar.unpacked');

// ---- 5b) 同步 extraResources：electron-builder 把它们放到 resources/ 下，**asar 里不含**
//   不补这一层就会出现「asar 里图标换了、窗口/托盘/任务栏还是旧的」——
//   2026-10-16 换 logo 时实测：build/icon.png 已换，resources/icon.png 仍是旧图（sha 对不上），
//   而 main/window.js 与 setupTray 都优先读 resources/icon.png。
//   清单同样**只从 electron-builder.yml 读**，避免两处漂移（和 asarUnpack 一个道理）。
function ymlPairs(name) {
  const out = [];
  let inBlock = false, cur = null;
  for (const line of YML.split(/\r?\n/)) {
    if (/^[A-Za-z_]/.test(line)) { inBlock = line.trimStart().startsWith(name + ':'); cur = null; continue; }
    if (!inBlock) continue;
    const mf = line.match(/^\s*-\s*from:\s*"?([^"'\s]+)"?/);
    if (mf) { cur = { from: mf[1] }; out.push(cur); continue; }
    const mt = line.match(/^\s*to:\s*"?([^"'\s]+)"?/);
    if (mt && cur) cur.to = mt[1];
  }
  return out.filter((x) => x.from && x.to);
}
function fingerprint(p) {
  const st = fs.statSync(p);
  if (st.isFile()) return { files: 1, bytes: st.size };
  let files = 0, bytes = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const q = path.join(d, e.name); if (e.isDirectory()) walk(q); else { files++; bytes += fs.statSync(q).size; } } };
  walk(p);
  return { files, bytes };
}
// ★ 明确**不接管** resources/python：它是 1.27 GB 的嵌入式解释器，且要按
//   engine/patches/muscriptor-events-fufumidi.1.py **手工**打上游补丁（见本文件开头第 19 行）。
//   2026-10-16 实测教训：最初把整张 extraResources 清单一并同步，resources/python 被整目录覆盖。
//   那次恰好无罪（工作区那份本来就带着补丁，两边 events.py 同为 22897 B），但那是运气：
//   一旦有人往工作区放一份**未打补丁**的 python，下一次部署就会静默把安装版的补丁抹掉。
const EXTRA_SKIP = ['resources/python'];
const extra = ymlPairs('extraResources');
const synced = [];
for (const { from, to } of extra) {
  const src = path.join(ROOT, from);
  const dst = path.join(RES, to);
  if (EXTRA_SKIP.some((s) => from === s || from.startsWith(s + '/'))) {
    synced.push(from + '（**不接管**，上游补丁靠手工 copy）');
    continue;
  }
  if (!fs.existsSync(src)) { synced.push(from + '（源码里没有，跳过）'); continue; }
  const same = fs.existsSync(dst) &&
    JSON.stringify(fingerprint(src)) === JSON.stringify(fingerprint(dst));
  if (same) { synced.push(from + '（已一致）'); continue; }
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
  const f = fingerprint(src);
  synced.push(from + ' -> resources/' + to + '（' + f.files + ' 文件 / ' + (f.bytes / 1048576).toFixed(1) + ' MB）');
}
console.log('[5b/7] extraResources 已同步：' + synced.join('；'));

// ---- 5c) 更新器必须与 release/update 的「已嵌入应用配置」版本一致 ----
//   2026-10-18 实测缺陷：手动部署只换 app.asar，安装目录里的 FuFumidi.update.exe 还是旧版
//   （embedded_config 为空），点「更新」会被更新器认成 C:\Program Files\KachinaInstaller 并报
//   「安装包损坏，请重新下载」。这里每次部署都同步一次，旧文件备份为 .bak。
const updSrc = path.join(ROOT, 'release', 'update', 'FuFumidi.update.exe');
const updDst = path.join(INSTALL, 'FuFumidi.update.exe');
if (fs.existsSync(updSrc)) {
  try {
    if (fs.existsSync(updDst)) {
      const oldBuf = fs.readFileSync(updDst);
      const newBuf = fs.readFileSync(updSrc);
      if (!oldBuf.equals(newBuf)) {
        fs.copyFileSync(updDst, updDst + '.bak');
        fs.copyFileSync(updSrc, updDst);
        console.log('  更新器已同步（旧文件备份为 FuFumidi.update.exe.bak）');
      } else {
        console.log('  更新器已是最新（带配置版）');
      }
    } else {
      fs.copyFileSync(updSrc, updDst);
      console.log('  更新器已写入（带配置版）');
    }
  } catch (e) {
    console.log('  ⚠ 更新器同步失败：' + String((e && e.message) || e));
  }
} else {
  console.log('  ⚠ 未找到 release/update/FuFumidi.update.exe，跳过更新器同步');
}

// ---- 5c) 硬门槛：安装版的 muscriptor 必须带着 FuFumidi 上游补丁
//   补丁只在 engine/patches/ 里存一份、靠手工 copy 进 resources/python（见本文件开头），
//   所以「有没有打上」必须每次部署都验一次，而不是等用户报告转录丢音。
{
  const EV = path.join(RES, 'python', 'Lib', 'site-packages', 'muscriptor', 'events.py');
  if (fs.existsSync(EV)) {
    const txt = fs.readFileSync(EV, 'utf8');
    if (!txt.includes('FUFUMIDI_TRACKER_TRACE')) {
      console.error('[5c/7] ✗ 安装版的 muscriptor/events.py 没有 FuFumidi 补丁 —— 转录会丢音。');
      console.error('       修法：copy engine/patches/muscriptor-events-fufumidi.1.py -> ' + EV);
      process.exit(1);
    }
    console.log('[5c/7] muscriptor 上游补丁在位（FUFUMIDI_TRACKER_TRACE）');
  }
}

// ---- 5d) 修 exe 的**内嵌图标**：任务栏 / 快捷方式 / 资源管理器读的是 exe 资源，
//   不是 asar 里的图，也不是 resources/icon.png —— 2026-10-16 用户实测：
//   侧栏与窗口图标都换了新 logo，任务栏和桌面快捷方式还是旧的。
//   工具用 electron-builder 自己的 rcedit（winCodeSign 缓存里），找不到就只警告不失败。
function findRcedit() {
  const cands = [
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign',
      'winCodeSign-2.6.0', 'rcedit-x64.exe'),
    path.join(ROOT, 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  const base = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  const walk = (d) => {
    if (!fs.existsSync(d)) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const q = path.join(d, e.name);
      if (e.isDirectory()) { const r = walk(q); if (r) return r; }
      else if (/^rcedit.*\.exe$/i.test(e.name)) return q;
    }
    return null;
  };
  return walk(base);
}
/* ★ 2026-10-18（真机事故：「安装包损坏，请重新下载」再次出现）：
   安装版里的 FuFumidi.update.exe 必须是**嵌入了应用配置**的那一版，否则 kachina 更新器
   不知道自己属于哪个应用 —— 日志里 embedded_config={}、install_path=C:\Program Files\KachinaInstaller，
   更新必然失败。dev 部署只替换 app.asar 时，安装目录里的更新器会保留上一次安装留下的旧文件，
   所以这里强制用构建产物里的「已配置更新器」覆盖安装目录那份（8.6MB 那版）。
   判定标记用 FuFumidiData（只存在于嵌入配置里），比 "FuFumidi" 字面量可靠。 */
{
  const builtUpdater = path.join(ROOT, 'release', 'update', 'FuFumidi.update.exe');
  const instUpdater = path.join(INSTALL, 'FuFumidi.update.exe');
  try {
    if (fs.existsSync(builtUpdater) && fs.statSync(builtUpdater).size > 1048576) {
      const buf = fs.readFileSync(builtUpdater);
      if (buf.includes(Buffer.from('FuFumidiData'))) {
        const cur = fs.existsSync(instUpdater) ? fs.readFileSync(instUpdater) : null;
        if (!cur || !cur.includes(Buffer.from('FuFumidiData'))) {
          fs.copyFileSync(builtUpdater, instUpdater);
          console.log('[5c/7] 已同步「含应用配置」的更新器 → ' + instUpdater);
        }
      } else {
        console.log('[5c/7] ⚠ 构建产物里的更新器不含应用配置，跳过同步（请先跑 build-kachina）');
      }
    }
  } catch (e) {
    console.log('[5c/7] ⚠ 更新器同步失败：' + (e && e.message));
  }
}
{
  const ico = path.join(ROOT, 'build', 'icon.ico');
  const rcedit = findRcedit();
  // 安装目录顶层的全部 exe：主程序、kachina 更新器、卸载器 —— 三个都带自己的图标资源
  const targets = fs.readdirSync(INSTALL, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.exe$/i.test(e.name))
    .map((e) => e.name);
  if (!rcedit || !fs.existsSync(ico)) {
    console.log('[5d/7] ⚠ 跳过 exe 图标同步（rcedit=' + rcedit + '）—— 任务栏/快捷方式图标会保持旧值');
  } else {
    const done = [];
    for (const f of targets) {
      const exe = path.join(INSTALL, f);
      try {
        execSync('"' + rcedit + '" "' + exe + '" --set-icon "' + ico + '"', { stdio: 'ignore' });
        done.push(f);
      } catch (e) {
        done.push(f + '(失败)');
      }
    }
    console.log('[5d/7] exe 内嵌图标已同步：' + done.join('、'));
  }
}

// ---- 6) 自检：内联文件里不该再出现「已经在 unpacked 里」的重复
function countFiles(dir) {
  let n = 0, bytes = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { n++; bytes += fs.statSync(p).size; } } };
  if (fs.existsSync(dir)) walk(dir);
  return { n, bytes };
}
const unp = countFiles(UNPACK);
console.log('[6/7] app.asar.unpacked：' + unp.n + ' 个文件 / ' + (unp.bytes / 1048576).toFixed(1) + ' MB（engine + soundfonts + js-synth）');

// ---- 7) 部署后冒烟：启动一次，断言不是白屏 / preload 在 / 没有未捕获异常
// 构建绿 ≠ 能用。上面六步只证明「文件拷贝成功」；渲染进程栽在启动路径上时表现就是白屏，
// 那样会把一个打不开的版本报成「完成」—— 所以这一步失败要当部署失败处理。
console.log('[7/7] 部署后冒烟：启动安装版一次，断言首屏有内容 / preload 已加载 / 无未捕获异常…');
try {
  execSync('node "' + path.join(__dirname, 'cdp', 'cdp-smoke.cjs') + '"', {
    stdio: 'inherit',
    env: Object.assign({}, process.env, { FUFUMIDI_INSTALL: INSTALL }),
  });
  console.log('完成 —— 冒烟通过，双击 ' + path.join(INSTALL, 'FuFumidi.exe') + ' 即可看到改动。');
} catch (e) {
  console.error('部署已拷贝完成，但冒烟失败：安装版起来了却没通过断言，先按上面的 - 逐条查，别当它可用。');
  process.exit(1);
}
