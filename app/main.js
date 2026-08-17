// ============================================================
// FuFumidi —— Electron 主进程
// 纯离线本地应用：加载内置 renderer 界面 + 本地 Python 转录引擎子进程
// ============================================================
const { app, BrowserWindow, session, dialog, shell, Menu, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const PluginHost = require('./plugin-host');
const { createIntegrity } = require('./integrity');

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
const activeChildren = new Set();
const convertChildren = new Map();  // jobId -> 子进程句柄（转录/修正取消用）
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
function spawnEngine(pyArgs, opts = {}) {
  const { script = 'music2midi.py', onLog, onDone, onError, timeoutMs = 30 * 60 * 1000 } = opts;
  const py = resolvePython();
  const eng = engineDir();
  // 支持插件传入绝对路径脚本：若非绝对路径则视为 engine/ 目录下的文件
  const scriptPath = path.isAbsolute(script) ? script : path.join(eng, script);
  const child = spawn(py, [scriptPath, ...pyArgs], {
    cwd: eng,
    windowsHide: true,
    // 强制引擎子进程以 UTF-8 输出 stdout/stderr + UTF-8 文件 I/O：
    // 1) 避免 Windows 默认 GBK 乱码污染 `###RESULT {json}` 解析
    // 2) 保证中文路径（音频/MIDI/输出）全程无乱码
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', FUFUMIDI_MODELS_DIR: modelsDir() },
  });
  activeChildren.add(child);
  // 转录/修正是 CPU 密集任务：Windows 下将子进程优先级提到「高于标准」以加速完成，
  // 主进程（界面）保持标准优先级，避免拖慢 UI。设置失败不影响运行。
  try { if (process.platform === 'win32') os.setPriority(child.pid, -1); } catch (e) {}
  // stdout 与 stderr 分缓冲，逐行解析，防止 stderr 片段串入 RESULT 行
  let outBuf = '', errBuf = '';
  let result = null;                 // 逐行捕获的 ###RESULT 对象
  let settled = false;
  const finish = (fn) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    try { child.kill(); } catch {}
    try { fn(); } catch {}
  };
  const pumpOut = (d) => {
    outBuf += d.toString('utf8');
    const lines = outBuf.split(/\r?\n/);
    outBuf = lines.pop();
    for (const l of lines) {
      const t = l.trim();
      if (!t) continue;
      const m = t.match(/^###RESULT\s+(\{.*\})\s*$/);
      if (m) { try { result = JSON.parse(m[1]); } catch {} continue; }
      try { onLog && onLog(t); } catch {}
    }
  };
  const pumpErr = (d) => { errBuf += d.toString('utf8'); };
  child.stdout.on('data', pumpOut);
  child.stderr.on('data', pumpErr);
  child.on('error', (e) => finish(() => onError && onError(String(e))));
  child.on('close', (code) => {
    activeChildren.delete(child);
    finish(() => onDone && onDone(code, { result, out: outBuf, err: errBuf }));
  });
  const timer = setTimeout(() => finish(() => onError && onError('引擎执行超时，已强制终止')), timeoutMs);
  return child;
}
app.on('before-quit', () => {
  for (const c of activeChildren) { try { c.kill(); } catch {} }
});

// ---------- 内联 Python（预设等轻量调用，不走 spawnEngine 的脚本注入） ----------
// spawnEngine 永远把脚本路径插到 argv[0]，无法用于 `python -c`；这里单独复刻
// env/cwd（PYTHONUTF8 + cwd=engineDir），供 presets.py 等引擎目录模块直接 import。
function runEngineInline(code) {
  const py = resolvePython();
  const eng = engineDir();
  return new Promise((resolve) => {
    const child = spawn(py, ['-c', code], {
      cwd: eng,
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { out += d.toString('utf8'); });
    child.on('error', (e) => resolve({ ok: false, code: -1, out, error: String(e) }));
    child.on('close', (code) => resolve({ ok: code === 0, code, out }));
  });
}
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
  ipcMain.handle('engine:convert', (evt, cfg) => new Promise((resolve, reject) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!cfg.out) {
      const base = (cfg.audio || 'audio').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      cfg.out = path.join(app.getPath('temp'), 'fufumidi', `transcribe_${base}_${Date.now()}.mid`);
      try { fs.mkdirSync(path.dirname(cfg.out), { recursive: true }); } catch {}
    }
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
  }));

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
  // 乐谱导出 PDF：渲染当前乐谱视图为 A4 PDF（本地打印排版）
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
    show: false,
    title: 'FuFumidi',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
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
  win.loadFile(path.join(__dirname, 'renderer', 'FuFumidi.html'));
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
