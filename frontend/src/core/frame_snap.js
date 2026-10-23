// ============================================================
// P1-6 影视配乐：帧吸附 + 时间码（纯逻辑）
// ============================================================
// 帧吸附本质是**时间**吸附，不是 tick 吸附：23.976/29.97 这类非整数帧率下，
// 一个 tick 对应的秒数会随 tempoMap 变化，所以先 tick→秒，按 fps 取整，再秒→tick。
// 全部计算走 C4 TimelineModel（tempoMap/SMPTE 都由它统一处理）。
import { secOfTick, tickOfSec } from './timeline.js';

export const FPS_PRESETS = [
  { fps: 23.976, label: '23.976 fps（电影）' },
  { fps: 24, label: '24 fps（电影）' },
  { fps: 25, label: '25 fps（PAL）' },
  { fps: 29.97, label: '29.97 fps（NTSC）' },
  { fps: 30, label: '30 fps' },
];
export function normalizeFps(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 25;
  // 常见写法容错：29.97/30 都保留；其它夹到 [1,240]
  return Math.max(1, Math.min(240, n));
}
/** 一帧多少秒 */
export function frameSeconds(fps) { return 1 / normalizeFps(fps); }
/** tick 落在第几帧（从 0 起） */
export function frameOfTick(timeline, tick, fps) {
  return Math.round(secOfTick(timeline, tick) * normalizeFps(fps));
}
/** 帧 → tick（时间域，按 timeline 的分段 tempo 反算） */
export function tickOfFrame(timeline, frame, fps) {
  return tickOfSec(timeline, Math.max(0, Math.round(Number(frame) || 0)) / normalizeFps(fps));
}
/** 把 tick 吸附到最近帧边界（返回 tick，可能是小数——调用方按需 round） */
export function snapTickToFrame(timeline, tick, fps) {
  const f = Math.round(secOfTick(timeline, Math.max(0, Number(tick) || 0)) * normalizeFps(fps));
  return tickOfSec(timeline, f / normalizeFps(fps));
}
/** 两个 tick 之间有多少帧（用于统计/显示） */
export function framesBetween(timeline, a, b, fps) {
  const f = normalizeFps(fps);
  return Math.round((secOfTick(timeline, Math.max(a, b)) - secOfTick(timeline, Math.min(a, b))) * f);
}
/**
 * tick → 时间码 'HH:MM:SS:FF'（非丢帧；29.97 显示为 30 帧计数，与主流 DAW 的 NDF 一致）
 */
export function timecodeOfTick(timeline, tick, fps) {
  const f = normalizeFps(fps);
  const total = Math.max(0, secOfTick(timeline, Math.max(0, Number(tick) || 0)));
  // 先量化到帧再拆分，避免 59.999 秒被算成 00:00:59:29
  const totalFrames = Math.round(total * f);
  const fpsInt = f === 29.97 ? 30 : Math.round(f);
  const frames = totalFrames % fpsInt;
  const totalSec = Math.floor(totalFrames / fpsInt);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const pad = (n) => String(n).padStart(2, '0');
  return pad(hh) + ':' + pad(mm) + ':' + pad(ss) + ':' + pad(frames);
}
/** 视频起点偏移：播放位置对应的视频时间（秒，可负 → 视频还没开始） */
export function videoTimeForPlayhead(playSec, offsetSec = 0) {
  return Number(playSec || 0) + Number(offsetSec || 0);
}
/** 该处「一帧」对应多少 tick（tick 步长随 tempoMap 变化，UI 显示用） */
export function frameTickStep(timeline, tick, fps) {
  const sec = secOfTick(timeline, Math.max(0, Number(tick) || 0));
  return Math.max(0, tickOfSec(timeline, sec + frameSeconds(fps)) - tickOfSec(timeline, sec));
}
