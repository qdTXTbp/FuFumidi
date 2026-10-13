// 线路测速的**呈现层**纯逻辑：格式化 + 按 id 合并流式结果 + 标最快。
//
// 为什么值得单测：这些函数错了不会抛异常，只会显示成「0 ms」/「NaN MB/s」，
// 而用户是**看着这两个数换线路**的（参考 FufuLauncher 的节点列表 +「 MB/s」）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatLatency, formatSpeed, pendingRow, mergeRow, markBest } from '../src/core/speedtest.js';

const src = (id) => ({ id, label: id, kind: 'mirror', channel: 'stable' });

test('延迟：未测是省略号 / 测过取整 / 不可达是破折号', () => {
  assert.equal(formatLatency({ pending: true }), '…');
  assert.equal(formatLatency({ ok: true, latencyMs: 12.4 }), '12 ms');
  assert.equal(formatLatency({ ok: true, latencyMs: null }), '—');
  assert.equal(formatLatency({ ok: false, latencyMs: 30 }), '—');
  assert.equal(formatLatency(null), '—');
});

test('速率：保留两位；0.00 也是有效信息（说明这条路几乎不通）', () => {
  assert.equal(formatSpeed({ ok: true, speedMBps: 1.234 }), '1.23 MB/s');
  assert.equal(formatSpeed({ ok: true, speedMBps: 0 }), '0.00 MB/s');
  assert.equal(formatSpeed({ ok: false }), '—');
  assert.equal(formatSpeed({ ok: true, speedMBps: NaN }), '—');
});

test('pendingRow：先铺出整张表，测一条亮一条', () => {
  const r = pendingRow(src('ghfast'));
  assert.equal(r.id, 'ghfast');
  assert.equal(r.pending, true);
  assert.equal(r.ok, false);
  assert.equal(r.speedMBps, 0);
});

test('★ 按 id 覆盖而不是按顺序 —— 测速是并发的，回来顺序 ≠ 列表顺序', () => {
  let rows = [pendingRow(src('a')), pendingRow(src('b')), pendingRow(src('c'))];
  rows = mergeRow(rows, { id: 'c', ok: true, speedMBps: 3, latencyMs: 50 });
  rows = mergeRow(rows, { id: 'a', ok: true, speedMBps: 1, latencyMs: 20 });
  assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c']);        // 位置不动
  assert.equal(rows.find(r => r.id === 'a').speedMBps, 1);       // 值落到自己那行
  assert.equal(rows.find(r => r.id === 'c').ok, true);
  assert.equal(rows.find(r => r.id === 'b').pending, true);      // b 还没回来
});

test('最快：速率优先、延迟兜底', () => {
  let rows = [pendingRow(src('a')), pendingRow(src('b'))];
  rows = mergeRow(rows, { id: 'a', ok: true, speedMBps: 2.0, latencyMs: 300 });
  rows = mergeRow(rows, { id: 'b', ok: true, speedMBps: 2.0, latencyMs: 40 });
  assert.equal(rows.find(r => r.id === 'b').best, true);
  assert.equal(rows.find(r => r.id === 'a').best, false);
});

test('没有可用线路时不标任何一条', () => {
  const rows = markBest([{ id: 'a', ok: false }, { id: 'b', ok: false }]);
  assert.equal(rows.every(r => !r.best), true);
});
