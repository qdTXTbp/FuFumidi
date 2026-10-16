#!/usr/bin/env node
// ============================================================
// 「死开关」静态审计：界面上绑定了 v-model、但**从来没有任何逻辑读过它**的控件。
//
// 为什么要有这个脚本：2026-10-15 用户发现「智能降噪」勾了等于没勾（引擎侧根本没接线），
// 还发现「跳过静音分段」在主进程那跳被整段丢掉。这类问题的共性是
// **控件存在、状态存在、就是没人用**。mechanical 的静态扫描能先把候选挑出来。
//
// 判据（宽严说明）：一个 v-model 绑定的名字，如果在
//   · 同一个 .vue 的 <script> 段里出现过，或
//   · 其它任何源码文件里出现过
// 就算「有人读」；只在模板里出现过 → 报为候选。
// 误报是可能的（例如只用于 :class 的纯展示状态），所以脚本只列清单，不判死刑。
// 用法：node scripts/audit-dead-options.cjs
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'frontend', 'src');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(vue|ts|js)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(SRC);
const sources = new Map();
for (const f of files) sources.set(f, fs.readFileSync(f, 'utf8'));
// 其它层（主进程 / preload / 引擎）也参与「是否有人读」的判断
const others = [];
for (const d of ['main', 'engine']) {
  const p = path.join(ROOT, d);
  if (!fs.existsSync(p)) continue;
  for (const f of fs.readdirSync(p)) {
    if (/\.(js|ts|py)$/.test(f) && !f.startsWith('test')) others.push([f, fs.readFileSync(path.join(p, f), 'utf8')]);
  }
}
for (const f of ['preload.js']) {
  const p = path.join(ROOT, f);
  if (fs.existsSync(p)) others.push([f, fs.readFileSync(p, 'utf8')]);
}

const dead = [];
for (const f of files) {
  if (!f.endsWith('.vue')) continue;
  const src = sources.get(f);
  // 必须按 template / script 块切，不能按「第一个 <script 的位置」切 ——
  // script setup 写在最前面的 SFC 里，那样切出来的 script 会把整个 template 也算进去，
  // 模板里的 v-model 名字就全被当成「脚本里读过」，审计永远为空（第一版栽在这）。
  const tplMatch = src.match(/<template>([\s\S]*)<\/template>/);
  const template = tplMatch ? tplMatch[1] : '';
  const script = src.replace(tplMatch ? tplMatch[0] : '', '');
  // 模板里除了 v-model 之外的用法（:prop="x"、@click="f(x)"、{{ x }}）也算「有人读」——
  // 实测这占了候选的一大半：颜色/描边/CC 编号这类值都是直接塞给子组件或行内样式用的。
  const tplUses = template.replace(/v-model(?::[a-z]+)?="[^"]*"/g, '');
  const names = new Set();
  for (const m of template.matchAll(/v-model(?::[a-z]+)?="([^"]+)"/g)) {
    const n = m[1].trim().replace(/\.value$/, '');
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(n)) names.add(n);
  }
  for (const n of names) {
    const re = new RegExp('\\b' + n.replace(/[$]/g, '\\$') + '\\b');
    // ★ 关键：声明本身不算「被读」。不然每个 ref 都因为 `const x = ref(...)` 而"有人读"，
    //   审计永远为空 —— 这正是这个脚本第一版跑出来「没有问题」的原因。
    const declRe = new RegExp('(const|let|var)\\s+' + n.replace(/[$]/g, '\\$') + '\\s*=\\s*(ref|shallowRef|reactive|computed)\\s*\\(');
    const scriptUses = script.replace(new RegExp(declRe.source, 'g'), '');
    if (re.test(scriptUses)) continue;                   // 同文件 script 里真读过
    if (re.test(tplUses)) continue;                       // 模板里除了 v-model 还有别的用法
    let elsewhere = '';
    for (const [name, text] of others) { if (re.test(text)) { elsewhere = name; break; } }
    if (elsewhere) continue;                              // 主进程/引擎读过
    let otherVue = '';
    for (const g of files) { if (g !== f && (g.endsWith('.ts') || g.endsWith('.js')) && re.test(sources.get(g))) { otherVue = path.relative(ROOT, g); break; } }
    if (otherVue) continue;
    dead.push({ file: path.relative(ROOT, f), name: n });
  }
}

if (!dead.length) {
  console.log('没有发现「绑定了但没人读」的控件。');
} else {
  console.log('候选（绑定了 v-model，但任何脚本里都没读过）：');
  for (const d of dead) console.log('  ' + d.file + '  →  ' + d.name);
  console.log('');
  console.log('共 ' + dead.length + ' 个候选 —— 逐个确认：要么接上逻辑，要么删掉控件（别留着假装能用）。');
}
