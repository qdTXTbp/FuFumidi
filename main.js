// ============================================================
// FuFumidi —— Electron 主进程
// 纯离线本地应用：加载内置 renderer 界面 + 本地 Python 转录引擎子进程
// ============================================================
const { app, BrowserWindow, session, dialog, shell, Menu, ipcMain, net, Tray } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('error', reject);
    s.on('data', d => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
  });
}
const { createIntegrity } = require('./integrity');
const Paths = require('./main/paths');
const GpuService = require('./main/gpu');
const {
  gpuEnhanceDir,
  gpuEnhanceSite,
  installedGpuKinds,
  inferGpuKind,
  writeGpuManifest,
  installGpuSite,
  isSplitPackagePath,
  combineSplitParts,
} = GpuService;
const { createEngineService } = require('./main/engine');
const { DEFAULT_SETTINGS, SETTINGS_PATH, readSettings, writeSettings } = require('./main/settings');
const { registerUpdateIpc } = require('./main/update');
const { registerScoreIpc } = require('./main/score');
const { createPluginService } = require('./main/plugins');
const { registerTaskQueueIpc } = require('./main/task-queue');
const { registerVideoIpc } = require('./main/video');
const { registerPresetsIpc } = require('./main/presets');
const { registerDialogsIpc } = require('./main/dialogs');
const { registerModelsIpc } = require('./main/models');
const { registerSettingsIpc } = require('./main/settings-ipc');
const { registerDiagnosticsIpc } = require('./main/diagnostics');
const { registerSystemIpc } = require('./main/system-ipc');
const { registerGpuIpc } = require('./main/gpu-ipc');
const { createRustService } = require('./main/rust');
const { createDbService } = require('./main/db');
const { registerLibraryIpc } = require('./main/library');
const { registerWallpaperIpc } = require('./main/wallpaper');
const { registerUtauIpc } = require('./main/utau');
const { registerSoundfontWorkshopIpc } = require('./main/soundfonts');
const { createWindow, configureSession, openFileFromArgv, openPath } = require('./main/window');
const { pyLit, parsePyJson } = require('./main/py-util');

const APP_ID = 'com.fufumidi.app';
app.setAppUserModelId(APP_ID);

// ---------- GPU 加速开关（须在 app ready 前设置）----------
// 动态壁纸等全屏视频渲染：启用硬件视频解码 + GPU 光栅化 + 零拷贝，
// 把解码/合成从 CPU 主线程卸载到 GPU，降低 CPU 占用。
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport,HardwareMediaKeyHandling');
// 视情况启用 angle 后端
app.commandLine.appendSwitch('use-angle', 'default');
// Chromium 的磁盘缓存（Cache / Code Cache / GPUCache）同样不留在 C 盘用户目录。
// 只重定向「磁盘缓存」，不动 sessionData —— IndexedDB / LocalStorage 里存着曲库字节与歌单，
// 改 sessionData 等于换用户目录，会丢数据。必须在 app ready 之前设置。
try {
  const chromiumCache = Paths.cacheDir('chromium');
  if (chromiumCache) app.commandLine.appendSwitch('disk-cache-dir', chromiumCache);
} catch (_) {}

const isDev = !app.isPackaged;

