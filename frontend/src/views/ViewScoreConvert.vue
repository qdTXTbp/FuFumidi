<script setup lang="ts">
import { CHART_RAMP } from '../core/palette.js';
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
import { retryablePages, pagesSummary } from '../core/score-pages.js';

const app = useAppStore();
const busy = ref(false);
const err = ref('');
const srcName = ref('');
const info = ref<any>(null);
const midiBytes = ref<Uint8Array | null>(null);
const tracks = ref<any[]>([]);
const previewEl = ref<HTMLCanvasElement | null>(null);
const overlays = ref<string[]>([]);        // 对照图 objectURL（带红圈/彩框，用来验收识别质量）
const pages = ref<string[]>([]);            // 同顺序的**未标注**原谱页图路径（§6.4 拿它当工作台底图）
const files = ref<string[]>([]);            // 本次转换吃进去的文件（多选/拖拽时是多个）
// 识谱增强引擎（Audiveris）：没装就在卡片下方给一条「装了会好一个量级」的可操作提示
const omrEngine = ref<any>(null);
const homrEngine = ref<any>(null);
const srEngine = ref<any>(null);              // 超分辨率组件（M3-2，低清扫描用）
const omrBusy = ref(false);
const omrText = ref('');
let offOmr: null | (() => void) = null;
async function refreshOmr() {
  try { omrEngine.value = await bridge().omrEngine?.status(); } catch (e) { omrEngine.value = null; }
  // homr（AI 识谱）：用户自行安装的第二个引擎，模型卡上要如实标「装没装」
  try { homrEngine.value = await bridge().omrEngine?.homrStatus?.(); } catch (e) { homrEngine.value = null; }
  // 超分辨率（M3-2）：同上，低清扫描才用得到
  try { srEngine.value = await bridge().omrEngine?.srStatus?.(); } catch (e) { srEngine.value = null; }
}

/** ★ 变谱要用到的四样组件 —— 提示就放在**用它的这一页**（用户实测反馈：
 *  「变谱用到的模型和 OCR 语言包」在资源中心找不到；它们确实不在资源中心默认打开的
 *  「模型管理」页签里，而在「资源管理」页签）。这里列出状态，缺哪项一句话说清，并给直达按钮。 */
const omrComponents = computed(() => {
  const av = !!(omrEngine.value && omrEngine.value.installed);
  const hm = !!(homrEngine.value && homrEngine.value.ready);
  const sr = !!(srEngine.value && srEngine.value.installed);
  const lg = ocrLangs.value.length > 0;
  return [
    { id: 'audiveris', name: t('Audiveris 增强引擎'), on: av, size: '158 MB', note: t('印刷谱首选：小节结构与变化音更准') },
    { id: 'homr', name: t('homr（AI 识谱）'), on: hm, size: '300 MB', note: t('扫描件 / 拍照首选：神经网络整页识谱') },
    { id: 'sr', name: t('超分辨率（低清扫描）'), on: sr, size: '40 MB', note: t('谱表量不出来或行距 < 5px 时先神经放大') },
    { id: 'ocr', name: t('OCR 语言包'), on: lg, size: '23 MB', note: t('读乐器名 / 速度记号 / 和弦名') },
  ];
});
const omrMissing = computed(() => omrComponents.value.filter((x: any) => !x.on).length);
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
// ★ 拍号/速度默认「自动」：谱面自己写的优先，用户填了才覆盖。
//   以前这两个控件在 Audiveris 路径上根本传不到引擎（只用于经典后端），
//   也就是「做了但没作用」—— 现在 --beats auto / --tempo auto 是真读的。
const beats = ref('auto');            // auto | 2 | 3 | 4 | 6
const beatType = ref(4);              // 4 | 8
const autoTempo = ref(true);
const tempo = ref(120);
// 预处理与后处理参数（真接到引擎：--upscale / --thicken / --quantize / --min-note-ms / --dedupe）
const upscale = ref('auto');          // auto | 1 | 2 | 3 | 4（auto = 按实测谱线间距推，上限 19M 像素）
const thicken = ref(false);           // 二值化后加粗：只对「谱线断裂的扫描件」有利
// ★ M3-3 共用影像预处理层：去倾斜 + Sauvola 局部二值化 + 去噪点。
//   auto = 逐页判断「像不像扫描件/照片」，像才上（干净印刷谱实测与旧路径逐像素一致）。
const prep = ref('auto');             // off | auto | scan
// ★ M3-2 超分辨率：off | auto（只在谱表量不出来 / 行距 < 5px 时才开）| on（强制）
const sr = ref('auto');               // 需要用户在资源中心装 waifu2x（约 40 MB），没装则自动跳过
/** ★ M2-4「一键重试该页」：记下这次跑到的东西（页图路径 / workdir / 参数），
 *  失败页点一下就只重跑那一页，其余页从引擎的按页缓存读回来。 */
const lastRun = ref<any>(null);
const quantize = ref('off');          // off | 1/4 | 1/8 | 1/16 | 1/32
const minNoteMs = ref(0);             // 丢掉过短音符（毫秒）0 = 不过滤
const dedupe = ref(true);             // 同一个符头被识别两次时去重
// 移调乐器：谱面上写的是「记谱音高」（Horn in F 差纯五度），MIDI 里一般要实际音高
const sounding = ref(true);           // true = 实际音高（推荐） / false = 按谱面记谱音高
// OCR 语言包状态：没装的话 Audiveris 读不出乐器名 / 速度记号 / 和弦名（TEXTS 步直接跳过）
const ocrLangs = ref<string[]>([]);
async function loadOcrLangs() {
  try {
    const b = bridge();
    const r = (b && b.omrEngine && b.omrEngine.langStatus) ? await b.omrEngine.langStatus() : null;
    ocrLangs.value = ((r && r.installed) || []).map((x: any) => String(x.code));
  } catch (e) { ocrLangs.value = []; }
}
/** 跳到资源中心的**资源管理**页签 —— 识谱引擎 / OCR 语言包 / 超分辨率组件都在那里。
 *  ★ 不能只 setView('resources')：那样同步出来的 hash 是 #/resources（不带 tab），
 *    ViewResources 会默认落在「模型管理」，用户在那儿根本看不到识谱引擎（实测反馈）。 */
/** 在变谱页直接下载组件，不再要求用户跳到资源中心。 */
async function installOne(id: string) {
  const b = bridge();
  if (!b || !b.omrEngine) throw new Error(t('当前环境不支持组件安装'));
  if (id === 'audiveris') return await b.omrEngine.install();
  if (id === 'homr') return await b.omrEngine.homrInstall();
  if (id === 'sr') return await b.omrEngine.srInstall();
  if (id === 'ocr') return await b.omrEngine.langInstall(['eng', 'chi_sim']);
  throw new Error('unknown component');
}

