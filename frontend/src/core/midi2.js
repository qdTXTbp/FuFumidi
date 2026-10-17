// ============================================================
// P2-3 MIDI 2.0 / MPE / MIDI Clock（纯逻辑，先做协议层）
// ============================================================
// 本模块不碰 Web MIDI / 主进程：只负责
//   1. UMP（Universal MIDI Packet）编解码：MT2 = MIDI 1.0 通道消息，MT4 = MIDI 2.0 通道消息
//   2. MPE（MIDI Polyphonic Expression）通道分配与逐音表情消息
//   3. MIDI Clock（24 PPQN）发/收状态机 + Song Position Pointer
// 设备 I/O 由调用方接（Web MIDI 或主进程 midiout），这里保证协议正确、可测。
//
// 参考：MIDI 2.0 spec（UMP 32-bit words）、MIDI Polyphonic Expression 1.0（lower/upper zone）。

/* ---------------- UMP 编解码 ---------------- */

export const UMP_MT_MIDI1 = 0x2;   // MIDI 1.0 Channel Voice（32-bit 单字）
export const UMP_MT_MIDI2 = 0x4;   // MIDI 2.0 Channel Voice（64-bit 双字）

/**
 * MIDI 1.0 通道消息 → UMP（MT2，32-bit）
 * @param {{group?:number, status:number, channel?:number, data1?:number, data2?:number}} m
 * @returns {number} uint32（用 >>> 0 保证无符号）
 */
export function umpFromMidi1(m) {
  const group = clampInt(m.group, 0, 15, 0);
  const status = clampInt(m.status, 0x80, 0xff, 0x90) & 0xf0;
  const channel = clampInt(m.channel, 0, 15, 0) & 0x0f;
  const d1 = clampInt(m.data1, 0, 127, 0) & 0x7f;
  const d2 = clampInt(m.data2, 0, 127, 0) & 0x7f;
  return ((((UMP_MT_MIDI1 << 28) >>> 0) | (group << 24) | (status << 16) | (channel << 16) | (d1 << 8) | d2) >>> 0);
}

/** UMP(MT2) → MIDI 1.0 通道消息；非 MT2 返回 null */
export function umpToMidi1(word) {
  const w = word >>> 0;
  const mt = (w >>> 28) & 0x0f;
  if (mt !== UMP_MT_MIDI1) return null;
  return {
    group: (w >>> 24) & 0x0f,
    status: (w >>> 16) & 0xf0,
    channel: (w >>> 16) & 0x0f,
    data1: (w >>> 8) & 0x7f,
    data2: w & 0x7f,
  };
}

/**
 * MIDI 2.0 通道消息 → UMP（MT4，返回 [word0, word1]）。
 * 支持：noteOn/Off（velocity16）、perNotePitchBend（32-bit 有符号）、CC（32-bit 值）、channelPressure。
 * @param {{group?:number, status:number, channel?:number, note?:number, index?:number,
 *          value16?:number, value32?:number, attributeType?:number}} m
 */
export function umpFromMidi2(m) {
  const group = clampInt(m.group, 0, 15, 0);
  // MIDI 2.0 的状态半字节范围是 0x0~0xf（逐音弯音是 0x6，不是 0x8+），别按 MIDI 1.0 的 0x80 下限夹
  const status = clampInt(m.status, 0, 0xff, 0x80) & 0xf0;
  const channel = clampInt(m.channel, 0, 15, 0) & 0x0f;
  const index = clampInt(m.note != null ? m.note : m.index, 0, 127, 0) & 0x7f;
  const attr = clampInt(m.attributeType, 0, 255, 0) & 0xff;
  const w0 = (((UMP_MT_MIDI2 << 28) | (group << 24) | (status << 16) | (channel << 16) | (index << 8) | attr) >>> 0);
  let w1;
  if (status === 0x60) {                 // Per-Note Pitch Bend：32-bit signed，中心 0
    const v = Number(m.value32) || 0;
    w1 = v >>> 0;
  } else {
    const v16 = clampInt(m.value16, 0, 0xffff, 0);
    w1 = ((v16 << 16) >>> 0);
  }
  return [w0, w1];
}

/** UMP(MT4) → MIDI 2.0 通道消息；非 MT4 返回 null */
export function umpToMidi2(w0, w1) {
  const a = w0 >>> 0, b = w1 >>> 0;
  const mt = (a >>> 28) & 0x0f;
  if (mt !== UMP_MT_MIDI2) return null;
  const status = (a >>> 16) & 0xf0;
  const out = {
    group: (a >>> 24) & 0x0f,
    status,
    channel: (a >>> 16) & 0x0f,
    index: (a >>> 8) & 0x7f,
    attributeType: a & 0xff,
  };
  if (status === 0x60) out.value32 = b | 0;        // 转回有符号
  else out.value16 = (b >>> 16) & 0xffff;
  return out;
}

