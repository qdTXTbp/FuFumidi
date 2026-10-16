<script setup>
import { ref, computed, reactive, watch, nextTick, onMounted } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { useVizBgStore, BG_MODES } from '../stores/vizbg';
import { t } from '../core/i18n.js';

const app = useAppStore();
const currentSong = computed(() => app.currentSong);
const toast = (m, t) => app.toast(m, t);
import { clamp } from '../core/util.js';
// ★ paintVizBg：与「可视化」页**同一个**背景绘制函数（主题/纯色/图片/透明）
import { drawVizWaterfallPost, paintVizBg, drawVizSpectrum, drawVizScope, drawVizChord, rmsAt, smoothEnergy, smoothEnergyDt, activeNotesAt, VIZ_REF_H, VIZ_REF_DPR } from '../core/viz.js';
import { playVoice, presetFromMode } from '../core/synth.js';
import { renderSongWithSf2 } from '../core/sf2render.js';
import NumSlider from '../components/NumSlider.vue';

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
  // 当前播放使用 SF2 音色时，导出优先用同一音色离线渲染（与播放音色一致；
  // 此前恒用内置合成器渲染，导致导出与试听不符）。返回 null（内置音色）或失败时回退下方内置路径。
  try {
    const r = await renderSongWithSf2(s, { rate: sr, scale, startSec, endSec, onProgress: opts.onProgress });
    if (r) return r;
  } catch (e) { console.warn('[convert] SF2 离线渲染失败，回退内置合成器：', e && e.message || e); }
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
  // WAV 要求帧交错排列（L0,R0,L1,R1,…）——旧实现按「整条 L + 整条 R」平面写入，
  // 播放器把左声道当交错流读 → 内容 2 倍速且左右声道各重复一遍（音画/听感全错）
  const chData = [];
  for (let c = 0; c < chs; c++) chData.push(buf.getChannelData(c));
  const out = new Float32Array(len * chs);
  for (let i = 0; i < len; i++) { const o = i * chs; for (let c = 0; c < chs; c++) out[o + c] = chData[c][i]; }
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
  // 交错排列（修复同 audioBufferToWavBytes 的平面写入 bug）
  const chData = [];
  for (let c = 0; c < chs; c++) chData.push(buf.getChannelData(c));
  const out = new Float32Array(len * chs);
  const CHUNK = 131072; // 每块处理的帧数
  for (let start = 0; start < len; start += CHUNK) {
    const end = Math.min(len, start + CHUNK);
    for (let i = start; i < end; i++) {
      const o = i * chs;
      for (let c = 0; c < chs; c++) out[o + c] = chData[c][i] * gain;
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
    const buf = await renderAudioBuffer(s, { rate: rate.value, scale: tempo.value, mode: preset.value, onProgress: (p) => { progress.value = Math.round(p * 50); } });
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
    // 直接传 Uint8Array（结构化克隆），避免 Array.from 生成数千万元素数组导致内存暴涨
    const r = await bridge.saveBinary({ name: name + '_render.wav', data: bytes });
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
  format: 'mp4', template: 'landscape', res: '1280x720', fps: 24, quality: 'medium',
  dur: 30, durMode: 'full', durCustom: 30, visual: 'mix', track: 'all',
  bitrate: 8, showProgress: true, showChord: true, showTimecode: false,
  // ★ 背景不在 VE 里：它跟「可视化」页共用 stores/vizbg（同一份 + 同一绘制函数）。
  //   以前这里是 bgColor/bgImage 一套私有设置，导出画面跟用户看到的瀑布流对不上。
  showLyrics: true, showWatermark: false, watermarkOpacity: 50, watermark: null,
  veBusy: false, veProgress: 0, veStage: '', veCancel: false,
});
// ★ 视频导出的背景 = 「可视化」页的背景（同一个 store / 同一个 localStorage 键）。
//   任何一边改动，两边的预览与成片立刻一致。
const vizBg = useVizBgStore();
const bg = vizBg.bg;
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
  // ★ 以前这里静默吞异常：绘制中途抛错（实测踩过 'bgMode is not defined'）时预览只剩背景，
  //   看着「像」正常，导出才报错。现在至少把原因打到控制台。
  // ★ 预览与成片必须用**同一套逻辑尺寸**（VIZ_REF_H），否则预览里合适的琴键条/音符密度，
  //   导出来是另一幅画 —— 这正是用户看到的「预览一个样、成片另一个样」。
  try {
    const ps = h / VIZ_REF_H;
    drawVideoFrame._bgScale = ps / VIZ_REF_DPR;
    ctx.save(); ctx.scale(ps, ps);
    drawVideoFrame(ctx, w / ps, VIZ_REF_H, s.secToTick ? s.secToTick(0) : 0, s, null, vf, 0);
    ctx.restore();
  }
  catch (e) { console.warn('[video] 预览绘制失败：', e); }
}
watch(() => [VE.template, bg.mode, bg.color, bg.blur, bg.dim, VE.visual, VE.showProgress, VE.showChord, VE.showTimecode, VE.showLyrics, VE.showWatermark, VE.res, VE.fps, VE.quality, VE.track], () => nextTick(drawVideoPreview), { deep: true });
onMounted(() => {
  nextTick(drawVideoPreview);
  // 图片解码是异步的：读完再重绘一次，否则首帧拿到的是 null（画成主题底）
  void vizBg.init().then(() => nextTick(drawVideoPreview));
});
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
  if (pcs.length < 3) return { name: pcs.length ? t('未形成完整三和弦') : '', minor: false };
  const root = pcs[0];
  const has = (iv) => pcs.includes((root + iv) % 12);
  const NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  if (has(4) && has(7)) return { name: NAME[root], minor: false };
  if (has(3) && has(7)) return { name: NAME[root] + 'm', minor: true };
  return { name: NAME[root] + t('（近似）'), minor: false };
}
const TRACK_COLORS = ['#ff5530', '#ea5ec1', '#1456f0', '#a855f7', '#3daeff', '#1ba673', '#3b82f6', '#f59e0b', '#d45656', '#17437d'];
function drawVideoFrame(ctx, W, H, tick, s, audioBuf, vf, nowSec) {
  const cvar = (n, fb) => { try { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb; } catch (e) { return fb; } };
  const mode = VE.visual || 'mix';
  const pad = 14, panelH = 178, rollH = Math.max(120, H - panelH - pad);
  // ★ 背景 = 「可视化」页选的那一份（主题渐变 / 纯色 / 图片 + 模糊暗化 / 真透明）。
  //   用同一个 paintVizBg 铺**整帧**：仪表盘模板下面还有卡片区，瀑布只盖上半块。
  //   ★ 模糊半径按「物理像素 / 实时 dpr」等比换算：模糊是设备像素量，实时画布是 934×534@2.5，
  //   照抄 13px 在 4K 帧上会清晰得多 —— 于是「导出比实时更清楚」也是不同一幅画。
  const bgOpts = vizBg.drawOpts();
  const bgScale = drawVideoFrame._bgScale;
  if (bgScale > 0 && bgOpts && typeof bgOpts.blur === 'number' && bgOpts.blur > 0) bgOpts.blur = bgOpts.blur * bgScale;
  paintVizBg(ctx, W, H, bgOpts);
  // ★ ④ 与实时统一：只算**真正在发声**的轨（静音轨不点亮），而不是遍历整份谱面
  const activeNotes = activeNotesAt(s, tick, {
    mute: (s.tracks || []).filter((tr) => tr.muted).map((tr) => tr.index),
    solo: VE.track === 'melody' ? (vf.melodyTrack != null ? vf.melodyTrack : -1) : -1,
  });
  if (!drawVideoFrame._state) drawVideoFrame._state = {};
  // 能量包络与实时视图同算法（viz.rmsAt ↔ viz.rmsFromBytes），这里从已解码的音频缓冲取，
  // 因此导出画面与实时预览的「随音乐脉动」是同一套视觉语言且逐帧可复现。
  const st = drawVideoFrame._state;
  // ★ ③ 按**秒**平滑：dt = 1/fps，与实时的 rAF 间隔同量纲（旧的逐帧系数在两条链路
  //   上时间常数不同 ⇒ 脉动快慢/幅度对不上）
  st.energy = smoothEnergyDt(st.energy, rmsAt(audioBuf, nowSec), 1 / (VE.fps || 30));
  // ★ 读用户同一份偏好（原来写死 zoom:1 / colorScheme:0，导出与实时看到的不是同一套密度与配色）
  if (!drawVideoFrame._prefs) {
    try { drawVideoFrame._prefs = JSON.parse(localStorage.getItem('fufumidi_viz') || '{}') || {}; }
    catch (e) { drawVideoFrame._prefs = {}; }
  }
  const prefs = drawVideoFrame._prefs;
  const opts = {
    state: st,
    // ★ ⑤ 与实时统一：读「可视化」页持久化的同一份偏好（原来写死 zoom:1 / colorScheme:0，
    //   用户在瀑布流里调的缩放与配色，导出的成片一概不认）
    zoom: (typeof prefs.zoom === 'number' && isFinite(prefs.zoom)) ? prefs.zoom : 1,
    colorScheme: (typeof prefs.colorScheme === 'number') ? prefs.colorScheme : 0,
    // 背景已经在上面铺满整帧了，瀑布只画音符（'keep' = 不动背景），
    // 否则它会在自己那块区域再清一次/再铺一次，仪表盘的下半块就跟上半块断层。
    bg: { mode: 'keep' },
    showLyrics: !!VE.showLyrics,
    lyricAt: vf.lyricAt || '',
    activeNotes,
    energy: st.energy,
    // ★ 视效开关也走同一份设置：以前只有背景同源，开关若只在实时视图生效，
    //   用户在预览里调的 3D 键盘/粒子，导出的成片又是一副样子（与背景那次是同一类缺陷）
    fx: vizBg.fxOpts(),
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
    drawVizWaterfallPost(ctx, W, H, s, tick, opts);
  } else {
    // 仪表盘：顶部瀑布 + 底部三卡片
    // ★ ⑥ 与实时统一：实时那边瀑布是画在**卡片**里的（圆角 + 发丝描边 + --canvas 底），
    //   导出原来直接铺满整帧 ⇒ 对比度、层次、边缘观感都不同。这里把同一层卡片画出来，
    //   并把绘制原点平移到卡片内（否则内容还是从 0,0 起画，会被裁掉顶部）。
    const cardR = 12, cx0 = pad, cy0 = pad, cw0 = W - pad * 2, ch0 = rollH - pad;
    ctx.save();
    ctx.fillStyle = cvar('--canvas', '#0b1220');
    ctx.beginPath(); roundRect(ctx, cx0, cy0, cw0, ch0, cardR); ctx.fill();
    ctx.strokeStyle = cvar('--hairline', 'rgba(255,255,255,.08)'); ctx.lineWidth = 1;
    ctx.beginPath(); roundRect(ctx, cx0, cy0, cw0, ch0, cardR); ctx.stroke();
    ctx.beginPath(); roundRect(ctx, cx0, cy0, cw0, ch0, cardR); ctx.clip();
    ctx.translate(cx0, cy0);
    drawVizWaterfallPost(ctx, cw0, ch0, s, tick, opts);
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
/* 诊断钩子（只读用途，与 window.__fufumidiVizEnergy 同类）：
 * 用**导出同一条链路**（同一个 drawVideoFrame / 同一个逻辑尺寸 / 同一份背景缓存）渲染一帧，
 * 回报绘制耗时与 PNG，供自动化比对「导出画面 vs 实时画面」并量化单帧成本。
 * 不参与导出逻辑，也不留下状态（画完把 VE.visual 还原）。
 * 用法：window.__fuVizRender({ w: 3840, h: 2160, sec: 25, reps: 10 }) */
if (typeof window !== 'undefined') {
  window.__fuVizRender = (o) => {
    o = o || {};
    const s = song.value;
    if (!s) return { error: 'no-song' };
    const W = Number(o.w) || 1920, H = Number(o.h) || 1080;
    const sec = Number(o.sec) || 0;
    const tick = s.secToTick(sec);
    // o.canvas：允许调用方指定画布（性能基准要复用导出的那块录制画布，量真实链路）
    const c2v = o.canvas || document.createElement('canvas');
    if (c2v.width !== W || c2v.height !== H) { c2v.width = W; c2v.height = H; }
    const c2 = c2v.getContext('2d');
    // 假音频缓冲：rmsAt 会返回 normalizeRms(o.rms)，默认 0.10 → 能量约 0.38。
    // 长度必须覆盖 sec（rmsAt 取的是 [sec, sec+40ms] 这段），否则取到越界一律返回 0，
    // 看上去像「导出没有能量光晕」，其实是探针自己给的缓冲太短。
    const rms = (typeof o.rms === 'number') ? o.rms : 0.10;
    const fakeLen = Math.max(1, Math.ceil(44100 * (sec + 1)));
    const fake = { sampleRate: 44100, duration: 1e6,
      getChannelData: () => { const a = new Float32Array(fakeLen); a.fill(rms); return a; } };
    const vf = { winSec: 8, melodyTrack: 0, lyricAt: o.lyric || '', pct: Number(o.pct) || 0 };
    const prevVisual = VE.visual;
    if (o.visual) VE.visual = o.visual;
    drawVideoFrame._state = null;
    drawVideoFrame._prefs = null;
    const ds = H / VIZ_REF_H;
    drawVideoFrame._bgScale = ds / VIZ_REF_DPR;
    const doFlush = o.flush !== false;
    const step = (stateful) => {
      c2.setTransform(1, 0, 0, 1, 0, 0);
      c2.save(); c2.scale(ds, ds);
      drawVideoFrame(c2, W / ds, VIZ_REF_H, tick, s, fake, vf, sec);
      c2.restore();
      // ★ Canvas2D 的绘制命令是**延迟执行**的：只包 performance.now() 量到的是「提交命令」
      //   的时间（4K 只有 0.8ms，看着像不要钱）。getImageData 会把管线冲干净，
      //   量到的才是真实单帧成本（4K 41ms）。flush:false 用来分离「提交」与「光栅化」。
      if (doFlush) c2.getImageData(0, 0, 1, 1);
      if (!stateful) drawVideoFrame._state = null;
    };
    step(false);
    const reps = Math.max(1, Number(o.reps) || 1);
    const t0 = performance.now();
    for (let i = 0; i < reps; i++) step(true);
    const ms = (performance.now() - t0) / reps;
    const out = { ms: Math.round(ms * 10) / 10, w: W, h: H, tick, sec,
      logical: [Math.round(W / ds), VIZ_REF_H], visual: o.visual || prevVisual,
      energy: drawVideoFrame._state && drawVideoFrame._state.energy };
    VE.visual = prevVisual;
    if (o.png !== false) out.url = c2v.toDataURL('image/png');
    return out;
  };
}
/* 导出用 H.264 编码配置选择（WebCodecs）。
 * 候选按 level 从高到低排：**codec 字符串里的 level 必须覆盖分辨率**，否则 isConfigSupported
 * 直接返回 false —— 实测 avc1.42002A（Level 4.2，上限约 1080p）在 2K/4K 上不支持，
 * 换成 Level 5.1（…33）之后 4K 也能交给硬件编码器。
 * 先试 prefer-hardware（GPU / NVENC），再退 no-preference；都不支持返回 null（走 MediaRecorder）。 */
const AVC_CANDIDATES = ['avc1.640034', 'avc1.640033', 'avc1.4D4033', 'avc1.420033', 'avc1.64002A', 'avc1.42002A'];
async function pickVideoCodec(W, H, fps, bitrate) {
  if (typeof VideoEncoder === 'undefined') return null;
  for (const hardwareAcceleration of ['prefer-hardware', 'no-preference']) {
    for (const codec of AVC_CANDIDATES) {
      try {
        const cfg = { codec, width: W, height: H, bitrate, framerate: fps, hardwareAcceleration, latencyMode: 'quality', avc: { format: 'annexb' } };
        const r = await VideoEncoder.isConfigSupported(cfg);
        if (r && r.supported) {
          // 回填 avc.format：某些实现会把自定义字段从返回的 config 里抹掉，抹掉后输出不是 Annex B
          const conf = Object.assign({}, r.config, { avc: { format: 'annexb' } });
          return { config: conf, codec, hardware: (r.config && r.config.hardwareAcceleration) || hardwareAcceleration };
        }
      } catch (e) { /* 换下一个候选 */ }
    }
  }
  return null;
}

/** 等编码器把队列排空（背压）。dequeue 事件不保证送达，加超时兜底避免卡死。 */
function waitEncoder(enc, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const fin = () => { if (done) return; done = true; try { enc.removeEventListener('dequeue', fin); } catch (e) {} resolve(); };
    try { enc.addEventListener('dequeue', fin); } catch (e) {}
    setTimeout(fin, timeoutMs || 300);
  });
}

