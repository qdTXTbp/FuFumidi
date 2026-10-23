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
import { secOfTick } from './timeline.js';

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

/* ============================================================
 * P1-1 编排时间线 clip 模型（v6 新增；与上面的 OpenUTAU part 纯逻辑共存）
 * ============================================================
 * 数据契约：clip 引用 track + 原曲区间 + 偏移，全部用 tick；渲染/换算走 C4 TimelineModel。
 * 所有变更函数都是**纯函数**（返回新 state），UI 侧由 C1 命令注册表统一包 undo。
 * state = { tracks:[...], clips:[...], markers:[...], regions:[...] }
 */
let _arrSeq = 0;
function _uid(prefix) { _arrSeq += 1; return prefix + '-' + _arrSeq; }
function _num(v, d) { const n = Math.round(Number(v)); return Number.isFinite(n) ? n : d; }
function _clone(o) { return JSON.parse(JSON.stringify(o)); }
function _normTrack(t, i) {
  return {
    id: String(t.id || ('track-' + (i + 1))),
    name: String(t.name || ('')), color: t.color || '',
    mute: !!t.mute, solo: !!t.solo,
    height: Math.max(28, _num(t.height, 56)),
  };
}
function _normClip(c) {
  const startTick = Math.max(0, _num(c.startTick, 0));
  const endTick = Math.max(startTick + 1, _num(c.endTick, startTick + 1));
  return {
    id: String(c.id || _uid('clip')), trackId: String(c.trackId || ''),
    startTick, endTick, offsetTick: Math.max(0, _num(c.offsetTick, 0)),
    name: String(c.name || ''), color: c.color || '',
  };
}
function _normMarker(m, i) { return { id: String(m.id || ('marker-' + (i + 1))), title: String(m.title || ''), tick: Math.max(0, _num(m.tick, 0)), color: m.color || '' }; }
function _normRegion(r, i) {
  const startTick = Math.max(0, _num(r.startTick, 0));
  const endTick = Math.max(startTick + 1, _num(r.endTick, startTick + 1));
  return { id: String(r.id || ('region-' + (i + 1))), name: String(r.name || ''), startTick, endTick, color: r.color || '' };
}

/** 规范化输入（幂等）：补 id/默认值、clip 排序 */
export function createArrangeState(input = {}) {
  return {
    tracks: (input.tracks || []).map(_normTrack),
    clips: (input.clips || []).map(_normClip).sort((a, b) => a.startTick - b.startTick || a.trackId.localeCompare(b.trackId)),
    markers: (input.markers || []).map(_normMarker).sort((a, b) => a.tick - b.tick),
    regions: (input.regions || []).map(_normRegion).sort((a, b) => a.startTick - b.startTick),
  };
}

/** 校验：返回 { ok, errors[] }（不抛异常，UI 可展示） */
export function validateArrangeState(state) {
  const errors = [];
  if (!state || !Array.isArray(state.tracks) || !Array.isArray(state.clips)) return { ok: false, errors: ['state 结构不合法'] };
  const ids = new Set();
  for (const c of state.clips) {
    if (ids.has(c.id)) errors.push('clip id 重复：' + c.id);
    ids.add(c.id);
    if (c.endTick <= c.startTick) errors.push('clip 长度必须 > 0：' + c.id);
    if (!state.tracks.some((t) => t.id === c.trackId)) errors.push('clip 指向不存在的轨道：' + c.id + ' → ' + c.trackId);
  }
  return { ok: errors.length === 0, errors };
}

export function clipLen(c) { return Math.max(0, (c.endTick || 0) - (c.startTick || 0)); }
export function clipsOfTrack(state, trackId) { return state.clips.filter((c) => c.trackId === trackId); }
export function findClip(state, clipId) { return state.clips.find((c) => c.id === clipId) || null; }

function _withClips(state, clips) {
  return Object.assign({}, state, { clips: clips.slice().sort((a, b) => a.startTick - b.startTick || a.trackId.localeCompare(b.trackId)) });
}

export function addClip(state, clip) {
  const next = _clone(state);
  const trackId = next.tracks.some((t) => t.id === clip.trackId) ? clip.trackId : (next.tracks[0] && next.tracks[0].id);
  if (!trackId) return next;
  next.clips.push(_normClip(Object.assign({}, clip, { trackId })));
  return _withClips(next, next.clips);
}

