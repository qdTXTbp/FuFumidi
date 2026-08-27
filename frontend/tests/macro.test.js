import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MACRO_DOC,
  macroToCmd,
  parseMacroScript,
  applyMacroLine,
  applyMacroScript,
} from '../src/core/macro.js';

function makeSong(notes = [], tpb = 480) {
  return {
    tpb,
    tracks: [{ notes: notes.map(n => ({ ...n })) }, { notes: [] }],
  };
}

test('parseMacroScript splits newlines and semicolons', () => {
  assert.deepEqual(
    parseMacroScript('transpose 12\nquantize 8; normalize  ;vel_inc 2'),
    ['transpose 12', 'quantize 8', 'normalize', 'vel_inc 2'],
  );
});

test('macroToCmd maps built-in macro names', () => {
  assert.equal(macroToCmd('clean'), 'clean');
  assert.equal(macroToCmd('transpose_up'), 'transpose 12');
  assert.equal(macroToCmd('normalize_vel'), 'normalize');
  assert.equal(macroToCmd('custom'), 'custom');
});

test('clean removes velocity 0 and quantizes remaining notes', () => {
  const song = makeSong([
    { start: 10, end: 490, midi: 60, vel: 100 },
    { start: 100, end: 600, midi: 62, vel: 0 },
    { start: 240, end: 800, midi: 64, vel: 90 },
  ], 480);
  const result = applyMacroScript(song, 'clean');
  assert.equal(result.changed, 3); // 1 deleted + 2 quantized
  assert.equal(song.tracks[0].notes.length, 2);
  assert.equal(song.tracks[0].notes[0].start, 0);
  assert.equal(song.tracks[0].notes[0].end, 480);
  assert.equal(song.tracks[0].notes[1].start, 480);
  assert.equal(song.tracks[0].notes[1].end, 1040);
});

test('transpose adjusts midi and clamps to 0..127', () => {
  const song = makeSong([
    { start: 0, end: 480, midi: 60, vel: 100 },
    { start: 0, end: 480, midi: 120, vel: 90 },
  ]);
  const result = applyMacroScript(song, 'transpose 12');
  assert.equal(result.changed, 2);
  assert.equal(song.tracks[0].notes[0].midi, 72);
  assert.equal(song.tracks[0].notes[1].midi, 127);
});

test('transpose accepts negative argument', () => {
  const song = makeSong([{ start: 0, end: 480, midi: 10, vel: 100 }]);
  applyMacroScript(song, 'transpose -12');
  assert.equal(song.tracks[0].notes[0].midi, 0);
});

test('quantize snaps start and keeps duration', () => {
  const song = makeSong([
    { start: 300, end: 780, midi: 60, vel: 100 },
  ], 480);
  applyMacroScript(song, 'quantize 8');
  const n = song.tracks[0].notes[0];
  assert.equal(n.start, 240); // grid = 240 ticks
  assert.equal(n.end, 720); // duration preserved
});

test('normalize maps selection to 80..127', () => {
  const song = makeSong([
    { start: 0, end: 480, midi: 60, vel: 40 },
    { start: 0, end: 480, midi: 62, vel: 100 },
  ]);
  const selection = [song.tracks[0].notes[0]];
  const result = applyMacroScript(song, 'normalize', { selection });
  assert.equal(result.changed, 1);
  assert.equal(selection[0].vel, 80);
  assert.equal(song.tracks[0].notes[1].vel, 100);
});

test('normalize without selection processes all notes', () => {
  const song = makeSong([
    { start: 0, end: 480, midi: 60, vel: 40 },
    { start: 0, end: 480, midi: 62, vel: 100 },
  ]);
  applyMacroScript(song, 'normalize');
  assert.equal(song.tracks[0].notes[0].vel, 80);
  assert.equal(song.tracks[0].notes[1].vel, 127);
});

test('vel_inc/vel_dec/vel_fix clamp to 1..127', () => {
  const song = makeSong([
    { start: 0, end: 480, midi: 60, vel: 120 },
    { start: 0, end: 480, midi: 62, vel: 5 },
  ]);
  applyMacroScript(song, 'vel_inc 20\nvel_dec 30\nvel_fix 64');
  assert.equal(song.tracks[0].notes[0].vel, 64);
  assert.equal(song.tracks[0].notes[1].vel, 64);
});

test('unknown command reports zero changes and leaves song unchanged', () => {
  const song = makeSong([{ start: 0, end: 480, midi: 60, vel: 100 }]);
  const before = JSON.stringify(song);
  const result = applyMacroScript(song, 'bogus 999');
  assert.equal(result.changed, 0);
  assert.equal(JSON.stringify(song), before);
});

test('MACRO_DOC contains the supported command set', () => {
  const cmds = MACRO_DOC.map(d => d.cmd.split(' ')[0]);
  for (const expected of ['transpose', 'quantize', 'normalize', 'vel_inc', 'vel_dec', 'vel_fix', 'clean']) {
    assert.ok(cmds.includes(expected), `missing ${expected}`);
  }
});

test('applyMacroLine returns op and parsed arg', () => {
  const song = makeSong([{ start: 0, end: 480, midi: 60, vel: 100 }]);
  const result = applyMacroLine(song, 'transpose -5');
  assert.equal(result.op, 'transpose');
  assert.equal(result.arg, -5);
  assert.equal(result.changed, 1);
});