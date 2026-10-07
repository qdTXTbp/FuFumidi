// -*- coding: utf-8 -*-
/**
 * `.fufumidi` —— 自包含歌声工程包（P0）。
 *
 * ## 为什么要有它
 *
 * 参照 AltZin Studio 的 `.azs`：一个 zip，里面是 `project.json` + `files/`。
 * 在它之前，本应用的编辑器状态是**纯内存**的（Pinia store），关掉就没了；
 * 而伴奏轨 `AudioClip.path` 存的是**本机绝对路径**，换一台机器或挪一下文件就断链。
 *
 * 所以格式定死两条：
 *   1. 工程包里**不写任何本机绝对路径** —— 外部文件一律进 `files/`，
 *      轨道上只留一个 `asset` id 引用它；
 *   2. 序列化走**白名单** —— 只写认识得字段。这样以后往 `SingTrack`
 *      加字段不会自动泄露进文件，反过来旧版程序读到新字段也不会崩。
 *
 * ## 包内布局
 *
 * ```
 * project.json            清单（见 serializeProject）
 * files/<assetId><ext>    伴奏等外部文件（assetId 只含 [A-Za-z0-9_-]）
 * ```
 *
 * ## 兼容性
 *
 * `version` 大于本模块 `FORMAT_VERSION` 时**拒绝打开**并提示升级 ——
 * 宁可明确报错，也不要拿半懂的数据去覆盖用户的工程。
 */

import { normalizeSampleNote } from './utau_tools.js';

/** 清单里的格式标识（拒绝别的格式误当工程打开） */
export const FORMAT_ID = 'fufumidi-song';
/** 当前写入的版本号 */
export const FORMAT_VERSION = 1;
/** 扩展名（不含点） */
export const PROJECT_EXT = 'fufumidi';

/** `files/` 里的资产 id：会成为文件名的一部分，所以字符集必须收紧 */
const ASSET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 拍号分母的合法集合（1/2/4/8/16/32 分音符） */
const SIG_DENS = [1, 2, 4, 8, 16, 32];

/* ------------------------------------------------------------------ 多点变速 / 拍号 */
//
// 这两组字段是 `.fufumidi` 与 OpenUtau `.ustx` 互转的「交换面」：
//   * ustx 的 tempos/timeSignatures 是多点列表（tick 单位）；
//   * 本工程的时间轴以**拍**为单位（tick = beat × 480，与 tempo 无关）。
// `bpm` 标量仍是**首点真源**（BPM 输入框改的是它），序列化时强制回填 tempoMap[0]。

