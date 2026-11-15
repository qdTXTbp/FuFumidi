// V0.3 基线探针（2026-11-15）：把「旧审计说未做 / README 说已修」的四条争议项钉死。
//
// 背景：docs/audit/2026-10-29/midi-workflow.md 与 docs/plans/2026-10-30-completion-matrix.md
// 评估的是 6.3.1 之前的本机安装版，其中 F-05 / F-06 / F-07 记为「未做」；而 README 6.3.1
// 与当前代码声称已修。本文件不判断好坏，只提供**可复现的当前行为断言**：
//   - 断言通过 = 该能力在当前代码里有可验证的实现路径；
//   - 断言「缺口仍存在」= 该能力确实还没做，测试作为证据留档。
// 每次相关实现变动后跑一次，口径就不会再飘。运行：node --test frontend/tests/baseline-probe.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { Player } from '../src/core/player.js';
import { Synth } from '../src/core/synth.js';
import { songToAbc } from '../src/core/score.js';
import { createArrangeState, setTrackFlags } from '../src/core/arrange.js';

/* ------------------------------------------------------------ F-05 编排片段参与播放 */

function probeSong(arrange) {
  return {
    tpb: 480,
    totalTicks: 3840,
    baseSec: (t) => t / 960,
    tracks: [{
      index: 0, name: '钢琴', ch: 0, program: 0,
      notes: [
        { start: 0, end: 480, midi: 60, vel: 100 },
        { start: 960, end: 1440, midi: 62, vel: 100 },
        { start: 2000, end: 2480, midi: 64, vel: 100 },
      ],
    }],
    ...(arrange ? { arrange } : {}),
  };
}

function arrangeWith(clip) {
  return createArrangeState({
    tracks: [{ id: 't0', name: '钢琴' }],
    clips: [{ id: 'c1', trackId: 't0', startTick: 0, endTick: 3840, offsetTick: 0, ...clip }],
  });
}

function eventsOf(song) {
  const p = new Player({ ctx: {}, midiEvent() {}, applyRouting() {} });
  p.load(song);
  return p.events;
}

test('[F-05-a] 无 arrange 时播放器读全部音轨音符（旧路径仍在）', () => {
  assert.deepEqual(eventsOf(probeSong()).map((e) => e.start), [0, 960, 2000]);
});

test('[F-05-b] 移动 clip 后播放事件跟着移位，且只保留 clip 覆盖的源区间', () => {
  const ev = eventsOf(probeSong(arrangeWith({ startTick: 1920, endTick: 2880, offsetTick: 0 })));
  assert.equal(ev.length, 1, 'clip 长 960tick，只取源区间 [0,960) 内的 1 个音');
  assert.equal(ev[0].start, 1920, '音符被放到 clip 的 startTick');
  assert.equal(ev[0].midi, 60);
});

test('[F-05-c] 裁剪 clip 与轨道静音都能改变播放事件', () => {
  const cut = eventsOf(probeSong(arrangeWith({ startTick: 0, endTick: 480, offsetTick: 0 })));
  assert.equal(cut.length, 1, '裁到 480tick 后只剩第一个音');
  const muted = eventsOf(probeSong(setTrackFlags(arrangeWith({}), 't0', { mute: true })));
  assert.equal(muted.length, 0, '编排轨静音后不出声');
});

test('[F-05-d] clip 自身 muted 与 solo 规则生效', () => {
  const clipMuted = eventsOf(probeSong(arrangeWith({ muted: true })));
  assert.equal(clipMuted.length, 0);
  const soloState = createArrangeState({
    tracks: [{ id: 't0', name: '钢琴', solo: false }, { id: 't1', name: '弦乐', solo: true }],
    clips: [{ id: 'c1', trackId: 't0', startTick: 0, endTick: 3840, offsetTick: 0 }],
  });
  assert.equal(eventsOf(probeSong(soloState)).length, 0, '有 solo 轨时非 solo 轨的 clip 不发声');
});

/* ------------------------------------------------------------ F-06 内置音色 CC 通道 */

function fakeSynth() {
  const calls = [];
  return {
    sf2Ready: true,
    sf2: { midiControl() {}, midiPitchBend() {} },
    _fileCc7: {}, _fileCc10: {},
    _applyChannelGain(ch, time) { calls.push(['gain', ch, time]); },
    _applyChannelPan(ch, time) { calls.push(['pan', ch, time]); },
    _sendCcAt(ch, cc, val, time) { calls.push(['cc', ch, cc, val, time]); },
    _sendBendAt(ch, val, time) { calls.push(['bend', ch, val, time]); },
    calls,
  };
}

test('[F-06-a] CC7 / CC10 记为文件基准并叠加到通道混音', () => {
  const s = fakeSynth();
  Synth.prototype.midiEvent.call(s, 0, { kind: 'cc', ch: 2, cc: 7, val: 100 });
  Synth.prototype.midiEvent.call(s, 0, { kind: 'cc', ch: 2, cc: 10, val: 40 });
  assert.equal(s._fileCc7[2], 100);
  assert.equal(s._fileCc10[2], 40);
  assert.ok(s.calls.some((c) => c[0] === 'gain' && c[1] === 2));
  assert.ok(s.calls.some((c) => c[0] === 'pan' && c[1] === 2));
});

