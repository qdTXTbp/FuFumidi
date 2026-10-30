// ============================================================
// 统一数据目录（Data Root）：依赖 / 环境 / 模型 / 缓存的唯一落点
//
// 目标：不挤占 C 盘 —— 默认落在「工具目录」旁的 FuFumidiData/，
//       安装目录不可写（如装在 Program Files）时回退到用户数据目录，
//       两条路都可被设置项 settings.data_root 覆盖。
//
// 目录结构：
//   <root>/
//     models/            模型权重（含 torch.hub 的 hub/checkpoints）
//     gpu-enhancements/  GPU 增强包（CUDA / ROCm / XPU 的 site-packages）
//     soundfonts/        音色库（SF2）
//     midi/              每个曲目对应的真实 .mid 文件（曲库文件规范化）
//     cache/             pip / huggingface / matplotlib / numba 等第三方缓存
//     temp/              引擎与主进程的中间产物
//
// 兼容：升级自旧版时，把原先散落在 <userData>/fufumidi 下的重型目录
//       一次性迁移到 root（同盘 rename，跨盘 copy+delete），迁移完成后
//       不再读旧路径；迁移失败则该项继续沿用旧路径并在 UI 中提示。
// ============================================================
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const Pick = require('./data-root-pick');

const DIR_NAME = Pick.DATA_DIR_NAME;
const READY_MARK = '.fufumidi-ready';
const MIGRATING_MARK = '.fufumidi-migrating';

// 需要从旧位置迁移过来的重型目录（目录名即 root 下的子目录名）
// legacy 指向旧版本的真实落点（历史上并不统一，逐一列出）
const MIGRATE_DIRS = [
  { name: 'models', legacy: () => path.join(legacyBase(), 'models') },
  { name: 'gpu-enhancements', legacy: () => path.join(legacyBase(), 'gpu-enhancements') },
  { name: 'soundfonts', legacy: () => path.join(legacyBase(), 'soundfonts') },
  { name: 'voicebanks', legacy: () => path.join(app.getPath('userData'), 'voicebanks') },
];

let _root = null;
let _rootReason = '';
let _rootFrom = '';          // 依据来源（settings.data_root_last / settings-paths / install-dir …）
let _discoveredCache = [];    // 本次发现的历史数据根候选（供设置页展示）
// 迁移未完成的项：值为旧路径（服务继续用旧路径，避免读到半成品）
const _legacy = Object.create(null);
let _migrationReport = null;

/* ---------------- 基础路径 ---------------- */

function installRoot() {
  /* 测试/诊断可强制指定（只影响去哪找 FuFumidiData，不影响别的事）。
     与 FUFUMIDI_E2E_DATA_ROOT 同类的开关，正常启动不设。 */
  const forced = process.env.FUFUMIDI_INSTALL_ROOT || '';
  if (forced) return forced;
  try {
    return app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
  } catch (_) { return process.cwd(); }
}
/** 旧版数据目录（<userData>/fufumidi） */
function legacyBase() { return path.join(app.getPath('userData'), 'fufumidi'); }
/** 兜底数据目录（<userData>/FuFumidiData） */
function userDataBase() { return path.join(app.getPath('userData'), DIR_NAME); }

function settingsFile() { return path.join(legacyBase(), 'settings.json'); }

function configuredRoot() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return (s && typeof s.data_root === 'string') ? s.data_root.trim() : '';
  } catch (_) { return ''; }
}

/** settings.json 的宽松读取（拿不到就当空对象，绝不抛） */
function settingsRaw() {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return (s && typeof s === 'object') ? s : {};
  } catch (_) { return {}; }
}

/** 上次实际用过的数据根（自动记录，仅作「找回来」的线索） */
function lastUsedRoot() {
  const s = settingsRaw();
  return (typeof s.data_root_last === 'string') ? s.data_root_last.trim() : '';
}

