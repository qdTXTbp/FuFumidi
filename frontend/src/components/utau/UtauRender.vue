<script setup>
// 合成渲染工作台：参数 → 渲染 → 波形试听 → 统计/导出/历史
// 引擎侧为 engine_utau.py（render-track），本页负责组织参数、校验、预览与产物管理。
import { ref, computed, onMounted, onBeforeUnmount, nextTick, watch } from 'vue';
import Icon from '../Icon.vue';
import { useAppStore } from '../../stores/app';
import { useUtauStore } from '../../stores/utau';
import { t } from '../../core/i18n.js';

const app = useAppStore();
const store = useUtauStore();
const toast = (m, k) => app.toast(m, k);
const bridge = window.fuBridge;
const isDesktop = !!(bridge && bridge.convert);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = p => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
const beatMs = computed(() => 60000 / store.bpm);

const LS_AUTOPLAY = 'fufumidi_utau_autoplay';
const LS_HISTORY = 'fufumidi_utau_render_history';
const HISTORY_MAX = 5;

/* ---------------- 渲染参数 ---------------- */
const scope = ref('all');                 // all | selection（仅选中音符）
const autoPlay = ref(true);
try { autoPlay.value = localStorage.getItem(LS_AUTOPLAY) !== '0'; } catch (e) {}
watch(autoPlay, v => { try { localStorage.setItem(LS_AUTOPLAY, v ? '1' : '0'); } catch (e) {} });

const busy = ref(false);
const busyMs = ref(0);
const errorText = ref('');
let busyTimer = 0;

const targetNotes = computed(() => {
  if (scope.value !== 'selection') return store.sortedNotes;
  const sel = new Set(store.selectedIds);
  return store.sortedNotes.filter(n => sel.has(n.id));
});

const projectStats = computed(() => {
  const notes = targetNotes.value;
  const bms = beatMs.value;
  let lo = 127, hi = 0, totalMs = 0;
  for (const n of notes) {
    if (n.pitch < lo) lo = n.pitch;
    if (n.pitch > hi) hi = n.pitch;
    totalMs += Math.round(n.durBeat * bms);
  }
  return {
    count: notes.length,
    span: notes.length ? pitchName(lo) + ' ~ ' + pitchName(hi) : '—',
    durMs: totalMs,
    lyrics: new Set(notes.map(n => n.lyric).filter(Boolean)).size,
    tuned: notes.filter(n => n.vibrato || (n.params && (n.params.pitch || n.params.breath || (n.params.gender != null && n.params.gender !== 50))) || (n.pitchCurve && n.pitchCurve.length) || n.flags).length,
  };
});

/* 歌词覆盖度：本地比对声库别名，提前暴露「歌词不在原音表中」的回退问题 */
const aliasSet = ref(null);
const aliasBusy = ref(false);
const missingLyrics = computed(() => {
  if (!aliasSet.value) return [];
  const miss = [];
  for (const n of targetNotes.value) {
    if (n.lyric && !aliasSet.value.has(n.lyric) && !miss.includes(n.lyric)) miss.push(n.lyric);
  }
  return miss;
});
async function loadAliases() {
  const dir = store.voicebankDir;
  aliasSet.value = null;
  if (!dir || !bridge || typeof bridge.utauAliases !== 'function') return;
  aliasBusy.value = true;
  try {
    const r = await bridge.utauAliases({ voicebank: dir, limit: 2000 });
    if (r && r.ok && Array.isArray(r.aliases)) aliasSet.value = new Set(r.aliases);
  } catch (e) {} finally { aliasBusy.value = false; }
}
watch(() => store.voicebankDir, loadAliases);

/* ---------------- 渲染 ---------------- */
function renderPayload() {
  const bms = beatMs.value;
  return targetNotes.value.map(n => {
    const item = { lyric: n.lyric, note: pitchName(n.pitch), length_ms: Math.round(n.durBeat * bms) };
    if (n.velocity !== 100) item.velocity = n.velocity;
    if (n.volume !== 100) item.volume = n.volume;
    if (n.vibrato) item.vibrato = { depth_cent: n.vibDepth, freq_hz: n.vibFreq, delay_ms: 0, fade_ms: n.vibFade || 0 };
    const p = n.params || {};
    if (p.pitch) item.pitch_cents = p.pitch;
    if (p.gender != null && p.gender !== 50) item.gender = p.gender;
    if (p.breath) item.breath = p.breath;
    if (Array.isArray(n.pitchCurve) && n.pitchCurve.length >= 2) {
      item.pitch_curve = n.pitchCurve.map(q => ({ pos: q.pos, cents: q.cents }));
    }
    if (n.flags) item.flags = n.flags;
    return item;
  });
}

