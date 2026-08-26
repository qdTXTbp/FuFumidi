<script setup>
import { ref, computed } from 'vue';
import Icon from '../components/Icon.vue';
import { currentSong, toast } from '../store.js';
import { t } from '../core/i18n.js';
import { clamp } from '../core/util.js';
import { playVoice, presetFromMode } from '../core/synth.js';

const tempo = ref(1);
const rate = ref(44100);
const gain = ref(100);
const preset = ref('auto');
const range = ref('full');
const busy = ref(false);
const progress = ref(0);
const done = ref(false);

const song = computed(() => (currentSong.value && currentSong.value.song) || null);
const totalNotes = computed(() => song.value ? song.value.tracks.reduce((a, tr) => a + tr.notes.length, 0) : 0);

const PRESETS = [
  ['auto', '自动（按音色号）'], ['piano', '钢琴'], ['ep', '电钢'], ['organ', '管风琴'],
  ['strings', '弦乐'], ['brass', '铜管'], ['flute', '长笛'], ['guitar', '吉他'],
  ['bass', '贝斯'], ['lead', '合成主音'], ['pad', '铺底'], ['violin', '小提琴'],
  ['cello', '大提琴'], ['harp', '竖琴'], ['marimba', '马林巴'], ['musicbox', '八音盒'],
  ['vibraphone', '颤音琴'], ['choir', '人声合唱'], ['trumpet', '小号'], ['sax', '萨克斯'],
  ['clarinet', '单簧管'], ['oboe', '双簧管'], ['nylon', '尼龙吉他'], ['steel', '钢弦吉他'],
  ['synthbass', '合成贝斯'], ['bell', '钟琴'], ['accordion', '手风琴'], ['banjo', '班卓琴'],
];

const estSize = computed(() => {
  const s = song.value;
  if (!s) return '—';
  const sec = s.totalSec / (tempo.value || 1);
  const bytes = sec * (rate.value || 44100) * 2;
  const kb = bytes / 1024;
  return kb >= 1048576 ? (kb / 1048576).toFixed(1) + ' MB' : Math.round(kb) + ' KB';
});

