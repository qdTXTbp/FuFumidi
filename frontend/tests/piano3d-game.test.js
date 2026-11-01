import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, WINDOWS } from '../src/core/piano3d/game.js';

function songWith(notes) {
  return {
    baseSec: (tick) => tick / 480,
    tracks: [{ name: 'piano', notes }],
  };
}

test('3D 钢琴判定：不同窗口分数与 combo', () => {
  const g = createGame(songWith([
    { start: 480, end: 960, pitch: 60 },
    { start: 960, end: 1440, pitch: 62 },
  ]));
  let r = g.input(60, 1.0 + 0.01);
  assert.equal(r.grade, 'perfect');
  assert.equal(g.stats().combo, 1);
  r = g.input(62, 2.0 + 0.07);
  assert.equal(r.grade, 'good');
  assert.equal(g.stats().combo, 2);
});

test('3D 钢琴判定：超出窗口算 Miss，过时自动 Miss', () => {
  const g = createGame(songWith([{ start: 480, end: 960, pitch: 60 }]));
  const r = g.input(60, 1.0 + WINDOWS.miss + 0.01);
  assert.equal(r.grade, 'miss');
  g.tick(3.0);
  assert.equal(g.stats().miss, 1);
});

test('3D 钢琴判定：reset 清空', () => {
  const g = createGame(songWith([{ start: 480, end: 960, pitch: 60 }]));
  g.input(60, 1.0);
  g.reset();
  const s = g.stats();
  assert.equal(s.combo, 0);
  assert.equal(s.score, 0);
  assert.equal(s.judged, 0);
});
