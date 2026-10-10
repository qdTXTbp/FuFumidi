// ============================================================
// 翻唱模型（SVC）注册表：导入 / 列出 / 删除 / 目录
// ------------------------------------------------------------
// 音色 = **用户导入的模型**，应用不内置、不代下载：
//
//   · 两个社区仓库（ModelScope aihobbyist/RVC_Model_Collection、ACG-DDSP-Model）
//     都是 **CC-BY-NC-4.0（禁商用、必须署名训练者）**，分发不在我们这边。
//     目录只做索引（main/svc-catalog.json，脚本 scripts/build-svc-catalog.js 生成），
//     界面把用户送到 ModelScope 页面，下载由用户自己完成，再用「导入」放进应用。
//
//   · 导入三种形态：选文件夹（登记引用，不复制）/ 逐个选文件（复制到应用目录）/ 导入 zip（解压到应用目录）。
//     ★ 引用式导入**删除时只注销条目，不删用户的原文件** —— 那可能是他的下载目录。
//
// 每个模型一份 model.json（清单）。目录里的值只是候选，真正的 version/f0/采样率
// 由引擎加载权重后 probe 出来并回写（见 engine/engine_svc.py probe）。
// ============================================================
'use strict';
const path = require('path');
const fs = require('fs');
const Paths = require('./paths');

/* ---------------- 目录与清单 ---------------- */
function svcRoot() {
  return path.join(Paths.modelsDir(), 'svc');
}
function catalogCacheFile() {
  return path.join(Paths.dataRoot(), 'svc-catalog.json');
}
function modelsDir() {
  return Paths.modelsDir();
}

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function writeJson(p, obj) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(obj, null, 1), 'utf8'); return true; }
  catch (e) { return false; }
}
function hasFile(p) { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } }
function hasDir(p) { try { return !!p && fs.statSync(p).isDirectory(); } catch (e) { return false; } }
function readdir(dir) { try { return fs.readdirSync(dir); } catch (e) { return []; } }

const DEFAULTS = {
  transpose: 0, indexRate: 0.3, filterRadius: 3, rmsMixRate: 0.25,
  protect: 0.33, f0Method: 'rmvpe', chunkSec: 60, autoPredictF0: false,
};

/* ---------------- 识别：这一堆文件到底是什么模型 ---------------- */
/**
 * 文件级识别（**不加载权重**，所以只给候选值）。
 *   RVC  ：*.pth（+ 可选同目录 *.index）
 *   DDSP ：config.yaml + *.pt（本轮登记但不接入）
 * ★ 采样率/版本这类只有加载才知道的东西，交给引擎 probe 回写；这里猜错了不致命。
 */
function detect(dir) {
  const files = readdir(dir);
  const all = [];
  for (const f of files) {
    const fp = path.join(dir, f);
    if (hasFile(fp)) all.push(f);
    else if (hasDir(fp)) for (const g of readdir(fp)) if (hasFile(path.join(fp, g))) all.push(f + '/' + g);
  }
  const pth = all.filter((f) => /\.pth$/i.test(f));
  const index = all.filter((f) => /\.index$/i.test(f));
  const pt = all.filter((f) => /\.pt$/i.test(f));
  const cfg = all.filter((f) => /(^|\/)(config|diffusion)\.ya?ml$/i.test(f));
  const manifest = readJson(path.join(dir, 'manifest.json'));
  if (manifest && manifest.engine) {
    return { engine: manifest.engine, files: manifest.files || {}, sr: manifest.sr || 0, version: manifest.version || '', from: 'manifest.json', all };
  }
  if (pth.length) {
    // 权重名里常带 sr（40k/48k/32k）—— 只当提示，probe 会校正
    const hint = /\b(32|40|48)k\b/i.exec(pth.join(' '));
    return { engine: 'rvc', files: { model: pth[0], index: index[0] || '' }, sr: hint ? parseInt(hint[1], 10) * 1000 : 0, version: '', from: 'detect', all };
  }
  if (cfg.length && pt.length) {
    return { engine: 'ddsp', files: { config: cfg[0], model: pt[0] }, sr: 0, version: '', from: 'detect', all };
  }
  return { engine: '', files: {}, sr: 0, version: '', from: 'detect', all };
}

/** 清单里的文件是否都还在（引用式导入的源目录可能被用户删掉） */
function fileState(m) {
  const dir = m.dir || '';
  const missing = [];
  let size = 0;
  for (const v of Object.values(m.files || {})) {
    if (!v) continue;
    const abs = path.isAbsolute(String(v)) ? String(v) : path.join(dir, String(v));
    if (hasFile(abs)) { try { size += fs.statSync(abs).size; } catch (e) {} }
    else missing.push(v);
  }
  return { size, missing };
}

