<script setup>
import { themeColor } from '../core/palette.js';
// 转录视图：音频 → MIDI（本地 Python 引擎，桌面端通过 fuBridge 桥接）
import { ref, reactive, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import Icon from '../components/Icon.vue';
import { useAppStore } from '../stores/app';
import { usePlaylistStore } from '../stores/playlist';
import { clamp, esc, fmtTime } from '../core/util.js';
import { t } from '../core/i18n.js';
import NumSlider from '../components/NumSlider.vue';

const app = useAppStore();
const playlist = usePlaylistStore();
const toast = (m, t) => app.toast(m, t);
// 转录结果属于后台产物：正在播放时只入库，不抢切当前曲目（避免打断播放）
// target：队列指定的歌单 id | 'all'（只进全部曲目）| undefined（跟随当前歌单）
const importFiles = (items, target) => app.importFiles(items, target, { keepPlaying: true });
const setView = (v) => app.setView(v);

const bridge = window.fuBridge;
const isDesktop = !!(bridge && bridge.convert);

/* ---------------- 状态 ---------------- */
const mode = ref('universal');           // universal | piano | separate
const umodel = ref('basic');             // 通用子模型：basic | muscriptor
const msSize = ref('medium');            // MuScriptor 规格：small | medium | large
const pmodel = ref('piano_pt');          // 钢琴子模型：piano_pt | aria | transkun | hft
/* ★ Aria-AMT 需要 CUDA（2026-10-17 用户：「Aria-AMT 在转录页标注需要 CUDA」）。
   实测：没有 CUDA 时它直接抛 AssertionError: CUDA device not found，而界面只说「未下载」，
   用户会以为是模型没装。这里把"要不要 CUDA"和"当前有没有 CUDA"都摆到台面上。 */
const cudaReady = ref(false);
void (async () => {
  try {
    const b = window.fuBridge;
    if (b && typeof b.gpuStatus === 'function') {
      const st = await b.gpuStatus();
      cudaReady.value = !!(st && (st.cudaActive || st.cuda));
    }
  } catch (e) { /* 取不到就当没有，提示会显示出来，不会误报可用 */ }
})();
const perf = ref('quality');             // quality | balanced | fast
const perfHint = ref('');
/* 识别片段长度（秒）：每种模型一次喂给模型识别的音频长度。
   0 = 跟随模型默认（各模型默认不同：basic-pitch 内置窗约 2s、MuScriptor 5s、
   piano-transcription 10s、Aria-AMT 30s、Transkun 由模型配置决定）。 */
const segmentSec = ref(0);
/* 转录前降噪：默认 off（保持旧输出完全一致）。选项来自引擎 audio_chain：
   off / light（谱减）/ strong（UVR-DeNoise 模型，需资源中心下载）。
   2026-10-15 实测降噪在部分素材会增加噪声引起的假音符，所以默认关、并写明代价。 */
const denoiseMode = ref('off');
/* 显存策略（硬件相关，存 localStorage，不进参数预设）：
   auto=默认；low=低显存自动降批（推荐，避免驱动共享内存溢出慢 5–10×）；
   allow=允许驱动借用系统内存（能跑完但可能明显变慢）。 */
const memoryMode = ref(localStorage.getItem('fufumidi_memory_mode') || 'auto');
function setMemoryMode(v) {
  memoryMode.value = ['auto', 'low', 'allow'].includes(v) ? v : 'auto';
  try { localStorage.setItem('fufumidi_memory_mode', memoryMode.value); } catch (e) {}
}
/** 各模型推荐片段长度（= 训练块长；见各引擎源码/配置） */
const SEG_RECOMMEND = computed(() => {
  if (mode.value === 'universal') return umodel.value === 'basic' ? 0 : 5;
  if (pmodel.value === 'aria') return 30;
  if (pmodel.value === 'transkun') return 16;
  if (pmodel.value === 'hft') return 0;
  return 10;
});
const bassBoost = ref(false);            // 低音增强（仅 basic 子模型）：关闭 melodia trick 以保留低音声部
// 多条弯音曲线（仅 basic 子模型）：basic-pitch 唯一没转发的用户可见参数。
// 开了以后同一音符可以挂多条弯音（颤音/滑音），**会真的落进导出的 MIDI**。
// 默认关 —— 对钢琴/鼓这类素材它只会让 MIDI 多出大量无用事件。
const pitchBends = ref(false);
// 节拍网格检测（仅 MuScriptor）。★ 2026-10-14：**装了 beat_this 模型就默认开**
// （用户要求）。仍然可以在界面上关掉 —— 手动改过之后不再被默认值覆盖。
// 未下载 / 加载失败时引擎侧会自动跳过，不阻断转录。
const beatGrid = ref(false);
let beatGridUserSet = false;             // 用户是否手动改过（改过就不再用默认值覆盖）
// ④ 批 A：引擎早就有、界面一直没入口的模型选项。默认值一律保持「原来的行为」，
// 所以不碰这些控件时输出与旧版一致（质量相关的开关默认关，见计划文档 §6）。
const maxFreq = ref(0);                  // 最高音高 Hz（仅 basic，0 = 不限制）：滤掉高频噪声/镲片串音
const minFreq = ref(0);                  // 最低音高 Hz（仅 basic，0 = 不限制）：滤掉低频隆隆声/次声
                                         // ★ 2026-10-14：从「低音增强」里独立出来。用户决定**显式控件优先** ——
                                         //   勾「低音增强」只设 no_melodia（不再顺带把 min_freq 钉成 40）。
const exportTempo = ref(0);              // 导出 BPM（0 = 用引擎默认 120 / 自动 BPM 优先）
// ④ 批 B：MuScriptor 生成参数。默认全部保持「不传」—— 不传时上游走贪婪解码，
// 结果可复现；调了 temperature / cfg_coef 才自动开采样（采样关着时这两个值是空转）。
const msTemp = ref(1.0);                 // 采样温度（1.0 = 不传）
const msCfg = ref(1.0);                  // 引导系数（1.0 = 不传）
const msBeam = ref(1);                   // 束搜索宽度（1 = 不传）
const msPrelude = ref(true);             // 跨块延音缝合（默认开；关掉才传 false＝不缝合）
// MuScriptor 乐器组：none=不限定（默认）；limit=手动硬约束；probe_segments=按段自动探测并约束
const msMode = ref('none');
const msGroups = ref(['voice', 'drums']);
const msProbeSegSec = ref(60);
function toggleMsGroup(id) {
  const i = msGroups.value.indexOf(id);
  if (i >= 0) { if (msGroups.value.length > 1) msGroups.value.splice(i, 1); return; }
  msGroups.value.push(id);
}
const MS_GROUPS = [
  { id: 'voice', cn: '人声' }, { id: 'acoustic_piano', cn: '钢琴' }, { id: 'electric_piano', cn: '电钢琴' },
  { id: 'acoustic_guitar', cn: '原声吉他' }, { id: 'clean_electric_guitar', cn: '清音电吉他' },
  { id: 'distorted_electric_guitar', cn: '失真电吉他' }, { id: 'electric_bass', cn: '电贝斯' },
  { id: 'acoustic_bass', cn: '原声贝斯' }, { id: 'string_ensemble', cn: '弦乐组' }, { id: 'violin', cn: '小提琴' },
  { id: 'viola', cn: '中提琴' }, { id: 'cello', cn: '大提琴' }, { id: 'contrabass', cn: '低音提琴' },
  { id: 'orchestral_harp', cn: '管弦竖琴' }, { id: 'flutes', cn: '长笛' }, { id: 'organ', cn: '风琴' },
  { id: 'synth_lead', cn: '合成主音' }, { id: 'synth_pad', cn: '合成铺底' }, { id: 'synth_strings', cn: '合成弦乐' },
  { id: 'brass_section', cn: '铜管组' }, { id: 'trumpet', cn: '小号' }, { id: 'trombone', cn: '长号' },
  { id: 'tuba', cn: '大号' }, { id: 'french_horn', cn: '圆号' }, { id: 'soprano_and_alto_sax', cn: '萨克斯' },
  { id: 'tenor_sax', cn: '次中音萨克斯' }, { id: 'baritone_sax', cn: '上低音萨克斯' }, { id: 'oboe', cn: '双簧管' },
  { id: 'english_horn', cn: '英国管' }, { id: 'clarinet', cn: '单簧管' }, { id: 'bassoon', cn: '巴松管' },
  { id: 'drums', cn: '鼓' }, { id: 'timpani', cn: '定音鼓' }, { id: 'chromatic_percussion', cn: '色彩打击乐' },
  { id: 'orchestra_hit', cn: '管弦齐奏' },
];
const msInstrValue = computed(() => {
  if (msMode.value === 'limit') return msGroups.value.join(',');
  if (msMode.value === 'probe_segments') return 'probe_segments';
  return 'none';
});
// ② 计算精度：默认 fp32（不传）—— bf16 改数值精度、属影响质量的开关，默认关。
// 实测：CPU（Zen 5/AVX512-BF16）10 分钟素材待复测、15 秒素材 +43%；GPU 上 ≈0%；
// 长素材（10 分钟/120 块）质量逐项相同，误差不累积。
const msPrec = ref('fp32');
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
const gpuDetail = ref('');          // 驱动版本 / 共享显存回退支持（P2 驱动检测）
const umBusy = ref(false);
const umResult = ref('');          // CUDA 统一内存实验输出（P2 实验，不改变转录）

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
      // 音频处理可选模型（分离 + 修复·VR）：kind 为 separate（人声分离）或 other（修复·VR）均可选用
      const sepArr = (arr || []).filter(m => m.kind === 'separate' || m.kind === 'other').map(m => ({ ...m }));
      sepModels.value = sepArr;
      if (!sepArr.some(m => m.id === sepModel.value)) {
        sepModel.value = (sepArr.find(m => m.exists) || sepArr[0] || {}).id || '';
      }
      if (sepModel.value) applyMsPresetForModel(sepModel.value);
      // ★ 节拍网格：模型装了（beat_this = true）就默认勾上；
      //   用户手动关过则尊重用户的选择。modelInstalled 返回 null 表示「未知」，
      //   那种情况**不动** —— 别把默认值建立在一个没查清的状态上。
      if (!beatGridUserSet && modelInstalled('beat_this') === true) beatGrid.value = true;
    }
  } catch (e) {}
}
function modelInstalled(key) {
  // 返回 true（已就绪）/ false（未下载）/ null（未知）
  return modelStatus[key] === true || modelStatus[key] === false ? modelStatus[key] : null;
}
// 当前激活模型的可读名称（供日志标注）
function currentModelLabel() {
  if (mode.value === 'separate') return t('HTDemucs 人声分离');
  if (mode.value === 'universal') {
    if (umodel.value === 'muscriptor') return 'MuScriptor ' + msSize.value.toUpperCase();
    if (umodel.value === 'yourmt3') return 'YourMT3+';
    if (umodel.value === 'miros') return 'MIROS';
    return 'Basic Pitch';
  }
  // piano
  if (pmodel.value === 'hft') return 'hFT-Transformer';
  if (pmodel.value === 'piano_pt') return 'piano-transcription';
  return pmodel.value === 'aria' ? 'Aria-AMT' : 'Transkun';
}
function currentModelInstalled() {
  const key = mode.value === 'separate' ? 'demucs_htdemucs'
    : mode.value === 'universal'
      ? (umodel.value === 'muscriptor' ? 'muscriptor_' + msSize.value
        : umodel.value === 'yourmt3' ? 'yourmt3'
          : umodel.value === 'miros' ? 'miros' : 'basic')
      : (pmodel.value === 'aria' ? 'aria_amt' : pmodel.value === 'piano_pt' ? 'piano_pt'
        : pmodel.value === 'hft' ? 'hft_transformer' : 'transkun');
  const st = modelInstalled(key);
  return st; // true / false / null
}

const drumtoast = false;
const sepModel = ref('demucs_htdemucs');           // 音频处理模型 id
const sepModels = ref([]);                          // 可选模型列表（含介绍/安装态）
const sepPickerOpen = ref(false);                   // 模型选择抽屉
const currentSep = computed(() => sepModels.value.find(m => m.id === sepModel.value));
function sepKindIcon(m) { return (m && m.id !== 'demucs_htdemucs') ? 'mic' : 'music'; }
// ★ 别复用 '修复·VR' —— 那个 key 在 i18n 里是「恢复默认」按钮的文案
//   （EN 译成 "Repair · Restore defaults"），用在这里英文/日文都是错的。凡「模型类别」一律走下面两条。
// 分类按**用途**判，不按 manifest 分类：vr 分类里既有 UVR-DeNoise（修复）也有 1_HP-UVR（人声分离），
// 全塞进一个标签下用户找不到东西；名字本身是可靠的判据（模型名都写明 Denoise / De-Echo / DeReverb）。
function sepPurposeOf(m) {
  const s = String((m && m.name) || '') + ' ' + String((m && m.id) || '');
  return /denoise|de-?echo|dereverb|noise/i.test(s) ? 'repair' : 'separate';
}
function sepKindName(m) { return sepPurposeOf(m) === 'repair' ? t('修复 · 去噪') : t('人声分离'); }
/* ---------------- 模型选择抽屉：搜索 + 分类 + 只看已下载 ---------------- */
// 模型目录里 vocal / multi / single / vr 全列出来有几十条，单列长列表滚半天才找到目标。
const sepQuery = ref('');
const sepCat = ref('all');            // all | separate（人声分离） | other（修复 · 去噪）
// ★ 默认**只显示可用**：仓库里 50 个模型没有任何 .yaml，下完也加载不了；
//   默认把它们摆出来，用户就会照着我给的「去噪用音频处理」提示下一个跑不动的模型。
const sepOnlyReady = ref(true);
function sepCatOf(m) { return sepPurposeOf(m); }
const sepModelsFiltered = computed(() => {
  const q = sepQuery.value.trim().toLowerCase();
  return sepModels.value.filter((m) => {
    if (sepCat.value !== 'all' && sepCatOf(m) !== sepCat.value) return false;
    // 「只显示可用」= 已下载 **且** 能真跑起来（缺配置的排除掉）
    if (sepOnlyReady.value && !(m.exists && m.sepReady !== false)) return false;
    if (!q) return true;
    return [m.name, m.arch, m.use, m.note, m.id].some((v) => String(v || '').toLowerCase().includes(q));
  });
});
const sepCatCounts = computed(() => {
  const c = { all: sepModels.value.length, separate: 0, repair: 0 };
  for (const m of sepModels.value) c[sepCatOf(m)]++;
  return c;
});
// VR / UVR 去噪模型的音轨名来自权重本身（pymss 的 primary/secondary_stem，通常「Noise / No No Noise」），
// 不是人声/伴奏那一套 —— 面板上别再摆出「人声 / 伴奏」让用户以为能选。
const sepIsVr = computed(() => /(^|[^a-z])(vr|uvr)/i.test(String((currentSep.value && currentSep.value.arch) || '')));
function onDocKeydown(e) { if (e && e.key === 'Escape' && sepPickerOpen.value) sepPickerOpen.value = false; }
function pickSep(m) {
  if (!m) return;
  if (!m.exists) { toast(t('该模型未下载，请先到') + t('模型管理') + t('下载'), 'warn'); return; }
  // 已下载但跑不动（缺 .yaml 配置）的模型：在这里拦住并说清原因，
  // 不要等用户点了「开始分离」才在引擎里炸「该模型缺少配置文件」。
  if (m.sepReady === false) {
    const why = String(m.sepWhy || '');
    toast(t('该模型暂时不可用：') + (why.indexOf('配置') >= 0 ? t('缺少配置文件（本机没有它的 .yaml，下载后也加载不了）') : t('未下载')), 'warn');
    return;
  }
  sepModel.value = m.id;
  msStems.value = [];      // 空 = 输出该模型全部音轨
  applyMsPresetForModel(m.id);
  sepPickerOpen.value = false;
}
function fmtSize2(b) {
  if (!b) return '—';
  if (b >= 1e9) return (b / 1e9).toFixed(2) + ' GB';
  if (b >= 1e6) return (b / 1e6).toFixed(0) + ' MB';
  return (b / 1024).toFixed(0) + ' KB';
}
const onset = ref(0.5);
const frame = ref(0.3);

/* ---------------- 音频处理（MSST 分离）面板 ---------------- */
const sepFile = ref('');              // 待分离音频
const sepDur = ref(0);                // 待分离音频时长(s)
const sepBusy = ref(false);
const sepProgress = ref(0);
const sepStage = ref('');
const sepStartAt = ref(0);
const sepOutputs = ref([]);
const sepOutDir = ref('');
const sepLogs = ref([]);
const sepJobId = ref(0);
const sepCanceled = ref(false);        // 用户点了「取消分离」——结束时要说"已取消"，不许报"失败"
const advOpen = ref(false);            // 高级参数是否展开（原来是 <details>，为了能动画改成受控）

/* ---------------- 模式切换：方向 + 整页高度过渡 ----------------
   为什么还要管"整页高度"：三种模式的内容高度差好几百像素（音频处理比通用识别矮 ~360px，
   展开高级参数时差得更多）。只做淡入淡出的话，新内容一挂上整页会"咯噔"跳一下 —— 那正是
   "切换太突兀"的来源。做法是经典的 FLIP：切之前把整页高度钉在旧值，等新内容挂上后量出新高度，
   再用 height 的 transition 平滑滑过去；期间 overflow: hidden 把溢出裁掉。 */
const pageEl = ref(null);
const MODE_ORDER = ['universal', 'piano', 'separate'];
const swapDir = ref('fwd');            // fwd=往后切（右侧进） / back=往回切（左侧进）
let _flipToken = 0;
let _flipH0 = 0;
let _flipSafety = 0;

function _clearFlip() {
  const el = pageEl.value;
  if (!el) return;
  el.style.transition = '';
  el.style.height = '';
  el.style.overflow = '';
}

watch(mode, (nv, ov) => {
  swapDir.value = MODE_ORDER.indexOf(nv) >= MODE_ORDER.indexOf(ov) ? 'fwd' : 'back';
  const el = pageEl.value;
  if (!el) return;
  const token = ++_flipToken;
  _flipH0 = el.offsetHeight;
  el.style.overflow = 'hidden';
  el.style.height = _flipH0 + 'px';
  // 安全网：万一 Transition 没跑（没有动画/被跳过），900ms 后一定要把内联样式清掉
  window.clearTimeout(_flipSafety);
  _flipSafety = window.setTimeout(() => { if (token === _flipToken) _clearFlip(); }, 900);
});

/* ★ 时机要用 Transition 的事件，不能靠"等 150ms"猜：out-in 里如果离场还没结束，
   pageEl.scrollHeight 量到的仍是旧内容的高度（实测会误判成"高度没变"而直接跳变）。 */
async function onSwapLeft() {
  const el = pageEl.value;
  if (!el) return;
  const token = _flipToken;
  await nextTick();                          // 这一刻新内容刚挂上
  if (token !== _flipToken || !el.isConnected) return;
  // ★ 量"内容自然高度"不能用 scrollHeight：高度被钉在旧值上时，scrollHeight 取的是
  //   max(内容, 已钉高度) —— 变矮的情况会量到旧值，于是误判成"高度没变"而直接跳变（实测）。
  //   先临时 height:auto 量一次再钉回去，中间是同步的、不会闪。
  el.style.height = 'auto';
  const h1 = el.offsetHeight;
  el.style.height = _flipH0 + 'px';
  if (Math.abs(h1 - _flipH0) < 2) { _clearFlip(); return; }
  void el.offsetHeight;                      // 强制回流：让下面的 transition 从 _flipH0 起跑
  el.style.transition = 'height .34s cubic-bezier(.22,.7,.28,1)';
  el.style.height = h1 + 'px';
  window.setTimeout(() => { if (token === _flipToken) _clearFlip(); }, 400);
}
// MSST 推理参数（无预设体系，逐项独立）
const msChunk = ref(926100);          // 分块大小（样本数，建议 44100 整数倍）
const msOverlap = ref(4);             // 重叠数 N → step = chunk // N
const msBatch = ref(2);               // 批次大小
const msNormalize = ref(true);        // 音频归一化
const msTta = ref(false);             // 启用 TTA
const msFormat = ref('wav');          // wav / flac / mp3
const msStems = ref([]);              // 勾选的输出音轨（空=全部）
const chunkSec = computed({
  get: () => Math.max(1, Math.round(msChunk.value / 44100)),
  set: v => { msChunk.value = Math.max(1, Math.round(v || 1)) * 44100; },
});

