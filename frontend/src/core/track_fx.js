// -*- coding: utf-8 -*-
/**
 * 本轨独享的效果链（P1）。
 *
 * ## 为什么是"本轨独享"
 *
 * 之前 EQ / 空间声是**全局一条链**，挂在合成器的总输出上 —— 于是给伴奏加混响，
 * 人声也一起被混响。参照 AltZin Studio 的「前置效果链」：每条音轨自己有一串
 * 可增删、可上下排序的效果节点，只作用于本轨。
 *
 * ## 为什么在播放端做，而不是渲染端
 *
 * 渲染端做要改引擎，而且每次调参数都得重渲（DiffSinger 渲一条几十秒）。
 * 在播放端用 Web Audio 节点串起来，改一个旋钮**立刻听得见**，
 * 而 phrase 级的渲染缓存也还能命中 —— 调效果不该让缓存失效。
 * 代价是"导出"时也要走同一条链（那是 P2 母带导出的活）。
 *
 * ## 为什么不用插件
 *
 * AltZin 的效果是插件型的，我们没有插件生态（合成走 SoundFont / JS synth），
 * 所以做成**固定的内置效果集**。好处是每个参数都能校验、能进工程文件、
 * 也不会因为缺插件而打不开别人的工程。
 */

/* ------------------------------------------------------------------ 工具 */

function num(v, d) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
function dbToGain(db) { return Math.pow(10, clamp(num(db, 0), -60, 24) / 20); }

let _seq = 0;
export function newFxId() {
  _seq += 1;
  return 'fx' + Date.now().toString(36) + _seq.toString(36);
}

/** 生成一段指数衰减噪声，当混响的脉冲响应（比打包 IR 文件省事，且无版权问题） */
function makeImpulse(ctx, seconds, decay) {
  const sr = ctx.sampleRate || 44100;
  const len = Math.max(1, Math.floor(clamp(num(seconds, 2), 0.1, 8) * sr));
  const buf = ctx.createBuffer(2, len, sr);
  const k = clamp(num(decay, 2.5), 0.5, 8);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, k);
    }
  }
  return buf;
}

/* ------------------------------------------------------------------ 效果注册表 */

/**
 * 每个效果提供 `make(ctx, params)`，返回 `{input, output}` —— 调用方只管把
 * 上游接到 `input`、把 `output` 接到下游，不必知道内部有几个节点。
 *
 * `params` 里的 `min/max/step/def` 直接驱动 UI，也用于 `normalizeFx()` 钳制，
 * 保证从工程文件读出来的脏数据不会把节点参数搞成 NaN。
 */
