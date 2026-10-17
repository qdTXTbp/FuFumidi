// P2-1 插件节点（离线渲染链）测试：纯 DSP，逐样本可验证
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLUGIN_TYPES, normalizePluginNode, normalizePluginChain, biquadCoeffs,
  applyPluginChain, describePluginChain,
} from '../src/core/plugin_node.js';

const SR = 48000;
function sine(freq, seconds, amp = 0.5, sr = SR) {
  const n = Math.round(sr * seconds);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
  return a;
}
function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}
function peak(x) { let m = 0; for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i])); return m; }

test('P2-1 normalizePluginNode：未知类型 null、参数夹紧、bool 默认开', () => {
  assert.equal(normalizePluginNode(null), null);
  assert.equal(normalizePluginNode({ type: 'nope' }), null);
  const g = normalizePluginNode({ type: 'gain', params: { gainDb: 999 } });
  assert.equal(g.params.gainDb, 24);
  assert.equal(g.enabled, true);
  const eq = normalizePluginNode({ type: 'eq', params: { freq: 1, q: 999, gainDb: -999, type: 'bad' } });
  assert.equal(eq.params.freq, 20);
  assert.equal(eq.params.q, 12);
  assert.equal(eq.params.gainDb, -24);
  assert.equal(eq.params.type, 'peaking');
  assert.equal(normalizePluginChain([{ type: 'gain' }, { type: 'nope' }]).length, 1);
});

test('P2-1 增益节点：+6dB 约 ×1.995', () => {
  const ch = sine(1000, 0.1, 0.2);
  const src = Float32Array.from(ch);
  const { channels } = applyPluginChain([ch], SR, [{ type: 'gain', params: { gainDb: 6 } }]);
  for (let i = 1; i < 10; i++) assert.ok(Math.abs(channels[0][i] / src[i] - 1.9953) < 1e-3);
});

test('P2-1 biquad peaking +12dB @1kHz：1k 提升约 4×，100Hz 基本不动', () => {
  const c = biquadCoeffs('peaking', SR, 1000, 1, 12);
  assert.ok(Math.abs(c.b0) > 0);
  const hi = sine(1000, 0.2, 0.1);
  const lo = sine(100, 0.2, 0.1);
  const hiRef = rms(hi), loRef = rms(lo);
  const { channels: hiOut } = applyPluginChain([hi], SR, [{ type: 'eq', params: { type: 'peaking', freq: 1000, q: 1, gainDb: 12 } }]);
  const { channels: loOut } = applyPluginChain([lo], SR, [{ type: 'eq', params: { type: 'peaking', freq: 1000, q: 1, gainDb: 12 } }]);
  const hiRatio = rms(hiOut[0]) / hiRef;
  const loRatio = rms(loOut[0]) / loRef;
  assert.ok(hiRatio > 3.0 && hiRatio < 4.5, '1kHz 应提升 ~4×，实际 ' + hiRatio.toFixed(2));
  assert.ok(loRatio > 0.8 && loRatio < 1.2, '100Hz 应基本不变，实际 ' + loRatio.toFixed(2));
});

test('P2-1 压缩器：过阈值的响信号被压，阈值下的轻信号基本不动', () => {
  const loud = sine(220, 0.5, 0.8);
  const quiet = sine(220, 0.5, 0.05);
  const loudRef = rms(loud), quietRef = rms(quiet);
  const nodes = [{ type: 'compressor', params: { thresholdDb: -18, ratio: 4, attackMs: 5, releaseMs: 100, kneeDb: 0 } }];
  const { channels: lOut, report } = applyPluginChain([Float32Array.from(loud)], SR, nodes);
  const { channels: qOut } = applyPluginChain([Float32Array.from(quiet)], SR, nodes);
  const lRatio = rms(lOut[0]) / loudRef;
  const qRatio = rms(qOut[0]) / quietRef;
  assert.ok(lRatio < 0.6, '响信号应明显降低，实际 ' + lRatio.toFixed(2));
  assert.ok(qRatio > 0.9, '轻信号应基本不动，实际 ' + qRatio.toFixed(2));
  assert.equal(report[0].type, 'compressor');
  assert.ok(Number.isFinite(report[0].beforePeakDb));
});