// ★ 模块作用域里的 t() 会被冻结在启动语言上（语言切换只重渲染，不重跑模块）。
//   这类表一律写成函数，渲染时求值 —— 下同（MODE_NAMES / PERF_NAMES / WEB_BUILTIN_PRESETS）。
const SEP_STEM_LABELS = () => ({ vocals: t('人声'), other: t('伴奏'), drums: t('鼓组'), bass: t('贝斯'), guitar: t('吉他'), piano: t('钢琴') });
function sepStemLabel(s) { return SEP_STEM_LABELS()[s] || s; }
function sepArchStems(arch) {
  const a = String(arch || '').toLowerCase();
  if (a.includes('drumsep')) return ['drums', 'other'];
  if (a.includes('htdemucs') || a.includes('demucs')) return ['drums', 'bass', 'other', 'vocals'];
  return ['vocals', 'other'];
}
const msStemOptions = computed(() => sepIsVr.value ? [] : sepArchStems(currentSep.value && currentSep.value.arch));
function toggleStem(s) { const i = msStems.value.indexOf(s); if (i >= 0) msStems.value.splice(i, 1); else msStems.value.push(s); }
function allStems() { msStems.value = msStemOptions.value.slice(); }
function logSep(txt, isErr) { sepLogs.value.push({ txt, isErr: !!isErr }); if (sepLogs.value.length > 200) sepLogs.value.splice(0, sepLogs.value.length - 200); }
async function pickSepFile() {
  if (bridge && bridge.pickAudio) { try { const p = await bridge.pickAudio(); if (p) { sepFile.value = p; sepDur.value = 0; decodeSepDur(p); } } catch (e) {} }
  else toast(t('请使用桌面版 FuFumidi 选择音频'), 'warn');
}
async function decodeSepDur(p) {
  // ★ 先问主进程（ffmpeg 读头信息，毫秒级、不占内存）。以前无条件 readBinary + decodeAudioData：
  //   1.4 GB 的演唱会 flac 会把整文件读进渲染进程再解码，界面直接假死（长音频分离必踩）。
  try {
    if (bridge && bridge.audioDuration) {
      const r = await bridge.audioDuration(p);
      if (r && r.ok && r.seconds > 0) { sepDur.value = r.seconds; return; }
    }
  } catch (e) {}
  // 兜底：只有拿不到时长的小文件才走解码（>48MB 直接放弃，别把内存撑爆）
  try {
    const buf = await bridge.readBinary(p); if (!buf) return;
    if (buf.length > 48 * 1024 * 1024) return;
    const AC = window.AudioContext || window.webkitAudioContext; const actx = new AC();
    await new Promise(res => { try { actx.decodeAudioData(buf.slice(0), ab => { sepDur.value = ab.duration || 0; res(); }, () => res()); } catch (e) { res(); } });
    if (actx.close) actx.close();
  } catch (e) {}
}
// 长音频（预计 > 30 分钟）要提前说清楚：主进程已放宽超时（无进展 20 分钟才判卡死），
// 不然用户会以为程序挂了（2026-10-17 实测：演唱会 FLAC 被判「引擎执行超时」）。
const sepLong = computed(() => { const s = sepEstSec(); return !!s && s > 30 * 60; });
// 单轨降噪模型（denoise_*，training.target_instrument 非空）不是分离模型：输出≈原音，先说明白
const sepIsDenoise = computed(() => /^denoise[_-]/i.test(String(sepModel.value || '')));
function sepEstSec() {
  if (!sepDur.value) return null;
  const isGpu = !!gpuInfo.value;
  let rtf = isGpu ? 1.5 : 10;   // GPU(如 5060)≈0.65x 实时；CPU 兜底较大
  if (currentSep.value && /scnet|htdemucs|mdx23c|apollo/i.test(currentSep.value.arch || '')) rtf = isGpu ? 1.2 : 6;
  if (msTta.value) rtf *= 3;
  return sepDur.value * rtf;
}
async function runSeparate() {
  if (!isDesktop || !bridge.separateAudio) { toast(t('请使用桌面版 FuFumidi 进行分离'), 'warn'); return; }
  if (!sepFile.value) { toast(t('请先选择要分离的音频'), 'warn'); return; }
  if (!currentSep.value || !currentSep.value.exists) { toast(t('请先选择/下载处理模型'), 'warn'); return; }
  if (msChunk.value < 44100) { toast(t('分块大小 chunk_size 至少 44100'), 'warn'); return; }
  sepBusy.value = true; sepCanceled.value = false; sepProgress.value = 0; sepLogs.value = []; sepOutputs.value = []; sepOutDir.value = ''; sepStage.value = '';
  sepStartAt.value = Date.now(); sepJobId.value++;
  const stems = msStems.value.length ? msStems.value.slice() : null;
  const cfg = { id: 'sep' + sepJobId.value, audio: sepFile.value, sep_model: sepModel.value,
    chunk_size: msChunk.value, num_overlap: msOverlap.value, batch_size: msBatch.value,
    normalize: msNormalize.value, tta: msTta.value, format: msFormat.value, stems };
  try {
    const res = await bridge.separateAudio(cfg);
    if (res && res.ok) {
      sepOutputs.value = res.outputs || []; sepOutDir.value = res.out_dir || ''; sepProgress.value = 100; sepStage.value = t('分离完成');
      toast(t('分离完成，共 ') + (res.outputs || []).length + t(' 个音轨'), 'ok');
    } else if (sepCanceled.value) {
      // 取消**不是**失败：引擎被杀掉后 onDone 会带非 0 code 回来，别把"已取消"报成"失败"
      sepStage.value = t('已取消'); toast(t('已取消分离'), 'ok');
    } else {
      const msg = (res && res.error) || t('分离失败');
      sepStage.value = t('失败'); logSep(msg, true); toast(msg, 'warn');
    }
  } catch (e) {
    if (sepCanceled.value) { sepStage.value = t('已取消'); toast(t('已取消分离'), 'ok'); return; }
    const msg = (e && e.message) || String(e); sepStage.value = t('失败'); logSep(msg, true); toast(t('分离失败：') + msg, 'warn');
  }
  finally { sepBusy.value = false; }
}
function openSepOut() { if (sepOutDir.value && bridge.openOutput) bridge.openOutput(sepOutDir.value); else toast(t('请使用桌面版打开输出文件夹'), 'warn'); }
/* 取消分离：主进程 engine:cancel 杀的正是 convertChildren 里登记的 'sep<N>'（见 main/task-queue.js），
   面板以前没给按钮 —— 长曲分离要等几十分钟，用户只能干看着。 */
function cancelSeparate() {
  if (!sepBusy.value) return;
  sepCanceled.value = true;
  try { if (bridge && bridge.cancel) bridge.cancel('sep' + sepJobId.value); } catch (e) {}
  sepStage.value = t('已请求取消…');
  logSep(t('已请求取消分离…'), true);
}
/* 分离结果 → 翻唱工作流：把音轨路径交给「翻唱」页（那边读 localStorage 接手），
   省掉「再选一次歌、再分离一遍」。人声/伴奏按文件名认，认不出就不带。 */
function coverFromSep() {
  const pick = (re) => (sepOutputs.value || []).find((o) => re.test(String(o).replace(/^.*[\\/]/, ''))) || '';
  const vocals = pick(/vocal/i);
  const inst = pick(/other|instrument|accompan|no_vocal/i);
  if (!vocals || !inst) { toast(t('这里需要同时有「人声」和「伴奏」两条轨'), 'warn'); return; }
  try {
    localStorage.setItem('fufumidi_cover_prefill', JSON.stringify({ vocals, instrumental: inst, outdir: sepOutDir.value || '' }));
  } catch (e) {}
  const app = useAppStore();
  app.setView('cover');
}

/* ---------------- MSST 参数预设（按模型保存 / 还原 / 应用） ---------------- */
const MS_PRESET_KEY = 'fufumidi_msst_presets';
const msSaved = ref([]);
const msPresetSel = ref('');
function persistMsPresets() { try { localStorage.setItem(MS_PRESET_KEY, JSON.stringify(msSaved.value)); } catch (e) {} }
function loadMsPresets() { try { const a = JSON.parse(localStorage.getItem(MS_PRESET_KEY) || '[]'); msSaved.value = Array.isArray(a) ? a : []; } catch (e) { msSaved.value = []; } }
const msPresetOptions = computed(() => msSaved.value.filter(p => p.modelId === sepModel.value));
// MSST 分离的**每模型默认参数**。判据同预设：最高质量 + 保证稳定性，不考虑速度性能。
//   · tta: true —— 引擎文档写明「小幅提升质量，推理时间 ×3」= 纯速度代价，按政策取最重的一档；
//   · format 'wav' —— 无损；
//   · stems [] —— 空 = 输出该模型全部音轨（含鼓组）。
// 切 MSST 模型时 applyMsPresetForModel 会套这套默认（用户为这个模型存过预设就用用户的）。
const msDefaults = () => ({ chunk: 926100, overlap: 4, batch: 2, normalize: true, tta: true, format: 'wav', stems: [] });
function collectMsParams() { return { chunk: msChunk.value, overlap: msOverlap.value, batch: msBatch.value, normalize: msNormalize.value, tta: msTta.value, format: msFormat.value, stems: msStems.value.slice(), chunkSec: chunkSec.value }; }
function applyMsParams(params) {
  const d = msDefaults();
  msChunk.value = Math.max(44100, Math.round(params.chunk || d.chunk));
  msOverlap.value = Math.max(1, Math.round(params.overlap || d.overlap));
  msBatch.value = Math.max(1, Math.round(params.batch || d.batch));
  msNormalize.value = typeof params.normalize === 'boolean' ? params.normalize : d.normalize;
  msTta.value = !!params.tta;
  msFormat.value = ['wav', 'flac', 'mp3'].includes(params.format) ? params.format : d.format;
  msStems.value = Array.isArray(params.stems) ? params.stems.slice() : [];
}
function applyMsPresetForModel(id) {
  const saved = msSaved.value.filter(p => p.modelId === id).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  const p = saved[0];
  if (p) { applyMsParams(p.params); msPresetSel.value = p.name; }
  else { applyMsParams(msDefaults()); msPresetSel.value = ''; }
}
async function saveMsPreset() {
  if (!currentSep.value) { toast(t('请先选择处理模型'), 'warn'); return; }
  const def = msDefaults();
  if (msChunk.value === def.chunk && msOverlap.value === def.overlap && msBatch.value === def.batch && msNormalize.value === def.normalize && !msTta.value && msFormat.value === def.format && !msStems.value.length) {
    toast(t('当前参数即为默认，无需保存'), 'warn'); return;
  }
  const name = await app.promptDialog({ title: t('保存「') + currentSep.value.name + t('」参数预设'), value: '' });
  if (!name || !name.trim()) return;
  msSaved.value.push({ name: name.trim(), modelId: sepModel.value, params: collectMsParams(), savedAt: Date.now() });
  persistMsPresets(); msPresetSel.value = name.trim();
  toast(t('参数预设已保存'), 'ok');
}
function applyMsPreset() {
  const p = msPresetOptions.value.find(x => x.name === msPresetSel.value);
  if (!p) { toast(t('请选择已保存的预设'), 'warn'); return; }
  applyMsParams(p.params); toast(t('已应用预设：') + p.name, 'ok');
}
function resetMsParams() { applyMsParams(msDefaults()); msPresetSel.value = ''; toast(t('已还原默认参数'), 'ok'); }
function delMsPreset() {
  if (!msPresetSel.value) return;
  msSaved.value = msSaved.value.filter(p => !(p.modelId === sepModel.value && p.name === msPresetSel.value));
  persistMsPresets(); msPresetSel.value = ''; toast(t('预设已删除'), 'ok');
}
const minNote = ref(128);
const mergeGap = ref(30);
const pedal = ref(true);
const drums = ref(false);
const stemExport = ref(false);
const stemFormat = ref('wav');
// 降噪：2026-10-15 实测两档降噪都会增加噪声引起的假音符（12 dB 素材 1 → 14/39），
// 所以默认关闭；2026-10-18 用户要求补回选项，高级参数里提供 off/light/strong 并写明代价。
// 电平统一恒定执行（audio_chain 的 −16 dBFS），不设开关。
const autoBpm = ref(true);   // 默认开启：转写出的 MIDI 按源音频自动测速，播放/导出与原曲速度一致

// 转录队列（**当前激活队列**的条目；多队列见下方「多队列」一节）
const queue = reactive([]);
let nextId = 1;
const sort = ref('default');
const running = ref(false);
const paused = ref(false);
const cancelAll = ref(false);
const currentJobId = ref(null);
/* 运行中的队列 id：运行中允许切换**视图**，但正在跑的队列始终是这个 id；
   顺序转录（chainMode）默认关，用户显式打开后才会一个队列接一个队列跑。 */
const runningQueueId = ref(0);
const chainMode = ref(false);
try { chainMode.value = localStorage.getItem('fufumidi_chain_queues') === '1'; } catch (e) {}
function setChainMode(v) {
  chainMode.value = !!v;
  try { localStorage.setItem('fufumidi_chain_queues', chainMode.value ? '1' : '0'); } catch (e) {}
}
let userPinnedQueue = false;     // 运行中用户手动切过视图 → 顺序转录不再自动跟随 */
function pendingItemsOf(q) { return (q && Array.isArray(q.items) ? q.items : []).filter((i) => i.status === 'pending'); }
/** 顺序转录的队列顺序：从当前激活队列开始、按列表顺序绕一圈 */
function queueOrderFrom(activeId) {
  const list = queues.slice();
  const i = list.findIndex((q) => q.id === activeId);
  if (i > 0) return list.slice(i).concat(list.slice(0, i));
  return list;
}

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
// 预设按**模型**归属（见下方「参数预设」一节）
let presetApplying = false;      // 正在套用预设 → watch 不要再插一脚（防回环）
let lastModelKey = '';           // 上次的模型键，用来判断"模型真的换了"

/* ---------------- 多队列：每个队列各自带一份「模型 + 参数」设置 ----------------
 * 用户要求（2026-10-14）：转录队列要能建多个，用来区分**用什么模型、用什么参数**。
 * 设计：队列 = { 名字, 模型选择, 参数快照, 条目 }。
 *   · 切队列 = 先把当前界面的模型/参数存回旧队列（snapshotIntoQueue），
 *     再把新队列的设置加载到界面（loadQueueSettings）—— 于是"切队列"就是"切模型与参数"；
 *   · 参数快照直接用 P1 的 collectPresetParams / applyPresetParams，**不另立一套序列化**；
 *   · 运行中禁止切/新建/删除队列（半路换设置会让同一批条目用两套参数，结果无法解释）。
 */
const QUEUES_KEY = 'fufumidi_queues_v1';
const queues = reactive([]);
const activeQid = ref(0);

// 智能修正
const rf = reactive({ audio: '', midi: '', mode: 'auto', stem: true, busy: false, jobId: 0, progress: 0, logs: [], info: '' });

const MODE_NAMES = () => ({ universal: t('通用识别'), piano: t('钢琴专用'), separate: t('音频处理') });
const PERF_NAMES = () => ({ quality: t('最高质量'), balanced: t('均衡'), fast: t('低配省资源') });
// ★ 每个档位下面必须写清代价（用户原则：不许只给开关不给代价说明）。
//   注意 fast 的真实语义是「资源最少」，在正常机器上它**比 quality 慢** ——
//   引擎侧 PERF_MODES/PERF_BATCH 就是「quality 全核+批量32 / fast 2核+批量8」。
const PERF_DESC = () => ({
  quality: t('全部核心 + 最大批量：同一台机器上最快，占内存/显存最多'),
  balanced: t('限制到 4 核、批量减半：折中'),
  fast: t('限制到 2 核 + 最小批量：低配/小显存机器更稳，正常机器上会更慢'),
}[perf.value] || '');

/* 「速度组」这一栏该不该出现。
 * ★ 该组目前只有两项（束搜索宽度 / 计算精度），**两项都只适用于 MuScriptor** ——
 *   束搜索影响生成耗时，计算精度影响显存/内存。其余模型（basic-pitch / 钢琴）没有任何
 *   「只花时间或显存、不改结果」的参数，就不该看到这个组标题：
 *   否则会出现「有分类标题、下面一个控件都没有」的空组（用户实测反馈）。
 * ★ 以后往这一组里加控件，**必须同时改这个判断** —— 它的语义是「本组至少有一个控件会渲染」。
 *   （separate 模式整块高级参数都不显示，所以不必单独判。） */
const showSpeedGroup = computed(() => mode.value === 'universal' && umodel.value === 'muscriptor');
// 模型键 → 内置默认预设名。★ 权威表在 engine/presets.py:MODEL_DEFAULT_PRESET，
// 桌面端由 presets.list 下发（model_defaults）；下面这份是**网页版兜底**（无桥接时用），
// 两边名字必须逐字一致，否则网页版「切模型自动套默认」找不到预设。
const WEB_MODEL_DEFAULTS = () => ({
  basic: 'Basic Pitch · 最优',
  yourmt3: 'YourMT3+ · 最优',
  miros: 'MIROS · 最优',
  muscriptor_small: 'MuScriptor · 最优',
  muscriptor_medium: 'MuScriptor · 最优',
  muscriptor_large: 'MuScriptor · 最优',
  piano_pt: '钢琴 · 最优',
  aria: 'Aria-AMT · 最优',
  transkun: 'Transkun · 最优',
  hft: 'hFT-Transformer · 最优',
  separate: '分离 · 最优',
});

// 网页版内置预设（与 engine/presets.py 的 _builtin_presets 一一对应；名字必须逐字一致）。
// 无桥接时 loadPresets 用这份数据填充，避免「应用预设」因列表为空而失效。
// 判据同引擎侧：最高质量 + 保证稳定性，不考虑速度性能（perf=quality / fp32 / 中性解码值）。
const WEB_BUILTIN_PRESETS = () => {
  const basic = {
    model: 'basic', onset_threshold: 0.5, frame_threshold: 0.3, minimum_note_length: 128,
    melodia: true, min_freq: 0, max_freq: 0,
    beat_grid: true, tempo: 0, perf: 'quality',
    auto_bpm: false, denoise_mode: 'off', segment_sec: 0,
  };
  const piano = {
    onset_threshold: 0.3, frame_threshold: 0.1, min_note_ms: 60, merge_gap_ms: 30,
    include_pedal: true, perf: 'quality',
    auto_bpm: false, denoise_mode: 'off', segment_sec: 10,
  };
  return [
    { name: 'Basic Pitch · 最优', mode: 'universal', params: { ...basic } },
    { name: 'YourMT3+ · 最优', mode: 'universal', params: { ...basic,
      model: 'yourmt3', segment_sec: 0 } },
    { name: 'MIROS · 最优', mode: 'universal', params: { ...basic,
      model: 'miros', segment_sec: 0 } },
    { name: 'MuScriptor · 最优', mode: 'universal', params: { ...basic,
      model: 'muscriptor', model_size: 'medium',
      temperature: 1.0, cfg_coef: 1.0, beam_size: 1, prelude_forcing: true,
      precision: 'fp32', segment_sec: 5 } },
    { name: '钢琴 · 最优', mode: 'piano', params: { ...piano, model: 'piano_pt', segment_sec: 10 } },
    { name: 'Aria-AMT · 最优', mode: 'piano', params: { ...piano, model: 'aria', segment_sec: 30 } },
    { name: 'Transkun · 最优', mode: 'piano', params: { ...piano, model: 'transkun', segment_sec: 16 } },
    { name: 'hFT-Transformer · 最优', mode: 'piano', params: { ...piano, model: 'hft', segment_sec: 0 } },
    { name: '分离 · 最优', mode: 'separate', params: {
      onset_threshold: 0.5, frame_threshold: 0.3, minimum_note_length: 128,
      include_drums: true, stem_format: 'wav', perf: 'quality',
      auto_bpm: false } },
  ];
};

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
  const q = currentQueue();
  for (const p of (paths || [])) {
    if (!p) continue;
    if (queue.some(i => i.path === p)) continue;
    const it = { id: nextId++, path: p, name: String(p).replace(/^.*[\\/]/, ''), status: 'pending', progress: 0, realPct: 0, duration: 0, out: '', note_count: 0, error: '' };
    queue.push(it);
    // 运行中往当前视图队列加条目：同时写进队列对象，正在跑的 worker 才能捡到
    if (q && q.id === runningQueueId.value) {
      q.items = Array.isArray(q.items) ? q.items : [];
      if (!q.items.some((x) => x.id === it.id)) q.items.push(it);
    }
  }
  saveQueue();
}
function statusTxt(s) {
  return { pending: t('等待'), running: t('转录中'), done: t('完成'), error: t('失败'), canceled: t('已取消') }[s] || s;
}
/* ---------------- 多队列 ---------------- */
const MODEL_SHORT = () => ({
  basic: 'Basic Pitch', yourmt3: 'YourMT3+', miros: 'MIROS', muscriptor_small: 'MuScriptor Small', muscriptor_medium: 'MuScriptor Medium',
  muscriptor_large: 'MuScriptor Large', piano_pt: 'piano-transcription', aria: 'Aria-AMT',
  transkun: 'Transkun', hft: 'hFT-Transformer', separate: t('音频处理'),
});
function currentQueue() { return queues.find((q) => q.id === activeQid.value) || queues[0] || null; }
/* 每个队列的「转录产物加入哪个歌单」：
   ''      = 跟随当前歌单（旧队列/旧版本行为，保持兼容）
   'all'   = 只进「全部曲目」，不归入任何歌单
   其它    = 歌单 id */
function queueTarget(q) { return (q && q.playlistTarget) || ''; }
function targetName(target) {
  if (target === 'all') return t('全部曲目');
  if (!target) return t('跟随当前歌单');
  const pl = playlist.playlists.find((x) => x.id === target);
  return pl ? pl.name : t('已删除的歌单');
}
function setQueueTarget(ev) {
  const q = currentQueue();
  if (!q) return;
  q.playlistTarget = String(ev && ev.target ? ev.target.value : '');
  persistQueues();
}
/** 真正传给 importFiles 的 target；歌单被删/无效时回退旧行为（跟随当前歌单） */
function effectiveTarget(q) {
  const v = queueTarget(q);
  if (v === 'all' || v === '') return v;
  return playlist.playlists.some((x) => x.id === v) ? v : '';
}
/** 队列摘要 —— 用户要的就是"一眼看出这个队列用什么模型、什么参数跑"。 */
function queueSummary(q) {
  if (!q) return '';
  const label = MODEL_SHORT()[q.modelKey] || (MODE_NAMES()[q.mode] || '');
  return [label, q.preset].filter(Boolean).join(' · ');
}
function queueCount(q) { return (q && q.id === activeQid.value) ? queue.length : ((q && q.items) ? q.items.length : 0); }

/** 把当前界面的模型 + 参数 + 条目存回队列对象。所有 saveQueue() 都会先走这一步。 */
function snapshotIntoQueue(q) {
  if (!q) return;
  q.mode = mode.value; q.umodel = umodel.value; q.msSize = msSize.value; q.pmodel = pmodel.value;
  q.perf = perf.value; q.preset = presetSel.value;
  q.params = collectPresetParams();       // 与预设共用同一套序列化
  q.modelKey = currModelKey();
  q.items = queue.slice();
}

