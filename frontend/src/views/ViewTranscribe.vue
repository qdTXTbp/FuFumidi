<script setup>
// 转录视图：音频 → MIDI（本地 Python 引擎，桌面端通过 fuBridge 桥接）
import { ref, reactive, computed, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { clamp, esc, fmtTime } from '../core/util.js';
import { t } from '../core/i18n.js';

const app = useAppStore();
const toast = (m, t) => app.toast(m, t);
const importFiles = (items) => app.importFiles(items);
const setView = (v) => app.setView(v);

const bridge = window.fuBridge;
const isDesktop = !!(bridge && bridge.convert);

/* ---------------- 状态 ---------------- */
const mode = ref('universal');           // universal | piano | separate
const umodel = ref('basic');             // 通用子模型：basic | muscriptor
const msSize = ref('medium');            // MuScriptor 规格：small | medium | large
const pmodel = ref('piano_pt');          // 钢琴子模型：piano_pt | aria | transkun
const perf = ref('quality');             // quality | balanced | fast
const perfHint = ref('');
const busy = ref(false);
const done = ref(false);
const progress = ref(0);
const stage = ref('');
const jobId = ref(0);
const logs = ref([]);
const logExpanded = ref(false);
const lastOut = ref('');
const doneInfo = ref('');
const gpuInfo = ref('');

/* ---------------- 模型下载状态（用于标记哪些模型已安装） ---------------- */
// key → model:list 返回条目的 id；basic / piano_pt 为内置兜底，始终就绪
const modelStatus = reactive({ basic: true, piano_pt: true });
async function refreshModelStatus() {
  try {
    if (bridge && bridge.modelList) {
      const arr = await bridge.modelList() || [];
      for (const m of arr) {
        if (m && m.id) modelStatus[m.id] = !!m.exists;
      }
    }
  } catch (e) {}
}
function modelInstalled(key) {
  // 返回 true（已就绪）/ false（未下载）/ null（未知）
  return modelStatus[key] === true || modelStatus[key] === false ? modelStatus[key] : null;
}
// 当前激活模型的可读名称（供日志标注）
function currentModelLabel() {
  if (mode.value === 'separate') return 'HTDemucs 人声分离';
  if (mode.value === 'universal') return umodel.value === 'muscriptor' ? ('MuScriptor ' + msSize.value.toUpperCase()) : 'Basic Pitch';
  // piano
  if (pmodel.value === 'piano_pt') return 'piano-transcription';
  return pmodel.value === 'aria' ? 'Aria-AMT' : 'Transkun';
}
function currentModelInstalled() {
  const key = mode.value === 'separate' ? 'demucs_htdemucs'
    : mode.value === 'universal'
      ? (umodel.value === 'muscriptor' ? 'muscriptor_' + msSize.value : 'basic')
      : (pmodel.value === 'aria' ? 'aria_amt' : pmodel.value === 'piano_pt' ? 'piano_pt' : 'transkun');
  const st = modelInstalled(key);
  return st; // true / false / null
}

// 高级参数
const onset = ref(0.5);
const frame = ref(0.3);
const minNote = ref(128);
const mergeGap = ref(30);
const pedal = ref(true);
const drums = ref(false);
const stemExport = ref(false);
const stemFormat = ref('wav');
const denoise = ref(false);
const normalize = ref(false);
const autoBpm = ref(false);

// 转录队列
const queue = reactive([]);
let nextId = 1;
const sort = ref('default');
const running = ref(false);
const paused = ref(false);
const cancelAll = ref(false);
const currentJobId = ref(null);

// 音频信息 + 波形
const audioInfo = ref('');
const duration = ref(0);
const audioPath = ref('');
const waveEl = ref(null);
const waveBox = ref(null);

// 参数预设
const presets = reactive({ list: [], builtins: [] });
const presetSel = ref('');
const presetMgrOpen = ref(false);

// 任务模板
const taskTemplates = reactive([]);
const tplName = ref('');
const tplIdx = ref(-1);

// 智能修正
const rf = reactive({ audio: '', midi: '', mode: 'auto', stem: true, busy: false, jobId: 0, progress: 0, logs: [], info: '' });

const MODE_NAMES = { universal: t('通用识别'), piano: t('钢琴专用'), separate: t('人声分离') };
const PERF_NAMES = { quality: t('最高质量'), balanced: t('均衡'), fast: t('高性能') };
const MODE_DEFAULT_PRESET = { universal: t('通用·标准'), piano: t('钢琴：最优'), separate: t('人声：最优') };

// 网页版内置预设（与引擎 presets.py 的 _builtin_presets 保持一致，仅取界面可应用的键）：
// 无桥接时 loadPresets 用这份数据填充，避免「应用预设」因列表为空而失效。
const WEB_BUILTIN_PRESETS = [
  { name: '人声：最优', mode: 'separate', params: { onset_threshold: 0.05, frame_threshold: 0.25, minimum_note_length: 100, include_drums: true, denoise: true, normalize: true, auto_bpm: true } },
  { name: '钢琴：最优', mode: 'piano', params: { onset_threshold: 0.05, frame_threshold: 0.06, min_note_ms: 20, merge_gap_ms: 0, include_pedal: true, denoise: true, normalize: true } },
  { name: '通用·标准', mode: 'universal', params: {} },
  { name: '通用·更干净', mode: 'universal', params: { onset_threshold: 0.60, frame_threshold: 0.45, minimum_note_length: 180 } },
  { name: '通用·更灵敏', mode: 'universal', params: { onset_threshold: 0.40, frame_threshold: 0.25, minimum_note_length: 80 } },
  { name: '通用·人声主旋律', mode: 'universal', params: { minimum_note_length: 150 } },
  { name: '通用·人声纯净', mode: 'universal', params: { onset_threshold: 0.45, frame_threshold: 0.35, minimum_note_length: 160, merge_gap_ms: 40, denoise: true } },
  { name: '通用·吉他拨弦', mode: 'universal', params: { frame_threshold: 0.30, minimum_note_length: 100 } },
  { name: '通用·低音乐器', mode: 'universal', params: { frame_threshold: 0.35, minimum_note_length: 200 } },
  { name: '钢琴·标准', mode: 'piano', params: {} },
  { name: '钢琴·快速琶音', mode: 'piano', params: { onset_threshold: 0.25, min_note_ms: 40, merge_gap_ms: 25, include_pedal: false } },
  { name: '分离·标准', mode: 'separate', params: {} },
  { name: '分离·带鼓组', mode: 'separate', params: { include_drums: true } },
];

const fileInput = ref(null);

function estSec() {
  if (!duration.value || duration.value <= 0) return null;
  let f = { universal: 1.5, piano: 4, separate: 10 }[mode.value] || 2;
  if (perf.value === 'fast') f *= 1.5;
  else if (perf.value === 'balanced') f *= 1.15;
  return Math.max(2, Math.round(duration.value * f));
}
const sumTime = computed(() => {
  if (!queue.some(i => i.status === 'pending' || i.status === 'running')) return null;
  const e = estSec();
  return e ? t('约 ') + fmtTime(e) : t('依引擎与性能档位而定');
});
const pendingCount = computed(() => queue.filter(i => i.status === 'pending' || i.status === 'error' || i.status === 'canceled').length);

/* ---------------- 队列 ---------------- */
function addPaths(paths) {
  for (const p of (paths || [])) {
    if (!p) continue;
    if (queue.some(i => i.path === p)) continue;
    queue.push({ id: nextId++, path: p, name: String(p).replace(/^.*[\\/]/, ''), status: 'pending', progress: 0, duration: 0, out: '', note_count: 0, error: '' });
  }
  saveQueue();
}
function statusTxt(s) {
  return { pending: t('等待'), running: t('转录中'), done: t('完成'), error: t('失败'), canceled: t('已取消') }[s] || s;
}
function saveQueue() {
  try {
    localStorage.setItem('fufumidi_batch_queue', JSON.stringify(queue.filter(i => i.status === 'pending' || i.status === 'error').map(i => i.path)));
  } catch (e) {}
}
function loadQueue() {
  try {
    const raw = localStorage.getItem('fufumidi_batch_queue');
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length && !queue.length) {
      addPaths(arr);
      toast('已恢复上次未完成的转录队列，共 ' + arr.length + t(' 个'), 'ok');
    }
    localStorage.removeItem('fufumidi_batch_queue');
  } catch (e) {}
}
function removeItem(it) {
  if (running.value && it.status === 'running') return;
  const i = queue.indexOf(it);
  if (i >= 0) queue.splice(i, 1);
  saveQueue();
}
function retryItem(it) {
  it.status = 'pending'; it.progress = 0; it.error = '';
  if (!running.value) runBatch();
}
function retryAll() {
  queue.forEach(i => { if (i.status === 'error' || i.status === 'canceled') { i.status = 'pending'; i.progress = 0; i.error = ''; } });
  if (!running.value) runBatch();
}
function clearDone() {
  if (running.value) { toast('队列运行中，请先停止', 'warn'); return; }
  const before = queue.length;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].status === 'done') queue.splice(i, 1);
  if (queue.length !== before) saveQueue();
}
function clearQueue() {
  if (running.value) { toast('队列运行中，请先取消', 'warn'); return; }
  queue.length = 0;
  saveQueue();
  toast('已清空转录队列', 'ok');
}
const sortedQueue = computed(() => {
  const arr = queue.slice();
  if (sort.value === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  else if (sort.value === 'type') arr.sort((a, b) => (String(a.name || '').split('.').pop() || '').localeCompare(String(b.name || '').split('.').pop() || ''));
  else if (sort.value === 'duration') arr.sort((a, b) => (a.duration || 0) - (b.duration || 0));
  return arr;
});
const queueStat = computed(() => {
  const n = queue.length, d = queue.filter(i => i.status === 'done').length, e = queue.filter(i => i.status === 'error').length;
  if (paused.value) return t('已暂停');
  if (running.value) return t('队列运行中');
  if (!n) return t('队列为空');
  return t('共 ') + n + t(' 首 · 完成 ') + d + (e ? t(' · 失败 ') + e : '');
});

/* ---------------- 音频选择 / 波形 ---------------- */
async function pickAudio() {
  if (isDesktop && bridge.pickAudioFiles) {
    try {
      const paths = await bridge.pickAudioFiles();
      if (paths && paths.length) { addPaths(paths); setPrimary(paths[0]); toast('已添加 ' + paths.length + t(' 个音频到队列'), 'ok'); }
    } catch (err) { toast('选择音频失败：' + (err && err.message || err), 'warn'); }
  } else {
    fileInput.value && fileInput.value.click();
  }
}
function onFileChange(e) {
  const files = Array.from(e.target.files || []);
  if (files.length) {
    addPaths(files.map(f => f.path || f.name));
    files.forEach((f, i) => { const q = queue.find(x => x.path === (f.path || f.name)); if (q) q._file = f; });
    setPrimary(files[0].path || files[0].name);
    toast('已添加 ' + files.length + t(' 个音频到队列'), 'ok');
  }
  e.target.value = '';
}
async function pickFolder() {
  if (!bridge || !bridge.pickDirectory || !bridge.listAudioFiles) { toast('请使用桌面版选择文件夹', 'warn'); return; }
  try {
    const dir = await bridge.pickDirectory();
    if (!dir) return;
    const files = await bridge.listAudioFiles(dir);
    if (!files || !files.length) { toast('文件夹里没有找到音频文件', 'warn'); return; }
    addPaths(files);
    setPrimary(files[0]);
    toast('已添加 ' + files.length + t(' 个音频到队列'), 'ok');
  } catch (e) { /* ignore */ }
}
const dropOver = ref(false);
function onDrop(e) {
  dropOver.value = false;
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length) { toast('请拖入音频文件', 'warn'); return; }
  addPaths(files.map(f => f.path || f.name));
  files.forEach((f, i) => { const q = queue.find(x => x.path === (f.path || f.name)); if (q) q._file = f; });
  setPrimary(files[0].path || files[0].name);
  toast('已添加 ' + files.length + t(' 个音频到队列'), 'ok');
}
function updateAudioInfo() {
  if (!audioPath.value) { audioInfo.value = ''; return; }
  const q = queue.find(i => i.path === audioPath.value);
  audioInfo.value = (q ? q.name : String(audioPath.value).replace(/^.*[\\/]/, '')) + (duration.value ? ' · ' + fmtTime(duration.value) : '');
}
function setPrimary(p) {
  if (!audioPath.value) { audioPath.value = p; updateAudioInfo(); previewWave(p); }
}
async function previewWave(pathOrName) {
  const box = waveBox.value, cv = waveEl.value;
  if (!box || !cv) return;
  let ab = null;
  try {
    if (isDesktop && bridge.readBinary) ab = await bridge.readBinary(pathOrName);
    else {
      // 浏览器回退：从队列项拿 File
      const it = queue.find(i => i.path === pathOrName);
      if (it && it._file) ab = await it._file.arrayBuffer();
    }
  } catch (e) {}
  if (!ab) { box.classList.add('hidden'); return; }
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC();
    actx.decodeAudioData(ab.slice(0), abuf => {
      duration.value = abuf.duration || 0;
      const w = cv.clientWidth || 700; cv.width = w; cv.height = 64;
      const g = cv.getContext('2d');
      g.clearRect(0, 0, w, 64);
      g.fillStyle = 'rgba(20,86,240,0.08)'; g.fillRect(0, 0, w, 64);
      const ch = abuf.getChannelData(0), n = ch.length, step = Math.max(1, Math.floor(n / w));
      g.fillStyle = '#3daeff';
      for (let x = 0; x < w; x++) {
        let mn = 1, mx = -1;
        for (let i = x * step; i < (x + 1) * step && i < n; i++) { const v = ch[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const y1 = 32 - mx * 29, y2 = 32 - mn * 29;
        g.fillRect(x, Math.min(y1, y2), 1, Math.max(1, Math.abs(y2 - y1)));
      }
      box.classList.remove('hidden');
      updateAudioInfo();
      if (actx.close) actx.close();
    }, () => box.classList.add('hidden'));
  } catch (e) { box.classList.add('hidden'); }
}

/* ---------------- 引擎探测 / 性能推荐 ---------------- */
let perfUserSet = false;
async function loadPerfDefault() {
  if (perfUserSet || !bridge || !bridge.getSettings) return;
  try {
    const s = await bridge.getSettings() || {};
    if (s.perf_mode) {
      perf.value = s.perf_mode;
      perfHint.value = '';
    }
  } catch (e) {}
}
async function probeEngine() {
  if (!bridge || !bridge.probe) return;
  try {
    const p = await bridge.probe();
    if (!perfUserSet && p && p.perf && p.perf.recommended) {
      perf.value = p.perf.recommended;
      perfHint.value = t('自动推荐：') + (PERF_NAMES[p.perf.recommended] || p.perf.recommended);
    }
    if (p && p.gpu) {
      const g = p.gpu;
      if (g.cuda) gpuInfo.value = 'GPU · ' + (g.vendor === 'nvidia' ? 'NVIDIA' : 'CUDA') + ' ✓';
      else if (g.mps) gpuInfo.value = 'GPU · Apple (MPS) ✓';
      else if (g.torch_directml || g.directml) gpuInfo.value = 'GPU · ' + (g.vendor === 'amd' ? 'AMD' : g.vendor === 'intel' ? 'Intel' : 'DirectML') + ' (DirectML) ✓';
    }
  } catch (e) {}
}
function selectPerf(p) { perfUserSet = true; perf.value = p; }

/* ---------------- 参数预设 ---------------- */
async function loadPresets() {
  const local = !bridge || !bridge.presets;
  let list = [], builtins = [];
  if (local) {
    // 网页版无桥接：用前端内置预设，保证「应用预设」可用（保存/删除仅桌面版支持）
    list = WEB_BUILTIN_PRESETS.map(p => ({ name: p.name, mode: p.mode, params: p.params }));
    builtins = WEB_BUILTIN_PRESETS.map(p => p.name);
  } else {
    try {
      const r = await bridge.presets.list();
      if (!r || !r.ok) { toast('加载预设失败：' + ((r && r.error) || ''), 'warn'); return; }
      list = Object.entries(r.presets || {}).map(([name, val]) => ({ name, ...val }));
      builtins = r.builtins || [];
    } catch (e) {}
  }
  presets.list.splice(0, presets.list.length, ...list);
  presets.builtins.splice(0, presets.builtins.length, ...builtins);
  if (presets.list.length) presetSel.value = presets.list[0].name;
}
function applyPreset(name) {
  const p = presets.list.find(x => x.name === name);
  if (!p) return false;
  mode.value = p.mode || 'universal';
  const pr = p.params || {};
  onset.value = pr.onset_threshold != null ? pr.onset_threshold : onset.value;
  frame.value = pr.frame_threshold != null ? pr.frame_threshold : frame.value;
  const mnRaw = pr.minimum_note_length != null ? pr.minimum_note_length : (pr.min_note_ms != null ? pr.min_note_ms : minNote.value);
  minNote.value = clamp(Math.round(parseFloat(mnRaw) || 128), 10, 300);
  mergeGap.value = clamp(Math.round(parseFloat(pr.merge_gap_ms != null ? pr.merge_gap_ms : mergeGap.value) || 0), 0, 200);
  pedal.value = pr.include_pedal !== false;
  drums.value = !!pr.include_drums;
  denoise.value = !!pr.denoise;
  normalize.value = !!pr.normalize;
  autoBpm.value = !!pr.auto_bpm;
  presetSel.value = name;
  return true;
}
function applyDefaultForMode(m) {
  const def = MODE_DEFAULT_PRESET[m];
  if (!def || !presets.list.some(x => x.name === def)) return;
  if (presetSel.value === def) return;
  applyPreset(def);
}
function onModeChange(m) {
  const prev = mode.value;
  mode.value = m;
  if (m !== prev) applyDefaultForMode(m);
}
async function savePreset() {
  if (!bridge || !bridge.presets) { toast('请使用桌面版保存预设', 'warn'); return; }
  const name = await app.promptDialog({ title: t('保存预设'), value: '' });
  if (!name || !name.trim()) return;
  const params = collectParams();
  try {
    const r = await bridge.presets.save(name.trim(), mode.value, params);
    if (r && r.ok) { toast('预设已保存', 'ok'); loadPresets(); }
    else toast('保存预设失败：' + ((r && r.error) || ''), 'warn');
  } catch (e) {}
}
async function delPreset() {
  if (!bridge || !bridge.presets || !presetSel.value) return;
  if (!await app.confirmDialog({ msg: t('删除预设「') + presetSel.value + '」？' })) return;
  try {
    const r = await bridge.presets.delete(presetSel.value);
    if (r && r.ok) { toast('预设已删除', 'ok'); loadPresets(); }
  } catch (e) {}
}
async function openPresetMgr() {
  presetMgrOpen.value = true;
  await loadPresets();
}
async function mgrApply(name) {
  if (applyPreset(name) && bridge && bridge.presets && bridge.presets.lastUsed) {
    try { await bridge.presets.lastUsed(name); } catch (e) {}
  }
  presetMgrOpen.value = false;
  toast('已应用预设：' + name, 'ok');
}
async function mgrDelete(name) {
  if (!bridge || !bridge.presets) return;
  if (!await app.confirmDialog({ msg: t('删除预设「') + name + '」？' })) return;
  try {
    const r = await bridge.presets.delete(name);
    if (r && r.ok) { toast('预设已删除', 'ok'); await loadPresets(); }
    else toast('删除失败：' + ((r && r.error) || ''), 'warn');
  } catch (e) {}
}
async function mgrRestore() {
  if (!bridge || !bridge.presets || !bridge.presets.restore) return;
  try {
    const r = await bridge.presets.restore();
    if (r && r.ok) { toast('已恢复全部内置预设', 'ok'); await loadPresets(); }
    else toast('恢复失败', 'warn');
  } catch (e) {}
}
const presetDragName = ref('');
function presetDragStart(p) { presetDragName.value = p.name; }
async function presetDrop(p) {
  const drag = presetDragName.value;
  presetDragName.value = '';
  if (!drag || drag === p.name || !bridge || !bridge.presets) return;
  try {
    const from = presets.list.findIndex(x => x.name === drag);
    const to = presets.list.findIndex(x => x.name === p.name);
    if (from < 0 || to < 0) return;
    const r = await bridge.presets.reorderTo(drag, to);
    if (r && r.ok) await loadPresets();
    else toast('排序失败', 'warn');
  } catch (e) {}
}

/* ---------------- 任务模板 ---------------- */
function loadTaskTemplates() {
  try { taskTemplates.splice(0, taskTemplates.length, ...(JSON.parse(localStorage.getItem('fufumidi_task_templates') || '[]') || [])); } catch (e) {}
}
function saveTaskTemplates() { try { localStorage.setItem('fufumidi_task_templates', JSON.stringify(taskTemplates)); } catch (e) {} }
function saveTemplate() {
  const name = tplName.value.trim();
  if (!name) { toast('请输入模板名', 'warn'); return; }
  const tpl = { name, mode: mode.value, perf: perf.value, refine: rf.stem, exportStems: stemExport.value };
  const i = taskTemplates.findIndex(x => x.name === name);
  if (i >= 0) taskTemplates[i] = tpl; else taskTemplates.push(tpl);
  saveTaskTemplates(); tplName.value = '';
  toast('任务模板已保存', 'ok');
}
function applyTemplate(tpl) {
  if (!tpl) return;
  mode.value = tpl.mode; perf.value = tpl.perf;
  stemExport.value = !!tpl.exportStems; rf.stem = tpl.refine !== false;
  toast('任务模板已应用', 'ok');
}
function delTemplate(idx) {
  taskTemplates.splice(idx, 1); saveTaskTemplates();
  toast('模板已删除', 'ok');
}
const tplPreview = (t) => t ? (MODE_NAMES[t.mode] || '') + ' · ' + (PERF_NAMES[t.perf] || '') + ' · ' + (t.refine ? t('修正') : t('无修正')) + ' · ' + (t.exportStems ? t('分轨') : t('不分轨')) : '';

/* ---------------- 参数收集 ---------------- */
function collectParams() {
  const cfg = {
    onset_threshold: parseFloat(onset.value.toFixed(2)),
    frame_threshold: parseFloat(frame.value.toFixed(2)),
    min_note_length: parseInt(minNote.value, 10),
    denoise: denoise.value,
    normalize: normalize.value,
    auto_bpm: autoBpm.value,
  };
  if (mode.value === 'piano') {
    cfg.min_note_ms = parseInt(minNote.value, 10);
    cfg.no_pedal = !pedal.value;
    cfg.merge_gap_ms = parseInt(mergeGap.value, 10);
    cfg.model = pmodel.value;
  }
  if (mode.value === 'universal') {
    cfg.model = umodel.value;
    if (umodel.value === 'muscriptor') cfg.model_size = msSize.value;
  }
  if (mode.value === 'separate') {
    cfg.with_drums = drums.value;
    cfg.export_stems = stemExport.value;
    cfg.stem_format = stemFormat.value || 'wav';
  }
  return cfg;
}

/* ---------------- 日志 ---------------- */
function logLine(txt, isErr) {
  logs.value.push({ txt, isErr: !!isErr });
  if (logs.value.length > 500) logs.value.splice(0, logs.value.length - 500);
}
function clearLog() { logs.value = []; }

/* ---------------- 转录运行 ---------------- */
let trTimer = null;
async function decodeDuration(it) {
  if (it.duration || !bridge || !bridge.readBinary) return;
  try {
    const buf = await bridge.readBinary(it.path);
    if (!buf) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    const actx = new AC();
    await new Promise(res => {
      try { actx.decodeAudioData(buf.slice(0), ab => { it.duration = ab.duration || 0; res(); }, () => res()); } catch (e) { res(); }
    });
    if (actx.close) actx.close();
  } catch (e) {}
}
async function runBatch() {
  if (running.value) return;
  if (!isDesktop) { toast('请使用桌面版 FuFumidi 进行转录', 'warn'); return; }
  if (!queue.some(i => i.status === 'pending')) {
    const d = queue.filter(i => i.status === 'done').length;
    toast(d ? t('队列已完成，可清空后继续添加音频') : t('请先选择音频文件'), d ? 'ok' : 'warn');
    return;
  }
  running.value = true; paused.value = false; cancelAll.value = false; busy.value = true; done.value = false; progress.value = 3; stage.value = '';
  logLine(t('转录队列：共 ') + pendingCount.value + ' 首，顺序处理…');
  const inst = currentModelInstalled();
  logLine(t('使用模型：') + currentModelLabel() + (inst === true ? t('（已就绪）') : inst === false ? t('（未下载，请到资源中心安装）') : ''));
  const t0 = Date.now();
  clearInterval(trTimer);
  trTimer = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    const doneN = queue.filter(i => i.status === 'done').length;
    const errN = queue.filter(i => i.status === 'error').length;
    const total = Math.max(1, queue.length);
    const cur = queue.find(i => i.status === 'running');
    // 当前项进度：未完成时按已用时间/预估时长估算（平滑推进而非停在 3% 突跳到 100%）
    let curP = 0;
    if (cur) {
      if (cur.progress >= 100) curP = 100;
      else if (cur.progress > 0) curP = cur.progress;
      else if (cur.startedAt && cur.estMs) curP = Math.min(95, Math.round((Date.now() - cur.startedAt) / cur.estMs * 100));
      if (curP > 0 && curP < 100) cur.progress = curP; // 同步到队列行内进度条
    }
    progress.value = Math.max(3, Math.min(95, Math.round(((doneN + errN) + curP / 100) / total * 100)));
    if (!cur) stage.value = t('完成 ') + doneN + ' / ' + total + (errN ? t(' · 失败 ') + errN : '') + ' · ' + fmtTime(el);
  }, 500);

  while (true) {
    if (paused.value || cancelAll.value) break;
    const it = queue.find(i => i.status === 'pending');
    if (!it) break;
    it.status = 'running'; it.progress = 0; it.error = '';
    it.startedAt = Date.now();
    await decodeDuration(it);
    it.estMs = Math.max(5000, estSec() * 1000 || 60000);
    const jid = 'batch' + it.id;
    currentJobId.value = jid;
    logLine('→ ' + it.name);
    try {
      const cfg = collectParams();
      cfg.audio = it.path; cfg.id = jid; cfg.out = null; cfg.mode = mode.value; cfg.perf = perf.value;
      const res = await bridge.convert(cfg);
      if (cancelAll.value) it.status = 'canceled';
      else if (res && res.ok && res.out) {
        it.status = 'done'; it.progress = 100; it.out = res.out; it.note_count = res.note_count || 0;
        try {
          const bytes = await bridge.readBinary(res.out);
          if (bytes) { await importFiles([{ name: String(res.out).replace(/^.*[\\/]/, ''), bytes }]); }
        } catch (e) {}
      } else {
        it.status = 'error'; it.error = (res && res.error) || (res ? 'code ' + res.code : '');
        logLine(it.name + '：' + it.error, true);
      }
    } catch (e) {
      if (cancelAll.value) it.status = 'canceled';
      else { it.status = 'error'; it.error = (e && e.message) || String(e); logLine(it.name + '：' + it.error, true); }
    }
    currentJobId.value = null;
    saveQueue();
  }
  running.value = false; busy.value = false;
  clearInterval(trTimer);
  const dN = queue.filter(i => i.status === 'done').length;
  const eN = queue.filter(i => i.status === 'error').length;
  progress.value = dN && !eN ? 100 : (dN ? Math.round(dN / Math.max(1, queue.length) * 100) : progress.value);
  if (dN && !eN) {
    const last = queue.filter(i => i.status === 'done').pop();
    if (last) { lastOut.value = last.out; doneInfo.value = t('成功 ') + dN + t(' 首') + (last.note_count != null ? ' · ' + last.note_count + t(' 个音符') : ''); logLine(doneInfo.value); }
    done.value = true;
    toast('批量转录完成：成功 ' + dN + t(' 首（已完成曲目已加入歌单）'), 'ok');
  } else if (dN) {
    logLine(t('[失败] ') + eN + t(' 首失败，可在队列中点击「重试」。'), true);
    toast('批量转录完成：成功 ' + dN + t(' 首，失败 ') + eN + t(' 首'), 'warn');
  } else if (eN) {
    logLine(t('[失败] ') + eN + t(' 首失败，可在队列中点击「重试」。'), true);
    toast('转录失败', 'warn');
  }
  if (cancelAll.value && !paused.value) logLine(t('已取消转录队列…'), true);
}
async function startTranscribe() {
  if (busy.value) return;
  const est = estSec();
  const msg = t('确认开始转录？\n文件：') + queue.find(i => i.status === 'pending')?.name + t('\n模式：') + (MODE_NAMES[mode.value] || mode.value) + t('\n质量：') + (PERF_NAMES[perf.value] || perf.value) + (est ? t('\n预计耗时：约 ') + fmtTime(est) : '');
  const ok = await app.confirmDialog({ title: t('开始转录'), msg, okText: t('开始') });
  if (!ok) return;
  runBatch();
}
function cancelTranscribe() {
  if (!busy.value) return;
  cancelAll.value = true;
  if (currentJobId.value && bridge && bridge.cancel) bridge.cancel(currentJobId.value);
  logLine(t('已请求取消转录队列…'), true);
}
function openOutput() {
  if (!lastOut.value) return;
  if (bridge && bridge.openOutput) bridge.openOutput(lastOut.value);
  else toast('请使用桌面版打开输出文件夹', 'warn');
}

