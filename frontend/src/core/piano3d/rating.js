// 6.5.0 3D 钢琴：导入 MIDI 的难度评级（纯逻辑，可单测）
// 目标不是“专业演奏难度认证”，而是给玩家一个可解释的 1–10 级和进阶建议。
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function baseSec(song) {
  return typeof song.baseSec === 'function' ? song.baseSec.bind(song) : (tick => tick / (song.tpb || 480));
}

export function analyzeSong(song) {
  const notes = [];
  const trs = (song && song.tracks) || [];
  for (const tr of trs) for (const n of (tr.notes || [])) {
    const start = baseSec(song)(n.start || 0);
    const end = baseSec(song)(n.end != null ? n.end : n.start || 0);
    const pitch = n.pitch != null ? n.pitch : n.midi;
    if (Number.isFinite(start) && Number.isFinite(end) && Number.isFinite(pitch)) {
      notes.push({ start, end: Math.max(start + 0.02, end), pitch });
    }
  }
  if (!notes.length) {
    return { ok: false, level: 0, label: '无音符', score: 0, metrics: { notes: 0, duration: 0, nps: 0, polyphony: 0, span: 0, bpm: song?.initialBpm || 120 } };
  }
  notes.sort((a, b) => a.start - b.start);
  const duration = notes.reduce((m, n) => Math.max(m, n.end), 0) - notes.reduce((m, n) => Math.min(m, n.start), Infinity);
  const nps = notes.length / Math.max(1, duration);
  // 同时发声峰值（扫描线，按 20ms 采样平均）
  const events = [];
  for (const n of notes) { events.push([n.start, 1]); events.push([n.end, -1]); }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, sum = 0, samples = 0;
  let last = events[0] ? events[0][0] : 0;
  for (const [t, d] of events) {
    if (t > last) { const steps = Math.max(1, Math.round((t - last) * 50)); sum += cur * steps; samples += steps; last = t; }
    cur += d; peak = Math.max(peak, cur);
  }
  const polyphony = samples ? sum / samples : peak;
  const pitches = notes.map(n => n.pitch);
  const span = pitches.length ? Math.max(...pitches) - Math.min(...pitches) : 0;
  const bpm = Number(song?.initialBpm) || 120;
  const busiest = (() => {
    // 最密 2 秒窗口
    let best = 0, j = 0;
    for (let i = 0; i < notes.length; i++) {
      while (j < notes.length && notes[j].start - notes[i].start <= 2) j++;
      best = Math.max(best, j - i);
    }
    return best / 2;
  })();
  // 加权分数：密度 45%、复音 25%、音域 15%、速度 15%
  const densityScore = clamp(nps / 8, 0, 1);
  const chordScore = clamp((polyphony - 1) / 4, 0, 1);
  const spanScore = clamp(span / 60, 0, 1);
  const speedScore = clamp((bpm - 60) / 120, 0, 1);
  const raw = 0.45 * densityScore + 0.25 * chordScore + 0.15 * spanScore + 0.15 * speedScore;
  const level = clamp(Math.round(1 + raw * 9), 1, 10);
  const labels = ['入门', '入门', '简单', '简单', '中等', '中等', '进阶', '进阶', '困难', '大师'];
  return {
    ok: true, level, label: labels[level - 1], score: Math.round(raw * 100),
    metrics: { notes: notes.length, duration: Math.round(duration), nps: Math.round(nps * 10) / 10, polyphony: Math.round(polyphony * 10) / 10, span, bpm, busiest: Math.round(busiest * 10) / 10 },
  };
}
