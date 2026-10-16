// 共享可视化渲染：从 ViewViz.vue 抽离，供 ViewConvert 视频导出复用
import { TRACK_COLORS } from './util.js';
import { t } from './i18n.js';

function cssVar(name, fb) {
  try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch (e) { return fb; }
}
function ensurePm() {
  if (ensurePm._pm) return ensurePm._pm;
  const pm = {}; let wk = 0;
  for (let m = 21; m <= 108; m++) { const pb = [1, 3, 6, 8, 10].includes(m % 12); pm[m] = { isBlack: pb, wkCount: wk }; if (!pb) wk++; }
  ensurePm._pm = pm;
  return pm;
}
// 一个八度内的黑键半音偏移（以 C 为 0）
const BLACK_PC = [1, 3, 6, 8, 10];

// 52 个白键的 midi（升序）。原来每帧都要用 while 循环把音高换算成白键序号，
// 这里预计算成数组，音频几何与琴键绘制直接查表。
const WHITE_MIDI = (() => {
  const out = [];
  for (let m = 21; m <= 108; m++) if (!BLACK_PC.includes(m % 12)) out.push(m);
  return out;
})();
const WHITE_TOTAL = WHITE_MIDI.length; // 52

/* ---- 参考逻辑尺寸（导出与实时同尺度的唯一基准）----
 * 瀑布流的几何里有一批**绝对像素**常量（琴键条高度上限 120、一小节恒 120px、圆角 4、
 * 发光半径 20、字号 10…）。它们只在「画布逻辑尺寸 ≈ 实时画布」时才正确。
 * 实测实时画布（瀑布流、1920×1080 窗口）是 934×534 CSS；导出若直接拿物理像素当逻辑单位
 * （4K 就是 3840×2160），这些常量相对画布就小了 4 倍 —— 琴键条变成一条 5% 高的细缝、
 * 一屏塞进 36 秒音乐、音符成了一条条细丝，与实时画面「差了十万八千里」（用户原话）。
 * 所以导出固定按 VIZ_REF_H 的逻辑高度绘制，再用 ctx.scale 映射到物理缓冲。
 * 仪表盘模板的实时卡片是 934×300，瀑布流是 934×534 —— 取 540 与瀑布流对齐。 */
export const VIZ_REF_H = 540;
export const VIZ_REF_W = 960;   // = VIZ_REF_H × 16/9，仅作说明用
// 实时画布的 devicePixelRatio 基准（本机实测 2.5）。背景模糊半径是**设备像素**
// （canvas 的 filter 不受 CTM 影响，实测），所以实时看到的是「13 物理 px / 2335 画面宽」，
// 导出若照抄 13 就变成「13 / 3840」——分辨率越高背景越清晰，两边不是一幅画。
// 导出按 (物理像素 / 实时 devicePixelRatio) 等比放大模糊半径，任何分辨率下相对模糊都一致。
export const VIZ_REF_DPR = 2.5;

// 3D 键盘（2026-10）：wk/bk 是**键面**（俯视看到的那一面），wkFront/bkFront 是**前脸**
// （键的厚度），wkEdge 是键面顶边的那道高光。三部分叠起来才有"一块琴键"的体积感 ——
// 只有键面时，琴键看起来是一张贴在画面上的纸（旧观感）。
const LIGHT_KEYS = {
  wkTop: '#f2f3f5', wkBot: '#e2e4e8', wkLine: 'rgba(10,10,10,0.12)',
  wkFrontTop: '#d8dbdf', wkFrontBot: '#bfc3c9', wkEdge: 'rgba(255,255,255,0.9)',
  bkTop: '#3a3d42', bkBot: '#1c1e22', bkFrontTop: '#22252a', bkFrontBot: '#101216',
};
const DARK_KEYS = {
  wkTop: '#2b303a', wkBot: '#20242c', wkLine: 'rgba(255,255,255,0.10)',
  wkFrontTop: '#1b1f26', wkFrontBot: '#101318', wkEdge: 'rgba(255,255,255,0.16)',
  bkTop: '#0c0e12', bkBot: '#04050a', bkFrontTop: '#07090c', bkFrontBot: '#020305',
};

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

// 判断 CSS 颜色是否偏暗（相对亮度 < 0.5）。琴键配色据此在浅/深两套间切换。
// 认不出来的写法按浅色处理 —— 与历史观感一致，不会把浅色主题误判成深色。
function isDarkColor(s) {
  const str = String(s || '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(str);
  if (hex) {
    let hx = hex[1];
    if (hx.length === 3) hx = hx[0] + hx[0] + hx[1] + hx[1] + hx[2] + hx[2];
    const r = parseInt(hx.slice(0, 2), 16), g = parseInt(hx.slice(2, 4), 16), b = parseInt(hx.slice(4, 6), 16);
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
  }
  const rgb = /^rgba?\(([^)]+)\)$/i.exec(str);
  if (rgb) {
    const p = rgb[1].split(',').map(x => parseFloat(x));
    if (p.length >= 3 && p.every(x => isFinite(x))) return (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) < 128;
  }
  return false;
}

// 琴键配色跟随主题：深色基底（studio / hc / 深色模式）下不再是一块亮白板。
// 结果按解析出的 --canvas 缓存，主题切换后自动失效重算。
function keyPalette(state) {
  const canvas = cssVar('--canvas', '#ffffff');
  if (state._keyFor !== canvas) {
    state._keyFor = canvas;
    state._key = isDarkColor(canvas) ? DARK_KEYS : LIGHT_KEYS;
  }
  return state._key;
}

// 音符块配色：colorScheme=0 用轨道色，1/2/3 用按音高推导的 HSL（与原实现同公式）
function blockColor(b, cs, by) {
  // 按左右手（D5）：左手冷色、右手暖色 —— SeeMusic / Synthesia 那一套的学习向配色。
  // 没有分手信息时用**音高**作启发（< C4 视为左手）。已知局限：跨越中音区的分解和弦会被拆成两色，
  // 所以面板里它是**可选项**，默认仍是轨道色。
  if (by === 'hand') return (b.pitch < 60) ? 'hsl(205,78%,62%)' : 'hsl(24,88%,60%)';
  if (by === 'pitch') {
    return 'hsl(' + ((b.pitch * 13) % 360) + ',72%,60%)';
  }
  if (!cs) return b.color;
  return 'hsl(' + (((b.pitch * (cs === 1 ? 7 : cs === 2 ? 13 : 17)) + (cs === 2 ? 30 : 0)) % 360) + ',' +
    (cs === 3 ? 75 : cs === 2 ? 80 : 70) + '%,' + (cs === 3 ? 65 : 60) + '%)';
}

// 音高 → 所在（黑键取紧邻下方）白键索引，供音域居中与几何计算
function whiteIndexOf(pitch) {
  const pi = ensurePm()[pitch];
  if (!pi) return 0;
  const i = pi.isBlack ? pi.wkCount - 1 : pi.wkCount;
  return Math.max(0, Math.min(WHITE_TOTAL - 1, i));
}

// 音符块横向几何：白键占 0.9 格，黑键占 0.6 格并骑在两个白键之间。
// cw 不取整（纵深收窄要按比例算），sx 已取整。
function pitchGeom(pitch, pm, g, wk0) {
  const pi = pm[pitch];
  if (!pi) return { sx: 0, cw: 0.9 * g };
  if (pi.isBlack) {
    const cw = 0.6 * g;
    return { sx: Math.floor((pi.wkCount - wk0) * g - cw / 2), cw };
  }
  const cw = 0.9 * g;
  return { sx: Math.floor((pi.wkCount - wk0) * g + 0.05 * g), cw };
}

/**
 * 把全曲音符压成「按音高分组的合并块」，全曲只算一次，供每帧复用。
 *
 * - 同音高上首尾相接 / 重叠的音符并成一条长条（Synthesia 式观感）
 * - 每个音高内的块按 start 升序且互不重叠，因此 end 也单调不减
 *   → 每帧可二分跳到「第一个还没结束的块」，整段已划过的历史不再参与绘制与合并
 * - vel 取合并组内的最大值，供发光强度使用
 * - centerPitch：按音符数加权的平均音高，缩放时用它选可视音域中心
 */