/* ---------------- 智能修正 ---------------- */
async function pickRfAudio() {
  if (bridge && bridge.pickAudio) { try { const p = await bridge.pickAudio(); if (p) rf.audio = p; } catch (e) {} }
  else toast('请使用桌面版 FuFumidi 选择音频', 'warn');
}
async function pickRfMidi() {
  if (bridge && bridge.pickFile) {
    try { const p = await bridge.pickFile({ filters: [{ name: 'MIDI', extensions: ['mid', 'midi', 'kar', 'rmi'] }] }); if (p) rf.midi = p; } catch (e) {}
  } else toast('请使用桌面版 FuFumidi 选择 MIDI', 'warn');
}
function rl(txt, isErr) {
  rf.logs.push({ txt, isErr: !!isErr });
  if (rf.logs.length > 500) rf.logs.splice(0, rf.logs.length - 500);
}
async function startRefine() {
  if (rf.busy) return;
  if (!rf.midi || !rf.audio) { toast('请先导入原音频与 MIDI 文件', 'warn'); return; }
  if (!bridge || !bridge.refine) { toast('请使用桌面版 FuFumidi 进行修正', 'warn'); return; }
  rf.busy = true; rf.jobId++; rf.progress = 0; rf.logs = [];
  rl(t('开始智能修正…（对齐起音 / 还原力度 / ') + (rf.mode === 'vocal' ? t('声部平衡') : t('清理杂音')) + '）');
  try {
    const res = await bridge.refine({ id: rf.jobId, audio: rf.audio, midi: rf.midi, mode: rf.mode, stemBalance: rf.stem });
    rf.progress = res.ok ? 100 : 0;
    if (res.ok && res.out) {
      const s = res.stats || {};
      rl(t('完成！起音吸附 ') + (s.onset_moved || 0) + t(' 个 · 尾音修正 ') + (s.offset_moved || 0) + ' · ' +
        (s.pitch_fixed ? t('音高修正 ') + s.pitch_fixed + ' · ' : '') +
        (s.micro_removed ? t('清理微音符 ') + s.micro_removed + ' · ' : '') +
        (s.lead_track ? t('主奏=[') + s.lead_track + '] · ' : '') +
        (s.vel_balanced ? t('力度调整 ') + s.vel_balanced + t(' 个音符 · ') : '') +
        t('输出 ') + (s.notes_out || '') + t(' 音符'));
      rf.midi = res.out;
      rf.info = t('输出 ') + String(res.out).replace(/^.*[\\/]/, '') + t(' · 耗时 ') + (s.elapsed_s != null ? s.elapsed_s + 's' : '');
      toast('智能修正完成', 'ok');
    } else {
      rl(t('[失败] 修正未成功：') + (res.error || t('请查看上方日志。')), true);
      toast('修正失败', 'warn');
    }
  } catch (e) {
    rl(t('[错误] ') + (e.message || String(e)), true);
    toast('修正失败', 'warn');
  } finally {
    rf.busy = false;
  }
}
async function openRefineResult() {
  try {
    const bytes = await bridge.readBinary(rf.midi);
    if (!bytes) { toast('修正输出文件不存在或已被删除', 'warn'); return; }
    await importFiles([{ name: String(rf.midi).replace(/^.*[\\/]/, ''), bytes }]);
    setView('edit');
    toast('已载入修正结果', 'ok');
  } catch (err) { toast('载入失败：' + err.message, 'warn'); }
}

