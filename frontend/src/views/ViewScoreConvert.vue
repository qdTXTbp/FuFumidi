<script setup lang="ts">
// ============================================================
// 变谱：乐谱（MusicXML / MXL）→ MIDI
// ============================================================
// 与「转录」「转换」并列的第三种入口：前两个是「音频 → MIDI」和「MIDI → 音频」，
// 这个是「**谱面 → MIDI**」—— MuseScore/Finale/Sibelius 导出的 .musicxml / .mxl 直接变成可编辑工程。
//
// 转换在引擎侧做（engine/engine_score2midi.py）：MusicXML 最容易错的是 divisions 单位、
// <backup> 分叉的多声部、连音线与速度表，那套逻辑有 19 条回归用例钉住。
// 这里只负责：选文件 → 展示统计与试看 → 导入曲库并打开 / 另存为。
import { ref, onMounted, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';
import { parseMidi } from '../core/midi.js';

const app = useAppStore();
const busy = ref(false);
const err = ref('');
const srcName = ref('');
const info = ref<any>(null);
const midiBytes = ref<Uint8Array | null>(null);
const tracks = ref<any[]>([]);
const previewEl = ref<HTMLCanvasElement | null>(null);

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pick() {
  const b: any = (window as any).fuBridge;
  if (!b || typeof b.scoreToMidi !== 'function') { err.value = t('桌面版才能用「变谱」'); return; }
  busy.value = true; err.value = ''; info.value = null; midiBytes.value = null; tracks.value = [];
  try {
    const r = await b.scoreToMidi({});
    if (!r || r.canceled) return;
    if (!r.ok) { err.value = String(r.error || t('转换失败')); return; }
    const bytes = b64ToBytes(r.bytes || '');
    midiBytes.value = bytes;
    info.value = r.info || null;
    srcName.value = r.fileName || '';
    try {
      const mid = parseMidi(bytes);
      tracks.value = (mid.tracks || []).filter((x: any) => (x.notes || []).length);
      await nextTick();
      drawPreview();
    } catch (e) { /* 预览失败不影响导入 */ }
    app.toast(t('已转换：') + String((r.info && r.info.noteCount) || 0) + t(' 个音符'), 'ok');
  } catch (e: any) {
    err.value = String((e && e.message) || e);
  } finally {
    busy.value = false;
  }
}

/** 试看：把所有声部画成一条紧凑的钢琴卷帘（按声部着色） */
function drawPreview() {
  const cv = previewEl.value;
  if (!cv) return;
  const all = tracks.value.flatMap((tr) => tr.notes || []);
  if (!all.length) return;
  const W = Math.max(320, cv.clientWidth || 640), H = 160;
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.floor(W * dpr); cv.height = Math.floor(H * dpr);
  const g = cv.getContext('2d');
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W, H);
  const cssVar = (n: string, fb: string) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb; } catch (e) { return fb; } };
  g.fillStyle = cssVar('--surface-muted', '#f7f8fa'); g.fillRect(0, 0, W, H);
  let t0 = Infinity, t1 = 0, lo = 127, hi = 0;
  for (const n of all) { t0 = Math.min(t0, n.start); t1 = Math.max(t1, n.end); lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
  const span = Math.max(12, hi - lo + 1);
  const pad = 4, rh = Math.max(1, (H - pad * 2) / span);
  const colors = ['#3d8bfd', '#ff7a45', '#36b37e', '#b37feb', '#f2b705', '#22b8cf', '#f06595', '#7f8c8d'];
  tracks.value.forEach((tr, i) => {
    g.fillStyle = colors[i % colors.length];
    for (const n of tr.notes || []) {
      const x = pad + ((n.start - t0) / Math.max(1, t1 - t0)) * (W - pad * 2);
      const w = Math.max(1.5, ((n.end - n.start) / Math.max(1, t1 - t0)) * (W - pad * 2) - 0.5);
      const y = pad + ((hi - n.midi) / span) * (H - pad * 2);
      g.fillRect(x, y, w, Math.max(1.5, rh));
    }
  });
}

/** 导入曲库（会自动切到这首） */
async function importToLibrary() {
  if (!midiBytes.value) return;
  const name = (srcName.value || 'score').replace(/\.(musicxml|xml|mxl)$/i, '') + '.mid';
  await app.importFiles([{ name, bytes: midiBytes.value }]);
}