/* ---------------- 旧数据根的发现（2026-10-24 报障修复） ----------------
 * 背景：6.2.4 装进 Program Files 后数据根回退到 %APPDATA% 下的**新建空目录**，
 * 而用户数据还在旧便携目录里 —— 候选表里根本没有「上次用过的位置」这一路。
 *
 * 发现来源（都不贵，启动时跑一次）：
 *   ① settings.json 里那些绝对路径值（active_soundfont / custom_wallpaper /
 *      output_dir / engine_path / plugin.dirs…，以及任何含 FuFumidiData 的字符串）
 *   ② %APPDATA%\fufumidi\*.json 里记录的路径（曲库 midi 文件、最近打开、播放列表）
 * 每个路径都会被展开成「祖先里叫 FuFumidiData 的目录」+「每层祖先下的 FuFumidiData」，
 * 再由 pickDataRoot 用 hasData/canUse 过滤 —— 只有**真有数据**的才认领。
 */

/** 从任意值里收集看起来像绝对路径的字符串 */
function collectPathStrings(v, out, depth) {
  const d = depth || 0;
  if (d > 6 || out.length > 400) return out;
  if (typeof v === 'string') {
    // 只留像盘符/UNC 开头的绝对路径（settings 里也有主题名之类的普通字符串）
    if (/^(?:[a-zA-Z]:[\\/]|\\\\)/.test(v.trim())) out.push(v.trim());
    return out;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectPathStrings(x, out, d + 1);
    return out;
  }
  if (v && typeof v === 'object') {
    for (const k of Object.keys(v)) collectPathStrings(v[k], out, d + 1);
  }
  return out;
}

