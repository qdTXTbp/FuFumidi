// L3：播放链路实测 —— 选中种子曲后真的播 2.5 秒，看时钟是否推进、合成器是否有活动节点。
(() => new Promise(async (resolve) => {
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const seed = app.songs.find(s => s.name === 'guest-seed') || app.songs[0];
  if (!seed) { window.__l3Playback = { err: 'no song' }; return resolve('ok'); }
  if (app.currentId !== seed.id) { await app.selectSong(seed.id); await sleep(1200); }
  app.ui.guideOpen = false; app.ui.settingsOpen = false;
  if (app.playing) { app.togglePlay(); await sleep(300); }
  const t0 = app.curSec;
  app.togglePlay();
  await sleep(2500);
  const mid = app.curSec;
  const live = app.syn && app.syn.live ? app.syn.live.length : -1;
  app.togglePlay();
  await sleep(600);
  const out = {
    song: seed.name,
    notes: seed.song ? seed.song.tracks.reduce((a, t) => a + t.notes.length, 0) : 0,
    totalSec: +app.totalSec.toFixed(1),
    posStart: +t0.toFixed(2),
    posAfter2500ms: +mid.toFixed(2),
    advanced: mid > t0 + 1.2,
    liveNodesWhilePlaying: live,
    stoppedAfterToggle: !app.playing,
    posAfterStop: +app.curSec.toFixed(2),
  };
  window.__l3Playback = out;
  resolve('ok');
}))()