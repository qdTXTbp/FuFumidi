// P-011 末项：EditorCanvas 使用 session 按 doc 持有的同一撤销引擎（隐藏窗口）
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const mk = (name, base) => Array.from(encodeMidi([{
  name, ch: 0, program: 0,
  notes: [{ start: base, end: base + 480, midi: 60, vel: 100, ch: 0 }, { start: base + 480, end: base + 960, midi: 64, vel: 90, ch: 0 }],
  ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor('!!window.__fufumidiE2E', { timeout: 20000, message: 'E2E 钩子' });
  if (!(await app.eval('!!window.__fufumidiE2E.hasSong()'))) {
    await app.eval("window.__fufumidiE2E.importMidi('p011-session-a.mid', " + JSON.stringify(mk('P011 Session A', 0)) + ")");
    await app.waitFor('!!window.__fufumidiE2E.hasSong()', { timeout: 20000 });
  }
  await app.eval("(localStorage.setItem('fufumidi_debug', '1'), true)");
  await app.navigate('#/edit');
  await app.waitFor('!!(window.__fufumidiDebug && window.__fufumidiDebug.historyDepth)', { timeout: 25000, message: 'session 调试桥' });
  const E = 'window.__fufumidiDebug.editor()';
  const D = 'window.__fufumidiDebug.historyDepth()';
  const S = 'window.__fufumidiDebug.song()';
  const count = () => app.eval("(" + S + ".tracks[0].notes || []).length");

  await app.eval('(' + E + '.clearHistory(), true)');
  const base = await count();
  await app.eval('(' + E + '.addNote(240, 66, 120), true)');
  await new Promise((r) => setTimeout(r, 150));
  const d1 = await app.eval('JSON.stringify(' + D + ')');
  const hs = await app.eval('JSON.stringify(' + E + '.historySnapshots())');
  const depth = JSON.parse(d1), snaps = JSON.parse(hs);
  if (depth.undo !== 1 || snaps.length !== 1) throw new Error('session 栈数量不同步: ' + d1 + ' / ' + hs);
  if (snaps[0].kind !== 'command') throw new Error('entry 不是 command: ' + hs);
  const sum = snaps.reduce((s, x) => s + (x.bytes || 0), 0);
  if (sum !== depth.bytes) throw new Error('面板 bytes 与引擎 bytes 不一致: ' + sum + ' != ' + depth.bytes);

  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base) throw new Error('session undo 未生效');
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base + 1) throw new Error('session redo 未生效');

  // KeepAlive 跨页保持同一 doc/engine
  await app.navigate('#/home');
  await app.waitFor('location.hash.indexOf("home") >= 0', { timeout: 15000 });
  await new Promise((r) => setTimeout(r, 300));
  await app.navigate('#/edit');
  await app.waitFor('!!(window.__fufumidiDebug && window.__fufumidiDebug.historyDepth)', { timeout: 20000 });
  const d2 = JSON.parse(await app.eval('JSON.stringify(' + D + ')'));
  if (d2.undo !== 1) throw new Error('跨页后栈丢失: ' + JSON.stringify(d2));

  // 切到第二首：新 doc 必须是空栈
  const docA = await app.eval('window.__fufumidiDebug.docId()');
  await app.eval("window.__fufumidiE2E.importMidi('p011-session-b.mid', " + JSON.stringify(mk('P011 Session B', 960)) + ")");
  await app.waitFor("window.__fufumidiDebug.docId() !== " + JSON.stringify(docA), { timeout: 20000, message: '切到第二首 doc' });
  await new Promise((r) => setTimeout(r, 300));
  const d3 = JSON.parse(await app.eval('JSON.stringify(' + D + ')'));
  if (d3.undo !== 0) throw new Error('新曲目撤销栈未隔离: ' + JSON.stringify(d3));
  const canUndo = await app.eval('' + E + '.canUndo()');
  if (canUndo) throw new Error('新曲目 canUndo 应为 false');
}
