// ============================================================
// 主进程诊断服务：运行期依赖检查/安装、诊断包导出
// ============================================================
'use strict';

function registerDiagnosticsIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, spawnEngine }) {
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

  // 全局体检：主动检查各子系统并**下结论**（不是打包现成文件）。
  // 其中「算力校验」会真的在显卡上跑一次矩阵乘并与 CPU 对拍，所以要几秒 ——
  // 这正是 AMD / Intel 用户最需要的一项：装了卡但 kernel 不匹配时，
  // 只有真算一遍才暴露（issue #20），任何版本号都看不出来。
  ipcMain.handle('diag:health', () => new Promise((resolve) => {
    spawnEngine([], {
      script: 'health.py',
      onDone: (code, r) => {
        const res = r.result || {};
        resolve({ ok: code === 0 && res.ok !== false, report: res.report || null,
                  error: res.error || null, raw: r.out || r.err });
      },
      onError: (e) => resolve({ ok: false, error: String(e) }),
    });
  }));
}

module.exports = { registerDiagnosticsIpc };