/** 把队列的模型 + 参数 + 条目加载到界面。 */
function loadQueueSettings(q) {
  if (!q) return;
  presetApplying = true;
  try {
    if (q.mode) mode.value = q.mode;
    if (q.umodel) umodel.value = q.umodel;
    if (q.msSize) msSize.value = q.msSize;
    if (q.pmodel) pmodel.value = q.pmodel;
    if (q.params) applyPresetParams(q.params, { keepModel: true });
    if (q.preset) presetSel.value = q.preset;
  } finally { presetApplying = false; }
  // 队列自带设置 → 别让「切模型自动套默认」再覆盖一遍；没有参数快照（老数据）才交给它套默认。
  // ★ watch 是异步的，所以这里必须先摆好 lastModelKey，不能只靠 presetApplying。
  lastModelKey = q.params ? currModelKey() : '';
  queue.splice(0, queue.length, ...(q.items || []));
  queue.forEach((it) => { if (it.status === 'running') it.status = 'pending'; });
  autoApplyForCurrentModel();
}

function persistQueues() {
  try {
    const dump = queues.map((q) => ({
      id: q.id, name: q.name, mode: q.mode, umodel: q.umodel, msSize: q.msSize, pmodel: q.pmodel,
      perf: q.perf, preset: q.preset, modelKey: q.modelKey, params: q.params,
      playlistTarget: q.playlistTarget || '',
      // 上限 500 条/队列：localStorage 只有几 MB，别让一个超大队列把配额撑爆
      items: ((q.id === activeQid.value ? queue : (q.items || []))).slice(0, 500).map((it) => ({
        id: it.id, path: it.path, name: it.name, duration: it.duration || 0,
        status: it.status === 'done' ? 'done' : (it.status === 'error' ? 'error' : 'pending'),
        out: it.out || '', note_count: it.note_count || 0, error: it.error || '',
        progress: it.status === 'done' ? 100 : 0, realPct: 0,
      })),
    }));
    localStorage.setItem(QUEUES_KEY, JSON.stringify({
      v: 1, active: activeQid.value,
      nextId,
      queues: dump,
    }));
  } catch (e) {}
}

function saveQueue() { snapshotIntoQueue(currentQueue()); persistQueues(); }

function switchQueue(q) {
  if (!q || q.id === activeQid.value) return;
  if (running.value) {
    // 运行中允许切换视图：不打断正在跑的队列，也不拿当前界面覆盖运行队列的设置。
    const cur = currentQueue();
    if (cur && cur.id !== runningQueueId.value) snapshotIntoQueue(cur);
    userPinnedQueue = true;
    activeQid.value = q.id;
    loadQueueSettings(q);
    persistQueues();
    const still = (q.id === runningQueueId.value) ? t('（这就是正在转录的队列）') : t('（后台仍在转录另一个队列，完成后可切回）');
    toast(t('已切换到队列：') + q.name + still, 'ok');
    return;
  }
  snapshotIntoQueue(currentQueue());
  activeQid.value = q.id;
  loadQueueSettings(q);
  persistQueues();
  toast(t('已切换到队列：') + q.name + t('（模型与参数已同步切换）'), 'ok');
}
async function addQueue() {
  const whileRunning = running.value;
  const name = await app.promptDialog({ title: t('新建队列'), value: t('队列 ') + (queues.length + 1) });
  if (!name || !name.trim()) return;
  const old = currentQueue();
  snapshotIntoQueue(old);            // 只复制快照，不动正在跑的条目
  const q = {
    id: queues.reduce((m, x) => Math.max(m, (x.id || 0) + 1), 1),
    name: name.trim(), items: [],
    mode: mode.value, umodel: umodel.value, msSize: msSize.value, pmodel: pmodel.value,
    perf: perf.value, preset: presetSel.value, modelKey: currModelKey(),
    params: collectPresetParams(),
    playlistTarget: (old && old.playlistTarget) || '',
  };
  queues.push(q);
  if (whileRunning) {
    // 运行中只“加入队列列表”，不能切过去（切走会清空正在跑的 queue → 这一批条目丢失）。
    // 当前这一批结束后再切；设置已按当时界面复制，切过去后还能改。
    persistQueues();
    toast(t('已新建队列：') + q.name + t('（当前转录结束后可切换）'), 'ok');
    return;
  }
  activeQid.value = q.id;
  queue.splice(0, queue.length);     // 新队列从空开始（旧队列的条目已经在它自己身上了）
  snapshotIntoQueue(q);              // 但沿用当前界面的模型/参数 —— 想改直接在界面上改
  persistQueues();
  toast(t('已新建队列：') + q.name + t('（当前模型与参数已复制过来）'), 'ok');
}
async function renameQueue(q) {
  if (!q) return;
  const name = await app.promptDialog({ title: t('重命名队列'), value: q.name });
  if (!name || !name.trim()) return;
  q.name = name.trim();
  persistQueues();
  toast(t('已重命名队列'), 'ok');
}
function duplicateQueue(q) {
  if (!q) return;
  if (running.value) { toast(t('队列运行中，请先停止再复制'), 'warn'); return; }
  if (q.id === activeQid.value) snapshotIntoQueue(q);
  const copy = { ...q, id: queues.reduce((m, x) => Math.max(m, (x.id || 0) + 1), 1), name: q.name + t(' 副本') };
  copy.items = (q.items || []).map((it) => ({ ...it, id: nextId++, status: it.status === 'done' ? 'done' : 'pending', progress: it.status === 'done' ? 100 : 0 }));
  queues.push(copy);
  persistQueues();
  toast(t('已复制队列：') + copy.name, 'ok');
}
async function removeQueue(q) {
  if (!q) return;
  if (running.value) { toast(t('队列运行中，请先停止再删除'), 'warn'); return; }
  if (queues.length <= 1) { toast(t('至少要保留一个队列'), 'warn'); return; }
  if (!await app.confirmDialog({ msg: t('删除队列「') + q.name + t('」？队列里的条目会一起删掉。') })) return;
  const wasActive = q.id === activeQid.value;
  if (wasActive) snapshotIntoQueue(q);
  const i = queues.indexOf(q);
  if (i >= 0) queues.splice(i, 1);
  if (wasActive) {
    activeQid.value = queues[Math.min(i, queues.length - 1)].id;
    loadQueueSettings(currentQueue());
  }
  persistQueues();
  toast(t('队列已删除'), 'ok');
}

function loadQueue() {
  try {
    const raw = localStorage.getItem(QUEUES_KEY);
    if (raw) {
      const d = JSON.parse(raw) || {};
      const arr = Array.isArray(d.queues) ? d.queues.filter((q) => q && q.name) : [];
      if (arr.length) {
        queues.splice(0, queues.length, ...arr.map((q) => ({ ...q, items: Array.isArray(q.items) ? q.items : [] })));
        activeQid.value = queues.some((q) => q.id === d.active) ? d.active : queues[0].id;
        nextId = Math.max(d.nextId || 1, 1 + queues.reduce((m, q) => Math.max(m, ...(q.items || []).map((i) => i.id || 0)), 0));
        loadQueueSettings(currentQueue());
        const n = queues.reduce((s, q) => s + q.items.length, 0);
        if (n) toast(t('已恢复 ') + queues.length + t(' 个转录队列，共 ') + n + t(' 个条目'), 'ok');
        return;
      }
    }
    // 老版本只有「一个队列 + 路径数组」→ 迁移成第一个队列，别把没跑完的东西丢了
    let paths = [];
    const legacy = localStorage.getItem('fufumidi_batch_queue');
    if (legacy) { const a = JSON.parse(legacy); if (Array.isArray(a)) paths = a.filter(Boolean); }
    const q = { id: 1, name: t('默认队列'), items: [] };
    queues.push(q);
    activeQid.value = q.id;
    queue.splice(0, queue.length);
    if (paths.length) {
      addPaths(paths);
      toast(t('已恢复上次未完成的转录队列，共 ') + paths.length + t(' 个'), 'ok');
    }
    localStorage.removeItem('fufumidi_batch_queue');
    saveQueue();
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
  if (running.value) { toast(t('队列运行中，请先停止'), 'warn'); return; }
  const before = queue.length;
  for (let i = queue.length - 1; i >= 0; i--) if (queue[i].status === 'done') queue.splice(i, 1);
  if (queue.length !== before) saveQueue();
}
function clearQueue() {
  if (running.value) { toast(t('队列运行中，请先取消'), 'warn'); return; }
  queue.length = 0;
  saveQueue();
  toast(t('已清空转录队列'), 'ok');
}
/* ---------------- 并行数（1-4，持久化） ---------------- */
const parallelN = ref(Math.max(1, Math.min(4, parseInt(localStorage.getItem('fufumidi_parallel') || '1', 10) || 1)));
function setParallel(n) {
  parallelN.value = Math.max(1, Math.min(4, n));
  try { localStorage.setItem('fufumidi_parallel', String(parallelN.value)); } catch (e) {}
  toast(t('并行数已设为 ') + parallelN.value + t('（下次开始转录时生效）'), 'ok');
}
const sortedQueue = computed(() => {
  const arr = queue.slice();
  if (sort.value === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh'));
  else if (sort.value === 'type') arr.sort((a, b) => (String(a.name || '').split('.').pop() || '').localeCompare(String(b.name || '').split('.').pop() || ''));
  else if (sort.value === 'duration') arr.sort((a, b) => (a.duration || 0) - (b.duration || 0));
  return arr;
});
/* ---------------- 队列拖动排序（用户 2026-10-14 要求） ----------------
   与侧边栏歌单/歌曲一致的交互：整行可拖，落点用 2px accent 线标出（上/下半行决定插前插后）。
   ★ 只在「默认顺序」下可拖：按名称/类型/时长是**显示层**排序，拖出来的顺序会立刻被排序覆盖，
     看着像没生效。非默认顺序时右下角给一句提示。 */
const dragItemId = ref(0);
function clearTrDragMarks() {
  document.querySelectorAll('.tr-batch-item').forEach(x => x.classList.remove('tr-drag-before', 'tr-drag-after'));
}
function trDragStart(it, e) {
  if (sort.value !== 'default') { toast(t('拖动排序要在「默认顺序」下进行'), 'warn'); return; }
  dragItemId.value = it.id;
  if (e && e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', String(it.id)); } catch (err) {}
  }
}
function trDragOver(e, it) {
  if (!dragItemId.value || dragItemId.value === it.id) return;
  const r = e.currentTarget.getBoundingClientRect();
  const before = (e.clientY - r.top) < r.height / 2;
  e.currentTarget.classList.toggle('tr-drag-before', before);
  e.currentTarget.classList.toggle('tr-drag-after', !before);
}
function trDragLeave(e) { e.currentTarget.classList.remove('tr-drag-before', 'tr-drag-after'); }
function trDragEnd() { dragItemId.value = 0; clearTrDragMarks(); }
function trDrop(e, target) {
  e.stopPropagation();
  const id = dragItemId.value;
  const r = e.currentTarget.getBoundingClientRect();
  const before = (e.clientY - r.top) < r.height / 2;
  clearTrDragMarks();
  if (!id || !target || id === target.id || sort.value !== 'default') { trDragEnd(); return; }
  const from = queue.findIndex(x => x.id === id);
  if (from < 0) { trDragEnd(); return; }
  const [moved] = queue.splice(from, 1);
  let to = queue.findIndex(x => x.id === target.id);   // 抽走之后重算落点
  if (to < 0) to = queue.length;
  if (!before) to += 1;
  queue.splice(to, 0, moved);
  saveQueue();
  trDragEnd();
}

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
      if (paths && paths.length) { addPaths(paths); setPrimary(paths[0]); toast(t('已添加 ') + paths.length + t(' 个音频到队列'), 'ok'); }
    } catch (err) { toast(t('选择音频失败：') + (err && err.message || err), 'warn'); }
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
    toast(t('已添加 ') + files.length + t(' 个音频到队列'), 'ok');
  }
  e.target.value = '';
}
async function pickFolder() {
  if (!bridge || !bridge.pickDirectory || !bridge.listAudioFiles) { toast(t('请使用桌面版选择文件夹'), 'warn'); return; }
  try {
    const dir = await bridge.pickDirectory();
    if (!dir) return;
    const files = await bridge.listAudioFiles(dir);
    if (!files || !files.length) { toast(t('文件夹里没有找到音频文件'), 'warn'); return; }
    addPaths(files);
    setPrimary(files[0]);
    toast(t('已添加 ') + files.length + t(' 个音频到队列'), 'ok');
  } catch (e) { /* ignore */ }
}
const dropOver = ref(false);
function onDrop(e) {
  dropOver.value = false;
  const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
  if (!files.length) { toast(t('请拖入音频文件'), 'warn'); return; }
  addPaths(files.map(f => f.path || f.name));
  files.forEach((f, i) => { const q = queue.find(x => x.path === (f.path || f.name)); if (q) q._file = f; });
  setPrimary(files[0].path || files[0].name);
  toast(t('已添加 ') + files.length + t(' 个音频到队列'), 'ok');
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
      g.fillStyle = themeColor('--t-info', '#3daeff');
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
      perfHint.value = t('自动推荐：') + (PERF_NAMES()[p.perf.recommended] || p.perf.recommended);
    }
    if (p && p.gpu) {
      const g = p.gpu;
      let _base = '';
      if (g.rocm) _base = 'GPU · AMD (ROCm) ✓';
      else if (g.cuda) _base = 'GPU · ' + (g.vendor === 'nvidia' ? 'NVIDIA' : 'CUDA') + ' ✓';
      else if (g.mps) _base = 'GPU · Apple (MPS) ✓';
      else if (g.torch_directml || g.directml) _base = 'GPU · ' + (g.vendor === 'amd' ? 'AMD' : g.vendor === 'intel' ? 'Intel' : 'DirectML') + ' (DirectML) ✓';
      if (g.vram_total_mb) {
        const _gb = (x) => (Math.round(x / 102.4) / 10).toFixed(1);
        _base += ' · 显存 ' + _gb(g.vram_free_mb || 0) + '/' + _gb(g.vram_total_mb) + ' GB 空闲';
      }
      gpuInfo.value = _base;
      const _parts = [];
      if (g.driver_version) _parts.push(t('驱动 ') + g.driver_version);
      if (g.sysmem_fallback_supported === true) _parts.push(t('共享显存回退：支持（驱动 ≥536.40；≥546.01 可按应用关闭）'));
      else if (g.sysmem_fallback_supported === false) _parts.push(t('共享显存回退：不支持（显存不足会直接报 OOM）'));
      gpuDetail.value = _parts.join(' · ');
    }
  } catch (e) {}
}
function selectPerf(p) { perfUserSet = true; perf.value = p; }
async function runUnifiedMemoryExperiment() {
  if (!bridge || typeof bridge.gpuUnifiedMemoryExperiment !== 'function') { toast(t('当前版本不支持统一内存实验'), 'warn'); return; }
  if (umBusy.value) return;
  umBusy.value = true;
  umResult.value = '';
  try {
    const r = await bridge.gpuUnifiedMemoryExperiment();
    if (r && r.ok) {
      umResult.value = t('统一内存：可用 · 分配 ') + (r.alloc_ms || 0) + 'ms · ' + t('主机写入 ') + (r.host_touch_ms || 0) + 'ms · ' + t('同步 ') + (r.sync_ms || 0) + 'ms（仅实验，不改变转录分配器）';
      toast(t('统一内存实验通过（仅实验，不改变转录）'), 'ok');
    } else {
      umResult.value = t('统一内存：不可用：') + ((r && (r.error || r.code)) || '');
      toast(t('统一内存不可用：') + ((r && (r.error || r.code)) || ''), 'warn');
    }
  } catch (e) {
    umResult.value = t('统一内存：不可用：') + String((e && e.message) || e);
    toast(t('统一内存实验失败'), 'warn');
  } finally { umBusy.value = false; }
}

/* ---------------- 参数预设（**按模型归属**） ---------------- */
// 用户要求（2026-10-14）：
//   ① 内置预设按**模型**给（每个模型一套「最优」），不再按"用途"命名；
//   ② 切模型 / 切规格 → 自动套该模型的默认预设；
//   ③ 用户手动应用某个预设 = 指定"当前模型用它" → 写回 presets.json 的 model_preset，
//      以后切回这个模型就用它（**以用户为准**）；
//   ④ 「恢复该模型默认」= 解绑，回到内置默认。
// 记忆落在**数据根**的 presets.json（与预设同一文件），整包更新不会碰它。
const modelDefaults = ref({});   // 模型键 → 内置默认预设名（权威表在 engine/presets.py）
const modelPreset = ref({});     // 模型键 → **用户指定**的预设名

/** 当前模型的键。★ 必须与 engine/presets.py:MODEL_DEFAULT_PRESET 的键逐字一致。 */
function currModelKey() {
  if (mode.value === 'separate') return 'separate';
  if (mode.value === 'universal') {
    if (umodel.value === 'muscriptor') return 'muscriptor_' + msSize.value;
    if (umodel.value === 'yourmt3') return 'yourmt3';
    if (umodel.value === 'miros') return 'miros';
    return 'basic';
  }
  return pmodel.value;                                  // piano_pt | aria | transkun
}

/** 该模型该用哪个预设：用户指定 > 后端下发的内置默认 > 网页版兜底。找不到返回空串。 */
function presetForModel(key) {
  const want = modelPreset.value[key] || modelDefaults.value[key] || WEB_MODEL_DEFAULTS()[key] || '';
  return (want && presets.list.some((x) => x.name === want)) ? want : '';
}

/** 当前模型用的是哪套预设（写进界面，让"现在生效的是哪一套"看得见）。 */
const presetModelHint = computed(() => {
  const key = currModelKey();
  const nm = presetForModel(key);
  if (!nm) return '';
  return (modelPreset.value[key] ? t('本模型使用你指定的预设：') : t('本模型默认预设：')) + nm;
});

async function loadPresets() {
  const local = !bridge || !bridge.presets;
  let list = [], builtins = [];
  const useWebFallback = () => {
    list = WEB_BUILTIN_PRESETS();
    builtins = list.map((p) => p.name);
    modelDefaults.value = WEB_MODEL_DEFAULTS();
  };
  if (local) {
    // 网页版无桥接：用前端内置预设，保证「应用预设」可用（保存/删除仅桌面版支持）
    useWebFallback();
  } else {
    try {
      const r = await bridge.presets.list();
      if (r && r.ok && r.presets && Object.keys(r.presets).length) {
        list = Object.entries(r.presets).map(([name, val]) => ({ name, ...val }));
        builtins = r.builtins || [];
        modelDefaults.value = r.model_defaults || {};
        modelPreset.value = r.model_preset || {};
      } else {
        // 桌面端后端预设意外为空/失败时兜底前端内置，避免预设列表空导致「应用」无反应
        toast(t('加载预设失败：') + ((r && r.error) || t('返回空列表')) + t('，已使用内置预设'), 'warn');
        useWebFallback();
      }
    } catch (e) { useWebFallback(); }
  }
  presets.list.splice(0, presets.list.length, ...list);
  presets.builtins.splice(0, presets.builtins.length, ...builtins);
  const want = presetForModel(currModelKey());
  if (want) presetSel.value = want;
  else if (presets.list.length) presetSel.value = presets.list[0].name;
  autoApplyForCurrentModel();     // 首次进来就把当前模型的默认预设套上
  // ★ 预设刚生效 → 当前队列的快照必须跟着刷新。
  //   否则首次启动时 loadQueue() 早于 loadPresets()，落盘的会是"预设生效前"的那份参数，
  //   下次启动就会拿旧参数覆盖掉模型默认。
  snapshotIntoQueue(currentQueue());
  persistQueues();
}

/** 预设参数快照：**全量**（与 collectParams 的稀疏 cfg 不同 —— 预设要能完整还原界面）。
 *  只收当前模型适用的键；应用时按「预设没给就保留当前值」处理。 */
function collectPresetParams() {
  const n2 = (v) => parseFloat(Number(v).toFixed(2));
  const iv = (v) => parseInt(v, 10) || 0;
  const p = {
    perf: perf.value,
    auto_bpm: autoBpm.value,
    tempo: iv(exportTempo.value),
    segment_sec: Math.max(0, iv(segmentSec.value)),
    denoise_mode: denoiseMode.value || 'off',
  };
  if (mode.value === 'universal') {
    Object.assign(p, {
      model: umodel.value,
      onset_threshold: n2(onset.value), frame_threshold: n2(frame.value),
      minimum_note_length: iv(minNote.value),
      melodia: !bassBoost.value,
      min_freq: iv(minFreq.value), max_freq: iv(maxFreq.value),
      beat_grid: beatGrid.value,
    });
    if (umodel.value === 'basic') p.multiple_pitch_bends = pitchBends.value;
    if (umodel.value === 'muscriptor') Object.assign(p, {
      model_size: msSize.value,
      muscriptor_instruments: msInstrValue.value,
      probe_segment_sec: iv(msProbeSegSec.value),
      temperature: Number(msTemp.value), cfg_coef: Number(msCfg.value),
      beam_size: iv(msBeam.value), prelude_forcing: msPrelude.value,
      precision: msPrec.value,
    });
  } else if (mode.value === 'piano') {
    Object.assign(p, {
      model: pmodel.value,
      onset_threshold: n2(onset.value), frame_threshold: n2(frame.value),
      min_note_ms: iv(minNote.value), merge_gap_ms: iv(mergeGap.value),
      include_pedal: pedal.value,
    });
  } else {
    Object.assign(p, {
      onset_threshold: n2(onset.value), frame_threshold: n2(frame.value),
      minimum_note_length: iv(minNote.value),
      include_drums: drums.value, stem_format: stemFormat.value || 'wav',
    });
  }
  return p;
}

