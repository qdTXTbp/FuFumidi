<script setup>
// 声库制作（M3b）：上传音频切分 / 录音 → 片段列表 → oto.ini 可视化标注 → 导出声库
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';
import {
  splitSyllables, autoOtoParams, encodeWav16, decodeAudioData, bytesToBase64,
} from '../core/utau_tools';

const app = useAppStore();
const toast = (m, ty) => app.toast(m, ty);
const bridge = window.fuBridge;

const fileInput = ref(null);
const waveCanvas = ref(null);

const srcName = ref('');
const audio = ref(null);          // { data: Float32Array, sr }
const segments = ref([]);         // [{ id, name, startMs, endMs, oto, ownData?, ownSr? }]
const selId = ref(null);
const recOn = ref(false);
const splitParams = ref({ minSilence: 120, minSyllable: 80, silenceDb: -40 });

const selSeg = computed(() => segments.value.find(s => s.id === selId.value) || null);

const MARKERS = [
  { k: 'offset', label: 'offset', c: '#3C2ECA' },
  { k: 'overlap', label: 'overlap', c: '#27D2BF' },
  { k: 'preutterance', label: 'preutterance', c: '#E8463A' },
  { k: 'consonant', label: 'consonant', c: '#EFAA17' },
  { k: 'blank', label: 'blank', c: '#22A5F7' },
];

let _idc = 0;
const nid = () => 'seg' + (++_idc) + Date.now().toString(36);
const r1 = x => Math.round(x * 10) / 10;
const fmtMs = ms => (ms / 1000).toFixed(2) + 's';

/* ---------------- 音频载入与切分 ---------------- */
async function loadAudio(name, bytes) {
  try {
    const ab = bytes instanceof ArrayBuffer ? bytes
      : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const { data, sr } = await decodeAudioData(ab);
    srcName.value = name;
    audio.value = { data, sr };
    segments.value = [];
    selId.value = null;
    autoSplit();
  } catch (e) {
    toast(t('无法解码音频：') + ((e && e.message) || e), 'error');
  }
}

async function onPickAudio() {
  if (bridge && typeof bridge.pickAudio === 'function') {
    try {
      const p = await bridge.pickAudio();
      if (!p) return;
      const b = await bridge.readBinary(p);
      if (!b) { toast(t('读取文件失败'), 'error'); return; }
      await loadAudio(String(p).replace(/^.*[\\/]/, ''), b);
    } catch (e) { toast(t('读取文件失败'), 'error'); }
    return;
  }
  fileInput.value && fileInput.value.click();
}

function onFileChange(e) {
  const f = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!f) return;
  f.arrayBuffer().then(b => loadAudio(f.name, b))
    .catch(() => toast(t('读取文件失败'), 'error'));
}

function autoSplit() {
  if (!audio.value) { toast(t('请先选择音频'), 'warn'); return; }
  const list = splitSyllables(audio.value.data, audio.value.sr, splitParams.value);
  if (!list.length) { toast(t('未找到可切分的音节，请调整参数'), 'warn'); return; }
  segments.value = list.map((s, i) => ({
    id: nid(), name: String(i + 1).padStart(3, '0'),
    startMs: s.startMs, endMs: s.endMs, oto: null,
  }));
  selId.value = segments.value[0].id;
  toast(t('已切分 ') + list.length + t(' 个音节'), 'ok');
}

/* ---------------- 录音 ---------------- */
let mediaRec = null, recChunks = [];
async function toggleRec() {
  if (recOn.value) { mediaRec && mediaRec.stop(); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast(t('浏览器不支持录音'), 'warn'); return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRec = new MediaRecorder(stream);
    recChunks = [];
    mediaRec.ondataavailable = e => { if (e.data && e.data.size) recChunks.push(e.data); };
    mediaRec.onstop = async () => {
      stream.getTracks().forEach(tr => tr.stop());
      try {
        const blob = new Blob(recChunks, { type: mediaRec.mimeType || 'audio/webm' });
        const { data, sr } = await decodeAudioData(await blob.arrayBuffer());
        segments.value.push({
          id: nid(), name: String(segments.value.length + 1).padStart(3, '0'),
          startMs: 0, endMs: data.length / sr * 1000, oto: null,
          ownData: data, ownSr: sr,
        });
        selId.value = segments.value[segments.value.length - 1].id;
        toast(t('已添加录音片段'), 'ok');
      } catch (e2) { toast(t('录音解码失败'), 'error'); }
      recOn.value = false;
    };
    mediaRec.start();
    recOn.value = true;
  } catch (e) {
    toast(t('录制需要麦克风权限'), 'warn');
  }
}