/** 清洗多点变速：非法点丢弃、首点强制 beat=0 且 bpm 取标量、同拍去重 */
function serializeTempoMap(list, scalarBpm) {
  const out = [];
  for (const p of (Array.isArray(list) ? list : [])) {
    const bpm = clamp(num(p && p.bpm, NaN), 20, 400);
    const beat = num(p && p.beat, NaN);
    if (!Number.isFinite(bpm) || !Number.isFinite(beat) || beat < 0) continue;
    out.push({ beat: Math.round(beat * 1000) / 1000, bpm });
  }
  const bpm0 = clamp(num(scalarBpm, 120), 20, 400);
  const first = out.find((p) => p.beat === 0);
  if (first) first.bpm = bpm0;
  else out.unshift({ beat: 0, bpm: bpm0 });
  out.sort((a, b) => a.beat - b.beat);
  const dedup = [];
  for (const p of out) {
    if (dedup.length && dedup[dedup.length - 1].beat === p.beat) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  return dedup;
}

/** 清洗多点拍号：非法点丢弃、首点强制 beat=0、同拍去重；空表兜底 4/4 */
function serializeSigMap(list) {
  const out = [];
  for (const p of (Array.isArray(list) ? list : [])) {
    const beat = num(p && p.beat, NaN);
    const n = Math.round(num(p && p.num, NaN));
    const d = Math.round(num(p && p.den, NaN));
    if (!Number.isFinite(beat) || beat < 0) continue;
    if (!(n >= 1 && n <= 32) || SIG_DENS.indexOf(d) < 0) continue;
    out.push({ beat: Math.round(beat * 1000) / 1000, num: n, den: d });
  }
  if (!out.some((p) => p.beat === 0)) out.unshift({ beat: 0, num: 4, den: 4 });
  out.sort((a, b) => a.beat - b.beat);
  const dedup = [];
  for (const p of out) {
    if (dedup.length && dedup[dedup.length - 1].beat === p.beat) dedup[dedup.length - 1] = p;
    else dedup.push(p);
  }
  return dedup;
}

let _seq = 0;
function genId(prefix) {
  _seq += 1;
  return prefix + Date.now().toString(36) + _seq.toString(36);
}

/* ------------------------------------------------------------------ 小工具 */

function num(v, d) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
function str(v, d) {
  return typeof v === 'string' ? v : (d === undefined ? '' : d);
}
/** 非法 assetId 一律退化成空串 —— 空串在保存侧会被重新分配，在读侧表示"缺文件" */
export function safeAssetId(v) {
  const s = str(v, '');
  return ASSET_ID_RE.test(s) ? s : '';
}
/** 取扩展名（含点）；没有或过长则空串 */
export function extOf(fileName) {
  const m = str(fileName).match(/\.[A-Za-z0-9]{1,8}$/);
  return m ? m[0] : '';
}
/** 资产在包内的路径 */
export function assetEntryName(id, fileName) {
  return 'files/' + safeAssetId(id) + extOf(fileName);
}

/* ------------------------------------------------------------------ 序列化 */

/* ---- 音素覆写（音素级时间微调；时间量 ms，offset/delta 钳 ±2000）---- */
function normPhonemeOverrides(list) {
  const out = [];
  for (const o of (Array.isArray(list) ? list : []).slice(0, 32)) {
    if (!o || typeof o !== 'object') continue;
    const idx = Math.round(num(o.index, NaN));
    if (!Number.isFinite(idx) || idx < 0 || idx > 63) continue;
    const e = { index: idx };
    for (const k of ['offset', 'preutterDelta', 'overlapDelta']) {
      if (o[k] !== undefined) {
        const v = num(o[k], NaN);
        if (Number.isFinite(v)) e[k] = clamp(v, -2000, 2000);
      }
    }
    if (Object.keys(e).length > 1) out.push(e);   // 只有 index 没有任何值 → 丢弃
  }
  return out;
}

/** 颤音扩展参（vibIn/vibOut/vibShift/vibDrift/vibVolLink）+ 音素覆写 —— 序列化/解析共用一份钳制逻辑 */
function copyVibExt(src, dst) {
  if (src.vibIn !== undefined) dst.vibIn = clamp(num(src.vibIn, 10), 0, 100);
  if (src.vibOut !== undefined) dst.vibOut = clamp(num(src.vibOut, 10), 0, 100);
  if (src.vibShift !== undefined) dst.vibShift = clamp(num(src.vibShift, 0), -100, 100);
  if (src.vibDrift !== undefined) dst.vibDrift = clamp(num(src.vibDrift, 0), -100, 100);
  if (src.vibVolLink !== undefined) dst.vibVolLink = clamp(num(src.vibVolLink, 0), -100, 100);
  const ov = normPhonemeOverrides(src.phonemeOverrides);
  if (ov.length) dst.phonemeOverrides = ov;
}

function serializeNote(n) {
  if (!n || typeof n !== 'object') return null;
  const o = {
    id: str(n.id) || genId('n'),
    startBeat: Math.max(0, num(n.startBeat, 0)),
    durBeat: Math.max(0.125, num(n.durBeat, 1)),
    pitch: clamp(Math.round(num(n.pitch, 60)), 0, 127),
    lyric: str(n.lyric),
    vibrato: !!n.vibrato,
    vibDepth: clamp(num(n.vibDepth, 35), 0, 100),
    vibFreq: clamp(num(n.vibFreq, 5.5), 0, 12),
    vibFade: clamp(num(n.vibFade, 0), 0, 100),
  };
  /* ---- 颤音扩展参（对应上游 UVibrato 的 in/out/shift/drift/volLink；vibFade 是旧字段，保留兼容）----
   * in/out 有互约束（out ≤ 100 − in，照搬 C# setter），序列化侧先各自钳到 [0,100]，
   * 引擎侧 UVibrato 构造时天然满足（setter 会互相压）。 */
  if (n.vibIn !== undefined || n.vibOut !== undefined || n.vibShift !== undefined
    || n.vibDrift !== undefined || n.vibVolLink !== undefined || n.phonemeOverrides !== undefined) {
    copyVibExt(n, o);
  }
  /* ---- UTAU 侧 ---- */
  if (n.velocity !== undefined) o.velocity = clamp(num(n.velocity, 100), 0, 100);
  if (n.volume !== undefined) o.volume = clamp(num(n.volume, 0), 0, 100);
  if (n.flags) o.flags = str(n.flags).slice(0, 256);
  if (n.params && typeof n.params === 'object' && !Array.isArray(n.params)) {
    const p = {};
    for (const k of Object.keys(n.params)) {
      const v = num(n.params[k], NaN);
      if (Number.isFinite(v)) p[str(k).slice(0, 64)] = v;
    }
    if (Object.keys(p).length) o.params = p;
  }
  if (n.gender !== undefined) o.gender = clamp(num(n.gender, 0), -100, 100);
  if (n.breath !== undefined) o.breath = clamp(num(n.breath, 0), 0, 100);
  /* ---- DiffSinger 侧 ---- */
  if (n.pitchOffset !== undefined) o.pitchOffset = clamp(num(n.pitchOffset, 0), -100, 100);
  return o;
}

/**
 * 音频片段。★ **不含 `path`** —— 那是本机路径，写进包就失去可移植性。
 */
function serializeAudio(a) {
  if (!a || typeof a !== 'object') return null;
  return {
    asset: safeAssetId(a.asset),
    fileName: str(a.fileName, 'audio').slice(0, 255),
    durationMs: Math.max(0, num(a.durationMs, 0)),
    skip: Math.max(0, num(a.skip, 0)),
    trim: Math.max(0, num(a.trim, 0)),
    fadeIn: Math.max(0, num(a.fadeIn, 0)),
    fadeOut: Math.max(0, num(a.fadeOut, 0)),
    gainDb: clamp(num(a.gainDb, 0), -60, 24),
    muted: !!a.muted,
  };
}

/**
 * 效果链 / 自动化子轨的序列化。
 *
 * ★ 放在 kind 分支**之前** —— 伴奏轨同样可以挂效果与音量/声像子轨。
 * 这里只做"形状"清洗（类型、长度），**值域钳制交给各自模块**（`normalizeFx` /
 * `normalizeCurves` 在读取侧兜底），免得本文件要去认识每个效果的参数范围。
 */
function serializeFx(list) {
  const out = [];
  for (const f of (Array.isArray(list) ? list : [])) {
    if (!f || typeof f !== 'object') continue;
    const type = str(f.type).slice(0, 32);
    if (!type) continue;
    const params = {};
    if (f.params && typeof f.params === 'object') {
      for (const k of Object.keys(f.params)) {
        const v = f.params[k];
        if (typeof v === 'number' && Number.isFinite(v)) params[str(k).slice(0, 32)] = v;
        else if (typeof v === 'string') params[str(k).slice(0, 32)] = str(v).slice(0, 32);
      }
    }
    out.push({ id: str(f.id).slice(0, 64) || genId('fx'), type, enabled: f.enabled !== false, params });
  }
  return out;
}

function serializeCurves(list) {
  const out = [];
  for (const c of (Array.isArray(list) ? list : [])) {
    if (!c || typeof c !== 'object') continue;
    const abbr = str(c.abbr).toUpperCase().slice(0, 8);
    if (!abbr) continue;
    const points = [];
    for (const p of (Array.isArray(c.points) ? c.points : [])) {
      const beat = num(p && p.beat, NaN);
      const value = num(p && p.value, NaN);
      if (Number.isFinite(beat) && Number.isFinite(value)) points.push({ beat, value });
    }
    out.push({ abbr, points });
  }
  return out;
}

/** 只认 `#rgb` / `#rrggbb`（可选 4/8 位带 alpha）；其余一律当成「没设过」 */
function safeColor(v) {
  const s = str(v).trim();
  return /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s.toLowerCase() : '';
}

function serializeTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const o = {
    id: str(t.id) || genId('tr'),
    name: str(t.name).slice(0, 255),
    kind: t.kind === 'audio' ? 'audio' : 'voice',
    fx: serializeFx(t.fx),
    curves: serializeCurves(t.curves),
  };
  if (o.kind === 'audio') {
    o.audio = serializeAudio(t.audio);
    return o;
  }
  o.engine = t.engine === 'diffsinger' ? 'diffsinger' : 'utau';
  // 轨道配色（多轨叠置时认轨的唯一线索）；没设过就不写，读的时候按索引补
  if (t.color) o.color = safeColor(t.color);
  o.singer = str(t.singer);
  if (t.singerName) o.singerName = str(t.singerName).slice(0, 255);
  o.language = str(t.language, 'zh').slice(0, 16) || 'zh';
  o.notes = (Array.isArray(t.notes) ? t.notes : [])
    .map(serializeNote).filter(Boolean);
  /* ---- 片段起点（拍，升序）：轨承载多片段（对齐 OpenUtau/传统 DAW）----
   * 音符仍是轨级绝对拍；partStarts 只记录分段边界，导出 ustx 时按区间切段。 */
  const starts = (Array.isArray(t.partStarts) ? t.partStarts : [])
    .map((s) => num(s, -1)).filter((s) => Number.isFinite(s) && s >= 0)
    .map((s) => Math.round(s * 1000) / 1000);
  if (starts.length) o.partStarts = Array.from(new Set(starts)).sort((a, b) => a - b);
  o.pitchCurve = (Array.isArray(t.pitchCurve) ? t.pitchCurve : [])
    .map((p) => ({ beat: num(p && p.beat, 0), cents: num(p && p.cents, 0) }))
    .filter((p) => Number.isFinite(p.beat) && Number.isFinite(p.cents));
  /* ---- 混音：多轨同时播放时的静音 / 增益（音频轨的同类字段在 `audio` 上）---- */
  o.muted = !!t.muted;
  o.gainDb = clamp(num(t.gainDb, 0), -60, 24);
  if (t.resampler) o.resampler = str(t.resampler).slice(0, 255);
  if (t.wavtool) o.wavtool = str(t.wavtool).slice(0, 255);
  if (t.depth !== undefined && Number.isFinite(num(t.depth, NaN))) {
    o.depth = clamp(num(t.depth, 1), 0, 1);
  }
  if (t.steps !== undefined && Number.isFinite(num(t.steps, NaN))) {
    o.steps = clamp(Math.round(num(t.steps, 20)), 1, 1000);
  }
  return o;
}

