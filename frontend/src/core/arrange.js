// -*- coding: utf-8 -*-
/**
 * 编排时间线（ArrangeView）的纯逻辑 —— **不碰 DOM**，node --test 可测。
 *
 * ## part 块从哪来（对齐 OpenUTAU 的「轨道行 → part 块」两级时间线）
 *
 * 我们的数据模型里音符直接挂在轨上（`startBeat` 是**轨级绝对拍**），
 * `partStarts` 只记录分段边界（导入 .ustx 时由引擎给出）。所以 part 块的
 * 区间按这个优先级确定：
 *
 *   1. 轨有 `partStarts` → 每段 = start → 下一 start（最后一段到 notes 最大 end）；
 *   2. 没有边界 → 按**音符间隙**聚类：相邻音符 `start - prevEnd > gap` 切开
 *      （gap 默认 4 拍 = 一小节 @4/4，OpenUTAU 的 part 之间通常空一小节以上）。
 *
 * 拖动 part = 平移落在 `[from, to)` 区间内的音符 + 曲线点 + part 边界
 * （`shiftRange` 返回新数组，不原地改——与 store 的写回习惯一致）。
 */

/** 聚类判 gap 的默认阈值（拍）：1 小节 @4/4 */
export const PART_GAP_BEATS = 4;

/**
 * 把一条轨的音符聚成 part 区间。
 *
 * @param {Array<{startBeat:number, durBeat:number}>} notes
 * @param {number[]} partStarts  显式分段边界（拍，升序；可空）
 * @param {number} gap  聚类阈值（拍），默认 PART_GAP_BEATS
 * @returns {Array<{from:number, to:number}>} 升序、不重叠、to > from
 */
export function partClusters(notes, partStarts = [], gap = PART_GAP_BEATS) {
  const list = (Array.isArray(notes) ? notes : [])
    .filter((n) => n && typeof n === 'object'
      && Number.isFinite(n.startBeat) && Number.isFinite(n.durBeat))
    .map((n) => ({ startBeat: n.startBeat, endBeat: n.startBeat + Math.max(0.125, n.durBeat) }))
    .sort((a, b) => a.startBeat - b.startBeat);

  const bounds = (Array.isArray(partStarts) ? partStarts : [])
    .filter((s) => Number.isFinite(s) && s >= 0)
    .sort((a, b) => a - b);

  const out = [];
  if (bounds.length) {
    // ---- 显式边界驱动：[start, nextStart)，最后一段到 notes 的最大 end；
    //      没有音符的尾段兜底 16 拍（4 小节 @4/4 —— OpenUTAU 的空 part 观感）
    const notesEnd = list.length ? Math.max(...list.map((n) => n.endBeat)) : 0;
    for (let i = 0; i < bounds.length; i++) {
      const from = bounds[i];
      const to = i + 1 < bounds.length ? bounds[i + 1] : Math.max(notesEnd, from + 16);
      if (to > from) out.push({ from, to });
    }
    return mergeTouches(out);
  }

  // ---- 间隙聚类：相邻音符间隔 > gap 切开
  for (const n of list) {
    const last = out[out.length - 1];
    if (last && n.startBeat - last.to <= gap) {
      last.to = Math.max(last.to, n.endBeat);
    } else {
      out.push({ from: n.startBeat, to: n.endBeat });
    }
  }
  return mergeTouches(out);
}

/** 零长段丢弃、真重叠（from < last.to）合并；显式边界的**相接**段保留为两段 */
function mergeTouches(list) {
  const out = [];
  for (const seg of list) {
    if (!(seg.to > seg.from)) continue;
    const last = out[out.length - 1];
    if (last && seg.from < last.to) last.to = Math.max(last.to, seg.to);
    else out.push({ from: seg.from, to: seg.to });
  }
  return out;
}

/**
 * 平移落在 `[from, to)` 区间内的元素（返回**新数组**，不改动入参）。
 *
 * @param {Array<{startBeat:number, durBeat:number}>} notes
 * @returns {Array} 移动后的音符数组（未命中的元素原样保留引用，命中返回新对象）
 */
export function shiftRange(notes, from, to, delta) {
  return (Array.isArray(notes) ? notes : []).map((n) => {
    if (!n || typeof n !== 'object' || !Number.isFinite(n.startBeat)) return n;
    if (n.startBeat >= from && n.startBeat < to) {
      return Object.assign({}, n, { startBeat: n.startBeat + delta });
    }
    return n;
  });
}

/** 同 shiftRange，但作用于曲线点数组（`{beat, …}`） */
export function shiftCurveRange(points, from, to, delta) {
  return (Array.isArray(points) ? points : []).map((p) => {
    if (!p || typeof p !== 'object' || !Number.isFinite(p.beat)) return p;
    if (p.beat >= from && p.beat < to) {
      return Object.assign({}, p, { beat: p.beat + delta });
    }
    return p;
  });
}

/** 同 shiftRange，但作用于 partStarts（纯数字数组）—— 边界跟着 part 走 */
export function shiftBoundsRange(bounds, from, to, delta) {
  return (Array.isArray(bounds) ? bounds : []).map((s) => {
    if (!Number.isFinite(s)) return s;
    if (s >= from && s < to) return Math.round((s + delta) * 1000) / 1000;
    return s;
  });
}