export const FX_TYPES = {
  gain: {
    label: '增益',
    params: [{ k: 'gainDb', label: '增益', unit: 'dB', min: -24, max: 24, step: 0.5, def: 0 }],
    make(ctx, p) {
      const g = ctx.createGain();
      g.gain.value = dbToGain(p.gainDb);
      return { input: g, output: g };
    },
  },

  eq3: {
    label: '三段均衡',
    params: [
      { k: 'low', label: '低频', unit: 'dB', min: -18, max: 18, step: 0.5, def: 0 },
      { k: 'mid', label: '中频', unit: 'dB', min: -18, max: 18, step: 0.5, def: 0 },
      { k: 'high', label: '高频', unit: 'dB', min: -18, max: 18, step: 0.5, def: 0 },
    ],
    make(ctx, p) {
      const lo = ctx.createBiquadFilter();
      lo.type = 'lowshelf'; lo.frequency.value = 200; lo.gain.value = clamp(num(p.low, 0), -18, 18);
      const mid = ctx.createBiquadFilter();
      mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.9;
      mid.gain.value = clamp(num(p.mid, 0), -18, 18);
      const hi = ctx.createBiquadFilter();
      hi.type = 'highshelf'; hi.frequency.value = 4000; hi.gain.value = clamp(num(p.high, 0), -18, 18);
      lo.connect(mid).connect(hi);
      return { input: lo, output: hi };
    },
  },

  filter: {
    label: '滤波',
    params: [
      { k: 'type', label: '类型', kind: 'enum', options: ['lowpass', 'highpass'], def: 'lowpass' },
      { k: 'freq', label: '截止', unit: 'Hz', min: 20, max: 20000, step: 10, def: 8000 },
      { k: 'q', label: 'Q', min: 0.1, max: 20, step: 0.1, def: 0.7 },
    ],
    make(ctx, p) {
      const f = ctx.createBiquadFilter();
      f.type = p.type === 'highpass' ? 'highpass' : 'lowpass';
      f.frequency.value = clamp(num(p.freq, 8000), 20, 20000);
      f.Q.value = clamp(num(p.q, 0.7), 0.1, 20);
      return { input: f, output: f };
    },
  },

  comp: {
    label: '压缩器',
    params: [
      { k: 'threshold', label: '阈值', unit: 'dB', min: -60, max: 0, step: 1, def: -18 },
      { k: 'ratio', label: '压缩比', min: 1, max: 20, step: 0.5, def: 4 },
      { k: 'attack', label: '启动', unit: 's', min: 0, max: 1, step: 0.005, def: 0.01 },
      { k: 'release', label: '释放', unit: 's', min: 0, max: 1, step: 0.01, def: 0.2 },
    ],
    make(ctx, p) {
      const c = ctx.createDynamicsCompressor();
      c.threshold.value = clamp(num(p.threshold, -18), -60, 0);
      c.ratio.value = clamp(num(p.ratio, 4), 1, 20);
      c.attack.value = clamp(num(p.attack, 0.01), 0, 1);
      c.release.value = clamp(num(p.release, 0.2), 0, 1);
      return { input: c, output: c };
    },
  },

  reverb: {
    label: '混响',
    params: [
      { k: 'mix', label: '干湿比', min: 0, max: 1, step: 0.05, def: 0.25 },
      { k: 'seconds', label: '时长', unit: 's', min: 0.2, max: 6, step: 0.1, def: 2 },
      { k: 'decay', label: '衰减', min: 0.5, max: 8, step: 0.1, def: 2.5 },
    ],
    make(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const mix = clamp(num(p.mix, 0.25), 0, 1);
      const dry = ctx.createGain(); dry.gain.value = 1 - mix;
      const wet = ctx.createGain(); wet.gain.value = mix;
      const conv = ctx.createConvolver();
      conv.buffer = makeImpulse(ctx, p.seconds, p.decay);
      input.connect(dry).connect(output);
      input.connect(conv).connect(wet).connect(output);
      return { input, output };
    },
  },

  delay: {
    label: '延迟',
    params: [
      { k: 'timeMs', label: '时间', unit: 'ms', min: 0, max: 1000, step: 5, def: 220 },
      { k: 'feedback', label: '反馈', min: 0, max: 0.9, step: 0.05, def: 0.3 },
      { k: 'mix', label: '干湿比', min: 0, max: 1, step: 0.05, def: 0.25 },
    ],
    make(ctx, p) {
      const input = ctx.createGain();
      const output = ctx.createGain();
      const mix = clamp(num(p.mix, 0.25), 0, 1);
      const d = ctx.createDelay(2);
      d.delayTime.value = clamp(num(p.timeMs, 220), 0, 1000) / 1000;
      const fb = ctx.createGain(); fb.gain.value = clamp(num(p.feedback, 0.3), 0, 0.9);
      const wet = ctx.createGain(); wet.gain.value = mix;
      const dry = ctx.createGain(); dry.gain.value = 1 - mix;
      input.connect(dry).connect(output);
      input.connect(d);
      d.connect(fb); fb.connect(d);        // 反馈环
      d.connect(wet).connect(output);
      return { input, output };
    },
  },

  pan: {
    label: '声像',
    params: [{ k: 'pan', label: '声像', min: -1, max: 1, step: 0.05, def: 0 }],
    make(ctx, p) {
      const n = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (!n) return null;                  // 极老浏览器没有 StereoPanner → 该效果跳过
      n.pan.value = clamp(num(p.pan, 0), -1, 1);
      return { input: n, output: n };
    },
  },
};

