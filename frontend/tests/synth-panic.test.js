// 暂停 / 停止 / 跳转时的「卡音」回归测试（2026-10 实测缺陷）。
//
// 缺陷：音序器路径把音符按 duration 交给音频线程调度，note-off 就住在那个待发队列里；
// allStop() 用 removeAllEventsFromClient() 清队列时把 note-off 一起清掉了，
// 而补发 note-off 的那句只走直连句柄 this.sf2（音序器路径下为空），
// 于是正在响的音符永远收不到 note-off —— 表现就是「暂停了还在一直出声」。
//
// 这里用替身对象验证修复后的不变量：清完队列必须立刻全通道 panic（CC120 + CC123），
// 且音序器路径与直连回退路径都要发；panic 的 tick 取「现在」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { Synth } from '../src/core/synth.js';

function makeSynth({ withSeq = true, withDirect = false } = {}) {
  const s = Object.create(Synth.prototype);
  s.ctx = { currentTime: 10 };
  s._seqAnchor = { ctx: 0, seq: 0 };          // _seqTickFor: tick = (t - 0) * 1000
  s._sf2SeqMode = withSeq;
  s._sf2SeqClient = withSeq ? 42 : null;
  const sent = [];
  s.sf2Seq = withSeq ? {
    sent,
    removed: 0,
    getTick: async () => 0,
    sendEventAt(ev, tick) { sent.push({ ev, tick }); },
    removeAllEventsFromClient() { this.removed++; },
  } : null;
  const direct = [];
  s.sf2 = withDirect ? {
    direct,
    midiControl(ch, cc, v) { direct.push(['cc', ch, cc, v]); },
    midiNoteOff(ch, midi) { direct.push(['off', ch, midi]); },
  } : null;
  s.live = [];
  s._sf2Pending = [];
  s.activeNotes = [{ midi: 60, ch: 3, sf2: true, start: 0, endTime: 99 }];
  s._sf2ChProg = [];
  s._sf2ChBank = [];
  s._sf2DrumCh = [];
  s._trimThreshold = 0;
  return s;
}

test('allStop 清掉音序器队列后必须全通道 panic（CC120 + CC123）', () => {
  const s = makeSynth({ withSeq: true });
  s.allStop();
  assert.equal(s.sf2Seq.removed, 1, '必须先清掉未分发的调度事件');
  const ccs = s.sf2Seq.sent.filter((x) => x.ev.type === 'controlchange');
  for (const cc of [120, 123]) {
    for (let ch = 0; ch < 16; ch++) {
      assert.ok(ccs.some((x) => x.ev.control === cc && x.ev.channel === ch), `缺 CC${cc} ch${ch}`);
    }
  }
  assert.equal(s.sf2Seq.sent.length, 32, '除 panic 外不该多发事件');
});

test('直连回退路径同样要 panic（它的 note-off 在主线程定时器里，可能已被清掉）', () => {
  const s = makeSynth({ withSeq: false, withDirect: true });
  s.allStop();
  const ccs = s.sf2.direct.filter((x) => x[0] === 'cc' && (x[2] === 120 || x[2] === 123));
  assert.equal(ccs.length, 32, '16 通道 × (CC120 + CC123)');
  assert.ok(s.sf2.direct.some((x) => x[0] === 'off' && x[1] === 3 && x[2] === 60), '逐个音符的 note-off 仍要照发');
});

test('panic 排在清理之后，且用「现在」的 tick', () => {
  const s = makeSynth({ withSeq: true });
  s.ctx.currentTime = 1.25;
  s.allStop();
  assert.equal(s.sf2Seq.sent[0].tick, 1250, 'tick 必须是当前时刻（锚点漂移不能把 panic 排到过去）');
});
