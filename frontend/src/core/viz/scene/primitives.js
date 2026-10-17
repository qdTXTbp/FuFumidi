// ============================================================
// 图元（可视化重做 · 场景层）
//
// 重做的关键一步：**把"画什么"变成纯数据**。
//   · 状态层算出每帧的 Primitive[]（层、几何、颜色、透明度、混合模式、预算键）
//   · 光栅器只负责"怎么画"（Canvas2D / WebGL2 各一份，吃同一份图元）
// 好处：① 测试断言图元列表，不再"按填充类型猜层"；② 琴键透明=层属性，不用逐个补乘全局状态；
//       ③ 每类图元带 budgetKey，可以按类别设上限（对标 MIDViz 的 per-node Max Items）。
// ============================================================

/** 层顺序 —— 渲染顺序由它决定，每一层都可有独立的开关与透明度 */
/* ★ 'fx' 是 2026-10-17 为"光效遮挡关系"加的层：它排在 keyboard **之后**。
   原先击键光柱/粒子光带都在 'impact' 层 —— 那是**琴键之前**，于是光柱的下半截被键面盖住，
   在键顶露出一条横向硬边（用户："光效的遮挡关系有问题、上游有生硬的转折"）。
   光是从键面往上洒的：它属于"压在键盘之上"的一层，所以单独给一层放在 keyboard 之后。 */
export const LAYERS = ['background', 'notes', 'impact', 'keyboard', 'fx', 'particles', 'overlay'];
export const LAYER_INDEX = LAYERS.reduce((m, l, i) => (m[l] = i, m), {});

const P = (k, layer, o) => Object.assign({ k, layer }, o);

/** 矩形（可圆角）。fill 可以是颜色字符串，或 { stops:[...], dir:'v'|'h' } */
export const rect = (layer, x, y, w, h, fill, o = {}) => P('rect', layer, { x, y, w, h, r: 0, fill, ...o });
/** 四边形（梯形键面、透视音符都用它） */
export const quad = (layer, pts, fill, o = {}) => P('quad', layer, { pts, fill, ...o });
/** 音符胶囊（圆角 = 半宽/半高，短音就是药丸形） */
export const capsule = (layer, x, y, w, h, fill, o = {}) => P('capsule', layer, { x, y, w, h, fill, ...o });
/** 径向发光（落点光晕、粒子） */
export const glow = (layer, x, y, r0, r1, color, o = {}) => P('glow', layer, { x, y, r0, r1, color, ...o });
/** 圆环（冲击波） */
export const ring = (layer, x, y, r, lw, color, o = {}) => P('ring', layer, { x, y, r, lw, color, ...o });
/** 光柱（竖光：从键面往上洒） */
export const beam = (layer, x, y, w, h, color, o = {}) => P('beam', layer, { x, y, w, h, color, ...o });
/** 线段（网格、小节线、键分隔线） */
export const line = (layer, x0, y0, x1, y1, color, o = {}) => P('line', layer, { x0, y0, x1, y1, color, ...o });
/** 文字（小节号、键名、歌词） */
export const text = (layer, str, x, y, color, o = {}) => P('text', layer, { str, x, y, color, ...o });
/** 暗角/色调这类整幅后处理图元（由光栅器负责实现） */
export const overlay = (kind, o = {}) => P('overlay', 'overlay', { kind, ...o });

/** 稳定排序：先按层，再按 z（同层内后画的在上面） */
export function sortPrims(list) {
  return list.sort((a, b) => (LAYER_INDEX[a.layer] - LAYER_INDEX[b.layer]) || ((a.z || 0) - (b.z || 0)));
}

/** 按图元类别计数（测试与预算裁剪都用它） */
export function countBy(list, prop = 'k') {
  const m = {};
  for (const p of list) m[p[prop]] = (m[p[prop]] || 0) + 1;
  return m;
}
