// ============================================================
// P-011 / CC 命令：延音踏板等离散 CC 增删（无 DOM）
// ============================================================
// CC 没有 id；按对象引用定位，idx 只做兜底（排序/重排后仍能撤销到正确对象）。

function ccsOf(track) {
  return track && Array.isArray(track.ccs) ? track.ccs : [];
}
function indexOfCc(track, cc) {
  return ccsOf(track).indexOf(cc);
}

/** 新增 CC：added 已写入 track.ccs 并排好序；undo 按引用删除，redo 放回原位置。 */
export function makeAddCcsCommand(track, added, label = '添加控制器') {
  const list = (added || []).map((c) => ({ c, idx: indexOfCc(track, c) })).filter((x) => x.idx >= 0).sort((a, b) => a.idx - b.idx);
  return {
    label,
    kind: 'command',
    bytes: 16 + list.length * 32,
    undo() {
      for (let i = list.length - 1; i >= 0; i--) {
        const at = indexOfCc(track, list[i].c);
        if (at >= 0) ccsOf(track).splice(at, 1);
      }
    },
    redo() {
      for (const x of list) {
        if (indexOfCc(track, x.c) >= 0) continue;
        const arr = ccsOf(track);
        arr.splice(Math.max(0, Math.min(x.idx, arr.length)), 0, x.c);
      }
    },
  };
}

/** 删除 CC：captures=[{idx, cc}]（删除前）；undo 升序插回，redo 按引用删除。 */
export function makeDeleteCcsCommand(track, captures, label = '删除控制器') {
  const list = (captures || []).map((x) => ({ idx: Number(x.idx), cc: x.cc })).filter((x) => x.idx >= 0).sort((a, b) => a.idx - b.idx);
  return {
    label,
    kind: 'command',
    bytes: 16 + list.length * 36,
    undo() {
      for (const x of list) {
        if (indexOfCc(track, x.cc) >= 0) continue;
        const arr = ccsOf(track);
        arr.splice(Math.max(0, Math.min(x.idx, arr.length)), 0, x.cc);
      }
    },
    redo() {
      for (let i = list.length - 1; i >= 0; i--) {
        const at = indexOfCc(track, list[i].cc);
        if (at >= 0) ccsOf(track).splice(at, 1);
      }
    },
  };
}
