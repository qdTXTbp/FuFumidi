// ============================================================
// P-011 命令式撤销核心（T-103）
// ============================================================
// 与 core/history_stack.js 的「整份快照」不同：这里的每条命令只保存**增量**（diff/前后值），
// 通过 undo()/redo() 闭包精确回滚，因此 10 万音符 × 50 次编辑不会各存一份全量快照。
//
// 约定：
//   · push(cmd) 在命令**已经应用**之后调用；命令必须实现 undo() 与 redo()；
//   · 新命令入栈时清空 redo；
//   · bytes 可由命令自带（推荐），否则用 JSON.stringify(diff).length*2 估算；
//   · 超出 limit / maxBytes 时丢最旧命令（内存上限是硬约束）。
//
// 该模块不依赖 Vue/DOM；应用级单栈、标签、事务由调用方接入（T-103 后续）。

export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

function estimateBytes(cmd) {
  if (Number.isFinite(cmd.bytes) && cmd.bytes >= 0) return cmd.bytes;
  if (cmd.diff !== undefined) {
    try { return JSON.stringify(cmd.diff).length * 2; } catch (e) { return 1024; }
  }
  return 256;
}

export function createCommandHistory(opts = {}) {
  const limit = Math.max(1, Number(opts.limit) || 200);
  const maxBytes = Math.max(1024, Number(opts.maxBytes) || DEFAULT_MAX_BYTES);
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : null;
  let undoStack = [];
  let redoStack = [];
  let bytes = 0;

  function depth() {
    return {
      undo: undoStack.length,
      redo: redoStack.length,
      bytes,
      undoLabel: undoStack.length ? undoStack[undoStack.length - 1].label : '',
      redoLabel: redoStack.length ? redoStack[redoStack.length - 1].label : '',
    };
  }
  function emit() { if (onChange) { try { onChange(depth()); } catch (e) {} } }
  function trim() {
    while (undoStack.length > limit || (bytes > maxBytes && undoStack.length > 1)) {
      const c = undoStack.shift();
      bytes -= c.bytes;
      if (bytes < 0) bytes = 0;
    }
  }
  function push(cmd) {
    if (!cmd || typeof cmd.undo !== 'function' || typeof cmd.redo !== 'function') {
      throw new Error('command must have undo()/redo()');
    }
    const c = { label: String(cmd.label || '编辑'), undo: cmd.undo, redo: cmd.redo, bytes: estimateBytes(cmd) };
    undoStack.push(c);
    bytes += c.bytes;
    redoStack = [];
    trim();
    emit();
    return c;
  }
  function undoStep() {
    const c = undoStack.pop();
    if (!c) return null;
    c.undo();
    bytes -= c.bytes;
    if (bytes < 0) bytes = 0;
    redoStack.push(c);
    emit();
    return c.label;
  }
  function redoStep() {
    const c = redoStack.pop();
    if (!c) return null;
    c.redo();
    undoStack.push(c);
    bytes += c.bytes;
    trim();
    emit();
    return c.label;
  }
  function clear() {
    undoStack = []; redoStack = []; bytes = 0; emit();
  }
  /** 把一组已应用命令合成一条（例如一次拖拽 = 多音符位移）。 */
  function transaction(label, commands) {
    const list = (commands || []).filter((c) => c && typeof c.undo === 'function' && typeof c.redo === 'function');
    const total = list.reduce((s, c) => s + estimateBytes(c), 0);
    return {
      label: String(label || '批量编辑'),
      bytes: total,
      undo() { for (let i = list.length - 1; i >= 0; i--) list[i].undo(); },
      redo() { for (const c of list) c.redo(); },
    };
  }
  /** 执行并记录（命令对象需实现 redo 来“应用”）。 */
  function execute(cmd) {
    cmd.redo();
    return push(cmd);
  }

  return {
    push, undo: undoStep, redo: redoStep, canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0, depth, clear, transaction, execute,
    limit, maxBytes,
  };
}