export function buildVizBlocks(song) {
  const byPitch = new Map();
  if (!song || !song.tracks) return { byPitch, centerPitch: 60, total: 0 };
  const items = [];
  let pitchSum = 0, count = 0;
  song.tracks.forEach((tr, ti) => {
    const color = TRACK_COLORS[(tr.index != null ? tr.index : ti) % TRACK_COLORS.length];
    (tr.notes || []).forEach(n => {
      items.push({ trackIndex: ti, pitch: n.midi, start: song.baseSec(n.start), end: song.baseSec(n.end), color, vel: n.vel });
      pitchSum += n.midi; count++;
    });
  });
  items.sort((a, b) => a.start - b.start || a.pitch - b.pitch);
  for (const it of items) {
    let arr = byPitch.get(it.pitch);
    if (!arr) { arr = []; byPitch.set(it.pitch, arr); }
    let merged = false;
    for (let k = arr.length - 1; k >= 0; k--) {
      const b = arr[k];
      if (it.start <= b.end + 0.01 && it.end >= b.start - 0.01) {
        if (it.start < b.start) b.start = it.start;
        if (it.end > b.end) b.end = it.end;
        if (it.vel > b.vel) b.vel = it.vel;
        merged = true;
        break;
      }
    }
    if (!merged) arr.push(it);
  }
  // 显式再排一次：下面的二分依赖「start 与 end 同时单调」这一不变量
  for (const arr of byPitch.values()) arr.sort((a, b) => a.start - b.start);
  return { byPitch, centerPitch: count ? Math.round(pitchSum / count) : 60, total: count };
}

// 每帧两次二分（每个音高各一次）：
//   firstEndGE   —— 第一个「还没结束」的块，跳过整段已划过的历史
//   firstStartGT  —— 第一个起点晚于上次绘制的块，用来识别这一帧刚跨过击键线的音符
function firstEndGE(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].end < t) lo = m + 1; else hi = m; }
  return lo;
}
function firstStartGT(arr, t) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].start <= t) lo = m + 1; else hi = m; }
  return lo;
}

/**
 * 某个音高在当前时刻「一屏之内」需要绘制的块区间 [from, to)。
 *
 * 依赖 buildVizBlocks 保证的不变量：arr 按 start 升序且互不重叠，因此 end 也单调。
 * 于是可以二分跳到第一个「还没结束」的块（整段已划过的历史直接跳过），
 * 再向上走到越过屏顶为止 —— 屏外的块完全不进绘制循环。
 */
export function visibleRange(arr, d, winSec) {
  const from = firstEndGE(arr, d);
  let to = from;
  while (to < arr.length && arr[to].start <= d + winSec) to++;
  return { from, to };
}

// 粒子散射用的确定性伪随机：导出画面必须可复现，不能用 Math.random()
function noise(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

// 帧间状态归一化：实时视图与视频导出各持一份，导出侧的对象字面量不一定带全部字段
function vizState(state) {
  const s = state || (drawVizWaterfall._state = drawVizWaterfall._state || {});
  if (!s.parts) s.parts = [];
  if (!s.byPitch) s.byPitch = new Map();
  if (typeof s.centerPitch !== 'number') s.centerPitch = 60;
  if (typeof s.lastD !== 'number') s.lastD = -1;
  if (typeof s.seed !== 'number') s.seed = 0;
  if (typeof s.hitPulse !== 'number') s.hitPulse = 0;   // 击键线光带的衰减脉冲
  return s;
}

// 老 Chromium 没有 roundRect：补一个等价实现（只在首次调用时打一次补丁）
function patchRoundRect() {
  if (typeof CanvasRenderingContext2D === 'undefined' || CanvasRenderingContext2D.prototype.roundRect) return;
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, w, h, r) {
    if (typeof r === 'number') r = [r, r, r, r];
    const q = [0, 0, 0, 0];
    (r || []).slice(0, 4).forEach((v, i) => { q[i] = Math.max(0, Math.min(v || 0, Math.min(w, h))); });
    this.moveTo(x + q[0], y);
    this.lineTo(x + w - q[1], y); this.arcTo(x + w, y, x + w, y + q[1], q[1]);
    this.lineTo(x + w, y + h - q[2]); this.arcTo(x + w, y + h, x + w - q[2], y + h, q[2]);
    this.lineTo(x + q[3], y + h); this.arcTo(x, y + h, x, y + h - q[3], q[3]);
    this.lineTo(x, y + q[0]); this.arcTo(x, y, x + q[0], y, q[0]);
    this.closePath(); return this;
  };
}

const MAX_PARTS = 420; // 粒子总量上限：每帧要逐个更新+绘制，不设上限会拖垮大曲目
                       // （旧值 260；升级后单次击键的粒子更多，提到 420，仍是"每帧一遍"）

/* ============================================================
 * 视效档（2026-10 瀑布流升级）：3D 键盘 / 粒子光效 / 击键光带 / 音符质感
 * ------------------------------------------------------------
 * · 全部**默认开启**，可用 opts.fx 覆盖。实时（ViewViz）与导出（ViewConvert）
 *   读同一份设置（stores/vizbg），预览与成片才一致。
 * · **关掉任一项都必须回到旧观感**，不能留残余 —— 用户是按开关判断的。
 * · 确定性：随机量一律走 noise(seed)（与旧版同一套），不用 Math.random，
 *   否则同一次导出重跑两遍会得到不同画面。
 * ============================================================ */
export const FX_DEFAULTS = {
  // —— 开关（面板里是勾选项）——
  keys3d: true, particles: true, beams: true, hitLine: true, gloss: true, keyNames: false,
  // —— 参数（面板里是滑块）——
  // D2 决定**不做固定档位**，改成用户可调：这些值就是那套"档位"的自由形式。
  persp: 0.45,       // 键盘透视强度 0..1（0 = 平板键；D6「尝试做」的那一项）
  bloom: 0.55,       // 后处理泛光强度 0..1.2
  bloomThr: 0.5,     // 泛光阈值 0..1（越大只有最亮的地方发光）
  flash: 0.7,        // 击键闪光 0..1.5（借 MIDIVisualizer 的 --flashes-size）
  partScale: 1,      // 粒子数量倍率 0.3..1.6
  glow: 1,           // 光柱/发光强度倍率 0.4..1.6
  colorBy: 'track',  // 'track' 轨道色 | 'pitch' 按音高 | 'hand' 按左右手（D5）
};
export function fxOf(opts) { return Object.assign({}, FX_DEFAULTS, opts && opts.fx); }

/* 参数元数据 —— **单一来源**：面板据此渲染滑块，不用在 store 与 UI 里各写一遍范围 */
export const FX_PARAMS = [
  { k: 'persp', label: '键盘透视', min: 0, max: 1, step: 0.05 },
  { k: 'bloom', label: '泛光', min: 0, max: 1.2, step: 0.05 },
  { k: 'bloomThr', label: '泛光阈值', min: 0, max: 1, step: 0.05 },
  { k: 'flash', label: '击键闪光', min: 0, max: 1.5, step: 0.05 },
  { k: 'partScale', label: '粒子数量', min: 0.3, max: 1.6, step: 0.1 },
  { k: 'glow', label: '光柱强度', min: 0.4, max: 1.6, step: 0.05 },
];
export const FX_COLORBY = [
  { k: 'track', label: '按轨道色' },
  { k: 'pitch', label: '按音高' },
  { k: 'hand', label: '按左右手' },
];

/* 内置主题：名字与数值都在这里，用户保存的自定义主题由 store 合并进来（D8：命名交给用户） */
export const FX_THEMES = {
  默认: {},
  // ★ 泛光值不能一味调大：离线渲染台实测 bloom 1.1 + thr 0.35 时亮音符会**糊成白块**
  //   （自乘 + 加法叠加 ≈ 0.9 的白）。1.0 以上在这个管线里没有意义，只会丢细节。
  霓虹: { bloom: 0.7, bloomThr: 0.5, glow: 1.3, persp: 0.55, flash: 1.0, colorBy: 'pitch', partScale: 1.3 },
  极光: { bloom: 0.8, bloomThr: 0.45, glow: 1.2, persp: 0.75, flash: 0.8, colorBy: 'hand', partScale: 1.1 },
  复古: { bloom: 0.3, bloomThr: 0.72, glow: 0.8, persp: 0.22, flash: 0.5, colorBy: 'track', partScale: 0.8 },
  极简: { bloom: 0, particles: false, beams: false, hitLine: false, persp: 0, flash: 0, gloss: false, partScale: 0.5 },
};

