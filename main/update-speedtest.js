// ============================================================
// 线路测速的**纯函数**部分（网络在 main/update.js 里，这里只算数与排序）
//
// 为什么单独一层：
//   测速的「算错了」不会报错 —— 它只是显示成一个偏大或偏小的数字，
//   用户据此换了线路。所以这部分必须能脱离网络单测。
//
// 参考实现（REA 取证，见 docs/REA-installer-and-updater.md）：
//   · BetterGI：`Helpers.Http.ProxySpeedTester` 的 `TestUrlAsync` 取一个小文件量时间，
//     `GetFastestProxyAsync` 并发试所有线路后取最快；
//   · FufuLauncher：`UpdateFufuLauncher.exe` 列表选节点 + 「正在测速中…」+「 MB/s」，
//     下载失败自动切回 GitHub 线路。
// ============================================================
"use strict";

//: 只取这么多字节就断开 —— 测速不该把 150 MB 的安装包下完
const SPEEDTEST_BYTES = 256 * 1024;
//: 单个源的总超时（连不上的源不该拖住整张表）
const SPEEDTEST_TIMEOUT_MS = 15000;

/**
 * 吞吐 = 字节数 ÷ **扣掉首字节延迟之后**的耗时。
 *
 * 把延迟算进吞吐是测速里最常见的错：高延迟低带宽的线路会显得比实际快。
 * 边界：非有限/负数一律归 0（宁可显示 0 也不要 NaN —— NaN 会让排序整个乱掉）。
 */
function computeSpeedMBps(bytes, ttfbMs, elapsedMs) {
  const b = Number(bytes), t = Number(ttfbMs), e = Number(elapsedMs);
  if (!Number.isFinite(b) || !Number.isFinite(t) || !Number.isFinite(e)) return 0;
  if (b <= 0) return 0;
  const xferMs = e - t;
  // 传输窗口不足 1 ms（或时间戳乱序）时按 1 ms 算，避免除以 0 得到 Infinity
  const win = xferMs >= 1 ? xferMs : 1;
  const v = b / 1048576 / (win / 1000);
  return Number.isFinite(v) ? v : 0;
}

/**
 * 最快的那条：先看可用，再看速率，最后用延迟兜底。
 *
 * 不按「速率最高」一条道走到黑 —— 有线路速率相近但延迟相差十倍，
 * 拿它下载小文件反而更慢。返回 id，没有可用项返回空串。
 */
function pickBest(rows) {
  const ok = (rows || []).filter(r => r && r.ok);
  if (!ok.length) return "";
  const score = (r) => (Number.isFinite(r.speedMBps) ? r.speedMBps : 0);
  const lat = (r) => (Number.isFinite(r.latencyMs) ? r.latencyMs : 1e9);
  const best = ok.slice().sort((a, b) => (score(b) - score(a)) || (lat(a) - lat(b)))[0];
  return best.id || "";
}

/** 把「首选线路」提到最前（其余保持原有优先级，作为回退链）。 */
function orderCandidates(list, preferredId) {
  const arr = Array.isArray(list) ? list.slice() : [];
  if (!preferredId) return arr;
  const i = arr.findIndex(s => s && s.id === preferredId);
  if (i <= 0) return arr;
  return [arr[i], ...arr.slice(0, i), ...arr.slice(i + 1)];
}

/** 汇总测速结果：补上 best 标记，并按「可用优先、速率降序」排好给界面。 */
function summarize(rows) {
  const bestId = pickBest(rows);
  const list = (rows || []).map(r => Object.assign({}, r, { best: !!r && r.ok && r.id === bestId }));
  return list.sort((a, b) => {
    if (!!a.ok !== !!b.ok) return a.ok ? -1 : 1;
    const sa = Number.isFinite(a.speedMBps) ? a.speedMBps : -1;
    const sb = Number.isFinite(b.speedMBps) ? b.speedMBps : -1;
    if (sb !== sa) return sb - sa;
    const la = Number.isFinite(a.latencyMs) ? a.latencyMs : 1e9;
    const lb = Number.isFinite(b.latencyMs) ? b.latencyMs : 1e9;
    return la - lb;
  });
}

module.exports = { SPEEDTEST_BYTES, SPEEDTEST_TIMEOUT_MS, computeSpeedMBps, pickBest, orderCandidates, summarize };
