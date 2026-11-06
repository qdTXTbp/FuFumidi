#!/usr/bin/env node
// ============================================================================
// 模型规格契约静态检查（只读源码，不启应用、不联网）
//
// 对比：
//   main/models.js 的 MODEL_REGISTRY（Electron 侧权威清单）
//   shells/tauri/src/**/*.rs 的 Tauri 模型清单（两种实现都兼容）：
//     - 旧式：push_model(&mut items, "id", ...)
//     - 新式：model_service.rs 的 SPECS: &[ModelSpec]（含 dl: Dl::* 下载定义）
//   以及 Tauri 的下载定义（Dl::File/Zip/Parts/Gsplit/Hf，或旧式 model_download_urls/zip）
//
// 判定：
//   - 结构性错误（ERROR）：重复 id、无法解析、Tauri include_str! 依赖的文件缺失
//   - 不一致（WARN）：Electron 有而 Tauri 未列 / Tauri 多列 / kind 不一致 / 下载定义缺口
//   - 允许 WARN：迁移进行中，Tauri 侧尚未覆盖全部模型是预期状态
//
// 退出码：0 = 完全一致；3 = 仅有 WARN；1 = 有 ERROR。
// 用法：node scripts/tauri/model-contract-check.mjs [--json]
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const MODELS_JS = path.join(ROOT, 'main', 'models.js');
const TAURI_SRC = path.join(ROOT, 'shells', 'tauri', 'src');
const MSST_CATALOG = path.join(ROOT, 'frontend', 'public', 'models-msst-catalog.json');
const AS_JSON = process.argv.includes('--json');

const errors = [];
const warns = [];
const err = (message) => errors.push(message);
const warn = (message) => warns.push(message);

/* --------------------------- 通用字面量扫描器 --------------------------- */
const BACKTICK = String.fromCharCode(96);
function skipString(src, i) {
  const quote = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === '\\') { j++; continue; }
    if (src[j] === quote) return j;
  }
  return src.length - 1;
}
// 从 open 处找配对的 closeChar，跳过字符串与注释（openChar/closeChar 必须成对）。
function findMatchingPair(src, open, openChar, closeChar) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === BACKTICK) { i = skipString(src, i); continue; }
    if (c === '/' && src[i + 1] === '/') { const n = src.indexOf('\n', i); if (n < 0) return -1; i = n; continue; }
    if (c === '/' && src[i + 1] === '*') { const n = src.indexOf('*/', i + 2); if (n < 0) return -1; i = n + 1; continue; }
    if (c === openChar) depth++;
    else if (c === closeChar) { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function blockAfter(src, re, what) {
  const m = re.exec(src);
  if (!m) { err('无法定位 ' + what); return null; }
  const open = src.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) { err(what + ' 缺少对象起始 { '); return null; }
  const close = findMatchingPair(src, open, '{', '}');
  if (close < 0) { err(what + ' 花括号不配对'); return null; }
  return src.slice(open, close + 1);
}
// 可选定位：重构后某些函数可能已迁走/改名，找不到不算错误。
function blockAfterOptional(src, re) {
  const m = re.exec(src);
  if (!m) return null;
  const open = src.indexOf('{', m.index + m[0].length - 1);
  if (open < 0) return null;
  const close = findMatchingPair(src, open, '{', '}');
  if (close < 0) return null;
  return src.slice(open, close + 1);
}

/* --------------------- 0) 读取 Tauri 侧全部 Rust 源文件 ----------------- */
const rustFiles = [];
if (fs.existsSync(TAURI_SRC)) {
  for (const name of fs.readdirSync(TAURI_SRC)) {
    if (!name.endsWith('.rs')) continue;
    const p = path.join(TAURI_SRC, name);
    if (fs.statSync(p).isFile()) rustFiles.push({ name, path: p, src: fs.readFileSync(p, 'utf8') });
  }
} else {
  err('缺少目录 shells/tauri/src');
}
if (rustFiles.length === 0) err('shells/tauri/src 下没有 .rs 源文件');
const allRs = rustFiles.map((f) => f.src).join('\n');
const findFile = (needle) => rustFiles.find((f) => f.src.includes(needle)) || null;