async function renderVideo() {
  const s = song.value;
  const bridge = window.fuBridge;
  if (!s) { toast(t('请先载入 MIDI 文件'), 'warn'); return; }
  if (VE.veBusy) return;
  let cv = null;   // 录制画布：finally 里要负责把它从 DOM 摘掉
    if (typeof MediaRecorder === 'undefined' && typeof VideoEncoder === 'undefined') { toast(t('视频导出不可用（当前内核不支持）'), 'err'); return; }
  VE.veBusy = true; VE.veProgress = 0; VE.veStage = t('准备音频（离线渲染）…'); VE.veCancel = false;
  try {
    let [W, H] = VE.res === 'custom' ? [veResCustom.value ? 1920 : 1920, 1080] : VE.res.split('x').map(Number);
    if (VE.template === 'portrait') { W = 720; H = 1280; }
    else if (VE.template === 'subtitle') { W = 1280; H = 800; }
    if (!W || !H) { W = 1280; H = 720; }
    // 视频时长与起始（需在音频切片渲染前确定）
    const fps = VE.fps || 30;
    let sec = VE.durMode === 'custom' ? Math.max(1, VE.durCustom || 30) : Math.max(1, s.totalSec || VE.durCustom || 30);
    sec = Math.min(sec, s.totalSec || sec);
    // ★ 时长不再设上限（用户明确要求）：新链路是 WebCodecs 逐帧编码 + 流式落盘——
    //   机器多快就多快，成片不再受实时约束，编码产物也直接写进临时文件，
    //   不会像旧链路那样把整段视频堆在内存里（10 分钟 4K ≈ 1.2 GB）。
    // 导出始终从曲首开始（「开始 / 结束（秒）」区间功能已移除）
    const startSec = 0;
    // 1) 离线渲染音频：按导出范围切片（[startSec, startSec+sec] 归一化），
    //    与视频长度严格一致，避免整曲渲染后截断导致音乐「被切断/变快」
    const buf = await renderAudioBuffer(s, { rate: 44100, scale: 1, mode: preset.value, startSec, endSec: startSec + sec, onProgress: (p) => { VE.veProgress = Math.min(10, Math.round(p * 10)); } });
    VE.veProgress = 10;
    const wavBytes = await audioBufferToWavBytesAsync(buf, (p) => { VE.veProgress = Math.min(100, 10 + Math.round(p * 10)); });
    VE.veStage = t('后台渲染中（可继续使用应用）…');
    const bitrate = VE.quality === 'low' ? 4e6 : VE.quality === 'high' ? 16e6 : (VE.quality === 'custom' ? (VE.bitrate * 1e6) : 8e6);
    // ---- 编码路线：优先 WebCodecs + 硬件编码器（GPU），不支持时回退 MediaRecorder ----
    // ★ 实测（本机 RTX 5070 Ti）：H.264 硬件编码在 720P/1080P/2K/4K 都可用，
    //   每帧编码提交仅 0.3~1 ms；整条链路 720P 93.7 fps、1080P 83.2 fps、4K 39.6 fps。
    //   旧链路是 MediaRecorder 实时录 VP9（纯 CPU 软编），成片多长就得满载多久。
    //   注意 codec 字符串里的 level 必须覆盖分辨率，否则 isConfigSupported 直接 false ——
    //   实测 avc1.42002A（Level 4.2）在 4K 上不支持，换 Level 5.1（…33）就支持。
    const codec = await pickVideoCodec(W, H, fps, bitrate);
    // 画布：WebCodecs 路径**不必挂进 DOM**（VideoFrame 直接读画布缓冲）；
    // 只有 MediaRecorder 回退路径需要它参与合成，才放进右下角 2×2 的隐形位置。
    cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const melodyTrack = s.tracks.findIndex((tr) => tr.isDrum === false && !/bass|贝斯|低音/.test(tr.name || ''));
    const totalFrames = Math.max(1, Math.round(sec * fps));
    const ds = H / VIZ_REF_H;
    drawVideoFrame._bgScale = ds / VIZ_REF_DPR;   // 背景模糊随分辨率等比（见 drawVideoFrame）
    // 每次导出都从干净的帧间状态起笔（粒子 / 能量包络 / 上次绘制时刻）。
    // 否则预览或其他导出遗留的粒子会让同一份工程两次导出的画面不一致。
    drawVideoFrame._state = null;
    // 预热背景位图缓存：底图（模糊 + cover 裁切）在第一帧之前先烘一次。
    try {
      const b0 = vizBg.drawOpts();
      if (b0 && typeof b0.blur === 'number' && b0.blur > 0) b0.blur = b0.blur * (ds / VIZ_REF_DPR);
      ctx.save(); ctx.scale(ds, ds);
      paintVizBg(ctx, W / ds, VIZ_REF_H, b0);
      ctx.restore();
    } catch (e) { console.warn('[video] 背景预热失败：', e); }
    /** 画一帧。el = 相对导出区间起点的内容秒数（音频已按区间归一化，从 0 起）。
     *  ★ 与实时同尺度（观感差距的**主因**）且**不动物理缓冲**：
     *  瀑布流里有绝对像素常量（琴键条上限 120、一小节 120px、发光 20、字号 10…），
     *  只有在「逻辑高度 ≈ 实时画布高度（实测 534）」时才与实时一致。
     *  导出原来把物理像素当逻辑单位（4K 即 3840×2160）⇒ 琴键条只剩 5% 高、
     *  一屏塞 36 秒音乐、音符变成细丝 —— 与实时画面完全不是一幅画。
     *  这里固定逻辑高度 = VIZ_REF_H，用 ctx.scale 映射到物理像素。 */
    const drawOne = (el) => {
      const tSec = Math.min(el, Math.max(0, sec - 1 / (fps * 2)));
      const tick = s.secToTick(Math.min(startSec + tSec, Math.max(0.001, s.totalSec - 0.001)));
      const vf = { winSec: 8, melodyTrack, lyricAt: lyricAtTick(s, tick), pct: (el / sec) };
      ctx.save();
      ctx.scale(ds, ds);
      drawVideoFrame(ctx, W / ds, VIZ_REF_H, tick, s, buf, vf, tSec);
      ctx.restore();
    };
    let streamId = null;
    if (codec && bridge && bridge.videoExportBegin) {
      // ================= 新链路：GPU 硬件编码 + 流式落盘 =================
      const begin = await bridge.videoExportBegin({ container: 'h264' });
      if (!begin || !begin.ok) throw new Error((begin && begin.error) || 'export-begin-failed');
      streamId = begin.id;
      VE.veStage = t('GPU 逐帧编码中…');
      let pending = [], pendingBytes = 0, encErr = null;
      // 编码产物按 4 MB 一批写盘：既不让内存堆积，也不至于每帧一次 IPC
      const flushOut = async (force) => {
        if (!pendingBytes || (!force && pendingBytes < 4 * 1024 * 1024)) return;
        const out = new Uint8Array(pendingBytes);
        let off = 0;
        for (const c of pending) { out.set(c, off); off += c.length; }
        pending = []; pendingBytes = 0;
        const w = await bridge.videoExportWrite(streamId, out);
        if (w && !w.ok) encErr = encErr || new Error(w.error || 'write-failed');
      };
      const enc = new VideoEncoder({
        output: (chunk) => { const d = new Uint8Array(chunk.byteLength); chunk.copyTo(d); pending.push(d); pendingBytes += d.length; },
        error: (e) => { encErr = encErr || e; },
      });
      enc.configure(codec.config);
      const KEY_EVERY = Math.max(1, Math.round(fps * 2));
      const t0 = performance.now();
      for (let i = 0; i < totalFrames; i++) {
        if (VE.veCancel || encErr) break;
        drawOne(i / fps);
        const frame = new VideoFrame(cv, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
        enc.encode(frame, { keyFrame: i % KEY_EVERY === 0 });
        frame.close();
        // 背压：编码队列积压时等 dequeue，避免长片把编码器内部队列顶爆
        if (enc.encodeQueueSize > 8) await waitEncoder(enc, 300);
        await flushOut(false);
        if ((i & 15) === 0) {
          const done = (i + 1) / totalFrames;
          VE.veProgress = Math.min(97, 10 + done * 87);
          const el = (performance.now() - t0) / 1000;
          const eta = done > 0.02 ? Math.round(el / done - el) : 0;
          VE.veStage = t('GPU 逐帧编码中…') + ' ' + Math.round(done * 100) + '%' + (eta > 1 ? ' · ' + t('剩余约') + ' ' + eta + 's' : '');
          await new Promise((r) => setTimeout(r, 0));   // 让进度条有机会刷新
        }
      }
      try { await enc.flush(); } catch (e) {}
      try { enc.close(); } catch (e) {}
      await flushOut(true);
      if (VE.veCancel) { try { await bridge.videoExportAbort(streamId); } catch (e) {} streamId = null; VE.veStage = t('已取消'); toast(t('导出已取消'), 'warn'); return; }
      if (encErr) throw encErr;
      VE.veProgress = 97;
      VE.veStage = t('封装为 MP4…');
      // ★ 编码产物是 Annex B 裸 H.264，主进程用 -c:v copy 直接封装 —— 不再跑 libx264 重编码
      // duration = 帧数 / 帧率：主进程用它 -t 收尾（不能用 -shortest，见 main/video.js）
      const r = await bridge.videoExportEnd({ id: streamId, fps, duration: totalFrames / fps, audio: wavBytes, name: s.name });
      streamId = null;
      if (r && r.ok) toast(t('视频已导出：') + (r.path || ''), 'ok');
      else if (!(r && r.canceled)) toast(t('视频导出失败：') + ((r && r.error) || ''), 'warn');
    } else {
      // ================= 回退链路：MediaRecorder（实时）+ 流式落盘 =================
      if (typeof MediaRecorder === 'undefined' || !HTMLCanvasElement.prototype.captureStream) throw new Error('no-recorder');
      // 录制画布必须挂到 DOM 并留在视口里：移出视口时合成器呈现延迟可达 300ms+，
      // 自动捕获会把「时间戳=捕获时刻、内容=δ 之前绘制」的帧写进视频（实测音频领先画面 ~340ms）。
      // 放在右下角、2×2 CSS 像素、几乎全透明：参与合成、用户看不见；抓的是像素缓冲 W×H。
      cv.style.cssText = 'position:fixed;right:0;bottom:0;width:2px;height:2px;opacity:0.01;z-index:-1;pointer-events:none;';
      document.body.appendChild(cv);
      let mstream = cv.captureStream(0);
      let vtrack = mstream.getVideoTracks()[0];
      const canManual = !!(vtrack && typeof vtrack.requestFrame === 'function');
      if (!canManual) { mstream = cv.captureStream(fps); vtrack = null; }
      let rec = null;
      for (const m of ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']) {
        if (!MediaRecorder.isTypeSupported(m)) continue;
        for (const br of [bitrate, Math.max(1e6, Math.floor(bitrate * 0.6)), 2e6]) {
          try { rec = new MediaRecorder(mstream, { mimeType: m, videoBitsPerSecond: br }); break; } catch (e) {}
        }
        if (rec) break;
      }
      if (!rec) throw new Error('no supported mime');
      const begin = (bridge && bridge.videoExportBegin) ? await bridge.videoExportBegin({ container: 'webm' }) : null;
      streamId = (begin && begin.ok) ? begin.id : null;
      const blobChunks = [];
      let writeChain = Promise.resolve();
      rec.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        if (!streamId) { blobChunks.push(e.data); return; }
        writeChain = writeChain.then(async () => { const b = new Uint8Array(await e.data.arrayBuffer()); await bridge.videoExportWrite(streamId, b); }).catch(() => {});
      };
      rec.onerror = (e) => { console.warn('[video] MediaRecorder error', e); };
      const stopped = new Promise((res) => { rec.onstop = res; });
      rec.start(500);
      // 录制器 start() 之后有一段还没开始收帧的冷启动窗口（本机实测约 0.6 秒）。
      // 等它过去再起钟、再画第 0 帧，成片首帧才是内容 0、时长才是目标时长。
      await new Promise((res) => {
        let done = false;
        const fin = () => { if (done) return; done = true; try { rec.removeEventListener('dataavailable', fin); } catch (e) {} res(); };
        try { rec.addEventListener('dataavailable', fin); } catch (e) {}
        setTimeout(fin, 800);
      });
      const start = performance.now();
      const stopRec = () => { try { if (rec.state !== 'inactive') rec.stop(); } catch (e) {} setTimeout(() => { try { mstream.getTracks().forEach((t2) => t2.stop()); } catch (e) {} }, 300); };
      const ivMs = Math.max(16, Math.round(1000 / fps));
      await new Promise((resolve) => {
        let drawDurEst = 16;
        // 尾部保护：录制器 stop() 之前还会丢掉最后 ~0.3 秒的帧，多跑一小段，
        // 让成片被 -shortest 按音频长度（= 目标时长）截断 —— 正好截在内容 sec 处。
        const TAIL_PAD = 0.6;
        const step = () => {
          const t1 = performance.now();
          const elRaw = (t1 - start) / 1000;
          const el = elRaw + drawDurEst / 1000;
          if (VE.veCancel || el >= sec + TAIL_PAD) { if (VE.veTimer) { clearInterval(VE.veTimer); VE.veTimer = null; } stopRec(); resolve(); return; }
          drawOne(Math.min(el, sec));
          if (canManual) { try { vtrack.requestFrame(); } catch (e) {} }
          drawDurEst = Math.min(400, drawDurEst * 0.7 + (performance.now() - t1) * 0.3);
          VE.veProgress = Math.min(97, 10 + (Math.min(elRaw, sec) / sec) * 87);
        };
        VE.veTimer = setInterval(step, ivMs);
        step();
      });
      await stopped;
      await writeChain;
      VE.veStage = t('转码为 MP4…');
      if (streamId) {
        if (VE.veCancel) { try { await bridge.videoExportAbort(streamId); } catch (e) {} streamId = null; VE.veStage = t('已取消'); toast(t('导出已取消'), 'warn'); return; }
        const r = await bridge.videoExportEnd({ id: streamId, fps, duration: sec, audio: wavBytes, name: s.name });
        streamId = null;
        if (r && r.ok) toast(t('视频已导出：') + (r.path || ''), 'ok');
        else if (!(r && r.canceled)) toast(t('视频导出失败：') + ((r && r.error) || ''), 'warn');
      } else {
        const webm = new Blob(blobChunks, { type: 'video/webm' });
        const data = new Uint8Array(await webm.arrayBuffer());
        if (bridge && bridge.transcodeVideo) {
          const r = await bridge.transcodeVideo(data, wavBytes, { name: s.name });
          if (r && r.ok) toast(t('视频已导出：') + (r.path || ''), 'ok');
          else if (!(r && r.canceled)) toast(t('视频导出失败：') + ((r && r.error) || ''), 'warn');
        } else {
          const a = document.createElement('a');
          a.download = (s.name || 'FuFumidi-video') + '.webm'; a.href = URL.createObjectURL(webm); a.click();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          toast(t('已导出 WebM（桌面版可转 MP4）'), 'ok');
        }
      }
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
            <option v-for="p in PRESETS" :key="p[0]" :value="p[0]">{{ t(p[1]) }}</option>
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
          <NumSlider v-model="gain" :min="0" :max="150" class="range" />
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
          <div class="pfill" :style="{ transform: 'scaleX(' + ((progress) / 100) + ')' }"></div>
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
            <option v-for="p in PRESETS" :key="p[0]" :value="p[0]">{{ t(p[1]) }}</option>
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
          <div v-if="VE.res === '3840x2160'" class="muted small" style="margin-top:2px">{{ t('4K：已启用 GPU 硬件编码，成片约 1.2 GB / 10 分钟，长片请留意磁盘空间') }}</div>
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
          <label>{{ t('码率') }}{{ t('（') }}Mbps{{ t('）') }}</label>
          <input type="number" min="0.5" step="0.5" class="num-input" v-model.number="VE.bitrate" />
        </div>
        <div class="field-row">
          <label>{{ t('时长') }}</label>
          <div class="fr-inline">
            <select class="select-input" v-model="VE.durMode">
              <option value="full">{{ t('整首') }}</option><option value="custom">{{ t('自定义（秒）') }}</option>
            </select>
            <input v-if="VE.durMode === 'custom'" type="number" min="1" step="1" class="num-input" v-model.number="VE.durCustom" style="width:84px;flex:0 0 auto" />
          </div>
        </div>
        <div class="field-row">
          <label>{{ t('水印图片') }}</label>
          <div class="fr-inline">
            <button class="btn sm" @click="vePickWatermark">{{ VE.watermark ? t('更换') : t('选择') }}</button>
            <NumSlider v-model="VE.watermarkOpacity" :min="0" :max="100" style="flex:1 1 80px;min-width:0" />
          </div>
        </div>
        <!-- ★ 背景跟「可视化」页共用一份（stores/vizbg）：这里改，瀑布流那边立刻变；
              反之亦然。导出前先在可视化页把背景调好，这里就是所见即所得。
              内容比其他格子多（模式 chip + 换图 + 两条滑杆 + 说明），所以整行铺满、内部横向排。 -->
        <div class="field-row is-wide">
          <label>{{ t('背景') }}</label>
          <div class="ve-bg-inline">
            <div class="ve-bg-modes">
              <button v-for="m in BG_MODES" :key="m.k" class="chip-btn" :class="{ active: bg.mode === m.k }"
                      :title="m.k === 'transparent' ? t('真·透明：导出的画面可当叠加层') : ''"
                      @click="vizBg.setMode(m.k)">{{ t(m.label) }}</button>
              <input v-if="bg.mode === 'solid'" type="color" :value="bg.color"
                     @input="vizBg.setColor($event.target.value)"
                     style="width:38px;height:24px;padding:0;border:1px solid var(--hairline);border-radius:6px;background:none;cursor:pointer" />
              <button v-if="bg.mode === 'image'" class="btn sm" @click="vizBg.pickImage()">
                <Icon name="folder" :size="12" />{{ bg.path ? t('更换') : t('选择') }}</button>
            </div>
            <div v-if="bg.mode === 'image' || bg.mode === 'theme'" class="ve-bg-sliders">
              <span class="muted small">{{ t('模糊') }}</span>
              <NumSlider :model-value="bg.blur" @update:model-value="v => { vizBg.setBlur(v) }" :min="0" :max="40" :step="1" :input-width="68" />
              <span class="muted small">{{ t('暗化') }}</span>
              <NumSlider :model-value="Math.round(bg.dim * 100)" @update:model-value="v => { vizBg.setDim((+v) / 100) }" :min="0" :max="80" :step="5" :input-width="68" />
            </div>
            <span class="muted small">{{ t('与「可视化」页共用同一套设置') }}</span>
            <span v-if="bg.mode === 'transparent'" class="muted small">{{ t('透明档：MP4 没有透明通道，导出后是黑底（可作叠加层的相加/滤色素材）') }}</span>
          </div>
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
          <div class="pfill" :style="{ transform: 'scaleX(' + ((VE.veProgress) / 100) + ')' }"></div>
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
.convert-view { max-width: 820px; padding: var(--page-pad-y) var(--page-pad-x) var(--page-pad-b); }
.conv-info-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 12px; padding: 8px 14px; margin-bottom: 12px; font-size: 12.5px; color: var(--steel); }
.conv-song { color: var(--stone); }
.conv-form { display: flex; flex-direction: column; gap: 16px; }
.form-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px 20px; }
@media (max-width: 720px) { .form-grid { grid-template-columns: 1fr; } }
.field-row { display: flex; flex-direction: column; gap: 6px; }
.field-row label { font-size: 12px; color: var(--steel); font-weight: 600; display: flex; align-items: center; gap: 8px; }
/* ★ 全局 styles.css 的 .field-row 是「设置面板」那一套（label 左 / 控件右 / space-between + 分隔线），
   会一路继承进这张卡片。一旦某一行被内容更高的邻居撑高（比如「背景」），space-between 就把标签和
   控件分别顶到行的上下两端 —— 实测 163px 高的行里两者相距 110px，看着像控件飞出去了。
   下面几条把卡片范围内的 .field-row 重置成「标签在上、控件紧跟其下」。 */
.ve-card .form-grid { align-items: start; row-gap: 16px; }
.ve-card .field-row { justify-content: flex-start; align-items: stretch; gap: 6px; padding: 0; border-bottom: 0; }
.ve-card .field-row:hover { background: none; }
/* 内容多的格子（背景：模式 chip + 换图 + 两条滑杆 + 说明）整行铺满，内部横向排 */
.ve-card .field-row.is-wide { grid-column: 1 / -1; }
.ve-bg-inline { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; }
.ve-bg-inline .ve-bg-sliders { flex: 1 1 280px; min-width: 220px; margin-top: 0; }
/* 一行内并排的控件（时长 + 秒数、水印按钮 + 不透明度） */
.fr-inline { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.fr-inline .select-input { flex: 1 1 auto; min-width: 0; }
.gain-row { flex-direction: row; align-items: center; justify-content: space-between; }
.range { flex: 1; accent-color: var(--ink); }
.conv-est { display: flex; align-items: center; gap: 10px; background: var(--surface-soft); border-radius: 10px; padding: 8px 14px; font-size: 12px; color: var(--steel); }
.conv-est b { color: var(--ink); font-size: 15px; margin-right: 8px; font-variant-numeric: tabular-nums; }
.conv-est em { font-style: normal; color: var(--stone); }
.btn.big { width: 100%; padding: 12px 18px; font-size: 14px; }
.conv-progress { display: flex; align-items: center; gap: 10px; height: 20px; background: var(--surface-soft); border-radius: 999px; overflow: hidden; padding: 0 12px; font-size: 11px; color: var(--steel); font-variant-numeric: tabular-nums; }
.conv-progress .pfill { height: 100%; background: var(--accent); border-radius: 999px; transition: transform var(--motion-base) var(--ease-out); }
.conv-done-tip { color: var(--success-text); font-size: 12.5px; font-weight: 600; text-align: center; }
/* 转换页进度/完成提示显隐过渡 */
.cv-enter-active, .cv-leave-active { transition: opacity var(--motion-base) var(--ease-out), transform var(--motion-base) var(--ease-spring); }
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
/* 背景控件：跟「可视化」页的 .viz-bg-bar 同一套语言（chip-btn + 细滑杆） */
.ve-bg-modes { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ve-bg-sliders { display: flex; align-items: center; gap: 6px; margin-top: 6px; }
.ve-bg-sliders input[type=range] { flex: 1; min-width: 60px; accent-color: var(--accent); }
.ve-opts { display: flex; flex-wrap: wrap; gap: 14px; font-size: 12.5px; color: var(--slate); }
.ve-opts label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.ve-opts input[type=checkbox] { accent-color: var(--ink); }
.num-input { width: 100%; padding: 6px 8px; font-size: 12px; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 8px; color: var(--ink); outline: none; box-sizing: border-box; }
</style>