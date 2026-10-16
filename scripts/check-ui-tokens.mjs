#!/usr/bin/env node
/* ============================================================
   scripts/check-ui-tokens.mjs —— 界面设计语言的守门脚本（M2）
   ============================================================
   守的是四条硬规则（都是重构里量出来的实际数字）：

   1. 组件里不许出现颜色字面值。颜色的唯一合法落点是
      ① styles/tokens.css 与 styles.css 的 :root 里 --x: #hex 定义；
      ② core/theme.js（深浅色的唯一来源）；③ core/palette.js（画布兜底色）。
      其余一律走 var(--t-err) / var(--data-3) / cssVar('--track-1', 兜底)。
   2. font-size 只许 var(--fs-xs|sm|md|lg|xl|2xl)（6 档，原 32 档）。
   3. border-radius 只许 var(--r-sm|md|lg|pill)（4 档，原 31 档）。
   4. gap 只许 var(--sp-*) 或 0~3px 微调档（4/8 网格，原 323 种游离值）。

   棘轮：BASELINE 是本次重构后的实测值，**只许变小**。
   确属改善后可跑 node scripts/check-ui-tokens.mjs --update 下调基线。
   ============================================================ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'frontend', 'src');

/* 实测基线 —— 只许变小 */
const BASELINE = { hex: 21, fs: 0, radius: 0, gap: 0 };

/* 合法持有字面值的文件（各自有注释说明理由） */
const EXEMPT_FILES = [
  'styles/tokens.css',        // token 层的首屏兜底值
  'styles/fonts.css',
  'core/theme.js',            // 深浅两档的唯一来源
  'core/palette.js',          // 画布/图表兜底色
  'core/viz/state/themes.js', // 可视化轨道主题
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'dist') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(vue|css|js|ts)$/.test(e.name)) out.push(p);
  }
  return out;
}

/** CSS 区段（.vue 只取 style 块与内联 style 属性；其余是脚本，单独判兜底） */
function cssRegions(s, isVue) {
  if (!isVue) return [[0, s.length]];
  const out = [];
  for (const m of s.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) out.push([m.index + m[0].indexOf(m[1]), m[1].length]);
  for (const m of s.matchAll(/(?::?style)="([^"]*)"/g)) out.push([m.index + m[0].indexOf(m[1]), m[1].length]);
  out.sort((a, b) => a[0] - b[0]);
  const clean = [];
  for (const r of out) {
    const last = clean.length ? clean[clean.length - 1][0] + clean[clean.length - 1][1] : -1;
    if (r[0] >= last) clean.push(r);
  }
  return clean;
}