/* ---------------- 片段数据 ---------------- */
function segSlice(s) {
  if (s.ownData) {
    const sr = s.ownSr;
    return { data: s.ownData, sr, start: 0, end: Math.min(s.ownData.length, Math.round(s.endMs * sr / 1000)) };
  }
  const sr = audio.value.sr;
  const start = Math.max(0, Math.round(s.startMs * sr / 1000));
  const end = Math.min(audio.value.data.length, Math.round(s.endMs * sr / 1000));
  return { data: audio.value.data, sr, start, end };
}

function delSeg(id) {
  const i = segments.value.findIndex(s => s.id === id);
  if (i < 0) return;
  segments.value.splice(i, 1);
  if (selId.value === id) selId.value = segments.value.length ? segments.value[Math.min(i, segments.value.length - 1)].id : null;
}

function labelSeg(s) {
  const { data, sr, start, end } = segSlice(s);
  s.oto = autoOtoParams(data.subarray(start, end), sr);
}

function labelAll() {
  for (const s of segments.value) labelSeg(s);
  toast(t('已自动标注全部片段'), 'ok');
}

/* ---------------- 试听 ---------------- */
let actx = null, srcNode = null;
function ensureCtx() {
  if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
  return actx;
}
function playSeg(s) {
  if (srcNode) { try { srcNode.stop(); } catch (e) {} srcNode = null; }
  const { data, sr, start, end } = segSlice(s);
  if (end <= start) return;
  const ctx = ensureCtx();
  if (ctx.state === 'suspended') ctx.resume();
  const buf = ctx.createBuffer(1, end - start, sr);
  buf.copyToChannel(data.subarray(start, end), 0);
  srcNode = ctx.createBufferSource();
  srcNode.buffer = buf;
  srcNode.connect(ctx.destination);
  srcNode.onended = () => { srcNode = null; };
  srcNode.start();
}
function stopPlay() {
  if (srcNode) { try { srcNode.stop(); } catch (e) {} srcNode = null; }
}

/* ---------------- 波形编辑器 ---------------- */
function markAbs(m) {
  const s = selSeg.value;
  if (!s || !s.oto) return 0;
  const dur = s.endMs - s.startMs;
  const o = s.oto;
  const clamp = v => Math.max(0, Math.min(dur, v));
  switch (m.k) {
    case 'offset': return clamp(o.offset || 0);
    case 'overlap': return clamp((o.offset || 0) + (o.overlap || 0));
    case 'preutterance': return clamp((o.offset || 0) + (o.preutterance || 0));
    case 'consonant': return clamp((o.offset || 0) + (o.consonant || 0));
    case 'blank': return clamp(dur - (o.blank || 0));
  }
  return 0;
}

function getBrandColor() {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
    return v || '#4B3FE3';
  } catch (e) { return '#4B3FE3'; }
}

function drawWave() {
  const cv = waveCanvas.value;
  const s = selSeg.value;
  if (!cv || !s) return; // 录音片段自带 ownData，无需 audio.value
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const { data, sr, start, end } = segSlice(s);
  const slice = data.subarray(start, end);
  const n = slice.length;
  const mid = h / 2;
  // 波形（min/max 柱状）
  ctx.strokeStyle = getBrandColor();
  ctx.lineWidth = 1;
  const px = Math.max(1, Math.floor(n / w));
  ctx.beginPath();
  for (let x = 0; x < w; x++) {
    const a = x * px, b = Math.min(n, a + px);
    let mn = 0, mx = 0;
    for (let j = a; j < b; j++) { const v = slice[j]; if (v < mn) mn = v; if (v > mx) mx = v; }
    ctx.moveTo(x, mid - mx * mid * 0.92);
    ctx.lineTo(x, mid - mn * mid * 0.92);
  }
  ctx.stroke();
  // 中线
  ctx.strokeStyle = 'rgba(128,128,128,0.25)';
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

  if (!s.oto) return;
  const dur = s.endMs - s.startMs;
  for (const m of MARKERS) {
    const abs = markAbs(m);
    const x = abs / dur * w;
    ctx.strokeStyle = m.c;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = m.c;
    ctx.fillRect(x - 11, 0, 22, 3);
    ctx.font = '10px sans-serif';
    const right = abs > dur * 0.75;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(m.label, x + (right ? -4 : 4), 11);
  }
}

