// 节拍器可取消性的回归护栏。
//
// 背景：节拍器会在整个预排窗口内一次把所有拍点排好（SF2 音序器路径下窗口可达 30s），
// 而 metroClick 创建的振荡器此前没有任何登记。于是 setMetronome(false) 只翻了标志位，
// 已经排好的点击声仍按原时间轴继续响 —— 表现为「关掉节拍器后还在哒哒哒，最多约 30 秒」，
// 暂停同理。这里把「关闭 / 暂停 / 跳转 时都能整体取消」钉死。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/core/player.js';

function fakePlayer() {
  const stopped = [];
  return {
    ctx: { currentTime: 100 },
    song: { tpb: 480, totalTicks: 100000, sigMap: [{ num: 4 }], baseSec: (tk) => tk / 1000, secToTick: (s) => s * 1000 },
    startSec: 100, startTick: 0, scale: 1, playing: true, pausedTick: 0,
    metro: true, metroBeat: 0,
    _timer: null, _aheadTimer: null, AHEAD_BASE: 1,
    syn: { allStop() {} },
    _metroNodes: [
      { o: { stop() { stopped.push('t100.5'); } }, end: 100.5 },
      { o: { stop() { stopped.push('t130'); } }, end: 130 },
    ],
    stopped,
    _clearMetro: Player.prototype._clearMetro,
    setMetronome: Player.prototype.setMetronome,
    pause: Player.prototype.pause,
    currentTick: Player.prototype.currentTick,
  };
}

test('_clearMetro 停掉所有已排队的点击声并清空登记表', () => {
  const p = fakePlayer();
  p._clearMetro();
  assert.deepEqual(p.stopped, ['t100.5', 't130'], '两个已排队的点击声都应被 stop');
  assert.equal(p._metroNodes.length, 0);
});

test('登记表为空时 _clearMetro 是空操作（不抛异常）', () => {
  const p = fakePlayer();
  p._metroNodes = [];
  p._clearMetro();
  assert.deepEqual(p.stopped, []);
});

test('关闭节拍器会取消已经排好的点击声（本次修复的核心）', () => {
  const p = fakePlayer();
  p.setMetronome(false);
  assert.equal(p.metro, false);
  assert.deepEqual(p.stopped, ['t100.5', 't130'], '关掉后不得再有已排队的点击声');
  assert.equal(p._metroNodes.length, 0);
});

test('重新打开节拍器同样先取消旧的，避免两套点击声叠加', () => {
  const p = fakePlayer();
  p.metro = false;
  p.setMetronome(true);
  assert.equal(p.metro, true);
  assert.deepEqual(p.stopped, ['t100.5', 't130']);
});

test('暂停会取消已经排好的点击声', () => {
  const p = fakePlayer();
  p.pause();
  assert.equal(p.playing, false);
  assert.deepEqual(p.stopped, ['t100.5', 't130'], '暂停后不得再有点击声继续响');
});
