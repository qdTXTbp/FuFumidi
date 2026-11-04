// ============================================================
// P-011 混合撤销栈：快照 entry + 增量命令 entry 共用一条 LIFO 日志
// ============================================================
// 快照 entry 语义与旧 EditorCanvas 双栈一致：undo 时先惰性捕获当前状态为 after，
// 再恢复 before；因此一条 entry 只常驻一份快照，不会比旧实现多占内存。
// 本模块不依赖 Vue/DOM；capture/restore 由调用方注入。

import { createCommandHistory, DEFAULT_HUGE_BYTES, DEFAULT_HUGE_KEEP } from './command_history.js';

export function makeSnapshotEntry({ label, ti = -1, capture, restore, noteCount = 0 } = {}) {
  if (typeof capture !== 'function' || typeof restore !== 'function') {
    throw new Error('snapshot entry requires capture()/restore()');
  }
  const before = capture();
  let after = null;
  return {
    kind: 'snapshot',
    label: String(label || before.label || '编辑'),
    ti: Number.isFinite(ti) ? ti : -1,
    at: before.at || Date.now(),
    bytes: before.bytes || 0,
    noteCount: before.noteCount != null ? before.noteCount : noteCount,
    undo() { after = capture(); restore(before); },
    redo() { if (after) restore(after); },
  };
}

export function createEditorHistory(opts = {}) {
  const history = createCommandHistory({
    limit: Number(opts.limit) || 80,
    maxBytes: Number(opts.maxBytes) || 32 * 1024 * 1024,
    hugeBytes: Number(opts.hugeBytes) || DEFAULT_HUGE_BYTES,
    hugeKeep: Number(opts.hugeKeep) || DEFAULT_HUGE_KEEP,
    onChange: opts.onChange,
  });
  function pushSnapshot(o) { return history.push(makeSnapshotEntry(o)); }
  function pushCommand(cmd) { return history.push(cmd); }
  return { ...history, pushSnapshot, pushCommand };
}