/** 扫 %APPDATA%\fufumidi 下的 json（限量，按体积与文件数封顶），取出里面的绝对路径 */
function pathsFromLegacyJson(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch (_) { return out; }
  const MAX_FILES = 15, MAX_BYTES = 512 * 1024;
  let n = 0;
  for (const name of names) {
    if (n >= MAX_FILES) break;
    if (!/\.json$/i.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.statSync(p);
      if (!st.isFile() || st.size > MAX_BYTES) continue;
    } catch (_) { continue; }
    n++;
    try { collectPathStrings(JSON.parse(fs.readFileSync(p, 'utf8')), out, 0); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
  }
  return out;
}

/** 汇总所有线索路径（设置值 + 旧 json 里的路径） */
function hintPaths() {
  const hints = collectPathStrings(settingsRaw(), [], 0);
  const legacy = legacyBase();
  for (const p of pathsFromLegacyJson(legacy)) hints.push(p);
  return hints;
}

/** 已存在且可写（**不创建目录**）；不存在一律 false —— 探测期绝不产生空目录 */
function canUseExisting(dir) {
  try {
    if (!dir || !fs.existsSync(dir)) return false;
    if (!fs.statSync(dir).isDirectory()) return false;
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
}

/** 目录还不存在，但父目录存在且可写（用于「全新安装，允许现场建」） */
function canCreateUnder(dir) {
  try {
    if (!dir) return false;
    if (fs.existsSync(dir)) return false;         // 已存在就走 canUseExisting
    const parent = path.dirname(dir);
    if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) return false;
    const probe = path.join(parent, '.write-probe-' + process.pid);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
}

/** 该目录里是否真有数据（交给纯函数判定） */
function hasDataAt(dir) {
  return Pick.hasDataDir(dir, { fs, readyMark: READY_MARK });
}

/** 目录可写探测（顺带创建） */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.write-probe');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch (_) { return false; }
}

/** 解析数据根目录（结果缓存；app ready 前后调用都安全） */
function resolveRoot() {
  if (_root) return _root;
  /* E2E（scripts/e2e）：强制独立数据根，绝不碰用户真实曲库/模型。
     只有设置了环境变量才生效；正常启动完全不走这条路。 */
  const e2eRoot = process.env.FUFUMIDI_E2E_DATA_ROOT || '';
  if (e2eRoot && writable(e2eRoot)) { _root = e2eRoot; _rootReason = 'e2e'; return _root; }

  const preferred = path.join(installRoot(), DIR_NAME);
  const userData = userDataBase();
  const configured = configuredRoot();
  const last = lastUsedRoot();

  // 历史数据根候选：从设置里的绝对路径反推（本次报障的关键一路）
  let discovered = [];
  try {
    discovered = Pick.rootsFromHints(hintPaths(), DIR_NAME);
    // 只留「已存在且有数据」的，供设置页展示（不含当前选中的那个）
    _discoveredCache = discovered.filter((d) => {
      if (d === preferred || d === userData || d === configured) return false;
      try { return hasDataAt(d) && canUseExisting(d); } catch (_) { return false; }
    });
  } catch (_) { discovered = []; _discoveredCache = []; }

  let picked;
  try {
    picked = Pick.pickDataRoot({
      configured, last, preferred, userData, discovered,
      canUse: canUseExisting, canCreate: canCreateUnder, hasData: hasDataAt,
    });
  } catch (e) {
    console.warn('[data-root] 选择逻辑异常，走旧路径：' + (e && e.message));
    picked = null;
  }

  if (picked && picked.root) {
    _root = picked.root;
    _rootReason = picked.reason;
    _rootFrom = picked.from;
    // 认领了历史目录：它是已存在的真实目录，标一个 ready 免得后续被当成「待迁移目标」
    if (picked.reason === 'adopted-previous' || picked.reason === 'user-data') {
      try { markReady(_root); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
    } else if (picked.reason === 'install-dir' || picked.reason === 'configured') {
      // 全新安装：目录可能还不存在，这里建出来（等价于旧代码 writable() 的副作用）
      try { ensure(_root); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
    }
    return _root;
  }

  /* 旧逻辑兜底（正常不会走到这里：pickDataRoot 必定返回一个候选） */
  const candidates = [];
  if (configured) candidates.push(configured);
  if (preferred !== configured) candidates.push(preferred);
  candidates.push(userData);
  for (const c of candidates) {
    if (writable(c)) {
      _root = c;
      if (c === preferred) _rootReason = 'install-dir';
      else if (c === configured) _rootReason = 'configured';
      else _rootReason = configured ? 'configured-not-writable' : 'install-dir-not-writable';
      return _root;
    }
  }
  _root = userData;
  _rootReason = 'no-writable-location';
  return _root;
}

/**
 * 把本次实际使用的数据根记到 settings.data_root_last。
 *
 * 为什么需要：6.2.4 报障的根因就是「换安装位置后没有任何记录能找回旧目录」。
 * 记下这一条之后，下次升级/换安装位置时 pickDataRoot 的第 ② 步就能把它找回来。
 * 只在变化时写，读-合并-写 + 临时文件原子替换，避免和 settings 服务并发写截断。
 * 显式写了 settings.data_root 的用户不受影响（那是第 ① 步，优先级更高）。
 */
function rememberRoot() {
  try {
    if (!_root || _rootReason === 'e2e') return false;
    const s = settingsRaw();
    if (s.data_root_last === _root) return false;
    s.data_root_last = _root;
    const file = settingsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp-root';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.warn('[data-root] 记录本次数据根失败：' + (e && e.message));
    return false;
  }
}

function dataRoot() { return resolveRoot(); }
function rootReason() { return _rootReason || (resolveRoot(), _rootReason); }
/** 本次数据根是凭什么选的（settings.data_root_last / settings-paths / install-dir / …） */
function rootFrom() { resolveRoot(); return _rootFrom || ''; }
/** 已发现的历史数据根候选（供设置页展示，不含当前选中的） */
function discoveredRoots() {
  resolveRoot();
  try {
    return _discoveredCache || [];
  } catch (_) { return []; }
}

function at(...parts) { return path.join(resolveRoot(), ...parts); }

function ensure(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } } return dir; }

/* ---------------- 各功能区目录 ---------------- */

/** 目录是否仍在旧位置（迁移未完成） */
function legacyOf(name) { return _legacy[name] || null; }

function areaDir(name) {
  if (_legacy[name]) return _legacy[name];
  return ensure(at(name));
}

/** 模型目录（FUFUMIDI_MODELS_DIR / TORCH_HOME） */
function modelsDir() { return areaDir('models'); }
/** GPU 增强包根目录 */
function gpuEnhanceRoot() { return areaDir('gpu-enhancements'); }
/** 音色库目录 */
function soundfontsDir() { return areaDir('soundfonts'); }
/** UTAU 声库目录 */
function voicebanksDir() { return areaDir('voicebanks'); }
/** DiffSinger 模块根目录（运行时组件与通用声码器；模块未启用时保持为空） */
function diffsingerRoot() { return areaDir('diffsinger'); }
/** DiffSinger 声库目录 */
function diffsingerVoicebanksDir() { return areaDir('diffsinger-voicebanks'); }
/** 曲库 MIDI 真实文件目录（不迁移：本目录是本次新增的） */
function midiDir() { return ensure(at('midi')); }
/** 第三方缓存根目录 */
function cacheRoot() { return ensure(at('cache')); }
function cacheDir(name) { return name ? ensure(path.join(cacheRoot(), name)) : cacheRoot(); }

/**
 * 转录「暂停/继续」标记文件（2026-10-14 用户要求：正在转录的那一首也要能暂停，继续后接着跑）。
 * 引擎跑在常驻 Python worker 里，主进程/渲染进程没有别的通道能塞进去 —— 文件是唯一
 * 既能跨进程、又不用改 stdin 请求协议的开关：文件存在 = 暂停，删掉 = 继续。
 * 路径通过 env.FUFUMIDI_PAUSE_FILE 传给引擎（engine_muscriptor 的 _pause_gate 轮询它）。
 */
function pauseFlagFile() { return path.join(cacheRoot(), 'fufumidi_pause.flag'); }
/** pip 下载缓存 */
function pipCacheDir() { return cacheDir('pip'); }
/** HuggingFace Hub 缓存（HF_HOME） */
function hfCacheDir() { return cacheDir('huggingface'); }
/** 中间产物目录（替代系统 Temp，避免临时文件堆在 C 盘） */
function tempDir() { return ensure(at('temp')); }
/** 数据根目录下的日志 */
function logDir() { return ensure(at('logs')); }

/* ---------------- 环境变量（供 Python 子进程） ---------------- */

/**
 * 把「依赖 / 环境 / 模型 / 缓存」相关的路径全部指向数据根目录。
 * 只写与本应用相关的键，不覆盖调用方额外传入的值。
 */
function applyToEnv(env) {
  const root = resolveRoot();
  env.FUFUMIDI_DATA_ROOT = root;
  env.FUFUMIDI_MODELS_DIR = modelsDir();
  env.FUFUMIDI_SOUNDFONTS_DIR = soundfontsDir();
  env.FUFUMIDI_MIDI_DIR = midiDir();
  env.FUFUMIDI_DIFFSINGER_ROOT = diffsingerRoot();
  env.FUFUMIDI_DIFFSINGER_VB_DIR = diffsingerVoicebanksDir();
  env.FUFUMIDI_TEMP_DIR = tempDir();
  env.FUFUMIDI_CACHE_DIR = cacheRoot();
  env.FUFUMIDI_PAUSE_FILE = pauseFlagFile();

  // torch.hub.get_dir() = $TORCH_HOME/hub；beat_this 权重按 models/hub/checkpoints 落盘，
  // 因此 TORCH_HOME 必须等于 models 目录（资源中心与引擎共用同一份）。
  env.TORCH_HOME = modelsDir();

  // HuggingFace：默认会落到 ~/.cache/huggingface（C 盘用户目录）→ 统一收进数据根目录
  const hf = hfCacheDir();
  env.HF_HOME = hf;
  env.HF_HUB_CACHE = path.join(hf, 'hub');
  env.HUGGINGFACE_HUB_CACHE = env.HF_HUB_CACHE;
  env.TRANSFORMERS_CACHE = env.HF_HUB_CACHE;
  env.HF_XET_CACHE = path.join(hf, 'xet');
  env.SENTENCE_TRANSFORMERS_HOME = path.join(hf, 'sentence-transformers');

  // pip / matplotlib / numba 等第三方缓存
  env.PIP_CACHE_DIR = pipCacheDir();
  env.MPLCONFIGDIR = cacheDir('matplotlib');
  env.NUMBA_CACHE_DIR = cacheDir('numba');
  env.NUMBA_CACHE_DIR_INTERNAL = env.NUMBA_CACHE_DIR;
  // 跨平台兜底：Linux/macOS 下这些库会回落到 ~/.cache / ~/.triton / ~/.cache/torch_extensions
  env.XDG_CACHE_HOME = cacheRoot();
  env.TORCH_EXTENSIONS_DIR = cacheDir('torch_extensions');
  env.TRITON_CACHE_DIR = cacheDir('triton');
  env.TORCHINDUCTOR_CACHE_DIR = cacheDir('torchinductor');
  env.HF_DATASETS_CACHE = path.join(hf, 'datasets');

  // 引擎中间产物：统一到 root/temp（原先落系统 Temp）
  const tmp = tempDir();
  env.TEMP = tmp;
  env.TMP = tmp;
  env.TMPDIR = tmp;
  return env;
}

/* ---------------- 迁移（旧 userData → 数据根目录） ---------------- */

function areaReady(dir) {
  try { return fs.existsSync(path.join(dir, READY_MARK)); } catch (_) { return false; }
}
function markReady(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, READY_MARK), new Date().toISOString());
  } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
}
function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let items = [];
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      const p = path.join(d, it.name);
      try {
        if (it.isDirectory()) walk(p);
        else if (it.isFile()) total += fs.statSync(p).size;
      } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
    }
  };
  walk(dir);
  return total;
}
/**
 * 异步统计目录体积：边遍历边让出事件循环，避免在 models / gpu-enhancements
 * （数万文件）上把主进程阻塞好几秒；超过预算则返回部分结果并标记 partial。
 */
