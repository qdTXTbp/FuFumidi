// 极密曲目「丢音」诊断：先确认真实走在哪条发声路径上，再量预算与窗口的关系。
(async () => {
  const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const player = window.__fufumidiActivePlayer;
  const syn = player && player.syn;
  if (!syn) return { err: '拿不到 synth（未加载过播放器？）' };

  // 统计窗口内音符量：直接用 player 的事件表算「每秒钟有多少音符进入预排窗口」
  const it = st.songs.find(s => s.name === 'large-60k') || st.songs.find(s => /large/i.test(s.name));
  if (!it) return { err: '找不到 large-60k' };
  if (st.playing) st.togglePlay();
  await sleep(400);
  await st.selectSong(it.id);
  await sleep(2500);

  const pl = player;
  const ev = pl.events;
  // 音符密度（按 10s 分桶）
  const buckets = [];
  const span = Math.max(1, ev[ev.length - 1].start - ev[0].start);
  const nb = Math.ceil(span / 10);
  for (let i = 0; i < nb; i++) buckets.push(0);
  for (const n of ev) { const b = Math.min(nb - 1, Math.floor((n.start - ev[0].start) / 10)); buckets[b]++; }
  // 时值分布
  const durs = ev.map(n => n.end - n.start).sort((a, b) => a - b);
  const dq = (r) => +durs[Math.min(durs.length - 1, Math.floor(durs.length * r))].toFixed(3);

  const route = {
    sf2Ready: !!syn.sf2Ready, seqMode: !!syn._sf2SeqMode,
    liveLimit: syn._liveLimit, aheadSec: pl.aheadSec, AHEAD_BASE: pl.AHEAD_BASE,
    trimThreshold: syn._trimThreshold,
  };

  // 采样 live 表长与窗口内待发声节点数
  const samples = [];
  if (!st.playing) st.togglePlay();
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    const t = syn.ctx.currentTime;
    let pending = 0, sounding = 0;
    for (const x of syn.live) ((x.tStart == null || x.tStart <= t) ? sounding++ : pending++);
    samples.push({ at: +st.curSec.toFixed(1), live: syn.live.length, pending, sounding, aheadSec: +pl.aheadSec.toFixed(2), active: syn.activeNotes.length });
  }
  if (st.playing) st.togglePlay();

  const mx = (k) => Math.max(...samples.map(s => s[k]));
  return {
    route,
    notes: ev.length,
    densityPerSec: +(ev.length / span).toFixed(1),
    densest10s: Math.max(...buckets),
    dur: { p50: dq(0.5), p95: dq(0.95), max: +durs[durs.length - 1].toFixed(3) },
    peak: { live: mx('live'), pending: mx('pending'), sounding: mx('sounding'), active: mx('active') },
    samples,
  };
})()
