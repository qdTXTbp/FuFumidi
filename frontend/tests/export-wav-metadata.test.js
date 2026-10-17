// P1-7 WAV 元数据：BWF bext + LIST INFO（生成后必须能被 chunk 扫描正确读回）
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeWav, decodeWavHeader } from '../src/core/export_audio.js';

function chunks(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o, l) => String.fromCharCode.apply(null, Array.from(u8.subarray(o, o + l)));
  const out = {};
  let off = 12;
  while (off + 8 <= u8.length) {
    const id = str(off, 4);
    const size = v.getUint32(off + 4, true);
    out[id.trim()] = u8.subarray(off + 8, off + 8 + size);
    off = off + 8 + size + (size % 2);
  }
  return out;
}
function zstr(u8, off, len) {
  let s = '';
  for (let i = off; i < off + len; i++) { if (!u8[i]) break; s += String.fromCharCode(u8[i]); }
  return s;
}
function wavSamples() {
  return [new Float32Array([0.1, -0.2, 0.3, -0.4]), new Float32Array([0.05, 0, -0.1, 0.2])];
}

test('P1-7 无 metadata：仍是标准 44 字节头，无额外 chunk', () => {
  const b = encodeWav(wavSamples(), 48000, { bitDepth: 16 });
  assert.equal(b.length, 44 + 4 * 2 * 2);
  const h = decodeWavHeader(b);
  assert.equal(h.dataSize, 16);
  assert.equal(h.frames, 4);
  assert.deepEqual(h.extraChunks, []);
});

test('P1-7 BWF bext：originator / 日期 / 时间 / 时间参考回读一致', () => {
  const b = encodeWav(wavSamples(), 48000, { bitDepth: 16, metadata: {
    description: 'Song A', originator: 'FuFumidi', originatorReference: 'REF-1',
    originationDate: '2026-10-18', originationTime: '12:34:56', timeReference: 48000,
  } });
  const c = chunks(b);
  assert.ok(c.bext, '应有 bext chunk');
  assert.equal(c.bext.length, 602);
  assert.equal(zstr(c.bext, 0, 256), 'Song A');
  assert.equal(zstr(c.bext, 256, 32), 'FuFumidi');
  assert.equal(zstr(c.bext, 288, 32), 'REF-1');
  assert.equal(zstr(c.bext, 320, 10), '2026-10-18');
  assert.equal(zstr(c.bext, 330, 8), '12:34:56');
  const v = new DataView(c.bext.buffer, c.bext.byteOffset, c.bext.byteLength);
  assert.equal(v.getUint32(338, true), 48000);
  assert.equal(v.getUint16(346, true), 1, 'BWF version 1');
});

test('P1-7 LIST INFO：INAM/ISFT/IART 字段可读，data 仍在正确位置', () => {
  const b = encodeWav(wavSamples(), 44100, { bitDepth: 16, metadata: {
    title: 'Demo', software: 'FuFumidi 6.0.0', artist: 'Bot', date: '2026-10-18',
  } });
  const c = chunks(b);
  assert.ok(c.LIST, '应有 LIST chunk');
  const list = c.LIST;
  assert.equal(zstr(list, 0, 4), 'INFO');
  // 手写解析子 chunk
  const found = {};
  const v = new DataView(list.buffer, list.byteOffset, list.byteLength);
  let off = 4;
  while (off + 8 <= list.length) {
    const id = zstr(list, off, 4);
    const size = v.getUint32(off + 4, true);
    found[id] = zstr(list, off + 8, size);
    off += 8 + size + (size % 2);
  }
  assert.equal(found.INAM, 'Demo');
  assert.equal(found.ISFT, 'FuFumidi 6.0.0');
  assert.equal(found.IART, 'Bot');
  assert.equal(found.ICRD, '2026-10-18');
  const h = decodeWavHeader(b);
  assert.equal(h.dataSize, 16, 'data 长度不受元数据影响');
  assert.equal(h.frames, 4);
  assert.ok(h.extraChunks.includes('LIST'));
});

test('P1-7 奇数长度文本的偶数字节对齐：data chunk 不漏读', () => {
  const b = encodeWav(wavSamples(), 48000, { bitDepth: 24, metadata: { title: 'abcde' } });
  const h = decodeWavHeader(b);
  assert.equal(h.bits, 24);
  assert.equal(h.dataSize, 4 * 2 * 3);
  assert.equal(h.frames, 4);
});

test('P1-7 32-bit float + 元数据仍可解码', () => {
  const b = encodeWav(wavSamples(), 48000, { bitDepth: 32, metadata: { title: 't' } });
  const h = decodeWavHeader(b);
  assert.equal(h.format, 3);
  assert.equal(h.float, true);
  assert.equal(h.bits, 32);
  assert.equal(h.frames, 4);
});

test('P1-7 中文/非 ASCII 元数据：写成单字节安全字符，不产生非法字节', () => {
  const b = encodeWav(wavSamples(), 48000, { bitDepth: 16, metadata: { description: '测试曲目', originator: '芙芙' } });
  const c = chunks(b);
  assert.ok(c.bext);
  // 非 ASCII 一律替换成 '?'（Latin-1 安全），不允许出现 >255 的码点写入
  assert.equal(zstr(c.bext, 0, 256), '????');
  assert.equal(zstr(c.bext, 256, 32), '??');
});
