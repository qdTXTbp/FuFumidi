// ============================================================
// 资源下载唯一入口（main/fast-download.js）的回归测试
// ------------------------------------------------------------
// 全部**不联网**：用本地 HTTP 服务模拟三种真实源的行为
//   ① 支持 Range 的源（对象存储 / Release 资产）
//   ② 忽略 Range、也不返回 content-length 的源（CNB 的 git raw，实测就是这个行为）
//   ③ 中途卡住不发的源（停滞看门狗）
// 覆盖：纯逻辑（分段计划 / 源排序 / 分卷尺寸）、分段下载、单连接回退、断点续传、
//       完整性（声明长度不足必须抛错）、取消保断点、多文件并发聚合进度、磁盘预检。
// 用法：npm run test:download
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const createFastDownload = require('../main/fast-download.js');
const pure = createFastDownload.pure;

const FastDL = createFastDownload({ net: { fetch: (...a) => fetch(...a) }, fs, path });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'fu-dl-test-'));

/** 造一个可重复的确定性负载（避免随机数据拖慢测试） */
function payload(size) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 31 + (i >> 8)) & 0xff;
  return buf;
}

/** 起一个本地源；handler 决定怎么响应，log 记录收到的请求头 */
async function serve(handler) {
  const log = [];
  const server = http.createServer((req, res) => {
    log.push({ url: req.url, range: req.headers.range || '' });
    handler(req, res, log.length);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { url: 'http://127.0.0.1:' + port + '/f.bin', log, close: () => new Promise((r) => server.close(r)) };
}

/** 支持 Range 的源 */
function rangeHandler(body) {
  return (req, res) => {
    const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (!m) {
      res.writeHead(200, { 'content-length': body.length, 'accept-ranges': 'bytes' });
      res.end(body);
      return;
    }
    const start = parseInt(m[1], 10);
    const end = m[2] ? Math.min(parseInt(m[2], 10), body.length - 1) : body.length - 1;
    const slice = body.subarray(start, end + 1);
    res.writeHead(206, {
      'content-length': slice.length,
      'content-range': 'bytes ' + start + '-' + end + '/' + body.length,
      'accept-ranges': 'bytes',
    });
    res.end(slice);
  };
}

const dest = (name) => path.join(TMP, name);

// ---------------------------------------------------------------
// 一、纯逻辑
// ---------------------------------------------------------------
test('planSegments：小文件单连接，慢源多开，快源少开', () => {
  assert.equal(pure.planSegments(1024 * 1024, 10).segCount, 1, '1MB 不分段');
  assert.equal(pure.planSegments(64 * 1024 * 1024, 1).segCount, 8, '慢源（1MB/s）开 8 段');
  assert.equal(pure.planSegments(64 * 1024 * 1024, 30).segCount, 4, '快源（30MB/s）开 4 段');
  assert.equal(pure.planSegments(64 * 1024 * 1024, 1, { segMax: 3 }).segCount, 3, 'segMax 生效');
  const p = pure.planSegments(64 * 1024 * 1024, 1);
  assert.ok(p.concurrency >= 1 && p.concurrency <= p.segCount, '并发不超过段数');
});

test('orderByHostRank：按实测速度重排，未知 host 排最后且保持相对顺序', () => {
  const urls = ['https://slow.com/a', 'https://fast.com/b', 'https://unknown.com/c', 'https://mid.com/d'];
  const rank = [{ host: 'fast.com', mbps: 30 }, { host: 'mid.com', mbps: 10 }, { host: 'slow.com', mbps: 1 }];
  assert.deepEqual(pure.orderByHostRank(urls, rank), [
    'https://fast.com/b', 'https://mid.com/d', 'https://slow.com/a', 'https://unknown.com/c',
  ]);
  assert.deepEqual(pure.orderByHostRank(urls, []), urls, '没有测速表就原样返回');
});

test('expectedPartSize：固定 25MiB 切片，末卷为余数，且求和等于总大小', () => {
  const total = 411888600;      // muscriptor/small 的真实大小
  const parts = 16;
  assert.equal(pure.expectedPartSize(total, parts, 1), 25 * 1024 * 1024, '首卷 25MiB');
  assert.equal(pure.expectedPartSize(total, parts, 16), total - 15 * 25 * 1024 * 1024, '末卷余数');
  let sum = 0;
  for (let i = 1; i <= parts; i++) sum += pure.expectedPartSize(total, parts, i);
  assert.equal(sum, total, '各卷求和 == manifest.size');
  assert.ok(pure.partsLayoutOk(total, parts));
  assert.equal(pure.expectedPartSize(total, 0, 1), 0, '清单不可用时返回 0（表示不校验）');
});

test('totalOfHeaders：优先 content-range，其次 content-length', () => {
  const h = (o) => ({ get: (k) => o[k] });
  assert.equal(pure.totalOfHeaders(h({ 'content-range': 'bytes 0-0/913106900' })), 913106900);
  assert.equal(pure.totalOfHeaders(h({ 'content-length': '26214400' })), 26214400);
  assert.equal(pure.totalOfHeaders(h({})), 0, 'CNB 的 git raw 两种头都没有');
});

// ---------------------------------------------------------------
// 二、分段下载（源支持 Range）
// ---------------------------------------------------------------
test('downloadFast：支持 Range 的源走分段，字节完全一致', async () => {
  const body = payload(6 * 1024 * 1024);
  const srv = await serve(rangeHandler(body));
  try {
    const out = dest('seg.bin');
    const r = await FastDL.downloadFast({ urls: [srv.url], dest: out, minSize: 1024, expectSize: body.length });
    assert.ok(r.segments > 1, '应当分段下载，实际 segments=' + r.segments);
    assert.equal(r.size, body.length);
    assert.deepEqual(fs.readFileSync(out), body, '分段合并后的字节必须与源一致');
  } finally { await srv.close(); }
});

test('downloadFast：源忽略 Range（CNB git raw 行为）时退回单连接且仍校验大小', async () => {
  const body = payload(1024 * 1024);
  // 忽略 Range：无论请求什么 Range 都返回 200 + 完整正文，且不带 content-length（chunked）
  const srv = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(body); });
  try {
    const out = dest('cnb.bin');
    const r = await FastDL.downloadFast({ urls: [srv.url], dest: out, minSize: 1024, expectSize: body.length });
    assert.equal(r.segments, 1, '不支持 Range 就不能分段');
    assert.deepEqual(fs.readFileSync(out), body);
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------
// 三、断点续传
// ---------------------------------------------------------------
test('downloadFast：已有 .part 时用 Range 续传，不重下已完成的字节', async () => {
  const body = payload(1024 * 1024);
  const srv = await serve(rangeHandler(body));
  const out = dest('resume.bin');
  try {
    const have = 400 * 1024;
    fs.writeFileSync(out + '.part', body.subarray(0, have));
    const r = await FastDL.downloadFast({ urls: [srv.url], dest: out, minSize: 1024, expectSize: body.length });
    assert.equal(r.size, body.length);
    assert.deepEqual(fs.readFileSync(out), body, '续传后的文件必须完整');
    assert.ok(srv.log.some((x) => x.range === 'bytes=' + have + '-'), '应当从断点位置发起 Range 请求');
  } finally { await srv.close(); }
});

test('downloadFast：声明长度不足必须抛错，且不留下正式文件', async () => {
  const body = payload(512 * 1024);
  const srv = await serve(rangeHandler(body));
  const out = dest('short.bin');
  try {
    await assert.rejects(
      () => FastDL.downloadFast({ urls: [srv.url], dest: out, minSize: 1024, expectSize: 4 * 1024 * 1024 }),
      /大小不符|下载失败/,
      '期望 4MB 只拿到 512KB，必须报错而不是当成功'
    );
    assert.equal(fs.existsSync(out), false, '半成品绝不能出现在正式路径上');
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------
// 四、取消 / 停滞
// ---------------------------------------------------------------
test('downloadFast：取消抛 err.cancelled 且保留断点', async () => {
  // 前 3MB 不限速（让 1.5MB 的测速探测秒过），之后每块 15ms —— 保证 abort 落在正文下载中
  const body = payload(8 * 1024 * 1024);
  const srv = await serve(async (req, res) => {
    res.writeHead(200, { 'content-length': body.length });
    for (let off = 0; off < body.length; off += 64 * 1024) {
      res.write(body.subarray(off, off + 64 * 1024));
      if (off > 3 * 1024 * 1024) await new Promise((r) => setTimeout(r, 15));
    }
    res.end();
  });
  const out = dest('cancel.bin');
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 400);
    await assert.rejects(
      () => FastDL.downloadFast({ urls: [srv.url], dest: out, minSize: 1024, ctrl }),
      (e) => e && e.cancelled === true,
      '取消必须抛 cancelled 标记，便于上层区分「用户取消」与「网络失败」'
    );
    assert.ok(fs.existsSync(out + '.part'), '取消后断点必须保留');
  } finally { await srv.close(); }
});

test('fetchGuarded：停滞看门狗在无字节时中断连接', async () => {
  const srv = await serve((req, res) => {
    res.writeHead(200, { 'content-length': 1024 * 1024 });
    res.write(Buffer.alloc(1024));   // 发一点，然后彻底不动
  });
  try {
    const gd = await FastDL.fetchGuarded(srv.url, { stallMs: 300, connectMs: 3000 });
    await assert.rejects(async () => { for (;;) { const { done } = await gd.reader.read(); if (done) break; } });
    gd.cleanup();
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------
// 五、多文件并发 + 预检
// ---------------------------------------------------------------
test('downloadMany：多文件并发下载，聚合进度到 100%', async () => {
  const files = [0, 1, 2, 3].map((i) => ({ name: 'many-' + i + '.bin', body: payload(256 * 1024 + i) }));
  const srv = await serve((req, res, n) => {
    const f = files.find((x) => req.url.includes(x.name));
    if (!f) { res.writeHead(404); res.end(); return; }
    rangeHandler(f.body)(req, res, n);
  });
  try {
    const seen = [];
    const items = files.map((f) => ({
      urls: [srv.url.replace('/f.bin', '/' + f.name)],
      dest: dest(f.name), minSize: 1024, expectSize: f.body.length, label: f.name,
    }));
    const done = await FastDL.downloadMany(items, { concurrency: 2, onProgress: (p) => seen.push(p) });
    for (const f of files) assert.deepEqual(fs.readFileSync(dest(f.name)), f.body, f.name + ' 内容必须正确');
    assert.equal(done.length, files.length, '每个文件都要有结果');
    const last = seen[seen.length - 1];
    assert.equal(last.doneCount, files.length, '最后一个进度事件应表明全部文件下载完成');
    assert.equal(last.bytesDone, last.bytesTotal, '已完成字节数应等于总字节数');
    assert.ok(last.overallPercent >= 99, '总进度应到 99%（100% 留给调用方的合并/校验阶段）');
    assert.ok(seen.every((p, i) => i === 0 || p.overallPercent >= seen[i - 1].overallPercent), '总进度不许回退');
  } finally { await srv.close(); }
});

// ---------------------------------------------------------------
// 六、传输层回退（Node fetch ⇄ Chromium net.fetch）
//   实测背景：CNB 协商 h2，Chromium 走 h2 只有 0.28MB/s，Node 走 HTTP/1.1 有 26MB/s。
//   所以默认 Node 优先、Chromium 兜底；两条通道任一不通都必须能自动换。
// ---------------------------------------------------------------
test('传输层：Node fetch 不通时自动回退 Chromium net.fetch', async () => {
  const body = payload(300 * 1024);
  const srv = await serve(rangeHandler(body));
  try {
    const dl = createFastDownload({
      net: { fetch: (...a) => fetch(...a) },
      nodeFetch: () => { throw new Error('node 通道不可用'); },
      fs, path,
    });
    const out = dest('tp-chromium.bin');
    const r = await dl.downloadFast({ urls: [srv.url], dest: out, minSize: 1024, expectSize: body.length });
    assert.equal(r.size, body.length);
    assert.deepEqual(fs.readFileSync(out), body, '回退到 Chromium 通道后内容必须正确');
  } finally { await srv.close(); }
});

test('传输层：Chromium 不通时用 Node fetch', async () => {
  const body = payload(300 * 1024);
  const srv = await serve(rangeHandler(body));
  try {
    const dl = createFastDownload({
      net: { fetch: () => { throw new Error('chromium 通道不可用'); } },
      nodeFetch: (...a) => fetch(...a),
      fs, path,
    });
    const out = dest('tp-node.bin');
    const r = await dl.downloadFast({ urls: [srv.url], dest: out, minSize: 1024, expectSize: body.length });
    assert.equal(r.size, body.length);
    assert.deepEqual(fs.readFileSync(out), body, 'Node 通道内容必须正确');
  } finally { await srv.close(); }
});

test('传输层：两条都不通时抛错，且不是 cancelled', async () => {
  const body = payload(64 * 1024);
  const srv = await serve(rangeHandler(body));
  try {
    const dl = createFastDownload({
      net: { fetch: () => { throw new Error('chromium 不通'); } },
      nodeFetch: () => { throw new Error('node 不通'); },
      fs, path,
    });
    await assert.rejects(
      () => dl.downloadFast({ urls: [srv.url], dest: dest('tp-none.bin'), minSize: 1024 }),
      (e) => !e.cancelled && /不通|HTTP/.test(String(e.message)),
    );
  } finally { await srv.close(); }
});

test('checkDiskSpace：空间不够时提前抛错', () => {
  assert.throws(() => FastDL.checkDiskSpace(dest('x.bin'), 1024 ** 5), /磁盘空间不足/);
  assert.doesNotThrow(() => FastDL.checkDiskSpace(dest('x.bin'), 1024));
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
