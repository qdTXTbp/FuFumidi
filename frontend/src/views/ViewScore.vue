<script setup>
import { ref, reactive, computed, watch, onMounted, onBeforeUnmount, nextTick } from 'vue';
import Icon from '../components/Icon.vue';
import { currentSong, state, toast, importFiles, setView } from '../store.js';
import { getPlayer } from '../audio.js';
import { t } from '../core/i18n.js';
import { esc, clamp, TRACK_COLORS } from '../core/util.js';
import { encodeMidi } from '../core/midi.js';
import { parseMusicXMLToSong } from '../core/musicxml.js';
import { songToAbc, jianpuData, tabData, detectSf, ABC_KEY_NAMES } from '../core/score.js';
import { songToMusicXMLTrack, songToMusicXML } from '../core/musicxml_out.js';

const mode = ref('staff');       // staff | jianpu | guitar | bass
const track = ref(0);
const fontSz = ref(22);
const follow = ref(true);
const zoom = ref(1);
const opts = reactive({ simple: true, grid: true, beam: false, multi: false });
const status = ref('');

const scoreEl = ref(null);
const scrollEl = ref(null);
const showOpts = ref(false);
const exporting = ref(false);
const midiBusy = ref(false);
const previewOpen = ref(false);
const previewBusy = ref(false);
const previewPages = ref([]);
const splitOpen = ref(false);
const splitContent = ref(null);

let scoreVerovio = null;
let abcjsLoaded = false;
let abcjsLoading = null;
let tune = null;        // 渲染完成标记（Verovio 不使用 abcjs TuneObject）
let noteEvents = [];    // [{ ms, tick, elements: [...] }]
let flow = [];          // 视觉流向（按行阅读顺序）
let lineTops = [], lineBottoms = [];
let renderCacheKey = '';
let playingSet = new Set(); // 当前高亮的 SVG 元素

const song = computed(() => (currentSong.value && currentSong.value.song) || null);
const tracks = computed(() => (song.value ? song.value.tracks : []));

const trackSel = computed({
  get: () => clamp(track.value, 0, Math.max(0, tracks.value.length - 1)),
  set: v => { track.value = parseInt(v, 10) || 0; },
});
const selTrack = computed(() => tracks.value[trackSel.value] || null);

/* ---------------- abcjs 动态加载（本地 vendor，离线可用） ---------------- */
function loadAbcjs() {
  if (abcjsLoaded) return Promise.resolve();
  if (abcjsLoading) return abcjsLoading;
  abcjsLoading = new Promise((resolve, reject) => {
    if (typeof window.ABCJS !== 'undefined') { abcjsLoaded = true; resolve(); return; }
    const s = document.createElement('script');
    s.src = './vendor/abcjs-min.js';
    s.onload = () => { abcjsLoaded = true; resolve(); };
    s.onerror = () => { reject(new Error('abcjs 组件加载失败')); };
    document.head.appendChild(s);
  });
  return abcjsLoading;
}

/* ---------------- 状态 ---------------- */
function setStatus(x) { status.value = x; }
function cssVar(name, fb) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fb;
  } catch (e) { return fb; }
}

function midiToSec(s, tick) {
  return s.baseSec ? s.baseSec(tick) : (tick / Math.max(1, s.tpb)) * (60000 / (s.initialBpm || 120)) / 1000;
}

/* ---------------- 五线谱（Verovio / v2.1 乐谱引擎） ---------------- */
let verovioLoading = null;
async function loadVerovio() {
  if (window.verovio && window.verovio.toolkit) return true;
  if (verovioLoading) return verovioLoading;
  verovioLoading = new Promise((resolve, reject) => {
    // Emscripten Module 全局污染会破坏 Verovio 的 Toolkit 初始化
    try { window.Module = undefined; } catch (e) {}
    const sc = document.createElement('script');
    sc.src = './vendor/verovio-toolkit-wasm.js';
    sc.onload = () => {
      const start = Date.now();
      const wait = () => {
        try {
          const v = window.verovio;
          if (v && v.toolkit && v.module && typeof v.module.cwrap === 'function') {
            const ctor = v.module.cwrap('vrvToolkit_constructor', 'number', []);
            if (typeof ctor === 'function') { resolve(true); return; }
          }
        } catch (e) {}
        if (Date.now() - start > 15000) { reject(new Error('Verovio 组件初始化超时')); return; }
        setTimeout(wait, 80);
      };
      wait();
    };
    sc.onerror = () => reject(new Error('Verovio 组件加载失败'));
    document.head.appendChild(sc);
  });
  return verovioLoading;
}