export function removeClip(state, clipId) {
  const next = _clone(state);
  next.clips = next.clips.filter((c) => c.id !== clipId);
  return next;
}

export function moveClip(state, clipId, patch = {}) {
  const next = _clone(state);
  const c = next.clips.find((x) => x.id === clipId);
  if (!c) return next;
  const len = clipLen(c);
  if (patch.trackId != null && next.tracks.some((t) => t.id === patch.trackId)) c.trackId = String(patch.trackId);
  const startTick = Math.max(0, _num(patch.startTick, c.startTick));
  c.startTick = startTick;
  c.endTick = startTick + len;
  return _withClips(next, next.clips);
}

/** 拖边改长度：edge='start'|'end'；start 边同步调 offset，保持素材内容不漂移 */
export function resizeClip(state, clipId, edge, tick) {
  const next = _clone(state);
  const c = next.clips.find((x) => x.id === clipId);
  if (!c) return next;
  const t = Math.max(0, _num(tick, edge === 'start' ? c.startTick : c.endTick));
  if (edge === 'start') {
    const newStart = Math.min(t, c.endTick - 1);
    c.offsetTick = Math.max(0, c.offsetTick + (newStart - c.startTick));
    c.startTick = newStart;
  } else {
    c.endTick = Math.max(c.startTick + 1, t);
  }
  return _withClips(next, next.clips);
}

export function splitClip(state, clipId, atTick) {
  const next = _clone(state);
  const idx = next.clips.findIndex((x) => x.id === clipId);
  if (idx < 0) return next;
  const c = next.clips[idx];
  const at = _num(atTick, 0);
  if (at <= c.startTick || at >= c.endTick) return next;
  const right = Object.assign({}, c, { id: _uid('clip'), startTick: at, offsetTick: c.offsetTick + (at - c.startTick) });
  c.endTick = at;
  next.clips.push(right);
  return _withClips(next, next.clips);
}

export function duplicateClip(state, clipId, patch = {}) {
  const src = findClip(state, clipId);
  if (!src) return _clone(state);
  const start = patch.startTick != null ? patch.startTick : src.endTick;
  return addClip(state, Object.assign({}, src, {
    id: _uid('clip'),
    trackId: patch.trackId != null ? patch.trackId : src.trackId,
    startTick: start, endTick: start + clipLen(src),
  }));
}

export function setTrackFlags(state, trackId, flags = {}) {
  const next = _clone(state);
  const t = next.tracks.find((x) => x.id === trackId);
  if (!t) return next;
  if (flags.mute != null) t.mute = !!flags.mute;
  if (flags.solo != null) t.solo = !!flags.solo;
  if (flags.name != null) t.name = String(flags.name);
  if (flags.height != null) t.height = Math.max(28, _num(flags.height, t.height));
  return next;
}

export function addMarker(state, marker) {
  const next = _clone(state);
  next.markers.push(_normMarker(marker, next.markers.length));
  next.markers.sort((a, b) => a.tick - b.tick);
  return next;
}
export function removeMarker(state, id) {
  const next = _clone(state);
  next.markers = next.markers.filter((m) => m.id !== id);
  return next;
}
export function addRegion(state, region) {
  const next = _clone(state);
  next.regions.push(_normRegion(region, next.regions.length));
  next.regions.sort((a, b) => a.startTick - b.startTick);
  return next;
}
export function removeRegion(state, id) {
  const next = _clone(state);
  next.regions = next.regions.filter((r) => r.id !== id);
  return next;
}

/** 导出/渲染计划：clip → 秒（C4 TimelineModel），供“按 clip 渲染”的离线导出用 */
export function renderPlan(state, timeline, opts = {}) {
  const only = opts.trackId ? state.clips.filter((c) => c.trackId === opts.trackId) : state.clips;
  const sec = (tick) => secOfTick(timeline, tick);
  return only.map((c) => ({
    clipId: c.id, trackId: c.trackId,
    startTick: c.startTick, endTick: c.endTick, offsetTick: c.offsetTick,
    startSec: sec(c.startTick), endSec: sec(c.endTick),
    offsetSec: sec(c.offsetTick) - sec(0),
    durationSec: sec(c.endTick) - sec(c.startTick),
  })).sort((a, b) => a.startSec - b.startSec);
}

