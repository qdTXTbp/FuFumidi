// 压缩包安全解压：规则、按路径入口、大包流式解压（zip64）
// 回归点（2026-10-31 线上问题）：installUnpackEntry 把**路径**传给了只接受 AdmZip 实例的
// safeExtractAllTo → `TypeError: zip.getEntries is not a function`，5 GB 运行时包白下一次。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Z = require('../main/zip-safe.js');
const AdmZip = require('adm-zip');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-zip-')); }
function walk(dir) {
  const out = [];
  const rec = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) rec(p); else out.push(path.relative(dir, p).replace(/\\/g, '/')); } };
  rec(dir);
  return out.sort();
}

/* ---------------- 手搓 zip（可控 zip64 / 重名 / 越界名） ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * @param {{zip64?:boolean, entries:Array<{name:string, data?:Buffer|string, method?:number}>}} spec
 * @returns {Buffer}
 */
function buildZip(spec) {
  const zip64 = !!spec.zip64;
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of spec.entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const isDir = /\/$/.test(e.name);
    const raw = isDir ? Buffer.alloc(0) : Buffer.from(e.data == null ? '' : e.data);
    const method = isDir ? 0 : (e.method == null ? 0 : e.method);
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const crc = crc32(raw);
    const extraLen = zip64 ? 20 : 0;        // id(2)+size(2)+usize(8)+csize(8)
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt16LE(0x0800, 6);            // UTF-8 名
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(zip64 ? 0xffffffff : body.length, 18);
    lh.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(extraLen, 28);
    const lhExtra = Buffer.alloc(extraLen);
    if (zip64) {
      lhExtra.writeUInt16LE(0x0001, 0);
      lhExtra.writeUInt16LE(16, 2);
      lhExtra.writeBigUInt64LE(BigInt(raw.length), 4);
      lhExtra.writeBigUInt64LE(BigInt(body.length), 12);
    }
    locals.push(lh, nameBuf, lhExtra, body);

    const cExtraLen = zip64 ? 28 : 0;       // id(2)+size(2)+usize(8)+csize(8)+lho(8)
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 4);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(zip64 ? 0xffffffff : body.length, 20);
    ch.writeUInt32LE(zip64 ? 0xffffffff : raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt16LE(cExtraLen, 30);
    ch.writeUInt32LE(zip64 ? 0xffffffff : offset, 42);
    const cExtra = Buffer.alloc(cExtraLen);
    if (zip64) {
      cExtra.writeUInt16LE(0x0001, 0);
      cExtra.writeUInt16LE(24, 2);
      cExtra.writeBigUInt64LE(BigInt(raw.length), 4);
      cExtra.writeBigUInt64LE(BigInt(body.length), 12);
      cExtra.writeBigUInt64LE(BigInt(offset), 20);
    }
    central.push(ch, nameBuf, cExtra);
    offset += 30 + nameBuf.length + extraLen + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const tail = [];
  let eocdOff = offset + cdBuf.length;
  if (zip64) {
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(BigInt(spec.entries.length), 24);
    z64.writeBigUInt64LE(BigInt(spec.entries.length), 32);
    z64.writeBigUInt64LE(BigInt(cdBuf.length), 40);
    z64.writeBigUInt64LE(BigInt(offset), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(eocdOff), 8);
    loc.writeUInt32LE(1, 16);
    tail.push(z64, loc);
    eocdOff += 56 + 20;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(zip64 ? 0xffff : spec.entries.length, 8);
  eocd.writeUInt16LE(zip64 ? 0xffff : spec.entries.length, 10);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : cdBuf.length, 12);
  eocd.writeUInt32LE(zip64 ? 0xffffffff : offset, 16);
  tail.push(eocd);
  return Buffer.concat([...locals, cdBuf, ...tail]);
}

function writeTmp(dir, name, buf) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, buf);
  return p;
}

/* ---------------- 1. 回归：按路径调用（线上 TypeError） ---------------- */
test('safeExtractAllTo 接受压缩包路径（回归 TypeError: zip.getEntries is not a function）', () => {
  const root = tmp();
  const zipPath = writeTmp(root, 'a.zip', buildZip({ entries: [{ name: 'x/y.txt', data: 'hi' }] }));
  const out = path.join(root, 'out');
  const r = Z.safeExtractAllTo(zipPath, out);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(out, 'x/y.txt'), 'utf8'), 'hi');
});

test('inspectEntries 也接受路径，且仍接受 AdmZip 实例', () => {
  const root = tmp();
  const zipPath = writeTmp(root, 'b.zip', buildZip({ entries: [{ name: 'f.bin', data: Buffer.alloc(10, 7) }] }));
  const byPath = Z.inspectEntries(zipPath, path.join(root, 'o1'));
  const byInst = Z.inspectEntries(new AdmZip(zipPath), path.join(root, 'o2'));
  assert.equal(byPath.ok, true, byPath.error);
  assert.deepEqual(byPath, byInst);
  assert.equal(byPath.count, 1);
});

