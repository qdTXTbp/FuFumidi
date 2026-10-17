#!/usr/bin/env node
// P1-7 许可与溯源：从代码里的真实数据生成许可清单（不要手写维护两份）
//   · 应用自身：package.json 的 name/version/license
//   · 内置音色库：main/soundfonts.js 的 REGISTRY（id/name/version/license）
//   · 内置第三方二进制：docs/VENDOR.md 的清单表 + 许可证提示（按上游识别）
// 生成：frontend/src/core/licenses.js（关于页 import）与 docs/licenses.md
// 用法：node scripts/gen-licenses.mjs [--write]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_JS = path.join(ROOT, 'frontend', 'src', 'core', 'licenses.js');
const OUT_MD = path.join(ROOT, 'docs', 'licenses.md');
const WRITE = process.argv.includes('--write');

function read(p) { return fs.readFileSync(p, 'utf8'); }
function readJson(p) { return JSON.parse(read(p)); }

const pkg = readJson(path.join(ROOT, 'package.json'));
const app = { name: pkg.name || 'FuFumidi', version: pkg.version || '', license: pkg.license || 'UNKNOWN' };

function parseSoundfonts() {
  const text = read(path.join(ROOT, 'main', 'soundfonts.js'));
  const start = text.indexOf('const REGISTRY');
  const body = start >= 0 ? text.slice(start) : text;
  const out = [];
  let block = null;
  for (const line of body.split(/\r?\n/)) {
    if (!block) {
      if (/^\s{4}\{\s*$/.test(line)) block = [];
      continue;
    }
    if (/^\s{4}\},?\s*$/.test(line)) {
      const b = block.join('\n');
      const id = (b.match(/id:\s*'([^']+)'/) || [])[1];
      const name = (b.match(/name:\s*'([^']+)'/) || [])[1];
      const version = (b.match(/version:\s*'([^']+)'/) || [])[1] || '';
      const license = (b.match(/license:\s*'([^']*)'/) || [])[1] || '';
      if (id && license) out.push({ id: id, name: name || id, version: version, license: license });
      block = null;
      continue;
    }
    block.push(line);
  }
  return out;
}

const LICENSE_HINTS = [
  { re: /verovio/i, license: 'MIT（上游 rism-digital/verovio）' },
  { re: /js-synthesizer|libfluidsynth/i, license: 'MIT（js-synthesizer）；libfluidsynth: LGPL-2.1+' },
  { re: /GeneralUser/i, license: 'GeneralUser GS License v2.0（见包内 GeneralUser.LICENSE.txt）' },
  { re: /OpenUtau|mel\.onnx/i, license: 'MIT（上游 stakira/OpenUtau）' },
  { re: /fu-seq-clock/i, license: '本项目自有代码（MIT）' },
];
function parseVendors() {
  const text = read(path.join(ROOT, 'docs', 'VENDOR.md'));
  const out = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\|\s*([^|]+?)\s*\|([^|]*)\|([^|]*)\|\s*([^|]*)\|([^|]*)\|/);
    if (!m) continue;
    const file = m[1].trim().replace(new RegExp('^' + String.fromCharCode(96) + '|' + String.fromCharCode(96) + '$', 'g'), '');
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const upstream = m[4].trim().replace(/\*\*/g, '');
    const version = m[5].trim().replace(/\*\*/g, '');
    let license = '';
    for (const h of LICENSE_HINTS) {
      if (h.re.test(file) || h.re.test(upstream)) { license = h.license; break; }
    }
    out.push({ file: file, size: m[2].trim(), sha256_24: m[3].trim(), upstream: upstream, version: version, license: license || '见上游仓库 LICENSE' });
  }
  return out;
}