const lastRender = ref(null);
const history = ref([]);
try { history.value = JSON.parse(localStorage.getItem(LS_HISTORY) || '[]') || []; } catch (e) { history.value = []; }
function pushHistory(rec) {
  const list = [rec, ...history.value].slice(0, HISTORY_MAX);
  history.value = list;
  try { localStorage.setItem(LS_HISTORY, JSON.stringify(list)); } catch (e) {}
}
function clearHistory() {
  history.value = [];
  try { localStorage.removeItem(LS_HISTORY); } catch (e) {}
}

async function render() {
  errorText.value = '';
  const notes = targetNotes.value;
  if (!store.notes.length) { errorText.value = t('请先在「曲谱与调声」中添加音符。'); return; }
  if (!notes.length) { errorText.value = t('当前渲染范围内没有音符。'); return; }
  if (!isDesktop) { errorText.value = t('网页版无法渲染本地声库，请用桌面版。可先导出音符 JSON，由桌面版导入。'); return; }
  if (!store.voicebankDir) { errorText.value = t('请先选择声库目录。'); return; }
  busy.value = true; busyMs.value = 0;
  const t0 = performance.now();
  busyTimer = setInterval(() => { busyMs.value = Math.round(performance.now() - t0); }, 200);
  try {
    const r = await bridge.utauRenderTrack({
      voicebank: store.voicebankDir,
      notes: renderPayload(),
      sampleNote: store.sampleNote,
      bpm: store.bpm,
    });
    const elapsedMs = Math.round(performance.now() - t0);
    if (!r || !r.ok) { errorText.value = t('渲染失败：') + ((r && r.error) || 'unknown'); return; }
    const rec = {
      path: r.out || '',
      durMs: r.duration_ms || 0,
      notes: notes.length,
      scope: scope.value,
      engineVersion: r.engineVersion || '',
      warnings: Array.isArray(r.warnings) ? r.warnings : [],
      elapsedMs,
      at: Date.now(),
      bytes: r.bytes || null,
    };
    lastRender.value = rec;
    pushHistory({ path: rec.path, durMs: rec.durMs, notes: rec.notes, scope: rec.scope, engineVersion: rec.engineVersion, elapsedMs, at: rec.at, warnings: rec.warnings.length });
    await loadWaveform(rec.bytes, { autoplay: autoPlay.value });
  } catch (e) {
    errorText.value = t('渲染失败：') + ((e && e.message) || e);
  } finally {
    clearInterval(busyTimer); busyTimer = 0;
    busy.value = false;
  }
}

/* ---------------- 波形 + 试听 ---------------- */
const waveCanvas = ref(null);
const audioInfo = ref(null);      // { durSec, peak, rms, clipped, rate }
const playing = ref(false);
const playSec = ref(0);
let audioCtx = null, srcNode = null, decoded = null, rafId = 0, startedAt = 0, startOffset = 0;

function fmtTime(sec) {
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
}

async function loadWaveform(bytes, opts = {}) {
  if (!bytes) return;
  stopPlayback();
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const ab = u8.slice(0).buffer;
  const AC = window.AudioContext || window.webkitAudioContext;
  audioCtx = audioCtx || new AC();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  decoded = await new Promise((res, rej) => {
    const p = audioCtx.decodeAudioData(ab, res, rej);
    if (p && typeof p.then === 'function') p.then(res).catch(rej);
  }).catch(() => null);
  if (!decoded) { errorText.value = t('渲染成功，但预览解码失败。'); return; }
  // 统计（从解码后的浮点数据实测，不依赖引擎自报）
  const ch = decoded.getChannelData(0);
  let peak = 0, sumsq = 0;
  for (let i = 0; i < ch.length; i++) { const v = ch[i]; const a = v < 0 ? -v : v; if (a > peak) peak = a; sumsq += v * v; }
  const rms = Math.sqrt(sumsq / Math.max(1, ch.length));
  audioInfo.value = {
    durSec: decoded.duration,
    peak: Math.round(peak * 1000) / 1000,
    rms: Math.round(rms * 1000) / 1000,
    rate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
    clipped: peak >= 0.999,
  };
  await nextTick();
  drawWave();
  if (opts.autoplay) play();
}