/** '#rgb' / '#rrggbb' / 'rgb(...)' → 'rgba(r,g,b,a)'；认不出来就原样返回 */
function withAlpha(c, a) {
  const s = String(c == null ? '' : c).trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s), r, g, b;
  if (m) { r = parseInt(m[1][0] + m[1][0], 16); g = parseInt(m[1][1] + m[1][1], 16); b = parseInt(m[1][2] + m[1][2], 16); }
  else if ((m = /^#([0-9a-f]{6})$/i.exec(s))) { r = parseInt(m[1].slice(0, 2), 16); g = parseInt(m[1].slice(2, 4), 16); b = parseInt(m[1].slice(4, 6), 16); }
  else if ((m = /^rgba?\(([^)]+)\)$/i.exec(s))) { const p = m[1].split(',').map(Number); r = p[0]; g = p[1]; b = p[2]; }
  if (r == null || !isFinite(r) || !isFinite(g) || !isFinite(b)) return s;
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/* 粒子发光贴图：按颜色缓存一张 64×64 的径向渐变。
 * 为什么不每帧 createRadialGradient —— 那是这段最贵的一步（每个粒子一次），
 * 缓存之后每帧只剩一次 drawImage（实测 4K 导出帧预算只有 41ms）。
 * node 单测环境没有 document → 返回 null，调用方回退成纯 arc 圆点。 */
const SPRITE_CACHE = new Map();
function glowSprite(color) {
  if (SPRITE_CACHE.has(color)) return SPRITE_CACHE.get(color);
  let cv = null;
  if (typeof document !== 'undefined' && document.createElement) {
    const S = 64;
    cv = document.createElement('canvas');
    cv.width = S; cv.height = S;
    const c2 = cv.getContext('2d');
    const gr = c2.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    gr.addColorStop(0, withAlpha(color, 1));
    gr.addColorStop(0.22, withAlpha(color, 0.82));
    gr.addColorStop(0.55, withAlpha(color, 0.26));
    gr.addColorStop(1, withAlpha(color, 0));
    c2.fillStyle = gr;
    c2.fillRect(0, 0, S, S);
  }
  SPRITE_CACHE.set(color, cv);
  return cv;
}

// 纵向坐标吸附到「设备像素」，只用于文字这类必须清晰、又不随播放移动的内容。
//
// 关于移动内容为什么**不**吸附：滚动速度是 0.933 CSS 像素/帧，而 dpr=2.5 时设备像素粒度
// 是 0.4 CSS 像素 —— 一帧要走 2.33 个设备像素，吸附后只能走 2 或 3 个，于是每帧的位移在
// 2/3 之间跳，观感就是轻微闪烁。实测（同一场景、同一时刻、各 40 帧）逐帧变化量的波动系数：
//   吸附到 CSS 像素 24.6% ／ 吸附到设备像素 21.6% ／ 完全不吸附 15.8%
// 所以移动中的音符块与小节线一律按精确坐标绘制（由画布自身做亚像素抗锯齿），
// 只有小节线编号这种静态文字才吸附，避免字发虚。
function pixelScale(ctx) {
  try {
    const m = ctx.getTransform ? ctx.getTransform() : null;
    return (m && m.a > 0) ? m.a : 1;
  } catch (e) { return 1; }
}

/**
 * 画音符瀑布的背景（`主题 / 纯色 / 图片 / 透明`）—— **可视化页与视频导出共用这一个实现**。
 *
 * ★ 抽出来是为了让导出与实时预览**逐像素同源**：导出页以前自己 fillRect 一个 bgColor，
 *   跟可视化页选的图片/透明档/模糊暗化完全无关（用户看到的和导出的是两幅画）。
 * ★ `mode === 'keep'` 表示**不动背景**（调用方已经自己铺过一整帧了）—— 导出的仪表盘模板
 *   要先把背景铺满整帧、再在上下两块区域分别画瀑布，不能让瀑布再清一次自己那块。
 * ★ 千万不要 setTransform(1,0,0,1,0,0)：调用方已经把 dpr 缩放设在 ctx 上，
 *   而传进来的 w/h 是 **CSS 像素**。重置成 identity 只会铺满左上角 1/dpr 的区域。
 */
function paintVizBgDirect(ctx, w, h, bgOpt = {}) {
  const mode = bgOpt.mode || 'theme';
  const blur = Math.max(0, Number(bgOpt.blur) || 0);
  const dim = Math.max(0, Math.min(0.9, Number(bgOpt.dim) || 0));
  ctx.save();
  if (mode === 'solid') {
    ctx.fillStyle = bgOpt.color || cssVar('--canvas', '#0b1020');
    ctx.fillRect(0, 0, w, h);
  } else if (mode === 'image' && bgOpt.image && bgOpt.image.width) {
    const im = bgOpt.image;
    // cover：填满、不拉伸变形。模糊会把边缘「吃」掉（blur 会采到画布外的透明像素），
    // 所以按模糊半径外扩一点再画 —— 实测不扩的话四边会透出底色。
    const pad = blur > 0 ? blur * 3 : 0;
    const scale = Math.max((w + pad * 2) / im.width, (h + pad * 2) / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    ctx.filter = blur > 0 ? 'blur(' + blur + 'px)' : 'none';
    ctx.drawImage(im, (w - dw) / 2, (h - dh) / 2, dw, dh);
    ctx.filter = 'none';
    if (dim > 0) { ctx.fillStyle = 'rgba(0,0,0,' + dim + ')'; ctx.fillRect(0, 0, w, h); }
  } else {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, cssVar('--canvas', '#ffffff'));
    g.addColorStop(1, cssVar('--surface', '#f7f8fa'));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    if (dim > 0) { ctx.fillStyle = 'rgba(0,0,0,' + dim + ')'; ctx.fillRect(0, 0, w, h); }
  }
  ctx.restore();
}

/* ---- 背景位图缓存（性能，逐像素等价）----
 * 为什么必须有：模糊一张底图是整帧里最贵的一步。4K（3840×2160）下一次 blur + cover 缩放实测
 * 要 80~150ms，而导出是**实时录制**（单帧预算 = 1/fps，24fps 只有 41ms）—— 每帧都超预算，
 * 于是持续满负载、丢帧，用户的机器甚至崩溃重启过一次。
 * 背景参数在一次会话里恒定（模式 / 颜色 / 模糊 / 暗化 / 图片 / 画布设备尺寸），所以缓存一张
 * **设备分辨率**的离屏位图，之后每帧只做一次 drawImage。
 * 为什么逐像素等价：缓存是在 ctx.scale(sc, sc) 下画的，模糊与 cover 裁切语义与直画完全一致
 * —— canvas 的 filter blur 作用在**设备空间**、不受 CTM 影响（实测模糊斜坡宽度不随 scale 变）。
 * 实时视图同样受益（dpr=2.5 时每帧少一次 2335×1335 的模糊）。 */
const BG_CACHE = { key: '', cv: null };
function bgCacheKey(mode, o, pw, ph) {
  const im = o.image;
  return [mode, o.color || '', Number(o.blur) || 0, Number(o.dim) || 0,
    im ? (im.currentSrc || im.src || 'img') + ':' + im.width + 'x' + im.height : '', pw, ph].join('|');
}

export function paintVizBg(ctx, w, h, bgOpt = {}) {
  const mode = bgOpt.mode || 'theme';
  if (mode === 'keep') return;
  if (mode === 'transparent') {
    // 真的清成透明：导出 PNG / 视频后才能当叠加层用（本来就只是一次 clearRect，不必缓存）
    ctx.save(); ctx.clearRect(0, 0, w, h); ctx.restore();
    return;
  }
  if (typeof document === 'undefined') { paintVizBgDirect(ctx, w, h, bgOpt); return; }
  const sc = pixelScale(ctx) || 1;
  const pw = Math.max(1, Math.round(w * sc)), ph = Math.max(1, Math.round(h * sc));
  const key = bgCacheKey(mode, bgOpt, pw, ph);
  if (BG_CACHE.key !== key || !BG_CACHE.cv) {
    const cv = document.createElement('canvas');
    cv.width = pw; cv.height = ph;
    const c2 = cv.getContext('2d');
    c2.save(); c2.scale(sc, sc);
    paintVizBgDirect(c2, w, h, bgOpt);
    c2.restore();
    BG_CACHE.key = key; BG_CACHE.cv = cv;
  }
  ctx.save();
  ctx.drawImage(BG_CACHE.cv, 0, 0, w, h);
  ctx.restore();
}

// 抽离自 ViewViz.drawRoll：绘制竖向音符瀑布到 ctx（w x h）
export function drawVizWaterfall(ctx, w, h, song, tick, opts = {}) {
  patchRoundRect();
  const pm = ensurePm();
  const state = vizState(opts.state);
  const fx = fxOf(opts);   // 视效开关（默认全开；UI 可逐项关掉，关掉必须回到旧观感）
  if (song && state.songRef !== song) {
    const built = buildVizBlocks(song);
    state.byPitch = built.byPitch;
    state.centerPitch = built.centerPitch;
    state.songRef = song;
    state.parts.length = 0;
    state.lastD = -1;
  }
  const x = Math.min(120, Math.round(0.2 * h));
  const wN = Math.floor(h - x); // 卷帘区高度；击键线在 y = wN
  // 纵向吸附到设备像素：所有会随播放移动的纵向坐标都过它，保证整场滚动步进一致、边缘不忽清忽虚
  const sc = pixelScale(ctx);
  const snapY = (yv) => Math.round(yv * sc) / sc;
  // ---- 背景：主题渐变 / 纯色 / 真透明（OBS 叠加层）/ 自定义图片（可模糊 + 暗化）----
  // opts.bg = { mode:'theme'|'solid'|'transparent'|'image'|'keep', color, image, blur, dim }
  // ★ 实现在 paintVizBg（导出侧调同一个函数，两边逐像素同源）
  paintVizBg(ctx, w, h, opts.bg || {});

  let d = 0, curTempo = (song && song.initialBpm) || 120, curSig = { num: 4 };
  if (song) {
    d = song.baseSec ? song.baseSec(tick) : 0;
    const tm = song.tempoMap || [], sm = song.sigMap || [];
    let ti = tm.length - 1; while (ti > 0 && tm[ti].sec > d) ti--;
    if (tm.length) curTempo = 60e6 / tm[ti].us;
    let si = sm.length - 1; while (si > 0 && sm[si].tick > tick) si--;
    if (sm.length) curSig = sm[si];
  }
  const barSec = curSig.num * 60 / curTempo;
  const v = 120 / barSec, j = d * v;      // px/秒：一小节恒为 120px
  const visSec = wN > 0 ? wN / v : 0;     // 一屏覆盖的时间跨度（秒）

  // ---- 可视音域：zoom 缩放的是音域宽度，不是琴键宽度 ----
  // zoom = 1 时 span = 52 且 wk0 = 0，几何退化成「88 键铺满画布」，与旧版逐像素一致。
  const zoom = opts.zoom || 1;
  const span = Math.max(12, Math.min(WHITE_TOTAL, Math.round(WHITE_TOTAL / zoom)));
  const centerWk = whiteIndexOf(state.centerPitch);
  const wk0 = Math.max(0, Math.min(WHITE_TOTAL - span, Math.round(centerWk - span / 2)));
  const wk1 = wk0 + span;                 // 白键索引区间 [wk0, wk1)
  const g = w / span;                     // 白键宽度
  // 该音域之外音高的块横向已在画布外，连遍历都省掉（zoom=1 时覆盖 21..108 全部音高，
  // 与旧版行为一致）
  const loMidi = WHITE_MIDI[wk0];
  const hiMidi = WHITE_MIDI[wk1 - 1] + 1;

  // ---- 透视（D6「尝试做」）----
  // 消失点放在键线上方正中：键面变成梯形（后边窄、前边宽），音符块随纵深向消失点收拢，
  // 整条卷帘读起来像一条走廊。ps = 0 时下面所有分支都不会执行 → **逐像素等于旧观感**。
  const ps = clamp01(fx.persp == null ? 0 : Number(fx.persp));
  const vpX = w / 2;
  const kB = 1 - 0.42 * ps;                  // 键面后边相对前边的收窄比

  // ---- 音乐能量驱动的背景光晕（能量由调用方传入，实时与导出同算法）----
  const energy = clamp01(opts.energy || 0);
  // ★ 光晕是「加在背景上」的：透明档（OBS 叠加层）不能有它，否则导出层自带一块亮斑。
  //   档位从 opts.bg 现取 —— 抽走 paintVizBg 之后这里的 bgMode 已不在作用域里
  //   （踩过：引用残留变量 → 导出抛 'bgMode is not defined'，预览又被 try/catch 吞掉）。
  const bgModeNow = (opts.bg || {}).mode || 'theme';
  if (energy > 0.01 && wN > 0 && bgModeNow !== 'transparent') {
    const glow = ctx.createLinearGradient(0, wN, 0, 0);
    glow.addColorStop(0, cssVar('--accent', '#4f94e0'));
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.05 + 0.16 * energy;
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, wN);
    ctx.globalAlpha = 1;
  }

  // ---- 击键线光带（升级）：整条击键线随最近击键亮起、约 0.8s 衰减 ----
  // 先画（在音符与琴键之下），琴键和前脸压在它上面，边界才干净。
  // 脉冲在这里统一衰减，与开关无关 —— 关掉光带后重新打开不能"欠账"。
  state.hitPulse = Math.max(0, (state.hitPulse || 0) - 0.06);
  if (fx.hitLine && wN > 0 && bgModeNow !== 'transparent') {
    const hp = state.hitPulse;
    const accent = cssVar('--accent', '#4f94e0');
    const band = ctx.createLinearGradient(0, wN - 46, 0, wN + 2);
    band.addColorStop(0, 'rgba(0,0,0,0)');
    band.addColorStop(1, withAlpha(accent, 0.04 + 0.2 * Math.max(hp, energy * 0.6)));
    ctx.fillStyle = band;
    ctx.fillRect(0, wN - 46, w, 48);
    ctx.strokeStyle = withAlpha(accent, 0.10 + 0.5 * hp + 0.2 * energy);
    ctx.lineWidth = 1 + hp * 1.6;
    ctx.beginPath(); ctx.moveTo(0, wN); ctx.lineTo(w, wN); ctx.stroke();
    ctx.lineWidth = 1;
  }

  const grid = cssVar('--hairline', 'rgba(10,10,10,0.10)');
  const gridStrong = cssVar('--border-strong', 'rgba(10,10,10,0.18)');
  const text = cssVar('--ink', '#0a0a0a');
  ctx.strokeStyle = grid; ctx.lineWidth = 1;
  for (let i = wk0; i <= wk1; i++) {
    if ((i - 2) % 7 !== 0) continue;      // 只描 C 键左沿
    const tx = Math.floor((i - wk0) * g);
    ctx.beginPath(); ctx.moveTo(tx, 0); ctx.lineTo(tx, wN); ctx.stroke();
  }
  const M = Math.floor(j / 120), S = Math.floor((j + wN) / 120) + 1;
  ctx.font = '10px system-ui, sans-serif'; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  // 滚动小节线：音符竖直下落，小节线应为水平线随音符一同向下滚动（1 像素 = 1 tick）
  for (let e = M; e <= S; e++) {
    const ty = wN - (120 * e - j);
    if (ty < -20 || ty > wN + 20) continue;
    ctx.strokeStyle = gridStrong; ctx.beginPath(); ctx.moveTo(30, ty); ctx.lineTo(w, ty); ctx.stroke();
    // 线随音符一起按精确坐标移动（见 pixelScale 处的说明）；编号是静态文字，吸附住避免发虚
    if (e > 0) { ctx.fillStyle = gridStrong; ctx.fillText(String(e), 24, snapY(ty)); }
  }
  const liveNotes = opts.activeNotes || [];
  const live = new Set(liveNotes.map(m => m.midi));
  const cs = opts.colorScheme || 0;

  // ---- 可见音符块 ----
  // 每个音高只做一次二分：跳过整段已划过的历史（i0 之前的块都已结束），
  // 再向上遍历到屏外为止。窗口外的块不进绘制循环 —— 这是大 MIDI 不掉帧的关键。
  const sounding = new Map();   // 正压在击键线上的音高 → 配色（供琴键高亮）
  const hits = [];              // 本帧刚跨过击键线的块（用于生成粒子）
  const forward = state.lastD >= 0 && d >= state.lastD;
  for (const [pitch, arr] of state.byPitch) {
    if (pitch < loMidi || pitch > hiMidi) continue;  // 横向在画布外
    const { from, to } = visibleRange(arr, d, visSec);
    if (from >= arr.length) continue;               // 该音高已全部走完
    const head = arr[from];
    if (head.start <= d) sounding.set(pitch, blockColor(head, cs, fx.colorBy));
    for (let k = from; k < to; k++) {
      const b = arr[k];
      const { sx: sxBase, cw: cwBase } = pitchGeom(pitch, pm, g, wk0);
      const bottom = wN - (b.start - d) * v;        // 起点：最先落到击键线的边
      const top = wN - (b.end - d) * v;
      // 纵深：0 = 正压在击键线上，1 = 屏顶。越远越淡、越窄、越不发亮
      const depth = clamp01((wN - bottom) / wN);
      const inset = Math.round(cwBase * 0.12 * depth / 2);
      let cw = Math.max(2, Math.floor(cwBase) - inset * 2);
      let sx = sxBase + inset;
      if (ps > 0) {
        // 越往上（depth 越大）越向消失点收拢：|偏移| 与宽度同时按 dk 缩放
        const dk = 1 - 0.42 * ps * depth;
        const cxx = vpX + (sx + cw / 2 - vpX) * dk;
        cw = Math.max(2, cw * dk);
        sx = cxx - cw / 2;
      }
      const velN = clamp01((b.vel == null ? 90 : b.vel) / 127);
      // 发光强度：只看「起音边到击键线的距离」，越近越亮，越过击键线后沿同一条曲线衰减。
      // 全程连续 —— 此前是「正在发声(9+13*vel) / 即将击键(0→9)」两段拼接，音头处会有一次
      // 最高 13px 的光晕阶跃，密集音符下观感就是一片片地在闪。
      const near = Math.max(0, 1 - Math.abs(wN - bottom) / (wN * 0.16));
      const blur = 20 * near * (0.55 + 0.45 * velN);
      ctx.fillStyle = blockColor(b, cs, fx.colorBy);
      ctx.globalAlpha = 1 - 0.5 * depth;
      if (blur > 0) { ctx.shadowBlur = blur; ctx.shadowColor = ctx.fillStyle; }
      // 按精确坐标绘制（不吸附）——理由见 pixelScale 处的说明
      // 圆角取「半宽 / 半高」上限：短音符就成了胶囊（参考 SeeMusic 那种药丸形），
      // 长音则是圆角长条。测试只数 roundRect 次数、不看半径，所以这里可以按块变。
      const bh2 = Math.max(bottom - top, 5);
      const rr2 = Math.max(2, Math.min(6, cw / 2, bh2 / 2));
      ctx.beginPath();
      ctx.roundRect(sx, top, cw, bh2, rr2);
      ctx.fill();
      if (blur > 0) ctx.shadowBlur = 0;
      ctx.globalAlpha = 1;
      // ---- 音符质感（升级）：落点光晕 + 下落边高光 ----
      // ★ 这两笔**绝不能用 roundRect**：单测用「击键线之前出现的 roundRect 个数」数屏内块数
      //   （frontend/tests/viz.test.js），多一个 roundRect 就会打破那条不变量。
      //   同理块的主填充必须仍是**调色板纯色**，渐变只能叠在它上面。
      const bc = ctx.fillStyle;
      if (fx.gloss && near > 0.02) {
        const hy = Math.min(bottom, wN);
        const rad = Math.max(7, cw * 0.9);
        const halo = ctx.createRadialGradient(sx + cw / 2, hy, 0, sx + cw / 2, hy, rad);
        halo.addColorStop(0, withAlpha(bc, 0.5 * near * (0.5 + 0.5 * velN)));
        halo.addColorStop(1, withAlpha(bc, 0));
        ctx.fillStyle = halo;
        ctx.beginPath(); ctx.arc(sx + cw / 2, hy, rad, 0, 2 * Math.PI); ctx.fill();
      }
      if (fx.gloss) {
        // 白热内芯：参考图里音符不是纯色块，而是「中间亮、边缘是配色」的发光体。
        // 用一条竖渐变（fillRect，不是 roundRect —— 见上面测试约束）叠在块中央。
        const coreW = Math.max(2, cw * 0.34);
        const core = ctx.createLinearGradient(0, top, 0, Math.max(bottom, top + 1));
        core.addColorStop(0, 'rgba(255,255,255,' + (0.04 + 0.20 * velN).toFixed(3) + ')');
        core.addColorStop(0.5, 'rgba(255,255,255,' + (0.16 + 0.30 * velN).toFixed(3) + ')');
        core.addColorStop(1, 'rgba(255,255,255,0.03)');
        ctx.fillStyle = core;
        ctx.fillRect(sx + (cw - coreW) / 2, top + 2, coreW, Math.max(bh2 - 4, 2));
        ctx.strokeStyle = 'rgba(255,255,255,' + ((0.14 + 0.26 * velN) * (1 - depth)).toFixed(3) + ')';
        ctx.lineWidth = 1.4;
        const ey = Math.min(bottom, wN) - 1;
        ctx.beginPath(); ctx.moveTo(sx + 2, ey); ctx.lineTo(sx + cw - 2, ey); ctx.stroke();
        ctx.lineWidth = 1;
      }
    }
    if (forward) {
      let k2 = firstStartGT(arr, state.lastD);
      while (k2 < arr.length && arr[k2].start <= d) { hits.push(arr[k2]); k2++; }
    }
  }

  // ---- 击键粒子：音符跨过击键线时从键面迸出 ----
  // 方向用确定性伪随机（noise）而非 Math.random，导出画面才能逐帧复现。
  // kind：0 = 发光火花、1 = 冲击波环、2 = 光柱、3 = 旧版圆点
  if (forward) {
    const partScale = Math.max(0.2, Math.min(2, fx.partScale == null ? 1 : Number(fx.partScale)));
    const maxParts = Math.round(MAX_PARTS * Math.min(1.6, partScale));
    for (const b of hits) {
      if (state.parts.length >= maxParts) break;
      const { sx: sxBase, cw: cwBase } = pitchGeom(b.pitch, pm, g, wk0);
      const velN = clamp01((b.vel == null ? 90 : b.vel) / 127);
      const color = blockColor(b, cs, fx.colorBy);
      const cx = sxBase + cwBase / 2;
      state.hitPulse = 1;
      if (fx.flash > 0) {   // 击键闪光：比余辉短、比余辉白
        const kf = state.keyFlash || (state.keyFlash = new Map());
        kf.set(b.pitch, 1);
      }
      if (!fx.particles) {
        // 关掉粒子开关 → **逐像素回到旧观感**（旧的 2~5 颗 2px 圆点）
        const n0 = 2 + Math.round(velN * 3);
        for (let i = 0; i < n0; i++) {
          const s1 = noise(state.seed++), s2 = noise(state.seed++);
          state.parts.push({ kind: 3, x: cx, y: wN, vx: (s1 - 0.5) * 1.8, vy: -(0.5 + s2 * 1.9), life: 1, decay: 0.02, size: 2, color });
        }
        continue;
      }
      const n = Math.max(1, Math.round((3 + velN * 6) * partScale));
      for (let i = 0; i < n; i++) {
        const s1 = noise(state.seed++), s2 = noise(state.seed++), s3 = noise(state.seed++);
        state.parts.push({
          kind: 0,
          x: cx + (s1 - 0.5) * cwBase,
          y: wN,
          vx: (s1 - 0.5) * 3.4,
          vy: -(0.6 + s2 * 3.6) - velN * 1.2,
          life: 1,
          decay: 0.016 + s3 * 0.02,
          size: 5 + s3 * 9 + velN * 8,
          color,
        });
      }
      // 冲击波环：从键面扩散出去 —— 一帧里最快被看到的那笔"击键"
      state.parts.push({ kind: 1, x: cx, y: wN, r: 2, vr: 2.4 + velN * 2.8, life: 1, decay: 0.042, size: 0, color });
      // 光柱：短命的竖向光束，落在键上的一瞬间最亮
      if (fx.beams) {
        // 光柱：参考图里这一笔会"留"一会儿再淡上去，所以寿命比火花长、越高力越粗越长
        state.parts.push({ kind: 2, x: cx, y: wN, w: cwBase * (1.5 + velN * 0.5), h: 84 + velN * 150, life: 1, decay: 0.032, size: 0, color });
      }
    }
  }

  // ---- 琴键 ----
  const kp = keyPalette(state);
  // 琴键余辉：按下即亮，松开后在约 0.18s 内淡出。此前是硬开硬关并直接挂 20px 发光，
  // 密集音符下琴键会一片片地闪。高亮层改为叠在底色上按余辉强度渐入渐出。
  const keyGlow = state.keyGlow || (state.keyGlow = new Map());
  const KEY_DECAY = 0.09;
  const glowOf = (pitch, on) => {
    const prev = keyGlow.get(pitch) || 0;
    const gv = on ? 1 : Math.max(0, prev - KEY_DECAY);
    if (gv > 0.02) keyGlow.set(pitch, gv); else keyGlow.delete(pitch);
    return gv;
  };
  const whiteLiveColor = cssVar('--ink', '#0a0a0a');
  // 琴键底色渐变按「纵向」定义，颜色只取决于 y；每个白键/黑键的 y 区间完全一致，
  // 因此整屏琴键可以共用两个渐变对象，而不是每个键各建一个（实测 90 个/帧 → 4 个/帧）。
  // 横向平移不改变纵向渐变的着色（着色由 y 在轴上的投影决定），渲染结果逐像素一致。
  // ---- 3D 键盘（升级）：键区高度拆成「键面」+「前脸」（键的厚度）----
  // 只有键面时琴键是一张贴在画面上的纸；补上前脸、顶边高光和按压下沉才有体积感。
  // ★ 键面的 roundRect 必须**仍然从 y = wN 起** —— 单测用「第一个 y === wN 的 roundRect」
  //   定位琴键起点（frontend/tests/viz.test.js），改起点就会打破它。
  const keys3d = !!fx.keys3d;
  const topH = keys3d ? Math.max(10, Math.round(x * 0.72)) : x;
  const grWk = ctx.createLinearGradient(0, wN, 0, wN + topH);
  grWk.addColorStop(0, kp.wkTop); grWk.addColorStop(1, kp.wkBot);
  const grWkFront = keys3d ? ctx.createLinearGradient(0, wN + topH, 0, wN + x) : null;
  if (grWkFront) { grWkFront.addColorStop(0, kp.wkFrontTop); grWkFront.addColorStop(1, kp.wkFrontBot); }
  const bkH = Math.floor(0.6 * topH);
  const bkFrontH = Math.round(x * 0.34);
  const grBk = ctx.createLinearGradient(0, wN, 0, wN + bkH);
  grBk.addColorStop(0, kp.bkTop); grBk.addColorStop(1, kp.bkBot);
  const grBkFront = keys3d ? ctx.createLinearGradient(0, wN + bkH, 0, wN + bkH + bkFrontH) : null;
  if (grBkFront) { grBkFront.addColorStop(0, kp.bkFrontTop); grBkFront.addColorStop(1, kp.bkFrontBot); }
  const glowK = fx.glow == null ? 1 : Math.max(0.2, Number(fx.glow));
  // 键面路径：有透视时是**梯形**（后边窄、前边宽），否则维持圆角矩形。
  // ★ ps = 0 走 roundRect 分支 → 与升级前逐像素一致（"全关"必须能回去）。
  const keyTop = (px, pw, kh, r) => {
    if (ps > 0) {
      const bx0 = vpX + (px - vpX) * kB, bx1 = vpX + (px + pw - vpX) * kB;
      ctx.beginPath();
      ctx.moveTo(bx0, wN); ctx.lineTo(bx1, wN);
      ctx.lineTo(px + pw, wN + kh); ctx.lineTo(px, wN + kh);
      return;
    }
    ctx.beginPath(); ctx.roundRect(px, wN, pw, kh, r);
  };
  // 击键闪光（借 MIDIVisualizer 的 --flashes-size）：比琴键余辉更短更白，是"这一下"的读数
  const keyFlash = state.keyFlash || (state.keyFlash = new Map());
  const flashOf = (pitch) => {
    const prev = keyFlash.get(pitch) || 0;
    const v = Math.max(0, prev - 0.14);
    if (v > 0.02) keyFlash.set(pitch, v); else keyFlash.delete(pitch);
    return v;
  };
  for (let i = wk0; i < wk1; i++) {
    const pitch = WHITE_MIDI[i];
    const px = Math.floor((i - wk0) * g), pw = Math.floor(g);
    const act = sounding.get(pitch);
    const gv = glowOf(pitch, act !== undefined || live.has(pitch));
    // 击键线上被"顶起来"的那一小块（参考 SeeMusic：线不是直的，音落下处鼓起来）。
    // 半圆 + 描边，画在琴键之前，键面压在它的下沿上。
    if (fx.hitLine && act !== undefined) {
      const rr3 = Math.max(5, Math.min(pw * 0.62, 14));
      ctx.fillStyle = withAlpha(act, 0.42);
      ctx.beginPath(); ctx.arc(px + pw / 2, wN, rr3, Math.PI, 2 * Math.PI); ctx.fill();
      ctx.strokeStyle = withAlpha(act, 0.85); ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(px + pw / 2, wN, rr3, Math.PI, 2 * Math.PI); ctx.stroke();
      ctx.lineWidth = 1;
    }
    // 按下 → 键面变短、前脸变长：视觉上"沉下去"，但键面顶边仍在 y = wN（测试约束）
    const kh = keys3d ? Math.max(6, topH - Math.round(4 * gv)) : x;
    if (keys3d) { ctx.fillStyle = grWkFront; ctx.fillRect(px, wN + kh, pw, x - kh); }
    ctx.fillStyle = grWk;
    keyTop(px, pw, kh, [0, 0, 4, 4]); ctx.fill();
    if (keys3d) {   // 键面顶边高光：3D 感的关键一笔，没有它就是贴纸
      ctx.strokeStyle = kp.wkEdge; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(px + 0.5, wN + 0.5); ctx.lineTo(px + pw - 0.5, wN + 0.5); ctx.stroke();
    }
    if (gv > 0.02) {
      const keyColor = act !== undefined ? act : whiteLiveColor;
      // 往卷帘区里洒一条向上的光（SeeMusic 那种"灯"的感觉）——
      // 与粒子/光柱同一档开关，关掉就退回纯琴键高亮
      if (fx.beams) {
        const hh = 40 + 92 * gv;
        const up = ctx.createLinearGradient(0, wN, 0, wN - hh);
        up.addColorStop(0, withAlpha(keyColor, 0.26 * gv));
        up.addColorStop(1, withAlpha(keyColor, 0));
        ctx.fillStyle = up;
        ctx.fillRect(px, wN - hh, pw, hh);
      }
      ctx.globalAlpha = gv;
      ctx.fillStyle = keyColor;
      ctx.shadowBlur = 18 * gv * glowK; ctx.shadowColor = ctx.fillStyle;
      keyTop(px, pw, kh, [0, 0, 4, 4]); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
    const fv = fx.flash > 0 ? flashOf(pitch) : 0;
    if (fv > 0.02) {
      ctx.globalAlpha = Math.min(1, fv * fx.flash);
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      keyTop(px, pw, kh, [0, 0, 4, 4]); ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.beginPath(); ctx.moveTo(px + pw, wN); ctx.lineTo(px + pw, wN + kh - 4);
    ctx.strokeStyle = kp.wkLine; ctx.stroke();
    // 键名标注（默认关）：Synthesia 那类跟弹软件的"学习辅助"，白键够宽才画，否则是噪点
    if (fx.keyNames && pw >= 14) {
      const NN = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      ctx.fillStyle = withAlpha(text, 0.7);
      ctx.font = '9px system-ui, sans-serif';
      ctx.fillText(NN[pitch % 12] + (Math.floor(pitch / 12) - 1), px + pw - 3, wN + kh + 9);
    }
    if (pitch % 12 === 0) { ctx.fillStyle = text; ctx.font = '10px system-ui, sans-serif'; ctx.fillText('C' + (pitch / 12 - 1), px + 4, h - 5); }
  }
  // 黑键骑在两个白键之间：i 号白键右上方各有一个（B/C 与 E/F 之间没有）
  for (let i = wk0; i < wk1; i++) {
    const pitch = WHITE_MIDI[i] + 1;
    if (!BLACK_PC.includes(pitch % 12)) continue;
    const bx = Math.floor((i - wk0 + 1) * g - 0.35 * g), bw = Math.floor(0.7 * g);
    const act = sounding.get(pitch);
    const gv = glowOf(pitch, act !== undefined || live.has(pitch));
    const bh = keys3d ? Math.max(6, bkH - Math.round(4 * gv)) : bkH;
    if (keys3d) { ctx.fillStyle = grBkFront; ctx.fillRect(bx, wN + bh, bw, bkFrontH); }
    ctx.fillStyle = grBk;
    keyTop(bx, bw, bh, [0, 0, 2, 2]); ctx.fill();
    if (keys3d) {
      ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx + 0.5, wN + 0.5); ctx.lineTo(bx + bw - 0.5, wN + 0.5); ctx.stroke();
    }
    if (fx.beams && gv > 0.02) {
      const hh = 34 + 78 * gv;
      const up = ctx.createLinearGradient(0, wN, 0, wN - hh);
      up.addColorStop(0, withAlpha(act !== undefined ? act : '#8fb8ff', 0.22 * gv));
      up.addColorStop(1, withAlpha(act !== undefined ? act : '#8fb8ff', 0));
      ctx.fillStyle = up;
      ctx.fillRect(bx, wN - hh, bw, hh);
    }
    if (gv > 0.02) {
      ctx.globalAlpha = gv;
      // 黑键上「仅合成器在响」用深色压暗（浅色主题下 --ink 也是深色，深色主题下则不然，
      // 这里保持与改动前一致的语义）
      ctx.fillStyle = act !== undefined ? act : '#0a0a0a';
      ctx.shadowBlur = 18 * gv * glowK; ctx.shadowColor = ctx.fillStyle;
      keyTop(bx, bw, bh, [0, 0, 2, 2]); ctx.fill();
      ctx.shadowBlur = 0; ctx.globalAlpha = 1;
    }
    const fvb = fx.flash > 0 ? flashOf(pitch) : 0;
    if (fvb > 0.02) {
      ctx.globalAlpha = Math.min(1, fvb * fx.flash);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      keyTop(bx, bw, bh, [0, 0, 2, 2]); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  // 粒子统一用**加色混合**画：光效叠在深色底上是"发光"，用普通混合只会是"贴纸"。
  if (state.parts.length) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let e = state.parts.length - 1; e >= 0; e--) {
      const p = state.parts[e];
      if (p.kind === 1) {                                  // 冲击波环
        p.r += p.vr; p.vr *= 0.94; p.life -= p.decay;
        if (p.life <= 0) { state.parts.splice(e, 1); continue; }
        ctx.globalAlpha = p.life * 0.5;
        ctx.strokeStyle = p.color;
        ctx.lineWidth = 1 + 2 * p.life;
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 2 * Math.PI); ctx.stroke();
        continue;
      }
      if (p.kind === 2) {                                  // 光柱
        p.y -= 2.6; p.life -= p.decay;
        if (p.life <= 0) { state.parts.splice(e, 1); continue; }
        ctx.globalAlpha = 1;
        // ★ 三层嵌套：canvas 的渐变只能沿一个轴，单层 linearGradient 的光柱左右是**硬边**，
        //   看着像红纸条（离线渲染台实测）。三层不同宽度的同色渐变叠起来，
        //   横向也就有了柔和衰减，接近参考图里"从键上洒出来的一束光"。
        for (let bi = 0; bi < 3; bi++) {
          const kk = bi / 2;
          const wkk = p.w * (0.42 + 0.58 * kk);
          const beam = ctx.createLinearGradient(0, p.y, 0, p.y - p.h);
          beam.addColorStop(0, withAlpha(p.color, (0.40 - 0.13 * bi) * p.life));
          beam.addColorStop(1, withAlpha(p.color, 0));
          ctx.fillStyle = beam;
          ctx.fillRect(p.x - wkk / 2, p.y - p.h, wkk, p.h);
        }
        continue;
      }
      p.x += p.vx; p.y += p.vy;
      p.vx *= 0.985;
      p.vy += p.kind === 3 ? 0.2 : 0.16;                   // 旧版圆点保持原重力常数
      p.life -= p.decay;
      if (p.life <= 0) { state.parts.splice(e, 1); continue; }
      if (p.kind === 0) {
        const sp = glowSprite(p.color);
        const s = p.size * (0.45 + p.life * 0.55) * 2;
        ctx.globalAlpha = p.life;
        if (sp) {
          ctx.drawImage(sp, p.x - s / 2, p.y - s / 2, s, s);
        } else {                                           // 无 document：纯 arc 回退
          ctx.fillStyle = p.color;
          ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, s * 0.16), 0, 2 * Math.PI); ctx.fill();
        }
      } else {
        ctx.globalAlpha = p.life; ctx.fillStyle = p.color;
        ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, 2 * Math.PI); ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.restore();
  }
  state.lastD = d;
  if (opts.showLyrics && opts.lyricAt) {
    ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 4, w, 24);
    ctx.fillStyle = '#fff'; ctx.font = '600 14px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(opts.lyricAt, w / 2, 16);
  }
  return { active: liveNotes.filter(n => n.start <= tick && n.end >= tick) };
}

