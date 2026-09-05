// ============================================================
// 主进程任务队列服务：音频转录、智能修正与任务取消
// ============================================================
'use strict';

function registerTaskQueueIpc({ ipcMain, BrowserWindow, app, path, fs, spawnEngine, engineWorkerConvert, pluginHost, readSettings, resolveSeparateModel }) {
  const convertChildren = new Map();  // jobId -> 子进程句柄（转录/修正取消用）

  // 转录
  ipcMain.handle('engine:convert', async (evt, cfg) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!cfg.out) {
      const rawName = (cfg.name || cfg.audio || 'audio').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      const base = rawName || 'audio';
      // 输出目录优先级：设置里显式配置的「默认输出目录」> 与输入文件同目录 > 系统临时目录
      let dir = '';
      try {
        const s = readSettings ? readSettings() : {};
        dir = (s && s.output_dir && String(s.output_dir).trim()) || '';
      } catch (e) { dir = ''; }
      if (!dir) {
        const srcDir = (cfg.audio || '').replace(/[\\/][^\\/]*$/, '');
        dir = srcDir && srcDir !== (cfg.audio || '') ? srcDir : app.getPath('temp');
      }
      // 目录不存在则创建；不可写时回退到临时目录
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.fuprobe_' + Date.now());
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
      } catch (e) {
        dir = path.join(app.getPath('temp'), 'fufumidi');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
      }
      cfg.out = path.join(dir, base + '.mid');
      let n = 1;
      while (fs.existsSync(cfg.out)) { cfg.out = path.join(dir, base + '_' + n + '.mid'); n++; }
    }
    const runSpawn = () => new Promise((resolve, reject) => {
      const args = ['convert', cfg.audio, '-o', cfg.out];
      if (cfg.mode) args.push('--mode', cfg.mode);
      if (cfg.perf) args.push('--perf', cfg.perf);
      const map = {
        onset_threshold: '--onset-threshold',
        frame_threshold: '--frame-threshold',
        min_note_length: '--min-note-length',
        min_note_ms: '--min-note-ms',
        merge_gap_ms: '--merge-gap-ms',
        tempo: '--tempo',
      };
      for (const [k, flag] of Object.entries(map)) {
        if (cfg[k] !== undefined && cfg[k] !== null) args.push(flag, String(cfg[k]));
      }
      for (const [k, flag] of Object.entries({ denoise: '--denoise', normalize: '--normalize', auto_bpm: '--auto-bpm', no_merge: '--no-merge', no_velnorm: '--no-velnorm', with_drums: '--with-drums', no_pedal: '--no-pedal', export_stems: '--export-stems' })) {
        if (cfg[k]) args.push(flag);
      }
      if (cfg.model) args.push('--model', cfg.model);
      if (cfg.model_size) args.push('--model-size', cfg.model_size);
      const send = (line) => {
        if (win && !win.isDestroyed()) win.webContents.send('engine:log', { id: cfg.id, line });
      };
      try {
        const child = spawnEngine(args, {
          onLog: send,
          onDone: (code, r) => {
            convertChildren.delete(cfg.id);
            if (r.result) {
              pluginHost.emit('transcribe-done', { ok: !!r.result.ok, out: r.result.out, note_count: r.result.note_count, mode: cfg.mode, perf: cfg.perf });
              return resolve(r.result);
            }
            resolve({ ok: code === 0, code, out: cfg.out, error: (r.err || r.out || '').slice(-400) });
          },
          onError: (e) => { convertChildren.delete(cfg.id); reject(new Error(e)); },
        });
        convertChildren.set(cfg.id, child);
      } catch (e) { reject(new Error(String(e))); }
    });

    if (cfg.audio && !cfg.forceSpawn) {
      try {
        cfg.__win = win; cfg.__logId = cfg.id;
        const workerRes = await engineWorkerConvert(cfg);
        if (workerRes && workerRes.ok) {
          pluginHost.emit('transcribe-done', { ok: true, out: workerRes.out, note_count: workerRes.note_count, mode: cfg.mode, perf: cfg.perf });
          return workerRes;
        }
      } catch (e) { /* fallback to single spawn */ }
    }
    return runSpawn();
  });

  // 智能修正（转录 MIDI + 原音频 → 精修 MIDI）
  ipcMain.handle('engine:refine', (evt, cfg) => new Promise((resolve, reject) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!cfg || !cfg.audio || !cfg.midi) { reject(new Error('缺少输入：需要原始音频与转录 MIDI 路径')); return; }
    if (!cfg.out) {
      const base = cfg.midi.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') + '_refined';
      cfg.out = path.join(app.getPath('temp'), 'fufumidi', `${base}_${Date.now()}.mid`);
      try { fs.mkdirSync(path.dirname(cfg.out), { recursive: true }); } catch {}
    }
    const args = ['refine', '--audio', cfg.audio, '--midi', cfg.midi, '-o', cfg.out];
    if (cfg.mode) args.push('--mode', cfg.mode);
    if (cfg.stemBalance !== undefined) args.push('--stem-balance', cfg.stemBalance ? 'on' : 'off');
    const send = (line) => {
      if (win && !win.isDestroyed()) win.webContents.send('engine:refine:log', { id: cfg.id, line });
    };
    try {
      const child = spawnEngine(args, {
        script: 'smart_midi.py',
        onLog: send,
        onDone: (code, r) => {
          convertChildren.delete(cfg.id);
          if (r.result) {
            pluginHost.emit('refine-done', { ok: !!r.result.ok, out: r.result.out, stats: r.result.stats, mode: cfg.mode });
            return resolve(r.result);
          }
          resolve({ ok: code === 0, code, out: cfg.out, error: (r.err || r.out || '').slice(-400) });
        },
        onError: (e) => { convertChildren.delete(cfg.id); reject(new Error(e)); },
      });
      convertChildren.set(cfg.id, child);
    } catch (e) { reject(new Error(String(e))); }
  }));

  // 音频处理（MSST 分离）：audio + 分离模型 → 输出所选音轨
  ipcMain.handle('engine:separate', (evt, cfg) => new Promise((resolve, reject) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!cfg || !cfg.audio || !cfg.sep_model) { reject(new Error('缺少参数：需要音频文件与处理模型')); return; }
    if (!resolveSeparateModel) { reject(new Error('音频处理服务未就绪')); return; }
    const resolved = resolveSeparateModel(cfg.sep_model);
    if (!resolved) { reject(new Error('未知的分离模型：' + cfg.sep_model)); return; }
    if (resolved.exists === false) { reject(new Error(resolved.error || '该模型未下载，请先到模型管理下载')); return; }
    if (!resolved.configPath) { reject(new Error('该模型缺少配置文件，暂不支持此模型')); return; }

    // 输出目录优先级：设置里显式配置的「默认输出目录」> 调用方指定 > 与输入同目录 > 临时目录
    let dir = cfg.out_dir && String(cfg.out_dir).trim() ? String(cfg.out_dir).trim() : '';
    if (!dir) {
      try { const s = readSettings ? readSettings() : {}; dir = (s && s.output_dir && String(s.output_dir).trim()) || ''; } catch (e) { dir = ''; }
    }
    if (!dir) {
      const srcDir = (cfg.audio || '').replace(/[\\/][^\\/]*$/, '');
      dir = srcDir && srcDir !== (cfg.audio || '') ? srcDir : app.getPath('temp');
    }
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { dir = app.getPath('temp'); try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {} }

    const args = ['separate', cfg.audio, '--output', dir,
      '--model', resolved.modelPath, '--config', resolved.configPath, '--arch', resolved.arch];
    if (cfg.chunk_size) args.push('--chunk-size', String(cfg.chunk_size));
    if (cfg.num_overlap) args.push('--num-overlap', String(cfg.num_overlap));
    if (cfg.batch_size) args.push('--batch-size', String(cfg.batch_size));
    if (Array.isArray(cfg.stems) && cfg.stems.length) args.push('--stems', cfg.stems.join(','));
    if (cfg.format) args.push('--format', String(cfg.format).toLowerCase());
    if (cfg.tta) args.push('--tta');
    if (cfg.normalize) args.push('--normalize');

    const sendLog = (line) => { if (win && !win.isDestroyed()) win.webContents.send('engine:separate:log', { id: cfg.id, line }); };
    const sendProg = (p) => { if (win && !win.isDestroyed()) win.webContents.send('engine:separate:progress', Object.assign({ id: cfg.id }, p || {})); };
    try {
      const child = spawnEngine(args, {
        onLog: sendLog,
        onProgress: sendProg,
        onDone: (code, r) => {
          convertChildren.delete(cfg.id);
          if (r.result) return resolve(r.result);
          resolve({ ok: code === 0, code, out_dir: dir, error: (r.err || r.out || '').slice(-400) });
        },
        onError: (e) => { convertChildren.delete(cfg.id); reject(new Error(e)); },
      });
      convertChildren.set(cfg.id, child);
    } catch (e) { reject(new Error(String(e))); }
  }));

  // 取消转录 / 修正（终止对应 jobId 的引擎子进程）
  ipcMain.handle('engine:cancel', (_e, id) => {
    const c = convertChildren.get(id);
    if (c) { try { c.kill(); } catch {} convertChildren.delete(id); return { ok: true }; }
    return { ok: false };
  });
}

module.exports = { registerTaskQueueIpc };
