// 界面级繁體复验 · 第 2 步：在真實界面上触发含「移动」字样的文案，读渲染后的 DOM 文本。
// 用的是可视化页「沉浸模式」入口 —— 它进入时会 toast「控件 3 秒无操作后自动淡出，移动鼠标或按 I 退出」，
// 全程零副作用，且文案由 t() → zhToHant 的真实渲染链路产出。
(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const pick = st.songs.find(s => s.name === 'large-60k') || st.songs.find(s => s.name && !/large/i.test(s.name));
  if (!pick) return { err: '曲库为空' };
  if (st.playing) st.togglePlay();
  await sleep(300);
  await st.selectSong(pick.id);
  if (typeof st.setView === 'function') st.setView('viz');
  location.hash = '#/views?tab=viz';
  await sleep(2500);

  const btn = [...document.querySelectorAll('button')].find(b => (b.textContent || '').trim() === '沉浸模式');
  if (!btn) return { err: '找不到「沉浸模式」按钮', buttons: [...document.querySelectorAll('button')].slice(0, 20).map(b => (b.textContent || '').trim()) };
  btn.click();
  await sleep(600);

  const toastEl = document.querySelector('.toast-wrap .toast');
  const toastText = toastEl ? toastEl.textContent : null;
  const html = document.body.innerText || '';
  // 全界面扫描：繁體下不应出现「移送」，也不应残留简体「移动」
  const count = (s) => (html.match(new RegExp(s, 'g')) || []).length;
  const res = {
    lang: localStorage.getItem('fufumidi_lang'),
    toastText,
    toastHas移動: !!(toastText && toastText.includes('移動')),
    toastHas移送: !!(toastText && toastText.includes('移送')),
    domContains: { 移送: count('移送'), 移动: count('移动'), 移動: count('移動') },
  };
  // 退出沉浸，还原界面状态
  const exit = document.querySelector('.hud-btn.hud-exit');
  if (exit) exit.click(); else st.setImmersive && st.setImmersive(false);
  await sleep(300);
  res.afterExit = { sidebar: st.sidebarOpen, playerbar: st.playerbarOpen, immersive: !!(st.ui && st.ui.immersive) };
  if (st.playing) st.togglePlay();
  return res;
})()