async function installComponent(id: string) {
  if (omrBusy.value) return;
  omrBusy.value = true; omrText.value = t('准备下载…');
  try {
    const r = await installOne(id);
    const ok = !!(r && r.ok !== false && (r.installed || r.ready || r.added));
    if (ok) { app.toast(t('组件已安装'), 'ok'); await refreshOmr(); await loadOcrLangs(); }
    else app.toast(t('组件下载失败：') + String((r && r.error) || ''), 'warn');
  } catch (e: any) {
    app.toast(t('组件下载失败：') + String((e && e.message) || e), 'warn');
  } finally { omrBusy.value = false; omrText.value = ''; }
}

async function installAllMissing() {
  if (omrBusy.value || !omrMissing.value) return;
  omrBusy.value = true;
  try {
    for (const c of omrComponents.value.filter((x: any) => !x.on)) {
      omrText.value = t('正在下载：') + c.name;
      await installOne(c.id);
      await refreshOmr();
    }
    await loadOcrLangs();
    app.toast(t('缺失组件已全部安装'), 'ok');
  } catch (e: any) {
    app.toast(t('组件下载失败：') + String((e && e.message) || e), 'warn');
  } finally { omrBusy.value = false; omrText.value = ''; }
}

async function refreshOmrComponents() {
  await refreshOmr();
  await loadOcrLangs();
}

/** 识别模型 = 后端（Audiveris / 内置）+ 内置后端的模式。
 *  图片与 PDF 才有模型可选；MusicXML / MIDI 是直通或精确解析，不经过识谱。 */
const model = ref('auto');
const MODELS = [
  { id: 'auto', name: '自动', sub: '有增强引擎就用它，没有就内置识谱', need: false },
  { id: 'audiveris', name: 'Audiveris 增强', sub: '印刷谱首选：小节结构与变化音更准', need: true },
  { id: 'homr', name: 'homr（AI 识谱）', sub: '扫描件 / 拍照首选：神经网络整页识谱', needHomr: true },
  { id: 'classical', name: '内置识谱 · 通用', sub: '离线可用，不装任何东西也能跑', need: false },
  { id: 'piano', name: '内置识谱 · 钢琴谱', sub: '按大谱表分组，适合单乐器钢琴谱', need: false },
  { id: 'melody', name: '内置识谱 · 单旋律', sub: '只抽主旋律，适合单声部曲谱', need: false },
];
const curModel = computed(() => MODELS.find((m) => m.id === model.value) || MODELS[0]);
function modelArgs() {
  const id = model.value;
  if (id === 'audiveris') return { backend: 'audiveris', mode: 'auto' };
  if (id === 'homr') return { backend: 'homr', mode: 'auto' };
  if (id === 'classical') return { backend: 'classical', mode: 'auto' };
  if (id === 'piano') return { backend: 'classical', mode: 'piano' };
  if (id === 'melody') return { backend: 'classical', mode: 'melody' };
  return { backend: 'auto', mode: 'auto' };
}
/** 谱面类型一键预设：单乐器 / 总谱 / 扫描件的参数差别很大，直接给三套。 */
const SCENES = [
  { id: 'single', icon: 'music', name: '单乐器 · 钢琴谱', desc: '2 行大谱表、页宽通常够，别加粗',
    set: { model: 'audiveris', upscale: 'auto', thicken: false, prep: 'off', quantize: 'off', dedupe: true } },
  { id: 'full', icon: 'score', name: '管弦乐总谱', desc: '一页几十行谱表，个别页可能识别失败（会列出来）',
    set: { model: 'audiveris', upscale: 'auto', thicken: false, prep: 'off', quantize: 'off', dedupe: true } },
  { id: 'scan', icon: 'expand', name: '扫描件 · 手机拍照', desc: '歪的 / 有阴影 / 有灰点：先摆正再二值化',
    set: { model: 'audiveris', upscale: 4, thicken: false, prep: 'auto', sr: 'auto', quantize: '1/16', dedupe: true } },
];
function applyScene(s: any) {
  const v = s.set || {};
  if (v.model) model.value = v.model;
  if (v.upscale !== undefined) upscale.value = v.upscale;
  if (v.thicken !== undefined) thicken.value = !!v.thicken;
  if (v.prep) prep.value = v.prep;
  if (v.sr) sr.value = v.sr;
  if (v.quantize) quantize.value = v.quantize;
  if (v.dedupe !== undefined) dedupe.value = !!v.dedupe;
  app.toast(t('已套用：') + t(s.name), 'ok');
}

let offProgress: null | (() => void) = null;
const overlayUrls: string[] = [];

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64 || '');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bridge(): any { return (window as any).fuBridge; }

/** PDF → 每页一张 PNG（base64）。
 *  ★ 目标宽度 3200px：PDF 多是矢量图，直接渲到高分辨率远比「先渲 1700px 再让引擎放大」清楚。
 *    总谱一行谱线间距在 1700px 下只有 6px（低于 Audiveris 的 11px 下限，整页会被判 invalid），
 *    3200px 下约 12px 才够它用。上限 6 倍是为了别把内存和 IPC 撑爆（A4 约 3200×4500 ≈ 1400 万像素）。 */
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
    const scale = Math.min(6, Math.max(1, 3200 / Math.max(1, vp0.width)));
    const vp = page.getViewport({ scale });
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(vp.width));
    cv.height = Math.max(1, Math.round(vp.height));
    const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
    ctx.fillStyle = '#ffffff';   // ui-tokens-allow: 取景画布的纸面白（PDF/图片栅格化），导出内容不该随界面主题变
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
  const scale = Math.min(3, Math.max(1, 2400 / Math.max(1, bmp.width)));
  cv.width = Math.round(bmp.width * scale);
  cv.height = Math.round(bmp.height * scale);
  const ctx = cv.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#ffffff';   // ui-tokens-allow: 取景画布的纸面白（PDF/图片栅格化），导出内容不该随界面主题变
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
    const base = baseOpts();
    let r = await run({ ...base, inputs });
    if (!r || r.canceled) {
      if (r && r.canceled) { canceling.value = false; app.toast(t('已取消识别'), 'warn'); }
      return;
    }
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
          if (canceling.value) { canceling.value = false; return; }
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
    await applyResult(r, label, base);
  } catch (e: any) {
    err.value = String((e && e.message) || e);
  } finally {
    busy.value = false;
    progressText.value = '';
  }
}

const canceling = ref(false);
/** 取消当前识别：主进程标记 canceled + 杀掉引擎子进程；界面在结果回来时收尾（busy 由 finally 复位）。 */
async function cancelRun() {
  const b = bridge();
  if (!b || typeof b.scoreCancel !== 'function') return;
  canceling.value = true;
  try { await b.scoreCancel(); app.toast(t('正在取消…'), 'warn'); } catch (e) { /* 忽略 */ }
}

