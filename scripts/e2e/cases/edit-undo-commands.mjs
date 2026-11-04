// P-011 第一批：单音符 add/delete/update 走增量命令；快照 entry 与命令 entry 共用一条栈。
// 隐藏窗口运行（lib.mjs 设 FUFUMIDI_E2E_HIDDEN=1），不弹窗。
import { encodeMidi } from '../../../frontend/src/core/midi.js';

const MINI = Array.from(encodeMidi([{
  name: 'P011 Undo', ch: 0, program: 0,
  notes: [
    { start: 0, end: 480, midi: 60, vel: 100, ch: 0 },
    { start: 480, end: 960, midi: 64, vel: 90, ch: 0 },
  ],
  ccs: [], events: [],
}], { division: 480 }));

export default async function (app) {
  await app.waitFor("!!window.__fufumidiE2E", { timeout: 20000, message: 'E2E 钩子' });
  const hasSong = await app.eval("!!(window.__fufumidiE2E && window.__fufumidiE2E.hasSong())");
  if (!hasSong) {
    await app.eval("window.__fufumidiE2E.importMidi('p011-undo.mid', " + JSON.stringify(MINI) + ")");
    await app.waitFor("!!(window.__fufumidiE2E && window.__fufumidiE2E.hasSong())", { timeout: 20000, message: '导入曲目' });
  }
  // ViewEdit 的调试桥显式开关：localStorage.fufumidi_debug='1'（生产用户永不命中）
  await app.eval("(localStorage.setItem('fufumidi_debug', '1'), true)");
  await app.navigate('#/edit');
  await app.waitFor("!!(window.__fufumidiDebug && window.__fufumidiDebug.editor && window.__fufumidiDebug.editor())", { timeout: 25000, message: '编辑页 editor 钩子' });
  const E = 'window.__fufumidiDebug.editor()';
  const S = 'window.__fufumidiDebug.song()';
  const count = () => app.eval("(" + S + ".tracks[0].notes || []).length");
  const snapshots = () => app.eval("(" + E + ".historySnapshots() || [])");
  const clear = () => app.eval("(" + E + ".clearHistory(), true)");

  await clear();
  const base = await count();
  await app.eval("(" + E + ".addNote(240, 62, 240), true)");
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base + 1) throw new Error('addNote 没有落音符');
  let hs = await snapshots();
  if (hs.length !== 1 || hs[0].kind !== 'command') throw new Error('addNote 未生成 command entry: ' + JSON.stringify(hs));

  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base) throw new Error('Ctrl+Z 没有撤销 addNote');
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base + 1) throw new Error('Ctrl+Shift+Z 没有重做 addNote');

  // editNote：按引用改 vel，撤销必须改回同一个音符（基线 vel 可能来自设置，不写死 100）
  const beforeVel = await app.eval("(() => { const n = " + S + ".tracks[0].notes.find(x => x.start === 240 && x.midi === 62); return n ? n.vel : -1; })()");
  await app.eval("(() => { const ed = " + E + ", n = " + S + ".tracks[0].notes.find(x => x.start === 240 && x.midi === 62); return ed.editNote(n, { vel: 55 }); })()");
  await new Promise((r) => setTimeout(r, 150));
  let vel = await app.eval("(() => { const n = " + S + ".tracks[0].notes.find(x => x.start === 240 && x.midi === 62); return n ? n.vel : -1; })()");
  if (vel !== 55) throw new Error('editNote 未应用 vel=' + vel);
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  vel = await app.eval("(() => { const n = " + S + ".tracks[0].notes.find(x => x.start === 240 && x.midi === 62); return n ? n.vel : -1; })()");
  if (vel !== beforeVel) throw new Error('editNote undo 未恢复 vel=' + vel + ' 期望 ' + beforeVel);
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 150));
  vel = await app.eval("(() => { const n = " + S + ".tracks[0].notes.find(x => x.start === 240 && x.midi === 62); return n ? n.vel : -1; })()");
  if (vel !== 55) throw new Error('editNote redo 未恢复 vel=' + vel);

  // deleteNoteExternal：undo 插回，redo 再删
  await app.eval("(() => { const ed = " + E + ", n = " + S + ".tracks[0].notes.find(x => x.start === 240 && x.midi === 62); return ed.deleteNoteExternal(n); })()");
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base) throw new Error('deleteNoteExternal 未删除');
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base + 1) throw new Error('deleteNoteExternal undo 未插回');
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base) throw new Error('deleteNoteExternal redo 未再删');

  // 混合屏障：快照 entry + 命令 entry 必须按真实先后撤销
  await app.eval("(" + E + ".pushStateForTrack(0, '快照屏障'), true)");
  await app.eval("(" + E + ".addNote(720, 67, 120), true)");
  await new Promise((r) => setTimeout(r, 150));
  const afterBoth = await count();
  if (afterBoth !== base + 1) throw new Error('屏障后音符数异常 ' + afterBoth);
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base) throw new Error('第一次撤销应去掉命令音符');
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== base) throw new Error('第二次撤销回到快照前');
  await app.key('Ctrl+Shift+Z');
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 200));
  if (await count() !== afterBoth) throw new Error('两次重做未回到屏障后的状态');

  // redo 清空：撤销后新编辑，redo 必须归零
  await app.key('Ctrl+Z');
  await app.eval("(" + E + ".addNote(960, 69, 120), true)");
  await new Promise((r) => setTimeout(r, 150));
  const canRedo = await app.eval("" + E + ".canRedo()");
  if (canRedo) throw new Error('新命令后 redo 未清空');

  // 批量删除：deleteNotes 也必须走命令 entry，undo 插回、redo 再删
  await clear();
  const batchBase = await count();
  if (batchBase < 2) throw new Error('批量删除测试需要至少 2 个音符');
  await app.eval("(() => { const ed = " + E + ", s = " + S + ", n = s.tracks[0].notes.slice(0, 2); return ed.deleteNotes(n); })()");
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== batchBase - 2) throw new Error('deleteNotes 未批量删除');
  const bhs = await snapshots();
  if (!bhs.length || bhs[bhs.length - 1].kind !== 'command') throw new Error('批量删除未生成 command entry');
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== batchBase) throw new Error('deleteNotes undo 未全部插回');
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== batchBase - 2) throw new Error('deleteNotes redo 未全部再删');

  // 隐藏窗口下 Page.captureScreenshot 偶发超时；本用例的验收证据是上面的状态断言，不依赖截图。
}
