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
  ROLL_LIMITS, collectNotes, collectTracks, rollWidth, rollHeight,
  noteRect, isNoteActive, followScroll, centerScrollTop, tempoFactorOf,
} from '../../core/roll_preview.js';
import { trackColor } from '../../core/palette.js';
import { ensureAudio } from '../../audio.js';

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
// ★ currentSong 是**曲库条目**，音符在 item.song.tracks[].notes（tick 域）。
//   2026-11-21 修复：之前直接读 currentSong.tracks，真实曲目一律空白。
const songDoc = computed(() => (app.currentSong && app.currentSong.song) || null);
const allTracks = computed(() => collectTracks(songDoc.value));
/** 选中的轨号集合：空轨不默认选，避免整页空着还要用户自己猜 */
const picked = ref(new Set());
watch(allTracks, (list) => {
  const next = new Set();
  for (const tr of list) if (tr.count > 0) next.add(tr.index);
  picked.value = next;
}, { immediate: true });

const notes = computed(() => collectNotes(songDoc.value, picked.value));

function toggleTrack(i) {
  const next = new Set(picked.value);
  if (next.has(i)) next.delete(i); else next.add(i);
  picked.value = next;
}
function pickAll() {
  const next = new Set();
  for (const tr of allTracks.value) if (tr.count > 0) next.add(tr.index);
  picked.value = next;
}

const originalBpm = computed(() => {
  const v = Number(app.currentSong && app.currentSong.initialBpm);
  return v > 0 ? v : 120; // 与参考稿 `tempos[0]?.bpm || 120` 一致
});
const totalWidth = computed(() => rollWidth(notes.value, pxPerSec.value));
const contentH = computed(() => rollHeight(rowPx.value));

/* 每个音符只算一次几何；样式串在 computed 里拼好，避免模板里重复计算 */
const layout = computed(() => notes.value.map((n) => {
  const r = noteRect(n, { pxPerSec: pxPerSec.value, rowPx: rowPx.value });
  return { n, style: `left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px` };
}));

/* ---------------- 走带：直接驱动播放器 ----------------
   ★ 2026-11-21 修：原先是参考稿那套「自己的时钟」，只滚画面不发声。
     现在时间一律读 app.curSec，按钮调 togglePlay / stopPlay / seekSec，
     画面与声音天然同步，也顺带享受播放器的「跳空白」与引擎自愈。 */
const isPlaying = computed(() => !!app.playing);

/** 当前播放头（秒）。
    播放中直接问播放器：store 的 curSec 是 30fps 节流写的（见 app.ts startTickLoop 的注释，
    "逐帧平滑动画的视图各自有独立绘制循环直接读 player"），拿它画会产生台阶感。
    暂停/seek 时 player 不变，用 store 里的值（seekSec 会写它）。 */
function currentSec() {
  if (app.playing) {
    try {
      const { player } = ensureAudio();
      if (player) return Number(player.currentSec()) || 0;
    } catch (e) { /* 引擎没起来时退回 store */ }
  }
  return Number(app.curSec) || 0;
}

let raf = 0;
let dirty = true;
let lastSec = -1;
let els = []; // [{ el, n, on }] —— 逐帧只改 class，不走 Vue 响应式

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

/** 把「发声窗口内」的音符点亮；暂停时也停在正确位置 */
function paintActive(sec) {
  for (const it of els) {
    const on = isNoteActive(sec, it.n, minHighlight.value);
    if (on !== it.on) { it.on = on; it.el.classList.toggle('active', on); }
  }
}

function tick() {
  raf = requestAnimationFrame(tick);
  const wrap = wrapEl.value;
  if (!wrap) return;

  const sec = currentSec();
  if (isPlaying.value) {
    // 播放中：每帧把播放头保持在视口中间（两端夹住），和参考稿一致
    const tgt = followScroll(sec * pxPerSec.value, wrap.clientWidth, totalWidth.value);
    if (Math.abs(wrap.scrollLeft - tgt) > 1) wrap.scrollLeft = tgt;
    dirty = true;
  }
  if (sec !== lastSec) { lastSec = sec; dirty = true; }
  if (!dirty) return;
  dirty = false;
  setPlayhead(sec);
  paintActive(sec);
}

function start() {
  if (!notes.value.length || isPlaying.value) return;
  seekTo(0);
  if (wrapEl.value) wrapEl.value.scrollLeft = 0;
  dirty = true;
  app.togglePlay();
}

function togglePlayPause() {
  if (!app.currentSong) return;
  app.togglePlay();
}

/** 恢复播放倍率：BPM 覆盖改的是全局播放速度，离开本页 / 重置时要还回去 */
function restoreTempo() {
  try { if (typeof app.setTempo === 'function') app.setTempo(1); } catch (e) { /* 引擎未就绪 */ }
}

/** 跳转到指定秒：优先走播放器（会同步引擎），引擎没起来时至少把 store 与画面归位，
    否则「重置」在引擎异常的环境里会留下一个不动的旧播放头。 */
function seekTo(sec) {
  try { app.seekSec(sec); return; } catch (e) { /* 引擎未就绪，走兜底 */ }
  try { app.curSec = sec; app.progress = 0; } catch (e) { /* store 不可写时彻底放弃 */ }
}

