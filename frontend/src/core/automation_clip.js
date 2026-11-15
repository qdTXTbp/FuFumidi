// -*- coding: utf-8 -*-
/**
 * Automation Clip 数据模型（FLAD-04）。
 *
 * ## 与「自动化子轨」的关系
 *
 * 现有自动化是**轨的子轨**（`track.curves`）：一条曲线从第 0 拍铺到结尾，
 * 不能单独复制/移动/循环。这里补的是 playlist 一级对象 —— clip 有自己的
 * 位置（placement）、可循环（loop）、可整体偏移（gain），可以像音频片段一样
 * 操作，而参数本身仍由 `param_registry` 的稳定 `parameterId` 指认。
 *
 * ★ 本期只做**数据层**：不接 UI、不改播放/渲染路径。曲线子轨的读写完全不变
 *   （`track_automation.normalizeCurves` 仍是唯一入口），clip 只作为新对象存在。
 *
 * ## 坐标与取值
 *
 * - `points[].beat` 是 **clip 内部相对拍**（0 = clip 起点），不是工程绝对拍。
 *   这样复制/移动 clip 时不用重算点坐标。
 * - `startBeat / endBeat` 是工程绝对拍，`endBeat` 为**开区间**边界。
 * - `gain` 是参数自身单位的整体偏移（VOL 就是 dB；PIT 就是音分），
 *   采样后相加，再按参数范围钳制。负增益相当于整条曲线往下压。
 * - `loop` 为真时，`beat - startBeat` 对 `endBeat - startBeat` 取模，
 *   即 clip 内容在放置区间内循环。
 *
 * ## 叠加规则
 *
 * 同一轨、同一参数可能有多条 clip 覆盖同一拍。这里按数组顺序**后者覆盖前者**
 * （`automationValueAt` 从后往前找），结果确定、可测；不做加法混合 ——
 * 两条音量曲线相加会莫名其妙地翻倍。
 */

import { defaultFor, envelopeFrom, sampleAt } from './track_automation.js';
import { curveParamId, paramById, normalizeParamValue } from './param_registry.js';

/** clip 最短长度（拍）：小于它拖不开右边界，也没法容纳两个点。 */
export const MIN_CLIP_BEATS = 0.25;

/** 单条 clip 点数上限：防御手改工程里的超大数组。 */
export const MAX_CLIP_POINTS = 4096;

/** 工程内 clip 数量上限。 */
export const MAX_CLIPS = 1024;

const GAIN_LIMIT = 60;

function num(v, d) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function str(v, d) {
  const s = v === undefined || v === null ? '' : String(v);
  return s === '' ? (d === undefined ? '' : d) : s;
}

let _seq = 0;

/** 新 clip id。同一进程内单调，刷新不重复；工程内的唯一性由 normalize 去重兜底。 */
export function newClipId() {
  _seq += 1;
  return 'ac_' + Date.now().toString(36) + '_' + _seq.toString(36);
}

function normalizePoints(param, rawPoints) {
  const pts = [];
  for (const p of (Array.isArray(rawPoints) ? rawPoints : [])) {
    if (pts.length >= MAX_CLIP_POINTS) break;
    if (!p || typeof p !== 'object') continue;
    const beat = num(p.beat, NaN);
    const value = num(p.value, NaN);
    if (!Number.isFinite(beat) || !Number.isFinite(value)) continue;
    pts.push({ beat: Math.max(0, beat), value: clamp(value, param.min, param.max) });
  }
  pts.sort((a, b) => a.beat - b.beat);
  return pts;
}

/**
 * 归一化一条 automation clip。认不出参数 / 没有归属轨的脏数据返回 null
 * （宁可丢一条 clip，也不要把非法参数塞进播放/导出链路）。
 *
 * @param {object} raw
 * @returns {null|{id:string, trackId:string, parameterId:string, points:Array,
 *   startBeat:number, endBeat:number, loop:boolean, gain:number,
 *   fadeIn:number, fadeOut:number, name:string}}
 */