/**
 * 把编辑器状态变成「可写盘」的两份东西。
 *
 * @param {object} state  需要的字段：`tracks / bpm / tempoMap / sigMap / keySf /
 *                        device / sampleNote / activeTrackId / meta`，缺的用默认值补。
 *                        `bpm` 标量是变速首点的真源（tempoMap[0].bpm 会被它覆盖）。
 * @returns {{json: object, assets: Array<{id:string, srcPath:string, fileName:string}>}}
 *          `assets` 是**待打包**的源文件清单（`srcPath` 只在保存这一刻有效，不进 json）。
 */
export function serializeProject(state) {
  const s = state || {};
  const tracks = (Array.isArray(s.tracks) ? s.tracks : []).map(serializeTrack).filter(Boolean);

  /* 收集资产：没有 asset 的（刚导入的伴奏）现在分配一个 */
  const assets = [];
  const used = new Set();
  for (const t of tracks) {
    if (t.audio) used.add(t.audio.asset);
  }
  for (const t of tracks) {
    if (t.kind !== 'audio' || !t.audio) continue;
    let id = t.audio.asset;
    if (!id) {
      do { id = genId('a'); } while (used.has(id));
      used.add(id);
      t.audio.asset = id;
    }
    assets.push({
      id: t.audio.asset,
      srcPath: str((s.tracks.find((x) => x && x.id === t.id) || {}).audio?.path),
      fileName: t.audio.fileName,
    });
  }

  const json = {
    format: FORMAT_ID,
    version: FORMAT_VERSION,
    app: 'FuFumidi',
    createdAt: str(s.createdAt) || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    meta: {
      title: str(s.meta && s.meta.title).slice(0, 255),
      comment: str(s.meta && s.meta.comment).slice(0, 4096),
      artist: str(s.meta && s.meta.artist).slice(0, 255),
      // 和声组（M8a）：只存「组名 + 成员轨 id」，成员轨数据本身不在这里
      groups: (Array.isArray(s.meta && s.meta.groups) ? s.meta.groups : []).slice(0, 64).map((g) => ({
        id: str(g && g.id).slice(0, 32),
        name: str(g && g.name).slice(0, 60),
        trackIds: (Array.isArray(g && g.trackIds) ? g.trackIds : []).map((x) => str(x).slice(0, 32)).slice(0, 64),
        muted: !!(g && g.muted),
        solo: !!(g && g.solo),
        gainDb: clamp(num(g && g.gainDb, 0), -24, 24),
      })).filter((g) => g.id && g.trackIds.length),
    },
    bpm: clamp(num(s.bpm, 120), 20, 400),
    /** 多点变速（拍单位，首点 beat=0，bpm 标量是首点真源）—— 对应 ustx tempos */
    tempoMap: serializeTempoMap(s.tempoMap, s.bpm),
    /** 多点拍号 —— 对应 ustx timeSignatures */
    sigMap: serializeSigMap(s.sigMap),
    /** 调号（-7..7，-1=降 B 调方向 … +7=升号方向）—— 对应 ustx key */
    keySf: clamp(Math.round(num(s.keySf, 0)), -7, 7),
    device: ['auto', 'cpu', 'cuda', 'dml'].indexOf(s.device) >= 0 ? s.device : 'auto',
    // ★ 采样基准音是**音名**（C4）；老工程里存过 'a'（当年被当成别名）→ 统一归一化，
    //   否则打开老工程后一点「渲染本轨」就会以「无法解析音名：a」整体失败
    sampleNote: normalizeSampleNote(str(s.sampleNote, '')),
    activeTrackId: str(s.activeTrackId),
    tracks,
    assets: assets.reduce((m, a) => { m[a.id] = { name: a.fileName }; return m; }, {}),
  };
  return { json, assets };
}