/* ---------------- 后处理泛光（D7）----------------
 * 逐元素的 shadowBlur 有两个问题：① 4K 下是最大的一笔成本；② 它让"每个音符自己亮"，
 * 而参考实现（MIDIVisualizer / Pianola 那类）都是**先渲染场景、再做一遍提亮+模糊+叠加**。
 *
 * Canvas 2D 里不需要 getImageData 的等价近似：
 *   ① 场景画进离屏（设备分辨率）
 *   ② 缩到 1/4 得到 A，再在 A 上用 `multiply` 自乘 → A ≈ 场景²（等价于阈值提亮：暗部被压掉）
 *   ③ 把 A 用 `lighter` 叠回主画布；再来一张 1/8 尺寸的，得到更宽的一圈晕
 * 成本 = 4 次 drawImage + 2 次降采样，都在小图上做，与分辨率弱相关。
 *
 * ★ **实时（ViewViz）与视频导出（ViewConvert）必须都调这个包装函数** —— 只调 drawVizWaterfall
 *   就等于"导出没有泛光"，正是用户反复强调的"预览与成片不一致"。
 * ★ node 单测环境没有 document → 直接回退 drawVizWaterfall（测试断言的是绘制调用，不受影响）。
 * ★ 泛光取自**场景层**（音符/琴键/粒子），不取自背景图 —— 否则一张亮背景会把整幅糊白。
 */
