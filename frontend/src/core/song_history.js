// -*- coding: utf-8 -*-
/**
 * 编辑历史栈（undo / redo）—— 纯逻辑，与具体工程模型解耦。
 *
 * 快照/恢复由调用方注入（歌声编辑器存 tracks 的 notes/curves/pitchCurve），
 * 本模块只管栈语义：
 *   * `push()` 记录当前状态、**清空 redo**（新编辑分支）
 *   * `undo()` 把当前状态压进 redo 再恢复上一个
 *   * 上限 `limit`（默认 50）：防长曲编辑把内存吃爆（每份快照是全量 JSON）
 */

/**
 * @param {{snapshot: () => any, restore: (s: any) => void, limit?: number}} opts
 * @returns {{push(): void, undo(): boolean, redo(): boolean,
 *            readonly canUndo: boolean, readonly canRedo: boolean, clear(): void}}
 */
export function createHistory({ snapshot, restore, limit = 50 } = {}) {
  if (typeof snapshot !== 'function' || typeof restore !== 'function') {
    throw new Error('createHistory 需要 snapshot/restore 注入');
  }
  const undoStack = [];
  let redoStack = [];

  return {
    /** 记录当前状态（在每个编辑动作**开始前**调用） */
    push() {
      undoStack.push(snapshot());
      if (undoStack.length > limit) undoStack.shift();
      redoStack = [];
    },
    /** 丢掉最后一次 push（交互被取消时用：不留「按一次没反应」的空步，也不产生 redo 分支） */
    drop() { undoStack.pop(); },
    undo() {
      if (!undoStack.length) return false;
      redoStack.push(snapshot());
      restore(undoStack.pop());
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      undoStack.push(snapshot());
      restore(redoStack.pop());
      return true;
    },
    get canUndo() { return undoStack.length > 0; },
    get canRedo() { return redoStack.length > 0; },
    /** 工程切换/载入新曲时清栈（不能 undo 到别的工程去） */
    clear() {
      undoStack.length = 0;
      redoStack = [];
    },
  };
}
