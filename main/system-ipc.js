// ============================================================
// 主进程系统 IPC：环境探针、完整性、帮助窗口与打开输出位置
// ============================================================
'use strict';

function registerSystemIpc({ ipcMain, integrity, BrowserWindow, path, shell, app, fs, spawnEngine }) {
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

  ipcMain.handle('guide:openEdit', () => {
    const win = new BrowserWindow({ width: 900, height: 700, title: 'FuFumidi 编辑功能说明', backgroundColor: '#0a0f18', autoHideMenuBar: true });
    win.loadFile(path.join(__dirname, '..', 'renderer', 'edit-guide.html'));
    return { ok: true };
  });

  // 读取与指定文件同目录的同名 .lrc 歌词（音频/MIDI 断点歌词自动加载用）
  // 返回 base64 原始字节：渲染端自行做 UTF-8/Shift-JIS 解码（日文 LRC 常为 SJIS）
  ipcMain.handle('sys:readSidecarLyrics', async (_e, filePath) => {
    try {
      if (!filePath || typeof filePath !== 'string') return { ok: false, error: 'no path' };
      const dir = path.dirname(filePath);
      const base = path.basename(filePath).replace(/\.[^.]+$/, '');
      for (const cand of [base + '.lrc', base + '.LRC']) {
        const p = path.join(dir, cand);
        if (fs.existsSync(p)) {
          const buf = await fs.promises.readFile(p);
          return { ok: true, path: p, b64: buf.toString('base64'), bytes: buf.length };
        }
      }
      return { ok: false, error: 'not found' };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // 选择封面图片 → data URL（供曲目标签封面）
  ipcMain.handle('sys:pickCover', async () => {
    try {
      const { dialog } = require('electron');
      const r = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }],
      });
      if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
      const p = r.filePaths[0];
      const buf = await fs.promises.readFile(p);
      const ext = path.extname(p).slice(1).toLowerCase() || 'png';
      const mime = ext === 'jpg' ? 'jpeg' : ext;
      if (buf.length > 6 * 1024 * 1024) return { ok: false, error: '图片过大（>6MB）' };
      return { ok: true, dataUrl: 'data:image/' + mime + ';base64,' + buf.toString('base64') };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // 开机自启：查询 / 设置（登录时启动）
  ipcMain.handle('app:autostart:get', () => {
    try { return { ok: true, openAtLogin: !!app.getLoginItemSettings().openAtLogin }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  ipcMain.handle('app:autostart:set', (_e, open) => {
    try {
      app.setLoginItemSettings({ openAtLogin: !!open, path: process.execPath });
      return { ok: true, openAtLogin: !!app.getLoginItemSettings().openAtLogin };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // 清除用户数据：下载的模型 / 下载的音色 / 播放类本地数据（断点、书签、统计）
  // 不删除 MIDI 曲库、歌单与收藏（这些可在应用内自行管理）
  ipcMain.handle('app:clearUserData', async (_e, scopes) => {
    const list = Array.isArray(scopes) ? scopes : ['models', 'soundfonts', 'playdata'];
    const done = [];
    try {
      const ud = app.getPath('userData');
      const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch (e) { return false; } };
      if (list.includes('models')) {
        rm(path.join(ud, 'fufumidi', 'models'));
        done.push('models');
      }
      if (list.includes('soundfonts')) {
        rm(path.join(ud, 'fufumidi', 'soundfonts'));
        done.push('soundfonts');
      }
      if (list.includes('playdata')) { done.push('playdata'); }
      // 清空模型后需要重建内置模型 junction → 提示前端重启应用
      return { ok: true, done, needRestart: done.includes('models') };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
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

module.exports = { registerSystemIpc };
