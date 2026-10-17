/* ============================================================
   FuFumidi · 调色板常量（M2）
   ============================================================
   为什么单独一个文件：重构前有 27 个 .vue 在 <script> 里各抄一份彩虹
   （共 289 处十六进制字面值），于是"改一个颜色要翻 27 个文件"，
   而且主题切换时画布/图表里的颜色不跟着变。

   现在分两类：
   ① **能读主题的一律读主题**：轨道色 cssVar('--track-N')、元素色 cssVar('--data-N')、
      语义色 cssVar('--t-ok') … —— 运行时光标落在 documentElement 上（core/theme.js 写入），
      深浅色切换立即生效，不需要重载。
   ② **必须写死的兜底**（主题还没应用时的首帧、离屏画布）→ 放在本文件的 RAMP 里。
      全仓库**只有这里**允许出现画布用色的字面值，scripts/check-ui-tokens.mjs 会守这条线。
   ============================================================ */

/** 读主题变量（documentElement 上的内联样式，即 core/theme.js 的产物）。 */
import { themeEpoch } from './theme.js';

/* ↑ 本文件是全仓库唯一允许出现画布/图表颜色字面值的地方（scripts/check-ui-tokens.mjs 守着这条线）。 */

export function cssVar(name, fallback = '') {
  try {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) { return fallback; }
}

/* 逐帧/逐音符读取主题色 —— 带纪元缓存。
   为什么需要它：画布代码里 g.fillStyle = '#3daeff' 这类字面值有 170 处，
   直接换成 getComputedStyle 会在热循环里每次查询样式；缓存后同一主题内只查一次，
   applyTheme 一跑（epoch +1）自动失效。这是"画布颜色跟着主题走"的关键一步。 */
const _cache = new Map();
export function themeColor(name, fallback = '') {
  let epoch = 0;
  try { epoch = themeEpoch(); } catch (e) { epoch = 0; }
  const key = epoch + '|' + name;
  if (_cache.has(key)) return _cache.get(key);
  const v = cssVar(name, fallback);
  _cache.set(key, v);
  return v;
}

/* 八轨色：与 core/theme.js 浅色档的 --track-* 一致，仅在主题未就绪时兜底 */
export const TRACK_FALLBACK = ['#3b82f6', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899'];

/* 七元素数据色：与 --data-1..7（深色档）一致，仅兜底 */
export const DATA_FALLBACK = ['#ff5530', '#ffb340', '#ffe066', '#3ecf8e', '#5ac8fa', '#7c6cff', '#ea5ec1'];

/* 波形/迷你卷帘用的十色序列：ViewConvert 与 ViewEdit 曾经各写一份（逐字节相同） */
export const VIEW_TRACK_RAMP = ['#ff5530', '#ea5ec1', '#1456f0', '#a855f7', '#3daeff', '#1ba673', '#3b82f6', '#f59e0b', '#d45656', '#17437d'];

/* 歌手/声库轨色（8 色）：原先只写在 stores/singer.ts 里 */
export const SINGER_TRACK_RAMP = ['#3d8bfd', '#ff7a45', '#36b37e', '#b37feb', '#f2b705', '#22b8cf', '#f06595', '#7f8c8d'];

/* 色觉障碍友好的定性配色（Okabe-Ito 系，8 色）：stores/singer.ts 的可访问性备选轨色。
   对红绿色盲仍可分辨，明度也拉开了 —— 着色按轨号取模时不会两轨糊在一起。 */
export const SINGER_TRACK_PALETTE_CB = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#F0E442', '#000000'];

/* 视效面板的四支起手色：左右手 / 力度低高。面板里可改，这里只是初值。
   原先直接写在 ViewViz.vue 的 setFxAny 调用里 —— 那是"用户数据"和"设计常量"混在一起。 */
export const FX_DEFAULT_COLORS = { handL: '#4f8dff', handR: '#ff7a3d', velLow: '#2f6fd0', velHigh: '#ff5530' };

/* 对比/评分图表用的五色序列 */
export const CHART_RAMP = ['#5ac8fa', '#ff9f0a', '#bf5af2', '#30d158', '#ff453a'];

/** 轨道色（8 档，读 --track-1..8） */
export function trackPalette() {
  return TRACK_FALLBACK.map((c, i) => cssVar('--track-' + (i + 1), c));
}

/** 元素数据色（7 档，读 --data-1..7） */
export function dataPalette() {
  return DATA_FALLBACK.map((c, i) => cssVar('--data-' + (i + 1), c));
}

/** 语义色：ok / warn / err / info —— 图表里标状态时用，别再用 #22c55e 这类字面值 */
export function semPalette() {
  return {
    ok: cssVar('--t-ok', '#3ecf8e'),
    warn: cssVar('--t-warn', '#ffb340'),
    err: cssVar('--t-err', '#ff6b6b'),
    info: cssVar('--t-info', '#5ac8fa'),
  };
}
