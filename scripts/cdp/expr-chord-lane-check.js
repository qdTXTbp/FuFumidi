(async () => {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const seed = app.songs.find(s => s.name === 'guest-seed');
  if (!seed) return 'no seed';
  await app.selectSong(seed.id);
  await sleep(1500);
  app.ui.guideOpen = false;
  app.setView('music');
  app.syncHash('edit');
  await sleep(2500);
  const more = document.querySelector('[data-guide="edit-more"]');
  if (more && !document.querySelector('.ed-adv')) more.click();
  await sleep(800);
  const btn = document.querySelector('[data-guide="edit-chord-analyze"]');
  const advOpen = !!document.querySelector('.ed-adv');
  if (!btn) return JSON.stringify({ advOpen, btn: false });
  btn.click();
  await sleep(2500);
  const lane = document.querySelector('.chord-lane');
  const cells = document.querySelectorAll('.chord-cell');
  return JSON.stringify({
    advOpen, btn: true, lane: !!lane, cells: cells.length,
    sample: [...cells].slice(0, 6).map(c => c.textContent),
    toast: app.toastMsg,
  }, null, 1);
})()