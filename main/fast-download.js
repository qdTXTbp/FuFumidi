'use strict';
// ============================================================
// 通用高速单文件下载器（主进程）
// ------------------------------------------------------------
// 背景：应用里原本有两套下载器 —— main/models.js 走「多源并发测速 + 单文件多分段
// 并行」，而 main/diffsinger.js（声库 / 声码器 / ModelScope 声库）走「固定顺序单连接
// + 25 秒无字节才换源」。后者在真实网络下的表现就是「有时 50MB/s、有时几百 KB」：
//   · 候选源里第一个恰好是国内的 CNB → 飞快；
//   · 第一个是境外直连 / 加速站且只是「慢」而不是「断」 → 25 秒看门狗永不触发，
//     于是一路以几百 KB/s 爬完整个几百 MB 的包。
//
// 本模块把 models.js 里已验证的两件事抽出来共用：
//   ① 多源并发测速：各源先取一小段计时，按实测速度排序，永远从最快的源开始；
//   ② 单文件多分段并行：源支持 Range 时切 N 段并发下载（对象存储/Release 单连接
//      普遍被限速，实测 4 段可把 5MB/s 提到 20MB/s），分段各自落盘、天然可续传。
// 任一条件不满足（源忽略 Range / 拿不到长度 / 文件很小）都自动回退到单连接续传。
//
// 取消契约：调用方传入 `isUserAbort` 标记对象与 `ctrl`（AbortController），
// 二者任一触发即中止，并抛 `err.cancelled = true`。调用方需自行判定并给出
// 「已取消」而不是「失败」的提示。
// ============================================================

const UA = 'FuFumidi';
const SEG_MAX = 8;                        // 最多分段数
const SEG_MIN_BYTES = 4 * 1024 * 1024;    // 小于 4MB 不值得分段
const SEG_CONCURRENCY = 4;                // 同时在跑的分段数
const PROBE_BYTES = 1536 * 1024;          // 测速采样上限
const PROBE_MS = 1800;                    // 测速采样最长耗时（避免慢源拖住整体启动）
const LOW_BPS = 320 * 1024;               // 单连接「低速」阈值：低于它且已过热身 → 换源
const LOW_WARMUP_MS = 12000;              // 低速判定前的热身时间（避开 TCP 慢启动）

