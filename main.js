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

  app.whenReady().then(() => {
    configureSession({ session, dialog, app });
    registerSystemIpc({ ipcMain, integrity, BrowserWindow, path, shell, app, fs, spawnEngine, dialog });
    registerUpdateIpc({ ipcMain, shell, BrowserWindow, app, path, fs, net });
    registerScoreIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline });
    registerTaskQueueIpc({ ipcMain, BrowserWindow, app, path, fs, spawnEngine, engineWorkerConvert, pluginHost, readSettings, resolveSeparateModel: (id) => (ModelsService ? ModelsService.resolveSeparateModel(id) : null) });
    registerVideoIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline, parsePyJson });
    registerPresetsIpc({ ipcMain, runEngineInline, parsePyJson, pyLit });
    registerDialogsIpc({ ipcMain, dialog, path, fs, app });
    registerDiagnosticsIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, spawnEngine });
    // 模型目录迁移 + 内置模型 junction（须在模型服务注册前完成 junction，迁移可后台）
    try { linkBundledModels(); } catch (_) {}
    try { healModelsDir(); } catch (_) {} // 清除断链（安装器替换 resources/models 后旧 junction 目标消失）
    migrateUserModels();
    ModelsService = registerModelsIpc({ ipcMain, BrowserWindow, app, path, fs, net, modelsDir, engineDir, sha256File, readSettings });
    DbService = createDbService({ app, path, fs });
    DbService.registerDbIpc({ ipcMain });
    registerSettingsIpc({ ipcMain, readSettings, writeSettings, db: DbService });
    registerWallpaperIpc({ ipcMain, app, fs, net, runEngineInline, parsePyJson });
    registerUtauIpc({ ipcMain, path, fs, os, app, dialog, spawnEngine });
    registerSoundfontWorkshopIpc({ ipcMain, BrowserWindow, app, path, fs, net });
    const RustService = createRustService({ app, path, fs });
    RustService.registerRustIpc({ ipcMain });
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
// 模型目录双轨制：
//   用户模型 → userData/fufumidi/models（随用户数据保留，更新/重装不再丢失）
//   内置模型 → resources/models（extraResources，只读分发）
// 引擎只看 FUFUMIDI_MODELS_DIR（用户目录）；内置模型通过 NTFS junction 透出（免管理员权限）
function bundledModelsDir() {
  const packaged = path.join(process.resourcesPath, 'models');
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, 'models');
}
function userModelsDir() {
  const d = path.join(app.getPath('userData'), 'fufumidi', 'models');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
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
  const sites = installedGpuKinds().map(gpuEnhanceSite);
  if (sites.length) {
    const old = process.env.PYTHONPATH || '';
    env.PYTHONPATH = sites.concat(old ? [old] : []).join(path.delimiter);
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
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
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