const BLOOM = { scene: null, a: null, b: null };
export function drawVizWaterfallPost(ctx, w, h, song, tick, opts = {}) {
  const fx = fxOf(opts);
  const amount = Math.max(0, Number(fx.bloom) || 0);
  if (amount <= 0.001 || typeof document === 'undefined' || !document.createElement) {
    return drawVizWaterfall(ctx, w, h, song, tick, opts);
  }
  const sc = pixelScale(ctx) || 1;
  const pw = Math.max(1, Math.round(w * sc)), ph = Math.max(1, Math.round(h * sc));
  const sized = (k, key) => {
    const cw = Math.max(1, Math.round(pw * k)), ch = Math.max(1, Math.round(ph * k));
    let cv = BLOOM[key];
    if (!cv) cv = BLOOM[key] = document.createElement('canvas');
    if (cv.width !== cw || cv.height !== ch) { cv.width = cw; cv.height = ch; }
    return cv;
  };
  // ① 场景 → 离屏（不含泛光）
  const scene = sized(1, 'scene');
  const sctx = scene.getContext('2d');
  sctx.setTransform(1, 0, 0, 1, 0, 0);
  sctx.clearRect(0, 0, pw, ph);
  sctx.save(); sctx.scale(sc, sc);
  const res = drawVizWaterfall(sctx, w, h, song, tick, opts);
  sctx.restore();

  // ② + ③ 场景本身 + 两层提亮模糊叠加
  const thr = Math.max(0, Math.min(1, Number(fx.bloomThr) || 0));
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.drawImage(scene, 0, 0);
  // ★ 只用**一张** 1/4 小图：原来 1/4 与 1/8 各降采样一次，等于每帧两次全分辨率读取，
  //   离线台实测 1080p 泛光要 +17 ms、4K +50 ms（CPU 光栅的上界）。
  //   现在小图只降一次，第二遍把它**放大 1.4 倍**再叠 —— 同样得到更宽的一圈晕，但省一次降采样。
  const small = sized(0.25, 'a');
  const c2 = small.getContext('2d');
  c2.setTransform(1, 0, 0, 1, 0, 0);
  c2.globalCompositeOperation = 'source-over';
  c2.clearRect(0, 0, small.width, small.height);
  c2.drawImage(scene, 0, 0, small.width, small.height);   // 降采样 = 低通
  if (thr > 0.02) {
    c2.globalCompositeOperation = 'multiply';
    c2.drawImage(small, 0, 0);                            // 自乘 ≈ 阈值提亮（暗部被压掉）
    if (thr > 0.45) c2.drawImage(small, 0, 0);            // 阈值更高 → 再压一次暗部
  }
  ctx.globalCompositeOperation = 'lighter';
  ctx.globalAlpha = Math.min(1, amount * 0.42);
  ctx.drawImage(small, 0, 0, pw, ph);
  const ow = pw * 1.4, oh = ph * 1.4;                     // 第二遍放大 → 更宽更柔的外圈
  ctx.globalAlpha = Math.min(1, amount * 0.22);
  ctx.drawImage(small, (pw - ow) / 2, (ph - oh) / 2, ow, oh);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  return res;
}

