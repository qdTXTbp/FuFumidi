// 诊断：走完指定章节，打印最后几步的状态变化，定位「章末未回目录」
(async () => {
  const CI = Number(window.__probeChapter != null ? window.__probeChapter : 6);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const waitFor = async (fn, ms = 9000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (fn()) return true; await sleep(90); } return false; };
  if (app.playing) app.togglePlay();
  if (app.ui.settingsOpen) app.ui.settingsOpen = false;
  if (app.ui.immersive && app.setImmersive) app.setImmersive(false);
  if (!app.currentId && app.songs.length) { await app.selectSong(app.songs[0].id); await sleep(1200); }
  app.ui.guideOpen = true;
  await sleep(500);
  const G = window.__fufumidiGuide;
  if (!G) return { err: 'no hook' };
  G.open();
  await waitFor(() => G.state().mode === 'catalog', 3000);

  const ch = G.chapters()[CI];
  G.start(CI);
  await waitFor(() => { const s = G.state(); return s.mode === 'ig' && s.chapterIdx === CI; }, 8000);
  const log = [];
  for (let si = 0; si < ch.steps.length; si++) {
    const attached = await waitFor(() => !!document.querySelector('.ig-target'), 9000);
    const s0 = G.state();
    const rec = { si, sel: ch.steps[si].selector, action: s0.action, attached, stepIdx: s0.stepIdx, mode: s0.mode };
    if (!attached) { rec.note = 'no target'; log.push(rec); break; }
    const t = document.querySelector('.ig-target');
    if (s0.action) t.click();
    else { const b = document.querySelector('.ig-card .ig-foot .guide-btn.primary'); if (b) b.click(); else rec.note = 'no primary btn'; }
    await waitFor(() => { const s = G.state(); return s.mode !== 'ig' || s.stepIdx !== si; }, 9000);
    await sleep(150);
    const s1 = G.state();
    rec.afterMode = s1.mode; rec.afterStep = s1.stepIdx;
    rec.primaryBtns = document.querySelectorAll('.ig-card .ig-foot .guide-btn.primary').length;
    rec.igCards = document.querySelectorAll('.ig-card').length;
    log.push(rec);
    if (s1.mode !== 'ig') break;
  }
  await sleep(1500);
  const fin = G.state();
  const out = {
    chapter: ch.id, steps: ch.steps.length,
    finalMode: fin.mode, finalStep: fin.stepIdx,
    catalogVisible: !!document.querySelector('.cat-list'),
    igCardVisible: !!document.querySelector('.ig-card'),
    log,
  };
  app.ui.guideOpen = false;
  return out;
})()