/** 当前界面上的全部识别参数（首次转换与「重试该页」共用，所以重试前改参数是生效的）。 */
function baseOpts() {
  return {
    beats: beats.value, beatType: beatType.value,
    tempo: autoTempo.value ? 'auto' : tempo.value,
    ...modelArgs(),
    upscale: upscale.value, thicken: !!thicken.value, prep: prep.value, sr: sr.value,
    quantize: quantize.value, minNoteMs: Number(minNoteMs.value) || 0,
    dedupe: !!dedupe.value,
    sounding: !!sounding.value,
  };
}

/** 结果落地（首次转换与「重试该页」共用同一条收尾）。 */
async function applyResult(r: any, label?: string, base?: any) {
  kind.value = r.kind || '';
  const bytes = b64ToBytes(r.bytes || '');
  midiBytes.value = bytes;
  info.value = r.info || null;
  srcName.value = r.fileName || srcName.value;
  progress.value = 88; progressText.value = t('生成试看…');
  try {
    loadOcrLangs();
    const mid = parseMidi(bytes);
    tracks.value = (mid.tracks || []).filter((x: any) => (x.notes || []).length);
    await nextTick();
    drawPreview();
  } catch (e) { /* 预览失败不影响导入 */ }
  if (r.overlays && r.overlays.length) await loadOverlays(r.overlays);
  pages.value = (r.pages && r.pages.length) ? r.pages.slice() : [];
  if (r.names && r.names.length) files.value = r.names.slice();
  progress.value = 100;
  const n = (r.info && (r.info.notes || r.info.noteCount)) || 0;
  app.toast(t('已转换：') + String(n) + t(' 个音符'), 'ok');
  if (label) srcName.value = label;
  // 只有「每页一个文件」的栅格输入才能单页重跑（PDF 已逐页栅格化成独立文件）
  const pg: string[] = (r.pages || []).slice();
  const wd = (r.info && r.info.workdir) || r.workdir || '';
  lastRun.value = (pg.length > 1 && wd && base) ? { pages: pg, workdir: wd, opts: base, name: srcName.value } : null;
}

/** 没解析出音符的页（含被跳过的页）—— 这些才给「重试该页」。
 *  判据在 core/score-pages.js 里（纯函数，有单测）；没有上次的页图/workdir 就不给按钮。 */
const failedPages = computed(() => (lastRun.value
  ? retryablePages(info.value, pageRows.value.map((x: any) => x.page)) : []));

/** 只重跑第 n 页（引擎按页缓存，其余页读缓存后整份重新合并）。 */
async function retryPage(n: number) {
  const lr = lastRun.value;
  if (!lr) { app.toast(t('这次没有留下可重试的页'), 'warn'); return; }
  busy.value = true; err.value = '';
  progress.value = 20; progressText.value = t('只重跑第 ') + n + t(' 页…');
  // ★ 用**当前界面上的参数**重跑（不是上次那份）：用户往往是先改了参数再点重试
  //   （例如「这页太糊 → 打开超分 → 重试该页」）。输入页集与 workdir 沿用上次的。
  const opts = baseOpts();
  try {
    const r = await run({ ...opts, inputs: lr.pages.map((p) => ({ path: p })), name: lr.name,
      retryPage: n, workdir: lr.workdir });
    if (!r || !r.ok) {
      err.value = String((r && r.error) || t('重试失败'));
      app.toast(String((r && r.error) || t('重试失败')), 'warn');
      return;
    }
    await applyResult(r, undefined, opts);
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
  const colors = CHART_RAMP;
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
  if (b === 'homr') return 'homr (AI)';
  if (b === 'classical') return t('内置识谱');
  return b || '—';
});
/** 轨名一律显示引擎给的 label（中文名），拿不到就用 MIDI 里的 ASCII 轨名。 */
const trackChips = computed(() => {
  const it = (info.value && info.value.tracks) || [];
  if (it.length) return it.map((x: any) => ({ name: x.label || x.name, n: Number(x.notes) || 0, range: x.range || null }));
  return (tracks.value || []).map((x: any) => ({ name: x.name || '', n: (x.notes || []).length, range: null }));
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
    if (w && w.code === 'page-failed') {
      // 引擎已把原因归类（fail），这里翻成「下一步怎么做」；拿不准就把原文附上
      const why = Array.isArray(w.reasons) && w.reasons.length ? '（' + String(w.reasons[0]).slice(0, 90) + '）' : '';
      const hint = ({
        lowres: t('分辨率不足：把「放大倍数」调到 4×，或换更高清的图。'),
        oom: t('内存不足（已自动降档重试）：仍失败就把放大倍数调小一档。'),
        timeout: t('识别超时：这一页太密，建议拆页或把放大倍数调小。'),
        'no-staves': t('没找到五线谱：确认这一页是谱面，而不是封面或纯文字页。'),
        'beam-guess': t('符杠厚度估算不可靠：常见于符杠很少的页，可试「加粗谱线」。'),
        export: t('识别完成但导出失败：多为分辨率或内存问题，已自动降档重试过。'),
      } as any)[w.fail] || '';
      return t('第 ') + w.page + t(' 页识别失败，已跳过') + (hint ? '：' + hint : why) + '。';
    }
    if (w && w.code === 'page-partial') return t('只成功了 ') + w.ok + '/' + w.total + t(' 页，其余页没有解析出音符。');
    if (w && w.code === 'page-unreadable') return t('第 ') + w.page + t(' 页的 MusicXML 解析失败，已跳过。');
    if (w && w.code === 'no-ocr-lang') return t('没装 OCR 语言包：乐器名、速度记号、和弦名都读不出来（声部只能叫「声部 N」）。可在「资源中心 → 识谱引擎」装英语包，约 23 MB。');
    if (w && w.code === 'raw-timing') return t('时值未做网格对齐：识谱抖动大时可以打开「量化」。');
    if (w && w.code === 'postprocess-failed') return t('后处理（量化/去重）失败，已按原始时值输出。');
    return String((w && w.code) || w || '');
  });
});
const noteTotal = computed(() => (info.value && (info.value.notes || info.value.noteCount)) || 0);
/** 后处理明细（量化/去重/丢短音），让「参数真的生效了」看得见。 */
const ppStats = computed(() => (info.value && info.value.stats) || null);
/** 体检项 → 人话（M2-4：结构问题要一眼看得见，错几个音是小事、丢小节是大事）。 */
function issueText(x: any) {
  if (!x) return '';
  if (x.code === 'empty-page') return t('这一页没识别到音符');
  if (x.code === 'bar-count-mismatch') return t('各声部小节数不一致（') + x.min + '~' + x.max + t(' 小节）');
  if (x.code === 'neg-duration') return t('有非正时值的音符 ') + x.n + t(' 个');
  if (x.code === 'long-hold') return t('超长音 ') + x.n + t(' 个（可能是连音线没闭合）');
  if (x.code === 'same-pitch-dup') return t('同刻同音重复 ') + x.n + t(' 处');
  return String(x.code);
}
/** 逐页：小节数 + 音符数 + 放大倍数 + 体检结论（哪页出问题一眼看得出）。 */
const pageRows = computed(() => {
  const r = info.value || {};
  const per = r.notesPerPage || [];
  const scales = r.scales || [];
  const checks = r.pageChecks || [];
  return per.map((n: number, i: number) => {
    const c = checks[i] || {};
    return {
      page: c.page || i + 1, system: c.system || 0, notes: n, scale: scales[i] || 0,
      bars: c.bars || 0, issues: ((c.issues || []) as any[]).map((x) => issueText(x)),
    };
  });
});
const durSec = computed(() => {
  const ms = (info.value && info.value.durationMs) || 0;
  return ms ? (ms / 1000).toFixed(1) + 's' : '—';
});