export function normalizeAutomationClip(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const param = paramById(raw.parameterId);
  if (!param) return null;
  const trackId = str(raw.trackId).slice(0, 64);
  if (!trackId) return null;                 // 没有归属轨的 clip 无处生效

  const startBeat = Math.max(0, num(raw.startBeat, 0));
  let endBeat = num(raw.endBeat, NaN);
  if (!Number.isFinite(endBeat)) endBeat = startBeat + 4;
  if (endBeat - startBeat < MIN_CLIP_BEATS) endBeat = startBeat + MIN_CLIP_BEATS;
  const len = endBeat - startBeat;

  return {
    id: str(raw.id).slice(0, 64) || newClipId(),
    trackId,
    parameterId: param.id,
    points: normalizePoints(param, raw.points),
    startBeat,
    endBeat,
    loop: !!raw.loop,
    gain: clamp(num(raw.gain, 0), -GAIN_LIMIT, GAIN_LIMIT),
    // 淡化长度（拍）：从 clip 两端向内；超出长度时钳到全长
    fadeIn: clamp(num(raw.fadeIn, 0), 0, len),
    fadeOut: clamp(num(raw.fadeOut, 0), 0, len),
    name: str(raw.name).slice(0, 60),
  };
}

/**
 * 整组归一化：丢掉非法项、按 id 去重（先出现者胜）、限制总数与时长。
 *
 * @param {Array} list
 * @returns {Array}
 */
export function normalizeAutomationClips(list) {
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    if (out.length >= MAX_CLIPS) break;
    const c = normalizeAutomationClip(raw);
    if (!c) continue;
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  return out;
}

/** clip 是否覆盖某一拍（`endBeat` 开区间）。 */
export function coversBeat(clip, beat) {
  const b = num(beat, NaN);
  if (!clip || !Number.isFinite(b)) return false;
  return b >= clip.startBeat && b < clip.endBeat;
}

/**
 * 在工程绝对拍上取这条 clip 的值；不在放置区间内返回 null（= 不影响该拍）。
 *
 * @param {object} clip  已归一化的 clip
 * @param {number} beat  工程绝对拍
 * @returns {number|null}
 */
export function clipValueAt(clip, beat) {
  if (!coversBeat(clip, beat)) return null;
  const param = paramById(clip.parameterId);
  if (!param) return null;
  const len = clip.endBeat - clip.startBeat;
  let local = Math.max(0, num(beat, 0) - clip.startBeat);
  if (clip.loop && len > 0) local = local % len;
  const v = sampleAt(clip.points, local, param.def) + clip.gain;
  return normalizeParamValue(clip.parameterId, v);
}

/**
 * 淡化系数：0 = 完全回到基础值，1 = 完全使用 clip 值。
 *
 * `fadeIn / fadeOut` 是拍数，从 clip 两端向内线性过渡；两端都设且总长超过
 * clip 长度时取两者较小值，形成三角包络。
 *
 * @returns {number} [0,1]
 */
export function fadeFactor(clip, beat) {
  if (!clip) return 1;
  const len = num(clip.endBeat, 0) - num(clip.startBeat, 0);
  if (!(len > 0)) return 1;
  const local = clamp(num(beat, 0) - clip.startBeat, 0, len);
  const fin = Math.max(0, num(clip.fadeIn, 0));
  const fout = Math.max(0, num(clip.fadeOut, 0));
  let f = 1;
  if (fin > 0 && local < fin) f = Math.min(f, local / fin);
  if (fout > 0 && local > len - fout) f = Math.min(f, (len - local) / fout);
  return clamp(f, 0, 1);
}

/**
 * 带淡化的 clip 取值：淡化区间内朝 `baseValue`（基础曲线/默认值）混合。
 *
 * 这样淡入淡出不会把参数拉到 0（音量 -∞ 或音分 0 都不是「无效果」），
 * 而是从基础曲线自然接管、再交还回去。
 *
 * @param {object} clip
 * @param {number} beat
 * @param {number} [baseValue] 不在 clip 覆盖范围时的取值
 * @returns {number|null}
 */
