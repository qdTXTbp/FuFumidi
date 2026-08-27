// 乐谱生成（从 legacy FuFumidi.html 抽取）：MIDI 轨道 → ABC / 简谱 / 吉他·贝斯 TAB
import { t } from './i18n.js';
import { clamp, esc } from './util.js';

const ABC_LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const ABC_NATURAL_PC = [0, 2, 4, 5, 7, 9, 11];
const ABC_MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11];
export const ABC_KEY_NAMES = { 0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#', [-1]: 'F', [-2]: 'Bb', [-3]: 'Eb', [-4]: 'Ab', [-5]: 'Db', [-6]: 'Gb', [-7]: 'Cb' };

// 无 key 事件时按音符分布估算调号（sf = 升降号数，五度圈计分）
export function detectSf(notes) {
  const h = new Array(12).fill(0);
  for (const n of notes) h[n.midi % 12]++;
  let best = null;
  for (let sf = -7; sf <= 7; sf++) {
    const tonic = ((7 * sf) % 12 + 12) % 12;
    const scale = ABC_MAJOR_SCALE.map(s => (tonic + s) % 12);
    let sc = 0;
    for (let pc = 0; pc < 12; pc++) sc += h[pc] * (scale.includes(pc) ? 1 : -0.3);
    if (!best || sc > best.sc) best = { sf, sc };
  }
  return best.sf;
}

// MIDI 音高 → ABC 音名文本
function abcPitch(midi) {
  const pc = ((midi % 12) + 12) % 12;
  let best = 0, bestErr = 9;
  for (let d = 0; d < 7; d++) {
    let diff = (pc - ABC_NATURAL_PC[d] + 12) % 12;
    if (diff > 6) diff -= 12;
    const err = Math.abs(diff);
    if (err < bestErr) { bestErr = err; best = d; }
  }
  let diff = (pc - ABC_NATURAL_PC[best] + 12) % 12;
  if (diff > 6) diff -= 12;
  const acc = diff > 0 ? '^'.repeat(diff) : diff < 0 ? '_'.repeat(-diff) : '';
  const oct = Math.round((midi - 60 - ABC_NATURAL_PC[best] - diff) / 12);
  const letter = ABC_LETTERS[best];
  if (oct === 0) return letter + acc;
  if (oct > 0) return letter.toLowerCase() + "'".repeat(oct - 1) + acc;
  return letter + ','.repeat(-oct) + acc;
}

// 时值（拍）→ ABC 时值文本（1/64 网格 + gcd 约分）
function abcDuration(beats) {
  let q = Math.round(beats * 64);
  if (q <= 0) q = 1;
  const gcd = (a, b) => b ? gcd(b, a % b) : a;
  const d = gcd(q, 64);
  const num = q / d, den = 64 / d;
  if (num === 1 && den === 1) return '';
  if (den === 1) return String(num);
  if (num === 1) return '/' + den;
  return num + '/' + den;
}

// 音符流切小节 → ABC 行
function abcVoiceBars(notes, tpb, quartersPerBar, beam, simple) {
  const barTicks = quartersPerBar * tpb;
  if (!notes.length) return [];
  const grid = Math.max(1, Math.round(tpb / (simple ? 4 : 8))); // 1/16 或 1/32
  const qn = [];
  for (const n of notes) {
    const qs = Math.round(n.start / grid) * grid;
    let qe = Math.round(n.end / grid) * grid;
    if (qe <= qs) qe = qs + grid;
    qn.push({ start: qs, end: qe, midi: n.midi });
  }
  qn.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const x of qn) {
    const prev = merged[merged.length - 1];
    if (prev && prev.start === x.start && prev.midi === x.midi) { if (x.end > prev.end) prev.end = x.end; }
    else merged.push(x);
  }
  const perBar = new Map();
  for (const n of merged) {
    let s = n.start;
    while (s < n.end) {
      const b = Math.floor(s / barTicks);
      const e = Math.min(n.end, (b + 1) * barTicks);
      let arr = perBar.get(b); if (!arr) { arr = []; perBar.set(b, arr); }
      arr.push({ start: s, end: e, midi: n.midi, tieOut: e < n.end });
      s = e;
    }
  }
  const bars = [...perBar.keys()].sort((a, b) => a - b);
  const lines = [];
  for (const bar of bars) {
    const barStart = bar * barTicks, barEnd = barStart + barTicks;
    const segs = perBar.get(bar).slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
    const seq = [];
    let cursor = barStart, i = 0;
    while (i < segs.length) {
      const onset = segs[i].start;
      if (onset > cursor) {
        seq.push({ text: 'z' + abcDuration((onset - cursor) / tpb), beat: (cursor - barStart) / tpb, end: (onset - barStart) / tpb });
        cursor = onset;
      }
      const chord = []; let tieOut = false, grpMax = onset;
      const grpStart = segs[i].start;
      while (i < segs.length && segs[i].start === grpStart) {
        const g = segs[i++];
        chord.push(g.midi);
        if (g.end > grpMax) grpMax = g.end;
        if (g.tieOut) tieOut = true;
      }
      const nextStart = i < segs.length ? segs[i].start : barEnd;
      const dur = Math.max(0, Math.min(grpMax, nextStart) - onset);
      const tie = tieOut && (onset + dur >= barEnd - 1) && bar < bars[bars.length - 1];
      chord.sort((a, b) => a - b);
      const body = (chord.length > 1 ? '[' + chord.map(m => abcPitch(m)).join('') + ']' : abcPitch(chord[0])) + abcDuration(dur / tpb);
      seq.push({ text: body + (tie ? '-' : ''), beat: (onset - barStart) / tpb, end: (onset - barStart + dur) / tpb });
      cursor = onset + dur;
    }
    const fill = quartersPerBar - (cursor - barStart) / tpb;
    if (fill > 0.004) seq.push({ text: 'z' + abcDuration(fill), beat: (cursor - barStart) / tpb, end: quartersPerBar });
    let line = '';
    for (let k = 0; k < seq.length; k++) {
      if (k > 0) {
        const prev = seq[k - 1];
        const prevEnd = prev.end;
        line += (!beam || prev.text.charCodeAt(0) === 122 || Math.abs(prevEnd - Math.round(prevEnd)) < 0.004) ? ' ' : '';
      }
      line += seq[k].text;
    }
    lines.push(line);
  }
  return lines;
}

