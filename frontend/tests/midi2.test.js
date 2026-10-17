// P2-3 MIDI 2.0 UMP / MPE / MIDI Clock 纯逻辑测试
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  UMP_MT_MIDI1, UMP_MT_MIDI2, umpFromMidi1, umpToMidi1, umpFromMidi2, umpToMidi2,
  velocity16To7, velocity7To16,
  createMpeState, mpeNoteOn, mpeNoteOff, mpePitchBend, mpeTimbre, mpePressure,
  mpeActiveNotes, mpeFreeChannels, mpeAllocChannel,
  createMidiClock, clockSchedule, clockJitter, PPQN,
} from '../src/core/midi2.js';

test('P2-3 UMP MT2：MIDI 1.0 通道消息编解码往返', () => {
  const w = umpFromMidi1({ group: 2, status: 0x90, channel: 5, data1: 60, data2: 100 });
  assert.equal((w >>> 28) & 0x0f, UMP_MT_MIDI1);
  const m = umpToMidi1(w);
  assert.deepEqual(m, { group: 2, status: 0x90, channel: 5, data1: 60, data2: 100 });
  assert.equal(umpToMidi1(0x40000000), null, '非 MT2 返回 null');
});

test('P2-3 UMP MT4：Note On 16-bit 力度往返', () => {
  const [w0, w1] = umpFromMidi2({ group: 1, status: 0x90, channel: 3, note: 64, value16: 0xffff });
  assert.equal((w0 >>> 28) & 0x0f, UMP_MT_MIDI2);
  const m = umpToMidi2(w0, w1);
  assert.equal(m.group, 1);
  assert.equal(m.status, 0x90);
  assert.equal(m.channel, 3);
  assert.equal(m.index, 64);
  assert.equal(m.value16, 0xffff);
});

test('P2-3 UMP MT4：逐音弯音 32-bit 有符号往返', () => {
  const [w0, w1] = umpFromMidi2({ status: 0x60, channel: 2, note: 60, value32: -123456 });
  const m = umpToMidi2(w0, w1);
  assert.equal(m.status, 0x60);
  assert.equal(m.value32, -123456);
  assert.equal(umpToMidi2(0x20000000, 0), null);
});

test('P2-3 力度 7bit ↔ 16bit 换算', () => {
  assert.equal(velocity7To16(127), 65535);
  assert.equal(velocity7To16(0), 0);
  assert.equal(velocity16To7(65535), 127);
  assert.equal(velocity16To7(0), 0);
  assert.equal(velocity16To7(velocity7To16(64)), 64);
});

test('P2-3 MPE lower zone：master=0、member 1..15；一音一通道', () => {
  const st = createMpeState();
  assert.equal(st.masterChannel, 0);
  const a = mpeNoteOn(st, 60, 100);
  const b = mpeNoteOn(st, 64, 90);
  assert.ok(a.channel >= 1 && a.channel <= 15, 'member 通道 1..15，实际 ' + a.channel);
  assert.notEqual(a.channel, b.channel);
  assert.ok(![0].includes(a.channel), '不能占用 master 通道');
  assert.deepEqual(mpeActiveNotes(st).map((x) => x.note).sort((x, y) => x - y), [60, 64]);
});

test('P2-3 MPE：音符释放后通道回收；同音重按先释放旧通道', () => {
  const st = createMpeState();
  const a = mpeNoteOn(st, 60);
  const b = mpeNoteOn(st, 60);
  assert.ok(b && b.channel >= 1 && b.channel <= 15, '同音重按仍拿到合法 member 通道');
  assert.equal(mpeActiveNotes(st).length, 1);
  const off = mpeNoteOff(st, 60);
  assert.equal(off.channel, b.channel);
  assert.equal(mpeFreeChannels(st).length, 15);
  assert.equal(mpeNoteOff(st, 60), null, '重复释放返回 null');
});

test('P2-3 MPE：逐音弯音/音色/压力只作用于该音自己的 member 通道', () => {
  const st = createMpeState();
  const a = mpeNoteOn(st, 60);
  const b = mpeNoteOn(st, 64);
  const pb = mpePitchBend(st, 60, 24, 48);   // +24 半音 = 半量程
  assert.equal(pb.channel, a.channel);
  assert.equal(pb.value14, 12288);
  assert.equal(mpePitchBend(st, 64, -48, 48).value14, 0);
  assert.equal(mpeTimbre(st, 60, 100).channel, a.channel);
  assert.equal(mpePressure(st, 64, 55).channel, b.channel);
  assert.equal(mpePitchBend(st, 99, 0), null, '没按下的音不产生表情');
});

test('P2-3 MPE upper zone：master=15、member 从低端起分配', () => {
  const st = createMpeState({ zone: 'upper', members: 4 });
  assert.equal(st.masterChannel, 15);
  const a = mpeNoteOn(st, 60);
  assert.ok(a.channel >= 11 && a.channel <= 14, 'upper zone member 11..14，实际 ' + a.channel);
});

test('P2-3 MPE：通道耗尽返回 null', () => {
  const st = createMpeState({ members: 2 });
  mpeNoteOn(st, 60); mpeNoteOn(st, 61);
  assert.equal(mpeNoteOn(st, 62), null);
  assert.equal(mpeAllocChannel(st), -1);
});

test('P2-3 MIDI Clock：120BPM 下 1 秒 = 48 脉冲（24 PPQN）', () => {
  const clk = createMidiClock({ bpm: 120 });
  assert.equal(PPQN, 24);
  clk.start(0);
  assert.equal(clk.advance(0.5), 24);
  assert.equal(clk.advance(1.0), 24);
  assert.equal(clk.state().pulses, 48);
  assert.equal(clk.positionBeats(), 2);
});

test('P2-3 MIDI Clock：60BPM → 24 脉冲/秒；setBpm 只影响之后', () => {
  const clk = createMidiClock({ bpm: 60 });
  clk.start(0);
  assert.equal(clk.advance(1.0), 24);
  clk.setBpm(120);
  assert.equal(clk.advance(2.0), 48);
  assert.equal(clk.state().pulses, 72);
});

test('P2-3 MIDI Clock：停止不发脉冲；抖动累积不丢拍', () => {
  const clk = createMidiClock({ bpm: 120 });
  clk.start(0);
  let total = 0;
  for (let i = 1; i <= 100; i++) total += clk.advance(i * 0.01);   // 1 秒，100 次小步进
  assert.equal(total, 48, '小步进不应丢脉冲（相位累计）');
  clk.stop();
  assert.equal(clk.advance(5.0), 0);
  assert.equal(clk.spp().beats, 2, 'Song Position = 2 拍');
});

test('P2-3 时钟时间表与抖动统计', () => {
  const s = clockSchedule({ bpm: 120, seconds: 1 });
  assert.equal(s.length, 48);
  assert.ok(Math.abs(s[1] - s[0] - 60 / 120 / 24) < 1e-6, '间隔=20.833ms（时间表保留 6 位小数）');
  const j = clockJitter([0, 0.0208333, 0.0416666, 0.0625]);
  assert.equal(j.count, 4);
  assert.ok(j.meanMs > 20 && j.meanMs < 21);
  assert.deepEqual(clockJitter([]), { count: 0, meanMs: 0, p95Ms: 0, maxMs: 0 });
});