/** §6.4 校对：把原谱页图交给编辑页当半透明底图，并把这个 MIDI 载入工作台。
 *  交接走 window.__fufumidiUnderlay（一次性），编辑页在 onMounted/onActivated 里取走。 */
async function proofreadInWorkbench() {
  if (!midiBytes.value || !srcName.value) { app.toast(t('请先转换出一份 MIDI'), 'warn'); return; }
  const page = pages.value[ovIndex.value] || pages.value[0] || overlays.value[ovIndex.value] || overlays.value[0] || '';
  if (!page) { app.toast(t('这次没留下页图：请用图片或 PDF 转换后再校对'), 'warn'); return; }
  (window as any).__fufumidiUnderlay = page;
  try {
    await app.importFiles([{ name: srcName.value.replace(/\.[^.]+$/, '') + '.mid', bytes: midiBytes.value }]);
  } catch (e: any) { app.toast(t('导入失败：') + String((e && e.message) || e), 'warn'); return; }
  app.setView('edit');
  app.toast(t('已把谱面页图垫到工作台底图'), 'ok');
}

async function importToLibrary() {
  if (!midiBytes.value || !srcName.value) return;
  try {
    await app.importFiles([{ name: srcName.value.replace(/\.[^.]+$/, '') + '.mid', bytes: midiBytes.value }]);
    app.toast(t('已导入曲库'), 'ok');
  } catch (e: any) { app.toast(t('导入失败：') + String((e && e.message) || e), 'warn'); }
}

/** 一键「以总谱查看」：把刚转出来的 MIDI 存进曲库并切到乐谱页的总谱模式。
 *  交接走 window.__fufumidiScoreMode（一次性），乐谱页激活时取走 —— 与页图底图同一套做法。 */