let dragKey = null;
function onPointerDown(e) {
  const cv = waveCanvas.value;
  const s = selSeg.value;
  if (!cv || !s || !s.oto) return;
  const rect = cv.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const w = rect.width || 1;
  const dur = s.endMs - s.startMs;
  let best = null, bestD = 10;
  for (const m of MARKERS) {
    const d = Math.abs(markAbs(m) / dur * w - x);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (!best) return;
  dragKey = best.k;
  try { cv.setPointerCapture(e.pointerId); } catch (err) {}
  updateDrag(x, w, dur);
}
function onPointerMove(e) {
  if (!dragKey) return;
  const cv = waveCanvas.value;
  if (!cv) return;
  const rect = cv.getBoundingClientRect();
  updateDrag(e.clientX - rect.left, rect.width || 1, selSeg.value.endMs - selSeg.value.startMs);
}
function updateDrag(x, w, dur) {
  const s = selSeg.value;
  if (!s || !s.oto) return;
  const o = s.oto;
  const ms = Math.max(0, Math.min(dur, (x / w) * dur));
  switch (dragKey) {
    case 'offset': o.offset = r1(ms); break;
    case 'overlap': o.overlap = r1(ms - (o.offset || 0)); break;
    case 'preutterance': o.preutterance = r1(ms - (o.offset || 0)); break;
    case 'consonant': o.consonant = r1(ms - (o.offset || 0)); break;
    case 'blank': o.blank = r1(Math.max(5, dur - ms)); break;
  }
  drawWave();
}
function onPointerUp() { dragKey = null; }

function onOtoNum(k, e) {
  const s = selSeg.value;
  if (!s || !s.oto) return;
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) return;
  s.oto[k] = k === 'blank' ? Math.max(5, v) : Math.max(0, v);
  drawWave();
}

/* ---------------- 导出 ---------------- */
async function exportVoicebank() {
  if (!segments.value.length) { toast(t('请先切分或添加片段'), 'warn'); return; }
  const otoLines = segments.value.map(s => {
    const o = s.oto || { offset: 0, consonant: 50, blank: 20, preutterance: 50, overlap: 20 };
    return `${s.name}.wav=${s.name},${o.offset},${o.consonant},${o.blank},${o.preutterance},${o.overlap}`;
  });
  const otoBytes = new TextEncoder().encode(otoLines.join('\n') + '\n');

  if (!bridge || typeof bridge.utauExportVoicebank !== 'function') {
    // 网页版兜底：下载 oto.ini 文本
    const blob = new Blob([otoBytes], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'oto.ini';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast(t('网页版仅下载 oto.ini，请用桌面版导出声库文件夹'), 'warn');
    return;
  }
  const dir = await bridge.pickDirectory();
  if (!dir) return;
  const files = [{ name: 'oto.ini', data: bytesToBase64(otoBytes) }];
  for (const s of segments.value) {
    const { data, sr, start, end } = segSlice(s);
    if (end <= start) continue;
    files.push({ name: s.name + '.wav', data: bytesToBase64(encodeWav16(data.subarray(start, end), sr)) });
  }
  const r = await bridge.utauExportVoicebank({ dir, files });
  if (r && r.ok) toast(t('已导出音源到 ') + dir, 'ok');
  else toast(t('导出失败：') + ((r && r.error) || 'unknown'), 'error');
}

/* 导出为压缩包：采集同样的 oto.ini + wav 列表，由主进程保存为 zip */
async function exportVoicebankZip() {
  if (!segments.value.length) { toast(t('请先切分或添加片段'), 'warn'); return; }
  if (!bridge || typeof bridge.utauExportVoicebankZip !== 'function') {
    toast(t('当前环境不支持压缩包导出，请使用桌面版'), 'warn');
    return;
  }
  const otoLines = segments.value.map(s => {
    const o = s.oto || { offset: 0, consonant: 50, blank: 20, preutterance: 50, overlap: 20 };
    return `${s.name}.wav=${s.name},${o.offset},${o.consonant},${o.blank},${o.preutterance},${o.overlap}`;
  });
  const otoBytes = new TextEncoder().encode(otoLines.join('\n') + '\n');
  const files = [{ name: 'oto.ini', data: bytesToBase64(otoBytes) }];
  for (const s of segments.value) {
    const { data, sr, start, end } = segSlice(s);
    if (end <= start) continue;
    files.push({ name: s.name + '.wav', data: bytesToBase64(encodeWav16(data.subarray(start, end), sr)) });
  }
  const r = await bridge.utauExportVoicebankZip({ files });
  if (r && r.ok) toast(t('已导出压缩包到 ') + (r.path || ''), 'ok');
  else if (r && r.canceled) { /* 用户取消 */ }
  else toast(t('导出失败：') + ((r && r.error) || 'unknown'), 'error');
}

/* ---------------- 响应式重绘 ---------------- */
// 用轻量签名代替 JSON.stringify：segments 内含 Float32Array(ownData)，全量序列化会卡顿
function segSignature() {
  return segments.value.map(s => {
    const o = s.oto;
    return s.id + '|' + s.name + '|' + s.startMs + '|' + s.endMs + '|'
      + (o ? [o.offset, o.consonant, o.blank, o.preutterance, o.overlap].join(',') : '-');
  }).join('~');
}
watch([selId, segSignature, () => (audio.value ? audio.value.data.length : 0)],
  () => { requestAnimationFrame(drawWave); });
function onResize() { requestAnimationFrame(drawWave); }

onMounted(() => { window.addEventListener('resize', onResize); });
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  stopPlay();
});
</script>

