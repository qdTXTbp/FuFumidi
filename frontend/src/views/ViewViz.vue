<script setup>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount, onActivated, onDeactivated } from 'vue';
import { useAppStore } from '../stores/app';
import { useVizBgStore } from '../stores/vizbg';
import { getSynth, ensureAudio, getPlayer } from '../audio.js';
import { FX_DEFAULT_COLORS } from '../core/palette.js';

const app = useAppStore();
const currentSong = computed(() => app.currentSong);
import Icon from '../components/Icon.vue';
// ★ 必须用 drawVizWaterfallPost：它内部才是"场景 + 后处理泛光"的完整一帧。
//   直接调 drawVizWaterfall 会得到"实时没有泛光、导出有"（或反过来）—— 预览与成片就不一致了。
// ★ 重做后走新门面 core/viz/index.js（图元层 + 光栅器 + 后处理）。
//   旧的 core/viz.js 仍提供 timeline/几何与单测用的纯函数。
import { drawVizWaterfallPost } from '../core/viz/index.js';
import { rmsFromBytes, smoothEnergy, FX_DEFAULTS } from '../core/viz.js';
// 配色：取色方式 / 预设 / 参数范围都来自 state/colors.js（与渲染层同一份，不在 UI 里另写一遍）
import { COLOR_MODES, COLOR_PRESETS, COLOR_PARAMS } from '../core/viz/state/colors.js';
import { t } from '../core/i18n.js';
import NumSlider from '../components/NumSlider.vue';

const mode = ref('dash'); // 'dash' | 'waterfall'
const wfZoom = ref(1);
const immersive = ref(false);

/* ---------------- 音符瀑布的背景 ----------------
   ★ 状态住在 stores/vizbg.ts：**导出视频页读的是同一份**（同一 localStorage 键、
     同一绘制函数 core/viz.js 的 paintVizBg）。以前两边各存一份，用户在瀑布流里挑的
     图片、透明档、模糊/暗化，导出的成片一概不认 —— 看到的和导出的不是一幅画。
    theme       主题渐变
    solid       纯色（深色底更适合投影/OBS）
    image       自定义图片（可模糊 + 暗化）—— 参照 SeeMusic / Synthesia 的背景图玩法
    transparent 真·透明（导出的 PNG/视频直接当叠加层，不再是一块白底）—— 默认档 */
const vizBg = useVizBgStore();
const bg = vizBg.bg;                // reactive，模板与绘制都直接读它
const bgMore = ref(false);          // 设置条是否展开：纯 UI 状态，不进 store
/* ---------------- 视效面板：独立浮层 + 可在工具内拖动（2026-10-17） ----------------
   为什么浮层化：原来视效条住在文档流里，一展开画布就被挤矮 —— 调参数时反而看不清效果。
   现在面板 Teleport 到 body、position:fixed，可以拖到不挡视线的地方，画布保持满幅。
   拖动手柄**只有标题栏**（面板里的滑块/色块照常点，不会一碰就拖走）；位置记在 localStorage。 */
const fxPanel = ref(false);
const fxPanelPos = ref({ x: 0, y: 0 });   // 面板左上角（视口坐标 px）
const fxPanelEl = ref(null);
const fxPanelSize = ref({ w: 0, h: 0 });  // 用户拖出来的尺寸（0 = 用 CSS 默认窄宽度）
let fxRO = null;                          // ResizeObserver：把"拖出来的尺寸"记下来
let fxDrag = null;                        // { dx, dy }：按下时指针相对面板左上角的偏移
function attachPanelResize() {
  if (fxRO || !fxPanelEl.value || typeof ResizeObserver === 'undefined') return;
  fxRO = new ResizeObserver(() => {
    const el = fxPanelEl.value;
    if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight;
    if (Math.abs(w - fxPanelSize.value.w) > 1 || Math.abs(h - fxPanelSize.value.h) > 1) {
      fxPanelSize.value = { w, h };
      savePrefs();
    }
  });
  fxRO.observe(fxPanelEl.value);
}
function panelSize() {
  const el = fxPanelEl.value;
  return { w: el ? el.offsetWidth : 780, h: el ? el.offsetHeight : 260 };
}
function clampPanel(x, y) {
  const { w, h } = panelSize();
  const maxX = Math.max(8, window.innerWidth - w - 8);
  const maxY = Math.max(8, window.innerHeight - h - 8);
  return { x: Math.round(Math.min(Math.max(8, x), maxX)), y: Math.round(Math.min(Math.max(8, y), maxY)) };
}
function defaultPanelPos() {
  const { w } = panelSize();
  return clampPanel(Math.round((window.innerWidth - w) / 2), Math.round(window.innerHeight * 0.14));
}
function toggleFxPanel() {
  fxPanel.value = !fxPanel.value;
  if (!fxPanel.value) return;
  if (!fxPanelPos.value.x && !fxPanelPos.value.y) fxPanelPos.value = defaultPanelPos();
  nextTick(() => { attachPanelResize(); fxPanelPos.value = clampPanel(fxPanelPos.value.x, fxPanelPos.value.y); });
}
function resetPanelPos() { fxPanelPos.value = defaultPanelPos(); savePrefs(); }
function onPanelDown(e) {
  if (e.button !== 0) return;
  if (e.target && e.target.closest && e.target.closest('button')) return;   // 标题栏上的按钮不触发拖动
  const p = fxPanelPos.value;
  fxDrag = { dx: e.clientX - p.x, dy: e.clientY - p.y };
  window.addEventListener('pointermove', onPanelMove);
  window.addEventListener('pointerup', onPanelUp);
  e.preventDefault();
}
function onPanelMove(e) {
  if (!fxDrag) return;
  fxPanelPos.value = clampPanel(e.clientX - fxDrag.dx, e.clientY - fxDrag.dy);
}
function onPanelUp() {
  fxDrag = null;
  window.removeEventListener('pointermove', onPanelMove);
  window.removeEventListener('pointerup', onPanelUp);
  savePrefs();
}
const fxItems = vizBg.FX_ITEMS;     // 视效开关清单（顺序即界面顺序）
/* ---------------- 配色（2026-10-17 推倒重做） ----------------
   旧版有两行互相压制的控件：选了"按音高"之后，"配色档"就整排失效；
   而且"按音高/按左右手"返回 hsl() 字符串，在 GPU 路径上解析不出来 → 全部变白。
   现在拆成两条正交轴：**取色方式**（色相从哪来）× **调色参数**（基准/跨度/旋转/饱和/亮度），
   预设只是往参数里填一组值，填完还能继续拖 —— 所以每个控件都必然改变画面。 */
