// E2E：P1-13 分标签页独立撤销栈（编排页）—— 两个曲目的撤销互不影响，切回后可继续撤销
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MIDI_A = Array.from(encodeMidi([{ name: 'TabsUndo A', ch: 0, program: 0, notes: [{ start: 0, end: 4800, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [] }], { division: 480 }));
const MIDI_B = Array.from(encodeMidi([{ name: 'TabsUndo B', ch: 0, program: 0, notes: [{ start: 0, end: 4800, midi: 67, vel: 100, ch: 0 }], ccs: [], events: [] }], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000 });
  await app.eval("window.__fufumidiE2E.importMidi('tabs-undo-a.mid', " + JSON.stringify(MIDI_A) + ")");
  await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  const aId = await app.eval('window.__fufumidiE2E.currentSongId ? window.__fufumidiE2E.currentSongId() : (window.__fufumidiTabs().activeId)');
  await app.eval("window.__fufumidiE2E.importMidi('tabs-undo-b.mid', " + JSON.stringify(MIDI_B) + ")");
  await app.waitFor('!window.__fufumidiTabs || window.__fufumidiTabs().tabs.length >= 2', { timeout: 20000 });
  const tabs = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiTabs().tabs)'));
  const bId = tabs.map((t) => t.id).find((id) => id !== aId) || tabs[1].id;

  // 切到 A，编排页加一个标记 → 撤销深度 1
  await app.eval("(() => { const el = [...document.querySelectorAll('[data-guide=song-tabs] .song-tab')].find((b) => b.getAttribute('data-song-id') === " + JSON.stringify(String(aId)) + "); if (!el) return false; el.click(); return true; })()");
  await app.waitFor('window.__fufumidiTabs().activeId === ' + JSON.stringify(String(aId)), { timeout: 15000 });
  await app.navigate('#/arrange');
  await app.waitFor('!!window.__fufumidiArrange', { timeout: 25000, message: '编排页钩子出现' });
  await app.eval("(() => { const b = [...document.querySelectorAll('button')].find((x) => x.innerText.trim() === '加标记' || /加标记/.test(x.innerText)); if (b) b.click(); return !!b; })()");
  await new Promise((r) => setTimeout(r, 250));
  let d = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiArrange.depth())'));
  app.assert(d.undo === 1, 'A 标签加标记后撤销深度 1：' + JSON.stringify(d));

  // 切到 B：历史栈应是**独立的空栈**
  await app.eval("(() => { const el = [...document.querySelectorAll('[data-guide=song-tabs] .song-tab')].find((b) => b.getAttribute('data-song-id') === " + JSON.stringify(String(bId)) + "); if (!el) return false; el.click(); return true; })()");
  await app.waitFor('window.__fufumidiTabs().activeId === ' + JSON.stringify(String(bId)), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));
  d = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiArrange.depth())'));
  app.assert(d.undo === 0, 'B 标签是独立历史栈（初始为空）：' + JSON.stringify(d));

  // B 也加一个标记并撤销；随后切回 A，A 的撤销记录仍在
  await app.eval("(() => { const b = [...document.querySelectorAll('button')].find((x) => /加标记/.test(x.innerText)); if (b) b.click(); return !!b; })()");
  await new Promise((r) => setTimeout(r, 250));
  d = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiArrange.depth())'));
  app.assert(d.undo === 1, 'B 标签加标记后深度 1');
  await app.eval('window.__fufumidiArrange.undo()');
  await new Promise((r) => setTimeout(r, 150));
  d = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiArrange.depth())'));
  app.assert(d.undo === 0, 'B 撤销后深度 0');

  await app.eval("(() => { const el = [...document.querySelectorAll('[data-guide=song-tabs] .song-tab')].find((b) => b.getAttribute('data-song-id') === " + JSON.stringify(String(aId)) + "); if (!el) return false; el.click(); return true; })()");
  await app.waitFor('window.__fufumidiTabs().activeId === ' + JSON.stringify(String(aId)), { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));
  d = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiArrange.depth())'));
  app.assert(d.undo === 1, '切回 A 后撤销记录仍在：' + JSON.stringify(d));
  await app.eval('window.__fufumidiArrange.undo()');
  await new Promise((r) => setTimeout(r, 150));
  d = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiArrange.depth())'));
  app.assert(d.undo === 0 && d.redo === 1, 'A 撤销后深度 0 / redo 1：' + JSON.stringify(d));
  await app.screenshot('arrange-tabs-undo');
  app.assert(true, '分标签撤销栈通过');
}