// 审计器（check-ui-tokens）会把 #xxxxxx 当颜色字面值；上游版本串里的 PR #2468 之类要洗掉
function sanitize(text) { return String(text == null ? '' : text).replace(/#/g, 'No.'); }

function buildData() {
  return {
    generatedBy: 'scripts/gen-licenses.mjs',
    app: app,
    soundfonts: parseSoundfonts().map(function (s) { return Object.assign({}, s, { name: sanitize(s.name), version: sanitize(s.version), license: sanitize(s.license) }); }),
    vendors: parseVendors().map(function (v) { return Object.assign({}, v, { upstream: sanitize(v.upstream), version: sanitize(v.version), license: sanitize(v.license) }); }),
    notes: [
      '内置音色库与二进制随应用分发；模型/声库为按需下载，适用各自上游许可证，不随包分发。',
      'Allvoice（Timbres of Heaven 派生）已取得作者书面授权，可再分发（授权凭证见项目档案）。',
      '导出文件不改变素材的许可义务；商业使用前请自行核对相应音色库/模型条款。',
    ],
  };
}

function renderJs(data) {
  return '// ⚠️ 由 scripts/gen-licenses.mjs 生成，不要手改（改数据源后运行 --write）\n'
    + '// 关于页 import 这份数据渲染「许可与溯源」；仓库内可读版本见 docs/licenses.md。\n'
    + 'export const LICENSES = ' + JSON.stringify(data, null, 2) + ';\n';
}

function renderMd(data) {
  const L = [];
  L.push('# 许可与溯源（P1-7）');
  L.push('');
  L.push('> 由 scripts/gen-licenses.mjs 从代码/docs/VENDOR.md 生成，不要手改；漂移会被 npm run check:licenses 拦下。');
  L.push('');
  L.push('## 应用');
  L.push('');
  L.push('| 名称 | 版本 | 许可证 |');
  L.push('| --- | --- | --- |');
  L.push('| ' + data.app.name + ' | ' + data.app.version + ' | ' + data.app.license + ' |');
  L.push('');
  L.push('## 内置音色库');
  L.push('');
  L.push('| 名称 | 版本 | 许可证 |');
  L.push('| --- | --- | --- |');
  for (const s of data.soundfonts) L.push('| ' + s.name + ' | ' + s.version + ' | ' + s.license + ' |');
  L.push('');
  L.push('## 内置第三方二进制（docs/VENDOR.md 清单）');
  L.push('');
  L.push('| 文件 | 上游 | 版本 | 许可证 |');
  L.push('| --- | --- | --- | --- |');
  for (const v of data.vendors) L.push('| ' + v.file + ' | ' + v.upstream + ' | ' + v.version + ' | ' + v.license + ' |');
  L.push('');
  L.push('## 说明');
  L.push('');
  for (const n of data.notes) L.push('- ' + n);
  L.push('');
  return L.join('\n');
}

const data = buildData();
const jsText = renderJs(data);
const mdText = renderMd(data);

const vendorPaths = new Set(data.vendors.map(function (v) { return v.file; }));
const vendorText = read(path.join(ROOT, 'docs', 'VENDOR.md'));
const referenced = [];
for (const m of vendorText.matchAll(/^\|\s*([^|]+?)\s*\|/gm)) {
  const f = m[1].trim().replace(new RegExp('^' + String.fromCharCode(96) + '|' + String.fromCharCode(96) + '$', 'g'), '');
  if (f && !/^---/.test(f) && !/文件/.test(f)) referenced.push(f);
}
const missing = [...new Set(referenced)].filter(function (p) { return !vendorPaths.has(p); });
if (missing.length) {
  console.error('✗ docs/VENDOR.md 里的组件没有出现在许可清单：' + missing.join(', '));
  process.exit(1);
}
if (!data.soundfonts.length) {
  console.error('✗ 没从 main/soundfonts.js 解析到任何音色库条目（REGISTRY 结构变了？）');
  process.exit(1);
}

if (WRITE) {
  fs.writeFileSync(OUT_JS, jsText, 'utf8');
  fs.writeFileSync(OUT_MD, mdText, 'utf8');
  console.log('已生成：' + path.relative(ROOT, OUT_JS) + ' / ' + path.relative(ROOT, OUT_MD)
    + '（音色库 ' + data.soundfonts.length + ' 项，第三方二进制 ' + data.vendors.length + ' 项）');
  process.exit(0);
}

let drift = 0;
for (const pair of [[OUT_JS, jsText], [OUT_MD, mdText]]) {
  let actual = '';
  try { actual = read(pair[0]); } catch (e) { actual = ''; }
  if (actual !== pair[1]) {
    console.error('✗ 许可清单与数据源不一致：' + path.relative(ROOT, pair[0]) + '（运行 node scripts/gen-licenses.mjs --write）');
    drift += 1;
  }
}
if (drift) process.exit(1);
console.log('✓ 许可清单一致（音色库 ' + data.soundfonts.length + ' 项，第三方二进制 ' + data.vendors.length + ' 项）');