/* ------------------------------------------------------------------ 解析 */

function fail(error) { return { ok: false, error }; }

function parseNote(n) {
  if (!n || typeof n !== 'object') return null;
  const o = {
    id: str(n.id) || genId('n'),
    startBeat: Math.max(0, num(n.startBeat, 0)),
    durBeat: Math.max(0.125, num(n.durBeat, 1)),
    pitch: clamp(Math.round(num(n.pitch, 60)), 0, 127),
    lyric: str(n.lyric),
    vibrato: !!n.vibrato,
    vibDepth: clamp(num(n.vibDepth, 35), 0, 100),
    vibFreq: clamp(num(n.vibFreq, 5.5), 0, 12),
    vibFade: clamp(num(n.vibFade, 0), 0, 100),
  };
  if (n.vibIn !== undefined || n.vibOut !== undefined || n.vibShift !== undefined
    || n.vibDrift !== undefined || n.vibVolLink !== undefined || n.phonemeOverrides !== undefined) {
    copyVibExt(n, o);
  }
  if (n.velocity !== undefined) o.velocity = clamp(num(n.velocity, 100), 0, 100);
  if (n.volume !== undefined) o.volume = clamp(num(n.volume, 0), 0, 100);
  if (n.flags) o.flags = str(n.flags).slice(0, 256);
  if (n.params && typeof n.params === 'object' && !Array.isArray(n.params)) {
    const p = {};
    for (const k of Object.keys(n.params)) {
      const v = num(n.params[k], NaN);
      if (Number.isFinite(v)) p[str(k).slice(0, 64)] = v;
    }
    if (Object.keys(p).length) o.params = p;
  }
  if (n.gender !== undefined) o.gender = clamp(num(n.gender, 0), -100, 100);
  if (n.breath !== undefined) o.breath = clamp(num(n.breath, 0), 0, 100);
  if (n.pitchOffset !== undefined) o.pitchOffset = clamp(num(n.pitchOffset, 0), -100, 100);
  return o;
}

function parseTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const kind = t.kind === 'audio' ? 'audio' : 'voice';
  const o = {
    id: str(t.id) || genId('tr'),
    name: str(t.name).slice(0, 255),
    kind,
    // 音频轨的 engine 无意义（不参与渲染），但要给个合法值，别让 UI 拿到 undefined
    engine: t.engine === 'diffsinger' ? 'diffsinger' : 'utau',
    singer: '',
    language: 'zh',
    notes: [],
    pitchCurve: [],
    fx: serializeFx(t.fx),
    curves: serializeCurves(t.curves),
  };
  if (kind === 'audio') {
    const a = t.audio && typeof t.audio === 'object' ? t.audio : {};
    o.audio = {
      asset: safeAssetId(a.asset),
      path: '',                 // ★ 由 resolveAssetPaths() 用解包出来的真实路径回填
      fileName: str(a.fileName, 'audio').slice(0, 255),
      durationMs: Math.max(0, num(a.durationMs, 0)),
      skip: Math.max(0, num(a.skip, 0)),
      trim: Math.max(0, num(a.trim, 0)),
      fadeIn: Math.max(0, num(a.fadeIn, 0)),
      fadeOut: Math.max(0, num(a.fadeOut, 0)),
      gainDb: clamp(num(a.gainDb, 0), -60, 24),
      muted: !!a.muted,
    };
    return o;
  }
  o.singer = str(t.singer);
  const col = safeColor(t.color);
  if (col) o.color = col;
  if (t.singerName) o.singerName = str(t.singerName).slice(0, 255);
  o.language = str(t.language, 'zh').slice(0, 16) || 'zh';
  o.notes = (Array.isArray(t.notes) ? t.notes : []).map(parseNote).filter(Boolean);
  o.notes.sort((a, b) => a.startBeat - b.startBeat);
  o.partStarts = (Array.isArray(t.partStarts) ? t.partStarts : [])
    .map((s) => num(s, -1)).filter((s) => Number.isFinite(s) && s >= 0)
    .map((s) => Math.round(s * 1000) / 1000)
    .sort((a, b) => a - b);
  o.pitchCurve = (Array.isArray(t.pitchCurve) ? t.pitchCurve : [])
    .map((p) => ({ beat: num(p && p.beat, 0), cents: num(p && p.cents, 0) }))
    .filter((p) => Number.isFinite(p.beat) && Number.isFinite(p.cents))
    .sort((a, b) => a.beat - b.beat);
  o.muted = !!t.muted;
  o.gainDb = clamp(num(t.gainDb, 0), -60, 24);
  if (t.resampler) o.resampler = str(t.resampler).slice(0, 255);
  if (t.wavtool) o.wavtool = str(t.wavtool).slice(0, 255);
  if (t.depth !== undefined && Number.isFinite(num(t.depth, NaN))) o.depth = clamp(num(t.depth, 1), 0, 1);
  if (t.steps !== undefined && Number.isFinite(num(t.steps, NaN))) o.steps = clamp(Math.round(num(t.steps, 20)), 1, 1000);
  return o;
}

