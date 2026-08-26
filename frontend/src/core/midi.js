// MIDI 解析 / 编码 / 歌曲模型（从 legacy FuFumidi.html 抽取，保持行为一致）
import { clamp, t } from './midi_deps.js';

/* ---------------- 解析 ---------------- */
export function parseMidi(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  if (bytes.length < 14) throw t('文件过短，不是有效的 MIDI');
  let p = 0;
  const u8 = () => bytes[p++];
  const u16 = () => ((u8() << 8) | u8()) & 0xffff;
  const u32 = () => ((u8() << 24) | (u8() << 16) | (u8() << 8) | u8()) >>> 0;
  function ascii(len) { const b = new Uint8Array(len); for (let i = 0; i < len; i++) b[i] = u8(); return new TextDecoder('utf-8').decode(b); }
  function vlq() { let v = 0, b, n = 0; do { b = u8(); v = (v << 7) | (b & 0x7f); } while ((b & 0x80) && ++n < 4); return v; }

  if (ascii(4) !== 'MThd') throw t('不是有效的 MIDI 文件（缺少 MThd 头）');
  u32();
  const format = u16();
  const ntrks = u16();
  const div = u16();
  const ticksPerBeat = div & 0x7fff;
  if (div & 0x8000) throw t('暂不支持 SMPTE 时间码的 MIDI（请转换后重试）');

  const tracks = [];
  if (ntrks > 256) throw t('MIDI 轨道数异常（') + ntrks + t('），拒绝解析');
  for (let tr = 0; tr < ntrks; tr++) {
    if (ascii(4) !== 'MTrk') throw t('轨道块损坏');
    const len = u32(), end = p + len;
    let tick = 0, running = 0, ch = 0, program = -1, name = '';
    const notes = [], active = new Map(), events = [], ccs = [];
    const close = n => {
      const a = active.get(n);
      if (a) { notes.push({ start: a.start, end: tick, midi: n, vel: a.vel, ch: a.ch }); active.delete(n); }
    };
    while (p < end) {
      tick += vlq();
      let status = u8();
      if (status < 0x80) { status = running; p--; } else running = status;
      if (status === 0xff) {
        const mt = u8(), ml = vlq();
        if (mt === 0x2f) break;
        if (mt === 0x51) { const us = (u8() << 16) | (u8() << 8) | u8(); events.push({ tick, type: 'tempo', us }); }
        else if (mt === 0x58) { const num = u8(), den = Math.pow(2, u8()); u8(); u8(); events.push({ tick, type: 'sig', num, den }); }
        else if (mt === 0x59) { const sf = u8(), mi = u8(); events.push({ tick, type: 'key', sf, mi }); }
        else if (mt === 0x03) { const s = ascii(ml); if (!name) name = s; events.push({ tick, type: 'name', text: s }); }
        else if (mt === 0x01 || mt === 0x05 || mt === 0x06) { const s = ascii(ml); events.push({ tick, type: mt === 0x05 ? 'lyric' : 'text', text: s }); }
        else { for (let i = 0; i < ml; i++) u8(); }
      } else if (status === 0xf0 || status === 0xf7) {
        const sl = vlq(); for (let i = 0; i < sl; i++) u8();
      } else {
        const ty = status & 0xf0; ch = status & 0x0f;
        if (ty === 0x80) { const n = u8(); u8(); close(n); }
        else if (ty === 0x90) { const n = u8(), v = u8(); if (v === 0) close(n); else { if (active.has(n)) close(n); active.set(n, { start: tick, vel: v, ch }); } }
        else if (ty === 0xc0) { program = u8(); events.push({ tick, type: 'program', program, ch }); }
        else if (ty === 0xb0) { const cc = u8(), cv = u8(); ccs.push({ tick, cc, cv }); if (cc === 7) events.push({ tick, type: 'cc7', val: cv }); }
        else if (ty === 0xe0) { const lo = u8(), hi = u8(); events.push({ tick, type: 'bend', val: (hi << 7) | lo }); }
        else if (ty === 0xa0) { u8(); u8(); }
        else if (ty === 0xd0) { u8(); }
        else { for (let i = 0; i < 2; i++) { if (p < end) u8(); } }
      }
    }
    for (const [n, a] of active) notes.push({ start: a.start, end: tick, midi: n, vel: a.vel, ch: a.ch });
    tracks.push({ name, program, ch, notes, events, ccs });
  }
  return { format, ntrks, ticksPerBeat, tracks };
}

/* ---------------- 编码 ---------------- */
function vlqBytes(v) {
  v = Math.max(0, Math.round(v));
  const out = [v & 0x7f]; v >>= 7;
  while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>= 7; }
  return out;
}
function asciiBytes(s) { return Array.from(new TextEncoder().encode(s)); }