<template>
  <div class="vb">
    <div class="vb-toolbar">
      <button class="btn primary" @click="onPickAudio">
        <Icon name="import" :size="14" /> {{ t('上传音频切分') }}
      </button>
      <input ref="fileInput" type="file" accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.opus" hidden @change="onFileChange" />
      <button class="btn sm" :class="{ danger: recOn }" @click="toggleRec">
        <Icon name="mic" :size="14" /> {{ recOn ? t('停止录音') : t('录音') }}
      </button>
      <span v-if="srcName" class="vb-src-name">{{ srcName }}</span>
    </div>

    <div class="vb-params">
      <label>{{ t('最小静音(ms)') }}<input type="number" v-model.number="splitParams.minSilence" class="text-input vb-num" min="20" step="10" /></label>
      <label>{{ t('最小音节(ms)') }}<input type="number" v-model.number="splitParams.minSyllable" class="text-input vb-num" min="20" step="10" /></label>
      <label>{{ t('静音阈值(dB)') }}<input type="number" v-model.number="splitParams.silenceDb" class="text-input vb-num" min="-80" max="0" step="2" /></label>
      <button class="btn sm" @click="autoSplit" :disabled="!audio">{{ t('重新切分') }}</button>
    </div>

    <div v-if="audio || segments.length" class="vb-body">
      <div class="vb-left">
        <div class="vb-left-head">
          <b>{{ t('片段') }} ({{ segments.length }})</b>
          <div class="vb-head-actions">
            <button class="btn sm" @click="labelAll" :disabled="!segments.length">{{ t('自动标注全部') }}</button>
            <button class="btn sm primary" @click="exportVoicebank" :disabled="!segments.length">{{ t('导出音源') }}</button>
            <button class="btn sm" @click="exportVoicebankZip" :disabled="!segments.length">{{ t('导出压缩包') }}</button>
          </div>
        </div>
        <div v-if="!segments.length" class="muted small vb-empty">
          {{ t('切分后在此列出片段，点选后右侧微调。') }}
        </div>
        <div v-else class="vb-segs">
          <div v-for="s in segments" :key="s.id" class="vb-seg" :class="{ on: s.id === selId }" @click="selId = s.id">
            <input class="text-input vb-name" v-model="s.name" @click.stop @keydown.enter="$event.target.blur()" />
            <span class="vb-time">{{ fmtMs(s.startMs) }} – {{ fmtMs(s.endMs) }}</span>
            <span class="vb-tools">
              <button class="icon-btn" :title="t('试听')" @click.stop="playSeg(s)"><Icon name="play2" :size="12" /></button>
              <button class="icon-btn" :title="t('自动标注')" @click.stop="labelSeg(s)"><Icon name="target" :size="12" /></button>
              <button class="icon-btn" :title="t('删除')" @click.stop="delSeg(s.id)"><Icon name="trash" :size="12" /></button>
            </span>
          </div>
        </div>
      </div>

      <div v-if="selSeg" class="vb-right">
        <div class="vb-wave-head">
          <b>{{ t('原音设定微调') }} · {{ selSeg.name }}</b>
          <span class="muted small">{{ t('拖动波形上的标记调整') }}</span>
        </div>
        <canvas ref="waveCanvas" class="vb-wave"
                @pointerdown="onPointerDown" @pointermove="onPointerMove"
                @pointerup="onPointerUp" @pointercancel="onPointerUp"></canvas>
        <div v-if="selSeg.oto" class="vb-oto-grid">
          <div v-for="m in MARKERS" :key="m.k" class="vb-oto-item">
            <span class="vb-dot" :style="{ background: m.c }"></span>
            <span class="vb-oto-k">{{ m.label }}</span>
            <input type="number" class="text-input vb-num" :value="selSeg.oto[m.k]"
                   step="0.5" min="0" @input="onOtoNum(m.k, $event)" />
            <span class="muted small">ms</span>
          </div>
        </div>
        <div v-else class="muted small vb-empty">
          {{ t('点击「自动标注」或右侧按钮生成初始参数。') }}
        </div>
      </div>
    </div>

    <div v-else class="vb-welcome muted">
      <p>{{ t('上传一段按音节逐字录制的音频（字与字之间有静音间隔），自动切分后逐个标注、微调，最后导出声库。') }}</p>
      <p>{{ t('也可以点击「录音」直接录入当前片段。') }}</p>
    </div>
  </div>
