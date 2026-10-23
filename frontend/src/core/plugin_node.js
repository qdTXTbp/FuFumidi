// ============================================================
// P2-1 插件节点（Phase A：离线渲染链节点）
// ============================================================
// 目标：把"插件"抽象成导出/混音链上的一个**离线节点**，不引入实时宿主：
//   renderAudioBuffer → [plugin node...] → 响度/限幅 → 编码
// 本模块提供纯 DSP 节点（gain/EQ/compressor/saturator），可在 Node 里逐样本测试；
// VST3/CLAP 通过"外部宿主适配器"在主进程侧渲染（见 docs/plugins.md），
// 节点参数与内置节点同一套 JSON，失败时整链退回内置效果（不静默改变响度）。

/* ---------------- 参数清洗 ---------------- */
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
function dbToGain(db) { return Math.pow(10, num(db, 0) / 20); }

export const PLUGIN_TYPES = {
  gain: {
    label: '增益', params: { gainDb: { def: 0, min: -60, max: 24 } },
  },
  eq: {
    label: '均衡（单段）',
    params: {
      type: { def: 'peaking', enum: ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass'] },
      freq: { def: 1000, min: 20, max: 20000 },
      q: { def: 1, min: 0.1, max: 12 },
      gainDb: { def: 0, min: -24, max: 24 },
    },
  },
  compressor: {
    label: '压缩',
    params: {
      thresholdDb: { def: -18, min: -60, max: 0 },
      ratio: { def: 4, min: 1, max: 20 },
      attackMs: { def: 10, min: 0.1, max: 200 },
      releaseMs: { def: 150, min: 10, max: 2000 },
      kneeDb: { def: 6, min: 0, max: 24 },
      makeupDb: { def: 0, min: -12, max: 24 },
    },
  },
  saturator: {
    label: '饱和', params: { drive: { def: 1, min: 0.1, max: 8 }, mix: { def: 0.5, min: 0, max: 1 } },
  },
};

/** 清洗一个节点（未知类型返回 null；参数按定义夹紧） */
export function normalizePluginNode(node) {
  if (!node || typeof node !== 'object') return null;
  const type = String(node.type || '');
  const def = PLUGIN_TYPES[type];
  if (!def) return null;
  const params = {};
  for (const key of Object.keys(def.params)) {
    const p = def.params[key];
    const raw = node.params && node.params[key] != null ? node.params[key] : p.def;
    if (p.enum) params[key] = p.enum.includes(String(raw)) ? String(raw) : p.def;
    else params[key] = clamp(num(raw, p.def), p.min, p.max);
  }
  return { id: String(node.id || type), type, enabled: node.enabled !== false, params };
}

export function normalizePluginChain(nodes) {
  return (Array.isArray(nodes) ? nodes : []).map(normalizePluginNode).filter(Boolean);
}

/* ---------------- Biquad（RBJ 公式） ---------------- */
export function biquadCoeffs(kind, sampleRate, freq, q, gainDb) {
  const sr = Math.max(8000, num(sampleRate, 44100));
  const f = clamp(num(freq, 1000), 20, sr * 0.49);
  const Q = clamp(num(q, 1), 0.1, 12);
  const A = Math.pow(10, clamp(num(gainDb, 0), -24, 24) / 40);
  const w0 = 2 * Math.PI * f / sr;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'lowpass') {
    b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = (1 - cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (kind === 'highpass') {
    b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = (1 + cos) / 2;
    a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
  } else if (kind === 'lowshelf') {
    const sq = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) - (A - 1) * cos + sq);
    b1 = 2 * A * ((A - 1) - (A + 1) * cos);
    b2 = A * ((A + 1) - (A - 1) * cos - sq);
    a0 = (A + 1) + (A - 1) * cos + sq;
    a1 = -2 * ((A - 1) + (A + 1) * cos);
    a2 = (A + 1) + (A - 1) * cos - sq;
  } else if (kind === 'highshelf') {
    const sq = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cos + sq);
    b1 = -2 * A * ((A - 1) + (A + 1) * cos);
    b2 = A * ((A + 1) + (A - 1) * cos - sq);
    a0 = (A + 1) - (A - 1) * cos + sq;
    a1 = 2 * ((A - 1) - (A + 1) * cos);
    a2 = (A + 1) - (A - 1) * cos - sq;
  } else {
    b0 = 1 + alpha * A; b1 = -2 * cos; b2 = 1 - alpha * A;
    a0 = 1 + alpha / A; a1 = -2 * cos; a2 = 1 - alpha / A;
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

class Biquad {
  constructor(coeffs) { this.c = coeffs; this.z1 = 0; this.z2 = 0; }
  process(x) {
    const c = this.c;
    const y = c.b0 * x + this.z1;
    this.z1 = c.b1 * x - c.a1 * y + this.z2;
    this.z2 = c.b2 * x - c.a2 * y;
    return y;
  }
}

/* ---------------- 节点处理 ---------------- */

function applyGain(chans, p) {
  const g = dbToGain(p.gainDb);
  if (g === 1) return chans;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) ch[i] *= g;
  return chans;
}