const colorMode = computed(() => (bg.fx && bg.fx.colorMode) || (bg.fx && bg.fx.colorBy) || 'track');
const colorPreset = computed(() => (bg.fx && bg.fx.preset) || 'rainbow');
// 色相基准/跨度只在"按音高"下参与取色；其余模式下这两条不显示，免得出现"拖了没反应"的死控件
const colorParams = computed(() => COLOR_PARAMS.filter((p) => colorMode.value === 'pitch' || (p.k !== 'hueBase' && p.k !== 'hueSpan')));
function fxColor(k) {
  const cur = bg.fx ? bg.fx[k] : undefined;
  return typeof cur === 'string' ? cur : FX_DEFAULTS[k];
}
function applyColorPreset(p) {
  vizBg.setFxAny('preset', p.k);
  vizBg.setFxAny('hueBase', p.hueBase);
  vizBg.setFxAny('hueSpan', p.hueSpan);
  vizBg.setFxAny('satAdj', p.satAdj);
  vizBg.setFxAny('lightAdj', p.lightAdj);
  // 预设调的是色相参数，只有"按音高"会用到它们 → 自动切过去，点了就一定看得见变化
  if (colorMode.value !== 'pitch') vizBg.setFxAny('colorMode', 'pitch');
}
function resetColors() {
  vizBg.setFxAny('colorMode', 'track');
  vizBg.setFxAny('hueBase', 0);
  vizBg.setFxAny('hueSpan', 330);
  vizBg.setFxAny('hueShift', 0);
  vizBg.setFxAny('satAdj', 0);
  vizBg.setFxAny('lightAdj', 0);
  vizBg.setFxAny('handL', FX_DEFAULT_COLORS.handL);
  vizBg.setFxAny('handR', FX_DEFAULT_COLORS.handR);
  vizBg.setFxAny('velLow', FX_DEFAULT_COLORS.velLow);
  vizBg.setFxAny('velHigh', FX_DEFAULT_COLORS.velHigh);
}
const fxThemeInput = ref('');        // 自定义主题名（D8：命名交给用户）
// 参数滑块的当前值（bg.fx 可能还没这批键 —— store 首次读写会补默认）
function fxNum(k) {
  const cur = bg.fx ? bg.fx[k] : undefined;
  return typeof cur === 'number' ? cur : FX_DEFAULTS[k];
}
function saveThemeAs() {
  const name = String(fxThemeInput.value || '').trim();
  if (!vizBg.saveTheme(name)) { app.toast(t('先给主题起个名字'), 'warn'); return; }
  app.toast(t('已存为主题：') + name);
  fxThemeInput.value = '';
}
// 模板里的 @input 是「先改 bg 再存」两步（颜色/模糊/暗化都直接改 reactive 字段），
// 所以保留一个薄壳；读写都在 store 里，导出页读到的是同一份。
function saveBg() { vizBg.save(); }
function setBgMode(m) { vizBg.setMode(m); }
function pickBgImage() { void vizBg.pickImage(); }
// 启动时把上次选过的图读回来（路径有效才用；图没了就退回主题，不留假图片档）
onMounted(() => { void vizBg.init(); });
// 沉浸模式下仪表盘那三张卡片没有意义，直接按瀑布流布局铺满
const isWaterfall = computed(() => mode.value === 'waterfall' || immersive.value);

/* 缓存失效就重新查一次：`isConnected === false` 说明这个节点已被 v-if 移除/重建。
   （只查已缓存的那一个 id；画布不存在时返回 null，调用方负责判空。） */
function pickCanvas(id, cached) {
  if (cached && cached.isConnected) return cached;
  return document.getElementById(id) || null;
}
function grabCanvases() {
  cvs.roll = pickCanvas('vizRoll', null);
  cvs.spec = pickCanvas('vizSpectrum', null);
  cvs.scope = pickCanvas('vizScope', null);
  cvs.chord = pickCanvas('vizChord', null);
}
// 切换「仪表盘 ↔ 音符瀑布」会重建节点：等 DOM 更新完再抓一次；tick 里另有兜底
watch(isWaterfall, () => { nextTick(() => { try { grabCanvases(); } catch (e) {} }); });

function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}

let raf = null;
// ★ 必须是**对象**而不是 null：grabCanvases() 是给字段赋值（cvs.roll = …），
//   声明成 null 会在 onMounted 里抛 TypeError，而 `raf = requestAnimationFrame(tick)`
//   就在它后面 —— 循环永远不启动，仪表盘与瀑布流**一起**全白（用户实测就是这个）。
let cvs = { roll: null, spec: null, scope: null, chord: null };
let spec = [];
// 帧间状态交给 core/viz.js 自己按需补齐字段（块、粒子、能量包络都在里面）
const rollState = {};
let tdBuf = null;

function clearCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 200, h = cv.clientHeight || 120;
  const W = Math.floor(w * dpr), H = Math.floor(h * dpr);
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function drawSpectrum(cv, syn) {
  const { ctx: ctx2d, w, h } = clearCanvas(cv);
  const a = syn.analyser;
  const freq = new Uint8Array(a.frequencyBinCount);
  a.getByteFrequencyData(freq);
  const bars = 72, binPer = a.frequencyBinCount / bars, bw = w / bars;
  const rowH = Math.max(2, Math.round(h / 44));
  const row = new Uint8Array(bars);
  for (let i = 0; i < bars; i++) {
    let v = 0;
    for (let k = Math.floor(i * binPer); k < Math.floor((i + 1) * binPer); k++) if (freq[k] > v) v = freq[k];
    row[i] = v;
  }
  spec.unshift(row);
  const maxRows = Math.floor(h / rowH);
  if (spec.length > maxRows) spec.length = maxRows;
  for (let r = 0; r < spec.length; r++) {
    const rr = spec[r];
    const y = r * rowH;
    const fade = 1 - (r / spec.length) * 0.55;
    for (let i = 0; i < bars; i++) {
      const v = rr[i] / 255;
      if (v < 0.05) continue;
      const hue = 210 + 40 * (i / bars);
      ctx2d.fillStyle = `hsla(${hue},85%,50%,${(0.2 + v * 0.8) * fade})`;
      ctx2d.fillRect(i * bw, y, bw, rowH);
    }
  }
  ctx2d.fillStyle = cssVar('--stone', 'rgba(10,10,10,0.4)'); ctx2d.font = '10px Consolas, monospace'; ctx2d.textAlign = 'right';
  ctx2d.fillText('20k', w - 6, h - 6); ctx2d.fillText('40', w - 6, h - 6 - Math.min(40, h / 3));
}

