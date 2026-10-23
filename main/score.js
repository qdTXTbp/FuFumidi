// ============================================================
// 主进程乐谱服务：PNG 分页 ZIP / PDF 导出
// ============================================================
'use strict';
const Paths = require('./paths');

/** 变谱的按页缓存目录会随每次整批跑增长（每页一份解析 JSON）—— 只留最近 8 个，其余删掉。
 *  正在被引用的目录不会被删（重试发生在同一次会话里，8 个足够覆盖）。 */
function pruneOmrRuns() {
  try {
    const root = Paths.cacheDir('omr');
    const dirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^run-/.test(d.name))
      .map((d) => ({ p: path.join(root, d.name), t: fs.statSync(path.join(root, d.name)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const d of dirs.slice(8)) { try { fs.rmSync(d.p, { recursive: true, force: true }); } catch (e) {} }
  } catch (e) { /* 清理失败不影响转换 */ }
}


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
      // 只在打印时把页面裁成乐谱本身：白底、黑谱、隐藏全部应用 UI，避免把深色工作区整页打进 PDF。
      const printCss = `@media print {
        @page { size: A4 portrait; margin: 12mm; }
        html, body { background: #fff !important; }
        body * { visibility: hidden !important; }
        .score-view, .score-view * { visibility: visible !important; }
        .score-view { position: absolute !important; inset: 0 auto auto 0 !important; width: 100% !important; height: auto !important; padding: 0 !important; gap: 0 !important; background: #fff !important; }
        .score-head, .score-toolbar, .score-subbar, .score-legend { display: none !important; }
        .score-scroll { position: static !important; overflow: visible !important; height: auto !important; max-height: none !important; padding: 0 !important; border: 0 !important; background: #fff !important; }
        #abcScore { color: #000 !important; background: #fff !important; overflow: visible !important; }
        #abcScore svg { display: block !important; width: 100% !important; height: auto !important; max-width: 100% !important; background: #fff !important; }
        #abcScore svg * { fill: #000 !important; stroke: #000 !important; }
      }`;
      let cssKey = '';
      try { cssKey = await win.webContents.insertCSS(printCss, { cssOrigin: 'user' }); } catch (e) {}
      try {
        const data = await win.webContents.printToPDF({
          printBackground: true,
          pageSize: 'A4',
          landscape: false,
          margins: { marginType: 'none' },
          preferCSSPageSize: true,
        });
        await fs.promises.writeFile(r.filePath, data);
        return { ok: true, path: r.filePath };
      } finally {
        if (cssKey) { try { await win.webContents.removeInsertedCSS(cssKey); } catch (e) {} }
      }
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
  /* ★ 「取消」句柄（用户：「变谱页缺失取消键」）：一次只跑一个 OMR 任务，用一个句柄表达"当前这一跑"。
     两件事都要做 —— 先标记 canceled，再 kill 子进程：只标记要等当前页跑完才停，
     只 kill 的话 onDone 会带回"引擎退出码 1"，界面会把它当失败弹错误。 */
  let activeRun = null;
  ipcMain.handle('score:cancel', () => {
    if (!activeRun) return { ok: false, error: '没有正在进行的识别' };
    activeRun.canceled = true;
    try { if (activeRun.child && activeRun.child.exitCode === null) activeRun.child.kill(); } catch (e) { /* 忽略 */ }
    return { ok: true };
  });

  ipcMain.handle('score:toMidi', (evt, cfg) => new Promise((resolve) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    (async () => {
      const opts = cfg || {};
      // ★ 多选：cfg.inputs 是**有序**的 [{path} | {pages}]（PDF 由渲染进程栅格化后回填 pages）。
      //   兼容旧的单个 path / pages 写法。
      let items = Array.isArray(opts.inputs) ? opts.inputs.filter((x) => x && (x.path || (x.pages && x.pages.length))) : [];
      if (!items.length) {
        const src0 = opts.path || '';
        const pages0 = Array.isArray(opts.pages) ? opts.pages.filter((x) => typeof x === 'string' && x.length > 32) : [];
        if (src0) items = [{ path: src0 }];
        else if (pages0.length) items = [{ pages: pages0 }];
      }
      if (!items.length) {
        const picked = await dialog.showOpenDialog(win, {
          title: '选择谱面（可多选：MusicXML / PDF / 图片 / MIDI）',
          properties: ['openFile', 'multiSelections'],
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
        items = picked.filePaths.map((p) => ({ path: p }));
      }
      for (const it of items) {
        if (it.path && !fs.existsSync(it.path)) return resolve({ ok: false, error: '找不到文件：' + it.path });
      }
      if (!spawnEngine) return resolve({ ok: false, error: '引擎不可用（spawnEngine 未注入）' });

      const work = path.join(Paths.tempDir(), 'fufumidi', 'score2midi_' + Date.now());
      fs.mkdirSync(work, { recursive: true });
      const out = path.join(work, 'out.mid');
      const overlayDir = path.join(work, 'overlay');
      const names = items.map((it) => (it.path ? path.basename(it.path) : 'page.png'));
      const name = opts.name || names[0] || 'score.pdf';
      const kindOf = (it) => {
        if (it.pages && it.pages.length) return 'raster';
        const e = extOf(it.path);
        if (MIDI_EXT.includes(e)) return 'midi';
        if (RASTER_EXT.includes(e) || e === 'pdf') return 'raster';
        return 'score';
      };
      const kinds = [...new Set(items.map(kindOf))];
      if (kinds.length > 1) {
        return resolve({ ok: false, error: '不要混着选：图片 / PDF 是一类，MusicXML 是一类，MIDI 是一类。', errorCode: 'mixed', kind: kinds[0] });
      }
      const kind = kinds[0];

      // PDF：主进程没有栅格化能力（Electron 的 PDF 插件翻页拿不到），
      // 交回渲染进程用 pdf.js 渲染成 PNG 再调一次（多选时逐个 PDF 都要渲）。
      if (kind === 'raster' && items.some((it) => !it.pages && extOf(it.path) === 'pdf')) {
        return resolve({ ok: false, needRaster: true, inputs: items, fileName: name, names, kind: 'pdf' });
      }

      // MIDI：本来就是 MIDI，直接回字节（多选只取第一个）
      if (kind === 'midi') {
        try {
          const bytes = fs.readFileSync(items[0].path).toString('base64');
          const info = { ok: true, kind: 'midi', noteCount: 0, tracks: [], warnings: [] };
          if (items.length > 1) info.warnings.push({ code: 'only-first', n: items.length });
          return resolve({ ok: true, kind: 'midi', passthrough: true, bytes, sourcePath: items[0].path, fileName: name,
                           names, info });
        } catch (e) { return resolve({ ok: false, error: '读取 MIDI 失败：' + String(e) }); }
      }

      // 栅格页（PDF 由渲染进程栅格化后送过来）：落成 PNG 文件，保持用户选择的先后顺序
      const inputs = [];
      let pageNo = 0;
      let truncated = false;
      const MAXP = 60;
      for (const it of items) {
        if (it.pages && it.pages.length) {
          for (const b64 of it.pages) {
            if (pageNo >= MAXP) { truncated = true; break; }
            pageNo += 1;
            const p = path.join(work, 'page-' + String(pageNo).padStart(3, '0') + '.png');
            fs.writeFileSync(p, Buffer.from(b64, 'base64'));
            inputs.push(p);
          }
        } else {
          inputs.push(it.path);
        }
        if (truncated) break;
      }
      // MusicXML 解析器一次只吃一个文件：多选时只转第一个并如实回报
      const multiOnlyFirst = kind === 'score' && items.length > 1;

      pruneOmrRuns();
      const args = ['to-midi'];
      const feed = kind === 'score' ? inputs.slice(0, 1) : inputs;
      for (const p of feed) args.push('--in', p);
      args.push('--out', out, '--overlay', overlayDir);
      if (kind === 'raster') {
        // ★ 拍号 / 速度支持 'auto'：谱面自己写的优先，用户填了才覆盖。
        //   以前这里无条件取 Number(opts.beats) || 4，引擎侧又只把它用在经典后端，
        //   于是界面上「自动」这个选项无从表达、Audiveris 路径上更是完全没用。
        const beatsRaw = String(opts.beats === undefined || opts.beats === null ? 'auto' : opts.beats);
        args.push('--beats', beatsRaw === 'auto' ? 'auto'
          : String(Math.max(1, Math.min(16, parseInt(beatsRaw, 10) || 4))));
        args.push('--beat-type', String([2, 4, 8, 16].includes(Number(opts.beatType)) ? Number(opts.beatType) : 4));
        const tempoRaw = String(opts.tempo === undefined || opts.tempo === null ? 'auto' : opts.tempo);
        const tempoNum = Number(tempoRaw);
        args.push('--tempo', (tempoRaw === 'auto' || !isFinite(tempoNum) || tempoNum <= 0)
          ? 'auto' : String(Math.max(20, Math.min(300, tempoNum))));
        // 识谱预处理（放大倍数 / 加粗）与后处理（量化 / 最短音符 / 去重）
        const up = String(opts.upscale === undefined || opts.upscale === null ? 'auto' : opts.upscale);
        args.push('--upscale', /^[0-9]+(\.[0-9]+)?$/.test(up) ? up : 'auto');
        args.push('--thicken', opts.thicken ? 'on' : 'off');
        // ★ M3-3 共用影像预处理层：off | auto（看着像扫描件/照片才上）| scan（强制）
        //   auto 是默认 —— 干净印刷谱实测与旧路径逐像素一致，歪的/带阴影的才走新路径。
        const prep = String(opts.prep || 'auto').toLowerCase();
        args.push('--prep', ['off', 'auto', 'scan'].includes(prep) ? prep : 'auto');
        // ★ M3-2 超分辨率：off | auto（只在谱表量不出来 / 行距 < 5px 时开）| on（强制）
        const sr = String(opts.sr || 'auto').toLowerCase();
        args.push('--sr', ['off', 'auto', 'on'].includes(sr) ? sr : 'auto');
        const srExe = path.join(Paths.dataRoot(), 'omr', 'waifu2x', 'waifu2x-ncnn-vulkan.exe');
        if (fs.existsSync(srExe)) args.push('--sr-exe', srExe);
        const q = String(opts.quantize || 'off');
        args.push('--quantize', ['off', '1/4', '1/8', '1/16', '1/32'].includes(q) ? q : 'off');
        const mn = Number(opts.minNoteMs) || 0;
        args.push('--min-note-ms', String(mn > 0 && mn <= 2000 ? mn : 0));
        args.push('--dedupe', opts.dedupe === false ? 'off' : 'on');
        // 移调乐器：默认写实际音高（Horn in F 差纯五度、Clarinet/Trumpet in Bb 差大二度）
        args.push('--sounding', opts.sounding === false ? 'off' : 'on');
      }
      // 栅格一律走多后端调度层：装着 Audiveris 就用它（质量高一个量级），没装自动降级到自带经典识谱
      const script = kind === 'raster' ? 'engine_omr_backends.py' : 'engine_score2midi.py';
      if (kind === 'raster') {
        args.push('--backend', String(opts.backend || 'auto'));
        args.push('--mode', String(opts.mode || 'auto'));
        const avExe = path.join(Paths.dataRoot(), 'omr', 'audiveris', 'Audiveris', 'Audiveris.exe');
        if (fs.existsSync(avExe)) args.push('--audiveris', avExe);
        // homr（用户自行安装，装在数据根下的独立 venv）：扫描件 / 拍照路径
        const homrExe = path.join(Paths.dataRoot(), 'omr', 'homr', 'venv', 'Scripts', 'homr.exe');
        if (fs.existsSync(homrExe)) args.push('--homr', homrExe);
        /* ★ M2-4「一键重试该页」：给每次整批跑一个**稳定的 workdir**，引擎把每页解析结果
           缓存在 <workdir>/pages/ 下；重试时把同一个 workdir 传回去，引擎只重跑那一页，
           其余页从缓存读回，再整份重新合并（合并必须看到完整页集，否则拍号与跨页声部会变）。 */
        const retryPage = Math.max(0, parseInt(opts.retryPage, 10) || 0);
        let workdir = '';
        try {
          if (retryPage && typeof opts.workdir === 'string' && opts.workdir && fs.existsSync(opts.workdir)) {
            workdir = opts.workdir;
          } else {
            workdir = path.join(Paths.cacheDir('omr'), 'run-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
          }
        } catch (e) { workdir = ''; }
        if (workdir) args.push('--workdir', workdir);
        if (retryPage) args.push('--retry-page', String(retryPage));
      }
      const run = { canceled: false, child: null };
      activeRun = run;
      const res = await new Promise((done) => {
        let settled = false;
        const finish = (v) => { if (!settled) { settled = true; done(v); } };
        run.child = spawnEngine(args, {
          script,
          timeoutMs: 10 * 60 * 1000,
          onProgress: (p) => {
            if (run.canceled) { finish({ ok: false, canceled: true }); return; }
            try { win && win.webContents.send('score:progress', p); } catch (e) {}
          },
          onDone: (code, rr) => {
            if (run.canceled) { finish({ ok: false, canceled: true }); return; }
            const r = rr && rr.result;
            finish(r || { ok: false, error: '引擎没有返回结果（退出码 ' + code + '）' });
          },
          onError: (e) => finish(run.canceled ? { ok: false, canceled: true } : { ok: false, error: String(e) }),
        });
      });
      if (activeRun === run) activeRun = null;
      if (run.canceled) return resolve({ ok: false, canceled: true });
      if (!res || !res.ok) return resolve({ ok: false, error: (res && res.error) || '转换失败',
        errorCode: (res && res.code) || '', workdir: (res && res.workdir) || '',
        inputs: items, fileName: name, names, kind });
      let bytes = null;
      try { bytes = fs.readFileSync(out).toString('base64'); } catch (e) { return resolve({ ok: false, error: '读回 MIDI 失败：' + String(e) }); }
      let overlays = [];
      try {
        overlays = (res.overlays || []).filter((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
      } catch (e) {}
      // 多选相关的如实回报（界面按 code 翻译）
      if (multiOnlyFirst) { res.warnings = (res.warnings || []).concat([{ code: 'only-first', n: items.length }]); }
      if (truncated) { res.warnings = (res.warnings || []).concat([{ code: 'page-cap', n: MAXP }]); }
      /* pages = **未标注**的原谱页图（overlays 是同尺寸的「识别对照图」，带红圈/彩框）。
         §6.4 的「在工作台校对」要的是原谱页图当半透明底图 —— 标注图会把符头糊掉。
         两者按同一顺序一一对应（引擎按输入页顺序出 overlay-01/02…）。 */
      let pages = [];
      if (kind === 'raster') {
        pages = inputs.filter((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
      }
      resolve({ ok: true, kind, info: res, bytes, overlays, pages, workdir: (res && res.workdir) || '',
        sourcePath: (feed[0] || ''), fileName: name, names });
    })().catch((e) => resolve({ ok: false, error: String((e && e.message) || e) }));
  }));
}

module.exports = { registerScoreIpc };
