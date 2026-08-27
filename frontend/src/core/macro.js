// 宏系统纯函数：从 ViewEdit.vue 抽离，便于单元测试与复用
// 操作对象为 song.tracks[].notes（{ start, end, midi, vel }），tpb 为每四分音符 tick 数
import { clamp } from './util.js';

export const MACRO_DOC = [
  { cmd: 'transpose N', desc: '将所有/选中音符移调 N 个半音（N 可为负）' },
  { cmd: 'quantize N', desc: '按 N 分音符量化起点和时值（如 8 = 八分音符）' },
  { cmd: 'normalize', desc: '力度归一化到 80-127（有选区时只处理选区）' },
  { cmd: 'vel_inc N', desc: '力度增加 N（1-127 之间截断）' },
  { cmd: 'vel_dec N', desc: '力度减少 N（1-127 之间截断）' },
  { cmd: 'vel_fix N', desc: '将力度固定为 N' },
  { cmd: 'clean', desc: '删除力度为 0 的音符，并量化所有音符' },
];

export function macroToCmd(name) {
  if (name === 'clean') return 'clean';
  if (name === 'transpose_up') return 'transpose 12';
  if (name === 'normalize_vel') return 'normalize';
  return name;
}

export function parseMacroScript(script) {
  return String(script || '')
    .split(/[\n;]+/)
    .map(x => x.trim())
    .filter(Boolean);
}

function allNotes(song) {
  if (!song || !Array.isArray(song.tracks)) return [];
  return song.tracks.reduce((a, tr) => a.concat(tr.notes || []), []);
}

function useSelectionOrAll(opts, fallback) {
  if (Array.isArray(opts.selection)) return opts.selection;
  return fallback;
}

export function applyMacroLine(song, line, opts = {}) {
  const tpb = opts.tpb ?? song?.tpb ?? 480;
  const command = String(line || '').trim();
  if (!command || !song) return { changed: 0, op: '', arg: 0 };

  const parts = command.split(/\s+/);
  const op = parts[0] || '';
  const arg = parseFloat(parts[1]) || 0;
  const notes = allNotes(song);
  let changed = 0;

  if (op === 'clean') {
    for (const tr of song.tracks) {
      const trNotes = tr.notes || [];
      const before = trNotes.length;
      tr.notes = trNotes.filter(n => n.vel > 0);
      changed += before - tr.notes.length;
      for (const n of tr.notes) {
        const st = Math.round(n.start / tpb) * tpb;
        n.end = n.end - n.start + st;
        n.start = st;
        changed++;
      }
    }
  } else if (op === 'transpose') {
    for (const n of notes) {
      n.midi = clamp(n.midi + arg, 0, 127);
      changed++;
    }
  } else if (op === 'quantize') {
    const gridTicks = tpb * 4 / (arg || 8);
    for (const n of notes) {
      const st = Math.round(n.start / gridTicks) * gridTicks;
      n.end = n.end - n.start + st;
      n.start = st;
      changed++;
    }
  } else if (op === 'normalize') {
    const src = useSelectionOrAll(opts, notes);
    if (src.length) {
      const min = Math.min(...src.map(n => n.vel));
      const max = Math.max(...src.map(n => n.vel));
      const range = Math.max(1, max - min);
      for (const n of src) {
        n.vel = Math.round(80 + (n.vel - min) / range * 47);
        changed++;
      }
    }
  } else if (op === 'vel_inc') {
    for (const n of notes) {
      n.vel = clamp(n.vel + arg, 1, 127);
      changed++;
    }
  } else if (op === 'vel_dec') {
    for (const n of notes) {
      n.vel = clamp(n.vel - arg, 1, 127);
      changed++;
    }
  } else if (op === 'vel_fix') {
    for (const n of notes) {
      n.vel = clamp(arg, 1, 127);
      changed++;
    }
  }

  return { changed, op, arg };
}

export function applyMacroScript(song, script, opts = {}) {
  const lines = Array.isArray(script) ? script.slice() : parseMacroScript(script);
  let changed = 0;
  const touched = [];
  for (const line of lines) {
    const result = applyMacroLine(song, line, opts);
    changed += result.changed;
    if (result.changed) touched.push(line);
  }
  return { changed, touched, lines: lines.length };
}