async function dirSizeAsync(dir, budgetMs = 3000) {
  const t0 = Date.now();
  let total = 0, partial = false, pending = 0;
  const root = path.resolve(dir);
  async function walk(d) {
    if (partial) return;
    if (Date.now() - t0 > budgetMs) { partial = true; return; }
    let items = [];
    try { items = await fs.promises.readdir(d, { withFileTypes: true }); } catch (_) { return; }
    for (const it of items) {
      if (partial) return;
      const p = path.join(d, it.name);
      if (it.isDirectory()) { await walk(p); continue; }
      if (!it.isFile()) continue;
      try { total += (await fs.promises.stat(p)).size; } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
      if (++pending >= 400) { pending = 0; await new Promise(r => setImmediate(r)); }
    }
  }
  await walk(root);
  return { size: total, partial: partial && total > 0 };
}
function freeSpace(dir) {
  try { return fs.statfsSync(dir).bavail * fs.statfsSync(dir).bsize; } catch (_) { return null; }
}

/**
 * 计算待迁移项（不复制任何数据，供启动时快速判断）。
 * 返回 [{ name, from, to, size }]
 */
function pendingMigration() {
  const out = [];
  const root = resolveRoot();
  for (const spec of MIGRATE_DIRS) {
    const from = spec.legacy();
    const to = path.join(root, spec.name);
    // 配置把数据根目录指到了旧位置本身：from === to，迁移毫无意义且绝不能删目录
    if (path.resolve(from) === path.resolve(to)) {
      markReady(to);
      continue;
    }
    if (!fs.existsSync(from)) {
      // 旧位置没有：若目标目录存在但没有 ready 标记，补一个（说明是本次新建的空目录）
      if (fs.existsSync(to) && !areaReady(to)) markReady(to);
      continue;
    }
    if (areaReady(to)) continue;                  // 已迁移
    // 目标已有内容，且不是「上次迁移中断留下的半成品」→ 不能整体清空；
    // 报为冲突并沿用旧路径，保住两边数据（旧版手工拷贝过数据、便携版自带 models 等场景）
    if (hasForeignContent(to)) {
      out.push({ name: spec.name, from, to, size: 0, conflict: true });
      continue;
    }
    out.push({ name: spec.name, from, to, size: dirSize(from) });
  }
  return out;
}

