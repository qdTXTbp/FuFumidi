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
  let ticksPerBeat = div & 0x7fff;
  /* v6.0.0 P0-6：SMPTE division（高字节是负 fps 的二补码，低字节是每帧 tick 数）。
     例：0xE728 = fps 25、40 ticks/frame；时间换算走 smpte，不再用 tempoMap 积分。 */
  let smpte = null;
  if (div & 0x8000) {
    const fps = 256 - ((div >> 8) & 0xff);
    const ticksPerFrame = div & 0xff;
    if (fps > 0 && ticksPerFrame > 0) { smpte = { fps, ticksPerFrame }; ticksPerBeat = ticksPerFrame; }
  }

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
        else if (mt === 0x59) { let sf = u8(); if (sf >= 128) sf -= 256; const mi = u8(); events.push({ tick, type: 'key', sf, mi }); }  // sf 是带符号字节（-7..7）
        else if (mt === 0x02) { events.push({ tick, type: 'copyright', text: ascii(ml) }); }
        else if (mt === 0x03) { const s = ascii(ml); if (!name) name = s; events.push({ tick, type: 'name', text: s }); }
        /* ★ v6.0.0 P0-1：meta 文本要按类型分开保留 —— 0x01 文本 / 0x05 歌词 / 0x06 marker / 0x07 cue。
           旧实现把 0x06 和 0x01 都记成 'text'，导出时 marker 与普通文本会互相覆盖。 */
        else if (mt === 0x01) { events.push({ tick, type: 'text', text: ascii(ml) }); }
        else if (mt === 0x05) { events.push({ tick, type: 'lyric', text: ascii(ml) }); }
        else if (mt === 0x06) { events.push({ tick, type: 'marker', text: ascii(ml) }); }
        else if (mt === 0x07) { events.push({ tick, type: 'cue', text: ascii(ml) }); }
        else { for (let i = 0; i < ml; i++) u8(); }
      } else if (status === 0xf0 || status === 0xf7) {
        const sl = vlq(); for (let i = 0; i < sl; i++) u8();
      } else {
        const ty = status & 0xf0; ch = status & 0x0f;
        if (ty === 0x80) { const n = u8(); u8(); close(n); }
        else if (ty === 0x90) { const n = u8(), v = u8(); if (v === 0) close(n); else { if (active.has(n)) close(n); active.set(n, { start: tick, vel: v, ch }); } }
        else if (ty === 0xc0) { program = u8(); events.push({ tick, type: 'program', program, ch }); }
        else if (ty === 0xb0) { const cc = u8(), cv = u8(); ccs.push({ tick, cc, cv, ch }); if (cc === 7) events.push({ tick, type: 'cc7', val: cv }); }
        else if (ty === 0xe0) { const lo = u8(), hi = u8(); events.push({ tick, type: 'bend', val: (hi << 7) | lo, ch }); }
        /* ★ v6.0.0 P0-1：aftertouch 不能再丢（旧实现读完就扔，导出必然丢事件）。
           0xA0 = 复音触后（note + pressure）；0xD0 = 通道触后（pressure）。 */
        else if (ty === 0xa0) { const n = u8(), v = u8(); events.push({ tick, type: 'polytouch', note: n, val: v, ch }); }
        else if (ty === 0xd0) { const v = u8(); events.push({ tick, type: 'chaintouch', val: v, ch }); }
        else { for (let i = 0; i < 2; i++) { if (p < end) u8(); } }
      }
    }
    for (const [n, a] of active) notes.push({ start: a.start, end: tick, midi: n, vel: a.vel, ch: a.ch });
    tracks.push({ name, program, ch, notes, events, ccs });
  }
  return { format, ntrks, ticksPerBeat, divisionRaw: div, smpte, tracks };
}

/* ---------------- 编码 ---------------- */
function vlqBytes(v) {
  v = Math.max(0, Math.round(v));
  const out = [v & 0x7f]; v >>= 7;
  while (v > 0) { out.unshift((v & 0x7f) | 0x80); v >>= 7; }
  return out;
}
function asciiBytes(s) { return Array.from(new TextEncoder().encode(s)); }

/* ---------------- 编码（v6.0.0 P0-1：事件级保真 + 正确的 format 1） ---------------- */
function metaText(type, text) {
  const b = asciiBytes(String(text == null ? "" : text));
  return [0xff, type, ...vlqBytes(b.length), ...b];
}
function metaKey(sf, mi) {
  return [0xff, 0x59, 2, (Math.round(Number(sf) || 0)) & 0xff, (Math.round(Number(mi) || 0)) & 0xff];
}

