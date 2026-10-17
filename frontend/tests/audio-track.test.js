// P1-11 音频轨最小闭环：采样级对齐（<5ms）、增益/静音、淡入淡出、离线混音
import test from 'node:test';
import assert from 'node:assert/strict';
import { SingTransport, applyFades } from '../src/core/sing_transport.js';

/* ---------------- Web Audio 垫片（无设备） ---------------- */
class FakeGain {
  constructor() { this.gain = { value: 1 }; this.connected = []; }
  connect(dst) { this.connected.push(dst); }
  disconnect() {}
}
class FakeSource {
  constructor() { this.playbackRate = { value: 1 }; this.started = null; this.connected = []; }
  connect(dst) { this.connected.push(dst); }
  disconnect() {}
  start(when, offset, dur) { this.started = { when, offset, dur }; }
  stop() {}
}
class FakeCtx {
  constructor(sr = 8000) { this.currentTime = 10; this.sampleRate = sr; this.destination = { id: 'dest' }; this.gains = []; this.sources = []; }
  createBufferSource() { const s = new FakeSource(); this.sources.push(s); return s; }
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
}
class FakeOfflineCtx extends FakeCtx {
  constructor(ch, length, sr) { super(sr); this.length = length; this.channels = ch; }
  async startRendering() { return { numberOfChannels: this.channels, length: this.length, sampleRate: this.sampleRate, getChannelData: () => new Float32Array(this.length) }; }
}

function buf(durationSec, sampleRate = 8000) {
  return { duration: durationSec, sampleRate, numberOfChannels: 1, length: Math.round(durationSec * sampleRate), getChannelData: () => new Float32Array(Math.round(durationSec * sampleRate)) };
}
function lane(over = {}) {
  return Object.assign({ buf: buf(8), label: 'lane', gainDb: 0, muted: false, skipMs: 0, fx: [], bpm: 120, tempoMap: [], volPoints: [], panPoints: [] }, over);
}

/* ---------------- 对齐 ---------------- */
test('P1-11 伴奏/人声两条源拿到同一个 when（采样级同步，误差 0ms）', () => {
  const ctx = new FakeCtx();
  const tr = new SingTransport(ctx);
  tr.lanes = [lane({ label: '伴奏', skipMs: 0 }), lane({ label: '人声', skipMs: 250 })];
  assert.equal(tr.play(0), true);
  assert.equal(ctx.sources.length, 2);
  const [a, b] = ctx.sources;
  assert.equal(a.started.when, b.started.when, '同一 when（<5ms 要求实际是 0）');
  assert.equal(a.started.offset, 0);
  assert.equal(b.started.offset, 0.25, 'skipMs=250 → 从 0.25s 起播');
  tr.stop();
});

test('P1-11 中途起播时 offset = max(skip, 位置)；已过 skip 后按位置对齐', () => {
  const ctx = new FakeCtx();
  const tr = new SingTransport(ctx);
  tr.lanes = [lane({ skipMs: 5000 }), lane({ skipMs: 1000 })];
  assert.equal(tr.play(4000), true);
  const [a, b] = ctx.sources;
  assert.equal(a.started.offset, 5.0, '位置 4s 还没到 skip 5s → 从 5s 起播');
  assert.equal(b.started.offset, 4.0, '位置 4s 已过 skip 1s → 从 4s 起播');
  assert.equal(a.started.when, b.started.when);
  tr.stop();
});

test('P1-11 durationMs = 各 lane (时长 − skip) 的最大值', () => {
  const tr = new SingTransport(new FakeCtx());
  tr.lanes = [lane({ buf: buf(8), skipMs: 1000 }), lane({ buf: buf(6), skipMs: 0 })];
  assert.equal(tr.durationMs, 7000);
});

/* ---------------- 增益 / 静音 / 变速 ---------------- */
test('P1-11 增益：dB→线性且上限 1；muted 为 0', () => {
  assert.ok(Math.abs(SingTransport._gain(-6) - 0.5012) < 1e-3);
  assert.equal(SingTransport._gain(0), 1);
  assert.equal(SingTransport._gain(6), 1, '多轨相加，单轨上限 1');
  const ctx = new FakeCtx();
  const tr = new SingTransport(ctx);
  tr.lanes = [lane({ gainDb: -6 }), lane({ muted: true, gainDb: 12 })];
  tr.play(0);
  assert.ok(Math.abs(ctx.gains[0].gain.value - 0.5012) < 1e-3);
  assert.equal(ctx.gains[1].gain.value, 0);
  tr.stop();
});

test('P1-11 变速：playbackRate=rate，源时长按 rate 缩短', () => {
  const ctx = new FakeCtx();
  const tr = new SingTransport(ctx);
  tr.lanes = [lane({ buf: buf(8), skipMs: 0 })];
  tr.play(0);
  tr.stop();
  tr.setRate(1.5);
  tr.play(0);
  const s = ctx.sources[ctx.sources.length - 1];
  assert.equal(s.playbackRate.value, 1.5);
  assert.ok(Math.abs(s.started.dur - 8 / 1.5) < 1e-6);
  // 位置按倍率缩放：墙钟走 1s（currentTime +1）→ 工程位置约 1.5s
  // （含 30ms 调度余量，位置 = (now − origin) × rate，容差按调度余量给）
  ctx.currentTime += 1;
  const pos = tr.positionMs;
  assert.ok(pos >= 1440 && pos <= 1500, '1.5× 下墙钟 1s ≈ 工程 1.5s，实际 ' + pos);
  tr.stop();
});

/* ---------------- 淡入淡出 ---------------- */
function rampBuf(len = 1000, sr = 1000) {
  const d = new Float32Array(len).fill(1);
  return { duration: len / sr, sampleRate: sr, numberOfChannels: 1, length: len, getChannelData: () => d };
}
test('P1-11 淡入淡出：首尾为 0、中段不受影响', () => {
  const b = rampBuf(1000, 1000);
  applyFades(b, 100, 200);           // 100ms 淡入 / 200ms 淡出 @1kHz
  const d = b.getChannelData(0);
  assert.equal(d[0], 0);
  assert.ok(Math.abs(d[50] - 0.5) < 1e-6);
  assert.ok(Math.abs(d[500] - 1) < 1e-6);
  assert.equal(d[999], 0);
  assert.ok(d[900] < 0.6);
});

test('P1-11 淡入淡出：总长不够时按比例收缩，不把中段乘两次', () => {
  const b = rampBuf(100, 1000);      // 100ms
  applyFades(b, 80, 80);             // 超过总长
  const d = b.getChannelData(0);
  assert.equal(d[0], 0);
  assert.equal(d[99], 0);
  assert.ok(d[50] > 0.8 && d[50] <= 1, '中段接近原值，实际 ' + d[50]);
});

/* ---------------- 离线混音导出 ---------------- */
test('P1-11 renderOffline：按播放同一套参数混音（速率/跳过/仅非静音）', async () => {
  globalThis.window = { OfflineAudioContext: FakeOfflineCtx };
  try {
    const tr = new SingTransport(new FakeCtx());
    tr.lanes = [lane({ buf: buf(8), skipMs: 1000, gainDb: -6 }), lane({ buf: buf(5), skipMs: 0, muted: true })];
    const out = await tr.renderOffline();
    assert.ok(out, '有输出');
    // 仅非静音 lane：总长 = (8-1)/1 + 0.3 = 7.3s → 8kHz = 58400 采样
    assert.equal(out.length, Math.ceil(7.3 * 8000));
    assert.equal(out.numberOfChannels, 2);
  } finally { delete globalThis.window; }
});