/** 应用预设参数（只覆盖预设里给了的键）。
 *
 *  ★ opts.keepModel：**不写回 mode / model / model_size**。
 *    这条路径是「切模型/切规格 → 自动套默认」，此刻模式与子模型是用户刚选的；
 *    MuScriptor 三个规格**共用同一套预设**，写回去就会把规格打回 medium
 *    （契约见 engine/presets.py 的 ★ 前端契约）。用户手动点「应用」时才允许连子模型一起切。
 */
function applyPresetParams(p, opts) {
  const pr = p || {};
  const keep = !!(opts && opts.keepModel);
  const has = (k) => pr[k] !== undefined && pr[k] !== null;
  const num = (k) => parseFloat(pr[k]);
  const numOr = (k, d) => (isNaN(num(k)) ? d : num(k));
  if (!keep && has('model')) {
    if (pr.model === 'basic' || pr.model === 'muscriptor' || pr.model === 'yourmt3' || pr.model === 'miros') umodel.value = pr.model;
    else if (['piano_pt', 'aria', 'transkun', 'hft'].indexOf(pr.model) >= 0) pmodel.value = pr.model;
  }
  if (!keep && has('model_size') && ['small', 'medium', 'large'].indexOf(pr.model_size) >= 0) msSize.value = pr.model_size;
  // 性能档：用户手动选过就尊重用户的选择（自动套预设不改它）
  if (has('perf') && ['quality', 'balanced', 'fast'].indexOf(pr.perf) >= 0 && !(keep && perfUserSet)) perf.value = pr.perf;
  if (has('onset_threshold')) onset.value = clamp(num('onset_threshold'), 0, 1);
  if (has('frame_threshold')) frame.value = clamp(num('frame_threshold'), 0, 1);
  const mn = has('minimum_note_length') ? num('minimum_note_length') : (has('min_note_ms') ? num('min_note_ms') : null);
  if (mn !== null && !isNaN(mn)) minNote.value = clamp(Math.round(mn), 10, 300);
  if (has('merge_gap_ms')) mergeGap.value = clamp(Math.round(num('merge_gap_ms')) || 0, 0, 200);
  if (has('include_pedal')) pedal.value = pr.include_pedal !== false;
  // 鼓组：历史预设写 include_drums，界面 cfg 用 with_drums —— 两个都认
  const dr = has('include_drums') ? pr.include_drums : (has('with_drums') ? pr.with_drums : null);
  if (dr !== null) drums.value = !!dr;
  // 旧预设里的 denoise / denoise_mode / normalize 一律忽略：降噪已从转录页移除，
  // 电平统一恒定开启（见 collectParams 上方的说明）。
  // ★ 2026-10-15：这里原来还有一行 `if (has('normalize')) normalize.value = ...`，
  //   `normalize` 这个 ref 早已随降噪开关一起删掉 —— 运行时会抛 ReferenceError，
  //   把本函数后半段（auto_bpm / tempo / 节拍网格 / 弯音 / 旋律增强）全部吃掉。
  //   实测在「套用带 normalize 键的预设」时必然触发，故整行删除。
  // 预设未显式指定 auto_bpm 时保留当前值（默认开），避免把自动测速关掉
  if (has('auto_bpm')) autoBpm.value = !!pr.auto_bpm;
  if (has('stem_format') && ['wav', 'flac', 'mp3'].indexOf(pr.stem_format) >= 0) stemFormat.value = pr.stem_format;
  if (has('tempo')) exportTempo.value = Math.max(0, Math.round(numOr('tempo', 0)));
  if (has('beat_grid')) beatGrid.value = !!pr.beat_grid;
  if (has('multiple_pitch_bends')) pitchBends.value = !!pr.multiple_pitch_bends;
  // 主旋律强化：新键 melodia，历史预设写 no_melodia（界面上的「低音增强」= 关掉 melodia）
  if (has('melodia')) bassBoost.value = pr.melodia === false;
  else if (has('no_melodia')) bassBoost.value = !!pr.no_melodia;
  // 音高范围：新键 min_freq/max_freq；历史预设用 minimum_frequency/maximum_frequency（null = 不限制）
  const freq = (kNew, kOld) => {
    if (has(kNew)) return Math.max(0, Math.round(numOr(kNew, 0)));
    if (kOld in pr) return pr[kOld] == null ? 0 : Math.max(0, Math.round(parseFloat(pr[kOld]) || 0));
    return null;
  };
  const lf = freq('min_freq', 'minimum_frequency');
  if (lf !== null) minFreq.value = lf;
  const hf = freq('max_freq', 'maximum_frequency');
  if (hf !== null) maxFreq.value = hf;
  // MuScriptor 生成参数
  if (has('temperature')) msTemp.value = Math.max(0, numOr('temperature', 1.0));
  if (has('cfg_coef')) msCfg.value = Math.max(0, numOr('cfg_coef', 1.0));
  if (has('beam_size')) msBeam.value = Math.max(1, Math.round(numOr('beam_size', 1)));
  if (has('prelude_forcing')) msPrelude.value = pr.prelude_forcing !== false;
  if (has('muscriptor_instruments') && typeof pr.muscriptor_instruments === 'string') {
    const v = pr.muscriptor_instruments.trim();
    if (!v || v === 'none') msMode.value = 'none';
    else if (v === 'probe_segments' || v === 'segments') msMode.value = 'probe_segments';
    else {
      const groups = v.split(',').map((s) => s.trim()).filter((g) => MS_GROUPS.some((x) => x.id === g));
      if (groups.length) { msGroups.value = groups; msMode.value = 'limit'; }
    }
  }
  if (has('probe_segment_sec')) msProbeSegSec.value = clamp(Math.round(numOr('probe_segment_sec', 60)), 20, 120);
  if (has('precision') && ['fp32', 'fp16'].indexOf(pr.precision) >= 0) msPrec.value = pr.precision;
  // 识别片段长度（0 = 模型默认）；老预设没有这个键时保留当前值
  if (has('segment_sec')) segmentSec.value = clamp(Math.round(numOr('segment_sec', 0)), 0, 120);
  // 降噪档位：只认引擎支持的三个值；老预设没有这个键时保持当前值（默认 off）
  if (has('denoise_mode') && ['off', 'light', 'strong'].indexOf(String(pr.denoise_mode)) >= 0) {
    denoiseMode.value = String(pr.denoise_mode);
  }
}

function applyPreset(name, opts) {
  const p = presets.list.find((x) => x.name === name);
  if (!p) return false;
  presetApplying = true;                       // 阻断 watch 的自动套用（防回环）
  try {
    // 手动应用时才跟着切模式；自动套用（keepModel）连模式都不动
    if (!(opts && opts.keepModel) && p.mode) mode.value = p.mode;
    applyPresetParams(p.params || {}, opts);
  } finally { presetApplying = false; }
  presetSel.value = name;
  lastModelKey = currModelKey();
  return true;
}

/** 切模型 / 切规格 → 自动套该模型的默认（或用户指定的）预设。
 *  预设还没加载出来时**不推进 lastModelKey**，等 loadPresets() 末尾再来一次。 */
function autoApplyForCurrentModel() {
  if (presetApplying) return;
  const key = currModelKey();
  if (key === lastModelKey) return;
  const want = presetForModel(key);
  if (!want) return;
  lastModelKey = key;
  applyPreset(want, { keepModel: true });
}
watch([mode, umodel, msSize, pmodel], autoApplyForCurrentModel);

// 行内「应用」按钮：应用当前选中的预设并给出反馈
async function applySelectedPreset() {
  if (!presetSel.value) { toast(t('请先选择预设'), 'warn'); return; }
  if (applyPreset(presetSel.value)) {
    await bindPresetToCurrentModel(presetSel.value);
    toast(t('已应用预设：') + presetSel.value, 'ok');
  }
}

/** 用户手动应用预设 = 指定「当前模型用它」→ 写回 model_preset。这就是「记住用户的选择」。 */
async function bindPresetToCurrentModel(name) {
  const key = currModelKey();
  if (bridge && bridge.presets && bridge.presets.setModelPreset) {
    try {
      const r = await bridge.presets.setModelPreset(key, name);
      if (r && r.ok) { modelPreset.value = r.model_preset || {}; return; }
    } catch (e) {}
  }
  modelPreset.value = { ...modelPreset.value, [key]: name };   // 网页版：只留在内存里
}

/** 「恢复该模型默认」：解绑本模型的用户指定，回到内置默认。 */
async function restoreModelDefault() {
  const key = currModelKey();
  if (bridge && bridge.presets && bridge.presets.setModelPreset) {
    try {
      const r = await bridge.presets.setModelPreset(key, '');
      if (r && r.ok) modelPreset.value = r.model_preset || {};
    } catch (e) {}
  } else {
    const m = { ...modelPreset.value }; delete m[key]; modelPreset.value = m;
  }
  lastModelKey = '';                     // 强制重新套用
  autoApplyForCurrentModel();
  toast(t('已恢复该模型默认预设'));
}

function onModeChange(m) {
  // 切模式后交给 watch：新模式的模型默认预设会自动套上
  //（旧版是查一张"模式 → 预设名"的表，现在那张表已经删了 —— 预设按模型归属）
  mode.value = m;
}
async function savePreset() {
  if (!bridge || !bridge.presets) { toast(t('请使用桌面版保存预设'), 'warn'); return; }
  const name = await app.promptDialog({ title: t('保存预设'), value: '' });
  if (!name || !name.trim()) return;
  // ★ 预设存**全量快照**（collectPresetParams），不是发给引擎的稀疏 cfg ——
  //   否则"保存当前参数"只会存下被显式改动过的那几项，应用时还原不回来。
  const params = collectPresetParams();
  try {
    const r = await bridge.presets.save(name.trim(), mode.value, params);
    if (r && r.ok) { toast(t('预设已保存'), 'ok'); loadPresets(); }
    else toast(t('保存预设失败：') + ((r && r.error) || ''), 'warn');
  } catch (e) {}
}
async function delPreset() {
  if (!bridge || !bridge.presets || !presetSel.value) return;
  if (!await app.confirmDialog({ msg: t('删除预设「') + presetSel.value + t('」') + t('？') })) return;
  try {
    const r = await bridge.presets.delete(presetSel.value);
    if (r && r.ok) { toast(t('预设已删除'), 'ok'); loadPresets(); }
  } catch (e) {}
}
async function openPresetMgr() {
  presetMgrOpen.value = true;
  await loadPresets();
}
async function mgrApply(name) {
  if (applyPreset(name)) {
    await bindPresetToCurrentModel(name);
    if (bridge && bridge.presets && bridge.presets.lastUsed) {
      try { await bridge.presets.lastUsed(name); } catch (e) {}
    }
  }
  presetMgrOpen.value = false;
  toast(t('已应用预设：') + name, 'ok');
}
async function mgrDelete(name) {
  if (!bridge || !bridge.presets) return;
  if (!await app.confirmDialog({ msg: t('删除预设「') + name + t('」') + t('？') })) return;
  try {
    const r = await bridge.presets.delete(name);
    if (r && r.ok) { toast(t('预设已删除'), 'ok'); await loadPresets(); }
    else toast(t('删除失败：') + ((r && r.error) || ''), 'warn');
  } catch (e) {}
}
async function mgrRestore() {
  if (!bridge || !bridge.presets || !bridge.presets.restore) return;
  try {
    const r = await bridge.presets.restore();
    if (r && r.ok) { toast(t('已恢复全部内置预设'), 'ok'); await loadPresets(); }
    else toast(t('恢复失败'), 'warn');
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
    else toast(t('排序失败'), 'warn');
  } catch (e) {}
}

/* ---------------- 参数收集 ---------------- */
function collectParams() {
  const cfg = {
    onset_threshold: parseFloat(onset.value.toFixed(2)),
    frame_threshold: parseFloat(frame.value.toFixed(2)),
    min_note_length: parseInt(minNote.value, 10),
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
    // 低音增强（basic 子模型）：melodia trick 会额外强化主旋律、相对压制伴奏声部，
    // 旋律密集时低音容易被吞；关闭后低音声部保留更完整。下限 40Hz 过滤次声噪声。
    // ★ 2026-10-14：只设 no_melodia。原先这里顺带 `cfg.min_freq = 40`，
    //   会把用户自己设的「最低音高」覆盖掉；用户决定**显式控件优先**。
    if (bassBoost.value && umodel.value === 'basic') {
      cfg.no_melodia = true;
    }
    if (umodel.value === 'muscriptor') {
      cfg.model_size = msSize.value;
      cfg.beat_grid = beatGrid.value;
      cfg.muscriptor_instruments = msInstrValue.value;
      if (msMode.value === 'probe_segments') cfg.probe_segment_sec = Number(msProbeSegSec.value) || 60;
      // 乐器组约束：'auto' / '人声,鼓' 这样的组名列表 / 空。
      // 注意这条链路有三跳（渲染端 → 主进程 worker 请求体 → 引擎），少任何一跳界面选了都不生效。
      // ★ 2026-10-14 更正：这段注释原先描述的是**已被移除**的批量推理行为
      //   （`bca0a55`「移除批量推理功能」）。现在：
      //   · `prelude_forcing` 是**独立开关**（见下面的 msPrelude），与性能档无关；
      //     2026-10-18b 起这个开关的**实现换了**：不再让模型 teacher-force 跨块 tie
      //     （那是僵尸长音的产地），改成解码后按「同轨同音高 + 边界两侧相接」缝合（见
      //     engine_muscriptor._stitch_chunk_boundaries）。界面开关含义不变：开＝要延音连续。
      //   · 性能档只决定「线程数」与 engine_pt 的**批量前向上限**：
      //       quality → 全核 + 上限 32（CUDA）/ 16（CPU）
      //       balanced → 4 核 + 16 / 8
      //       fast     → 2 核 + 8 / 4
      //     —— 所以同机上 `quality` 反而最快，`fast` 是给低配/小显存机器防 OOM 的。
      //   · 旧的显存实测（RTX 5070 Ti 12GB：medium batch=4 峰值 4.2GB / batch=8 峰值 7.9GB
      //     仅余 2GB / batch=16 触发驱动回退、速度暴跌 5 倍）仍解释了
      //     `engine_pt._PERF_BATCH` 为什么封在 32 —— 保留作依据，但它已不决定界面行为。
    }
  }
  // ④ 批 A：上面三个 if 之外，还有一批「引擎早就有、界面没入口」的选项。
  // 默认值都保持原行为：不勾不改时发出去的请求与旧版一致。
  if (mode.value === 'universal') {
    if (exportTempo.value > 0) cfg.tempo = exportTempo.value;
    if (umodel.value === 'basic' && pitchBends.value) cfg.multiple_pitch_bends = true;
    if (umodel.value === 'basic' && maxFreq.value > 0) cfg.max_freq = maxFreq.value;
    if (umodel.value === 'basic' && minFreq.value > 0) cfg.min_freq = minFreq.value;
    if (umodel.value === 'muscriptor') {
      if (msTemp.value !== 1.0) cfg.temperature = msTemp.value;
      if (msCfg.value !== 1.0) cfg.cfg_coef = msCfg.value;
      if (msBeam.value > 1) cfg.beam_size = msBeam.value;
      // 开（默认）不传参数 = 引擎默认「缝合延音」；关掉才显式 false = 不缝合
      if (!msPrelude.value) cfg.prelude_forcing = false;
      if (msPrec.value && msPrec.value !== 'fp32') cfg.precision = msPrec.value;
    }
  }
  // 识别片段长度：0 = 各模型默认，不传；>0 时所有转录模型共用同一个键（引擎按模型映射）
  if (mode.value !== 'separate' && Number(segmentSec.value) > 0) cfg.segment_sec = Number(segmentSec.value);
  // 转录前降噪（默认 off = 旧行为；只有显式选择才发送）
  if (mode.value !== 'separate' && denoiseMode.value && denoiseMode.value !== 'off') cfg.denoise_mode = denoiseMode.value;
  if (mode.value !== 'separate' && memoryMode.value) cfg.memory_mode = memoryMode.value;
  if (mode.value === 'separate') {
    cfg.with_drums = drums.value;
    cfg.export_stems = stemExport.value;
    cfg.stem_format = stemFormat.value || 'wav';
    cfg.sep_model = sepModel.value;
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
  if (!isDesktop) { toast(t('请使用桌面版 FuFumidi 进行转录'), 'warn'); return; }
  const activeQ = currentQueue();
  const chain = !!chainMode.value;
  let work = [];
  if (chain) {
    work = queueOrderFrom(activeQ && activeQ.id).filter((q) => pendingItemsOf(q).length);
  } else if (activeQ && pendingItemsOf(activeQ).length) {
    work = [activeQ];
  }
  if (!work.length) {
    const doneN = (activeQ && Array.isArray(activeQ.items) ? activeQ.items : []).filter((i) => i.status === 'done').length;
    toast(doneN ? t('队列已完成，可清空后继续添加音频') : t('请先选择音频文件'), doneN ? 'ok' : 'warn');
    return;
  }
  running.value = true; paused.value = false; cancelAll.value = false; busy.value = true; done.value = false; progress.value = 3; stage.value = '';
  userPinnedQueue = false;
  try { if (bridge && bridge.setTranscribePause) bridge.setTranscribePause(false); } catch (e) {}
  const para = Math.max(1, Math.min(4, parseInt(localStorage.getItem('fufumidi_parallel') || '1', 10) || 1));
  const totals = {
    total: work.reduce((s, q) => s + pendingItemsOf(q).length, 0),
    done: 0, err: 0, queueIndex: 0, queueCount: work.length,
  };
  logLine(chain
    ? t('顺序转录：共 ') + work.length + t(' 个队列 / ') + totals.total + t(' 首')
    : t('转录队列：共 ') + totals.total + t(' 首') + (para > 1 ? t('，并行 ') + para + t(' 路') : t('，顺序处理')));
  let runQ = null;
  let runItems = [];
  const t0 = Date.now();
  clearInterval(trTimer);
  trTimer = setInterval(() => {
    if (paused.value) {
      const left = runItems.filter((i) => i.status === 'pending').length;
      stage.value = t('已暂停') + (left ? ' · ' + t('已暂停：还剩 {n} 首').replace('{n}', String(left)) : '') + (chain ? ' · ' + t('队列 ') + totals.queueIndex + '/' + totals.queueCount : '');
      return;
    }
    const doneN = runItems.filter((i) => i.status === 'done').length;
    const errN = runItems.filter((i) => i.status === 'error').length;
    const cur = runItems.find((i) => i.status === 'running');
    let curP = 0;
    if (cur) {
      if (cur.realPct > 0) curP = Math.min(99, cur.realPct);
      else if (cur.progress >= 100) curP = 100;
      else if (cur.progress > 0) curP = cur.progress;
      else if (cur.startedAt && cur.estMs) curP = Math.min(95, Math.round((Date.now() - cur.startedAt) / cur.estMs * 100));
      if (curP > 0 && curP < 100) cur.progress = curP;
      const elS = (Date.now() - (cur.startedAt || Date.now())) / 1000;
      const estS = ((cur.estMs || estSec() * 1000 || 60000)) / 1000;
      const remains = Math.max(0, Math.round(estS - elS));
      stage.value = (chain ? t('队列 ') + totals.queueIndex + '/' + totals.queueCount + ' · ' : '')
        + t('已用 ') + fmtTime(elS) + (remains > 0 ? ' · ' + t('剩余约 ') + fmtTime(remains) : '');
    }
    const _allDone = Math.max(1, totals.total);
    progress.value = Math.max(3, Math.min(95, Math.round(((totals.done + totals.err) + curP / 100) / _allDone * 100)));
    if (!cur) stage.value = t('完成 ') + (totals.done + totals.err) + ' / ' + totals.total + (totals.err ? t(' · 失败 ') + totals.err : '') + ' · ' + fmtTime((Date.now() - t0) / 1000);
  }, 500);

  const runningJobIds = new Set();
  try { window.__fufumidiRunningJobs = runningJobIds; } catch (e) {}
  const processOne = async (it, cfgBase, target) => {
    it.status = 'running'; it.progress = 0; it.realPct = 0; it.error = '';
    it.startedAt = Date.now();
    await decodeDuration(it);
    it.estMs = Math.max(5000, estSec() * 1000 || 60000);
    const jid = 'batch' + it.id;
    runningJobIds.add(jid); currentJobId.value = jid;
    logLine('→ ' + it.name);
    try {
      const cfg = Object.assign({}, cfgBase);
      cfg.audio = it.path; cfg.id = jid; cfg.out = null;
      cfg.mode = (runQ && runQ.mode) || mode.value;
      cfg.perf = (runQ && runQ.perf) || perf.value;
      cfg.__slots = para;
      const res = await bridge.convert(cfg);
      if (cancelAll.value) it.status = 'canceled';
      else if (res && res.ok && res.out) {
        it.status = 'done'; it.progress = 100; it.out = res.out; it.note_count = res.note_count || 0;
        totals.done += 1;
        try {
          const bytes = await bridge.readBinary(res.out);
          if (bytes) { await importFiles([{ name: String(res.out).replace(/^.*[\\/]/, ''), bytes }], target); }
        } catch (e) {}
      } else {
        it.status = 'error'; it.error = (res && res.error) || (res ? 'code ' + res.code : '');
        totals.err += 1;
        logLine(it.name + t('：') + it.error, true);
      }
    } catch (e) {
      if (cancelAll.value) it.status = 'canceled';
      else { it.status = 'error'; it.error = (e && e.message) || String(e); totals.err += 1; logLine(it.name + t('：') + it.error, true); }
    }
    runningJobIds.delete(jid);
    const rest = [...runningJobIds];
    currentJobId.value = rest.length ? rest[rest.length - 1] : null;
    persistQueues();
  };
  const runQueue = async (q, qi) => {
    runQ = q; runningQueueId.value = q.id; totals.queueIndex = qi + 1;
    if (!userPinnedQueue) { activeQid.value = q.id; loadQueueSettings(q); }
    // 取这个队列自己的参数快照：如果用户把视图切到了别的队列，临时加载本队列设置取完再切回
    let cfgBase;
    if (activeQid.value === q.id) {
      cfgBase = collectParams();
    } else {
      const prevId = activeQid.value; const prevQ = currentQueue();
      loadQueueSettings(q);
      cfgBase = collectParams();
      if (prevQ) { activeQid.value = prevId; loadQueueSettings(prevQ); }
    }
    if (activeQid.value === q.id) q.items = queue.slice();
    q.items = Array.isArray(q.items) ? q.items : [];
    runItems = q.items;
    const target = effectiveTarget(q);
    const targetLabel = targetName(target);
    logLine(t('开始队列：') + q.name + (chain ? '（' + totals.queueIndex + '/' + totals.queueCount + '）' : '') + t(' · 产物：') + targetLabel);
    const worker = async () => {
      while (true) {
        if (cancelAll.value) break;
        const it = (q.items || []).find((x) => x.status === 'pending');
        if (!it) break;
        while (paused.value && !cancelAll.value) await new Promise((r) => setTimeout(r, 200));
        if (cancelAll.value) break;
        await processOne(it, cfgBase, target);
      }
    };
    await Promise.all(Array.from({ length: para }, () => worker()));
    if (activeQid.value === q.id) queue.splice(0, queue.length, ...(q.items || []));
    persistQueues();
    // 暂停时不要启动下一个队列（继续按钮会解除暂停）
    while (paused.value && !cancelAll.value) await new Promise((r) => setTimeout(r, 200));
  };
  for (let qi = 0; qi < work.length; qi++) {
    if (cancelAll.value) break;
    await runQueue(work[qi], qi);
  }
  running.value = false; busy.value = false; runningQueueId.value = 0;
  clearInterval(trTimer);
  if (runQ && activeQid.value === runQ.id) queue.splice(0, queue.length, ...(runQ.items || []));
  persistQueues();
  const dN = totals.done; const eN = totals.err;
  progress.value = dN && !eN ? 100 : (dN ? Math.round(dN / Math.max(1, totals.total) * 100) : progress.value);
  if (dN && !eN) {
    const last = runItems.filter((i) => i.status === 'done').pop();
    if (last) { lastOut.value = last.out; doneInfo.value = t('成功 ') + dN + t(' 首') + (last.note_count != null ? ' · ' + last.note_count + t(' 个音符') : ''); logLine(doneInfo.value); }
    done.value = true;
    toast(chain ? t('顺序转录完成：成功 ') + dN + t(' 首（各队列产物已按各自歌单加入）') : t('批量转录完成：成功 ') + dN + t(' 首'), 'ok');
  } else if (dN) {
    logLine(t('[失败] ') + eN + t(' 首失败，可在队列中点击「重试」。'), true);
    toast(t('批量转录完成：成功 ') + dN + t(' 首，失败 ') + eN + t(' 首'), 'warn');
  } else if (eN) {
    logLine(t('[失败] ') + eN + t(' 首失败，可在队列中点击「重试」。'), true);
    toast(t('转录失败'), 'warn');
  }
  if (cancelAll.value && !paused.value) logLine(t('已取消转录队列…'), true);
  if (!cancelAll.value && (dN || eN)) playTranscribeDoneChime(eN > 0);
}
/** 转录完成后播放短提示音（Web Audio 合成，不依赖外部音频文件）。
 *  成功两声上行、失败两声下行；只在批次结束且非取消时调用一次。 */
function playTranscribeDoneChime(failed = false) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const t0 = ctx.currentTime;
    const freqs = failed ? [392, 311] : [659.25, 880.0, 1318.5];
    freqs.forEach((f, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = f;
      const at = t0 + i * 0.11;
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.18, at + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.18);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(at); osc.stop(at + 0.2);
    });
    setTimeout(() => { try { ctx.close(); } catch (e) {} }, 900);
  } catch (e) {}
}

