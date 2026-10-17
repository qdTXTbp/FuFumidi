// ============================================================
// P1-9 存储治理（纯逻辑 + IPC 适配）
// ============================================================
// 目标：把数据根下的占用按类别算清楚，给出安全清理建议，并能安全执行清理。
// 硬规则：
//   · 曲库（midi/）永远 protected —— 清理只删「可重建」的缓存/临时/日志；
//   · 模型/音色/声库属于"资产"，默认不删，必须显式 includeAssets 才允许；
//   · 日志按保留最近 N 份，其余删；
//   · 所有删除都在传入的 area 目录下，且目录必须存在（不做任何路径拼接外的删除）。
'use strict';
const fs = require('fs');
const path = require('path');

/** 类别定义：safe=可安全清理（可重建）；protected=永不清理；asset=资产（需显式允许） */
const CATEGORY_META = {
  models: { label: '转录/分离模型', kind: 'asset' },
  soundfonts: { label: '音色库', kind: 'asset' },
  voicebanks: { label: 'UTAU 声库', kind: 'asset' },
  diffsinger: { label: 'DiffSinger 运行时', kind: 'asset' },
  diffsingerVoicebanks: { label: 'DiffSinger 声库', kind: 'asset' },
  gpuEnhancements: { label: 'GPU 增强包', kind: 'asset' },
  cache: { label: '缓存（可重建）', kind: 'safe' },
  temp: { label: '临时文件', kind: 'safe' },
  logs: { label: '日志', kind: 'safe', keepLatest: 5 },
  midi: { label: '曲库（永不清）', kind: 'protected' },
};

function statTree(dir, depth = 0) {
  if (depth > 12) return { bytes: 0, files: 0 };
  let bytes = 0, files = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { bytes: 0, files: 0 }; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        const sub = statTree(p, depth + 1);
        bytes += sub.bytes; files += sub.files;
      } else if (ent.isFile()) {
        const s = fs.statSync(p);
        bytes += s.size; files += 1;
      }
    } catch (e) { /* 单个文件读不到不影响整体 */ }
  }
  return { bytes: bytes, files: files };
}

/**
 * @param {Array<{id:string,label?:string,dir:string}>} areas
 * @returns {Promise<{areas:Array, totalBytes:number, updatedAt:number}>}
 */
async function reportStorage(areas) {
  const out = [];
  let total = 0;
  for (const a of areas || []) {
    const meta = CATEGORY_META[a.id] || { label: a.id, kind: 'safe' };
    const exists = !!(a.dir && fs.existsSync(a.dir));
    const stat = exists ? statTree(a.dir) : { bytes: 0, files: 0 };
    total += stat.bytes;
    out.push({
      id: a.id, label: meta.label, path: a.dir || '', kind: meta.kind,
      safe: meta.kind === 'safe', protected: meta.kind === 'protected',
      exists: exists, bytes: stat.bytes, files: stat.files,
    });
  }
  return { areas: out, totalBytes: total, updatedAt: Date.now() };
}

/** 清理计划：哪些 area 会被删、为什么；默认只含 safe，资产需 includeAssets */
function cleanupPlan(report, opts = {}) {
  const includeAssets = !!opts.includeAssets;
  const items = [];
  for (const a of (report && report.areas) || []) {
    if (a.protected) continue;
    if (!a.exists || a.bytes <= 0) continue;
    if (a.kind === 'asset' && !includeAssets) continue;
    items.push({ id: a.id, label: a.label, path: a.path, bytes: a.bytes, files: a.files, kind: a.kind });
  }
  return { items: items, totalBytes: items.reduce((s, x) => s + x.bytes, 0), includeAssets: includeAssets };
}

/** 日志目录只保留最近 N 个文件；返回 {removedBytes, removedFiles} */
function pruneLogs(dir, keepLatest) {
  let files = [];
  try {
    files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => { const p = path.join(dir, e.name); let mtime = 0; let size = 0; try { const st = fs.statSync(p); mtime = st.mtimeMs; size = st.size; } catch (err) {} return { p, mtime, size }; })
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) { return { removedBytes: 0, removedFiles: 0 }; }
  let removedBytes = 0, removedFiles = 0;
  for (let i = Math.max(0, Number(keepLatest) || 5); i < files.length; i++) {
    try { fs.unlinkSync(files[i].p); removedBytes += files[i].size; removedFiles += 1; } catch (e) {}
  }
  return { removedBytes: removedBytes, removedFiles: removedFiles };
}

/** 删空一个目录（保留目录本身） */
function emptyDir(dir) {
  let removedBytes = 0, removedFiles = 0;
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return { removedBytes: 0, removedFiles: 0 }; }
  for (const ent of ents) {
    const p = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        const sub = statTree(p);
        fs.rmSync(p, { recursive: true, force: true });
        removedBytes += sub.bytes; removedFiles += sub.files;
      } else if (ent.isFile()) {
        const s = fs.statSync(p);
        fs.unlinkSync(p);
        removedBytes += s.size; removedFiles += 1;
      }
    } catch (e) {}
  }
  return { removedBytes: removedBytes, removedFiles: removedFiles };
}

/**
 * 执行清理（只处理传入的 areas；protected 永远跳过；asset 需 includeAssets）
 * @returns {{ok:boolean, freedBytes:number, removed:Array, errors:string[]}}
 */
function runCleanup(areas, report, opts = {}) {
  const plan = cleanupPlan(report, opts);
  const byId = new Map((areas || []).map((a) => [a.id, a]));
  let freed = 0;
  const removed = [];
  const errors = [];
  for (const it of plan.items) {
    const area = byId.get(it.id);
    if (!area || !area.dir) continue;
    const meta = CATEGORY_META[it.id] || {};
    let r;
    if (meta.keepLatest) r = pruneLogs(area.dir, meta.keepLatest);
    else r = emptyDir(area.dir);
    freed += r.removedBytes;
    removed.push({ id: it.id, bytes: r.removedBytes, files: r.removedFiles });
  }
  return { ok: errors.length === 0, freedBytes: freed, removed: removed, errors: errors };
}

/** 注册 IPC（由 main.js 调用；areas() 返回当前数据根下的分类目录） */
function registerStorageIpc({ ipcMain, areas }) {
  if (!ipcMain || typeof areas !== 'function') return;
  ipcMain.handle('storage:report', async () => reportStorage(areas()));
  ipcMain.handle('storage:cleanup', async (_e, payload) => {
    const p = payload || {};
    try {
      const list = areas();
      const rep = await reportStorage(list);
      return runCleanup(list, rep, { includeAssets: !!p.includeAssets });
    } catch (e) {
      return { ok: false, freedBytes: 0, removed: [], errors: [String((e && e.message) || e)] };
    }
  });
}

module.exports = { CATEGORY_META, reportStorage, cleanupPlan, runCleanup, pruneLogs, emptyDir, statTree, registerStorageIpc };