function drawScope(cv, syn) {
  const { ctx: ctx2d, w, h } = clearCanvas(cv);
  const a = syn.analyser;
  const td = new Uint8Array(a.fftSize);
  a.getByteTimeDomainData(td);
  ctx2d.strokeStyle = 'rgba(20,86,240,0.9)'; ctx2d.lineWidth = 1.6; ctx2d.beginPath();
  for (let i = 0; i < td.length; i++) {
    const x = i / td.length * w, y = h / 2 + (td[i] - 128) / 128 * (h / 2 - 6);
    i ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y);
  }
  ctx2d.stroke();
  ctx2d.strokeStyle = cssVar('--hairline', 'rgba(10,10,10,0.08)');
  ctx2d.beginPath(); ctx2d.moveTo(0, h / 2); ctx2d.lineTo(w, h / 2); ctx2d.stroke();
}

/* 没有音频引擎（syn 还没建起来 / AudioContext 被挂起）时的占位画面。
   ★ 为什么不干脆什么都不画：那看起来就是「功能坏了」（用户截图里四个白框）。
   这里画上「播放时显示…」，既说明组件是活的，也告诉用户它需要播放才有数据。 */
function drawIdle(cv, text) {
  const { ctx, w, h } = clearCanvas(cv);
  ctx.fillStyle = cssVar('--canvas', '#ffffff');
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = cssVar('--stone', 'rgba(10,10,10,.55)');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '11px "Microsoft YaHei", "Segoe UI", sans-serif';
  ctx.fillText(text, w / 2, h / 2);
}

function drawChord(cv, syn) {
  const { ctx: ctx2d, w, h } = clearCanvas(cv);
  const acts = syn.activeNow();
  const pcs = [...new Set(acts.map(x => ((x.midi % 12) + 12) % 12))].sort((a, b) => a - b);
  const KEY_NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  let chord = null;
  if (pcs.length >= 3) {
    let best = null;
    for (let r = 0; r < 12; r++) {
      for (const [mi, set] of [[0, [0, 4, 7]], [1, [0, 3, 7]]]) {
        let sc = 0;
        for (const d of set) if (pcs.includes((r + d) % 12)) sc++;
        if (!best || sc > best.sc) best = { r, mi, sc };
      }
    }
    if (best && best.sc >= 3) chord = { name: KEY_NAME[best.r] + (best.mi ? 'm' : ''), pcs };
  }
  const bgc = cssVar('--canvas', '#ffffff');
  const stone = cssVar('--stone', 'rgba(10,10,10,.55)');
  const slate = cssVar('--slate', 'rgba(10,10,10,.75)');
  ctx2d.fillStyle = bgc; ctx2d.fillRect(0, 0, w, h);
  ctx2d.textAlign = 'center'; ctx2d.textBaseline = 'middle';
  if (chord) {
    ctx2d.fillStyle = themeColor('--data-1', '#ff5530');
    ctx2d.font = '700 ' + Math.max(18, Math.round(h * 0.3)) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx2d.fillText(chord.name, w / 2, h * 0.34);
    ctx2d.fillStyle = stone;
    ctx2d.font = '10px Consolas, "Microsoft YaHei", sans-serif';
    ctx2d.fillText(chord.pcs.map(p => KEY_NAME[p]).join(' · '), w / 2, h * 0.62);
    ctx2d.fillStyle = stone;
    ctx2d.font = '10px "Microsoft YaHei", sans-serif';
    ctx2d.fillText(t('播放中'), w / 2, h * 0.8);
  } else if (pcs.length) {
    ctx2d.fillStyle = slate;
    ctx2d.font = '600 ' + Math.max(14, Math.round(h * 0.16)) + 'px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx2d.fillText(pcs.map(p => KEY_NAME[p]).join(' · '), w / 2, h * 0.4);
    ctx2d.fillStyle = stone;
    ctx2d.font = '10px "Microsoft YaHei", sans-serif';
    ctx2d.fillText(t('未形成完整三和弦'), w / 2, h * 0.68);
  } else {
    ctx2d.fillStyle = stone;
    ctx2d.font = '12px "Microsoft YaHei", sans-serif';
    ctx2d.fillText(t('播放时显示实时和弦'), w / 2, h * 0.45);
  }
}

function drawRoll(ctx2d, c, u, syn, song, player) {
  const tick = player && song ? player.currentTick() : 0;
  drawVizWaterfallPost(ctx2d, c, u, song, tick, {
    state: rollState,
    zoom: wfZoom.value,
    showLyrics: true,
    lyricAt: '',
    activeNotes: syn && syn.activeNow ? syn.activeNow() : [],
    energy: rollState.energy || 0,
    // 视效开关：与背景同源（stores/vizbg），导出页读同一份 —— 预览与成片才不会两幅画
    fx: vizBg.fxOpts(),
    theme: vizBg.vizTheme(),   // ★ 视觉主题（舞台/键面/材质）也走同一份设置
    // 背景只作用于音符瀑布（频谱/示波器/和弦仍是主题底）
    bg: vizBg.drawOpts(),
  });
}

// 音乐能量：取自 AnalyserNode 的字节波形，与视频导出侧（viz.rmsAt）是同一个度量，
// 只是那边的信号源是解码后的 PCM。包络平滑把值存回 rollState，供绘制读取。
function readEnergy(syn) {
  const a = syn && syn.analyser;
  if (!a) return 0;
  if (!tdBuf || tdBuf.length !== a.fftSize) tdBuf = new Uint8Array(a.fftSize);
  a.getByteTimeDomainData(tdBuf);
  return rmsFromBytes(tdBuf);
}