/** 主题变量的兜底参数：cssVar('--x', '#fff') / cvar('--x', '#fff') —— 合法 */
const FALLBACK_CALL = /(?:cssVar|cvar|readVar|themeColor|css)\s*\(\s*['"][^'"]+['"]\s*,\s*['"]#[0-9a-fA-F]{3,8}['"]/;

/** 注释/字符串掩码：注释里提到色号（文档爱写"原来那套里 #36b37e 与 #ff7a45 会糊"）不该算违规。
 *  同时要认字符串，否则 'https://…' 里的 // 会把整行当注释，反而漏报。 */
function maskedSpans(src) {
  const out = []; let i = 0, st = 'code', start = 0;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (st === 'code') {
      if (c === '/' && n === '/') { st = 'line'; start = i; i += 2; continue; }
      if (c === '/' && n === '*') { st = 'block'; start = i; i += 2; continue; }
      if (c === '<' && src.startsWith('<!--', i)) { st = 'html'; start = i; i += 4; continue; }
      if (c === "'") { st = 'sq'; start = i; i++; continue; }
      if (c === '"') { st = 'dq'; start = i; i++; continue; }
      if (c === '`') { st = 'bq'; start = i; i++; continue; }
      i++; continue;
    }
    if (st === 'line' && c === '\n') { out.push([start, i]); st = 'code'; }
    else if (st === 'block' && c === '*' && n === '/') { out.push([start, i + 2]); st = 'code'; i += 2; continue; }
    else if (st === 'html' && src.startsWith('-->', i)) { out.push([start, i + 3]); st = 'code'; i += 3; continue; }
    else if ((st === 'sq' || st === 'dq' || st === 'bq') && c === '\\') { i += 2; continue; }
    else if ((st === 'sq' && c === "'") || (st === 'dq' && c === '"') || (st === 'bq' && c === '`')) { st = 'code'; }
    i++;
  }
  if (st === 'line' || st === 'block' || st === 'html') out.push([start, src.length]);
  return out;
}

const counts = { hex: 0, fs: 0, radius: 0, gap: 0 };
const byFile = new Map();
const add = (file, kind, line, text) => {
  counts[kind]++;
  if (!byFile.has(file)) byFile.set(file, []);
  byFile.get(file).push(kind + ' L' + line + '  ' + text.trim().slice(0, 88));
};

for (const abs of walk(SRC)) {
  const rel = path.relative(SRC, abs).split(path.sep).join('/');
  // core/viz/** 自带一套主题系统（core/viz/state/themes.js 的 7 套可视化主题），
  // 它的取色不走应用级 token —— 单独治理，不在这里重复判。
  if (EXEMPT_FILES.includes(rel) || rel.startsWith('core/viz/')) continue;
  const src = fs.readFileSync(abs, 'utf8');
  const isVue = abs.endsWith('.vue');
  const regs = cssRegions(src, isVue);
  const isCss = new Array(src.length).fill(false);
  for (const [st, len] of regs) for (let i = st; i < st + len; i++) isCss[i] = true;
  const comments = maskedSpans(src);
  const inComment = (at) => comments.some(([a, b]) => at >= a && at < b);
  const lines = src.split('\n');
  let pos = 0;
  for (let ln = 0; ln < lines.length; ln++) {
    const line = lines[ln];
    const lineStart = pos; pos += line.length + 1;
    // 1) 颜色字面值
    for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
      const at = lineStart + m.index;
      const inCss = isCss[at];
      if (inComment(at)) continue;                                  // 注释里的色号不算
      const before = line.slice(0, m.index);
      if (/\|\|\s*['"]?$/.test(before)) continue;                  // pal.steel || '#333'（hex 前的引号也要算）
      // 兜底参数必须连右引号一起判，否则 cvar('--surface', '#101826') 会被误报
      // 兜底写法在 CSS 与脚本里都合法（.js 文件整体被当作 CSS 区，不能只判 !inCss）
      if (FALLBACK_CALL.test(line.slice(0, m.index + m[0].length + 1))) continue;
      // getPropertyValue('--x') || '#hex' 也是兜底写法（组件里读一次缓存住的写法）
      if (/getPropertyValue\s*\(\s*['"]--[^'"]+['"]\s*\)[^;]*\|\|/.test(before)) continue;
      // var(--x, #hex)：CSS 变量自带兜底，本身就是 token 化写法（Icon.vue 的 SVG 填充就是这种）
      if (/var\(\s*--[\w-]+\s*,\s*$/.test(before)) continue;
      if (/--[\w-]+\s*:\s*[^;]*$/.test(before) && inCss) continue;   // token 定义行
      add(rel, 'hex', ln + 1, line);
    }
    // 2) font-size 字面值
    for (const m of line.matchAll(/font-size\s*:\s*[\d.]+px/g)) add(rel, 'fs', ln + 1, line);
    // 3) border-radius 字面值
    for (const m of line.matchAll(/border(?:-(?:top|right|bottom|left)){0,2}-radius\s*:\s*[^;{}"'\n]*\d+px/g)) {
      if (/var\(--r-/.test(m[0])) continue;
      add(rel, 'radius', ln + 1, line);
    }
    // 4) gap 游离值（>3px 且非 token）
    for (const m of line.matchAll(/(?:^|[;\s{])(?:row-|column-)?gap\s*:\s*([^;{}"'\n]+)/g)) {
      const val = m[1].trim();
      if (val.includes('var(--sp-')) continue;
      const bad = val.split(/\s+/).some(v => { const n = parseFloat(v); return /^[\d.]+px$/.test(v) && n > 3; });
      if (bad) add(rel, 'gap', ln + 1, line);
    }
  }
}

const LABEL = { hex: '颜色字面值', fs: 'font-size 字面值', radius: 'border-radius 字面值', gap: 'gap 游离值' };
const over = [];
console.log('界面 token 审计（棘轮：只许变小）');
for (const k of ['hex', 'fs', 'radius', 'gap']) {
  const now = counts[k], base = BASELINE[k];
  const flag = now > base ? 'X 超出' : now < base ? 'OK 改善' : 'OK 持平';
  console.log('  ' + LABEL[k].padEnd(18) + String(now).padStart(4) + '  (基线 ' + base + ')  ' + flag);
  if (now > base) over.push(k);
}
if (process.argv.includes('--list')) {
  const rows = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12);
  console.log('\n违规最多的文件：');
  for (const [f, items] of rows) {
    console.log('  ' + f + '  (' + items.length + ')');
    for (const it of items.slice(0, 4)) console.log('      ' + it);
  }
}
if (process.argv.includes('--update')) {
  const self = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const next = self.replace(/const BASELINE = \{[^}]*\};/,
    'const BASELINE = { hex: ' + counts.hex + ', fs: ' + counts.fs + ', radius: ' + counts.radius + ', gap: ' + counts.gap + ' };');
  fs.writeFileSync(fileURLToPath(import.meta.url), next);
  console.log('\n基线已更新。');
}
if (over.length) {
  console.log('\n以上 ' + over.map(k => LABEL[k]).join(' / ') + ' 超出基线 —— 请改用 var(--t-*) / var(--fs-*) / var(--r-*) / var(--sp-*)，');
  console.log('或确属画布兜底色时放进 core/palette.js。明细：node scripts/check-ui-tokens.mjs --list');
  process.exit(1);
}
