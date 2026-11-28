// 「播放时卡在一个音色上很久」的回归测试（2026-11-28）。
//
// 三个独立缺陷都会造成同一听感，这里逐一钉住：
//   ① 切音色库（Bank Select, CC0）后没有重发 Program Change。
//      MIDI 规范里 bank 只在**下一个** program change 生效，而缓存只比较 prog 数值，
//      于是 bank 变了但 prog 没变时 PC 被吞掉 —— 通道一直用旧库的音色，直到出现别的 prog。
//   ② 通道类型（旋律 / 鼓组）是单向的：midiSetChannelType(ch, true) 之后不会自己变回。
//      合成器实例跨曲目复用，上一首在 ch N 打过鼓，下一首该通道的旋律音符仍用鼓组音色。
//   ③ 音符试听（preview）直接改 ch0 的 program，绕过了「已下发状态」缓存；
//      下次播放时若 prog 与缓存相同就不重发 PC，整条通道沿用试听的音色。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Synth, resolveSf2Bank } from '../src/core/synth.js';

function makeSeqSynth() {
  const s = Object.create(Synth.prototype);
  s.ctx = { currentTime: 0 };
  s.sf2Seq = { sent: [], sendEventAt(ev, tick) { this.sent.push({ ev, tick }); } };
  // bank0/prog5 与 bank1/prog5 都存在 → resolveSf2Bank 会真的选中 bank 1
  s._sf2Presets = new Set([5, 128 + 5]);
  s._sf2ChProg = [];
  s._sf2ChBank = [];
  s._sf2ChProgOverride = {};
  s._sf2DrumCh = [];
  return s;
}

const dump = (s) => s.sf2Seq.sent.map((x) => (x.ev.type === 'controlchange' ? `cc${x.ev.control}=${x.ev.value}` : `pc${x.ev.preset}`));

test('切库后即使 program 号没变，也必须重发 programchange', () => {
  const s = makeSeqSynth();
  s._seqApplyProgram(0, { ch: 0, bank: 0, prog: 5 }, 1000);
  s._seqApplyProgram(0, { ch: 0, bank: 1, prog: 5 }, 2000);
  assert.deepEqual(dump(s), ['cc0=0', 'pc5', 'cc0=1', 'pc5']);
});

test('同一库内 prog 没变时不重复下发（缓存仍然有效）', () => {
  const s = makeSeqSynth();
  s._seqApplyProgram(0, { ch: 0, bank: 1, prog: 5 }, 1000);
  s._seqApplyProgram(0, { ch: 0, bank: 1, prog: 5 }, 2000);
  s._seqApplyProgram(0, { ch: 0, bank: 1, prog: 5 }, 3000);
  assert.deepEqual(dump(s), ['cc0=1', 'pc5']);
});

test('通道类型双向同步：鼓 → 旋律必须显式恢复', () => {
  const s = Object.create(Synth.prototype);
  const calls = [];
  s.sf2 = { midiSetChannelType(ch, isDrum) { calls.push([ch, isDrum]); } };
  s._sf2DrumCh = [];
  s._ensureChannelType(9, true);
  s._ensureChannelType(9, false);
  assert.deepEqual(calls, [[9, true], [9, false]], '设鼓之后必须能回到旋律');
  s._ensureChannelType(0, false);
  assert.equal(calls.length, 2, '默认就是旋律通道，不该产生多余调用');
});

test('试听作废 ch0 的已下发缓存，播放时会重新下发音色', () => {
  const s = Object.create(Synth.prototype);
  s.ctx = { currentTime: 0 };
  s.ensure = () => {};
  s._trimActive = () => {};
  s.sf2Ready = true;
  const calls = [];
  s.sf2 = {
    midiProgramChange(ch, p) { calls.push(['pc', ch, p]); },
    midiNoteOn(ch, midi) { calls.push(['on', ch, midi]); },
    midiNoteOff() {},
  };
  s._sf2ChProg = [0];
  s._sf2ChBank = [0];
  s.activeNotes = [];
  s.preview(60, 24, 100, 0.2);
  assert.deepEqual(calls.slice(0, 2), [['pc', 0, 24], ['on', 0, 60]]);
  assert.equal(s._sf2ChProg[0], undefined, '试听改过 ch0 的 program，缓存必须作废');
  assert.equal(s._sf2ChBank[0], undefined);
});

test('音色库里没有该 program 时退回 0 号钢琴（否则 FluidSynth 沿用上一个音色）', () => {
  const presets = new Set([0, 40]);              // 只收了钢琴和弦乐
  assert.deepEqual(resolveSf2Bank(presets, 0, 40), { bank: 0, prog: 40 });
  assert.deepEqual(resolveSf2Bank(presets, 0, 73), { bank: 0, prog: 0 }, '缺失的 prog 必须有人接');
  assert.deepEqual(resolveSf2Bank(presets, 0, 999), { bank: 0, prog: 0 }, '越界 prog 先钳制再判断');
  // 清单没解析出来时不做猜测（原行为）
  assert.deepEqual(resolveSf2Bank(null, 0, 73), { bank: 0, prog: 73 });
});
