// L3：主题切换复验 —— 用色差明显的两套主题（当前 / hc 高对比深色），逐个真点下拉框。
(async () => {
  const app = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('app');
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  app.ui.settingsTab = 'appearance';
  app.ui.settingsOpen = true;
  await sleep(900);
  const sel = [...document.querySelectorAll('select.ov-input')].find(s => [...s.options].some(o => o.value === 'hc'));
  const out = { found: !!sel };
  const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const snap = () => ({ theme: sel ? sel.value : '', canvas: cssVar('--canvas'), ink: cssVar('--ink'), surface: cssVar('--surface') });
  if (sel) {
    out.original = snap();
    const pick = async (id) => {
      sel.value = id;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await sleep(1000);
      return snap();
    };
    out.hc = await pick('hc');
    out.light = await pick('light');
    out.changedBetween = out.hc.canvas !== out.light.canvas && out.hc.ink !== out.light.ink;
    out.restored = await pick(out.original.theme);
  }
  app.ui.settingsOpen = false;
  window.__l3Theme = out;
  return 'ok';
})()