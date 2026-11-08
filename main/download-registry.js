// ============================================================
// 统一下载管理层：所有下载点都在这里登记成一个「任务」
//
// 分层（别混）：
//   main/fast-download.js  —— 传输层：多源测速 / 分段 / 续传 / 看门狗 / 校验
//   main/download-registry.js —— 任务层：登记 / 进度归一化 / 取消 / 完成 / 失败
//   main/taskcenter.js     —— 任务总线：10Hz 广播，离开页面不丢
//
// 设计原则（2026-11-08）：**纯加法**。各模块原有的 IPC 事件名、字段、返回结构
// 一律不动（App.vue / ViewResources / ViewModels / ViewTranscribe 等 4 处都在消费
// model:progress，改字段会同时打破它们）。这里只额外往任务中心登记一份。
//
// 用法：
//   const DL = require('./download-registry');
//   const dl = DL.start({ domain: 'model', key: id, title: spec.name, onCancel });
//   // 已有进度回调里加一行：dl.progress(p)
//   // 结束时：dl.finish({ ok:true }) 或 dl.finish({ ok:false, error })
//   // 也可：await DL.run(spec, async (dl) => { ...; return result })
// ============================================================
'use strict';

const TC = require('./taskcenter');

// kind 用 TaskCenter.vue 里已有的分类（KIND_LABEL / KIND_ICON 已覆盖），
// 域信息放在 title 前缀，避免新增 kind 导致前端出现「未知分类」。
const DOMAIN_LABEL = {
  model: '模型', soundfont: '音色库', voicebank: '声库', wallpaper: '壁纸',
  update: '更新包', omr: '识谱组件', gpu: 'GPU 增强包', plugin: '插件',
  separate: '分离模型', runtime: '运行时',
};
const DOMAIN_KIND = { model: 'model', update: 'update', omr: 'omr' };

let seq = 0;