// 高刷屏 rAF 可达 300fps：频谱/瀑布限流到 ~60fps（视觉无差别，省 5 倍 FFT 与绘制）
const MIN_FRAME_MS = 15;
let lastPaint = 0;
let lastAudioTry = 0;   // 音频引擎未就绪时的重试节流
function tick(ts) {
  raf = requestAnimationFrame(tick);
  const now = ts || performance.now();
  if (now - lastPaint < MIN_FRAME_MS) return;
  lastPaint = now;
  const syn = getSynth();
  const song = currentSong.value && currentSong.value.song;
  const player = getPlayer();
  // ★ 这里**不能**再 `if (!syn || !song) return;`：频谱 / 示波器 / 实时和弦三块只需要
  //   AnalyserNode（syn），跟有没有 MIDI 谱面（song）无关。以前这一行把三块一起挡掉了 ——
  //   纯音频曲目、或刚启动还没解析谱面时，三块面板永远空白，连 drawChord 里那句
  //   「播放时显示实时和弦」的占位都不会画（用户截图里四个框全空就是这个）。
  //   音符瀑布（roll）才真正需要 song/pitches，它单独判。
  if (!syn) {
    // 音频引擎还没就绪：至少把三块面板画成占位，并**周期性重试** ensureAudio
    // （首次挂在启动早期、或 AudioContext 被浏览器挂起时都会走到这里）。
    cvs.roll = pickCanvas('vizRoll', cvs.roll);
    cvs.spec = pickCanvas('vizSpectrum', cvs.spec);
    cvs.scope = pickCanvas('vizScope', cvs.scope);
    cvs.chord = pickCanvas('vizChord', cvs.chord);
    if (cvs.spec && cvs.spec.clientWidth) drawIdle(cvs.spec, t('播放时显示频谱'));
    if (cvs.scope && cvs.scope.clientWidth) drawIdle(cvs.scope, t('播放时显示波形'));
    if (cvs.chord && cvs.chord.clientWidth) drawIdle(cvs.chord, t('播放时显示实时和弦'));
    if (now - lastAudioTry > 2000) { lastAudioTry = now; try { ensureAudio(); } catch (e) {} }
    return;
  }
  // ★ 画布引用必须**每次绘制前校验**：三块卡片画布位于 `v-if="!isWaterfall"` 内，
  //   而 `cvs` 原来只在 onMounted 取一次 —— 只要挂载时不是仪表盘模式（上次用的音符瀑布 /
  //   沉浸态），引用就是 null 且永远为 null；切回仪表盘时 Vue 会**重建 canvas 节点**，
  //   旧引用随即失效。此前直接读 `cvs.spec.clientWidth` 会抛 TypeError，而它在 tick 里、
  //   raf 已排好下一帧 ⇒ 每帧抛一次，连后面的音符瀑布都不画（用户报的「三块面板都不显示」）。
  cvs.roll = pickCanvas('vizRoll', cvs.roll);
  cvs.spec = pickCanvas('vizSpectrum', cvs.spec);
  cvs.scope = pickCanvas('vizScope', cvs.scope);
  cvs.chord = pickCanvas('vizChord', cvs.chord);
  rollState.energy = smoothEnergy(rollState.energy, readEnergy(syn));
  // 诊断钩子：CDP / 控制台读取当前音乐能量（只读用途，与 __fufumidiActivePlayer 同类）
  if (typeof window !== 'undefined') window.__fufumidiVizEnergy = rollState.energy;
  if (cvs.spec && cvs.spec.clientWidth) drawSpectrum(cvs.spec, syn);
  if (cvs.scope && cvs.scope.clientWidth) drawScope(cvs.scope, syn);
  if (cvs.chord && cvs.chord.clientWidth) drawChord(cvs.chord, syn);
  // 音符瀑布需要谱面数据；没有就跳过这一块（三块小面板不受影响）
  if (cvs.roll && cvs.roll.clientWidth && song) {
    const { ctx, w, h } = clearCanvas(cvs.roll);
    drawRoll(ctx, w, h, syn, song, player);
  }
}

/* ---------------- 沉浸模式 ---------------- */
// 进入时隐去顶栏 / 侧栏 / 播放栏，底部换成本页的 HUD 浮层；
// 退出时把这三处恢复成「进入之前的原样」（用户可能本来就关着侧栏）。
let barsSaved = null;

function setImmersive(on) {
  if (on === immersive.value) return;
  if (on && !currentSong.value) return; // 没载入曲目时无可渲染内容
  immersive.value = on;
  if (on) {
    barsSaved = { sidebar: app.sidebarOpen, playerbar: app.playerbarOpen };
    app.sidebarOpen = false;
    app.playerbarOpen = false;
    app.ui.immersive = true;
    // 沉浸标记打在 <html> 上：外壳（分组标签/侧栏/播放栏）与滚动条由 styles.css 统一收掉，
    // 组件内的 scoped 样式够不到这些兄弟节点。
    document.documentElement.classList.add('fu-immersive');
    // 原生标题栏在 web 内容之外，CSS 藏不掉 —— 只有窗口真全屏能收掉它。
    try { window.fuBridge?.setFullScreen?.(true); } catch (e) {}
    // 全屏切换会改窗口尺寸，而画布尺寸是"读一次 clientWidth/Height"算出来的：
    // 立刻 + 120ms + 600ms 各重算一次，把过渡期间的空档也覆盖掉（实测只算一次会留底边）。
    const remeasure = () => { try { grabCanvases(); window.dispatchEvent(new Event('resize')); } catch (e) {} };
    nextTick(remeasure);
    setTimeout(remeasure, 120);
    setTimeout(remeasure, 600);
    pokeHud();
    app.toast(t('控件 3 秒无操作后自动淡出，移动鼠标或按 I 退出'));
  } else {
    if (barsSaved) {
      app.sidebarOpen = barsSaved.sidebar;
      app.playerbarOpen = barsSaved.playerbar;
      barsSaved = null;
    }
    app.ui.immersive = false;
    const de = document.documentElement;
    de.classList.remove('fu-immersive');
    de.classList.remove('fu-cursor-hidden');
    try { window.fuBridge?.setFullScreen?.(false); } catch (e) {}
    if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
    hudOn.value = true;
  }
}
function toggleImmersive() { setImmersive(!immersive.value); }

// HUD 自动淡出：鼠标/按键一动就亮起来，静止 3 秒后隐去
const hudOn = ref(true);
let hudTimer = null;
function pokeHud() {
  hudOn.value = true;
  if (hudTimer) clearTimeout(hudTimer);
  hudTimer = setTimeout(() => { hudTimer = null; if (immersive.value) hudOn.value = false; }, 3000);
}

function onKey(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  const tg = e.target;
  if (tg && (/^(INPUT|TEXTAREA|SELECT)$/.test(tg.tagName) || tg.isContentEditable)) return;
  if (e.key === 'i' || e.key === 'I') { e.preventDefault(); toggleImmersive(); }
  else if (e.key === 'Escape' && immersive.value) { e.preventDefault(); setImmersive(false); }
}
function onPointerMove() { if (immersive.value) pokeHud(); }

/* 控件淡出时连**光标**一起藏（用户要求：按钮 / 进度条 / 光标都能完全隐藏）。
   光标藏不藏跟着 hudOn 走：动一下鼠标就回来，静止 3 秒后随控件一起消失。 */