/* ---------------- 2/3. 两条解压通道产出必须一致 ---------------- */
test('safeExtractFile：小包走 adm-zip，forceStream 走流式，产物一致', async () => {
  const root = tmp();
  const payload = buildZip({
    entries: [
      { name: 'pkg/', data: '' },
      { name: 'pkg/a.txt', data: 'alpha' },
      { name: 'pkg/sub/b.bin', data: Buffer.alloc(4096, 3) },
      { name: 'pkg/empty.bin', data: '' },
      { name: 'pkg/c.txt', data: 'compress-me'.repeat(200), method: 8 },
    ],
  });
  const zipPath = writeTmp(root, 'c.zip', payload);

  const outA = path.join(root, 'small');
  const ra = await Z.safeExtractFile(zipPath, outA);
  assert.equal(ra.ok, true, ra.error);
  assert.equal(ra.streamed, false);

  const outB = path.join(root, 'stream');
  const rb = await Z.safeExtractFile(zipPath, outB, { forceStream: true });
  assert.equal(rb.ok, true, rb.error);
  assert.equal(rb.streamed, true);

  assert.deepEqual(walk(outA), walk(outB));
  assert.deepEqual(walk(outA), ['pkg/a.txt', 'pkg/c.txt', 'pkg/empty.bin', 'pkg/sub/b.bin']);
  for (const rel of walk(outA)) {
    assert.deepEqual(fs.readFileSync(path.join(outA, rel)), fs.readFileSync(path.join(outB, rel)), rel);
  }
  assert.equal(fs.readFileSync(path.join(outB, 'pkg/c.txt'), 'utf8'), 'compress-me'.repeat(200));
});

test('流式解压报告进度：单调不减，末值等于总字节', async () => {
  const root = tmp();
  const zipPath = writeTmp(root, 'd.zip', buildZip({
    entries: [
      { name: 'a.bin', data: Buffer.alloc(300000, 1) },
      { name: 'b.bin', data: Buffer.alloc(300000, 2), method: 8 },
    ],
  }));
  const seen = [];
  const r = await Z.safeExtractFile(zipPath, path.join(root, 'out'), { forceStream: true, onProgress: (done, total) => seen.push([done, total]) });
  assert.equal(r.ok, true, r.error);
  assert.ok(seen.length >= 2);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i][0] >= seen[i - 1][0], '进度必须单调');
  const last = seen[seen.length - 1];
  assert.equal(last[0], last[1]);
  assert.equal(last[1], 600000);
});

test('条目很多时进度回调按节流上报（不把 IPC 打满）', async () => {
  const root = tmp();
  const entries = [];
  for (let i = 0; i < 400; i++) entries.push({ name: `d${i % 20}/f${i}.txt`, data: 'x'.repeat(64) });
  const zipPath = writeTmp(root, 'many.zip', buildZip({ entries }));
  let calls = 0;
  const r = await Z.safeExtractFile(zipPath, path.join(root, 'out'), { forceStream: true, onProgress: () => { calls++; } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.count, 400);
  assert.ok(calls <= 10, '400 个条目只应有极少数进度回调，实际 ' + calls);
  assert.ok(calls >= 1);
});

/* ---------------- 4. zip64（>4 GiB 偏移/尺寸的编码） ---------------- */
test('readCentralDirectory 解析 zip64 包（尺寸/本地头偏移取自 zip64 扩展字段）', () => {
  const root = tmp();
  const zipPath = writeTmp(root, 'z64.zip', buildZip({
    zip64: true,
    entries: [
      { name: 'big/blob.bin', data: Buffer.alloc(1024, 9) },
      { name: 'after.txt', data: 'after' },
    ],
  }));
  const { entries, zip64 } = Z.readCentralDirectory(zipPath);
  assert.equal(zip64, true);
  assert.deepEqual(entries.map((e) => e.name), ['big/blob.bin', 'after.txt']);
  assert.equal(entries[0].size, 1024);
  assert.equal(entries[1].size, 5);
  // 第二条的本地头偏移必须落在第一条数据之后（不是 0xFFFFFFFF 之类的哨兵值）
  assert.ok(entries[1].lho > 30 + 12 + 1024, 'lho=' + entries[1].lho);
});

test('safeExtractFile 能解 zip64 包（流式通道）', async () => {
  const root = tmp();
  const zipPath = writeTmp(root, 'z64b.zip', buildZip({
    zip64: true,
    entries: [
      { name: 'a/x.txt', data: 'zip64-hello' },
      { name: 'b/y.txt', data: 'zip64-world'.repeat(50), method: 8 },
    ],
  }));
  const out = path.join(root, 'out');
  const r = await Z.safeExtractFile(zipPath, out, { forceStream: true });
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(out, 'a/x.txt'), 'utf8'), 'zip64-hello');
  assert.equal(fs.readFileSync(path.join(out, 'b/y.txt'), 'utf8'), 'zip64-world'.repeat(50));
});