/** 目标目录里是否有「不属于本应用迁移流程」的既有内容 */
function hasForeignContent(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    if (fs.existsSync(path.join(dir, MIGRATING_MARK))) return false;   // 上次中断的半成品：允许清掉重来
    return fs.readdirSync(dir).length > 0;
  } catch (_) { return false; }
}

/**
 * 递归复制目录，按字节回报进度（跨盘迁移用；fs.cpSync 无法给进度）。
 * 返回复制的字节数。
 */
function copyDirProgress(src, dst, totalBytes, onBytes) {
  let copied = 0;
  const walk = async (s, d) => {
    await fs.promises.mkdir(d, { recursive: true });
    let items = [];
    try { items = await fs.promises.readdir(s, { withFileTypes: true }); } catch (_) { return; }
    let since = 0;
    for (const it of items) {
      const sp = path.join(s, it.name), dp = path.join(d, it.name);
      if (it.isDirectory()) { await walk(sp, dp); continue; }
      if (!it.isFile()) continue;                 // 跳过符号链接/junction，避免复制出畸形结构
      try {
        await fs.promises.copyFile(sp, dp);
      } catch (e) {
        throw new Error('复制失败 ' + it.name + '：' + ((e && e.message) || e));
      }
      let sz = 0;
      try { sz = (await fs.promises.stat(sp)).size; } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
      copied += sz; since += sz;
      if (onBytes) onBytes(copied, totalBytes);
      // 每累计 ~8MB 让出一次事件循环：迁移期间进度窗才能持续刷新
      if (since >= 8 * 1024 * 1024) { since = 0; await new Promise(r => setImmediate(r)); }
    }
  };
  return walk(src, dst).then(() => copied);
}