async function openAsFullScore() {
  if (!midiBytes.value || !srcName.value) { app.toast(t('请先转换出一份 MIDI'), 'warn'); return; }
  (window as any).__fufumidiScoreMode = 'score';
  try {
    await app.importFiles([{ name: srcName.value.replace(/.[^.]+$/, '') + '.mid', bytes: midiBytes.value }]);
  } catch (e: any) { app.toast(t('导入失败：') + String((e && e.message) || e), 'warn'); return; }
  app.setView('score');
  app.toast(t('已按总谱打开'), 'ok');
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
  loadOcrLangs();
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
  <div class="page sc-wrap">
    <div class="page-head">
      <div class="page-ic"><Icon name="score" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ t('变谱') }}</div>
        <div class="page-sub">{{ t('谱面 → MIDI · 光学识谱 + MusicXML 精确解析 · 离线完成') }}</div>
      </div>
      <span class="tag" :class="{ 'warn-tag': !!(omrEngine && !omrEngine.installed) }">
        {{ omrEngine && omrEngine.installed ? t('识谱增强引擎已就绪') : t('内置识谱（离线）') }}
      </span>
      <button v-if="omrEngine && !omrEngine.installed" class="btn sm" :disabled="omrBusy" @click="installOmr">
        <Icon name="download" :size="13" /> {{ omrBusy ? t('安装中…') : t('安装识谱引擎') }}
      </button>
    </div>

    <div class="sc-grid">
    <div class="sc-col">
    <div class="card sc-card sc-in" :class="{ 'sc-drop-on': dropOn }"
         @dragenter.prevent="dropOn = true" @dragover.prevent="dropOn = true"
         @dragleave="dropOn = false" @drop="onDrop">
      <div class="sc-dropzone" :class="{ over: dropOn }" @click="pick">
        <div class="sc-dz-ic"><Icon name="score" :size="26" /></div>
        <div class="sc-dz-tx">
          <b>{{ dropOn ? t('释放以上传') : t('拖入谱面 / 点击选择') }}</b>
          <span>{{ t('PNG · JPG · PDF · MusicXML / MXL · MIDI · 支持多选') }}</span>
        </div>
      </div>
      <div class="sc-row">
        <button class="btn primary sc-main" :disabled="busy" @click="pick">
          <Icon name="import" :size="14" />
          <span>{{ busy ? progressText || t('转换中…') : t('选择谱面文件…') }}</span>
        </button>
        <button v-if="busy" class="btn sc-cancel" :disabled="canceling" :title="t('取消这次识别')" @click="cancelRun">
          <Icon name="close" :size="13" /> {{ canceling ? t('正在取消…') : t('取消') }}
        </button>
        <span class="tag">{{ t('多选 / 拖拽 / PDF 自动栅格化') }}</span>
      </div>
      <div class="sc-prog" v-if="busy">
        <div class="sc-prog-bar" :style="{ transform: 'scaleX(' + ((Math.max(4, progress)) / 100) + ')' }"></div>
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

      <div class="sc-opts-line">
        <span>{{ t('识别模型') }}<b>{{ t(curModel.name) }}</b></span>
        <span>{{ t('放大') }}<b>{{ upscale === 'auto' ? t('自动') : upscale + '×' }}</b></span>
        <span>{{ t('量化') }}<b>{{ quantize === 'off' ? t('不对齐') : quantize }}</b></span>
        <span v-if="thicken">{{ t('加粗谱线') }}</span>
        <span v-if="prep !== 'off'">{{ t('影像预处理') }}<b>{{ prep === 'scan' ? t('强制') : t('自动') }}</b></span>
        <span v-if="sr !== 'off'">{{ t('超分辨率') }}<b>{{ sr === 'on' ? t('强制') : t('自动') }}</b></span>
      </div>
    </div>

    <div v-if="err" class="sc-err sc-in"><Icon name="warn" :size="14" /> {{ err }}</div>

    <!-- ★ 识别参数（用户：「识别参数模块应该放到第一张图片的两个模块之间」）：
         原先在右栏，调参时看不到结果；现在夹在「导入」卡与「结果」卡之间，
         并摊成多列 —— 主栏比右栏宽得多，一列排十行会把结果卡挤出屏幕。 -->
      <div class="card sc-card sc-params">
      <div class="sc-param-grid">
      <label class="sc-field">
        <span class="sc-field-nm">{{ t('拍号') }}</span>
        <select v-model="beats" :disabled="busy">
          <option value="auto">{{ t('自动') }}</option>
          <option value="2">2/4</option>
          <option value="3">3/4</option>
          <option value="4">4/4</option>
          <option value="6">6/8</option>
        </select>
        <select v-model.number="beatType" :disabled="busy || beats === 'auto'">
          <option :value="4">/4</option>
          <option :value="8">/8</option>
        </select>
      </label>
      <label class="sc-field">
        <span class="sc-field-nm">{{ t('速度') }}</span>
        <select v-model="autoTempo" :disabled="busy">
          <option :value="true">{{ t('自动') }}</option>
          <option :value="false">{{ t('指定') }}</option>
        </select>
        <input type="number" min="20" max="300" step="1" v-model.number="tempo" :disabled="busy || autoTempo" />
        <span class="sc-unit">BPM</span>
      </label>
      <label class="sc-field">
        <span class="sc-field-nm">{{ t('放大倍数') }}</span>
        <select v-model="upscale" :disabled="busy">
          <option value="auto">{{ t('自动') }}</option>
          <option value="1">1×</option>
          <option value="2">2×</option>
          <option value="3">3×</option>
          <option value="4">4×</option>
        </select>
      </label>
      <label class="sc-field">
        <span class="sc-field-nm">{{ t('加粗谱线') }}</span>
        <select v-model="thicken" :disabled="busy">
          <option :value="false">{{ t('关') }}</option>
          <option :value="true">{{ t('开') }}</option>
        </select>
      </label>
      <label class="sc-field">
        <span class="sc-field-nm">{{ t('超分辨率') }}</span>
        <select v-model="sr" :disabled="busy">
          <option value="off">{{ t('关') }}</option>
          <option value="auto">{{ t('自动') }}</option>
          <option value="on">{{ t('强制') }}</option>
        </select>
      </label>
      <label class="sc-field">
        <span class="sc-field-nm">{{ t('影像预处理') }}</span>
        <select v-model="prep" :disabled="busy">
          <option value="off">{{ t('关') }}</option>
          <option value="auto">{{ t('自动') }}</option>
          <option value="scan">{{ t('强制') }}</option>
        </select>
      </label>
      <label class="sc-field">
        <span class="sc-field-nm">{{ t('量化网格') }}</span>
        <select v-model="quantize" :disabled="busy">
          <option value="off">{{ t('不对齐') }}</option>
          <option value="1/4">1/4</option>
          <option value="1/8">1/8</option>
          <option value="1/16">1/16</option>
          <option value="1/32">1/32</option>
        </select>
      </label>
      <label class="sc-field">
        <span class="sc-field-nm">{{ t('最短音符') }}</span>
        <select v-model.number="minNoteMs" :disabled="busy">
          <option :value="0">{{ t('不过滤') }}</option>
          <option :value="30">30 ms</option>
          <option :value="60">60 ms</option>
          <option :value="120">120 ms</option>
        </select>
      </label>
      <label class="sc-field">
        <span class="sc-field-nm">{{ t('去重') }}</span>
        <select v-model="dedupe" :disabled="busy">
          <option :value="true">{{ t('开') }}</option>
          <option :value="false">{{ t('关') }}</option>
        </select>
      </label>
      <div class="sc-field">
        <span class="sc-field-nm">{{ t('移调乐器') }}</span>
        <select v-model="sounding" :disabled="busy">
          <option :value="true">{{ t('实际音高') }}</option>
          <option :value="false">{{ t('记谱音高') }}</option>
        </select>
      </div>
      <div class="sc-side-hint sc-param-note">{{ t('速度/拍号默认「自动」：谱面自己写的优先，填了才覆盖。') }}</div>
      </div>
    </div>

    <div v-if="info" class="card sc-card sc-in">
      <div class="sc-stats">
        <span v-if="info.tracks"><b>{{ info.tracks.length }}</b>{{ t(' 个声部') }}</span>
        <span><b>{{ noteTotal }}</b>{{ t(' 个音符') }}</span>
        <span>{{ t('时长') }} <b>{{ durSec }}</b></span>
        <span v-if="info.backend || info.engine">{{ t('识别引擎') }} <b>{{ engineName }}</b></span>
        <span v-if="info.accidentals !== undefined">{{ t('变化音') }} <b>{{ info.accidentals }}</b></span>
        <span v-if="info.spacing">{{ t('谱线间距') }} <b>{{ info.spacing }}px</b></span>
        <span v-if="info.tempoChanges > 1" class="muted">{{ t('速度变化 ') }}{{ info.tempoChanges }}{{ t(' 次') }}</span>
        <span v-if="info.bpm" class="muted">{{ t('速度 ') }}<b>{{ Math.round(info.bpm) }}</b>
          <template v-if="info.bpmSource === 'metronome'"> {{ t('（谱面记号）') }}</template>
          <template v-else-if="info.bpmSource === 'metronome-unreadable'"> {{ t('（谱面记号没读准，可在右栏手填）') }}</template>
        </span>
        <span v-if="info.transposedTracks" class="muted">{{ t('移调校正 ') }}{{ info.transposedTracks }}{{ t(' 个声部') }}</span>
        <!-- 拍号是**推**出来的（Audiveris 不导出 <time>），要如实标注，别让用户以为是读出来的 -->
        <span v-if="info.timeSig" class="muted">{{ t('拍号 ') }}<b>{{ info.timeSig }}</b><template v-if="info.meterInferred"> {{ t('推断值') }}</template></span>
        <span v-if="Number(info.pageTotal) > 1" class="muted">{{ pagesSummary(info) }}{{ t(' 页') }}</span>
      </div>
      <div v-if="pageRows.length || ppStats || failedPages.length" class="sc-pages">
        <span v-for="r in pageRows" :key="r.page + '-' + r.system" class="sc-pg" :class="{ warn: r.issues.length }"
              :title="r.issues.join('；')">
          {{ t('第') }}{{ r.page }}{{ t('页') }}<template v-if="r.system">·{{ t('系统') }}{{ r.system }}</template>
          <template v-if="r.bars"> · {{ r.bars }}{{ t(' 小节') }}</template> · {{ r.notes }}{{ t(' 音') }}<template v-if="r.scale"> · {{ r.scale }}×</template>
          <Icon v-if="r.issues.length" name="warn" :size="11" />
        </span>
        <!-- ★ M2-4：没解析出音符的页 —— 点一下**只重跑这一页**（其余页用上次结果，整份重新合并） -->
        <button v-for="n in failedPages" :key="'retry' + n" type="button" class="sc-pg retry" :disabled="busy"
                :title="t('只重跑这一页：其余页沿用上次结果，不需要整批重来')" @click="retryPage(n)">
          <Icon name="refresh" :size="11" /> {{ t('第 ') }}{{ n }}{{ t(' 页重试') }}
        </button>
        <span v-if="ppStats && ppStats.dup" class="sc-pg dim">{{ t('去重 ') }}{{ ppStats.dup }}</span>
        <span v-if="ppStats && ppStats.quantized" class="sc-pg dim">{{ t('量化 ') }}{{ ppStats.quantized }}</span>
        <span v-if="ppStats && ppStats.short" class="sc-pg dim">{{ t('滤除过短 ') }}{{ ppStats.short }}</span>
      </div>
      <ul v-if="warnings.length" class="sc-warn">
        <li v-for="(w, i) in warnings" :key="i"><Icon name="warn" :size="12" /> {{ w }}</li>
      </ul>
      <div class="sc-preview"><canvas ref="previewEl"></canvas></div>
      <div class="sc-tracks">
        <span v-for="(tr, i) in trackChips" :key="i" class="sc-tr">
          {{ tr.name }} · {{ tr.n }}{{ t(' 音') }}
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
        <button class="btn" data-guide="sc-proofread" :title="t('把原谱页图半透明垫到工作台的钢琴卷帘下，对着谱面逐音校对')" @click="proofreadInWorkbench">
          <Icon name="wallpaper" :size="14" /> {{ t('在工作台校对') }}
        </button>
        <button class="btn" data-guide="sc-fullscore" :title="t('把这份 MIDI 按总谱排版打开（每个声部一行谱表）')" @click="openAsFullScore">
          <Icon name="score" :size="14" /> {{ t('以总谱查看') }}
        </button>
        <button class="btn" @click="saveAs"><Icon name="save" :size="14" /> {{ t('另存为 MIDI…') }}</button>
      </div>
    </div>

    <!-- 还没转换时的空态：把「怎么用」和三种谱面的差别写在正中间，不留一大片白 -->
    <div v-else class="card sc-card sc-empty sc-in">
      <div class="sc-empty-head">
        <Icon name="score" :size="20" />
        <div class="sc-empty-tx">
          <b>{{ t('还没转换任何谱面') }}</b>
          <span>{{ t('右边选识别模型与参数，然后把图片 / PDF / MusicXML / MIDI 拖进来，或点上面的按钮。') }}</span>
        </div>
      </div>
      <!-- 谱面类型直接给三张可点的预设卡：既填满版面，也让「参数该怎么配」变成一次点击 -->
      <div class="sc-presets">
        <button v-for="s in SCENES" :key="s.id" type="button" class="sc-preset" :disabled="busy" @click="applyScene(s)">
          <span class="sc-preset-ic"><Icon :name="s.icon" :size="15" /></span>
          <span class="sc-preset-nm">{{ t(s.name) }}</span>
          <span class="sc-preset-desc">{{ t(s.desc) }}</span>
        </button>
      </div>
      <div class="sc-steps">
        <span><b>1</b>{{ t('拖入谱面') }}</span>
        <span><b>2</b>{{ t('选模型与参数') }}</span>
        <span><b>3</b>{{ t('转出 MIDI 或总谱') }}</span>
      </div>
    </div>
    </div>

    <aside class="sc-side">
      <div class="card sc-side-card">
        <div class="sc-side-head"><Icon name="spark" :size="13" /> {{ t('识别模型') }}</div>
        <button v-for="m in MODELS" :key="m.id" type="button" class="sc-model"
                :class="{ on: model === m.id }" :disabled="busy"
                @click="model = m.id">
          <span class="sc-model-nm">{{ t(m.name) }}</span>
          <span class="sc-model-sub">{{ t(m.sub) }}</span>
          <span v-if="m.need" class="sc-model-tag" :class="{ warn: !!(omrEngine && !omrEngine.installed) }">
            {{ omrEngine && omrEngine.installed ? t('已安装') : t('未安装') }}
          </span>
          <span v-else-if="m.needHomr" class="sc-model-tag" :class="{ warn: !(homrEngine && homrEngine.ready) }">
            {{ (homrEngine && homrEngine.ready) ? t('已安装') : t('未安装') }}
          </span>
          <span v-else-if="m.id === 'auto'" class="sc-model-tag">{{ t('推荐') }}</span>
        </button>
        <div class="sc-side-hint">{{ t('只有图片 / PDF 走识谱；MusicXML 与 MIDI 是精确解析或直通。') }}</div>
      </div>

      <!-- ★ 组件状态提示（用户：「在变谱页添加提示，而不是资源中心」）：
           这四样都要单独装，且都不随安装包分发。缺哪项在这一页就说清楚，并给直达按钮。 -->
      <div class="card sc-side-card">
        <div class="sc-side-head">
          <Icon name="download" :size="13" /> {{ t('识谱组件') }}
          <span class="sc-cmp-tag" :class="{ warn: omrMissing > 0 }">
            {{ omrMissing ? t('缺 ') + omrMissing + t(' 项') : t('齐备') }}
          </span>
        </div>
        <div v-for="c in omrComponents" :key="c.id" class="sc-cmp">
          <Icon :name="c.on ? 'check' : 'plus'" :size="11" :class="c.on ? 'sc-cmp-ok' : 'sc-cmp-no'" />
          <span class="sc-cmp-nm">{{ c.name }}<small class="sc-cmp-size">{{ c.size }}</small></span>
          <button class="btn sm ghost" :disabled="omrBusy" :title="c.on ? t('重新下载') : t('下载')" @click="installComponent(c.id)"><Icon name="download" :size="11" /> {{ t('下载') }}</button>
        </div>
        <div v-if="omrText" class="sc-cmp-progress">{{ omrText }}</div>
        <div class="sc-cmp-actions">
          <button v-if="omrMissing" class="btn sm primary" :disabled="omrBusy" @click="installAllMissing">
            <Icon name="download" :size="12" /> {{ omrBusy ? t('安装中…') : t('一键安装缺失组件') }}
          </button>
        </div>
      </div>


      <!-- ★ 谱面类型预设只留空态里那三张卡（用户：「这两处功能重复了，保留这个」）——
           右栏再放一份完全一样的，既重复又占掉参数区的高度。 -->
    </aside>
    </div>
  </div>
