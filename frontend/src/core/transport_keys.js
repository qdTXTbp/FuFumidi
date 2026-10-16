// ============================================================
// 方向键的播放控制语义 —— 纯函数，便于单测（frontend/tests/transport-keys.test.js）
//
// 两件事：
//   1. 步长可配（秒 / 百分比 / 小节），取代原来写死的 ±2%；
//   2. 长按 → 倍数播放（→ 快进播放 N 倍；← 快退，**不出声** —— 用户 2026-10-14 定，
//      MIDI 播放器不能倒放，快退只能是反复 seek）。
// ============================================================

export const SEEK_UNITS = ["sec", "percent", "bar"];

/** 方向键一次的位移（秒，带正负号）。dir: +1 前进 / -1 后退。*/
export function seekDelta({ dir, step, unit, totalSec, secPerBar }) {
  const d = dir >= 0 ? 1 : -1;
  const v = Number(step) > 0 ? Number(step) : 0;
  if (!v) return 0;
  switch (unit) {
    case "percent":
      return d * (Number.isFinite(totalSec) ? totalSec : 0) * (v / 100);
    case "bar":
      return d * v * (Number(secPerBar) > 0 ? Number(secPerBar) : 2);
    default:
      return d * v;
  }
}

/** 目标位置（夹在 [0, totalSec] 内）。*/
export function seekTarget({ sec, dir, step, unit, totalSec, secPerBar }) {
  const t = Number(sec) + seekDelta({ dir, step, unit, totalSec, secPerBar });
  const hi = Number.isFinite(totalSec) ? totalSec : t;
  return Math.max(0, Math.min(hi, t));
}

/** 长按判定：按住超过 delayMs 才切到 N 倍，否则 1 倍。*/
export function holdRate(heldMs, { delayMs = 400, rate = 2 } = {}) {
  const r = Number(rate) > 0 ? Number(rate) : 1;
  return Number(heldMs) >= Number(delayMs) ? r : 1;
}

/** 快退长按时每次向后挪多少（秒）：按"倍数 × 步长"给，按住越久挪得越多。*/
export function rewindStep({ step, unit, rate, totalSec, secPerBar, elapsedMs }) {
  const base = Math.abs(seekDelta({ dir: -1, step, unit, totalSec, secPerBar }));
  const r = holdRate(elapsedMs, { delayMs: 0, rate });
  return base * r;
}

/** 焦点在输入框/可编辑区里时不抢方向键（否则改数值时没法用左右键移光标）。*/
export function isEditableTarget(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = String(el.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return false;
}