/** 下拉框用的顺序 */
export const FX_ORDER = ['gain', 'eq3', 'filter', 'comp', 'reverb', 'delay', 'pan'];

/* ------------------------------------------------------------------ 归一化 */

/**
 * 轨道上的一个效果节点。
 *
 * @typedef {{id: string, type: string, enabled: boolean,
 *            params: Record<string, string|number>}} FxNode
 */

/**
 * 造一个新效果节点（带默认参数）
 *
 * @returns {FxNode | null}
 */
export function makeFx(type, over) {
  const def = FX_TYPES[type];
  if (!def) return null;
  const params = {};
  for (const p of def.params) params[p.k] = p.def;
  const o = { id: newFxId(), type, enabled: true, params };
  if (over && typeof over === 'object') {
    if (over.id) o.id = String(over.id);
    if (typeof over.enabled === 'boolean') o.enabled = over.enabled;
    if (over.params && typeof over.params === 'object') Object.assign(params, over.params);
  }
  return normalizeFx([o])[0];
}

/**
 * 钳到合法范围；认不出类型 / 参数非有限值的一律修正。
 *
 * ★ 工程文件可能被人手改过，这里必须**兜底而不是抛错** ——
 *   一个参数写成 NaN 就让整条轨没声音，是最难排查的故障。
 *
 * @param {any[]} list
 * @returns {FxNode[]}
 */
export function normalizeFx(list) {
  const out = [];
  for (const it of (Array.isArray(list) ? list : [])) {
    if (!it || typeof it !== 'object') continue;
    const def = FX_TYPES[it.type];
    if (!def) continue;
    const raw = (it.params && typeof it.params === 'object') ? it.params : {};
    const params = {};
    for (const p of def.params) {
      if (p.kind === 'enum') {
        params[p.k] = p.options.indexOf(raw[p.k]) >= 0 ? raw[p.k] : p.def;
        continue;
      }
      const v = num(raw[p.k], p.def);
      params[p.k] = clamp(v, p.min, p.max);
    }
    out.push({
      id: String(it.id || newFxId()),
      type: it.type,
      enabled: it.enabled === false ? false : true,
      params,
    });
  }
  return out;
}

/* ------------------------------------------------------------------ 建链 */

/**
 * 把一串效果接成 `{input, output}`。
 *
 * ★ 单次播放用完即弃：Web Audio 的 source 是一次性的，每次 `play()` 都重建
 *   source，所以效果节点也跟着重建 —— 不做缓存，省得状态残留（比如延迟的反馈环
 *   里还留着上一次的尾巴）。
 *
 * @returns {{input: AudioNode, output: AudioNode, nodes: AudioNode[]}}
 *          `nodes` 供调用方在停止时 disconnect。
 */
export function buildFxChain(ctx, list) {
  const fx = normalizeFx(list).filter(f => f.enabled);
  const nodes = [];
  if (!fx.length) return { input: null, output: null, nodes };
  let input = null;
  let tail = null;
  for (const f of fx) {
    const made = FX_TYPES[f.type].make(ctx, f.params);
    if (!made) continue;                    // 该效果在当前环境不可用
    if (!input) input = made.input;
    if (tail) tail.connect(made.input);
    tail = made.output;
    nodes.push(made.input, made.output);
  }
  return { input, output: tail, nodes };
}

/** 效果链的一句话摘要（轨道列表上显示，不用展开就知道这轨挂了什么） */
export function fxSummary(list) {
  const fx = normalizeFx(list);
  if (!fx.length) return '';
  return fx.map(f => (f.enabled ? '' : '［关］') + (FX_TYPES[f.type].label || f.type)).join(' → ');
}