test('P2-1 饱和器：输出不超 1，mix=1 时按 tanh 曲线压缩', () => {
  const x = sine(100, 0.1, 0.9);
  const nodes = [{ type: 'saturator', params: { drive: 2, mix: 1 } }];
  const { channels } = applyPluginChain([x], SR, nodes);
  const out = channels[0];
  assert.ok(peak(out) <= 1.0 + 1e-6);
  assert.ok(Math.abs(out[1]) < Math.abs(x[1]) + 1e-6, 'tanh 应压住小信号相对值');
  const nodes0 = [{ type: 'saturator', params: { drive: 2, mix: 0 } }];
  const { channels: dry } = applyPluginChain([Float32Array.from(x)], SR, nodes0);
  for (let i = 0; i < 20; i++) assert.ok(Math.abs(dry[0][i] - x[i]) < 1e-6, 'mix=0 应为干声');
});

test('P2-1 顺序重要：gain→sat 与 sat→gain 结果不同', () => {
  const mk = () => [Float32Array.from({ length: 200 }, (_, i) => 0.3 * Math.sin(i * 0.3))];
  const a = applyPluginChain(mk(), SR, [
    { type: 'gain', params: { gainDb: 12 } },
    { type: 'saturator', params: { drive: 3, mix: 1 } },
  ]).channels[0];
  const b = applyPluginChain(mk(), SR, [
    { type: 'saturator', params: { drive: 3, mix: 1 } },
    { type: 'gain', params: { gainDb: 12 } },
  ]).channels[0];
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  assert.ok(diff > 1e-3, '非线性节点顺序必须影响结果');
});

test('P2-1 bypass：enabled=false 的节点完全不动信号；空链恒等', () => {
  const src = sine(440, 0.05, 0.4);
  const before = Float32Array.from(src);
  const { channels, report } = applyPluginChain([src], SR, [{ type: 'gain', enabled: false, params: { gainDb: 24 } }]);
  for (let i = 0; i < before.length; i++) assert.equal(channels[0][i], before[i]);
  assert.equal(report[0].skipped, true);
  const src2 = sine(440, 0.05, 0.4);
  const out2 = applyPluginChain([src2], SR, []).channels;
  assert.equal(out2[0], src2);
});

test('P2-1 立体声各通道独立处理且都生效', () => {
  const l = sine(500, 0.1, 0.3), r = sine(500, 0.1, 0.1);
  const { channels } = applyPluginChain([Float32Array.from(l), Float32Array.from(r)], SR, [{ type: 'gain', params: { gainDb: -6 } }]);
  assert.ok(Math.abs(channels[0][10] / l[10] - 0.5012) < 1e-3);
  assert.ok(Math.abs(channels[1][10] / r[10] - 0.5012) < 1e-3);
});

test('P2-1 describePluginChain：给 UI 的摘要带 label/参数', () => {
  const d = describePluginChain([{ id: 'fx1', type: 'eq', params: { freq: 2000 } }, { type: 'gain' }]);
  assert.equal(d.length, 2);
  assert.equal(d[0].label, PLUGIN_TYPES.eq.label);
  assert.equal(d[0].params.freq, 2000);
  assert.equal(d[1].params.gainDb, 0);
});

test('P2-1 输出钳制：非法样本归零，超范围钳到 ±1', () => {
  const ch = new Float32Array([2, -3, NaN, 0.5]);
  const { channels } = applyPluginChain([ch], SR, []);
  assert.deepEqual(Array.from(channels[0]), [1, -1, 0, 0.5]);
});
