// ============================================================
// 颜色工具（可视化重做 · 状态层）
//
// 为什么独立一份：旧实现里 `withAlpha` 埋在 500 行的渲染函数中，键面/音符/粒子各算各的，
// 于是"同一套主题下颜色对不齐"。重做后**所有颜色都从这里出**，主题才能真的换掉观感。
// 纯函数，无 DOM 依赖 —— 单测/离线渲染台都能直接用。
// ============================================================

/** '#rgb' | '#rrggbb' | 'rgb(...)' | 'rgba(...)' → 'rgba(r,g,b,a)'；认不出就原样返回 */
export function withAlpha(c, a) {
  const s = String(c == null ? '' : c).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s), r, g, b;
  if (m) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
  else if ((m = /^#([0-9a-f]{6})$/i.exec(s))) {
    r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16);
  } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) {
    const p = m[1].split(',').map(Number); r = p[0]; g = p[1]; b = p[2];
    if (p.length > 3 && a == null) a = p[3];
  } else return s;
  if (r == null || !isFinite(r) || !isFinite(g) || !isFinite(b)) return s;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + (a == null ? 1 : a) + ')';
}

function toRgb(c) {
  const s = String(c || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
  if ((m = /^#([0-9a-f]{6})$/i.exec(s))) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
  if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) { const p = m[1].split(',').map(Number); return [p[0], p[1], p[2]]; }
  return [255, 255, 255];
}

/** 线性混色（t=0 取 a，t=1 取 b） */
export function mix(a, b, t) {
  const A = toRgb(a), B = toRgb(b);
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  return 'rgb(' + Math.round(A[0] + (B[0] - A[0]) * k) + ',' + Math.round(A[1] + (B[1] - A[1]) * k) + ',' + Math.round(A[2] + (B[2] - A[2]) * k) + ')';
}

/** 感知亮度 0..1（用于"背景上该用深字还是浅字"这类判断） */
export function lum(c) {
  const [r, g, b] = toRgb(c);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** 提亮/压暗（k>0 变亮，k<0 变暗），返回 rgb() */
export function shade(c, k) {
  return k >= 0 ? mix(c, '#ffffff', k) : mix(c, '#000000', -k);
}

export function hsl(h, s, l) { return 'hsl(' + (((h % 360) + 360) % 360) + ',' + s + '%,' + l + '%)'; }

/** 音符材质用的三点渐变（顶/中/底）—— 参考实现里音符不是纯色块，而是有内芯与边缘 */
export function noteStops(color, opts = {}) {
  // ★ 提亮要克制：内芯提太多 + 泛光叠加会把音符推成白块（重做后第一版实测霓虹档整条糊白）。
  //   参考实现里"亮"来自轮廓与光晕，不是把填充色刷白。
  const k = opts.velN == null ? 0.7 : opts.velN;
  // 「音符质感」关掉时给一块平的色块（没有白热内芯，只在底部收一道暗边）
  if (opts.gloss === false) return [color, color, color, shade(color, -0.22)];
  return [shade(color, 0.10 + 0.10 * k), shade(color, 0.04 + 0.07 * k), color, shade(color, -0.28)];
}
