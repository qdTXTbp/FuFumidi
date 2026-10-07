// -*- coding: utf-8 -*-
/**
 * 自动化子轨（P1）—— 从属轨。
 *
 * ## 为什么要有"目标"这个概念
 *
 * 之前只有一条 `pitchCurve`（音高曲线），其它表情参数只能逐音符手工填。
 * 参照 AltZin Studio 的「从属轨 = 插件自动化子轨」：一条音轨下挂若干条子轨，
 * 每条控制一个**目标参数**随时间变化。
 *
 * ## ★ 两种生效时机（这是本模块最关键的区分）
 *
 *   * `mode: 'render'` —— 参数要送进引擎，改了**必须重渲**才听得见。
 *     例：`PIT` 音高（两个引擎都吃）、`DYN/BRE/GEN`（**只有 UTAU 吃**，
 *     DiffSinger 引擎当前没有对应的每音符输入，别糊过去假装生效）。
 *   * `mode: 'playback'` —— 作用在已渲染的音频上，改了**立刻听得见**，
 *     不触碰渲染缓存。例：`VOL` 音量、`PAN` 声像。
 *
 * 把两者混为一谈会导致"调了没反应"或"渲了两次"（比如 DYN 既改音符又改播放增益）。
 * 所以每个目标显式声明 `mode`，UI 也据此提示要不要重渲。
 *
 * ## 曲线坐标
 *
 * 横轴用**拍**（与音符一致，改 BPM 时相对位置不变），纵轴是该目标的原生单位。
 */

