// 内置合成器路径下的「预排地平线」：先切内置音色再选曲播放，避免带着 30s 窗口的游标进入测量。
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
  const sw = await syn.setSoundfont('internal');   // 先切路径
  await sleep(400);
  await st.selectSong(it.id);                      // 再选曲（此时 prepare 已按内置路径）
  await sleep(1500);

  const snap = () => {
    const t = syn.ctx.currentTime;
    const hz = syn.live.map(x => x.tStart - t).sort((a, b) => a - b);
    const q = (r) => hz.length ? +hz[Math.min(hz.length - 1, Math.floor(hz.length * r))].toFixed(3) : null;
    return {
      live: syn.live.length,
      pending: syn.live.filter(x => x.tStart > t).length,
      horizon: { p50: q(0.5), p95: q(0.95), max: hz.length ? +hz[hz.length - 1].toFixed(3) : null },
      cursorLeadSec: +(((player.events[Math.min(player.cursor, player.events.length - 1)].start - player.currentTick()) / 440)).toFixed(2),
      aheadSec: player.aheadSec, scale: player.scale, playing: st.playing,
    };
  };
  const out = { route: { using: sw && sw.using, seqMode: !!syn._sf2SeqMode } };
  out.paused = snap();
  if (!st.playing) st.togglePlay();
  out.ticks = [];
  for (let i = 0; i < 10; i++) { await sleep(500); out.ticks.push(snap()); }
  if (st.playing) st.togglePlay();
  out.stopped = snap();
  return out;
})()