/* ---------------- 渲染 ---------------- */
async function renderAudio() {
  const s = song.value;
  if (!s) { toast(t('请先载入 MIDI 文件'), 'warn'); return; }
  if (busy.value) return;
  busy.value = true; done.value = false; progress.value = 0;

  const sr = rate.value;
  const scale = tempo.value;
  const g = clamp(gain.value / 100, 0, 2);
  const totalSec = s.totalSec / scale;
  // 预渲染 1.5 秒静音尾音，避免最后一个音符被截断
  const TAIL = 1.5;
  const totalLen = Math.max(1, Math.ceil((totalSec + TAIL) * sr));

  // 收集全部音符（折算为相对整曲起点的秒），统一折算避免每桶重复计算
  const notes = [];
  for (const tr of s.tracks) {
    const presetName = presetFromMode(preset.value, tr.program, tr.isDrum);
    for (const n of tr.notes) {
      const t = s.baseSec(n.start) / scale;
      const e = s.baseSec(n.end) / scale;
      if (e <= t) continue;
      notes.push({ t, e, midi: n.midi, vel: n.vel, preset: presetName, trk: tr.index });
    }
  }
  notes.sort((a, b) => a.t - b.t);

  const finish = (buf) => {
    downloadWav(buf, s.name, g);
    progress.value = 100; done.value = true;
    toast(t('音频已导出'));
  };

  // 空曲：直接渲染静音缓冲
  if (!notes.length) {
    try {
      const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, totalLen, sr);
      finish(await ctx.startRendering());
    } catch (e) {
      toast(t('渲染失败：') + String(e.message || e), 'warn');
    } finally { busy.value = false; }
    return;
  }

  // 分桶离线渲染：按音符起始时间分桶，每桶用独立 OfflineAudioContext 渲染完整包络，
  // 最后 overlap-add 合成。相比整曲单图渲染，峰值 AudioNode 数量与峰值缓冲大小都大幅下降，
  // 显著降低内存占用并加快渲染（修复大曲目在 startRendering 阶段卡死/失败的问题）。
  const BUCKET = 10;   // 每桶起始时间窗（秒）
  const RELEASE = 0.6; // 每桶末尾额外尾音（秒），覆盖最长 release
  const buckets = new Map();
  for (const n of notes) {
    const bi = Math.floor(n.t / BUCKET);
    let b = buckets.get(bi);
    if (!b) { b = { notes: [], minT: n.t, maxE: n.e }; buckets.set(bi, b); }
    b.notes.push(n);
    if (n.t < b.minT) b.minT = n.t;
    if (n.e > b.maxE) b.maxE = n.e;
  }
  const idxs = Array.from(buckets.keys()).sort((a, b) => a - b);
  const rendered = [];
  try {
    for (let k = 0; k < idxs.length; k++) {
      const b = buckets.get(idxs[k]);
      const offSec = b.minT;
      const durSec = (b.maxE - b.minT) + RELEASE;
      const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, Math.max(1, Math.ceil(durSec * sr)), sr);
      const master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
      // 每轨一个前置增益节点（音量交给 downloadWav 统一应用，避免双重增益）
      const tgs = [];
      for (let i = 0; i < s.tracks.length; i++) { const tg = ctx.createGain(); tg.gain.value = 1; tg.connect(master); tgs.push(tg); }
      const live = [];
      for (const n of b.notes) playVoice(ctx, n.t - offSec, n.midi, n.vel, n.preset, tgs[n.trk], n.e - offSec, live);
      const buf = await ctx.startRendering();
      rendered.push({ offSec, buf });
      progress.value = Math.round((k + 1) / idxs.length * 70);
      await new Promise(r => setTimeout(r, 0));
    }
    progress.value = 70;
    const out = mixRendered(rendered, sr, totalLen);
    progress.value = 95;
    await new Promise(r => setTimeout(r, 20));
    finish(out);
  } catch (e) {
    toast(t('渲染失败：') + String(e.message || e), 'warn');
  } finally {
    busy.value = false;
  }
}

/* overlap-add：把各桶缓冲按偏移量叠加为整曲缓冲（每桶只渲染其起始窗内的音符，
   但缓冲覆盖其最晚音符结束 + 尾音，跨桶重叠处直接相加即为正确混音） */
function mixRendered(rendered, sr, totalLen) {
  const tmp = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, 1, sr);
  const out = tmp.createBuffer(2, totalLen, sr);
  const L = out.getChannelData(0), R = out.getChannelData(1);
  for (const it of rendered) {
    const off = Math.max(0, Math.round(it.offSec * sr));
    const srcL = it.buf.getChannelData(0);
    const srcR = it.buf.numberOfChannels > 1 ? it.buf.getChannelData(1) : srcL;
    const n = Math.min(srcL.length, totalLen - off);
    for (let i = 0; i < n; i++) { L[off + i] += srcL[i]; R[off + i] += srcR[i]; }
  }
  return out;
}

