// ============================================================
// P0-3 MIDI 键盘录音引擎（纯逻辑，不碰 Web MIDI / Vue）
// ============================================================
// 设计目标：录音的难点全在这里，UI 只负责把 midiin.js 的事件喂进来、把 take 画出来。
//   · 预备拍（pre-roll）：0/1/2 小节，期间按下的键**不算音**，但若一直按到录音开始则从 0 算；
//   · 循环 take：每绕一圈算一个 pass；replace 只留最后一圈，overdub 全部叠加；
//   · 量化：off / 1/4 / 1/8 / 1/16 / 1/32（或直接给 tick 网格）；
//   · 延迟校准：点击声时间 vs 用户敲击时间 → 中位偏移（稳定性用 p10–p90 跨度衡量）；
//   · 输入延迟补偿：所有事件时间统一减 inputOffsetMs 再换算 tick。
//
// 时间→tick 默认按「开始录音时的 bpm」线性换算；变速曲目可由调用方注入 tickAtMs(ms)。

/** 量化名 → tick 网格（tpb = 四分音符 tick 数） */
export function quantizeGridTicks(name, tpb = 480) {
  switch (String(name == null ? "off" : name)) {
    case "off": case "none": case "": return 0;
    case "1/4": return Math.max(1, Math.round(tpb));
    case "1/8": return Math.max(1, Math.round(tpb / 2));
    case "1/16": return Math.max(1, Math.round(tpb / 4));
    case "1/32": return Math.max(1, Math.round(tpb / 8));
    default: {
      const n = Number(name);
      return Number.isFinite(n) && n > 0 ? Math.max(1, Math.round(n)) : 0;
    }
  }
}

/** tick 吸到网格；grid<=0 时原样取整 */
export function quantizeTick(tick, grid) {
  const t = Math.round(Number(tick) || 0);
  if (!grid || grid <= 0) return t;
  return Math.round(Math.round(t / grid) * grid);
}

function clampInt(v, lo, hi) {
  const n = Math.round(Number(v) || 0);
  return Math.max(lo, Math.min(hi, n));
}
function nowMs() {
  try { return (typeof performance !== "undefined" && performance.now) ? performance.now() : Date.now(); } catch (e) { return Date.now(); }
}

/**
 * 创建录音器。
 * @param {{tpb?:number, bpm?:number, sigNum?:number, sigDen?:number, barTicks?:number,
 *          preRollBars?:number, quantize?:string|number, mode?:'replace'|'overdub',
 *          inputOffsetMs?:number, tickAtMs?:(ms:number)=>number, minVelocity?:number}} opts
 */