/* ---------------- 列出 ---------------- */
function list() {
  const root = svcRoot();
  const out = [];
  for (const name of readdir(root)) {
    const dir = path.join(root, name);
    if (!hasDir(dir)) continue;
    const m = readJson(path.join(dir, 'model.json'));
    if (!m || !m.id) continue;
    const st = fileState(m);
    out.push({
      ...m,
      dir,
      size: st.size,
      missing: st.missing,
      ready: !st.missing.length && !!m.engine,
      external: !String(dir).startsWith(root),   // 引用式：指向应用目录之外
    });
  }
  // 引用式导入的模型不落在 svcRoot 下，单独登记在 index.json 里
  const idx = readJson(path.join(root, 'index.json')) || {};
  for (const [id, m] of Object.entries(idx.models || {})) {
    if (out.some((x) => x.id === id)) continue;
    const st = fileState(m);
    out.push({ ...m, size: st.size, missing: st.missing, ready: !st.missing.length && !!m.engine, external: true });
  }
  out.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh'));
  return out;
}

function find(id) {
  return list().find((m) => m.id === id) || null;
}

/* ---------------- 导入 ---------------- */
function slug(s) {
  return String(s || '').trim().replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_').slice(0, 60) || 'model';
}
function uniqueId(base) {
  const root = svcRoot();
  let id = base, i = 2;
  while (hasDir(path.join(root, id)) || find(id)) { id = base + '-' + (i++); }
  return id;
}

/** 登记一份清单：落在应用目录里的写 model.json，引用式的写 index.json */
function saveModel(m) {
  const root = svcRoot();
  fs.mkdirSync(root, { recursive: true });
  if (String(m.dir || '').startsWith(root)) {
    writeJson(path.join(m.dir, 'model.json'), m);
    return m;
  }
  const idx = readJson(path.join(root, 'index.json')) || { models: {} };
  idx.models = idx.models || {};
  idx.models[m.id] = m;
  writeJson(path.join(root, 'index.json'), idx);
  return m;
}

/**
 * 导入一个文件夹：**登记引用，不复制**（每个角色权重 + index 近 180MB，复制一份纯属浪费磁盘）。
 * ★ 代价：删除时只注销条目，不动用户的原文件。
 */
function importFolder(dir, opts) {
  const o = opts || {};
  if (!hasDir(dir)) return { ok: false, error: '目录不存在：' + dir };
  const d = detect(dir);
  if (!d.engine) {
    return { ok: false, error: '没认出这是什么模型：目录下既没有 *.pth（RVC 权重），也没有 config.yaml + *.pt（DDSP-SVC）。' };
  }
  const manifest = readJson(path.join(dir, 'manifest.json')) || {};
  const name = o.name || manifest.name || path.basename(dir);
  const m = {
    id: uniqueId(slug(o.id || manifest.id || name)),
    name,
    engine: d.engine,
    version: manifest.version || d.version || '',
    sr: Number(o.sr || manifest.sr || d.sr || 0) || 0,
    f0: manifest.f0 != null ? !!manifest.f0 : true,
    dir,
    files: o.files || manifest.files || d.files || {},
    defaults: { ...DEFAULTS, ...(manifest.defaults || {}), ...(o.defaults || {}) },
    source: 'folder',
    lang: o.lang || manifest.lang || '',
    work: o.work || manifest.work || '',
    importedAt: new Date().toISOString(),
  };
  saveModel(m);
  return { ok: true, model: m, detected: d };
}

