// ============================================================
// 可视化共享工具（重做后的角色）
//
// ★ 这里**不再有任何渲染入口**：旧的 drawVizWaterfall / drawVizWaterfallPost
//   （一个 520 行的单体函数 + 它的 canvas 泛光）已随重做的 M6 删除。
// 留下的是被新旧两边共用的纯工具：
//   · 几何/时间轴：ensurePm / WHITE_MIDI / BLACK_PC / whiteIndexOf / pitchGeom /
//                  buildVizBlocks / visibleRange / noise
//   · 音乐能量：rmsAt / rmsFromBytes / smoothEnergy / smoothEnergyDt / normalizeRms / activeNotesAt
//   · 背景：paintVizBg（主题/纯色/图片/透明，实时与视频导出同一个）
//   · 仪表盘：drawVizSpectrum / drawVizScope / drawVizChord
//   · 参数默认值：FX_DEFAULTS / FX_PARAMS / FX_COLORBY（stores/vizbg 的单一来源）
//
// 新渲染架构在 core/viz/ 下：state（数据）→ scene（图元）→ raster（Canvas2D / WebGL2）
// → post（着色器后处理），唯一入口是 core/viz/index.js 的门面。
// ============================================================
import { TRACK_COLORS } from './util.js';
import { COLOR_DEFAULTS, COLOR_MODES, COLOR_PRESETS, COLOR_PARAMS } from './viz/state/colors.js';
import { t } from './i18n.js';

function cssVar(name, fb) {
  try { const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); return v || fb; } catch (e) { return fb; }
}
export function ensurePm() {
  if (ensurePm._pm) return ensurePm._pm;
  const pm = {}; let wk = 0;
  for (let m = 21; m <= 108; m++) { const pb = [1, 3, 6, 8, 10].includes(m % 12); pm[m] = { isBlack: pb, wkCount: wk }; if (!pb) wk++; }
  ensurePm._pm = pm;
  return pm;
}
// 一个八度内的黑键半音偏移（以 C 为 0）
export const BLACK_PC = [1, 3, 6, 8, 10];

