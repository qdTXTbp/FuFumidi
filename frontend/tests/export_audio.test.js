import test from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeWav, decodeWavHeader, measurePeakDb, measureRmsDb, measureLufs,
  applyLimiter, normalizeLoudness, durationSec,
} from '../src/core/export_audio.js';

function sine(freq, amp, sr, sec, ch = 1) {
  const n = Math.round(sr * sec);
  const out = [];
  for (let c = 0; c < ch; c++) {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = amp * Math.sin(2 * Math.PI * freq * i / sr);
    out.push(a);
  }
  return out;
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || '') + ' 期望 ' + b + ' ±' + eps + '，实际 ' + a);

test('P0-4 WAV 16bit：头字段/大小/量化正确', () => {
  const chs = [new Float32Array(44100).fill(0.5), new Float32Array(44100).fill(-0.25)];
  const wav = encodeWav(chs, 44100, { bitDepth: 16 });
  assert.equal(wav.length, 44 + 44100 * 2 * 2);
  const h = decodeWavHeader(wav);
  assert.deepEqual([h.format, h.bits, h.channels, h.sampleRate, h.frames], [1, 16, 2, 44100, 44100]);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(dv.getInt16(44, true), 16384, '0.5 → 16383.5 四舍五入');
  assert.equal(dv.getInt16(46, true), -8192, '-0.25 → -8192');
});

test('P0-4 WAV 16bit + TPDF dither：静音也不再是纯 0（且不超过 ±2 LSB）', () => {
  const silent = [new Float32Array(2000)];
  const noD = encodeWav(silent, 44100, { bitDepth: 16, dither: false });
  let nz = 0;
  { const dv = new DataView(noD.buffer, noD.byteOffset, noD.byteLength); for (let i = 0; i < 2000; i++) if (dv.getInt16(44 + i * 2, true) !== 0) nz++; }
  assert.equal(nz, 0, '不开 dither 静音就是 0');
  const d = encodeWav(silent, 44100, { bitDepth: 16, dither: true });
  const dv2 = new DataView(d.buffer, d.byteOffset, d.byteLength);
  let nz2 = 0, maxAbs = 0;
  for (let i = 0; i < 2000; i++) { const v = dv2.getInt16(44 + i * 2, true); if (v !== 0) nz2++; maxAbs = Math.max(maxAbs, Math.abs(v)); }
  // TPDF(|x|>0.5) 的概率约 25%，2000 样本里应有一大批非零
  assert.ok(nz2 > 300, 'TPDF 应让至少 ~25% 静音样本非零，实际 ' + nz2);
  assert.ok(maxAbs <= 2, 'dither 幅度应在 ±1 LSB（进位后至多 2），实际 ' + maxAbs);
});

test('P0-4 WAV 24bit：3 字节小端 / 大小 / 0.5 的字节', () => {
  const chs = [new Float32Array(100).fill(0.5)];
  const wav = encodeWav(chs, 48000, { bitDepth: 24 });
  assert.equal(wav.length, 44 + 100 * 3);
  assert.equal(decodeWavHeader(wav).bits, 24);
  const o = 44;
  assert.deepEqual([wav[o], wav[o + 1], wav[o + 2]], [0x00, 0x00, 0x40], '0.5*8388607=4194303.5→0x400000');
});

test('P0-4 WAV float32：format 3 / 32bit / 原样浮点', () => {
  const chs = [new Float32Array([0.25, -0.75])];
  const wav = encodeWav(chs, 44100, { bitDepth: 32 });
  const h = decodeWavHeader(wav);
  assert.deepEqual([h.format, h.float, h.bits, h.frames], [3, true, 32, 2]);
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(dv.getFloat32(44, true), 0.25);
  assert.equal(dv.getFloat32(48, true), -0.75);
});

test('P0-4 峰值/RMS/duration 测量', () => {
  const chs = sine(1000, 0.5, 48000, 1, 1);
  near(measurePeakDb(chs), -6.0206, 0.05, '峰值');
  near(measureRmsDb(chs), -9.0309, 0.1, 'RMS');
  near(durationSec(chs, 48000), 1, 1e-9);
});

test('P0-4 响度（K 加权）：997Hz -20dBFS 单声道 ≈ -23.4 LUFS', () => {
  const chs = sine(997, 0.1, 48000, 5, 1);
  const lufs = measureLufs(chs, 48000);
  assert.ok(lufs > -24.5 && lufs < -22.5, '实测 ' + lufs.toFixed(2) + ' LUFS');
});

test('P0-4 响度：满幅 997Hz 立体声 ≈ 0 LUFS', () => {
  const chs = sine(997, 1.0, 48000, 5, 2);
  const lufs = measureLufs(chs, 48000);
  assert.ok(lufs > -1.5 && lufs < 1.5, '实测 ' + lufs.toFixed(2) + ' LUFS');
});

test('P0-4 限幅：超 0dBFS 的正弦被压到 ceiling 以下，并报告衰减量', () => {
  const chs = sine(440, 1.5, 48000, 1, 2);
  const { channels, reductionDb } = applyLimiter(chs, 48000, { ceilingDb: -1 });
  const peak = measurePeakDb(channels);
  const ceiling = Math.pow(10, -1 / 20);
  assert.ok(peak <= 20 * Math.log10(ceiling) + 0.02, '输出峰值 ' + peak.toFixed(2) + ' dB 应 ≤ -1dB');
  assert.ok(reductionDb > 2, '应报告 >2dB 衰减，实际 ' + reductionDb.toFixed(2));
});

test('P0-4 响度归一：-20dBFS 正弦归一到 -14 LUFS（误差小、峰值不越限）', () => {
  const chs = sine(997, 0.1, 48000, 5, 2);
  const before = measureLufs(chs, 48000);
  const { channels, report } = normalizeLoudness(chs, 48000, { targetLufs: -14, ceilingDb: -1 });
  assert.ok(Math.abs(report.outputLufs - (-14)) <= 0.7, '输出响度 ' + report.outputLufs.toFixed(2) + ' LUFS（输入 ' + before.toFixed(2) + '）');
  assert.ok(report.outputPeakDb <= -0.9, '输出峰值 ' + report.outputPeakDb.toFixed(2) + ' dB 应 ≤ -1');
  assert.ok(report.gainDb > 0, '应为正增益');
  assert.ok(Math.abs(report.errorDb) <= 0.7);
});

test('P0-4 encodeWav：非法输入会明确报错', () => {
  assert.throws(() => encodeWav([], 44100), /没有声道/);
  const many = Array.from({ length: 9 }, () => new Float32Array(10));
  assert.throws(() => encodeWav(many, 44100), /声道数过多/);
});