async function renderStaff() {
  const el = scoreEl.value, s = song.value;
  const tr = selTrack.value;
  const sc = scrollEl.value;
  if (!el) return;
  el.innerHTML = '';
  el.style.cssText = '';
  tune = null; noteEvents = []; flow = []; lineTops = []; lineBottoms = []; playingSet.clear();
  if (sc) { sc.scrollTop = 0; sc.scrollLeft = 0; }
  if (!s || !tr || !tr.notes.length) { el.innerHTML = '<div class="score-empty">' + esc(t('该轨道没有音符')) + '</div>'; setStatus(t('暂无数据')); return; }
  setStatus(t('正在生成…'));
  try { await loadVerovio(); } catch (e) { el.innerHTML = '<div class="score-empty">' + esc(String(e.message || e)) + '</div>'; setStatus(t('生成失败')); return; }
  const vrv = window.verovio;
  if (!vrv || !vrv.toolkit) { el.innerHTML = '<div class="score-empty">Verovio 组件未加载（离线资源缺失）</div>'; setStatus(t('生成失败')); return; }

  try {
    const vpW = sc ? sc.clientWidth : 900;
    const padL = sc ? (parseFloat(getComputedStyle(sc).paddingLeft) || 0) : 0;
    const padR = sc ? (parseFloat(getComputedStyle(sc).paddingRight) || 0) : 0;
    const pageW = Math.max(300, vpW - padL - padR - 8);
    const xml = songToMusicXMLTrack(s, trackSel.value);

    if (scoreVerovio && scoreVerovio.destroy) { try { scoreVerovio.destroy(); } catch (e) {} }
    scoreVerovio = new vrv.toolkit();
    scoreVerovio.setOptions({
      pageWidth: Math.round(pageW),
      pageHeight: 100000,
      scale: Math.max(100, Math.round(100 * zoom.value)),
      adjustPageHeight: true,
      pageMarginLeft: 30, pageMarginRight: 10, pageMarginTop: 0, pageMarginBottom: 0,
      footer: 'none', header: 'none',
      spacingLinear: 0.45, spacingNonLinear: 0.8, spacingStaff: 5,
    });
    const loadRes = scoreVerovio.loadData(xml);
    if (loadRes === false || loadRes < 0) { el.innerHTML = '<div class="score-empty">MusicXML 加载失败</div>'; setStatus(t('生成失败')); return; }
    const pages = scoreVerovio.getPageCount();
    let html = '';
    for (let p = 1; p <= pages; p++) { try { html += scoreVerovio.renderToSVG(p, {}) || ''; } catch (e) {} }
    el.innerHTML = html;
    el.style.width = pageW + 'px';
    el.classList.toggle('fu-grid', !!opts.grid);

    // 建立 timemap：优先用歌曲真实 tick 时间（支持变速 MIDI）
    const songNotes = tr.notes.slice().sort((a, b) => a.start - b.start || a.midi - b.midi);
    const systems = Array.from(el.querySelectorAll('.system'));
    const events = [];
    const seen = new Set();
    let ni = 0;
    for (const node of el.querySelectorAll('.note')) {
      const id = node.id || '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const n = songNotes[ni++];
      let ms = 0, tick = null;
      if (n) {
        tick = n.start;
        ms = midiToSec(s, n.start) * 1000;
      } else {
        try { const t2 = scoreVerovio.getTimeForElement(id); if (t2 != null && t2 >= 0) ms = t2; } catch (e) {}
      }
      const sys = node.closest ? node.closest('.system') : null;
      const line = Math.max(0, systems.indexOf(sys));
      if (tick != null) node.setAttribute('data-tick', String(tick));
      events.push({ ms, tick, ev: { el: node, left: null, line, elements: [[node]] } });
    }
    events.sort((a, b) => a.ms - b.ms);
    noteEvents = events;
    flow = events.slice();
    let fmax = -1;
    for (const it of flow) { if (it.ms > fmax) fmax = it.ms; it.flowMs = fmax; }

    // 谱线行范围（按 system 的 y 分组）
    lineTops = []; lineBottoms = [];
    const ar = el.getBoundingClientRect();
    for (const node of systems) {
      try {
        const r = node.getBoundingClientRect();
        const y0 = r.top - ar.top + (sc ? sc.scrollTop : 0);
        const y1 = r.bottom - ar.top + (sc ? sc.scrollTop : 0);
        lineTops.push(y0); lineBottoms.push(y1);
      } catch (e) {}
    }

    const svg = el.querySelector('svg');
    if (svg) { svg.style.maxWidth = '100%'; svg.style.margin = '0 auto'; }
    tune = {}; // 标记已渲染（供跟随代码使用）
    setStatus(t('渲染完成'));
  } catch (e) {
    el.innerHTML = '<div class="score-empty">' + t('乐谱解析失败：') + esc(String(e.message || e)) + '</div>';
    tune = null; setStatus(t('生成失败'));
  }
}