function downloadWav(buf, name, g) {
  const chs = buf.numberOfChannels;
  const len = buf.length;
  const sampleRate = buf.sampleRate;
  const out = new Float32Array(len * chs);
  for (let c = 0; c < chs; c++) {
    const d = buf.getChannelData(c);
    const o = c * len;
    for (let i = 0; i < len; i++) out[o + i] = d[i] * g;
  }
  const ab = new ArrayBuffer(44 + out.length * 2);
  const v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + out.length * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, chs, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * chs * 2, true);
  v.setUint16(32, chs * 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, out.length * 2, true);
  let p = 44;
  for (let i = 0; i < out.length; i++) {
    const s = Math.max(-1, Math.min(1, out[i]));
    v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    p += 2;
  }
  const blob = new Blob([ab], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.download = name + '_render.wav';
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
</script>

<template>
  <div class="page convert-view">
    <div class="page-head">
      <span class="page-ic"><Icon name="convert" :size="20" /></span>
      <div>
        <div class="page-title">{{ t('转换') }}</div>
        <div class="page-sub">{{ t('音频导出 · 本地离线渲染 · 浏览器直接下载 WAV') }}</div>
      </div>
    </div>

    <div class="conv-info-bar">
      <b>{{ t('音频导出') }}</b><span>· {{ t('本地离线渲染') }}</span>
      <span class="conv-song">{{ song ? song.name : t('未加载曲目') }}</span>
    </div>

    <div class="card conv-form">
      <div class="form-grid">
        <div class="field-row">
          <label>{{ t('音色风格') }}</label>
          <select class="select-input" v-model="preset" style="min-width:150px">
            <option v-for="p in PRESETS" :key="p[0]" :value="p[0]">{{ p[1] }}</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('速度') }}</label>
          <select class="select-input" v-model.number="tempo">
            <option :value="0.5">0.5×</option><option :value="0.75">0.75×</option>
            <option :value="1">1×（原速）</option>
            <option :value="1.25">1.25×</option><option :value="1.5">1.5×</option><option :value="2">2×</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('采样率') }}</label>
          <select class="select-input" v-model.number="rate">
            <option :value="22050">22050 Hz</option><option :value="44100">44100 Hz</option><option :value="48000">48000 Hz</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('渲染范围') }}</label>
          <select class="select-input" v-model="range" disabled>
            <option value="full">{{ t('整首歌曲') }}</option>
          </select>
        </div>
        <div class="field-row gain-row">
          <label>{{ t('输出音量') }}<b style="color:var(--brand-coral)">{{ gain }}%</b></label>
          <input type="range" min="0" max="150" v-model.number="gain" class="range" />
        </div>
      </div>

      <div class="conv-est">
        <span class="ce-lbl">{{ t('文件预估') }}</span>
        <span class="ce-val"><b>{{ estSize }}</b><em>· {{ totalNotes }} {{ t('音符') }}</em></span>
      </div>

      <button class="btn primary big" @click="renderAudio" :disabled="busy || !song">
        <Icon name="convert" :size="16" />{{ busy ? t('渲染中…') : t('渲染并导出 WAV') }}
      </button>

      <div v-if="busy || done" class="conv-progress">
        <div class="pfill" :style="{ width: progress + '%' }"></div>
        <span>{{ progress }}%</span>
      </div>
      <div v-if="done" class="conv-done-tip">✓ {{ t('渲染完成，WAV 已下载') }}</div>
    </div>
  </div>
</template>

<style scoped>
.convert-view { max-width: 820px; padding: 18px 26px 40px; }
.conv-info-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 12px; padding: 8px 14px; margin-bottom: 12px; font-size: 12.5px; color: var(--steel); }
.conv-song { color: var(--stone); }
.conv-form { display: flex; flex-direction: column; gap: 16px; }
.form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px 20px; }
@media (max-width: 720px) { .form-grid { grid-template-columns: 1fr; } }
.field-row { display: flex; flex-direction: column; gap: 6px; }
.field-row label { font-size: 12px; color: var(--steel); font-weight: 600; display: flex; align-items: center; gap: 8px; }
.gain-row { flex-direction: row; align-items: center; justify-content: space-between; }
.range { flex: 1; accent-color: var(--ink); }
.conv-est { display: flex; align-items: center; gap: 10px; background: var(--surface-soft); border-radius: 10px; padding: 8px 14px; font-size: 12px; color: var(--steel); }
.conv-est b { color: var(--ink); font-size: 15px; margin-right: 8px; font-variant-numeric: tabular-nums; }
.conv-est em { font-style: normal; color: var(--stone); }
.btn.big { width: 100%; padding: 12px 18px; font-size: 14px; }
.conv-progress { display: flex; align-items: center; gap: 10px; height: 20px; background: var(--surface-soft); border-radius: 999px; overflow: hidden; padding: 0 12px; font-size: 11px; color: var(--steel); font-variant-numeric: tabular-nums; }
.conv-progress .pfill { height: 100%; background: var(--ink); border-radius: 999px; transition: width 0.2s; }
.conv-done-tip { color: var(--success-text); font-size: 12.5px; font-weight: 600; text-align: center; }
</style>
