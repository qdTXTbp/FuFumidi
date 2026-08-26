// ============================================================
// FuFumidi —— Electron 主进程
// 纯离线本地应用：加载内置 renderer 界面 + 本地 Python 转录引擎子进程
// ============================================================
const { app, BrowserWindow, session, dialog, shell, Menu, ipcMain, net } = require('electron');
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
  gpuEnhanceRoot,
  gpuEnhanceDir,
  gpuEnhanceSite,
  installedGpuKinds,
  inferGpuKind,
  writeGpuManifest,
  installGpuSite,
  isSplitPackagePath,
  splitPartNumber,
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

const APP_ID = 'com.fufumidi.app';
app.setAppUserModelId(APP_ID);

const isDev = !app.isPackaged;

// ---------- 单实例锁：保证双击 .mid 打开进同一个窗口 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
    openFileFromArgv(argv);
  });

  app.whenReady().then(() => {
    configureSession();
    registerIpc();
    registerTaskQueueIpc({ ipcMain, BrowserWindow, app, path, fs, spawnEngine, engineWorkerConvert, pluginHost });
    registerVideoIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline, parsePyJson });
    registerPresetsIpc({ ipcMain, runEngineInline, parsePyJson, pyLit });
    registerDialogsIpc({ ipcMain, dialog, path, fs, app });
    ModelsService = registerModelsIpc({ ipcMain, BrowserWindow, app, path, fs, net, modelsDir, demucsModelFile, sha256File });
    registerPluginsIpc();
    registerGpuIpc();
    createWindow();
    Menu.setApplicationMenu(null); // 隐藏默认菜单栏，界面更清爽

    // 启动参数里带上 .mid/.midi 时（例如：双击文件 / 命令行调用）自动打开
    setTimeout(() => openFileFromArgv(process.argv), 600);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// ---------- Python 路径解析（跨平台 + 内置运行时优先） ----------