// ---------- 单实例锁：保证双击 .mid 打开进同一个窗口 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    openFileFromArgv(argv, (p) => openPath({ BrowserWindow, fs }, p));
  });

  app.whenReady().then(async () => {
    configureSession({ session, dialog, app });
    registerSystemIpc({ ipcMain, integrity, BrowserWindow, path, shell, app, fs, spawnEngine, dialog });
    registerUpdateIpc({ ipcMain, shell, BrowserWindow, app, path, fs, net });
    registerScoreIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline });
    registerTaskQueueIpc({ ipcMain, BrowserWindow, app, path, fs, spawnEngine, engineWorkerConvert, pluginHost, readSettings, resolveSeparateModel: (id) => (ModelsService ? ModelsService.resolveSeparateModel(id) : null) });
    registerVideoIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline, parsePyJson });
    registerPresetsIpc({ ipcMain, runEngineInline, parsePyJson, pyLit });
    registerDialogsIpc({ ipcMain, dialog, path, fs, app });
    registerDiagnosticsIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, spawnEngine });
    // 依赖 / 环境 / 模型目录规范化：把旧版散落在 C 盘用户目录下的重型目录
    // 一次性迁移到「工具目录」旁的 FuFumidiData（迁移期间显示进度窗）。
    // 必须在模型服务、GPU 服务之前完成，避免服务拿到半成品目录。
    await prepareDataRoot();
    // 模型目录迁移 + 内置模型 junction（须在模型服务注册前完成 junction，迁移可后台）
    try { linkBundledModels(); } catch (_) {}
    try { healModelsDir(); } catch (_) {} // 清除断链（安装器替换 resources/models 后旧 junction 目标消失）
    migrateUserModels();
    ModelsService = registerModelsIpc({ ipcMain, BrowserWindow, app, path, fs, net, modelsDir, engineDir, sha256File, readSettings });
    DbService = createDbService({ app, path, fs });
    DbService.registerDbIpc({ ipcMain });
    // 可选 Rust 核心：先建好服务，供曲库文件体检/重复检测等热点路径优先使用
    const RustService = createRustService({ app, path, fs });
    RustService.registerRustIpc({ ipcMain });
    // 曲库文件服务：每个 MIDI 曲目都必须对应一个真实 .mid 文件（<数据根目录>/midi）
    registerLibraryIpc({
      ipcMain, path, fs, shell,
      rustInvoke: (args, timeoutMs) => RustService.invoke(args, timeoutMs),
    });
    registerSettingsIpc({ ipcMain, readSettings, writeSettings, db: DbService });
    registerWallpaperIpc({ ipcMain, app, fs, net, runEngineInline, parsePyJson });
    registerUtauIpc({ ipcMain, BrowserWindow, path, fs, os, app, dialog, net, spawnEngine });
    registerSoundfontWorkshopIpc({ ipcMain, BrowserWindow, app, path, fs, net });
    registerPluginsIpc();
    registerGpuIpc({
      ipcMain, dialog, BrowserWindow, app, path, fs, net, spawn,
      stopEngineWorker, resetBaseToCpu,
      installedGpuKinds, gpuEnhanceDir, gpuEnhanceSite,
      inferGpuKind, writeGpuManifest, installGpuSite,
      isSplitPackagePath, combineSplitParts,
      engineDir, engineEnv, resolvePython,
      runEngineInline, parsePyJson,
    });
    const mainWin = createWindow({ BrowserWindow, shell, pluginHost, rootDir: __dirname });
    setupTray({ win: mainWin, app, readSettings, rootDir: __dirname });
    Menu.setApplicationMenu(null); // 隐藏默认菜单栏，界面更清爽

    // 启动参数里带上 .mid/.midi 时（例如：双击文件 / 命令行调用）自动打开
    setTimeout(() => openFileFromArgv(process.argv, (p) => openPath({ BrowserWindow, fs }, p)), 600);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow({ BrowserWindow, shell, pluginHost, rootDir: __dirname });
    });
  });
}