/** 逐个选文件 + 手填元数据：文件复制到 <模型目录>/svc/<id>/ */
function importFiles(files, opts) {
  const o = opts || {};
  const picked = Object.entries(files || {}).filter(([, v]) => !!v);
  if (!picked.length) return { ok: false, error: '没有选中任何文件' };
  const root = svcRoot();
  const name = o.name || slug(path.basename(picked[0][1]).replace(/\.[^.]+$/, ''));
  const id = uniqueId(slug(o.id || name));
  const dest = path.join(root, id);
  try {
    fs.mkdirSync(dest, { recursive: true });
    const rel = {};
    for (const [k, src] of picked) {
      if (!hasFile(src)) continue;
      const target = path.join(dest, path.basename(src));
      fs.copyFileSync(src, target);
      rel[k] = path.basename(src);
    }
    const m = {
      id, name,
      engine: o.engine || (/config\.ya?ml$/i.test(rel.config || '') ? 'ddsp' : 'rvc'),
      version: o.version || '',
      sr: Number(o.sr || 0) || 0,
      f0: o.f0 !== false,
      dir: dest,
      files: rel,
      defaults: { ...DEFAULTS, ...(o.defaults || {}) },
      source: 'files',
      lang: o.lang || '', work: o.work || '',
      importedAt: new Date().toISOString(),
    };
    saveModel(m);
    return { ok: true, model: m };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 导入 zip：解压到应用目录（散文件没有可引用的家），然后按文件夹那套识别 */
function importZip(zipPath, opts) {
  const o = opts || {};
  if (!hasFile(zipPath)) return { ok: false, error: '压缩包不存在：' + zipPath };
  let AdmZip;
  try { AdmZip = require('adm-zip'); } catch (e) { return { ok: false, error: '缺少 adm-zip' }; }
  const root = svcRoot();
  const base = slug(path.basename(zipPath).replace(/\.(zip|7z|rar)$/i, ''));
  const id = uniqueId(slug(o.id || base));
  const dest = path.join(root, id);
  try {
    const z = new AdmZip(zipPath);
    z.extractAllTo(dest, true);
    // 包里可能多一层目录：找到真正装着权重的那一层
    let dir = dest;
    const inner = readdir(dest).filter((f) => hasDir(path.join(dest, f)));
    if (inner.length === 1 && !detect(dest).engine) dir = path.join(dest, inner[0]);
    const r = importFolder(dir, { ...o, id, name: o.name || base });
    if (!r.ok) { try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {} return r; }
    // 解压出来的目录就是它的家 → 物理删除时删的是应用目录里这份，不动用户原文件
    const m = { ...r.model, source: 'zip' };
    saveModel(m);
    return { ok: true, model: m };
  } catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch (_) {}
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 删除：只删**应用目录里**的那份；引用式（源目录在别处）只注销条目 */
function remove(id) {
  const m = find(id);
  if (!m) return { ok: false, error: 'not found' };
  const root = svcRoot();
  try {
    if (String(m.dir || '').startsWith(root)) fs.rmSync(m.dir, { recursive: true, force: true });
    const idx = readJson(path.join(root, 'index.json'));
    if (idx && idx.models && idx.models[id]) {
      delete idx.models[id];
      writeJson(path.join(root, 'index.json'), idx);
    }
    return { ok: true, removedPhysical: String(m.dir || '').startsWith(root) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ---------------- 目录（ModelScope 索引快照） ---------------- */
function builtinCatalog() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'svc-catalog.json'), 'utf8')); }
  catch (e) { return { generated: '', repos: [], langs: [], works: [], models: [] }; }
}
/** 内置快照 + 在线刷新过的缓存（缓存新就用缓存） */
function catalog() {
  const base = builtinCatalog();
  const cache = readJson(catalogCacheFile());
  if (cache && cache.generated && cache.generated > (base.generated || '')) return cache;
  return base;
}
/** 在线刷新：重新拉文件树，写一份缓存到数据目录（失败不影响内置快照） */
async function refreshCatalog(net) {
  const url = 'https://www.modelscope.cn/api/v1/models/aihobbyist/RVC_Model_Collection/repo/files?Revision=master&Recursive=True';
  const body = await new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'GET', headers: { 'user-agent': 'FuFumidi' } });
    let buf = '';
    req.on('response', (res) => {
      res.on('data', (c) => { buf += String(c); });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.end();
  });
  const j = JSON.parse(body);
  const files = ((j && j.Data && j.Data.Files) || []).filter((f) => f.Type === 'blob');
  // 与 scripts/build-svc-catalog.js 同一套规则（避免两处逻辑走偏）
  const byDir = new Map();
  for (const f of files) {
    if (!/\.pth$/i.test(f.Name)) continue;
    const dir = f.Path.split('/').slice(0, -1).join('/');
    if (!byDir.has(dir)) byDir.set(dir, { pth: f, index: null });
  }
  for (const f of files) {
    if (!/\.index$/i.test(f.Name)) continue;
    const e = byDir.get(f.Path.split('/').slice(0, -1).join('/'));
    if (e) e.index = f;
  }
  const LANGS = ['中文', '日语', '英语', '韩语'];
  const models = [];
  for (const [dir, e] of byDir) {
    const parts = dir.split('/');
    const gen = parts[0] || '';
    const sr = /40k/.test(gen) ? 40000 : /48k/.test(gen) ? 48000 : /32k/.test(gen) ? 32000 : 0;
    const hasLang = parts.length > 3 && LANGS.indexOf(parts[2]) >= 0;
    models.push({
      id: 'rvc:' + dir, name: parts[parts.length - 1] || '', work: parts[1] || '',
      lang: hasLang ? parts[2] : '未标语言', sr, gen, engine: 'rvc', repo: 'rvc',
      pth: e.pth.Path, pthSize: e.pth.Size || 0,
      index: e.index ? e.index.Path : '', indexSize: e.index ? e.index.Size || 0 : 0,
    });
  }
  const prev = catalog();
  const next = { ...prev, generated: new Date().toISOString(), refreshed: true, models: models.concat(prev.models.filter((m) => m.engine !== 'rvc')) };
  writeJson(catalogCacheFile(), next);
  return { ok: true, count: models.length, generated: next.generated };
}