/** 16-bit 力度 → 0..127（显示/兼容 MIDI 1.0 设备） */
export function velocity16To7(v) { return Math.max(0, Math.min(127, Math.round((Number(v) || 0) / 65535 * 127))); }
export function velocity7To16(v) { return Math.max(0, Math.min(65535, Math.round((Number(v) || 0) / 127 * 65535))); }

/* ---------------- MPE ---------------- */

export const MPE_LOWER = 'lower';
export const MPE_UPPER = 'upper';

/**
 * MPE 通道分配器（默认 lower zone：master=0，members=1..15）。
 * 规则（MPE 1.0）：master 通道发 zone 级消息，member 通道一音一通道；
 * 释放后的 member 放回池子（后进先出，避免通道频繁跳变）。
 */
export function createMpeState(opts = {}) {
  const zone = opts.zone === MPE_UPPER ? MPE_UPPER : MPE_LOWER;
  const members = Math.max(1, Math.min(15, Number(opts.members) || 15));
  const st = {
    zone,
    masterChannel: zone === MPE_UPPER ? 15 : 0,
    members: [],
    free: [],
    /** @type {Map<number, {channel:number, velocity:number}>} */
    notes: new Map(),
    /** 每音最近一次表情，便于"新音继承"或重发 */
    lastExpr: new Map(),
  };
  // lower：1..members；upper：15-members..14
  const start = zone === MPE_LOWER ? 1 : (15 - members);
  for (let i = 0; i < members; i++) st.members.push(start + i);
  for (let i = st.members.length - 1; i >= 0; i--) st.free.push(st.members[i]);
  return st;
}

/** 分配一个 member 通道（没空返回 -1） */
export function mpeAllocChannel(st) {
  if (!st || !st.free.length) return -1;
  return st.free.pop();
}
export function mpeReleaseChannel(st, channel) {
  if (!st || channel == null) return false;
  if (!st.members.includes(channel)) return false;
  if (!st.free.includes(channel)) st.free.push(channel);
  return true;
}

/**
 * 按下音符：分配 member 通道并返回 MIDI 1.0 消息（通道为 member 通道）。
 * @returns {{channel:number,note:number,velocity:number}|null}
 */
export function mpeNoteOn(st, note, velocity = 100) {
  if (!st) return null;
  const n = clampInt(note, 0, 127, 60);
  if (st.notes.has(n)) mpeNoteOff(st, n);       // 同音重按：先释放旧通道
  const ch = mpeAllocChannel(st);
  if (ch < 0) return null;
  st.notes.set(n, { channel: ch, velocity: velocity });
  return { channel: ch, note: n, velocity: clampInt(velocity, 0, 127, 100) };
}

/** 松开音符：返回应发 note-off 的 member 通道 */
export function mpeNoteOff(st, note) {
  if (!st) return null;
  const n = clampInt(note, 0, 127, 60);
  const rec = st.notes.get(n);
  if (!rec) return null;
  st.notes.delete(n);
  mpeReleaseChannel(st, rec.channel);
  return { channel: rec.channel, note: n, velocity: 0 };
}

/**
 * 逐音音高弯曲（semitones → member 通道 pitch bend 14-bit，默认 ±48 半音范围）。
 * 返回 {channel,value14} 或 null（该音没按下）。
 */
export function mpePitchBend(st, note, semitones, rangeSemitones = 48) {
  if (!st) return null;
  const rec = st.notes.get(clampInt(note, 0, 127, 60));
  if (!rec) return null;
  const span = Math.max(1e-6, Number(rangeSemitones) || 48);
  const norm = Math.max(-1, Math.min(1, (Number(semitones) || 0) / span));
  const value14 = Math.max(0, Math.min(16383, Math.round(8192 + norm * 8192)));
  return { channel: rec.channel, value14, group: st.zone };
}

/** 逐音音色（MPE 用 CC74），value 0..127 */
export function mpeTimbre(st, note, value) {
  if (!st) return null;
  const rec = st.notes.get(clampInt(note, 0, 127, 60));
  if (!rec) return null;
  return { channel: rec.channel, cc: 74, value: clampInt(value, 0, 127, 64) };
}

/** 逐音通道压力（aftertouch），value 0..127 */
export function mpePressure(st, note, value) {
  if (!st) return null;
  const rec = st.notes.get(clampInt(note, 0, 127, 60));
  if (!rec) return null;
  return { channel: rec.channel, value: clampInt(value, 0, 127, 0) };
}

export function mpeActiveNotes(st) { return st ? Array.from(st.notes.entries()).map(([note, r]) => ({ note, channel: r.channel })) : []; }
export function mpeFreeChannels(st) { return st ? st.free.slice() : []; }