/* 同一 tick 内的写出顺序：meta → program → note-off → CC/bend/触后 → note-on。
   旧实现只把 note-off 提到最前，导致「同一 tick 的 meta 与 note-on」顺序不稳定；
   解析回来时 delta/事件次序就与源文件不一致（round-trip 对比会红）。 */
function evRank(bytes) {
  const st = bytes[0];
  if (st === 0xff) return 0;
  if ((st & 0xf0) === 0xc0) return 1;
  if ((st & 0xf0) === 0x80) return 2;
  if ((st & 0xf0) === 0x90) return 4;
  return 3;
}

/** 从轨道事件里兜底收集全局 meta（未显式传 tempoMap/sigMap/keySig 时用） */
function collectMeta(tracks, type) {
  const seen = new Map();
  for (const tr of tracks) for (const e of (tr.events || [])) {
    if (!e || e.type !== type) continue;
    const tick = Math.max(0, Math.round(e.tick || 0));
    seen.set(tick, Object.assign({}, e, { tick }));
  }
  return [...seen.values()].sort((a, b) => a.tick - b.tick);
}

export function encodeMidi(tracks, opts = {}) {
  tracks = Array.isArray(tracks) ? tracks : [];
  let div = clamp(Math.round(opts.division || opts.ticksPerBeat || 480), 24, 0x7fff);
  const smpte = opts.smpte && Number(opts.smpte.fps) > 0
    ? { fps: clamp(Math.round(Number(opts.smpte.fps)), 1, 255), ticksPerFrame: clamp(Math.round(Number(opts.smpte.ticksPerFrame) || 40), 1, 255) }
    : null;
  if (smpte) div = (((256 - smpte.fps) & 0xff) << 8) | (smpte.ticksPerFrame & 0xff);
  /* ★ P0-1：format 必须按轨数决定 —— 旧实现写死 format 0 却带 ntrks>1（格式 0 是多轨合并语义，
     多轨 format 0 在多数 DAW 里会被拆错轨）。 >1 轨写 1；opts.format 可显式覆盖（导出测试用）。 */
  const format = opts.format != null ? (Math.round(Number(opts.format)) === 1 ? 1 : 0) : (tracks.length > 1 ? 1 : 0);
  const ntrks = Math.max(1, tracks.length);

  // ---- 全局 meta：tempo / 拍号 / 调号（写在 0 号轨，format 1 的 conductor track 约定） ----
  const tempoList = (Array.isArray(opts.tempoMap) && opts.tempoMap.length) ? opts.tempoMap : collectMeta(tracks, "tempo");
  const sigList = (Array.isArray(opts.sigMap) && opts.sigMap.length) ? opts.sigMap : collectMeta(tracks, "sig");
  const metaEvs = [];
  const tempoSeen = new Map();
  for (const e of tempoList) {
    if (!e) continue;
    const tick = Math.max(0, Math.round(e.tick || 0));
    const us = clamp(Math.round(e.us || 500000), 1, 0xffffff);
    tempoSeen.set(tick, { tick, bytes: [0xff, 0x51, 3, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff], order: 0 });
  }
  for (const v of tempoSeen.values()) metaEvs.push(v);
  const sigSeen = new Map();
  for (const e of sigList) {
    if (!e) continue;
    const tick = Math.max(0, Math.round(e.tick || 0));
    const denExp = clamp(Math.round(Math.log2(Math.max(1, Number(e.den) || 4))), 0, 7);
    sigSeen.set(tick, { tick, bytes: [0xff, 0x58, 4, (Number(e.num) || 4) & 0xff, denExp, 24, 8], order: 1 });
  }
  for (const v of sigSeen.values()) metaEvs.push(v);
  const keySig = opts.keySig || (collectMeta(tracks, "key")[0] || null);
  if (keySig && (keySig.sf != null || keySig.mi != null)) {
    const tick = Math.max(0, Math.round(keySig.tick || 0));
    metaEvs.push({ tick, bytes: metaKey(keySig.sf, keySig.mi), order: 2 });
  }
  if (opts.copyright) {
    const b = asciiBytes(String(opts.copyright));
    metaEvs.push({ tick: 0, bytes: [0xff, 0x02, ...vlqBytes(b.length), ...b], order: -1 });
  }
  metaEvs.sort((a, b) => a.tick - b.tick || a.order - b.order);

  const chunks = [[0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    (format >> 8) & 0xff, format & 0xff, (ntrks >> 8) & 0xff, ntrks & 0xff, (div >> 8) & 0xff, div & 0xff]];

  tracks.forEach((tr, ti) => {
    const ev = [];
    const ch = (tr.ch != null ? tr.ch : 0) & 0x0f;
    const push = (tick, bytes) => ev.push({ tick: Math.max(0, Math.round(Number(tick) || 0)), bytes, rank: evRank(bytes) });
    if (tr.name) push(0, metaText(0x03, tr.name));
    if (ti === 0) for (const m of metaEvs) push(m.tick, m.bytes);

    // 轨道事件：歌词/文本/marker/cue/bend/触后/中途 program
    const progTicks = new Set();
    for (const e of (tr.events || [])) {
      if (!e || e.type == null) continue;
      const tick = Math.max(0, Math.round(Number(e.tick) || 0));
      const chn = e.ch != null ? (e.ch & 0x0f) : ch;
      if (e.type === "lyric") push(tick, metaText(0x05, e.text));
      else if (e.type === "marker") push(tick, metaText(0x06, e.text));
      else if (e.type === "cue") push(tick, metaText(0x07, e.text));
      else if (e.type === "text") push(tick, metaText(0x01, e.text));
      else if (e.type === "program") { push(tick, [0xc0 | chn, (Number(e.program) || 0) & 0x7f]); progTicks.add(tick); }
      else if (e.type === "bend") {
        const v = clamp(Math.round(Number(e.val) || 0), 0, 0x3fff);
        push(tick, [0xe0 | chn, v & 0x7f, (v >> 7) & 0x7f]);
      } else if (e.type === "polytouch") {
        push(tick, [0xa0 | chn, clamp(Math.round(Number(e.note) || 0), 0, 127), clamp(Math.round(Number(e.val) || 0), 0, 127)]);
      } else if (e.type === "chaintouch") {
        push(tick, [0xd0 | chn, clamp(Math.round(Number(e.val) || 0), 0, 127)]);
      }
      // tempo/sig/key/name/cc7 不在这里写：tempo/sig/key 走全局 meta，name 在轨首写，cc7 走 ccs
    }
    // tr.program 是"轨首音色"；若轨道里已有任何 program 事件（来自源文件的中途换音色），
    // 不能再补一个 tick0 的 program（会把中途最终音色错写回开头）。
    if (tr.program != null && progTicks.size === 0) push(0, [0xc0 | ch, Number(tr.program) & 0x7f]);
    for (const p of (tr.pcs || [])) {
      if (!p || p.program == null) continue;
      const pch = p.ch != null ? (p.ch & 0x0f) : ch;
      push(Math.max(0, Math.round(Number(p.tick) || 0)), [0xc0 | pch, Number(p.program) & 0x7f]);
    }
    for (const n of (tr.notes || [])) {
      if (!n || n.midi == null) continue;
      const nch = n.ch != null ? (n.ch & 0x0f) : ch;
      const v = clamp(n.vel != null ? n.vel : 100, 1, 127);
      push(n.start, [0x90 | nch, n.midi & 0x7f, v]);
      push(n.end, [0x80 | nch, n.midi & 0x7f, 64]);
    }
    for (const c of (tr.ccs || [])) {
      if (!c || c.cc == null) continue;
      const cch = c.ch != null ? (c.ch & 0x0f) : ch;
      push(Math.max(0, Math.round(Number(c.tick) || 0)), [0xb0 | cch, c.cc & 0x7f, (c.cv != null ? c.cv : c.val) & 0x7f]);
    }
    // 稳定排序：tick → rank → 原插入序（Array.sort 在现代 V8 是稳定排序）
    ev.sort((a, b) => a.tick - b.tick || a.rank - b.rank);
    let last = 0;
    const body = [];
    for (const e of ev) { body.push(...vlqBytes(e.tick - last), ...e.bytes); last = e.tick; }
    body.push(...vlqBytes(0), 0xff, 0x2f, 0x00);
    chunks.push([0x4d, 0x54, 0x72, 0x6b, (body.length >>> 24) & 0xff, (body.length >>> 16) & 0xff, (body.length >>> 8) & 0xff, body.length & 0xff, ...body]);
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
  /* P1-7：版权元事件（0x02）单独提出来，导出时可回填 */
  let copyright = '';
  for (const tr of mid.tracks) for (const e of (tr.events || [])) { if (e.type === 'copyright' && !copyright) copyright = e.text; }
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
  const smpte = mid.smpte && mid.smpte.fps ? mid.smpte : null;
  function baseSec(tick) {
    if (smpte) return tick / (smpte.fps * smpte.ticksPerFrame);
    let seg = map[0];
    for (let i = map.length - 1; i >= 0; i--) if (map[i].tick <= tick) { seg = map[i]; break; }
    return seg.sec + (tick - seg.tick) * seg.us / 1e6 / tpb;
  }
  function secToTick(sec) {
    if (smpte) return Math.max(0, Number(sec) || 0) * smpte.fps * smpte.ticksPerFrame;
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
  // MIDI 的 program（音色）与 bank（音色库，CC0/CC32）是**通道级**状态：不跟随轨道，
  // 会在一首曲子里中途变化，而且文件常把 setup 事件放在与音符不同的轨道里
  // （例如格式 1 的 24 轨文件里，音符在轨 15~22，但各通道的音色事件分散在不同轨）。
  // 因此这里跨轨道按通道汇总成时间线，回放时逐音符取「该时刻该通道」的真实音色。
  const chanProg = new Map();   // ch -> [{tick, program}]
  const chanCtl = new Map();    // ch -> [{tick, cc, val}]，只收 CC0/CC32（库号）
  const pushTL = (m, ch, item) => { const a = m.get(ch); if (a) a.push(item); else m.set(ch, [item]); };
  for (const tk of mid.tracks) {
    for (const e of tk.events) if (e.type === 'program' && e.ch != null) pushTL(chanProg, e.ch, { tick: e.tick, program: e.program });
    for (const c of (tk.ccs || [])) if (c.ch != null && (c.cc === 0 || c.cc === 32)) pushTL(chanCtl, c.ch, { tick: c.tick, cc: c.cc, val: c.cv });
  }
  const byTick = (a, b) => a.tick - b.tick;
  for (const a of chanProg.values()) a.sort(byTick);
  for (const a of chanCtl.values()) a.sort(byTick);
  // 把 CC0（库号 MSB）/CC32（变体号 LSB）合成为「库号时间线」。
  // 注意不能直接取最后一条事件：文件里 CC32 紧跟 CC0 之后，最后一条的值恒为 0。
  // 库号取 CC0；只有 CC32 的文件（少见）退回用 CC32 的值。
  const chanBank = new Map();   // ch -> [{tick, bank}]
  for (const [ch, arr] of chanCtl) {
    let msb = null, lsb = null, last = -1;
    const out = [];
    for (const r of arr) {
      if (r.cc === 0) msb = r.val; else lsb = r.val;
      const bank = (msb != null ? msb : (lsb != null ? lsb : 0)) & 0x7f;
      if (bank !== last) { out.push({ tick: r.tick, bank }); last = bank; }
    }
    chanBank.set(ch, out);
  }
  // 二分找出「tick 之前最后一条」记录的下标；没有则 -1
  function lastAt(arr, tick) {
    if (!arr || !arr.length || arr[0].tick > tick) return -1;
    let lo = 0, hi = arr.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m].tick <= tick) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  // 通道在 tick 时刻的状态：program 为 null 表示文件没写过（调用方自行给默认值）；bank 默认 0 号库。
  function chanStateAt(ch, tick) {
    let program = null, bank = 0;
    const ps = chanProg.get(ch);
    const pi = lastAt(ps, tick);
    if (pi >= 0) program = ps[pi].program;
    const bs = chanBank.get(ch);
    const bi = lastAt(bs, tick);
    if (bi >= 0) bank = bs[bi].bank;
    return { program, bank };
  }
  let totalTicks = 0;
  for (const tr of tracks) for (const n of tr.notes) totalTicks = Math.max(totalTicks, n.end);
  totalTicks += tpb;
  const song = Object.assign({ format: mid.format, tpb, smpte, tracks, tempoMap: map, sigMap, keySig, copyright, totalTicks, chanStateAt }, meta);
  song.totalSec = baseSec(song.totalTicks);
  song.baseSec = baseSec;
  song.secToTick = secToTick;
  song.initialBpm = Math.round(60e6 / map[0].us);
  // ★ 2026-10-18：小节数必须按**拍号**算（旧写法 ceil(totalTicks / tpb·4) 假定 4/4）。
  //   3/8 的曲子会被算成 1/3 的小节数 → 转谱页/总谱直接截断（实测 87 小节被当成 33 小节）。
  const _s0 = sigMap[0] || { num: 4, den: 4 };
  const _barLen = Math.max(1, Math.round(_s0.num * tpb * 4 / _s0.den));
  song.bars = Math.max(1, Math.ceil(song.totalTicks / _barLen));
  return song;
}