/* ---------------- 5. 安全规则 ---------------- */
test('安全规则：越界 / 绝对路径 / 盘符 / 重名 / 空包 / 超限 一律整包拒绝且不落盘', async () => {
  const root = tmp();
  const cases = [
    { why: '..', entries: [{ name: '../evil.txt', data: 'x' }] },
    { why: 'abs', entries: [{ name: '/etc/evil.txt', data: 'x' }] },
    { why: 'drive', entries: [{ name: 'C:/Windows/evil.dll', data: 'x' }] },
    { why: 'dup', entries: [{ name: 'same.txt', data: 'a' }, { name: 'SAME.txt', data: 'b' }] },
    { why: 'nul', entries: [{ name: 'bad\u0000name.txt', data: 'x' }] },
  ];
  for (const c of cases) {
    const zipPath = writeTmp(root, 'bad-' + c.why + '.zip', buildZip({ entries: c.entries }));
    const out = path.join(root, 'out-' + c.why);
    const r = await Z.safeExtractFile(zipPath, out);
    assert.equal(r.ok, false, c.why + ' 应被拒绝');
    assert.equal(r.stage, 'check', c.why + ' 应在校验阶段拦下');
    assert.equal(fs.existsSync(out) ? walk(out).length : 0, 0, c.why + ' 不应有任何文件落盘');
  }
  // 解出来的东西不能跑到 dest 外面
  assert.equal(fs.existsSync(path.join(root, 'evil.txt')), false);

  const capped = writeTmp(root, 'cap.zip', buildZip({ entries: [{ name: 'a.bin', data: Buffer.alloc(2048, 1) }] }));
  const r2 = await Z.safeExtractFile(capped, path.join(root, 'out-cap'), { maxEntries: 5, maxTotalBytes: 1024 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /体积超限/);

  const capped2 = await Z.safeExtractFile(capped, path.join(root, 'out-cap2'), { maxEntries: 0 + 1 });
  assert.equal(capped2.ok, true, '条目数 1 ≤ 上限 1 应通过');
});

/* ---------------- 6/7. 坏包与不支持的方法 ---------------- */
test('截断包 / 非 zip：返回 ok:false stage:check，不抛异常', async () => {
  const root = tmp();
  const good = buildZip({ entries: [{ name: 'a.txt', data: 'hello' }] });
  const truncated = writeTmp(root, 'trunc.zip', good.subarray(0, good.length - 8));
  const r1 = await Z.safeExtractFile(truncated, path.join(root, 'o1'));
  assert.equal(r1.ok, false);
  assert.equal(r1.stage, 'check');
  assert.match(r1.error, /读取压缩包条目失败/);

  const notZip = writeTmp(root, 'notzip.bin', Buffer.from('this is not a zip at all, just text.'.repeat(3)));
  const r2 = await Z.safeExtractFile(notZip, path.join(root, 'o2'));
  assert.equal(r2.ok, false);
  assert.equal(r2.stage, 'check');

  const missing = await Z.safeExtractFile(path.join(root, 'nope.zip'), path.join(root, 'o3'));
  assert.equal(missing.ok, false);
  assert.equal(missing.stage, 'check');
});

test('不支持的压缩方式：流式通道返回 stage:extract（调用方据此保留压缩包重试）', async () => {
  const root = tmp();
  // method 12 = bzip2，本解压器不支持
  const zipPath = writeTmp(root, 'bz.zip', buildZip({ entries: [{ name: 'a.txt', data: 'abc', method: 0 }] }));
  const { entries } = Z.readCentralDirectory(zipPath);
  entries[0].method = 12;
  await assert.rejects(
    () => Z.extractStream(zipPath, entries, path.join(root, 'out')),
    /不支持的压缩方式/,
  );
});

/* ---------------- 8. .oudep（OpenUTAU 依赖包，内容就是 zip） ---------------- */
test('safeExtractAllTo 仍能解 .oudep（按扩展名无关，内容即 zip）', () => {
  const root = tmp();
  const p = writeTmp(root, 'dep.oudep', buildZip({ entries: [{ name: 'k/oto.ini', data: 'oto' }] }));
  const out = path.join(root, 'out');
  const r = Z.safeExtractAllTo(p, out);
  assert.equal(r.ok, true, r.error);
  assert.equal(fs.readFileSync(path.join(out, 'k/oto.ini'), 'utf8'), 'oto');
});
