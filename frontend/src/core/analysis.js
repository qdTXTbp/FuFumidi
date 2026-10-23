// 音乐分析辅助（从 legacy FuFumidi.html 抽取，行为一致，图表适配主题）
import { t } from './i18n.js';
import { KEY_NAME, noteName, clamp } from './util.js';

function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}

export function detectKey(notes) {
  const k = detectKeySpec(notes);
  return KEY_NAME[k.root] + ' ' + t(k.mode === 'major' ? '大调' : '小调');
}

/** 调性（结构化）：供编辑器「按分析结果设调」直接使用 */
export function detectKeySpec(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes) h[n.midi % 12]++;
  const major = [0, 2, 4, 5, 7, 9, 11], minor = [0, 2, 3, 5, 7, 8, 10];
  let best = null;
  for (let r = 0; r < 12; r++) for (const [mode, set] of [['major', major], ['minor', minor]]) {
    let sc = 0;
    for (let pc = 0; pc < 12; pc++) sc += h[pc] * (set.includes((pc - r + 12) % 12) ? 1 : -0.3);
    if (!best || sc > best.sc) best = { root: r, mode, sc };
  }
  return { root: best.root, mode: best.mode };
}

export function maxPolyphony(notes) {
  const evs = [];
  for (const n of notes) { evs.push([n.start, 1]); evs.push([n.end, -1]); }
  evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, mx = 0;
  for (const [, d] of evs) { cur += d; if (cur > mx) mx = cur; }
  return mx;
}

// 和弦类型表（s：相对根音的半音集合；suffix：显示后缀）。
// 顺序即同分优先级：三和弦在前，避免七和弦因音数多而在证据不足时抢占判定。
const CHORD_TYPES = [
  { s: [0, 4, 7],      suffix: '' },      // 大三
  { s: [0, 3, 7],      suffix: 'm' },     // 小三
  { s: [0, 4, 7, 11],  suffix: 'maj7' },  // 大七
  { s: [0, 4, 7, 10],  suffix: '7' },     // 属七
  { s: [0, 3, 7, 10],  suffix: 'm7' },    // 小七
  { s: [0, 3, 6, 10],  suffix: 'm7b5' },  // 半减七
  { s: [0, 3, 6],      suffix: 'dim' },   // 减三
  { s: [0, 3, 6, 9],   suffix: 'dim7' },  // 减七
  { s: [0, 4, 8],      suffix: 'aug' },   // 增三
  { s: [0, 5, 7],      suffix: 'sus4' },  // 挂四
  { s: [0, 2, 7],      suffix: 'sus2' },  // 挂二
];

/**
 * 单小节和弦评分：平均强度（消除音数红利）+ 根音明确度 - 非和弦音惩罚。
 * 返回 { sc, cover }；cover 为和弦内音权重占比，用于置信度门槛。
 */
function scoreChord(pc, total, root, set) {
  let inSum = 0;
  for (const d of set) inSum += pc[(root + d) % 12];
  const outSum = total - inSum;
  return { sc: inSum / set.length + pc[root] * 0.35 - outSum * 0.45, cover: inSum / total };
}

export function detectChords(song) {
  const { perBar } = barChordScan(song);
  const map = new Map();
  for (const f of perBar) {
    if (!f) continue;
    // 转位：最低音不是根音且在和弦内 → 记为 和弦/低音（如 C/E、G7/B）
    const inv = f.bass >= 0 && f.bass !== f.r && f.set.includes((f.bass - f.r + 12) % 12);
    const name = KEY_NAME[f.r] + f.suffix + (inv ? '/' + KEY_NAME[f.bass] : '');
    if (!map.has(name)) map.set(name, { name, root: f.r, suffix: f.suffix, bass: inv ? f.bass : -1, count: 0, bars: [] });
    const e = map.get(name); e.count++; e.bars.push(f.bar);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, 8);
}

