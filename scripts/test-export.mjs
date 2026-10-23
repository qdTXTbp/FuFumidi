// P0-4 导出落盘链路测试（main/export.js 的纯函数；不依赖 Electron）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { encodeWav, decodeWavHeader } from '../frontend/src/core/export_audio.js';

const require = createRequire(import.meta.url);
const E = require('../main/export.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-export-')); }

test('P0-4 sanitizeName：Windows 非法字符/结尾点空格/超长/空名', () => {
  const dirty = E.sanitizeName('a/b:c*?<>|.wav', 'wav');
  assert.equal(dirty, 'a_b_c_____.wav');
  assert.ok(!/[\/:*?"<>|]/.test(dirty), '不允许残留 Windows 非法字符：' + dirty);
  assert.equal(E.sanitizeName('  名字结尾...  ', 'wav'), '名字结尾.wav');
  assert.equal(E.sanitizeName('', 'wav'), 'export.wav');
  assert.equal(E.sanitizeName('song', '.wav'), 'song.wav');
  assert.equal(E.sanitizeName('song', 'wav'), 'song.wav');
  const long = E.sanitizeName('x'.repeat(200), 'wav');
  assert.ok(long.length <= 124, '超长名被截断：' + long.length);
  assert.ok(long.endsWith('.wav'));
});

test('P0-4 writeExport：原子落盘 + sidecar manifest（sha256/大小/音频参数）', () => {
  const dir = tmpDir();
  const chs = [new Float32Array(48000).fill(0.1), new Float32Array(48000).fill(-0.1)];
  const wav = encodeWav(chs, 48000, { bitDepth: 24 });
  const res = E.writeExport({
    dir, name: '我的导出 测试', ext: 'wav', bytes: wav,
    manifest: E.buildManifest({
      bytes: wav, name: '我的导出 测试', ext: 'wav', format: 'wav', bitDepth: 24,
      sampleRate: 48000, channels: 2, durationSec: 1, lufs: -14.2, peakDb: -1.1, sourceName: '曲目 A',
    }),
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(fs.existsSync(res.path));
  assert.equal(fs.statSync(res.path).size, wav.length);
  assert.ok(!fs.existsSync(res.path + '.tmp'), '不能留 .tmp');
  assert.ok(fs.existsSync(res.manifestPath));
  const m = JSON.parse(fs.readFileSync(res.manifestPath, 'utf8'));
  assert.equal(m.format, 'fufumidi-export');
  assert.equal(m.version, 1);
  assert.equal(m.file.sha256, E.sha256(Buffer.from(wav)));
  assert.equal(m.file.size, wav.length);
  assert.equal(m.audio.bitDepth, 24);
  assert.equal(m.audio.sampleRate, 48000);
  assert.equal(m.audio.channels, 2);
  assert.equal(m.audio.lufs, -14.2);
  assert.equal(m.source.name, '曲目 A');
  const back = new Uint8Array(fs.readFileSync(res.path));
  assert.equal(decodeWavHeader(back).bits, 24, '落盘的确实是 24bit WAV');
});

test('P0-4 writeExport：缺目录/空数据返回明确错误，不留半成品', () => {
  assert.equal(E.writeExport({ dir: '', name: 'a', bytes: new Uint8Array([1]) }).ok, false);
  assert.equal(E.writeExport({ dir: tmpDir(), name: 'a', bytes: new Uint8Array(0) }).ok, false);
});

test('P0-4 buildManifest：字段完整、时间可注入（可复现）', () => {
  const m = E.buildManifest({
    bytes: Buffer.from([1, 2, 3]), fileName: 'x.wav', name: 'x', ext: 'wav',
    now: Date.UTC(2026, 9, 18, 0, 0, 0), format: 'wav', bitDepth: 16, sampleRate: 44100,
    channels: 2, durationSec: 12.3456, lufs: -13.98, peakDb: -1.004, targetLufs: -14,
  });
  assert.equal(m.createdAt, '2026-10-18T00:00:00.000Z');
  assert.equal(m.file.name, 'x.wav');
  assert.equal(m.audio.durationSec, 12.346);
  assert.equal(m.audio.lufs, -14);
  assert.equal(m.audio.peakDb, -1);
  assert.equal(m.audio.targetLufs, -14);
});
