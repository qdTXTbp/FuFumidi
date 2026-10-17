import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXPORT_FORMATS, LOUDNESS_TARGETS, formatInfo, loudnessInfo,
  normalizeExportOptions, exportOptionsToSettings, buildExportMeta, estimateFileBytes,
} from '../src/core/export_options.js';

test('P0-4b 格式表：16/24/float32 与位深/扩展名', () => {
  assert.deepEqual(EXPORT_FORMATS.map((f) => [f.id, f.bitDepth, f.ext]), [
    ['wav16', 16, 'wav'], ['wav24', 24, 'wav'], ['float32', 32, 'wav'],
  ]);
  assert.equal(formatInfo('wav16').bitDepth, 16);
  assert.equal(formatInfo('不存在').id, 'wav24', '未知格式回落到 wav24');
  assert.deepEqual(LOUDNESS_TARGETS.map((l) => l.targetLufs), [null, -14, -16, -23]);
  assert.equal(loudnessInfo('-16').targetLufs, -16);
  assert.equal(loudnessInfo('??').id, 'off');
});

test('P0-4b normalizeExportOptions：默认值 / 未知值回落 / 数值夹取', () => {
  const d = normalizeExportOptions({});
  assert.deepEqual([d.format, d.bitDepth, d.dither, d.loudness, d.limiter, d.stems], ['wav24', 24, true, 'off', true, false]);
  const u = normalizeExportOptions({ format: 'flac', loudness: 'abc', gainPct: 999 });
  assert.equal(u.format, 'wav24');
  assert.equal(u.loudness, 'off');
  assert.equal(u.gainPct, 150);
  assert.equal(normalizeExportOptions({ gainPct: -5 }).gainPct, 0);
  assert.equal(normalizeExportOptions({ format: 'wav16', dither: false }).dither, false);
});

test('P0-4b exportOptionsToSettings：写成 settings.js 的三个键', () => {
  assert.deepEqual(exportOptionsToSettings({ format: 'float32', dither: false, loudness: '-14' }), {
    'export.audio.format': 'float32',
    'export.audio.dither': false,
    'export.audio.loudness': '-14',
  });
});

test('P0-4b buildExportMeta：IPC 元数据字段完整、LUFS 保留一位', () => {
  const m = buildExportMeta({
    name: '曲目 A', format: 'wav24', sampleRate: 48000, channels: 2,
    durationSec: 12.34567, lufs: -14.234, peakDb: -1.004, targetLufs: -14, sourceName: 'A.mid',
  });
  assert.deepEqual(
    [m.name, m.ext, m.format, m.bitDepth, m.sampleRate, m.channels, m.durationSec, m.lufs, m.peakDb, m.targetLufs],
    ['曲目 A', 'wav', 'wav24', 24, 48000, 2, 12.346, -14.2, -1, -14]
  );
  assert.equal(m.sourceName, 'A.mid');
  assert.equal(buildExportMeta({ format: 'wav16' }).targetLufs, null, '响度关时 target 为 null');
});

test('P0-4b estimateFileBytes：位深不同大小不同', () => {
  const a = estimateFileBytes(60, 48000, 'wav16');
  const b = estimateFileBytes(60, 48000, 'wav24');
  const c = estimateFileBytes(60, 48000, 'float32');
  assert.ok(a < b && b < c);
  assert.equal(a, Math.round(60 * 48000 * 2 * 2 + 44));
  assert.equal(estimateFileBytes(0, 44100, 'wav16'), 44);
});
