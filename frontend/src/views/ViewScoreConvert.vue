<script setup lang="ts">
// ============================================================
// 变谱：谱面 → MIDI（全格式）
// ============================================================
// 四条输入路径都在这里会合：
//   MusicXML / MXL  → 引擎 MusicXML 解析器（divisions、<backup> 多声部、连音线、速度表）
//   图片            → 引擎光学识谱（engine_omr.py）
//   PDF             → 本页用 pdf.js 先栅格化成 PNG，再交给同一条识谱链路
//   MIDI            → 直通
//
// ★ 为什么 PDF 的栅格化放在渲染进程：Electron 内置 PDF 查看器翻页拿不到（#page= 不生效，
//   第二页截出来和第一页一模一样，实测），而 pdf.js 还能把矢量 PDF 渲到任意分辨率 ——
//   对识谱来说分辨率就是识别率。
// ★ 识别结果永远配一张「识别对照图」：红圈=认到的符头、绿/蓝/橙框=变化音、品红=小节线。
//   识谱不可能 100% 准，用户得能一眼看出哪里错了，再导入编辑器手工修。
import { ref, onMounted, onBeforeUnmount, nextTick, computed } from 'vue';
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
const overlays = ref<string[]>([]);        // 对照图 objectURL
const files = ref<string[]>([]);            // 本次转换吃进去的文件（多选/拖拽时是多个）
// 识谱增强引擎（Audiveris）：没装就在卡片下方给一条「装了会好一个量级」的可操作提示
const omrEngine = ref<any>(null);
const omrBusy = ref(false);
const omrText = ref('');
let offOmr: null | (() => void) = null;
async function refreshOmr() {
  try { omrEngine.value = await bridge().omrEngine?.status(); } catch (e) { omrEngine.value = null; }
}
async function installOmr() {
  if (omrBusy.value) return;
  omrBusy.value = true; omrText.value = t('准备下载…');
  try {
    const r = await bridge().omrEngine.install();
    if (r && r.ok && r.installed) { app.toast(t('识谱引擎已安装'), 'ok'); omrEngine.value = r; }
    else { app.toast(t('安装失败：') + String((r && r.error) || ''), 'warn'); }
  } catch (e: any) { app.toast(t('安装失败：') + String((e && e.message) || e), 'warn'); }
  finally { omrBusy.value = false; omrText.value = ''; }
}
const dropOn = ref(false);                  // 拖拽悬停高亮
const ovIndex = ref(0);
const progress = ref(0);
const progressText = ref('');
const kind = ref('');

// 识谱参数（只对图片 / PDF 生效）
const beats = ref(4);
const beatType = ref(4);
const tempo = ref(120);

let offProgress: null | (() => void) = null;
const overlayUrls: string[] = [];

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bridge(): any { return (window as any).fuBridge; }

/** PDF → 每页一张 PNG（base64）。宽约 1700px ≈ A4@200dpi，低清谱也够识谱用。 */
async function rasterizePdf(path: string): Promise<string[]> {
  const b = bridge();
  const buf = await b.readBinary(path);
  if (!buf) throw new Error(t('读取 PDF 失败'));
  const pdfjs: any = await import('pdfjs-dist');
  const worker: any = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default || worker;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
  const total = Math.min(doc.numPages, 40);
  const pages: string[] = [];
  for (let i = 1; i <= total; i++) {
    progress.value = Math.round((i / total) * 55);
    progressText.value = t('渲染 PDF 第 ') + i + '/' + total + t(' 页');
    const page = await doc.getPage(i);
    const vp0 = page.getViewport({ scale: 1 });
    const scale = Math.min(4, Math.max(1, 1700 / Math.max(1, vp0.width)));
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(vp.width));
    cv.height = Math.max(1, Math.round(vp.height));
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    pages.push(cv.toDataURL('image/png').split(',')[1]);
  }
  return pages;
}

