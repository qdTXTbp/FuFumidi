// ============================================================
// 主进程插件服务：插件宿主、清单加载、插件 IPC 与渲染层事件桥
// ============================================================
'use strict';

const PluginHost = require('../plugin-host');
const Paths = require('./paths');
const Installer = require('./plugin-install');

/**
 * 插件平台地址。
 * 正式地址是自有域名 platform.fufumidi.de5.net（已 CNAME 到本 Worker）。
 * 自建平台时在设置里用 plugin_platform_url 覆盖。
 */
const DEFAULT_PLATFORM_URL = 'https://platform.fufumidi.de5.net';

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

    // ---- 插件市场安装 ----
    // 两段式：download 只落缓存并回报包内清单，install 在用户确认后才解压落地。
    // 平台目前没有发布签名，所以中间那步「让人看清包里有什么」不能省。
    const platformBase = () => {
      try {
        const s = readSettings ? readSettings() : {};
        const u = s && s.plugin_platform_url && String(s.plugin_platform_url).trim();
        return u || DEFAULT_PLATFORM_URL;
      } catch (e) { return DEFAULT_PLATFORM_URL; }
    };

    ipcMain.handle('plugins:installFromPlatform', async (_e, slug, version) => {
      const r = await Installer.download({
        baseUrl: platformBase(),
        slug,
        version,
        userPluginsDir: PLUGINS_USER_DIR(),
      });
      if (!r.ok) return r;
      // 记下用户装这个插件的意图：rescan 后据此回报「新装/升级」
      try {
        const s = readSettings ? (readSettings() || {}) : {};
        const store = Object.assign({}, s.plugin_installs || {});
        store[slug] = { version: r.manifest && r.manifest.version, at: Date.now() };
        if (writeSettings) writeSettings({ plugin_installs: store });
      } catch (e) {}
      return r;
    });

    ipcMain.handle('plugins:confirmInstall', (_e, token, overwrite) => {
      const r = Installer.install({
        token,
        overwrite: !!overwrite,
        userPluginsDir: PLUGINS_USER_DIR(),
      });
      if (!r.ok) return r;
      // 装完立刻重扫，让新插件马上可用
      const list = pluginHost.loadAll();
      const activated = list.find((p) => p.id === r.id) || null;
      return { ...r, activated, total: list.length };
    });

    ipcMain.handle('plugins:cancelInstall', (_e, token) => Installer.discard(token));

    ipcMain.handle('plugins:installedList', () => ({
      ok: true,
      dir: PLUGINS_USER_DIR(),
      plugins: Installer.listInstalled(PLUGINS_USER_DIR()),
    }));

    ipcMain.handle('plugins:openDir', () => {
      try { fs.mkdirSync(PLUGINS_USER_DIR(), { recursive: true }); shell.openPath(PLUGINS_USER_DIR()); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
    });
    ipcMain.handle('plugins:openDocs', () => {
      try {
        const srcPath = path.join(__dirname, '..', 'plugins', 'plugin-dev.html');
        if (!fs.existsSync(srcPath)) return { ok: false, path: srcPath };
        // asar 归档内的文件无法用 shell.openPath 直接打开：先解出到数据根目录的 temp/ 再打开
        const docDir = path.join(Paths.tempDir(), 'FuFumidi-dev-doc');
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
