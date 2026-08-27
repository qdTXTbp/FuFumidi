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
