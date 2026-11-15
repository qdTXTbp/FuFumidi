// V0.2 压缩音频导出：格式表一致性、ffmpeg 参数、主进程转码链路（用 stub 引擎，不真跑 ffmpeg）。
// 真实 ffmpeg 转码的可用性验证见 docs/test-reports/2026-11-15-v0.2-audio-formats.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  EXPORT_FORMATS, formatInfo, needsTranscode,
  normalizeExportOptions, buildExportMeta, estimateFileBytes,
} from '../src/core/export_options.js';

const require = createRequire(import.meta.url);
const A = require('../../main/audio-encode.js');
const { parsePyJson } = require('../../main/py-util.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-enc-')); }

test('V0.2 两份格式表必须一致（前端 codec 字段 ↔ 主进程 COMPRESSED_FORMATS）', () => {
  const front = EXPORT_FORMATS.filter((f) => f.codec).map((f) => f.id).sort();
  const back = Object.keys(A.COMPRESSED_FORMATS).sort();
  assert.deepEqual(front, back, '只改一边会导致 UI 有选项但主进程不转码（或反之）');
  for (const f of EXPORT_FORMATS.filter((x) => x.codec)) {
    assert.equal(A.extFor(f.id), f.ext, f.id + ' 扩展名不一致');
  }
});

test('V0.2 ffmpegArgs：三种压缩格式参数正确，WAV 返回 null', () => {
  const mp3 = A.ffmpegArgs('mp3', 'in.wav', 'out.mp3');
  assert.deepEqual(mp3.slice(0, 7), ['-y', '-hide_banner', '-loglevel', 'error', '-i', 'in.wav', '-c:a']);
  assert.ok(mp3.includes('libmp3lame') && mp3.includes('320k'));
  assert.equal(mp3[mp3.length - 1], 'out.mp3');
  assert.ok(A.ffmpegArgs('flac', 'a.wav', 'a.flac').includes('flac'));
  assert.ok(A.ffmpegArgs('ogg', 'a.wav', 'a.ogg').includes('libvorbis'));
  assert.equal(A.ffmpegArgs('wav24', 'a.wav', 'a.wav'), null);
  assert.equal(A.ffmpegArgs('nope', 'a.wav', 'a.x'), null);
});

test('V0.2 buildPyCode：经 imageio_ffmpeg 定位，不硬编码 ffmpeg 版本', () => {
  const code = A.buildPyCode(A.ffmpegArgs('flac', 'C:/tmp/a.wav', 'C:/tmp/a.flac'));
  assert.ok(code.includes('imageio_ffmpeg.get_ffmpeg_exe()'));
  assert.ok(code.includes('C:/tmp/a.wav') && code.includes('C:/tmp/a.flac'));
  assert.ok(code.includes('capture_output=True'));
});

test('V0.2 encodeAudio：转码成功返回产物字节，并清理两个临时文件', async () => {
  const dir = tmpDir();
  let seenArgs = null;
  const runEngineInline = async (code) => {
    const m = code.match(/\[ff\] \+ (\[[^\n]*\]), capture_output=True/);
    seenArgs = JSON.parse(m[1]);
    fs.writeFileSync(seenArgs[seenArgs.length - 1], Buffer.from('FAKE-MP3-BYTES'));
    return { ok: true, out: JSON.stringify({ ok: true }) };
  };
  const res = await A.encodeAudio({
    bytes: Buffer.from('RIFF-fake-wav'), format: 'mp3', tmpDir: dir,
    runEngineInline, parsePyJson,
  });
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.bytes.toString(), 'FAKE-MP3-BYTES');
  assert.ok(seenArgs.includes('libmp3lame'));
  assert.deepEqual(fs.readdirSync(dir), [], '临时 WAV 与产物都要删掉');
});

test('V0.2 encodeAudio：失败路径给明确错误，不抛异常、不留文件', async () => {
  const dir = tmpDir();
  assert.equal((await A.encodeAudio({ bytes: Buffer.from('x'), format: 'mp3', tmpDir: dir })).ok, false,
    '缺引擎运行时应明确报错');
  assert.equal((await A.encodeAudio({ bytes: Buffer.from([]), format: 'mp3', tmpDir: dir })).ok, false);
  assert.equal((await A.encodeAudio({ bytes: Buffer.from('x'), format: 'wav24', tmpDir: dir })).ok, false);

  const runEngineInline = async () => ({ ok: true, out: JSON.stringify({ ok: false, err: 'encoder missing' }) });
  const r = await A.encodeAudio({ bytes: Buffer.from('x'), format: 'ogg', tmpDir: dir, runEngineInline, parsePyJson });
  assert.equal(r.ok, false);
  assert.match(r.error, /encoder missing/);
  assert.deepEqual(fs.readdirSync(dir), [], '失败也要清理临时 WAV');
});

test('V0.2 export_options：压缩格式走 24bit 母版、扩展名正确、dither 不适用', () => {
  for (const id of ['flac', 'mp3', 'ogg']) {
    const o = normalizeExportOptions({ format: id });
    assert.equal(o.format, id);
    assert.equal(o.bitDepth, 24, id + ' 的母版应走 24bit，避免 16bit 二次损失');
    assert.equal(o.codec, formatInfo(id).codec);
    assert.equal(needsTranscode(id), true);
    assert.equal(buildExportMeta({ format: id }).ext, o.ext);
  }
  assert.equal(needsTranscode('wav24'), false);
  assert.equal(normalizeExportOptions({ format: 'aac' }).format, 'wav24', '真未知值才回落');
});

test('V0.2 estimateFileBytes：压缩格式按比特率/压缩比估，明显小于 WAV 母版', () => {
  const wav = estimateFileBytes(60, 48000, 'wav24');
  const mp3 = estimateFileBytes(60, 48000, 'mp3');
  const flac = estimateFileBytes(60, 48000, 'flac');
  const ogg = estimateFileBytes(60, 48000, 'ogg');
  assert.equal(mp3, Math.round(60 * 320 * 1000 / 8));
  assert.equal(ogg, Math.round(60 * 192 * 1000 / 8));
  assert.equal(flac, Math.round(60 * 48000 * 3 * 2 * 0.6));
  assert.ok(mp3 < wav && ogg < wav && flac < wav);
  assert.equal(estimateFileBytes(0, 44100, 'mp3'), 0);
});
