#!/usr/bin/env node
// ============================================================
// 准备一份「已裁掉多余语言包」的 Electron dist，供 electron-builder 使用
// ============================================================
// 为什么需要它：
//   electron-builder 打包时会执行 `removeUnusedLanguagesIfNeeded()` —— 把 dist/locales 里
//   不在 `electronLanguages` 列表中的 .pak **批量删掉**（本机实测一次 51 个）。
//   而本机环境的 safe-delete 守卫规定「单轮 ≥50 项删除须用户确认」，构建就卡在
//   `[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]` 上失败。
//
// 做法：**复制时就跳过**多余语言包（只读、零删除），再用 `-c.electronDist=<产物目录>`
// 指给 electron-builder。这样它进来看到的 locales 已经只有目标语言，无需删除。
//
// 用法：
//   node scripts/prepare-electron-dist.mjs                 # 默认输出 ../_electron-dist
//   node scripts/prepare-electron-dist.mjs --out D:/x/dist
//   node scripts/prepare-electron-dist.mjs --langs en-US,zh-CN
//
// 语言列表默认从 electron-builder.yml 的 electronLanguages 解析，保证与正式配置一致。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}

const outDir = path.resolve(arg('out', path.join(ROOT, '..', '_electron-dist')));
const srcDir = path.join(ROOT, 'node_modules', 'electron', 'dist');

/** 从 electron-builder.yml 的 electronLanguages 块解析语言列表（失败则用默认四语） */
function langsFromConfig() {
  try {
    const yml = fs.readFileSync(path.join(ROOT, 'electron-builder.yml'), 'utf8');
    const m = yml.match(/^electronLanguages:\s*\r?\n((?:\s*-\s*\S+\r?\n)+)/m);
    if (!m) return null;
    return m[1].split(/\r?\n/).map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
  } catch (_) {
    return null;
  }
}

const langs = (arg('langs', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const keep = new Set(langs.length ? langs : (langsFromConfig() || ['en-US', 'zh-CN', 'zh-TW', 'ja']));

if (!fs.existsSync(srcDir)) {
  console.error('[electron-dist] 找不到 ' + srcDir + '（先 npm install）');
  process.exit(1);
}
if (fs.existsSync(outDir)) {
  // 只提示，不删除：删除由调用方决定（避免触发批量删除守卫）
  console.error('[electron-dist] 输出目录已存在：' + outDir + '\n  换一个 --out，或手动清理后重试');
  process.exit(1);
}

let copied = 0, skipped = 0, bytes = 0;
function copyDir(from, to, rel) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    const relPath = rel ? rel + '/' + e.name : e.name;
    if (e.isDirectory()) { copyDir(src, dst, relPath); continue; }
    // 语言包：不在保留列表里的直接跳过（不复制 = 不需要删除）
    if (rel === 'locales' && e.name.endsWith('.pak')) {
      const lang = e.name.replace(/\.pak$/, '');
      if (!keep.has(lang)) { skipped++; continue; }
    }
    const st = fs.statSync(src);
    fs.copyFileSync(src, dst);
    copied++; bytes += st.size;
  }
}

const t0 = Date.now();
copyDir(srcDir, outDir, '');
console.log('[electron-dist] ' + outDir);
console.log('  复制 ' + copied + ' 个文件 / ' + (bytes / 1048576).toFixed(0) + ' MB，'
  + '跳过语言包 ' + skipped + ' 个（保留：' + [...keep].join(', ') + '）'
  + '，耗时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
console.log('  用法：npx electron-builder --win nsis --x64 -c.electronDist="' + outDir.replace(/\\/g, '/') + '"');
