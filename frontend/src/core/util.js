// 通用工具函数（从 legacy FuFumidi.html 抽取，行为保持一致）

export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const midiFreq = m => 440 * Math.pow(2, (m - 69) / 12);

export const KEY_NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const noteName = m => KEY_NAME[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

export function fmtTime(s) {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return m + ':' + String(ss).padStart(2, '0');
}

export function fmtSize(n) {
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

export const pad2 = n => String(n).padStart(2, '0');

// 从若干条轨道里就地移除一批音符，返回移除总数。
//
// 此前各处都是逐个 `indexOf` + `splice`：每次都要线性查找、还要把尾部整体搬移，
// 音符上万时合计 O(N²) —— 表现为「点一下卡很久，甚至像点了没反应」。
// 这里改为倒序单趟 splice：索引从尾部往前走，已处理过的尾部不会再被搬移，整体为 O(N)。
export function removeNotes(tracks, doomed) {
  let n = 0;
  for (const tr of tracks) {
    for (let i = tr.notes.length - 1; i >= 0; i--) {
      if (doomed.has(tr.notes[i])) { tr.notes.splice(i, 1); n++; }
    }
  }
  return n;
}

export const TRACK_COLORS = ['#ff5530', '#ea5ec1', '#1456f0', '#a855f7', '#3daeff', '#1ba673', '#3b82f6', '#f59e0b', '#d45656', '#17437d'];
