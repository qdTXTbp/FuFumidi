'use strict';
// ============================================================
// 资源下载唯一入口（主进程）
// ------------------------------------------------------------
// 【规范 · 不可绕过】FuFumidi 里所有「从网络取文件」的代码都必须走这个模块，
// 不允许在别处再写 fetch / 流式写盘的下载循环。规范正文见 docs/DOWNLOADS.md，
// 门禁见 scripts/test-fast-download.mjs —— 新增下载点必须同时补用例。
//
// 为什么收敛成一个入口：历史上每个模块各写一份下载器，每份只解决了自己踩到的
// 那个坑 —— models.js 有测速没低速轮换、diffsinger.js 有分段没完整性、
// soundfonts.js 有看门狗没测速、wallpaper.js 连续传都没有。结果就是
// 「有时 50MB/s、有时几百 KB」「下一半就断」「下完打不开」反复出现。
// 这一份把九件事一次性做全，调用方只管给 URL 列表和目标路径：
//
//   ① 多源并发测速   各候选源先取一小段计时，永远从实测最快的源开始
//   ② 分段并发       源支持 Range（206）时切 N 段并行；对象存储/Release 单连接普遍被限速
//   ③ 多文件并发     downloadMany：几十个分卷/文件并行拉（实测 4 路 13.8MB/s → 12 路 25MB/s）
//   ④ 断点续传       单连接路径保留 .part 用 Range 续；分段路径每段独立落盘，天然可续
//   ⑤ 停滞看门狗     按「实际收到字节」计时，N 秒无字节即中止当前连接并换源
//   ⑥ 低速轮换       已过热身仍低于 LOW_BPS 的源被主动放弃 —— 「有时飞快有时龟速」的解法
//   ⑦ 完整性         期望长度 expectSize / 远端声明长度 / 最小体积 三重校验，
//                    不符即抛错并丢弃，绝不把半成品当成功
//   ⑧ 取消 / 暂停    统一 (isUserAbort, ctrl) 契约，中止时抛 err.cancelled = true
//   ⑨ 磁盘预检       checkDiskSpace：空间不够在动手前就报，不等到 90% 才失败
//
// 两条实测得到的事实（写死在常量里，改之前先跑 scripts/bench-download.mjs）：
//   · CNB 的 git raw 端点**不支持 Range、不返回 content-length**（chunked），
//     所以走它的单文件只能单连接（~6.7MB/s），提速只能靠「多文件并发」；
//   · Models 仓库的分卷是**固定 25 MiB 切片**（最后一卷为余数），
//     因此每卷的期望字节数可由 manifest 的 size/parts 直接推导，见 expectedPartSize()。
// ============================================================

const UA_DEFAULT = 'FuFumidi';

const SEG_MAX = 8;                        // 最多分段数
const SEG_MIN_BYTES = 4 * 1024 * 1024;    // 小于 4MB 不值得分段
const SEG_CONCURRENCY = 4;                // 分段并发默认值
const SEG_CONCURRENCY_MAX = 8;            // 分段并发上限
const PROBE_BYTES = 1536 * 1024;          // 测速采样上限
const PROBE_MS = 1800;                    // 测速采样最长耗时（避免慢源拖住整体启动）
const LOW_BPS = 320 * 1024;               // 单连接「低速」阈值：低于它且已过热身 → 换源
const LOW_WARMUP_MS = 12000;              // 低速判定前的热身时间（避开 TCP 慢启动）
const RANK_TTL_MS = 5 * 60 * 1000;        // 测速结果缓存时长（同一批文件复用一次测速）
const PART_CHUNK = 25 * 1024 * 1024;      // 分卷仓库的固定切片（实测）
const FILE_CONCURRENCY = 4;               // 多文件并发默认值
const PARTS_CONCURRENCY = 12;             // 分卷并发默认值（实测 12 路 ≈ 25MB/s）

function hostOf(u) { try { return new URL(u).host; } catch (_) { return ''; } }

