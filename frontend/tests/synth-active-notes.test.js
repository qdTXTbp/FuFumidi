// 活跃音符表（synth.activeNotes）清理逻辑的回归护栏。
//
// 背景：这张表既被 activeNow() 每帧全量 filter（可视化页的和弦/卷帘），也被 allStop()
// 全量遍历逐条发 midiNoteOff。清理原先只放在内置合成器分支里，而 SF2 的三条分支都提前
// return —— 桌面端默认走 SF2，于是这张表只增不减（一首 5 分钟密集曲目可累积数万条），
// 表现为「播放越久越卡」。
//
// 第二层约束：清理不能是「每来一个音符就全量过滤一次」。极密曲目（实测 160 音符/秒）在
// 预排窗口内随时有近 5000 条尚未结束、清不掉的记录，那样一秒就是百万级扫描。
// 这里用「数组引用是否变化」来观测是否真的发生了一次过滤。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Synth } from '../src/core/synth.js';

function fakeSynth(now, entries) {
  return {
    ctx: { currentTime: now },
    activeNotes: entries.map(e => ({ midi: 60, start: e.start, endTime: e.end })),
    _trimThreshold: 3000,
    _trimActive: Synth.prototype._trimActive,
  };
}
const mk = (n, end) => Array.from({ length: n }, (_, i) => ({ start: 0, end }));
const didFilter = (s, before) => s.activeNotes !== before;

test('未达阈值时完全不动（连一次 filter 都不做）', () => {
  const s = fakeSynth(100, mk(2999, 90));
  const before = s.activeNotes;
  s._trimActive();
  assert.equal(didFilter(s, before), false, '不该重建数组');
  assert.equal(s.activeNotes.length, 2999);
});

test('达到阈值时丢掉已经结束的记录，保留仍在发声的', () => {
  const s = fakeSynth(100, mk(3000, 90).concat(mk(5, 130)));
  assert.equal(s.activeNotes.length, 3005);
  s._trimActive();
  assert.equal(s.activeNotes.length, 5, '只应留下 endTime > now 的 5 条');
});

test('阈值随存活量上浮：存活很多时不会每个音符都触发一次全量过滤', () => {
  // 模拟极密曲目：窗口内近 5000 条都还没结束，一批过期记录把它们顶过了阈值
  const s = fakeSynth(100, mk(1000, 90).concat(mk(4000, 200)));
  s._trimActive();
  assert.equal(s.activeNotes.length, 4000, '清掉 1000 条过期的，留下 4000 条存活');
  assert.ok(s._trimThreshold >= 5000, '阈值应上浮到 5000（4000×1.25），实际 ' + s._trimThreshold);

  // 再涨到 4100 条（仍未到 5000）时不应再次过滤
  const before = s.activeNotes;
  for (let i = 0; i < 100; i++) s.activeNotes.push({ midi: 60, start: 0, endTime: 200 });
  s._trimActive();
  assert.equal(didFilter(s, before), false, '未到上浮后的阈值就不该重建数组');
  assert.equal(s.activeNotes.length, 4100);
});

test('上浮后的阈值仍会再次触发清理，不会永久停摆', () => {
  const s = fakeSynth(100, mk(1000, 90).concat(mk(4000, 130)));
  s._trimActive();                                  // 留下 4000 条存活（endTime=130）
  const th = s._trimThreshold;
  for (let i = 0; i < th - 4000 + 1; i++) s.activeNotes.push({ midi: 60, start: 0, endTime: 130 });
  // 时间推进到全都结束之后
  s.ctx.currentTime = 200;
  s._trimActive();
  assert.equal(s.activeNotes.length, 0, '时间过了之后应当能全部清掉');
});