/** 各模块进度字段五花八门：percent 0..100 / progress 0..1 / received+total / 裸数字 */
function normalize(p) {
  if (typeof p === 'number') return clamp(p <= 1 ? p : p / 100);
  const o = p || {};
  let v = 0;
  if (o.done) v = 1;
  else if (o.percent != null) v = Number(o.percent) / 100;
  else if (o.progress != null) v = Number(o.progress) / (Number(o.progress) > 1 ? 100 : 1);
  else if (o.received != null && Number(o.total) > 0) v = Number(o.received) / Number(o.total);
  return clamp(v);
}
function clamp(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** 只在文本变化时写 log —— 进度每秒几十次，全写进去会淹没任务详情 */
function textOf(p) {
  const o = (p && typeof p === 'object') ? p : {};
  const bits = [];
  if (o.text) bits.push(String(o.text));
  else if (o.phase && o.phase !== 'download') bits.push(String(o.phase));
  if (o.host) bits.push(String(o.host));
  if (o.retrying || o.retry || o.retrying === true) bits.push('换源重试');
  if (!bits.length && o.error) bits.push(String(o.error));
  return bits.join(' · ').slice(0, 180);
}

/** 没有任务中心时返回同样的 API（全 no-op），模块不必写 if */
function noopTask(ctrl, gate, id) {
  return {
    id, ctrl, isUserAbort: gate,
    progress() {}, log() {}, done() {}, fail() {}, canceled() {}, finish() {},
  };
}

function start(spec = {}) {
  const center = typeof TC.peekTaskCenter === 'function' ? TC.peekTaskCenter() : null;
  const domain = String(spec.domain || 'misc');
  const key = String(spec.key || 'download');
  const id = 'dl:' + domain + ':' + key + ':' + (++seq);
  const label = DOMAIN_LABEL[domain] || domain;
  const title = spec.title ? label + ' · ' + spec.title : label + ' · ' + key;

  const ctrl = new AbortController();
  const gate = { aborted: false };
  const extraCancel = typeof spec.onCancel === 'function' ? spec.onCancel : null;
  const cancel = () => {
    if (gate.aborted) return;
    gate.aborted = true;
    try { ctrl.abort(); } catch (e) { /* abort 重复调用不影响 */ }
    try { if (extraCancel) extraCancel(); } catch (e) { /* 各自模块的取消表由它自己保证 */ }
  };

  if (!center) return noopTask(ctrl, gate, id);
  const h = center.register({
    id,
    kind: spec.kind || DOMAIN_KIND[domain] || 'download',
    title,
    cancelable: spec.cancelable !== false,
    onCancel: cancel,
  });

  let settled = false;
  let lastText = '';
  const settle = (fn) => { if (settled) return; settled = true; fn(); };

  return {
    id,
    // 可直接喂给 FastDL：没有 AbortController 的模块靠这两个就获得统一取消能力
    ctrl,
    isUserAbort: gate,
    progress(p) {
      if (settled) return;
      h.progress(normalize(p));
      const txt = textOf(p);
      if (txt && txt !== lastText) { lastText = txt; h.log(txt); }
    },
    log(line) { if (!settled && line) h.log(String(line)); },
    done(result) { settle(() => h.done(result)); },
    fail(err) { settle(() => h.fail(err)); },
    canceled() {
      // 不可从任务中心取消的任务（下载桥接）没有 cancelable=true，h.cancel() 会被拒；
      // 用 markCanceled 如实终态化，不留一个永远 running 的幽灵任务。
      settle(() => {
        if (typeof center.markCanceled === 'function') center.markCanceled(h.id);
        else h.cancel();
      });
    },
    /** 统一收口：吃各模块现有返回值 {ok, canceled, paused, error, existed, active} */
    finish(res) {
      if (settled) return;
      if (res == null) { this.done(); return; }
      if (res.ok === false) {
        if (res.canceled || res.paused) this.canceled();
        else this.fail(res.error || '下载失败');
      } else this.done(res);
    },
  };
}

// ------------------------------------------------------------------
// 进度桥：各模块原有 IPC 事件名/字段一律不动，只在这里「旁路」登记任务。
// 由 main.js 在 browser-window-created 时挂到 webContents.send 上，
// 因此 8 个下载模块无需逐个改协议（改字段会同时打破 4 个前端面板）。
// ------------------------------------------------------------------
const PROGRESS_CHANNELS = {
  'model:progress': { domain: 'model', key: (p) => p.id },
  'sf-workshop:progress': { domain: 'soundfont', key: (p) => p.id },
  'utau:voicebankProgress': { domain: 'voicebank', key: (p) => p.id },
  'diffsinger:voicebankProgress': { domain: 'voicebank', key: (p) => p.id },
  'diffsinger:msProgress': { domain: 'voicebank', key: (p) => p.id },
  'diffsinger:runtimeProgress': { domain: 'runtime', key: (p) => p.id || 'runtime' },
  'gpu:progress': { domain: 'gpu', key: () => 'package' },
  'update:progress': { domain: 'update', key: () => 'installer' },
  'omr:progress': { domain: 'omr', key: () => 'components' },
  'wallpaper:downloadProgress': { domain: 'wallpaper', key: (p) => p.name },
  'wallpaper:addLocalProgress': { domain: 'wallpaper', key: (p) => p.name },
};

const _active = new Map();

function observe(channel, p) {
  const spec = PROGRESS_CHANNELS[channel];
  if (!spec || !p || typeof p !== 'object') return;
  const key = String(spec.key(p) || 'download');
  const mapKey = spec.domain + ':' + key;
  let task = _active.get(mapKey);
  if (!task) {
    // cancelable:false —— 各资源页已有自己的取消按钮与 abort 表，
    // 这里不重复造取消通道（挂错会把断点丢掉）。
    task = start({ domain: spec.domain, key, title: p.name || p.label || key, cancelable: false });
    _active.set(mapKey, task);
  }
  if (p.error) { task.fail(p.error); _active.delete(mapKey); return; }
  if (p.canceled || p.paused) { task.canceled(); _active.delete(mapKey); return; }
  task.progress(p);
  if (p.done) { task.done(); _active.delete(mapKey); }
}

/** 测试/诊断用 */
function activeCount() { return _active.size; }
function reset() { _active.clear(); }

/** 包一层：抛异常自动 fail，正常返回自动 finish */
async function run(spec, fn) {
  const h = start(spec);
  try {
    const r = await fn(h);
    h.finish(r);
    return r;
  } catch (e) {
    h.fail(e);
    throw e;
  }
}

module.exports = { start, run, normalize, observe, activeCount, reset, PROGRESS_CHANNELS, DOMAIN_LABEL, DOMAIN_KIND };