// 网格节拍宽：用「相隔正好一拍的音符对」求一拍实际横向宽度
function setBeatWidth(el, s) {
  el.classList.toggle('fu-grid', !!opts.grid);
  let bw = Math.round(56 * zoom.value);
  if (noteEvents.length > 1) {
    const beatMs = 60000 / (s.initialBpm || 120);
    const byLine = new Map();
    for (const it of noteEvents) {
      if (it.ev.left == null) continue;
      let a = byLine.get(it.ev.line); if (!a) { a = []; byLine.set(it.ev.line, a); }
      a.push(it);
    }
    const deltas = [];
    for (const a of byLine.values()) {
      a.sort((x, y) => x.ms - y.ms);
      for (let i = 0; i < a.length; i++) for (let j = i + 1; j < a.length; j++) {
        const beats = (a[j].ms - a[i].ms) / beatMs;
        if (Math.abs(beats - 1) < 0.15) {
          const dl = a[j].ev.left - a[i].ev.left;
          if (dl > 10 && dl < 500) { deltas.push(dl); }
          break;
        } else if (beats > 1.2) break;
      }
    }
    if (deltas.length >= 3) { deltas.sort((a, b) => a - b); bw = Math.round(deltas[Math.floor(deltas.length / 2)] * zoom.value); }
  }
  el.style.setProperty('--fu-beatw', Math.max(12, bw) + 'px');
}

/* ---------------- 简谱 / TAB（HTML 渲染） ---------------- */
function trackBlocks(multi, fn) {
  if (!song.value) return [];
  const idxs = multi ? song.value.tracks.map((_, i) => i).filter(i => song.value.tracks[i].notes.length) : [trackSel.value];
  return idxs.map(ti => {
    const r = fn(song.value, ti);
    return { ti, name: song.value.tracks[ti].name || (t('音轨 ') + (ti + 1)), ...r };
  });
}

const jianpuBlocks = computed(() => trackBlocks(opts.multi, jianpuData));
const tabBlocks = computed(() => trackBlocks(opts.multi, (s, ti) =>
  tabData(s, ti, mode.value === 'guitar' ? [64, 59, 55, 50, 45, 40] : [43, 38, 33, 28])
));
const tabPlaced = computed(() => tabBlocks.value.reduce((a, b) => a + (b.placed || 0), 0));

/* ---------------- 渲染调度 ---------------- */
let renderRaf = 0;
function scheduleRender() {
  if (renderRaf) return;
  renderRaf = requestAnimationFrame(() => { renderRaf = 0; doRender(); });
}
function doRender() {
  if (mode.value === 'staff') renderStaff();
  else setStatus('');
  // 非五线谱模式由响应式数据自动渲染
}

function changeMode() { renderCacheKey = ''; scheduleRender(); }
function changeTrack() { renderCacheKey = ''; scheduleRender(); }
function setZoom(v) {
  zoom.value = clamp(parseFloat(v) || 1, 0.6, 1.8);
  scheduleRender();
}

watch([song, () => state.view], () => { renderCacheKey = ''; nextTick(scheduleRender); });
watch([mode, trackSel, () => opts.simple, () => opts.grid, () => opts.beam, zoom], () => { renderCacheKey = ''; scheduleRender(); });

// 跟随播放
function tickFollow() {
  if (!follow.value || !state.playing) return;
  const s = song.value;
  if (!s || !tune) return;
  const p = getPlayer();
  if (!p || !p.song) return;
  const curMs = midiToSec(s, p.currentTick()) * 1000;
  // 高亮当前音符
  const playing = new Set();
  const curSet = new Set();
  for (const it of noteEvents) {
    if (it.ms <= curMs && curMs < it.ms + 500) {
      if (it.ev.elements) for (const es of it.ev.elements) if (es) for (const node of es) {
        if (node && node.classList) { playing.add(node); curSet.add(node); }
      }
    }
  }
  for (const n of playingSet) if (!curSet.has(n)) n.classList.remove('fu-play');
  for (const n of curSet) n.classList.add('fu-play');
  playingSet = curSet;
  // 自动滚动到当前行
  const fi = findFlowIdx(curMs);
  const it = flow[fi];
  if (it && it.ev.line != null && scrollEl.value) {
    const l = it.ev.line;
    const top = lineTops[l];
    if (top != null) {
      const sc = scrollEl.value;
      const c = sc.clientHeight / 2;
      const target = Math.max(0, top - c + 20);
      if (Math.abs(sc.scrollTop - target) > 40) sc.scrollTo({ top: target, behavior: 'smooth' });
    }
  }
}
function findFlowIdx(ms) {
  let lo = 0, hi = flow.length - 1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (flow[mid].flowMs <= ms) lo = mid + 1; else hi = mid - 1; }
  return hi;
}

