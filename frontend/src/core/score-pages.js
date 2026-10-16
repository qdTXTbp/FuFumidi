/**
 * 变谱结果里「哪些页该给『重试该页』」——纯函数，单独放一份是为了能单测
 * （组件里的 computed 拿不到测试环境；这段逻辑直接决定按钮出现在哪几页上）。
 *
 * @param {any} info 引擎回的结果（用 pageTotal 表示这次提交的总页数）
 * @param {number[]} donePages 已经有逐页结果的页号（含分带页，同一页可能出现多次）
 * @returns {number[]} 没解析出音符的页号（升序）
 */
export function retryablePages(info, donePages) {
  const total = Number((info && info.pageTotal) || 0);
  // 单页输入没有「其余页沿用上次结果」的意义，整批就是那一页 —— 不给按钮
  if (!total || total < 2) return [];
  const done = new Set((donePages || []).map((n) => Number(n) || 0));
  const out = [];
  for (let i = 1; i <= total; i++) if (!done.has(i)) out.push(i);
  return out;
}

/** 结果里的页数摘要（「2 页 / 共 3 页」用）：只报**真的解析出音符**的页数。 */
export function pagesSummary(info) {
  const total = Number((info && info.pageTotal) || 0);
  const ok = Number((info && info.pages) || 0);
  if (!total) return '';
  return ok < total ? ok + ' / ' + total : String(total);
}