/** 从响应头解析文件总长度（优先 content-range，兼容 206 / 无 content-length） */
function totalOfHeaders(headers) {
  try {
    const get = (k) => (headers && typeof headers.get === 'function' ? headers.get(k) : (headers || {})[k]);
    const cr = String(get('content-range') || '');
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) return parseInt(m[1], 10) || 0;
    return parseInt(get('content-length') || '0', 10) || 0;
  } catch (_) { return 0; }
}

/**
 * 纯函数：由「实测速度 + 文件大小」决定分段数与并发数。
 * 慢源（<12MB/s）多半是单流被限速 → 多开连接；快源单流已接近上限 → 少开，免得被对端限流。
 */
function planSegments(total, mbps, opts) {
  const o = opts || {};
  const segMax = o.segMax || SEG_MAX;
  const concMax = o.concurrencyMax || SEG_CONCURRENCY_MAX;
  const minBytes = o.segMinBytes || SEG_MIN_BYTES;
  if (!total || total < minBytes) return { segCount: 1, concurrency: 1, reason: '文件过小' };
  const want = (mbps > 0 && mbps >= 12) ? 4 : 8;
  const bySize = Math.floor(total / (1024 * 1024));
  const segCount = Math.max(1, Math.min(segMax, want, bySize));
  return { segCount, concurrency: Math.max(1, Math.min(concMax, segCount)) };
}

/** 纯函数：按已测得的 host 速度顺序重排候选 URL（没测到的排最后，保持原相对顺序） */
function orderByHostRank(urls, hostRank) {
  const list = [...new Set((urls || []).filter(Boolean))];
  if (!hostRank || !hostRank.length) return list;
  const rank = new Map();
  hostRank.forEach((h, i) => {
    const k = typeof h === 'string' ? h : (h && h.host);
    if (k && !rank.has(k)) rank.set(k, i);
  });
  return list
    .map((u, i) => ({ u, i, r: rank.has(hostOf(u)) ? rank.get(hostOf(u)) : 999 }))
    .sort((a, b) => (a.r - b.r) || (a.i - b.i))
    .map((x) => x.u);
}

/**
 * 纯函数：分卷仓库里第 index 卷（1 起）的期望字节数。
 * 固定 25 MiB 切片，最后一卷是余数；推导不出（清单不一致）时返回 0 表示「不校验」。
 */
function expectedPartSize(total, parts, index) {
  if (!total || !parts || index < 1 || index > parts) return 0;
  const remaining = total - (index - 1) * PART_CHUNK;
  if (remaining <= 0) return 0;
  return Math.min(PART_CHUNK, remaining);
}

/** 纯函数：manifest 的 size/parts 是否自洽（自洽才敢用推导值当校验依据） */
function partsLayoutOk(total, parts) {
  if (!total || !parts || parts < 1) return false;
  const last = expectedPartSize(total, parts, parts);
  return last > 0 && last <= PART_CHUNK;
}

