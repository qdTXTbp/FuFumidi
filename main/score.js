// ============================================================
// 主进程乐谱服务：PNG 分页 ZIP / PDF 导出
// ============================================================
'use strict';

function registerScoreIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline }) {
  ipcMain.handle('score:exportPngZip', async (evt, opts) => {
    try {
      if (!opts || !Array.isArray(opts.tiles) || !opts.tiles.length) return { ok: false, error: 'empty tiles' };
      const win = BrowserWindow.fromWebContents(evt.sender);
      const save = await dialog.showSaveDialog({
        title: '导出乐谱 PNG 分页包',
        defaultPath: path.join(app.getPath('downloads'), (opts.name || 'score') + '.zip'),
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      });
      if (save.canceled || !save.filePath) return { ok: false, canceled: true };
      const tmpDir = path.join(app.getPath('temp'), 'fufumidi-score-png');
      fs.mkdirSync(tmpDir, { recursive: true });
      for (let i = 0; i < opts.tiles.length; i++) {
        fs.writeFileSync(path.join(tmpDir, 'score-' + String(i + 1).padStart(3, '0') + '.png'), Buffer.from(opts.tiles[i].data));
      }
      const code = 'import zipfile, glob, os\n' +
        'out = r' + JSON.stringify(save.filePath) + '\n' +
        'd = r' + JSON.stringify(tmpDir) + '\n' +
        'z = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)\n' +
        'for f in glob.glob(os.path.join(d, "*.png")):\n' +
        '    z.write(f, os.path.basename(f))\n' +
        'z.close()\n' +
        'print("###RESULT " + str({"ok": True, "out": out}))';
      const rr = await runEngineInline(code);
      try { for (const f of fs.readdirSync(tmpDir)) fs.unlinkSync(path.join(tmpDir, f)); } catch {}
      return rr && rr.ok ? { ok: true, path: save.filePath } : { ok: false, error: rr.out.slice(-300) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

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
}

module.exports = { registerScoreIpc };