/** 逐小节和弦扫描：返回每小节的最优和弦（无音符的小节为 null） */
function barChordScan(song) {
  const tpb = song.tpb;
  const sig = song.sigMap[0] || { num: 4 };
  const barTicks = tpb * (sig.num || 4);
  const bars = Math.min(8192, Math.max(1, Math.ceil(song.totalTicks / barTicks)));
  // 大文件保护：先按小节分批，仅对音符实际覆盖的小节累计（而非「每小节扫全量音符」），
  // 长音（跨 >3 小节）近似归属起音小节，避免病态文件退化为 O(小节×音符)。
  const buckets = new Array(bars).fill(0).map(() => new Array(12).fill(0));
  const bassPc = new Array(bars).fill(-1);   // 每小节最低音的 pitch class（用于转位判定）
  const bassMidi = new Array(bars).fill(127);
  for (const tr of song.tracks) for (const n of tr.notes) {
    const b0 = Math.floor(n.start / barTicks);
    if (b0 >= bars) continue;
    const pc = n.midi % 12;
    if (n.midi < bassMidi[b0]) { bassMidi[b0] = n.midi; bassPc[b0] = pc; }
    const b1 = Math.min(bars - 1, Math.floor((n.end - 1) / barTicks));
    const hi = Math.min(b1, b0 + 3); // 长音跨度封顶，只累计起音附近小节
    for (let b = b0; b <= hi; b++) {
      const start = Math.max(n.start, b * barTicks), end = Math.min(n.end, (b + 1) * barTicks);
      if (end > start) buckets[b][pc] += end - start;
    }
  }
  const perBar = new Array(bars).fill(null);
  for (let b = 0; b < bars; b++) {
    const pc = buckets[b];
    let total = 0;
    for (let i = 0; i < 12; i++) total += pc[i];
    if (total <= 0) continue;
    let best = null;
    for (let r = 0; r < 12; r++) for (const tp of CHORD_TYPES) {
      const { sc, cover } = scoreChord(pc, total, r, tp.s);
      if (cover < 0.5) continue;             // 置信度门槛：和弦内音须占多数权重
      if (!best || sc > best.sc) best = { r, tp, sc, cover };
    }
    if (best) perBar[b] = { bar: b + 1, r: best.r, suffix: best.tp.suffix, set: best.tp.s, sc: best.sc, bass: bassPc[b] };
  }
  return { bars, barTicks, perBar };
}

/**
 * 和弦轨（P1-2）：逐小节和弦，供编辑器显示与「约束到和弦音」使用。
 * 返回 [{ bar, tick, endTick, name, root, suffix, pcs }]，仅含有音符的小节。
 */
export function detectChordTrack(song) {
  const { barTicks, perBar } = barChordScan(song);
  const out = [];
  for (const f of perBar) {
    if (!f) continue;
    const pcs = [...new Set(f.set.map(d => (f.r + d) % 12))];
    out.push({
      bar: f.bar,
      tick: (f.bar - 1) * barTicks,
      endTick: f.bar * barTicks,
      name: KEY_NAME[f.r] + f.suffix,
      root: f.r, suffix: f.suffix, pcs,
    });
  }
  return out;
}

/* 音名 → pitch class（支持 #/b 与大小写） */
const PC_BY_NAME = (() => {
  const m = {};
  KEY_NAME.forEach((n, i) => { m[n] = i; });
  m['Db'] = 1; m['Eb'] = 3; m['Gb'] = 6; m['Ab'] = 8; m['Bb'] = 10;
  return m;
})();