function num(v, d) {
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

/**
 * 自动化目标注册表。
 *
 * @property {string} label  显示名
 * @property {'render'|'playback'} mode  生效时机（见文件头）
 * @property {string[]} engines  哪些引擎的轨道能用（`audio` 表示伴奏轨）
 */
export const CURVE_TARGETS = {
  PIT: {
    label: '音高', unit: 'cent', min: -1200, max: 1200, step: 5, def: 0,
    mode: 'render', engines: ['utau', 'diffsinger'],
  },
  DYN: {
    label: '力度', unit: '', min: 0, max: 100, step: 1, def: 100,
    mode: 'render', engines: ['utau'],
    note: '对应 UTAU 的音量（送进 resampler），改了要重渲',
  },
  BRE: {
    label: '气声', unit: '', min: 0, max: 100, step: 1, def: 0,
    mode: 'render', engines: ['utau'],
    note: '对应 UTAU 的 modulation，改了要重渲',
  },
  GEN: {
    label: '性别', unit: '', min: -100, max: 100, step: 1, def: 0,
    mode: 'render', engines: ['utau'],
    note: '对应 UTAU 的 GENC，改了要重渲',
  },
  VOL: {
    label: '音量', unit: 'dB', min: -60, max: 6, step: 0.5, def: 0,
    mode: 'playback', engines: ['utau', 'diffsinger', 'audio'],
  },
  PAN: {
    label: '声像', unit: '', min: -1, max: 1, step: 0.05, def: 0,
    mode: 'playback', engines: ['utau', 'diffsinger', 'audio'],
  },
};

/** UI 下拉顺序：先放两个引擎通用的，再放 UTAU 专属的 */
export const CURVE_ORDER = ['PIT', 'VOL', 'PAN', 'DYN', 'BRE', 'GEN'];

/**
 * 这条轨道能用的目标。
 *
 * @param {'utau'|'diffsinger'} engine
 * @param {'voice'|'audio'} [kind]
 */
export function targetsFor(engine, kind) {
  const key = kind === 'audio' ? 'audio' : engine;
  return CURVE_ORDER.filter((a) => (CURVE_TARGETS[a].engines || []).indexOf(key) >= 0);
}

export function defaultFor(abbr) {
  const t = CURVE_TARGETS[abbr];
  return t ? t.def : 0;
}

/* ------------------------------------------------------------------ 归一化 */

/**
 * 钳制并排序一条曲线。脏数据一律兜底（工程文件可能被手改过）。
 *
 * @returns {{abbr:string, points:{beat:number,value:number}[]}|null}
 */
export function normalizeCurve(c) {
  if (!c || typeof c !== 'object') return null;
  const abbr = String(c.abbr || '').toUpperCase();
  const t = CURVE_TARGETS[abbr];
  if (!t) return null;                       // 认不出的目标直接丢，别塞给引擎
  const pts = [];
  for (const p of (Array.isArray(c.points) ? c.points : [])) {
    if (!p || typeof p !== 'object') continue;
    const beat = num(p.beat, NaN);
    const value = num(p.value, NaN);
    if (!Number.isFinite(beat) || !Number.isFinite(value)) continue;
    pts.push({ beat: Math.max(0, beat), value: clamp(value, t.min, t.max) });
  }
  pts.sort((a, b) => a.beat - b.beat);
  return { abbr, points: pts };
}

/** 整组曲线归一化，并**过滤掉当前引擎用不了的**目标 */
export function normalizeCurves(list, engine, kind) {
  const ok = targetsFor(engine, kind);
  const out = [];
  const seen = new Set();
  for (const c of (Array.isArray(list) ? list : [])) {
    const n = normalizeCurve(c);
    if (!n) continue;
    if (ok.indexOf(n.abbr) < 0) continue;    // 该引擎没有这个参数 → 不显示也不送
    if (seen.has(n.abbr)) continue;          // 同一目标只留一条（重名会让"按名取"歧义）
    seen.add(n.abbr);
    out.push(n);
  }
  return out;
}

/** 取某条目标的曲线（没有则返回 null，调用方据此判断"没自动化"） */
export function curveOf(track, abbr) {
  const list = (track && Array.isArray(track.curves)) ? track.curves : [];
  for (const c of list) if (c && c.abbr === abbr) return c;
  return null;
}

/* ------------------------------------------------------------------ 采样 */

/**
 * 在指定拍上取值：**线性插值**，两端做保持（第一个点之前取首值，末点之后取末值）。
 *
 * 不做外插——外插会让曲线在开头/结尾飞出去（比如两个点斜率大，第 0 拍被推到
 * 远超范围的值），听感上是莫名其妙的音量跳变。
 */
export function sampleAt(points, beat, fallback) {
  const pts = Array.isArray(points) ? points : [];
  const fb = Number.isFinite(fallback) ? fallback : 0;
  if (!pts.length) return fb;
  if (!Number.isFinite(beat)) return fb;
  // ★ 用 `<` 而不是 `<=`：拍值重合时（用户叠了两个点）要走进下面的插值分支，
  //   由 `span <= 0` 那条规则取后一个值；用 `<=` 会在这里就返回首值，等于"后写的点被无视"。
  if (beat < pts[0].beat) return pts[0].value;
  const last = pts[pts.length - 1];
  if (beat >= last.beat) return last.value;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (beat <= b.beat) {
      const span = b.beat - a.beat;
      if (span <= 0) return b.value;         // 重合点：取后一个（后写覆盖先写）
      return a.value + (b.value - a.value) * ((beat - a.beat) / span);
    }
  }
  return last.value;
}

/**
 * 生成 `setValueCurveAtTime()` 用的包络。
 *
 * @param {{beat:number,value:number}[]} points
 * @param {number} bpm
 * @param {number} durationSec  该轨音频时长
 * @param {number} [steps]      采样点数（默认 256，够细且开销可忽略）
 * @param {string} abbr         `VOL` 会把 dB 转成线性增益，其余原样
 * @returns {Float32Array}
 */
export function envelope(points, bpm, durationSec, steps, abbr) {
  return envelopeFrom(points, bpm, 0, durationSec, steps, abbr);
}

/**
 * 曲线泳道的显示配置（PianoRoll 泳道用，从 CURVE_TARGETS 派生）。
 *
 * PIT 的数据域是 ±1200 音分，但泳道显示窗口固定 ±200（唱曲音高偏差的实用范围）；
 * 其余目标直接用完整数据域。未知 abbr 返回 null（调用方据此隐藏选项）。
 *
 * @param {string} abbr
 * @returns {{label:string, dispMin:number, dispMax:number, ticks:number[]}|null}
 */
export function laneViewOf(abbr) {
  const t = CURVE_TARGETS[abbr];
  if (!t || t.mode !== 'render') return null;   // 播放侧目标（VOL/PAN）不给泳道
  if (abbr === 'PIT') {
    return { label: t.label, dispMin: -200, dispMax: 200, ticks: [-200, -100, 0, 100, 200] };
  }
  const mid = (t.min + t.max) / 2;
  return {
    label: t.label,
    dispMin: t.min,
    dispMax: t.max,
    ticks: [t.min, mid, t.max].map((v) => Math.round(v)),
  };
}