/* ---------------- 引擎日志 ---------------- */
let offLog = null, offRefine = null, offModelProg = null;
onMounted(() => {
  loadQueue();
  loadPresets();
  loadTaskTemplates();
  loadPerfDefault();
  probeEngine();
  refreshModelStatus();
  if (bridge && bridge.onEngineLog) {
    offLog = bridge.onEngineLog(p => {
      if (!p) return;
      if (p.id === currentJobId.value || String(p.id).indexOf('batch') === 0) {
        if (p.line) { logLine(p.line); stage.value = String(p.line).slice(0, 80); }
      }
    });
  }
  if (bridge && bridge.onRefineLog) {
    offRefine = bridge.onRefineLog(p => { if (p && p.id === rf.jobId && p.line) rl(p.line); });
  }
  if (bridge && bridge.onModelProgress) {
    offModelProg = bridge.onModelProgress(p => { if (p && p.done) refreshModelStatus(); });
  }
});
onBeforeUnmount(() => {
  if (trTimer) clearInterval(trTimer);
  if (offLog) offLog();
  if (offRefine) offRefine();
  if (offModelProg) { try { offModelProg(); } catch (e) {} offModelProg = null; }
});
</script>

<template>
  <div class="page tr-view">
    <div class="page-head">
      <div class="page-ic"><Icon name="transcribe" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ t('转录') }}</div>
        <div class="page-sub">音频转 MIDI · 本地 Python 引擎 · 离线完成</div>
      </div>
      <span v-if="gpuInfo" class="tag accent">{{ gpuInfo }}</span>
      <button class="btn sm ghost" @click="state.ui.settingsTab = 'gpu'; state.ui.settingsOpen = true">GPU 加速</button>
      <span class="tag" :class="isDesktop ? '' : 'warn-tag'">{{ isDesktop ? t('桌面引擎就绪') : t('请使用桌面版') }}</span>
    </div>

    <!-- 音频选择 -->
    <div class="card tr-drop-card">
      <div class="tr-drop" :class="{ over: dropOver }" data-guide="audio-drop"
           @dragover.prevent="dropOver = true" @dragleave="dropOver = false" @drop.prevent="onDrop"
           @click="pickAudio">
        <div class="td-ic"><Icon name="transcribe" :size="26" /></div>
        <div class="td-txt">
          <b>{{ dropOver ? t('释放以上传') : t('拖入音频 / 点击选择') }}</b>
          <span>支持多选 · MP3 / WAV / FLAC / M4A / 视频</span>
        </div>
        <input ref="fileInput" type="file" accept="audio/*,video/*" hidden multiple @change="onFileChange">
      </div>
      <div v-if="audioInfo" class="tr-audio-info"><Icon name="music" :size="13" /> {{ audioInfo }}</div>
      <div ref="waveBox" class="tr-wave hidden"><canvas ref="waveEl" width="700" height="64"></canvas></div>
      <div class="tr-batch-head">
        <div>
          <div class="fb-label">转录队列</div>
          <div class="fb-hint">支持多选 / 文件夹 / 顺序转录 / 完成后加入歌单</div>
        </div>
        <div class="tr-batch-ctls">
          <button class="btn sm" @click="pickAudio"><Icon name="plus" :size="13" />{{ t('文件') }}</button>
          <button class="btn sm" @click="pickFolder"><Icon name="folder" :size="13" /> 文件夹</button>
          <button class="btn sm ghost" @click="retryAll">重试全部</button>
          <button class="btn sm ghost" @click="clearDone">清空完成</button>
          <select class="select-input" v-model="sort" style="width:auto;padding:4px 8px;font-size:11px">
            <option value="default">{{ t('默认顺序') }}</option><option value="name">{{ t('按名称') }}</option>
            <option value="type">{{ t('按类型') }}</option><option value="duration">{{ t('按时长') }}</option>
          </select>
          <button class="btn sm danger" @click="clearQueue">{{ t('清空') }}</button>
        </div>
      </div>
      <div v-if="queue.length" class="tr-batch-list">
        <div class="tr-batch-item" v-for="it in sortedQueue" :key="it.id">
          <span class="tb-name" :title="it.path">{{ it.name }}</span>
          <span class="tb-bar"><i :style="{ width: Math.round(it.progress || 0) + '%' }"></i></span>
          <span class="tb-badge" :class="it.status">{{ statusTxt(it.status) }}{{ it.status === 'done' && it.note_count ? ' · ' + it.note_count : '' }}</span>
          <button v-if="it.status === 'error'" class="btn sm ghost" @click="retryItem(it)">{{ t('重试') }}</button>
          <button v-else-if="it.status === 'pending' || it.status === 'done' || it.status === 'canceled'" class="btn sm ghost danger" @click="removeItem(it)">{{ t('移除') }}</button>
        </div>
      </div>
      <div class="tr-batch-stat muted small">{{ queueStat }}</div>
    </div>

    <!-- 引擎模式 -->
    <div class="card tr-card">
      <div class="fb-label">引擎模式</div>
      <div class="tr-modes">
        <button class="tr-mode" :class="{ active: mode === 'universal' }" data-guide="mode-universal" @click="onModeChange('universal')">
          <b>{{ t('通用识别') }}</b><span>任意歌曲 · 人声 · 多乐器</span>
        </button>
        <button class="tr-mode" :class="{ active: mode === 'piano' }" data-guide="mode-piano" @click="onModeChange('piano')">
          <b>{{ t('钢琴专用') }}</b><span>纯钢琴高精度 · 含踏板</span>
        </button>
        <button class="tr-mode" :class="{ active: mode === 'separate' }" data-guide="mode-separate" @click="onModeChange('separate')">
          <b>{{ t('人声分离') }}</b><span>分声部转录 · 需 Demucs</span>
        </button>
      </div>

      <!-- 通用子模型：Basic Pitch（兜底）/ MuScriptor（可选，三档规格） -->
      <div v-if="mode === 'universal'" class="tr-submodels">
        <div class="fb-label">{{ t('通用模型') }}</div>
        <div class="tr-pills">
          <button class="tr-pill" :class="{ active: umodel === 'basic' }" @click="umodel = 'basic'">{{ t('Basic Pitch · 内置兜底') }}<i v-if="modelInstalled('basic') !== null" class="ms-badge" :class="modelInstalled('basic') ? 'ok' : 'miss'">{{ modelInstalled('basic') ? t('已下载') : t('未下载') }}</i></button>
          <button class="tr-pill" :class="{ active: umodel === 'muscriptor' }" @click="umodel = 'muscriptor'">MuScriptor<i v-if="currentModelInstalled() !== null" class="ms-badge" :class="currentModelInstalled() ? 'ok' : 'miss'">{{ currentModelInstalled() ? t('已下载') : t('未下载') }}</i></button>
        </div>
        <div v-if="umodel === 'muscriptor'" class="tr-pills">
          <button class="tr-pill" :class="{ active: msSize === 'small' }" @click="msSize = 'small'">Small · 100M<i v-if="modelInstalled('muscriptor_small') !== null" class="ms-badge" :class="modelInstalled('muscriptor_small') ? 'ok' : 'miss'">{{ modelInstalled('muscriptor_small') ? t('已下载') : t('未下载') }}</i></button>
          <button class="tr-pill" :class="{ active: msSize === 'medium' }" @click="msSize = 'medium'">{{ t('Medium · 300M（推荐）') }}<i v-if="modelInstalled('muscriptor_medium') !== null" class="ms-badge" :class="modelInstalled('muscriptor_medium') ? 'ok' : 'miss'">{{ modelInstalled('muscriptor_medium') ? t('已下载') : t('未下载') }}</i></button>
          <button class="tr-pill" :class="{ active: msSize === 'large' }" @click="msSize = 'large'">Large · 1.3B<i v-if="modelInstalled('muscriptor_large') !== null" class="ms-badge" :class="modelInstalled('muscriptor_large') ? 'ok' : 'miss'">{{ modelInstalled('muscriptor_large') ? t('已下载') : t('未下载') }}</i></button>
        </div>
        <div class="tr-perf-hint" v-if="umodel === 'muscriptor'">{{ t('未下载时请到资源中心 → 模型文件 按规格下载') }}</div>
      </div>

      <!-- 钢琴子模型：piano-transcription / Aria-AMT / Transkun -->
      <div v-if="mode === 'piano'" class="tr-submodels">
        <div class="fb-label">{{ t('钢琴模型') }}</div>
        <div class="tr-pills">
          <button class="tr-pill" :class="{ active: pmodel === 'piano_pt' }" @click="pmodel = 'piano_pt'">{{ t('piano-transcription · 内置') }}<i v-if="modelInstalled('piano_pt') !== null" class="ms-badge" :class="modelInstalled('piano_pt') ? 'ok' : 'miss'">{{ modelInstalled('piano_pt') ? t('已下载') : t('未下载') }}</i></button>
          <button class="tr-pill" :class="{ active: pmodel === 'aria' }" @click="pmodel = 'aria'">Aria-AMT<i v-if="modelInstalled('aria_amt') !== null" class="ms-badge" :class="modelInstalled('aria_amt') ? 'ok' : 'miss'">{{ modelInstalled('aria_amt') ? t('已下载') : t('未下载') }}</i></button>
          <button class="tr-pill" :class="{ active: pmodel === 'transkun' }" @click="pmodel = 'transkun'">Transkun<i v-if="modelInstalled('transkun') !== null" class="ms-badge" :class="modelInstalled('transkun') ? 'ok' : 'miss'">{{ modelInstalled('transkun') ? t('已下载') : t('未下载') }}</i></button>
        </div>
        <div class="tr-perf-hint" v-if="pmodel !== 'piano_pt'">{{ t('Aria-AMT / Transkun 需先到资源中心安装对应模型') }}</div>
      </div>

      <div class="fb-label">性能模式</div>
      <div class="tr-pills">
        <button class="tr-pill" :class="{ active: perf === 'quality' }" @click="selectPerf('quality')">{{ t('最高质量') }}</button>
        <button class="tr-pill" :class="{ active: perf === 'balanced' }" @click="selectPerf('balanced')">{{ t('均衡') }}</button>
        <button class="tr-pill" :class="{ active: perf === 'fast' }" @click="selectPerf('fast')">{{ t('高性能') }}</button>
      </div>
      <div v-if="perfHint" class="tr-perf-hint">{{ perfHint }}</div>

      <details class="tr-adv" data-guide="adv-panel">
        <summary>高级参数<span class="adv-cnt">{{ t('阈值 · 踏板 · 降噪') }}</span><span class="adv-arr">▾</span></summary>
        <div class="tr-params">
          <div class="tr-slider">
            <label>起音阈值<b>{{ onset.toFixed(2) }}</b></label>
            <input type="range" min="0" max="1" step="0.01" v-model.number="onset">
          </div>
          <div class="tr-slider">
            <label>音符判定阈值<b>{{ frame.toFixed(2) }}</b></label>
            <input type="range" min="0" max="1" step="0.01" v-model.number="frame">
          </div>
          <div class="tr-slider">
            <label>最短音符<b>{{ minNote }}ms</b></label>
            <input type="range" min="10" max="300" step="1" v-model.number="minNote">
          </div>
          <div class="tr-slider" v-if="mode === 'piano'">
            <label>音符合并间隔<b>{{ mergeGap }}ms</b></label>
            <input type="range" min="0" max="200" step="1" v-model.number="mergeGap">
          </div>
          <div class="tr-switch" v-if="mode === 'piano'">
            <label><span><b>包含踏板事件</b><small>还原延音踏板</small></span><input type="checkbox" v-model="pedal"></label>
          </div>
          <div class="tr-switch" v-if="mode === 'separate'">
            <label><span><b>输出鼓组节奏轨</b><small>同时转录鼓点 / 打击乐节奏</small></span><input type="checkbox" v-model="drums"></label>
          </div>
          <div class="tr-switch" v-if="mode === 'separate'">
            <label><span><b>导出分离音频分轨</b><small>人声 / 贝斯 / 其它乐器 / 鼓</small></span>
              <span style="display:flex;align-items:center;gap:6px"><input type="checkbox" v-model="stemExport">
              <select v-if="stemExport" class="select-input" v-model="stemFormat" style="width:74px;padding:2px 6px;font-size:11px">
                <option value="wav">WAV</option><option value="flac">FLAC</option><option value="m4a">M4A</option>
              </select></span>
            </label>
          </div>
          <div class="tr-switch"><label><span><b>{{ t('智能降噪') }}</b><small>{{ t('降噪模式：谱减法') }}</small></span><input type="checkbox" v-model="denoise"></label></div>
          <div class="tr-switch"><label><span><b>{{ t('响度平衡') }}</b><small>{{ t('响度标准化（RMS）') }}</small></span><input type="checkbox" v-model="normalize"></label></div>
          <div class="tr-switch"><label><span><b>{{ t('自动检测 BPM') }}</b><small>{{ t('作为导出速度') }}</small></span><input type="checkbox" v-model="autoBpm"></label></div>

          <div class="tr-preset-row">
            <label class="fb-label" style="margin:0">参数预设</label>
            <div class="row" style="gap:6px">
              <select class="select-input" v-model="presetSel" :title="t('选择预设并应用')" style="min-width:138px">
                <option v-for="p in presets.list" :key="p.name" :value="p.name">{{ p.name }}{{ presets.builtins.includes(p.name) ? '' : ' ✎' }}</option>
              </select>
              <button class="btn sm" @click="presetSel && applyPreset(presetSel)">应用</button>
              <button class="btn sm" @click="savePreset"><Icon name="plus" :size="13" />{{ t('保存') }}</button>
              <button class="btn sm ghost danger" @click="delPreset"><Icon name="trash" :size="13" />{{ t('删除') }}</button>
              <button class="btn sm ghost" @click="openPresetMgr"><Icon name="menu" :size="13" /> 管理</button>
            </div>
          </div>
        </div>
      </details>

      <!-- 任务模板 -->
      <div class="tr-tpl-row">
        <div>
          <div class="fb-label">任务模板</div>
          <div class="fb-hint">保存当前转录+修正+导出流程</div>
        </div>
        <div class="row" style="gap:6px;flex-wrap:wrap">
          <input v-model="tplName" class="text-input" :placeholder="t('模板名')" style="width:110px;padding:5px 8px" />
          <button class="btn sm" @click="saveTemplate">保存模板</button>
          <select v-model="tplIdx" class="select-input" style="min-width:120px" @change="tplIdx >= 0 && applyTemplate(taskTemplates[tplIdx])">
            <option disabled :value="-1">选择模板</option>
            <option v-for="(t, i) in taskTemplates" :key="t.name" :value="i">{{ t.name }}</option>
          </select>
          <button class="btn sm ghost" @click="taskTemplates.length && delTemplate(taskTemplates.length - 1)">{{ t('删除') }}</button>
        </div>
      </div>
      <div v-if="taskTemplates.length" class="tr-tpl-preview muted small">{{ tplPreview(taskTemplates[taskTemplates.length - 1]) }}</div>

      <!-- 摘要 + 开始 -->
      <div v-if="queue.some(i => i.status === 'pending' || i.status === 'error')" class="tr-sum">
        即将转录：<b>{{ queue.find(i => i.status === 'pending' || i.status === 'error')?.name || '—' }}</b> · 引擎：<b>{{ MODE_NAMES[mode] }}</b> · 预计耗时：<b>{{ sumTime || '—' }}</b>
      </div>
      <button class="btn primary big" style="width:100%;justify-content:center;margin-top:14px" data-guide="start-transcribe" @click="startTranscribe" :disabled="busy || !isDesktop || !queue.length">
        <Icon name="transcribe" :size="16" />{{ busy ? t('转录中…') : t('开始转录') }}
      </button>
      <button v-if="busy" class="btn ghost" style="width:100%;justify-content:center;margin-top:8px" @click="cancelTranscribe"><Icon name="stop" :size="14" /> 取消转录</button>

      <div v-if="busy || done" class="tr-progress">
        <div class="pfill" :style="{ width: progress + '%' }"></div><span>{{ progress }}%</span>
      </div>
      <div v-if="stage" class="tr-stage muted small">{{ stage }}</div>
      <div v-if="done" class="tr-done">
        <button class="btn sm" @click="setView('play')"><Icon name="play2" :size="13" /> 打开播放</button>
        <button class="btn sm ghost" @click="openOutput"><Icon name="folder" :size="13" /> 打开输出文件夹</button>
        <span class="muted small">{{ doneInfo }}</span>
      </div>

      <!-- 运行日志 -->
      <div v-if="logs.length" class="tr-log">
        <div class="tr-log-head">
          <span class="log-title">{{ t('运行日志') }}</span><span class="log-count">{{ logs.length }} 行</span>
          <span style="flex:1"></span>
          <button class="icon-btn" :title="t('清空')" @click="clearLog"><Icon name="trash" :size="13" /></button>
          <button class="icon-btn" :title="t('展开/收起')" @click="logExpanded = !logExpanded"><Icon name="chevron" :size="13" /></button>
        </div>
        <div class="tr-log-scroll" :class="{ collapsed: !logExpanded }">
          <div v-for="(l, i) in logs" :key="i" :class="{ err: l.isErr }">{{ l.txt }}</div>
        </div>
      </div>
    </div>

    <!-- 智能修正 -->
    <div class="card tr-card" style="border-top:1px dashed var(--border)">
      <div class="fb-label" style="font-weight:700">智能修正</div>
      <div class="fb-hint">对齐起音 · 还原力度 · 声部平衡 · 清理杂音</div>
      <div class="tr-rf-row">
        <span class="muted small" style="min-width:44px">原音频</span>
        <button class="btn sm" @click="pickRfAudio"><Icon name="music" :size="13" /> 选择音频</button>
        <span class="muted small rf-path">{{ rf.audio ? rf.audio.replace(/^.*[\\/]/, '') : '—' }}</span>
      </div>
      <div class="tr-rf-row">
        <span class="muted small" style="min-width:44px">原 MIDI</span>
        <button class="btn sm" @click="pickRfMidi"><Icon name="kbd" :size="13" /> 选择 MIDI</button>
        <span class="muted small rf-path">{{ rf.midi ? rf.midi.replace(/^.*[\\/]/, '') : '—' }}</span>
      </div>
      <div class="fb-label">修正模式</div>
      <div class="tr-pills">
        <button class="tr-pill" :class="{ active: rf.mode === 'auto' }" @click="rf.mode = 'auto'">自动</button>
        <button class="tr-pill" :class="{ active: rf.mode === 'piano' }" @click="rf.mode = 'piano'">钢琴</button>
        <button class="tr-pill" :class="{ active: rf.mode === 'vocal' }" @click="rf.mode = 'vocal'">人声</button>
      </div>
      <div class="tr-switch" style="margin-top:8px">
        <label><span><b>{{ t('声部平衡') }}</b><small>抬主奏/人声 · 压配乐</small></span><input type="checkbox" v-model="rf.stem"></label>
      </div>
      <button class="btn primary big" style="width:100%;justify-content:center;margin-top:12px" @click="startRefine" :disabled="rf.busy || !rf.midi || !rf.audio">
        <Icon name="spark" :size="15" />{{ rf.busy ? t('修正中…') : t('开始智能修正') }}
      </button>
      <div v-if="rf.busy || rf.info" class="tr-progress">
        <div class="pfill" :style="{ width: (rf.busy ? 60 : 100) + '%' }"></div><span>{{ rf.busy ? '…' : t('完成') }}</span>
      </div>
      <div v-if="rf.info" class="tr-done">
        <button class="btn sm" @click="openRefineResult"><Icon name="play2" :size="13" /> 打开修正结果</button>
        <span class="muted small">{{ rf.info }}</span>
      </div>
      <div v-if="rf.logs.length" class="tr-log">
        <div class="tr-log-head"><span class="log-title">{{ t('修正日志') }}</span><span class="log-count">{{ rf.logs.length }} 行</span><span style="flex:1"></span><button class="icon-btn" @click="rf.logs = []"><Icon name="trash" :size="13" /></button></div>
        <div class="tr-log-scroll">
          <div v-for="(l, i) in rf.logs" :key="i" :class="{ err: l.isErr }">{{ l.txt }}</div>
        </div>
      </div>
    </div>

    <!-- 预设管理 -->
    <Transition name="ov">
      <div v-if="presetMgrOpen" class="preset-mgr-overlay" @click.self="presetMgrOpen = false">
      <div class="preset-mgr-card">
        <div class="preset-mgr-head">
          <b>参数预设管理</b>
          <button class="icon-btn" @click="presetMgrOpen = false" :title="t('关闭')"><Icon name="plus" :size="14" style="transform:rotate(45deg)" /></button>
        </div>
        <div class="preset-mgr-list">
          <div v-if="!presets.list.length" class="muted small" style="padding:16px">暂无预设</div>
          <div v-for="p in presets.list" :key="p.name" class="preset-mgr-row"
               draggable="true" @dragstart="presetDragStart(p)" @dragover.prevent @drop.prevent="presetDrop(p)" @dragend="presetDragName = ''">
            <span class="pm-handle" :title="t('拖动排序')">⋮⋮</span>
            <span class="pm-name" @click="mgrApply(p.name)" :title="t('点击应用')">{{ p.name }}</span>
            <span class="pm-mode">{{ p.mode }}</span>
            <button class="btn sm ghost danger" :title="t('删除')" @click="mgrDelete(p.name)">{{ t('删除') }}</button>
          </div>
        </div>
        <div class="preset-mgr-foot">
          <button class="btn sm" @click="mgrRestore">恢复全部内置</button>
          <span style="flex:1"></span>
          <button class="btn sm primary" @click="presetMgrOpen = false">{{ t('完成') }}</button>
        </div>
      </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.tr-view { max-width: 900px; padding: 18px 26px 40px; }
