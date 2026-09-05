<script setup>
import { ref, computed, reactive, watch, nextTick, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const currentSong = computed(() => app.currentSong);
const toast = (m, t) => app.toast(m, t);
import { clamp } from '../core/util.js';
import { drawVizWaterfall, drawVizSpectrum, drawVizScope, drawVizChord } from '../core/viz.js';
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
// 核心：离线渲染整曲音频 → AudioBuffer（视频导出复用）
// opts.startSec / opts.endSec：按导出范围切片渲染（时间轴归一化到片段起点），
// 避免整曲渲染后被 -shortest 硬截断导致音乐「被切断/听感变快」
async function renderAudioBuffer(s, opts) {
  const sr = opts.rate || 44100;
  const scale = opts.scale || 1;
  const startSec = Math.max(0, opts.startSec || 0);
  const endSec = opts.endSec != null ? opts.endSec : (s.totalSec / scale);
  const segLen = Math.max(0, endSec - startSec);
  const TAIL = 1.5;
  const totalLen = Math.max(1, Math.ceil((segLen + TAIL) * sr));
  const notes = [];
  for (const tr of s.tracks) {
    const presetName = presetFromMode(opts.mode || 'auto', tr.program, tr.isDrum);
    for (const n of tr.notes) {
      const t0 = s.baseSec(n.start) / scale - startSec;
      const e0 = s.baseSec(n.end) / scale - startSec;
      if (e0 <= 0 || t0 >= segLen + TAIL) continue; // 与片段无交集
      if (e0 <= t0) continue;
      notes.push({ t: Math.max(0, t0), e: e0, midi: n.midi, vel: n.vel, preset: presetName, trk: tr.index });
    }
  }
  notes.sort((a, b) => a.t - b.t);
  if (!notes.length) {
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, totalLen, sr);
    return await ctx.startRendering();
  }
  const BUCKET = 20, RELEASE = 0.6;
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
  for (let k = 0; k < idxs.length; k++) {
    const b = buckets.get(idxs[k]);
    const offSec = b.minT;
    const durSec = (b.maxE - b.minT) + RELEASE;
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, Math.max(1, Math.ceil(durSec * sr)), sr);
    const master = ctx.createGain(); master.gain.value = 1; master.connect(ctx.destination);
    const tgs = [];
    for (let i = 0; i < s.tracks.length; i++) { const tg = ctx.createGain(); tg.gain.value = 1; tg.connect(master); tgs.push(tg); }
    const live = [];
    for (const n of b.notes) playVoice(ctx, n.t - offSec, n.midi, n.vel, n.preset, tgs[n.trk], n.e - offSec, live);
    const buf = await ctx.startRendering();
    rendered.push({ offSec, buf });
  }
  return mixRendered(rendered, sr, totalLen);
}
function audioBufferToWavBytes(buf) {
  const chs = buf.numberOfChannels, len = buf.length, sampleRate = buf.sampleRate;
  const out = new Float32Array(len * chs);
  for (let c = 0; c < chs; c++) { const d = buf.getChannelData(c); const o = c * len; for (let i = 0; i < len; i++) out[o + i] = d[i]; }
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
  return new Uint8Array(ab);
}

// 异步分块 WAV 编码：避免整段音频转换阻塞主线程导致界面卡死
async function audioBufferToWavBytesAsync(buf, onProgress, gain = 1) {
  const chs = buf.numberOfChannels, len = buf.length, sampleRate = buf.sampleRate;
  const out = new Float32Array(len * chs);
  const CHUNK = 262144;
  for (let start = 0; start < len; start += CHUNK) {
    const end = Math.min(len, start + CHUNK);
    for (let c = 0; c < chs; c++) {
      const d = buf.getChannelData(c);
      const o = c * len;
      for (let i = start; i < end; i++) out[o + i] = d[i] * gain;
    }
    if (onProgress) onProgress(end / len);
    await new Promise(r => setTimeout(r, 0));
  }
  const ab = new ArrayBuffer(44 + out.length * 2);
  const v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + out.length * 2, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, chs, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * chs * 2, true);
  v.setUint16(32, chs * 2, true); v.setUint16(34, 16, true);
  ws(36, 'data'); v.setUint32(40, out.length * 2, true);
  for (let p = 44, i = 0; i < out.length; i++, p += 2) {
    const s = Math.max(-1, Math.min(1, out[i]));
    v.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(ab);
}

