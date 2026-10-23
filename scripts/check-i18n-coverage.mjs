#!/usr/bin/env node
// P0-8 i18n 覆盖率门禁：扫源码里所有 t('中文…') 字面量，检查 EN（core/i18n.js）与
// JA（core/i18n_ja.js）都有翻译。缺一条算未完成（白名单见 scripts/i18n-whitelist.json）。
// 用法：node scripts/check-i18n-coverage.mjs [--json] [--update] [--top N]
//   --update  把缺失键打印成可直接粘进两个词典的骨架（不自动改文件）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.join(ROOT, 'frontend', 'src');
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const topN = (() => { const i = argv.indexOf('--top'); return i >= 0 ? Number(argv[i + 1]) || 40 : 40; })();

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;
const whitelistPath = path.join(HERE, 'i18n-whitelist.json');
let whitelist = [];
try { whitelist = JSON.parse(fs.readFileSync(whitelistPath, 'utf8')).missing || []; } catch (e) { whitelist = []; }
// 历史欠账基线（棘轮，只允许减少）：老 UI 还有大量中文直出字符串，一次性全译不现实；
// 从本批起**新代码**必须同步 EN/JA，老欠账记在基线里逐批清。--update-baseline 重新生成。
const baselinePath = path.join(HERE, 'i18n-baseline.json');
const updateBaseline = argv.includes('--update-baseline');
let baseline = { en: [], ja: [] };
try { baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')); } catch (e) { baseline = { en: [], ja: [] }; }
const baseEn = new Set(baseline.en || []);
const baseJa = new Set(baseline.ja || []);

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (!/node_modules|dist|artifacts/.test(ent.name)) walk(p, out); }
    else if (/\.(js|ts|vue)$/.test(ent.name)) out.push(p);
  }
  return out;
}

/** 从源码里抓 t('literal') / t("literal")（只抓字面量，变量不抓） */
function usedKeys(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = [];
  const re = /\bt\(\s*(['"])((?:\\.|(?!\1)[^\\])*?)\1\s*\)/g;
  let m;
  while ((m = re.exec(text))) {
    const key = m[2].replace(/\\'/g, "'").replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (key && CJK.test(key)) out.push(key);
  }
  return out;
}

function dictKeys(file) {
  const text = fs.readFileSync(file, 'utf8');
  const keys = new Set();
  const re = /^\s*'((?:\\.|[^'\\])*)'\s*:/gm;
  let m;
  while ((m = re.exec(text))) keys.add(m[1].replace(/\\'/g, "'"));
  return keys;
}

const files = walk(SRC);
const used = new Map();   // key → Set(file)
for (const f of files) for (const k of usedKeys(f)) {
  if (!used.has(k)) used.set(k, new Set());
  used.get(k).add(path.relative(ROOT, f));
}
const en = dictKeys(path.join(SRC, 'core', 'i18n.js'));
const ja = dictKeys(path.join(SRC, 'core', 'i18n_ja.js'));
const wl = new Set(whitelist);

// 很多 t(' …') 是**拼接片段**（前面/后面直接接数字或变量），本来就不该进词典，
// 单独计数，不算覆盖率缺失。整句/整词才要求翻译。
const isFragment = (k) => /^\s|\s$/.test(k) || !/[\u3400-\u9fff\uf900-\ufaff]/.test(k);
const missingEn = [], missingJa = [];
const fragments = new Set();
for (const [k, fs2] of used) {
  if (wl.has(k)) continue;
  if (isFragment(k)) { fragments.add(k); continue; }
  if (!en.has(k)) missingEn.push({ key: k, files: [...fs2].slice(0, 3) });
  if (!ja.has(k)) missingJa.push({ key: k, files: [...fs2].slice(0, 3) });
}
missingEn.sort((a, b) => a.key.localeCompare(b.key));
missingJa.sort((a, b) => a.key.localeCompare(b.key));
const newEn = missingEn.filter((it) => !baseEn.has(it.key));
const newJa = missingJa.filter((it) => !baseJa.has(it.key));
const fixedEn = [...baseEn].filter((k) => !missingEn.some((it) => it.key === k));
const fixedJa = [...baseJa].filter((k) => !missingJa.some((it) => it.key === k));
const ok = !newEn.length && !newJa.length;
if (updateBaseline) {
  fs.writeFileSync(baselinePath, JSON.stringify({
    comment: 'P0-8 i18n 棘轮基线：这些是历史欠账（老 UI 未翻译的中文字符串）。只允许减少；新代码的键必须在 i18n.js / i18n_ja.js 补翻译。',
    updatedAt: new Date().toISOString(),
    en: missingEn.map((it) => it.key).sort(),
    ja: missingJa.map((it) => it.key).sort(),
  }, null, 2) + '\n', 'utf8');
  console.log('已更新 i18n 基线：EN ' + missingEn.length + ' 条，JA ' + missingJa.length + ' 条 → ' + path.relative(ROOT, baselinePath));
}
const result = {
  ok, usedKeys: used.size, enKeys: en.size, jaKeys: ja.size, whitelist: wl.size,
  fragments: fragments.size, missingEn, missingJa, newEn, newJa, fixedEn, fixedJa,
};

if (asJson) console.log(JSON.stringify(result, null, 2));
else {
  console.log('i18n 覆盖率（P0-8）');
  console.log('  源码字面量 t() 键   ' + used.size);
  console.log('  EN 词条             ' + en.size);
  console.log('  JA 词条             ' + ja.size);
  console.log('  白名单              ' + wl.size);
  console.log('  拼接片段（豁免）    ' + fragments.size);
  console.log('  历史欠账（基线）    EN ' + baseEn.size + ' / JA ' + baseJa.size);
  const show = (label, arr, fixed) => {
    if (!arr.length) { console.log('  ✓ ' + label + ' 无新增缺失' + (fixed.length ? '（比基线少 ' + fixed.length + ' 条）' : '')); return; }
    console.log('  ✗ ' + label + ' 新增 ' + arr.length + ' 条未翻译：');
    for (const it of arr.slice(0, topN)) console.log('      ' + JSON.stringify(it.key) + '  ← ' + it.files.join(', '));
    if (arr.length > topN) console.log('      …（还有 ' + (arr.length - topN) + ' 条）');
  };
  show('EN', newEn, fixedEn);
  show('JA', newJa, fixedJa);
  if (fixedEn.length || fixedJa.length) console.log('  ℹ 已还清的欠账：可运行 --update-baseline 缩小基线（EN ' + fixedEn.length + ' / JA ' + fixedJa.length + '）');
}
process.exit(ok ? 0 : 1);