function drawWave() {
  const cv = waveCanvas.value;
  if (!cv) return;
  const wrap = cv.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const W = Math.max(80, Math.round(wrap.clientWidth));
  const H = Math.max(60, Math.round(wrap.clientHeight));
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
  }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const cs = getComputedStyle(document.documentElement);
  const v = (n, fb) => (cs.getPropertyValue(n).trim() || fb);
  g.fillStyle = v('--lane-bg', 'rgba(10,10,10,0.03)');
  g.fillRect(0, 0, W, H);
  const mid = H / 2;
  g.strokeStyle = v('--grid', 'rgba(10,10,10,0.08)');
  g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
  if (!decoded) return;
  const ch = decoded.getChannelData(0);
  const step = Math.max(1, Math.floor(ch.length / W));
  g.fillStyle = v('--curve', '#4f8ef7');
  for (let x = 0; x < W; x++) {
    let mn = 0, mx = 0;
    const s0 = x * step, s1 = Math.min(ch.length, s0 + step);
    for (let i = s0; i < s1; i++) { const val = ch[i]; if (val < mn) mn = val; if (val > mx) mx = val; }
    const y1 = mid - mx * (H / 2 - 2), y2 = mid - mn * (H / 2 - 2);
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  drawHead();
}

function drawHead() {
  const cv = waveCanvas.value;
  if (!cv || !audioInfo.value) return;
  const g = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.width / dpr, H = cv.height / dpr;
  const cs = getComputedStyle(document.documentElement);
  g.save();
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const x = Math.max(0, Math.min(W - 1, (playSec.value / Math.max(0.001, audioInfo.value.durSec)) * W));
  g.strokeStyle = cs.getPropertyValue('--playhead').trim() || '#ff5530';
  g.lineWidth = 1.5;
  g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke();
  g.restore();
}

function tick() {
  if (!playing.value || !decoded) return;
  const cur = startOffset + (audioCtx.currentTime - startedAt);
  playSec.value = Math.max(0, Math.min(decoded.duration, cur));
  drawHead();
  if (playSec.value >= decoded.duration - 0.01) { stopPlayback(); return; }
  rafId = requestAnimationFrame(tick);
}

function play(from) {
  if (!decoded || !audioCtx) return;
  const off = from != null ? from : (playSec.value >= decoded.duration - 0.02 ? 0 : playSec.value);
  stopPlayback();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  srcNode = audioCtx.createBufferSource();
  srcNode.buffer = decoded;
  srcNode.connect(audioCtx.destination);
  srcNode.onended = () => { if (playing.value && playSec.value >= (decoded ? decoded.duration - 0.05 : 0)) stopPlayback(); };
  startOffset = off; startedAt = audioCtx.currentTime;
  srcNode.start(0, off);
  playing.value = true;
  playSec.value = off;
  drawHead();
  rafId = requestAnimationFrame(tick);
}

function stopPlayback() {
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (srcNode) { try { srcNode.onended = null; srcNode.stop(); } catch (e) {} srcNode = null; }
  playing.value = false;
}

function togglePlay() { if (playing.value) { stopPlayback(); } else { play(); } }

function seekWave(e) {
  if (!audioInfo.value) return;
  const cv = waveCanvas.value;
  const r = cv.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - r.left) / Math.max(1, r.width)));
  const target = ratio * audioInfo.value.durSec;
  if (playing.value) play(target); else { playSec.value = target; drawHead(); }
}