/** 和弦名 → 调内音级集合（0-11）；无法解析返回 null。用于手改小节和弦后重算约束集合 */
export function chordPcsByName(name) {
  const s = String(name || '').trim();
  const m = s.match(/^([A-Ga-g][#b]?)(.*)$/);
  if (!m) return null;
  const root = PC_BY_NAME[m[1][0].toUpperCase() + m[1].slice(1)];
  if (root == null) return null;
  const parts = m[2].split('/');
  const suffix = (parts[0] || '').trim();
  const tp = CHORD_TYPES.find(x => x.suffix === suffix) || CHORD_TYPES.find(x => x.suffix === '');
  const pcs = tp.s.map(d => (root + d) % 12);
  const bass = (parts[1] || '').trim();
  if (bass && PC_BY_NAME[bass] != null) pcs.push(PC_BY_NAME[bass]);
  return [...new Set(pcs)];
}

function clearCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || cv.parentElement?.clientWidth || 300;
  const h = cv.clientHeight || 120;
  const W = Math.floor(w * dpr), H = Math.floor(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function barChart(cv, values, opts = {}) {
  const { ctx, w, h } = clearCanvas(cv);
  if (!w || !h) return;
  const n = values.length;
  const pad = 6;
  const max = opts.max || Math.max(1, ...values);
  ctx.fillStyle = cssVar('--surface-soft', 'rgba(10,10,10,0.03)'); ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = cssVar('--hairline', 'rgba(10,10,10,0.12)'); ctx.beginPath(); ctx.moveTo(0, h - pad); ctx.lineTo(w, h - pad); ctx.stroke();
  const bw = (w - pad * 2) / n;
  for (let i = 0; i < n; i++) {
    const v = values[i];
    const bh = Math.max(1, v / max * (h - pad * 2 - 14));
    ctx.fillStyle = opts.hotAt && opts.hotAt(i) ? 'rgba(255,85,48,0.95)' : 'rgba(20,86,240,0.85)';
    ctx.fillRect(pad + i * bw + bw * 0.15, h - pad - bh, bw * 0.7, bh);
  }
  if (opts.labels) {
    ctx.fillStyle = cssVar('--stone', 'rgba(10,10,10,0.45)'); ctx.font = '9px Consolas, monospace'; ctx.textAlign = 'center';
    const step = Math.ceil(n / opts.labels.length);
    opts.labels.forEach((lb, li) => {
      const i = Math.min(n - 1, li * step);
      ctx.fillText(lb, pad + i * bw + bw / 2, h - 2);
    });
  }
}

export function hBarChart(cv, items) {
  const { ctx, w, h } = clearCanvas(cv);
  if (!w || !h) return;
  const n = items.length, rh = (h - 10) / n;
  const max = Math.max(1, ...items.map(i => i.val));
  for (let i = 0; i < n; i++) {
    const it = items[i];
    const y = 6 + i * rh;
    const bw = Math.max(2, it.val / max * (w - 90));
    ctx.fillStyle = it.color;
    ctx.fillRect(78, y + 3, bw, Math.max(4, rh - 10));
    ctx.fillStyle = cssVar('--slate', '#4a4a4a'); ctx.font = '10px "Microsoft YaHei", system-ui'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(it.label, 4, y + rh / 2);
    ctx.fillStyle = cssVar('--stone', '#8a8a8a'); ctx.textAlign = 'right';
    ctx.fillText(String(it.val), w - 4, y + rh / 2);
  }
}

export const DUR_LABELS = ['1/32', '1/16', '1/8', '1/4', '1/2', '1', '2', '4+'];

export function durationBin(beats) {
  return beats >= 4 ? 7 : beats >= 2 ? 6 : beats >= 1 ? 5 : beats >= 0.5 ? 4 : beats >= 0.25 ? 3 : beats >= 0.125 ? 2 : beats >= 0.0625 ? 1 : 0;
}

// 与 legacy 相同的通用分析：返回完整统计对象
export function analyzeSong(song) {
  const all = [];
  for (const tr of song.tracks) for (const n of tr.notes) all.push(n);
  const sig = song.sigMap[0];
  let lo = 127, hi = 0;
  for (const n of all) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
  const avg = song.totalSec ? all.length / song.totalSec : 0;
  const key = detectKey(all);
  const maxP = maxPolyphony(all);
  const drums = song.tracks.filter(tr => tr.isDrum).length;
  const chords = detectChords(song);
  const keyRoot = (key || '').split(' ')[0];
  const rootPc = KEY_NAME.indexOf(keyRoot);

  // 各分布
  const pitch = new Array(12).fill(0);
  for (const n of all) pitch[((n.midi % 12) + 12) % 12]++;
  const vel = new Array(16).fill(0);
  for (const n of all) vel[Math.floor(clamp(n.vel, 0, 127) / 8)]++;
  const dur = new Array(8).fill(0);
  for (const n of all) dur[durationBin((n.end - n.start) / song.tpb)]++;

  // 小节密度
  const sigN = sig.num || 4, barTicks = song.tpb * sigN;
  const fullBars = Math.min(20000, Math.max(1, Math.ceil(song.totalTicks / barTicks)));
  const dens = new Array(fullBars).fill(0);
  for (const n of all) { const bi = Math.floor(n.start / barTicks); if (bi < fullBars) dens[bi]++; }

  // 离调/错音
  const major = [0, 2, 4, 5, 7, 9, 11];
  const off = all.filter(n => !major.includes(((n.midi % 12) - rootPc + 12) % 12));
  const offBars = [...new Set(off.map(n => Math.floor(n.start / Math.max(1, barTicks)) + 1))].sort((a, b) => a - b).slice(0, 8);
  const offNames = [...new Set(off.map(n => noteName(n.midi)))].slice(0, 8).join(t('、'));

  // 节奏稳定性
  const tpb = song.tpb || 480;
  let devSum = 0, cnt = 0;
  for (const tr of song.tracks) for (const n of tr.notes) { const beat = Math.round(n.start / tpb); const dev = Math.abs(n.start - beat * tpb); devSum += dev; cnt++; }
  const devAvg = cnt ? devSum / cnt : 0;
  const humanPct = Math.min(100, Math.round(devAvg / (tpb * 0.5) * 100));

  // 力度曲线
  const seg = 40;
  const bins = new Array(seg).fill(0), counts = new Array(seg).fill(0);
  const totalTicks = Math.max(1, song.totalTicks || 1);
  for (const tr of song.tracks) for (const n of tr.notes) {
    const idx = Math.min(seg - 1, Math.floor(n.start / totalTicks * seg));
    bins[idx] += n.vel || 80; counts[idx]++;
  }
  const velCurve = bins.map((b, i) => counts[i] ? b / counts[i] / 127 : 0.3);

  return {
    all: all.length, sig, lo, hi, avg, key, maxP, drums,
    pitch, vel, dur, dens, chords, off, offBars, offNames, humanPct, velCurve,
    barTicks, rootPc,
  };
}

/* ============================================================
 * P1-2 分析升级：转调滑窗 / 段落聚类 / 罗马数字
 * ============================================================ */

/* Krumhansl-Kessler 调性轮廓（大/小调） */
const KS_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KS_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function _pearson(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  const den = Math.sqrt(da * db);
  return den > 0 ? num / den : 0;
}

/** 转调滑窗：按 windowBeats 长度 / hopBeats 步进，对每个窗口做 K-S 调性匹配。
 *  返回 [{ startTick, endTick, root, mode, score, margin }]（margin = 最佳与次佳相关系数差，低置信窗口自行过滤） */
export function detectKeyWindows(notes, opts = {}) {
  const tpb = Math.max(1, Math.round(opts.tpb || 480));
  const windowBeats = Math.max(2, Number(opts.windowBeats) || 16);
  const hopBeats = Math.max(1, Number(opts.hopBeats) || Math.max(1, Math.round(windowBeats / 2)));
  const minNotes = Math.max(1, Number(opts.minNotes) || 6);
  const list = Array.isArray(notes) ? notes.filter((n) => n && Number.isFinite(n.start) && Number.isFinite(n.end)) : [];
  if (!list.length) return [];
  const winTicks = Math.round(windowBeats * tpb), hopTicks = Math.round(hopBeats * tpb);
  const endAll = Math.max.apply(null, list.map((n) => n.end));
  const out = [];
  for (let start = 0; start < endAll; start += hopTicks) {
    const end = start + winTicks;
    const chroma = new Array(12).fill(0);
    let count = 0, total = 0;
    for (const n of list) {
      const ov = Math.min(end, n.end) - Math.max(start, n.start);
      if (ov <= 0) continue;
      chroma[((n.midi % 12) + 12) % 12] += ov;
      total += ov; count += 1;
    }
    if (count < minNotes || total <= 0) continue;
    let best = null, second = null;
    for (let r = 0; r < 12; r++) {
      for (const [mode, prof] of [['major', KS_MAJOR], ['minor', KS_MINOR]]) {
        const tmpl = new Array(12).fill(0);
        for (let pc = 0; pc < 12; pc++) tmpl[pc] = prof[((pc - r) % 12 + 12) % 12];
        const sc = _pearson(chroma, tmpl);
        if (!best || sc > best.score) { second = best; best = { root: r, mode, score: sc }; }
        else if (!second || sc > second.score) second = { root: r, mode, score: sc };
      }
    }
    out.push({
      startTick: start, endTick: end, root: best.root, mode: best.mode,
      score: Math.round(best.score * 1000) / 1000,
      margin: Math.round(((best.score - (second ? second.score : 0))) * 1000) / 1000,
    });
  }
  return out;
}

/** 转调检测：把滑窗结果按同调合并成段落，并丢弃低置信（margin < threshold）窗口 */
export function detectModulations(notes, opts = {}) {
  const threshold = opts.threshold == null ? 0.05 : Number(opts.threshold);
  const wins = detectKeyWindows(notes, opts).filter((w) => w.margin >= threshold);
  const out = [];
  for (const w of wins) {
    const last = out[out.length - 1];
    if (last && last.root === w.root && last.mode === w.mode) {
      last.endTick = Math.max(last.endTick, w.endTick);
      last.windows += 1;
      last.score = Math.round(((last.score * (last.windows - 1) + w.score) / last.windows) * 1000) / 1000;
    } else {
      out.push({ startTick: w.startTick, endTick: w.endTick, root: w.root, mode: w.mode, score: w.score, windows: 1 });
    }
  }
  return out;
}

/** 逐小节能量（时长 × 力度）与和弦标签，供段落聚类用 */
function barEnergyScan(song) {
  const tpb = song.tpb || 480;
  const sig = (song.sigMap && song.sigMap[0]) || { num: 4 };
  const barTicks = Math.max(1, Math.round(tpb * (sig.num || 4) * 4 / ((sig.den || 4))));
  const bars = Math.min(8192, Math.max(1, Math.ceil((song.totalTicks || barTicks) / barTicks)));
  const energy = new Array(bars).fill(0);
  for (const tr of song.tracks || []) for (const n of tr.notes || []) {
    const b0 = Math.floor(n.start / barTicks);
    if (b0 >= bars) continue;
    const b1 = Math.min(bars - 1, Math.floor(Math.max(n.start, n.end - 1) / barTicks));
    for (let b = b0; b <= b1; b++) {
      const ov = Math.min(n.end, (b + 1) * barTicks) - Math.max(n.start, b * barTicks);
      if (ov > 0) energy[b] += ov * (n.vel == null ? 100 : n.vel) / 100;
    }
  }
  return { bars, barTicks, energy };
}

/**
 * 段落聚类（P1-2）：按「和弦标签变化 + 能量突变」切段，再合并过短段。
 * 返回 [{ startBar, endBar, startTick, endTick, label, energy, chords:[{bar,name}] }]
 */
export function detectSegments(song, opts = {}) {
  if (!song) return [];
  const minBars = Math.max(1, Number(opts.minBars) || 2);
  const { barTicks, perBar } = barChordScan(song);
  const { energy } = barEnergyScan(song);
  // 空曲目（没有音符也没有和弦）返回空数组，别造一个空段
  if (!energy.some((e) => e > 0) && !perBar.some(Boolean)) return [];
  const bars = energy.length;
  const labelOf = (b) => (perBar[b] ? perBar[b].r + ':' + perBar[b].suffix : '');
  const out = [];
  let segStart = 0;
  let chordAtStart = labelOf(0);
  for (let b = 1; b < bars; b++) {
    const prevE = energy[b - 1], curE = energy[b];
    const chordChange = labelOf(b) && labelOf(b - 1) && labelOf(b) !== labelOf(b - 1);
    const eRatio = prevE > 0 ? curE / prevE : (curE > 0 ? 99 : 1);
    const energyJump = (eRatio > 1.8 || eRatio < 0.55) && Math.max(prevE, curE) > 0;
    const longEnough = (b - segStart) >= minBars;
    if ((chordChange || energyJump) && longEnough) {
      out.push({ startBar: segStart + 1, endBar: b, barStart: segStart, barEnd: b - 1 });
      segStart = b;
      chordAtStart = labelOf(b) || chordAtStart;
    }
  }
  out.push({ startBar: segStart + 1, endBar: bars, barStart: segStart, barEnd: bars - 1 });
  // 合并过短段
  const merged = [];
  for (const s of out) {
    const last = merged[merged.length - 1];
    if (last && (s.barEnd - s.barStart + 1) < minBars) { last.endBar = s.endBar; last.barEnd = s.barEnd; }
    else merged.push(Object.assign({}, s, { chords: [] }));
  }
  return merged.map((s) => {
    const chords = [];
    for (let b = s.barStart; b <= s.barEnd; b++) if (perBar[b]) chords.push({ bar: b + 1, name: KEY_NAME[perBar[b].r] + perBar[b].suffix });
    const first = chords.length ? chords[0].name : '';
    const lastC = chords.length ? chords[chords.length - 1].name : '';
    let e = 0;
    for (let b = s.barStart; b <= s.barEnd; b++) e += energy[b] || 0;
    return {
      startBar: s.barStart + 1, endBar: s.barEnd + 1,
      startTick: s.barStart * barTicks, endTick: (s.barEnd + 1) * barTicks,
      label: first ? (first === lastC ? first : first + ' → ' + lastC) : '',
      energy: Math.round(e * 10) / 10,
      chords,
    };
  });
}

/** 和弦名 → { root, suffix, bass }（无 bass 返回 -1）；委托给 chordPcsByName 的解析规则 */
export function parseChordName(name) {
  const s = String(name || '').trim();
  const m = s.match(/^([A-Ga-g][#b]?)(.*)$/);
  if (!m) return null;
  const root = PC_BY_NAME[m[1][0].toUpperCase() + m[1].slice(1)];
  if (root == null) return null;
  const parts = m[2].split('/');
  const suffix = (parts[0] || '').trim();
  const bassName = (parts[1] || '').trim();
  return { root, suffix, bass: bassName && PC_BY_NAME[bassName] != null ? PC_BY_NAME[bassName] : -1 };
}

/** 罗马数字级数：C 大调里的 Am → vi；G7 → V7；Bb → bVII；F#dim → #ivdim */
export function romanNumeralOf(chordName, key) {
  const c = parseChordName(chordName);
  if (!c || !key || key.root == null) return '';
  // 输入拼写决定升降：'Bb' 优先降号（bVII），'F#' 优先升号（#iv）
  const spelling = String(chordName || '').match(/^[A-Ga-g]([#b]?)/);
  const preferFlat = !!(spelling && spelling[1] === 'b');
  const preferSharp = !!(spelling && spelling[1] === '#');
  const majorScale = [0, 2, 4, 5, 7, 9, 11];
  const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
  const keyRoot = ((key.root % 12) + 12) % 12;
  const rel = ((c.root - keyRoot) % 12 + 12) % 12;
  let degree = -1;
  for (let i = 0; i < 7; i++) if (majorScale[i] === rel) { degree = i; break; }
  let accidental = '';
  if (degree < 0) {
    // 不在大调音阶里：找最近的音级并加升/降号
    let best = 0, bestAbs = 99, bestSigned = 0;
    for (let i = 0; i < 7; i++) {
      let diff = rel - majorScale[i];
      if (diff > 6) diff -= 12;
      if (diff < -6) diff += 12;
      const abs = Math.abs(diff);
      const better = abs < bestAbs
        || (abs === bestAbs && ((preferFlat && diff < 0 && bestSigned >= 0) || (preferSharp && diff > 0 && bestSigned <= 0)));
      if (better) { bestAbs = abs; best = i; bestSigned = diff; }
    }
    degree = best;
    accidental = bestSigned < 0 ? 'b' : '#';
  }
  const isMinor = /^(m(?!aj7)|m7|m7b5|dim|dim7|m6|m9)/.test(c.suffix);
  let numeral = ROMAN[degree];
  if (isMinor || /^dim/.test(c.suffix)) numeral = numeral.toLowerCase();
  return accidental + numeral + c.suffix.replace(/^m(?!aj7)/, '');
}

/* ============================================================
 * P1-2b 和弦轨写回 MIDI：把逐小节和弦转成 marker 元事件
 * ============================================================
 * 为什么用 marker（0x06）而不是自造事件：P0-1 编码器已能写出 marker，DAW/Cubase/REAPER
 * 都会把它显示在时间线标尺上，兼容性最好；重写时用 chordGen 标记「上一轮生成的」，
 * 只替换自己写过的，不动用户手写的 marker。
 */
function _keyName(root) { return KEY_NAME[((root % 12) + 12) % 12] || String(root); }

/** 调性 spec → 显示名（'C 大调' / 'A 小调'） */
export function keySpecLabel(spec) {
  if (!spec || spec.root == null) return '';
  return _keyName(spec.root) + ' ' + t(spec.mode === 'major' ? '大调' : '小调');
}

/**
 * detectChordTrack() 的逐小节和弦 → marker 事件（默认合并相邻同名和弦）。
 * @param {Array<{tick:number,name:string}>} chords
 * @param {{collapse?:boolean}} opts
 * @returns {Array<{tick:number,type:'marker',text:string,chordGen:true}>}
 */
export function chordMarkersOf(chords, opts = {}) {
  const collapse = opts.collapse !== false;
  const out = [];
  const list = (chords || []).slice().sort((a, b) => a.tick - b.tick);
  for (const c of list) {
    if (!c || !c.name) continue;
    const tick = Math.max(0, Math.round(c.tick || 0));
    const last = out[out.length - 1];
    if (collapse && last && last.text === c.name) continue;
    out.push({ tick, type: 'marker', text: String(c.name), chordGen: true });
  }
  return out;
}

/**
 * 把和弦 marker 合并进一条轨的事件表（纯函数）：先删掉上一轮 chordGen 生成的 marker，
 * 再追加新的；其他事件原样保留，按 tick 稳定排序。返回新数组。
 */
export function mergeChordMarkers(existingEvents, markers) {
  const keep = (existingEvents || []).filter((e) => !(e && e.chordGen));
  const add = (markers || []).map((m) => Object.assign({}, m, { chordGen: true, type: 'marker' }));
  return keep.concat(add).sort((a, b) => (a.tick - b.tick));
}
