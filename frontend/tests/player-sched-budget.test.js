// 预排调度的「节点预算软上限」回归护栏。
//
// 背景：内置合成器路径是「预排即建节点」，节点数 ≈ 预排窗口 ×（窗口内密度 + 尾音）。
// 构造曲目 large-60k 平均 160 音符/秒（实测段落约 180 音符/秒、每音符约 4.4 个节点），
// 1 秒窗口加尾音就把 1024 的节点预算顶满，pruneLive 于是每 25ms 丢弃一批「还排在窗口里」的
// 节点（实测 336 节点/秒，约合该段落四成音符）。修复方式：占用接近预算时，本趟不再继续往后排，
// 把「丢音」换成「预排窗口变浅」。下面把三条边界钉死：到顶就停、没到顶行为不变、
// 不创建节点的路径（SF2 音序器 / 直接路径）完全不受影响。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/core/player.js';

// 每 tick = 1ms，便于把「窗口」直接读成 tick 数
function fakePlayer({ n = 20, limit = 8, now = 100, aheadSec = 1 } = {}) {
  const scheduled = [];
  const expired = { calls: 0 };
  const syn = {
    _sf2SeqMode: false,
    _liveLimit: limit,
    live: [],
    expireLive() { expired.calls++; return this.live.length; },
    noteOn(t, note) {
      scheduled.push({ t, midi: note.midi });
      this.live.push({ tStart: t, tStop: t + 2 });   // 模拟「一个节点」
    },
    midiEvent() {},
  };
  const events = [];
  for (let i = 0; i < n; i++) events.push({ start: i + 1, end: i + 3, midi: 60 + i, trk: 0 });
  return {
    ctx: { currentTime: now },
    song: {
      tpb: 480, totalTicks: 100000, sigMap: [{ num: 4 }],
      baseSec: (tk) => tk / 1000, secToTick: (s) => s * 1000,
    },
    startSec: now, startTick: 0, scale: 1, playing: true, pausedTick: 0,
    aheadSec, AHEAD_BASE: 1, cursor: 0, ccursor: 0, _cbCursor: 0,
    events, ctlEvents: [], metro: false, metroBeat: 0, _metroNodes: [],
    onNote: null, syn, scheduled, expired,
    _sched: Player.prototype._sched, noteTime: Player.prototype.noteTime, noteEndTime: Player.prototype.noteEndTime,
  };
}

test('占用达到软上限（预算的 3/4）时，本趟立即停止继续往后排', () => {
  const p = fakePlayer({ n: 20, limit: 8 });     // 软上限 = 6
  p._sched();
  assert.equal(p.scheduled.length, 6, '只排到预算的 3/4 就停，避免顶穿预算后被迫丢音');
  assert.equal(p.cursor, 6, '游标停在已排到的位置，剩下的留给下一趟');
});

test('占用没到软上限时，行为与改动前完全一致（排满整个预排窗口）', () => {
  const p = fakePlayer({ n: 20, limit: 1024 });  // 软上限 768，远高于这 20 个音符
  p._sched();
  assert.equal(p.scheduled.length, 20, '窗口内的音符全部排上');
  assert.equal(p.cursor, 20);
});

test('调度器每趟都会先回收已结束的节点，再决定还能排多少', () => {
  const p = fakePlayer({ n: 4, limit: 8 });
  p._sched();
  assert.equal(p.expired.calls, 1, '每趟恰好回收一次');
  assert.equal(p.scheduled.length, 4);
});

test('不创建节点的路径（SF2 音序器）不受软上限约束', () => {
  const p = fakePlayer({ n: 20, limit: 8 });
  p.syn._sf2SeqMode = true;
  p.syn.noteOn = function (t, note) { p.scheduled.push({ t, midi: note.midi }); };  // live 恒为 0
  p._sched();
  assert.equal(p.scheduled.length, 20, 'live 恒为 0 的路径不该被节点预算拦住');
});

test('已经播完（结束时刻早于现在）的音符仍然被跳过，且不占用预算', () => {
  const p = fakePlayer({ n: 20, limit: 8 });
  // 前 10 个音符整体落在过去（tick 1~10 → 99.901~99.912s，结束时刻都早于 now-30ms），
  // 后 10 个落在 0.5s 之后的窗口内
  for (let i = 0; i < 10; i++) p.events[i] = { start: i + 1, end: i + 2, midi: 60 + i, trk: 0 };
  for (let i = 0; i < 10; i++) p.events[10 + i] = { start: 500 + i * 10, end: 505 + i * 10, midi: 70 + i, trk: 0 };
  p.ctx.currentTime = 100;
  p.startSec = 99.9;
  p._sched();
  assert.ok(p.scheduled.every(s => s.midi >= 70), '已播完的不应被排进来');
  assert.equal(p.scheduled.length, 6, '跳过的音符不消耗预算，仍排到软上限');
});
