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
  const h = new Array(12).fill(0);
  for (const n of notes) h[n.midi % 12]++;
  const major = [0, 2, 4, 5, 7, 9, 11], minor = [0, 2, 3, 5, 7, 8, 10];
  let best = null;
  for (let r = 0; r < 12; r++) for (const [mode, set] of [['M', major], ['m', minor]]) {
    let sc = 0;
    for (let pc = 0; pc < 12; pc++) sc += h[pc] * (set.includes((pc - r + 12) % 12) ? 1 : -0.3);
    if (!best || sc > best.sc) best = { r, mode, sc };
  }
  return KEY_NAME[best.r] + ' ' + t(best.mode === 'M' ? '大调' : '小调');
}

export function maxPolyphony(notes) {
  const evs = [];
  for (const n of notes) { evs.push([n.start, 1]); evs.push([n.end, -1]); }
  evs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, mx = 0;
  for (const [, d] of evs) { cur += d; if (cur > mx) mx = cur; }
  return mx;
}

export function detectChords(song) {
  const tpb = song.tpb;
  const sig = song.sigMap[0] || { num: 4 };
  const barTicks = tpb * (sig.num || 4);
  const bars = Math.min(8192, Math.max(1, Math.ceil(song.totalTicks / barTicks)));
  // 大文件保护：先按小节分批，仅对音符实际覆盖的小节累计（而非「每小节扫全量音符」），
  // 长音（跨 >3 小节）近似归属起音小节，避免病态文件退化为 O(小节×音符)。
  const buckets = new Array(bars).fill(0).map(() => new Array(12).fill(0));
  for (const tr of song.tracks) for (const n of tr.notes) {
    const b0 = Math.floor(n.start / barTicks);
    if (b0 >= bars) continue;
    const pc = n.midi % 12;
    const b1 = Math.min(bars - 1, Math.floor((n.end - 1) / barTicks));
    const hi = Math.min(b1, b0 + 3); // 长音跨度封顶，只累计起音附近小节
    for (let b = b0; b <= hi; b++) {
      const start = Math.max(n.start, b * barTicks), end = Math.min(n.end, (b + 1) * barTicks);
      if (end > start) buckets[b][pc] += end - start;
    }
  }
  const found = [];
  for (let b = 0; b < bars; b++) {
    const pc = buckets[b];
    let best = null;
    for (let r = 0; r < 12; r++) for (const [m, set] of [[0, [0, 4, 7]], [1, [0, 3, 7]]]) {
      let sc = 0; for (const d of set) sc += pc[(r + d) % 12];
      if (!best || sc > best.sc) best = { r, m, sc };
    }
    if (best && best.sc > 0) found.push({ bar: b + 1, r: best.r, m: best.m, sc: best.sc });
  }
  const map = new Map();
  for (const f of found) {
    const name = KEY_NAME[f.r] + (f.m === 0 ? '' : 'm');
    if (!map.has(name)) map.set(name, { name, count: 0, bars: [] });
    const e = map.get(name); e.count++; e.bars.push(f.bar);
  }
  return Array.from(map.values()).sort((a, b) => b.count - a.count).slice(0, 8);
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
  const offNames = [...new Set(off.map(n => noteName(n.midi)))].slice(0, 8).join('、');

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