// ---------- Python 路径解析（跨平台 + 内置运行时优先） ----------
// 内置运行时：打包时用 python-build-standalone 分发自包含 CPython + 预装依赖，
// 使应用在任意平台开箱即用，无需用户安装 Python。
// ---------- 系统托盘：最小化/关闭到托盘后台播放（设置 close_to_tray，默认开） ----------
let _tray = null;
function setupTray({ win, app, readSettings, rootDir }) {
  // Tray 只能用真实磁盘图标：打包后 __dirname 在 asar 内，build/ 图标经 extraResources
  // 落到 resources/icon.png；开发模式回退源码树 build/。
  let toTrayOn = () => { let v = true; try { const s = readSettings(); v = !(s && s.close_to_tray === false); } catch (_) {} return v; };
  try {
    const iconCandidates = [
      path.join(process.resourcesPath || '', 'icon.png'),
      path.join(rootDir, 'build', 'icon.png'),
      path.join(rootDir, 'build', 'icon.ico'),
    ];
    const iconPath = iconCandidates.find(p => { try { return p && fs.existsSync(p); } catch (_) { return false; } });
    if (!iconPath) throw new Error('托盘图标缺失: ' + iconCandidates.join(' , '));
    _tray = new Tray(iconPath);
    _tray.setToolTip('FuFumidi');
    const showWin = () => { if (win.isDestroyed()) return; win.show(); win.focus(); };
    _tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示主窗口', click: showWin },
      { label: '播放 / 暂停', click: () => { if (!win.isDestroyed()) win.webContents.send('tray:control', 'playpause'); } },
      { label: '下一首', click: () => { if (!win.isDestroyed()) win.webContents.send('tray:control', 'next'); } },
      { type: 'separator' },
      { label: '退出', click: () => { app.isQuiting = true; app.quit(); } },
    ]));
    _tray.on('double-click', showWin);
  } catch (e) {
    console.warn('[tray] 托盘初始化失败（关闭将直接退出）:', e && e.message);
    _tray = null;
  }
  // 关闭/最小化拦截与 Tray 创建解耦：仅在托盘就绪时隐藏到托盘，
  // 托盘失败时放行默认行为（避免窗口消失后无法找回）
  win.on('close', (e) => {
    if (!app.isQuiting && _tray && toTrayOn()) { e.preventDefault(); win.hide(); }
  });
  win.on('minimize', (e) => {
    if (_tray && toTrayOn()) { e.preventDefault(); win.hide(); }
  });
  app.on('before-quit', () => { app.isQuiting = true; });
}
function bundledPython() {
  const names = process.platform === 'win32' ? ['python.exe'] : ['python', 'python3'];
  const roots = [
    path.join(process.resourcesPath, 'python'),   // 打包后 extraResources 分发到 resources/python
    path.join(__dirname, '..', 'python'),         // 打包后随 app 分发（兼容旧布局）
    path.join(__dirname, 'python'),
    path.join(__dirname, 'engine', 'python'),
  ];
  for (const root of roots) {
    for (const n of names) {
      const p = path.join(root, n);
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}
function resolvePython() {
  const s = readSettings();
  if (s.engine_path && fs.existsSync(s.engine_path)) return s.engine_path;  // 用户显式指定优先
  const b = bundledPython();
  if (b) return b;                                                            // 内置运行时其次
  if (process.env.FUFUMIDI_PYTHON && fs.existsSync(process.env.FUFUMIDI_PYTHON)) return process.env.FUFUMIDI_PYTHON;
  if (process.platform === 'win32') {
    // 开发机已知的完整环境（含 torch/demucs，供钢琴/人声分离模式）
    if (fs.existsSync('D:/manga-image-translator/Miniconda3/python.exe')) return 'D:/manga-image-translator/Miniconda3/python.exe';
    return 'python';
  }
  return 'python3';
}

// ---------- 引擎子进程（通用：music2midi.py / smart_midi.py） ----------
// engine 目录：打包后 engine/**/* 被 asarUnpack 到 resources/app.asar.unpacked/engine。
// Python 子进程读不了 asar 归档内的文件，必须指向真实文件系统路径。
function engineDir() {
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', 'engine');
  if (fs.existsSync(path.join(unpacked, 'music2midi.py'))) return unpacked;
  return path.join(__dirname, 'engine');
}

// ---------- 数据目录规范化（依赖 / 环境 / 模型 / 缓存的唯一落点） ----------
// 默认落在「工具目录」旁的 FuFumidiData/，不挤占 C 盘；安装目录不可写时
// 自动回退用户数据目录。升级自旧版时，把旧位置的重型目录一次性迁移过来。
async function prepareDataRoot() {
  let pending = [];
  try { pending = Paths.pendingMigration(); } catch (e) { console.warn('[data-root] 检查失败:', e && e.message); }
  if (!pending.length) { console.log('[data-root] ' + Paths.dataRoot()); return; }
  const totalBytes = pending.reduce((a, b) => a + (b.size || 0), 0);
  const mb = Math.ceil(totalBytes / 1048576);
  let splash = null;
  const setText = (txt, pct) => {
    if (!splash || splash.isDestroyed()) return;
    try {
      splash.webContents.executeJavaScript(
        'window.__t(' + JSON.stringify(txt) + ',' + (pct == null ? 'null' : Number(pct)) + ')', true
      ).catch(() => {});
    } catch (_) {}
  };
  try {
    splash = new BrowserWindow({
      width: 460, height: 180, frame: false, resizable: false, movable: false, maximizable: false,
      minimizable: false, alwaysOnTop: true, skipTaskbar: true, show: false, backgroundColor: '#12151b',
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false },
    });
    splash.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(dataRootSplashHtml()));
    splash.once('ready-to-show', () => { try { splash.show(); } catch (_) {} });
  } catch (_) { splash = null; }
  setText('正在把依赖与模型迁移到工具目录（约 ' + mb + ' MB，仅首次）…', 0);
  let rep = { moved: [], failed: [] };
  try {
    rep = await Paths.runMigration(pending, (p) => {
      const verb = p.phase === 'copy' ? '正在复制' : p.phase === 'cleanup' ? '正在清理旧副本' : '正在处理';
      const pct = p.size ? Math.round((p.copied || 0) / p.size * 100) : null;
      setText(verb + ' ' + p.name + '（' + p.index + '/' + p.total + '）' + (pct != null ? ' ' + pct + '%' : ''), pct);
    });
  } catch (e) {
    console.warn('[data-root] 迁移异常:', e && e.message);
  }
  // 迁移失败项：本次运行继续沿用旧路径（旧数据仍可用），下次启动会重试
  for (const f of rep.failed) {
    try { Paths.useLegacyFor(f.name, Paths.legacyPathOf(f.name)); } catch (_) {}
  }
  if (splash && !splash.isDestroyed()) { try { splash.destroy(); } catch (_) {} }
  console.log('[data-root] root=' + Paths.dataRoot() + ' moved=[' + rep.moved.join(',') + '] failed=' + JSON.stringify(rep.failed));
}
function dataRootSplashHtml() {
  return '<!doctype html><html><head><meta charset="utf-8"><title>FuFumidi</title><style>'
    + 'html,body{margin:0;height:100%;background:#12151b;color:#e9ebef;'
    + 'font:13px/1.7 "Microsoft YaHei",system-ui,-apple-system,sans-serif;'
    + 'display:flex;align-items:center;justify-content:center;flex-direction:column;gap:14px;user-select:none}'
    + '.t{font-size:13px;opacity:.92;padding:0 24px;text-align:center}'
    + '.s{font-size:11px;opacity:.5}'
    + '.b{width:320px;height:5px;border-radius:3px;background:#252a34;overflow:hidden}'
    + '.b i{display:block;height:100%;width:0%;border-radius:3px;background:#5b9cf8;transition:width .25s ease}'
    + '.b.ind i{width:36%;animation:r 1.15s linear infinite}'
    + '@keyframes r{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}'
    + '</style></head><body><div class="t" id="t">正在准备数据目录…</div>'
    + '<div class="b ind" id="b"><i id="i"></i></div>'
    + '<div class="s">把依赖与模型集中到工具目录，避免占用 C 盘</div>'
    + '<script>window.__t=function(s,p){'
    + 'var e=document.getElementById("t");if(e)e.textContent=s;'
    + 'var b=document.getElementById("b"),i=document.getElementById("i");'
    + 'if(!b||!i)return;'
    + 'if(p==null||p<=0){b.className="b ind";i.style.width="36%";}'
    + 'else{b.className="b";i.style.width=Math.min(100,p)+"%";}'
    + '};</script></body></html>';
}
// 模型目录双轨制：
//   用户模型 → 数据根目录（<工具目录>/FuFumidiData/models），不挤占 C 盘
//   内置模型 → resources/models（extraResources，只读分发）
// 引擎只看 FUFUMIDI_MODELS_DIR（数据根目录）；内置模型通过 NTFS junction 透出（免管理员权限）
function bundledModelsDir() {
  const packaged = path.join(process.resourcesPath, 'models');
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, 'models');
}
function userModelsDir() {
  return Paths.modelsDir();
}
function modelsDir() {
  return userModelsDir();
}
// 为内置模型的每个顶层「目录」创建 junction（已存在同名真实目录则跳过）。
// 只处理目录：文件（如 basic_pitch_quant.onnx）由迁移复制，目录型 reparse 指向文件在目标更新后会变断链
function linkBundledModels() {
  const from = bundledModelsDir(), to = userModelsDir();
  try {
    for (const name of fs.readdirSync(from)) {
      const src = path.join(from, name);
      let st = null;
      try { st = fs.statSync(src); } catch (_) { continue; }
      if (!st.isDirectory()) continue;
      const dst = path.join(to, name);
      if (fs.existsSync(dst)) continue;
      try { fs.symlinkSync(src, dst, 'junction'); } catch (_) {}
    }
  } catch (_) {}
}
// 修复断链：安装器更新会整体替换 resources/models，旧 junction 的目标目录可能随之消失，
// 残留断链让后续 mkdir/statSync 报 ENOENT（表现为「模型下载损坏 / 无法下载」）。启动时清除断链占位。
function healModelsDir() {
  const root = userModelsDir();
  try {
    for (const name of fs.readdirSync(root)) {
      const p = path.join(root, name);
      let st = null;
      try { st = fs.statSync(p); } catch (_) {}
      if (!st) {
        try { fs.rmSync(p, { recursive: true, force: true }); console.warn('[models] 已移除断链占位:', name); } catch (_) {}
      }
    }
  } catch (_) {}
}
// 一次性迁移：把旧安装目录内已下载的模型复制到用户目录（升级自旧版的用户资产救援）
function migrateUserModels() {
  const to = userModelsDir();
  const flag = path.join(to, '.migrated_v1');
  if (fs.existsSync(flag)) return;
  const from = bundledModelsDir();
  try {
    fs.mkdirSync(to, { recursive: true });
    let moved = 0;
    const copyDir = (src, dst) => {
      fs.mkdirSync(dst, { recursive: true });
      for (const name of fs.readdirSync(src)) {
        const s = path.join(src, name), d = path.join(dst, name);
        const st = fs.lstatSync(s);
        if (st.isDirectory()) copyDir(s, d);
        else if (!fs.existsSync(d)) { try { fs.copyFileSync(s, d); moved++; } catch (_) {} }
      }
    };
    copyDir(from, to);
    fs.writeFileSync(flag, String(new Date().toISOString()));
    console.log('[models] 用户模型迁移完成，文件数:', moved);
  } catch (e) {
    console.warn('[models] 迁移失败（忽略，下次启动重试）:', e && e.message);
  }
}
function engineEnv(extra) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', FUFUMIDI_MODELS_DIR: modelsDir(), FUFUMIDI_MODELS_BUNDLED_DIR: bundledModelsDir() };
  // 内置 Python 必须运行在「干净」环境：宿主机的 PYTHONPATH / PYTHONHOME / PYTHONSTARTUP 等
  // 会把系统上版本不匹配或半损坏的第三方包（numpy / torch）带进来，表现为
  // 应用自检通过、转录却报 `No module named 'numpy.exceptions'`（见 issue #18）。
  // 这里只保留应用自己注入的两个编码变量，其余 PYTHON* 一律剔除。
  for (const k of Object.keys(env)) {
    if (k !== 'PYTHONIOENCODING' && k !== 'PYTHONUTF8' && /^PYTHON/i.test(k)) delete env[k];
  }
  // 依赖 / 环境 / 模型 / 缓存的统一落点：模型、torch.hub、HuggingFace、pip、
  // matplotlib、numba 的缓存与中间产物全部收进数据根目录（默认在工具目录旁），
  // 不再外泄到 C 盘的 ~/.cache、AppData\Local\pip、系统 Temp 等位置。
  Paths.applyToEnv(env);
  // 引擎侧也要能看到配置文件与版本（engine/diag.py 会打进诊断包）
  env.FUFUMIDI_SETTINGS_PATH = Paths.settingsFile();
  try { env.FUFUMIDI_APP_VERSION = app.getVersion(); } catch (_) {}
  // HuggingFace 令牌：主进程下载走 HTTP 头，Python 侧（huggingface_hub）只认环境变量，
  // 不注入的话引擎回退到按规格名走 HF 时会因为读不到 $HF_HOME/token 而 401
  try {
    const st = readSettings();
    if (st && st.hf_token) env.HF_TOKEN = String(st.hf_token).trim();
  } catch (_) {}
  const sites = installedGpuKinds().map(gpuEnhanceSite);
  if (sites.length) {
    // 只保留应用自己的 GPU 增强包路径，不再拼接宿主 PYTHONPATH
    env.PYTHONPATH = sites.join(path.delimiter);
  } else {
    // 没有安装隔离 GPU 增强包时，强制 CPU，避免基础环境中的旧 GPU 包继续生效
    env.FUFUMIDI_DISABLE_GPU = '1';
  }
  if (extra) Object.assign(env, extra);
  return env;
}