// 整个 MIDI 轨道 → ABC 文本（大谱表/单谱表自动判断）
export function songToAbc(s, trkIdx, groupN = 4, opts = {}) {
  const tr = s.tracks[trkIdx];
  if (!tr || !tr.notes.length) return '';
  const tpb = s.tpb;
  const sig = s.sigMap[0] || { num: 4, den: 4 };
  const quartersPerBar = sig.num * 4 / sig.den;
  const bpm = Math.round(((s.tempoMap && s.tempoMap[0]) ? 60000000 / s.tempoMap[0].us : (s.initialBpm || 120)) * 10) / 10;
  const sfRaw = (s.keySig && s.keySig.sf != null) ? s.keySig.sf : detectSf(tr.notes);
  const sf = clamp(sfRaw, -7, 7);
  const low = tr.notes.filter(n => n.midi < 60);
  const high = tr.notes.filter(n => n.midi >= 60);
  const twoStaff = low.length > 0 && high.length > 0;
  const name = String(tr.name || ('轨道 ' + (trkIdx + 1))).replace(/[\r\n|%]/g, ' ').replace(/\s+/g, ' ').trim() || ('Track ' + (trkIdx + 1));
  const beam = !!opts.beam;
  let h = 'X:1\nT:' + name + '\nM:' + sig.num + '/' + sig.den + '\nL:1/4\nQ:1/4=' + bpm + '\nK:' + (ABC_KEY_NAMES[sf] || 'C') + '\n';
  const group = Math.max(1, Math.round(groupN) || 4);
  if (twoStaff) {
    h += 'V:1 clef=treble\nV:2 clef=bass\n';
    const hiBars = abcVoiceBars(high, tpb, quartersPerBar, beam, opts.simple);
    const loBars = abcVoiceBars(low, tpb, quartersPerBar, beam, opts.simple);
    const nBars = Math.max(hiBars.length, loBars.length);
    const empty = 'z' + abcDuration(quartersPerBar);
    for (let start = 0; start < nBars; start += group) {
      const end = Math.min(nBars, start + group);
      const hiLine = [], loLine = [];
      for (let b = start; b < end; b++) { hiLine.push(hiBars[b] || empty); loLine.push(loBars[b] || empty); }
      h += '[V:1] ' + hiLine.join(' | ') + ' |\n';
      h += '[V:2] ' + loLine.join(' | ') + ' |\n';
    }
  } else {
    const bars = abcVoiceBars(tr.notes, tpb, quartersPerBar, beam, opts.simple);
    for (let start = 0; start < bars.length; start += group) {
      h += bars.slice(start, start + group).join(' | ') + ' |\n';
    }
  }
  return h;
}