export function createRecorder(opts = {}) {
  const tpb = Math.max(1, Math.round(opts.tpb || 480));
  const bpm = Math.max(1, Number(opts.bpm) || 120);
  const sigNum = Math.max(1, Number(opts.sigNum) || 4);
  const sigDen = Math.max(1, Number(opts.sigDen) || 4);
  const barTicks = Math.max(1, Math.round(opts.barTicks || (sigNum * tpb * 4 / sigDen)));
  const preRollBars = clampInt(opts.preRollBars == null ? 1 : opts.preRollBars, 0, 4);
  const gridTicks = quantizeGridTicks(opts.quantize == null ? "off" : opts.quantize, tpb);
  const mode = opts.mode === "replace" ? "replace" : "overdub";
  const inputOffsetMs = Number(opts.inputOffsetMs) || 0;
  const tickAtMs = typeof opts.tickAtMs === "function" ? opts.tickAtMs : null;
  const msPerTick = 60000 / (bpm * tpb);
  const preRollMs = preRollBars * barTicks * msPerTick;

  const st = {
    phase: "idle",            // idle | preroll | recording | stopped
    startMs: 0,
    recStartMs: 0,
    takeStartTick: 0,
    loopStartTick: 0,
    loopEndTick: 0,
    loopLen: 0,
    pass: 0,
    passStartTick: 0,
    passes: [],               // [{notes:[{start,end,midi,vel}]}]（tick 相对 take 起点/当前 pass）
    active: new Map(),        // midi → { start, vel }（绝对 tick，录音阶段）
    held: new Map(),          // 预备拍期间按下的键：midi → vel
    stops: [],
  };

  function rawTick(ms) {
    const t = Number(ms) - inputOffsetMs;
    if (tickAtMs) return tickAtMs(t);
    return st.takeStartTick + (t - st.recStartMs) / msPerTick;
  }
  function relTick(ms) {
    if (st.phase === "preroll") return -1;
    const t = rawTick(ms);
    return Math.max(0, Math.round(t - st.passStartTick));
  }
  function ensurePass() {
    while (st.passes.length <= st.pass) st.passes.push({ notes: [] });
    return st.passes[st.pass];
  }
  function activate(ms) {
    st.phase = "recording";
    const pass = ensurePass();
    // 预备拍期间按住、录音开始时还没松开的键：从 take 开头算音
    for (const [midi, vel] of st.held) {
      st.active.set(midi, { start: 0, vel });
    }
    st.held.clear();
    void pass;
  }
  function maybeActivate(ms) {
    if (st.phase === "preroll" && Number(ms) >= st.recStartMs) activate(ms);
  }

  /** 开始录音：pre-rollBars 小节准备拍后进入正式录音 */
  function start(o = {}) {
    const atMs = o.atMs == null ? nowMs() : Number(o.atMs);
    const startTick = Math.max(0, Math.round(o.startTick || 0));
    const loopStart = Math.max(0, Math.round(o.loopStartTick != null ? o.loopStartTick : startTick));
    const loopEnd = Math.max(loopStart + 1, Math.round(o.loopEndTick != null ? o.loopEndTick : loopStart + barTicks * 4));
    st.phase = preRollMs > 0 ? "preroll" : "recording";
    st.startMs = atMs;
    st.recStartMs = atMs + preRollMs;
    st.takeStartTick = loopStart;
    st.loopStartTick = loopStart;
    st.loopEndTick = loopEnd;
    st.loopLen = loopEnd - loopStart;
    st.pass = 0;
    st.passStartTick = loopStart;
    st.passes = [];
    st.active.clear();
    st.held.clear();
    st.stops = [];
    if (preRollMs <= 0) ensurePass();
    return { phase: st.phase, preRollMs, takeStartTick: loopStart, loopLen: st.loopLen };
  }

  function noteOn(note, velocity, atMs) {
    if (st.phase === "idle" || st.phase === "stopped") return false;
    const midi = clampInt(note, 0, 127);
    const vel = clampInt(velocity == null ? 100 : velocity, 1, 127);
    const ms = atMs == null ? nowMs() : Number(atMs);
    if (st.phase === "preroll") {
      st.held.set(midi, vel);
      maybeActivate(ms);
      return false;
    }
    maybeActivate(ms);
    const rel = relTick(ms);
    const prev = st.active.get(midi);
    if (prev) { closeNote(midi, rel); }        // 同音重复按下：先收掉上一个（键盘常态）
    st.active.set(midi, { start: rel, vel });
    return true;
  }

  function closeNote(midi, endRel) {
    const cur = st.active.get(midi);
    if (!cur) return false;
    st.active.delete(midi);
    const note = { start: Math.max(0, Math.round(cur.start)), end: Math.max(1, Math.round(endRel)), midi, vel: cur.vel };
    if (note.end <= note.start) note.end = note.start + 1;
    ensurePass().notes.push(note);
    return true;
  }

  function noteOff(note, atMs) {
    const ms = atMs == null ? nowMs() : Number(atMs);
    const midi = clampInt(note, 0, 127);
    maybeActivate(ms);   // 预备拍跨过边界后，第一个事件可能就是这个 note-off
    if (st.phase === "preroll") { st.held.delete(midi); return false; }   // 准备期间松开：这个音不算
    if (st.phase !== "recording") return false;
    return closeNote(midi, relTick(ms));
  }

  /** 循环播放绕回起点时调用：结束当前 pass，开始下一圈（按住不放的音会跨圈保持） */
  function advanceLoop() {
    if (st.phase !== "recording") return false;
    st.pass += 1;
    st.passStartTick = st.loopStartTick + st.pass * st.loopLen;
    ensurePass();
    // 跨圈按住的音：在圈尾收尾（不再开新音）。若下一圈继续按着，用户重新按下时会自然成为新音；
    // 这样 loop take 里不会出现同音高叠在一起（DoD：循环 take 不叠音）。
    for (const [midi, cur] of [...st.active]) {
      const endRel = Math.max(1, st.loopLen);
      ensurePassForPrev().notes.push({ start: Math.max(0, cur.start), end: endRel, midi, vel: cur.vel });
      st.active.delete(midi);
    }
    return true;
  }
  function ensurePassForPrev() { return st.passes[st.pass - 1]; }

  /** 停止录音，返回 take（音符已量化、相对 take 起点；replace 只留最后一圈） */
  function stop(atMs) {
    if (st.phase !== "preroll" && st.phase !== "recording") return null;
    const ms = atMs == null ? nowMs() : Number(atMs);
    maybeActivate(ms);   // 预备拍时间已过、但没有新事件：停止这一刻就是要开始录音了
    if (st.phase === "preroll") {
      // 预备拍期间就停了：没有 take
      st.phase = "stopped";
      st.held.clear();
      return null;
    }
    maybeActivate(ms);
    const endRel = Math.min(st.loopLen, Math.max(1, relTick(ms)));
    for (const [midi] of [...st.active]) closeNote(midi, Math.max(endRel, (st.active.get(midi) || {}).start + 1));
    st.phase = "stopped";

    const usable = st.passes.filter((p) => p && p.notes.length);
    // 每个 pass 单独量化/去叠音：不同圈的同音高音符在时间上是先后关系（第二圈要加 loopLen），
    // 不能拿相对 tick 一起 trim，否则跨圈保持的音会被误截断。
    const perPass = usable.map((p) => {
      let ns = p.notes.map((n) => Object.assign({}, n));
      if (gridTicks > 0) ns = ns.map((n) => {
        const start = Math.max(0, quantizeTick(n.start, gridTicks));
        const end = Math.max(start + Math.max(1, gridTicks), quantizeTick(n.end, gridTicks));
        return Object.assign({}, n, { start, end });
      });
      ns.sort((a, b) => a.start - b.start || a.midi - b.midi);
      return mode === "overdub" ? trimSamePitchOverlaps(ns) : ns;
    });
    const picked = mode === "replace" && perPass.length ? [perPass[perPass.length - 1]] : perPass;
    let notes = [];
    for (const ns of picked) for (const n of ns) notes.push(n);
    if (mode === "overdub") notes = trimSamePitchOverlaps(notes);
    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    const take = {
      mode, quantize: opts.quantize == null ? "off" : opts.quantize,
      gridTicks, takeStartTick: st.loopStartTick, loopEndTick: st.loopEndTick, loopLen: st.loopLen,
      passes: usable.length, notes,
      stats: { count: notes.length, velMin: notes.length ? Math.min(...notes.map((n) => n.vel)) : 0, velMax: notes.length ? Math.max(...notes.map((n) => n.vel)) : 0 },
    };
    return take;
  }

  function cancel() { st.phase = "idle"; st.active.clear(); st.held.clear(); st.passes = []; st.pass = 0; }
  function phase() { return st.phase; }
  function loopInfo() { return { startTick: st.loopStartTick, endTick: st.loopEndTick, len: st.loopLen, pass: st.pass }; }

  return { start, noteOn, noteOff, advanceLoop, stop, cancel, phase, loopInfo };
}

