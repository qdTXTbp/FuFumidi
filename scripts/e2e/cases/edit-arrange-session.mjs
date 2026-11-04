// P-011 跨页：编辑页与编排页共享 session 按 doc 的同一条撤销栈（隐藏窗口）
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{ name: 'CrossPage', ch: 0, program: 0, notes: [{ start: 0, end: 960, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [] }], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!window.__fufumidiE2E', { timeout: 20000 });
  await app.eval("window.__fufumidiE2E.importMidi('p011-cross-page.mid', " + JSON.stringify(MINI) + ")");
  await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  await app.eval("(localStorage.setItem('fufumidi_debug', '1'), true)");
  await app.navigate('#/edit');
  await app.waitFor('!!(window.__fufumidiDebug && window.__fufumidiDebug.historyDepth)', { timeout: 25000 });
  const E = 'window.__fufumidiDebug.editor()';
  const S = 'window.__fufumidiDebug.song()';
  const count = () => app.eval("(" + S + ".tracks[0].notes || []).length");
  await app.eval('(' + E + '.clearHistory(), true)');
  const base = await count();
  await app.eval('(' + E + '.addNote(480, 67, 120), true)');
  await new Promise((r) => setTimeout(r, 150));
  let d = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiDebug.historyDepth())'));
  if (d.undo !== 1) throw new Error('编辑页 addNote 未入 session: ' + JSON.stringify(d));

  await app.navigate('#/arrange');
  await app.waitFor('!!window.__fufumidiArrange', { timeout: 25000 });
  d = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiArrange.depth())'));
  if (d.undo !== 1) throw new Error('编排页没有复用编辑页的栈: ' + JSON.stringify(d));
  const mkBefore = await app.eval('window.__fufumidiArrange.markers()');
  await app.eval("(() => { const b = [...document.querySelectorAll('button')].find((x) => /加标记/.test(x.innerText)); if (b) b.click(); return !!b; })()");
  await new Promise((r) => setTimeout(r, 250));
  d = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiArrange.depth())'));
  if (d.undo !== 2) throw new Error('编排加标记后应为 2 条: ' + JSON.stringify(d));
  await app.eval('window.__fufumidiArrange.undo()');
  await new Promise((r) => setTimeout(r, 200));
  if (await app.eval('window.__fufumidiArrange.markers()') !== mkBefore) throw new Error('撤销没有回退标记');
  if (await count() !== base + 1) throw new Error('撤销编排不应误删编辑音符');

  await app.navigate('#/edit');
  await app.waitFor('!!(window.__fufumidiDebug && window.__fufumidiDebug.historyDepth)', { timeout: 25000 });
  await app.eval('(' + E + '.undo(), true)');
  await new Promise((r) => setTimeout(r, 200));
  if (await count() !== base) throw new Error('跨页撤销没有回退编辑音符');
  await app.eval('(' + E + '.redo(), true)');
  await new Promise((r) => setTimeout(r, 200));
  if (await count() !== base + 1) throw new Error('跨页重做没有恢复编辑音符');
}
