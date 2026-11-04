// ============================================================
// P-011 / T-103 增量音符命令（无 DOM，EditorCanvas 接入前的纯逻辑层）
// ============================================================
// 每个工厂都接收“已经修改好”的 track，并捕获最小 diff；命令兼容 command_history.push()。
// 约定：track.notes 是数组；note 对象带 id（无 id 时用对象引用定位）。
//
// ★ 索引纪律：命令必须在 afterEdit()/sortNotes() **之后**构造并 push；
//   本模块的 undo/redo 仍会优先按对象引用定位，避免调用方时序写错时删错/改错音符。

function notesOf(track) {
  return track && Array.isArray(track.notes) ? track.notes : [];
}
function indexOfNote(track, note) {
  const notes = notesOf(track);
  if (note && note.id != null) {
    const byId = notes.findIndex((n) => n && n.id === note.id);
    if (byId >= 0) return byId;
  }
  return notes.indexOf(note);
}
function insertAt(track, idx, note) {
  const notes = notesOf(track);
  const i = Math.max(0, Math.min(Number.isFinite(idx) ? idx : notes.length, notes.length));
  notes.splice(i, 0, note);
}

/** 新增音符：added 是修改后的 notes（含新音符）；undo 按引用删除，redo 放回原位置。 */
export function makeAddNotesCommand(track, addedNotes, label = '新增音符') {
  const added = (addedNotes || []).slice();
  const inserted = added.map((n) => ({ n, idx: indexOfNote(track, n) })).filter((x) => x.idx >= 0);
  inserted.sort((a, b) => a.idx - b.idx);
  return {
    label,
    kind: 'command',
    bytes: 24 + added.length * 48,
    undo() {
      for (let i = inserted.length - 1; i >= 0; i--) {
        const x = inserted[i];
        const at = indexOfNote(track, x.n);
        if (at >= 0) notesOf(track).splice(at, 1);
      }
    },
    redo() {
      for (const x of inserted) {
        if (indexOfNote(track, x.n) >= 0) continue;
        insertAt(track, x.idx, x.n);
      }
    },
  };
}

/** 删除音符：capture 为删除前的 [{idx, note}]；undo 升序插回，redo 按引用删除。 */
export function makeDeleteNotesCommand(track, captures, label = '删除音符') {
  const list = (captures || []).map((x) => ({ idx: Number(x.idx), note: x.note })).filter((x) => x.idx >= 0).sort((a, b) => a.idx - b.idx);
  return {
    label,
    kind: 'command',
    bytes: 16 + list.length * 56,
    undo() {
      for (const x of list) {
        if (indexOfNote(track, x.note) >= 0) continue;
        insertAt(track, x.idx, x.note);
      }
    },
    redo() {
      for (let i = list.length - 1; i >= 0; i--) {
        const at = indexOfNote(track, list[i].note);
        if (at >= 0) notesOf(track).splice(at, 1);
      }
    },
  };
}

/** 修改音符字段：updates=[{idx, note?, before, after}]；按引用应用，idx 仅作兜底。 */
export function makeUpdateNotesCommand(track, updates, label = '修改音符') {
  const list = (updates || []).filter((u) => u && Number.isFinite(u.idx)).map((u) => ({
    idx: u.idx,
    note: u.note || notesOf(track)[u.idx] || null,
    before: { ...(u.before || {}) },
    after: { ...(u.after || {}) },
  }));
  const target = (u) => {
    if (u.note && indexOfNote(track, u.note) >= 0) return u.note;
    return notesOf(track)[u.idx] || null;
  };
  return {
    label,
    kind: 'command',
    bytes: 16 + list.reduce((s, u) => s + JSON.stringify(u.before).length * 2 + JSON.stringify(u.after).length * 2, 0),
    undo() {
      for (let i = list.length - 1; i >= 0; i--) {
        const n = target(list[i]);
        if (n) Object.assign(n, list[i].before);
      }
    },
    redo() {
      for (const u of list) {
        const n = target(u);
        if (n) Object.assign(n, u.after);
      }
    },
  };
}

/** 工具：一次性删除一批音符并返回命令（会立即从 track 删除）。 */
export function removeNotesWithCommand(track, notes, label = '删除音符') {
  const captures = [];
  const set = new Set(notes || []);
  for (let i = track.notes.length - 1; i >= 0; i--) {
    if (set.has(track.notes[i])) { captures.push({ idx: i, note: track.notes[i] }); track.notes.splice(i, 1); }
  }
  captures.sort((a, b) => a.idx - b.idx);
  return makeDeleteNotesCommand(track, captures, label);
}
