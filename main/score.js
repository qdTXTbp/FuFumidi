// ============================================================
// 主进程乐谱服务：PNG 分页 ZIP / PDF 导出
// ============================================================
'use strict';
const Paths = require('./paths');

function registerScoreIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline, spawnEngine }) {
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
      const tmpDir = path.join(Paths.tempDir(), 'fufumidi-score-png');
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

  /* ------------------------------------------------------------------
   * 「变谱」：乐谱（MusicXML / MXL）→ MIDI
   *
   * 流程：选文件 → 引擎 engine_score2midi.py 解析并写临时 .mid → 读回字节给渲染进程。
   * 渲染进程拿到字节后决定「另存为」还是「导入曲库并打开编辑器」。
   *
   * ★ 为什么放引擎侧而不是渲染进程里 DOMParser：MusicXML 最易错的是 divisions 单位、
   *   <backup> 分叉的多声部、连音线与速度表 —— 这套逻辑有 19 条回归用例
   *   （engine/tests/test_score2midi.py）钉住，只有放引擎侧才测得到。
   * ------------------------------------------------------------------ */
  ipcMain.handle('score:toMidi', (evt, cfg) => new Promise((resolve) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    (async () => {
      let src = (cfg && cfg.path) || '';
      if (!src) {
        const picked = await dialog.showOpenDialog(win, {
          title: '选择乐谱（MusicXML / MXL）',
          properties: ['openFile'],
          filters: [
            { name: '乐谱（MusicXML / MXL）', extensions: ['musicxml', 'xml', 'mxl'] },
            { name: '全部文件', extensions: ['*'] },
          ],
        });
        if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return resolve({ ok: false, canceled: true });
        src = picked.filePaths[0];
      }
      if (!src || !fs.existsSync(src)) return resolve({ ok: false, error: '找不到文件：' + src });
      if (!spawnEngine) return resolve({ ok: false, error: '引擎不可用（spawnEngine 未注入）' });
      const out = path.join(Paths.tempDir(), 'fufumidi', 'score2midi_' + Date.now() + '.mid');
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const res = await new Promise((done) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; done(v); } };
        spawnEngine(['to-midi', '--in', src, '--out', out], {
          script: 'engine_score2midi.py',
          timeoutMs: 5 * 60 * 1000,
          onDone: (code, rr) => {
            const r = rr && rr.result;
            finish(r || { ok: false, error: '引擎没有返回结果（退出码 ' + code + '）' });
          },
          onError: (e) => finish({ ok: false, error: String(e) }),
        });
      });
      if (!res || !res.ok) return resolve({ ok: false, error: (res && res.error) || '转换失败' });
      let bytes = null;
      try { bytes = fs.readFileSync(out).toString('base64'); } catch (e) { return resolve({ ok: false, error: '读回 MIDI 失败：' + String(e) }); }
      resolve({ ok: true, info: res, bytes, sourcePath: src, fileName: path.basename(src) });
    })().catch((e) => resolve({ ok: false, error: String((e && e.message) || e) }));
  }));
}

module.exports = { registerScoreIpc };
