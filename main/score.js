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
   * 「变谱」：谱面 → MIDI（全格式）
   *
   * 四条路，按输入分流：
   *   1. MusicXML / MXL     → engine_score2midi.py（19 条回归用例钉住 divisions /
   *                            <backup> 多声部 / 连音线 / 速度表）
   *   2. 图片（png/jpg/gif/webp/bmp/tif…）→ engine_omr.py 光学识谱
   *      （Pillow 直接读；多帧 GIF/TIFF 每一帧当一页）
   *   3. PDF                → 渲染进程用 pdf.js 栅格化成 PNG 再传过来（cfg.pages），
   *                            这里落到临时文件后同样交给 engine_omr.py
   *   4. MIDI               → 本来就是 MIDI，直接读字节（passthrough）
   *
   * 实测：PDF 走 Electron 内置 PDF 查看器截屏拿不到翻页（#page= 不生效，第 2 页和第 1 页
   * 一模一样），所以栅格化放在渲染进程用 pdf.js 做 —— 顺带也能渲染矢量 PDF 到任意分辨率。
   * ------------------------------------------------------------------ */
  const RASTER_EXT = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico', 'ppm', 'pgm', 'avif'];
  const SCORE_EXT = ['musicxml', 'xml', 'mxl'];
  const MIDI_EXT = ['mid', 'midi'];
  const extOf = (p) => { const m = /\.([a-z0-9]+)$/i.exec(String(p || '')); return m ? m[1].toLowerCase() : ''; };
  ipcMain.handle('score:toMidi', (evt, cfg) => new Promise((resolve) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    (async () => {
      const opts = cfg || {};
      let src = opts.path || '';
      let pages = Array.isArray(opts.pages) ? opts.pages.filter((x) => typeof x === 'string' && x.length > 32) : [];
      if (!src && !pages.length) {
        const picked = await dialog.showOpenDialog(win, {
          title: '选择谱面（MusicXML / PDF / 图片 / MIDI）',
          properties: ['openFile'],
          filters: [
            { name: '全部支持的谱面', extensions: [...SCORE_EXT, 'pdf', ...RASTER_EXT, ...MIDI_EXT] },
            { name: '乐谱（MusicXML / MXL）', extensions: SCORE_EXT },
            { name: 'PDF', extensions: ['pdf'] },
            { name: '图片（PNG / JPG / GIF / WebP / BMP / TIFF）', extensions: RASTER_EXT },
            { name: 'MIDI', extensions: MIDI_EXT },
            { name: '全部文件', extensions: ['*'] },
          ],
        });
        if (picked.canceled || !picked.filePaths || !picked.filePaths.length) return resolve({ ok: false, canceled: true });
        src = picked.filePaths[0];
      }
      if (src && !fs.existsSync(src)) return resolve({ ok: false, error: '找不到文件：' + src });
      if (!spawnEngine) return resolve({ ok: false, error: '引擎不可用（spawnEngine 未注入）' });

      const work = path.join(Paths.tempDir(), 'fufumidi', 'score2midi_' + Date.now());
      fs.mkdirSync(work, { recursive: true });
      const out = path.join(work, 'out.mid');
      const overlayDir = path.join(work, 'overlay');
      const name = opts.name || (src ? path.basename(src) : 'score.pdf');
      const ext = extOf(src || name);
      const kind = pages.length ? 'raster' : (MIDI_EXT.includes(ext) ? 'midi' : (RASTER_EXT.includes(ext) || ext === 'pdf' ? 'raster' : 'score'));

      // PDF：主进程没有栅格化能力（Electron 的 PDF 插件翻页拿不到），
      // 交回渲染进程用 pdf.js 渲染成 PNG 再调一次。
      if (kind === 'raster' && !pages.length && ext === 'pdf') {
        return resolve({ ok: false, needRaster: true, sourcePath: src, fileName: name, kind: 'pdf' });
      }

      // MIDI：本来就是 MIDI，直接回字节
      if (kind === 'midi') {
        try {
          const bytes = fs.readFileSync(src).toString('base64');
          return resolve({ ok: true, kind: 'midi', passthrough: true, bytes, sourcePath: src, fileName: name,
                           info: { ok: true, kind: 'midi', noteCount: 0, tracks: [] } });
        } catch (e) { return resolve({ ok: false, error: '读取 MIDI 失败：' + String(e) }); }
      }

      // 栅格页（PDF 由渲染进程栅格化后送过来）：落成 PNG 文件
      let inputs = [];
      if (pages.length) {
        const MAXP = 60;
        pages = pages.slice(0, MAXP);
        for (let i = 0; i < pages.length; i++) {
          const p = path.join(work, 'page-' + String(i + 1).padStart(3, '0') + '.png');
          fs.writeFileSync(p, Buffer.from(pages[i], 'base64'));
          inputs.push(p);
        }
      } else {
        inputs = [src];
      }

      const args = ['to-midi'];
      for (const p of inputs) args.push('--in', p);
      args.push('--out', out, '--overlay', overlayDir);
      if (kind === 'raster') {
        args.push('--beats', String(Math.max(1, Math.min(16, Number(opts.beats) || 4))));
        args.push('--beat-type', String([2, 4, 8, 16].includes(Number(opts.beatType)) ? Number(opts.beatType) : 4));
        args.push('--tempo', String(Math.max(20, Math.min(300, Number(opts.tempo) || 120))));
      }
      const script = kind === 'raster' ? 'engine_omr.py' : 'engine_score2midi.py';
      const res = await new Promise((done) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; done(v); } };
        spawnEngine(args, {
          script,
          timeoutMs: 10 * 60 * 1000,
          onProgress: (p) => { try { win && win.webContents.send('score:progress', p); } catch (e) {} },
          onDone: (code, rr) => {
            const r = rr && rr.result;
            finish(r || { ok: false, error: '引擎没有返回结果（退出码 ' + code + '）' });
          },
          onError: (e) => finish({ ok: false, error: String(e) }),
        });
      });
      if (!res || !res.ok) return resolve({ ok: false, error: (res && res.error) || '转换失败', sourcePath: src, fileName: name, kind });
      let bytes = null;
      try { bytes = fs.readFileSync(out).toString('base64'); } catch (e) { return resolve({ ok: false, error: '读回 MIDI 失败：' + String(e) }); }
      let overlays = [];
      try {
        overlays = (res.overlays || []).filter((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
      } catch (e) {}
      resolve({ ok: true, kind, info: res, bytes, overlays, sourcePath: src || '', fileName: name });
    })().catch((e) => resolve({ ok: false, error: String((e && e.message) || e) }));
  }));
}

module.exports = { registerScoreIpc };