/* 历史条目：重新载入试听 / 定位文件 */
async function replayHistory(h) {
  if (!h || !h.path) return;
  if (!bridge || typeof bridge.readBinary !== 'function') { errorText.value = t('无法读取历史文件。'); return; }
  try {
    const buf = await bridge.readBinary(h.path);
    if (!buf) { errorText.value = t('历史文件已不存在：') + h.path; return; }
    lastRender.value = { path: h.path, durMs: h.durMs, notes: h.notes, engineVersion: h.engineVersion, warnings: [], elapsedMs: h.elapsedMs, at: h.at };
    await loadWaveform(buf, { autoplay: true });
  } catch (e) { errorText.value = t('读取失败：') + ((e && e.message) || e); }
}

/* ---------------- 产物操作 ---------------- */
async function saveAs() {
  const rec = lastRender.value;
  if (!rec) return;
  let bytes = rec.bytes;
  if (!bytes && rec.path && bridge.readBinary) bytes = await bridge.readBinary(rec.path);
  if (!bytes) { errorText.value = t('没有可保存的音频数据。'); return; }
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const base = (store.voicebankDir ? String(store.voicebankDir).replace(/^.*[\\/]/, '') : 'utau');
  const name = base + '_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '') + '.wav';
  const r = await bridge.saveBinary({ name, data: u8 });
  if (r && r.ok) toast(t('已保存：') + r.path, 'ok');
  else if (r && r.error) toast(t('保存失败：') + r.error, 'error');
}

function revealFile() {
  const p = lastRender.value && lastRender.value.path;
  if (p && bridge.openOutput) bridge.openOutput(p);
}

async function copyPath() {
  const p = lastRender.value && lastRender.value.path;
  if (!p) return;
  try { await navigator.clipboard.writeText(p); } catch (e) {}
}

/* 声库快捷切换 */
const vbList = ref([]);
async function loadVoicebanks() {
  if (!bridge || typeof bridge.utauListVoicebanks !== 'function') return;
  try { const r = await bridge.utauListVoicebanks(); if (r && r.ok) vbList.value = r.list || []; } catch (e) {}
}
async function pickVoicebank() {
  if (!isDesktop) { errorText.value = t('请用桌面版选择声库目录。'); return; }
  const dir = await bridge.pickDirectory();
  if (dir) store.setVoicebank(dir);
}