function reset() {
  try { app.stopPlay(); } catch (e) { /* 没有引擎时忽略 */ }
  restoreTempo();
  seekTo(0);
  bpmInput.value = '';
  customBpm.value = 0;
  pxPerSec.value = ROLL_LIMITS.pxPerSec.def;
  rowPx.value = ROLL_LIMITS.rowPx.def;
  minHighlight.value = ROLL_LIMITS.minHighlight.def;
  clearActive();
  lastSec = -1;
  setPlayhead(0);
  dirty = true;
  if (wrapEl.value) { wrapEl.value.scrollLeft = 0; centerVertical(); }
}

function replay() {
  if (!notes.value.length) return;
  seekTo(0);
  if (wrapEl.value) wrapEl.value.scrollLeft = 0;
  clearActive();
  lastSec = -1;
  setPlayhead(0);
  dirty = true;
  if (!isPlaying.value) app.togglePlay();
}

function applyBpm() {
  const v = parseFloat(bpmInput.value);
  if (!Number.isFinite(v) || v <= 0) return;
  customBpm.value = v;
  // 现在声音是真的：BPM 覆盖直接改播放速度，画面与声音对齐
  try { app.setTempo(Math.max(0.25, Math.min(4, tempoFactorOf(originalBpm.value, v)))); } catch (e) { /* 引擎未就绪 */ }
  dirty = true;
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
  restoreTempo();       // 换曲目后别把上一首的倍率带过去
  bpmInput.value = '';
  customBpm.value = 0;
  await nextTick();
  rebuildEls();
  if (wrapEl.value) wrapEl.value.scrollLeft = 0;
  centerVertical();
  clearActive();
  lastSec = -1;
  dirty = true;
});

onMounted(async () => {
  await nextTick();
  rebuildEls();
  centerVertical();
  // ★ 逐帧循环必须在这里起：播放头 / 自动跟随 / 高亮都靠它
  raf = requestAnimationFrame(tick);
});

onBeforeUnmount(() => {
  if (raf) cancelAnimationFrame(raf);
  restoreTempo();
});
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
      <button class="chip-btn" :title="t('按这个 BPM 改变播放速度（不只是预览）')" @click="applyBpm">{{ t('应用BPM') }}</button>

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
      <button class="chip-btn" :disabled="!notes.length || isPlaying" @click="start">{{ t('开始') }}</button>
      <button class="chip-btn" :disabled="!app.currentSong" @click="togglePlayPause">{{ isPlaying ? t('暂停') : t('继续') }}</button>
      <button class="chip-btn" @click="reset">{{ t('重置') }}</button>
      <button class="chip-btn" :disabled="!notes.length" @click="replay">{{ t('重新播放') }}</button>
    </div>

    <!-- 多轨曲目：让用户挑哪几条轨参与（默认全选有音符的轨） -->
    <div v-if="allTracks.length > 1" class="roll-tracks">
      <span class="muted small">{{ t('音轨') }}（{{ picked.size }}/{{ allTracks.length }}）</span>
      <button v-for="tr in allTracks" :key="tr.index" class="chip-btn"
              :class="{ active: picked.has(tr.index) }" :disabled="!tr.count"
              :title="tr.count ? '' : t('这条轨没有音符')"
              @click="toggleTrack(tr.index)">
        <span class="trk-dot" :style="{ background: trackColor(tr.index) }"></span>
        {{ tr.name || (t('轨') + ' ' + (tr.index + 1)) }}
        <span class="trk-n">{{ tr.count }}</span>
      </button>
      <button v-if="picked.size < allTracks.length" class="chip-btn" @click="pickAll">{{ t('全选') }}</button>
    </div>

    <div ref="wrapEl" class="roll-wrap">
      <div class="roll-inner" :style="{ width: totalWidth + 'px', height: contentH + 'px' }">
        <div ref="playheadEl" class="roll-playhead"></div>
        <div v-for="(it, i) in layout" :key="i" class="roll-note" :style="it.style"></div>
      </div>
      <div v-if="!notes.length" class="roll-empty" role="status">
        <b>{{ songDoc ? t('没有可显示的音符') : t('还没有可画成卷帘的音符') }}</b>
        <span>{{ songDoc ? t('这条曲目没有音符，或者你把所有音轨都取消了勾选。') : t('载入一首 MIDI 曲目后，这里会按时间轴铺开每条轨的音符。') }}</span>
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

/* 多轨选择条：一行排不下就换行，和参数条用同一条分隔线 */
.roll-tracks {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-2) 0;
  border-top: 1px solid var(--hairline);
}
.trk-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: var(--r-pill);
  margin-right: 4px;
}
.trk-n { font-size: var(--fs-xs); color: var(--text3); margin-left: 4px; }

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

/* 未播放：压到 30% 不透明度，只是"底图"；播放中：实色 + 一点辉光，
   一眼能看出这一拍是哪些音在响（参考稿是灰→黑，这里把两端拉得更开）。 */
.roll-note {
  position: absolute;
  background: var(--text3);
  opacity: 0.3;
  transition: background-color 0.3s, opacity 0.3s;
}
.roll-note.active {
  background: var(--text);
  opacity: 1;
  box-shadow: 0 0 6px color-mix(in srgb, var(--text) 55%, transparent);
}

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
