// ============================================================
// C4 TimelineModel（v6.0.0 契约冻结版 · 实现）
//
// 唯一的时间轴换算入口。目标：编辑器 / 编排时间线 / 调教 / 可视化**不再各自**
// 做 tempo 积分和拍号换算（5.2.4 之前 EditorCanvas、arrange、viz 各算一份，
// 变拍号/变速时必然对不齐）。
//
// 数据形状（与 docs/plans/2026-10-18-v6-contracts.md C4 一致）：
//   { tpb, tempoMap:[{tick,us}], sigMap:[{tick,num,den}],
//     markers:[], regions:[], playheadTick, loop:{a,b}, selection,
//     smpte?: { fps, ticksPerFrame } }
//
// 约定：
//   · tick 单位是整数；sec 单位是秒（浮点）；tempoMap 首项必须是 tick=0；
//   · 变拍号视为**落在小节线上**（段落起点即新小节起点）——MIDI 编辑器的通行做法；
//   · SMPTE 模式（smpte 非空）下 tick 是时间码刻度：sec = tick / (fps * ticksPerFrame)，
//     tempoMap 被忽略（仍保留给导出用）；
//   · 所有导出函数都不修改入参；要改时间轴请 normalize 出新对象。
// ============================================================
import { clamp } from './midi_deps.js';

const DEF_TPB = 480;
const DEF_US = 500000; // 120 BPM
const DEF_SIG = { num: 4, den: 4 };

const _cache = new WeakMap();
function cacheOf(tl) {
  let c = _cache.get(tl);
  if (!c) { c = Object.create(null); _cache.set(tl, c); }
  return c;
}
function toInt(v, fallback = 0) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? n : fallback;
}

/** 规范化：补默认、排序、去重、预计算分段（不修改入参） */
export function normalizeTimeline(input = {}) {
  const tpb = Math.max(1, toInt(input.tpb || input.ticksPerBeat || DEF_TPB, DEF_TPB));
  const rawTempo = Array.isArray(input.tempoMap) ? input.tempoMap.slice() : [];
  const tempoSorted = rawTempo
    .map((e) => ({ tick: Math.max(0, toInt(e && e.tick)), us: clamp(toInt(e && e.us, DEF_US), 1, 0xffffff) }))
    .sort((a, b) => a.tick - b.tick);
  const tempoMap = [];
  for (const e of tempoSorted) {
    const last = tempoMap[tempoMap.length - 1];
    if (last && last.tick === e.tick) last.us = e.us;   // 同 tick：后者覆盖（先排序再去重，否则乱序输入会漏）
    else tempoMap.push(e);
  }
  if (!tempoMap.length || tempoMap[0].tick !== 0) tempoMap.unshift({ tick: 0, us: DEF_US });

  const rawSig = Array.isArray(input.sigMap) ? input.sigMap.slice() : [];
  const sigSorted = rawSig.map((e) => {
    const tick = Math.max(0, toInt(e && e.tick));
    const num = clamp(toInt(e && e.num, DEF_SIG.num), 1, 64);
    const den = [1, 2, 4, 8, 16, 32, 64].includes(toInt(e && e.den, DEF_SIG.den)) ? toInt(e && e.den, DEF_SIG.den) : DEF_SIG.den;
    return { tick, num, den };
  }).sort((a, b) => a.tick - b.tick);
  const sigMap = [];
  for (const e of sigSorted) {
    const last = sigMap[sigMap.length - 1];
    if (last && last.tick === e.tick) { last.num = e.num; last.den = e.den; }
    else sigMap.push(e);
  }
  if (!sigMap.length || sigMap[0].tick !== 0) sigMap.unshift({ tick: 0, num: DEF_SIG.num, den: DEF_SIG.den });

  const smpte = input.smpte && Number(input.smpte.fps) > 0 && Number(input.smpte.ticksPerFrame) > 0
    ? { fps: Number(input.smpte.fps), ticksPerFrame: Math.max(1, toInt(input.smpte.ticksPerFrame, 1)) }
    : null;

  const tl = {
    tpb, tempoMap, sigMap, smpte,
    markers: Array.isArray(input.markers) ? input.markers.slice() : [],
    regions: Array.isArray(input.regions) ? input.regions.slice() : [],
    playheadTick: Math.max(0, toInt(input.playheadTick)),
    loop: input.loop && Number.isFinite(Number(input.loop.a)) && Number.isFinite(Number(input.loop.b))
      ? { a: Math.max(0, toInt(input.loop.a)), b: Math.max(0, toInt(input.loop.b)) }
      : { a: 0, b: 0 },
    selection: input.selection || null,
    totalTicks: Math.max(0, toInt(input.totalTicks || 0)),
  };
  return tl;
}

