// 跳过空白片段 / 开头静音 / 倍率切换位置：播放器层面的量纲与顺序回归护栏。
//
// 两个都是**实测踩到的真 bug**，所以钉在这里：
//   1. events 里的 start/end 是 **tick**，而空档判定与 seek 用**歌曲秒** ——
//      第一版直接拿 tick 当秒，开头静音的目标算成几万秒 → seek 到曲尾 → play() 重置回 0，
//      表现成「开头跳空白点了没反应」。
//   2. setScale 先改 scale 再取当前位置，等于把已按旧倍率走过的时长按新倍率重算 ——
//      从 2× 切回 1× 会**回撤一半时长**（用户长按 → 快进松手后"被倒回去一段"）。
import test from "node:test";
import assert from "node:assert/strict";
import { Player } from "../src/core/player.js";

// 假曲目：1 秒 = 1000 tick（tick ≠ 秒，这正是第一个 bug 的必要条件）
function fakePlayer({ notes = [], playing = false, now = 100, startSec = 100, startTick = 0 } = {}) {
  const secToTick = (s) => Math.round(s * 1000);
  const baseSec = (tk) => tk / 1000;
  return {
    ctx: { currentTime: now },
    startSec, startTick, playing, pausedTick: startTick,
    scale: 1,                                   // 与真实构造函数一致（否则换算全成 NaN）
    song: { secToTick, baseSec, totalSec: 100, totalTicks: 100000, tpb: 480 },
    events: notes,
    skips: [],
    skipSilence: false, skipMinGap: 2.5, skipLead: 0.2,
    _restartAt(t) { this.startTick = t; this.startSec = this.ctx.currentTime; },
    seekTick(t) { this.pausedTick = t; this.seekedTick = t; },
    currentTick: Player.prototype.currentTick,
    currentSec: Player.prototype.currentSec,
    setScale: Player.prototype.setScale,
    seekSec: Player.prototype.seekSec,
    _eventsSec: Player.prototype._eventsSec,
    _rebuildGaps: Player.prototype._rebuildGaps,
    setSkipSilence: Player.prototype.setSkipSilence,
    skipLeadingSilence: Player.prototype.skipLeadingSilence,
  };
}

const N = (a, b) => ({ start: Math.round(a * 1000), end: Math.round(b * 1000) });   // 秒 → tick

test("空档表按**秒**算，不是 tick", () => {
  const p = fakePlayer({ notes: [N(0, 10), N(20, 30), N(31, 40)] });
  p.setSkipSilence(true, 2.5, 0.2);
  assert.deepEqual(p.gaps, [{ start: 10, end: 20 }], "10~20 s 才是空档；tick 量纲会得到 10000~20000");
});

test("空档太短不算（阈值是秒）", () => {
  const p = fakePlayer({ notes: [N(0, 10), N(11, 20)] });
  p.setSkipSilence(true, 2.5, 0.2);
  assert.deepEqual(p.gaps, []);
});

test("开头静音：跳到第一个音前 lead 秒（用歌曲秒，不是几万秒）", () => {
  const p = fakePlayer({ notes: [N(19, 30)] });
  const moved = p.skipLeadingSilence(1.0, 0.5);
  assert.equal(moved, true);
  assert.equal(p.seekedTick, 18500, "19 s 起音、留 0.5 s → 落在第 18.5 秒");
});

test("没有开头静音就不动", () => {
  const p = fakePlayer({ notes: [N(0.2, 30)] });
  assert.equal(p.skipLeadingSilence(1.0, 0.5), false);
  assert.equal(p.seekedTick, undefined);
});

test("已经越过开头静音就不再往回跳", () => {
  const p = fakePlayer({ notes: [N(19, 30)], playing: true, now: 130, startSec: 100 });
  // 墙上过了 30 秒（1× → 歌曲 30 s），已经在第一个音之后
  assert.equal(p.currentSec(), 30);
  assert.equal(p.skipLeadingSilence(1.0, 0.5), false);
});

test("setScale 保持当前位置：先按旧倍率取位置，再换 scale", () => {
  const p = fakePlayer({ playing: true, now: 100, startSec: 100, startTick: 0 });
  p.setScale(1);
  p.ctx.currentTime = 110;                     // 1× 走了 10 秒 → 歌曲 10 s
  assert.equal(p.currentSec(), 10);
  p.setScale(2);                               // 切 2×：位置必须还在 10 s
  assert.equal(p.currentSec(), 10, "切倍率不能改位置（旧实现会在这里回撤一半）");
  p.ctx.currentTime = 115;                     // 2× 再走 5 秒 → 歌曲 20 s
  assert.equal(p.currentSec(), 20);
  p.setScale(1);                               // 切回 1×：位置仍在 20 s
  assert.equal(p.currentSec(), 20, "松手恢复原速要停在当前位置继续播");
});

test("长按快进再松手：位置不倒退（模拟 → 按住 20 秒后松手）", () => {
  const p = fakePlayer({ playing: true, now: 100, startSec: 100, startTick: 0 });
  p.setScale(1);
  p.setTemporary = (m) => p.setScale(1 * m);   // 与 app.setTemporaryRate 同构
  p.setTemporary(2);                           // 长按 → 切 2×
  p.ctx.currentTime = 120;                     // 2× 走 20 秒 → 歌曲 40 s
  assert.equal(p.currentSec(), 40);
  p.setTemporary(1);                           // 松手 → 回 1×
  assert.equal(p.currentSec(), 40, "松手后必须停在快进到的位置");
});
