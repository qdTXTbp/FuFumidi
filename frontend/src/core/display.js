// ============================================================
// 外观三件：界面字号 / 界面密度 / 全局 UI 缩放（M9）
// ============================================================
// 为什么单独一个模块：这三件在**两个地方**都要生效 ——
//   ① App.vue 启动时（防闪烁：先按 localStorage 应用，settings 只兜底）
//   ② 设置面板里改一下要**立即**看到（onFontSize / onDensity / onUiScale）。
// 以前两处各写一份（各带一套自己的取值校验），于是脏数据在一处被夹紧、在另一处原样
// 透传给 CSS —— 界面看起来就是「改了没反应」。现在取值域只在这里定义一次。

/** 密度三档：紧凑 / 舒适（默认）/ 宽松。CSS 见 styles.css 的 body[data-density] 段。 */
export const DENSITIES = ['compact', 'comfortable', 'relaxed'];
/** 界面字号三档（空串 = 用样式表默认） */
export const FONT_SIZES = { standard: '', large: '15px', xlarge: '17px' };
export const UI_SCALE_MIN = 0.9;
export const UI_SCALE_MAX = 1.3;
export const UI_SCALE_STEP = 0.05;

export function normalizeDensity(v) {
  return DENSITIES.indexOf(v) >= 0 ? v : 'comfortable';
}
export function normalizeFont(v) {
  return Object.prototype.hasOwnProperty.call(FONT_SIZES, v) ? v : 'standard';
}
/** 缩放夹到 0.9~1.3 并对齐到 5% 档（滑杆本来就是 0.05 步进，这里防的是脏值 / 手改 localStorage） */
export function clampScale(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  const snapped = Math.round(n / UI_SCALE_STEP) * UI_SCALE_STEP;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, Math.round(snapped * 100) / 100));
}

/**
 * 全局 UI 缩放：走 Electron 的 webFrame 缩放因子，而不是 CSS transform。
 *   transform: scale() 只改画面不改排版（元素会互相压住），而且画布会糊；
 *   缩放因子是真重排，devicePixelRatio 跟着变，画布的 devicePixel 尺寸自动跟上（依旧清晰）。
 * 浏览器里跑（没有桥）时退回 CSS zoom —— 它在 Chromium 里同样是重排级缩放。
 */
export function applyUiScale(v) {
  const s = clampScale(v);
  if (typeof document === 'undefined') return s;
  const b = (typeof window !== 'undefined') ? window.fuBridge : null;
  if (b && typeof b.setZoomFactor === 'function') {
    try { b.setZoomFactor(s); } catch (e) { /* 桥在但调用失败：dataset 仍可查 */ }
  } else {
    try { document.documentElement.style.zoom = String(s); } catch (e) { /* 忽略 */ }
  }
  // 验收/调试可读：当前生效的缩放（真实缩放因子在 fuBridge.getZoomFactor 里）
  try { document.documentElement.dataset.uiScale = String(s); } catch (e) { /* 忽略 */ }
  return s;
}

/** 启动时应用三件（settings 只兜底，localStorage 优先） */
export function applyDisplayPrefs(s) {
  if (typeof document === 'undefined') return;
  const src = s || {};
  document.body.style.fontSize = FONT_SIZES[normalizeFont(src.font_size)] || '';
  document.body.dataset.density = normalizeDensity(src.density);
  applyUiScale(src.ui_scale == null ? 1 : src.ui_scale);
}

/* ---------------- 持久化（localStorage 优先 + settings 兜底，与主题同一套约定） ---------------- */
/** 读三件设置：**没存过就是 null**（让调用方有机会回落到 settings），不要在这里编默认值 ——
    否则"设置里存过、localStorage 没有"的机器上，这里的默认值会把 settings 里的值盖掉。 */
export function loadDisplayPrefs() {
  const out = { font_size: null, density: null, ui_scale: null };
  try {
    const f = localStorage.getItem('fufumidi_font');
    const d = localStorage.getItem('fufumidi_density');
    const u = localStorage.getItem('fufumidi_ui_scale');
    if (f) out.font_size = normalizeFont(f);
    if (d) out.density = normalizeDensity(d);
    if (u) out.ui_scale = clampScale(u);
  } catch (e) { /* 隐私模式等，忽略 */ }
  return out;
}
export function saveFontSize(v) { try { localStorage.setItem('fufumidi_font', normalizeFont(v)); } catch (e) {} }
export function saveDensity(v) { try { localStorage.setItem('fufumidi_density', normalizeDensity(v)); } catch (e) {} }
export function saveUiScale(v) { try { localStorage.setItem('fufumidi_ui_scale', String(clampScale(v))); } catch (e) {} }