/* ---------------- 音乐能量：实时视图与视频导出共用同一套算法 ---------------- */

const ENERGY_WIN_SEC = 0.04;   // 40ms 窗口：短到能跟上音符起落，长到不会被单周期波形带偏
const ENERGY_FLOOR = 0.01;     // 低于此 RMS 视为静音（底噪/混响尾巴）
const ENERGY_GAIN = 4.2;       // 音乐 RMS 大致落在 0.02~0.35，映射到 0..1

// RMS 软归一化到 0..1
function normalizeRms(rms) {
  return clamp01((rms - ENERGY_FLOOR) * ENERGY_GAIN);
}

// 导出侧：从解码后的 PCM 取 sec 处的能量
export function rmsAt(audioBuf, sec, winSec = ENERGY_WIN_SEC) {
  if (!audioBuf || typeof audioBuf.getChannelData !== 'function') return 0;
  const data = audioBuf.getChannelData(0), sr = audioBuf.sampleRate || 44100;
  const n = Math.max(1, Math.floor(sr * winSec));
  const i0 = Math.max(0, Math.floor(sec * sr));
  const i1 = Math.min(data.length, i0 + n);
  if (i1 <= i0) return 0;
  let sum = 0;
  for (let i = i0; i < i1; i++) sum += data[i] * data[i];
  return normalizeRms(Math.sqrt(sum / (i1 - i0)));
}

