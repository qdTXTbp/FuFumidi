// ============================================================
// P2-1 VST3 离线渲染（主进程）：桥接 engine/plugin_render.py（pedalboard 宿主）
// ============================================================
// 为什么宿主解释器不在安装包里：pedalboard + numpy 体积大且与引擎 Python 版本/ABI 无关，
// 属于“高级用户可选能力” —— 由 plugin.host_python 或 FUFUMIDI_PLUGIN_PYTHON 指定；
// 找不到时明确返回 backend-missing（不静默退化成内置节点）。
'use strict';
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

function candidatesPython(settings) {
  const out = [];
  const s = settings || {};
  if (s['plugin.host_python']) out.push(String(s['plugin.host_python']));
  if (process.env.FUFUMIDI_PLUGIN_PYTHON) out.push(process.env.FUFUMIDI_PLUGIN_PYTHON);
  out.push('E:/Midi/_attic/envs/plugin-uv/Scripts/python.exe');
  out.push('python');
  return out;
}

function candidatesDirs(settings) {
  const out = [];
  const s = settings || {};
  for (const d of (Array.isArray(s['plugin.dirs']) ? s['plugin.dirs'] : [])) out.push(String(d));
  if (process.env.FUFUMIDI_PLUGIN_DIRS) out.push(...String(process.env.FUFUMIDI_PLUGIN_DIRS).split(';'));
  out.push('E:/Midi/_attic/plugins');
  return out.filter(Boolean);
}

function engineScript(app, rootDir) {
  // 开发态：<repo>/engine；打包态：process.resourcesPath/engine
  const dev = path.join(rootDir || process.cwd(), 'engine', 'plugin_render.py');
  if (fs.existsSync(dev)) return dev;
  try {
    const packed = path.join(process.resourcesPath || '', 'engine', 'plugin_render.py');
    if (fs.existsSync(packed)) return packed;
  } catch (e) {}
  return dev;
}

function run(py, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    let done = false;
    let out = '', err = '';
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      child = spawn(py, args, { windowsHide: true, env: { ...process.env } });
    } catch (e) { finish({ code: -1, out: '', err: String(e && e.message || e) }); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch (e) {} finish({ code: -1, out, err: err + '\nTimeout', timeout: true }); }, opts.timeoutMs || 10 * 60 * 1000);
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { err += String(d); if (err.length > 200000) err = err.slice(-200000); });
    child.on('error', (e) => { clearTimeout(timer); finish({ code: -1, out, err: err + '\n' + String(e && e.message || e) }); });
    child.on('close', (code) => { clearTimeout(timer); finish({ code: code == null ? -1 : code, out, err }); });
  });
}

function parseLastJson(text) {
  const lines = String(text || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch (e) {}
  }
  return null;
}

function registerPluginIpc({ ipcMain, app, dialog, BrowserWindow, readSettings, writeSettings, rootDir }) {
  const pyCandidates = () => candidatesPython(readSettings ? readSettings() : {});
  const dirs = () => candidatesDirs(readSettings ? readSettings() : {});

  ipcMain.handle('plugin:status', async () => {
    const script = engineScript(app, rootDir);
    const py = pyCandidates()[0];
    let hostOk = false;
    if (script && fs.existsSync(script) && py) {
      const r = await run(py, [script, 'list', '--dir', dirs()[0] || ''], { timeoutMs: 120000 });
      const j = parseLastJson(r.out);
      if (j && j.ok) hostOk = true;
      return { ok: hostOk, hostPython: py, plugins: (j && j.plugins) || [], dirs: dirs(), error: hostOk ? '' : (j && j.error) || String(r.err || '').slice(-300) };
    }
    return { ok: false, hostPython: py || '', plugins: [], dirs: dirs(), error: '插件宿主不可用（需配置 plugin.host_python）' };
  });

  ipcMain.handle('plugin:list', async () => {
    const script = engineScript(app, rootDir);
    const py = pyCandidates()[0];
    const args = [script, 'list'];
    for (const d of dirs()) args.push('--dir', d);
    const r = await run(py, args, { timeoutMs: 120000 });
    const j = parseLastJson(r.out);
    return j || { ok: false, error: String(r.err || '').slice(-300) };
  });

  ipcMain.handle('plugin:pickDir', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
      title: '选择插件目录（.vst3）',
      properties: ['openDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    const dir = r.filePaths[0];
    if (writeSettings) {
      const s = readSettings ? readSettings() : {};
      const list = Array.isArray(s['plugin.dirs']) ? s['plugin.dirs'].slice() : [];
      if (!list.includes(dir)) list.push(dir);
      try { writeSettings({ 'plugin.dirs': list.slice(0, 20) }); } catch (e) {}
    }
    return { ok: true, dir };
  });

  ipcMain.handle('plugin:pickFile', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
      title: '选择 VST3 插件（包目录或 .vst3 文件）',
      properties: ['openFile'],
      filters: [{ name: 'VST3', extensions: ['vst3'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, file: r.filePaths[0] };
  });

  ipcMain.handle('plugin:pickAudio', async () => {
    const r = await dialog.showOpenDialog(BrowserWindow.getFocusedWindow(), {
      title: '选择输入音频（WAV）',
      properties: ['openFile'],
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true };
    return { ok: true, file: r.filePaths[0] };
  });

  ipcMain.handle('plugin:savePath', async (evt, suggested) => {
    const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
      title: '导出插件渲染结果',
      defaultPath: String(suggested || 'plugin-render.wav'),
      filters: [{ name: 'WAV', extensions: ['wav'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    return { ok: true, file: r.filePath };
  });

  ipcMain.handle('plugin:renderFile', async (evt, payload) => {
    const p = payload || {};
    const plugin = String(p.plugin || '');
    const input = String(p.input || '');
    const output = String(p.output || '');
    if (!plugin || !input || !output) return { ok: false, error: '缺少插件/输入/输出路径' };
    if (!fs.existsSync(input)) return { ok: false, error: '输入音频不存在' };
    const script = engineScript(app, rootDir);
    const py = pyCandidates()[0];
    const params = p.params && typeof p.params === 'object' ? JSON.stringify(p.params) : '';
    const args = [script, 'fx', '--plugin', plugin, '--in', input, '--out', output];
    if (params) args.push('--params', params);
    if (Number(p.sampleRate)) args.push('--sample-rate', String(Number(p.sampleRate)));
    const r = await run(py, args, { timeoutMs: 10 * 60 * 1000 });
    const j = parseLastJson(r.out);
    if (j && j.ok) return j;
    return { ok: false, error: (j && j.error) || '插件渲染失败', log: String(r.err || r.out || '').slice(-1500) };
  });
}

module.exports = { registerPluginIpc, candidatesPython, candidatesDirs, engineScript, parseLastJson };
