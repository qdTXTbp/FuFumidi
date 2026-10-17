// P2-2 音频 I/O 后端选择 / 延迟口径测试（纯逻辑）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AUDIO_BACKENDS, availableBackends, chooseAudioBackend, latencyReport,
  formatLatencyReport, bufferOptions, DEFAULT_TARGET_RTL_MS,
} from '../src/core/audio_rt.js';

test('P2-2 后端表：webaudio 三平台都有，原生后端按平台归属', () => {
  const all = AUDIO_BACKENDS.map((b) => b.id);
  assert.ok(all.includes('webaudio') && all.includes('asio') && all.includes('coreaudio'));
  assert.equal(availableBackends('win32', false).map((b) => b.id).join(','), 'webaudio');
  assert.ok(availableBackends('win32', true).some((b) => b.id === 'wasapi-exclusive'));
  assert.equal(availableBackends('darwin', false).some((b) => b.native), false);
});

test('P2-2 选择：auto + 原生不可用 → WebAudio，且必须写回退原因', () => {
  const r = chooseAudioBackend({ platform: 'win32', nativeAvailable: false });
  assert.equal(r.backend, 'webaudio');
  assert.equal(r.fallback, true);
  assert.match(r.reason, /回退|未随包/);
});

test('P2-2 选择：强制 webaudio 不算回退；强制 native 但实现缺失才是回退', () => {
  const forced = chooseAudioBackend({ platform: 'win32', setting: 'webaudio', nativeAvailable: true });
  assert.equal(forced.backend, 'webaudio');
  assert.equal(forced.fallback, false);
  const nativeMissing = chooseAudioBackend({ platform: 'win32', setting: 'native', nativeAvailable: false });
  assert.equal(nativeMissing.backend, 'webaudio');
  assert.equal(nativeMissing.fallback, true);
  const nativeOk = chooseAudioBackend({ platform: 'win32', setting: 'native', nativeAvailable: true });
  assert.equal(nativeOk.backend, 'wasapi-exclusive');
  assert.equal(nativeOk.native, true);
});

test('P2-2 选择：macOS 原生优先 coreaudio；未知平台安全回退', () => {
  assert.equal(chooseAudioBackend({ platform: 'darwin', setting: 'auto', nativeAvailable: true }).backend, 'coreaudio');
  const weird = chooseAudioBackend({ platform: 'plan9', setting: 'auto', nativeAvailable: true });
  assert.equal(weird.backend, 'webaudio');
  assert.equal(weird.fallback, true);
});

test('P2-2 延迟口径：base+output+input+buffer，目标 10ms', () => {
  const r = latencyReport({ baseLatency: 0.005, outputLatency: 0.005, sampleRate: 48000 });
  assert.equal(r.baseMs, 5);
  assert.equal(r.outputMs, 5);
  assert.equal(r.estimatedRtlMs, 10);
  assert.equal(r.withinTarget, true);
  assert.equal(r.grade, 'low');
  assert.equal(DEFAULT_TARGET_RTL_MS, 10);
});

test('P2-2 延迟口径：WebAudio 典型值不达标（如实报告）', () => {
  const r = latencyReport({ baseLatency: 0.01, outputLatency: 0.02, sampleRate: 44100, bufferFrames: 512 });
  assert.ok(Math.abs(r.bufferMs - 11.61) < 0.02);
  assert.ok(r.estimatedRtlMs > 25, '实际 ' + r.estimatedRtlMs);
  assert.equal(r.withinTarget, false);
  assert.equal(r.grade, 'high');
});

test('P2-2 报告文本：包含后端/采样率/估算值与是否达标', () => {
  const rep = latencyReport({ baseLatency: 0.005, outputLatency: 0.005 });
  const txt = formatLatencyReport(rep, 'webaudio');
  assert.match(txt, /后端：webaudio/);
  assert.match(txt, /采样率：44100 Hz/);
  assert.match(txt, /估算 RTL：10 ms/);
  assert.match(txt, /达标/);
});

test('P2-2 缓冲档位换算：48k 下 128 帧 ≈ 2.67ms', () => {
  const opts = bufferOptions(48000);
  assert.equal(opts.length, 6);
  assert.equal(opts.find((x) => x.frames === 128).ms, 2.67);
  assert.equal(opts.find((x) => x.frames === 1024).ms, 21.33);
});
