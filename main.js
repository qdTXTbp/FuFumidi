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
const PluginHost = require('./plugin-host');
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
    registerPlugins();
    createWindow();
    Menu.setApplicationMenu(null); // 隐藏默认菜单栏，界面更清爽

    // 启动参数里带上 .mid/.midi 时（例如：双击文件 / 命令行调用）自动打开
    setTimeout(() => openFileFromArgv(process.argv), 600);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// ---------- 设置持久化（userData/fufumidi/settings.json） ----------
const SETTINGS_PATH = () => path.join(app.getPath('userData'), 'fufumidi', 'settings.json');
const PLUGINS_USER_DIR = () => path.join(app.getPath('userData'), 'fufumidi', 'plugins');
const DEFAULT_SETTINGS = {
  theme: 'fufu',
  accent: '',
  font_size: 'standard',
  density: 'comfortable',
  perf_mode: 'quality',
  engine_path: '',
  engine_mode: 'universal',
  output_dir: '',
  guide_done: false,
  advanced_mode: false,
  custom_wallpaper: '',
  transcribe_params: {},
  plugins_enabled: [],        // 已启用的插件 ID 列表
  lang: 'zh',                 // 界面语言：zh=中文，en=English
};

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH(), 'utf8')) };
  } catch (e) {
    // 设置文件损坏（曾因并发写截断）→ 备份并修复，绝不反复退回默认值导致引导每次弹出
    const p = SETTINGS_PATH();
    try { if (fs.existsSync(p)) fs.renameSync(p, p + '.corrupt-' + Date.now()); } catch (e2) {}
    const repaired = { ...DEFAULT_SETTINGS, guide_done: true };   // 已使用过的用户：引导不再重复
    try { writeSettings(repaired); } catch (e3) {}
    return repaired;
  }
}