export function encodeMidi(tracks, opts = {}) {
  const div = opts.division || 480;
  const chunks = [[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, tracks.length, (div >> 8) & 0xff, div & 0xff]];
  const metaEvs = [];
  for (const e of (opts.tempoMap || [])) {
    const us = clamp(Math.round(e.us || 500000), 1, 0xffffff);
    metaEvs.push({ tick: Math.max(0, Math.round(e.tick || 0)), bytes: [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff] });
  }
  for (const e of (opts.sigMap || [])) {
    const denExp = Math.max(0, Math.round(Math.log2(e.den || 4)));
    metaEvs.push({ tick: Math.max(0, Math.round(e.tick || 0)), bytes: [0xff, 0x58, 4, e.num & 0xff, denExp & 0xff, 24, 8] });
  }
  metaEvs.sort((a, b) => a.tick - b.tick);
  tracks.forEach((tr, ti) => {
    const ev = [];
    const ch = tr.ch || 0;
    const push = (tick, bytes) => ev.push({ tick: Math.max(0, Math.round(tick)), bytes });
    if (tr.name) { const nb = asciiBytes(tr.name); push(0, [0xff, 0x03, ...vlqBytes(nb.length), ...nb]); }
    if (tr.program != null) push(0, [0xc0 | ch, tr.program & 0x7f]);
    if (ti === 0) for (const m of metaEvs) push(m.tick, m.bytes);
    for (const n of tr.notes) {
      const v = clamp(n.vel != null ? n.vel : 100, 1, 127);
      push(n.start, [0x90 | ch, n.midi & 0x7f, v]);
      push(n.end, [0x80 | ch, n.midi & 0x7f, 64]);
    }
    for (const c of (tr.ccs || [])) {
      if (!c || c.cc == null) continue;
      push(c.tick || 0, [0xb0 | ch, c.cc & 0x7f, c.cv & 0x7f]);
    }
    ev.sort((a, b) => a.tick - b.tick || (((a.bytes[0] & 0xf0) === 0x80 ? -1 : 1) - ((b.bytes[0] & 0xf0) === 0x80 ? -1 : 1)));
    let last = 0;
    const body = [];
    for (const e of ev) { body.push(...vlqBytes(e.tick - last), ...e.bytes); last = e.tick; }
    body.push(...vlqBytes(0), 0xff, 0x2f, 0x00);
    const trk = [0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff, ...body];
    chunks.push(trk);
  });
  let total = 0; for (const c of chunks) total += c.length;
  const out = new Uint8Array(total); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

/* ---------------- 歌曲模型 ---------------- */
export function buildSong(mid, meta = {}) {
  const tpb = mid.ticksPerBeat;
  const tempoEvents = [], sigEvents = [];
  let keySig = null;
  for (const tr of mid.tracks) for (const e of tr.events) {
    if (e.type === 'tempo') tempoEvents.push({ tick: e.tick, us: e.us });
    else if (e.type === 'sig') sigEvents.push({ tick: e.tick, num: e.num, den: e.den });
    else if (e.type === 'key' && !keySig) keySig = { sf: e.sf, mi: e.mi };
  }
  tempoEvents.sort((a, b) => a.tick - b.tick);
  const map = [{ tick: 0, us: 500000, sec: 0 }];
  for (const e of tempoEvents) {
    const prev = map[map.length - 1];
    if (e.tick === prev.tick) { prev.us = e.us; continue; }
    const sec = prev.sec + (e.tick - prev.tick) * prev.us / 1e6 / tpb;
    map.push({ tick: e.tick, us: e.us, sec });
  }
  sigEvents.sort((a, b) => a.tick - b.tick);
  const sigMap = [{ tick: 0, num: 4, den: 4 }];
  for (const e of sigEvents) {
    const l = sigMap[sigMap.length - 1];
    if (e.tick === l.tick) { l.num = e.num; l.den = e.den; } else sigMap.push({ tick: e.tick, num: e.num, den: e.den });
  }
  function baseSec(tick) {
    let seg = map[0];
    for (let i = map.length - 1; i >= 0; i--) if (map[i].tick <= tick) { seg = map[i]; break; }
    return seg.sec + (tick - seg.tick) * seg.us / 1e6 / tpb;
  }
  function secToTick(sec) {
    if (sec <= 0) return 0;
    let prev = map[0];
    for (let i = 1; i < map.length; i++) {
      const cur = map[i];
      if (sec <= cur.sec) return prev.tick + (sec - prev.sec) * tpb * 1e6 / prev.us;
      prev = cur;
    }
    return prev.tick + (sec - prev.sec) * tpb * 1e6 / prev.us;
  }
  const tracks = mid.tracks.map((tk, i) => ({
    index: i,
    name: tk.name || (t('音轨 ') + (i + 1)),
    ch: tk.ch || 0,
    program: tk.program != null && tk.program >= 0 ? tk.program : 0,
    isDrum: tk.ch === 9,
    notes: tk.notes.slice().sort((a, b) => a.start - b.start),
    events: tk.events,
    ccs: (tk.ccs || []).slice(),
  }));
  let totalTicks = 0;
  for (const tr of tracks) for (const n of tr.notes) totalTicks = Math.max(totalTicks, n.end);
  totalTicks += tpb;
  const song = Object.assign({ format: mid.format, tpb, tracks, tempoMap: map, sigMap, keySig, totalTicks }, meta);
  song.totalSec = baseSec(song.totalTicks);
  song.baseSec = baseSec;
  song.secToTick = secToTick;
  song.initialBpm = Math.round(60e6 / map[0].us);
  song.bars = Math.ceil(song.totalTicks / (tpb * 4));
  return song;
}
