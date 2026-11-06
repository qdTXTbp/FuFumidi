// ============================================================
// 模型下载状态机（纯函数，不依赖 Vue / i18n / 桥）
//
// 为什么单独成模块：ViewModels（资源中心卡片/抽屉）与 ModelCatalog（调教页）
// 共用同一套下载状态；放进 SFC 里只能靠人眼保证一致，也没法用 node --test 覆盖。
//
// 输入：
//   · model_list() 条目（Tauri 契约）：size/exists/parts/partSizes/minSize/downloadable…
//   · model:progress 事件：{ id, received, total, percent, done, speed, text, paused?, canceled?, error? }
//   · model_download() 返回值：{ ok, paused?, canceled?, error? }
// 输出：界面直接渲染的 `prog[id]` 条目与三态判定。
//
// ★ 暂停 / 取消是**用户意图**，不是失败：
//   · paused   → 保留断点，点「继续」用同一个 modelDownload 重入续传；
//   · canceled → 允许重新点下载（后端若保留 .part 会续传）。
// ============================================================

/** 下载态（界面据此显示三态按钮） */
export const DL = Object.freeze({
  IDLE: 'idle',            // 未下载
  DOWNLOADING: 'downloading',
  PAUSED: 'paused',
  FAILED: 'failed',
  INSTALLED: 'installed',
});

function positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 清单总大小：分卷 partSizes 求和 > 已声明 size > minSize。
 *  返回 { bytes, isMin, source }；isMin=true 表示只能给出下界（界面加 ≥）。 */
export function manifestBytes(item) {
  if (!item) return { bytes: 0, isMin: false, source: '' };
  const parts = positive(item.parts);
  const sizes = Array.isArray(item.partSizes) ? item.partSizes : [];
  if (parts > 0 && sizes.length === parts) {
    let sum = 0;
    for (const s of sizes) sum += positive(s);
    if (sum > 0) return { bytes: sum, isMin: false, source: 'parts' };
  }
  // totalSize = 清单里声明的总量（Tauri model_service 提供）；size 对
  // marker 型模型只是标记文件大小，未下载时恒为 0，不能当清单大小用。
  const total = positive(item.totalSize);
  if (total > 0) return { bytes: total, isMin: false, source: 'totalSize' };
  const size = positive(item.size);
  if (size > 0) return { bytes: size, isMin: false, source: 'size' };
  const min = positive(item.minSize);
  if (min > 0) return { bytes: min, isMin: true, source: 'minSize' };
  return { bytes: 0, isMin: false, source: '' };
}

/** 界面上该给出的体积：
 *  · 下载中/暂停中 → 用进度的 total（或已收）
 *  · 已安装 → 用磁盘实际 size
 *  · 未下载 → 清单大小 / minSize（**绝不再显示 0**）
 * 返回 { bytes, received, isMin, live }。 */
export function expectedBytes(item, entry) {
  const live = !!(entry && (entry.active || entry.paused));
  if (live && (positive(entry.total) || positive(entry.received))) {
    return { bytes: positive(entry.total) || positive(entry.received), received: positive(entry.received), isMin: false, live: true };
  }
  if (item && item.exists) {
    const size = positive(item.size);
    const min = positive(item.minSize);
    // 已安装但 size 只是标记文件（marker 型）时，退回清单总量，别显示几百字节
    if (size > 0 && (!min || size >= min)) return { bytes: size, received: 0, isMin: false, live: false };
    const total = positive(item.totalSize);
    return { bytes: total || size, received: 0, isMin: false, live: false };
  }
  const m = manifestBytes(item);
  return { bytes: m.bytes, received: 0, isMin: m.isMin, live: false };
}

/** 三态判定。已安装优先于陈旧的失败记录；本地进度优先于 model_list 的 active。 */
export function downloadState(item, entry) {
  if (entry && entry.active) return DL.DOWNLOADING;
  if (entry && entry.paused) return DL.PAUSED;
  // 已安装优先于陈旧的失败记录：重新下载失败不该把「能用的模型」显示成未安装
  if (item && item.exists) return DL.INSTALLED;
  // 刚下完、列表还没刷新回来：先显示「已安装」，避免闪一下「未安装」
  if (entry && entry.done) return DL.INSTALLED;
  if (entry && entry.error) return DL.FAILED;
  return DL.IDLE;
}