// 实时侧：从 AnalyserNode.getByteTimeDomainData 的字节波形取能量。
// 与 rmsAt 是同一个信号上的同一个度量，差别仅在字节量化（128 为静音中点）。
export function rmsFromBytes(td) {
  if (!td || !td.length) return 0;
  let sum = 0;
  for (let i = 0; i < td.length; i++) { const v = (td[i] - 128) / 128; sum += v * v; }
  return normalizeRms(Math.sqrt(sum / td.length));
}

// 能量包络平滑：起音快、收音慢，避免逐帧抖动导致的背景闪烁
export function smoothEnergy(prev, target, attack = 0.5, release = 0.06) {
  const p = (typeof prev === 'number' && isFinite(prev)) ? prev : 0;
  const k = target > p ? attack : release;
  return p + (target - p) * k;
}

export function drawVizSpectrum(ctx, w, h, audioBuf, nowSec) {
  if (!audioBuf) return;
  const data = audioBuf.getChannelData(0), sr = audioBuf.sampleRate;
  const bars = 72, rowH = Math.max(2, Math.round(h / 44));
  const windowSec = 2, step = Math.max(1, Math.floor(sr * 0.02));
  for (let r = 0; r < Math.floor(h / rowH); r++) {
    const t = nowSec - (windowSec * (Math.floor(h / rowH) - 1 - r) / Math.floor(h / rowH));
    if (t < 0) continue;
    const si = Math.max(0, Math.floor(t * sr)), si2 = Math.min(data.length, si + step);
    let sum = 0;
    for (let j = si; j < si2; j++) sum += data[j] * data[j];
    const rms = Math.min(1, Math.sqrt(sum / Math.max(1, si2 - si)) * 3);
    const bw = w / bars;
    for (let i = 0; i < bars; i++) {
      const v = rms * (0.4 + 0.6 * (i / bars));
      const hue = 210 + 40 * (i / bars);
      ctx.fillStyle = 'hsla(' + hue + ',85%,50%,' + (0.2 + v * 0.8) + ')';
      ctx.fillRect(i * bw, r * rowH, bw, rowH);
    }
  }
}