/* ---------------- MIDI Clock ---------------- */

export const PPQN = 24;   // MIDI 时钟固定 24 脉冲/四分音符

/**
 * 时钟发生器：由传输层按实际时间推进。
 * 用法：start(); 每帧 advance(nowSec) → 返回这一帧应发多少个 clock pulse；
 *       停止后不再发；setBpm() 只影响之后的推进（不追算过去）。
 */
export function createMidiClock(opts = {}) {
  const ppqn = Math.max(1, Number(opts.ppqn) || PPQN);
  const st = {
    ppqn,
    bpm: Math.max(1, Number(opts.bpm) || 120),
    playing: false,
    lastSec: 0,
    pulses: 0,        // 已发脉冲（从 start 起累计）
    phase: 0,         // 不足一个脉冲的分数部分（避免累积漂移）
    startPulses: 0,   // start() 时的基准（pause 继续时用）
  };
  function start(nowSec = 0) {
    st.playing = true;
    st.lastSec = Number(nowSec) || 0;
    st.phase = 0;
    return { type: 'start' };
  }
  function resume(nowSec = 0) {
    st.playing = true;
    st.lastSec = Number(nowSec) || 0;
    st.startPulses = st.pulses;
    return { type: 'continue' };
  }
  function stop() {
    st.playing = false;
    return { type: 'stop' };
  }
  function setBpm(v) { st.bpm = Math.max(1, Math.min(999, Number(v) || st.bpm)); return st.bpm; }
  /** 推进到 nowSec，返回这一帧应发的 clock 数量（整数） */
  function advance(nowSec) {
    if (!st.playing) { st.lastSec = Number(nowSec) || st.lastSec; return 0; }
    const now = Number(nowSec) || 0;
    const dt = Math.max(0, now - st.lastSec);
    st.lastSec = now;
    // 每拍 ppqn 个脉冲；每秒拍数 = bpm/60
    const exact = dt * (st.bpm / 60) * st.ppqn + st.phase;
    const n = Math.floor(exact + 1e-9);
    st.phase = exact - n;
    st.pulses += n;
    return n;
  }
  /** 当前 song position（以四分音符计，含暂停期间已经过的部分） */
  function positionBeats() { return st.pulses / st.ppqn; }
  /** Song Position Pointer 的 14-bit 值（单位：MIDI beat = 6 个 clock = 1/4 音符） */
  function spp() {
    const beats = Math.max(0, Math.min(16383, Math.floor(positionBeats())));
    return { lsb: beats & 0x7f, msb: (beats >> 7) & 0x7f, beats };
  }
  function reset() { st.playing = false; st.lastSec = 0; st.pulses = 0; st.phase = 0; st.startPulses = 0; }
  function state() { return { ppqn: st.ppqn, bpm: st.bpm, playing: st.playing, pulses: st.pulses, phase: st.phase }; }
  return { start, resume, stop, setBpm, advance, positionBeats, spp, reset, state, get ppqn() { return st.ppqn; } };
}

/**
 * 静态 BPM 下的时钟脉冲时间表（导出/测试用）：返回每个 pulse 的秒数时间点。
 * @param {{bpm:number, seconds:number, startSec?:number, ppqn?:number}} p
 */
export function clockSchedule(p) {
  const bpm = Math.max(1, Number(p && p.bpm) || 120);
  const secs = Math.max(0, Number(p && p.seconds) || 0);
  const start = Number(p && p.startSec) || 0;
  const ppqn = Math.max(1, Number(p && p.ppqn) || PPQN);
  const interval = 60 / bpm / ppqn;
  const out = [];
  for (let t = start; t < start + secs - 1e-9; t += interval) out.push(Math.round(t * 1e6) / 1e6);
  return out;
}

/** 采样率无关的 clock 抖动统计（接收侧用）：返回 {count, meanMs, p95Ms, maxMs} */
export function clockJitter(times) {
  const ts = (Array.isArray(times) ? times : []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (ts.length < 2) return { count: ts.length, meanMs: 0, p95Ms: 0, maxMs: 0 };
  const d = [];
  for (let i = 1; i < ts.length; i++) d.push((ts[i] - ts[i - 1]) * 1000);
  const mean = d.reduce((a, b) => a + b, 0) / d.length;
  const dev = d.map((x) => Math.abs(x - mean)).sort((a, b) => a - b);
  return {
    count: ts.length,
    meanMs: Math.round(mean * 1000) / 1000,
    p95Ms: Math.round((dev[Math.min(dev.length - 1, Math.floor(dev.length * 0.95))] || 0) * 1000) / 1000,
    maxMs: Math.round(Math.max(...dev) * 1000) / 1000,
  };
}

function clampInt(v, lo, hi, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.round(n))) : def;
}
