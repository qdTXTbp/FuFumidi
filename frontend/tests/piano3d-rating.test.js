import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSong } from '../src/core/piano3d/rating.js';

function song(notes, bpm = 120) {
  return { tpb: 480, initialBpm: bpm, baseSec: t => t / 480, tracks: [{ notes }] };
}
const n = (start, end, pitch) => ({ start, end, pitch });

test('MIDI 难度：空曲', () => {
  assert.equal(analyzeSong(song([])).level, 0);
});
test('MIDI 难度：简单儿歌低于密集曲', () => {
  const easy = analyzeSong(song([n(0,480,60),n(480,960,62),n(960,1440,64)], 90));
  const hardNotes = [];
  for (let i = 0; i < 120; i++) hardNotes.push(n(i*120, i*120+100, 48 + (i % 24)), n(i*120, i*120+100, 60 + (i % 12)));
  const hard = analyzeSong(song(hardNotes, 168));
  assert.ok(easy.level >= 1 && easy.level < hard.level, JSON.stringify({ easy, hard }));
  assert.ok(hard.level >= 6);
  assert.ok(hard.metrics.nps > easy.metrics.nps);
});
test('MIDI 难度：复音与音域提高等级', () => {
  const single = analyzeSong(song([n(0,480,60), n(480,960,62)], 120));
  const chord = analyzeSong(song([n(0,960,36),n(0,960,48),n(0,960,60),n(960,1920,84)], 120));
  assert.ok(chord.level >= single.level);
  assert.ok(chord.metrics.span > single.metrics.span);
});