/* ---------------- 简谱 ---------------- */
export function jianpuNoteInfo(midi, sf) {
  const root = ((sf * 7) % 12 + 12) % 12;
  const SCALE = [0, 2, 4, 5, 7, 9, 11];
  const pc = ((midi % 12) + 12) % 12;
  let acc = '';
  let rel = ((pc - root) % 12 + 12) % 12;
  let idx = SCALE.indexOf(rel);
  if (idx < 0) { let best = 0, bd = 12; SCALE.forEach((s, i) => { const d = Math.min(Math.abs(rel - s), 12 - Math.abs(rel - s)); if (d < bd) { bd = d; best = i; } }); idx = best; acc = rel > SCALE[best] ? '#' : 'b'; }
  const oct = Math.floor(midi / 12);
  const dots = oct >= 6 ? '·' : oct <= 3 ? '˙' : '';
  return { num: idx + 1, acc, dots };
}

// 返回简谱渲染数据（供 Vue 模板渲染）
export function jianpuData(song, trkIdx) {
  const tr = song.tracks[trkIdx];
  if (!tr || !tr.notes.length) return { error: t('该轨道没有音符') };
  if (tr.isDrum) return { error: t('鼓组轨道不适合简谱显示，请切换其它轨道') };
  const MAX = 20000;
  const shown = tr.notes.slice(0, MAX);
  const sf = (song.keySig && song.keySig.sf) || 0;
  const beats = song.tpb;
  const cells = shown.map(n => {
    const info = jianpuNoteInfo(n.midi, sf);
    const b = (n.end - n.start) / beats;
    const cls = b >= 4 ? 'jp-long' : b >= 2 ? 'jp-half' : b <= 0.25 ? 'jp-16' : b <= 0.5 ? 'jp-8' : '';
    const dash = b >= 4 ? '— — —' : b >= 2 ? '—' : '';
    return { acc: info.acc, num: info.num, dots: info.dots, cls, dash };
  });
  return { cells, truncated: tr.notes.length > MAX, total: tr.notes.length, max: MAX };
}

/* ---------------- 吉他 / 贝斯 TAB ---------------- */
export function tabData(song, trkIdx, strings) {
  const tr = song.tracks[trkIdx];
  if (!tr || !tr.notes.length) return { error: t('该轨道没有音符') };
  if (tr.isDrum) return { error: t('鼓组轨道不适合弦乐 TAB，请切换其它轨道') };
  const tpb = song.tpb;
  const step = tpb / 2;   // 每列 = 八分音符
  const total = Math.ceil(song.totalTicks / step);
  const grid = Array.from({ length: total }, () => Array(strings.length).fill(null));
  const minOpen = Math.min(...strings), maxOpen = Math.max(...strings);
  let placed = 0;
  for (const n of tr.notes) {
    let best = null, bestPen = Infinity;
    for (const delta of [-24, -12, 0, 12, 24]) {
      const p = n.midi + delta;
      strings.forEach((s, i) => {
        const f = p - s;
        if (f < 0 || f > 24) return;
        const pen = Math.abs(f - 7) + Math.abs(delta);
        if (pen < bestPen) { bestPen = pen; best = { i, f }; }
      });
    }
    if (best) {
      const c = Math.floor(n.start / step);
      if (c < total) { grid[c][best.i] = best.f; placed++; }
    }
  }
  if (!placed) return { error: t('该轨道音高超出当前乐器范围，无法自动编配把位') };
  const colsPerBar = 8, barsPerLine = 4;
  const beatsPerBar = (song.sigMap && song.sigMap[0]) ? song.sigMap[0].num : 4;
  const totalBars = Math.max(1, song.bars || Math.ceil((tr.notes.length ? tr.notes[tr.notes.length - 1].end : 0) / (tpb * beatsPerBar)));
  const names = strings.length === 6 ? ['e', 'B', 'G', 'D', 'A', 'E'] : ['G', 'D', 'A', 'E'];
  const systems = [];
  for (let start = 0; start < totalBars; start += barsPerLine) {
    const end = Math.min(totalBars, start + barsPerLine);
    const lines = strings.map((_, si) => {
      const cells = [];
      for (let b = start; b < end; b++) {
        const barCells = [];
        for (let c = 0; c < colsPerBar; c++) {
          const g = grid[b * colsPerBar + c] || [];
          barCells.push(g[si] == null ? '--' : String(g[si]).padStart(2, ' '));
        }
        cells.push(barCells.join(' '));
      }
      return names[si] + '|' + cells.join(' | ') + '|';
    });
    systems.push(lines);
  }
  return { systems, placed };
}
