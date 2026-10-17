import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNoteMessage, parseControlMessage } from '../src/core/midiin.js';
import { createRecorder } from '../src/core/recorder.js';

test('P0-3 midiin 解析 Note On/Off（含 Note On vel=0 这种常见编码）', () => {
  assert.equal(parseNoteMessage([0x90, 60, 100]), 'on');
  assert.equal(parseNoteMessage([0x90, 60, 0]), 'off');
  assert.equal(parseNoteMessage([0x80, 60, 64]), 'off');
  assert.equal(parseNoteMessage([0x91, 64, 80]), 'on');
  assert.equal(parseNoteMessage([0xb0, 64, 127]), null);
  assert.equal(parseNoteMessage([0x90]), null);
  assert.equal(parseNoteMessage(null), null);
});

test('P0-3 midiin 解析 CC（0xB0，含通道）', () => {
  assert.deepEqual(parseControlMessage([0xb0, 64, 127]), { cc: 64, val: 127, ch: 0 });
  assert.deepEqual(parseControlMessage([0xb3, 1, 64]), { cc: 1, val: 64, ch: 3 });
  assert.equal(parseControlMessage([0x90, 60, 100]), null);
  assert.equal(parseControlMessage([0xb0, 64]), null);
  assert.equal(parseControlMessage(null), null);
});

test('P0-3 假 MIDI 事件流：256 拍内不丢事件（midiin 解析 → recorder）', () => {
  const beats = 256;
  const tpb = 480;
  const msPerBeat = 500;   // 120 BPM
  const r = createRecorder({ tpb, bpm: 120, preRollBars: 0, quantize: 'off' });
  r.start({ atMs: 0, startTick: 0, loopStartTick: 0, loopEndTick: beats * tpb });
  // 每拍一个音，音高循环（相邻同音高至少隔 12 拍，不会重叠）
  for (let i = 0; i < beats; i++) {
    const midi = 60 + (i % 12);
    const onMs = i * msPerBeat + 50;
    const offMs = onMs + 200;
    const onData = [0x90, midi, 90];
    // 每 3 个音用 Note On vel=0 表示 off，覆盖两种编码
    const offData = i % 3 === 0 ? [0x90, midi, 0] : [0x80, midi, 64];
    if (parseNoteMessage(onData) === 'on') r.noteOn(onData[1], onData[2], onMs);
    if (parseNoteMessage(offData) === 'off') r.noteOff(offData[1], offMs);
  }
  const take = r.stop(beats * msPerBeat);
  assert.equal(take.notes.length, beats, '256 个音全部录到');
  assert.equal(take.notes[0].midi, 60);
  assert.equal(take.notes[1].midi, 61);
  // 起点应落在 i 拍 + 50ms 附近（允许 1 tick 取整误差）
  const msTick = 60000 / (120 * tpb);
  for (const i of [0, 1, 100, 255]) {
    const want = Math.round((i * msPerBeat + 50) / msTick);
    const got = take.notes.find((n) => Math.abs(n.start - want) <= 1);
    assert.ok(got, '第 ' + i + ' 拍的音存在且起点正确（期望 ' + want + '）');
  }
});

test('P0-3 假 MIDI 事件流：延音踏板 CC 能被识别但不影响音符数（当前 take 不含 CC）', () => {
  assert.deepEqual(parseControlMessage([0xb0, 64, 127]), { cc: 64, val: 127, ch: 0 });
  assert.deepEqual(parseControlMessage([0xb0, 64, 0]), { cc: 64, val: 0, ch: 0 });
});
