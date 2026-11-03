// ============================================================
// 引擎探针缓存：TTL + 单飞（single-flight）
// ============================================================
// 资源中心的 onMounted 会同时触发 engine:probe 与 dep:check，两者各自起一个 Python
// 并导入 torch（实测 11.6 s CPU）。探针结果在 10 分钟内不会变（除非用户刚装/卸增强包），
// 因此这里做两件事：
//   · TTL 缓存：10 分钟内重复请求直接返回上次结果（0 个新 Python 进程）；
//   · 单飞：并发请求只跑一次，其余等同一个 Promise。
// 失败结果默认不缓存（避免一次偶发失败被钉住 10 分钟）。
'use strict';

function createProbeCache({ ttlMs = 10 * 60 * 1000, now = Date.now } = {}) {
  let entry = null;      // { key, value, at }
  let inflight = null;   // { key, promise }

  function peek() {
    if (!entry) return null;
    return { key: entry.key, value: entry.value, at: entry.at, ageMs: Math.max(0, now() - entry.at) };
  }

  /**
   * @param {string} key 缓存键（probe / deps 等）
   * @param {() => Promise<any>} fn 真正执行探测的函数
   * @param {{cacheable?: boolean, shouldCache?: (v:any)=>boolean}} opts
   */
  async function run(key, fn, opts = {}) {
    const cacheable = opts.cacheable !== false;
    if (cacheable && entry && entry.key === key && (now() - entry.at) < ttlMs) {
      return entry.value;
    }
    if (inflight && inflight.key === key) return inflight.promise;
    const promise = Promise.resolve().then(fn).then((value) => {
      if (cacheable && (!opts.shouldCache || opts.shouldCache(value))) {
        entry = { key, value, at: now() };
      }
      return value;
    }).finally(() => {
      if (inflight && inflight.promise === promise) inflight = null;
    });
    inflight = { key, promise };
    return promise;
  }

  function clear() { entry = null; inflight = null; }

  return { run, clear, peek };
}

module.exports = { createProbeCache };
