// ============================================================
// C3 DocumentSession（v6.0.0 契约冻结版 · 前端会话层）
// ============================================================
// 职责：把「打开过哪些文档、哪个脏了、撤销栈、视图状态、上次保存时间」收敛成一份状态，
// 供 P0-2（自动保存/崩溃恢复）、P1-14（标签页/会话恢复）共用。
//
// 设计约束：
//   · 纯数据 + 纯函数，不依赖 Vue/桥：主进程落盘由调用方经 bridge.project.autosave* 完成；
//   · 脏标记用**序号**（dirtySeq/savedSeq），不做深比较 —— 大曲目深比较每帧一次会卡；
//   · 撤销栈里放运行时函数（{undo,redo,label}），不参与序列化；
//   · 每个 doc 的视图状态（zoom/scroll/selection/playhead）随快照走，恢复后回到原位。

import { createEditorHistory } from './editor_history.js';

let _autoId = 0;

export function createSessionStore(opts = {}) {
  const maxUndo = Math.max(1, Number(opts.maxUndo) || 80);
  const maxHistoryBytes = Math.max(1024, Number(opts.maxHistoryBytes) || 32 * 1024 * 1024);
  const docs = new Map();
  const listeners = new Set();
  let currentId = "";

  const emit = (type, payload) => {
    for (const fn of listeners) { try { fn(type, payload); } catch (_) { /* 订阅者异常不影响会话 */ } }
  };
  const now = () => Date.now();

  function open(input = {}) {
    const docId = String(input.docId || ("doc-" + (++_autoId) + "-" + now()));
    const existed = docs.get(docId);
    const doc = {
      docId,
      kind: input.kind || (existed && existed.kind) || "edit",
      title: input.title != null ? String(input.title) : ((existed && existed.title) || ""),
      path: input.path != null ? String(input.path) : ((existed && existed.path) || ""),
      model: input.model !== undefined ? input.model : (existed ? existed.model : null),
      view: Object.assign({ zoom: 1, scroll: 0, selection: null, playhead: 0 }, existed ? existed.view : {}, input.view || {}),
      dirtySeq: existed ? existed.dirtySeq : 0,
      savedSeq: existed ? existed.savedSeq : 0,
      history: existed ? existed.history : createEditorHistory({ limit: maxUndo, maxBytes: maxHistoryBytes }),
      openedAt: existed ? existed.openedAt : now(),
      lastSavedAt: existed ? existed.lastSavedAt : now(),
      lastEditAt: existed ? existed.lastEditAt : 0,
    };
    docs.set(docId, doc);
    currentId = docId;
    emit("open", doc);
    return doc;
  }

  function get(docId) { return docs.get(String(docId)) || null; }
  function list() { return [...docs.values()]; }
  function current() { return currentId ? get(currentId) : null; }
  function activate(docId) {
    if (!docs.has(String(docId))) return false;
    currentId = String(docId);
    emit("activate", docId);
    return true;
  }
  function close(docId) {
    const id = String(docId);
    const doc = docs.get(id);
    if (!doc) return false;
    docs.delete(id);
    if (currentId === id) currentId = docs.size ? [...docs.keys()][docs.size - 1] : "";
    emit("close", id);
    return true;
  }

  function markDirty(docId, label) {
    const doc = get(docId);
    if (!doc) return 0;
    doc.dirtySeq += 1;
    doc.lastEditAt = now();
    // 新编辑的 redo 清空由 history.push() 负责；这里不再清，避免保存/脏标记误伤 redo
    emit("dirty", { docId: doc.docId, dirtySeq: doc.dirtySeq, label: label || "" });
    return doc.dirtySeq;
  }
  function isDirty(docId) { const d = get(docId); return !!d && d.dirtySeq > d.savedSeq; }
  function dirtyCount() { return [...docs.values()].filter((d) => d.dirtySeq > d.savedSeq).length; }

  function pushUndo(docId, entry) {
    const doc = get(docId);
    if (!doc || !entry || typeof entry.undo !== "function") return false;
    const redo = typeof entry.redo === "function" ? entry.redo : () => { throw new Error("redo unavailable"); };
    try { doc.history.push({ label: entry.label || "", undo: entry.undo, redo, bytes: entry.bytes, kind: entry.kind, noteCount: entry.noteCount, ti: entry.ti, at: entry.at }); }
    catch (_) { return false; }
    return true;
  }
  function history(docId) { const d = get(docId); return d ? d.history : null; }
  function depth(docId) { const h = history(docId); return h ? h.depth() : { undo: 0, redo: 0, bytes: 0, redoBytes: 0, undoLabel: "", redoLabel: "", seq: 0 }; }
  function clearUndo(docId) { const h = history(docId); if (!h) return false; h.clear(); return true; }
  function canUndo(docId) { const h = history(docId); return !!h && h.canUndo(); }
  function canRedo(docId) { const h = history(docId); return !!h && h.canRedo(); }
  function undo(docId) {
    const doc = get(docId);
    if (!doc) return false;
    let label = null;
    try { label = doc.history.undo(); } catch (_) { return false; }
    if (label == null) return false;
    doc.dirtySeq += 1; doc.lastEditAt = now();
    emit("undo", doc.docId);
    return true;
  }
  function redo(docId) {
    const doc = get(docId);
    if (!doc) return false;
    let label = null;
    try { label = doc.history.redo(); } catch (_) { return false; }
    if (label == null) return false;
    doc.dirtySeq += 1; doc.lastEditAt = now();
    emit("redo", doc.docId);
    return true;
  }

  function setView(docId, patch = {}) {
    const doc = get(docId);
    if (!doc) return false;
    Object.assign(doc.view, patch);
    emit("view", { docId: doc.docId, view: doc.view });
    return true;
  }
  function getView(docId) { const d = get(docId); return d ? Object.assign({}, d.view) : null; }

  function markSaved(docId, at) {
    const doc = get(docId);
    if (!doc) return false;
    doc.savedSeq = doc.dirtySeq;
    doc.lastSavedAt = at == null ? now() : Number(at);
    emit("saved", doc.docId);
    return true;
  }

  /** 是否该自动保存：脏 && 距上次保存 ≥ intervalSec（默认 30s） */
  function shouldAutosave(docId, at, intervalSec = 30) {
    const doc = get(docId);
    if (!doc || doc.dirtySeq <= doc.savedSeq) return false;
    const t = at == null ? now() : Number(at);
    return t - doc.lastSavedAt >= Math.max(1, Number(intervalSec) || 30) * 1000;
  }

  /** 序列化快照（给 autosave:write；不含模型时可用于恢复 UI 列表） */
  function snapshot(docId, { includeModel = false } = {}) {
    const doc = get(docId);
    if (!doc) return null;
    const snap = {
      format: "fufumidi-session", version: 1,
      docId: doc.docId, kind: doc.kind, title: doc.title, path: doc.path,
      view: Object.assign({}, doc.view),
      dirtySeq: doc.dirtySeq, savedSeq: doc.savedSeq,
      openedAt: doc.openedAt, lastSavedAt: doc.lastSavedAt, lastEditAt: doc.lastEditAt,
    };
    if (includeModel) snap.model = doc.model;
    return snap;
  }

  /** 从快照恢复（崩溃恢复）；已存在的 doc 合并，不存在的重建 */
  function restore(snap) {
    if (!snap || typeof snap !== "object" || !snap.docId) return null;
    const doc = open({
      docId: snap.docId, kind: snap.kind, title: snap.title, path: snap.path,
      model: snap.model, view: snap.view,
    });
    if (Number.isFinite(Number(snap.dirtySeq))) doc.dirtySeq = Math.max(doc.dirtySeq, Number(snap.dirtySeq));
    if (Number.isFinite(Number(snap.savedSeq))) doc.savedSeq = Number(snap.savedSeq);
    if (Number.isFinite(Number(snap.lastSavedAt))) doc.lastSavedAt = Number(snap.lastSavedAt);
    emit("restore", doc);
    return doc;
  }

  function subscribe(fn) {
    if (typeof fn !== "function") return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { open, get, list, current, activate, close, markDirty, isDirty, dirtyCount, pushUndo, undo, redo, canUndo, canRedo, history, depth, clearUndo, setView, getView, markSaved, shouldAutosave, snapshot, restore, subscribe };
}

/** 应用级单例（Vue 侧用；测试请自己 createSessionStore 以隔离） */
export const appSession = createSessionStore();
