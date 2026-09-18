// L3：主题切换（真点 UI）、沉浸模式（真点按钮）、大文件导入（页面内生成 2 万音符 MIDI）。
(async () => {
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  app.ui.guideOpen = false;
  const out = {};
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

  // ---- 1) 主题切换：走设置面板的下拉框（真实路径） ----
  app.ui.settingsTab = 'appearance';
  app.ui.settingsOpen = true;
  await sleep(900);
  const sel = [...document.querySelectorAll('select.ov-input')].find(s => [...s.options].some(o => /浅色|深色|Light|Dark|高对比|专业/.test(o.textContent)));
  out.themeSelectFound = !!sel;
  if (sel) {
    const before = cssVar('--canvas');
    const opt = [...sel.options].find(o => o.value !== sel.value && /light|hc|studio/i.test(o.value)) || [...sel.options].find(o => o.value !== sel.value);
    out.themeFrom = sel.value;
    out.themeTo = opt ? opt.value : '';
    if (opt) {
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(900);
      out.themeCanvasChanged = cssVar('--canvas') !== before;
      out.themeCanvasAfter = cssVar('--canvas');
    }
  }
  app.ui.settingsOpen = false;
  await sleep(400);

  // ---- 2) 沉浸模式：点引导锚定的那个按钮 ----
  app.setView('views'); app.syncHash('viz');
  await sleep(2500);
  const btn = document.querySelector('[data-guide="viz-immersive"]');
  out.immersiveButtonFound = !!btn;
  if (btn) {
    btn.click(); await sleep(1200);
    const on = document.querySelectorAll('.topbar').length ? getComputedStyle(document.querySelector('.topbar')).display : 'absent';
    out.immersiveAfterClick = { flag: !!app.ui.immersive, topbarDisplay: on };
    if (app.ui.immersive) { btn.click(); await sleep(1000); out.immersiveRestored = !app.ui.immersive; }
  }

  // ---- 3) 大文件导入：页面内构造 2 万音符 MIDI ----
  const vlq = (n) => { const b = [n & 0x7f]; n >>= 7; while (n > 0) { b.unshift((n & 0x7f) | 0x80); n >>= 7; } return b; };
  const TPQ = 480;
  function makeTrack(seed, count) {
    const evs = [{ t: 0, d: [0xc0, seed % 128] }];
    for (let i = 0; i < count; i++) {
      const p = 36 + ((seed * 7 + i * 5) % 60);
      const st = Math.floor(i / 4) * (TPQ / 2);
      evs.push({ t: st, d: [0x90, p, 70] });
      evs.push({ t: st + TPQ / 2 - 15, d: [0x80, p, 0] });
    }
    evs.sort((a, b) => a.t - b.t || a.d[0] - b.d[0]);
    const tk = []; let last = 0;
    for (const e of evs) { tk.push(...vlq(e.t - last), ...e.d); last = e.t; }
    tk.push(...vlq(0), 0xff, 0x2f, 0x00);
    return tk;
  }
  const per = 5000, nTrk = 4;
  const chunks = [];
  for (let k = 0; k < nTrk; k++) {
    const tk = makeTrack(k + 1, per);
    chunks.push(0x4d, 0x54, 0x72, 0x6b, (tk.length >>> 24) & 255, (tk.length >>> 16) & 255, (tk.length >>> 8) & 255, tk.length & 255, ...tk);
  }
  const hdr = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, 0, nTrk, (TPQ >> 8) & 255, TPQ & 255];
  const bytes = new Uint8Array([...hdr, ...chunks]);
  out.bigMidiBytes = bytes.length;
  out.bigMidiNotes = per * nTrk;
  const t0 = Date.now();
  const before = app.songs.length;
  await app.importFiles([{ name: 'l3-big-20k.mid', bytes }], 'all');
  out.importMs = Date.now() - t0;
  out.songsBefore = before;
  out.songsAfter = app.songs.length;
  const last = app.songs.find(s => s.name === 'l3-big-20k') || app.songs[app.songs.length - 1];
  await app.selectSong(last.id);
  await sleep(2500);
  out.parsedNotes = last.song ? last.song.tracks.reduce((a, t) => a + t.notes.length, 0) : 0;
  out.parsedTracks = last.song ? last.song.tracks.length : 0;
  // 打开编辑器，确认大文件也能把卷帘画出来
  app.setView('music'); app.syncHash('edit');
  const te = Date.now();
  await sleep(4000);
  out.editCanvasPainted = (() => {
    const c = [...document.querySelectorAll('canvas')].filter(x => x.width > 200 && x.height > 100)[0];
    if (!c) return null;
    try {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 0) n++;
      return n;
    } catch (e) { return 'err'; }
  })();
  out.editViewMs = Date.now() - te;
  if (app.playing) app.togglePlay();
  app.setView('home');
  window.__l3Misc = out;
  return 'ok';
})()