export function clipValueAtFaded(clip, beat, baseValue) {
  const raw = clipValueAt(clip, beat);
  if (raw === null) return null;
  const f = fadeFactor(clip, beat);
  if (f >= 1) return raw;
  const param = paramById(clip.parameterId);
  const base = Number.isFinite(Number(baseValue)) ? Number(baseValue) : (param ? param.def : 0);
  return normalizeParamValue(clip.parameterId, base + (raw - base) * f);
}

/**
 * 多 clip 叠加：找**最后一条**覆盖该拍的同轨同参数 clip。
 *
 * @param {Array} clips
 * @param {{trackId:string, parameterId:string, beat:number}} q
 * @returns {number|null} 没有 clip 覆盖时返回 null，调用方回落到已有曲线/字段值
 */
export function automationValueAt(clips, q, baseValue) {
  const trackId = str(q && q.trackId);
  const parameterId = str(q && q.parameterId);
  const beat = num(q && q.beat, NaN);
  if (!trackId || !parameterId || !Number.isFinite(beat)) return null;
  const list = Array.isArray(clips) ? clips : [];
  const hasBase = Number.isFinite(Number(baseValue));
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i];
    if (!c || c.trackId !== trackId || c.parameterId !== parameterId) continue;
    const v = hasBase ? clipValueAtFaded(c, beat, Number(baseValue)) : clipValueAt(c, beat);
    if (v !== null) return v;
  }
  return null;
}

/** 某条轨的 clip（保持原顺序，播放/UI 可直接用）。 */
export function clipsForTrack(clips, trackId) {
  const id = str(trackId);
  return (Array.isArray(clips) ? clips : []).filter((c) => c && c.trackId === id);
}

/** 该轨该参数是否有任何 clip —— 播放侧据此决定要不要建自动化链，即使没有基础曲线。 */
export function hasClipFor(clips, trackId, abbr) {
  const parameterId = curveParamId(abbr);
  if (!parameterId) return false;
  const id = str(trackId);
  if (!id) return false;
  const list = Array.isArray(clips) ? clips : [];
  for (const c of list) {
    if (c && c.trackId === id && c.parameterId === parameterId) return true;
  }
  return false;
}

/**
 * 基础曲线 + clip 覆盖的逐拍取值：**clip 优先**，没被覆盖的拍回落到曲线/默认值。
 *
 * 这是「合并采样」的单一入口：播放（Web Audio 包络）与渲染（逐音符参数）
 * 都走它，避免两边各写一套优先级导致听感和导出不一致。
 *
 * @param {{beat:number,value:number}[]} points 基础曲线（工程绝对拍；可空）
 * @param {string} abbr
 * @param {Array} clips
 * @param {string} trackId
 * @param {number} beat
 * @param {number} [fallback] 基础曲线也没有点时用的默认值
 * @returns {number}
 */
export function effectiveValueAt(points, abbr, clips, trackId, beat, fallback) {
  const base = sampleAt(points, beat, fallback);
  const parameterId = curveParamId(abbr);
  if (parameterId) {
    const v = automationValueAt(clips, { trackId, parameterId, beat }, base);
    if (v !== null) return v;
  }
  return base;
}

/**
 * 播放/导出用的包络：在 `envelopeFrom` 之上叠加 clip 覆盖。
 *
 * 参数顺序与 `envelopeFrom` 一致，多出的 `clips/trackId` 放在 abbr 之后，
 * 调用处一眼能看出「这条包络带 clip」。
 *
 * @returns {Float32Array}
 */
export function automationEnvelope(points, abbr, clips, trackId, bpm, startSec, endSec, steps, tempoMap) {
  const parameterId = curveParamId(abbr);
  const def = defaultFor(abbr);
  const override = parameterId
    ? (beat) => automationValueAt(clips, { trackId, parameterId, beat },
      sampleAt(points, beat, def))
    : null;
  return envelopeFrom(points, bpm, startSec, endSec, steps, abbr, tempoMap, override);
}

