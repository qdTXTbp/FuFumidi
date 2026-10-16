// ============================================================
// 用户元数据底座：按 "<kind>:<id>" 存用户对条目的改动
// ============================================================
// 为什么必须是**独立表**、不能写进各处的清单：
//   资源中心四页的数据来自四套后端（model:list / utau:voicebankRegistry / DiffSinger 声库目录 /
//   音色工坊的 sf-workshop:list），结构各不相同，且它们**每次刷新都会重算**。
//   用户改的名字、排序、标签如果写进那些结构里，刷新即丢。
//
// 落点：数据根（paths.dataRoot()）—— 与模型 / 声库 / presets.json 同一处。
//       整包更新替换的是 resources/，不会碰这里。
//
// 结构：{ "schema_version": 1, "items": { "<kind>:<id>": { name, author, source,
//         tags: [], category, order, pinned } } }
//   kind 白名单：model（调教模型）| utau（UTAU 声库）| ds（DiffSinger 声库）
//               | sf（音色库）| voice（GPT-SoVITS 音色）
//   空字段一律**不写**：空 = 用原始名/原始值，这样"用户到底改了什么"一眼可见。
//
// ★ 迁移纪律：只加分支、不改老分支；解析失败时先把坏文件另存为
//   usermeta.corrupt-<时间戳>.json 再重建 —— 绝不静默丢用户数据。
'use strict';

const fsMod = require('fs');
const pathMod = require('path');

const SCHEMA_VERSION = 1;
/** 允许的 kind：白名单 + 拒绝。前端传错 kind 时不写盘，免得变成静默丢数据。 */
const KINDS = ['model', 'utau', 'ds', 'sf', 'voice'];
const STR_FIELDS = ['name', 'author', 'source', 'category'];
const MAX_TAGS = 24;

/** 元数据条目：只保留用户**真正改过**的字段（空值一律不写）。 */
function cleanItem(item) {
  const src = item || {};
  const o = {};
  for (const f of STR_FIELDS) {
    const v = src[f];
    if (typeof v === 'string' && v.trim()) o[f] = v.trim();
  }
  if (Array.isArray(src.tags)) {
    const tags = src.tags.map((t) => String(t == null ? '' : t).trim()).filter(Boolean);
    const uniq = tags.filter((t, i) => tags.indexOf(t) === i).slice(0, MAX_TAGS);
    if (uniq.length) o.tags = uniq;      // 清空标签 = 删掉这个键，不写空数组
  }
  if (typeof src.order === 'number' && Number.isFinite(src.order)) o.order = Math.trunc(src.order);
  if (src.pinned === true) o.pinned = true;   // 只有 true 有意义
  return o;
}