function exportJson() {
  const data = JSON.stringify({ bpm: store.bpm, sampleNote: store.sampleNote, notes: renderPayload() }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'utau_project.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

let ro = null;
onMounted(() => {
  loadVoicebanks();
  loadAliases();
  if (typeof ResizeObserver !== 'undefined' && waveCanvas.value && waveCanvas.value.parentElement) {
    ro = new ResizeObserver(() => drawWave());
    ro.observe(waveCanvas.value.parentElement);
  }
});
onBeforeUnmount(() => {
  stopPlayback();
  if (busyTimer) clearInterval(busyTimer);
  if (ro) { ro.disconnect(); ro = null; }
});
</script>

<template>
  <div class="ur">
    <!-- 左：渲染设置 -->
    <section class="ur-col ur-setup">
      <div class="ur-card">
        <div class="ur-card-h"><Icon name="mic" :size="13" />{{ t('声库与工程') }}</div>
        <div class="ur-row">
          <span class="ur-label">{{ t('声库') }}</span>
          <button class="btn sm ur-ellipsis" :title="store.voicebankDir || t('未选声库')" @click="pickVoicebank">
            {{ store.voicebankDir ? store.voicebankDir.replace(/^.*[\\/]/, '') : t('选择声库目录') }}
          </button>
          <select v-if="vbList.length" class="select-input ur-vb-sel" :value="''" :aria-label="t('已导入声库')"
                  @change="e => e.target.value && (store.setVoicebank(e.target.value), e.target.value = '')">
            <option value="" disabled>{{ t('已导入…') }}</option>
            <option v-for="v in vbList" :key="v.dir" :value="v.dir">{{ v.name }}</option>
          </select>
        </div>
        <div class="ur-kv">
          <div><span>{{ t('速度') }}</span><b>{{ store.bpm }} BPM</b></div>
          <div><span>{{ t('音符') }}</span><b>{{ projectStats.count }}</b></div>
          <div><span>{{ t('音域') }}</span><b>{{ projectStats.span }}</b></div>
          <div><span>{{ t('预计时长') }}</span><b>{{ fmtTime(projectStats.durMs / 1000) }}</b></div>
          <div><span>{{ t('已调声') }}</span><b>{{ projectStats.tuned }} / {{ projectStats.count }}</b></div>
          <div><span>{{ t('歌词种类') }}</span><b>{{ projectStats.lyrics }}</b></div>
        </div>
        <div v-if="aliasSet" class="ur-hint" :class="{ warn: missingLyrics.length }">
          <template v-if="missingLyrics.length">
            <Icon name="info" :size="12" />
            {{ t('有 ') }}{{ missingLyrics.length }}{{ t(' 个歌词不在声库原音表中，渲染时会回退到首个原音：') }}
            <b>{{ missingLyrics.slice(0, 4).join('、') }}{{ missingLyrics.length > 4 ? '…' : '' }}</b>
          </template>
          <template v-else><Icon name="music" :size="12" />{{ t('全部歌词都能在声库中找到对应原音') }}</template>
        </div>
        <div v-else-if="aliasBusy" class="ur-hint">{{ t('正在读取声库原音表…') }}</div>
      </div>

      <div class="ur-card">
        <div class="ur-card-h"><Icon name="quantize" :size="13" />{{ t('渲染范围与选项') }}</div>
        <div class="ur-seg">
          <button :class="{ on: scope === 'all' }" @click="scope = 'all'">{{ t('全部音符') }}（{{ store.notes.length }}）</button>
          <button :class="{ on: scope === 'selection' }" :disabled="!store.selectedIds.length" @click="scope = 'selection'">
            {{ t('仅选中') }}（{{ store.selectedIds.length }}）
          </button>
        </div>
        <label class="ur-check">
          <input type="checkbox" v-model="autoPlay" />{{ t('渲染完成后自动试听') }}
        </label>
        <div class="ur-actions">
          <button class="btn primary" :disabled="busy || !store.notes.length" @click="render">
            <Icon name="convert" :size="14" />
            {{ busy ? t('渲染中…') : t('渲染人声') }}
          </button>
          <button class="btn sm ghost" :title="t('把当前渲染参数导出为 JSON（可在网页版/其它机器导入）')" @click="exportJson">{{ t('导出参数') }}</button>
        </div>
        <div v-if="busy" class="ur-prog"><span :style="{ width: Math.min(96, (busyMs / 300)) + '%' }"></span></div>
        <div v-if="busy" class="ur-hint">{{ t('引擎渲染中，已用 ') }}{{ (busyMs / 1000).toFixed(1) }}s</div>
        <div v-if="errorText" class="ur-err">{{ errorText }}</div>
      </div>
    </section>

    <!-- 右：结果与试听 -->
    <section class="ur-col ur-out">
      <!-- 渲染结果摘要：一眼看清「是否成功 / 用了哪个引擎 / 花了多久」 -->
      <div v-if="lastRender" class="ur-card ur-result">
        <div class="ur-card-h">
          <Icon name="spark" :size="13" />{{ t('渲染完成') }}
          <span class="ur-spacer"></span>
          <span class="ur-badge ok">{{ t('成功') }}</span>
        </div>
        <div class="ur-kv">
          <div><span>{{ t('音符数') }}</span><b>{{ lastRender.notes }}</b></div>
          <div><span>{{ t('音频时长') }}</span><b>{{ (lastRender.durMs / 1000).toFixed(1) }}s</b></div>
          <div><span>{{ t('渲染耗时') }}</span><b>{{ (lastRender.elapsedMs / 1000).toFixed(1) }}s</b></div>
          <div><span>{{ t('提示条数') }}</span><b>{{ (lastRender.warnings && lastRender.warnings.length) || 0 }}</b></div>
        </div>
        <div class="ur-res-engine ur-mono small">engine_utau {{ lastRender.engineVersion || '—' }}</div>
      </div>

      <div class="ur-card">
        <div class="ur-card-h">
          <Icon name="play" :size="13" />{{ t('试听') }}
          <span class="ur-spacer"></span>
          <span v-if="audioInfo" class="ur-mono">{{ fmtTime(playSec) }} / {{ fmtTime(audioInfo.durSec) }}</span>
        </div>
        <div class="ur-wave" :class="{ empty: !decoded }" @click="seekWave">
          <canvas ref="waveCanvas"></canvas>
          <div v-if="!decoded" class="ur-wave-empty">{{ busy ? t('渲染中…') : t('渲染完成后在此显示波形') }}</div>
        </div>
        <div class="ur-play-row">
          <button class="btn sm" :disabled="!decoded" @click="togglePlay">
            <Icon :name="playing ? 'pause' : 'play'" :size="13" />{{ playing ? t('暂停') : t('播放') }}
          </button>
          <button class="btn sm ghost" :disabled="!decoded" @click="stopPlayback(); playSec = 0; drawHead()">{{ t('回到开头') }}</button>
          <span class="ur-spacer"></span>
          <span v-if="audioInfo" class="ur-mono muted small">{{ audioInfo.rate }}Hz · {{ audioInfo.channels === 1 ? t('单声道') : t('立体声') }}</span>
        </div>
      </div>

      <div class="ur-card">
        <div class="ur-card-h"><Icon name="chart" :size="13" />{{ t('渲染统计') }}</div>
        <div class="ur-kv">
          <div><span>{{ t('时长') }}</span><b>{{ audioInfo ? fmtTime(audioInfo.durSec) : (lastRender ? (lastRender.durMs / 1000).toFixed(1) + 's' : '—') }}</b></div>
          <div><span>{{ t('峰值') }}</span><b>{{ audioInfo ? audioInfo.peak : '—' }}</b></div>
          <div><span>{{ t('RMS') }}</span><b>{{ audioInfo ? audioInfo.rms : '—' }}</b></div>
          <div><span>{{ t('音符数') }}</span><b>{{ lastRender ? lastRender.notes : '—' }}</b></div>
          <div><span>{{ t('渲染耗时') }}</span><b>{{ lastRender ? (lastRender.elapsedMs / 1000).toFixed(1) + 's' : '—' }}</b></div>
          <div><span>{{ t('引擎') }}</span><b>{{ lastRender && lastRender.engineVersion ? 'v' + lastRender.engineVersion : '—' }}</b></div>
        </div>
        <div v-if="audioInfo && audioInfo.clipped" class="ur-hint warn"><Icon name="info" :size="12" />{{ t('检测到峰值削波（≈1.0），可降低音量或减少气声/性别参数。') }}</div>
        <div class="ur-actions">
          <button class="btn sm" :disabled="!lastRender" @click="saveAs"><Icon name="save" :size="13" />{{ t('另存为 WAV') }}</button>
          <button class="btn sm ghost" :disabled="!lastRender || !lastRender.path" @click="revealFile">{{ t('打开所在文件夹') }}</button>
          <button class="btn sm ghost" :disabled="!lastRender" @click="copyPath">{{ t('复制路径') }}</button>
        </div>
        <div v-if="lastRender && lastRender.path" class="ur-path" :title="lastRender.path">{{ lastRender.path }}</div>
      </div>

      <div v-if="lastRender && lastRender.warnings && lastRender.warnings.length" class="ur-card ur-warn">
        <div class="ur-card-h"><Icon name="info" :size="13" />{{ t('引擎提示') }}（{{ lastRender.warnings.length }}）</div>
        <div v-for="(w, i) in lastRender.warnings" :key="i" class="ur-warn-i">· {{ t(w) }}</div>
      </div>

      <div class="ur-card">
        <div class="ur-card-h">
          <Icon name="clock" :size="13" />{{ t('最近渲染') }}
          <span class="ur-spacer"></span>
          <button v-if="history.length" class="btn sm ghost" @click="clearHistory">{{ t('清空') }}</button>
        </div>
        <div v-if="!history.length" class="ur-hint">{{ t('还没有渲染记录。') }}</div>
        <div v-for="(h, i) in history" :key="h.at + '-' + i" class="ur-hist">
          <span class="ur-hist-t">{{ new Date(h.at).toLocaleTimeString() }}</span>
          <span class="ur-mono small">{{ (h.durMs / 1000).toFixed(1) }}s · {{ h.notes }} {{ t('音符') }}</span>
          <span v-if="h.warnings" class="ur-badge">{{ t('提示 ') }}{{ h.warnings }}</span>
          <span class="ur-spacer"></span>
          <button class="btn sm ghost" :title="t('重新试听')" @click="replayHistory(h)">{{ t('试听') }}</button>
          <button class="btn sm ghost" :title="t('打开所在文件夹')" @click="bridge && bridge.openOutput && bridge.openOutput(h.path)">{{ t('定位') }}</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.ur { display: grid; grid-template-columns: minmax(280px, 340px) minmax(0, 1fr); gap: 12px; padding: 12px 16px 18px; align-items: start; }
@media (max-width: 900px) { .ur { grid-template-columns: minmax(0, 1fr); } }
.ur-col { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.ur-card { border: 1px solid var(--border); border-radius: 12px; background: var(--surface); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.ur-card-h { display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; color: var(--stone); }
.ur-spacer { flex: 1; min-width: 0; }
.ur-row { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ur-label { flex: none; font-size: 12px; color: var(--stone); }
.ur-ellipsis { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.ur-vb-sel { flex: 0 1 118px; min-width: 84px; }
.ur-kv { display: grid; grid-template-columns: repeat(auto-fit, minmax(112px, 1fr)); gap: 4px 10px; }
.ur-kv > div { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; font-size: 12px; color: var(--stone); min-width: 0; }
.ur-kv b { color: var(--ink); font-family: var(--mono); font-size: 11.5px; font-weight: 600; text-align: right; overflow: hidden; text-overflow: ellipsis; }
.ur-hint { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--stone); line-height: 1.5; }
.ur-hint.warn { color: var(--amber); }
.ur-hint b { color: var(--ink); font-weight: 600; }
.ur-seg { display: flex; gap: 4px; background: var(--surface-soft); border-radius: 9px; padding: 2px; }
.ur-seg button { flex: 1; font-size: 11.5px; padding: 4px 8px; border: 0; border-radius: 7px; background: transparent; color: var(--stone); cursor: pointer; white-space: nowrap; }
.ur-seg button:hover:not(:disabled) { color: var(--ink); }
.ur-seg button.on { background: var(--accent); color: #fff; }
.ur-seg button:disabled { opacity: .45; cursor: default; }
.ur-check { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--ink); cursor: pointer; }
.ur-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ur-prog { height: 4px; border-radius: 2px; background: var(--surface-soft); overflow: hidden; }
.ur-prog span { display: block; height: 100%; background: var(--accent); transition: width .2s linear; }
.ur-err { padding: 7px 9px; border: 1px solid var(--error); border-radius: 8px; color: var(--error); font-size: 12px; word-break: break-all; }
.ur-wave { position: relative; height: 132px; border: 1px solid var(--border); border-radius: 10px; overflow: hidden; cursor: crosshair; background: var(--lane-bg); }
.ur-wave canvas { display: block; }
.ur-wave.empty { cursor: default; }
.ur-wave-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 12px; color: var(--stone); }
.ur-play-row { display: flex; align-items: center; gap: 6px; }
.ur-mono { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 11.5px; color: var(--ink); }
.ur-path { font-family: var(--mono); font-size: 10.5px; color: var(--stone); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ur-warn { border-color: var(--amber); }
.ur-warn-i { font-size: 11.5px; color: var(--ink); line-height: 1.5; word-break: break-all; }
/* 渲染结果摘要：成功态用品牌/成功色描边，与「引擎提示」的琥珀色警告卡区分开 */
.ur-result { border-color: color-mix(in srgb, var(--success-text) 42%, var(--border)); }
.ur-badge.ok { background: var(--success-bg); color: var(--success-text); }
.ur-res-engine { color: var(--stone); word-break: break-all; }
.ur-hist { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--stone); padding: 3px 0; border-bottom: 1px solid var(--hairline-soft); }
.ur-hist:last-child { border-bottom: 0; }
.ur-hist-t { flex: none; font-family: var(--mono); color: var(--ink); }
.ur-badge { flex: none; padding: 0 5px; border-radius: 6px; background: var(--accent-dim, rgba(20,86,240,.14)); color: var(--accent); font-size: 10.5px; }
.small { font-size: 11px; }
.muted { color: var(--muted); }
</style>