module.exports = function createFastDownload({ net, fs, path }) {
  const hostOf = (u) => { try { return new URL(u).host; } catch (_) { return ''; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function cancelledError() {
    const e = new Error('已取消下载');
    e.cancelled = true;
    return e;
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

  /** 从响应头解析文件总长度（优先 content-range，兼容 206） */
  function totalOf(res) {
    const cr = res.headers.get('content-range') || '';
    const m = cr.match(/\/(\d+)\s*$/);
    if (m) return parseInt(m[1], 10) || 0;
    return parseInt(res.headers.get('content-length') || '0', 10) || 0;
  }

  /** 多源并发测速：各源读一小段计时 → 按实测速度降序返回 */
  async function rankMirrors(urls, ctrl) {
    const probe = async (u) => {
      const t0 = Date.now();
      const gd = await fetchGuarded(u, {
        headers: { 'user-agent': UA, Range: 'bytes=0-' + (PROBE_BYTES - 1) },
        ctrl, connectMs: 8000, stallMs: 10000,
      });
      try {
        let got = 0;
        const total = totalOf(gd.res);
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
    const settled = await Promise.all(urls.map(async (u) => {
      try { return await probe(u); } catch (_) { return { url: u, mbps: 0, total: 0, ranged: false }; }
    }));
    return settled.filter((r) => r.mbps > 0).sort((a, b) => b.mbps - a.mbps);
  }

  /** 只取远端文件总长度（HEAD 语义，用 1 字节 Range 代替 HEAD） */
  async function remoteSize(u, ctrl) {
    const gd = await fetchGuarded(u, {
      headers: { 'user-agent': UA, Range: 'bytes=0-0' }, ctrl, connectMs: 8000, stallMs: 8000,
    });
    try { return totalOf(gd.res); }
    finally { try { await gd.reader.cancel(); } catch (_) {} try { gd.cleanup(); } catch (_) {} }
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
   * 高速下载单文件。
   * @returns {Promise<{size:number,total:number,host:string,segments:number}>}
   *          取消时抛出的 Error 带 `.cancelled = true`
   */
  async function downloadFast(opts) {
    const {
      urls, dest, headers, minSize = 200000, onProgress,
      isUserAbort, ctrl: outerCtrl, segMax = SEG_MAX, concurrency = SEG_CONCURRENCY,
    } = opts || {};
    const abortObj = isUserAbort || {};
    const head = { 'user-agent': UA, ...(headers || {}) };
    const report = (p) => { try { onProgress && onProgress({ host: '', ...p }); } catch (_) {} };

    const candidates = [...new Set((urls || []).filter(Boolean))];
    if (!candidates.length) throw new Error('没有可用的下载源');

    // ---- 统一的取消信号 ----
    const ctrl = new AbortController();
    const kill = () => { try { ctrl.abort(); } catch (_) {} };
    if (outerCtrl) { if (outerCtrl.signal.aborted) kill(); else outerCtrl.signal.addEventListener('abort', kill); }
    const userAborted = () => !!(abortObj.aborted || abortObj.isUserAbort);
    const stopped = () => ctrl.signal.aborted || userAborted();
    const checkStop = () => { if (stopped()) throw cancelledError(); };

    // ---- ① 多源并发测速 ----
    report({ phase: 'probe', text: '正在测速选择最快的下载源…' });
    let ranked = await rankMirrors(candidates, ctrl).catch(() => []);
    checkStop();
    if (!ranked.length) {
      // 探测全失败（可能探测被拦但正文可下）：退回候选顺序，按单连接尝试
      ranked = candidates.map((u) => ({ url: u, mbps: 0, total: 0, ranged: false }));
    }
    const order = ranked.map((r) => r.url);
    report({ phase: 'ranked', host: hostOf(order[0]), speed: ranked[0].mbps, sources: ranked.length });

    // ---- ② 定长度 + 决定是否分段 ----
    let total = ranked[0].total || 0;
    if (!total) { try { total = await remoteSize(order[0], ctrl); } catch (_) {} }
    checkStop();
    let segCount = 1;
    if (total >= SEG_MIN_BYTES && ranked[0].ranged) {
      segCount = Math.min(segMax, Math.max(1, Math.floor(total / (2 * 1024 * 1024))));
    }

    if (segCount > 1) {
      try {
        return await runSegmented({ order, dest, total, segCount, head, minSize, report, checkStop, stopped, ctrl, concurrency, hostOf });
      } catch (e) {
        if (e && e.cancelled) throw e;
        report({ phase: 'retry', host: hostOf(order[0]), error: '分段下载失败，改用单连接续传：' + short(e) });
        cleanSegTmp(dest);
      }
    }

    // ---- ③ 单连接 + 断点续传（兜底 / 小文件）----
    return await runSingle({ order, dest, total, head, minSize, report, checkStop, stopped, ctrl, hostOf });
  }

  function short(e) {
    const s = String((e && e.message) || e || '');
    return s.length > 120 ? s.slice(0, 120) + '…' : s;
  }

  // ============================================================
  // 分段并发下载（源支持 Range 时）
  // ============================================================
  async function runSegmented({ order, dest, total, segCount, head, minSize, report, checkStop, stopped, ctrl, concurrency, hostOf }) {
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
      report({ received: downloaded, total, percent: pct, speed, host: lastHost, segmented: segCount, done: !!done });
    };
    sendP(false);

    const fetchSeg = async (i, url) => {
      const start = i * segSize;
      const end = Math.min(total, start + segSize) - 1;
      const gd = await fetchGuarded(url, {
        headers: { ...head, Range: `bytes=${start}-${end}` },
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
    // 整个下载的瓶颈 —— 总耗时不取决于最快源，而取决于最慢源，正是「有时飞快、
    // 有时龟速」的来源。排序已经给出了每源的真实吞吐，直接用它即可。
    const sourceOrder = order.slice();
    const pickUrl = (i, attempt) => {
      if (attempt === 0) return sourceOrder[0];
      const rest = sourceOrder.slice(1);
      if (!rest.length) return sourceOrder[0];
      return rest[(i + attempt) % rest.length];
    };
    const runOne = async (i) => {
      let lastErr = null;
      for (let attempt = 0; attempt < Math.max(3, sourceOrder.length); attempt++) {
        const url = pickUrl(i, attempt);
        checkStop();
        try { await fetchSeg(i, url); return; }
        catch (e) {
          lastErr = e;
          if (e && e.cancelled) throw e;
          const msg = String((e && e.message) || e);
          if (/不支持分段/.test(msg) || segCtrl.signal.aborted) throw e;
          await sleep(400);   // 换源前稍作退避，避免连续触发对端限流
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
        const reranked = await rankMirrors(sourceOrder, ctrl);
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
    if (size !== total || size < minSize) {
      try { fs.rmSync(part, { force: true }); } catch (_) {}
      throw new Error('合并后大小不符：' + size + '/' + total + '（可能被代理拦截）');
    }
    try { fs.rmSync(dest, { force: true }); } catch (_) {}
    fs.renameSync(part, dest);
    cleanSegments(dest);
    return { size, total, host: hostOf(sourceOrder[0]), segments: segCount };
  }

  // ============================================================
  // 单连接 + 断点续传（兜底路径）
  // ============================================================
  async function runSingle({ order, dest, total, head, minSize, report, checkStop, stopped, ctrl, hostOf }) {
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
        if (total && have >= total) { fs.renameSync(part, dest); return { size: have, total, host: hostOf(url), segments: 1 }; }
        const headers = { ...head };
        if (have > 0) headers.Range = 'bytes=' + have + '-';

        const gd = await fetchGuarded(url, { headers, ctrl, connectMs: 20000, stallMs: 25000 });
        try {
          const resumable = gd.res.status === 206 && have > 0;
          if (!resumable && have > 0) { try { fs.rmSync(part, { force: true }); } catch (_) {} have = 0; }
          const clen = parseInt(gd.res.headers.get('content-length') || '0', 10);
          const totalSize = clen ? have + clen : (total || 0);

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
            report({ received, total: totalSize, speed: 0, host: hostOf(url), segmented: 1 });

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
        if (st.size < (minSize || 200000)) { lastErr = new Error('下载文件过小（' + st.size + ' B），可能被代理拦截'); cleanUpPart(part); continue; }
        if (total && st.size !== total) { lastErr = new Error('大小不符：' + st.size + '/' + total); continue; }
        try { fs.rmSync(dest, { force: true }); } catch (_) {}
        fs.renameSync(part, dest);
        return { size: st.size, total: total || st.size, host: hostOf(url), segments: 1 };
      } catch (e) {
        lastErr = e;
        try { if (ws) ws.destroy(); } catch (_) {}
        ws = null;
        if (e && e.cancelled) throw e;
        if (stopped()) throw cancelledError();
        report({ retry: round + 1, host: hostOf(url), error: '第 ' + (round + 1) + ' 轮失败，自动换源/续传…' });
        if (/下载文件过小|大小不符/.test(String((e && e.message) || ''))) cleanUpPart(part);
      }
    }
    if (stopped()) throw cancelledError();
    throw new Error('下载失败（已轮换 ' + MAX_ROUNDS + ' 轮）：' + short(lastErr));
  }

  function cleanUpPart(part) { try { fs.rmSync(part, { force: true }); } catch (_) {} }

  return { fetchGuarded, rankMirrors, remoteSize, downloadFast, cleanSegTmp, cleanSegments, hostOf, cancelledError };
};
