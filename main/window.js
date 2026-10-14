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
    // ★ 图标必须解析到**真实磁盘文件**：打包后 rootDir 在 app.asar 内，而 build/ 不进包，
    //   `rootDir/build/icon.png` 解析不到 → Electron 用空图标覆盖 exe 自带图标 →
    //   任务栏图标变白（2026-10-14 用户复现「任务栏图标又丢了」）。
    //   与 setupTray 同一套候选：extraResources 落地的 resources/icon.png 优先。
    icon: (() => {
      const cands = [
        path.join(process.resourcesPath || '', 'icon.png'),
        path.join(rootDir, 'build', 'icon.png'),
        path.join(rootDir, 'build', 'icon.ico'),
      ];
      return cands.find(p => { try { return p && fs.existsSync(p); } catch (_) { return false; } }) || undefined;
    })(),
    webPreferences: {
      preload: path.join(rootDir, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 沙箱曾默认开启。部分机器（多虚拟显示适配器 / 第三方注入驱动的环境）上
      // 开启后 GPU 进程与渲染进程一启动就以 0xC0000005 崩溃，Chromium 连续崩溃后
      // 触发 "GPU process isn't usable" FATAL，整个应用直接退出
      // （症状：窗口不出现，或窗口全黑）。这里关闭沙箱；
      // 隔离性由 contextIsolation + nodeIntegration:false + preload 桥保证。
      sandbox: false,
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

// 待打开的文件：主进程在启动 600ms 后就发 'open-file'，而渲染进程可能还没订阅上，
// 那次消息会**永久丢失**（webContents.send 对没有监听者的消息不做缓存）。
// 所以这里留一份，让渲染进程就绪后主动来取 —— 取走即清空。
let _pendingOpen = null;

function openPath({ BrowserWindow, fs: f }, filePath) {
  f.readFile(filePath, (err, buf) => {
    if (err) return;
    _pendingOpen = { bytes: new Uint8Array(buf), name: path.basename(filePath) };
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;   // 窗口还没建好：留着，等渲染进程来取
    win.webContents.send('open-file', _pendingOpen.bytes, _pendingOpen.name);
  });
}

/** 渲染进程就绪后主动取一次待打开的文件（拿过就清，避免重复导入） */
function takePendingOpen() {
  const p = _pendingOpen;
  _pendingOpen = null;
  return p;
}

module.exports = { createWindow, configureSession, openFileFromArgv, openPath, takePendingOpen };
