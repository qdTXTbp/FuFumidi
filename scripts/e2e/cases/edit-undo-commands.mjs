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

  // 批量字段修改：selectAll + transpose/setSelVel 也必须走 update 命令
  await clear();
  await app.eval("(" + E + ".selectAll(), true)");
  const midiBefore = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.midi)");
  await app.eval("(" + E + ".transposeSelected(2), true)");
  await new Promise((r) => setTimeout(r, 150));
  let midiAfter = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.midi)");
  if (JSON.stringify(midiAfter) !== JSON.stringify(midiBefore.map((m) => m + 2))) throw new Error('transposeSelected 未批量移调: ' + JSON.stringify(midiAfter));
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  midiAfter = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.midi)");
  if (JSON.stringify(midiAfter) !== JSON.stringify(midiBefore)) throw new Error('transpose undo 未恢复: ' + JSON.stringify(midiAfter));
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 150));
  midiAfter = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.midi)");
  if (JSON.stringify(midiAfter) !== JSON.stringify(midiBefore.map((m) => m + 2))) throw new Error('transpose redo 未恢复: ' + JSON.stringify(midiAfter));

  await app.eval("(" + E + ".selectAll(), true)");
  const velBefore = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.vel)");
  await app.eval("(" + E + ".setSelVel(42), true)");
  await new Promise((r) => setTimeout(r, 150));
  const velAfter = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.vel)");
  if (!velAfter.every((v) => v === 42)) throw new Error('setSelVel 未批量应用: ' + JSON.stringify(velAfter));
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  const velUndo = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.vel)");
  if (JSON.stringify(velUndo) !== JSON.stringify(velBefore)) throw new Error('setSelVel undo 未恢复: ' + JSON.stringify(velUndo));

  // 粘贴/复制：add 命令 + 选区按引用
  await clear();
  const clipBase = await count();
  await app.eval("(" + E + ".selectAll(), true)");
  await app.eval("(" + E + ".copySelected(), true)");
  await app.eval("(" + E + ".pasteAt(0), true)");
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== clipBase * 2) throw new Error('pasteAt 未复制全部音符');
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== clipBase) throw new Error('paste undo 未恢复');
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== clipBase * 2) throw new Error('paste redo 未恢复');

  await app.eval("(" + E + ".selectAll(), true)");
  const dupCount = await app.eval("(" + E + ".selCount() || 0)");
  await app.eval("(" + E + ".duplicateSelected(), true)");
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== clipBase * 2 + dupCount) throw new Error('duplicateSelected 数量不对');
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await count() !== clipBase * 2) throw new Error('duplicate undo 未恢复');

  // 延音踏板：CC 增删也走命令 entry
  await clear();
  const ccBase = await app.eval("((" + S + ".tracks[0].ccs) || []).length");
  const addedCc = await app.eval("(" + E + ".addPedal() || 0)");
  if (addedCc !== 2) throw new Error('addPedal 未添加两个 CC');
  if (await app.eval("((" + S + ".tracks[0].ccs) || []).length") !== ccBase + 2) throw new Error('addPedal 后 CC 数不对');
  const ccSnaps = await snapshots();
  if (!ccSnaps.length || ccSnaps[ccSnaps.length - 1].kind !== 'command') throw new Error('踏板未生成 command entry');
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await app.eval("((" + S + ".tracks[0].ccs) || []).length") !== ccBase) throw new Error('踏板 undo 未删除 CC');
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await app.eval("((" + S + ".tracks[0].ccs) || []).length") !== ccBase + 2) throw new Error('踏板 redo 未恢复 CC');
  const removedCc = await app.eval("(" + E + ".delPedal() || 0)");
  if (removedCc < 1) throw new Error('delPedal 未删除 CC');
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (await app.eval("((" + S + ".tracks[0].ccs) || []).length") !== ccBase + 2) throw new Error('delPedal undo 未恢复 CC');

  // 实时预览提交：commitPreview 必须一条 update 命令，撤销回预览前
  await clear();
  await app.eval("(" + E + ".selectAll(), true)");
  const prevBefore = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.vel)");
  await app.eval("(" + E + ".beginPreview(), true)");
  await app.eval("(" + E + ".applyPreviewNow(notes => { notes.forEach(n => { n.vel = 45; }); return notes.length; }), true)");
  await app.eval("(" + E + ".commitPreview(), true)");
  await new Promise((r) => setTimeout(r, 150));
  const prevAfter = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.vel)");
  if (!prevAfter.every((v) => v === 45)) throw new Error('commitPreview 未提交 vel=45: ' + JSON.stringify(prevAfter));
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  const prevUndo = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.vel)");
  if (JSON.stringify(prevUndo) !== JSON.stringify(prevBefore)) throw new Error('commitPreview undo 未恢复');
  await app.key('Ctrl+Shift+Z');
  await new Promise((r) => setTimeout(r, 150));
  if (!(await app.eval("(" + S + ".tracks[0].notes || []).every(n => n.vel === 45)"))) throw new Error('commitPreview redo 未恢复');

  // 草稿批量写回也走 update 命令
  await clear();
  await app.eval("(" + E + ".selectAll(), true)");
  const draftBefore = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.vel)");
  await app.eval("(() => { const ed = " + E + ", arr = ed.selNotes(); arr.forEach(d => { d.vel = 51; }); return ed.applyDraft(arr); })()");
  await new Promise((r) => setTimeout(r, 150));
  if (!(await app.eval("(" + S + ".tracks[0].notes || []).every(n => n.vel === 51)"))) throw new Error('applyDraft 未批量写回');
  await app.key('Ctrl+Z');
  await new Promise((r) => setTimeout(r, 150));
  const draftUndo = await app.eval("(" + S + ".tracks[0].notes || []).map(n => n.vel)");
  if (JSON.stringify(draftUndo) !== JSON.stringify(draftBefore)) throw new Error('applyDraft undo 未恢复');

  // 隐藏窗口下 Page.captureScreenshot 偶发超时；本用例的验收证据是上面的状态断言，不依赖截图。
}