</template>

<style scoped>
/* 与「转录」「转换」同一条规矩：外边距由全局 .page 给，这里只限宽 */
.sc-wrap { max-width: 1040px; }
/* 两栏：左边导入 + 结果，右边模型 / 参数。
   原来这些控件全塞在一张卡里，页面下半截是一大片空白（用户：「太空旷」）。 */
.sc-grid { display: grid; grid-template-columns: minmax(0, 1fr) 326px; gap: var(--sp-4); align-items: start; }
.sc-col { min-width: 0; }
.sc-side { display: flex; flex-direction: column; gap: var(--sp-2); position: sticky; top: 10px; }
.sc-side-card { padding: 12px 14px; margin-bottom: 0; gap: var(--sp-2); }
.sc-side-head { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-md); font-weight: 700; color: var(--ink); margin-bottom: 2px; }
.sc-side-hint { margin-top: 6px; font-size: var(--fs-sm); color: var(--stone); line-height: 1.55; }
/* 识别参数卡（主栏内）：摊成多列，字段之间只留 2px 行距 */
.sc-params { padding: 12px 14px; }
.sc-param-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(196px, 1fr)); gap: 2px var(--sp-4); margin-top: 6px; }
.sc-param-grid .sc-field { margin-bottom: 0; }
.sc-param-note { grid-column: 1 / -1; }
/* 识谱组件状态行：左边一个对勾/加号，中间组件名，右边「已安装」或体积 */
.sc-cmp-tag { margin-left: auto; font-size: var(--fs-xs); font-weight: 600; color: var(--steel);
  background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 0 8px; }