/** 量化后同音高重叠的修整（overdub 下"不叠音"）：后一个音把前一个截断到它的起点 */
export function trimSamePitchOverlaps(notes) {
  const out = [];
  const list = (notes || []).slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
  for (const n of list) {
    const prev = out.filter((x) => x.midi === n.midi).pop();
    if (prev && prev.end > n.start) {
      prev.end = Math.max(prev.start + 1, n.start);
    }
    out.push(Object.assign({}, n));
  }
  return out;
}

/**
 * 把 take 应用到轨道已有音符上（纯函数，不改入参）。
 * replace：删掉 take 窗口内的旧音；overdub：保留旧音，但同音高被新音截断。
 * 返回新数组（绝对 tick）。
 */
export function applyTake(existingNotes, take, o = {}) {
  const base = Array.isArray(existingNotes) ? existingNotes : [];
  if (!take || !Array.isArray(take.notes) || !take.notes.length) return base.slice();
  const startTick = Number(take.takeStartTick) || 0;
  const endTick = Number(take.loopEndTick) || (startTick + (Number(take.loopLen) || 0));
  const absolute = take.notes.map((n) => ({
    start: startTick + Math.max(0, Math.round(n.start)),
    end: startTick + Math.max(1, Math.round(n.end)),
    midi: n.midi, vel: n.vel, ch: n.ch,
  }));
  if (take.mode === "replace") {
    const kept = base.filter((n) => n.end <= startTick || n.start >= endTick);
    return kept.concat(absolute).sort((a, b) => a.start - b.start || a.midi - b.midi);
  }
  let kept = base.map((n) => Object.assign({}, n));
  for (const n of absolute) {
    // overdub：同音高的旧音若与新音重叠，把旧音截到新音起点（或整体删掉）
    for (const old of kept) {
      if (old.midi !== n.midi) continue;
      if (old.end <= n.start || old.start >= n.end) continue;
      if (old.start >= n.start) { old.end = old.start; continue; }
      old.end = Math.min(old.end, n.start);
    }
  }
  kept = kept.filter((n) => n.end > n.start);
  return kept.concat(absolute).sort((a, b) => a.start - b.start || a.midi - b.midi);
}

/**
 * 延迟校准：clickTimesMs 是节拍器发声时间，tapTimesMs 是用户实际敲击时间。
 * 返回中位偏移（正值 = 用户比节拍慢）与稳定性；ok = 样本≥4 且 p10–p90 跨度 ≤5ms。
 */
export function calibrateLatency(clickTimesMs, tapTimesMs) {
  const clicks = (clickTimesMs || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const taps = (tapTimesMs || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  const offsets = [];
  const n = Math.min(clicks.length, taps.length);
  for (let i = 0; i < n; i++) offsets.push(taps[i] - clicks[i]);
  if (!offsets.length) return { count: 0, medianMs: 0, meanMs: 0, p10Ms: 0, p90Ms: 0, spreadMs: 0, ok: false };
  offsets.sort((a, b) => a - b);
  const at = (q) => offsets[Math.min(offsets.length - 1, Math.max(0, Math.round((offsets.length - 1) * q)))];
  const medianMs = at(0.5);
  const meanMs = offsets.reduce((s, x) => s + x, 0) / offsets.length;
  const p10Ms = at(0.1), p90Ms = at(0.9);
  return { count: offsets.length, medianMs, meanMs, p10Ms, p90Ms, spreadMs: p90Ms - p10Ms, ok: offsets.length >= 4 && (p90Ms - p10Ms) <= 5 };
}
