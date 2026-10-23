// ============================================================
// P1-13 B3 曲线引擎（编辑 / 调教共用一套点运算）
// ============================================================
// track_automation.js 负责「调教侧」的目标注册与包络；本模块提供两者共用的
// **点列表基础运算** 与 **MIDI 弯音 ↔ 归一化/音分** 换算。
//
// 约定：曲线 = [{ beat, value }]，beat 升序、value 已按目标范围钳制。
//   · 所有操作都是**不可变**的吗？—— 是。返回新数组，调用方自己决定何时推撤销。
//   · 不做外插：首点之前取首值、末点之后取末值（与 track_automation.sampleAt 一致）。
//   · 同 beat 多个点只保留最后一个（编辑时笔刷会连续写同一个 tick）。

export const BEND_MIN = -8192;
export const BEND_MAX = 8191;
export const BEND_CENTER = 0;
export const PB_UNIT_MAX = 127;          // 编辑泳道内部用 0..127 归一化显示
export const PB_RANGE_SEMITONES = 2;     // 通用 MIDI 默认弯音范围 ±2 半音（RPN 可改）

function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/** 点列表排序 + 同 beat 去重（保留后者）+ 排序稳定 */
export function normalizePoints(points) {
  const arr = (Array.isArray(points) ? points : [])
    .filter((p) => p && Number.isFinite(Number(p.beat)) && Number.isFinite(Number(p.value)))
    .map((p) => ({ beat: Number(p.beat), value: Number(p.value) }))
    .sort((a, b) => a.beat - b.beat);
  const out = [];
  for (const p of arr) {
    if (out.length && Math.abs(out[out.length - 1].beat - p.beat) < 1e-9) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** 按目标范围钳制 */
export function clampPoints(points, min, max) {
  return normalizePoints(points).map((p) => ({ beat: p.beat, value: clamp(p.value, min, max) }));
}

/** 插入/替换一个点（同 beat 替换），返回新数组 */
export function insertPoint(points, beat, value) {
  const b = Math.max(0, num(beat, 0));
  const v = num(value, 0);
  const list = (Array.isArray(points) ? points : []).filter((p) => Math.abs(Number(p.beat) - b) >= 1e-9);
  list.push({ beat: b, value: v });
  return normalizePoints(list);
}

/** 删除 beat 附近（容差内）的点 */
export function removePoint(points, beat, tol = 1e-6) {
  const b = num(beat, 0);
  return normalizePoints(points).filter((p) => Math.abs(p.beat - b) > Math.abs(num(tol, 1e-6)));
}

/** 移动第 index 个点到 (beat, value)，返回新数组（自动重排） */
export function movePoint(points, index, beat, value) {
  const list = normalizePoints(points);
  if (index < 0 || index >= list.length) return list;
  list[index] = { beat: Math.max(0, num(beat, 0)), value: num(value, 0) };
  return normalizePoints(list);
}

/**
 * 取值：线性插值 + 两端保持（与 track_automation.sampleAt 同一语义）。
 * @param {{beat:number,value:number}[]} points
 * @param {number} beat
 * @param {number} fallback 没有点时的返回值
 */
export function valueAt(points, beat, fallback = 0) {
  const pts = normalizePoints(points);
  const fb = Number.isFinite(Number(fallback)) ? Number(fallback) : 0;
  if (!pts.length) return fb;
  const b = num(beat, 0);
  if (b <= pts[0].beat) return pts[0].value;
  if (b >= pts[pts.length - 1].beat) return pts[pts.length - 1].value;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], c = pts[i];
    if (b <= c.beat) {
      const span = c.beat - a.beat;
      if (span <= 0) return c.value;
      return a.value + (c.value - a.value) * ((b - a.beat) / span);
    }
  }
  return pts[pts.length - 1].value;
}

/**
 * Ramer–Douglas–Peucker 简化（按「值差」作为距离；曲线 x 轴是拍，单位不同，
 * 所以用垂直误差近似：|value - 线性插值| 与 epsilon 比较）。
 */
