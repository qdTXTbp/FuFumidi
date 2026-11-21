/* ============================================================
   core/roll_preview.js —— 「卷帘」页签的纯逻辑（不碰 DOM）
   ============================================================
   参照 CodePen《midi可视化》(Vencent-Bill / xbGayxZ) 的语义：
     · 横轴 = 时间（px/s），纵轴 = 音高，**按 127 键全键盘定位**
       （top = (127 - midi) × 行距；不是按当前曲目的音域裁切——
        这样同一份 MIDI 在任何曲目里位置都一致，换歌不会整体跳一下）
     · 音符条固定 6px 高；最短高亮时间保证 16 分音符也看得见
     · 独立走带：自己的 playbackTime，用 BPM 覆盖控制快慢

   为什么抽成纯函数：几何与命中（px/s、行距、最短高亮、居中滚动）
   是这块唯一会算错的东西，塞进 .vue 就只能靠肉眼。
   ============================================================ */

/** 与 CodePen 默认值一致：20–300 px/s、2–20 px 行距、0.20s 最短高亮 */
export const ROLL_LIMITS = {
  pxPerSec: { min: 20, max: 300, step: 5, def: 60 },
  rowPx: { min: 2, max: 20, step: 1, def: 8 },
  minHighlight: { min: 0.01, max: 2, step: 0.01, def: 0.2 },
};

/** 音符条高度（px）—— 与参考实现一致，固定 6，不随行距缩放 */
export const NOTE_H = 6;
/** MIDI 最高键号：top = (KEY_MAX - midi) × 行距 */
export const KEY_MAX = 127;
export const KEY_COUNT = 128;
/** 末尾留白（px） */
export const TAIL_PAD = 100;

/**
 * 把曲目拍平成音符列表 [{start,end,midi,vel,track}]。
 * 跳过残缺音符（历史工程里偶有 end/midi 为空），一个坏音符不该毁掉整张卷帘。
 */
export function collectNotes(song) {
  const out = [];
  const tracks = song && Array.isArray(song.tracks) ? song.tracks : [];
  tracks.forEach((tr, ti) => {
    const list = tr && Array.isArray(tr.notes) ? tr.notes : [];
    for (const n of list) {
      if (!n) continue;
      const start = Number(n.start);
      const end = Number(n.end);
      const midi = Number(n.midi);
      if (!Number.isFinite(start) || !Number.isFinite(end) || !Number.isFinite(midi)) continue;
      out.push({
        start,
        end: Math.max(end, start),
        midi,
        vel: Number.isFinite(Number(n.vel)) ? Number(n.vel) : 0.8,
        track: ti,
      });
    }
  });
  return out;
}

/** 曲目时长（秒）：最后一个音符的结束时间 */
export function durationOf(notes) {
  let end = 0;
  for (const n of notes || []) if (n.end > end) end = n.end;
  return end;
}

/** 卷帘内容宽度（px）= 时长 × px/s + 末尾留白 */
export function rollWidth(notes, pxPerSec, padPx = TAIL_PAD) {
  const px = Number(pxPerSec) || ROLL_LIMITS.pxPerSec.def;
  return Math.max(0, durationOf(notes) * px + padPx);
}

/** 卷帘内容高度（px）：128 个键 × 行距 */
export function rollHeight(rowPx) {
  const row = Number(rowPx) || ROLL_LIMITS.rowPx.def;
  return KEY_COUNT * row;
}

/**
 * 单个音符的矩形（相对卷帘内容左上角）。
 * 宽最少 2px：20ms 的音符在 20px/s 下不到 1px，否则等于没画。
 */
export function noteRect(note, { pxPerSec, rowPx } = {}) {
  const px = Number(pxPerSec) || ROLL_LIMITS.pxPerSec.def;
  const row = Number(rowPx) || ROLL_LIMITS.rowPx.def;
  return {
    x: note.start * px,
    y: (KEY_MAX - note.midi) * row,
    w: Math.max((note.end - note.start) * px, 2),
    h: NOTE_H,
  };
}

/**
 * 播放头 t（秒）是否落在音符的发声窗口内。
 * minHighlight 是参考实现里的关键参数：短音符不加下限只会闪一下。
 */
export function isNoteActive(t, note, minHighlight = ROLL_LIMITS.minHighlight.def) {
  if (!note) return false;
  const minDur = Math.max(0, Number(minHighlight) || 0);
  const dur = Math.max(note.end - note.start, minDur);
  return t >= note.start && t < note.start + dur;
}

/** 播放头居中所需的横向滚动量（两端夹住，避免负值/滚过头） */
export function followScroll(playX, viewW, contentW) {
  const max = Math.max(0, contentW - viewW);
  const want = playX - viewW / 2;
  if (!Number.isFinite(want)) return 0;
  return Math.min(Math.max(want, 0), max);
}

/**
 * 纵向初始位置：把这批音符的音域居中，别让用户一进来看到一片空白
 * （参考实现固定高 800，本页高度随窗口变化，所以补一个居中）。
 */
export function centerScrollTop(notes, rowPx, viewH) {
  const row = Number(rowPx) || ROLL_LIMITS.rowPx.def;
  const content = rollHeight(row);
  if (!notes || !notes.length) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const n of notes) {
    if (n.midi < min) min = n.midi;
    if (n.midi > max) max = n.midi;
  }
  const mid = ((KEY_MAX - min) + (KEY_MAX - max)) / 2 * row + NOTE_H / 2;
  return Math.min(Math.max(mid - viewH / 2, 0), Math.max(0, content - viewH));
}

/**
 * 播放倍率：BPM 覆盖 / 原曲 BPM。
 * 原曲 BPM 缺失时按 120（参考实现同样是 `tempos[0]?.bpm || 120`）。
 */
export function tempoFactorOf(originalBpm, customBpm) {
  const base = Number(originalBpm) > 0 ? Number(originalBpm) : 120;
  const want = Number(customBpm) > 0 ? Number(customBpm) : base;
  return want / base;
}