</template>

<style scoped>
.vb { padding: 18px 22px; display: flex; flex-direction: column; gap: 12px; min-height: 100%; }
.vb-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.vb-toolbar .btn { min-height: 30px; }
.vb-src-name { margin-left: auto; font-size: 12px; color: var(--stone); max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vb-params { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--stone); background: var(--surface-muted); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; }
.vb-head-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vb-params label { display: inline-flex; align-items: center; gap: 6px; }
.vb-num { width: 76px; padding: 3px 6px; font-size: 12px; }
.vb-body { display: grid; grid-template-columns: 300px 1fr; gap: 14px; flex: 1; min-height: 0; }
.vb-left { display: flex; flex-direction: column; border: 1px solid var(--border); border-radius: 12px; background: var(--canvas); min-height: 0; }
.vb-left-head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--border); font-size: 13px; }
.vb-left-head b { margin-right: auto; }
.vb-empty { padding: 12px; line-height: 1.6; }
.vb-segs { overflow-y: auto; flex: 1; padding: 6px; display: flex; flex-direction: column; gap: 4px; }
.vb-seg { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid transparent; border-radius: 8px; cursor: pointer; }
.vb-seg:hover { background: var(--surface-muted); }
.vb-seg.on { border-color: var(--brand); background: var(--brand-soft); }
.vb-name { width: 56px; padding: 3px 6px; font-size: 12px; }
.vb-time { font-size: 11px; color: var(--stone); flex: 1; min-width: 0; }
.vb-tools { display: inline-flex; gap: 2px; }
.vb-right { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--border); border-radius: 12px; background: var(--canvas); padding: 12px; min-height: 0; }
.vb-wave-head { display: flex; align-items: baseline; gap: 10px; font-size: 13px; }
.vb-wave { width: 100%; height: 220px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-muted); cursor: crosshair; touch-action: none; }
.vb-oto-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.vb-oto-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 5px 9px; border: 1px solid var(--border); border-radius: 8px; }
.vb-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.vb-oto-k { min-width: 78px; color: var(--ink); }
.vb-welcome { padding: 26px 8px; line-height: 1.9; font-size: 13px; }
</style>
