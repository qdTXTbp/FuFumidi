// 极密曲目在内置合成器路径下的丢音复测（修复后）。
// 计数口径修正：先前把「自然结束」也计入了「被丢」，这里先手动回收再比较，差值只来自修剪丢弃。
(async () => {
  const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const player = window.__fufumidiActivePlayer;
  const syn = player && player.syn;
  if (!syn) return { err: '拿不到 synth' };
  const it = st.songs.find(s => s.name === 'large-60k') || st.songs.find(s => /large/i.test(s.name));
  if (!it) return { err: '找不到 large-60k' };

  if (st.playing) st.togglePlay();
  await sleep(300);
  const sw = await syn.setSoundfont('internal');
  await sleep(400);
  await st.selectSong(it.id);
  await sleep(1500);

  if (!syn.__fix) {
    syn.__fix = { pending: 0, sounding: 0, calls: 0, noteOns: 0, maxLive: 0, maxPending: 0, horizonMax: 0 };
    const origExpire = syn.expireLive.bind(syn);
    const origPrune = syn.pruneLive.bind(syn);
    syn.pruneLive = function (limit) {
      origExpire();                       // 先回收自然结束的，保证下面的差只来自「丢弃」
      const t = this.ctx.currentTime;
      const before = new Set(this.live);
      const out = origPrune(limit);
      const after = new Set(this.live);
      syn.__fix.calls++;
      for (const x of before) {
        if (after.has(x)) continue;
        if (x.tStart != null && x.tStart > t) syn.__fix.pending++;
        else syn.__fix.sounding++;
      }
      return out;
    };
    const origOn = syn.noteOn.bind(syn);
    syn.noteOn = function (time, note, endTime) {
      const out = origOn(time, note, endTime);
      syn.__fix.noteOns++;
      const t = this.ctx.currentTime;
      let pd = 0, hz = 0;
      for (const x of this.live) { const d = x.tStart - t; if (d > 0) { pd++; if (d > hz) hz = d; } }
      if (this.live.length > syn.__fix.maxLive) syn.__fix.maxLive = this.live.length;
      if (pd > syn.__fix.maxPending) syn.__fix.maxPending = pd;
      if (hz > syn.__fix.horizonMax) syn.__fix.horizonMax = hz;
      return out;
    };
  }
  Object.assign(syn.__fix, { pending: 0, sounding: 0, calls: 0, noteOns: 0, maxLive: 0, maxPending: 0, horizonMax: 0 });

  if (!st.playing) st.togglePlay();
  const dur = 8;
  const ticks = [];
  for (let i = 0; i < dur * 2; i++) {
    await sleep(500);
    const t = syn.ctx.currentTime;
    const hz = syn.live.map(x => x.tStart - t).sort((a, b) => a - b);
    ticks.push({
      live: syn.live.length,
      pending: syn.live.filter(x => x.tStart > t).length,
      horizonMax: hz.length ? +hz[hz.length - 1].toFixed(3) : 0,
    });
  }
  const a = syn.analyser;
  const td = new Uint8Array(a.fftSize);
  a.getByteTimeDomainData(td);
  let s2 = 0; for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; s2 += v * v; }
  if (st.playing) st.togglePlay();
  const d = syn.__fix;
  return {
    route: { using: sw && sw.using, liveLimit: syn._liveLimit, softCap: Math.floor(syn._liveLimit * 3 / 4) },
    rms: +Math.sqrt(s2 / td.length).toFixed(4),
    perSec: {
      noteOns: +(d.noteOns / dur).toFixed(0),
      pruneCalls: +(d.calls / dur).toFixed(1),
      droppedPending: +(d.pending / dur).toFixed(1),
      droppedSounding: +(d.sounding / dur).toFixed(1),
    },
    peakLive: d.maxLive, peakPending: d.maxPending, horizonMax: +d.horizonMax.toFixed(3),
    ticks,
  };
})()