/** 另存为 .mid */
async function saveAs() {
  const b: any = (window as any).fuBridge;
  if (!b || !midiBytes.value) return;
  const name = (srcName.value || 'score').replace(/\.(musicxml|xml|mxl)$/i, '') + '.mid';
  const r = await b.saveBinary({ name, data: midiBytes.value });
  if (r && r.ok) app.toast(t('已保存到：') + r.path, 'ok');
  else if (!(r && r.canceled)) app.toast(t('保存失败'), 'warn');
}

onMounted(() => { window.addEventListener('resize', () => drawPreview()); });
</script>

<template>
  <div class="sc-page">
    <div class="card sc-hero">
      <div class="sc-title"><Icon name="score" :size="16" /> {{ t('变谱') }}</div>
      <p class="sc-lead">
        {{ t('把谱面文件直接变成可编辑的 MIDI 工程。') }}
      </p>
      <p class="muted sc-sub">
        {{ t('支持 MusicXML（.musicxml / .xml）与压缩包 .mxl —— MuseScore、Finale、Sibelius、Dorico 都能导出。') }}
        {{ t('多声部（<backup> 分叉的钢琴双手）、和弦、连音线、速度/拍号/调号都会按谱面正确还原。') }}
      </p>
      <div class="sc-actions">
        <button class="btn primary" :disabled="busy" @click="pick">
          <Icon name="import" :size="14" /> {{ busy ? t('转换中…') : t('选择乐谱文件…') }}
        </button>
        <span v-if="srcName" class="muted small">{{ srcName }}</span>
      </div>
    </div>

    <p v-if="err" class="sc-err"><Icon name="info" :size="13" /> {{ err }}</p>

    <div v-if="info" class="card sc-result">
      <div class="sc-stats">
        <span><b>{{ info.tracks ? info.tracks.length : 0 }}</b>{{ t(' 个声部') }}</span>
        <span><b>{{ info.noteCount }}</b>{{ t(' 个音符') }}</span>
        <span><b>{{ info.bpm }}</b> BPM</span>
        <span><b>{{ info.timeSig }}</b></span>
        <span>{{ t('调号') }} <b>{{ info.key }}</b></span>
        <span>{{ t('时长') }} <b>{{ (info.durationMs / 1000).toFixed(1) }}s</b></span>
        <span v-if="info.tempoChanges > 1" class="muted">{{ t('速度变化 ') }}{{ info.tempoChanges }}{{ t(' 次') }}</span>
      </div>
      <div class="sc-tracks">
        <span v-for="(tr, i) in (info.tracks || [])" :key="i" class="sc-track">
          <i :style="{ background: ['#3d8bfd','#ff7a45','#36b37e','#b37feb','#f2b705','#22b8cf','#f06595','#7f8c8d'][i % 8] }"></i>
          {{ tr.name }} · {{ tr.notes === undefined ? '' : tr.notes }}{{ t(' 音') }}
        </span>
      </div>
      <canvas ref="previewEl" class="sc-preview"></canvas>
      <div class="sc-actions">
        <button class="btn primary" @click="importToLibrary"><Icon name="music" :size="14" /> {{ t('导入曲库并打开') }}</button>
        <button class="btn" @click="saveAs"><Icon name="save" :size="14" /> {{ t('另存为 MIDI…') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sc-page { display: flex; flex-direction: column; gap: 10px; height: 100%; overflow: auto; padding: 4px 2px 12px; }
.sc-hero { display: flex; flex-direction: column; gap: 6px; padding: 14px 16px; }
.sc-title { display: flex; align-items: center; gap: 6px; font-size: 15px; font-weight: 700; color: var(--ink); }
.sc-lead { margin: 0; font-size: 13px; color: var(--slate); }
.sc-sub { margin: 0; font-size: 12px; line-height: 1.7; }
.sc-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
.sc-err { display: flex; align-items: center; gap: 6px; margin: 0; padding: 8px 12px; border-radius: 10px;
  background: var(--surface-soft); color: var(--brand-coral); font-size: 12.5px; }
.sc-result { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; }
.sc-stats { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap; font-size: 12.5px; color: var(--slate); }
.sc-stats b { color: var(--ink); font-family: var(--mono); font-size: 13px; }
.sc-tracks { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--slate); }
.sc-track { display: inline-flex; align-items: center; gap: 5px; }
.sc-track i { width: 9px; height: 9px; border-radius: 50%; display: inline-block; }
.sc-preview { width: 100%; height: 160px; border: 1px solid var(--hairline); border-radius: 10px; display: block; }
</style>