/** 图片兜底栅格化：Pillow 打不开的格式（如 AVIF）交给 Chromium 解码。 */
async function rasterizeImage(path: string): Promise<string[]> {
  const b = bridge();
  const buf = await b.readBinary(path);
  if (!buf) throw new Error(t('读取图片失败'));
  const blob = new Blob([buf]);
  const bmp = await createImageBitmap(blob);
  const cv = document.createElement('canvas');
  const scale = Math.min(3, Math.max(1, 1700 / Math.max(1, bmp.width)));
  cv.width = Math.round(bmp.width * scale);
  cv.height = Math.round(bmp.height * scale);
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(bmp, 0, 0, cv.width, cv.height);
  return [cv.toDataURL('image/png').split(',')[1]];
}

async function loadOverlays(paths: string[]) {
  for (const u of overlayUrls) URL.revokeObjectURL(u);
  overlayUrls.length = 0;
  overlays.value = [];
  ovIndex.value = 0;
  for (const p of paths) {
    try {
      const buf = await bridge().readBinary(p);
      if (!buf) continue;
      const url = URL.createObjectURL(new Blob([buf], { type: 'image/png' }));
      overlayUrls.push(url);
      overlays.value.push(url);
    } catch (e) { /* 单页失败不影响其它页 */ }
  }
}

async function run(cfg: any) {
  const b = bridge();
  if (!b || typeof b.scoreToMidi !== 'function') { err.value = t('桌面版才能用「变谱」'); return null; }
  return await b.scoreToMidi(cfg);
}

/** 单选/多选/拖拽都汇到这里：inputs 是**有序**的 [{path} | {pages}]。 */
async function convert(inputs: any[], label?: string) {
  const b = bridge();
  if (!b || typeof b.scoreToMidi !== 'function') { err.value = t('桌面版才能用「变谱」'); return; }
  busy.value = true; err.value = ''; info.value = null; midiBytes.value = null; tracks.value = [];
  progress.value = 0; progressText.value = t('读取文件…');
  files.value = (inputs || []).map((it: any) => it.name || String(it.path || '').split(/[\\/]/).pop() || 'page');
  await loadOverlays([]);
  try {
    const base = { beats: beats.value, beatType: beatType.value, tempo: tempo.value };
    let r = await run({ ...base, inputs });
    if (!r || r.canceled) return;
    // PDF：渲染进程逐页栅格化（多选时每个 PDF 都要渲），再把页图按原顺序送回去
    if (!r.ok && r.needRaster && Array.isArray(r.inputs)) {
      srcName.value = r.fileName || '';
      files.value = (r.names && r.names.length) ? r.names.slice() : files.value;
      const total = r.inputs.filter((it: any) => !it.pages && /\.pdf$/i.test(String(it.path || ''))).length;
      let donePdf = 0;
      const filled: any[] = [];
      for (const it of r.inputs) {
        if (!it.pages && /\.pdf$/i.test(String(it.path || ''))) {
          donePdf += 1;
          progressText.value = t('渲染 PDF ') + donePdf + '/' + total;
          filled.push({ ...it, pages: await rasterizePdf(it.path) });
        } else {
          filled.push(it);
        }
      }
      progress.value = 62; progressText.value = t('识谱中…');
      r = await run({ ...base, inputs: filled, name: r.fileName });
    }
    // 图片：引擎读不了（例如 AVIF）就整批退回 Chromium 解码再送回来
    if (!r.ok && !r.canceled && r.kind === 'raster' && Array.isArray(r.inputs)) {
      const filled: any[] = [];
      for (const it of r.inputs) {
        if (it.pages && it.pages.length) { filled.push(it); continue; }
        filled.push({ pages: await rasterizeImage(it.path) });
      }
      progress.value = 62; progressText.value = t('识谱中…');
      r = await run({ ...base, inputs: filled, name: r.fileName });
    }
    if (!r || !r.ok) {
      err.value = r && r.errorCode === 'mixed' ? t('不要混着选：图片 / PDF 是一类，MusicXML 是一类，MIDI 是一类。') : String((r && r.error) || t('转换失败'));
      return;
    }
    kind.value = r.kind || '';
    const bytes = b64ToBytes(r.bytes || '');
    midiBytes.value = bytes;
    info.value = r.info || null;
    srcName.value = r.fileName || srcName.value;
    progress.value = 88; progressText.value = t('生成试看…');
    try {
      const mid = parseMidi(bytes);
      tracks.value = (mid.tracks || []).filter((x: any) => (x.notes || []).length);
      await nextTick();
      drawPreview();
    } catch (e) { /* 预览失败不影响导入 */ }
    if (r.overlays && r.overlays.length) await loadOverlays(r.overlays);
    if (r.names && r.names.length) files.value = r.names.slice();
    progress.value = 100;
    const n = (r.info && (r.info.notes || r.info.noteCount)) || 0;
    app.toast(t('已转换：') + String(n) + t(' 个音符'), 'ok');
    if (label) srcName.value = label;
  } catch (e: any) {
    err.value = String((e && e.message) || e);
  } finally {
    busy.value = false;
    progressText.value = '';
  }
}

