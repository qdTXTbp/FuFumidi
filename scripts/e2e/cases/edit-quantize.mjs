// E2E：6.7 量化增强 —— 强度 100% + 量化终点；起点/终点都落到 1/8 网格。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'E2E Quantize', ch: 0, program: 0,
  notes: [
    { start: 100, end: 500, midi: 60, vel: 100, ch: 0 },
    { start: 700, end: 1100, midi: 64, vel: 90, ch: 0 },
  ], ccs: [], events: [],
}], { division: 480 }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default async function (app) {
  const notes = async () => JSON.parse(await app.eval(
    'JSON.stringify(((window.__fufumidiE2E.song() || {}).tracks || []).reduce((a, t) => a.concat((t.notes || []).map((n) => ({ start: n.start, end: n.end }))), []))'));

  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 钩子' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('e2e-quantize.mid', " + JSON.stringify(MINI) + ')');
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await sleep(700);
  await app.navigate('#/edit');
  await app.waitFor('location.hash.indexOf("edit") >= 0 && !!document.querySelector("canvas")', { timeout: 30000, message: '编辑页' });

  const before = await notes();
  app.assert(before.length === 2, '初始两个音符：' + JSON.stringify(before));
  app.assert(before.some((n) => n.start % 240 !== 0), '初始存在非网格音符');

  // 全选 → 打开智能量化 → 1/8 + 量化终点 + 应用（默认强度改为 100%）
  await app.key('Ctrl+A');
  await sleep(250);
  // 智能量化在「更多」高级工具浮层里：先展开
  await app.click('[data-guide=edit-more]');
  await app.waitFor('!!document.querySelector("[data-guide=smart-quantize]")', { timeout: 10000, message: '高级工具面板展开' });
  await app.click('[data-guide=smart-quantize]');
  await app.waitFor('!!document.querySelector("[data-guide=sq-apply]")', { timeout: 10000, message: '智能量化弹窗' });
  await app.eval("(() => { const s = document.querySelector('[data-guide=sq-grid]'); s.value = '8'; s.dispatchEvent(new Event('input', { bubbles: true })); s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()");
  await app.eval("(() => { const c = document.querySelector('[data-guide=sq-end]'); if (c && !c.checked) c.click(); return true; })()");
  await app.click('[data-guide=sq-apply]');

  for (let i = 0; i < 30; i++) {
    const now = await notes();
    if (now.length === 2 && now.every((n) => n.start % 240 === 0 && n.end % 240 === 0)) break;
    await sleep(150);
  }
  const after = await notes();
  app.assert(after.length === 2, '量化后音符数不变');
  app.assert(after.every((n) => n.start % 240 === 0), '起点落在 1/8 网格：' + JSON.stringify(after));
  app.assert(after.every((n) => n.end % 240 === 0), '终点也落在 1/8 网格：' + JSON.stringify(after));
  app.assert(after.every((n) => n.end > n.start), '时值仍为正');

  // 撤销恢复
  await app.key('Ctrl+Z');
  for (let i = 0; i < 30; i++) { const now = await notes(); if (now.some((n) => n.start % 240 !== 0)) break; await sleep(150); }
  app.assert((await notes()).some((n) => n.start % 240 !== 0), '撤销恢复原始位置');
}