test('[F-06-b] CC11 / CC64 与弯音都有下发路径，不再静默丢弃', () => {
  const s = fakeSynth();
  Synth.prototype.midiEvent.call(s, 0, { kind: 'cc', ch: 3, cc: 11, val: 90 });
  Synth.prototype.midiEvent.call(s, 0, { kind: 'cc', ch: 3, cc: 64, val: 127 });
  Synth.prototype.midiEvent.call(s, 0, { kind: 'bend', ch: 3, val: 2048 });
  assert.deepEqual(s.calls.filter((c) => c[0] === 'cc').map((c) => c[2]), [11, 64]);
  assert.deepEqual(s.calls.filter((c) => c[0] === 'bend').map((c) => c[2]), [2048]);
});

test('[F-06-c] 播放器把文件里的 CC / bend 排进 ctlEvents（端到端前半段）', () => {
  const song = probeSong();
  song.tracks[0].ccs = [
    { tick: 0, ch: 0, cc: 11, cv: 90 },
    { tick: 480, ch: 0, cc: 64, cv: 127 },
    { tick: 960, ch: 0, cc: 64, cv: 0 },
  ];
  song.tracks[0].events = [{ type: 'bend', tick: 100, ch: 0, val: 2048 }];
  const p = new Player({ ctx: {}, midiEvent() {}, applyRouting() {} });
  p.load(song);
  assert.deepEqual(p.ctlEvents.map((e) => [e.kind, e.cc == null ? null : e.cc, e.start]),
    [['cc', 11, 0], ['bend', null, 100], ['cc', 64, 480], ['cc', 64, 960]]);
});

/* ------------------------------------------------------------ F-07 跨小节时值 / 连音线 */

test('[F-07] ABC 记谱路径：跨小节长音在第 1 小节产出连音线', () => {
  const song = {
    tpb: 480,
    sigMap: [{ num: 4, den: 4 }],
    tempoMap: [{ us: 500000 }],
    keySig: { sf: 0 },
    tracks: [{ name: '钢琴', notes: [{ start: 0, end: 3840, midi: 64 }] }],
  };
  const abc = songToAbc(song, 0);
  const body = abc.split('\n').filter((l) => !/^[A-Za-z]:/.test(l)).join('\n');
  assert.ok(body.includes('-'), '跨两小节的长音应带 ABC 连音线 "-"');
  assert.ok(body.includes('|'), '应产生至少两个小节的谱面');
  // 边界：本探针只覆盖 core/score.js 的 ABC 路径；MusicXML / Verovio 渲染路径不在此断言内。
});

/* ------------------------------------------------------------ L5 混音粒度（两条路径） */
//
// 旧审计「混音台 per-track/per-channel 未做 / 同通道多轨分不开」把两条播放路径混为一谈了。
// 实际是：内置合成器路径**本来就有每轨独立 GainNode + Panner**；只有 SF2 / 音色库路径
// 因为输出只有一路混合节点，才退回 MIDI 通道级（CC7 / CC10）。此探针把两条路径分别钉死。

function fakeTrackSynth() {
  const ctx = {
    currentTime: 0,
    createGain() {
      const g = { gain: { value: 1, setTargetAtTime(v) { g.gain.value = v; } }, connect() {} };
      return g;
    },
    createStereoPanner() { return { pan: { setTargetAtTime() {} }, connect() {} }; },
  };
  const s = Object.create(Synth.prototype);
  Object.assign(s, {
    ctx, master: { connect() {} },
    trackGains: [], panners: [], vol: [], pan: [], mute: [], solo: [],
  });
  return s;
}

test('[L5-a] 内置合成器路径：每轨独立增益，调第 1 轨不影响第 0 轨', () => {
  const s = fakeTrackSynth();
  Synth.prototype.setTrackVol.call(s, 1, 0.3);
  assert.equal(s.trackGains.length, 2, 'ensure() 为两轨各建一个 GainNode');
  assert.equal(s.trackGains[1].gain.value, 0.3);
  assert.equal(s.trackGains[0].gain.value, 1, '同通道的另一条轨不受影响');
});

test('[L5-b] 内置合成器路径：mute / solo / pan 也都有轨道级入口', () => {
  const names = Object.getOwnPropertyNames(Synth.prototype);
  for (const k of ['setTrackVol', 'setTrackMute', 'setTrackSolo', 'setTrackPan']) {
    assert.ok(names.includes(k), '缺轨道级 API：' + k);
  }
  const s = fakeTrackSynth();
  Synth.prototype.setTrackMute.call(s, 1, true);
  assert.equal(s.trackGains[1].gain.value, 0, 'mute 把该轨增益拉到 0');
  assert.equal(s.trackGains[0].gain.value, 1);
});

test('[L5-c] SF2 / 音色库路径：混音仍是 MIDI 通道级 —— 这一侧才是缺口', () => {
  assert.match(Synth.prototype.setChannelVol.toString(), /setChannelVol\(ch/, '音量接口第一参数是 MIDI 通道');
  const stub = { chVol: {}, _applyChannelGain(ch) { this.lastCh = ch; } };
  Synth.prototype.setChannelVol.call(stub, 5, 0.5);
  assert.equal(stub.chVol[5], 0.5);
  assert.equal(stub.lastCh, 5, '改动落在整个通道上，同通道其它轨会一起变');
});
