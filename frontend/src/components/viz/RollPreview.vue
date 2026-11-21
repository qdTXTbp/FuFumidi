<script setup>
/* ============================================================
   RollPreview.vue —— 「卷帘」页签（独立板块）
   ============================================================
   直接参照 CodePen《midi可视化》(Vencent-Bill / xbGayxZ) 的实现：
     · DOM 音符条（不是画布）：position:absolute，left/width 按 px/s，top 按 (127-midi)×行距
     · 自带一套走带：开始 / 暂停 / 重置 / 重新播放（不依赖播放栏）
     · BPM 可选覆盖：倍率 = 覆盖BPM / 曲目BPM，只影响这块预览的快慢
     · 横向 20–300 px/s、纵向 2–20 px、最短高亮 0.01–2s
   与参考稿的差异只有两处（都是为了嵌进应用）：
     ① 音符数据来自当前曲目，不再选择 .mid 文件（导入本来就有专门入口）；
     ② 颜色走主题变量（--text3 / --text），深浅主题自动跟随。
   ============================================================ */
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useAppStore } from '../../stores/app';
import { t } from '../../core/i18n.js';
import {
  ROLL_LIMITS, collectNotes, durationOf, rollWidth, rollHeight,
  noteRect, isNoteActive, followScroll, centerScrollTop, tempoFactorOf,
} from '../../core/roll_preview.js';

const props = defineProps({ page: { type: Boolean, default: false } });
const app = useAppStore();

/* ---------------- 参数（默认值与参考稿一致） ---------------- */
const pxPerSec = ref(ROLL_LIMITS.pxPerSec.def);
const rowPx = ref(ROLL_LIMITS.rowPx.def);
const minHighlight = ref(ROLL_LIMITS.minHighlight.def);
const bpmInput = ref('');
const customBpm = ref(0);

const wrapEl = ref(null);
const playheadEl = ref(null);

/* ---------------- 数据 ---------------- */
const notes = computed(() => collectNotes(app.currentSong));
const originalBpm = computed(() => {
  const v = Number(app.currentSong && app.currentSong.initialBpm);
  return v > 0 ? v : 120; // 与参考稿 `tempos[0]?.bpm || 120` 一致
});
const tempoFactor = computed(() => tempoFactorOf(originalBpm.value, customBpm.value));
const totalDuration = computed(() => durationOf(notes.value));
const totalWidth = computed(() => rollWidth(notes.value, pxPerSec.value));
const contentH = computed(() => rollHeight(rowPx.value));

/* 每个音符只算一次几何；样式串在 computed 里拼好，避免模板里重复计算 */
const layout = computed(() => notes.value.map((n) => {
  const r = noteRect(n, { pxPerSec: pxPerSec.value, rowPx: rowPx.value });
  return { n, style: `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px` };
}));

/* ---------------- 走带（参考稿的四个按钮） ---------------- */
const hasStarted = ref(false);
const paused = ref(false);
const playbackTime = ref(0);

let animStart = 0;
let raf = 0;
let ended = false;
let els = []; // [{ el, n, on }] —— 逐帧直接改 class，不走 Vue 响应式

function rebuildEls() {
  els = [];
  const wrap = wrapEl.value;
  if (!wrap) return;
  const nodes = wrap.querySelectorAll('.roll-note');
  const list = notes.value;
  for (let i = 0; i < nodes.length && i < list.length; i++) {
    els.push({ el: nodes[i], n: list[i], on: false });
  }
}

function clearActive() {
  for (const it of els) {
    if (it.on) { it.on = false; it.el.classList.remove('active'); }
  }
}

function setPlayhead(sec) {
  if (playheadEl.value) playheadEl.value.style.transform = `translateX(${sec * pxPerSec.value}px)`;
}

function tick(ts) {
  if (paused.value) return;
  if (!animStart) animStart = ts;
  const now = (ts - animStart) / 1000 * tempoFactor.value; // 秒（曲目时间）
  playbackTime.value = now;
  setPlayhead(now);

  const wrap = wrapEl.value;
  if (wrap) wrap.scrollLeft = followScroll(now * pxPerSec.value, wrap.clientWidth, totalWidth.value);

  for (const it of els) {
    const on = isNoteActive(now, it.n, minHighlight.value);
    if (on !== it.on) { it.on = on; it.el.classList.toggle('active', on); }
  }

  if (now < totalDuration.value) {
    raf = requestAnimationFrame(tick);
  } else if (!ended) {
    ended = true;
    paused.value = true; // 停在末尾，按钮回到「暂停/继续」的初始语义
  }
}