async function startTranscribe() {
  if (busy.value) return;
  const chain = !!chainMode.value;
  const activeQ = currentQueue();
  const activePending = activeQ ? pendingItemsOf(activeQ).length : 0;
  const pending = chain ? queues.reduce((s, q) => s + pendingItemsOf(q).length, 0) : activePending;
  if (!pending) { toast(t('请先选择音频文件'), 'warn'); return; }
  const est = estSec();
  const first = activeQ && pendingItemsOf(activeQ)[0] ? pendingItemsOf(activeQ)[0].name : '';
  const msg = chain
    ? t('确认开始转录？') + '\n' + t('顺序转录全部队列：') + queues.filter((q) => pendingItemsOf(q).length).length + t(' 个队列，共 ') + pending + t(' 首')
    : t('确认开始转录？\n文件：') + first + t('\n模式：') + (MODE_NAMES()[mode.value] || mode.value) + t('\n质量：') + (PERF_NAMES()[perf.value] || perf.value) + (est ? t('\n预计耗时：约 ') + fmtTime(est) : '');
  const ok = await app.confirmDialog({ title: t('开始转录'), msg, okText: t('开始') });
  if (!ok) return;
  runBatch();
}
/* ---------------- 暂停 / 继续（用户 2026-10-14 要求） ----------------
   语义：**当前这首跑完就停**。中途硬停会白扔这一首已经算的部分（引擎只在收尾时落盘 MIDI，
   没有单文件断点），所以暂停落在「不再启动下一首」这个边界上；继续 = 从剩下的 pending 接着跑。 */
function pauseBatch() {
  if (!running.value || paused.value) return;
  paused.value = true;
  try { if (bridge && bridge.setTranscribePause) bridge.setTranscribePause(true); } catch (e) {}
  // 暂停点在哪取决于引擎（引擎侧见 engine/pause_gate.py 的表）：
  //  · MuScriptor 卡在 5 秒块之间、basic-pitch 卡在取窗之间 → 当场停住，继续时从原处接着跑；
  //  · 钢琴 piano_pt 卡在我们自己的分批前向之间 → 手里这一批算完就停（秒级），同样不重算；
  //  · Aria-AMT / Transkun 是外部工具、一次调用跑完整首 → 这一首跑完再停（下一首不再启动）。
  const _rq = queues.find((q) => q.id === runningQueueId.value) || currentQueue();
  const _rmode = (_rq && _rq.mode) || mode.value;
  const _rpmodel = (_rq && _rq.pmodel) || pmodel.value;
  const pianoFast = _rmode === 'piano' && _rpmodel === 'piano_pt';
  const midFile = _rmode !== 'piano' || pianoFast;
  stage.value = t('已暂停');
  logLine(pianoFast
    ? t('已暂停：当前这首算完手里这一批就停住，点「继续」接着跑')
    : midFile ? t('已暂停：当前这首当场停住，点「继续」接着跑')
              : t('已暂停：当前这首跑完停住，点「继续」接着跑'));
  toast(t('已暂停'), 'ok');
}
function resumeBatch() {
  if (!paused.value) return;
  paused.value = false;
  try { if (bridge && bridge.setTranscribePause) bridge.setTranscribePause(false); } catch (e) {}
  logLine(t('继续转录…'));
  toast(t('继续转录'), 'ok');
  // 正常情况下 worker 还挂在原来的那一首上（不重启、不重算）；只有「暂停恰好落在两首之间、
  // worker 已退出」这种边界情况才需要重新起跑。
  if (!running.value) runBatch();
}
function cancelTranscribe() {
  if (!busy.value && !paused.value) return;
  cancelAll.value = true;
  paused.value = false;
  try { if (bridge && bridge.setTranscribePause) bridge.setTranscribePause(false); } catch (e) {}   // 引擎不能卡在暂停里
  stage.value = '';
  // 并行模式下取消所有在跑任务
  const jobs = window.__fufumidiRunningJobs || [];
  for (const jid of jobs) { if (bridge && bridge.cancel) bridge.cancel(jid); }
  if (currentJobId.value && bridge && bridge.cancel) bridge.cancel(currentJobId.value);
  logLine(t('已请求取消转录队列…'), true);
}
function openOutput() {
  if (!lastOut.value) return;
  if (bridge && bridge.openOutput) bridge.openOutput(lastOut.value);
  else toast(t('请使用桌面版打开输出文件夹'), 'warn');
}

/* ---------------- 智能修正 ---------------- */
async function pickRfAudio() {
  if (bridge && bridge.pickAudio) { try { const p = await bridge.pickAudio(); if (p) rf.audio = p; } catch (e) {} }
  else toast(t('请使用桌面版 FuFumidi 选择音频'), 'warn');
}
async function pickRfMidi() {
  if (bridge && bridge.pickFile) {
    try { const p = await bridge.pickFile({ filters: [{ name: 'MIDI', extensions: ['mid', 'midi', 'kar', 'rmi'] }] }); if (p) rf.midi = p; } catch (e) {}
  } else toast(t('请使用桌面版 FuFumidi 选择 MIDI'), 'warn');
}
function rl(txt, isErr) {
  rf.logs.push({ txt, isErr: !!isErr });
  if (rf.logs.length > 500) rf.logs.splice(0, rf.logs.length - 500);
}
async function startRefine() {
  if (rf.busy) return;
  if (!rf.midi || !rf.audio) { toast(t('请先导入原音频与 MIDI 文件'), 'warn'); return; }
  if (!bridge || !bridge.refine) { toast(t('请使用桌面版 FuFumidi 进行修正'), 'warn'); return; }
  rf.busy = true; rf.jobId++; rf.progress = 0; rf.logs = [];
  rl(t('开始智能修正…（对齐起音 / 还原力度 / ') + (rf.mode === 'vocal' ? t('声部平衡') : t('清理杂音')) + t('）'));
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
      toast(t('智能修正完成'), 'ok');
    } else {
      rl(t('[失败] 修正未成功：') + (res.error || t('请查看上方日志。')), true);
      toast(t('修正失败'), 'warn');
    }
  } catch (e) {
    rl(t('[错误] ') + (e.message || String(e)), true);
    toast(t('修正失败'), 'warn');
  } finally {
    rf.busy = false;
  }
}
async function openRefineResult() {
  try {
    const bytes = await bridge.readBinary(rf.midi);
    if (!bytes) { toast(t('修正输出文件不存在或已被删除'), 'warn'); return; }
    await importFiles([{ name: String(rf.midi).replace(/^.*[\\/]/, ''), bytes }]);
    setView('edit');
    toast(t('已载入修正结果'), 'ok');
  } catch (err) { toast(t('载入失败：') + err.message, 'warn'); }
}

/* ---------------- 引擎日志 ---------------- */
let offLog = null, offRefine = null, offModelProg = null, offSeparate = null, offSepProg = null;
onMounted(() => {
  window.addEventListener('keydown', onDocKeydown);   // 模型选择抽屉：Esc 关闭
  loadQueue();
  loadPresets();
  loadMsPresets();
  loadPerfDefault();
  probeEngine();
  refreshModelStatus();
  if (bridge && bridge.onEngineLog) {
    offLog = bridge.onEngineLog(p => {
      if (!p) return;
      // MuScriptor 真实分块进度（引擎侧 ###PROG 前缀）：只更新进度，不进日志面板
      const ln = p.line ? String(p.line).trim() : '';
      if (ln.indexOf('###PROG ') === 0) {
        try {
          const d = JSON.parse(ln.slice(8));
          const qid = parseInt(String(p.id).replace(/^batch/, ''), 10);
          const it = queue.find((x) => x.id === qid);
          if (it && d && d.total > 0) it.realPct = Math.min(99, Math.round(d.completed / d.total * 100));
        } catch (e) {}
        return;
      }
      if (p.id === currentJobId.value || String(p.id).indexOf('batch') === 0) {
        if (p.line) logLine(p.line);   // 详细引擎日志进日志面板；stage 由统一进度信息接管
      }
    });
  }
  if (bridge && bridge.onRefineLog) {
    offRefine = bridge.onRefineLog(p => { if (p && p.id === rf.jobId && p.line) rl(p.line); });
  }
  if (bridge && bridge.onModelProgress) {
    offModelProg = bridge.onModelProgress(p => { if (p && p.done) refreshModelStatus(); });
  }
  if (bridge && bridge.onSeparateLog) {
    offSeparate = bridge.onSeparateLog(p => { if (p && p.id === 'sep' + sepJobId.value && p.line) logSep(p.line); });
  }
  if (bridge && bridge.onSeparateProgress) {
    offSepProg = bridge.onSeparateProgress(p => {
      if (!p || p.id !== 'sep' + sepJobId.value || p.percent == null) return;
      const pct = Math.round(p.percent);
      sepProgress.value = Math.max(sepProgress.value, Math.min(100, pct));
      const el = (Date.now() - sepStartAt.value) / 1000;
      const frac = Math.max(0.01, p.percent / 100);
      const eta = Math.max(0, Math.round(el / frac * (1 - frac)));
      sepStage.value = t('分块处理 ') + pct + '% · ' + t('已用 ') + fmtTime(el) + (eta > 0 ? ' · ' + t('剩余约 ') + fmtTime(eta) : '');
    });
  }
  // E2E/调试钩子：只暴露队列操作，不改变正常交互；用于无文件对话框验证
  // 「运行中切换队列」「顺序转录」两条真实流程（见 scripts/e2e/cases/transcribe-queue-chain.mjs）。
  try {
    window.__fufumidiTranscribe = {
      addPaths,
      runBatch,
      switchQueue,
      setChainMode,
      state: () => ({
        running: running.value, paused: paused.value, runningQueueId: runningQueueId.value,
        activeQid: activeQid.value, chainMode: chainMode.value,
        queues: queues.map((q) => ({ id: q.id, name: q.name, playlistTarget: q.playlistTarget || '', items: (q.items || []).map((i) => ({ id: i.id, name: i.name, status: i.status, note_count: i.note_count || 0 })) })),
      }),
    };
  } catch (e) {}
});
onBeforeUnmount(() => {
  try { delete window.__fufumidiTranscribe; } catch (e) {}
  try { window.removeEventListener('keydown', onDocKeydown); } catch (e) {}
  if (trTimer) clearInterval(trTimer);
  if (offLog) offLog();
  if (offRefine) offRefine();
  if (offModelProg) { try { offModelProg(); } catch (e) {} offModelProg = null; }
  if (offSeparate) { try { offSeparate(); } catch (e) {} offSeparate = null; }
  if (offSepProg) { try { offSepProg(); } catch (e) {} offSepProg = null; }
});
</script>