/* ---------------- 导出 PNG（五线谱，多页自动打包 ZIP） ---------------- */
function dataUrlToBytes(dataUrl) {
  const b64 = String(dataUrl).split(',')[1] || '';
  return Array.from(atob(b64), c => c.charCodeAt(0));
}
async function rasterizeSvg(svg, scale, tileH) {
  const w = svg.clientWidth || svg.getBoundingClientRect().width || parseFloat(svg.getAttribute('width')) || 986;
  const h = svg.clientHeight || svg.getBoundingClientRect().height || parseFloat(svg.getAttribute('height')) || 600;
  if (!w || !h) return [];
  const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
  URL.revokeObjectURL(url);
  const out = [];
  let off = 0;
  while (off < h) {
    const th = Math.min(tileH, h - off);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(w * scale));
    cv.height = Math.max(1, Math.round(th * scale));
    const g = cv.getContext('2d');
    g.setTransform(scale, 0, 0, scale, 0, 0);
    g.fillStyle = cssVar('--canvas', '#ffffff'); g.fillRect(0, 0, w, th);
    g.drawImage(img, 0, off, w, th, 0, 0, w, th);
    out.push(cv.toDataURL('image/png'));
    off += th;
  }
  return out;
}
async function exportStaffPng() {
  const el = scoreEl.value;
  if (!el) return;
  const svgs = el ? Array.from(el.querySelectorAll('svg')) : [];
  if (!svgs.length) { toast(t('当前没有可导出的五线谱'), 'warn'); return; }
  exporting.value = true;
  const bridge2 = window.fuBridge;
  const base = (song.value ? song.value.name : 'score').replace(/\.[^.]+$/, '');
  try {
    const scale = 2, tileH = 9000;
    const tiles = [];
    for (let i = 0; i < svgs.length; i++) {
      const pages = await rasterizeSvg(svgs[i], scale, tileH);
      for (const dataUrl of pages) {
        tiles.push({ name: base + '-p' + String(tiles.length + 1).padStart(3, '0') + '.png', data: dataUrlToBytes(dataUrl) });
      }
    }
    if (!tiles.length) { toast(t('没有可导出的乐谱'), 'warn'); return; }
    if (tiles.length === 1) {
      if (bridge2 && bridge2.saveBinary) {
        const r = await bridge2.saveBinary({ name: tiles[0].name, data: new Uint8Array(tiles[0].data) });
        if (r && r.ok) toast(t('已导出乐谱 PNG：') + r.path, 'ok');
        else if (r && !r.canceled) toast(t('PNG 导出失败'), 'warn');
      } else {
        const blob = new Blob([new Uint8Array(tiles[0].data)], { type: 'image/png' });
        const a = document.createElement('a'); a.download = tiles[0].name; a.href = URL.createObjectURL(blob); a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
        toast(t('已导出 PNG'));
      }
    } else if (bridge2 && bridge2.exportScorePngZip) {
      const r = await bridge2.exportScorePngZip({ name: base, tiles });
      if (r && r.ok) toast(t('已导出乐谱 PNG 分页包：') + r.path, 'ok');
      else if (!(r && r.canceled)) toast(t('PNG 导出失败'), 'warn');
    } else {
      toast(t('乐谱过长，请使用 PDF 导出完整版'), 'warn');
    }
  } catch (e) {
    toast(t('PNG 导出失败：') + String(e.message || e), 'warn');
  } finally {
    exporting.value = false;
  }
}

/* ---------------- MusicXML 导入 ---------------- */
async function importMusicXML() {
  const b = window.fuBridge;
  if (!b || !b.pickMusicXML || !b.readBinary) { toast(t('当前环境不支持 MusicXML 导入'), 'warn'); return; }
  midiBusy.value = true;
  try {
    const p = await b.pickMusicXML();
    if (!p) return;
    const buf = await b.readBinary(p);
    if (!buf) { toast(t('无法读取 MusicXML 文件'), 'warn'); return; }
    const text = new TextDecoder('utf-8').decode(new Uint8Array(buf));
    const base = p.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
    const song = parseMusicXMLToSong(text, base + '.mid');
    const bytes = encodeMidi(song.tracks.map(tr => ({ name: tr.name, program: tr.program, ch: tr.ch, notes: tr.notes, ccs: tr.ccs || [] })),
      { division: song.tpb, tempoMap: song.tempoMap, sigMap: song.sigMap });
    await importFiles([{ name: base + '.mid', bytes }]);
    setView('score');
    toast(t('已导入 MusicXML：') + base, 'ok');
  } catch (e) {
    toast(t('MusicXML 导入失败：') + String(e.message || e), 'warn');
  } finally { midiBusy.value = false; }
}