/**
 * 读一份工程清单。任何不认识/不合法的地方都**兜底成合法默认值**，
 * 只有真正无法解读（格式不对 / 版本太新 / 没有轨道）才报错。
 *
 * @param {object} json
 * @returns {{ok:boolean, error?:string, project?:object, assets?:Array<{id,name}>}}
 */
export function parseProject(json) {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    return fail('文件内容不是有效的工程清单');
  }
  if (json.format !== FORMAT_ID) {
    return fail('不是 FuFumidi 工程文件');
  }
  const v = num(json.version, NaN);
  if (!Number.isFinite(v) || v < 1) return fail('工程文件缺少版本号');
  if (v > FORMAT_VERSION) {
    return fail('该工程由更新版本的 FuFumidi 创建（格式 v' + v + '），请升级后再打开');
  }
  if (!Array.isArray(json.tracks)) return fail('工程文件没有轨道数据');

  const tracks = json.tracks.map(parseTrack).filter(Boolean);
  if (!tracks.length) return fail('工程文件里没有可用的轨道');

  const assets = [];
  const assetMap = (json.assets && typeof json.assets === 'object') ? json.assets : {};
  for (const id of Object.keys(assetMap)) {
    const safe = safeAssetId(id);
    if (!safe) continue;                       // 非法 id 直接丢，绝不当文件名用
    const name = str(assetMap[id] && assetMap[id].name, 'audio');
    assets.push({ id: safe, name });
  }

  const meta = (json.meta && typeof json.meta === 'object') ? json.meta : {};
  const tempoMap = serializeTempoMap(json.tempoMap, json.bpm);
  const project = {
    version: v,
    createdAt: str(json.createdAt),
    meta: {
      title: str(meta.title).slice(0, 255),
      comment: str(meta.comment).slice(0, 4096),
      artist: str(meta.artist).slice(0, 255),
      groups: (Array.isArray(meta.groups) ? meta.groups : []).slice(0, 64).map((g) => ({
        id: str(g && g.id).slice(0, 32),
        name: str(g && g.name).slice(0, 60),
        trackIds: (Array.isArray(g && g.trackIds) ? g.trackIds : []).map((x) => str(x).slice(0, 32)).slice(0, 64),
        muted: !!(g && g.muted),
        solo: !!(g && g.solo),
        gainDb: clamp(num(g && g.gainDb, 0), -24, 24),
      })).filter((g) => g.id && g.trackIds.length),
    },
    bpm: tempoMap.length ? tempoMap[0].bpm : clamp(num(json.bpm, 120), 20, 400),
    /** 多点变速 / 拍号 / 调号（旧版工程没有这些字段 → 兜底成默认值） */
    tempoMap,
    sigMap: serializeSigMap(json.sigMap),
    keySf: clamp(Math.round(num(json.keySf, 0)), -7, 7),
    device: ['auto', 'cpu', 'cuda', 'dml'].indexOf(json.device) >= 0 ? json.device : 'auto',
    sampleNote: normalizeSampleNote(str(json.sampleNote, '')),
    activeTrackId: str(json.activeTrackId),
    tracks,
  };
  // 记录的 activeTrackId 必须真的存在，否则 UI 会停在"没选中任何轨"
  if (!tracks.some((t) => t.id === project.activeTrackId)) {
    project.activeTrackId = tracks[0].id;
  }
  return { ok: true, project, assets };
}

/**
 * 用「解包后的真实路径」回填音频轨的 `path`。
 *
 * @param {Array} tracks  parseProject 出来的轨道
 * @param {object} resolved  `{ [assetId]: 本地绝对路径 }`
 * @returns {Array} 新数组（不改动入参）
 */
export function resolveAssetPaths(tracks, resolved) {
  const map = resolved || {};
  return (tracks || []).map((t) => {
    if (t.kind !== 'audio' || !t.audio) return t;
    const p = str(map[t.audio.asset]);
    return Object.assign({}, t, { audio: Object.assign({}, t.audio, { path: p }) });
  });
}

/**
 * 哪些资产没落到本地（文件丢了 / 解包失败）—— UI 要据此提示，
 * 而不是让用户对着一条静音的伴奏轨发呆。
 *
 * @returns {Array<{trackId:string, fileName:string, asset:string}>}
 */
export function missingAssets(tracks) {
  const out = [];
  for (const t of tracks || []) {
    if (t.kind !== 'audio' || !t.audio) continue;
    if (!t.audio.path) out.push({ trackId: t.id, fileName: t.audio.fileName, asset: t.audio.asset });
  }
  return out;
}