<template>
  <div ref="pageEl" class="page tr-view">
    <div class="page-head">
      <div class="page-ic"><Icon name="transcribe" :size="20" /></div>
      <div class="grow">
        <div class="page-title">{{ t('转录') }}</div>
        <div class="page-sub">{{ t('音频转 MIDI · 本地 Python 引擎 · 离线完成') }}</div>
      </div>
      <span v-if="gpuInfo" class="tag accent">{{ gpuInfo }}</span>
      <button class="btn sm ghost" @click="state.ui.settingsTab = 'gpu'; state.ui.settingsOpen = true">{{ t('GPU 加速') }}</button>
      <span class="tag" :class="isDesktop ? '' : 'warn-tag'">{{ isDesktop ? t('桌面引擎就绪') : t('请使用桌面版') }}</span>
    </div>

    <!-- 音频选择：三种模式**同一个位置、同一套虚线框**（音频处理以前是自己一套图标行） -->
    <Transition name="trSwap" mode="out-in">
    <div v-if="mode === 'separate'" class="card tr-drop-card">
      <div class="tr-drop" @click="pickSepFile">
        <div class="td-ic"><Icon name="transcribe" :size="26" /></div>
        <div class="td-txt">
          <b>{{ sepFile ? String(sepFile).replace(/^.*[\\/]/, '') : t('拖入音频 / 点击选择') }}</b>
          <span>{{ t('支持 MP3 / WAV / FLAC / M4A 等 · ') }}{{ sepDur ? fmtTime(sepDur) : t('（未选择）') }}</span>
        </div>
      </div>
    </div>
    <div v-else class="card tr-drop-card">
      <div class="tr-drop" :class="{ over: dropOver }" data-guide="audio-drop"
           @dragover.prevent="dropOver = true" @dragleave="dropOver = false" @drop.prevent="onDrop"
           @click="pickAudio">
        <div class="td-ic"><Icon name="transcribe" :size="26" /></div>
        <div class="td-txt">
          <b>{{ dropOver ? t('释放以上传') : t('拖入音频 / 点击选择') }}</b>
          <span>{{ t('支持多选 · MP3 / WAV / FLAC / M4A / 视频') }}</span>
        </div>
        <input ref="fileInput" type="file" accept="audio/*,video/*" hidden multiple @change="onFileChange">
      </div>
      <div v-if="audioInfo" class="tr-audio-info"><Icon name="music" :size="13" /> {{ audioInfo }}</div>
      <div ref="waveBox" class="tr-wave hidden"><canvas ref="waveEl" width="700" height="64"></canvas></div>
      <div class="tr-batch-head">
        <div>
          <div class="fb-label">{{ t('转录队列') }}</div>
          <div class="fb-hint">{{ t('支持多选 / 文件夹 / 顺序转录 / 完成后加入歌单') }}</div>
        </div>
        <div class="tr-batch-ctls">
          <button class="btn sm" @click="pickAudio"><Icon name="plus" :size="13" />{{ t('文件') }}</button>
          <button class="btn sm" @click="pickFolder"><Icon name="folder" :size="13" /> {{ t('文件夹') }}</button>
          <button v-if="busy && !paused" class="btn sm" @click="pauseBatch"><Icon name="pause" :size="13" />{{ t('暂停') }}</button>
          <button v-else-if="paused" class="btn sm" @click="resumeBatch"><Icon name="play" :size="13" />{{ t('继续') }}</button>
          <button class="btn sm ghost" @click="retryAll">{{ t('重试全部') }}</button>
          <button class="btn sm ghost" @click="clearDone">{{ t('清空完成') }}</button>
          <select class="select-input" v-model="sort" style="width:auto;padding:4px 8px;font-size:var(--fs-xs)">
            <option value="default">{{ t('默认顺序') }}</option><option value="name">{{ t('按名称') }}</option>
            <option value="type">{{ t('按类型') }}</option><option value="duration">{{ t('按时长') }}</option>
          </select>
          <button class="btn sm danger" @click="clearQueue">{{ t('清空') }}</button>
        </div>
      </div>
      <div class="fb-hint" v-if="queue.length && sort !== 'default'" style="margin:-4px 0 6px">{{ t('拖动排序需切回「默认顺序」') }}</div>
      <!-- 多队列：切队列 = 切模型与参数（每个队列自带一份设置） -->
      <div v-if="queues.length" class="tr-queues">
        <span class="fb-label" style="margin:0">{{ t('队列') }}</span>
        <button v-for="q in queues" :key="q.id" class="fu-ctl fu-ctl--sm tr-pill" :class="{ active: q.id === activeQid }"
                :title="t('切换到这个队列（模型与参数一起切）') + ' · ' + queueSummary(q)"
                @click="switchQueue(q)">
          {{ q.name }}<i v-if="q.id === runningQueueId" class="tr-q-run" :title="t('正在转录')">▶</i><i v-if="queueCount(q)" class="tr-q-n">{{ queueCount(q) }}</i>
        </button>
        <button class="btn sm ghost" @click="addQueue"><Icon name="plus" :size="13" />{{ t('新建队列') }}</button>
        <button class="btn sm ghost" :disabled="!currentQueue()" @click="renameQueue(currentQueue())">{{ t('重命名') }}</button>
        <button class="btn sm ghost" :disabled="!currentQueue()" @click="duplicateQueue(currentQueue())">{{ t('复制') }}</button>
        <button class="btn sm ghost danger" :disabled="queues.length <= 1 || !currentQueue()" @click="removeQueue(currentQueue())">{{ t('删除队列') }}</button>
        <label class="tr-chain" data-guide="chain-queues" :title="t('打开后按队列顺序：一个队列跑完自动接着跑下一个（默认关）')">
          <input type="checkbox" :checked="chainMode" :disabled="running" @change="setChainMode($event.target.checked)">
          <span>{{ t('依次转录全部队列') }}</span>
        </label>
        <label class="tr-queue-target" data-guide="queue-playlist" :title="t('这个队列的转录产物完成后加入哪个歌单')">
          <span>{{ t('产物歌单') }}</span>
          <select class="select-input" :value="queueTarget(currentQueue())" :disabled="running || busy" @change="setQueueTarget">
            <option value="">{{ t('跟随当前歌单') }}</option>
            <option value="all">{{ t('仅加入全部曲目') }}</option>
            <option v-for="pl in playlist.playlists" :key="pl.id" :value="pl.id">{{ pl.name }}</option>
          </select>
        </label>
        <span class="fb-hint" v-if="currentQueue()">{{ t('本队列：') }}{{ queueSummary(currentQueue()) }} · {{ targetName(queueTarget(currentQueue())) }}</span>
      </div>
      <div v-if="queue.length" class="tr-batch-list">
        <div class="tr-batch-item" v-for="it in sortedQueue" :key="it.id"
             :draggable="sort === 'default'" :class="{ dragging: dragItemId === it.id }"
             @dragstart="trDragStart(it, $event)" @dragover.prevent="trDragOver($event, it)"
             @dragleave="trDragLeave($event)" @drop.stop.prevent="trDrop($event, it)" @dragend="trDragEnd()">
          <span class="tb-grip" :title="sort === 'default' ? t('拖动排序') : t('拖动排序需切回「默认顺序」')" aria-hidden="true">⋮⋮</span>
          <span class="tb-name" :title="it.path">{{ it.name }}</span>
          <span class="tb-bar"><i :style="{ transform: 'scaleX(' + ((Math.round(it.progress || 0)) / 100) + ')' }"></i></span>
          <span class="tb-badge" :class="it.status">{{ statusTxt(it.status) }}{{ it.status === 'done' && it.note_count ? ' · ' + it.note_count : '' }}</span>
          <button v-if="it.status === 'error'" class="btn sm ghost" @click="retryItem(it)">{{ t('重试') }}</button>
          <button v-else-if="it.status === 'pending' || it.status === 'done' || it.status === 'canceled'" class="btn sm ghost danger" @click="removeItem(it)">{{ t('移除') }}</button>
        </div>
      </div>
      <div class="tr-batch-stat muted small">{{ queueStat }}</div>
    </div>
    </Transition>

    <!-- 引擎模式 -->
    <div class="card tr-card">
      <div class="fb-label">{{ t('引擎模式') }}</div>
      <div class="tr-modes">
        <button class="tr-mode" :class="{ active: mode === 'universal' }" data-guide="mode-universal" @click="onModeChange('universal')">
          <b>{{ t('通用识别') }}</b><span>{{ t('任意歌曲 · 人声 · 多乐器') }}</span>
        </button>
        <button class="tr-mode" :class="{ active: mode === 'piano' }" data-guide="mode-piano" @click="onModeChange('piano')">
          <b>{{ t('钢琴专用') }}</b><span>{{ t('纯钢琴高精度 · 含踏板') }}</span>
        </button>
        <button class="tr-mode" :class="{ active: mode === 'separate' }" data-guide="mode-separate" @click="onModeChange('separate')">
          <b>{{ t('音频处理') }}</b><span>{{ t('选择处理模型 · 分离 / 修复') }}</span>
        </button>
      </div>

      <!-- ★ 切换动画：只包"随模式变化"的内容（引擎模式三张选择卡本身不动）
           方向感：往后切（通用→钢琴→音频）从右进、往回切从左进，比单纯淡入淡出"有说法" -->
      <Transition :name="swapDir === 'fwd' ? 'trSwapFwd' : 'trSwapBack'" mode="out-in" @after-leave="onSwapLeft">
      <div :key="mode" class="tr-mode-body">

      <!-- 通用子模型：Basic Pitch（兜底）/ MuScriptor（可选，三档规格） -->
      <div v-if="mode === 'universal'" class="tr-submodels">
        <div class="fb-label">{{ t('通用模型') }}</div>
        <div class="fu-ctl tr-pills">
          <button class="fu-ctl tr-pill" :class="{ active: umodel === 'basic' }" @click="umodel = 'basic'">{{ t('Basic Pitch · 内置兜底') }}<i v-if="modelInstalled('basic') !== null" class="fu-badge ms-badge" :class="modelInstalled('basic') ? 'ok' : 'miss'">{{ modelInstalled('basic') ? t('已下载') : t('未下载') }}</i></button>
          <button class="fu-ctl tr-pill" :class="{ active: umodel === 'muscriptor' }" @click="umodel = 'muscriptor'">MuScriptor<i v-if="currentModelInstalled() !== null" class="fu-badge ms-badge" :class="currentModelInstalled() ? 'ok' : 'miss'">{{ currentModelInstalled() ? t('已下载') : t('未下载') }}</i></button>
          <button class="fu-ctl tr-pill" :class="{ active: umodel === 'yourmt3' }" @click="umodel = 'yourmt3'">YourMT3+<i v-if="modelInstalled('yourmt3') !== null" class="fu-badge ms-badge" :class="modelInstalled('yourmt3') ? 'ok' : 'miss'">{{ modelInstalled('yourmt3') ? t('已下载') : t('未下载') }}</i></button>
          <button class="fu-ctl tr-pill" :class="{ active: umodel === 'miros' }" @click="umodel = 'miros'">MIROS<i v-if="modelInstalled('miros') !== null" class="fu-badge ms-badge" :class="modelInstalled('miros') ? 'ok' : 'miss'">{{ modelInstalled('miros') ? t('已下载') : t('未下载') }}</i></button>
        </div>
        <div v-if="umodel === 'muscriptor'" class="fu-ctl tr-pills">
          <button class="fu-ctl tr-pill" :class="{ active: msSize === 'small' }" @click="msSize = 'small'">Small · 100M<i v-if="modelInstalled('muscriptor_small') !== null" class="fu-badge ms-badge" :class="modelInstalled('muscriptor_small') ? 'ok' : 'miss'">{{ modelInstalled('muscriptor_small') ? t('已下载') : t('未下载') }}</i></button>
          <button class="fu-ctl tr-pill" :class="{ active: msSize === 'medium' }" @click="msSize = 'medium'">{{ t('Medium · 300M（推荐）') }}<i v-if="modelInstalled('muscriptor_medium') !== null" class="fu-badge ms-badge" :class="modelInstalled('muscriptor_medium') ? 'ok' : 'miss'">{{ modelInstalled('muscriptor_medium') ? t('已下载') : t('未下载') }}</i></button>
          <button class="fu-ctl tr-pill" :class="{ active: msSize === 'large' }" @click="msSize = 'large'">Large · 1.3B<i v-if="modelInstalled('muscriptor_large') !== null" class="fu-badge ms-badge" :class="modelInstalled('muscriptor_large') ? 'ok' : 'miss'">{{ modelInstalled('muscriptor_large') ? t('已下载') : t('未下载') }}</i></button>
        </div>
        <div class="tr-perf-hint" v-if="umodel === 'muscriptor'">{{ t('未下载时请到资源中心 → 模型文件 按规格下载') }}</div>
        <div class="tr-perf-hint" v-if="umodel === 'yourmt3'">{{ t('YourMT3+ 需先到资源中心下载运行时+权重（约 400 MB）') }}</div>
        <div class="tr-perf-hint" v-if="umodel === 'miros'">{{ t('MIROS 需先到资源中心下载运行时+权重（约 6 GB）') }}</div>
      </div>

      <!-- 钢琴子模型：piano-transcription / Aria-AMT / Transkun -->
      <div v-if="mode === 'piano'" class="tr-submodels">
        <div class="fb-label">{{ t('钢琴模型') }}</div>
        <div class="fu-ctl tr-pills">
          <button class="fu-ctl tr-pill" :class="{ active: pmodel === 'piano_pt' }" @click="pmodel = 'piano_pt'">{{ t('piano-transcription · 内置') }}<i v-if="modelInstalled('piano_pt') !== null" class="fu-badge ms-badge" :class="modelInstalled('piano_pt') ? 'ok' : 'miss'">{{ modelInstalled('piano_pt') ? t('已下载') : t('未下载') }}</i></button>
          <button class="fu-ctl tr-pill" :class="{ active: pmodel === 'aria' }" @click="pmodel = 'aria'">Aria-AMT<b class="tr-cuda" :title="t('Aria-AMT 需要 CUDA（NVIDIA 显卡 + CUDA 加速包）；没有 CUDA 时它无法转录')">{{ t('需 CUDA') }}</b><i v-if="modelInstalled('aria_amt') !== null" class="fu-badge ms-badge" :class="modelInstalled('aria_amt') ? 'ok' : 'miss'">{{ modelInstalled('aria_amt') ? t('已下载') : t('未下载') }}</i></button>
          <button class="fu-ctl tr-pill" :class="{ active: pmodel === 'transkun' }" @click="pmodel = 'transkun'">Transkun<i v-if="modelInstalled('transkun') !== null" class="fu-badge ms-badge" :class="modelInstalled('transkun') ? 'ok' : 'miss'">{{ modelInstalled('transkun') ? t('已下载') : t('未下载') }}</i></button>
          <button class="fu-ctl tr-pill" :class="{ active: pmodel === 'hft' }" @click="pmodel = 'hft'">hFT-Transformer<i v-if="modelInstalled('hft_transformer') !== null" class="fu-badge ms-badge" :class="modelInstalled('hft_transformer') ? 'ok' : 'miss'">{{ modelInstalled('hft_transformer') ? t('已下载') : t('未下载') }}</i></button>
        </div>
        <div class="tr-perf-hint" v-if="pmodel !== 'piano_pt'">{{ t('Aria-AMT / Transkun / hFT 需先到资源中心安装对应模型') }}</div>
        <div class="tr-perf-hint tr-warn" v-if="pmodel === 'aria' && !cudaReady">{{ t('当前没有可用的 CUDA（需 NVIDIA 显卡 + 已安装的 CUDA 加速包）。Aria-AMT 会报「CUDA device not found」——改用 piano-transcription 或 Transkun 可以正常转录。') }}</div>
      </div>

      <!-- 音频处理：当前模型 + 选择模型（与「通用模型 / 钢琴模型」同一种 pill 行） -->
      <div v-if="mode === 'separate'" class="tr-submodels">
        <div class="fb-label">{{ t('处理模型') }}</div>
        <div class="fu-ctl tr-pills">
          <button class="fu-ctl tr-pill active" @click="sepPickerOpen = true">
            {{ currentSep ? currentSep.name : t('内置 Demucs') }}
            <i class="fu-badge ms-badge ok">{{ currentSep ? (currentSep.arch + ' · ' + fmtSize2(currentSep.size)) : t('HTDemucs · 内置') }}</i>
          </button>
          <button class="fu-ctl tr-pill ghost-like" @click="sepPickerOpen = true"><Icon name="search" :size="13" />{{ t('更换模型') }}</button>
        </div>
        <div v-if="sepPurposeOf(currentSep) === 'repair'" class="tr-slider-hint">{{ t('这是去噪 / 修复模型：输出「噪声」与「已去噪」两条音轨，不用于人声 / 伴奏分离') }}</div>
        <div v-else-if="sepIsVr" class="tr-slider-hint">{{ t('VR 模型的音轨名由权重自身决定，面板不预置音轨选项；不勾选即全部输出') }}</div>
      </div>

      <!-- 模型选择抽屉（搜索 + 分类 + 网格） -->
      <Teleport to="body">
      <Transition name="sepFade">
        <div v-if="sepPickerOpen" class="sep-scrim" @click.self="sepPickerOpen = false">
          <div class="sep-pane">
            <div class="sep-head">
              <b><Icon name="box" :size="15" /> {{ t('选择音频处理模型') }}</b>
              <span class="sep-head-n">{{ sepModelsFiltered.length }} / {{ sepModels.length }}</span>
              <button class="icon-btn" style="margin-left:auto" @click="sepPickerOpen = false"><Icon name="close" :size="15" /></button>
            </div>
            <div class="sep-tools">
              <label class="sep-search">
                <Icon name="search" :size="14" />
                <input class="text-input" v-model="sepQuery" :placeholder="t('搜索模型名称 / 架构 / 用途…')">
                <button v-if="sepQuery" class="icon-btn" @click="sepQuery = ''"><Icon name="close" :size="12" /></button>
              </label>
              <div class="fu-ctl tr-pills">
                <button class="fu-ctl tr-pill" :class="{ active: sepCat === 'all' }" @click="sepCat = 'all'">{{ t('全部') }}<i class="sep-cnt">{{ sepCatCounts.all }}</i></button>
                <button class="fu-ctl tr-pill" :class="{ active: sepCat === 'separate' }" @click="sepCat = 'separate'">{{ t('人声分离') }}<i class="sep-cnt">{{ sepCatCounts.separate }}</i></button>
                <button class="fu-ctl tr-pill" :class="{ active: sepCat === 'repair' }" @click="sepCat = 'repair'">{{ t('修复 · 去噪') }}<i class="sep-cnt">{{ sepCatCounts.repair }}</i></button>
                <button class="fu-ctl tr-pill ghost-like" :class="{ active: sepOnlyReady }" :title="t('已下载但缺配置文件的模型跑不起来，勾上就看不到它们')" @click="sepOnlyReady = !sepOnlyReady">{{ t('只显示可用') }}</button>
              </div>
            </div>
            <div class="sep-hint">{{ t('已下载的模型可直接选用；未下载的模型请先到模型管理下载') }}</div>
            <div class="sep-list">
              <div v-for="m in sepModelsFiltered" :key="m.id" class="sep-item" :class="{ sel: sepModel === m.id, off: !m.exists }" @click="pickSep(m)">
                <div class="si-head">
                  <span class="si-ic"><Icon :name="sepKindIcon(m)" :size="14" /></span>
                  <span class="si-arch">{{ m.arch }}</span>
                  <span class="si-kind" :class="m.kind === 'other' ? 'vr' : ''">{{ sepKindName(m) }}</span>
                  <span class="fu-badge si-pill" :class="(m.exists && m.sepReady !== false) ? 'on' : 'off'"
                        :title="m.sepWhy && m.sepWhy.indexOf('配置') >= 0 ? t('本机没有这个模型的配置文件（.yaml），下载后也加载不了') : (m.sepWhy ? t(m.sepWhy) : '')">{{
                    !m.exists ? (String(m.sepWhy || '').indexOf('配置') >= 0 ? t('缺配置') : t('未下载'))
                              : (m.sepReady === false ? t('不可用') : t('已下载')) }}</span>
                </div>
                <div class="si-name">{{ m.name }}<span v-if="m.best" class="si-best" :title="t('该领域效果最佳')">👑 {{ m.best }}</span></div>
                <div class="si-use">{{ m.use || m.note || '' }}</div>
                <div v-if="m.useLabel" class="si-usage">{{ t('用途：') }}{{ t(m.useLabel) }}</div>
                <div v-if="m.useNotFor" class="si-notfor">{{ t('注意：') }}{{ t(m.useNotFor) }}</div>
                <div class="si-foot">
                  <span>{{ fmtSize2(m.size) }}<i v-if="m.sepAuto" class="si-auto" :title="t('这个模型上游没有带 .yaml：引擎会从权重本身推出结构，生成后跑一次前向校验再使用（只生成一次）')">{{ t('首次自动配置') }}</i></span>
                  <span v-if="m.exists" class="si-check" :class="{ cur: sepModel === m.id }">{{ sepModel === m.id ? t('使用中') : t('使用') }}</span>
                </div>
              </div>
              <div v-if="!sepModelsFiltered.length" class="sep-none">{{ sepModels.length ? (sepOnlyReady && !sepQuery.trim() && sepCat === 'all' ? t('本机没有「已下载且可用」的处理模型（缺配置的下载后也跑不起来）；取消勾选「只显示可用」可查看全部') : t('没有匹配的模型（清空搜索或换分类）')) : t('没有可选模型（请到模型管理查看）') }}</div>
            </div>
          </div>
        </div>
      </Transition>
      </Teleport>

      <!-- 音频处理（MSST 分离）工作区 -->
      <div v-if="mode === 'separate'" class="tr-msst">
        <div class="tr-submodels">
          <div class="fb-label">{{ t('推理参数') }} <small class="ms-mut">{{ t('（与 MSST-WebUI 一致 · 支持按模型保存预设）') }}</small></div>
          <!-- 与「高级参数」里的滑条同一种排法：label + 值 → 滑条 → 说明 -->
          <div class="tr-slider">
            <label>{{ t('分块大小') }} chunk_size<b>{{ chunkSec }}s</b></label>
            <NumSlider v-model="chunkSec" :min="1" :max="30" :step="1" unit="s" />
            <div class="tr-slider-hint">{{ t('增大提高分离效果，也增加耗时与显存') }}</div>
          </div>
          <div class="tr-slider">
            <label>{{ t('重叠数') }} overlap<b>{{ msOverlap }}</b></label>
            <NumSlider v-model="msOverlap" :min="1" :max="10" :step="1" />
            <div class="tr-slider-hint">{{ t('建议 4；增大提高效果、增加耗时') }}</div>
          </div>
          <div class="tr-slider">
            <label>{{ t('批次大小') }} batch_size<b>{{ msBatch }}</b></label>
            <NumSlider v-model="msBatch" :min="1" :max="8" :step="1" />
            <div class="tr-slider-hint">{{ t('减小降低显存，对效果影响不大') }}</div>
          </div>
          <div class="tr-switch"><label><span><b>{{ t('音频归一化') }}</b><small>{{ t('对输入/输出进行归一化（部分模型无此功能）') }}</small></span><input type="checkbox" v-model="msNormalize"></label></div>
          <div class="tr-switch"><label><span><b>{{ t('启用 TTA（测试时增强）') }}</b><small>{{ t('小幅提升分离质量，推理时间约 ×3') }}</small></span><input type="checkbox" v-model="msTta"></label></div>

          <div class="tr-preset-row">
            <label class="fb-label" style="margin:0">{{ t('参数预设') }} <small class="ms-mut">{{ t('（按当前模型保存 / 还原 / 应用）') }}</small></label>
            <div class="row" style="gap:var(--sp-2);flex-wrap:wrap">
              <select class="select-input" v-model="msPresetSel" style="min-width:130px">
                <option value="" disabled>{{ t('选择已保存预设') }}</option>
                <option v-for="p in msPresetOptions" :key="p.name" :value="p.name">{{ t(p.name) }}</option>
              </select>
              <button class="btn sm" @click="applyMsPreset">{{ t('应用') }}</button>
              <button class="btn sm" @click="saveMsPreset"><Icon name="plus" :size="13" />{{ t('保存预设') }}</button>
              <button class="btn sm ghost" @click="resetMsParams">{{ t('还原默认') }}</button>
              <button class="btn sm ghost danger" v-if="msPresetSel" @click="delMsPreset">{{ t('删除') }}</button>
            </div>
          </div>
        </div>

        <div class="tr-submodels">
          <div class="fb-label">{{ t('输出') }} <small class="ms-mut">{{ t('（不同模型可输出的音轨不同；不勾选即全部）') }}</small></div>
          <div class="fu-ctl tr-pills" v-if="msStemOptions.length">
            <button class="fu-ctl tr-pill" v-for="s in msStemOptions" :key="s" :class="{ active: msStems.includes(s) }" @click="toggleStem(s)">{{ sepStemLabel(s) }}</button>
            <button class="fu-ctl tr-pill ghost-like" @click="allStems()">{{ t('全选') }}</button>
          </div>
          <div v-else class="tr-slider-hint">{{ t('该模型的音轨名由权重自身决定（去噪模型一般输出「噪声 / 已去噪」两条），不勾选即全部输出') }}</div>
          <div class="tr-switch">
            <label><span><b>{{ t('输出格式') }}</b><small>{{ t('分离音频的保存格式') }}</small></span>
              <select class="select-input" v-model="msFormat" style="width:104px;padding:2px 6px;font-size:var(--fs-xs)">
                <option value="wav">{{ t('WAV（默认）') }}</option><option value="flac">FLAC</option><option value="mp3">MP3</option>
              </select></label>
          </div>
        </div>

        <div v-if="sepFile && currentSep" class="tr-sum" style="margin-top:6px">
          {{ t('即将分离：') }}<b>{{ currentSep.name }}</b><span v-if="sepEstSec()"> · {{ t('预计耗时约 ') }}<b>{{ fmtTime(sepEstSec()) }}</b></span>
          <span v-if="sepLong" class="tr-warn"> · {{ t('长音频：分离会一直跑下去（无进展 20 分钟才判失败），慢的话建议先裁剪片段') }}</span>
          <span v-if="sepIsDenoise" class="tr-warn"> · {{ t('这是单轨降噪模型：输出≈原音（只压稳态噪声），不分离人声/伴奏；要分离请选 Mel-Band Roformer（如 duality）') }}</span>
          <span v-if="currentSep && currentSep.useLabel" class="sep-uselabel"> · {{ t('用途：') }}{{ t(currentSep.useLabel) }}</span>
          <span v-if="currentSep && currentSep.useNotFor" class="tr-warn"> · {{ t('注意：') }}{{ t(currentSep.useNotFor) }}</span>
        </div>
        <button class="btn primary big" style="width:100%;justify-content:center;margin-top:8px" @click="runSeparate"
                :disabled="!currentSep || !currentSep.exists || sepBusy">
          <Icon name="box" :size="15" />{{ sepBusy ? t('分离中…') : t('开始分离') }}
        </button>
        <!-- 取消：主进程 engine:cancel 本来就认 'sep<N>' 这个 jobId，只是面板以前没给按钮 -->
        <div v-if="sepBusy" class="row" style="gap:var(--sp-2);margin-top:8px">
          <button class="btn ghost" style="flex:1;justify-content:center" @click="cancelSeparate"><Icon name="stop" :size="14" /> {{ t('取消分离') }}</button>
        </div>
        <div v-if="sepBusy || sepStage" class="tr-progress" style="margin-top:8px">
          <div class="pfill" :style="{ transform: 'scaleX(' + ((sepProgress) / 100) + ')' }"></div><span>{{ sepProgress }}%</span>
        </div>
        <div v-if="sepStage" class="tr-stage muted small">{{ sepStage }}</div>

        <div v-if="sepOutputs.length" class="tr-done">
          <span class="muted small">{{ t('已生成 ') }}{{ sepOutputs.length }}{{ t(' 个音轨：') }}</span>
          <button class="btn sm ghost" v-if="sepOutDir" @click="openSepOut"><Icon name="folder" :size="13" /> {{ t('打开输出文件夹') }}</button>
          <button class="btn sm primary" v-if="sepOutDir" @click="coverFromSep"><Icon name="mic" :size="13" /> {{ t('用分离结果做翻唱') }}</button>
        </div>
        <Transition name="fade">
        <div v-if="sepOutputs.length" class="ms-out-list">
          <div v-for="o in sepOutputs" :key="o" class="ms-out-item"><Icon name="music" :size="12" /> {{ String(o).replace(/^.*[\\/]/, '') }}</div>
        </div>
        </Transition>

        <Transition name="fade">
        <div v-if="sepLogs.length" class="tr-log">
          <div class="tr-log-head"><span class="log-title">{{ t('分离日志') }}</span><span class="log-count">{{ sepLogs.length }}{{ t(' 行') }}</span><span style="flex:1"></span><button class="icon-btn" @click="sepLogs = []"><Icon name="trash" :size="13" /></button></div>
          <div class="tr-log-scroll"><div v-for="(l, i) in sepLogs" :key="i" :class="{ err: l.isErr }">{{ l.txt }}</div></div>
        </div>
        </Transition>
      </div>

      <div v-if="mode !== 'separate'">
        <div class="fb-label">{{ t('性能模式') }}</div>
        <div class="fu-ctl tr-pills">
          <button class="fu-ctl tr-pill" :class="{ active: perf === 'quality' }" @click="selectPerf('quality')">{{ t('最高质量') }}</button>
          <button class="fu-ctl tr-pill" :class="{ active: perf === 'balanced' }" @click="selectPerf('balanced')">{{ t('均衡') }}</button>
          <button class="fu-ctl tr-pill" :class="{ active: perf === 'fast' }" @click="selectPerf('fast')">{{ t('低配省资源') }}</button>
        </div>
        <div class="tr-perf-desc">{{ PERF_DESC() }}</div>
        <div v-if="perfHint" class="tr-perf-hint">{{ perfHint }}</div>
      </div>

      <div v-if="mode !== 'separate'" class="tr-adv" :class="{ open: advOpen }" data-guide="adv-panel">
        <button type="button" class="tr-adv-head" :aria-expanded="advOpen ? 'true' : 'false'" @click="advOpen = !advOpen">{{ t('高级参数') }}<span class="adv-cnt">{{ t('阈值 · 踏板 · 模型选项') }}</span><span class="adv-arr" :class="{ open: advOpen }">▾</span></button>
        <div class="tr-adv-body">
        <div class="tr-adv-inner">
        <div class="tr-params">
          <!-- WP1-5：原来这里只是两段注释，用户看不到分组。折叠区结构不变，只加可见的分组标题。 -->
          <div class="tr-group">{{ t('质量组（影响识别与导出结果）') }}</div>
          <div class="tr-slider">
            <label>{{ t('起音阈值') }}<b>{{ onset.toFixed(2) }}</b></label>
            <NumSlider v-model="onset" :min="0" :max="1" :step="0.01" />
          </div>
          <div class="tr-slider">
            <label>{{ t('音符判定阈值') }}<b>{{ frame.toFixed(2) }}</b></label>
            <NumSlider v-model="frame" :min="0" :max="1" :step="0.01" />
          </div>
          <div class="tr-slider">
            <label>{{ t('最短音符') }}<b>{{ minNote }}ms</b></label>
            <NumSlider v-model="minNote" :min="10" :max="300" :step="1" />
            <!-- ★ 钢琴模型的碎音护栏（engine_pt._sane_min_note_ms）：10ms 等于关掉过滤器，
                 实测 30 秒样例 71 → 8037 个音符、3 分钟样例 47967 个 / 517 秒。 -->

          </div>
          <div class="tr-slider" v-if="mode !== 'separate'" data-guide="segment-sec">
            <label>{{ t('识别片段长度') }}<b>{{ segmentSec > 0 ? segmentSec + 's' : t('模型默认') }} · {{ t('推荐') }}{{ SEG_RECOMMEND > 0 ? ' ' + SEG_RECOMMEND + 's' : ' ' + t('不分段') }}</b></label>
            <NumSlider v-model="segmentSec" :min="0" :max="60" :step="1" unit="s" />

          </div>
          <div class="tr-switch" v-if="mode !== 'separate'" data-guide="memory-mode">
            <label>
              <span><b>{{ t('显存策略') }}</b></span>
              <select class="select-input" :value="memoryMode" @change="setMemoryMode($event.target.value)" style="width:auto;padding:2px 6px;font-size:var(--fs-xs)">
                <option value="auto">{{ t('自动（默认）') }}</option>
                <option value="low">{{ t('低显存模式（推荐）') }}</option>
                <option value="allow">{{ t('允许借用系统内存') }}</option>
              </select>
            </label>
          </div>

          <div class="tr-switch" v-if="mode !== 'separate'" data-guide="denoise-mode">
            <label>
              <span><b>{{ t('转录前降噪') }}</b></span>
              <select class="select-input" v-model="denoiseMode" style="width:auto;padding:2px 6px;font-size:var(--fs-xs)">
                <option value="off">{{ t('关闭（默认）') }}</option>
                <option value="light">{{ t('轻降噪（谱减）') }}</option>
                <option value="strong">{{ t('强降噪（UVR 模型）') }}</option>
              </select>
            </label>
          </div>
          <div v-if="mode !== 'separate'" class="tr-slider" data-guide="unified-memory">
            <button class="btn sm ghost" :disabled="umBusy" @click="runUnifiedMemoryExperiment">{{ umBusy ? t('实验中…') : t('运行统一内存实验（CUDA Managed Memory）') }}</button>
            <small v-if="umResult">{{ umResult }}</small>
          </div>
          <div class="tr-slider" v-if="mode === 'piano'">
            <label>{{ t('音符合并间隔') }}<b>{{ mergeGap }}ms</b></label>
            <NumSlider v-model="mergeGap" :min="0" :max="200" :step="1" />
          </div>
          <div class="tr-switch" v-if="mode === 'piano'">
            <label><span><b>{{ t('包含踏板事件') }}</b></span><input type="checkbox" v-model="pedal"></label>
          </div>
          <div class="tr-switch" v-if="mode === 'universal' && umodel === 'basic'">
            <label><span><b>{{ t('多条弯音曲线') }}</b></span><input type="checkbox" v-model="pitchBends"></label>
          </div>
          <div class="tr-switch" v-if="mode === 'universal' && umodel === 'basic'">
            <label><span><b>{{ t('低音增强') }}</b></span><input type="checkbox" v-model="bassBoost"></label>
          </div>
          <!-- WP1-5：分组标题按用户要求改为「质量组 / 速度组」，旧的按作用域分组作废 -->
          <!-- ④ 批 A：模型选项（引擎早就有，只是界面没入口） -->
          <!-- ★「自动检测 BPM」与「导出速度」是**同一件事**（用户 2026-10-14 定）：
               导出速度就是写进 MIDI 的那个速度标签；勾了自动测速，这个值由源音频测出来，
               手动档没有意义 → 直接隐藏，避免两个速度互相打架。
               引擎侧 _apply_auto_bpm 会把整份 MIDI（含每个音符的 tick）一起换到测出来的
               速度上、绝对秒数不变 —— 所以隐藏不是「少给一个选项」，它们本来就是同一个值。 -->
          <div class="tr-switch" v-if="mode !== 'separate'">
            <label><span><b>{{ t('自动检测 BPM') }}</b></span><input type="checkbox" v-model="autoBpm"></label>
          </div>
          <div class="tr-slider" v-if="mode === 'universal' && !autoBpm">
            <label>{{ t('导出速度') }}<b>{{ exportTempo > 0 ? exportTempo + ' BPM' : t('默认 120 BPM') }}</b></label>
            <NumSlider v-model="exportTempo" :min="0" :max="240" :step="1" />
          </div>
          <div class="tr-slider" v-if="mode === 'universal' && umodel === 'basic'">
            <label>{{ t('最高音高') }}<b>{{ maxFreq > 0 ? maxFreq + ' Hz' : t('不限制') }}</b></label>
            <NumSlider v-model="maxFreq" :min="0" :max="8000" :step="50" />
          </div>
          <div class="tr-slider" v-if="mode === 'universal' && umodel === 'basic'">
            <label>{{ t('最低音高') }}<b>{{ minFreq > 0 ? minFreq + ' Hz' : t('不限制') }}</b></label>
            <NumSlider v-model="minFreq" :min="0" :max="2000" :step="5" />

          </div>
          <!-- WP1-5：同上；MuScriptor 的采样类参数留在质量组，束搜索/精度归速度组 -->
          <!-- ④ 批 B：MuScriptor 生成参数（都属「影响质量」，默认保持原行为） -->
          <div class="tr-slider" v-if="mode === 'universal' && umodel === 'muscriptor'">
            <label>{{ t('采样温度') }}<b>{{ msTemp.toFixed(1) }}</b></label>
            <NumSlider v-model="msTemp" :min="0.1" :max="2" :step="0.1" />

          </div>
          <div class="tr-slider" v-if="mode === 'universal' && umodel === 'muscriptor'">
            <label>{{ t('引导系数') }}<b>{{ msCfg.toFixed(1) }}</b></label>
            <NumSlider v-model="msCfg" :min="1" :max="5" :step="0.1" />

          </div>
          <div class="tr-switch" v-if="mode === 'universal' && umodel === 'muscriptor'">
            <label><span><b>{{ t('跨块延音缝合') }}</b></span><input type="checkbox" v-model="msPrelude"></label>
          </div>
          <div class="tr-switch" v-if="mode === 'universal' && umodel === 'muscriptor'">
            <label><span><b>{{ t('节拍网格检测') }}</b></span><input type="checkbox" v-model="beatGrid" @change="beatGridUserSet = true"></label>
          </div>
          <div class="tr-switch" v-if="mode === 'universal' && umodel === 'muscriptor'">
            <label>
              <span><b>{{ t('乐器组') }}</b></span>
              <select v-model="msMode" class="select-input" style="width:auto;padding:2px 6px;font-size:var(--fs-xs)">
                <option value="none">{{ t('不限定') }}</option>
                <option value="limit">{{ t('限定乐器组') }}</option>
                <option value="probe_segments">{{ t('自动探测（分段）') }}</option>
              </select>
            </label>
          </div>
          <div v-if="mode === 'universal' && umodel === 'muscriptor' && msMode === 'probe_segments'" class="tr-slider">
            <label>{{ t('探测段长') }}<b>{{ msProbeSegSec }}s</b></label>
            <NumSlider v-model="msProbeSegSec" :min="20" :max="120" :step="10" unit="s" :aria-label="t('探测段长')" />
          </div>
          <div class="tr-switch" style="display:block" v-if="mode === 'universal' && umodel === 'muscriptor' && msMode === 'limit'">
            <div style="display:flex;flex-wrap:wrap;gap:var(--sp-2);max-height:150px;overflow:auto;padding:2px 0">
              <button v-for="g in MS_GROUPS" :key="g.id" type="button" class="fu-ctl tr-pill"
                      :class="{ active: msGroups.includes(g.id) }" :title="g.id"
                      @click="toggleMsGroup(g.id)">{{ t(g.cn) }}</button>
            </div>
          </div>
          <div class="tr-switch" v-if="mode === 'separate'">
            <label><span><b>{{ t('输出鼓组节奏轨') }}</b></span><input type="checkbox" v-model="drums"></label>
          </div>
          <div class="tr-switch" v-if="mode === 'separate'">
            <label><span><b>{{ t('导出分离音频分轨') }}</b></span>
              <span style="display:flex;align-items:center;gap:var(--sp-2)"><input type="checkbox" v-model="stemExport">
              <select v-if="stemExport" class="select-input" v-model="stemFormat" style="width:74px;padding:2px 6px;font-size:var(--fs-xs)">
                <option value="wav">WAV</option><option value="flac">FLAC</option><option value="m4a">M4A</option>
              </select></span>
            </label>
          </div>
          <!-- 降噪**不在转录页**：2026-10-15 用「已知旋律 + 注入噪声」的基准实测过两档降噪，
               结论是负面的（12 dB 素材假音符 1 → 14（谱减法）/ 39（去噪模型）；6 dB 素材 16 → 16 / 50），
               所以不在这里摆一个"看起来能救、实测反而更糟"的开关 —— 这是用户明确要防的那类选项。
               要降噪请走「音频处理」：那里能先听效果再决定要不要拿去转录。 -->


          <!-- 电平统一：恒定开启，所以不再做成开关（做成开关就等于又造一个"可能没作用"的选项）。 -->


          <!-- WP1-5：速度组。全表里只有这两项是为「省时间 / 省显存」存在的，
               其余都会改变识别或导出结果，所以都在上面的质量组里。
               ★ 组标题必须与它的成员同门控：这两项都是 MuScriptor 专属，
                 别的模型下会出现"只有标题、没有控件"的空组（用户实测反馈）。 -->
          <div class="tr-group" v-if="showSpeedGroup">{{ t('速度组（影响耗时与显存/内存占用）') }}</div>
          <div class="tr-slider" v-if="mode === 'universal' && umodel === 'muscriptor'">
            <label>{{ t('束搜索宽度') }}<b>{{ msBeam }}</b></label>
            <NumSlider v-model="msBeam" :min="1" :max="5" :step="1" />

          </div>
          <div class="tr-switch" v-if="mode === 'universal' && umodel === 'muscriptor'">
            <label>
              <span>
                <b>{{ t('计算精度') }}</b>

              </span>
              <select v-model="msPrec">
                <option value="fp32">{{ t('fp32（默认，最稳）') }}</option>
                <option value="bf16">{{ t('bf16（省显存，实测不更快）') }}</option>
                <option value="fp16">{{ t('fp16（更激进，未验证）') }}</option>
              </select>
            </label>
          </div>
          <div class="tr-preset-row">
            <label class="fb-label" style="margin:0">{{ t('参数预设') }}</label>
            <div class="row" style="gap:var(--sp-2)">
              <select class="select-input" v-model="presetSel" :title="t('选择预设并应用')" style="min-width:138px">
                <option v-for="p in presets.list" :key="p.name" :value="p.name">{{ t(p.name) }}{{ presets.builtins.includes(p.name) ? '' : ' ✎' }}</option>
              </select>
              <button class="btn sm" @click="applySelectedPreset()">{{ t('应用') }}</button>
              <button class="btn sm" @click="savePreset"><Icon name="plus" :size="13" />{{ t('保存') }}</button>
              <button class="btn sm ghost danger" @click="delPreset"><Icon name="trash" :size="13" />{{ t('删除') }}</button>
              <button class="btn sm ghost" @click="openPresetMgr"><Icon name="menu" :size="13" /> {{ t('管理') }}</button>
              <button class="btn sm ghost" @click="restoreModelDefault" :title="t('解绑本模型的自定义预设，回到内置默认')">{{ t('恢复该模型默认') }}</button>
              <span class="fb-hint" v-if="presetModelHint" style="margin-left:4px">{{ presetModelHint }}</span>
            </div>
          </div>
        </div>
      </div>
      </div>
      </div>

      <!-- 任务模板已移除（2026-10-14）："记住一套设置"改由**队列**承担 ——
           每个队列自带模型与参数，切队列即切设置（用户要求）。 -->
      <div v-if="mode !== 'separate'">

      <!-- 摘要 + 开始 -->
      <div v-if="queue.some(i => i.status === 'pending' || i.status === 'error')" class="tr-sum">
        {{ t('即将转录：') }}<b>{{ queue.find(i => i.status === 'pending' || i.status === 'error')?.name || '—' }}</b> · {{ t('引擎：') }}<b>{{ MODE_NAMES()[mode] }}</b> · {{ t('预计耗时：') }}<b>{{ sumTime || '—' }}</b>
      </div>
      <div class="tr-par" style="display:flex;align-items:center;gap:var(--sp-2);margin-top:12px">
        <span style="font-size:var(--fs-md);color:var(--steel)">{{ t('并行数') }}</span>
        <select style="background:var(--surface);color:var(--ink);border:1px solid var(--hairline);border-radius:var(--r-md);padding:4px 8px;font-size:var(--fs-md)" :value="parallelN" @change="setParallel(parseInt($event.target.value, 10) || 1)">
          <option v-for="n in 4" :key="n" :value="n">{{ n }}</option>
        </select>
        <span style="font-size:var(--fs-sm);color:var(--stone)">{{ t('多文件同时转录；GPU 模型建议保持 1') }}</span>
      </div>
      <button class="btn primary big" style="width:100%;justify-content:center;margin-top:14px" data-guide="start-transcribe" @click="startTranscribe" :disabled="busy || !isDesktop || !queue.length">
        <Icon name="transcribe" :size="16" />{{ busy ? t('转录中…') : t('开始转录') }}
      </button>
      <div v-if="busy || paused" class="row" style="gap:var(--sp-2);margin-top:8px">
        <button v-if="busy && !paused" class="btn ghost" style="flex:1;justify-content:center" @click="pauseBatch"><Icon name="pause" :size="14" /> {{ t('暂停') }}</button>
        <button v-else class="btn" style="flex:1;justify-content:center" @click="resumeBatch"><Icon name="play" :size="14" /> {{ t('继续') }}</button>
        <button v-if="busy" class="btn ghost" style="flex:1;justify-content:center" @click="cancelTranscribe"><Icon name="stop" :size="14" /> {{ t('取消转录') }}</button>
      </div>

      <Transition name="fade">
      <div v-if="busy || done" class="tr-progress">
        <div class="pfill" :style="{ transform: 'scaleX(' + ((progress) / 100) + ')' }"></div><span>{{ progress }}%</span>
      </div>
      </Transition>
      <div v-if="stage" class="tr-stage muted small">{{ stage }}</div>
      <Transition name="fade">
      <div v-if="done" class="tr-done">
        <button class="btn sm" @click="setView('play')"><Icon name="play2" :size="13" /> {{ t('打开播放') }}</button>
        <button class="btn sm ghost" @click="openOutput"><Icon name="folder" :size="13" /> {{ t('打开输出文件夹') }}</button>
        <span class="muted small">{{ doneInfo }}</span>
      </div>
      </Transition>

      <!-- 运行日志 -->
      <Transition name="fade">
      <div v-if="logs.length" class="tr-log">
        <div class="tr-log-head">
          <span class="log-title">{{ t('运行日志') }}</span><span class="log-count">{{ logs.length }}{{ t(' 行') }}</span>
          <span style="flex:1"></span>
          <button class="icon-btn" :title="t('清空')" @click="clearLog"><Icon name="trash" :size="13" /></button>
          <button class="icon-btn" :title="t('展开/收起')" @click="logExpanded = !logExpanded"><Icon name="chevron" :size="13" /></button>
        </div>
        <div class="tr-log-scroll" :class="{ collapsed: !logExpanded }">
          <div v-for="(l, i) in logs" :key="i" :class="{ err: l.isErr }">{{ l.txt }}</div>
        </div>
      </div>
      </Transition>
      </div>
      </div>
      </Transition>
    </div>

    <!-- 智能修正 -->
    <div v-if="mode !== 'separate'" class="card tr-card" style="border-top:1px dashed var(--border)">
      <div class="fb-label" style="font-weight:700">{{ t('智能修正') }}</div>
      <div class="fb-hint">{{ t('对齐起音 · 还原力度 · 声部平衡 · 清理杂音') }}</div>
      <div class="tr-rf-row">
        <span class="muted small" style="min-width:44px">{{ t('原音频') }}</span>
        <button class="btn sm" @click="pickRfAudio"><Icon name="music" :size="13" /> {{ t('选择音频') }}</button>
        <span class="muted small rf-path">{{ rf.audio ? rf.audio.replace(/^.*[\\/]/, '') : '—' }}</span>
      </div>
      <div class="tr-rf-row">
        <span class="muted small" style="min-width:44px">{{ t('原 MIDI') }}</span>
        <button class="btn sm" @click="pickRfMidi"><Icon name="kbd" :size="13" /> {{ t('选择 MIDI') }}</button>
        <span class="muted small rf-path">{{ rf.midi ? rf.midi.replace(/^.*[\\/]/, '') : '—' }}</span>
      </div>
      <div class="fb-label">{{ t('修正模式') }}</div>
      <div class="fu-ctl tr-pills">
        <button class="fu-ctl tr-pill" :class="{ active: rf.mode === 'auto' }" @click="rf.mode = 'auto'">{{ t('自动') }}</button>
        <button class="fu-ctl tr-pill" :class="{ active: rf.mode === 'piano' }" @click="rf.mode = 'piano'">{{ t('钢琴') }}</button>
        <button class="fu-ctl tr-pill" :class="{ active: rf.mode === 'vocal' }" @click="rf.mode = 'vocal'">{{ t('人声') }}</button>
      </div>
      <div class="tr-switch" style="margin-top:8px">
        <label><span><b>{{ t('声部平衡') }}</b><small>{{ t('抬主奏/人声 · 压配乐') }}</small></span><input type="checkbox" v-model="rf.stem"></label>
      </div>
      <button class="btn primary big" style="width:100%;justify-content:center;margin-top:12px" @click="startRefine" :disabled="rf.busy || !rf.midi || !rf.audio">
        <Icon name="spark" :size="15" />{{ rf.busy ? t('修正中…') : t('开始智能修正') }}
      </button>
      <div v-if="rf.busy || rf.info" class="tr-progress">
        <div class="pfill" :style="{ transform: 'scaleX(' + (((rf.busy ? 60 : 100)) / 100) + ')' }"></div><span>{{ rf.busy ? '…' : t('完成') }}</span>
      </div>
      <div v-if="rf.info" class="tr-done">
        <button class="btn sm" @click="openRefineResult"><Icon name="play2" :size="13" /> {{ t('打开修正结果') }}</button>
        <span class="muted small">{{ rf.info }}</span>
      </div>
      <div v-if="rf.logs.length" class="tr-log">
        <div class="tr-log-head"><span class="log-title">{{ t('修正日志') }}</span><span class="log-count">{{ rf.logs.length }}{{ t(' 行') }}</span><span style="flex:1"></span><button class="icon-btn" @click="rf.logs = []"><Icon name="trash" :size="13" /></button></div>
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
          <b>{{ t('参数预设管理') }}</b>
          <button class="icon-btn" @click="presetMgrOpen = false" :title="t('关闭')"><Icon name="plus" :size="14" style="transform:rotate(45deg)" /></button>
        </div>
        <div class="preset-mgr-list">
          <div v-if="!presets.list.length" class="muted small" style="padding:16px">{{ t('暂无预设') }}</div>
          <div v-for="p in presets.list" :key="p.name" class="preset-mgr-row"
               draggable="true" @dragstart="presetDragStart(p)" @dragover.prevent @drop.prevent="presetDrop(p)" @dragend="presetDragName = ''">
            <span class="pm-handle" :title="t('拖动排序')">⋮⋮</span>
            <span class="pm-name" @click="mgrApply(p.name)" :title="t('点击应用')">{{ t(p.name) }}</span>
            <span class="pm-mode">{{ p.mode }}</span>
            <button class="btn sm ghost danger" :title="t('删除')" @click="mgrDelete(p.name)">{{ t('删除') }}</button>
          </div>
        </div>
        <div class="preset-mgr-foot">
          <button class="btn sm" @click="mgrRestore">{{ t('恢复全部内置') }}</button>
          <span style="flex:1"></span>
          <button class="btn sm primary" @click="presetMgrOpen = false">{{ t('完成') }}</button>
        </div>
      </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.tr-view { max-width: 900px; padding: var(--page-pad-y) var(--page-pad-x) var(--page-pad-b); }