/* ---------------- 给模型管理页的展示文案 ---------------- */
const ENGINE_LABEL = { rvc: 'RVC', ddsp: 'DDSP-SVC' };
function archLabel(m) {
  const eng = ENGINE_LABEL[m.engine] || (m.engine || '未知');
  const sr = m.sr ? (m.sr / 1000) + 'k' : '';
  return [eng, m.version, sr].filter(Boolean).join(' · ');
}
function useLabel(m) {
  const bits = [];
  if (m.work) bits.push(m.work);
  if (m.lang && m.lang !== '未标语言') bits.push(m.lang);
  return bits.join(' / ') || '翻唱音色（导入）';
}
function noteLabel(m) {
  if (!m.ready) return m.missing && m.missing.length ? ('缺文件：' + m.missing.join('、')) : '引擎未识别';
  if (m.engine === 'ddsp') return 'DDSP-SVC 尚未支持（.sf_pkg 是 SVC-Fusion 专用封装）';
  return m.external ? '引用式导入（源目录在应用外，删除只注销条目）' : '已导入';
}

/* ---------------- IPC ---------------- */
function registerSvcIpc({ ipcMain, BrowserWindow, path: _path, fs: _fs, dialog, shell, spawnEngine, engineEnv, net }) {
  ipcMain.handle('svc:list', async () => {
    try { return { ok: true, models: list(), root: svcRoot() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('svc:catalog', async () => {
    try { return { ok: true, catalog: catalog() }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('svc:refreshCatalog', async () => {
    try { return await refreshCatalog(net); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('svc:pickFolder', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const r = await dialog.showOpenDialog(win, { title: '选择模型目录（含 .pth 权重）', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    const dir = r.filePaths[0];
    const d = detect(dir);
    return { ok: true, dir, detected: d };
  });

  ipcMain.handle('svc:pickFiles', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择模型文件（.pth 权重 / .index / config.yaml）',
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '模型文件', extensions: ['pth', 'pt', 'index', 'yaml', 'yml', 'json'] }, { name: '全部文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    return { ok: true, files: r.filePaths };
  });

  ipcMain.handle('svc:pickZip', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择模型压缩包', properties: ['openFile'],
      filters: [{ name: '压缩包', extensions: ['zip'] }, { name: '全部文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    return { ok: true, path: r.filePaths[0] };
  });

  ipcMain.handle('svc:importFolder', async (_e, dir, opts) => {
    try { return importFolder(dir, opts || {}); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('svc:importFiles', async (_e, files, opts) => {
    try { return importFiles(files || {}, opts || {}); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('svc:importZip', async (_e, p, opts) => {
    try { return importZip(p, opts || {}); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('svc:remove', async (_e, id) => remove(id));

  /** probe：让引擎读权重，把真实的 version / f0 / 采样率回写清单 */
  ipcMain.handle('svc:probe', async (_e, id) => {
    const m = find(id);
    if (!m) return { ok: false, error: '模型不存在：' + id };
    return new Promise((resolve) => {
      let out = '';
      spawnEngine(['probe', '--model', String(m.dir)], {
        script: 'engine_svc.py',
        timeoutMs: 5 * 60 * 1000,
        env: engineEnv({}),
        onLog: (line) => { out += line + '\n'; },
        onDone: (code, info) => {
          const res = (info && info.result) || null;
          if (res && res.ok) {
            // ★ 以权重实际值为准：清单与实测不一致就回写，并在返回里说明改了什么
            const patch = {};
            for (const k of ['version', 'sr', 'f0', 'engine']) {
              if (res[k] != null && String(res[k]) !== String(m[k])) patch[k] = res[k];
            }
            if (Object.keys(patch).length) saveModel({ ...m, ...patch });
            resolve({ ok: true, model: { ...m, ...patch }, patched: patch, raw: res });
          } else {
            resolve({ ok: false, error: (res && res.error) || out.slice(-400) || ('退出码 ' + code) });
          }
        },
        onError: (msg) => resolve({ ok: false, error: String(msg) }),
      });
    });
  });

  ipcMain.handle('svc:openCatalogPage', async (_e, url) => {
    try { if (url) await shell.openExternal(String(url)); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  return { list, find, importFolder, importFiles, importZip, remove, catalog, refreshCatalog };
}

module.exports = {
  svcRoot, catalogCacheFile, modelsDir,
  list, find, detect, fileState,
  importFolder, importFiles, importZip, remove,
  catalog, refreshCatalog, builtinCatalog,
  archLabel, useLabel, noteLabel,
  registerSvcIpc,
};
