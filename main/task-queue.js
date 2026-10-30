// ============================================================
// 主进程任务队列服务：音频转录、智能修正与任务取消
// ============================================================
'use strict';
const SepCommon = require('./separate-common');
const Paths = require('./paths');

function registerTaskQueueIpc({ ipcMain, BrowserWindow, app, path, fs, spawnEngine, engineWorkerConvert, cancelEngineJob, pluginHost, readSettings, resolveSeparateModel, ensureSepConfig, center }) {
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
        dir = srcDir && srcDir !== (cfg.audio || '') ? srcDir : Paths.tempDir();
      }
      // 目录不存在则创建；不可写时回退到数据根目录的 temp
      try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, '.fuprobe_' + Date.now());
        fs.writeFileSync(probe, '');
        fs.unlinkSync(probe);
      } catch (e) {
        dir = path.join(Paths.tempDir(), 'fufumidi');
        try { fs.mkdirSync(dir, { recursive: true }); } catch (_) { try { require('./log').write('WARN', 'optional failure', String((_ && _.stack) || _)); } catch (_) { /* log failure ignored */ } }
      }
      cfg.out = path.join(dir, base + '.mid');
      let n = 1;
      while (fs.existsSync(cfg.out)) { cfg.out = path.join(dir, base + '_' + n + '.mid'); n++; }
    }
    const baseName = String(cfg.name || cfg.audio || 'audio').replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') || '音频';
    const task = center ? center.register({
      kind: 'transcribe',
      title: '转录：' + baseName,
      cancelable: true,
      onCancel: () => { try { if (cancelEngineJob) cancelEngineJob(cfg.id); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } },
    }) : null;
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
        denoise_mode: '--denoise-mode',
        // 识别片段长度：回退到命令行这条路径也要带，否则两条路径表现不一致
        segment_sec: '--segment-sec',
        // 音频标签模型 / 分段探测长度：worker 路径走 engine.js map，spawn 回退路径也必须带上，
        // 否则一旦 worker 失败回退，用户选的 CED-Small 会悄悄退回 AudioSet。
        audio_tagger: '--audio-tagger',
        probe_segment_sec: '--probe-segment-sec',
        audio_tagger_window_sec: '--audio-tagger-window-sec',
        min_freq: '--min-freq',
        max_freq: '--max-freq',
        temperature: '--temperature',
        cfg_coef: '--cfg-coef',
        beam_size: '--beam-size',
        precision: '--precision',
        memory_mode: '--memory-mode',
        muscriptor_batch: '--batch-size',
      };
      for (const [k, flag] of Object.entries(map)) {
        if (cfg[k] !== undefined && cfg[k] !== null) args.push(flag, String(cfg[k]));
      }
      for (const [k, flag] of Object.entries({ denoise: '--denoise', normalize: '--normalize', auto_bpm: '--auto-bpm', beat_grid: '--beat-grid', no_merge: '--no-merge', no_velnorm: '--no-velnorm', with_drums: '--with-drums', no_pedal: '--no-pedal', no_melodia: '--no-melodia', export_stems: '--export-stems', multiple_pitch_bends: '--multiple-pitch-bends' })) {
        if (cfg[k]) args.push(flag);
      }
      if (cfg.model) args.push('--model', cfg.model);
      if (cfg.model_size) args.push('--model-size', cfg.model_size);
      // 乐器组约束（MuScriptor 硬约束）：worker 路径走 engine.js 的 map，
      // 这条 spawn 路径要显式补参数，否则「回退到命令行」时约束会丢。
      if (cfg.muscriptor_instruments) args.push('--muscriptor-instruments', String(cfg.muscriptor_instruments));
      // 同上：这条 spawn 路径要显式补参数，否则回退到命令行时超长音符上限会丢。
      if (cfg.max_note_hold != null) args.push('--max-note-hold', String(cfg.max_note_hold));
      const send = (line) => {
        if (win && !win.isDestroyed()) win.webContents.send('engine:log', { id: cfg.id, line });
      };
      try {
        const child = spawnEngine(args, {
          onLog: send,
          onDone: (code, r) => {
            convertChildren.delete(cfg.id);
            if (r.result) {
              try { if (r.result.ok) task && task.done(r.result); else task && task.fail(r.result.error || '转录失败'); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
              pluginHost.emit('transcribe-done', { ok: !!r.result.ok, out: r.result.out, note_count: r.result.note_count, mode: cfg.mode, perf: cfg.perf });
              return resolve(r.result);
            }
            if (!r.result) { try { task && task.fail((r.err || r.out || '转录失败').slice(-400)); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
            resolve({ ok: code === 0, code, out: cfg.out, error: (r.err || r.out || '').slice(-400) });
          },
          onError: (e) => { convertChildren.delete(cfg.id); try { task && task.fail(e); } catch (err) { try { require('./log').write('WARN', 'optional failure', String((err && err.stack) || err)); } catch (_) { /* log failure ignored */ } } reject(new Error(e)); },
        });
        convertChildren.set(cfg.id, child);
      } catch (e) { reject(new Error(String(e))); }
    });

    if (cfg.audio && !cfg.forceSpawn) {
      try {
        cfg.__win = win; cfg.__logId = cfg.id; cfg.__task = task;
        const workerRes = await engineWorkerConvert(cfg);
        if (workerRes && workerRes.ok) {
          try { task && task.done(workerRes); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
          pluginHost.emit('transcribe-done', { ok: true, out: workerRes.out, note_count: workerRes.note_count, mode: cfg.mode, perf: cfg.perf });
          return workerRes;
        }
      } catch (e) {
        // ★ 取消**不是**"worker 失败"，绝不能回落：回落会另起一个一次性进程
        //   把整段转录从头重跑一遍（2026-10-14 实测：点「取消」后 python 又起来了，
        //   用户看到的就是"取消没反应，转录照旧跑完"）。
        if (e && (e.canceled || /canceled/i.test(String(e && e.message)))) throw e;
        /* 其它原因（worker 崩溃 / 启动失败）→ 回落到一次性 spawn，功能永远可用 */
      }
    }
    try {
      const _out = await runSpawn();
      if (!_out || !_out.ok) { try { task && task.fail((_out && _out.error) || '转录失败'); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
      return _out;
    } catch (e) {
      try { task && task.fail(e); } catch (err) { try { require('./log').write('WARN', 'optional failure', String((err && err.stack) || err)); } catch (_) { /* log failure ignored */ } }
      throw e;
    }
  });

  // 转录「暂停 / 继续」（用户 2026-10-14 要求：正在转录的那一首也要能暂停，继续后接着跑）。
  // 只写/删一个标记文件，引擎在 5 秒块与块之间轮询它（见 engine_muscriptor._pause_gate）：
  // **不 kill、不重启** —— 模型状态留在进程里，继续时从原处接着跑。
  ipcMain.handle('engine:set-pause', (_e, on) => {
    const f = Paths.pauseFlagFile();
    try {
      if (on) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, String(Date.now())); }
      else { try { fs.unlinkSync(f); } catch (e2) { try { require('./log').write('WARN', 'optional failure', String((e2 && e2.stack) || e2)); } catch (_) { /* log failure ignored */ } } }
      return { ok: true, paused: !!on, file: f };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // 智能修正（转录 MIDI + 原音频 → 精修 MIDI）
  ipcMain.handle('engine:refine', (evt, cfg) => new Promise((resolve, reject) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    if (!cfg || !cfg.audio || !cfg.midi) { reject(new Error('缺少输入：需要原始音频与转录 MIDI 路径')); return; }
    if (!cfg.out) {
      const base = cfg.midi.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') + '_refined';
      cfg.out = path.join(Paths.tempDir(), 'fufumidi', `${base}_${Date.now()}.mid`);
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

  // 音频时长探测（走 engine/audio_probe.py，用内置 ffmpeg 读头信息）。
  // ★ 不要在渲染进程里 readBinary + decodeAudioData 取时长：1.4 GB 的演唱会 flac
  //   会把整文件读进渲染进程内存再解码，界面直接卡死（长音频分离场景必踩）。
  ipcMain.handle('audio:duration', async (_e, p) => {
    const file = String(p || '');
    try { if (!file || !fs.existsSync(file)) return { ok: false, error: '文件不存在' }; } catch (e) { return { ok: false, error: String(e) }; }
    return new Promise((resolve) => {
      try {
        spawnEngine([file], {
          script: 'audio_probe.py',
          timeoutMs: 120000,
          onDone: (_code, r) => {
            if (r && r.result && r.result.ok) return resolve(r.result);
            resolve({ ok: false, error: (r && ((r.result && r.result.error) || r.err || r.out) || '探测失败').slice(-200) });
          },
          onError: (msg) => resolve({ ok: false, error: String(msg) }),
        });
      } catch (e) { resolve({ ok: false, error: String(e) }); }
    });
  });

  // 音频处理（MSST 分离）：audio + 分离模型 → 输出所选音轨
  ipcMain.handle('engine:separate', async (evt, cfg) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    // ★ 配置自愈：MSST 的配置是**下载模型时**从上游取的（不内置到工具里）。老安装、
    //   或下载完但配置没备齐的，这里补一次再构造请求 —— 否则会以「缺配置」直接失败。
    try {
      const id = cfg && (cfg.model || cfg.modelId || cfg.sepModel);
      const cur = resolveSeparateModel ? resolveSeparateModel(id) : null;
      if (cur && cur.exists && !cur.configPath && ensureSepConfig) await ensureSepConfig(id);
    } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    return new Promise((resolve, reject) => {
    const win2 = win;
    // ★ 参数构造集中在 main/separate-common.js —— 音频处理面板与翻唱工作流共用同一份，
    //   避免「面板出一个文件名、工作流找另一个文件名」这种只在运行时才炸的错。
    const req = SepCommon.buildSeparateRequest(cfg, { resolveSeparateModel, readSettings, Paths, fs });
    if (!req.ok) { reject(new Error(req.error)); return; }
    const dir = req.dir;
    const args = req.args;

    const sendLog = (line) => { if (win && !win.isDestroyed()) win.webContents.send('engine:separate:log', { id: cfg.id, line }); };
    const sendProg = (p) => { if (win && !win.isDestroyed()) win.webContents.send('engine:separate:progress', Object.assign({ id: cfg.id }, p || {})); };
    try {
      // ★ 分离对长音频可能要几十分钟到几小时：总超时放宽到 6 小时（与翻唱一致），
      //   改由「20 分钟没有任何输出」来判定卡死 —— 否则一场演唱会 FLAC 会在 30 分钟被误杀
      //   （2026-10-17 用户实测：denoise mel-band roformer 分离报「引擎执行超时，已强制终止」）。
      sendLog('[分离] 已放宽超时：无进展 20 分钟才终止（硬上限 6 小时）');
      const child = spawnEngine(args, {
        timeoutMs: 6 * 60 * 60 * 1000,
        idleTimeoutMs: 20 * 60 * 1000,
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
    });
  });

  // 取消转录 / 修正（终止对应 jobId 的引擎子进程）
  ipcMain.handle('engine:cancel', (_e, id) => {
    const c = convertChildren.get(id);
    if (c) { try { c.kill(); } catch {} convertChildren.delete(id); return { ok: true }; }
    // ★ worker 路径（engine.js 常驻 worker）记的是另一本账，必须也问一次 ——
    //   否则前端点「取消转录」永远拿到 { ok: false }，正在跑的转录照旧跑完。
    if (cancelEngineJob) {
      try { if (cancelEngineJob(id)) return { ok: true }; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    }
    return { ok: false };
  });
}

module.exports = { registerTaskQueueIpc };