/**
 * 把 clip 覆盖「烘焙」进点列表，返回一条等价曲线（工程绝对拍）。
 *
 * 取**所有折点并集**采样：基础曲线的每个点、每条 clip 的起止与内部折点。
 * 因为两边都是分段线性的，在并集折点上采样就能精确表达合并结果，
 * 所以引擎侧（渲染/导出）拿到的仍是一条普通曲线，不需要认识 clip。
 *
 * 没有相关 clip 时原样返回基础点（快路径），既有链路零变化。
 *
 * @param {{beat:number,value:number}[]} points 基础曲线（工程绝对拍）
 * @param {string} abbr
 * @param {Array} clips
 * @param {string} trackId
 * @param {number} [fallback] 基础曲线为空时的默认值
 * @returns {{beat:number,value:number}[]}
 */
export function mergedCurvePoints(points, abbr, clips, trackId, fallback) {
  const base = Array.isArray(points) ? points : [];
  const parameterId = curveParamId(abbr);
  if (!parameterId) return base.slice();
  const id = str(trackId);
  const relevant = (Array.isArray(clips) ? clips : [])
    .filter((c) => c && c.trackId === id && c.parameterId === parameterId);
  if (!relevant.length) return base.slice();

  const beats = [];
  for (const p of base) {
    const b = num(p && p.beat, NaN);
    if (Number.isFinite(b)) beats.push(b);
  }
  /* ★ 起止处是**跳变**（clip 覆盖时用 clip 值，区间外回基础曲线）。
     分段线性折线没法表达同拍两值，所以在边界内侧各补一个极小偏移点：
     start−ε 取基础值、start 取 clip 值；end−ε 取 clip 值、end 取基础值。
     ε 取 1e-4 拍（120 BPM 下约 0.05 ms），听不出台阶，但不会画出跨区间的斜坡。 */
  const EPS = 1e-4;
  for (const c of relevant) {
    beats.push(c.startBeat, c.endBeat);
    if (c.startBeat > EPS) beats.push(c.startBeat - EPS);
    if (c.endBeat > c.startBeat + EPS) beats.push(c.endBeat - EPS);
    // 淡化拐点也是折点：不补会在导出曲线上把淡入淡出画成一条直线
    if (num(c.fadeIn, 0) > 0) beats.push(c.startBeat + num(c.fadeIn, 0));
    if (num(c.fadeOut, 0) > 0) beats.push(c.endBeat - num(c.fadeOut, 0));
    const len = c.endBeat - c.startBeat;
    for (const p of (Array.isArray(c.points) ? c.points : [])) {
      const local = num(p && p.beat, NaN);
      if (!Number.isFinite(local)) continue;
      // 与 clipValueAt 同语义：loop 时局部坐标对放置长度取模
      const l = (c.loop && len > 0) ? ((local % len) + len) % len : local;
      const abs = c.startBeat + l;
      if (abs >= c.startBeat && abs < c.endBeat) beats.push(abs);
    }
  }

  beats.sort((a, b) => a - b);
  const def = Number.isFinite(Number(fallback)) ? Number(fallback) : defaultFor(abbr);
  const out = [];
  for (const b of beats) {
    if (out.length && Math.abs(out[out.length - 1].beat - b) < 1e-9) continue;
    out.push({ beat: b, value: effectiveValueAt(base, abbr, clips, id, b, def) });
  }
  return out;
}

/**
 * 从现有曲线截一段生成 clip。
 *
 * 两侧补边界点，保证「截出来的 clip 在起止处仍取原曲线的值」——
 * 否则只保留区间内的点，clip 开头会回落到参数默认值，听起来像突然跳变。
 *
 * @param {{abbr:string, points:Array}} curve  轨上的曲线（点用**工程绝对拍**）
 * @param {{trackId:string, startBeat:number, endBeat:number, id?:string,
 *          loop?:boolean, gain?:number, name?:string}} opt
 * @returns {object|null}
 */
