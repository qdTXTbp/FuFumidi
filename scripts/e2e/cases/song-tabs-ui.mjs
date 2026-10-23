// E2E：P1-14 多标签页 —— 两首曲目自动成标签、点击切换、关闭标签（不删曲目）。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MIDI_A = Array.from(encodeMidi([{ name: "A", ch: 0, program: 0, notes: [{ start: 0, end: 480, midi: 60, vel: 100, ch: 0 }], ccs: [], events: [] }], { division: 480 }));
const MIDI_B = Array.from(encodeMidi([{ name: "B", ch: 0, program: 0, notes: [{ start: 0, end: 480, midi: 67, vel: 100, ch: 0 }], ccs: [], events: [] }], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!(window.__fufumidiE2E)', { timeout: 20000, message: 'E2E 测试钩子已注册' });
  await app.eval("window.__fufumidiE2E.importMidi('tabs-a.mid', " + JSON.stringify(MIDI_A) + ")");
  await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  await app.eval("window.__fufumidiE2E.importMidi('tabs-b.mid', " + JSON.stringify(MIDI_B) + ")");
  await app.waitFor('!window.__fufumidiTabs || window.__fufumidiTabs().tabs.length >= 2', { timeout: 20000, message: '两个标签出现' });
  await app.waitFor('!!document.querySelector("[data-guide=song-tabs]")', { timeout: 20000, message: '标签栏渲染' });
  const before = JSON.parse(await app.eval('JSON.stringify(window.__fufumidiTabs())'));
  app.assert(before.tabs.length === 2, '标签数 2，实际 ' + before.tabs.length);
  const first = before.tabs[0].id;
  await app.eval("[...document.querySelectorAll('[data-guide=song-tabs] .song-tab')].find((b) => b.getAttribute('data-song-id') === " + JSON.stringify(first) + ").click()");
  await app.waitFor('window.__fufumidiTabs().activeId === ' + JSON.stringify(first), { timeout: 15000, message: '切换到第一个标签' });
  await app.eval("(() => { const tabs = window.__fufumidiTabs().tabs; const other = tabs.find((x) => x.id !== " + JSON.stringify(first) + "); if (!other) return false; const el = [...document.querySelectorAll('[data-guide=song-tabs] .song-tab')].find((b) => b.getAttribute('data-song-id') === other.id); if (!el) return false; el.querySelector('[data-guide=song-tab-close]').click(); return true; })()");
  await app.waitFor('window.__fufumidiTabs().tabs.length === 1', { timeout: 15000, message: '关闭后剩 1 个标签' });
  app.assert((await app.eval('window.__fufumidiE2E.songCount()')) >= 2, '关闭标签不影响曲库（仍有 2 首）');
  await app.screenshot('song-tabs');
  app.assert(true, '多标签页通过');
}