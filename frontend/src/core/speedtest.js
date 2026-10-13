// ============================================================
// 线路测速的**呈现层**纯函数（网络与测速在主进程，见 main/update-speedtest.js）
//
// 单独一层是为了能单测：`formatLatency/formatSpeed` 出错不会报错，
// 只会显示成「0 ms」或「NaN MB/s」——用户据此换线路。
//
// 参考（REA 取证，docs/REA-installer-and-updater.md）：
//   · FufuLauncher 的更新器：节点列表 + 「正在测速中…」+「 MB/s」列 + 失败切回 GitHub；
//   · BetterGI：并发试各线路后取最快（GetFastestProxyAsync）。
// ============================================================

/** 延迟显示：未测 = —，测过 = 整数 ms，不可达 = 不可达 */
export function formatLatency(row) {
  if (!row || row.ok !== true) return row && row.pending ? '…' : '—'
  // ★ 必须先挡 null/undefined 再 Number()：Number(null) === 0，
  //   主进程用 null 表示「没测到」，被当成 0 ms 会显示成零延迟（测试抓到的）。
  if (row.latencyMs == null) return '—'
  const ms = Number(row.latencyMs)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  return Math.round(ms) + ' ms'
}

/** 速率显示：保留两位（0.00 也是有效信息 —— 说明这条路几乎不通） */
export function formatSpeed(row) {
  if (!row || row.ok !== true) return '—'
  if (row.speedMBps == null) return '—'   // 同上：null 不是 0
  const v = Number(row.speedMBps)
  if (!Number.isFinite(v) || v < 0) return '—'
  return v.toFixed(2) + ' MB/s'
}

/** 还没测的行（按线路清单先铺出来，测一条亮一条） */
export function pendingRow(src) {
  return { id: src.id, label: src.label, kind: src.kind, channel: src.channel, ok: false, pending: true, latencyMs: null, speedMBps: 0 }
}

/**
 * 把流式回来的单条结果并进表格。
 *
 * ★ 按 id 覆盖，不按顺序 —— 测速是并发的，回来顺序不等于列表顺序；
 *   按顺序写会把结果串行（真实踩过：第 3 条的结果盖到第 1 行上）。
 */
export function mergeRow(rows, row) {
  const list = Array.isArray(rows) ? rows.slice() : []
  const i = list.findIndex(r => r && r.id === row.id)
  const merged = Object.assign({ pending: false }, row)
  if (i >= 0) list[i] = Object.assign({}, list[i], merged)
  else list.push(merged)
  return markBest(list)
}

/** 标出最快那条（与主进程 pickBest 同一判据：可用优先 → 速率 → 延迟） */
export function markBest(rows) {
  const list = (rows || []).map(r => Object.assign({}, r, { best: false }))
  const ok = list.filter(r => r.ok)
  if (!ok.length) return list
  const score = r => (Number.isFinite(r.speedMBps) ? r.speedMBps : 0)
  const lat = r => (Number.isFinite(r.latencyMs) ? r.latencyMs : 1e9)
  const best = ok.slice().sort((x, y) => (score(y) - score(x)) || (lat(x) - lat(y)))[0]
  const hit = list.find(r => r.id === best.id)
  if (hit) hit.best = true
  return list
}
