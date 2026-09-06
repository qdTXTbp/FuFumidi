<script setup>
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
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

function draw() {
  const cv = canvas.value, w = wrap.value;
  if (!cv || !w) return;
  const dpr = window.devicePixelRatio || 1;
  const W = w.clientWidth, H = 320;
  if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
    cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
  }
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, W, H);

  // 背景（跟随主题）
  const bgTop = cssVar('--canvas', '#ffffff');
  const bgBottom = cssVar('--surface', '#f7f8fa');
  const hair = cssVar('--hairline', 'rgba(10,10,10,.1)');
  const border2 = cssVar('--border-strong', 'rgba(10,10,10,.18)');
  const g = ctx2d.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, bgTop); g.addColorStop(1, bgBottom);
  ctx2d.fillStyle = g; ctx2d.fillRect(0, 0, W, H);

  const song = currentSong.value && currentSong.value.song;
  if (!song || !song.totalTicks) return;

  const rowH = H / (hiNote - loNote + 1);
  const tW = Math.max(W, 12);

  // 键盘背景（黑键）
  const isBlack = m => { const p = m % 12; return [1, 3, 6, 8, 10].includes(p); };
  for (let m = loNote; m <= hiNote; m++) {
    if (!isBlack(m)) continue;
    const y = (hiNote - m) * rowH;
    ctx2d.fillStyle = 'rgba(10,10,10,0.028)';
    ctx2d.fillRect(0, y, W, rowH);
  }
  // 网格线（随主题）
  ctx2d.strokeStyle = hair;
  ctx2d.lineWidth = 1;
  const tpb = song.tpb, beatPx = tW / song.totalTicks * tpb;
  for (let b = 0; b * beatPx < W; b++) {
    const x = b * beatPx;
    ctx2d.beginPath(); ctx2d.moveTo(x, 0); ctx2d.lineTo(x, H);
    ctx2d.strokeStyle = b % 4 === 0 ? border2 : hair;
    ctx2d.stroke();
  }

  // 音符（MiniMax 品牌色编码）
  const scale = W / song.totalTicks;
  const curTick = song.secToTick(state.curSec / state.tempo);
  const viewStart = Math.max(0, curTick - song.totalTicks * 0.15);
  const viewEnd = viewStart + song.totalTicks * 0.6;
  const xOf = tick => (tick - viewStart) / (viewEnd - viewStart) * W;

  const brandColors = ['#ff5530', '#ea5ec1', '#1456f0', '#a855f7', '#3daeff', '#1ba673', '#3b82f6', '#f59e0b', '#d45656', '#17437d'];
  // 大文件裁剪：notes 按 start 升序，只遍历视口附近区间（前/后各留一个视口宽），避免每帧全量扫描
  const winTic = viewEnd - viewStart;
  for (const tr of song.tracks) {
    const color = tr.index < 10 ? brandColors[tr.index] : '#8e8e93';
    const ns = tr.notes;
    if (!ns.length) continue;
    let hi2 = 0, lo2 = ns.length;
    while (lo2 < hi2) { const m = (lo2 + hi2) >> 1; if (ns[m].start <= viewEnd) lo2 = m + 1; else hi2 = m; }
    const up = lo2;
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
      ctx2d.fillStyle = color + 'e6';
      const borderH = Math.min(4, rowH * 0.5);
      ctx2d.fillRect(x, y + 1, w2, borderH);
    }
  }
  ctx2d.globalAlpha = 1;

  // 播放头（品牌 coral）
  const px = xOf(curTick);
  const pg = ctx2d.createLinearGradient(0, 0, 0, H);
  pg.addColorStop(0, 'rgba(255,85,48,0.45)'); pg.addColorStop(1, 'rgba(255,85,48,0.08)');
  ctx2d.fillStyle = pg;
  ctx2d.fillRect(px - 1, 0, 2.5, H);
  ctx2d.fillStyle = '#ff5530';
  ctx2d.fillRect(px - 4, 0, 8, 3);

  // 音名标签（最左）
  ctx2d.font = '10px monospace';
  ctx2d.textAlign = 'left';
  for (let m = loNote; m <= hiNote; m += 12) {
    const y = (hiNote - m) * rowH;
    ctx2d.fillStyle = 'rgba(10,10,10,0.45)';
    ctx2d.fillText(noteName(m), 5, y + rowH - 3);
  }
}

function loop() { draw(); raf = requestAnimationFrame(loop); }

function onResize() { draw(); }

watch(() => state.view, v => { if (v === 'music') draw(); });

onMounted(async () => {
  await nextTick();
  ctx2d = canvas.value.getContext('2d');
  computeRange();
  window.addEventListener('resize', onResize);
  raf = requestAnimationFrame(loop);
});
onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  window.removeEventListener('resize', onResize);
});

watch(() => currentSong.value, () => { computeRange(); draw(); });
</script>

<template>
  <div class="pianoroll-wrap" ref="wrap">
    <canvas ref="canvas" style="height:320px"></canvas>
  </div>
</template>