watch([immersive, hudOn], ([im, on]) => {
  const de = document.documentElement;
  if (im && !on) de.classList.add('fu-cursor-hidden');
  else de.classList.remove('fu-cursor-hidden');
});

/* ---------------- HUD 进度条：拖动时显示本地值，不被播放头拉回 ---------------- */
const dragging = ref(false);
const dragVal = ref(0);
const hudProgress = computed(() => (dragging.value ? dragVal.value : app.progress));
function onSeekStart() { dragging.value = true; dragVal.value = app.progress; }
function onSeekInput(e) {
  const r = parseFloat(e.target.value);
  dragVal.value = r;
  app.seekRatio(r);
}
function onSeekEnd() { dragging.value = false; }

/* ---------------- 偏好持久化（与 fufumidi_fx / fufumidi_soundfont 同风格） ---------------- */
const LS_VIZ = 'fufumidi_viz';
function loadPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_VIZ) || 'null');
    if (!s) return;
    if (typeof s.zoom === 'number' && isFinite(s.zoom)) wfZoom.value = Math.min(3, Math.max(0.4, s.zoom));
    if (s.mode === 'dash' || s.mode === 'waterfall') mode.value = s.mode;
    if (s.fxPanelPos && typeof s.fxPanelPos.x === 'number' && typeof s.fxPanelPos.y === 'number') {
      fxPanelPos.value = { x: s.fxPanelPos.x, y: s.fxPanelPos.y };
    }
    if (s.fxPanelSize && typeof s.fxPanelSize.w === 'number' && s.fxPanelSize.w > 0) {
      fxPanelSize.value = { w: s.fxPanelSize.w, h: s.fxPanelSize.h || 0 };
    }
  } catch (e) {}
}
function savePrefs() {
  try {
    localStorage.setItem(LS_VIZ, JSON.stringify({
      zoom: wfZoom.value, mode: mode.value, fxPanelPos: fxPanelPos.value, fxPanelSize: fxPanelSize.value,
    }));
  } catch (e) {}
}
watch([wfZoom, mode], savePrefs);

/* 窗口尺寸变化（含进出全屏 / 拖窗 / 缩放）→ 必须重算画布。
   原先没有任何 resize 监听：画布尺寸只在挂载与切模式时读一次，
   全屏后就会沿用旧高度，底部留出一条。 */
function onWindowResize() {
  try { grabCanvases(); } catch (e) {}
  if (immersive.value) pokeHud();
}

onMounted(() => {
  loadPrefs();
  try { ensureAudio(); } catch (e) { /* 不支持 Web Audio 时仅渲染瀑布 */ }
  grabCanvases();
  window.addEventListener('keydown', onKey);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('resize', onWindowResize);
  raf = requestAnimationFrame(tick);
});
// KeepAlive 保活期间停掉循环：频谱/瀑布每帧都要算 FFT 与大量绘制，
// 离开本页后继续跑会明显拖慢整个应用
onActivated(() => { grabCanvases(); if (!raf) raf = requestAnimationFrame(tick); });
onDeactivated(() => { if (raf) { cancelAnimationFrame(raf); raf = null; } setImmersive(false); });
onBeforeUnmount(() => {
  onPanelUp();   // 摘掉可能还挂着的拖拽监听
  if (raf) cancelAnimationFrame(raf);
  raf = null;
  if (hudTimer) { clearTimeout(hudTimer); hudTimer = null; }
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('mousemove', onPointerMove);
  window.removeEventListener('resize', onWindowResize);
  setImmersive(false);
  spec = [];
});
</script>