/** 双击聚焦：clip → 卷帘里应定位到的原曲 tick 区间 */
export function focusRangeOfClip(clip) {
  return { fromTick: clip.offsetTick, toTick: clip.offsetTick + clipLen(clip), trackId: clip.trackId };
}

/* ============================================================
 * P1-1c 编排持久化 + 按 clip 渲染计划
 * ============================================================ */
function _plainArrState(state) {
  return {
    tracks: (state.tracks || []).map((t) => ({ id: t.id, name: t.name, color: t.color, mute: !!t.mute, solo: !!t.solo, height: t.height })),
    clips: (state.clips || []).map((c) => ({ id: c.id, trackId: c.trackId, startTick: c.startTick, endTick: c.endTick, offsetTick: c.offsetTick, name: c.name, color: c.color })),
    markers: (state.markers || []).map((m) => ({ id: m.id, title: m.title, tick: m.tick, color: m.color })),
    regions: (state.regions || []).map((r) => ({ id: r.id, name: r.name, startTick: r.startTick, endTick: r.endTick, color: r.color })),
  };
}

/** 把编排状态挂到 song 上（工程保存/会话恢复用；纯数据，可 JSON 序列化） */
export function writeArrangeToSong(song, state) {
  if (!song) return null;
  const plain = _plainArrState(state || createArrangeState({}));
  song.arrange = plain;
  return plain;
}

/** 从 song 读编排状态；没有/不合法返回 null（调用方自己建默认） */
export function readArrangeFromSong(song) {
  if (!song || !song.arrange) return null;
  try {
    const st = createArrangeState(song.arrange);
    return validateArrangeState(st).ok ? st : null;
  } catch (e) { return null; }
}

/** 按当前曲目生成默认编排：有音符的轨道各一个整曲 clip（最多 16 轨，避免超宽） */
export function defaultArrangeState(song, opts = {}) {
  if (!song) return createArrangeState({});
  const maxTracks = Math.max(1, Number(opts.maxTracks) || 16);
  const tracks = [];
  const clips = [];
  const end = Math.max(1920, song.totalTicks || 0);
  (song.tracks || []).forEach((tr, i) => {
    if (!tr.notes || !tr.notes.length) return;
    if (tracks.length >= maxTracks) return;
    const id = 't' + i;
    tracks.push({ id, name: tr.name || ('轨道 ' + (i + 1)), mute: !!tr.mute, solo: !!tr.solo });
    clips.push({ id: 'clip-' + (i + 1), trackId: id, startTick: 0, endTick: end, offsetTick: 0, name: tr.name || ('轨道 ' + (i + 1)) });
  });
  return createArrangeState({ tracks, clips });
}

/**
 * 按 clip 渲染计划（P1-1c）：
 *   每个 clip 需要「从原曲 offsetSec 起渲染 durationSec，再放到 arrange 时间线的 placeSec」。
 * 返回 { jobs, totalSec }；jobs 已按 placeSec 排序。scale=播放倍速（导出时若 1.5×，两边时间同除）。
 */
export function clipsRenderJobs(state, timeline, opts = {}) {
  const scale = Math.max(0.05, Number(opts.scale) || 1);
  const sec = (tick) => secOfTick(timeline, Math.max(0, Math.round(tick || 0)));
  const jobs = (state.clips || []).map((c) => {
    const srcStart = sec(c.offsetTick) / scale;
    const srcEnd = sec(c.offsetTick + clipLen(c)) / scale;
    const place = sec(c.startTick) / scale;
    return {
      clipId: c.id, trackId: c.trackId, name: c.name,
      placeSec: place, sourceStartSec: srcStart, sourceEndSec: srcEnd,
      durationSec: Math.max(0, srcEnd - srcStart),
    };
  }).filter((j) => j.durationSec > 0).sort((a, b) => a.placeSec - b.placeSec);
  const totalSec = jobs.reduce((m, j) => Math.max(m, j.placeSec + j.durationSec), 0);
  return { jobs, totalSec };
}
