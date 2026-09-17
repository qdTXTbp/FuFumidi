// 极密曲目在内置合成器路径（唯一会创建 Web Audio 发声节点的路径）下的预算实测。
// SF2 音序器路径不创建节点（live 恒为 0），所以丢音只可能发生在这里。
(async () => {
  const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const player = window.__fufumidiActivePlayer;
  const syn = player && player.syn;
  if (!syn) return { err: '拿不到 synth' };

  const it = st.songs.find(s => s.name === 'large-60k') || st.songs.find(s => /large/i.test(s.name));
  if (!it) return { err: '找不到 large-60k' };
  if (st.playing) st.togglePlay();
  await sleep(400);
  await st.selectSong(it.id);
  await sleep(1200);
  const r = await syn.setSoundfont('internal');
  await sleep(600);

  const song = player.song;
  const ev = player.events;
  const dens = [];
  for (let i = 0; i + 1 < ev.length; i++) dens.push(ev[i + 1].start - ev[i].start);
  dens.sort((a, b) => a - b);
  const dq = (arr, r2) => +arr[Math.min(arr.length - 1, Math.floor(arr.length * r2))].toFixed(4);
  const durs = ev.map(n => n.end - n.start).sort((a, b) => a - b);

  // 统计：一次修剪里「丢的是还没发声的」还是「丢的是正在响的」
  if (!syn.__dense) {
    syn.__dense = { pending: 0, sounding: 0, calls: 0, created: 0, noteOns: 0, maxLive: 0, maxPending: 0 };
    const origPrune = syn.pruneLive.bind(syn);
    syn.pruneLive = function (limit) {
      const before = new Set(this.live);
      const t = this.ctx.currentTime;
      const out = origPrune(limit);
      const after = new Set(this.live);
      syn.__dense.calls++;
      for (const x of before) {
        if (after.has(x)) continue;
        if (x.tStart == null || x.tStart <= t) syn.__dense.sounding++;
        else syn.__dense.pending++;
      }
      return out;
    };
    const origOn = syn.noteOn.bind(syn);
    syn.noteOn = function (time, note, endTime) {
      const n0 = this.live.length;
      const out = origOn(time, note, endTime);
      syn.__dense.noteOns++;
      syn.__dense.created += Math.max(0, this.live.length - n0);
      const t = this.ctx.currentTime;
      let pd = 0;
      for (const x of this.live) if (x.tStart != null && x.tStart > t) pd++;
      if (this.live.length > syn.__dense.maxLive) syn.__dense.maxLive = this.live.length;
      if (pd > syn.__dense.maxPending) syn.__dense.maxPending = pd;
      return out;
    };
  }
  Object.assign(syn.__dense, { pending: 0, sounding: 0, calls: 0, created: 0, noteOns: 0, maxLive: 0, maxPending: 0 });

  if (!st.playing) st.togglePlay();
  const dur = 8;
  const ticks = [];
  for (let i = 0; i < dur * 2; i++) {
    await sleep(500);
    const t = syn.ctx.currentTime;
    let pd = 0;
    for (const x of syn.live) if (x.tStart != null && x.tStart > t) pd++;
    ticks.push({ live: syn.live.length, pending: pd, aheadSec: +player.aheadSec.toFixed(2) });
  }
  const a = syn.analyser;
  const td = new Uint8Array(a.fftSize);
  a.getByteTimeDomainData(td);
  let s2 = 0; for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; s2 += v * v; }
  if (st.playing) st.togglePlay();

  const d = syn.__dense;
  return {
    route: { using: r && r.using, sf2Ready: !!syn.sf2Ready, seqMode: !!syn._sf2SeqMode, liveLimit: syn._liveLimit, aheadSec: player.aheadSec },
    unit: { totalSec: +song.totalSec.toFixed(2), totalTicks: song.totalTicks, tpb: song.tpb, firstStart: +ev[0].start.toFixed(2), lastStart: +ev[ev.length - 1].start.toFixed(2), n: ev.length },
    onsetGapTicks: { p50: dq(dens, 0.5), p95: dq(dens, 0.95), min: dens[0] },
    noteDur: { p50: dq(durs, 0.5), p95: dq(durs, 0.95), max: +durs[durs.length - 1].toFixed(2) },
    rms: +Math.sqrt(s2 / td.length).toFixed(4),
    perSec: { noteOns: +(d.noteOns / dur).toFixed(0), nodesCreated: +(d.created / dur).toFixed(0), pruneCalls: +(d.calls / dur).toFixed(1), droppedPending: +(d.pending / dur).toFixed(0), droppedSounding: +(d.sounding / dur).toFixed(2) },
    peakLive: d.maxLive, peakPending: d.maxPending,
    lossRatio: +(d.pending / Math.max(1, d.created)).toFixed(3),
    ticks,
  };
})()