<template>
  <div class="page viz-page" :class="{ 'waterfall': isWaterfall, immersive }">
    <div class="viz-col">
      <div class="viz-hero card">
        <div class="vc-head" :class="{ 'hud-hidden': immersive && !hudOn }">
          <span class="dot" style="background:var(--brand-coral)"></span><b>{{ t('音符瀑布') }}</b>
          <button class="chip-btn" :class="{ 'active': mode === 'dash' }" data-guide="viz-modes" @click="mode = 'dash'">{{ t('仪表盘') }}</button>
          <button class="chip-btn" :class="{ 'active': mode === 'waterfall' }" data-guide="viz-waterfall" @click="mode = 'waterfall'">{{ t('瀑布流') }}</button>
          <!-- 配色原本是工具栏上一个单独循环的 chip；用户要求「配色归入视效」——
               它本来就是视效的一部分（轨道色 / 按音高推导的两套 HSL），现在住进视效面板。 -->
          <!-- 背景：主题 / 纯色 / 图片 / 透明（叠加层）。SeeMusic 那类软件把"背景图 + 模糊"
               当成主要观感开关，这里补上；透明档配合导出即可当 OBS 叠加层。 -->
          <button class="chip-btn" :class="{ active: bgMore }" :title="t('音符瀑布背景（主题/纯色/图片/透明）')" @click="bgMore = !bgMore">
            <Icon name="eye" :size="12" />{{ t('背景') }}
          </button>
          <!-- 视效：3D 键盘 / 粒子光效 / 落键光柱 / 击键光带 / 音符质感。
               参考 SeeMusic、Synthesia、Lumiric Stage 那类瀑布流的语言：
               「灯、粒子、键的厚度」才是观感差异，而不是把音符块画得更大。 -->
          <button class="chip-btn" :class="{ active: fxPanel }" data-guide="viz-fx" :title="t('瀑布流视效（配色 / 3D 键盘 / 粒子 / 光柱 / 光带 / 质感）')" @click="toggleFxPanel">
            <Icon name="spark" :size="12" />{{ t('视效') }}
          </button>
          <span style="flex:1"></span>
          <button class="chip-btn" @click="wfZoom = Math.max(0.4, +(wfZoom - 0.1).toFixed(2))">−</button>
          <span class="vc-zoom">{{ Math.round(wfZoom * 100) }}%</span>
          <button class="chip-btn" @click="wfZoom = Math.min(3, +(wfZoom + 0.1).toFixed(2))">+</button>
          <button class="chip-btn" :disabled="!currentSong" data-guide="viz-immersive" :title="t('沉浸模式')" @click="toggleImmersive">
            <Icon name="expand" :size="13" />{{ t('沉浸模式') }}
          </button>
          <span class="muted small" style="margin-left:10px">{{ t('Synthesia · 播放同步') }}</span>
        </div>
        <!-- ★ 沉浸模式不显示这条：沉浸态的 .vc-head 是绝对定位浮层，设置条留在文档流里会与它重叠，
             而且浅色控件压在满屏画面上很突兀。退出沉浸后设置条原样回来。 -->
        <div v-if="bgMore && !immersive" class="viz-bg-bar">
          <span class="muted small">{{ t('音符瀑布背景') }}</span>
          <button class="chip-btn" :class="{ active: bg.mode === 'theme' }" @click="setBgMode('theme')">{{ t('主题') }}</button>
          <button class="chip-btn" :class="{ active: bg.mode === 'solid' }" @click="setBgMode('solid')">{{ t('纯色') }}</button>
          <input v-if="bg.mode === 'solid'" type="color" class="viz-bg-color" :value="bg.color" @input="bg.color = $event.target.value; saveBg()" />
          <button class="chip-btn" :class="{ active: bg.mode === 'image' }" @click="setBgMode('image')">{{ t('图片') }}</button>
          <button class="chip-btn" :title="t('选择背景图片') " @click="pickBgImage"><Icon name="folder" :size="12" />{{ t('选择…') }}</button>
          <button class="chip-btn" :class="{ active: bg.mode === 'transparent' }" :title="t('真·透明：导出的画面可当叠加层')" @click="setBgMode('transparent')">{{ t('透明') }}</button>
          <template v-if="bg.mode === 'image' || bg.mode === 'theme'">
            <span class="muted small">{{ t('模糊') }}</span>
            <NumSlider :model-value="bg.blur" @update:model-value="v => { bg.blur = +v; saveBg() }" :min="0" :max="40" :step="1" range-style="width:88px" :input-width="68" no-input />
            <span class="muted small">{{ t('暗化') }}</span>
            <NumSlider :model-value="Math.round(bg.dim * 100)" @update:model-value="v => { bg.dim = (+v) / 100; saveBg() }" :min="0" :max="80" :step="5" range-style="width:88px" :input-width="68" no-input />
          </template>
        </div>
        <!-- 视效面板内容（原来在文档流里，现在整体搬进上面的浮层）：
             ① 主题（含用户自定义主题的命名/删除）② 参数滑块 ③ 特效开关 ④ 取色/配色/调色
             ★ 所有值都住在 stores/vizbg，导出页读同一份 —— 预览与成片必须是一幅画。 -->
          <!-- ★ 视效面板：独立浮层 + 可拖动（2026-10-17）。
               放在文档流里会把画布挤矮，调参数时看不见效果；浮层化后画布保持满幅，
               面板可以拖到不挡视线的地方。拖动手柄**只有标题栏**，滑块/色块照常点。 -->
          <Teleport to="body">
            <div v-if="fxPanel" ref="fxPanelEl" class="fx-panel"
                 :style="{
                   left: fxPanelPos.x + 'px', top: fxPanelPos.y + 'px',
                   width: fxPanelSize.w ? fxPanelSize.w + 'px' : '', height: fxPanelSize.h ? fxPanelSize.h + 'px' : '',
                 }">
              <div class="fx-panel-head" :title="t('拖动标题移动面板')" @pointerdown="onPanelDown">
                <Icon name="spark" :size="13" />
                <b>{{ t('视效') }}</b>
                <span class="muted small">{{ t('拖动标题移动面板') }}</span>
                <span style="flex:1"></span>
                <button class="chip-btn" :title="t('复位位置')" @pointerdown.stop @click="resetPanelPos">{{ t('复位') }}</button>
                <button class="chip-btn" :title="t('关闭')" @pointerdown.stop @click="fxPanel = false">✕</button>
              </div>
              <div class="fx-panel-body">
          <div class="viz-bg-bar">
            <span class="muted small">{{ t('视效主题') }}</span>
            <!-- 内置主题 = 视觉主题（舞台/键面/音符材质/后处理整包换）；用户主题带 user 标记 -->
            <button v-for="th in vizBg.themeList()" :key="th.k" class="chip-btn"
                    :class="{ active: vizBg.themeName === th.k }" @click="vizBg.applyTheme(th.k)">{{ t(th.label) }}</button>
            <input class="viz-theme-input" v-model="fxThemeInput" :placeholder="t('新主题名')"
                   @keydown.enter="saveThemeAs" />
            <button class="chip-btn" :title="t('把当前参数存成自定义主题（名字你定）')" @click="saveThemeAs">
              <Icon name="save" :size="12" />{{ t('存为主题') }}
            </button>
            <button v-if="vizBg.userThemes[vizBg.themeName]" class="chip-btn"
                    :title="t('删除这个自定义主题')" @click="vizBg.deleteTheme(vizBg.themeName)">✕</button>
            <span style="flex:1"></span>
            <button class="chip-btn" :title="t('全部打开')" @click="vizBg.resetFx(true)">{{ t('全开') }}</button>
            <button class="chip-btn" :title="t('全部关掉（回到旧观感）')" @click="vizBg.resetFx(false)">{{ t('全关') }}</button>
          </div>
          <div class="viz-bg-bar">
            <span class="muted small">{{ t('视效参数') }}</span>
            <template v-for="p in vizBg.FX_PARAMS" :key="p.k">
              <span class="muted small">{{ t(p.label) }}</span>
              <NumSlider :model-value="fxNum(p.k)" @update:model-value="v2 => vizBg.setFxAny(p.k, +v2)"
                         :min="p.min" :max="p.max" :step="p.step" range-style="width:74px" :input-width="54" no-input />
            </template>
          </div>
          <div class="viz-bg-bar">
            <span class="muted small">{{ t('特效') }}</span>
            <button v-for="f in fxItems" :key="f.k" class="chip-btn"
                    :class="{ active: !!(bg.fx && bg.fx[f.k]) }" :title="t(f.hint)"
                    @click="vizBg.setFx(f.k, !(bg.fx && bg.fx[f.k]))">{{ t(f.label) }}</button>
            <span class="muted small" style="margin-left:6px">{{ t('取色') }}</span>
            <button v-for="m in COLOR_MODES" :key="m.k" class="chip-btn"
                    :class="{ active: colorMode === m.k }"
                    :title="t('色相从哪来')" @click="vizBg.setFxAny('colorMode', m.k)">{{ t(m.label) }}</button>
            <span class="muted small" style="margin-left:6px">{{ t('配色预设') }}</span>
            <button v-for="cp in COLOR_PRESETS" :key="cp.k" class="chip-btn"
                    :class="{ active: colorPreset === cp.k }"
                    :title="t('填一组色相参数，填完还能继续拖滑块')" @click="applyColorPreset(cp)">{{ t(cp.label) }}</button>
            <template v-if="colorMode === 'hand'">
              <span class="muted small" style="margin-left:6px">{{ t('左手') }}</span>
              <input type="color" class="viz-color" :value="fxColor('handL')" :aria-label="t('左手颜色')"
                     @input="vizBg.setFxAny('handL', $event.target.value)">
              <span class="muted small">{{ t('右手') }}</span>
              <input type="color" class="viz-color" :value="fxColor('handR')" :aria-label="t('右手颜色')"
                     @input="vizBg.setFxAny('handR', $event.target.value)">
            </template>
            <template v-else-if="colorMode === 'vel'">
              <span class="muted small" style="margin-left:6px">{{ t('弱') }}</span>
              <input type="color" class="viz-color" :value="fxColor('velLow')" :aria-label="t('弱力度颜色')"
                     @input="vizBg.setFxAny('velLow', $event.target.value)">
              <span class="muted small">{{ t('强') }}</span>
              <input type="color" class="viz-color" :value="fxColor('velHigh')" :aria-label="t('强力度颜色')"
                     @input="vizBg.setFxAny('velHigh', $event.target.value)">
            </template>
          </div>
          <div class="viz-bg-bar">
            <span class="muted small">{{ t('调色') }}</span>
            <template v-for="p in colorParams" :key="p.k">
              <span class="muted small">{{ t(p.label) }}</span>
              <NumSlider :model-value="fxNum(p.k)" @update:model-value="v2 => vizBg.setFxAny(p.k, +v2)"
                         :min="p.min" :max="p.max" :step="p.step" range-style="width:74px" :input-width="54" no-input />
            </template>
            <span style="flex:1"></span>
            <button class="chip-btn" :title="t('配色参数回到默认（取色方式=轨道色）')" @click="resetColors">{{ t('配色重置') }}</button>
          </div>
              </div>
            </div>
          </Teleport>
        <div class="vc-body" :class="{ 'bd-canvas': bg.mode === 'transparent' }">
          <!-- ★ 画布自己有一层 CSS 底色（.vc-body canvas 的 background）—— 透明档只 clearRect
               是没用的，元素底色照样透不出来。所以透明档必须把画布元素的底色也去掉，
               并由容器铺 --canvas（否则透出的是卡片那层半透明白，和沉浸态不一致）。 -->
          <canvas id="vizRoll" :class="{ 'cv-transparent': bg.mode === 'transparent' }"></canvas>
          <div v-if="immersive" class="viz-hud" :class="{ 'hud-hidden': !hudOn }">
            <button class="hud-btn" :title="app.playing ? t('暂停') : t('播放')" @click="app.togglePlay()">
              <Icon :name="app.playing ? 'pause' : 'play'" :size="18" />
            </button>
            <span class="hud-time">{{ app.curStr }} / {{ app.totalStr }}</span>
            <input class="hud-seek" type="range" min="0" max="1" step="0.0001" :aria-label="t('播放进度')"
                   :value="hudProgress" @pointerdown="onSeekStart" @pointerup="onSeekEnd"
                   @pointercancel="onSeekEnd" @input="onSeekInput">
            <button class="hud-btn" :title="t('视效面板')" @click="toggleFxPanel"><Icon name="spark" :size="14" /></button>
            <span class="hud-name">{{ currentSong?.name || '' }}</span>
            <button class="hud-btn hud-exit" :title="t('退出沉浸模式（Esc）')" @click="setImmersive(false)">
              <Icon name="close" :size="14" />{{ t('退出') }}
            </button>
          </div>
        </div>
      </div>

      <div class="viz-grid" v-if="!isWaterfall">
        <div class="viz-card card">
          <div class="vc-head"><span class="dot" style="background:var(--brand-blue)"></span><b>{{ t('频谱瀑布') }}</b><span class="muted small" style="margin-left:auto">{{ t('竖直下落') }}</span></div>
          <div class="vc-body"><canvas id="vizSpectrum"></canvas></div>
        </div>
        <div class="viz-card card">
          <div class="vc-head"><span class="dot" style="background:var(--brand-purple)"></span><b>{{ t('波形示波器') }}</b><span class="muted small" style="margin-left:auto">{{ t('时域') }}</span></div>
          <div class="vc-body"><canvas id="vizScope"></canvas></div>
        </div>
        <div class="viz-card card">
          <div class="vc-head"><span class="dot" style="background:var(--brand-magenta)"></span><b>{{ t('实时和弦') }}</b><span class="muted small" style="margin-left:auto">{{ t('播放同步') }}</span></div>
          <div class="vc-body"><canvas id="vizChord"></canvas></div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.viz-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.viz-col { display: flex; flex-direction: column; gap: var(--sp-4); height: 100%; min-height: 0; }