/* ---------------- MusicXML 导出 ---------------- */
async function exportMusicXML() {
  const s = song.value;
  if (!s) { toast(t('请先载入 MIDI 文件'), 'warn'); return; }
  const b = window.fuBridge;
  try {
    const xml = songToMusicXML(s);
    const bytes = new TextEncoder().encode(xml);
    const name = (s.name || 'score').replace(/\.midi?$/i, '') + '.musicxml';
    if (b && b.saveBinary) {
      const r = await b.saveBinary({ name, data: Array.from(bytes) });
      if (r && r.ok) toast(t('已导出 MusicXML：') + r.path, 'ok');
      else if (r && !r.canceled) toast(t('MusicXML 导出失败'), 'warn');
    } else {
      const blob = new Blob([bytes], { type: 'application/vnd.recordare.musicxml+xml' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = name; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      toast(t('已导出 MusicXML'), 'ok');
    }
  } catch (e) {
    toast(t('MusicXML 导出失败：') + (e.message || e), 'warn');
  }
}

/* ---------------- PDF 导出（IPC printToPDF） ---------------- */
async function exportPdf() {
  const b = window.fuBridge;
  if (!b || !b.exportScorePdf) { toast(t('当前环境不支持 PDF 导出'), 'warn'); return; }
  try {
    const r = await b.exportScorePdf();
    if (r && r.ok) toast(t('已导出乐谱 PDF：') + r.path, 'ok');
    else if (r && !r.canceled) toast(t('PDF 导出失败'), 'warn');
  } catch (e) {
    toast(t('PDF 导出失败：') + String(e.message || e), 'warn');
  }
}

/* ---------------- 乐谱分屏（点击音符定位） ---------------- */
function openScoreSplit() {
  if (!song.value || !scoreEl.value) { toast(t('请先载入并渲染五线谱'), 'warn'); return; }
  if (mode.value !== 'staff') { toast(t('请先切换至五线谱模式'), 'warn'); return; }
  splitOpen.value = true;
  nextTick(() => {
    const dst = splitContent.value;
    if (!dst || !scoreEl.value) return;
    dst.innerHTML = scoreEl.value.innerHTML;
    if (scoreEl.value.style.width) dst.style.width = scoreEl.value.style.width;
    dst.querySelectorAll('.note').forEach(n => {
      n.style.cursor = 'pointer';
      n.addEventListener('click', () => {
        const tick = parseInt(n.getAttribute('data-tick'), 10);
        if (!isFinite(tick)) return;
        const p = getPlayer();
        if (p) p.seekTick(tick);
        toast(t('已定位到音符 @ ') + tick, 'ok');
        splitOpen.value = false;
      });
    });
  });
}

/* ---------------- 分页预览（SVG 栅格化为 PNG 图集弹窗） ---------------- */
async function previewScore() {
  if (mode.value !== 'staff') { toast(t('请先切换至五线谱模式'), 'warn'); return; }
  const svgs = scoreEl.value ? Array.from(scoreEl.value.querySelectorAll('svg')) : [];
  if (!svgs.length) { toast(t('请先渲染五线谱'), 'warn'); return; }
  previewOpen.value = true;
  previewBusy.value = true;
  previewPages.value = [];
  try {
    const scale = 1.5, tileH = 9000;
    const pages = [];
    for (const svg of svgs) {
      const w = svg.clientWidth || svg.getBoundingClientRect().width || parseFloat(svg.getAttribute('width')) || 986;
      const h = svg.clientHeight || svg.getBoundingClientRect().height || parseFloat(svg.getAttribute('height')) || 600;
      if (!w || !h) continue;
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      URL.revokeObjectURL(url);
      let off = 0;
      while (off < h) {
        const th = Math.min(tileH, h - off);
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(w * scale)); cv.height = Math.max(1, Math.round(th * scale));
        const g = cv.getContext('2d');
        g.setTransform(scale, 0, 0, scale, 0, 0);
        g.fillStyle = cssVar('--canvas', '#ffffff'); g.fillRect(0, 0, w, th);
        g.drawImage(img, 0, off, w, th, 0, 0, w, th);
        pages.push(cv.toDataURL('image/png'));
        off += th;
      }
    }
    if (!pages.length) throw new Error('empty');
    previewPages.value = pages;
  } catch (e) {
    toast(t('预览失败：') + String(e.message || e), 'warn');
  } finally { previewBusy.value = false; }
}

/* ---------------- 点击定位播放头 ---------------- */
function onScoreClick(e) {
  const el = e.target && e.target.closest ? e.target.closest('[data-tick]') : null;
  if (!el) return;
  const tick = parseInt(el.getAttribute('data-tick'), 10);
  if (!isFinite(tick)) return;
  const p = getPlayer();
  if (!p) return;
  const s = song.value, tr = selTrack.value;
  // 从量化 tick 反查最近的真实音符起点（避免量化误差）
  let real = tick;
  if (s && tr && tr.notes.length) {
    const onsets = tr.notes;
    let lo = 0, hi = onsets.length - 1, best = onsets[0].start;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (onsets[mid].start <= tick) { best = onsets[mid].start; lo = mid + 1; } else hi = mid - 1; }
    real = best;
  }
  p.seekTick(real);
  toast(t('已定位到音符 @ ') + real, 'ok');
}