.warn-tag { color: var(--amber); border-color: rgba(245, 158, 11, 0.4); background: rgba(245, 158, 11, 0.1); }
.tr-drop-card { padding: 16px; display: flex; flex-direction: column; gap: var(--sp-3); }
.tr-drop { display: flex; align-items: center; gap: var(--sp-4); padding: 22px; border: 1.5px dashed var(--border-strong); border-radius: var(--r-lg); background: var(--canvas); cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out), transform var(--motion-base) var(--ease-out), box-shadow var(--motion-base) var(--ease-out); }
.tr-drop:hover, .tr-drop.over { border-color: var(--brand-blue); background: var(--surface-soft); }
.td-ic { width: 46px; height: 46px; border-radius: var(--r-md); background: var(--surface); display: flex; align-items: center; justify-content: center; color: var(--brand-blue); flex: none; }
.td-txt b { display: block; font-size: var(--fs-md); color: var(--ink); }
.td-txt span { font-size: var(--fs-sm); color: var(--stone); }
.tr-audio-info { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-sm); color: var(--slate); }
.tr-wave { border: 1px solid var(--hairline); border-radius: var(--r-md); overflow: hidden; background: var(--canvas); }
.tr-wave canvas { display: block; width: 100%; height: 64px; }
.tr-batch-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-top: 4px; }
.fb-label { font-size: var(--fs-md); font-weight: 600; color: var(--ink); }
.fb-hint { font-size: var(--fs-xs); color: var(--stone); margin-top: 1px; }
.tr-batch-ctls { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.tr-batch-list { border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--canvas); overflow: hidden; }
.tr-batch-item { display: flex; align-items: center; gap: var(--sp-2); padding: 6px 10px; border-bottom: 1px solid var(--hairline-soft); font-size: var(--fs-sm); }
.tr-batch-item:last-child { border-bottom: none; }
.tb-name { flex: 1; min-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }
.tb-bar { width: 120px; height: 6px; border-radius: var(--r-pill); background: var(--surface-soft); overflow: hidden; flex: none; }
.tb-bar i { display: block; height: 100%; background: var(--brand-blue); border-radius: var(--r-pill); transition: transform var(--motion-base) var(--ease-out); }
.tb-badge { font-size: var(--fs-xs); padding: 2px 8px; border-radius: var(--r-pill); background: var(--surface-soft); color: var(--stone); flex: none; }
.tb-badge.running { background: rgba(20,86,240,.1); color: var(--brand-blue); }
.tb-badge.done { background: var(--success-bg); color: var(--success-text); }
.tb-badge.error { background: rgba(212,86,86,.1); color: var(--error); }
.tb-badge.canceled { color: var(--muted); }
.tr-batch-stat { margin-top: 6px; }
.tr-card { padding: 18px 20px; display: flex; flex-direction: column; gap: var(--sp-3); margin-top: 14px; }
/* ===== 模式切换动画：只包"随模式变化"的那块，里面的间距与 .tr-card 保持一致 ===== */
.tr-mode-body { display: flex; flex-direction: column; gap: var(--sp-3); }
.trSwap-enter-active { transition: opacity var(--motion-base) var(--ease-out), transform var(--motion-base) var(--ease-out); }
.trSwap-leave-active { transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.trSwap-enter-from { opacity: 0; transform: translateY(6px); }
.trSwap-leave-to { opacity: 0; transform: translateY(-6px); }
/* 引擎模式切换：方向感（往后切从右进、往回切从左进）+ 稍慢一点，别像瞬移 */
.trSwapFwd-enter-active, .trSwapBack-enter-active { transition: opacity var(--motion-base) var(--ease-out), transform var(--motion-slow) var(--ease-out); }
.trSwapFwd-leave-active, .trSwapBack-leave-active { transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.trSwapFwd-enter-from { opacity: 0; transform: translateX(16px); }
.trSwapFwd-leave-to { opacity: 0; transform: translateX(-10px); }
.trSwapBack-enter-from { opacity: 0; transform: translateX(-16px); }
.trSwapBack-leave-to { opacity: 0; transform: translateX(10px); }
.tr-modes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--sp-3); }
.tr-mode { border: 1px solid var(--border); border-radius: var(--r-md); padding: 12px 14px; background: var(--surface); text-align: left; cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out); }
.tr-mode b { display: block; font-size: var(--fs-md); color: var(--ink); margin-bottom: 2px; }
.tr-mode span { font-size: var(--fs-xs); color: var(--stone); line-height: 1.4; }
.tr-mode:hover { border-color: var(--border-strong); }
.tr-mode.active { border-color: var(--ink); background: var(--canvas); box-shadow: 0 0 0 1px var(--ink); }
.tr-mode.active b { color: var(--brand-coral); }
.tr-pills { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
/* .tr-pill 的形状（盒/内边距/圆角/悬停/选中）一律由 styles/controls.css 的 .fu-ctl 提供，
   这里只留语义偏差（ghost-like 的虚线描边）。原先本地那份是 5px 14px，与其它页面的胶囊不一致。 */
.tr-pill .ms-badge { height: 15px; }   /* 形状交给 .fu-badge，只钉高度 */
.tr-pill .ms-badge.ok { background: rgba(72, 187, 120, 0.16); color: var(--t-ok); }
.tr-pill .ms-badge.miss { background: rgba(212, 86, 86, 0.16); color: var(--t-err); }
.tr-pill.active .ms-badge.ok, .tr-pill.active .ms-badge.miss { background: rgba(255,255,255,0.2); color: var(--on-accent); }
.tr-submodels { margin-top: 10px; padding: 10px 12px; border: 1px dashed var(--hairline); border-radius: var(--r-md); background: var(--surface-soft); }
.tr-submodels .fb-label { margin-bottom: 8px; }
.tr-perf-hint { font-size: var(--fs-sm); color: var(--success-text); }
.tr-slider-hint { margin-top: 4px; font-size: var(--fs-sm); color: var(--stone); line-height: 1.5; }
.tr-perf-desc { margin-top: 6px; font-size: var(--fs-sm); color: var(--stone); line-height: 1.5; }
.tr-adv { border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); }
.tr-adv-head { display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: 10px 14px; font-size: var(--fs-md); font-weight: 600; color: var(--ink); cursor: pointer; user-select: none; background: none; border: 0; font-family: inherit; text-align: left; }
.tr-adv-head .adv-cnt { font-weight: 400; color: var(--stone); font-size: var(--fs-xs); }
.tr-adv-head .adv-arr { margin-left: auto; color: var(--stone); transition: transform var(--motion-base) var(--ease-out); }
.tr-adv-head .adv-arr.open { transform: rotate(180deg); }
/* 折叠动画用 grid-template-rows 0fr→1fr：不用事先知道内容高度，长短内容都能平滑展开 */
.tr-adv-body { display: grid; grid-template-rows: 0fr; opacity: 0; transition: grid-template-rows var(--motion-base) var(--ease-out), opacity var(--motion-base) var(--ease-out); }
.tr-adv.open .tr-adv-body { grid-template-rows: 1fr; opacity: 1; }
/* 里面再包一层：.tr-params 自带 4/14px 上下 padding，折叠态会留下一条 18px 的边。
   ★ min-height:0 只能在**折叠态**给：展开态给了它，1fr 会被解析成 0（这套 0fr↔1fr 技巧的关键）。 */