.viz-hero { display: flex; flex-direction: column; min-height: 0; position: relative; }
.viz-hero .vc-body { height: 46vh; min-height: 260px; position: relative; }
/* 卡片列用 minmax(0,1fr)：canvas 的内在宽度（300px）会把纯 1fr 撑破并横向裁切 */
.viz-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-4); }
.viz-card { min-width: 0; }
.viz-card .vc-body { height: clamp(140px, 20vh, 220px); }
@media (max-width: 1024px) { .viz-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 720px) { .viz-grid { grid-template-columns: minmax(0, 1fr); } }
.vc-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: 10px; font-size: var(--fs-md); font-weight: 600; color: var(--ink); flex-wrap: wrap; }
.vc-head b { letter-spacing: -0.2px; }
.vc-head .vc-zoom { font-size: var(--fs-xs); min-width: 44px; text-align: center; font-weight: 500; }
.vc-body canvas { width: 100%; height: 100%; display: block; border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--canvas); }
.chip-btn.active { background: var(--accent); color: var(--on-accent); }
/* 背景设置条：低调的一行，不抢画面 */
.viz-bg-bar { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; padding: 6px 12px 8px; font-size: var(--fs-sm);
              border-bottom: 1px solid var(--hairline); margin-bottom: 2px; }
.viz-bg-bar input[type=range] { accent-color: var(--accent); }
.viz-theme-input {
  width: 108px; height: 24px; padding: 0 8px; font-size: var(--fs-sm);
  border: 1px solid var(--hairline); border-radius: var(--r-sm);
  background: var(--surface); color: var(--ink);
}
.viz-bg-color { width: 28px; height: 22px; padding: 0; border: 1px solid var(--border); border-radius: var(--r-sm); background: transparent; }
.viz-page.waterfall .viz-grid { display: none; }
.viz-page.waterfall .viz-hero { flex: 1; }
/* 全屏瀑布流：不写死 vh 魔法数，直接吃掉剩余高度（窗口变化时自适应） */
.viz-page.waterfall .viz-hero .vc-body { flex: 1; height: auto; min-height: 300px; }