export function createClipFromCurve(curve, opt) {
  const o = opt || {};
  const abbr = str(curve && curve.abbr).toUpperCase();
  const parameterId = curveParamId(abbr);
  if (!parameterId) return null;
  const param = paramById(parameterId);
  if (!param) return null;

  const startBeat = Math.max(0, num(o.startBeat, 0));
  let endBeat = num(o.endBeat, NaN);
  if (!Number.isFinite(endBeat)) endBeat = startBeat + 4;
  if (endBeat - startBeat < MIN_CLIP_BEATS) endBeat = startBeat + MIN_CLIP_BEATS;

  const src = (curve && Array.isArray(curve.points)) ? curve.points : [];
  const len = endBeat - startBeat;
  const pts = [{ beat: 0, value: sampleAt(src, startBeat, param.def) }];
  for (const p of src) {
    if (!p || typeof p !== 'object') continue;
    const abs = num(p.beat, NaN);
    const value = num(p.value, NaN);
    if (!Number.isFinite(abs) || !Number.isFinite(value)) continue;
    const local = abs - startBeat;
    if (local > 0 && local < len) pts.push({ beat: local, value });
  }
  pts.push({ beat: len, value: sampleAt(src, endBeat, param.def) });

  return normalizeAutomationClip({
    id: o.id,
    trackId: o.trackId,
    parameterId,
    points: pts,
    startBeat,
    endBeat,
    loop: o.loop,
    gain: o.gain,
    name: o.name,
  });
}

/**
 * 按增量平移 clip（复制/拖动）。内容（points）不动 —— 点坐标是 clip 内部的，
 * 移动的是放置区间，这正是「整条曲线跟着 clip 走」的语义。
 */
export function shiftClip(clip, deltaBeats) {
  const d = num(deltaBeats, 0);
  const startBeat = Math.max(0, clip.startBeat + d);
  const shift = startBeat - clip.startBeat;
  return { ...clip, startBeat, endBeat: clip.endBeat + shift };
}

/** 复制一条 clip（默认放在原位置后面一条长度处；id 重新生成）。 */
export function cloneClip(clip) {
  const len = clip.endBeat - clip.startBeat;
  return { ...clip, id: newClipId(), startBeat: clip.startBeat + len, endBeat: clip.endBeat + len };
}

/**
 * 拖边裁剪：`edge='start'|'end'`，`beat` 是工程绝对拍。
 *
 * 点坐标是 clip 内部相对拍，所以**拉左边时同步平移点**，保证曲线内容在时间轴上
 * 不漂移（和 MIDI clip 的 `offsetTick` 同一语义）；拉右边只改放置区间。
 * 裁掉所有点后保留一个取样点，避免空 clip 在播放时退化成参数默认值。
 */
export function trimClip(clip, edge, beat) {
  const b = num(beat, NaN);
  if (!clip || !Number.isFinite(b)) return normalizeAutomationClip(clip);
  if (edge !== 'start') {
    const endBeat = Math.max(clip.startBeat + MIN_CLIP_BEATS, b);
    return normalizeAutomationClip({ ...clip, endBeat });
  }
  const newStart = Math.min(Math.max(0, b), clip.endBeat - MIN_CLIP_BEATS);
  const delta = newStart - clip.startBeat;
  let points = Array.isArray(clip.points) ? clip.points : [];
  if (delta > 0) {
    const kept = points
      .filter((p) => p && p.beat >= delta)
      .map((p) => ({ beat: p.beat - delta, value: p.value }));
    points = kept.length ? kept : [{
      beat: 0,
      value: sampleAt(points, delta, (paramById(clip.parameterId) || {}).def),
    }];
  } else if (delta < 0) {
    points = points.map((p) => ({ beat: (p && p.beat) - delta, value: p && p.value }));
  }
  return normalizeAutomationClip({ ...clip, startBeat: newStart, points });
}