/* ------------------------ 1) Electron MODEL_REGISTRY ------------------- */
if (!fs.existsSync(MODELS_JS)) err('缺少 main/models.js');
const modelsJs = fs.existsSync(MODELS_JS) ? fs.readFileSync(MODELS_JS, 'utf8') : '';
let registryBlock = '';
if (modelsJs) {
  const idx = modelsJs.indexOf('const MODEL_REGISTRY = {');
  if (idx < 0) {
    err('main/models.js 中找不到 const MODEL_REGISTRY = {');
  } else {
    const open = modelsJs.indexOf('{', idx);
    const close = findMatchingPair(modelsJs, open, '{', '}');
    if (close < 0) err('MODEL_REGISTRY 花括号不配对');
    else registryBlock = modelsJs.slice(open, close + 1);
  }
}

const registry = []; // { key, id, kind, downloadable, hasUrl, hasParts, type, dest }
if (registryBlock) {
  const entryRe = /^ {4}([A-Za-z_$][\w$]*):\s*\{/gm;
  let m;
  while ((m = entryRe.exec(registryBlock))) {
    const open = m.index + m[0].length - 1;
    const close = findMatchingPair(registryBlock, open, '{', '}');
    if (close < 0) { err('MODEL_REGISTRY 条目 ' + m[1] + ' 花括号不配对'); continue; }
    const body = registryBlock.slice(open, close + 1);
    const id = (body.match(/\bid:\s*'([^']*)'/) || [])[1] || null;
    const kind = (body.match(/\bkind:\s*'([^']*)'/) || [])[1] || null;
    const downloadable = /^\s*downloadable:\s*true/m.test(body);
    const hasUrl = /^\s*url:\s*'/m.test(body);
    const hasParts = /^\s*parts:\s*\[/m.test(body);
    const type = (body.match(/\btype:\s*'([^']*)'/) || [])[1] || null;
    const key = m[1];
    if (!id) warn('MODEL_REGISTRY 条目 ' + key + ' 没有解析到 id');
    if (id && id !== key) warn('MODEL_REGISTRY 键名与 id 不一致：key=' + key + ' id=' + id);
    registry.push({ key, id: id || key, kind, downloadable, hasUrl, hasParts, type });
  }
  if (registry.length === 0) err('MODEL_REGISTRY 中未解析出任何条目');
}

const registryIds = new Set();
for (const e of registry) {
  if (registryIds.has(e.id)) err('MODEL_REGISTRY 重复 id: ' + e.id);
  registryIds.add(e.id);
}

/* ------------------- 2) Tauri 模型清单（新式 SPECS 优先） --------------- */
const tauriIds = new Set();
const tauriKind = new Map();
const downloadCovered = new Set();
let modelListSource = null;
let specMode = false;

// 2a) 新式：const SPECS: &[ModelSpec] = &[ ... ]，每项含 id/kind/dl
const specFile = findFile('ModelSpec');
if (specFile) {
  const specArray = (() => {
    const m = /(?:pub\s+)?const\s+SPECS\s*:\s*&\[ModelSpec\]\s*=\s*&\[/.exec(specFile.src);
    if (!m) return null;
    const open = specFile.src.indexOf('[', m.index + m[0].length - 1);
    const close = findMatchingPair(specFile.src, open, '[', ']');
    return close < 0 ? null : specFile.src.slice(open, close + 1);
  })();
  if (specArray) {
    specMode = true;
    modelListSource = specFile.name + ' SPECS';
    const entryRe = /ModelSpec\s*\{/g;
    let m;
    while ((m = entryRe.exec(specArray))) {
      const open = m.index + m[0].length - 1;
      const close = findMatchingPair(specArray, open, '{', '}');
      if (close < 0) { err('SPECS 中存在花括号不配对的 ModelSpec'); continue; }
      const body = specArray.slice(open, close + 1);
      const id = (body.match(/\bid:\s*"([^"]+)"/) || [])[1] || null;
      if (!id) { warn('SPECS 中有 ModelSpec 未解析到 id'); continue; }
      const kind = (body.match(/\bkind:\s*"([^"]+)"/) || [])[1] || null;
      const dlVariant = (body.match(/\bdl:\s*Dl::(\w+)/) || [])[1] || 'None';
      if (tauriIds.has(id)) err('Tauri SPECS 重复 id: ' + id);
      tauriIds.add(id);
      if (kind) tauriKind.set(id, kind);
      if (dlVariant !== 'None') downloadCovered.add(id);
    }
  }
}

// 2b) 旧式：push_model(&mut items, "id", "name", "kind", ...)
if (!specMode) {
  const pushRe = /push_model\(\s*&mut\s+items,\s*"([^"]+)",\s*"([^"]*)",\s*"([^"]+)"/g;
  let m;
  for (const f of rustFiles) {
    while ((m = pushRe.exec(f.src))) {
      if (tauriIds.has(m[1])) err('Tauri 模型清单重复 id: ' + m[1]);
      tauriIds.add(m[1]);
      tauriKind.set(m[1], m[3]);
      downloadCovered.add(m[1]); // push_model 统一 downloadable=true
    }
    const literalRe = /push_model\(\s*&mut\s+items,\s*"([^"]+)"/g;
    while ((m = literalRe.exec(f.src))) if (!tauriIds.has(m[1])) tauriIds.add(m[1]);
  }
  const listFn = findFile('push_model');
  if (listFn) modelListSource = listFn.name + ' push_model';
}

// 2c) 模型列表里内联 json! 条目（内置模型，如 basic_pitch / htdemucs4_6stems）
for (const f of rustFiles) {
  const lm = /fn (?:list_with_state|model_list)\s*\([^)]*\)[^{]*\{/.exec(f.src);
  if (!lm) continue;
  const listBody = blockAfter(f.src, /fn (?:list_with_state|model_list)\s*\([^)]*\)[^{]*\{/, 'fn model_list/list_with_state');
  if (!listBody) continue;
  const idRe = /"id":\s*"([^"]+)"/g;
  let m;
  while ((m = idRe.exec(listBody))) {
    if (!tauriIds.has(m[1])) {
      tauriIds.add(m[1]);
      const window = listBody.slice(m.index, m.index + 600);
      const kind = (window.match(/"kind":\s*"([^"]+)"/) || [])[1];
      if (kind) tauriKind.set(m[1], kind);
    }
  }
}

// 2d) 旧式下载定义（函数名兼容前后缀），作为 SPECS 之外的正交信息
for (const f of rustFiles) {
  for (const fnName of ['model_download_urls', 'model_download_zip']) {
    const body = blockAfterOptional(f.src, new RegExp('fn ' + fnName + '\\s*\\([^)]*\\)[^{]*\\{'));
    if (!body) continue;
    const armRe = /"([A-Za-z0-9_]+)"\s*=>/g;
    let m;
    while ((m = armRe.exec(body))) downloadCovered.add(m[1]);
  }
}
for (const f of rustFiles) {
  const body = blockAfterOptional(f.src, /(?:async\s+)?fn model_download\s*\([^)]*\)[^{]*\{/);
  if (!body) continue;
  const re = /id\s*==\s*"([A-Za-z0-9_]+)"/g;
  let m;
  while ((m = re.exec(body))) downloadCovered.add(m[1]);
}
const msstHandled = /id\.starts_with\(\s*"msst:"/.test(allRs) || /msst:/.test(allRs);
const muscriptorHandled = /id\s*==\s*"muscriptor_/.test(allRs);

if (tauriIds.size === 0) err('Tauri 侧未解析出任何模型条目');

/* ------------------------------ 3) 比对 -------------------------------- */
const isDynamicTauriId = (id) => id.startsWith('msst:');
const missingInTauri = registry.filter((e) => !tauriIds.has(e.id) && !(msstHandled && /^msst/i.test(e.id))).map((e) => e.id);
const extraInTauri = [...tauriIds].filter((id) => !registryIds.has(id) && !isDynamicTauriId(id)).sort();
const kindMismatches = [];
for (const e of registry) {
  const tk = tauriKind.get(e.id);
  if (e.kind && tk && e.kind !== tk) kindMismatches.push({ id: e.id, electron: e.kind, tauri: tk });
}
const downloadGaps = [];
for (const e of registry) {
  if (!e.downloadable) continue;
  if (downloadCovered.has(e.id)) continue;
  if (msstHandled && /^msst/i.test(e.id)) continue;
  if (muscriptorHandled && /^muscriptor_/.test(e.id)) continue;
  downloadGaps.push({ id: e.id, hasUrl: e.hasUrl, hasParts: e.hasParts, type: e.type });
}
const downloadOrphans = [...downloadCovered].filter((id) => !registryIds.has(id) && !isDynamicTauriId(id)).sort();

if (missingInTauri.length) warn('Electron MODEL_REGISTRY 中 ' + missingInTauri.length + ' 个条目在 Tauri 侧未列出：' + missingInTauri.join(', '));
if (extraInTauri.length) warn('Tauri 侧 ' + extraInTauri.length + ' 个条目不在 MODEL_REGISTRY（内置/动态条目属预期）：' + extraInTauri.join(', '));
for (const km of kindMismatches) warn('kind 不一致 ' + km.id + '：Electron=' + km.electron + ' / Tauri=' + km.tauri);
for (const g of downloadGaps) warn('下载定义缺口 ' + g.id + '（Electron downloadable=true，Tauri 侧无下载定义）');
if (downloadOrphans.length) warn('Tauri 下载定义指向 MODEL_REGISTRY 之外的 id：' + downloadOrphans.join(', '));

if (!fs.existsSync(MSST_CATALOG)) {
  err('缺少 frontend/public/models-msst-catalog.json（Tauri 编译期 include_str! 读取）');
} else {
  try {
    const cat = JSON.parse(fs.readFileSync(MSST_CATALOG, 'utf8'));
    if (!Array.isArray(cat) || cat.length === 0) warn('models-msst-catalog.json 不是非空数组');
  } catch (e) {
    err('models-msst-catalog.json 不是合法 JSON：' + ((e && e.message) || e));
  }
}

/* ------------------------------ 4) 输出 -------------------------------- */
const summary = {
  electronRegistryEntries: registry.length,
  tauriModelListEntries: [...tauriIds].filter((id) => !isDynamicTauriId(id)).length,
  tauriListSource: modelListSource,
  specMode,
  tauriDynamicMsst: Boolean(msstHandled),
  tauriDownloadDefinitions: downloadCovered.size,
  missingInTauri,
  extraInTauri,
  kindMismatches,
  downloadGaps,
  downloadOrphans,
  registryIds: [...registryIds],
  tauriIds: [...tauriIds],
};
const result = {
  ok: errors.length === 0 && warns.length === 0,
  errors,
  warns,
  summary,
  sources: {
    electron: 'main/models.js',
    tauri: rustFiles.map((f) => 'shells/tauri/src/' + f.name),
    catalog: 'frontend/public/models-msst-catalog.json',
  },
};

if (AS_JSON) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const tag = errors.length ? 'FAIL' : warns.length ? 'WARN' : 'OK';
  console.log('[model-contract] ' + tag + ' · Electron ' + registry.length + ' 条 / Tauri ' + summary.tauriModelListEntries + ' 条（' + (modelListSource || '未识别') + '） / 下载定义 ' + downloadCovered.size + ' 个');
  for (const e of errors) console.log('  ERROR ' + e);
  for (const w of warns) console.log('  WARN  ' + w);
}
process.exit(errors.length ? 1 : warns.length ? 3 : 0);