/* ---- 沉浸模式：去掉卡片壳，画面铺满主区，控件浮在画面上并自动淡出 ---- */
/* ★ 沉浸态的底色必须与非沉浸的透明档**完全一致**（用户实测：两边背景不一样）。
   统一用 --canvas：非沉浸那边由 .vc-body.bd-canvas 铺同色，两边看起来才是同一个背景。
   HUD 的可读性靠它自己的深色渐变 + 深色 chip 解决，不靠整块改底色。 */
/* ★ fixed + inset:0：实测旧写法在沉浸态下画面**下移 61px（顶栏高度）、右侧留 10px（滚动条槽）**——
   只写 padding:0/max-width:none 管不到父容器的内边距与滚动条。铺满由这里保证，不靠外层。 */
.viz-page.immersive { position: fixed; inset: 0; z-index: 30; padding: 0; max-width: none; background: var(--canvas); }
.viz-page.immersive .viz-hero {
  border: 0; border-radius: 0; background: transparent; box-shadow: none; padding: 0;
}
.vc-body canvas.cv-transparent { background: transparent; }
.vc-body.bd-canvas { background: var(--canvas); }
.viz-page.immersive .vc-body canvas { border: 0; border-radius: 0; }
/* ★ 高度链必须显式到底：.vc-body 靠 flex:1 撑，而 .viz-col/.viz-hero 若没有 100%，
   全屏切换（窗口从 1268×785 变 1536×960）时会把画布留出一条底边（用户实测反馈「底部有一点没挡住」）。
   这里把整条链钉死，并让画布 block 化、去掉任何边框/圆角带来的 1~2px 误差。 */
.viz-page.immersive,
.viz-page.immersive .viz-col,
.viz-page.immersive .viz-hero { height: 100%; }
.viz-page.immersive .viz-hero { display: flex; flex-direction: column; }
.viz-page.immersive .vc-body { flex: 1 1 auto; min-height: 0; height: auto; }
.viz-page.immersive .vc-body canvas { display: block; width: 100%; height: 100%; }
.viz-page.immersive .vc-head {
  position: absolute; top: 0; left: 0; right: 0; z-index: 3;
  margin: 0; padding: 8px 14px;
  background: linear-gradient(to bottom, rgba(0, 0, 0, .5), rgba(0, 0, 0, 0));
  color: var(--on-accent);
  transition: opacity var(--motion-slow) var(--ease-out);
}
/* 沉浸态的控件压在画面之上：统一改成白色系，深浅主题下都能读 */
/* 沉浸态底色可能是浅色（--canvas）：chip 用**深色半透明** + 白字，浅底深底都读得清 */
.viz-page.immersive .vc-head .chip-btn {
  background: rgba(0, 0, 0, .45);
  border-color: rgba(255, 255, 255, .22);
  color: var(--on-accent);
}
.viz-page.immersive .vc-head .chip-btn:hover { background: rgba(0, 0, 0, .62); }
.viz-page.immersive .vc-head .chip-btn.active { background: var(--btn-bg); color: var(--btn-fg);   /* 反相实心：深色档下原来写死近黑，等于看不清 */ }
.viz-page.immersive .vc-head .muted,
.viz-page.immersive .vc-head .vc-zoom { color: rgba(255, 255, 255, .82); }

.viz-hud {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 3;
  display: flex; align-items: center; gap: var(--sp-3);
  padding: 10px 16px;
  background: linear-gradient(to top, rgba(0, 0, 0, .52), rgba(0, 0, 0, 0));
  color: var(--on-accent);
  transition: opacity var(--motion-slow) var(--ease-out);
}
.hud-btn {
  display: inline-flex; align-items: center; gap: var(--sp-2);
  flex: none;
  padding: 7px 12px; border: 1px solid rgba(255, 255, 255, .24);
  border-radius: var(--r-pill);
  background: rgba(255, 255, 255, .16); color: var(--on-accent);
  font-size: var(--fs-md); font-weight: 600; cursor: pointer;
}
.hud-btn:hover { background: rgba(255, 255, 255, .28); }
.hud-time { flex: none; font-size: var(--fs-sm); font-variant-numeric: tabular-nums; opacity: .92; }
.hud-name { flex: none; max-width: 32%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-md); font-weight: 600; opacity: .92; }
.hud-seek { flex: 1; min-width: 0; accent-color: var(--on-accent); }
.hud-exit { margin-left: auto; }
/* 静止后整层隐去：只留画面 */
.hud-hidden { opacity: 0; pointer-events: none; }

/* ---------------- 视效面板（浮层 + 可拖动） ----------------
   Teleport 到 body，所以这里不能用祖先选择器定位；靠 position:fixed + 高 z-index。
   玻璃质感：半透明底 + 背景模糊，压在画面上也能看清下面的音符。 */
.fx-panel {
  position: fixed;
  z-index: 4200;
  /* 默认窄一些：面板是浮层，宽了会挡住画面（用户反馈「面板太宽了」）。
     需要更宽可以拖右下角 —— resize:both 给了原生缩放手柄，尺寸会记住。 */
  width: min(560px, 92vw);
  min-width: 330px;
  max-width: 96vw;
  max-height: 86vh;
  resize: both;
  overflow: auto;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--card) 90%, transparent);
  backdrop-filter: blur(12px) saturate(1.08);   /* 玻璃感：面板压着画面时仍然能看出下面的音符 */
  box-shadow: 0 18px 50px rgba(0, 0, 0, .45);
  color: var(--ink);
}
.fx-panel-head {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 8px 10px;
  border-bottom: 1px solid var(--line);
  cursor: move;
  user-select: none;
  touch-action: none;          /* 拖动时不要触发页面滚动/手势 */
  position: sticky; top: 0;
  background: inherit;
  border-radius: var(--r-md) var(--r-md) 0 0;
}
.fx-panel-head b { font-size: var(--fs-md); }
.fx-panel-head .chip-btn { cursor: pointer; }
.fx-panel-body { display: flex; flex-direction: column; padding-bottom: 6px; }
/* 面板里的控件比工具条里更紧凑：窄面板下换行次数少一半 */
.fx-panel-body .viz-bg-bar { padding: 5px 10px 6px; gap: var(--sp-2); }
.fx-panel-body .chip-btn { padding: 3px 8px; font-size: var(--fs-sm); }
.fx-panel-body :deep(.muted.small) { font-size: var(--fs-xs); }
.fx-panel-body .viz-bg-bar { border-radius: 0; }
@media (max-width: 720px) {
  .hud-name { display: none; }
}
</style>
