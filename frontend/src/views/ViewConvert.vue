<script setup>
import { ref, computed, reactive, watch, nextTick, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { t } from '../core/i18n.js';

const app = useAppStore();
const currentSong = computed(() => app.currentSong);
const toast = (m, t) => app.toast(m, t);
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
// 核心：离线渲染整曲音频 → AudioBuffer（视频导出复用）
async function renderAudioBuffer(s, opts) {
  const sr = opts.rate || 44100;
  const scale = opts.scale || 1;
  const totalSec = s.totalSec / scale;
  const TAIL = 1.5;
  const totalLen = Math.max(1, Math.ceil((totalSec + TAIL) * sr));
  const notes = [];
  for (const tr of s.tracks) {
    const presetName = presetFromMode(opts.mode || 'auto', tr.program, tr.isDrum);
    for (const n of tr.notes) {
      const t = s.baseSec(n.start) / scale;
      const e = s.baseSec(n.end) / scale;
      if (e <= t) continue;
      notes.push({ t, e, midi: n.midi, vel: n.vel, preset: presetName, trk: tr.index });
    }
  }
  notes.sort((a, b) => a.t - b.t);
  if (!notes.length) {
    const ctx = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(2, totalLen, sr);
    return await ctx.startRendering();
  }
  const BUCKET = 10, RELEASE = 0.6;
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

async function renderAudio() {
  const s = song.value;
  if (!s) { toast(t('请先载入 MIDI 文件'), 'warn'); return; }
  if (busy.value) return;
  busy.value = true; done.value = false; progress.value = 0;
  try {
    const buf = await renderAudioBuffer(s, { rate: rate.value, scale: tempo.value, mode: preset.value });
    const g = clamp(gain.value / 100, 0, 2);
    downloadWav(buf, s.name, g);
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

/* ==================== 视频 / 可视化导出 ==================== */
const VE = reactive({
  format: 'mp4', template: 'landscape', res: '1280x720', fps: 30, quality: 'medium',
  dur: 30, visual: 'mix', track: 'all', range: 'all', start: 0, end: 30,
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
  const C = { bg: VE.bgColor || '#0a0e15', card: '#101826', line: 'rgba(255,255,255,.10)', text: '#e8eef7', sub: '#7a8aa6', accent: '#4f9dff', green: '#34d399', magenta: '#f472b6' };
  const isDark = true;
  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  if (VE.bgImage) {
    const bi = VE.bgImage, bs = Math.max(W / bi.width, H / bi.height), bw = bi.width * bs, bh = bi.height * bs;
    ctx.drawImage(bi, (W - bw) / 2, (H - bh) / 2, bw, bh);
    ctx.fillStyle = 'rgba(10,14,21,.55)'; ctx.fillRect(0, 0, W, H);
  }
  const secPerTick = s.totalSec > 0 ? s.totalSec / s.totalTicks : 0;
  const nowSec2 = Math.max(0, tick * secPerTick);
  const pad = 14, headH = 36, panelH = 175;
  const rollH = Math.max(120, H - panelH - pad - 10);
  const drawRoll = () => {
    const winSec = vf.winSec || 8;
    const x0 = pad, xw = W - pad * 2;
    ctx.fillStyle = C.card; roundRect(ctx, 0, 0, W, rollH, 14); ctx.fill();
    ctx.fillStyle = C.text; ctx.font = '600 13px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText('音符瀑布', pad + 14, headH / 2);
    ctx.fillStyle = C.sub; ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'right';
    ctx.fillText('Synthesia · 播放同步', W - pad - 12, headH / 2);
    ctx.fillStyle = C.line; ctx.fillRect(pad, headH, W - pad * 2, 1);
    const bodyY = headH + 8, bodyH = rollH - headH - 14;
    const t0 = tick - secPerTick ? Math.max(0, tick - winSec / secPerTick) : 0;
    const t1 = tick;
    const lo = 21, hi = 108;
    // 键盘行
    const rowHh = bodyH / (hi - lo);
    for (let m = lo; m <= hi; m++) {
      const pc = ((m % 12) + 12) % 12;
      if ([1, 3, 6, 8, 10].includes(pc)) { ctx.fillStyle = 'rgba(255,255,255,.05)'; ctx.fillRect(x0, bodyY + (hi - m) * rowHh, xw, rowHh); }
      if (pc === 0) { ctx.fillStyle = 'rgba(255,255,255,.12)'; ctx.fillRect(x0, bodyY + (hi - m) * rowHh, xw, rowHh); }
    }
    const pxPerTick = xw / Math.max(1, t1 - t0);
    const active = [];
    for (const tr of s.tracks) {
      if (VE.track === 'melody' && !tr.isDrum && tr.index !== vf.melodyTrack) continue;
      const col = TRACK_COLORS[tr.index % TRACK_COLORS.length];
      for (const n of tr.notes) {
        if (n.end < t0 || n.start > t1) continue;
        const x = x0 + (n.start - t0) * pxPerTick;
        const y = bodyY + (hi - n.midi) * rowHh;
        const w2 = Math.max(2, (n.end - n.start) * pxPerTick);
        ctx.globalAlpha = .88; ctx.fillStyle = col;
        ctx.fillRect(x, y + 1, w2, rowHh - 2);
        ctx.globalAlpha = 1;
        if (n.start <= tick && n.end >= tick) active.push(n);
      }
    }
    // 播放线（右侧，当前 tick）
    const px = x0 + (tick - t0) * pxPerTick;
    ctx.strokeStyle = 'rgba(255,90,60,.85)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(px, bodyY); ctx.lineTo(px, bodyY + bodyH); ctx.stroke();
    return active;
  };
  const drawPanel = (x, y, w2, h2, title, drawBody) => {
    ctx.fillStyle = C.card; roundRect(ctx, x, y, w2, h2, 12); ctx.fill();
    ctx.strokeStyle = C.line; ctx.lineWidth = 1; roundRect(ctx, x, y, w2, h2, 12); ctx.stroke();
    ctx.fillStyle = C.text; ctx.font = '600 12px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(title, x + 14, y + 15);
    ctx.strokeStyle = C.line; ctx.strokeRect(x + 1, y + 27, w2 - 2, 1);
    ctx.save(); ctx.beginPath(); roundRect(ctx, x, y, w2, h2, 12); ctx.clip();
    drawBody(x + 8, y + 32, w2 - 16, h2 - 40);
    ctx.restore();
  };
  const activeNotes = drawRoll();
  const gy = rollH + pad + 4;
  const mode = VE.visual || 'mix';
  const cardW = Math.max(60, Math.floor((W - pad * 3) / 3));
  const drawSpectrumBody = (bx, by, bw, bh) => {
    if (audioBuf) {
      const data = audioBuf.getChannelData(0), sr = audioBuf.sampleRate;
      const i0 = Math.max(0, Math.floor(nowSec2 * sr));
      const windowSec = 2, step = Math.max(1, Math.floor(sr * 0.02));
      const nBars = 48;
      for (let i = 0; i < nBars; i++) {
        const t = nowSec2 - (windowSec * (nBars - 1 - i) / nBars);
        if (t < 0) continue;
        const si = Math.max(0, Math.floor(t * sr)), si2 = Math.min(data.length, si + step);
        let sum = 0;
        for (let j = si; j < si2; j++) sum += data[j] * data[j];
        const rms = Math.min(1, Math.sqrt(sum / Math.max(1, si2 - si)) * 3);
        const bh2 = Math.max(1, rms * bh);
        ctx.fillStyle = 'rgba(79,157,255,' + (0.25 + rms * 0.7) + ')';
        ctx.fillRect(bx + i * (bw / nBars), by + bh - bh2, Math.max(1, bw / nBars - 1), bh2);
      }
    }
  };
  const drawScopeBody = (bx, by, bw, bh) => {
    if (audioBuf) {
      const data = audioBuf.getChannelData(0), sr = audioBuf.sampleRate;
      const win = Math.floor(sr * 0.05);
      const i0 = Math.max(0, Math.floor(nowSec2 * sr));
      ctx.strokeStyle = '#4f9dff'; ctx.lineWidth = 1.4; ctx.beginPath();
      const n = Math.min(win, data.length - i0);
      for (let i = 0; i < n; i += 2) {
        const x = bx + i / Math.max(1, n) * bw;
        const y = by + bh / 2 + data[i0 + i] * bh * 0.45;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  };
  const chord = detectLiveChord(activeNotes);
  const drawChordBody = (bx, by, bw, bh) => {
    ctx.fillStyle = C.text; ctx.font = '700 26px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(chord.name || '—', bx + bw / 2, by + bh / 2);
    ctx.fillStyle = C.sub; ctx.font = '11px "Segoe UI", "Microsoft YaHei", sans-serif';
    ctx.fillText(activeNotes.length ? activeNotes.length + ' 个发声音符' : '播放时显示实时和弦', bx + bw / 2, by + bh / 2 + 24);
  };
  if (mode === 'waterfall') {
    // 只保留音符瀑布
  } else if (mode === 'spectrum') {
    drawPanel(pad, gy, W - pad * 2, Math.max(150, H - gy - 36), '频谱瀑布', drawSpectrumBody);
  } else if (mode === 'scope') {
    drawPanel(pad, gy, W - pad * 2, Math.max(150, H - gy - 36), '波形示波器', drawScopeBody);
  } else if (mode === 'chord') {
    drawPanel(pad, gy, W - pad * 2, Math.max(150, H - gy - 36), '实时和弦', drawChordBody);
  } else {
    drawPanel(pad, gy, cardW, panelH, '频谱瀑布', drawSpectrumBody);
    drawPanel(pad + cardW + pad, gy, cardW, panelH, '波形示波器', drawScopeBody);
    drawPanel(pad + (cardW + pad) * 2, gy, cardW, panelH, '实时和弦', drawChordBody);
  }
  // 歌词字幕
  if (VE.showLyrics) {
    const lyr = vf.lyricAt;
    if (lyr) {
      ctx.fillStyle = 'rgba(0,0,0,.55)';
      const tw = Math.min(W - 80, ctx.measureText ? lyr.length * 16 + 32 : W);
      ctx.fillRect((W - tw) / 2, gy + panelH + 8, tw, 30);
      ctx.fillStyle = '#fff'; ctx.font = '600 16px "Segoe UI", "Microsoft YaHei", sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(lyr, W / 2, gy + panelH + 23);
    }
  }
  // 水印
  if (VE.showWatermark && VE.watermark) {
    ctx.globalAlpha = clamp(VE.watermarkOpacity / 100, 0, 1);
    const wmW = Math.min(140, W * 0.2);
    ctx.drawImage(VE.watermark, W - wmW - 16, H - wmW * (VE.watermark.height / VE.watermark.width) - 16, wmW, wmW * (VE.watermark.height / VE.watermark.width));
    ctx.globalAlpha = 1;
  }
  // 进度条 / 时间码
  if (VE.showProgress) {
    ctx.fillStyle = 'rgba(255,255,255,.14)'; ctx.fillRect(pad, H - 7, W - pad * 2, 3);
    ctx.fillStyle = '#ff5530'; ctx.fillRect(pad, H - 7, (W - pad * 2) * vf.pct, 3);
  }
  if (VE.showTimecode) {
    ctx.fillStyle = C.text; ctx.font = '12px "Consolas", monospace'; ctx.textAlign = 'right';
    const mm = Math.floor(nowSec2 / 60), ss = String(Math.floor(nowSec2 % 60)).padStart(2, '0');
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
    // 1) 离线渲染音频
    const buf = await renderAudioBuffer(s, { rate: 44100, scale: 1, mode: 'auto' });
    VE.veProgress = 10;
    const wavBytes = audioBufferToWavBytes(buf);
    VE.veStage = t('后台录制中（可继续使用应用）…');
    // 2) 离屏画布录制
    const cv = document.createElement('canvas');
    const dpr = 1;
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const fps = VE.fps || 30;
    const mime = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'].find(m => { try { return MediaRecorder.isTypeSupported(m); } catch (e) { return false; } });
    if (!mime) throw new Error('no supported mime');
    let sec = VE.dur || 30;
    if (sec === 0) sec = Math.min(s.totalSec, 120);
    if (VE.range === 'custom') sec = Math.max(1, VE.end - VE.start);
    sec = Math.min(sec, s.totalSec || sec);
    let startSec = VE.range === 'custom' ? (VE.start || 0) : 0;
    const stream = cv.captureStream(fps);
    const bitrate = VE.quality === 'low' ? 4e6 : VE.quality === 'high' ? 16e6 : (VE.quality === 'custom' ? (VE.bitrate * 1e6) : 8e6);
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { rec.onstop = res; });
    rec.start(500);
    const start = performance.now();
    const stopRec = () => { try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} setTimeout(() => { try { stream.getTracks().forEach((t2) => t2.stop()); } catch (e) {} }, 300); };
    let cancelFlag = false;
    const melodyTrack = s.tracks.findIndex((tr) => tr.isDrum === false && !/bass|贝斯|低音/.test(tr.name || ''));
    const ivMs = Math.max(16, Math.round(1000 / fps));
    await new Promise((resolve) => {
      const step = () => {
        if (VE.veCancel || (performance.now() - start) / 1000 >= sec) { stopRec(); resolve(); return; }
        const el = (performance.now() - start) / 1000;
        const tick = s.secToTick(Math.min(startSec + el, Math.max(0.001, s.totalSec - 0.001)));
        const vf = { winSec: 8, melodyTrack, lyricAt: lyricAtTick(s, tick), pct: (el / sec) };
        drawVideoFrame(ctx, W, H, tick, s, buf, vf, el);
        VE.veProgress = Math.min(97, 10 + (el / sec) * 87);
        setTimeout(step, ivMs);
      };
      step();
    });
    const webm = new Blob(chunks, { type: 'video/webm' });
    const data = new Uint8Array(await webm.arrayBuffer());
    VE.veStage = t('转码为 MP4…');
    if (bridge && bridge.transcodeVideo) {
      const r = await bridge.transcodeVideo({ data: Array.from(data), audio: Array.from(wavBytes) });
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
  } finally { VE.veBusy = false; }
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

    <!-- ==================== 视频 / 可视化导出 ==================== -->
    <div class="card conv-form ve-card">
      <div class="ve-head">
        <b>视频 / 可视化导出</b>
        <span class="muted small">把钢琴卷帘动画 + 频谱/波形/和弦渲染为 MP4 视频（本地 ffmpeg 合成）</span>
      </div>
      <div class="ve-preview-wrap" :class="'ve-tpl-' + VE.template">
        <canvas ref="vePreviewEl" class="ve-preview-canvas"></canvas>
        <div v-if="!song" class="ve-preview-empty">{{ t('加载曲目后显示实时预览') }}</div>
      </div>
      <div class="form-grid" style="grid-template-columns:repeat(3,1fr)">
        <div class="field-row">
          <label>{{ t('可视化模板') }}</label>
          <select class="select-input" v-model="VE.visual">
            <option value="mix">混合布局</option><option value="waterfall">音符瀑布</option><option value="spectrum">频谱</option><option value="scope">波形</option><option value="chord">实时和弦</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('画面比例') }}</label>
          <select class="select-input" v-model="VE.template">
            <option value="landscape">横屏 16:9</option><option value="portrait">竖屏 9:16</option><option value="subtitle">横屏+底部字幕留白</option>
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
            <option value="low">低</option><option value="medium">中</option><option value="high">高</option><option value="custom">自定义码率</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('码率') }}（Mbps）</label>
          <input type="number" min="0.5" step="0.5" class="num-input" v-model.number="VE.bitrate" style="width:100%" />
        </div>
        <div class="field-row">
          <label>{{ t('时长') }}</label>
          <select class="select-input" v-model.number="VE.dur">
            <option :value="15">15 秒</option><option :value="30">30 秒</option><option :value="60">60 秒</option><option :value="0">整首（≤120 秒）</option>
          </select>
        </div>
        <div class="field-row">
          <label>{{ t('导出范围') }}</label>
          <select class="select-input" v-model="VE.range">
            <option value="all">整曲</option><option value="custom">自定义区间</option>
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
      <div v-if="VE.veBusy" class="conv-progress">
        <div class="pfill" :style="{ width: VE.veProgress + '%' }"></div>
        <span>{{ Math.round(VE.veProgress) }}%</span>
      </div>
      <button v-if="VE.veBusy" class="btn sm danger" @click="VE.veCancel = true">取消导出</button>
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
