// L3：视图渲染实测 —— 可视化画布是否真的画出东西、乐谱是否真的排出版、沉浸模式能否进出。
(async () => {
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  app.ui.guideOpen = false;
  const seed = app.songs.find(s => s.name === 'guest-seed') || app.songs[0];
  if (seed && app.currentId !== seed.id) { await app.selectSong(seed.id); await sleep(1200); }
  const out = {};

  // 1) 可视化：切到「视图 → 可视化」，看 canvas 像素
  app.setView('views'); app.syncHash('viz');
  await sleep(3000);
  const cvs = [...document.querySelectorAll('canvas')].filter(c => c.width > 60 && c.height > 60);
  out.vizCanvasCount = cvs.length;
  out.vizPainted = [];
  for (const c of cvs.slice(0, 3)) {
    let painted = null;
    try {
      const ctx = c.getContext('2d');
      if (ctx) {
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;   // 抽样统计非透明像素
        painted = n;
      }
    } catch (e) { painted = 'err:' + ((e && e.message) || e); }
    out.vizPainted.push(painted);
  }

  // 2) 沉浸模式进出
  if (typeof app.setImmersive === 'function') {
    app.setImmersive(true); await sleep(900);
    out.immersiveOn = !!app.ui.immersive;
    out.topbarHidden = !document.querySelector('.topbar') || getComputedStyle(document.querySelector('.topbar')).display === 'none';
    app.setImmersive(false); await sleep(900);
    out.immersiveOff = !app.ui.immersive;
  }

  // 3) 乐谱：Verovio 排版
  app.setView('views'); app.syncHash('score');
  await sleep(5000);
  const svgNote = document.querySelectorAll('svg .note, svg .notehead');
  out.scoreNoteEls = svgNote.length;
  out.scoreSvg = document.querySelectorAll('svg').length;

  // 4) 数据分析：切过去看图表画布是否有内容
  app.setView('views'); app.syncHash('analyze');
  await sleep(3000);
  const ac = [...document.querySelectorAll('canvas')].filter(c => c.width > 60 && c.height > 20);
  out.analyzeCanvasCount = ac.length;
  out.analyzePainted = [];
  for (const c of ac.slice(0, 3)) {
    let painted = null;
    try {
      const ctx = c.getContext('2d');
      const d = ctx ? ctx.getImageData(0, 0, c.width, c.height).data : null;
      if (d) { let n = 0; for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++; painted = n; }
    } catch (e) { painted = 'err:' + ((e && e.message) || e); }
    out.analyzePainted.push(painted);
  }
  app.setView('home');
  window.__l3Views = out;
  return 'ok';
})()