async function pick() { await convert([]); }

/** 拖拽导入：Electron 里 File 对象拿不到路径，走 preload 的 webUtils 桥。 */
async function onDrop(e: DragEvent) {
  e.preventDefault();
  dropOn.value = false;
  const b = bridge();
  const list = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!list.length) return;
  const inputs = list.map((f) => ({ path: b.pathForFile ? b.pathForFile(f) : '', name: f.name })).filter((x) => x.path);
  if (!inputs.length) { err.value = t('拖进来的文件拿不到路径'); return; }
  await convert(inputs);
}

/** 试看：把所有声部画成一条紧凑的钢琴卷帘（按声部着色） */
function drawPreview() {
  const cv = previewEl.value;
  if (!cv) return;
  const W = cv.clientWidth || 720, H = 190;
  cv.width = W * 2; cv.height = H * 2;
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  g.setTransform(2, 0, 0, 2, 0, 0);
  g.clearRect(0, 0, W, H);
  const all = tracks.value.flatMap((tr: any) => tr.notes || []);
  if (!all.length) return;
  let lo = 127, hi = 0, end = 0;
  for (const n of all) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); end = Math.max(end, n.end || n.start || 0); }
  const pad = 8, span = Math.max(1, hi - lo);
  const px = (tm: number) => pad + (tm / Math.max(1, end)) * (W - pad * 2);
  const py = (m: number) => H - pad - ((m - lo) / span) * (H - pad * 2);
  const colors = ['#5ac8fa', '#ff9f0a', '#bf5af2', '#30d158', '#ff453a'];
  tracks.value.forEach((tr: any, i: number) => {
    g.fillStyle = colors[i % colors.length];
    for (const n of (tr.notes || [])) {
      const x0 = px(n.start || 0), x1 = Math.max(x0 + 1.5, px(n.end || (n.start || 0) + 0.1));
      g.fillRect(x0, py(n.midi) - 1.2, x1 - x0, 2.6);
    }
  });
}

