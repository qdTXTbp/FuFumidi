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
//     gpu-enhancements/  GPU 增强包（CUDA / DirectML 的 site-packages）
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

const DIR_NAME = 'FuFumidiData';
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
// 迁移未完成的项：值为旧路径（服务继续用旧路径，避免读到半成品）
const _legacy = Object.create(null);
let _migrationReport = null;

/* ---------------- 基础路径 ---------------- */

function installRoot() {
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
  const preferred = path.join(installRoot(), DIR_NAME);
  const configured = configuredRoot();
  const candidates = [];
  if (configured) candidates.push(configured);
  if (preferred !== configured) candidates.push(preferred);
  candidates.push(userDataBase());
  for (const c of candidates) {
    if (writable(c)) {
      _root = c;
      if (c === preferred) _rootReason = 'install-dir';
      else if (c === configured) _rootReason = 'configured';
      else if (c === userDataBase()) _rootReason = configured ? 'configured-not-writable' : 'install-dir-not-writable';
      return _root;
    }
  }
  _root = userDataBase();
  _rootReason = 'no-writable-location';
  return _root;
}

function dataRoot() { return resolveRoot(); }
function rootReason() { return _rootReason || (resolveRoot(), _rootReason); }

function at(...parts) { return path.join(resolveRoot(), ...parts); }

function ensure(dir) { try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} return dir; }

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
/** 曲库 MIDI 真实文件目录（不迁移：本目录是本次新增的） */
function midiDir() { return ensure(at('midi')); }
/** 第三方缓存根目录 */
function cacheRoot() { return ensure(at('cache')); }
function cacheDir(name) { return name ? ensure(path.join(cacheRoot(), name)) : cacheRoot(); }
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
  env.FUFUMIDI_TEMP_DIR = tempDir();
  env.FUFUMIDI_CACHE_DIR = cacheRoot();

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
  } catch (_) {}
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
      } catch (_) {}
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
      try { total += (await fs.promises.stat(p)).size; } catch (_) {}
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
      try { sz = (await fs.promises.stat(sp)).size; } catch (_) {}
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
      try { onProgress && onProgress({ ...it, index: i + 1, total: items.length, phase, copied: copied || 0 }); } catch (_) {}
    };
    report('start');
    try {
      // 目标已有他人数据：跳过迁移（绝不清空），让调用方沿用旧路径
      if (it.conflict) throw new Error('数据目录中已有同名内容，为避免覆盖已跳过迁移');
      // 半成品清理：目标存在但没 ready 标记 → 上次中断，整目录重来
      try { fs.rmSync(it.to, { recursive: true, force: true }); } catch (_) {}
      try { fs.mkdirSync(path.dirname(it.to), { recursive: true }); } catch (_) {}
      // 先落「迁移中」标记：中途崩溃/断电时下次启动才知道这个半成品可以安全清掉
      try {
        fs.mkdirSync(it.to, { recursive: true });
        fs.writeFileSync(path.join(it.to, MIGRATING_MARK), new Date().toISOString());
      } catch (_) {}
      const free = freeSpace(path.dirname(it.to));
      if (free != null && it.size && free < it.size * 1.05) {
        throw new Error('目标磁盘剩余空间不足（需要 ' + Math.ceil(it.size / 1048576) + ' MB）');
      }
      // 同盘 rename 瞬时完成；跨盘回退「逐文件复制 + 进度 + 删除旧副本」
      let done = false;
      try { fs.renameSync(it.from, it.to); done = true; } catch (_) {}
      if (!done) {
        report('copy', 0);
        await copyDirProgress(it.from, it.to, it.size, (copied) => report('copy', copied));
        report('cleanup', it.size);
        fs.rmSync(it.from, { recursive: true, force: true });
      }
      markReady(it.to);
      try { fs.rmSync(path.join(it.to, MIGRATING_MARK), { force: true }); } catch (_) {}
      moved.push(it.name);
      report('done', it.size);
    } catch (e) {
      failed.push({ name: it.name, error: String((e && e.message) || e) });
      // 迁移失败：该项继续沿用旧路径（不只是本次进程，重启后 pendingMigration 也会再试）
      try { fs.rmSync(it.to, { recursive: true, force: true }); } catch (_) {}
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
    installRoot: installRoot(),
    legacyBase: legacyBase(),
    configured: configuredRoot(),
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
  at,
  modelsDir,
  gpuEnhanceRoot,
  soundfontsDir,
  voicebanksDir,
  midiDir,
  cacheRoot,
  cacheDir,
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
