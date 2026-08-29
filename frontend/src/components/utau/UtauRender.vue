<script setup>
// 合成渲染：把 UTAU 工程的音符/歌词/调声 → engine_utau render-track 渲染人声并预览
import { ref, computed } from 'vue';
import Icon from '../Icon.vue';
import { useUtauStore } from '../../stores/utau';
import { t } from '../../core/i18n.js';

const store = useUtauStore();
const bridge = window.fuBridge;
const isDesktop = !!(bridge && bridge.convert);

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pitchName = p => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);

const busy = ref(false);
const result = ref('');
let ctx = null, srcNode = null;

const beatMs = computed(() => 60000 / store.bpm);

function renderPayload() {
  const bms = beatMs.value;
  return store.sortedNotes.map(n => {
    const item = { lyric: n.lyric, note: pitchName(n.pitch), length_ms: Math.round(n.durBeat * bms) };
    if (n.velocity !== 100) item.velocity = n.velocity;
    if (n.volume !== 100) item.volume = n.volume;
    if (n.vibrato) item.vibrato = { depth_cent: n.vibDepth, freq_hz: n.vibFreq, delay_ms: 0 };
    return item;
  });
}

async function render() {
  if (!store.notes.length) { result.value = t('请先在曲谱编辑中添加音符。'); return; }
  if (!isDesktop) { result.value = t('网页版无法渲染本地声库，请用桌面版。可先导出音符 JSON，由桌面版导入。'); return; }
  busy.value = true; result.value = '';
  try {
    const r = await bridge.utauRenderTrack({
      voicebank: store.voicebankDir || null,
      notes: renderPayload(),
      sampleNote: store.sampleNote,
      bpm: store.bpm,
    });
    if (r && r.ok) {
      result.value = t('渲染完成：') + r.out;
      if (r.bytes) playBytes(r.bytes);
    } else {
      result.value = t('渲染失败：') + ((r && r.error) || 'unknown');
    }
  } catch (e) {
    result.value = t('渲染失败：') + ((e && e.message) || e);
  } finally { busy.value = false; }
}

function playBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const AC = window.AudioContext || window.webkitAudioContext;
  ctx = ctx || new AC();
  if (ctx.state === 'suspended') ctx.resume();
  ctx.decodeAudioData(u8.slice(0), buf => {
    if (srcNode) { try { srcNode.stop(); } catch (e) {} }
    srcNode = ctx.createBufferSource();
    srcNode.buffer = buf;
    srcNode.connect(ctx.destination);
    srcNode.start();
  }, () => { result.value = t('渲染成功，但预览解码失败。') + result.value; });
}

async function pickVoicebank() {
  if (!isDesktop) { result.value = t('请用桌面版选择声库目录。'); return; }
  const dir = await bridge.pickDirectory();
  if (dir) store.setVoicebank(dir);
}

function exportJson() {
  const data = JSON.stringify({
    bpm: store.bpm, sampleNote: store.sampleNote, notes: renderPayload(),
  }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'utau_project.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
</script>

<template>
  <div class="ur">
    <div class="ur-panel">
      <b>{{ t('合成渲染') }}</b>
      <p class="muted small">{{ t('把当前工程的音符 / 歌词 / 调声交给 engine_utau 渲染人声。') }}</p>

      <div class="ur-row">
        <span class="ur-label">{{ t('声库') }}</span>
        <button class="btn sm" @click="pickVoicebank">
          {{ store.voicebankDir ? store.voicebankDir : t('选择声库目录') }}
        </button>
        <span v-if="isDesktop && !store.voicebankDir" class="warn small">{{ t('（网页版默认无，需桌面版选择）') }}</span>
      </div>
      <div class="ur-row"><span class="ur-label">{{ t('工程') }}</span><em>{{ store.bpm }} BPM · {{ store.notes.length }} 音符 · 共 {{ (store.totalBeats).toFixed(1) }} 拍</em></div>

      <div class="ur-actions">
        <button class="btn primary" @click="render" :disabled="busy || !store.notes.length">
          <Icon name="convert" :size="14" /> {{ busy ? t('渲染中…') : t('渲染人声') }}
        </button>
        <button class="btn sm ghost" @click="exportJson">{{ t('导出音符 JSON') }}</button>
      </div>

      <div v-if="result" class="ur-result" :class="{ err: result.startsWith(t('渲染失败')) }">{{ result }}</div>
    </div>

    <div class="ur-hint muted small">{{ t('提示：先在「声库制作」准备好音源并导出，再在桌面版选择该目录渲染。') }}</div>
  </div>
</template>

<style scoped>
.ur { padding: 14px 18px; display: flex; flex-direction: column; gap: 12px; }
.ur-panel { max-width: 560px; display: flex; flex-direction: column; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: var(--canvas); }
.ur-panel b { font-size: 14px; }
.ur-row { display: flex; align-items: center; gap: 10px; font-size: 13px; }
.ur-label { width: 54px; color: var(--stone); font-size: 12px; flex: none; }
.ur-actions { display: flex; gap: 10px; margin-top: 4px; }
.ur-result { padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; font-size: 13px; background: var(--surface-muted); word-break: break-all; }
.ur-result.err { border-color: var(--danger); color: var(--danger); }
.ur-hint { line-height: 1.6; }
.warn { color: var(--warning); }
</style>