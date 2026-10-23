// ============================================================
// 撤销 / 重做栈（P1-13 B2 / 编排撤销共用）
// ============================================================
// 只存**快照**，不认识状态结构：调用方给 clone 函数（默认 structuredClone/JSON）。
// 约定：
//   · push(before) 在修改**之前**调用，参数是"修改前"的快照；
//   · undo(current) 返回要恢复的快照，并把 current 放进 redo 栈；
//   · 新操作会清空 redo 栈（标准编辑器语义）；
//   · 超过 limit 丢最旧的；undoable 为 false 的操作（视图缩放等）由调用方决定不 push。

export function createHistoryStack(opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 80);
  const clone = typeof opts.clone === 'function' ? opts.clone : defaultClone;
  const undoStack = [];
  const redoStack = [];

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }
  function depth() { return { undo: undoStack.length, redo: redoStack.length }; }

  /** 记录"修改前"快照；返回实际入栈的快照 */
  function push(before) {
    undoStack.push(clone(before));
    if (undoStack.length > limit) undoStack.shift();
    redoStack.length = 0;
    return undoStack[undoStack.length - 1];
  }

  /** @returns {any|null} 恢复前的快照（没有可撤销则 null） */
  function undo(current) {
    if (!undoStack.length) return null;
    redoStack.push(clone(current));
    if (redoStack.length > limit) redoStack.shift();
    return undoStack.pop();
  }

  /** @returns {any|null} 重做目标快照 */
  function redo(current) {
    if (!redoStack.length) return null;
    undoStack.push(clone(current));
    if (undoStack.length > limit) undoStack.shift();
    return redoStack.pop();
  }

  function clear() { undoStack.length = 0; redoStack.length = 0; }

  return { push, undo, redo, canUndo, canRedo, depth, clear };
}

/**
 * P1-13：按标签页隔离的历史栈注册表。
 * 每个 key（曲目 id）一个独立 undo/redo；未创建的 key 惰性创建。
 * 超过 maxTabs 时按 LRU 丢弃最久未用的栈（避免多标签长期占用内存）。
 */
export function createTabbedHistoryRegistry(opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 60);
  const maxTabs = Math.max(1, Number(opts.maxTabs) || 16);
  const map = new Map();   // key -> { stack, used }
  let clock = 0;

  function forTab(key) {
    const k = String(key == null ? 'default' : key);
    let hit = map.get(k);
    if (!hit) {
      hit = { stack: createHistoryStack({ limit, clone: opts.clone }), used: 0 };
      map.set(k, hit);
    }
    hit.used = ++clock;
    // LRU：超限时丢最久未用的（保持至少当前这一个）
    if (map.size > maxTabs) {
      let oldestKey = '';
      let oldest = Infinity;
      for (const [kk, v] of map) {
        if (kk === k) continue;
        if (v.used < oldest) { oldest = v.used; oldestKey = kk; }
      }
      if (oldestKey) map.delete(oldestKey);
    }
    return hit.stack;
  }
  function drop(key) { return map.delete(String(key == null ? 'default' : key)); }
  function keys() { return Array.from(map.keys()); }
  function size() { return map.size; }
  function clearAll() { map.clear(); }
  return { forTab, drop, keys, size, clearAll };
}

function defaultClone(v) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); } catch (e) { /* 含函数时退回 JSON */ }
  }
  return JSON.parse(JSON.stringify(v));
}