/* ---------------- 内部：预计算 ---------------- */

function tempoSegs(tl) {
  const c = cacheOf(tl);
  if (c.tempoSegs) return c.tempoSegs;
  const segs = [];
  let sec = 0;
  for (let i = 0; i < tl.tempoMap.length; i++) {
    const e = tl.tempoMap[i];
    if (i > 0) {
      const p = tl.tempoMap[i - 1];
      sec += (e.tick - p.tick) * p.us / 1e6 / tl.tpb;
    }
    segs.push({ tick: e.tick, us: e.us, sec });
  }
  c.tempoSegs = segs;
  return segs;
}

function sigSegs(tl) {
  const c = cacheOf(tl);
  if (c.sigSegs) return c.sigSegs;
  const segs = [];
  let bars = 0;
  for (let i = 0; i < tl.sigMap.length; i++) {
    const e = tl.sigMap[i];
    const next = tl.sigMap[i + 1];
    const barTicks = barTicksOf(e, tl.tpb);
    const end = next ? next.tick : Infinity;
    segs.push({ tick: e.tick, end, num: e.num, den: e.den, barTicks, barsBefore: bars });
    if (next) bars += Math.max(0, Math.round((next.tick - e.tick) / barTicks));
  }
  c.sigSegs = segs;
  return segs;
}

/** 一小节的 tick 数（按拍号；tpb 是四分音符 tick 数） */
export function barTicksOf(sig, tpb = DEF_TPB) {
  const den = (sig && sig.den) || 4;
  const num = (sig && sig.num) || 4;
  return Math.max(1, Math.round(num * (tpb * 4 / den)));
}

function findSeg(segs, tick) {
  let lo = 0, hi = segs.length - 1, ans = 0;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (segs[m].tick <= tick) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  return ans;
}

/* ---------------- 秒 ↔ tick ---------------- */

export function secOfTick(tl, tick) {
  const t = Math.max(0, Number(tick) || 0);
  if (tl.smpte) return t / (tl.smpte.fps * tl.smpte.ticksPerFrame);
  const segs = tempoSegs(tl);
  const s = segs[findSeg(segs, t)];
  return s.sec + (t - s.tick) * s.us / 1e6 / tl.tpb;
}

export function tickOfSec(tl, sec) {
  const s0 = Math.max(0, Number(sec) || 0);
  if (tl.smpte) return s0 * tl.smpte.fps * tl.smpte.ticksPerFrame;
  const segs = tempoSegs(tl);
  if (s0 <= 0) return 0;
  let seg = segs[0];
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].sec > s0) break;
    seg = segs[i];
  }
  return seg.tick + (s0 - seg.sec) * tl.tpb * 1e6 / seg.us;
}

/* ---------------- 小节 / 拍 ---------------- */

/** tick → { bar, beat, num, den, tickInBar, barTick, barTicks, sigTick }（bar/beat 从 0 起） */
export function barBeatOf(tl, tick) {
  const t = Math.max(0, Number(tick) || 0);
  const segs = sigSegs(tl);
  const seg = segs[findSeg(segs, t)];
  const inSeg = t - seg.tick;
  const barsInSeg = Math.floor(inSeg / seg.barTicks);
  const tickInBar = inSeg - barsInSeg * seg.barTicks;
  const beatTicks = seg.barTicks / seg.num;
  return {
    bar: seg.barsBefore + barsInSeg,
    beat: Math.floor(tickInBar / beatTicks),
    num: seg.num, den: seg.den,
    tickInBar, barTick: seg.tick + barsInSeg * seg.barTicks,
    barTicks: seg.barTicks, sigTick: seg.tick,
  };
}

/** (bar, beat) → tick；越界时夹到最后的段尾（用于 UI 导航） */
export function tickOfBarBeat(tl, bar, beat = 0) {
  const segs = sigSegs(tl);
  const b = Math.max(0, toInt(bar));
  let seg = segs[segs.length - 1];
  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1];
    if (!next || b < segs[i].barsBefore + Math.max(0, Math.round((next.tick - segs[i].tick) / segs[i].barTicks))) { seg = segs[i]; break; }
  }
  const barsInSeg = b - seg.barsBefore;
  const beatTicks = seg.barTicks / seg.num;
  return seg.tick + barsInSeg * seg.barTicks + clamp(toInt(beat), 0, seg.num - 1) * beatTicks;
}

