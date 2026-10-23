import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStore } from '../src/core/session.js';

const T0 = 1_700_000_000_000;

test("C3 打开/列表/当前/切换/关闭", () => {
  const s = createSessionStore();
  const a = s.open({ docId: "a", kind: "edit", title: "曲 A", path: "C:/a.mid" });
  const b = s.open({ docId: "b", kind: "sing", title: "歌 B" });
  assert.equal(a.docId, "a");
  assert.equal(s.list().length, 2);
  assert.equal(s.current().docId, "b");
  assert.equal(s.activate("a"), true);
  assert.equal(s.current().docId, "a");
  assert.equal(s.close("b"), true);
  assert.equal(s.get("b"), null);
  assert.equal(s.close("a"), true);
  assert.equal(s.current(), null);
  assert.equal(s.activate("不存在"), false);
});

test("C3 脏标记用序号：markDirty/isDirty/markSaved", () => {
  const s = createSessionStore();
  s.open({ docId: "a" });
  assert.equal(s.isDirty("a"), false);
  s.markDirty("a", "改音符");
  s.markDirty("a", "改速度");
  assert.equal(s.isDirty("a"), true);
  assert.equal(s.dirtyCount(), 1);
  s.markSaved("a", T0);
  assert.equal(s.isDirty("a"), false);
  assert.equal(s.get("a").lastSavedAt, T0);
  assert.equal(s.markDirty("不存在"), 0);
});

test("C3 自动保存时机：脏 && 距上次保存 ≥ 30s（可调）", () => {
  const s = createSessionStore();
  s.open({ docId: "a" });
  s.markSaved("a", 0);
  s.markDirty("a");
  assert.equal(s.shouldAutosave("a", 5000), false, "刚保存 5s 不自动存");
  assert.equal(s.shouldAutosave("a", 30000), true, "30s 到点自动存");
  s.markSaved("a", 30000);
  assert.equal(s.shouldAutosave("a", 99999), false, "保存后不再脏 → 不自动存");
  s.markDirty("a");
  assert.equal(s.shouldAutosave("a", 30001), false, "刚保存 1ms 不自动存");
  assert.equal(s.shouldAutosave("a", 40000, 10), true, "间隔可调 10s（差 10000ms ≥ 10000）");
  assert.equal(s.shouldAutosave("不存在", 99999), false);
});

test("C3 撤销/重做：一次手势一条记录；新编辑清空重做栈", () => {
  const s = createSessionStore();
  s.open({ docId: "a" });
  let value = 0;
  s.pushUndo("a", { label: "加 1", undo: () => { value -= 1; }, redo: () => { value += 1; } });
  value += 1;
  s.markDirty("a");
  assert.equal(s.canUndo("a"), true);
  assert.equal(s.undo("a"), true);
  assert.equal(value, 0);
  assert.equal(s.canRedo("a"), true);
  assert.equal(s.redo("a"), true);
  assert.equal(value, 1);
  assert.equal(s.canRedo("a"), false, "redo 用完即空");
  s.pushUndo("a", { label: "改速度", undo: () => {}, redo: () => {} });
  assert.equal(s.canRedo("a"), false, "新编辑清空 redo");
  assert.equal(s.undo("a"), true, "撤销第二条");
  assert.equal(s.canUndo("a"), true, "第一条还在");
  assert.equal(s.undo("a"), true, "撤销第一条");
  assert.equal(s.canUndo("a"), false);
  assert.equal(s.undo("a"), false, "栈空返回 false");
  assert.equal(s.redo("a"), true, "重做第一条");
});

test("C3 撤销栈上限与坏记录保护", () => {
  const s = createSessionStore({ maxUndo: 3 });
  s.open({ docId: "a" });
  for (let i = 0; i < 10; i++) s.pushUndo("a", { undo: () => {}, redo: () => {} });
  assert.equal(s.get("a").undo.length, 3);
  assert.equal(s.pushUndo("a", { label: "没有函数" }), false);
  assert.equal(s.pushUndo("不存在", { undo: () => {} }), false);
  assert.equal(s.undo("不存在"), false);
  s.pushUndo("a", { undo: () => { throw new Error("boom"); } });
  assert.equal(s.undo("a"), false, "undo 回调抛异常时返回 false 且不崩");
});

test("C3 视图状态：读写副本，外部改副本不影响会话", () => {
  const s = createSessionStore();
  s.open({ docId: "a", view: { zoom: 2, playhead: 960 } });
  assert.equal(s.getView("a").zoom, 2);
  s.setView("a", { scroll: 120 });
  const v = s.getView("a");
  assert.equal(v.scroll, 120);
  assert.equal(v.playhead, 960);
  v.zoom = 99;
  assert.equal(s.getView("a").zoom, 2, "getView 返回副本");
  assert.equal(s.setView("不存在", {}), false);
});

test("C3 快照/恢复：默认不含模型，includeModel 才带；恢复后脏状态与视图一致", () => {
  const s = createSessionStore();
  s.open({ docId: "a", kind: "edit", title: "曲 A", model: { notes: [1, 2, 3] }, view: { zoom: 1.5 } });
  s.markDirty("a");
  const snap = s.snapshot("a");
  assert.equal(snap.format, "fufumidi-session");
  assert.equal(snap.model, undefined, "默认不序列化模型（模型单独走 autosave 的 data）");
  assert.equal(snap.view.zoom, 1.5);
  const full = s.snapshot("a", { includeModel: true });
  assert.deepEqual(full.model, { notes: [1, 2, 3] });

  const s2 = createSessionStore();
  const doc = s2.restore(full);
  assert.equal(doc.docId, "a");
  assert.equal(doc.title, "曲 A");
  assert.equal(doc.view.zoom, 1.5);
  assert.equal(s2.isDirty("a"), true, "恢复出来的草稿应保持脏标记，等用户决定存/丢");
  assert.equal(s2.restore(null), null);
  assert.equal(s2.restore({}), null);
});

test("C3 打开已存在 doc：保留撤销栈与脏标记，可更新标题/模型", () => {
  const s = createSessionStore();
  s.open({ docId: "a", title: "旧标题" });
  s.markDirty("a");
  s.pushUndo("a", { undo: () => {}, redo: () => {} });
  const again = s.open({ docId: "a", title: "新标题", model: { x: 1 } });
  assert.equal(again.title, "新标题");
  assert.equal(again.model.x, 1);
  assert.equal(again.undo.length, 1);
  assert.equal(s.isDirty("a"), true);
});

test("C3 订阅：open/dirty/saved/close 事件；订阅者抛异常不影响主流程", () => {
  const s = createSessionStore();
  const seen = [];
  const off = s.subscribe((type, payload) => { seen.push(type); if (type === "dirty") throw new Error("subscriber boom"); });
  s.open({ docId: "a" });
  s.markDirty("a");
  s.markSaved("a");
  s.close("a");
  assert.deepEqual(seen, ["open", "dirty", "saved", "close"]);
  off();
  s.open({ docId: "b" });
  assert.equal(seen.length, 4, "退订后不再收到事件");
  assert.equal(typeof s.subscribe(null), "function");
});

test("C3 自动 docId：不传 docId 也能开，且互不相同", () => {
  const s = createSessionStore();
  const a = s.open({});
  const b = s.open({});
  assert.ok(a.docId && b.docId && a.docId !== b.docId);
  assert.equal(s.list().length, 2);
});