let _settingsWrites = Promise.resolve();
function writeSettings(s) {
  // 串行化原子写入：避免插件设置与应用设置并发写同一 tmp 文件导致 JSON 截断
  _settingsWrites = _settingsWrites.then(() => {
    const p = SETTINGS_PATH();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
    fs.renameSync(tmp, p);
  }).catch(() => {});
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
const convertChildren = new Map();  // jobId -> 子进程句柄（转录/修正取消用）
const _folderWatchers = new Map();
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

// ---------- 退出时清理引擎子进程 ----------
app.on('before-quit', () => {
  killAll();
  for (const w of _folderWatchers.values()) { try { w.close(); } catch {} }
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

// ---------- 插件系统（主进程宿主） ----------
let currentSongMeta = null;
function sendToAll(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}
const pluginHost = new PluginHost({
  getSettings: readSettings,
  saveSettings: writeSettings,
  spawnEngine: (args, opts) => spawnEngine(args, opts),
  broadcast: sendToAll,
  getSongMeta: () => currentSongMeta,
});
function registerPlugins() {
  try { fs.mkdirSync(PLUGINS_USER_DIR(), { recursive: true }); } catch (e) {}
  pluginHost.setRoots([PLUGINS_USER_DIR(), path.join(__dirname, 'plugins')]);
  pluginHost.loadAll();
  ipcMain.handle('plugins:list', () => pluginHost.list());
  ipcMain.handle('plugins:setEnabled', (_e, id, enabled) => pluginHost.setEnabled(id, !!enabled));
  ipcMain.handle('plugins:invoke', (_e, id, cmd, payload) => pluginHost.invoke(id, cmd, payload));
  ipcMain.handle('plugins:rescan', () => { pluginHost.loadAll(); return pluginHost.list(); });
  // 打开开发者文档（浏览器查看 HTML）
  ipcMain.handle('update:list', async () => {
    try {
      const r = await fetch('https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=10', { headers: { 'User-Agent': 'FuFumidi-Update' } });
      const data = await r.json();
      return data.map(x => ({ tag: x.tag_name, name: x.name, assets: (x.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })), body: (x.body || '').slice(0, 240) }));
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('update:openExternal', async (_e, url) => {
    try { shell.openExternal(url); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

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


  ipcMain.handle('plugins:openDir', () => {
    try { fs.mkdirSync(PLUGINS_USER_DIR(), { recursive: true }); shell.openPath(PLUGINS_USER_DIR()); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
  });
  ipcMain.handle('plugins:openDocs', () => {
    try {
      const srcPath = path.join(__dirname, 'plugins', 'plugin-dev.html');
      if (!fs.existsSync(srcPath)) return { ok: false, path: srcPath };
      // asar 归档内的文件无法用 shell.openPath 直接打开：先解出到系统临时目录再打开
      const docDir = path.join(app.getPath('temp'), 'FuFumidi-dev-doc');
      fs.mkdirSync(docDir, { recursive: true });
      const outPath = path.join(docDir, 'plugin-dev.html');
      fs.writeFileSync(outPath, fs.readFileSync(srcPath));
      shell.openPath(outPath);
      return { ok: true, path: outPath };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  // 渲染层应用事件 → 插件事件钩子（song-loaded / view-changed / transcribe-done / refine-done …）
  ipcMain.on('app:event', (_e, ev, payload) => {
    if (ev === 'song-loaded') currentSongMeta = payload || currentSongMeta;
    pluginHost.emit(ev, payload);
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

  // 转录
  // 转录（优先常驻 worker，回退单次 spawn）
  ipcMain.handle('engine:convert', async (evt, cfg) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!cfg.out) {
      const rawName = (cfg.name || cfg.audio || 'audio').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      const base = rawName || 'audio';
      cfg.out = path.join(app.getPath('temp'), 'fufumidi', base + '.mid');
      let n = 1;
      while (fs.existsSync(cfg.out)) { cfg.out = path.join(app.getPath('temp'), 'fufumidi', base + '_' + n + '.mid'); n++; }
      try { fs.mkdirSync(path.dirname(cfg.out), { recursive: true }); } catch {}
    }
    const runSpawn = () => new Promise((resolve, reject) => {
      const args = ['convert', cfg.audio, '-o', cfg.out];
      if (cfg.mode) args.push('--mode', cfg.mode);
      if (cfg.perf) args.push('--perf', cfg.perf);
      const map = {
        onset_threshold: '--onset-threshold',
        frame_threshold: '--frame-threshold',
        min_note_length: '--min-note-length',
        min_note_ms: '--min-note-ms',
        merge_gap_ms: '--merge-gap-ms',
        tempo: '--tempo',
      };
      for (const [k, flag] of Object.entries(map)) {
        if (cfg[k] !== undefined && cfg[k] !== null) args.push(flag, String(cfg[k]));
      }
      for (const [k, flag] of Object.entries({ denoise: '--denoise', normalize: '--normalize', auto_bpm: '--auto-bpm', no_merge: '--no-merge', no_velnorm: '--no-velnorm', with_drums: '--with-drums', no_pedal: '--no-pedal', export_stems: '--export-stems' })) {
        if (cfg[k]) args.push(flag);
      }
      const send = (line) => {
        if (win && !win.isDestroyed()) win.webContents.send('engine:log', { id: cfg.id, line });
      };
      try {
        const child = spawnEngine(args, {
          onLog: send,
          onDone: (code, r) => {
            convertChildren.delete(cfg.id);
            if (r.result) {
              pluginHost.emit('transcribe-done', { ok: !!r.result.ok, out: r.result.out, note_count: r.result.note_count, mode: cfg.mode, perf: cfg.perf });
              return resolve(r.result);
            }
            resolve({ ok: code === 0, code, out: cfg.out, error: (r.err || r.out || '').slice(-400) });
          },
          onError: (e) => { convertChildren.delete(cfg.id); reject(new Error(e)); },
        });
        convertChildren.set(cfg.id, child);
      } catch (e) { reject(new Error(String(e))); }
    });

    if (cfg.audio && !cfg.forceSpawn) {
      try {
        cfg.__win = win; cfg.__logId = cfg.id;
        const workerRes = await engineWorkerConvert(cfg);
        if (workerRes && workerRes.ok) {
          pluginHost.emit('transcribe-done', { ok: true, out: workerRes.out, note_count: workerRes.note_count, mode: cfg.mode, perf: cfg.perf });
          return workerRes;
        }
      } catch (e) { /* fallback to single spawn */ }
    }
    return runSpawn();
  });

  // 智能修正（转录 MIDI + 原音频 → 精修 MIDI）
  ipcMain.handle('engine:refine', (evt, cfg) => new Promise((resolve, reject) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!cfg || !cfg.audio || !cfg.midi) { reject(new Error('缺少输入：需要原始音频与转录 MIDI 路径')); return; }
    if (!cfg.out) {
      const base = cfg.midi.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') + '_refined';
      cfg.out = path.join(app.getPath('temp'), 'fufumidi', `${base}_${Date.now()}.mid`);
      try { fs.mkdirSync(path.dirname(cfg.out), { recursive: true }); } catch {}
    }
    const args = ['refine', '--audio', cfg.audio, '--midi', cfg.midi, '-o', cfg.out];
    if (cfg.mode) args.push('--mode', cfg.mode);
    if (cfg.stemBalance !== undefined) args.push('--stem-balance', cfg.stemBalance ? 'on' : 'off');
    const send = (line) => {
      if (win && !win.isDestroyed()) win.webContents.send('engine:refine:log', { id: cfg.id, line });
    };
    try {
      const child = spawnEngine(args, {
        script: 'smart_midi.py',
        onLog: send,
        onDone: (code, r) => {
          convertChildren.delete(cfg.id);
          if (r.result) {
            pluginHost.emit('refine-done', { ok: !!r.result.ok, out: r.result.out, stats: r.result.stats, mode: cfg.mode });
            return resolve(r.result);
          }
          resolve({ ok: code === 0, code, out: cfg.out, error: (r.err || r.out || '').slice(-400) });
        },
        onError: (e) => { convertChildren.delete(cfg.id); reject(new Error(e)); },
      });
      convertChildren.set(cfg.id, child);
    } catch (e) { reject(new Error(String(e))); }
  }));

  // 取消转录 / 修正（终止对应 jobId 的引擎子进程）
  ipcMain.handle('engine:cancel', (_e, id) => {
    const c = convertChildren.get(id);
    if (c) { try { c.kill(); } catch {} convertChildren.delete(id); return { ok: true }; }
    return { ok: false };
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

  // 原生对话框
  ipcMain.handle('dialog:pickAudio', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '音频 / 视频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'webm'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  // 批量转录：一次选择多个音频 / 视频
  ipcMain.handle('dialog:pickAudioFiles', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频 / 视频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'webm'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  // 批量转录：递归列出文件夹内音频/视频（上限 2000 / 8 层）
  ipcMain.handle('dir:listAudioFiles', async (_e, dir) => {
    try {
      if (!dir || !fs.existsSync(dir)) return [];
      const exts = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.mp4', '.mkv', '.avi', '.mov', '.webm', '.aiff', '.aif', '.au', '.snd', '.caf', '.m4v', '.m4s', '.ts', '.mpg', '.mpeg', '.flv', '.3gp', '.amr', '.mka']);
      const out = [];
      const walk = (d, depth) => {
        if (out.length >= 2000 || depth > 8) return;
        let items;
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
          if (out.length >= 2000) return;
          try {
            if (it.isDirectory()) walk(path.join(d, it.name), depth + 1);
            else if (it.isFile() && exts.has(path.extname(it.name).toLowerCase())) out.push(path.join(d, it.name));
          } catch {}
        }
      };
      walk(dir, 0);
      out.sort((a, b) => a.localeCompare(b, 'zh'));
      return out;
    } catch (e) { return []; }
  });
  ipcMain.handle('dialog:pickImage', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickFile', async (_e, opts) => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: (opts && opts.filters) || [{ name: '文件', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickDirectory', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  // 内置 SoundFont 列表（随应用分发，用户直接选择，无需加载外部文件）
  ipcMain.handle('soundfont:list', async () => {
    try {
      const dir = path.join(__dirname, 'renderer', 'vendor', 'soundfonts');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(f => /\.(sf2|sf3)$/i.test(f))
        .map(f => ({ id: f, name: f.replace(/\.[^.]+$/, ''), path: path.join(dir, f) }));
    } catch (e) { return []; }
  });
  // MusicXML 导入
  ipcMain.handle('dialog:pickMusicXML', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'MusicXML', extensions: ['xml', 'musicxml', 'mxl'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  // 内置模型注册表：本地模型清单 + 缺失模型官方源一键下载（带进度/取消）
  const MODEL_REGISTRY = {
    piano_transcription: {
      id: 'piano_transcription',
      name: '钢琴转录模型',
      note: 'piano-transcription CRNN（含踏板检测）· 约 166 MB',
      dest: path.join('piano_transcription', 'note_F1=0.9677_pedal_F1=0.9186.pth'),
      url: 'https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1',
      minSize: 1.6e8,
      downloadable: true,
    },
  };
  const _modelCancels = new Set();
  const _modelAborts = new Map();
  const _modelPause = new Set();
  ipcMain.handle('model:list', async () => {
    const dir = modelsDir();
    const items = [];
    const push = (name, p, note, extra) => {
      try {
        const st = fs.statSync(p);
        items.push(Object.assign({ name, path: p, size: st.size, exists: true, note: note || '' }, extra || {}));
      } catch (e) { items.push(Object.assign({ name, path: p, size: 0, exists: false, note: note || '' }, extra || {})); }
    };
    push('通用转录（int8 量化）', path.join(dir, 'basic_pitch_quant.onnx'), 'basic-pitch ONNX int8 量化模型（CPU 加速）');
    const pt = MODEL_REGISTRY.piano_transcription;
    push(pt.name, path.join(dir, pt.dest), pt.note, { id: pt.id, downloadable: true });
    const dm = demucsModelFile();
    items.push({ id: 'demucs_htdemucs', name: '人声分离模型', path: dm || '', size: dm ? (() => { try { return fs.statSync(dm).size; } catch (e) { return 0; } })() : 0, exists: !!dm, downloadable: !dm, note: dm ? 'demucs htdemucs 已内置（约 80 MB）' : 'demucs htdemucs（未安装，可一键下载，国内自动走镜像）' });
    return items;
  });
  ipcMain.handle('model:cancel', async (_e, id) => {
    if (id) { _modelCancels.add(id); try { const c = _modelAborts.get(id); if (c) c.abort(); } catch (e) {} }
    return { ok: true };
  });
  ipcMain.handle('model:delete', async (_e, id) => {
    try {
      let p = null;
      if (id === 'demucs_htdemucs') p = demucsModelFile();
      else if (MODEL_REGISTRY[id]) p = path.join(modelsDir(), MODEL_REGISTRY[id].dest);
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'not found' };
      fs.unlinkSync(p);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('folder:setWatch', (_e, dir, enabled) => {
    try {
      const win = BrowserWindow.fromWebContents(_e.sender);
      const key = win ? win.id : 0;
      if (_folderWatchers.has(key)) { try { _folderWatchers.get(key).close(); } catch (e) {} _folderWatchers.delete(key); }
      if (!enabled || !dir || !fs.existsSync(dir)) return { ok: true };
      const exts = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.mp4', '.mkv', '.avi', '.mov', '.webm']);
      let timer = null;
      const w = fs.watch(dir, { persistent: false }, (_ev, filename) => {
        if (!filename) return;
        const full = path.join(dir, filename.toString());
        if (exts.has(path.extname(full).toLowerCase())) {
          clearTimeout(timer);
          timer = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('folder-watch:file', full); }, 300);
        }
      });
      _folderWatchers.set(key, w);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('model:pause', async (_e, id) => {
    if (id) { _modelPause.add(id); try { const c = _modelAborts.get(id); if (c) c.abort(); } catch (e) {} }
    return { ok: true };
  });
  ipcMain.handle('model:download', async (evt, id) => {
    const spec = MODEL_REGISTRY[id];
    if (!spec || !spec.url) return { ok: false, error: 'unknown model: ' + id };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const dest = path.join(modelsDir(), spec.dest);
    if (fs.existsSync(dest) && fs.statSync(dest).size >= spec.minSize) {
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: fs.statSync(dest).size, total: fs.statSync(dest).size, percent: 100, done: true });
      return { ok: true, path: dest, size: fs.statSync(dest).size, existed: true };
    }
    _modelCancels.delete(id);
    _modelPause.delete(id);
    const tmp = dest + '.part';
    const ctrl = new AbortController();
    _modelAborts.set(id, ctrl);
    const timeout = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 120000);
    let out = null, start = 0, keepPart = false;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(tmp)) start = fs.statSync(tmp).size;
      const headers = { 'user-agent': 'FuFumidi/2.0.0' };
      if (start > 0) headers['Range'] = 'bytes=' + start + '-';
      const urls = [spec.url, 'https://ghfast.top/' + spec.url, 'https://gh-proxy.com/' + spec.url, 'https://ghproxy.net/' + spec.url];
      let res = null;
      for (const u of urls) {
        try {
          res = await net.fetch(u, { headers, signal: ctrl.signal });
          if (res.ok && res.body) break; else res = null;
        } catch (e) { res = null; }
      }
      if (!res) throw new Error('所有下载源均失败');
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = (parseInt(res.headers.get('content-length') || '0', 10) || 0) + start;
      out = fs.createWriteStream(tmp, { flags: start > 0 ? 'a' : 'w' });
      const reader = res.body.getReader();
      let received = start, lastSend = 0;
      const sendP = (done) => {
        const now = Date.now();
        if (!done && now - lastSend < 300) return;
        lastSend = now;
        const pct = total ? Math.min(99, Math.round(received / total * 100)) : 0;
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received, total, percent: pct, done: !!done });
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (_modelPause.has(id)) { try { reader.cancel(); } catch (e) {} throw new Error('paused'); }
        if (_modelCancels.has(id)) { try { reader.cancel(); } catch (e) {} throw new Error('canceled'); }
        received += value.length;
        sendP(false);
        await new Promise((res2, rej2) => out.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
      }
      await new Promise((res2, rej2) => out.end(err => (err ? rej2(err) : res2())));
      sendP(true);
      if (_modelPause.has(id)) throw new Error('paused');
      if (_modelCancels.has(id)) throw new Error('canceled');
      fs.renameSync(tmp, dest);
      const size = fs.statSync(dest).size;
      if (size < spec.minSize) throw new Error('下载文件不完整：' + size + ' bytes');
      if (spec.sha256) {
        const hash = await sha256File(dest);
        if (hash !== spec.sha256) { try { fs.unlinkSync(dest); } catch (e) {} throw new Error('SHA256 校验失败：' + hash); }
      }
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: size, total: size, percent: 100, done: true });
      return { ok: true, path: dest, size };
    } catch (e) {
      if (out) { try { out.destroy(); } catch (_) {} }
      await new Promise(r => setTimeout(r, 150));
      const msg = String((e && e.message) || e);
      const paused = _modelPause.has(id);
      keepPart = paused;
      if (!paused && !_modelCancels.has(id)) { try { fs.unlinkSync(tmp); } catch (_) {} }
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, error: msg, canceled: _modelCancels.has(id), paused });
      return { ok: false, error: msg, canceled: _modelCancels.has(id), paused };
    } finally {
      clearTimeout(timeout);
      _modelCancels.delete(id);
      _modelAborts.delete(id);
      _modelPause.delete(id);
      try { if (!keepPart && fs.existsSync(tmp) && !fs.existsSync(dest)) fs.unlinkSync(tmp); } catch (_) {}
    }
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

  // ---------- 自动更新（国内直连不可用时自动走镜像） ----------
  const UPDATE_MIRRORS = [
    'https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
    'https://ghfast.top/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
    'https://gh-proxy.com/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
    'https://ghproxy.net/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  ];
  async function fetchLatestRelease() {
    let lastErr = null;
    for (const base of UPDATE_MIRRORS) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(()=>ctrl.abort(), 12000);
        const r = await net.fetch(base, { headers: { 'user-agent': 'FuFumidi/2.0.0' }, signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
        const d = await r.json();
        if (d && d.tag_name) return d;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('无法访问 GitHub');
  }
  function assetForPlatform(release) {
    const p = process.platform, arch = process.arch;
    const assets = release.assets || [];
    if (p === 'win32') return assets.find(a => /.exe$/i.test(a.name));
    if (p === 'darwin') return assets.find(a => arch === 'arm64' ? /arm64.*.dmg$/i.test(a.name) : /.dmg$/i.test(a.name) && !/arm64/i.test(a.name));
    if (p === 'linux') return assets.find(a => /.AppImage$/i.test(a.name));
    return null;
  }
  ipcMain.handle('update:check', async () => {
    try {
      const rel = await fetchLatestRelease();
      const asset = assetForPlatform(rel);
      const ver = (rel.tag_name || '').replace(/^v/i, '');
      return { ok: true, current: app.getVersion(), latest: ver, tag: rel.tag_name, notes: (rel.body || '').slice(0, 500), url: asset ? asset.browser_download_url : null, name: asset ? asset.name : null, mirror: asset ? ('https://ghfast.top/' + asset.browser_download_url) : null };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('update:download', async (evt, url) => {
    if (!url) return { ok: false, error: 'empty url' };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const mirrors = [url, 'https://ghfast.top/' + url, 'https://gh-proxy.com/' + url, 'https://ghproxy.net/' + url];
    const dest = path.join(app.getPath('temp'), 'fufumidi-update', 'FuFumidi-update' + path.extname(new URL(url).pathname));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let lastErr = null;
    for (const u of mirrors) {
      try {
        const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/2.0.0' } });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
        const out = fs.createWriteStream(dest + '.part');
        const reader = res.body.getReader();
        let received = 0, lastSend = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          const now = Date.now();
          if (now - lastSend > 300) { lastSend = now; if (win && !win.isDestroyed()) win.webContents.send('update:progress', { received, total, percent: total ? Math.min(99, Math.round(received/total*100)) : 0 }); }
          await new Promise((res2, rej2) => out.write(Buffer.from(value), err => err ? rej2(err) : res2()));
        }
        await new Promise((res2, rej2) => out.end(err => err ? rej2(err) : res2()));
        fs.renameSync(dest + '.part', dest);
        if (win && !win.isDestroyed()) win.webContents.send('update:progress', { received, total, percent: 100, done: true });
        return { ok: true, path: dest };
      } catch (e) { lastErr = e; try { fs.unlinkSync(dest + '.part'); } catch {} }
    }
    return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
  });
  ipcMain.handle('update:open', async (_e, p) => {
    try { shell.openPath(p); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
  });

  // 诊断包导出
  // 乐谱 PNG 分页导出：渲染器生成多张 PNG，主进程打包为 ZIP
  ipcMain.handle('score:exportPngZip', async (evt, opts) => {
    try {
      if (!opts || !Array.isArray(opts.tiles) || !opts.tiles.length) return { ok: false, error: 'empty tiles' };
      const win = BrowserWindow.fromWebContents(evt.sender);
      const save = await dialog.showSaveDialog({
        title: '导出乐谱 PNG 分页包',
        defaultPath: path.join(app.getPath('downloads'), (opts.name || 'score') + '.zip'),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (save.canceled || !save.filePath) return { ok: false, canceled: true };
      const tmpDir = path.join(app.getPath('temp'), 'fufumidi-score-png');
      fs.mkdirSync(tmpDir, { recursive: true });
      for (let i = 0; i < opts.tiles.length; i++) {
        fs.writeFileSync(path.join(tmpDir, 'score-' + String(i + 1).padStart(3, '0') + '.png'), Buffer.from(opts.tiles[i].data));
      }
      const code = 'import zipfile, glob, os\n' +
        'out = r' + JSON.stringify(save.filePath) + '\n' +
        'd = r' + JSON.stringify(tmpDir) + '\n' +
        'z = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)\n' +
        'for f in glob.glob(os.path.join(d, "*.png")):\n' +
        '    z.write(f, os.path.basename(f))\n' +
        'z.close()\n' +
        'print("###RESULT " + str({"ok": True, "out": out}))';
      const rr = await runEngineInline(code);
      try { for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f)); } catch {}
      return rr && rr.ok ? { ok: true, path: save.filePath } : { ok: false, error: rr.out.slice(-300) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

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
  ipcMain.handle('score:exportPdf', async (evt) => {
    try {
      const win = BrowserWindow.fromWebContents(evt.sender);
      const r = await dialog.showSaveDialog({
        title: '导出乐谱 PDF',
        defaultPath: path.join(app.getPath('downloads'), 'score.pdf'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      const data = await win.webContents.printToPDF({
        printBackground: true,
        pageSize: 'A4',
        landscape: false,
        margins: { marginType: 'default' },
      });
      await fs.promises.writeFile(r.filePath, data);
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // 视频导出：接收渲染器录制的 WebM（可视化 + 可选离线渲染的 WAV 音频）→ 内置 ffmpeg 合成 MP4
  ipcMain.handle('video:transcode', async (evt, opts) => {
    try {
      if (!opts || !opts.data) return { ok: false, error: 'empty' };
      const win = BrowserWindow.fromWebContents(evt.sender);
      const save = await dialog.showSaveDialog({
        title: '导出视频 MP4',
        defaultPath: path.join(app.getPath('downloads'), 'FuFumidi-video.mp4'),
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      });
      if (save.canceled || !save.filePath) return { ok: false, canceled: true };
      const tmpDir = path.join(app.getPath('temp'), 'fufumidi-video');
      fs.mkdirSync(tmpDir, { recursive: true });
      const webm = path.join(tmpDir, Date.now() + '.webm');
      fs.writeFileSync(webm, Buffer.from(opts.data));
      let wav = null;
      if (opts.audio && opts.audio.byteLength) {
        wav = path.join(tmpDir, Date.now() + '.wav');
        fs.writeFileSync(wav, Buffer.from(opts.audio));
      }
      const out = save.filePath;
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', webm];
      if (wav) args.push('-i', wav, '-map', '0:v:0', '-map', '1:a:0');
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out);
      const code =
        'import json, subprocess\n' +
        'import imageio_ffmpeg\n' +
        'ff = imageio_ffmpeg.get_ffmpeg_exe()\n' +
        'r = subprocess.run([ff] + ' + JSON.stringify(args) +
        ', capture_output=True)\n' +
        "print(json.dumps({'ok': r.returncode == 0, 'err': (r.stderr or b'').decode('utf-8', 'replace')[-300:]}))";
      const rr = await runEngineInline(code);
      try { fs.unlinkSync(webm); if (wav) fs.unlinkSync(wav); } catch (e) {}
      const d = parsePyJson(rr.out);
      if (d && d.ok) return { ok: true, path: out };
      return { ok: false, error: (d && d.err) || (rr.out || 'ffmpeg failed').slice(-300) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // 歌单“导入文件夹”：递归列出目录下的 MIDI 文件（上限 2000 / 8 层，避免误选整盘卡死）
  ipcMain.handle('dir:listMidiFiles', async (_e, dir) => {
    try {
      if (!dir || !fs.existsSync(dir)) return [];
      const exts = new Set(['.mid', '.midi', '.kar', '.rmi']);
      const out = [];
      const walk = (d, depth) => {
        if (out.length >= 2000 || depth > 8) return;
        let items;
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
          if (out.length >= 2000) return;
          try {
            if (it.isDirectory()) walk(path.join(d, it.name), depth + 1);
            else if (it.isFile() && exts.has(path.extname(it.name).toLowerCase())) out.push(path.join(d, it.name));
          } catch {}
        }
      };
      walk(dir, 0);
      out.sort((a, b) => a.localeCompare(b, 'zh'));
      return out;
    } catch (e) { return []; }
  });
  // 读取本地文件（转录结果回载）——异步 + 大小上限，避免阻塞主进程
  ipcMain.handle('file:readBinary', async (_e, p) => {
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile() || st.size > 64 * 1024 * 1024) return null;
      const buf = await fs.promises.readFile(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch { return null; }
  });
  // 读取 SoundFont（SF2/SF3 通常数十 MB 到数百 MB，单独放宽上限）
  ipcMain.handle('file:readSoundFont', async (_e, p) => {
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile() || st.size > 512 * 1024 * 1024) return null;
      const buf = await fs.promises.readFile(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch { return null; }
  });

  // 保存二进制（WAV / MIDI 导出）：原生保存对话框 → fs 写盘。
  // 绕开 Electron 33 失效的下载子系统：<a download> 经 will-download 的
  // preventDefault+setSavePath+resume 后下载会被 0 字节取消（blob/data/http 均如此）。
  ipcMain.handle('file:saveBinary', async (_e, opts) => {
    try {
      const name = (opts && opts.name) || 'download.bin';
      const ext = path.extname(name).toLowerCase() || '';
      const filters = ext === '.wav'
        ? [{ name: 'WAV 音频', extensions: ['wav'] }]
        : ext === '.mid' || ext === '.midi'
          ? [{ name: 'MIDI 音频', extensions: ['mid', 'midi'] }]
          : [{ name: '文件', extensions: ['*'] }];
      const r = await dialog.showSaveDialog({
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), name),
        filters,
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      const buf = (opts && opts.data != null) ? Buffer.from(opts.data) : Buffer.alloc(0);
      await fs.promises.writeFile(r.filePath, buf);
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, canceled: false, error: String((e && e.message) || e) }; }
  });

  // 转录参数预设：列表（内置 + 用户合并）/ 保存 / 删除 / 记住上次使用
  ipcMain.handle('presets:list', async () => {
    const r = await runEngineInline(
      'import json, presets\n' +
      'p, last = presets.load_presets()\n' +
      "print(json.dumps({'ok': True, 'presets': p, 'last_used': last, " +
      "'builtins': list(presets._builtin_presets().keys())}, ensure_ascii=False))"
    );
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, presets: d.presets || {}, last_used: d.last_used || '', builtins: d.builtins || [] };
    return { ok: false, error: (r.error || r.out || 'presets:list failed').slice(-400) };
  });
  ipcMain.handle('presets:save', async (_e, name, mode, params) => {
    const code =
      'import json, presets\n' +
      'ok = presets.save_preset(' + JSON.stringify((name || '').trim()) + ', ' + pyLit(mode) + ', ' + pyLit(params || {}) + ')\n' +
      'if ok: presets.save_last_used(' + JSON.stringify((name || '').trim()) + ')\n' +
      "print(json.dumps({'ok': True, 'saved': bool(ok)}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, saved: !!d.saved };
    return { ok: false, error: (r.error || r.out || 'presets:save failed').slice(-400) };
  });
  ipcMain.handle('presets:delete', async (_e, name) => {
    const code =
      'import json, presets\n' +
      'ok = presets.delete_preset(' + JSON.stringify((name || '').trim()) + ')\n' +
      "print(json.dumps({'ok': True, 'deleted': bool(ok)}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, deleted: !!d.deleted };
    return { ok: false, error: (r.error || r.out || 'presets:delete failed').slice(-400) };
  });
  ipcMain.handle('presets:lastUsed', async (_e, name) => {
    const code =
      'import presets\n' +
      'presets.save_last_used(' + JSON.stringify((name || '').trim()) + ')\n' +
      "print(json.dumps({'ok': True}, ensure_ascii=False))";
    await runEngineInline(code);
    return { ok: true };
  });
  ipcMain.handle('presets:reorder', async (_e, name, delta) => {
    const code =
      'import json, presets\n' +
      'order = presets.reorder_preset(' + JSON.stringify((name || '').trim()) + ', ' + pyLit(delta) + ')\n' +
      "print(json.dumps({'ok': True, 'order': order}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, order: d.order || [] };
    return { ok: false, error: (r.error || r.out || 'presets:reorder failed').slice(-400) };
  });
  // 拖拽排序：直接把预设移到展示顺序的目标下标（前端拖放一次性定位）
  ipcMain.handle('presets:reorderTo', async (_e, name, index) => {
    const code =
      'import json, presets\n' +
      'order = presets.reorder_preset_to(' + JSON.stringify((name || '').trim()) + ', ' + pyLit(index) + ')\n' +
      "print(json.dumps({'ok': True, 'order': order}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, order: d.order || [] };
    return { ok: false, error: (r.error || r.out || 'presets:reorderTo failed').slice(-400) };
  });
  ipcMain.handle('presets:restore', async () => {
    const code =
      'import json, presets\n' +
      'ok = presets.restore_all_builtins()\n' +
      "print(json.dumps({'ok': True, 'restored': bool(ok)}, ensure_ascii=False))";
    const r = await runEngineInline(code);
    const d = parsePyJson(r.out);
    if (d && d.ok) return { ok: true, restored: !!d.restored };
    return { ok: false, error: (r.error || r.out || 'presets:restore failed').slice(-400) };
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
  // 渲染器就绪后补发插件渲染脚本（registerPlugins 在窗口创建前已 loadAll，
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
