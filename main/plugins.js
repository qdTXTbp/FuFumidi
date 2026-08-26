// ============================================================
// 主进程插件服务：插件宿主、清单加载、插件 IPC 与渲染层事件桥
// ============================================================
'use strict';

const PluginHost = require('../plugin-host');

function createPluginService({ app, path, fs, shell, ipcMain, BrowserWindow, readSettings, writeSettings, spawnEngine }) {
  const PLUGINS_USER_DIR = () => path.join(app.getPath('userData'), 'fufumidi', 'plugins');

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

  function registerPluginsIpc() {
    try { fs.mkdirSync(PLUGINS_USER_DIR(), { recursive: true }); } catch (e) {}
    pluginHost.setRoots([PLUGINS_USER_DIR(), path.join(__dirname, '..', 'plugins')]);
    pluginHost.loadAll();

    ipcMain.handle('plugins:list', () => pluginHost.list());
    ipcMain.handle('plugins:setEnabled', (_e, id, enabled) => pluginHost.setEnabled(id, !!enabled));
    ipcMain.handle('plugins:invoke', (_e, id, cmd, payload) => pluginHost.invoke(id, cmd, payload));
    ipcMain.handle('plugins:rescan', () => { pluginHost.loadAll(); return pluginHost.list(); });

    ipcMain.handle('plugins:openDir', () => {
      try { fs.mkdirSync(PLUGINS_USER_DIR(), { recursive: true }); shell.openPath(PLUGINS_USER_DIR()); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
    });
    ipcMain.handle('plugins:openDocs', () => {
      try {
        const srcPath = path.join(__dirname, '..', 'plugins', 'plugin-dev.html');
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

  return { pluginHost, PLUGINS_USER_DIR, registerPluginsIpc };
}

module.exports = { createPluginService };