// ---------- 引擎服务（main/engine.js） ----------
const EngineService = createEngineService({ resolvePython, engineDir, engineEnv });
const { spawnEngine, stopEngineWorker, runEngineInline, engineWorkerConvert, killAll } = EngineService;

// ---------- 插件服务（main/plugins.js） ----------
const PluginService = createPluginService({ app, path, fs, shell, ipcMain, BrowserWindow, readSettings, writeSettings, spawnEngine });
const { pluginHost, PLUGINS_USER_DIR, registerPluginsIpc } = PluginService;

function cpuFallbackWheels() {
  const dir = path.join(process.resourcesPath, 'cpu-fallback');
  const torch = path.join(dir, 'torch-2.9.1-cp311-cp311-win_amd64.whl');
  const ort = path.join(dir, 'onnxruntime-1.28.0-cp311-cp311-win_amd64.whl');
  if (fs.existsSync(torch) && fs.existsSync(ort)) return [torch, ort];
  return [];
}
async function resetBaseToCpu() {
  try {
    const py = resolvePython();
    const sp = path.join(process.resourcesPath, 'python', 'Lib', 'site-packages');
    // Remove GPU-only metadata / DirectML leftovers (torch/onnxruntime dirs are replaced by CPU wheels below)
    if (fs.existsSync(sp)) {
      for (const name of fs.readdirSync(sp)) {
        if (/^(torch_directml|onnxruntime_gpu|onnxruntime_directml)/.test(name)) {
          try { fs.rmSync(path.join(sp, name), { recursive: true, force: true }); } catch (e) {}
        }
      }
    }
    const wheels = cpuFallbackWheels();
    if (!wheels.length) return false;
    const ok = await new Promise((resolve) => {
      const c = spawn(py, ['-m', 'pip', 'install', '--no-deps', '--force-reinstall', '--no-cache-dir', '--disable-pip-version-check', ...wheels], {
        windowsHide: true,
        // 走 engineEnv：pip 的解包临时目录与各类缓存同样收进数据根目录，不落 C 盘
        env: engineEnv({ PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
      });
      c.on('close', code => resolve(code === 0));
      c.on('error', () => resolve(false));
    });
    return ok;
  } catch (e) { return false; }
}

// ---------- 模型/目录监听服务（在 whenReady 时注册 IPC） ----------
let ModelsService = null;
let DbService = null;

// ---------- 退出时清理引擎子进程 ----------
let _quitting = false;
app.on('before-quit', (e) => {
  if (_quitting) return; // 二次进入（app.quit 重放）直接放行
  if (!DbService) { killAll(); if (ModelsService) ModelsService.closeAll(); return; }
  // 给渲染进程最后一刻的 SQLite 写入（歌单/收藏 fire-and-forget）留出落盘时间，再关闭数据库
  _quitting = true;
  e.preventDefault();
  killAll();
  if (ModelsService) ModelsService.closeAll();
  setTimeout(async () => {
    try { await DbService.close(); } catch (err) {}
    app.quit();
  }, 400);
});

// ---------- 完整性检验（settings / presets / 插件清单 误删检测与修复） ----------
const integrity = createIntegrity({
  getSettingsPath: SETTINGS_PATH,
  getPluginsUserDir: PLUGINS_USER_DIR,
  getBuiltinPluginsDir: () => path.join(__dirname, 'plugins'),
  readSettings,
  writeSettings,
  defaultSettings: DEFAULT_SETTINGS,
  isPackaged: app.isPackaged,
  getAppAsarPath: () => (app.isPackaged ? path.join(process.resourcesPath, 'app.asar') : null),
});
// 启动后后台静默检查：不打断用户，发现问题仅标记，由设置页警告条提示用户手动修复
setTimeout(() => {
  try {
    const r = integrity.check();
    if (!r.ok) {
      console.log('[FuFumidi] integrity issues:', JSON.stringify(r.issues.map(i => i.id)));
    }
  } catch (e) { console.error('[FuFumidi] integrity check failed:', String(e && e.message || e)); }
}, 2500);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