function stopLoop() {
  if (raf) { cancelAnimationFrame(raf); raf = 0; }
}

function start() {
  if (!notes.value.length || hasStarted.value) return;
  hasStarted.value = true;
  paused.value = false;
  ended = false;
  animStart = 0;
  playbackTime.value = 0;
  setPlayhead(0);
  stopLoop();
  raf = requestAnimationFrame(tick);
}

function togglePause() {
  if (!hasStarted.value) return;
  paused.value = !paused.value;
  if (paused.value) stopLoop();
  else {
    // 从暂停点续跑：把起算点回拨已播放的时长（参考稿同写法）
    animStart = performance.now() - playbackTime.value / tempoFactor.value * 1000;
    stopLoop();
    raf = requestAnimationFrame(tick);
  }
}

function reset() {
  stopLoop();
  hasStarted.value = false;
  paused.value = false;
  ended = false;
  animStart = 0;
  playbackTime.value = 0;
  bpmInput.value = '';
  customBpm.value = 0;
  pxPerSec.value = ROLL_LIMITS.pxPerSec.def;
  rowPx.value = ROLL_LIMITS.rowPx.def;
  minHighlight.value = ROLL_LIMITS.minHighlight.def;
  clearActive();
  setPlayhead(0);
  if (wrapEl.value) { wrapEl.value.scrollLeft = 0; centerVertical(); }
}

function replay() {
  if (!notes.value.length) return;
  stopLoop();
  hasStarted.value = true;
  paused.value = false;
  ended = false;
  animStart = 0;
  playbackTime.value = 0;
  clearActive();
  setPlayhead(0);
  raf = requestAnimationFrame(tick);
}

function applyBpm() {
  const v = parseFloat(bpmInput.value);
  if (!Number.isFinite(v) || v <= 0) return;
  customBpm.value = v;
  // 参考稿在 buildVisualizer() 里重建并复位；这里同样从 0 开始，避免倍率切换时跳动
  stopLoop();
  hasStarted.value = false;
  paused.value = false;
  ended = false;
  animStart = 0;
  playbackTime.value = 0;
  clearActive();
  setPlayhead(0);
  if (wrapEl.value) wrapEl.value.scrollLeft = 0;
}

/* ---------------- 位置与尺寸变化 ---------------- */
function centerVertical() {
  const wrap = wrapEl.value;
  if (!wrap) return;
  wrap.scrollTop = centerScrollTop(notes.value, rowPx.value, wrap.clientHeight);
}

watch(layout, async () => {
  await nextTick();
  rebuildEls();
  // 行距变化后，原来居中的音域可能已经跑出视口 —— 重新居中
  centerVertical();
});

watch(() => (app.currentSong && app.currentSong.id), async () => {
  await nextTick();
  rebuildEls();
  if (wrapEl.value) wrapEl.value.scrollLeft = 0;
  centerVertical();
});

onMounted(async () => {
  await nextTick();
  rebuildEls();
  centerVertical();
});

onBeforeUnmount(stopLoop);
</script>

