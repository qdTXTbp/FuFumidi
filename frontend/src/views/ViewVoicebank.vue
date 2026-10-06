<script setup>
// 声库制作（M3b）：上传音频切分 / 录音 → 片段列表 → oto.ini 可视化标注 → 导出声库
import { ref, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';
import {
  splitSyllables, autoOtoParams, encodeWav16, decodeAudioData, bytesToBase64,
} from '../core/utau_tools';
import {
  encodeOtoText, decodeOtoBytes, otoUnsupported, sjisTableInfo, OTO_ENCODINGS, isOtoEncoding,
} from '../core/shift_jis.js';
import { computeSpectrogram, drawSpectrogram } from '../core/spectrogram.js';

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

/* ---------------- 本轮（M8e）新增的三个视图状态 ----------------
   1. 右栏两种形态：波形微调（逐片段） / 参数一览表（一屏核对 + 批量改）
   2. oto.ini 编码：UTAU 传统声库要 Shift-JIS，导 UTF-8 进去是乱码
   3. 频域底图：时域看切分、频域看辅音/元音差别 */
const savedEnc = (() => { try { return localStorage.getItem('fufumidi_oto_enc'); } catch (e) { return null; } })();
const otoEnc = ref(isOtoEncoding(savedEnc) ? savedEnc : 'sjis');
const savedPane = (() => { try { return localStorage.getItem('fufumidi_vb_pane'); } catch (e) { return null; } })();
const rightPane = ref(savedPane === 'table' ? 'table' : 'wave');
const savedSpec = (() => { try { return localStorage.getItem('fufumidi_vb_spec'); } catch (e) { return null; } })();
const specOn = ref(savedSpec !== '0');
/** 一览表每列表头的「统一为」输入框 */
const bulkVal = ref({ offset: 0, overlap: 0, preutterance: 0, consonant: 0, blank: 20 });
watch(otoEnc, v => { try { localStorage.setItem('fufumidi_oto_enc', v); } catch (e) {} });
watch(rightPane, v => { try { localStorage.setItem('fufumidi_vb_pane', v); } catch (e) {} });
watch(specOn, v => { try { localStorage.setItem('fufumidi_vb_spec', v ? '1' : '0'); } catch (e) {} });
// 提示文案走 i18n：编码名是专有名词，不翻译，但"给谁用"这句话要翻
const encHint = computed(() => t((OTO_ENCODINGS.find(e => e.id === otoEnc.value) || {}).hint || ''));

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

/* 频谱底图缓存：拖标记时每帧重算 STFT 是浪费（片段没换就没必要重算） */
let specCache = { key: '', spec: null };
/** 最近一次画出来的谱图信息（帧数 / 频点数）——验收时要能证明"真的算了谱"，而不是只画了波形 */
let lastSpecInfo = null;
function segmentSpectrogram(s, start, end) {
  const key = s.id + '|' + start + '|' + end;
  if (specCache.key === key) return specCache.spec;
  const { data, sr } = segSlice(s);
  const spec = computeSpectrogram(data.subarray(start, end), sr, { fft: 1024, hop: 256 });
  specCache = { key, spec };
  return spec;
}
function peakDbOf(spec) {
  let mx = -999;
  for (let i = 0; i < spec.db.length; i++) if (spec.db[i] > mx) mx = spec.db[i];
  return mx;
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
  // 频域底图（低频在下）：辅音/元音的差别在时域里看不出来，在频域里一眼能分
  if (specOn.value && n > 64) {
    const spec = segmentSpectrogram(s, start, end);
    if (spec && spec.frames) {
      drawSpectrogram(ctx, spec, 0, 0, w, h, { grid: true });
      lastSpecInfo = { frames: spec.frames, bins: spec.bins, sr: spec.sr, peakDb: Math.round(peakDbOf(spec) * 10) / 10 };
    }
  } else { lastSpecInfo = null; }
  // 波形（min/max 柱状）—— 压在频谱上时用亮色描边 + 半透明白芯，保证两条信息都读得出来
  // 压在频谱上时压到 0.55：0.82 的白色会把频域信息整个盖掉（实测：频谱 3312 色 → 被白块糊成一片）
  ctx.strokeStyle = specOn.value && n > 64 ? 'rgba(255,255,255,0.55)' : getBrandColor();
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
  ctx.font = '10px sans-serif';
  MARKERS.forEach((m, i) => {
    const abs = markAbs(m);
    const x = abs / dur * w;
    ctx.strokeStyle = m.c;
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
    ctx.fillStyle = m.c;
    /* 标签分两行交错：五个标记挤在一起时（offset/overlap/preutterance/consonant 常常只差几十毫秒）
       单行标签会叠成一团 —— 实测 "preutteranceconsonant" 糊在一起。再描一层深色边，
       压在亮频谱上也读得清。 */
    const ly = 11 + (i % 2) * 12;
    ctx.fillRect(x - 11, ly - 9, 22, 3);
    const right = abs > dur * 0.75;
    ctx.textAlign = right ? 'right' : 'left';
    const tx = x + (right ? -4 : 4);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.strokeText(m.label, tx, ly);
    ctx.fillStyle = m.c;
    ctx.fillText(m.label, tx, ly);
  });
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

/* ---------------- 参数一览表（一屏核对 + 批量改） ---------------- */
// 以前只能"点一个片段、改一组参数"，24 个片段就要点 24 次；一览表把所有片段的
// offset / overlap / preutterance / consonant / blank 摆成一屏，并且每列都能一次统一。
function ensureOto(s) {
  if (!s.oto) s.oto = { ...OTO_DEFAULT };
  return s.oto;
}
function onCell(k, s, e) {
  const v = parseFloat(e.target.value);
  if (!Number.isFinite(v)) return;
  ensureOto(s)[k] = k === 'blank' ? Math.max(5, v) : Math.max(0, v);
  if (selId.value !== s.id) selId.value = s.id;
  drawWave();
}
/** 把某一列统一成表头那个值（整批录音的 blank/offset 常常要一致） */
function applyCol(k) {
  const v = Math.max(k === 'blank' ? 5 : 0, Number(bulkVal.value[k]) || 0);
  for (const s of segments.value) ensureOto(s)[k] = v;
  bulkVal.value[k] = v;
  toast(t('已把全部片段的 ') + k + t(' 统一为 ') + v, 'ok');
  drawWave();
}
function unlabeledCount() { return segments.value.filter(s => !s.oto).length; }

/* ---------------- oto.ini 组装（导出与验收共用同一份） ---------------- */
// 参数顺序就是 oto.ini 的顺序：offset, consonant, blank, preutterance, overlap
const OTO_DEFAULT = { offset: 0, consonant: 50, blank: 20, preutterance: 50, overlap: 20 };
function otoLine(s) {
  const o = s.oto || OTO_DEFAULT;
  return `${s.name}.wav=${s.name},${o.offset},${o.consonant},${o.blank},${o.preutterance},${o.overlap}`;
}
function buildOtoText() { return segments.value.map(otoLine).join('\n') + '\n'; }
/** 按选定编码出字节：Shift-JIS 是老 UTAU 认的编码，UTF-8 给 OpenUtau / 现代工具 */
function buildOtoBytes(enc) { return encodeOtoText(buildOtoText(), enc || otoEnc.value); }
/** 声库文件清单：oto.ini（按选定编码）+ 每个片段一个 wav */
function makeVoicebankFiles(enc) {
  const files = [{ name: 'oto.ini', data: bytesToBase64(buildOtoBytes(enc)) }];
  for (const s of segments.value) {
    const { data, sr, start, end } = segSlice(s);
    if (end <= start) continue;
    files.push({ name: s.name + '.wav', data: bytesToBase64(encodeWav16(data.subarray(start, end), sr)) });
  }
  return files;
}
function encLabel() { const e = OTO_ENCODINGS.find(x => x.id === otoEnc.value); return e ? e.label : otoEnc.value; }
/** Shift-JIS 里没有的字符（例如简体汉字）会变成 '?' —— 先告诉用户，别让他导出后才发现 */
function warnUnencodable() {
  if (otoEnc.value !== 'sjis') return;
  const miss = otoUnsupported(buildOtoText());
  if (miss.length) toast(t('这些字符在 Shift-JIS 里没有，导出会变成 ?：') + miss.join(' '), 'warn');
}

/* ---------------- 导出 ---------------- */
async function exportVoicebank() {
  if (!segments.value.length) { toast(t('请先切分或添加片段'), 'warn'); return; }
  warnUnencodable();
  if (!bridge || typeof bridge.utauExportVoicebank !== 'function') {
    // 网页版兜底：下载 oto.ini 文本（浏览器只能给 UTF-8，桌面版才能出 Shift-JIS）
    const blob = new Blob([buildOtoBytes('utf8')], { type: 'text/plain;charset=utf-8' });
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
  const r = await bridge.utauExportVoicebank({ dir, files: makeVoicebankFiles() });
  if (r && r.ok) toast(t('已导出音源到 ') + dir + ' · oto.ini = ' + encLabel(), 'ok');
  else toast(t('导出失败：') + ((r && r.error) || 'unknown'), 'error');
}

/* 导出为压缩包：采集同样的 oto.ini + wav 列表，由主进程保存为 zip */
async function exportVoicebankZip() {
  if (!segments.value.length) { toast(t('请先切分或添加片段'), 'warn'); return; }
  if (!bridge || typeof bridge.utauExportVoicebankZip !== 'function') {
    toast(t('当前环境不支持压缩包导出，请使用桌面版'), 'warn');
    return;
  }
  warnUnencodable();
  const r = await bridge.utauExportVoicebankZip({ files: makeVoicebankFiles() });
  if (r && r.ok) toast(t('已导出压缩包到 ') + (r.path || '') + ' · oto.ini = ' + encLabel(), 'ok');
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

onMounted(() => {
  window.addEventListener('resize', onResize);
  /* 验收桥（与音乐编辑器 / 调教页同一套开关）：生产包里也能用，只有 fufumidi_debug=1 时才挂。
     没有它，这个页面里"造片段 → 导出 → 验字节"这条路完全无法自动化（上传音频要走系统对话框）。 */
  if (localStorage.getItem('fufumidi_debug') === '1') {
    window.__vbDebug = {
      segments, selId, audio, splitParams, otoEnc, rightPane, specOn, bulkVal,
      autoSplit, labelAll, drawWave, playSeg, applyCol, onCell, ensureOto, unlabeledCount,
      buildOtoText, buildOtoBytes, makeVoicebankFiles, otoLine,
      encodeOtoText, decodeOtoBytes, otoUnsupported, sjisTableInfo,
      specInfo: () => lastSpecInfo,
      tableRows: () => document.querySelectorAll('.vb-table tbody tr').length,
      tableUnlabeledRows: () => document.querySelectorAll('.vb-table tbody tr.unlabeled').length,
      waveCanvas: () => waveCanvas.value,
    };
  }
});
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
      <label class="vb-enc">{{ t('oto.ini 编码') }}
        <select class="text-input vb-sel" v-model="otoEnc">
          <option v-for="e in OTO_ENCODINGS" :key="e.id" :value="e.id">{{ e.label }}</option>
        </select>
        <span class="muted small">{{ encHint }}</span>
      </label>
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

      <div v-if="selSeg || segments.length" class="vb-right">
        <div class="vb-wave-head">
          <b>{{ t('原音设定微调') }} · {{ selSeg ? selSeg.name : t('全部片段') }}</b>
          <span class="vb-pane-tabs">
            <button class="btn sm" :class="{ primary: rightPane === 'wave' }" @click="rightPane = 'wave'">
              <Icon name="viz" :size="12" /> {{ t('波形微调') }}
            </button>
            <button class="btn sm" :class="{ primary: rightPane === 'table' }" @click="rightPane = 'table'">
              <Icon name="chart" :size="12" /> {{ t('参数一览表') }}
            </button>
          </span>
          <label v-if="rightPane === 'wave'" class="vb-spec-toggle">
            <input type="checkbox" v-model="specOn" /> {{ t('频域底图') }}
          </label>
          <span class="muted small">{{ rightPane === 'wave' ? t('拖动波形上的标记调整') : t('一屏核对全部片段，每列都能统一') }}</span>
        </div>

        <template v-if="rightPane === 'wave'">
          <canvas ref="waveCanvas" class="vb-wave"
                  @pointerdown="onPointerDown" @pointermove="onPointerMove"
                  @pointerup="onPointerUp" @pointercancel="onPointerUp"></canvas>
          <div v-if="selSeg && selSeg.oto" class="vb-oto-grid">
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
        </template>

        <div v-else class="vb-table-wrap">
          <table class="vb-table">
            <thead>
              <tr>
                <th class="vb-th-idx">#</th>
                <th>{{ t('片段') }}</th>
                <th v-for="m in MARKERS" :key="m.k" class="vb-th-param">
                  <span class="vb-th-name"><span class="vb-dot" :style="{ background: m.c }"></span>{{ m.label }}</span>
                  <span class="vb-col-apply">
                    <input type="number" class="text-input vb-num vb-num-sm" v-model.number="bulkVal[m.k]" step="0.5"
                           :title="t('把这一列全部改成这个值')" />
                    <button class="icon-btn" :title="t('把这一列全部改成这个值')" @click="applyCol(m.k)"><Icon name="chevron" :size="11" /></button>
                  </span>
                </th>
                <th>{{ t('时长') }}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(s, i) in segments" :key="s.id" :class="{ on: s.id === selId, unlabeled: !s.oto }" @click="selId = s.id">
                <td class="vb-td-idx">{{ i + 1 }}</td>
                <td><input class="text-input vb-name" v-model="s.name" @click.stop /></td>
                <td v-for="m in MARKERS" :key="m.k">
                  <input type="number" class="text-input vb-num" :value="s.oto ? s.oto[m.k] : ''"
                         :placeholder="s.oto ? '' : '—'" step="0.5" min="0"
                         @click.stop @input="onCell(m.k, s, $event)" />
                </td>
                <td class="vb-td-dur">{{ Math.round(s.endMs - s.startMs) }} ms</td>
                <td class="vb-td-act">
                  <!-- ★ 必须套一层 inline-flex：.icon-btn 是 display:grid，直接放 td 里会各占一行，
                       一行 34px × 2 → 整行被撑到 75px（实测），表就变成了"每行一格大空" -->
                  <span class="vb-tools">
                    <button class="icon-btn" :title="t('试听')" @click.stop="playSeg(s)"><Icon name="play2" :size="12" /></button>
                    <button class="icon-btn" :title="t('删除')" @click.stop="delSeg(s.id)"><Icon name="trash" :size="12" /></button>
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="unlabeledCount()" class="muted small vb-table-hint">
            {{ t('虚线的片段还没标注：直接在表里填数就是标注。') }}
          </div>
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
.vb { padding: 0; display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.vb-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: nowrap; overflow-x: auto; flex: none; }
.vb-toolbar .btn { min-height: var(--ctl-h); }
.vb-src-name { margin-left: auto; font-size: 12px; color: var(--stone); max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vb-params { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; font-size: 12px; color: var(--stone); background: var(--surface-muted); border: 1px solid var(--border); border-radius: 10px; padding: 8px 10px; }
.vb-head-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.vb-params label { display: inline-flex; align-items: center; gap: 6px; }
.vb-num { width: 76px; padding: 3px 6px; font-size: 12px; }
.vb-body { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 14px; flex: 1; min-height: 0; }
/* 窄窗口回退单列：左栏（切分列表）折到上方，避免右侧波形被压到溢出 */
@media (max-width: 860px) {
  .vb-body { grid-template-columns: minmax(0, 1fr); }
  .vb-left { max-height: 42vh; }
}
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
/* 波形高度跟随窗口：短窗口下不再把右栏（波形 + oto 网格）撑出可视区 */
.vb-wave { width: 100%; height: clamp(150px, 26vh, 260px); border: 1px solid var(--border); border-radius: 8px; background: var(--surface-muted); cursor: crosshair; touch-action: none; }
.vb-oto-grid { display: flex; flex-wrap: wrap; gap: 10px; }
.vb-oto-item { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 5px 9px; border: 1px solid var(--border); border-radius: 8px; }
.vb-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.vb-oto-k { min-width: 78px; color: var(--ink); }
.vb-welcome { padding: 26px 8px; line-height: 1.9; font-size: 13px; }

/* ---- M8e：编码切换 / 一览表 / 频域底图 ---- */
.vb-enc { margin-left: auto; gap: 4px; }
.vb-sel { width: 118px; padding: 3px 6px; font-size: 12px; }
.vb-pane-tabs { display: inline-flex; gap: 4px; }
.vb-spec-toggle { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--stone); }
.vb-table-wrap { overflow: auto; flex: 1; min-height: 0; border: 1px solid var(--border); border-radius: 8px; }
.vb-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.vb-table th { position: sticky; top: 0; z-index: 1; background: var(--surface-muted); border-bottom: 1px solid var(--border); padding: 5px 6px; text-align: left; font-weight: 600; white-space: nowrap; }
.vb-table td { border-bottom: 1px solid var(--border); padding: 3px 6px; }
.vb-table tr.on td { background: var(--brand-soft); }
/* 没标注过的片段用虚线输入框标出来：一览表里"哪几行还是空的"要一眼看见 */
.vb-table tr.unlabeled .vb-num { border-style: dashed; }
.vb-table th { padding: 4px 5px; }
.vb-table td { padding: 2px 5px; }
.vb-table .vb-num { width: 58px; padding: 2px 4px; }
.vb-table .vb-name { width: 52px; padding: 2px 4px; }
/* 表头两行：第一行参数名，第二行「统一为」输入 + 应用按钮。
   单行摆（名字 输入 按钮）会把每列撑到 ~190px，5 列参数必然横向裁掉（实测 1042px 塞进 662px）。 */
.vb-th-param { white-space: nowrap; }
/* 列宽由表头决定：参数名用 11px，'preutterance' 这种长名字才不会把列撑到 104px */
.vb-th-name { display: flex; align-items: center; gap: 4px; font-size: 11px; }
.vb-col-apply { display: flex; align-items: center; gap: 2px; margin-top: 2px; }
/* ⚠ 要写成 .vb-table .vb-num-sm：上面那条 .vb-table .vb-num（0,2,0）比 .vb-num-sm（0,1,0）更具体，
   否则表头那个"统一为"输入框仍是 58px，列宽被顶到 104px，5 列参数横向溢出（实测两次） */
.vb-table .vb-num-sm { width: 40px; padding: 1px 3px; font-size: 11px; }
.vb-th-idx, .vb-td-idx { width: 18px; color: var(--stone); }
.vb-td-dur { white-space: nowrap; color: var(--stone); }
.vb-td-act { width: 72px; }
.vb-table-hint { padding: 8px 10px; border-top: 1px solid var(--border); }
</style>