export function drawVizScope(ctx, w, h, audioBuf, nowSec) {
  if (!audioBuf) return;
  const data = audioBuf.getChannelData(0), sr = audioBuf.sampleRate;
  const win = Math.floor(sr * 0.05);
  const i0 = Math.max(0, Math.floor(nowSec * sr));
  ctx.strokeStyle = 'rgba(20,86,240,0.9)'; ctx.lineWidth = 1.6; ctx.beginPath();
  const n = Math.min(win, data.length - i0);
  for (let i = 0; i < n; i += 2) {
    const x = i / Math.max(1, n) * w;
    const y = h / 2 + data[i0 + i] * h * 0.45;
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.stroke();
}

export function drawVizChord(ctx, w, h, activeNotes) {
  const pcs = [...new Set(activeNotes.map(n => ((n.midi % 12) + 12) % 12))].sort((a, b) => a - b);
  const KEY_NAME = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];
  let chord = null;
  if (pcs.length >= 3) {
    let best = null;
    for (let r = 0; r < 12; r++) for (const [mi, set] of [[0,[0,4,7]],[1,[0,3,7]]]) {
      let sc=0; for (const d of set) if (pcs.includes((r+d)%12)) sc++;
      if (!best || sc > best.sc) best = { r, mi, sc };
    }
    if (best && best.sc >= 3) chord = { name: KEY_NAME[best.r] + (best.mi ? 'm' : ''), pcs };
  }
  ctx.fillStyle = cssVar('--canvas', '#ffffff'); ctx.fillRect(0,0,w,h);
  ctx.textAlign='center'; ctx.textBaseline='middle';
  if (chord) {
    ctx.fillStyle='#ff5530'; ctx.font='700 '+Math.max(18,Math.round(h*.3))+'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(chord.name, w/2, h*.34);
    ctx.fillStyle=cssVar('--stone','rgba(10,10,10,.55)'); ctx.font='10px Consolas, monospace';
    ctx.fillText(chord.pcs.map(p=>KEY_NAME[p]).join(' · '), w/2, h*.62);
    ctx.fillStyle=cssVar('--slate','rgba(10,10,10,.75)'); ctx.font='12px "Microsoft YaHei", sans-serif';
    ctx.fillText(t('播放中'), w/2, h*.8);
  } else {
    ctx.fillStyle=cssVar('--slate','rgba(10,10,10,.75)'); ctx.font='12px "Microsoft YaHei", sans-serif';
    ctx.fillText(pcs.length ? pcs.map(p=>KEY_NAME[p]).join(' · ') : t('播放时显示实时和弦'), w/2, h*.45);
  }
}
/** 按**秒**平滑的能量包络（③ 导出/实时统一）。
 *  旧的 smoothEnergy(prev, target, attack, release) 是**逐帧**系数：实时 60~144Hz 与导出固定 fps
 *  的时间常数不同，于是同一个音在两边「脉动」的快慢/幅度不一样。
 *  这里用 1-exp(-dt/τ) 的形式，dt 由调用方给（实时取 rAF 间隔，导出取 1/fps）。 */
export function smoothEnergyDt(prev, target, dt, attack = 0.18, release = 0.22) {
  // ★ 必须和 smoothEnergy 一样兜住非数值：导出每次开录都把 _state 清空，
  //   第一帧 prev 是 undefined —— 少了这一行，undefined + NaN 会让包络**整段变成 NaN**，
  //   于是 `energy > 0.01` 永远为假，导出的画面从头到尾没有那层随音乐脉动的背景光晕
  //   （实时侧有兜底、导出侧没有 ⇒ 两边差一层光）。
  const p = (typeof prev === 'number' && isFinite(prev)) ? prev : 0;
  const tg = (typeof target === 'number' && isFinite(target)) ? target : 0;
  const k = (tg > p ? attack : release);
  const a = 1 - Math.exp(-Math.max(0, dt) / Math.max(1e-3, k));
  return p + (tg - p) * a;
}

/** 某一时刻**真正在发声**的音符（④ 导出与实时统一）：
 *  导出原来直接遍历谱面 `n.start <= tick && n.end >= tick`，于是**静音轨/独奏外的轨**也会被点亮，
 *  亮块数量与实时（syn.activeNow() 只报真正在响的）对不上。
 *  mute = 被静音的轨 index 数组；solo >= 0 时只算该轨（与混音台语义一致）。 */
export function activeNotesAt(song, tick, opts = {}) {
  const mute = opts.mute || [];
  const solo = (typeof opts.solo === 'number') ? opts.solo : -1;
  const minVel = opts.minVel || 1;
  const out = [];
  for (const tr of (song && song.tracks) || []) {
    if (solo >= 0 ? tr.index !== solo : mute.indexOf(tr.index) >= 0) continue;
    if (tr.muted && solo < 0) continue;
    for (const n of tr.notes || []) {
      if (n.start <= tick && n.end >= tick && (n.vel == null ? 127 : n.vel) >= minVel) out.push(n);
    }
  }
  return out;
}