module.exports = function createFastDownload({ net, fs, path }) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const _rankCache = new Map();   // key: URL 列表 → { at, ranked }

  function cancelledError() {
    const e = new Error('已取消下载');
    e.cancelled = true;
    return e;
  }

  function short(e) {
    const s = String((e && e.message) || e || '');
    return s.length > 140 ? s.slice(0, 140) + '…' : s;
  }

  /**
   * 带防护的 fetch。
   *   · connectMs：只约束「响应头到达」，正文流不受总时长限制（大文件不会被砍断）
   *   · stallMs：停滞看门狗 —— 按**实际收到字节**判定，收到数据就刷新计时
   */
  async function fetchGuarded(url, { headers, ctrl, connectMs = 30000, stallMs = 30000 } = {}) {
    const srcCtrl = new AbortController();
    const onUser = () => { try { srcCtrl.abort(); } catch (_) {} };
    if (ctrl) { if (ctrl.signal.aborted) onUser(); else ctrl.signal.addEventListener('abort', onUser); }
    const timer = setTimeout(() => { try { srcCtrl.abort(); } catch (_) {} }, connectMs);
    let r;
    try {
      r = await net.fetch(url, { headers: headers || {}, signal: srcCtrl.signal });
    } finally { clearTimeout(timer); }
    try { if (ctrl) ctrl.signal.removeEventListener('abort', onUser); } catch (_) {}
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);

    const raw = r.body.getReader();
    let lastData = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > stallMs) { try { srcCtrl.abort(); } catch (_) {} }
    }, 2000);
    // 包装 reader：每读到数据就刷新停滞计时。
    const reader = {
      read: async () => { const o = await raw.read(); if (!o.done) lastData = Date.now(); return o; },
      cancel: (reason) => raw.cancel(reason),
    };
    return { res: r, reader, srcCtrl, cleanup: () => clearInterval(watchdog) };
  }

  /** 多源并发测速：各源读一小段计时 → 按实测速度降序返回（同批文件默认复用缓存） */
  async function rankMirrors(urls, ctrl, opts) {
    const o = opts || {};
    const list = [...new Set((urls || []).filter(Boolean))];
    if (!list.length) return [];
    const key = list.join('|');
    const hit = _rankCache.get(key);
    if (o.useCache !== false && hit && Date.now() - hit.at < RANK_TTL_MS) return hit.ranked;
    const probe = async (u) => {
      const t0 = Date.now();
      const gd = await fetchGuarded(u, {
        headers: { 'user-agent': UA_DEFAULT, Range: 'bytes=0-' + (PROBE_BYTES - 1) },
        ctrl, connectMs: 8000, stallMs: 10000,
      });
      try {
        let got = 0;
        const total = totalOfHeaders(gd.res.headers);
        const ranged = gd.res.status === 206;
        for (;;) {
          const { done, value } = await gd.reader.read();
          if (done) break;
          got += value.length;
          if (got >= PROBE_BYTES || Date.now() - t0 >= PROBE_MS) {
            try { await gd.reader.cancel(); } catch (_) {}
            break;
          }
        }
        const ms = Math.max(1, Date.now() - t0);
        return { url: u, mbps: (got / ms) * 1000 / 1048576, total, ranged };
      } finally { try { gd.cleanup(); } catch (_) {} }
    };
    const settled = await Promise.all(list.map(async (u) => {
      try { return await probe(u); } catch (_) { return { url: u, mbps: 0, total: 0, ranged: false }; }
    }));
    const ranked = settled.filter((r) => r.mbps > 0).sort((a, b) => b.mbps - a.mbps);
    if (ranked.length) _rankCache.set(key, { at: Date.now(), ranked });
    return ranked;
  }

  /** 只取远端文件总长度（HEAD 语义，用 1 字节 Range 代替 HEAD） */
  async function remoteSize(u, ctrl) {
    const gd = await fetchGuarded(u, {
      headers: { 'user-agent': UA_DEFAULT, Range: 'bytes=0-0' }, ctrl, connectMs: 8000, stallMs: 8000,
    });
    try { return totalOfHeaders(gd.res.headers); }
    finally { try { await gd.reader.cancel(); } catch (_) {} try { gd.cleanup(); } catch (_) {} }
  }

  /** 测速结果 → host 速度表，供同批其它文件直接复用（省掉每个文件一次测速） */
  function hostRankOf(ranked) {
    return (ranked || []).map((r) => ({ host: hostOf(r.url), mbps: r.mbps }));
  }

  /** 磁盘空间预检：不够就在动手前抛错（含所需/可用，便于用户自己腾地方） */
  function checkDiskSpace(dest, needBytes) {
    if (!needBytes || needBytes <= 0) return { ok: true, free: 0 };
    let free = 0;
    try {
      const st = fs.statfsSync(path.dirname(dest));
      free = Number(st.bavail) * Number(st.bsize);
    } catch (_) { return { ok: true, free: 0, unknown: true }; }
    const need = Math.ceil(needBytes * 1.05);
    if (free < need) {
      const gb = (n) => (n / 1073741824).toFixed(2) + ' GB';
      throw new Error('磁盘空间不足：需要约 ' + gb(need) + '，可用 ' + gb(free) + '（' + path.dirname(dest) + '）');
    }
    return { ok: true, free };
  }

  /** 完整性校验：期望长度 / 远端声明长度 / 最小体积 */
  function verifySize(size, o) {
    const opt = o || {};
    const what = opt.label ? '（' + opt.label + '）' : '';
    if (opt.expectSize && size !== opt.expectSize) {
      throw new Error('大小不符' + what + '：' + size + '/' + opt.expectSize + '（传输被截断，已丢弃，可重试）');
    }
    if (opt.total && size !== opt.total) throw new Error('大小不符' + what + '：' + size + '/' + opt.total);
    if (opt.minSize && size < opt.minSize) throw new Error('文件过小' + what + '：' + size + ' B（可能被代理拦截）');
    return true;
  }

  /** 只清理分段临时文件（保留已完整的分段，便于续传） */
  function cleanSegTmp(dest) {
    let names = [];
    try { names = fs.readdirSync(path.dirname(dest)); } catch (_) { return; }
    const base = path.basename(dest) + '.fs';
    for (const n of names) {
      if (!n.startsWith(base) || !n.endsWith('.tmp')) continue;
      try { fs.rmSync(path.join(path.dirname(dest), n), { force: true }); } catch (_) {}
    }
  }

  /** 清掉目标文件的全部分段残片 */
  function cleanSegments(dest) {
    cleanSegTmp(dest);
    for (let i = 0; i < SEG_MAX; i++) {
      try { fs.rmSync(dest + '.fs' + i, { force: true }); } catch (_) {}
    }
  }

  /**
   * 高速下载单个文件。
   * @returns {Promise<{size:number,total:number,host:string,segments:number}>}
   *          取消时抛出的 Error 带 `.cancelled = true`
   */
  async function downloadFast(opts) {
    const {
      urls, dest, headers, minSize = 200000, onProgress,
      isUserAbort, ctrl: outerCtrl, segMax = SEG_MAX, concurrency = SEG_CONCURRENCY,
      singleStream = false, hostRank = null, expectSize = 0, label = '', noProbe = false,
    } = opts || {};
    const abortObj = isUserAbort || {};
    const head = { 'user-agent': UA_DEFAULT, ...(headers || {}) };
    const report = (p) => { try { onProgress && onProgress({ host: '', label, ...p }); } catch (_) {} };

    const candidates = [...new Set((urls || []).filter(Boolean))];
    if (!candidates.length) throw new Error('没有可用的下载源');
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); } catch (_) {}

    // ---- 统一的取消信号 ----
    const ctrl = new AbortController();
    const kill = () => { try { ctrl.abort(); } catch (_) {} };
    if (outerCtrl) { if (outerCtrl.signal.aborted) kill(); else outerCtrl.signal.addEventListener('abort', kill); }
    const userAborted = () => !!(abortObj.aborted || abortObj.isUserAbort);
    const stopped = () => ctrl.signal.aborted || userAborted();
    const checkStop = () => { if (stopped()) throw cancelledError(); };

    // ---- ① 源顺序：优先复用同批已测得的 host 速度表，其次实测 ----
    let ranked;
    if (hostRank && hostRank.length) {
      ranked = orderByHostRank(candidates, hostRank).map((u) => ({ url: u, mbps: 0, total: 0, ranged: false }));
      report({ phase: 'ranked', host: hostOf(ranked[0].url), sources: ranked.length, text: '沿用已测速的源顺序' });
    } else {
      report({ phase: 'probe', text: '正在测速选择最快的下载源…' });
      ranked = await rankMirrors(candidates, ctrl, { useCache: !noProbe }).catch(() => []);
      checkStop();
      if (!ranked.length) ranked = candidates.map((u) => ({ url: u, mbps: 0, total: 0, ranged: false }));
      report({ phase: 'ranked', host: hostOf(ranked[0].url), speed: ranked[0].mbps, sources: ranked.length, ranged: ranked[0].ranged });
    }
    const order = ranked.map((r) => r.url);

    // ---- ② 定长度 + 定分段计划 ----
    let total = ranked[0].total || 0;
    if (!total && ranked[0].ranged) { try { total = await remoteSize(order[0], ctrl); } catch (_) {} }
    checkStop();
    let plan = { segCount: 1, concurrency: 1 };
    if (!singleStream && ranked[0].ranged && (total || expectSize)) {
      plan = planSegments(total || expectSize, ranked[0].mbps, { segMax, concurrencyMax: concurrency });
    }

    if (plan.segCount > 1) {
      try {
        return await runSegmented({
          order, dest, total, segCount: plan.segCount, concurrency: plan.concurrency,
          head, minSize, expectSize, label, report, checkStop, stopped, ctrl,
        });
      } catch (e) {
        if (e && e.cancelled) throw e;
        report({ phase: 'retry', host: hostOf(order[0]), error: '分段下载失败，改用单连接续传：' + short(e) });
        cleanSegTmp(dest);
      }
    }

    // ---- ③ 单连接 + 断点续传（兜底 / 小文件 / 源不支持 Range）----
    return await runSingle({ order, dest, total, expectSize, label, head, minSize, report, checkStop, stopped, ctrl });
  }

  // ============================================================
  // 分段并发下载（源支持 Range 时）
  // ============================================================
  async function runSegmented({ order, dest, total, segCount, concurrency, head, minSize, expectSize, label, report, checkStop, stopped, ctrl }) {
    const segSize = Math.ceil(total / segCount);
    const segPath = (i) => dest + '.fs' + i;
    const segBytes = (i) => Math.max(0, Math.min(total, (i + 1) * segSize) - i * segSize);

    let segCtrl = new AbortController();
    const onOuterAbort = () => { try { segCtrl.abort(); } catch (_) {} };
    if (ctrl.signal.aborted) onOuterAbort(); else ctrl.signal.addEventListener('abort', onOuterAbort);
    const releaseOuter = () => { try { ctrl.signal.removeEventListener('abort', onOuterAbort); } catch (_) {} };

    // 续传：已完成且长度正确的分段直接跳过
    let downloaded = 0;
    const todo = [];
    for (let i = 0; i < segCount; i++) {
      let ok = false;
      try { ok = fs.existsSync(segPath(i)) && fs.statSync(segPath(i)).size === segBytes(i); } catch (_) {}
      if (ok) downloaded += segBytes(i); else todo.push(i);
    }

    let lastSend = 0, lastT = 0, lastR = 0, speed = 0;
    let lastHost = hostOf(order[0]);
    const sendP = (done) => {
      const now = Date.now();
      if (!done && now - lastSend < 250) return;
      lastSend = now;
      if (!done) {
        if (!lastT) { lastT = now; lastR = downloaded; }
        else if (now - lastT >= 400) { speed = ((downloaded - lastR) / (now - lastT)) * 1000; lastT = now; lastR = downloaded; }
      }
      const pct = total ? Math.min(99, Math.round(downloaded / total * 100)) : 0;
      report({ received: downloaded, total, percent: pct, speed, host: lastHost, segmented: segCount, label, done: !!done });
    };
    sendP(false);

    const fetchSeg = async (i, url) => {
      const start = i * segSize;
      const end = Math.min(total, start + segSize) - 1;
      const gd = await fetchGuarded(url, {
        headers: { ...head, Range: 'bytes=' + start + '-' + end },
        ctrl: segCtrl, connectMs: 20000, stallMs: 60000,
      });
      // 每次尝试都用唯一临时名：重试同一分段时不会与上一轮残留的文件句柄打架
      //（Windows 上「先 rm 再同名 open」经常拿到 EPERM）
      const fn = segPath(i) + '.' + Date.now().toString(36) + '.tmp';
      let got = 0;
      let ws = null;
      try {
        if (gd.res.status !== 206) throw new Error('该源不支持分段（Range）');
        ws = fs.createWriteStream(fn, { flags: 'w' });
        const errP = new Promise((_res, rej) => ws.on('error', rej));
        errP.catch(() => {});
        const reader = gd.reader;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (stopped()) { try { reader.cancel(); } catch (_) {} throw cancelledError(); }
          got += value.length;
          downloaded += value.length;
          lastHost = hostOf(url);
          sendP(false);
          await Promise.race([errP, new Promise((res2, rej2) => ws.write(Buffer.from(value), (err) => (err ? rej2(err) : res2())))]);
        }
        await new Promise((res2, rej2) => ws.end((err) => (err ? rej2(err) : res2())));
        ws = null;
        if (got !== segBytes(i)) throw new Error('分段长度不符：' + got + '/' + segBytes(i));
        fs.renameSync(fn, segPath(i));
      } catch (e) {
        // 回退本段已计入的进度，避免进度条虚高后卡住
        downloaded = Math.max(0, downloaded - got);
        throw e;
      } finally {
        // 先关写入流再删文件：Windows 下文件被占用时删除会静默失败
        if (ws) { try { ws.destroy(); } catch (_) {} await sleep(30); }
        try { fs.rmSync(fn, { force: true }); } catch (_) {}
        try { gd.cleanup(); } catch (_) {}
      }
    };

    // 分段全部优先走「实测最快的源」，只有某段失败才依次换到其它源。
    //
    // 这里刻意**不**做「分段均衡分摊到各镜像」：当镜像之间速度差距大时（实测同一
    // 文件在 CNB 可到 50MB/s、某加速站只有 200KB/s），分摊会让最慢的那一段成为
    // 整个下载的瓶颈 —— 总耗时不取决于最快源，而取决于最慢源。
    const sourceOrder = order.slice();
    const pickUrl = (i, attempt) => {
      if (attempt === 0) return sourceOrder[0];
      const rest = sourceOrder.slice(1);
      if (!rest.length) return sourceOrder[0];
      return rest[(i + attempt) % rest.length];
    };
    const runOne = async (i) => {
      let lastErr = null;
      const maxAttempt = Math.max(3, sourceOrder.length);
      for (let attempt = 0; attempt < maxAttempt; attempt++) {
        const url = pickUrl(i, attempt);
        checkStop();
        try { await fetchSeg(i, url); return; }
        catch (e) {
          lastErr = e;
          if (e && e.cancelled) throw e;
          const msg = String((e && e.message) || e);
          if (/不支持分段/.test(msg) || segCtrl.signal.aborted) throw e;
          await sleep(Math.min(400 * Math.pow(2, attempt), 4000));   // 指数退避，避免连续触发对端限流
        }
      }
      throw new Error('分段 ' + i + ' 下载失败：' + short(lastErr));
    };

    let cursor = 0;
    const runRound = async () => {
      cursor = 0;
      const workers = Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, async () => {
        for (;;) {
          checkStop();
          if (segCtrl.signal.aborted) throw cancelledError();
          const idx = cursor++;
          if (idx >= todo.length) return;
          await runOne(todo[idx]);
        }
      });
      // 用 allSettled 而非 all：一个镜像抽风时让其余分段自然收尾，错误信息才不失真
      const settled = await Promise.allSettled(workers);
      const errs = settled.filter((r) => r.status === 'rejected').map((r) => r.reason);
      if (!errs.length) return null;
      return errs.find((e) => !/aborted/i.test(String((e && e.message) || e))) || errs[0];
    };
    const stopRound = () => { try { segCtrl.abort(); } catch (_) {} };
    const startRound = () => {
      segCtrl = new AbortController();
      if (ctrl.signal.aborted) { try { segCtrl.abort(); } catch (_) {} }
    };

    let fail = await runRound();
    if (fail && !(fail.cancelled)) {
      // 整体再试一轮：重新测速排序（网络状况可能已变），已完成分段自动跳过
      stopRound();
      await sleep(800);
      cleanSegTmp(dest);
      if (stopped()) { releaseOuter(); throw cancelledError(); }
      try {
        const reranked = await rankMirrors(sourceOrder, ctrl, { useCache: false });
        if (reranked.length) { sourceOrder.length = 0; sourceOrder.push(...reranked.map((r) => r.url)); }
      } catch (_) {}
      startRound();
      fail = await runRound();
    }
    if (fail) {
      stopRound();
      await sleep(250);
      cleanSegTmp(dest);
      releaseOuter();
      if (fail.cancelled) throw fail;
      throw new Error('分段下载失败（已重试一轮）：' + short(fail));
    }
    releaseOuter();
    sendP(true);

    // ---- 合并分段 → .part → 目标 ----
    const part = dest + '.part';
    try { fs.rmSync(part, { force: true }); } catch (_) {}
    await new Promise((res2, rej2) => {
      const ws = fs.createWriteStream(part, { flags: 'w' });
      ws.on('error', rej2);
      let i = 0;
      const next = () => {
        if (i >= segCount) { ws.end(() => res2()); return; }
        const rs = fs.createReadStream(segPath(i++));
        rs.on('error', rej2);
        rs.on('end', next);
        rs.pipe(ws, { end: false });
      };
      next();
    });
    const size = fs.statSync(part).size;
    if (size !== total) {
      try { fs.rmSync(part, { force: true }); } catch (_) {}
      throw new Error('合并后大小不符：' + size + '/' + total + '（可能被代理拦截）');
    }
    verifySize(size, { expectSize, total, minSize, label });
    try { fs.rmSync(dest, { force: true }); } catch (_) {}
    fs.renameSync(part, dest);
    cleanSegments(dest);
    return { size, total, host: hostOf(sourceOrder[0]), segments: segCount };
  }

  // ============================================================
  // 单连接 + 断点续传（兜底路径）
  // ============================================================
  async function runSingle({ order, dest, total, expectSize, label, head, minSize, report, checkStop, stopped, ctrl }) {
    const part = dest + '.part';
    const MAX_ROUNDS = Math.max(4, order.length * 2);
    let lastErr = null;

    for (let round = 0; round < MAX_ROUNDS; round++) {
      checkStop();
      const url = order[round % order.length];
      let ws = null;
      try {
        let have = 0;
        try { have = fs.statSync(part).size; } catch (_) {}
        if (total && have >= total) {
          verifySize(have, { expectSize: expectSize || total, minSize, label });
          try { fs.rmSync(dest, { force: true }); } catch (_) {}
          fs.renameSync(part, dest);
          return { size: have, total, host: hostOf(url), segments: 1 };
        }
        const headers = { ...head };
        if (have > 0) headers.Range = 'bytes=' + have + '-';

        const gd = await fetchGuarded(url, { headers, ctrl, connectMs: 20000, stallMs: 25000 });
        try {
          const resumable = gd.res.status === 206 && have > 0;
          if (!resumable && have > 0) { try { fs.rmSync(part, { force: true }); } catch (_) {} have = 0; }
          const clen = parseInt(gd.res.headers.get('content-length') || '0', 10);
          const totalSize = clen ? have + clen : (total || expectSize || 0);

          ws = fs.createWriteStream(part, { flags: resumable ? 'a' : 'w' });
          ws.on('error', () => {});

          // 低速轮换：连续低于 LOW_BPS 且已过热身 → 主动放弃当前源，换下一个（保留 .part 续传）。
          // 这是「有时几百 KB」的直接解法：慢源不再被一路走完。
          const t0 = Date.now();
          let winT = Date.now(), winB = have, lowSince = 0;
          const reader = gd.reader;
          let got = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (stopped()) { try { reader.cancel(); } catch (_) {} throw cancelledError(); }
            got += value.length;
            const received = have + got;
            report({ received, total: totalSize, speed: 0, host: hostOf(url), segmented: 1, label });

            const now = Date.now();
            if (now - winT >= 3000) {
              const bps = ((received - winB) / (now - winT)) * 1000;
              winT = now; winB = received;
              if (now - t0 > LOW_WARMUP_MS && order.length > 1 && bps > 0 && bps < LOW_BPS) {
                if (!lowSince) lowSince = now;
                else if (now - lowSince >= 6000) {
                  try { reader.cancel('slow'); } catch (_) {}
                  throw new Error('当前源速度过低（' + Math.round(bps / 1024) + ' KB/s），换个源');
                }
              } else { lowSince = 0; }
            }
            await new Promise((res2, rej2) => ws.write(Buffer.from(value), (err) => (err ? rej2(err) : res2())));
          }
          await new Promise((res2, rej2) => ws.end((err) => (err ? rej2(err) : res2())));
          ws = null;
        } finally { try { gd.cleanup(); } catch (_) {} }

        const st = fs.statSync(part);
        // 完整性优先级：期望长度（调用方给的权威值）> 远端声明长度 > 最小体积
        try {
          verifySize(st.size, { expectSize, total, minSize, label });
        } catch (e) {
          lastErr = e;
          // 比期望还大 = 残片已被污染（错误页/串流），必须丢弃；偏小则保留，下一轮用 Range 续传补齐
          if (expectSize && st.size > expectSize) { try { fs.rmSync(part, { force: true }); } catch (_) {} }
          continue;
        }
        try { fs.rmSync(dest, { force: true }); } catch (_) {}
        fs.renameSync(part, dest);
        return { size: st.size, total: total || st.size, host: hostOf(url), segments: 1 };
      } catch (e) {
        lastErr = e;
        try { if (ws) ws.destroy(); } catch (_) {}
        ws = null;
        if (e && e.cancelled) throw e;
        if (stopped()) throw cancelledError();
        report({ retry: round + 1, host: hostOf(url), label, error: '第 ' + (round + 1) + ' 轮失败，自动换源/续传…' });
      }
    }
    if (stopped()) throw cancelledError();
    throw new Error('下载失败（已轮换 ' + MAX_ROUNDS + ' 轮）：' + short(lastErr));
  }

  /**
   * 多文件 / 多分卷并发下载（同一批复用一次测速结果）。
   * items: [{ urls, dest, expectSize, minSize, label, singleStream, segMax, concurrency, headers }]
   * 失败默认「快速停止」：已完成的文件/分卷保留在磁盘上，重试从断点继续。
   */
  async function downloadMany(items, opts) {
    const o = opts || {};
    const list = (items || []).filter(Boolean);
    if (!list.length) return [];
    const concurrency = Math.max(1, o.concurrency || FILE_CONCURRENCY);
    const totalBytes = list.reduce((s, it) => s + (it.expectSize || 0), 0);
    const prog = new Array(list.length).fill(0);
    const finished = new Array(list.length).fill(false);
    const results = new Array(list.length).fill(null);
    const emit = (i, p, isDone) => {
      if (isDone) {
        finished[i] = true;
        prog[i] = list[i].expectSize || p.size || p.received || prog[i];
      } else {
        prog[i] = Math.max(prog[i], p.received || 0);
      }
      const sum = prog.reduce((a, b) => a + b, 0);
      const doneCount = finished.filter(Boolean).length;
      try {
        o.onProgress && o.onProgress({
          index: i, count: list.length, doneCount,
          bytesDone: sum, bytesTotal: totalBytes,
          overallPercent: totalBytes ? Math.min(99, Math.round((sum / totalBytes) * 100)) : 0,
          label: list[i].label || '', done: !!isDone, ...p,
        });
      } catch (_) {}
    };
    let cursor = 0, firstErr = null, stop = false;
    const worker = async () => {
      for (;;) {
        if (stop) return;
        const i = cursor++;
        if (i >= list.length) return;
        const it = list[i];
        try {
          const r = await downloadFast({
            headers: o.headers, hostRank: o.hostRank, ctrl: o.ctrl, isUserAbort: o.isUserAbort,
            ...it,
            onProgress: (p) => emit(i, p, false),
          });
          results[i] = r;
          emit(i, { received: r.size, total: r.size, percent: 100, speed: 0, host: r.host }, true);
        } catch (e) {
          results[i] = { error: e };
          if (e && e.cancelled) { if (!firstErr) firstErr = e; stop = true; return; }
          if (!firstErr) {
            const msg = (it.label ? it.label + '：' : '') + short(e);
            firstErr = new Error(msg);
          }
          if (o.stopOnError !== false) { stop = true; return; }
        }
      }
    };
    await Promise.allSettled(Array.from({ length: Math.min(concurrency, list.length) }, worker));
    if (firstErr) throw firstErr;
    return results;
  }

  return {
    fetchGuarded, rankMirrors, remoteSize, hostRankOf,
    downloadFast, downloadMany,
    cleanSegTmp, cleanSegments,
    hostOf, cancelledError, verifySize, checkDiskSpace, planSegments,
    expectedPartSize, partsLayoutOk,
    PART_CHUNK, PARTS_CONCURRENCY, SEG_MAX,
  };
};

module.exports.pure = { planSegments, orderByHostRank, expectedPartSize, partsLayoutOk, totalOfHeaders, hostOf };
module.exports.PART_CHUNK = PART_CHUNK;
module.exports.PARTS_CONCURRENCY = PARTS_CONCURRENCY;
module.exports.SEG_MAX = SEG_MAX;
module.exports.FILE_CONCURRENCY = FILE_CONCURRENCY;