/** 点「下载/继续/重试」时的初始条目：暂停后重入保留已收字节，界面不跳回 0%。 */
export function beginEntry(prev) {
  const base = prev || {};
  const resume = !!base.paused;
  return {
    ...(resume ? base : {}),
    active: true,
    paused: false,
    done: false,
    canceled: false,
    error: '',
    text: '',
    speed: 0,
    percent: resume ? positive(base.percent) : 0,
    received: resume ? positive(base.received) : 0,
    total: resume ? positive(base.total) : 0,
    pauseReq: false,
    cancelReq: false,
  };
}

/** 点了「暂停」：先乐观落成暂停态（后端 abort 到返回之间还会有一两个进度事件）。 */
export function markPauseRequested(prev) {
  return { ...(prev || {}), pauseReq: true, active: false, paused: true, speed: 0 };
}

/** 点了「取消」：先落成取消态，防止迟到的进度事件把界面翻回「下载中」。 */
export function markCancelRequested(prev) {
  return { ...(prev || {}), cancelReq: true, active: false, paused: false, canceled: true, speed: 0 };
}

/** 合并一条 model:progress 进度。paused / canceled 事件不是错误。 */
export function applyProgress(prev, p) {
  const cur = prev || {};
  const next = { ...cur, ...(p || {}) };
  next.percent = Math.max(0, Math.min(100, Math.round(positive(p && p.percent))));
  next.speed = positive(p && p.speed);
  next.received = positive(p && p.received);
  next.total = positive(p && p.total);
  if (p && p.done) {
    next.active = false; next.paused = false; next.done = true;
    next.canceled = false; next.error = ''; next.percent = 100; next.speed = 0;
  } else if (p && p.paused) {
    // 暂停/取消/失败事件带的 received/total 常常是 0：保留最后已知进度，进度条不跳回 0
    next.percent = Math.max(0, Math.min(100, Math.round(positive(cur.percent))));
    next.active = false; next.paused = true; next.done = false;
    next.canceled = false; next.error = ''; next.text = String(p.error || p.text || '');
  } else if (p && (p.canceled || /^canceled$/i.test(String(p.error || '')))) {
    next.percent = Math.max(0, Math.min(100, Math.round(positive(cur.percent))));
    next.active = false; next.paused = false; next.done = false;
    next.canceled = true; next.error = '';
  } else if (p && p.error) {
    next.percent = Math.max(0, Math.min(100, Math.round(positive(cur.percent))));
    next.active = false; next.paused = false; next.done = false;
    next.canceled = false; next.error = String(p.error);
  } else if (cur.pauseReq) {
    // 暂停请求已发出：迟到的普通进度不把界面翻回下载中
    next.active = false; next.paused = true;
  } else if (cur.cancelReq) {
    next.active = false; next.paused = false; next.canceled = true;
  } else {
    next.active = true; next.paused = false; next.done = false;
    next.canceled = false; next.error = ''; next.text = String((p && p.text) || '');
  }
  return next;
}

/** 合并 modelDownload() 的终态。paused / canceled 不是失败。 */
export function applyResult(prev, r) {
  const next = { ...(prev || {}) };
  // 调用方 catch 到异常时可能直接把 Error 传进来：也要落成「下载失败」，不能当成成功。
  const isErr = !!(r && typeof r === 'object' && r.ok === undefined && typeof r.message === 'string' && r.path === undefined && r.size === undefined);
  const error = String((r && (r.error || (isErr ? r.message : ''))) || '');
  const canceled = !!(r && (r.canceled || /^canceled$/i.test(error)));
  if (r && r.paused) {
    next.active = false; next.paused = true; next.done = false;
    next.canceled = false; next.error = ''; next.text = error || next.text || '';
  } else if (canceled) {
    next.active = false; next.paused = false; next.done = false;
    next.canceled = true; next.error = ''; next.percent = 0; next.speed = 0;
  } else if (!r || r.ok === false || isErr) {
    next.active = false; next.paused = false; next.done = false;
    next.canceled = false; next.error = error || String(next.error || '') || 'download failed';
  } else {
    next.active = false; next.paused = false; next.done = true;
    next.canceled = false; next.error = ''; next.percent = 100; next.speed = 0;
  }
  return next;
}
