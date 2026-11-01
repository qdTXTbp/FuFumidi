// 6.5.0 3D 钢琴音游判定（纯逻辑，可单测）
export const WINDOWS = { perfect: 0.025, great: 0.05, good: 0.09, miss: 0.13 };

function collectNotes(song) {
  const out = [];
  if (!song || !song.tracks || typeof song.baseSec !== 'function') return out;
  for (const tr of song.tracks) {
    for (const n of (tr.notes || [])) {
      const t = song.baseSec(n.start);
      const end = song.baseSec(n.end);
      if (!Number.isFinite(t)) continue;
      out.push({ id: out.length, pitch: n.pitch != null ? n.pitch : n.midi, time: t, end: Number.isFinite(end) ? end : t + 0.2, track: tr.name || '', hit: false, judged: false });
    }
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export function createGame(song, opts = {}) {
  const notes = collectNotes(song);
  const maxMiss = opts.missWindow || WINDOWS.miss;
  const st = {
    notes,
    cursor: 0,
    perfect: 0, great: 0, good: 0, miss: 0,
    combo: 0, maxCombo: 0, score: 0,
    lastGrade: '', lastAt: 0,
  };
  const total = notes.length || 1;

  function gradeFor(dt) {
    if (dt <= WINDOWS.perfect) return 'perfect';
    if (dt <= WINDOWS.great) return 'great';
    if (dt <= WINDOWS.good) return 'good';
    return '';
  }

  /** 输入一个 MIDI 音符；timeSec 用播放器当前秒 */
  function input(pitch, timeSec) {
    let best = null, bestDt = Infinity;
    for (const n of notes) {
      if (n.hit || n.judged || n.pitch !== pitch) continue;
      const dt = Math.abs(n.time - timeSec);
      if (dt < bestDt) { bestDt = dt; best = n; }
    }
    if (!best || bestDt > maxMiss) {
      st.lastGrade = 'miss';
      st.lastAt = timeSec;
      st.combo = 0;
      return { grade: 'miss', dt: best ? bestDt : null, note: best };
    }
    const grade = gradeFor(bestDt);
    best.hit = true; best.judged = true;
    if (grade === 'perfect') st.perfect++;
    else if (grade === 'great') st.great++;
    else st.good++;
    st.combo++;
    st.maxCombo = Math.max(st.maxCombo, st.combo);
    st.score += grade === 'perfect' ? 1000 : grade === 'great' ? 700 : 400;
    st.lastGrade = grade;
    st.lastAt = timeSec;
    return { grade, dt: bestDt, note: best };
  }

  /** 每帧推进：超过 miss 窗口的未判音符记 Miss */
  function tick(timeSec) {
    for (const n of notes) {
      if (n.judged || n.hit) continue;
      if (timeSec - n.time > maxMiss) {
        n.judged = true;
        st.miss++;
        st.combo = 0;
        st.lastGrade = 'miss';
        st.lastAt = timeSec;
      }
    }
    return st;
  }

  function stats() {
    const judged = st.perfect + st.great + st.good + st.miss;
    const acc = judged ? ((st.perfect * 100 + st.great * 70 + st.good * 40) / (judged * 100)) : 0;
    return {
      perfect: st.perfect, great: st.great, good: st.good, miss: st.miss,
      combo: st.combo, maxCombo: st.maxCombo, score: st.score,
      accuracy: Math.round(acc * 1000) / 10,
      judged, total: notes.length, lastGrade: st.lastGrade,
    };
  }

  function reset() {
    for (const n of notes) { n.hit = false; n.judged = false; }
    st.perfect = st.great = st.good = st.miss = st.combo = st.maxCombo = st.score = 0;
    st.lastGrade = ''; st.lastAt = 0;
    return stats();
  }

  return { input, tick, stats, reset, notes };
}