function createUserMeta(opts) {
  const o = opts || {};
  const fs = o.fs || fsMod;
  const path = o.path || pathMod;
  const rootDir = () => (typeof o.root === 'function' ? o.root() : o.root);
  const filePath = () => path.join(rootDir(), 'usermeta.json');
  const blank = () => ({ schema_version: SCHEMA_VERSION, items: {} });

  /** 结构迁移：只加分支、不改老分支。 */
  function migrate(data) {
    const v = data.schema_version || 0;
    if (!data.items || typeof data.items !== 'object' || Array.isArray(data.items)) data.items = {};
    if (v < 1) {
      // v1 = 首个版本：把每个条目里的未知/空字段剔掉（早期手写文件可能带杂项）
      const items = {};
      for (const k of Object.keys(data.items)) {
        const it = cleanItem(data.items[k]);
        if (Object.keys(it).length) items[k] = it;
      }
      data.items = items;
    }
    data.schema_version = SCHEMA_VERSION;
    return data;
  }

  function load() {
    let raw = null;
    try { raw = fs.readFileSync(filePath(), 'utf8'); }
    catch (e) { return blank(); }                    // 还没有文件 = 全新用户，不是错误
    let data = null;
    try {
      data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('顶层不是对象');
    } catch (e) {
      // ★ 文件坏了：先留证据再重建。用户的元数据不能因为一次解析失败就消失。
      try {
        const bak = filePath().replace(/\.json$/, '') + '.corrupt-' + Date.now() + '.json';
        fs.renameSync(filePath(), bak);
        if (o.onCorrupt) o.onCorrupt(bak, e);
      } catch (e2) { /* 备份也失败就只能重建，但至少不会写坏原文件 */ }
      return blank();
    }
    return migrate(data);
  }

  function save(data) {
    const p = filePath();
    const tmp = p + '.tmp';
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
      fs.renameSync(tmp, p);       // 同卷 rename 原子：不会留下半个 JSON
      return true;
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      return false;
    }
  }

  const key = (kind, id) => String(kind) + ':' + String(id == null ? '' : id);
  function valid(kind, id) {
    return KINDS.indexOf(String(kind)) >= 0 && String(id == null ? '' : id).trim() !== '';
  }

  /** 合并写入：只动传入的字段，其余保留；把某字段清空 = 删掉它（回到原始值）。 */
  function setItem(kind, id, patch) {
    if (!valid(kind, id)) return { ok: false, error: '非法的 kind/id：' + key(kind, id) };
    const data = load();
    const k = key(kind, id);
    const next = cleanItem(Object.assign({}, data.items[k] || {}, patch || {}));
    if (Object.keys(next).length) data.items[k] = next; else delete data.items[k];
    if (!save(data)) return { ok: false, error: '写入失败' };
    return { ok: true, item: next };
  }

  function removeItem(kind, id) {
    if (!valid(kind, id)) return { ok: false, error: '非法的 kind/id' };
    const data = load();
    delete data.items[key(kind, id)];
    if (!save(data)) return { ok: false, error: '写入失败' };
    return { ok: true };
  }

  /** 把某个 kind 的展示顺序整体写下来：ids[0] 的 order = 1，依此类推。
   *  调用方应传**该 kind 的完整列表** —— 没传到的条目会保留旧 order，可能与新顺序交错。 */
  function reorder(kind, ids) {
    if (KINDS.indexOf(String(kind)) < 0 || !Array.isArray(ids)) return { ok: false, error: '非法入参' };
    const data = load();
    ids.forEach((id, i) => {
      if (String(id == null ? '' : id).trim() === '') return;
      const k = key(kind, id);
      const next = cleanItem(Object.assign({}, data.items[k] || {}, { order: i + 1 }));
      if (Object.keys(next).length) data.items[k] = next; else delete data.items[k];
    });
    if (!save(data)) return { ok: false, error: '写入失败' };
    return { ok: true };
  }

  function list() { return load().items; }

  return { filePath, load, save, list, setItem, removeItem, reorder, cleanItem, SCHEMA_VERSION, KINDS };
}

/** 主进程注册：所有 handler 返回 { ok, ... }，前端不必靠猜错误。 */
function registerUserMetaIpc({ ipcMain }) {
  const svc = createUserMeta({
    root: () => require('./paths').dataRoot(),
    onCorrupt: (bak, e) => console.error('[usermeta] 元数据文件解析失败，已另存为 ' + bak + '：' + (e && e.message)),
  });
  ipcMain.handle('usermeta:list', async () => ({ ok: true, items: svc.list(), path: svc.filePath() }));
  ipcMain.handle('usermeta:set', async (_e, kind, id, patch) => svc.setItem(kind, id, patch));
  ipcMain.handle('usermeta:remove', async (_e, kind, id) => svc.removeItem(kind, id));
  ipcMain.handle('usermeta:reorder', async (_e, kind, ids) => svc.reorder(kind, ids));
  ipcMain.handle('usermeta:pin', async (_e, kind, id, pinned) => svc.setItem(kind, id, { pinned: !!pinned }));
  return svc;
}

module.exports = { createUserMeta, registerUserMetaIpc, SCHEMA_VERSION, KINDS };