async function renderAudio() {
  const s = song.value;
  if (!s) { toast(t('请先载入 MIDI 文件'), 'warn'); return; }
  if (busy.value) return;
  busy.value = true; done.value = false; progress.value = 0;
  try {
    const buf = await renderAudioBuffer(s, { rate: rate.value, scale: tempo.value, mode: preset.value });
    const g = clamp(gain.value / 100, 0, 2);
    await downloadWav(buf, s.name, g);
    progress.value = 100; done.value = true;
    toast(t('音频已导出'));
  } catch (e) {
    toast(t('渲染失败：') + String(e.message || e), 'warn');
  } finally { busy.value = false; }
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

async function downloadWav(buf, name, g) {
  const bytes = await audioBufferToWavBytesAsync(buf, (p) => { progress.value = Math.max(progress.value, Math.round(p * 100)); }, g);
  const bridge = window.fuBridge;
  if (bridge && bridge.saveBinary) {
    const r = await bridge.saveBinary({ name: name + '_render.wav', data: Array.from(bytes) });
    if (r && r.ok) toast(t('已保存到：') + r.path, 'ok');
    else if (!(r && r.canceled)) toast(t('保存失败：') + ((r && r.error) || ''), 'warn');
    return;
  }
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const a = document.createElement('a');
  a.download = name + '_render.wav';
  a.href = URL.createObjectURL(blob);
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/* ==================== 视频 / 可视化导出 ==================== */
const VE = reactive({
  format: 'mp4', template: 'landscape', res: '1280x720', fps: 30, quality: 'medium',
  dur: 30, durMode: 'full', durCustom: 30, visual: 'mix', track: 'all', range: 'all', start: 0, end: 30,
  bitrate: 8, bgColor: '#0a0e15', showProgress: true, showChord: true, showTimecode: false,
  showLyrics: true, showWatermark: false, watermarkOpacity: 50, bgImage: null, watermark: null,
  veBusy: false, veProgress: 0, veStage: '', veCancel: false,
});
const veResCustom = ref(false);
const vePreviewEl = ref(null);
function previewWH() {
  if (VE.template === 'portrait') return { w: 360, h: 640 };
  if (VE.template === 'subtitle') return { w: 640, h: 400 };
  return { w: 640, h: 360 };
}
function drawVideoPreview() {
  const canvas = vePreviewEl.value;
  if (!canvas) return;
  const s = song.value;
  if (!s) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  const { w, h } = previewWH();
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const vf = { winSec: 8, melodyTrack: 0, lyricAt: '', pct: 0 };
  try { drawVideoFrame(ctx, w, h, s.secToTick ? s.secToTick(0) : 0, s, null, vf, 0); } catch (e) {}
}
watch(() => [VE.template, VE.bgColor, VE.visual, VE.showProgress, VE.showChord, VE.showTimecode, VE.showLyrics, VE.showWatermark, VE.res, VE.fps, VE.quality, VE.track], () => nextTick(drawVideoPreview), { deep: true });
onMounted(() => nextTick(drawVideoPreview));
function vePickBgImage() { vePickImage((d) => { VE.bgImage = d; }); }
function vePickWatermark() { vePickImage((d) => { VE.watermark = d; }); }
function vePickImage(cb) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  inp.onchange = () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const img = new Image();
    img.onload = () => cb(img);
    img.src = URL.createObjectURL(f);
  };
  inp.click();
}
function loadImageBytes(img) {
  const cv = document.createElement('canvas');
  cv.width = img.naturalWidth || img.width; cv.height = img.naturalHeight || img.height;
  cv.getContext('2d').drawImage(img, 0, 0);
  return cv.toDataURL('image/png');
}
// 实时和弦识别
function detectLiveChord(notes) {
  const pcs = [...new Set(notes.map(n => ((n.midi % 12) + 12) % 12))].sort((a, b) => a - b);
  if (pcs.length < 3) return { name: pcs.length ? '未形成完整三和弦' : '', minor: false };
  const root = pcs[0];
  const has = (iv) => pcs.includes((root + iv) % 12);
  const NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  if (has(4) && has(7)) return { name: NAME[root], minor: false };
  if (has(3) && has(7)) return { name: NAME[root] + 'm', minor: true };
  return { name: NAME[root] + '（近似）', minor: false };
}
const TRACK_COLORS = ['#ff5530', '#ea5ec1', '#1456f0', '#a855f7', '#3daeff', '#1ba673', '#3b82f6', '#f59e0b', '#d45656', '#17437d'];
function drawVideoFrame(ctx, W, H, tick, s, audioBuf, vf, nowSec) {
  const cvar = (n, fb) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb; } catch (e) { return fb; } };
  const mode = VE.visual || 'mix';
  const pad = 14, panelH = 178, rollH = Math.max(120, H - panelH - pad);
  ctx.fillStyle = VE.bgColor || cvar('--canvas', '#0a0f18');
  ctx.fillRect(0, 0, W, H);
  const activeNotes = [];
  for (const tr of s.tracks) {
    if (VE.track === 'melody' && !tr.isDrum && tr.index !== vf.melodyTrack) continue;
    for (const n of tr.notes) if (n.start <= tick && n.end >= tick) activeNotes.push(n);
  }
  if (!drawVideoFrame._state) drawVideoFrame._state = { parts: [], keys: new Set(), lastD: 0, blocks: null, songRef: null };
  const opts = {
    state: drawVideoFrame._state,
    zoom: 1,
    colorScheme: 0,
    showLyrics: !!VE.showLyrics,
    lyricAt: vf.lyricAt || '',
    activeNotes,
  };
  const drawPanelBg = (x, y, w2, h2, title, sub, dot) => {
    ctx.fillStyle = cvar('--surface', '#101826');
    ctx.beginPath(); roundRect(ctx, x, y, w2, h2, 12); ctx.fill();
    ctx.strokeStyle = cvar('--hairline', 'rgba(255,255,255,.08)'); ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = cvar('--ink', '#e8eef7'); ctx.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(title, x + 14, y + 15);
    ctx.fillStyle = dot; ctx.beginPath(); ctx.arc(x + 8, y + 15, 3.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = cvar('--stone', '#5d6b82'); ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(sub, x + w2 - 12, y + 15);
    ctx.strokeStyle = cvar('--hairline', 'rgba(255,255,255,.08)');
    ctx.beginPath(); ctx.moveTo(x + 1, y + 27); ctx.lineTo(x + w2 - 1, y + 27); ctx.stroke();
  };
  if (mode === 'waterfall') {
    drawVizWaterfall(ctx, W, H, s, tick, opts);
  } else {
    // 仪表盘：顶部瀑布 + 底部三卡片
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, W, rollH); ctx.clip();
    drawVizWaterfall(ctx, W, rollH, s, tick, opts);
    ctx.restore();
    const gy = rollH + pad;
    const ch = panelH - 34;
    const cardW = Math.max(60, Math.floor((W - pad * 4) / 3));
    const cards = [
      { title: t('频谱瀑布'), sub: t('竖直下落'), dot: cvar('--accent', '#4f9dff'), draw: (cx, cy, cw, chh) => drawVizSpectrum(ctx, cw, chh, audioBuf, nowSec) },
      { title: t('波形示波器'), sub: t('时域'), dot: '#5ac8fa', draw: (cx, cy, cw, chh) => drawVizScope(ctx, cw, chh, audioBuf, nowSec) },
      { title: t('实时和弦'), sub: t('播放同步'), dot: '#b48ef0', draw: (cx, cy, cw, chh) => drawVizChord(ctx, cw, chh, activeNotes) },
    ];
    cards.forEach((card, i) => {
      const x = pad + i * (cardW + pad), y = gy;
      drawPanelBg(x, y, cardW, panelH, card.title, card.sub, card.dot);
      ctx.save();
      ctx.beginPath(); ctx.rect(x + 8, y + 30, cardW - 16, ch - 8); ctx.clip();
      ctx.translate(x + 8, y + 30);
      card.draw(x + 8, y + 30, cardW - 16, ch - 8);
      ctx.restore();
    });
  }
  if (VE.showLyrics && vf.lyricAt) {
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    const tw = Math.min(W - 80, (vf.lyricAt || '').length * 16 + 32);
    ctx.fillRect((W - tw) / 2, H - 36, tw, 28);
    ctx.fillStyle = '#fff'; ctx.font = '600 15px "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(vf.lyricAt, W / 2, H - 22);
  }
  if (VE.showWatermark && VE.watermark) {
    ctx.globalAlpha = clamp(VE.watermarkOpacity / 100, 0, 1);
    const wmW = Math.min(140, W * 0.2);
    const wmH = wmW * (VE.watermark.height / VE.watermark.width);
    ctx.drawImage(VE.watermark, W - wmW - 16, H - wmH - 16, wmW, wmH);
    ctx.globalAlpha = 1;
  }
  if (VE.showProgress) {
    ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(pad, H - 7, W - pad * 2, 3);
    ctx.fillStyle = '#ff5530'; ctx.fillRect(pad, H - 7, (W - pad * 2) * vf.pct, 3);
  }
  if (VE.showTimecode) {
    ctx.fillStyle = cvar('--ink', '#fff'); ctx.font = '12px Consolas, monospace'; ctx.textAlign = 'right';
    const mm = Math.floor(nowSec / 60), ss = String(Math.floor(nowSec % 60)).padStart(2, '0');
    ctx.fillText(mm + ':' + ss, W - pad - 4, H - 18);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function lyricAtTick(s, tick) {
  let hit = '';
  for (const tr of s.tracks) for (const e of (tr.events || [])) {
    if (e.type === 'lyric' && e.text && e.tick <= tick) hit = e.text;
  }
  return hit;
}
async function renderVideo() {
  const s = song.value;
  const bridge = window.fuBridge;
  if (!s) { toast(t('请先载入 MIDI 文件'), 'warn'); return; }
  if (VE.veBusy) return;
  if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) { toast(t('视频导出不可用（当前内核不支持）'), 'err'); return; }
  VE.veBusy = true; VE.veProgress = 0; VE.veStage = t('准备音频（离线渲染）…'); VE.veCancel = false;
  try {
    let [W, H] = VE.res === 'custom' ? [veResCustom.value ? 1920 : 1920, 1080] : VE.res.split('x').map(Number);
    if (VE.template === 'portrait') { W = 720; H = 1280; }
    else if (VE.template === 'subtitle') { W = 1280; H = 800; }
    if (!W || !H) { W = 1280; H = 720; }
    // 视频时长与起始（需在音频切片渲染前确定）
    const fps = VE.fps || 30;
    let sec = VE.durMode === 'custom' ? Math.max(1, VE.durCustom || 30) : Math.max(1, s.totalSec || VE.durCustom || 30);
    if (sec === 0) sec = Math.min(s.totalSec, 120);
    if (VE.range === 'custom') sec = Math.max(1, VE.end - VE.start);
    sec = Math.min(sec, s.totalSec || sec);
    const startSec = VE.range === 'custom' ? (VE.start || 0) : 0;
    // 1) 离线渲染音频：按导出范围切片（[startSec, startSec+sec] 归一化），
    //    与视频长度严格一致，避免整曲渲染后 -shortest 截断导致音乐「被切断/变快」
    const buf = await renderAudioBuffer(s, { rate: 44100, scale: 1, mode: preset.value, startSec, endSec: startSec + sec });
    VE.veProgress = 10;
    const wavBytes = await audioBufferToWavBytesAsync(buf, (p) => { VE.veProgress = Math.min(100, 10 + Math.round(p * 10)); });
    VE.veStage = t('后台录制中（可继续使用应用）…');
    // 2) 离屏画布录制：必须挂载到 DOM 并移出视口，让 canvas 进入合成器管线，
    //    否则 MediaRecorder 抓不到已 GPU 加速的离屏画布内容 → 视频黑屏（且无需 CUDA/硬件加速）
    const cv = document.createElement('canvas');
    const dpr = 1;
    cv.width = W; cv.height = H;
    cv.style.cssText = 'position:fixed;left:-100000px;top:0;width:' + W + 'px;height:' + H + 'px;z-index:-1;pointer-events:none;';
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');
    const stream = cv.captureStream(fps);
    const bitrate = VE.quality === 'low' ? 4e6 : VE.quality === 'high' ? 16e6 : (VE.quality === 'custom' ? (VE.bitrate * 1e6) : 8e6);
    // 自动尝试多种编码/码率，避免单一种类不支持导致导出失败
    const mimeCandidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    let rec = null, usedMime = null;
    for (const m of mimeCandidates) {
      if (!MediaRecorder.isTypeSupported(m)) continue;
      for (const br of [bitrate, Math.max(1e6, Math.floor(bitrate * 0.6)), 2e6]) {
        try {
          rec = new MediaRecorder(stream, { mimeType: m, videoBitsPerSecond: br });
          usedMime = m;
          break;
        } catch (e) {}
      }
      if (rec) break;
    }
    if (!rec) throw new Error('no supported mime');
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => { console.warn('[video] MediaRecorder error', e); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start(500);
    const start = performance.now();
    const stopRec = () => { try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} setTimeout(() => { try { stream.getTracks().forEach((t2) => t2.stop()); } catch (e) {} }, 300); };
    let cancelFlag = false;
    const melodyTrack = s.tracks.findIndex((tr) => tr.isDrum === false && !/bass|贝斯|低音/.test(tr.name || ''));
    const ivMs = Math.max(16, Math.round(1000 / fps));
    await new Promise((resolve) => {
      const step = () => {
        const nowMs = performance.now();
        if (VE.veCancel || (nowMs - start) / 1000 >= sec) {
          if (VE.veTimer) { clearInterval(VE.veTimer); VE.veTimer = null; }
          stopRec(); resolve(); return;
        }
        const el = (nowMs - start) / 1000;
        const tick = s.secToTick(Math.min(startSec + el, Math.max(0.001, s.totalSec - 0.001)));
        const vf = { winSec: 8, melodyTrack, lyricAt: lyricAtTick(s, tick), pct: (el / sec) };
        // 音频已按片段归一化（从 0 起），频谱/波形用 el；瀑布 tick 用全曲坐标 startSec+el
        drawVideoFrame(ctx, W, H, tick, s, buf, vf, el);
        VE.veProgress = Math.min(97, 10 + (el / sec) * 87);
      };
      VE.veTimer = setInterval(step, ivMs);
      step();
    });
    const webm = new Blob(chunks, { type: 'video/webm' });
    const data = new Uint8Array(await webm.arrayBuffer());
    VE.veStage = t('转码为 MP4…');
    if (bridge && bridge.transcodeVideo) {
      const r = await bridge.transcodeVideo(Array.from(data), Array.from(wavBytes));
      if (r && r.ok) toast(t('视频已导出：') + (r.path || ''), 'ok');
      else if (!(r && r.canceled)) toast(t('视频导出失败：') + ((r && r.error) || ''), 'warn');
    } else {
      const blob = new Blob([webm], { type: 'video/webm' });
      const a = document.createElement('a');
      a.download = s.name + '_video.webm'; a.href = URL.createObjectURL(blob); a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      toast(t('已导出 WebM（桌面版可转 MP4）'), 'ok');
    }
    VE.veProgress = 100;
    VE.veStage = t('完成');
  } catch (e) {
    toast(t('视频导出失败：') + String(e.message || e), 'warn');
  } finally {
    if (VE.veTimer) { clearInterval(VE.veTimer); VE.veTimer = null; }
    try { if (cv && cv.remove) cv.remove(); } catch (e) {}
    VE.veBusy = false;
  }
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
            <option :value="1">{{ t('1×（原速）') }}</option>
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

      <Transition name="cv">
        <div v-if="busy || done" class="conv-progress">
          <div class="pfill" :style="{ width: progress + '%' }"></div>
          <span>{{ progress }}%</span>
        </div>
      </Transition>
      <Transition name="cv">
        <div v-if="done" class="conv-done-tip">✓ {{ t('渲染完成，WAV 已下载') }}</div>
      </Transition>
    </div>

    <!-- ==================== 视频 / 可视化导出 ==================== -->
    <div class="card conv-form ve-card">
      <div class="ve-head">
        <b>{{ t('视频 / 可视化导出') }}</b>
        <span class="muted small">{{ t('把钢琴卷帘动画 + 频谱/波形/和弦渲染为 MP4 视频（本地 ffmpeg 合成）') }}</span>
      </div>
      <div class="ve-preview-wrap" :class="'ve-tpl-' + VE.template">
        <canvas ref="vePreviewEl" class="ve-preview-canvas"></canvas>
        <div v-if="!song" class="ve-preview-empty">{{ t('加载曲目后显示实时预览') }}</div>
      </div>
      <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="field-row">
          <label>{{ t('音色风格') }}</label>
          <select class="select-input" v-model="preset" style="min-width:150px">
            <option v-for="p in PRESETS" :key="p[0]" :value="p[0]">{{ p[1] }}</option>
          </select>
        </div>
<div class="field-row">
          <label>{{ t('可视化模板') }}</label>
          <select class="select-input" v-model="VE.visual">
            <option value="mix">{{ t('仪表盘') }}</option><option value="waterfall">{{ t('瀑布流') }}</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('画面比例') }}</label>
          <select class="select-input" v-model="VE.template">
            <option value="landscape">{{ t('横屏 16:9') }}</option><option value="portrait">{{ t('竖屏 9:16') }}</option><option value="subtitle">{{ t('横屏+底部字幕留白') }}</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('分辨率') }}</label>
          <select class="select-input" v-model="VE.res">
            <option value="1280x720">720P</option><option value="1920x1080">1080P</option><option value="2560x1440">2K</option><option value="3840x2160">4K</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('帧率') }}</label>
          <select class="select-input" v-model.number="VE.fps">
            <option :value="24">24 fps</option><option :value="30">30 fps</option><option :value="60">60 fps</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('质量') }}</label>
          <select class="select-input" v-model="VE.quality">
            <option value="low">{{ t('低') }}</option><option value="medium">{{ t('中') }}</option><option value="high">{{ t('高') }}</option><option value="custom">{{ t('自定义码率') }}</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('码率') }}（Mbps）</label>
          <input type="number" min="0.5" step="0.5" class="num-input" v-model.number="VE.bitrate" style="width:100%" />
        </div>
        <div class="field-row">
          <label>{{ t('时长') }}</label>
          <select class="select-input" v-model="VE.durMode">
            <option value="full">{{ t('整首') }}</option><option value="custom">{{ t('自定义（秒）') }}</option>
          </select>
          <input v-if="VE.durMode === 'custom'" type="number" min="1" step="1" class="num-input" v-model.number="VE.durCustom" style="width:80px" />
        </div>
        <div class="field-row">
          <label>{{ t('导出范围') }}</label>
          <select class="select-input" v-model="VE.range">
            <option value="all">{{ t('整曲') }}</option><option value="custom">{{ t('自定义区间') }}</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('开始 / 结束（秒）') }}</label>
          <div style="display:flex;gap:6px;align-items:center">
            <input type="number" min="0" step="0.1" class="num-input" v-model.number="VE.start" style="flex:1" />
            <span class="muted">-</span>
            <input type="number" min="0" step="0.1" class="num-input" v-model.number="VE.end" style="flex:1" />
          </div>
        </div>
        <div class="field-row">
          <label>{{ t('背景色') }}</label>
          <input type="color" v-model="VE.bgColor" style="width:100%;height:30px;padding:0;border:1px solid var(--hairline);border-radius:6px;background:none;cursor:pointer" />
        </div>
        <div class="field-row">
          <label>{{ t('背景图片') }}</label>
          <button class="btn sm" @click="vePickBgImage">{{ VE.bgImage ? t('更换') : t('选择') }}</button>
          <span v-if="VE.bgImage" class="muted small" @click="VE.bgImage = null" style="cursor:pointer">✕ {{ t('移除') }}</span>
        </div>
        <div class="field-row">
          <label>{{ t('水印') }}</label>
          <button class="btn sm" @click="vePickWatermark">{{ VE.watermark ? t('更换') : t('选择') }}</button>
          <input v-if="VE.watermark" type="range" min="0" max="100" v-model.number="VE.watermarkOpacity" style="width:100%" />
        </div>
      </div>
      <div class="ve-opts">
        <label><input type="checkbox" v-model="VE.showProgress" /> {{ t('进度条') }}</label>
        <label><input type="checkbox" v-model="VE.showChord" /> {{ t('实时和弦') }}</label>
        <label><input type="checkbox" v-model="VE.showTimecode" /> {{ t('时间码') }}</label>
        <label><input type="checkbox" v-model="VE.showLyrics" /> {{ t('歌词字幕') }}</label>
        <label><input type="checkbox" v-model="VE.showWatermark" /> {{ t('水印') }}</label>
      </div>
      <button class="btn primary big" @click="renderVideo" :disabled="VE.veBusy || !song">
        <Icon name="play2" :size="16" />{{ VE.veBusy ? VE.veStage || t('导出中…') : t('导出视频 MP4') }}
      </button>
      <Transition name="cv">
        <div v-if="VE.veBusy" class="conv-progress">
          <div class="pfill" :style="{ width: VE.veProgress + '%' }"></div>
          <span>{{ Math.round(VE.veProgress) }}%</span>
        </div>
      </Transition>
      <Transition name="cv">
        <button v-if="VE.veBusy" class="btn sm danger" @click="VE.veCancel = true">{{ t('取消导出') }}</button>
      </Transition>
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
.conv-progress .pfill { height: 100%; background: var(--accent); border-radius: 999px; transition: width 0.2s; }
.conv-done-tip { color: var(--success-text); font-size: 12.5px; font-weight: 600; text-align: center; }
/* 转换页进度/完成提示显隐过渡 */
.cv-enter-active, .cv-leave-active { transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.2, 0.9, 0.3, 1.18); }
.cv-enter-from, .cv-leave-to { opacity: 0; transform: translateY(6px); }
.ve-card { margin-top: 18px; padding: 18px; }
.ve-head { display: flex; flex-direction: column; gap: 4px; }
.ve-head b { font-size: 15px; color: var(--ink); }
.ve-preview-wrap { position: relative; width: 100%; background: var(--surface-soft); border: 1px solid var(--hairline); border-radius: 12px; overflow: hidden; }
.ve-preview-wrap.ve-tpl-landscape { aspect-ratio: 16 / 9; }
.ve-preview-wrap.ve-tpl-portrait { aspect-ratio: 9 / 16; max-width: 320px; }
.ve-preview-wrap.ve-tpl-subtitle { aspect-ratio: 16 / 10; }
.ve-preview-canvas { width: 100%; height: 100%; display: block; }
.ve-preview-empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--stone); font-size: 12px; pointer-events: none; }
.ve-opts { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12.5px; color: var(--slate); }
.ve-opts label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.ve-opts input[type=checkbox] { accent-color: var(--ink); }
.num-input { width: 100%; padding: 6px 8px; font-size: 12px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 8px; color: var(--ink); outline: none; box-sizing: border-box; }
</style>
