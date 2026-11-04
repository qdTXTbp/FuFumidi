// ============================================================
// P-011 / T-103 增量音符命令（无 DOM，EditorCanvas 接入前的纯逻辑层）
// ============================================================
// 每个工厂都接收“已经修改好”的 track，并捕获最小 diff；命令兼容 command_history.push()。
// 约定：track.notes 是数组；note 对象带 id（无 id 时用对象引用定位）。

function indexOfNote(track, note) {
  const notes = track && Array.isArray(track.notes) ? track.notes : [];
  if (note && note.id != null) {
    const byId = notes.findIndex((n) => n && n.id === note.id);
    if (byId >= 0) return byId;
  }
  return notes.indexOf(note);
}

/** 新增音符：after 是修改后的 notes（含新音符）；undo 删除新音符，redo 放回原位置。 */
export function makeAddNotesCommand(track, addedNotes, label = '新增音符') {
  const added = (addedNotes || []).slice();
  const inserted = added.map((n) => ({ n, idx: indexOfNote(track, n) })).filter((x) => x.idx >= 0);
  return {
    label,
    bytes: 24 + added.length * 48,
    undo() { for (let i = inserted.length - 1; i >= 0; i--) track.notes.splice(inserted[i].idx, 1); },
    redo() { for (const x of inserted) track.notes.splice(x.idx, 0, x.n); },
  };
}

/** 删除音符：capture 为删除前的 [{idx, note}]；undo 逆序插回，redo 倒序删除。 */
export function makeDeleteNotesCommand(track, captures, label = '删除音符') {
  const list = (captures || []).map((x) => ({ idx: Number(x.idx), note: x.note })).filter((x) => x.idx >= 0).sort((a, b) => a.idx - b.idx);
  return {
    label,
    bytes: 16 + list.length * 56,
    undo() { for (const x of list) track.notes.splice(x.idx, 0, x.note); },
    redo() { for (let i = list.length - 1; i >= 0; i--) track.notes.splice(list[i].idx, 1); },
  };
}

/** 修改音符字段（移动/力度/音高/量化）：updates=[{idx, before, after}]，before/after 是字段对象。 */
export function makeUpdateNotesCommand(track, updates, label = '修改音符') {
  const list = (updates || []).filter((u) => u && u.idx >= 0).map((u) => ({ idx: u.idx, before: { ...(u.before || {}) }, after: { ...(u.after || {}) } }));
  const apply = (vals) => {
    for (const u of list) {
      const n = track.notes[u.idx];
      if (!n) continue;
      for (const k of Object.keys(vals)) n[k] = vals[k];
    }
  };
  return {
    label,
    bytes: 16 + list.reduce((s, u) => s + JSON.stringify(u.before).length * 2 + JSON.stringify(u.after).length * 2, 0),
    undo() { for (let i = list.length - 1; i >= 0; i--) { const u = list[i]; const n = track.notes[u.idx]; if (n) Object.assign(n, u.before); } },
    redo() { for (const u of list) { const n = track.notes[u.idx]; if (n) Object.assign(n, u.after); } },
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