export function simplifyPoints(points, epsilon = 1) {
  const pts = normalizePoints(points);
  const eps = Math.max(0, num(epsilon, 1));
  if (pts.length <= 2 || eps <= 0) return pts;
  const keep = new Set([0, pts.length - 1]);
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    const a = pts[i0], b = pts[i1];
    let maxD = -1, maxI = -1;
    for (let i = i0 + 1; i < i1; i++) {
      const t = (pts[i].beat - a.beat) / ((b.beat - a.beat) || 1);
      const line = a.value + (b.value - a.value) * t;
      const d = Math.abs(pts[i].value - line);
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > eps && maxI > 0) {
      keep.add(maxI);
      stack.push([i0, maxI], [maxI, i1]);
    }
  }
  return [...keep].sort((x, y) => x - y).map((i) => pts[i]);
}

/** 按步长量化 beat（保留首尾点，避免曲线整体位移） */
export function quantizePoints(points, stepBeats) {
  const step = Math.max(1e-6, num(stepBeats, 0.25));
  const pts = normalizePoints(points);
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    out.push({ beat: Math.round(pts[i].beat / step) * step, value: pts[i].value });
  }
  out.push(pts[pts.length - 1]);
  return normalizePoints(out);
}

/** 移动平均平滑（窗口=奇数点数；首尾固定） */
export function smoothPoints(points, windowSize = 3) {
  const pts = normalizePoints(points);
  const n = Math.max(1, Math.floor(num(windowSize, 3)));
  if (n <= 1 || pts.length <= 2) return pts;
  const half = Math.floor(n / 2);
  const out = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { ...p };
    let sum = 0, cnt = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(pts.length - 1, i + half); k++) { sum += pts[k].value; cnt++; }
    return { beat: p.beat, value: sum / cnt };
  });
  return out;
}

/** 整体缩放值（例如批量调力度 ×0.8） */
export function scalePoints(points, factor, min = -Infinity, max = Infinity) {
  const f = num(factor, 1);
  return clampPoints(normalizePoints(points).map((p) => ({ beat: p.beat, value: p.value * f })), min, max);
}

/** 合并两条曲线：同 beat 以 b 覆盖 a；结果升序 */
export function mergePoints(a, b) {
  return normalizePoints([...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]);
}

/* ---------------- MIDI 弯音（PB）换算 ---------------- */

/**
 * 14-bit 弯音值 → 编辑泳道 0..127。
 * ★ 中心必须精确落在 64：负半轴用 8192 步长、正半轴用 8191 步长，
 *   否则"回到中间"会写成 8256（约 +1.5 cents 的永久偏移）。
 */
export function bendToUnit(val) {
  const v = clamp(num(val, 0), BEND_MIN, BEND_MAX);
  if (v >= 0) return clamp(64 + Math.round(v / 8191 * 63), 0, PB_UNIT_MAX);
  return clamp(64 + Math.round(v / 8192 * 64), 0, PB_UNIT_MAX);
}
/** 编辑泳道 0..127 → 14-bit 弯音值（0..16383；中心 64 = 8192 精确值） */
export function unitToBend(unit) {
  const u = clamp(Math.round(num(unit, 64)), 0, PB_UNIT_MAX);
  if (u >= 64) return clamp(Math.round(8192 + (u - 64) / 63 * 8191), 0, 16383);
  return clamp(Math.round(8192 + (u - 64) / 64 * 8192), 0, 16383);
}
/** 14-bit 弯音值 → 音分（默认 ±2 半音 = ±200 cents） */
export function bendToCents(val, rangeSemitones = PB_RANGE_SEMITONES) {
  const v = clamp(num(val, 0), BEND_MIN, BEND_MAX);
  const cents = (v / 8192) * num(rangeSemitones, PB_RANGE_SEMITONES) * 100;
  return Math.round(cents * 100) / 100;
}
/** 音分 → 14-bit 弯音值（超范围钳制） */
export function centsToBend(cents, rangeSemitones = PB_RANGE_SEMITONES) {
  const span = num(rangeSemitones, PB_RANGE_SEMITONES) * 100;
  if (span <= 0) return 0;
  return clamp(Math.round(num(cents, 0) / span * 8192), BEND_MIN, BEND_MAX);
}
/** 归一化到 [-1,1]（画包络/显示用） */
export function bendNorm(val) { return clamp(num(val, 0) / 8192, -1, 1); }
/** 判断是否是"静止/未画"的弯音值 */
export function isBendCenter(val) { return Math.abs(num(val, 0)) < 1; }