.tr-adv-body > * { overflow: hidden; }
.tr-adv:not(.open) .tr-adv-body > * { min-height: 0; }
/* 折叠/展开时把 .tr-params 的上下 padding 也一起收掉，免得留边 */
.tr-adv:not(.open) .tr-params { padding-top: 0; padding-bottom: 0; }
.tr-params { padding: 4px 14px 14px; display: flex; flex-direction: column; gap: var(--sp-3); }
/* WP1-5：分组标题。第一条不画上边线（它紧跟在容器 padding 之后）。 */
.tr-group { margin-top: 2px; padding-top: 10px; border-top: 1px solid var(--hairline); font-size: var(--fs-xs); font-weight: 600; letter-spacing: .02em; color: var(--stone); }
.tr-group:first-child { margin-top: 0; padding-top: 0; border-top: 0; }
.tr-slider label { display: flex; justify-content: space-between; font-size: var(--fs-sm); color: var(--slate); margin-bottom: 2px; }
.tr-slider label b { color: var(--ink); font-weight: 600; font-variant-numeric: tabular-nums; }
.tr-slider input[type=range] { width: 100%; accent-color: var(--ink); }
.tr-switch label { display: flex; align-items: center; justify-content: space-between; font-size: var(--fs-sm); color: var(--slate); }
.tr-switch b { display: block; color: var(--ink); font-weight: 600; }
.tr-switch small { color: var(--stone); font-size: var(--fs-xs); }
.tr-switch input[type=checkbox] { accent-color: var(--ink); }
.tr-preset-row { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: 4px; padding-top: 10px; border-top: 1px solid var(--hairline); }
/* 多队列条：切队列 = 切模型与参数 */
.tr-queues { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin: 0 0 8px; }
.tr-queues .tr-pill { padding: 2px var(--sp-2); font-size: var(--fs-xs); }   /* 与 .fu-ctl--sm 同值 */
.tr-queues .tr-q-n { font-style: normal; margin-left: 6px; font-size: var(--fs-xs); opacity: .72; }
.tr-chain { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--stone); cursor: pointer; }
.tr-chain input { accent-color: var(--accent); }
.tr-q-run { font-style: normal; margin-left: 4px; color: var(--accent); font-size: var(--fs-xs); }
.tr-queue-target { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-xs); color: var(--stone); }
.tr-queue-target select { max-width: 160px; padding: 2px 6px; font-size: var(--fs-xs); }
.tr-sum { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; background: var(--surface-soft); border-radius: var(--r-md); padding: 10px 14px; font-size: var(--fs-sm); color: var(--slate); }
.tr-sum b { color: var(--ink); font-weight: 600; }
.tr-progress { position: relative; display: flex; align-items: center; justify-content: flex-end; height: 20px; background: var(--surface-soft); border-radius: var(--r-pill); overflow: hidden; margin-top: 8px; }
.tr-progress .pfill { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; background: var(--ink); border-radius: var(--r-pill); transition: transform var(--motion-base) var(--ease-out); }
.tr-progress span { position: relative; z-index: 1; padding: 0 12px; font-size: var(--fs-xs); color: var(--steel); }
.tr-stage { margin-top: 4px; text-align: center; }
.tr-done { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; margin-top: 8px; }
.tr-log { border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); margin-top: 10px; overflow: hidden; }
.tr-log-head { display: flex; align-items: center; gap: var(--sp-2); padding: 6px 10px; font-size: var(--fs-xs); color: var(--slate); border-bottom: 1px solid var(--hairline-soft); }
.log-count { color: var(--stone); }
.tr-log-scroll { max-height: 220px; overflow-y: auto; padding: 8px 12px; font-family: var(--mono); font-size: var(--fs-xs); color: var(--slate); line-height: 1.6; }
.tr-log-scroll.collapsed { max-height: 60px; }
.tr-log-scroll .err { color: var(--error); }
.tr-rf-row { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.rf-path { max-width: 100%; overflow-wrap: anywhere; word-break: break-word; }
.preset-mgr-overlay { position: fixed; inset: 0; z-index: 120; background: rgba(0,0,0,0.35); -webkit-backdrop-filter: blur(8px) saturate(1.4); backdrop-filter: blur(8px) saturate(1.4); display: flex; align-items: center; justify-content: center; padding: 24px; }
.preset-mgr-card { width: 560px; max-width: 94vw; max-height: 82vh; background: var(--glass-bg-strong); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); border: 1px solid color-mix(in srgb, var(--on-accent) 26%, transparent); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; overflow: hidden; }
.preset-mgr-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--hairline); color: var(--ink); font-size: var(--fs-lg); }
.preset-mgr-list { flex: 1; overflow-y: auto; padding: 10px 14px; display: flex; flex-direction: column; gap: var(--sp-2); }
.preset-mgr-row { display: flex; align-items: center; gap: var(--sp-2); padding: 8px 10px; border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); }
.pm-handle { color: var(--stone); cursor: grab; user-select: none; flex: none; }
.pm-name { flex: 1; cursor: pointer; color: var(--ink); font-weight: 600; }
.pm-mode { font-size: var(--fs-xs); color: var(--stone); background: var(--surface-soft); padding: 2px 8px; border-radius: var(--r-pill); }
.preset-mgr-foot { display: flex; align-items: center; gap: var(--sp-2); padding: 10px 14px; border-top: 1px solid var(--hairline); }

/* ===== 音频处理：模型选择 ===== */
.sep-pick { display: flex; align-items: center; gap: var(--sp-3); padding: 10px 12px; border: 1px solid var(--hairline); border-radius: var(--r-md); background: var(--surface); cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out); }
.sep-pick:hover { border-color: var(--brand-coral); box-shadow: var(--shadow-sm); }
.sep-pick-ic { display: inline-flex; width: 30px; height: 30px; align-items: center; justify-content: center; border-radius: var(--r-md); background: linear-gradient(135deg, var(--brand-coral), color-mix(in srgb, var(--brand-coral) 70%, var(--data-6))); color: var(--on-accent); }
.sep-pick .grow { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.sep-pick .grow b { font-size: var(--fs-md); color: var(--ink); }
.sep-pick .grow small { font-size: var(--fs-xs); color: var(--stone); }
.sep-scrim { position: fixed; inset: 0; z-index: 140; background: rgba(8,10,16,.45); -webkit-backdrop-filter: blur(8px) saturate(1.4); backdrop-filter: blur(8px) saturate(1.4); display: flex; align-items: center; justify-content: center; padding: 24px; }
.sep-pane { width: 940px; max-width: 94vw; max-height: 84vh; background: var(--glass-bg-strong); -webkit-backdrop-filter: var(--glass-blur); backdrop-filter: var(--glass-blur); border: 1px solid color-mix(in srgb, var(--on-accent) 26%, transparent); border-radius: var(--r-lg); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; overflow: hidden; }
.sep-head { display: flex; align-items: center; gap: var(--sp-2); padding: 13px 16px; border-bottom: 1px solid var(--hairline); font-size: var(--fs-lg); color: var(--ink); }
/* 搜索 + 分类：模型一多（vocal/multi/single/vr 全列）单列长列表滚很久，改成「搜索 + 分类 + 网格」 */
.sep-head-n { font-size: var(--fs-xs); color: var(--stone); font-family: var(--mono); font-variant-numeric: tabular-nums; }
.sep-tools { display: flex; align-items: center; gap: var(--sp-3); flex-wrap: wrap; padding: 10px 16px 0; }
.sep-tools .tr-pills { flex: 1; min-width: 240px; }
.sep-search { flex: 1; min-width: 240px; display: flex; align-items: center; gap: var(--sp-2); padding: 0 8px 0 10px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--surface); color: var(--stone); }
.sep-search:focus-within { border-color: var(--brand-coral); box-shadow: var(--shadow-sm); }
.sep-search .text-input { flex: 1; min-width: 0; border: 0; background: transparent; padding: 7px 0; font-size: var(--fs-md); }
.sep-search .text-input:focus { outline: none; }
.sep-cnt { font-style: normal; margin-left: 5px; font-size: var(--fs-xs); opacity: .72; font-variant-numeric: tabular-nums; }
.sep-hint { font-size: var(--fs-sm); color: var(--stone); padding: 8px 16px; background: var(--surface-soft); border-bottom: 1px solid var(--hairline); margin-top: 10px; }
.sep-list { flex: 1; overflow-y: auto; padding: 12px 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(258px, 1fr)); gap: var(--sp-2); align-content: start; }
.sep-item { border: 1px solid var(--hairline); border-radius: var(--r-md); padding: 10px 12px; background: var(--surface); cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out); }
.sep-item:hover { border-color: var(--brand-coral); box-shadow: var(--shadow-sm); }
.sep-item.sel { border-color: var(--brand-coral); box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand-coral) 30%, transparent); }
.sep-item.off { opacity: .45; cursor: not-allowed; }
.si-head { display: flex; align-items: center; gap: var(--sp-2); }
.si-ic { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; border-radius: var(--r-sm); background: var(--surface-soft); color: var(--accent); }
.si-arch { font-size: var(--fs-xs); font-weight: 600; color: var(--stone); text-transform: uppercase; letter-spacing: .2px; font-family: var(--mono); }
.si-kind { margin-left: auto; font-size: var(--fs-xs); font-weight: 700; padding: 1px 7px; border-radius: var(--r-lg); background: color-mix(in srgb, var(--brand-coral) 12%, transparent); color: var(--brand-coral); }
.si-kind.vr { background: color-mix(in srgb, var(--data-6) 14%, transparent); color: var(--data-6); }
.si-pill { padding: 1px 7px; border-radius: var(--r-lg); font-weight: var(--fw-strong); }   /* 形状交给 .fu-badge */
.si-pill.on { background: color-mix(in srgb, var(--ok,var(--t-ok)) 16%, transparent); color: var(--ok,var(--t-ok)); }
.si-pill.off { background: var(--surface-soft); color: var(--stone); }
.si-name { font-size: var(--fs-md); font-weight: 700; color: var(--ink); margin-top: 5px; display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.si-best { display: inline-flex; align-items: center; gap: 2px; font-size: var(--fs-xs); font-weight: 700; color: var(--t-warn); background: linear-gradient(135deg, var(--data-2), var(--data-3)); padding: 0 6px; border-radius: var(--r-lg); line-height: 15px; }
.si-use { font-size: var(--fs-xs); color: var(--slate); line-height: 1.55; margin-top: 2px; -webkit-box-orient: vertical; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; }
.si-usage { font-size: var(--fs-xs); color: var(--accent); line-height: 1.5; margin-top: 3px; }
.si-notfor { font-size: var(--fs-xs); color: var(--t-warn); line-height: 1.5; margin-top: 1px; }
.sep-uselabel { color: var(--slate); font-size: var(--fs-xs); }
.si-foot { display: flex; align-items: center; justify-content: space-between; margin-top: 6px; font-size: var(--fs-xs); color: var(--stone); font-family: var(--mono); }
.si-auto { font-style: normal; margin-left: 6px; font-size: var(--fs-xs); font-weight: 700; padding: 1px 6px; border-radius: var(--r-lg); background: color-mix(in srgb, var(--brand-blue) 14%, transparent); color: var(--brand-blue); font-family: system-ui; }
.si-check { font-size: var(--fs-xs); font-weight: 700; color: var(--stone); font-family: system-ui; }
.si-check.cur { color: var(--brand-coral); }
.sep-none { grid-column: 1 / -1; text-align: center; color: var(--stone); padding: 30px 0; font-size: var(--fs-sm); }
.sepFade-enter-active, .sepFade-leave-active { transition: opacity var(--motion-fast) var(--ease-out); }
.sepFade-enter-from, .sepFade-leave-to { opacity: 0; }
.sepFade-enter-active .sep-pane, .sepFade-leave-active .sep-pane { transition: transform var(--motion-base) var(--ease-out), opacity var(--motion-fast) var(--ease-out); }
.sepFade-enter-from .sep-pane, .sepFade-leave-to .sep-pane { transform: scale(.94); opacity: 0; }

/* ===== 音频处理：MSST 工作区 ===== */
.tr-msst { display: flex; flex-direction: column; gap: var(--sp-3); padding: 4px 0; }
.tr-msst .tr-submodels { margin-top: 0; }
/* 音频处理的分组框与「通用识别 / 钢琴专用」的分组框用同一套间距，避免第三页看起来是另一个页面 */
.tr-msst .ms-grid { margin-top: 8px; }
.tr-msst .tr-switch { margin-top: 8px; }
.ms-mut { color: var(--stone); font-weight: 400; }
.ms-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-3); }
@media (max-width: 640px) { .ms-grid { grid-template-columns: 1fr; } }
.ms-field { display: flex; flex-direction: column; gap: var(--sp-1); border: 1px solid var(--hairline); border-radius: var(--r-md); padding: 8px 10px; background: var(--surface); font-size: var(--fs-sm); color: var(--slate); }
.ms-field small { color: var(--stone); font-size: var(--fs-xs); line-height: 1.4; }
.ms-field .text-input { width: 100%; padding: 5px 8px; font-size: var(--fs-md); }
.ms-range-row { display: flex; align-items: center; gap: var(--sp-2); }
.ms-range-row input[type=range] { flex: 1; accent-color: var(--ink); }
.ms-range-row b { flex: none; min-width: 30px; text-align: right; color: var(--ink); font-size: var(--fs-md); font-variant-numeric: tabular-nums; }
.tr-pill.ghost-like { background: transparent; border: 1px dashed var(--border-strong); color: var(--stone); }
.tr-pill.ghost-like:hover { border-color: var(--brand-coral); color: var(--brand-coral); }
.ms-out-list { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: 4px; }
.ms-out-item { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-sm); color: var(--success-text); background: var(--success-bg); padding: 3px 9px; border-radius: var(--r-pill); font-family: var(--mono); }
/* Aria-AMT 的「需 CUDA」徽标与不可用提示 */
.tr-cuda { margin-left: var(--sp-2); padding: 0 var(--sp-1); border-radius: var(--r-sm);
  font-size: var(--fs-xs); font-weight: 600; color: var(--t-warn);
  border: 1px solid color-mix(in srgb, var(--t-warn) 45%, var(--line)); background: color-mix(in srgb, var(--t-warn) 12%, transparent); }
.tr-perf-hint.tr-warn { color: var(--t-warn); }
</style>