// 内置运行时：打包时用 python-build-standalone 分发自包含 CPython + 预装依赖，
// 使应用在任意平台开箱即用，无需用户安装 Python。
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
// 离线模型目录：打包后 extraResources 分发到 resources/models，开发模式在 app/models
function modelsDir() {
  const packaged = path.join(process.resourcesPath, 'models');
  return fs.existsSync(packaged) ? packaged : path.join(__dirname, 'models');
}
function demucsModelFile() {
  // 内置 python 的 site-packages/demucs/remote 下已随包分发 htdemucs 权重（约 80 MB）
  const name = '955717e8-8726e21a.th';
  const roots = [];
  try { roots.push(path.dirname(resolvePython())); } catch (e) {}
  roots.push(path.join(process.resourcesPath, 'python'));
  for (const root of roots) {
    if (!root) continue;
    const cands = [
      path.join(root, 'Lib', 'site-packages', 'demucs', 'remote', name),
      path.join(root, 'lib', 'python3.11', 'site-packages', 'demucs', 'remote', name),
      path.join(root, 'lib', 'python3.12', 'site-packages', 'demucs', 'remote', name),
      path.join(root, 'lib', 'python3.10', 'site-packages', 'demucs', 'remote', name),
    ];
    for (const c of cands) if (fs.existsSync(c)) return c;
    try {
      const lib = path.join(root, 'lib');
      for (const d of fs.readdirSync(lib)) {
        const c = path.join(lib, d, 'site-packages', 'demucs', 'remote', name);
        if (fs.existsSync(c)) return c;
      }
    } catch (e) {}
  }
  return null;
}
function engineEnv(extra) {
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', FUFUMIDI_MODELS_DIR: modelsDir() };
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

// ---------- 退出时清理引擎子进程 ----------
app.on('before-quit', () => {
  killAll();
  if (ModelsService) ModelsService.closeAll();
});

// JS 值 → Python 字面量（安全内嵌到 -c 代码；JSON 的 true/false/null 不是合法 Python）
function pyLit(v) {
  if (v === null || v === undefined) return 'None';
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(pyLit).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).map(k => pyLit(k) + ': ' + pyLit(v[k])).join(', ') + '}';
  return 'None';
}
function parsePyJson(out) {
  const m = (out || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// ---------- GPU 增强包 IPC（main.js 保留编排层） ----------
function registerGpuIpc() {
  ipcMain.handle('gpu:status', async () => {
    try {
      const dirs = installedGpuKinds();
      return { ok: true, directml: dirs.indexOf('directml') >= 0, cuda: dirs.indexOf('cuda') >= 0, isolated: true, paths: dirs };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('gpu:uninstall', async (_e, kind) => {
    const k = String(kind || '').toLowerCase();
    if (k !== 'cuda' && k !== 'directml') return { ok: false, error: '未知的增强包类型' };
    const dir = gpuEnhanceDir(k);
    const existed = fs.existsSync(dir);
    await stopEngineWorker();
    if (existed) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    const restored = await resetBaseToCpu();
    return { ok: true, removed: existed, restored };
  });

  ipcMain.handle('gpu:listPackages', async () => {
    try {
      const r = await fetch('https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=10', { headers: { 'User-Agent': 'FuFumidi-Update' } });
      const data = await r.json();
      const out = [];
      for (const rel of data) {
        const assets = rel.assets || [];
        for (const a of assets) {
          if (a.name && /^fufumidi-gpu-directml\.zip$/i.test(a.name)) {
            out.push({ tag: rel.tag_name, name: a.name, url: a.browser_download_url, size: a.size, kind: 'directml' });
          }
          if (a.name && /^fufumidi-gpu-cuda\.zip$/i.test(a.name)) {
            out.push({ tag: rel.tag_name, name: a.name, url: a.browser_download_url, size: a.size, kind: 'cuda' });
          }
        }
        const cudaParts = assets.filter(a => a.name && /^fufumidi-gpu-cuda(?:-parts)?\.(zip\.\d{3}|part\d+)$/i.test(a.name));
        if (cudaParts.length) {
          cudaParts.sort((a, b) => {
            const ma = String(a.name).match(/(\d+)\s*$/), mb = String(b.name).match(/(\d+)\s*$/);
            return (ma ? parseInt(ma[1],10) : 0) - (mb ? parseInt(mb[1],10) : 0);
          });
          out.push({
            tag: rel.tag_name,
            name: 'fufumidi-gpu-cuda-parts (split)',
            kind: 'cuda',
            split: true,
            size: cudaParts.reduce((sum, a) => sum + (a.size || 0), 0),
            url: cudaParts[0].browser_download_url,
            files: cudaParts.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size }))
          });
        }
      }
      return { ok: true, packages: out };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('dialog:pickZip', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const r = await dialog.showOpenDialog(win, { title: '选择 GPU 增强包', filters: [{ name: 'GPU 增强包', extensions: ['zip', '001', '002', '003', 'part1', 'part2', 'part3', 'part4', 'part5'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
    return r.filePaths;
  });

  ipcMain.handle('gpu:importLocal', async (evt, localPath, kind) => {
    const localPaths = Array.isArray(localPath) ? localPath : [localPath];
    if (!localPaths.length || localPaths.some(p => !p || !fs.existsSync(p))) return { ok: false, error: '本地文件不存在' };
    try {
      const first = localPaths[0];
      const detected = inferGpuKind(first);
      const k = String(detected || kind || '').toLowerCase();
      if (k !== 'cuda' && k !== 'directml') return { ok: false, error: '无法识别增强包类型，请先选择 DirectML 或 CUDA 包/分卷' };
      const zipTmp = path.join(app.getPath('temp'), 'fufumidi-gpu-import.zip');
      if (localPaths.length > 1 || isSplitPackagePath(first)) {
        await combineSplitParts(localPaths, zipTmp);
      } else {
        fs.copyFileSync(first, zipTmp);
      }
      const extractDir = path.join(app.getPath('temp'), 'fufumidi-gpu-import');
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      const psCmd = 'Expand-Archive -Path "' + zipTmp + '" -DestinationPath "' + extractDir + '" -Force';
      const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', psCmd], { windowsHide: true });
      await new Promise((res, rej) => { ps.on('close', c => c === 0 ? res() : rej(new Error('解压失败'))); ps.on('error', rej); });
      const spSrc = path.join(extractDir, 'site-packages');
      if (!fs.existsSync(spSrc)) return { ok: false, error: '压缩包内缺少 site-packages 目录' };
      await stopEngineWorker();
      installGpuSite(k, spSrc, { name: path.basename(first), source: 'local' });
      try { fs.unlinkSync(zipTmp); } catch {}
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
      return { ok: true, kind: k, split: localPaths.length > 1 || isSplitPackagePath(first) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('gpu:packageUrl', async (_e, kind) => {
    try {
      const suffix = kind === 'cuda' ? 'cuda' : 'directml';
      const r = await fetch('https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest', { headers: { 'User-Agent': 'FuFumidi-Update' } });
      const rel = await r.json();
      const assets = (rel.assets || []).filter(a => a.name && a.name.toLowerCase().includes('gpu-' + suffix) && a.name.toLowerCase().endsWith('.zip'));
      if (!assets.length) return { ok: false, error: '未找到 GPU 增强包资产：fufumidi-gpu-' + suffix + '.zip' };
      const a = assets[0];
      return { ok: true, url: a.browser_download_url, name: a.name, size: a.size };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('gpu:downloadPackage', async (evt, opts) => {
    if (!opts || (!opts.url && !(opts.files && opts.files.length))) return { ok: false, error: 'empty url' };
    const kind = String(opts.kind || inferGpuKind(opts.name || (opts.files && opts.files[0] && (opts.files[0].name || opts.files[0].url)) || opts.url) || '').toLowerCase();
    if (kind !== 'cuda' && kind !== 'directml') return { ok: false, error: '无法识别增强包类型' };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const dlDir = path.join(app.getPath('temp'), 'fufumidi-gpu-dl');
    const extractDir = path.join(app.getPath('temp'), 'fufumidi-gpu-extract');
    const zipTmp = path.join(app.getPath('temp'), 'fufumidi-gpu-dl.zip');
    fs.rmSync(dlDir, { recursive: true, force: true });
    fs.mkdirSync(dlDir, { recursive: true });
    let lastErr = null;
    try {
      const files = (Array.isArray(opts.files) && opts.files.length) ? opts.files : [{ name: opts.name || '', url: opts.url, size: opts.size || 0 }];
      const isSplit = files.length > 1 || /.part\d+$|\.zip\.\d{3}$/i.test(files[0].name || '');
      const totalAll = files.reduce((sum, f) => sum + (f.size || 0), 0);
      let receivedAll = 0;
      const paths = [];
      for (const f of files) {
        if (!f || !f.url) throw new Error('missing file url');
        const name = f.name || decodeURIComponent((new URL(f.url).pathname.split('/').pop() || 'part'));
        const outPath = path.join(dlDir, name);
        const mirrors = [f.url, 'https://ghfast.top/' + f.url, 'https://ghproxy.net/' + f.url, 'https://gh-proxy.com/' + f.url];
        let okDl = false;
        for (const u of mirrors) {
          try {
            const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/2.1.0' } });
            if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
            const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
            const out = fs.createWriteStream(outPath);
            const reader = res.body.getReader();
            let received = 0, lastSend = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              received += value.length; receivedAll += value.length;
              const now = Date.now();
              if (now - lastSend > 300) {
                lastSend = now;
                if (win && !win.isDestroyed()) win.webContents.send('gpu:progress', { received: receivedAll, total: totalAll, percent: totalAll ? Math.min(99, Math.round(receivedAll/totalAll*100)) : 0 });
              }
              await new Promise((res2, rej2) => out.write(Buffer.from(value), err => err ? rej2(err) : res2()));
            }
            await new Promise((res2, rej2) => out.end(err => err ? rej2(err) : res2()));
            okDl = true;
            break;
          } catch (e) { lastErr = e; }
        }
        if (!okDl) throw lastErr || new Error('download failed');
        paths.push(outPath);
      }
      if (isSplit) {
        await combineSplitParts(paths, zipTmp);
      } else {
        fs.copyFileSync(paths[0], zipTmp);
      }
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      const psCmd = 'Expand-Archive -Path "' + zipTmp + '" -DestinationPath "' + extractDir + '" -Force';
      const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', psCmd], { windowsHide: true });
      await new Promise((res2, rej2) => { ps.on('close', c => c === 0 ? res2() : rej2(new Error('extract failed'))); ps.on('error', rej2); });
      const spSrc = path.join(extractDir, 'site-packages');
      if (!fs.existsSync(spSrc)) throw new Error('压缩包内缺少 site-packages 目录');
      await stopEngineWorker();
      installGpuSite(kind, spSrc, { name: opts.name || 'fufumidi-gpu-' + kind + '.zip', url: opts.url, source: 'download', split: isSplit });
      try { fs.unlinkSync(zipTmp); } catch {}
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
      if (win && !win.isDestroyed()) win.webContents.send('gpu:progress', { received: receivedAll, total: totalAll, percent: 100, done: true });
      return { ok: true, kind };
    } catch (e) {
      try { fs.unlinkSync(zipTmp); } catch {}
      try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('gpu:installAuto', async () => {
    try {
      const py = resolvePython();
      const code = 'from engine_gpu import detect; import json; print(\'###RESULT \' + json.dumps(detect()))';
      const rr = await runEngineInline(code);
      const d = parsePyJson(rr.out);
      const vendor = (d && d.vendor) || 'unknown';
      const kind = vendor === 'nvidia' ? 'cuda' : 'directml';
      const req = kind === 'cuda' ? 'requirements-gpu-cuda.txt' : 'requirements-gpu-directml.txt';
      const reqPath = path.join(engineDir(), req);
      if (!fs.existsSync(reqPath)) return { ok: false, error: 'GPU requirement file missing: ' + reqPath };
      const targetSite = gpuEnhanceSite(kind);
      await stopEngineWorker();
      fs.mkdirSync(targetSite, { recursive: true });
      const result = await new Promise((res) => {
        const c = spawn(py, ['-m', 'pip', 'install', '--target', targetSite, '-r', reqPath, '--no-input', '--disable-pip-version-check'], { env: engineEnv() });
        let out = '', err = '';
        c.stdout.on('data', d => out += d);
        c.stderr.on('data', d => err += d);
        c.on('close', code => res({ code, out: out.slice(-600), err: err.slice(-600) }));
        c.on('error', e => res({ code: -1, err: String(e) }));
      });
      if (result.code === 0) {
        writeGpuManifest(kind, { source: 'auto' });
      }
      return { ok: result.code === 0, kind, out: result.out, err: result.err };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

// ---------- 完整性检验（settings / presets / 插件清单 误删检测与修复） ----------
const integrity = createIntegrity({
  getSettingsPath: SETTINGS_PATH,
  getPluginsUserDir: PLUGINS_USER_DIR,
  getBuiltinPluginsDir: () => path.join(__dirname, 'plugins'),
  readSettings,
  writeSettings,
  defaultSettings: DEFAULT_SETTINGS,
  isPackaged: app.isPackaged,
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

// ---------- IPC 注册 ----------
function registerIpc() {
  // 环境探针
  ipcMain.handle('engine:probe', () => new Promise((resolve) => {
    let acc = '';
    try {
      spawnEngine(['probe'], {
        onLog: (l) => { acc += '\n' + l; },
        onDone: () => {
          const m = acc.match(/\{[\s\S]*\}/);
          try { resolve(m ? JSON.parse(m[0]) : { ok: false, raw: acc }); }
          catch { resolve({ ok: false, raw: acc }); }
        },
        onError: (e) => resolve({ ok: false, error: e }),
      });
    } catch (e) { resolve({ ok: false, error: String(e) }); }
  }));

  // 完整性检验：校验 settings / presets / 插件清单，返回问题列表
  ipcMain.handle('integrity:check', () => {
    try { return integrity.check(); } catch (e) { return { ok: false, issues: [], error: String(e && e.message || e) }; }
  });
  // 一键修复：按问题 id 数组执行修复，返回逐项结果
  ipcMain.handle('integrity:repair', (_e, ids) => {
    try { return integrity.repair(ids); } catch (e) { return { ok: false, results: [], error: String(e && e.message || e) }; }
  });

  // 设置（深合并嵌套键 + 原子写入）
  ipcMain.handle('settings:load', () => readSettings());
  ipcMain.handle('settings:save', (_e, s) => {
    const cur = readSettings();
    const merged = { ...cur, ...(s || {}) };
    for (const k of ['transcribe_params']) {   // 嵌套对象白名单：深合并，避免部分更新丢失兄弟键
      if (s && s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) {
        merged[k] = { ...(cur[k] || {}), ...s[k] };
      }
    }
    writeSettings(merged);
    return readSettings();
  });

  // MIDI 文件关联开关（默认开）：通过 HKCU 注册表覆盖 .mid/.midi 的默认打开程序。
  // 开启 → 指向 FuFumidi（新建 FuFumidi.MIDI ProgID + 关联）；关闭 → 移除 HKCU 覆盖，
  // 回落到系统默认程序。仅在 Windows 生效，其它平台返回 {ok:false, reason:'unsupported'}。
  ipcMain.handle('settings:fileAssoc', async (_e, enabled) => {
    if (process.platform !== 'win32') return { ok: false, reason: 'unsupported' };
    const { execFile } = require('child_process');
    const exe = process.execPath;
    const progID = 'FuFumidi.MIDI';
    const run = (args) => new Promise((res) => {
      execFile('reg.exe', args, { windowsHide: true }, (err) => res(!err));
    });
    const hkcu = 'HKCU\\Software\\Classes';
    try {
      if (enabled) {
        // ProgID 定义（打开命令） + 扩展名默认值指向 ProgID
        await run(['add', `${hkcu}\\${progID}\\shell\\open\\command`, '/ve', '/d', `"${exe}" "%1"`, '/f']);
        await run(['add', `${hkcu}\\${progID}\\DefaultIcon`, '/ve', '/d', `"${exe}",0`, '/f']);
        await run(['add', `${hkcu}\\.mid`, '/ve', '/d', progID, '/f']);
        await run(['add', `${hkcu}\\.midi`, '/ve', '/d', progID, '/f']);
      } else {
        // 删除 HKCU 覆盖（NSIS 安装时注册的 HKCR 关联由系统回退）
        await run(['delete', `${hkcu}\\.mid`, '/f']);
        await run(['delete', `${hkcu}\\.midi`, '/f']);
        await run(['delete', `${hkcu}\\${progID}`, '/f']);
      }
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // 运行期依赖检测 / 自动补全（基础包缺依赖时一键修复；国内镜像优先）
  ipcMain.handle('dep:check', () => new Promise((resolve) => {
    spawnEngine(['check'], {
      script: 'deps.py',
      onDone: (code, r) => resolve({ ok: code === 0, result: r.result, raw: r.out || r.err }),
      onError: (e) => resolve({ ok: false, error: String(e) }),
    });
  }));
  ipcMain.handle('dep:install', (_e, group) => new Promise((resolve) => {
    spawnEngine(['install', '--group', group || 'all'], {
      script: 'deps.py',
      onDone: (code, r) => resolve({ ok: code === 0, result: r.result, raw: r.out || r.err }),
      onError: (e) => resolve({ ok: false, error: String(e) }),
    });
  }));

  // ---------- 自动更新（已抽到 main/update.js） ----------
  registerUpdateIpc({ ipcMain, shell, BrowserWindow, app, path, fs, net });

  // ---------- 乐谱服务（已抽到 main/score.js） ----------
  registerScoreIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline });

  // 诊断包导出
  ipcMain.handle('diag:export', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const r = await dialog.showSaveDialog({
      title: '导出诊断包',
      defaultPath: path.join(app.getPath('downloads'), 'fufumidi-diagnostic.zip'),
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    return new Promise((resolve) => {
      spawnEngine(['-o', r.filePath], {
        script: 'diag.py',
        onDone: (code, rr) => resolve({ ok: code === 0, path: r.filePath, error: rr.err || rr.out }),
        onError: (e) => resolve({ ok: false, error: String(e) }),
      });
    });
  });
  ipcMain.handle('guide:openEdit', () => {
    const win = new BrowserWindow({ width: 900, height: 700, title: 'FuFumidi 编辑功能说明', backgroundColor: '#0a0f18', autoHideMenuBar: true });
    win.loadFile(path.join(__dirname, 'renderer', 'edit-guide.html'));
    return { ok: true };
  });

  // 打开输出位置：文件存在则在资源管理器/访达中定位；否则打开其所在目录，再兜底下载目录
  ipcMain.handle('shell:openOutput', async (_e, p) => {
    try {
      if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return { ok: true }; }
      if (p) {
        const dir = path.dirname(p);
        if (fs.existsSync(dir)) { shell.openPath(dir); return { ok: true }; }
      }
      const dl = app.getPath('downloads');
      if (fs.existsSync(dl)) shell.openPath(dl);
      return { ok: true };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
}

// ---------- 窗口 ----------
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0a0f18',
    autoHideMenuBar: true,
    show: true,
    title: 'FuFumidi',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  // 渲染器就绪后补发插件渲染脚本（registerPluginsIpc 在窗口创建前已 loadAll，
  // 首次广播会落在渲染器监听之前而丢失，这里重播兜底）
  win.webContents.on('did-finish-load', () => {
    if (typeof pluginHost.broadcastScripts === 'function') pluginHost.broadcastScripts();
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[FuFumidi] renderer gone:', JSON.stringify(details));
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // 加载新版 Vue+Vite 构建（renderer/dist）；老单文件界面已由 v2.2.0 前端迁移取代
  const vueDist = path.join(__dirname, 'renderer', 'dist', 'index.html');
  if (!fs.existsSync(vueDist)) {
    console.error('[FuFumidi] renderer/dist 缺失：请先执行 cd frontend && npm run build');
  }
  win.loadFile(vueDist);
  return win;
}

// ---------- 下载（导出 MIDI / WAV）→ 原生保存对话框 ----------
function configureSession() {
  session.defaultSession.on('will-download', (event, item) => {
    event.preventDefault();
    let name = item.getFilename();
    if (!name) name = Date.now() + '.bin';
    const ext = path.extname(name) || '.bin';
    const base = path.basename(name, ext);
    dialog.showSaveDialog({
      title: '保存文件',
      defaultPath: path.join(app.getPath('downloads'), name),
      filters: ext === '.wav'
        ? [{ name: 'WAV 音频', extensions: ['wav'] }]
        : ext === '.mid' || ext === '.midi'
          ? [{ name: 'MIDI 音频', extensions: ['mid', 'midi'] }]
          : [{ name: '文件', extensions: ['*'] }],
    }).then(({ canceled, filePath }) => {
      if (canceled || !filePath) { item.cancel(); return; }
      item.setSavePath(filePath);
      item.resume();
    }).catch(() => item.cancel());
  });
}

// ---------- 从命令行/关联文件打开 .mid ----------
function openFileFromArgv(argv) {
  if (!argv || !Array.isArray(argv)) return;
  const target = argv.find(a => /\.midi?$/i.test(a) && fs.existsSync(a));
  if (!target) return;
  openPath(target);
}

function openPath(filePath) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  fs.readFile(filePath, (err, buf) => {
    if (err) return;
    win.webContents.send('open-file', new Uint8Array(buf), path.basename(filePath));
  });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