/**
 * 工程秒 → 拍，沿多点变速段换算。
 *
 * `tempoMap` 形如 `[{beat, bpm}]`（首点 beat=0，由 song_project 序列化保证）；
 * 语义是「从 beat_i 开始速度为 bpm_i」。没给 map 就退回恒定 bpm（旧链路不变）。
 *
 * @param {number} sec  工程时间（秒，从 0 起）
 * @param {{beat:number,bpm:number}[]} [tempoMap]
 * @param {number} [fallbackBpm]
 * @returns {number}
 */
export function secToBeat(sec, tempoMap, fallbackBpm) {
  const pts = [];
  for (const p of (Array.isArray(tempoMap) ? tempoMap : [])) {
    const beat = num(p && p.beat, NaN);
    const bpm = num(p && p.bpm, NaN);
    if (!Number.isFinite(beat) || beat < 0 || !(bpm > 0)) continue;
    if (pts.length && pts[pts.length - 1].beat === beat) pts[pts.length - 1] = { beat, bpm };
    else pts.push({ beat, bpm });
  }
  if (!pts.length) return (num(sec, 0) / 60) * (num(fallbackBpm, 120) > 0 ? num(fallbackBpm, 120) : 120);
  pts.sort((a, b) => a.beat - b.beat);
  if (pts[0].beat > 0) pts.unshift({ beat: 0, bpm: pts[0].bpm });
  const t = Math.max(0, num(sec, 0));
  let secAcc = 0;
  for (let i = 0; i < pts.length; i++) {
    const { beat, bpm } = pts[i];
    const nextBeat = i + 1 < pts.length ? pts[i + 1].beat : Infinity;
    const segSec = (nextBeat - beat) * 60 / bpm;
    if (t <= secAcc + segSec) return beat + (t - secAcc) * bpm / 60;
    secAcc += segSec;
  }
  // 超出最后一个点：按末段速率外推
  const last = pts[pts.length - 1];
  return last.beat + (t - secAcc) * last.bpm / 60;
}

/**
 * 生成 `setValueCurveAtTime()` 用的包络，**指定时间窗口**。
 *
 * ★ 为什么要窗口版本：播放可以从任意位置起（seek / 暂停续播），
 *    automation 必须跟着从那个位置接着走 —— 整段包络从 0 开始的话，
 *    从第 30 秒续播会听到开头的音量曲线重演一遍。
 *
 * @param {number} startSec 窗口起点（**工程时间**，秒）
 * @param {number} endSec   窗口终点
 * @param {{beat:number,bpm:number}[]} [tempoMap]  多点变速（给了就沿段换算 sec→beat）
 */
export function envelopeFrom(points, bpm, startSec, endSec, steps, abbr, tempoMap) {
  const n = Math.max(2, Math.floor(num(steps, 256)));
  const arr = new Float32Array(n);
  const bpm2 = num(bpm, 120) > 0 ? num(bpm, 120) : 120;
  const a = Math.max(0, num(startSec, 0));
  const b = Math.max(a + 0.01, num(endSec, 0));
  const def = defaultFor(abbr);
  for (let i = 0; i < n; i++) {
    const sec = a + (i / (n - 1)) * (b - a);
    const beat = secToBeat(sec, tempoMap, bpm2);
    const v = sampleAt(points, beat, def);
    arr[i] = abbr === 'VOL' ? Math.pow(10, clamp(v, -60, 6) / 20) : v;
  }
  return arr;
}

/**
 * 给渲染用：某个音符范围内的参数值。
 *
 * 取**起点**而不用区间平均 —— 平均会让"渐强"这种写法在长音符上被抹平，
 * 而起点值与"逐音符填参数"的直觉一致（也是 UTAU 的语义）。
 */
export function valueForNote(points, startBeat, durBeat, abbr) {
  const mid = num(startBeat, 0) + Math.max(0, num(durBeat, 1)) * 0.5;
  return sampleAt(points, mid, defaultFor(abbr));
}
