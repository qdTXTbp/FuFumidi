// ============================================================
// P1-13 B4 编辑器导航：跟随播放的视口滚动策略（纯逻辑）
// ============================================================
// 目标：播放时让播放头留在可视区，但**不要每帧都滚**（会晕、也会让用户手动滚动失效）。
// 策略：
//   · 播放头在 [leftRatio, rightRatio] 可视区之间 → 不滚（返回 null）；
//   · 超出右侧 → 视口滚到「播放头在 anchorRatio 处」（默认 30%，前面留一点上下文）；
//   · 超出左侧（循环回跳 / 倒放）→ 同理滚到 anchor；
//   · 结果夹在 >= 0。
// 由 EditorCanvas 在播放中调用，用户手动拖滚动条/滚轮时关闭跟随（由调用方处理）。

export function viewSpanTicks(pxPerTick, width) {
  const ppt = Number(pxPerTick) || 0;
  const w = Number(width) || 0;
  if (ppt <= 0 || w <= 0) return 0;
  return w / ppt;
}

/**
 * @param {{viewTick:number, pxPerTick:number, width:number, curTick:number,
 *          leftRatio?:number, rightRatio?:number, anchorRatio?:number}} p
 * @returns {number|null} 新的 viewTick（无需滚动返回 null）
 */
export function followViewTick(p) {
  const viewTick = Math.max(0, Number(p && p.viewTick) || 0);
  const curTick = Math.max(0, Number(p && p.curTick) || 0);
  const width = Number(p && p.width) || 0;
  const ppt = Number(p && p.pxPerTick) || 0;
  const span = viewSpanTicks(ppt, width);
  if (span <= 0) return null;
  const leftRatio = clampRatio(p.leftRatio, 0.12);
  const rightRatio = clampRatio(p.rightRatio, 0.88);
  const anchorRatio = clampRatio(p.anchorRatio, 0.3);
  const x = (curTick - viewTick) * ppt;
  const lo = width * leftRatio, hi = width * rightRatio;
  if (x >= lo && x <= hi) return null;
  const next = Math.max(0, curTick - span * anchorRatio);
  return Math.abs(next - viewTick) < 1e-6 ? null : next;
}

/** 播放头是否在可视区内（用于 UI 提示"已跟丢"） */
export function isTickVisible(p) {
  const span = viewSpanTicks(p && p.pxPerTick, p && p.width);
  if (span <= 0) return true;
  const v = Math.max(0, Number(p && p.viewTick) || 0);
  const c = Number(p && p.curTick) || 0;
  return c >= v && c <= v + span;
}

function clampRatio(v, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(0.95, Math.max(0.01, n));
}
