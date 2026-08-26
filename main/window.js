// ============================================================
// 主进程窗口服务：创建主窗口、下载会话、文件打开辅助
// ============================================================
'use strict';

const path = require('path');
const fs = require('fs');

function createWindow({ BrowserWindow, shell, pluginHost, rootDir }) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0a0f18',
    autoHideMenuBar: true,
    show: true,
    title: 'FuFumidi',
    icon: path.join(rootDir, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(rootDir, 'preload.js'),
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
  const vueDist = path.join(rootDir, 'renderer', 'dist', 'index.html');
  if (!fs.existsSync(vueDist)) {
    console.error('[FuFumidi] renderer/dist 缺失：请先执行 cd frontend && npm run build');
  }
  win.loadFile(vueDist);
  return win;
}

// ---------- 下载（导出 MIDI / WAV）→ 原生保存对话框 ----------
function configureSession({ session, dialog, app }) {
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
function openFileFromArgv(argv, openPath) {
  if (!argv || !Array.isArray(argv)) return;
  const target = argv.find(a => /\.midi?$/i.test(a) && fs.existsSync(a));
  if (!target) return;
  openPath(target);
}

function openPath({ BrowserWindow, fs: f }, filePath) {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return;
  f.readFile(filePath, (err, buf) => {
    if (err) return;
    win.webContents.send('open-file', new Uint8Array(buf), path.basename(filePath));
  });
}

module.exports = { createWindow, configureSession, openFileFromArgv, openPath };
