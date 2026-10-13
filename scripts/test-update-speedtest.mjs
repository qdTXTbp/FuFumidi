// ============================================================
// 线路测速纯函数（main/update-speedtest.js）的回归测试
// ------------------------------------------------------------
// 测速的「算错了」不会报错 —— 它只是显示成一个偏大或偏小的数字，用户据此换线路。
// 所以这里钉住三件事：
//   · 吞吐必须**扣掉首字节延迟**（把延迟算进吞吐是测速最常见的错）；
//   · 除零 / NaN / 乱序时间戳一律归 0，不许漏出 Infinity 或 NaN（会让排序整个乱掉）；
//   · 「最快」是速率优先、延迟兜底，不是只看速率。
// 用法：npm run test:speedtest
// ============================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ST from '../main/update-speedtest.js';

const { computeSpeedMBps, pickBest, orderCandidates, summarize, SPEEDTEST_BYTES } = ST;

test('吞吐：扣掉首字节延迟再算', () => {
  // 1 MiB，延迟 200ms，总耗时 1200ms → 传输窗口 1000ms → 1.00 MB/s
  assert.equal(Math.round(computeSpeedMBps(1048576, 200, 1200) * 100) / 100, 1);
  // 同一份数据不扣延迟会算成 0.83 MB/s —— 正是要避免的偏大/偏小
  assert.ok(computeSpeedMBps(1048576, 200, 1200) > computeSpeedMBps(1048576, 0, 1200));
});

test('吞吐：256 KB 的取样窗口也是真实速率', () => {
  const v = computeSpeedMBps(SPEEDTEST_BYTES, 50, 550);   // 256KB / 0.5s ≈ 0.5 MB/s
  assert.ok(Math.abs(v - 0.5) < 0.02, 'got ' + v);
});

test('吞吐：边界一律归 0，不许出现 NaN / Infinity', () => {
  for (const args of [[0, 10, 100], [-5, 10, 100], [100, 50, 50], [100, 100, 40], [NaN, 1, 1], [100, NaN, 1], [100, 1, NaN]]) {
    const v = computeSpeedMBps(args[0], args[1], args[2]);
    assert.ok(Number.isFinite(v) && v >= 0, args.join(',') + ' → ' + v);
  }
});

test('最快：速率优先，速率相同看延迟；没有可用项返回空串', () => {
  const rows = [
    { id: 'slow', ok: true, speedMBps: 1, latencyMs: 10 },
    { id: 'fast-a', ok: true, speedMBps: 5, latencyMs: 400 },
    { id: 'fast-b', ok: true, speedMBps: 5, latencyMs: 30 },
    { id: 'dead', ok: false, speedMBps: 99, latencyMs: 1 },
  ];
  assert.equal(pickBest(rows), 'fast-b');
  assert.equal(pickBest([{ id: 'x', ok: false }]), '');
  assert.equal(pickBest([]), '');
  assert.equal(pickBest(null), '');
});

test('首选线路：提到最前，其余顺序不动（回退链保留）', () => {
  const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(orderCandidates(list, 'c').map(x => x.id), ['c', 'a', 'b']);
  assert.deepEqual(orderCandidates(list, 'a').map(x => x.id), ['a', 'b', 'c']);
  assert.deepEqual(orderCandidates(list, '').map(x => x.id), ['a', 'b', 'c']);
  assert.deepEqual(orderCandidates(list, 'nope').map(x => x.id), ['a', 'b', 'c']);
  assert.deepEqual(list.map(x => x.id), ['a', 'b', 'c']);   // 不改原数组
});

test('汇总：可用优先、速率降序，并只标一条最快', () => {
  const out = summarize([
    { id: 'dead', ok: false, speedMBps: 0, latencyMs: null },
    { id: 'slow', ok: true, speedMBps: 0.2, latencyMs: 90 },
    { id: 'fast', ok: true, speedMBps: 4.0, latencyMs: 120 },
  ]);
  assert.deepEqual(out.map(r => r.id), ['fast', 'slow', 'dead']);
  assert.equal(out.filter(r => r.best).length, 1);
  assert.equal(out[0].best, true);
  assert.equal(out[2].best, false);                        // 不可达的永远不是最快
});