/**
 * 执行迁移。同步阻塞，调用方负责显示进度窗口。
 * onProgress({ name, index, total, phase, copied, size })
 * 返回 { moved:[], failed:[{name,error}] }
 */
function runMigration(items, onProgress) {
  const moved = [], failed = [];
  const steps = items.map((it, i) => async () => {
    const report = (phase, copied) => {
      try { onProgress && onProgress({ ...it, index: i + 1, total: items.length, phase, copied: copied || 0 }); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
    };
    report('start');
    try {
      // 目标已有他人数据：跳过迁移（绝不清空），让调用方沿用旧路径
      if (it.conflict) throw new Error('数据目录中已有同名内容，为避免覆盖已跳过迁移');
      // 半成品清理：目标存在但没 ready 标记 → 上次中断，整目录重来
      try { fs.rmSync(it.to, { recursive: true, force: true }); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
      try { fs.mkdirSync(path.dirname(it.to), { recursive: true }); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
      // 先落「迁移中」标记：中途崩溃/断电时下次启动才知道这个半成品可以安全清掉
      try {
        fs.mkdirSync(it.to, { recursive: true });
        fs.writeFileSync(path.join(it.to, MIGRATING_MARK), new Date().toISOString());
      } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
      const free = freeSpace(path.dirname(it.to));
      if (free != null && it.size && free < it.size * 1.05) {
        throw new Error('目标磁盘剩余空间不足（需要 ' + Math.ceil(it.size / 1048576) + ' MB）');
      }
      // 同盘 rename 瞬时完成；跨盘回退「逐文件复制 + 进度 + 删除旧副本」
      let done = false;
      try { fs.renameSync(it.from, it.to); done = true; } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
      if (!done) {
        report('copy', 0);
        await copyDirProgress(it.from, it.to, it.size, (copied) => report('copy', copied));
        report('cleanup', it.size);
        fs.rmSync(it.from, { recursive: true, force: true });
      }
      markReady(it.to);
      try { fs.rmSync(path.join(it.to, MIGRATING_MARK), { force: true }); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
      moved.push(it.name);
      report('done', it.size);
    } catch (e) {
      failed.push({ name: it.name, error: String((e && e.message) || e) });
      // 迁移失败：该项继续沿用旧路径（不只是本次进程，重启后 pendingMigration 也会再试）
      try { fs.rmSync(it.to, { recursive: true, force: true }); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
      report('failed');
    }
  });
  return steps.reduce((p, fn) => p.then(fn), Promise.resolve()).then(() => {
    _migrationReport = { moved, failed, at: new Date().toISOString() };
    return _migrationReport;
  });
}

/** 迁移结果（供 UI 展示） */
function migrationReport() { return _migrationReport; }

/**
 * 标记某功能目录“仍在旧位置”。必须在任何服务创建之前调用，
 * 让 modelsDir()/gpuEnhanceRoot()/soundfontsDir() 返回旧路径。
 */
function useLegacyFor(name, legacyPath) { _legacy[name] = legacyPath; }
function clearLegacy(name) { delete _legacy[name]; }

/* ---------------- 概览（供设置页 / 资源中心展示） ---------------- */

/** 只解析路径、不创建目录（供概览查询，避免「看一眼」就产生写盘副作用） */
function peekDir(name) {
  if (_legacy[name]) return _legacy[name];
  return path.join(resolveRoot(), name);
}

/**
 * 数据目录概览（异步）：体积统计走 dirSizeAsync，边遍历边让出事件循环，
 * 不会在 models / gpu-enhancements 这种数万文件的目录上把主进程卡住。
 */
async function overview() {
  const root = resolveRoot();
  const entries = [
    { key: 'models', label: '模型权重' },
    { key: 'gpu-enhancements', label: 'GPU 增强包' },
    { key: 'soundfonts', label: '音色库' },
    { key: 'voicebanks', label: 'UTAU 声库' },
    { key: 'diffsinger', label: 'DiffSinger 组件' },
    { key: 'diffsinger-voicebanks', label: 'DiffSinger 声库' },
    { key: 'midi', label: 'MIDI 曲库文件' },
    { key: 'cache', label: '第三方缓存' },
    { key: 'temp', label: '中间产物' },
  ];
  const out = [];
  for (const e of entries) {
    const dir = peekDir(e.key);
    const spec = MIGRATE_DIRS.find(m => m.name === e.key);
    const legacyDir = spec ? spec.legacy() : null;
    const exists = (() => { try { return fs.existsSync(dir); } catch (_) { return false; } })();
    const r = exists ? await dirSizeAsync(dir) : { size: 0, partial: false };
    out.push({
      key: e.key, label: e.label, dir, exists,
      legacyDir,
      pending: !!(legacyDir && exists2(legacyDir) && !areaReady(dir)),
      conflict: !!(legacyDir && exists2(legacyDir) && !areaReady(dir) && hasForeignContent(dir)),
      size: r.size,
      sizePartial: r.partial,
    });
  }
  return {
    ok: true,
    root,
    reason: rootReason(),
    from: rootFrom(),
    installRoot: installRoot(),
    legacyBase: legacyBase(),
    configured: configuredRoot(),
    lastRoot: lastUsedRoot(),
    discovered: discoveredRoots(),
    entries: out,
    migration: _migrationReport,
  };
}
function exists2(p) { try { return fs.existsSync(p); } catch (_) { return false; } }

/** 某功能目录的旧版落点（历史路径不统一，按注册表返回） */
function legacyPathOf(name) {
  const spec = MIGRATE_DIRS.find(m => m.name === name);
  return spec ? spec.legacy() : path.join(legacyBase(), name);
}

module.exports = {
  DIR_NAME,
  installRoot,
  legacyBase,
  legacyPathOf,
  userDataBase,
  dataRoot,
  rootReason,
  rootFrom,
  discoveredRoots,
  rememberRoot,
  at,
  modelsDir,
  gpuEnhanceRoot,
  soundfontsDir,
  voicebanksDir,
  diffsingerRoot,
  diffsingerVoicebanksDir,
  midiDir,
  cacheRoot,
  cacheDir,
  pauseFlagFile,
  pipCacheDir,
  hfCacheDir,
  tempDir,
  logDir,
  applyToEnv,
  pendingMigration,
  runMigration,
  migrationReport,
  useLegacyFor,
  clearLegacy,
  legacyOf,
  overview,
  peekDir,
  settingsFile,
};
