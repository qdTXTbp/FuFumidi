// ============================================================
// 播放时跳过空白片段 —— 纯函数，便于单测（frontend/tests/skip-silence.test.js）
//
// ★ 判据是「音符间隙」而不是音频静音：FuFumidi 播的是 MIDI 合成音，
//   "空白"就是"这段时间没有任何音符"。做音频分析要解整首歌、还要额外内存，
//   而且和实际发声的内容不一致（弱奏段落没有音符但音频不静音）。
//
// 用户 2026-10-14 定：开关**默认关**（给一个显眼的开关），
//   但**开头静音默认跳**（一上来先空几十秒很烦）。
// ============================================================

/** 合并重叠/相接的区间（输入 [{start,end}]，秒）。*/
export function mergeSpans(spans) {
  const arr = (spans || [])
    .filter((s) => s && Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const s of arr) {
    const last = out[out.length - 1];
    if (last && s.start <= last.end) last.end = Math.max(last.end, s.end);
    else out.push({ start: s.start, end: s.end });
  }
  return out;
}

/** 长度 ≥ minGapSec 的空档列表。空档 = 相邻音符区间之间（含首尾）没有音符的时间。*/
export function computeGaps(notes, minGapSec) {
  const min = Number(minGapSec) > 0 ? Number(minGapSec) : 0;
  const spans = mergeSpans(notes);
  if (!spans.length) return [];
  const gaps = [];
  for (let i = 1; i < spans.length; i++) {
    const a = spans[i - 1].end;
    const b = spans[i].start;
    if (b - a >= min) gaps.push({ start: a, end: b });
  }
  return gaps;
}

/** 开头静音（第一个音符之前）时长 ≥ minSec 时返回该音符的起点，否则 null。*/
export function leadingSilenceEnd(notes, minSec) {
  const spans = mergeSpans(notes);
  if (!spans.length) return null;
  const min = Number(minSec) > 0 ? Number(minSec) : 0;
  return spans[0].start >= min ? spans[0].start : null;
}

/** sec 落在哪个空档里（不在任何空档返回 null）。*/
export function gapAt(gaps, sec) {
  if (!Array.isArray(gaps) || !Number.isFinite(sec)) return null;
  for (const g of gaps) {
    if (sec >= g.start && sec < g.end) return g;
  }
  return null;
}

/**
 * 要不要跳、跳到哪。返回目标秒数或 null（不跳）。
 * lead：落到空档结尾前多久（留一点余量，免得正好落在下一个音上）。
 */
export function nextSkipTarget({ gaps, sec, lead = 0.2, totalSec = Infinity }) {
  const g = gapAt(gaps, sec);
  if (!g) return null;
  let target = g.end - (Number(lead) > 0 ? Number(lead) : 0);
  if (target <= sec) return null;
  if (Number.isFinite(totalSec)) target = Math.min(target, totalSec);
  return target;
}
