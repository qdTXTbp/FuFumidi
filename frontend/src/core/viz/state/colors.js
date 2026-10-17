// ============================================================
// 配色系统（可视化重做 · 状态层 · 2026-10-17 推倒重做）
//
// 旧版为什么被否：「配色不够自由，除了轨道色生效，其它选项都不生效」。两个实锤原因：
//   ① 两行控件互相压制：``noteColor`` 先判 ``colorBy``（按音高/按左右手）就直接 return，
//      于是"配色档"（colorScheme 1/2/3）在选了"按音高"之后**完全失效** —— 面板一半是死的。
//   ② **返回 hsl() 字符串，而 WebGL 光栅器的颜色解析只认 hex/rgb** →
//      在 GPU 路径上"按音高/按左右手"全部回落成白色（Canvas2D 认得 hsl，所以两条后端观感还不一致）。
//      数据层颜色确实变了，画面上全白 —— 这类"数据对了、像素没变"的 bug 只有比像素才抓得住。
//
// 这一版把配色拆成**两条正交轴**，任意组合都生效：
//   取色方式 mode  ：轨道色 | 按音高 | 按左右手 | 按力度   ← 决定"色相从哪来"
//   调色参数       ：色相基准 / 色相跨度 / 色相旋转 / 饱和度偏移 / 亮度偏移，以及手色、力度两端色
// 预设（七彩/暖/冷/单色）只是往这几个参数里填一组值，填完还能继续拖 —— 所以是"自由"的。
// **输出统一是 #rrggbb**：两条光栅器、导出与预览拿到的都是同一个字符串。
// ============================================================

export const COLOR_MODES = [
  /* ★ 2026-10-18f（用户决策二）：默认改成「左右手 + 音区冷暖」渐变 ——
     左手区 C1–B3 深蓝 → 紫，右手区 C4–B6 粉紫 → 明黄/橙。
     多人总谱要按声部区分时，切到「轨道色」（= 多轨总谱模式，保留 8 色高对比）。 */
  { k: 'handPitch', label: '左右手音区' },
  { k: 'track', label: '轨道色' },
  { k: 'pitch', label: '按音高' },
  { k: 'hand', label: '按左右手' },
  { k: 'vel', label: '按力度' },
];

/** 预设 = 一组参数（点完还能继续拖滑块，才叫自由） */
export const COLOR_PRESETS = [
  { k: 'rainbow', label: '七彩', hueBase: 0, hueSpan: 330, satAdj: 0, lightAdj: 0 },
  { k: 'warm', label: '暖', hueBase: 0, hueSpan: 70, satAdj: 8, lightAdj: 2 },
  { k: 'cool', label: '冷', hueBase: 180, hueSpan: 80, satAdj: 2, lightAdj: 0 },
  { k: 'mono', label: '单色', hueBase: 210, hueSpan: 0, satAdj: -28, lightAdj: 10 },
];

export const COLOR_DEFAULTS = {
  colorMode: 'handPitch',
  preset: 'rainbow',
  hueBase: 0,      // 色相基准 0..360
  hueSpan: 330,    // 色相跨度：最低音到最高音之间的色相跨度 0..360
  hueShift: 0,     // 色相旋转 -180..180（**所有模式都生效**，轨道色也能转）
  satAdj: 0,       // 饱和度偏移 -40..40
  lightAdj: 0,     // 亮度偏移 -25..25
  handL: '#4f8dff', handR: '#ff7a3d',
  velLow: '#2f6fd0', velHigh: '#ff5530',
};

/** 面板滑块/取色器的**单一来源**（store 与 UI 都不再各写一遍范围） */
export const COLOR_PARAMS = [
  { k: 'hueBase', label: '色相基准', min: 0, max: 360, step: 5, wrap: true },
  { k: 'hueSpan', label: '色相跨度', min: 0, max: 360, step: 5 },
  { k: 'hueShift', label: '色相旋转', min: -180, max: 180, step: 5 },
  { k: 'satAdj', label: '饱和度', min: -40, max: 40, step: 2 },
  { k: 'lightAdj', label: '亮度', min: -25, max: 25, step: 1 },
];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** 认 #rgb / #rrggbb / rgb() / rgba() / hsl() / hsla() → {h:0..360, s:0..100, l:0..100} */
export function toHsl(c) {
  const s0 = String(c == null ? '' : c).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s0);
  if (m) { const h = m[1]; return rgbToHsl(parseInt(h[0] + h[0], 16), parseInt(h[1] + h[1], 16), parseInt(h[2] + h[2], 16)); }
  m = /^#([0-9a-f]{6})$/i.exec(s0);
  if (m) return rgbToHsl(parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16));
  m = /^rgba?\(([^)]+)\)$/i.exec(s0);
  if (m) { const p = m[1].split(',').map(Number); return rgbToHsl(p[0] || 0, p[1] || 0, p[2] || 0); }
  m = /^hsla?\(([^)]+)\)$/i.exec(s0);
  if (m) {
    const p = m[1].split(',').map((x) => parseFloat(x));
    return { h: ((p[0] || 0) % 360 + 360) % 360, s: p[1] == null ? 60 : p[1], l: p[2] == null ? 55 : p[2] };
  }
  return { h: 210, s: 60, l: 55 };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  const l = (mx + mn) / 2;
  const s = d < 1e-6 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: s * 100, l: l * 100 };
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1; if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