const isRaster = computed(() => kind.value === 'raster' || kind.value === 'pdf');
/** 识别引擎显示名：Audiveris 是外部增强引擎，classical 是自带离线识谱。 */
const engineName = computed(() => {
  const b = String((info.value && (info.value.backend || info.value.engine)) || '');
  if (b === 'audiveris') return 'Audiveris';
  if (b === 'classical') return t('内置识谱');
  return b || '—';
});
/** parseMidi 回的 notes 是数组，引擎回的 tracks[].notes 是数字 —— 两种都要能显示。 */
function noteCountOf(tr: any): number {
  if (!tr) return 0;
  if (Array.isArray(tr.notes)) return tr.notes.length;
  return Number(tr.notes) || 0;
}
/** 引擎回的是警告代码，这里按当前语言翻译（全语言适配）。 */
const warnings = computed<string[]>(() => {
  const raw = (info.value && info.value.warnings) || [];
  return raw.map((w: any) => {
    if (typeof w === 'string') return w;
    if (w && w.code === 'lowres') return t('页面分辨率偏低（谱线间距 ') + w.spacing + t(' 像素）：变化音记号可能识别不全，建议每页宽度 1200 像素以上。');
    if (w && w.code === 'no-barlines') return t('没有识别到小节线，节奏只能按整页平均估算。');
    if (w && w.code === 'no-accidentals') return t('没有识别到变化音记号：如果原谱有升/降号，请调高分辨率后重试。');
    if (w && w.code === 'only-first') return t('一次只能转换一个这种文件，只用了第一个（共选了 ') + w.n + t(' 个）。');
    if (w && w.code === 'page-cap') return t('页数超过上限，只取了前 ') + w.n + t(' 页。');
    if (w && w.code === 'backend-missing') return t('没装识谱增强引擎（Audiveris），已用内置识谱；可在「资源中心 → 识谱引擎」安装后重试。');
    if (w && w.code === 'classical-fallback') return t('已回退到内置识谱：离线可用，但变化音与节奏精度低于增强引擎。');
    if (w && w.code === 'audiveris-failed') return t('识谱增强引擎失败，已回退内置识谱。');
    if (w && w.code === 'page-failed') return t('第 ') + w.page + t(' 页识别失败，已跳过。');
    return String((w && w.code) || w || '');
  });
});
const noteTotal = computed(() => (info.value && (info.value.notes || info.value.noteCount)) || 0);
const durSec = computed(() => {
  const ms = (info.value && info.value.durationMs) || 0;
  return ms ? (ms / 1000).toFixed(1) + 's' : '—';
});

async function importToLibrary() {
  if (!midiBytes.value || !srcName.value) return;
  try {
    await app.importFiles([{ name: srcName.value.replace(/\.[^.]+$/, '') + '.mid', bytes: midiBytes.value }]);
    app.toast(t('已导入曲库'), 'ok');
  } catch (e: any) { app.toast(t('导入失败：') + String((e && e.message) || e), 'warn'); }
}

async function saveAs() {
  if (!midiBytes.value || !srcName.value) return;
  try {
    const r = await bridge().saveBinary({
      name: srcName.value.replace(/\.[^.]+$/, '') + '.mid',
      data: midiBytes.value,
      filters: [{ name: 'MIDI', extensions: ['mid'] }],
    });
    if (r && r.ok) app.toast(t('已保存到：') + r.path, 'ok');
    else if (!(r && r.canceled)) app.toast(t('保存失败'), 'warn');
  } catch (e: any) { app.toast(t('保存失败') + '：' + String((e && e.message) || e), 'warn'); }
}

onMounted(() => {
  const b = bridge();
  refreshOmr();
  if (b && b.omrEngine && typeof b.omrEngine.onProgress === 'function') {
    offOmr = b.omrEngine.onProgress((p: any) => { if (p && p.text) omrText.value = String(p.text) + (p.percent ? ' ' + p.percent + '%' : ''); });
  }
  if (b && typeof b.onScoreProgress === 'function') {
    offProgress = b.onScoreProgress((p: any) => {
      if (!p) return;
      if (typeof p.percent === 'number') progress.value = 55 + Math.round(p.percent * 0.3);
      if (p.text) progressText.value = String(p.text);
    });
  }
});
onBeforeUnmount(() => { if (offProgress) offProgress(); if (offOmr) offOmr(); for (const u of overlayUrls) URL.revokeObjectURL(u); });
</script>

