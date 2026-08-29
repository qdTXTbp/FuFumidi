// ============================================================
// UTAU 声库制作 IPC：把渲染进程传来的声库文件写入用户选择的目录
// ============================================================
'use strict';

function registerUtauIpc({ ipcMain, path, fs }) {
  ipcMain.handle('utau:exportVoicebank', async (_e, opts) => {
    try {
      const { dir, files } = opts || {};
      if (!dir || typeof dir !== 'string' || !Array.isArray(files)) {
        return { ok: false, error: '参数错误' };
      }
      if (!fs.existsSync(dir)) return { ok: false, error: '保存目录不存在' };
      for (const f of files) {
        const name = String((f && f.name) || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
        if (!name) continue;
        const buf = Buffer.from(String((f && f.data) || ''), 'base64');
        fs.writeFileSync(path.join(dir, name), buf);
      }
      return { ok: true, dir, count: files.length };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

module.exports = { registerUtauIpc };
