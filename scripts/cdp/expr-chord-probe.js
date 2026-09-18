(async () => {
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  function barChordScan(song) {
    const tpb = song.tpb;
    const sig = song.sigMap[0] || { num: 4 };
    const barTicks = tpb * (sig.num || 4);
    const bars = Math.min(8192, Math.max(1, Math.ceil(song.totalTicks / barTicks)));
    const buckets = new Array(bars).fill(0).map(() => new Array(12).fill(0));
    for (const tr of song.tracks) for (const n of tr.notes) {
      const b0 = Math.floor(n.start / barTicks);
      if (b0 >= bars) continue;
      const pc = n.midi % 12;
      const b1 = Math.min(bars - 1, Math.floor((n.end - 1) / barTicks));
      const hi = Math.min(b1, b0 + 3);
      for (let b = b0; b <= hi; b++) {
        const start = Math.max(n.start, b * barTicks), end = Math.min(n.end, (b + 1) * barTicks);
        if (end > start) buckets[b][pc] += end - start;
      }
    }
    let filled = 0;
    for (let b = 0; b < bars; b++) { const pc = buckets[b]; let total = 0; for (let i = 0; i < 12; i++) total += pc[i]; if (total > 0) filled++; }
    return { bars, barTicks, filled };
  }
  const out = [];
  for (const s of app.songs) {
    if (!s.song || !Array.isArray(s.song.tracks)) continue;
    const n = s.song.tracks.reduce((a, t) => a + (t.notes ? t.notes.length : 0), 0);
    let r;
    try { r = barChordScan(s.song); } catch (e) { out.push({ name: s.name, n, err: String(e && e.message) }); continue; }
    out.push({ name: s.name, n, tpb: s.song.tpb, totalTicks: s.song.totalTicks, sig: s.song.sigMap && s.song.sigMap[0], bars: r.bars, barTicks: r.barTicks, filled: r.filled });
  }
  out.sort((a, b) => a.n - b.n);
  return JSON.stringify({ count: out.length, current: app.currentId, list: out.slice(0, 12) }, null, 1);
})()