<template>
  <div class="sc-wrap">
    <div class="sc-head">
      <div class="sc-title"><Icon name="score" :size="16" /> {{ t('变谱') }}</div>
      <div class="sc-sub">{{ t('任何形态的谱面，直接变成可编辑的 MIDI 工程；支持多选与拖拽。') }}</div>
    </div>

    <div class="sc-card sc-in" :class="{ 'sc-drop': dropOn }"
         @dragenter.prevent="dropOn = true" @dragover.prevent="dropOn = true"
         @dragleave="dropOn = false" @drop="onDrop">
      <div class="sc-row">
        <button class="btn primary sc-main" :disabled="busy" @click="pick">
          <Icon name="import" :size="14" />
          <span>{{ busy ? progressText || t('转换中…') : t('选择谱面文件…') }}</span>
        </button>
        <div class="sc-fmt">
          <span class="sc-chip">MusicXML / MXL</span>
          <span class="sc-chip">PDF</span>
          <span class="sc-chip">PNG · JPG · GIF · WebP · BMP · TIFF</span>
          <span class="sc-chip">MIDI</span>
        </div>
      </div>
      <div class="sc-prog" v-if="busy">
        <div class="sc-prog-bar" :style="{ width: Math.max(4, progress) + '%' }"></div>
      </div>
      <TransitionGroup v-if="files.length" name="sc-file" tag="ul" class="sc-files">
        <li v-for="(f, i) in files" :key="f + i">
          <Icon name="score" :size="11" /> <span>{{ f }}</span>
        </li>
      </TransitionGroup>
      <div class="sc-hint">
        {{ t('图片与 PDF 走光学识谱：分辨率越高越准，建议每页宽度 1200 像素以上、五线谱占满页面。') }}
        {{ t('可以多选：一次选多张图片，或把多个文件直接拖进来。') }}
      </div>
      <div v-if="omrEngine && !omrEngine.installed" class="sc-engine">
        <Icon name="spark" :size="14" />
        <div class="sc-engine-tx">
          <b>{{ t('装上「识谱增强引擎」会好一个量级') }}</b>
          <span>{{ t('图片与 PDF 的识谱默认用内置引擎（离线可用）；装上 Audiveris（约 81 MB）后，变化音、节拍与小节结构都会明显更准。') }}</span>
          <span v-if="omrBusy" class="sc-engine-prog">{{ omrText }}</span>
        </div>
        <button class="btn sm primary" :disabled="omrBusy" @click="installOmr">
          <Icon name="download" :size="12" /> {{ omrBusy ? t('安装中…') : t('安装识谱引擎') }}
        </button>
      </div>
      <div v-else-if="omrEngine && omrEngine.installed" class="sc-engine on">
        <Icon name="spark" :size="13" />
        <span>{{ t('识谱增强引擎已就绪：Audiveris') }} {{ omrEngine.version }}</span>
      </div>

      <div class="sc-opts">
        <label class="sc-opt">
          <span>{{ t('拍号') }}</span>
          <select v-model.number="beats" :disabled="busy">
            <option :value="2">2/4</option>
            <option :value="3">3/4</option>
            <option :value="4">4/4</option>
            <option :value="6">6/8</option>
          </select>
          <select v-model.number="beatType" :disabled="busy">
            <option :value="4">/4</option>
            <option :value="8">/8</option>
          </select>
        </label>
        <label class="sc-opt">
          <span>{{ t('速度') }}</span>
          <input type="number" min="20" max="300" step="1" v-model.number="tempo" :disabled="busy" />
          <span class="sc-unit">BPM</span>
        </label>
      </div>
    </div>

    <div v-if="err" class="sc-err sc-in"><Icon name="warn" :size="14" /> {{ err }}</div>

    <div v-if="info" class="sc-card sc-in">
      <div class="sc-stats">
        <span v-if="info.tracks"><b>{{ info.tracks.length }}</b>{{ t(' 个声部') }}</span>
        <span><b>{{ noteTotal }}</b>{{ t(' 个音符') }}</span>
        <span>{{ t('时长') }} <b>{{ durSec }}</b></span>
        <span v-if="info.backend || info.engine">{{ t('识别引擎') }} <b>{{ engineName }}</b></span>
        <span v-if="info.accidentals !== undefined">{{ t('变化音') }} <b>{{ info.accidentals }}</b></span>
        <span v-if="info.spacing">{{ t('谱线间距') }} <b>{{ info.spacing }}px</b></span>
        <span v-if="info.tempoChanges > 1" class="muted">{{ t('速度变化 ') }}{{ info.tempoChanges }}{{ t(' 次') }}</span>
        <span v-if="info.pages > 1" class="muted">{{ info.pages }}{{ t(' 页') }}</span>
      </div>
      <ul v-if="warnings.length" class="sc-warn">
        <li v-for="(w, i) in warnings" :key="i"><Icon name="warn" :size="12" /> {{ w }}</li>
      </ul>
      <div class="sc-preview"><canvas ref="previewEl"></canvas></div>
      <div class="sc-tracks">
        <span v-for="(tr, i) in tracks" :key="i" class="sc-tr">
          {{ tr.name }} · {{ noteCountOf(tr) }}{{ t(' 音') }}
        </span>
      </div>

      <div v-if="overlays.length" class="sc-ov">
        <div class="sc-ov-head">
          <span>{{ t('识别对照图') }}</span>
          <span class="sc-ov-tabs">
            <button v-for="(u, i) in overlays" :key="i" :class="{ on: i === ovIndex }" @click="ovIndex = i">{{ i + 1 }}</button>
          </span>
        </div>
        <div class="sc-ov-box">
          <img :src="overlays[ovIndex]" :key="ovIndex" class="sc-ov-img" alt="" />
        </div>
        <div class="sc-ov-legend">
          <span class="lg lg-note">{{ t('符头') }}</span>
          <span class="lg lg-acc">{{ t('变化音') }}</span>
          <span class="lg lg-bar">{{ t('小节线') }}</span>
        </div>
      </div>

      <div class="sc-actions">
        <button class="btn primary" @click="importToLibrary"><Icon name="music" :size="14" /> {{ t('导入曲库并打开') }}</button>
        <button class="btn" @click="saveAs"><Icon name="save" :size="14" /> {{ t('另存为 MIDI…') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sc-wrap { padding: 18px 20px 26px; max-width: 980px; }
.sc-head { margin-bottom: 12px; }
.sc-title { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; color: var(--text); }
.sc-sub { margin-top: 4px; font-size: 12.5px; color: var(--muted); }
.sc-card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
.sc-in { animation: scIn 0.28s cubic-bezier(.2,.7,.3,1) both; }
@keyframes scIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.sc-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.sc-main { min-width: 168px; }
.sc-fmt { display: flex; gap: 6px; flex-wrap: wrap; }
.sc-chip { font-size: 11px; color: var(--muted); border: 1px solid var(--line); border-radius: 999px; padding: 2px 9px; }
.sc-prog { margin-top: 12px; height: 4px; border-radius: 3px; background: color-mix(in srgb, var(--line) 70%, transparent); overflow: hidden; }
.sc-prog-bar { height: 100%; border-radius: 3px; background: linear-gradient(90deg, #5ac8fa, #bf5af2, #5ac8fa); background-size: 200% 100%; animation: scFlow 1.1s linear infinite; transition: width 0.3s ease; }
@keyframes scFlow { from { background-position: 0 0; } to { background-position: 200% 0; } }
.sc-hint { margin-top: 10px; font-size: 11.5px; color: var(--muted); line-height: 1.6; }
/* 拖拽悬停：整卡描边亮起（时长/缓动跟全局一致：0.2~0.34s + cubic-bezier(.2,.7,.3,1)） */
.sc-card.sc-drop { border-color: color-mix(in srgb, #5ac8fa 60%, var(--line));
  background: color-mix(in srgb, #5ac8fa 8%, var(--panel));
  transition: border-color .2s cubic-bezier(.2,.7,.3,1), background .2s cubic-bezier(.2,.7,.3,1); }
/* 文件列表：多选/拖拽进来的文件逐个滑入 */
.sc-files { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.sc-files li { display: inline-flex; align-items: center; gap: 5px; max-width: 260px;
  padding: 3px 9px; border-radius: 999px; border: 1px solid var(--line); background: var(--bg);
  font-size: 11px; color: var(--muted); }
.sc-files li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-file-enter-active { transition: opacity .24s cubic-bezier(.2,.7,.3,1), transform .24s cubic-bezier(.2,.7,.3,1); }
.sc-file-leave-active { transition: opacity .16s ease, transform .16s ease; position: absolute; }
.sc-file-enter-from { opacity: 0; transform: translateY(-6px) scale(.96); }
.sc-file-leave-to { opacity: 0; transform: scale(.96); }
.sc-file-move { transition: transform .24s cubic-bezier(.2,.7,.3,1); }
.sc-engine { margin-top: 10px; display: flex; align-items: center; gap: 10px; padding: 9px 12px;
  border: 1px solid color-mix(in srgb, #5ac8fa 45%, var(--line)); border-radius: 9px;
  background: linear-gradient(100deg, color-mix(in srgb, #5ac8fa 12%, transparent), transparent 70%);
  animation: scIn .3s cubic-bezier(.2,.7,.3,1) both; }
.sc-engine.on { border-color: var(--line); background: none; font-size: 11.5px; color: var(--muted); }
.sc-engine-tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sc-engine-tx b { font-size: 12.5px; color: var(--text); }
.sc-engine-tx span { font-size: 11.5px; color: var(--muted); line-height: 1.5; }
.sc-engine-prog { font-variant-numeric: tabular-nums; color: #7fd4ff !important; }
.sc-engine .btn { margin-left: auto; flex: none; }
.sc-opts { margin-top: 10px; display: flex; gap: 16px; flex-wrap: wrap; }
.sc-opt { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.sc-opt select, .sc-opt input { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; font-size: 12px; }
.sc-opt input { width: 64px; }
.sc-unit { opacity: 0.7; }
.sc-err { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-radius: 8px; background: color-mix(in srgb, #ff453a 14%, transparent); border: 1px solid color-mix(in srgb, #ff453a 40%, transparent); color: #ff8a80; font-size: 12.5px; margin-bottom: 12px; }
.sc-stats { display: flex; gap: 16px; flex-wrap: wrap; font-size: 12.5px; color: var(--muted); }
.sc-stats b { color: var(--text); font-weight: 600; }
.sc-warn { margin: 10px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 4px; }
.sc-warn li { display: flex; align-items: flex-start; gap: 6px; font-size: 12px; color: #ffb340; line-height: 1.5; }
.sc-preview { margin-top: 12px; height: 190px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.sc-preview canvas { width: 100%; height: 100%; display: block; }
.sc-tracks { margin-top: 8px; display: flex; gap: 10px; flex-wrap: wrap; font-size: 11.5px; color: var(--muted); }
.sc-tr { border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; }
.sc-ov { margin-top: 14px; }
.sc-ov-head { display: flex; align-items: center; justify-content: space-between; font-size: 12.5px; color: var(--text); }
.sc-ov-tabs { display: flex; gap: 4px; }
.sc-ov-tabs button { min-width: 24px; height: 22px; border-radius: 6px; border: 1px solid var(--line); background: var(--bg); color: var(--muted); font-size: 11.5px; cursor: pointer; transition: all 0.16s ease; }
.sc-ov-tabs button.on { color: #fff; background: #5ac8fa; border-color: #5ac8fa; }
.sc-ov-box { margin-top: 8px; max-height: 460px; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.sc-ov-img { display: block; width: 100%; animation: scFade 0.22s ease both; }
@keyframes scFade { from { opacity: 0; } to { opacity: 1; } }
.sc-ov-tabs button:hover { border-color: color-mix(in srgb, #5ac8fa 55%, var(--line)); color: var(--text); }
.sc-ov-legend { margin-top: 6px; display: flex; gap: 14px; font-size: 11px; color: var(--muted); }
.lg::before { content: ''; display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 5px; vertical-align: -1px; }
.lg-note::before { background: #e62828; }
.lg-acc::before { background: #009600; }
.lg-bar::before { background: #ff00ff; }
.sc-actions { margin-top: 14px; display: flex; gap: 10px; }
</style>