/* ---------------- 生命周期 ---------------- */
let followRaf = 0;
function loop() {
  tickFollow();
  followRaf = requestAnimationFrame(loop);
}
onMounted(() => {
  nextTick(scheduleRender);
  followRaf = requestAnimationFrame(loop);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(followRaf);
  if (renderRaf) cancelAnimationFrame(renderRaf);
});
</script>

<template>
  <div class="score-view">
    <div class="score-toolbar">
      <span class="tb-label">{{ t('乐谱轨道') }}</span>
      <span class="trk-sel">
        <span class="trk-dot" :style="{ background: (selTrack ? (TRACK_COLORS[trackSel % TRACK_COLORS.length]) : 'var(--stone)') }"></span>
        <select class="select-input" :value="trackSel" @change="trackSel = $event.target.value" :disabled="!tracks.length">
          <option v-for="(tr, i) in tracks" :key="i" :value="i">{{ tr.name || (t('音轨 ') + (i + 1)) }}</option>
        </select>
      </span>
      <span class="sep"></span>

      <select class="select-input" :value="mode" @change="mode = $event.target.value; changeMode()">
        <option value="staff">{{ t('五线谱') }}</option>
        <option value="jianpu">{{ t('简谱') }}</option>
        <option value="guitar">{{ t('吉他六线谱') }}</option>
        <option value="bass">{{ t('贝斯四线谱') }}</option>
      </select>
      <select v-if="mode === 'jianpu'" class="select-input" :value="fontSz" @change="fontSz = parseInt($event.target.value, 10) || 22" style="width:78px">
        <option :value="18">{{ t('简谱小') }}</option>
        <option :value="22">{{ t('简谱中') }}</option>
        <option :value="28">{{ t('简谱大') }}</option>
      </select>

      <span class="sep"></span>

      <button class="btn sm" :class="{ active: follow }" @click="follow = !follow" :title="t('跟随播放')">
        <Icon name="play2" :size="14" />{{ t('跟随播放') }}
      </button>
      <button class="btn sm" @click="showOpts = !showOpts" :title="t('显示选项')">
        <Icon name="eye" :size="14" />{{ t('显示') }}
      </button>
      <div v-if="showOpts" class="score-pop" @mouseleave="showOpts = false">
        <label><input type="checkbox" v-model="opts.simple" @change="changeMode()" />{{ t('简化记谱') }}</label>
        <label><input type="checkbox" v-model="opts.grid" @change="changeMode()" />{{ t('四分音符网格') }}</label>
        <label><input type="checkbox" v-model="opts.beam" @change="changeMode()" />{{ t('自动连线') }}</label>
        <label><input type="checkbox" v-model="opts.multi" @change="changeMode()" />{{ t('多轨显示') }}</label>
      </div>

      <span class="sep"></span>
      <button class="btn sm" @click="importMusicXML" :disabled="midiBusy" :title="t('导入 MusicXML 文件')">
        <Icon name="import" :size="14" />{{ t('MusicXML') }}
      </button>
      <button class="btn sm" @click="exportMusicXML" :disabled="!song" :title="t('导出 MusicXML 文件')">
        <Icon name="save" :size="14" />{{ t('导出 XML') }}
      </button>
      <button class="btn sm" @click="previewScore" :disabled="mode !== 'staff' || previewBusy" :title="t('分页预览')">
        <Icon name="eye" :size="14" />{{ t('预览') }}
      </button>
      <button class="btn sm" @click="exportStaffPng" :disabled="mode !== 'staff' || exporting">
        <Icon name="save" :size="14" />{{ t('PNG') }}
      </button>
      <button class="btn sm" @click="exportPdf" :disabled="mode !== 'staff'" :title="t('导出 PDF（打印当前页面）')">
        <Icon name="save" :size="14" />{{ t('PDF') }}
      </button>
      <button class="btn sm" @click="openScoreSplit" :disabled="mode !== 'staff' || !song" :title="t('分屏查看乐谱并点击定位')">
        <Icon name="viz" :size="14" />{{ t('分屏') }}
      </button>

      <span style="flex:1"></span>
      <span class="tb-status">
        <span class="pulse" :class="{ on: state.playing }"></span>
        <span>{{ status || (song ? (selTrack ? selTrack.name || t('音轨 ') + (trackSel + 1) : '') + ' · ' + ((song.sigMap && song.sigMap[0]) ? song.sigMap[0].num + '/' + song.sigMap[0].den : '4/4') + ' · ' + (ABC_KEY_NAMES[clamp((song.keySig && song.keySig.sf != null) ? song.keySig.sf : detectSf(selTrack ? selTrack.notes : []), -7, 7)] || 'C') + ' · ' + (selTrack ? selTrack.notes.length : 0) + ' 音符' : t('未加载')) }}</span>
      </span>

      <span class="sep"></span>
      <div class="zoom-fab">
        <button class="icon-btn" @click="setZoom(zoom - 0.1)" :title="t('缩小')"><Icon name="minus" :size="14" /></button>
        <span class="zf-pct">{{ Math.round(zoom * 100) }}%</span>
        <button class="icon-btn" @click="setZoom(zoom + 0.1)" :title="t('放大')"><Icon name="plus" :size="14" /></button>
      </div>
    </div>

    <div class="score-scroll" ref="scrollEl">
      <!-- 五线谱：abcjs 渲染容器 -->
      <div ref="scoreEl" id="abcScore" v-show="mode === 'staff'" @click="onScoreClick"></div>
      <!-- 简谱 -->
      <div v-if="mode === 'jianpu'">
        <div v-for="b in jianpuBlocks" :key="b.ti" class="score-block">
          <div class="score-block-name">{{ b.name }}</div>
          <div v-if="b.error" class="score-empty">{{ b.error }}</div>
          <template v-else>
            <div v-if="b.truncated" class="score-empty" style="padding:8px">{{ t('该轨道音符过多') }}（{{ b.total }}），{{ t('简谱仅显示前') }} {{ b.max }} {{ t('个音符') }}</div>
            <div class="jianpu" :style="{ fontSize: fontSz + 'px' }">
              <span v-for="(c, i) in b.cells" :key="i" class="jp-cell">
                <span class="jp-note" :class="c.cls">{{ c.acc }}{{ c.num }}{{ c.dots }}</span>
                <span v-if="c.dash" class="jp-dash">{{ c.dash }}</span>
              </span>
            </div>
          </template>
        </div>
      </div>
      <!-- 吉他 / 贝斯 TAB -->
      <div v-if="mode === 'guitar' || mode === 'bass'">
        <div v-for="b in tabBlocks" :key="b.ti" class="score-block">
          <div class="score-block-name">{{ b.name }}</div>
          <div v-if="b.error" class="score-empty">{{ b.error }}</div>
          <template v-else>
            <div class="score-empty" style="padding:6px">{{ t('自动把位（按音高就近排布，可编辑视图调整音高）') }} · {{ b.placed }} {{ t('音') }}</div>
            <div class="tab-sys">
              <div v-for="(sys, si) in b.systems" :key="si" class="tab-sys-block">
                <div v-for="(l, li) in sys" :key="li" class="tab-line">{{ l }}</div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <div class="score-legend">
      <span class="lg-item"><span class="dot" style="background:#ffd866"></span>{{ t('正在播放音符') }}</span>
      <span class="lg-item"><span class="dot" style="background:#1456f0"></span>{{ t('升降号自动按调号判定') }}</span>
    </div>

    <!-- 乐谱分页预览弹窗 -->
    <div v-if="previewOpen" class="pv-overlay" @click.self="previewOpen = false">
      <div class="pv-card">
        <div class="pv-head">
          <b>{{ t('乐谱分页预览') }}</b>
          <button class="icon-btn" @click="previewOpen = false" title="关闭"><Icon name="plus" :size="14" style="transform:rotate(45deg)" /></button>
        </div>
        <div class="pv-body">
          <div v-if="previewBusy" class="score-empty">{{ t('正在生成预览…') }}</div>
          <template v-else>
            <div v-for="(p, i) in previewPages" :key="i" class="pv-page">
              <div class="pv-page-name">{{ t('第 ') }}{{ i + 1 }}{{ t(' 页') }}</div>
              <img :src="p" alt="score page" />
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- 乐谱分屏预览弹窗 -->
    <div v-if="splitOpen" class="pv-overlay" @click.self="splitOpen = false">
      <div class="pv-card">
        <div class="pv-head">
          <b>{{ t('乐谱分屏') }}</b>
          <button class="icon-btn" @click="splitOpen = false" title="关闭"><Icon name="plus" :size="14" style="transform:rotate(45deg)" /></button>
        </div>
        <div ref="splitContent" class="split-body"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.score-view { display: flex; flex-direction: column; height: 100%; background: var(--canvas); }