/** 给状态栏/位置显示用：tick → "小节:拍"（1 基，与 DAW 一致） */
export function formatBarBeat(tl, tick) {
  const b = barBeatOf(tl, tick);
  return (b.bar + 1) + ':' + (b.beat + 1);
}

/** 从 fromTick 到 toTick 逐小节产出（网格/标尺用） */
export function iterBars(tl, fromTick = 0, toTick = Infinity) {
  const out = [];
  const end = Number.isFinite(toTick) ? Math.max(0, toTick) : Infinity;
  let cur = Math.max(0, toInt(fromTick));
  let guard = 0;
  while (cur <= end && guard++ < 100000) {
    const bb = barBeatOf(tl, cur);
    const tick = bb.barTick;
    if (tick > end) break;
    out.push({ bar: bb.bar, tick, ticks: bb.barTicks, num: bb.num, den: bb.den, sigTick: bb.sigTick });
    cur = tick + bb.barTicks;
  }
  return out;
}

/* ---------------- 吸附 / 网格 ---------------- */

const GRID_NAMES = { bar: 1, beat: 1, half: 2, quarter: 4, eighth: 8, sixteenth: 16, thirtysecond: 32 };

/** 网格步长（tick）。grid 可为名称/数字（四分音符的等分数），frame 模式用 smpte.fps */
export function snapStep(tl, grid = "beat") {
  const g = String(grid == null ? "beat" : grid).toLowerCase();
  if (g === "off" || g === "none") return 0;
  if (g === "frame") return tl.smpte ? (1 / tl.smpte.fps) * tl.smpte.fps * tl.smpte.ticksPerFrame : 0;
  if (g === "bar") return barTicksOf((tl.sigMap && tl.sigMap[0]) || DEF_SIG, tl.tpb);
  if (GRID_NAMES[g] && g !== "bar" && g !== "beat") return Math.max(1, Math.round(tl.tpb * 4 / GRID_NAMES[g]));
  if (g === "beat") return Math.max(1, Math.round(tl.tpb));
  const n = Number(grid);
  return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n)) : 0;
}

/** 把 tick 吸附到网格；strength ∈ [0,1] 是「离网格多近才吸」（1 = 始终吸附） */
export function snapTick(tl, tick, opts = {}) {
  const t = Math.max(0, Number(tick) || 0);
  const step = snapStep(tl, opts.grid || "beat");
  if (!step) return t;
  const nearest = Math.round(t / step) * step;
  const strength = clamp(Number(opts.strength == null ? 1 : opts.strength), 0, 1);
  const dist = Math.abs(nearest - t) / step;
  return dist <= strength ? nearest : t;
}

/** 给 UI 用的标尺刻度：返回 from–to 之间所有整小节起点 + bar 编号 */
export function rulerMarks(tl, fromTick, toTick) {
  return iterBars(tl, fromTick, toTick).map((b) => ({ tick: b.tick, label: String(b.bar + 1), bar: b.bar + 1 }));
}

/* ---------------- 与 song 模型的桥 ---------------- */

/** 从 buildSong() 的 song 造一个 timeline（song 已有 tpb/tempoMap/sigMap） */
export function timelineOfSong(song = {}) {
  return normalizeTimeline({
    tpb: song.tpb,
    tempoMap: song.tempoMap,
    sigMap: song.sigMap,
    smpte: song.smpte || null,
    totalTicks: song.totalTicks || 0,
  });
}

/** 时间轴副本（导出/编排需要独立快照时用；不与 song 共享数组） */
export function cloneTimeline(tl) {
  return normalizeTimeline({
    tpb: tl.tpb, tempoMap: tl.tempoMap, sigMap: tl.sigMap, smpte: tl.smpte,
    markers: tl.markers, regions: tl.regions, playheadTick: tl.playheadTick,
    loop: tl.loop, selection: tl.selection, totalTicks: tl.totalTicks,
  });
}

/** 播放头时间的便捷读取（秒） */
export function playheadSec(tl) { return secOfTick(tl, tl.playheadTick); }
