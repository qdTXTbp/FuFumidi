// 播放速度（倍速）与时间刻度的量纲契约回归护栏。
//
// 背景：setScale 曾经把界面传进来的「速度倍率」直接当内部倍率用，而内部的 scale 定义是
// 「墙上时间 / 歌曲时间」，两者互为倒数 —— 结果界面按「加速」实际把曲子放慢，BPM 填 240
// 得到一半速度；currentSec 又多乘了一次 scale，于是倍速下播放时间文本翻倍、曲尾淡出失效。
// 这里把三条契约钉死：setScale 收速度倍率、currentSec 是歌曲时间、seekSec 用歌曲秒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/core/player.js';

// 假曲目用线性映射（1 秒 = 1000 tick），期望值可以直接手算
function fakePlayer({ now = 100, startSec = 100, startTick = 0, playing = false } = {}) {
  const secToTick = (s) => s * 1000;
  const baseSec = (tk) => tk / 1000;
  return {
    ctx: { currentTime: now },
    startSec, startTick, playing, pausedTick: startTick,
    song: { secToTick, baseSec, totalSec: 100, totalTicks: 100000, tpb: 480 },
    seeked: null,
    _restartAt() {},                       // setScale 在播放中会重排调度，这里只验证换算
    seekTick(t) { this.seeked = t; },
    currentTick: Player.prototype.currentTick,
    currentSec: Player.prototype.currentSec,
    progress: Player.prototype.progress,
    setScale: Player.prototype.setScale,
    seekSec: Player.prototype.seekSec,
  };
}

test('setScale 收「速度倍率」，内部换算成倒数（1 = 原速）', () => {
  const p = fakePlayer();
  p.setScale(1);
  assert.equal(p.scale, 1);
  p.setScale(2);                          // 快一倍 → 墙上时间/歌曲时间 = 0.5
  assert.equal(p.scale, 0.5);
  p.setScale(0.5);                        // 慢一半 → 2
  assert.equal(p.scale, 2);
  p.setScale(4);
  assert.equal(p.scale, 0.25);
});

test('setScale 对非法值兜底为原速，不会把整首歌打成静默或除零', () => {
  const p = fakePlayer();
  p.setScale(0);
  assert.equal(p.scale, 1);
  p.setScale(-3);
  assert.equal(p.scale, 1);
  p.setScale(undefined);
  assert.equal(p.scale, 1);
});

test('速度倍率 2 时，墙上 1 秒推进 2 秒歌曲时间（方向不能反）', () => {
  const p = fakePlayer({ playing: true, startSec: 100 });
  p.setScale(2);
  p.ctx.currentTime = 101;                // 墙上过去 1 秒
  assert.equal(p.currentTick(), 2000, '应推进 2 秒歌曲时间，而不是 0.5 秒');
  assert.equal(p.currentSec(), 2);
});

test('速度倍率 0.5 时，墙上 1 秒推进 0.5 秒歌曲时间', () => {
  const p = fakePlayer({ playing: true, startSec: 100 });
  p.setScale(0.5);
  p.ctx.currentTime = 101;
  assert.equal(p.currentTick(), 500);
  assert.equal(p.currentSec(), 0.5);
});

test('currentSec 是歌曲时间轴刻度，不随倍速伸缩（与 totalSec 同量纲）', () => {
  const at1x = fakePlayer({ playing: true, startSec: 100, now: 103 });
  at1x.setScale(1);
  assert.equal(at1x.currentSec(), 3);

  const at4x = fakePlayer({ playing: true, startSec: 100, now: 103 });
  at4x.setScale(4);                       // 墙上过了 3 秒 → 歌曲位置 12 秒
  // 修复前这里会再乘一次内部倍率（0.25）得到 3，于是「播放时间」显示成实际位置的 1/4；
  // 曲尾淡出拿 totalSec - currentSec 判断也会因此错位。
  assert.equal(at4x.currentSec(), 12, 'currentSec 必须是歌曲位置本身');

  const atHalf = fakePlayer({ playing: true, startSec: 100, now: 103 });
  atHalf.setScale(0.5);                   // 慢一半 → 歌曲位置 1.5 秒
  assert.equal(atHalf.currentSec(), 1.5);
});

test('progress 同样与倍速无关（歌曲位置 / 歌曲总长）', () => {
  const p = fakePlayer({ playing: true, startSec: 100, now: 125 });
  p.setScale(4);                          // 歌曲位置 100 秒 → 正好到头
  p.song.totalSec = 100;
  assert.equal(p.progress(), 1);
});

test('seekSec 用歌曲秒，不受当前倍速影响', () => {
  const p = fakePlayer();
  p.setScale(4);
  p.seekSec(60);
  assert.equal(p.seeked, 60000, 'seekSec(60) 应落到歌曲第 60 秒，而不是 15 秒');
  p.setScale(0.25);
  p.seekSec(60);
  assert.equal(p.seeked, 60000);
});