// 52 个白键的 midi（升序）。原来每帧都要用 while 循环把音高换算成白键序号，
// 这里预计算成数组，音频几何与琴键绘制直接查表。
export const WHITE_MIDI = (() => {
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
// 背景模糊半径的折算基准（导出时按 ds / VIZ_REF_DPR 等比放大模糊）
export const VIZ_REF_DPR = 2.5;

// 3D 键盘（2026-10）：wk/bk 是**键面**（俯视看到的那一面），wkFront/bkFront 是**前脸**
// （键的厚度），wkEdge 是键面顶边的那道高光。三部分叠起来才有"一块琴键"的体积感 ——
// 只有键面时，琴键看起来是一张贴在画面上的纸（旧观感）。
/* ★ 键面亮度是"效果一般"的**元凶**（2026-10-17 量测）：
 *   参考实现（SeeMusic/粒子流/Synthesia/DoraPiano）的**键盘区平均亮度 0.00–0.33**，
 *   而我们是 **0.59–0.65** —— 一大条白键盘抢走了全部注意力，音符再亮也是陪衬。
 *   所以两套主题的键面**都压暗**：白键不再是"白"，而是中灰；黑键接近背景。
 *   只有**按键**才亮（余辉 + 光柱 + 闪光），亮度层级才对：背景 < 键盘 < 音符 < 击键瞬间。
 *   亮度的读数用 scripts/viz-lookcheck.py（此条不是验收门槛，是自查）。 */

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

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
export function whiteIndexOf(pitch) {
  const pi = ensurePm()[pitch];
  if (!pi) return 0;
  const i = pi.isBlack ? pi.wkCount - 1 : pi.wkCount;
  return Math.max(0, Math.min(WHITE_TOTAL - 1, i));
}

// 音符块横向几何：白键占 0.9 格，黑键占 0.6 格并骑在两个白键之间。
// cw 不取整（纵深收窄要按比例算），sx 已取整。
export function pitchGeom(pitch, pm, g, wk0) {
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
export function noise(n) {
  const x = Math.sin(n * 12.9898) * 43758.5453;
  return x - Math.floor(x);
}

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
  grid: true,        // 键位竖线 + 小节线 + 小节编号（想要干净画面就关掉）
  // —— 参数（面板里是滑块）——
  // D2 决定**不做固定档位**，改成用户可调：这些值就是那套"档位"的自由形式。
  persp: 0,          // 键盘透视强度 0..1（0 = 平板键，与 Synthesia/SeeMusic 同路线）。
                     // 3D 只做"温和倾斜"：横向扇形很小、纵向 1/z 缩短 + 远端压暗 + 黑键前脸。
                     // 2026-10-17：默认从 0.45 改回 0 —— 上一版的大扇形被用户判为"粗暴的拉伸"。
  bloom: 0.55,       // 后处理泛光强度 0..1.2
  bloomThr: 0.5,     // 泛光阈值 0..1（越大只有最亮的地方发光）
  flash: 0.7,        // 击键闪光 0..1.5（借 MIDIVisualizer 的 --flashes-size）
  partScale: 1,      // 粒子数量倍率 0.3..1.6
  glow: 1,           // 光柱/发光强度倍率 0.4..1.6
  // 配色：取色方式 + 参数（色相/跨度/旋转/饱和/亮度/手色）全在 state/colors.js，这里是单一来源的并入
  ...COLOR_DEFAULTS,
  keysOn: true,      // 显示琴键（关掉 = 只留音符与光效，给叠加层用）
  // 琴键不透明度已移除（用户要求去掉：琴键要么显示要么隐藏，透明度留给音符）
  noteAlpha: 1,      // 下落音符的不透明度 0.15..1（玻璃质感下用它做通透度）
};

/* 参数元数据 —— **单一来源**：面板据此渲染滑块，不用在 store 与 UI 里各写一遍范围 */
export const FX_PARAMS = [
  { k: 'persp', label: '键盘透视', min: 0, max: 1, step: 0.05 },
  { k: 'bloom', label: '泛光', min: 0, max: 1.2, step: 0.05 },
  { k: 'bloomThr', label: '泛光阈值', min: 0, max: 1, step: 0.05 },
  { k: 'flash', label: '击键闪光', min: 0, max: 1.5, step: 0.05 },
  { k: 'partScale', label: '粒子数量', min: 0.3, max: 1.6, step: 0.1 },
  { k: 'glow', label: '光柱强度', min: 0.4, max: 1.6, step: 0.05 },
  { k: 'noteAlpha', label: '音符不透明度', min: 0.15, max: 1, step: 0.05 },
];
// 配色元数据由 state/colors.js 提供（单一来源）：取色方式 / 预设 / 参数范围
export const FX_COLORBY = COLOR_MODES;
export { COLOR_MODES, COLOR_PRESETS, COLOR_PARAMS, COLOR_DEFAULTS };

/* 内置主题：名字与数值都在这里，用户保存的自定义主题由 store 合并进来（D8：命名交给用户） */

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
 * 画音符瀑布的背景（`主题 / 纯色 / 图片 / 动态壁纸 / 透明`）—— **可视化页与视频导出共用这一个实现**。
 *
 * ★ 抽出来是为了让导出与实时预览**逐像素同源**：导出页以前自己 fillRect 一个 bgColor，
 *   跟可视化页选的图片/透明档/模糊暗化完全无关（用户看到的和导出的是两幅画）。
 * ★ `mode === 'keep'` 表示**不动背景**（调用方已经自己铺过一整帧了）—— 导出的仪表盘模板
 *   要先把背景铺满整帧、再在上下两块区域分别画瀑布，不能让瀑布再清一次自己那块。
 * ★ 千万不要 setTransform(1,0,0,1,0,0)：调用方已经把 dpr 缩放设在 ctx 上，
 *   而传进来的 w/h 是 **CSS 像素**。重置成 identity 只会铺满左上角 1/dpr 的区域。
 */
/* 动态壁纸的**受限尺寸帧**（2026-10-17）。
   视频每帧都在变，所以模糊只能逐帧做 —— 而位图缓存那条路（下面 paintVizBg 里的 BG_CACHE）
   正是为"背景参数一次会话里恒定"设计的。4K 全分辨率一次 blur 实测 80~150ms，远超单帧预算，
   于是先把当前帧画进一张**最多 1280 宽**的离屏画布、在那里做模糊（半径同比缩小），再放大铺满：
   模糊过的画面本来就没有细节可损失，而开销被压到 1/9 以下。不模糊时直接铺，一次 drawImage 最省。 */
const WALL_FRAME = { cv: null, w: 0, h: 0 };
function wallFrameCanvas(w, h) {
  if (!WALL_FRAME.cv) WALL_FRAME.cv = document.createElement('canvas');
  if (WALL_FRAME.w !== w || WALL_FRAME.h !== h) {
    WALL_FRAME.cv.width = w; WALL_FRAME.cv.height = h;
    WALL_FRAME.w = w; WALL_FRAME.h = h;
  }
  return WALL_FRAME.cv;
}

export function paintVizBgDirect(ctx, w, h, bgOpt = {}) {
  const mode = bgOpt.mode || 'theme';
  const blur = Math.max(0, Number(bgOpt.blur) || 0);
  const dim = Math.max(0, Math.min(0.9, Number(bgOpt.dim) || 0));
  // ★ 动态壁纸档：只认"已经出过帧"的视频（readyState<2 或 videoWidth=0 时交给下面的渐变兜底，
  //   不留一块黑屏）。视频与图片走**同一条 cover 铺法**，区别只在逐帧做模糊那一支。
  const vid = (mode === 'wallpaper' && bgOpt.video && bgOpt.video.videoWidth) ? bgOpt.video : null;
  const img = (!vid && mode === 'image' && bgOpt.image && bgOpt.image.width) ? bgOpt.image : null;
  ctx.save();
  if (mode === 'solid') {
    ctx.fillStyle = bgOpt.color || cssVar('--canvas', '#0b1020');
    ctx.fillRect(0, 0, w, h);
  } else if (vid && blur > 0 && typeof document !== 'undefined') {
    const cw = Math.min(1280, Math.max(480, Math.round(w)));
    const ch = Math.max(1, Math.round(cw * h / Math.max(1, w)));
    const cv = wallFrameCanvas(cw, ch);
    const c2 = cv.getContext('2d');
    const k = cw / Math.max(1, w);                 // 帧相对画布的缩放：模糊半径同比缩
    const b2 = blur * k, pad2 = b2 * 3;
    const sc2 = Math.max((cw + pad2 * 2) / vid.videoWidth, (ch + pad2 * 2) / vid.videoHeight);
    const dw2 = vid.videoWidth * sc2, dh2 = vid.videoHeight * sc2;
    c2.setTransform(1, 0, 0, 1, 0, 0);
    c2.clearRect(0, 0, cw, ch);
    c2.filter = 'blur(' + b2 + 'px)';
    c2.drawImage(vid, (cw - dw2) / 2, (ch - dh2) / 2, dw2, dh2);
    c2.filter = 'none';
    if (dim > 0) { c2.fillStyle = 'rgba(0,0,0,' + dim + ')'; c2.fillRect(0, 0, cw, ch); }
    ctx.drawImage(cv, 0, 0, w, h);
  } else if (vid || img) {
    const src = vid || img;
    const sw = vid ? vid.videoWidth : img.width;
    const sh = vid ? vid.videoHeight : img.height;
    // cover：填满、不拉伸变形。模糊会把边缘「吃」掉（blur 会采到画布外的透明像素），
    // 所以按模糊半径外扩一点再画 —— 实测不扩的话四边会透出底色。
    const pad = blur > 0 ? blur * 3 : 0;
    const scale = Math.max((w + pad * 2) / sw, (h + pad * 2) / sh);
    const dw = sw * scale, dh = sh * scale;
    ctx.filter = blur > 0 ? 'blur(' + blur + 'px)' : 'none';
    ctx.drawImage(src, (w - dw) / 2, (h - dh) / 2, dw, dh);
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
  if (mode === 'wallpaper') {
    // ★ 动态壁纸**绝不能走位图缓存**：BG_CACHE 的键里没有时间，缓存住就等于画面永远停在第一帧
    //   （用户看到的会是"选了动态壁纸却是一张静止图"）。逐帧直画当前帧；
    //   模糊已在 paintVizBgDirect 内部按受限尺寸做过，所以这里不必再打折。
    paintVizBgDirect(ctx, w, h, bgOpt);
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
    ctx.fillStyle='#ff5530'; ctx.font='700 '+Math.max(18,Math.round(h*.3))+'px "Segoe UI", "Microsoft YaHei", sans-serif';   // ui-tokens-allow: 可视化内部绘制（该子系统自带主题，见 docs/DESIGN.md 第 8 节）
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
