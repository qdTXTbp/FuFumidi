<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, onActivated, onDeactivated, nextTick } from 'vue';
import { useAppStore } from '../stores/app';
import { KEY_NAME, noteName } from '../core/util.js';

const app = useAppStore();
const state = app;
const currentSong = computed(() => app.currentSong);

const wrap = ref(null);
const canvas = ref(null);
let ctx2d = null;
let raf = null;

// 绘制范围（音高区间，随内容自适应）
let loNote = 21, hiNote = 108;

function computeRange() {
  const song = currentSong.value && currentSong.value.song;
  if (!song) { loNote = 21; hiNote = 108; return; }
  let lo = 108, hi = 21;
  for (const tr of song.tracks) for (const n of tr.notes) { if (n.midi < lo) lo = n.midi; if (n.midi > hi) hi = n.midi; }
  loNote = Math.max(0, lo - 3);
  hiNote = Math.min(127, hi + 3);
}
function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}

/* 主题颜色令牌缓存：按主题一次性解析，主题切换由 applyTheme 写 documentElement
   内联样式触发 MutationObserver 失效。原先每帧 ~16 次 getComputedStyle。 */
const TRACK_FALLBACK = ['#3b82f6', '#14b8a6', '#22c55e', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899'];
let _pal = null;
function palette() {
  if (_pal) return _pal;
  const brandColors = [];
  for (let i = 1; i <= 8; i++) brandColors.push(cssVar('--track-' + i, TRACK_FALLBACK[i - 1]));
  _pal = {
    canvas: cssVar('--canvas', '#ffffff'),
    surface: cssVar('--surface', '#f7f8fa'),
    hair: cssVar('--hairline', 'rgba(10,10,10,.1)'),
    border2: cssVar('--border-strong', 'rgba(10,10,10,.18)'),
    rowAlt: cssVar('--row-alt', 'rgba(10,10,10,0.028)'),
    playhead: cssVar('--playhead', '#ff5530'),
    playheadSoft: cssVar('--playhead-soft', 'rgba(255,85,48,0.08)'),
    stone: cssVar('--stone', 'rgba(10,10,10,0.45)'),
    brandColors,
  };
  return _pal;
}
function invalidatePalette() { _pal = null; }

function draw() {
  const cv = canvas.value, w = wrap.value;
  if (!cv || !w) return;
  const dpr = window.devicePixelRatio || 1;
  const W = w.clientWidth;
  // 高度取容器实测值（styles.css 用 clamp 控制），回退 320px；不再写死
  const H = Math.max(120, Math.round(w.clientHeight || 320));
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, W, H);

  // 背景（跟随主题）
  const pal = palette();
  const g = ctx2d.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, pal.canvas); g.addColorStop(1, pal.surface);
  ctx2d.fillStyle = g; ctx2d.fillRect(0, 0, W, H);

  const song = currentSong.value && currentSong.value.song;
  if (!song || !song.totalTicks) return;

  const rowH = H / (hiNote - loNote + 1);
  const tW = Math.max(W, 12);

  // 键盘背景（黑键）
  const isBlack = m => { const p = m % 12; return [1, 3, 6, 8, 10].includes(p); };
  const rowAlt = pal.rowAlt;
  for (let m = loNote; m <= hiNote; m++) {
    if (!isBlack(m)) continue;
    const y = (hiNote - m) * rowH;
    ctx2d.fillStyle = rowAlt;
    ctx2d.fillRect(0, y, W, rowH);
  }
  // 网格线（随主题）
  ctx2d.strokeStyle = pal.hair;
  ctx2d.lineWidth = 1;
  const tpb = song.tpb, beatPx = tW / song.totalTicks * tpb;
  for (let b = 0; b * beatPx < W; b++) {
    const x = b * beatPx;
    ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, H);
    ctx2d.strokeStyle = b % 4 === 0 ? pal.border2 : pal.hair;
    ctx2d.stroke();
  }

  // 音符（MiniMax 品牌色编码）
  const curTick = song.secToTick(state.curSec / state.tempo);
  const viewStart = Math.max(0, curTick - song.totalTicks * 0.15);
  const viewEnd = viewStart + song.totalTicks * 0.6;
  const xOf = tick => (tick - viewStart) / (viewEnd - viewStart) * W;

  const brandColors = pal.brandColors;
  // 大文件裁剪：notes 按 start 升序，只遍历视口附近区间（前/后各留一个视口宽），避免每帧全量扫描
  const winTic = viewEnd - viewStart;
  for (const tr of song.tracks) {
    const color = brandColors[tr.index % brandColors.length];
    const ns = tr.notes;
    if (!ns.length) continue;
    // 上界二分：第一个 start > viewEnd 的下标。此前这里写成 `let hi2 = 0, lo2 = ns.length`
    // 配 `while (lo2 < hi2)`，条件一开始就不成立、循环一次都不执行，up 恒等于数组长度 ——
    // 于是「只遍历视口附近区间」的裁剪完全失效，每帧从视口左界一路扫到全曲末尾。
    let uLo = 0, uHi = ns.length;
    while (uLo < uHi) { const m = (uLo + uHi) >> 1; if (ns[m].start <= viewEnd) uLo = m + 1; else uHi = m; }
    const up = uLo;
    let a2 = 0, b2 = up, t0lo = viewStart - winTic;
    while (a2 < b2) { const m = (a2 + b2) >> 1; if (ns[m].start < t0lo) a2 = m + 1; else b2 = m; }
    const alpha = 0.9;
    for (let k = a2; k < up; k++) {
      const n = ns[k];
      if (n.end < viewStart || n.start > viewEnd) continue;
      const x = xOf(n.start), w2 = Math.max(2, xOf(n.end) - x);
      const y = (hiNote - n.midi) * rowH;
      ctx2d.fillStyle = color;
      ctx2d.globalAlpha = alpha * 0.35;
      ctx2d.fillRect(x, y + 1, w2, rowH - 2);
      ctx2d.globalAlpha = alpha;
      const borderH = Math.min(4, rowH * 0.5);
      ctx2d.fillRect(x, y + 1, w2, borderH);
    }
  }
  ctx2d.globalAlpha = 1;

  // 播放头（主题令牌：默认与卷帘一致的 coral）
  const px = xOf(curTick);
  const pg = ctx2d.createLinearGradient(0, 0, 0, H);
  pg.addColorStop(0, pal.playhead);
  pg.addColorStop(1, pal.playheadSoft);
  ctx2d.fillStyle = pg;
  ctx2d.fillRect(px - 1, 0, 2.5, H);
  ctx2d.fillStyle = pal.playhead;
  ctx2d.fillRect(px - 4, 0, 8, 3);

  // 音名标签（最左）
  ctx2d.font = '10px monospace';
  ctx2d.textAlign = 'left';
  const labelColor = pal.stone;
  for (let m = loNote; m <= hiNote; m += 12) {
    const y = (hiNote - m) * rowH;
    ctx2d.fillStyle = labelColor;
    ctx2d.fillText(noteName(m), 5, y + rowH - 3);
  }
}