.score-toolbar {
  display: flex; align-items: center; gap: 8px;
  padding: 10px 14px; border-bottom: 1px solid var(--hairline);
  flex-wrap: wrap; flex: none;
}
.tb-label { font-size: 12px; color: var(--stone); font-weight: 600; }
.trk-sel { display: inline-flex; align-items: center; gap: 6px; }
.trk-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
.sep { width: 1px; height: 20px; background: var(--hairline); margin: 0 2px; }
.tb-status { display: inline-flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--steel); min-width: 0; }
.tb-status .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--stone); flex: none; }
.tb-status .pulse.on { background: var(--success-text); box-shadow: 0 0 0 0 rgba(27,166,115,.5); animation: pulse 1.4s infinite; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(27,166,115,.5); } 70% { box-shadow: 0 0 0 6px rgba(27,166,115,0); } 100% { box-shadow: 0 0 0 0 rgba(27,166,115,0); } }
.zoom-fab { display: inline-flex; align-items: center; gap: 2px; }
.zf-pct { font-size: 11px; color: var(--stone); min-width: 40px; text-align: center; font-variant-numeric: tabular-nums; }
.score-pop {
  position: absolute; top: 46px; right: 130px; z-index: 40;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: 12px; box-shadow: var(--shadow);
  padding: 10px 12px; display: flex; flex-direction: column; gap: 8px;
  font-size: 12.5px; color: var(--ink); min-width: 140px;
}
.score-pop label { display: flex; align-items: center; gap: 8px; cursor: pointer; }
.score-pop input { accent-color: var(--ink); }

