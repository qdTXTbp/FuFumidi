// pruneLive 的受害者选择策略回归护栏。
//
// 背景：预排窗口内的音符是「先创建节点、后到点发声」，所以一个活节点分两种状态 ——
// 还没开始发声（tStart > now）与正在发声（tStart <= now）。超预算时若按 tStop 从小到大砍，
// 砍掉的恰好是正在响的那批，极端密集的文件（160 音符/秒，预排窗口本身就撑满上限）
// 会整首歌变成数字静音。这里把「先丢未发声的」这条策略钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Synth } from '../src/core/synth.js';

// pruneLive 只用到 ctx.currentTime 与 this.live，直接借原型方法跑，不必构造真 Synth
function fakeSynth(now, entries) {
  const stopped = [];
  return {
    ctx: { currentTime: now },
    stopped,
    live: entries.map(e => ({ o: { stop() { stopped.push(e.id); } }, tStop: e.tStop, tStart: e.tStart, id: e.id })),
    pruneLive: Synth.prototype.pruneLive,
    expireLive: Synth.prototype.expireLive,
  };
}
const ids = (s) => s.live.map(x => x.id).sort();

test('pruneLive 先回收已经自然结束的节点，且不受预算影响', () => {
  const s = fakeSynth(10, [
    { id: 'ended', tStart: 9.0, tStop: 9.5 },
    { id: 'ring', tStart: 9.8, tStop: 10.5 },
  ]);
  s.pruneLive(256);
  assert.deepEqual(s.stopped, ['ended']);
  assert.deepEqual(ids(s), ['ring']);
});

test('超预算时先丢「还没开始发声」的预排音，绝不先丢正在响的（本次修复的核心）', () => {
  const entries = [
    { id: 'ring1', tStart: 9.5, tStop: 10.4 },  // 正在响
    { id: 'ring2', tStart: 9.6, tStop: 10.6 },  // 正在响
    { id: 'fut1', tStart: 10.3, tStop: 11.3 },  // 还没发声
    { id: 'fut2', tStart: 10.8, tStop: 11.8 },  // 还没发声
  ];
  const s = fakeSynth(10, entries);
  s.pruneLive(3); // 丢 1 个
  assert.deepEqual(s.stopped, ['fut2'], '应丢「最晚才开始发声」的那个预排音');
  assert.deepEqual(ids(s), ['fut1', 'ring1', 'ring2'], '正在响的两个必须保住');

  // 对照：旧实现按 tStop 升序取受害者，第一个就是正在响的 ring1 —— 把这个差异钉死
  const byStop = entries.slice().sort((a, b) => a.tStop - b.tStop)[0].id;
  assert.equal(byStop, 'ring1', '旧策略的首个受害者正是正在响的音');
  assert.ok(!s.stopped.includes('ring1'), '新策略不得丢正在响的音');
});

test('预排音不够丢时才动用正在响的，且从剩余声音最少的开始', () => {
  const s = fakeSynth(10, [
    { id: 'ring1', tStart: 9.5, tStop: 10.2 },
    { id: 'ring2', tStart: 9.6, tStop: 11.0 },
    { id: 'fut1', tStart: 10.5, tStop: 11.5 },
  ]);
  s.pruneLive(1); // 丢 2 个：1 个预排音 + 1 个正在响的（剩余最短的 ring1）
  assert.deepEqual(s.stopped, ['fut1', 'ring1']);
  assert.deepEqual(ids(s), ['ring2']);
});

test('未超预算时不丢任何东西', () => {
  const s = fakeSynth(10, [{ id: 'a', tStart: 9.9, tStop: 11 }]);
  s.pruneLive(256);
  assert.deepEqual(s.stopped, []);
  assert.deepEqual(ids(s), ['a']);
});

test('缺少 tStart 的节点按「已发声」处理，不会误伤正在响的声音', () => {
  const s = fakeSynth(10, [
    { id: 'legacy', tStop: 10.3 },                 // 无 tStart：按正在发声处理
    { id: 'fut', tStart: 10.5, tStop: 11.5 },      // 预排
  ]);
  s.pruneLive(1);
  assert.deepEqual(s.stopped, ['fut']);
  assert.deepEqual(ids(s), ['legacy']);
});

// expireLive 是调度器每趟（25ms）用来拿「当前节点占用」的入口：它只回收已经自然结束的节点、
// 不做任何丢弃，因此必须是纯回收语义；同时要原地压缩（这个频率下不该产生新数组）。
test('expireLive 只回收已结束的节点，并原样保留其余节点', () => {
  const s = fakeSynth(10, [
    { id: 'ended1', tStart: 9.0, tStop: 9.9 },
    { id: 'ring', tStart: 9.8, tStop: 11.0 },
    { id: 'fut', tStart: 10.6, tStop: 11.6 },
  ]);
  const before = s.live;
  const n = s.expireLive();
  assert.equal(n, 2, '返回值是清理后的占用数');
  assert.equal(s.live.length, 2);
  assert.equal(s.live, before, '应原地压缩，不新建数组');
  assert.deepEqual(s.stopped, ['ended1']);
  assert.deepEqual(ids(s), ['fut', 'ring']);
});

test('expireLive 在 tStop 恰好等于当前时刻时也回收（与旧实现同界）', () => {
  const s = fakeSynth(10, [{ id: 'edge', tStart: 9.5, tStop: 10 }, { id: 'keep', tStart: 9.5, tStop: 10.0001 }]);
  assert.equal(s.expireLive(), 1);
  assert.deepEqual(ids(s), ['keep']);
});

test('expireLive 不丢弃还在响或还排在窗口里的节点（哪怕远超预算）', () => {
  const s = fakeSynth(10, [
    { id: 'r1', tStart: 9.9, tStop: 11 },
    { id: 'f1', tStart: 10.4, tStop: 11.4 },
    { id: 'f2', tStart: 10.9, tStop: 11.9 },
  ]);
  assert.equal(s.expireLive(), 3);
  assert.deepEqual(s.stopped, [], '没有节点自然结束，就不该 stop 任何东西');
});