// 绘制循环改为「按需重绘」：只有内容变化（dirty）或正在播放时才画。
// 原实现无条件每帧全量重画「全曲概览」（大 MIDI 下每帧约 1.1 万+ 音符 × 2 次 fillRect），
// 且本组件位于 <KeepAlive> 内，离开演奏页后仍在满帧烧 CPU —— 全应用卡顿的主因。
let dirty = true;
let active = true;
// 可见性：KeepAlive 把被缓存的子树移入 0×0 隐藏容器（v-show 隐藏同理），尺寸归零。
// onDeactivated 只对被缓存组件的「根」触发，嵌套组件收不到 —— 用尺寸变化判定可见性，
// 隐藏时 loop 空转，不再满帧重画全曲概览。
let visible = false;
// 高刷屏 rAF 可达 300fps：播放头连续重绘限流到 ~60fps，省掉 5 倍无谓绘制
const MIN_FRAME_MS = 15;
let lastPaint = 0;
function markDirty() { dirty = true; }
function loop(ts) {
  const now = ts || performance.now();
  if (visible && (dirty || state.playing) && (dirty || now - lastPaint >= MIN_FRAME_MS)) {
    dirty = false; lastPaint = now; draw();
  }
  raf = requestAnimationFrame(loop);
}
function startLoop() { if (!raf) raf = requestAnimationFrame(loop); }
function stopLoop() { if (raf) { cancelAnimationFrame(raf); raf = null; } }

function onResize() { markDirty(); draw(); }

watch(() => state.view, v => { if (v === 'music') { markDirty(); draw(); } });
// 暂停时拖动进度条 / 定位：播放头位置变了也要重画
watch(() => state.curSec, () => { if (!state.playing) markDirty(); });

let ro = null;
let palObs = null;
onMounted(async () => {
  await nextTick();
  ctx2d = canvas.value.getContext('2d');
  computeRange();
  window.addEventListener('resize', onResize);
  // 容器尺寸变化（窗口缩放 / 播放栏收起）时重算高度重绘
  if (typeof ResizeObserver !== 'undefined' && wrap.value) {
    const syncVisible = () => {
      const v = wrap.value ? (wrap.value.clientWidth > 0 && wrap.value.clientHeight > 0) : false;
      if (v !== visible) { visible = v; markDirty(); }
    };
    syncVisible();
    ro = new ResizeObserver(() => { markDirty(); syncVisible(); draw(); });
    ro.observe(wrap.value);
  }
  if (typeof MutationObserver !== 'undefined') {
    palObs = new MutationObserver(() => { invalidatePalette(); markDirty(); });
    palObs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
  }
  startLoop();
});
onActivated(() => { active = true; markDirty(); startLoop(); });
onDeactivated(() => { active = false; stopLoop(); });
onBeforeUnmount(() => {
  active = false;
  stopLoop();
  window.removeEventListener('resize', onResize);
  if (ro) { ro.disconnect(); ro = null; }
  if (palObs) { palObs.disconnect(); palObs = null; }
});

watch(() => currentSong.value, () => { computeRange(); markDirty(); draw(); });
</script>

<template>
  <div class="pianoroll-wrap" ref="wrap">
    <canvas ref="canvas"></canvas>
  </div>
</template>