.score-scroll { flex: 1; overflow: auto; padding: 6px 10px 20px; }
.score-block { margin-bottom: 14px; border-bottom: 1px dashed var(--hairline); padding-bottom: 8px; }
.score-block-name { font-size: 12px; color: var(--stone); margin-bottom: 4px; }

.score-empty { color: var(--stone); font-size: 13px; padding: 18px 12px; line-height: 1.8; text-align: center; }
.jianpu { display: block; padding: 14px 8px; line-height: 2; color: var(--ink); }
.jp-cell { display: inline-block; margin: 2px 8px; white-space: nowrap; }
.jp-note { font-weight: 700; color: #d45656; }
.jp-long::after { content: ' —'; color: var(--stone); }
.jp-half::after { content: ' -'; color: var(--stone); }
.jp-8 { text-decoration: underline; }
.jp-16 { text-decoration: underline double; }
.jp-dash { color: var(--stone); font-size: 15px; margin-left: 4px; }
.tab-sys { display: flex; flex-direction: column; gap: 16px; padding: 12px 8px; }
.tab-line { font-family: var(--mono); font-size: 13px; line-height: 1.55; white-space: pre; overflow-x: auto; color: var(--steel); padding: 1px 0; }

.score-legend {
  display: flex; gap: 14px; flex-wrap: wrap; align-items: center;
  padding: 8px 14px; border-top: 1px solid var(--hairline);
  font-size: 11px; color: var(--stone); flex: none;
}
.lg-item { display: inline-flex; align-items: center; gap: 6px; }
.lg-item .dot { width: 7px; height: 7px; border-radius: 50%; }

/* Verovio 五线谱：强制使用主题文字色，避免深色主题下黑音符融入背景 */
:deep(#abcScore) { color: var(--ink) !important; background: transparent; }
:deep(#abcScore svg) { color: var(--ink) !important; }
:deep(#abcScore svg svg) { color: var(--ink) !important; }
:deep(#abcScore svg *) {
  stroke: currentColor !important;
  fill: currentColor !important;
}
:deep(#abcScore .fu-play *) { fill: #ffb224 !important; stroke: #ffb224 !important; }
:deep(#abcScore .fu-play .abcjs-notehead) { stroke: #6b3200 !important; stroke-width: 2 !important; }
:deep(#abcScore .fu-play .abcjs-stem) { stroke: #ffbe3c !important; stroke-width: 2.2 !important; }
:deep(#abcScore .abcjs-note) { cursor: pointer; }
:deep(#abcScore svg .abcjs-ending) { display: none; }
:deep(#abcScore.fu-grid) { background-image: repeating-linear-gradient(to right, var(--hairline) 0 1px, transparent 1px var(--fu-beatw, 56px)); }

/* 分页预览弹窗 */
.pv-overlay {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(10, 10, 10, 0.28);
  display: flex; align-items: center; justify-content: center;
  padding: 30px;
}
.pv-card {
  width: 780px; max-width: 96vw; max-height: 88vh;
  background: var(--canvas); border: 1px solid var(--hairline);
  border-radius: 16px; box-shadow: var(--shadow-lg);
  display: flex; flex-direction: column; overflow: hidden;
}
.pv-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--hairline);
  font-size: 14px; font-weight: 700; color: var(--ink);
  flex: none;
}
.pv-body { flex: 1; overflow-y: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 14px; }
.pv-page { border: 1px solid var(--hairline); border-radius: 12px; overflow: hidden; }
.pv-page-name { font-size: 11px; color: var(--stone); padding: 5px 10px; border-bottom: 1px solid var(--hairline); }
.pv-page img { width: 100%; display: block; background: var(--canvas); }
.split-body { flex: 1; overflow: auto; padding: 14px 16px; }
.split-body svg { max-width: 100%; display: block; margin: 0 auto; background: var(--canvas); }
</style>