.sc-cmp-tag.warn { color: var(--t-warn); border-color: color-mix(in srgb, var(--t-warn) 55%, var(--line));
  background: color-mix(in srgb, var(--t-warn) 12%, transparent); }
.sc-cmp { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); padding: 2px 0; }
.sc-cmp-ok { color: var(--accent); flex: none; }
.sc-cmp-no { color: var(--t-warn); flex: none; }
.sc-cmp-nm { color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-cmp-st { margin-left: auto; flex: none; font-size: var(--fs-xs); color: var(--accent); }
.sc-cmp-st.off { color: var(--stone); font-variant-numeric: tabular-nums; }
.sc-model { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 1px var(--sp-2); width: 100%; text-align: left;
  padding: 8px 10px; margin-bottom: 5px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.sc-model:hover { border-color: var(--border-strong); }
.sc-model:active { transform: scale(0.99); }
.sc-model.on { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 12%, transparent); box-shadow: 0 6px 16px rgba(10, 10, 10, 0.14); }
.sc-model-nm { grid-column: 1; font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.sc-model-sub { grid-column: 1; font-size: var(--fs-xs); color: var(--stone); line-height: 1.45; }
.sc-model-tag { grid-column: 2; grid-row: 1; align-self: start; font-size: var(--fs-xs); color: var(--steel);
  background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 1px 9px; }
.sc-model-tag.warn { color: var(--t-warn); border-color: color-mix(in srgb, var(--t-warn) 45%, var(--line)); }
.sc-empty { display: flex; flex-direction: column; gap: var(--sp-3); }
.sc-empty-head { display: flex; gap: var(--sp-3); align-items: flex-start; color: var(--accent); }
.sc-empty-tx { display: flex; flex-direction: column; gap: 3px; }
.sc-empty-tx b { font-size: var(--fs-md); color: var(--ink); }
.sc-empty-tx span { font-size: var(--fs-sm); color: var(--stone); line-height: 1.55; }
.sc-empty-list { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--stone); line-height: 1.65; }
/* 空态里的三张预设卡（点一下就把模型与参数设好）。
   ★ 必须有**看得见的方框**：之前用 --line 的 1px 发丝线压在这页 92% 白玻璃上等于没有框，
   用户看不出这里有三个可选项（原话：「要有方框框起来方便用户看到有这三个选项」）。
   现在用 --border-strong 实边 + 纯白底 + 一层浅投影，三张卡自己立起来。 */
.sc-presets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); }
.sc-preset { display: flex; flex-direction: column; gap: var(--sp-1); text-align: left; padding: 12px 13px 14px;
  border: 1.5px solid var(--border-strong); border-radius: var(--radius-md); background: var(--surface); cursor: pointer;
  box-shadow: 0 1px 2px rgba(10, 10, 10, 0.05), 0 4px 12px rgba(10, 10, 10, 0.06);
  transition: border-color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.sc-preset:hover { border-color: var(--accent); transform: translateY(-1px);
  box-shadow: 0 2px 4px rgba(10, 10, 10, 0.06), 0 8px 20px rgba(10, 10, 10, 0.10); }
.sc-preset:active { transform: scale(0.995); }
.sc-preset-ic { color: var(--accent); }
.sc-preset-nm { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.sc-preset-desc { font-size: var(--fs-xs); color: var(--stone); line-height: 1.5; }
.sc-steps { display: flex; flex-wrap: wrap; gap: var(--sp-4); font-size: var(--fs-sm); color: var(--stone); }
.sc-steps b { display: inline-flex; width: 15px; height: 15px; align-items: center; justify-content: center; margin-right: 5px;
  border-radius: 50%; background: var(--accent); color: var(--on-accent); font-size: var(--fs-xs); font-weight: 600; }
@media (max-width: 900px) { .sc-presets { grid-template-columns: 1fr; } }
/* 壁纸打开时全局 .card 是 78% 白玻璃：这一页信息密度高，文字压到壁纸亮部会发花 ——
   单独提到 92%（玻璃感保留，可读性回来）。 */
.sc-wrap .card { background: color-mix(in srgb, var(--canvas) 92%, transparent); }
.sc-opts-line { display: flex; gap: var(--sp-4); flex-wrap: wrap; font-size: var(--fs-sm); color: var(--stone); }
.sc-opts-line b { margin-left: 5px; color: var(--ink); font-weight: 600; }
.sc-pages { display: flex; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-xs); color: var(--steel); }
.sc-pg { border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 1px 9px; background: var(--surface); }
/* 失败页的「重试该页」按钮：可点、悬停变强调色（与只读胶囊区分开） */
.sc-pg.retry { display: inline-flex; align-items: center; gap: var(--sp-1); cursor: pointer; font: inherit;
  border-color: color-mix(in srgb, var(--t-warn) 60%, var(--line)); color: var(--t-warn); font-size: var(--fs-xs); }
.sc-pg.retry:hover { border-color: var(--accent); color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent); }
.sc-pg.retry:disabled { opacity: .55; cursor: default; }
.sc-pg.dim { border-style: dashed; opacity: .85; }
/* 体检有问题的页：琥珀色边框 + 悬停看原因（M2-4） */
.sc-pg.warn { border-color: color-mix(in srgb, var(--t-warn) 55%, var(--line)); color: var(--t-warn); }
@media (max-width: 1080px) { .sc-grid { grid-template-columns: minmax(0, 1fr); } .sc-side { position: static; } }
/* 页头用全局 .page-head / .page-ic / .page-title / .page-sub（与转录、转换一致） */
.sc-wrap > .page-head { margin-bottom: 16px; }
/* 外观（白底 / hairline / 圆角 / 阴影）由全局 .card 提供，这里只补排布 */
.sc-card { display: flex; flex-direction: column; gap: var(--sp-3); margin-bottom: 14px; }
.sc-in { animation: scIn var(--motion-slow) var(--ease-out) both; }
@keyframes scIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.sc-row { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; }
/* 与转录的 .tr-drop 同一套几何：1.5px 虚线 + 14 圆角 + 22 内边距 */
.sc-dropzone { display: flex; align-items: center; gap: var(--sp-4); padding: 20px 22px; border: 1.5px dashed var(--border-strong);
  border-radius: var(--r-lg); background: var(--canvas); cursor: pointer;
  transition: border-color var(--motion-base) var(--ease-out), background var(--motion-base) var(--ease-out); }