/** HSL → '#rrggbb'（**统一输出 hex**：两条光栅器与导出拿到的是同一个字符串） */
export function hslHex(h, s, l) {
  const hh = (((h % 360) + 360) % 360) / 360;
  const ss = clamp(s, 0, 100) / 100, ll = clamp(l, 0, 100) / 100;
  let r, g, b;
  if (ss < 1e-6) { r = g = b = ll; }
  else {
    const q = ll < 0.5 ? ll * (1 + ss) : ll + ss - ll * ss;
    const p = 2 * ll - q;
    r = hue2rgb(p, q, hh + 1 / 3); g = hue2rgb(p, q, hh); b = hue2rgb(p, q, hh - 1 / 3);
  }
  const hex = (v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0');
  return '#' + hex(r) + hex(g) + hex(b);
}

/** 两个 hex 按 t 混色（按力度取色用）。色相走**短弧** —— 蓝→红要经品红，不能经青绿黄 */
export function mixHex(a, b, t) {
  const A = toHsl(a), B = toHsl(b);
  const k = clamp(t, 0, 1);
  let dh = ((B.h - A.h) % 360 + 540) % 360 - 180;   // 归一化到 (-180, 180]
  return hslHex(A.h + dh * k, A.s + (B.s - A.s) * k, A.l + (B.l - A.l) * k);
}

/**
 * 取一个音符的颜色。**所有模式都会叠加"色相旋转 / 饱和偏移 / 亮度偏移"**，
 * 所以面板上任何一个控件动一下，画面都必须变（这一点由像素级测试守着）。
 * @param cfg  fx 里的配色字段（缺项走 COLOR_DEFAULTS）
 * @param note { pitch, color, vel }
 */
export function noteColorOf(cfg, note) {
  const c = Object.assign({}, COLOR_DEFAULTS, cfg || {});
  // 旧存档只有 colorBy（'track'/'pitch'/'hand'）—— 直接当取色方式用，不丢用户设置
  if (!(cfg && cfg.colorMode) && cfg && cfg.colorBy) c.colorMode = cfg.colorBy;
  const pitch = note && note.pitch != null ? note.pitch : 60;
  const base = { h: 210, s: 70, l: 58 };
  switch (c.colorMode) {
    case 'handPitch': {
      /* 左手 C1(24)–B3(59)：h 228°(深蓝) → 290°(紫)；右手 C4(60)–B6(95)：h 315°(粉紫) → 405°(=45° 明黄)，
         同时低音压暗、高音提亮 —— 「低音像深海、高音像火花」这条直觉要能看见。 */
      if (pitch < 60) {
        const u = clamp((pitch - 24) / 35, 0, 1);
        base.h = 228 + u * 62; base.s = 70 + u * 8; base.l = 50 + u * 10;
      } else {
        const u = clamp((pitch - 60) / 35, 0, 1);
        base.h = 315 + u * 90; base.s = 78 + u * 6; base.l = 56 + u * 12;
      }
      break;
    }
    case 'hand': {
      const src = toHsl(pitch < 60 ? c.handL : c.handR);
      base.h = src.h; base.s = src.s; base.l = src.l;
      break;
    }
    case 'vel': {
      const mixed = mixHex(c.velLow, c.velHigh, clamp((note && note.vel != null ? note.vel : 90) / 127, 0, 1));
      const src = toHsl(mixed);
      base.h = src.h; base.s = src.s; base.l = src.l;
      break;
    }
    case 'pitch': {
      const u = clamp((pitch - 21) / 87, 0, 1);           // 88 键铺满整个色相跨度
      base.h = Number(c.hueBase) + u * Number(c.hueSpan);
      base.s = 70; base.l = 58;
      break;
    }
    default: {                                            // 轨道色：默认与轨道色**逐位一致**
      const src = toHsl((note && note.color) || '#4f9dff');
      base.h = src.h; base.s = src.s; base.l = src.l;
      break;
    }
  }
  return hslHex(
    base.h + Number(c.hueShift || 0),
    base.s + Number(c.satAdj || 0),
    base.l + Number(c.lightAdj || 0),
  );
}