.warn-tag { color: var(--amber); border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.1); }
.tr-drop-card { padding: 16px; display: flex; flex-direction: column; gap: 10px; }
.tr-drop { display: flex; align-items: center; gap: 14px; padding: 22px; border: 1.5px dashed var(--border-strong); border-radius: 14px; background: var(--canvas); cursor: pointer; transition: border-color .15s, background .15s; }
.tr-drop:hover, .tr-drop.over { border-color: var(--brand-blue); background: var(--surface-soft); }
.td-ic { width: 46px; height: 46px; border-radius: 12px; background: var(--surface); display: flex; align-items: center; justify-content: center; color: var(--brand-blue); flex: none; }
.td-txt b { display: block; font-size: 13.5px; color: var(--ink); }
.td-txt span { font-size: 11.5px; color: var(--stone); }
.tr-audio-info { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--slate); }
.tr-wave { border: 1px solid var(--hairline); border-radius: 10px; overflow: hidden; background: var(--canvas); }
.tr-wave canvas { display: block; width: 100%; height: 64px; }
.tr-batch-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
.fb-label { font-size: 12.5px; font-weight: 600; color: var(--ink); }
.fb-hint { font-size: 11px; color: var(--stone); margin-top: 1px; }
.tr-batch-ctls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.tr-batch-list { border: 1px solid var(--hairline); border-radius: 10px; background: var(--canvas); overflow: hidden; }
.tr-batch-item { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--hairline-soft); font-size: 12px; }
.tr-batch-item:last-child { border-bottom: none; }
.tb-name { flex: 1; min-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.tb-bar { width: 120px; height: 6px; border-radius: 999px; background: var(--surface-soft); overflow: hidden; flex: none; }
.tb-bar i { display: block; height: 100%; background: var(--brand-blue); border-radius: 999px; transition: width .2s; }
.tb-badge { font-size: 10.5px; padding: 2px 8px; border-radius: 999px; background: var(--surface-soft); color: var(--stone); flex: none; }
.tb-badge.running { background: rgba(20,86,240,.1); color: var(--brand-blue); }
.tb-badge.done { background: var(--success-bg); color: var(--success-text); }
.tb-badge.error { background: rgba(212,86,86,.1); color: var(--error); }
.tb-badge.canceled { color: var(--muted); }
.tr-batch-stat { margin-top: 6px; }
.tr-card { padding: 18px 20px; display: flex; flex-direction: column; gap: 12px; margin-top: 14px; }
.tr-modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.tr-mode { border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; background: var(--surface); text-align: left; cursor: pointer; transition: all .15s; }
.tr-mode b { display: block; font-size: 13px; color: var(--ink); margin-bottom: 2px; }
.tr-mode span { font-size: 11px; color: var(--stone); line-height: 1.4; }
.tr-mode:hover { border-color: var(--border-strong); }
.tr-mode.active { border-color: var(--ink); background: var(--canvas); box-shadow: 0 0 0 1px var(--ink); }
.tr-mode.active b { color: var(--brand-coral); }
.tr-pills { display: flex; gap: 6px; flex-wrap: wrap; }
.tr-pill { padding: 5px 14px; border-radius: 999px; border: 1px solid var(--border); background: var(--surface); font-size: 12px; color: var(--slate); cursor: pointer; display: inline-flex; align-items: center; gap: 6px; }
.tr-pill:hover { border-color: var(--border-strong); }
.tr-pill.active { background: var(--accent); border-color: var(--accent); color: #fff; }
.tr-pill .ms-badge { font-style: normal; font-size: 10px; line-height: 14px; height: 15px; padding: 0 6px; border-radius: 999px; }
.tr-pill .ms-badge.ok { background: rgba(72, 187, 120, 0.16); color: #48bb78; }
.tr-pill .ms-badge.miss { background: rgba(212, 86, 86, 0.16); color: #e06c6c; }
.tr-pill.active .ms-badge.ok, .tr-pill.active .ms-badge.miss { background: rgba(255,255,255,0.2); color: #fff; }
.tr-submodels { margin-top: 10px; padding: 10px 12px; border: 1px dashed var(--hairline); border-radius: 10px; background: var(--surface-soft); }
.tr-submodels .fb-label { margin-bottom: 8px; }
.tr-perf-hint { font-size: 11.5px; color: var(--success-text); }
.tr-adv { border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface); }
.tr-adv summary { display: flex; align-items: center; gap: 8px; padding: 10px 14px; font-size: 12.5px; font-weight: 600; color: var(--ink); cursor: pointer; user-select: none; }
.tr-adv summary .adv-cnt { font-weight: 400; color: var(--stone); font-size: 11px; }
.tr-adv summary .adv-arr { margin-left: auto; color: var(--stone); }
.tr-params { padding: 4px 14px 14px; display: flex; flex-direction: column; gap: 10px; }
.tr-slider label { display: flex; justify-content: space-between; font-size: 12px; color: var(--slate); margin-bottom: 2px; }
.tr-slider label b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.tr-slider input[type=range] { width: 100%; accent-color: var(--ink); }
.tr-switch label { display: flex; align-items: center; justify-content: space-between; font-size: 12px; color: var(--slate); }
.tr-switch b { display: block; color: var(--ink); font-weight: 600; }
.tr-switch small { color: var(--stone); font-size: 10.5px; }
.tr-switch input[type=checkbox] { accent-color: var(--ink); }
.tr-preset-row { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--hairline); }
.tr-tpl-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 4px; }
.tr-tpl-preview { margin-top: 4px; }
.tr-sum { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; background: var(--surface-soft); border-radius: 10px; padding: 10px 14px; font-size: 12px; color: var(--slate); }
.tr-sum b { color: var(--ink); font-weight: 600; }
.tr-progress { position: relative; display: flex; align-items: center; justify-content: flex-end; height: 20px; background: var(--surface-soft); border-radius: 999px; overflow: hidden; margin-top: 8px; }
.tr-progress .pfill { position: absolute; left: 0; top: 0; bottom: 0; width: 0; background: var(--ink); border-radius: 999px; transition: width .2s; }
.tr-progress span { position: relative; z-index: 1; padding: 0 12px; font-size: 11px; color: var(--steel); }
.tr-stage { margin-top: 4px; text-align: center; }
.tr-done { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.tr-log { border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface); margin-top: 10px; overflow: hidden; }
.tr-log-head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; font-size: 11px; color: var(--slate); border-bottom: 1px solid var(--hairline-soft); }
.log-count { color: var(--stone); }
.tr-log-scroll { max-height: 220px; overflow-y: auto; padding: 8px 12px; font-family: var(--mono); font-size: 11px; color: var(--slate); line-height: 1.6; }
.tr-log-scroll.collapsed { max-height: 60px; }
.tr-log-scroll .err { color: var(--error); }
.tr-rf-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.rf-path { max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
.preset-mgr-overlay { position: fixed; inset: 0; z-index: 120; background: rgba(0,0,0,0.35); display: flex; align-items: center; justify-content: center; padding: 24px; }
.preset-mgr-card { width: 560px; max-width: 94vw; max-height: 82vh; background: var(--canvas); border: 1px solid var(--hairline); border-radius: 16px; box-shadow: var(--shadow-lg); display: flex; flex-direction: column; overflow: hidden; }
.preset-mgr-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--hairline); color: var(--ink); font-size: 14px; }
.preset-mgr-list { flex: 1; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: 6px; }
.preset-mgr-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--hairline); border-radius: 10px; background: var(--surface); }
.pm-handle { color: var(--stone); cursor: grab; user-select: none; flex: none; }
.pm-name { flex: 1; cursor: pointer; color: var(--ink); font-weight: 600; }
.pm-mode { font-size: 11px; color: var(--stone); background: var(--surface-soft); padding: 2px 8px; border-radius: 99px; }
.preset-mgr-foot { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--hairline); }
</style>