.sc-dropzone:hover, .sc-dropzone.over { border-color: var(--accent); background: var(--surface-soft); }
.sc-dz-ic { width: 46px; height: 46px; border-radius: var(--r-md); background: var(--surface); display: grid; place-items: center; color: var(--accent); flex: none; }
.sc-card.sc-drop-on { border-color: var(--accent); }
.sc-dz-tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sc-dz-tx b { font-size: var(--fs-md); color: var(--ink); }
.sc-dz-tx span { font-size: var(--fs-sm); color: var(--stone); }
.sc-main { min-width: 168px; }
.sc-fmt { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.sc-chip { font-size: var(--fs-xs); color: var(--muted); border: 1px solid var(--line); border-radius: var(--r-pill); padding: 2px 9px; }
.sc-prog { height: 4px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--hairline) 70%, transparent); overflow: hidden; }
.sc-prog-bar { height: 100%; border-radius: var(--r-sm); background: linear-gradient(90deg, var(--t-info), var(--data-6), var(--t-info)); background-size: 200% 100%; animation: scFlow 1.1s linear infinite; transition: transform var(--motion-base) var(--ease-out); }
@keyframes scFlow { from { background-position: 0 0; } to { background-position: 200% 0; } }
.sc-hint { font-size: var(--fs-sm); color: var(--stone); line-height: 1.6; }
/* 拖拽悬停：整卡描边亮起（时长/缓动跟全局一致：0.2~0.34s + var(--ease-out)） */
.sc-card.sc-drop-on { transition: border-color var(--motion-base) var(--ease-out); }
/* 文件列表：多选/拖拽进来的文件逐个滑入 */
.sc-files { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.sc-files li { display: inline-flex; align-items: center; gap: var(--sp-1); max-width: 260px;
  padding: 2px 10px; border-radius: var(--r-pill); border: 1px solid var(--hairline); background: var(--surface);
  font-size: var(--fs-xs); color: var(--steel); }
.sc-files li span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sc-file-enter-active { transition: opacity var(--motion-base) var(--ease-out), transform var(--motion-base) var(--ease-out); }
.sc-file-leave-active { transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); position: absolute; }
.sc-file-enter-from { opacity: 0; transform: translateY(-6px) scale(.96); }
.sc-file-leave-to { opacity: 0; transform: scale(.96); }
.sc-file-move { transition: transform var(--motion-base) var(--ease-out); }
.sc-engine { display: flex; align-items: center; gap: var(--sp-3); padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--hairline)); border-radius: var(--r-md);
  background: linear-gradient(100deg, color-mix(in srgb, var(--accent) 10%, transparent), transparent 70%);
  animation: scIn var(--motion-slow) var(--ease-out) both; }
.sc-engine.on { border-color: var(--hairline); background: none; font-size: var(--fs-sm); color: var(--stone); }
.sc-engine-tx { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.sc-engine-tx b { font-size: var(--fs-md); color: var(--ink); }
.sc-engine-tx span { font-size: var(--fs-sm); color: var(--stone); line-height: 1.5; }
.sc-engine-prog { font-variant-numeric: tabular-nums; color: var(--t-info) !important; }
.sc-engine .btn { margin-left: auto; flex: none; }
.sc-field { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: 4px; font-size: var(--fs-sm); color: var(--stone); }
.sc-field-nm { flex: 1; min-width: 0; }
.sc-field select, .sc-field input { background: var(--canvas); color: var(--ink); border: 1px solid var(--hairline); border-radius: var(--r-md); padding: 4px 8px; font-size: var(--fs-sm); }
.sc-field input { width: 62px; }
.sc-unit { opacity: 0.7; }
/* OCR 语言包状态：装了显示语言代码，没装标红提示去资源中心 */
.sc-ocr { font-size: var(--fs-sm); color: var(--success-text); font-variant-numeric: tabular-nums; }
.sc-ocr.off { color: var(--stone); }
.sc-err { display: flex; align-items: center; gap: var(--sp-2); padding: 10px 14px; border-radius: var(--r-md); background: color-mix(in srgb, var(--t-err) 14%, transparent); border: 1px solid color-mix(in srgb, var(--t-err) 40%, transparent); color: var(--t-err); font-size: var(--fs-md); margin-bottom: 12px; }
.sc-stats { display: flex; gap: var(--sp-4); flex-wrap: wrap; font-size: var(--fs-md); color: var(--stone); }
.sc-stats b { color: var(--ink); font-weight: 600; }
.sc-warn { margin: 10px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--sp-1); }
.sc-warn li { display: flex; align-items: flex-start; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--t-warn); line-height: 1.5; }
.sc-preview { height: 190px; background: var(--surface); border: 1px solid var(--hairline); border-radius: var(--r-md); overflow: hidden; }
.sc-preview canvas { width: 100%; height: 100%; display: block; }
.sc-tracks { display: flex; gap: var(--sp-2); flex-wrap: wrap; font-size: var(--fs-sm); color: var(--steel); }
.sc-tr { border: 1px solid var(--hairline); border-radius: var(--r-pill); padding: 2px 10px; background: var(--surface); }
.sc-ov { margin-top: 14px; }
.sc-ov-head { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-md); font-weight: 700; color: var(--ink); }
.sc-ov-tabs { display: flex; gap: var(--sp-1); }
.sc-ov-tabs button { min-width: 24px; height: 22px; border-radius: var(--r-sm); border: 1px solid var(--line); background: var(--bg); color: var(--muted); font-size: var(--fs-sm); cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out); }
.sc-ov-tabs button.on { color: var(--on-accent); background: var(--t-info); border-color: var(--t-info); }
.sc-ov-box { margin-top: 8px; max-height: 460px; overflow: auto; border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); }
.sc-ov-img { display: block; width: 100%; animation: scFade var(--motion-base) var(--ease-out) both; }
@keyframes scFade { from { opacity: 0; } to { opacity: 1; } }
.sc-ov-tabs button:hover { border-color: color-mix(in srgb, var(--t-info) 55%, var(--line)); color: var(--text); }
.sc-ov-legend { margin-top: 6px; display: flex; gap: var(--sp-4); font-size: var(--fs-xs); color: var(--muted); }
.lg::before { content: ''; display: inline-block; width: 10px; height: 10px; border-radius: var(--r-sm); margin-right: 5px; vertical-align: -1px; }
.lg-note::before { background: var(--t-err); }
.lg-acc::before { background: var(--t-ok); }
.lg-bar::before { background: var(--data-7); }
.sc-actions { display: flex; gap: var(--sp-3); flex-wrap: wrap; }
.sc-cmp-size { margin-left: 6px; color: var(--stone); font-size: var(--fs-xs); font-weight: 400; }
.sc-cmp .btn { margin-left: auto; flex: none; padding: 2px 8px; min-height: 22px; }
.sc-cmp-progress { margin: 6px 0 2px; color: var(--t-info); font-size: var(--fs-xs); }
.sc-cmp-actions { display: flex; gap: var(--sp-2); margin-top: 8px; }
</style>