<template>
  <div class="viz-card card roll-card" :class="{ 'roll-card-page': props.page }">
    <div class="vc-head roll-head">
      <span class="dot" style="background: var(--brand-coral)"></span>
      <b>{{ t('卷帘回放') }}</b>
      <span class="muted small">{{ app.currentSong ? app.currentSong.name : t('还没有可画成卷帘的音符') }}</span>
      <span style="flex:1"></span>
      <span class="muted small">{{ t('曲目 BPM') }} {{ originalBpm }}</span>
    </div>

    <div class="roll-bar">
      <label class="roll-lbl" for="rollBpm">{{ t('BPM（可选）') }}</label>
      <input id="rollBpm" v-model="bpmInput" class="roll-num" type="number" min="20" max="400"
             :placeholder="t('默认用曲目 BPM')" @keydown.enter="applyBpm" />
      <button class="chip-btn" @click="applyBpm">{{ t('应用BPM') }}</button>

      <span class="roll-gap"></span>
      <label class="roll-lbl" for="rollPx">{{ t('横向缩放') }}（px/s）</label>
      <input id="rollPx" v-model.number="pxPerSec" type="range"
             :min="ROLL_LIMITS.pxPerSec.min" :max="ROLL_LIMITS.pxPerSec.max" :step="ROLL_LIMITS.pxPerSec.step" />
      <span class="roll-val">{{ pxPerSec }}</span>

      <label class="roll-lbl" for="rollRow">{{ t('纵向间距') }}（px）</label>
      <input id="rollRow" v-model.number="rowPx" type="range"
             :min="ROLL_LIMITS.rowPx.min" :max="ROLL_LIMITS.rowPx.max" :step="ROLL_LIMITS.rowPx.step" />
      <span class="roll-val">{{ rowPx }}</span>

      <label class="roll-lbl" for="rollHl">{{ t('最短高亮时间') }}</label>
      <input id="rollHl" v-model.number="minHighlight" class="roll-num" type="number"
             :min="ROLL_LIMITS.minHighlight.min" :max="ROLL_LIMITS.minHighlight.max" :step="ROLL_LIMITS.minHighlight.step" />

      <span class="roll-gap"></span>
      <button class="chip-btn" :disabled="!notes.length || hasStarted" @click="start">{{ t('开始') }}</button>
      <button class="chip-btn" :disabled="!hasStarted" @click="togglePause">{{ paused ? t('继续') : t('暂停') }}</button>
      <button class="chip-btn" @click="reset">{{ t('重置') }}</button>
      <button class="chip-btn" :disabled="!notes.length" @click="replay">{{ t('重新播放') }}</button>
    </div>

    <div ref="wrapEl" class="roll-wrap">
      <div class="roll-inner" :style="{ width: totalWidth + 'px', height: contentH + 'px' }">
        <div ref="playheadEl" class="roll-playhead"></div>
        <div v-for="(it, i) in layout" :key="i" class="roll-note" :style="it.style"></div>
      </div>
      <div v-if="!notes.length" class="roll-empty" role="status">
        <b>{{ t('还没有可画成卷帘的音符') }}</b>
        <span>{{ t('载入一首 MIDI 曲目后，这里会按时间轴铺开每条轨的音符。') }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.roll-card { min-width: 0; }
.roll-head { flex-wrap: wrap; row-gap: var(--sp-1); }

/* 参数条：一行排不下就换行（参考稿是整段居中，这里按工具条对齐） */
.roll-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
  border-top: 1px solid var(--hairline);
}
.roll-lbl { font-size: var(--fs-sm); color: var(--text2); }
.roll-val { font-size: var(--fs-xs); color: var(--text3); min-width: 24px; }
.roll-num {
  width: 78px;
  font-size: var(--fs-sm);
  padding: 2px 6px;
  border: 1px solid var(--hairline);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--text);
}
.roll-bar input[type='range'] { width: 96px; }
.roll-gap { width: 8px; }

/* 卷帘本体：参考稿是 overflow:auto + cursor:grab 的滚动容器 */
.roll-wrap {
  position: relative;
  height: clamp(240px, 46vh, 560px);
  overflow: auto;
  cursor: grab;
  background: var(--canvas);
  border: 1px solid var(--hairline);
  border-radius: var(--r-sm);
}
/* 独占页签：卡片撑满页面可用高度，卷帘吃掉剩余空间。
   用 height:100%（父级 .roll-page 有确定高度）而不是 flex:1 ——
   后者会被内容的 min-content 顶破，整页跟着变高。 */
.roll-card-page { height: 100%; min-height: 0; display: flex; flex-direction: column; }
.roll-card-page .roll-wrap { flex: 1 1 0; height: auto; min-height: 0; }

.roll-inner { position: relative; }

.roll-note {
  position: absolute;
  background: var(--text3);
  transition: background-color 0.3s;
}
.roll-note.active { background: var(--text); }

.roll-playhead {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: var(--brand-coral);
  z-index: 10;
  pointer-events: none;
}

.roll-empty {
  position: sticky;
  left: 0;
  top: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  width: 100%;
  height: 100%;
  padding: var(--sp-4);
  text-align: center;
  color: var(--text3);
  font-size: var(--fs-sm);
}
.roll-empty b { color: var(--text); font-size: var(--fs-md); }
</style>