function applyEq(chans, p, sampleRate) {
  const c = biquadCoeffs(p.type, sampleRate, p.freq, p.q, p.gainDb);
  for (const ch of chans) {
    const bq = new Biquad(c);
    for (let i = 0; i < ch.length; i++) ch[i] = bq.process(ch[i]);
  }
  return chans;
}

function applyCompressor(chans, p, sampleRate) {
  const sr = Math.max(8000, num(sampleRate, 44100));
  const thr = num(p.thresholdDb, -18);
  const ratio = Math.max(1, num(p.ratio, 4));
  const knee = Math.max(0, num(p.kneeDb, 6));
  const atk = Math.exp(-1 / (Math.max(0.1, num(p.attackMs, 10)) / 1000 * sr));
  const rel = Math.exp(-1 / (Math.max(10, num(p.releaseMs, 150)) / 1000 * sr));
  const makeup = dbToGain(p.makeupDb);
  let env = 0;
  const n = chans[0] ? chans[0].length : 0;
  for (let i = 0; i < n; i++) {
    let peak = 0;
    for (const ch of chans) peak = Math.max(peak, Math.abs(ch[i]));
    // 峰值包络（线性）
    const a = peak > env ? atk : rel;
    env = a * env + (1 - a) * peak;
    const db = env > 1e-9 ? 20 * Math.log10(env) : -120;
    let over = db - thr;
    let reduceDb = 0;
    if (over > knee / 2) reduceDb = over * (1 - 1 / ratio);
    else if (over > -knee / 2) {
      const x = over + knee / 2;
      reduceDb = (1 - 1 / ratio) * x * x / (2 * knee);
    }
    const g = dbToGain(-reduceDb) * makeup;
    for (const ch of chans) ch[i] *= g;
  }
  return chans;
}

function applySaturator(chans, p) {
  const drive = Math.max(0.1, num(p.drive, 1));
  const mix = clamp(num(p.mix, 0.5), 0, 1);
  const norm = Math.tanh(drive);
  for (const ch of chans) {
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      const wet = Math.tanh(x * drive) / (norm || 1);
      ch[i] = x * (1 - mix) + wet * mix;
    }
  }
  return chans;
}

/**
 * 应用一串插件节点（**原地**修改 channels；返回 {channels, report}）。
 * report: [{id,type,ms,beforePeakDb,afterPeakDb}]，便于导出面板/日志展示。
 * 外部宿主节点（type: 'vst3'/'clap'）不在本模块处理 —— 由主进程适配器预处理成内置节点。
 */
export function applyPluginChain(channels, sampleRate, nodes, opts = {}) {
  const chans = Array.isArray(channels) ? channels : [];
  const chain = normalizePluginChain(nodes);
  const report = [];
  const t0 = Date.now();
  for (const n of chain) {
    if (!n.enabled) { report.push({ id: n.id, type: n.type, skipped: true }); continue; }
    const before = peakDb(chans);
    const t = Date.now();
    if (n.type === 'gain') applyGain(chans, n.params);
    else if (n.type === 'eq') applyEq(chans, n.params, sampleRate);
    else if (n.type === 'compressor') applyCompressor(chans, n.params, sampleRate);
    else if (n.type === 'saturator') applySaturator(chans, n.params);
    report.push({ id: n.id, type: n.type, ms: Date.now() - t, beforePeakDb: round(before), afterPeakDb: round(peakDb(chans)) });
  }
  if (opts && opts.clamp !== false) clampAll(chans);
  if (opts && opts.reportTotal) report.totalMs = Date.now() - t0;
  return { channels: chans, report };
}

function peakDb(chans) {
  let peak = 0;
  for (const ch of chans) for (let i = 0; i < ch.length; i++) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  return peak > 0 ? 20 * Math.log10(peak) : -120;
}
function clampAll(chans) {
  for (const ch of chans) for (let i = 0; i < ch.length; i++) {
    const x = ch[i];
    if (!Number.isFinite(x)) ch[i] = 0;
    else if (x > 1) ch[i] = 1;
    else if (x < -1) ch[i] = -1;
  }
}
function round(v) { return Math.round(v * 100) / 100; }

/** 给 UI/导出元数据用的摘要（不含 DSP 结果） */
export function describePluginChain(nodes) {
  return normalizePluginChain(nodes).map((n) => ({
    id: n.id, type: n.type, label: (PLUGIN_TYPES[n.type] || {}).label || n.type,
    enabled: n.enabled, params: { ...n.params },
  }));
}
