// E2E：6.7 P-010 拍号编辑 —— 改拍号（只动小节线）→ 撤销恢复。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E TimeSig', ch: 0, program: 0,
  notes: [
    { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
    { start: 960, end: 1440, midi: 64, vel: 90, ch: 0 },
  ], ccs: [], events: [],
}], { division: 480 }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (app) {
  const sig = async () => JSON.parse(await app.eval(
    'JSON.stringify(((window.__fufumidiE2E.song() || {}).sigMap) || [])'));
  const setSelect = async (sel, value) => {
    await app.eval("(() => { const el = document.querySelector(" + JSON.stringify(sel) + "); if (!el) return false; el.value = " + JSON.stringify(String(value)) + "; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  };

  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 钩子' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-time-sig.mid', " + JSON.stringify(MINI) + ')');
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await sleep(700);
  await app.navigate('#/edit');
  await app.waitFor('location.hash.indexOf("edit") >= 0 && !!document.querySelector("canvas")', { timeout: 30000, message: '编辑页' });

  // 切到检查器「视图」页签（拍号编辑在那里）
  const opened = await app.eval("(() => { const t = [...document.querySelectorAll('.insp-tab')].find((x) => (x.textContent || '').indexOf('视图') >= 0); if (!t) return false; t.click(); return true; })()");
  app.assert(opened, '检查器有「视图」页签');
  await app.waitFor("!!document.querySelector('[data-guide=sig-num]')", { timeout: 15000, message: '拍号控件出现' });

  const before = await sig();
  app.assert(before.length >= 1 && before[0].num === 4 && before[0].den === 4, '初始 4/4：' + JSON.stringify(before));

  await setSelect('[data-guide=sig-num]', 3);
  await setSelect('[data-guide=sig-den]', 4);
  await app.click('[data-guide=sig-apply]');
  for (let i = 0; i < 30; i++) { const x = await sig(); if (x.some((p) => p.tick === 0 && p.num === 3 && p.den === 4)) break; await sleep(150); }
  const changed = await sig();
  app.assert(changed.some((p) => p.tick === 0 && p.num === 3 && p.den === 4), '拍号改为 3/4：' + JSON.stringify(changed));
  app.assert((await app.eval('(window.__fufumidiE2E.song().tracks || []).reduce((a,t)=>a+(t.notes||[]).length,0)')) === 2, '音符没有被改');

  // 撤销（Ctrl+Z）恢复 4/4
  await app.key('Ctrl+Z');
  for (let i = 0; i < 30; i++) { const x = await sig(); if (x.some((p) => p.tick === 0 && p.num === 4 && p.den === 4)) break; await sleep(150); }
  app.assert((await sig()).some((p) => p.tick === 0 && p.num === 4 && p.den === 4), '撤销恢复 4/4：' + JSON.stringify(await sig()));
}
