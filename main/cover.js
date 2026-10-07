// ============================================================
// 翻唱工作流（主进程）：一首歌 → 分离 → 扒谱 → 合成 → 混音 → 成品
// ------------------------------------------------------------
// 引擎侧只有一份实现：engine/engine_cover.py（CLI 与界面走同一条路，
// 分离又复用「音频处理」面板同一个入口 music2midi.py separate）。
//
// 两条音色通道：
//   · DiffSinger 声库（--voicebank）：扒谱出的音符 → 逐句合成
//   · GPT-SoVITS 音色（--gsv-voice）：逐句拿原唱那一句当参考重合成（路线 A+）
// 两者产出同构（一条整长干声轨），后面的混音完全共用。
//
// ★ GPT-SoVITS 推理跑在**另一个解释器**里（应用自带的 python 没有 torch），
//   由引擎侧 gsv_env.find_python 解析；这里只负责把 FUFUMIDI_GSV_ROOT /
//   FUFUMIDI_GSV_PYTHON 通过环境变量传下去。
// ============================================================
'use strict';

const Paths = require('./paths');

function registerCoverIpc({ ipcMain, BrowserWindow, path, fs, dialog, shell, spawnEngine,
                            engineEnv, readSettings }) {
  //: 当前运行中的翻唱任务（同一时刻只允许一个：它会占满 CPU/GPU）
  let current = null;
  let seq = 0;

  const modelsDir = () => Paths.modelsDir();
  const voicesRoot = () => path.join(modelsDir(), 'gpt-sovits', 'voices');

  function send(win, payload) {
    if (win && !win.isDestroyed()) win.webContents.send('cover:progress', payload);
  }

  function hasFile(p) { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } }
  function hasDir(p) { try { return !!p && fs.statSync(p).isDirectory(); } catch (e) { return false; } }

  /** 列一个目录下的文件（失败返回空数组，不抛） */
  function readdir(dir) {
    try { return fs.readdirSync(dir); } catch (e) { return []; }
  }

  /* ---------------- DiffSinger 声库（用户装的那些） ---------------- */
  function diffsingerSingers() {
    const root = Paths.diffsingerVoicebanksDir();
    const out = [];
    for (const name of readdir(root)) {
      const dir = path.join(root, name);
      if (!hasDir(dir) || !hasFile(path.join(dir, 'dsconfig.yaml'))) continue;
      const builtinVoc = hasDir(path.join(dir, 'dsvocoder'));
      out.push({ kind: 'diffsinger', id: name, name, dir,
        ready: hasDir(path.join(dir, 'dsdur')) && (builtinVoc || true),
        note: builtinVoc ? '自带声码器' : '通用声码器' });
    }
    return out;
  }

  /* ---------------- GPT-SoVITS 音色（资源中心下载 / 用户导入的） ---------------- */
  function gsvVoices() {
    const root = voicesRoot();
    const out = [];
    for (const name of readdir(root)) {
      const dir = path.join(root, name);
      if (!hasDir(dir)) continue;
      const files = readdir(dir);
      const ckpt = files.find((f) => /\.ckpt$/i.test(f));
      const pth = files.find((f) => /\.pth$/i.test(f));
      const ref = files.find((f) => /^(ref|reference)\.(wav|mp3|flac)$/i.test(f))
        || files.find((f) => /\.(wav|mp3|flac)$/i.test(f));
      out.push({ kind: 'gsv', id: name, name, dir, ready: !!(ckpt && pth),
        note: (ckpt && pth) ? ('v2 · 参考音 ' + (ref || '缺失')) : '权重不完整（缺 .ckpt/.pth）' });
    }
    return out;
  }

  /* ---------------- GPT-SoVITS 运行时 ---------------- */
  /** 运行时目录候选：runtime.json（资源中心/用户手写）→ <数据根>/gpt-sovits/runtime */
  function gsvRuntime() {
    const cfgFile = path.join(Paths.dataRoot(), 'gpt-sovits', 'runtime.json');
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8')) || {}; } catch (e) { cfg = {}; }
    const cands = [cfg.root, path.join(Paths.dataRoot(), 'gpt-sovits', 'runtime')].filter(Boolean);
    for (const root of cands) {
      if (hasFile(path.join(root, 'GPT_SoVITS', 'TTS_infer_pack', 'TTS.py'))) {
        const py = [cfg.python, path.join(root, 'python', 'python.exe')].find(hasFile) || '';
        return { found: true, root, python: py, source: root === cfg.root ? 'runtime.json' : '数据目录' };
      }
    }
    return { found: false, root: '', python: '', source: '' };
  }

  /* ---------------- IPC ---------------- */

  ipcMain.handle('cover:env', async () => {
    const gsv = gsvRuntime();
    return { ok: true, dataRoot: Paths.dataRoot(), modelsRoot: modelsDir(),
      voicesRoot: voicesRoot(), gsv: { ...gsv, voices: gsvVoices().length } };
  });

  ipcMain.handle('cover:singers', async () => {
    try { return { ok: true, diffsinger: diffsingerSingers(), gsv: gsvVoices() }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  // 选源音频（主进程 dialog 才能拿到真实路径；渲染进程的 File 对象拿不到）
  ipcMain.handle('cover:pickAudio', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择要翻唱的歌曲',
      properties: ['openFile'],
      filters: [{ name: '音频', extensions: ['flac', 'wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus'] },
                { name: '全部文件', extensions: ['*'] }],
    });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    return { ok: true, path: r.filePaths[0] };
  });

  ipcMain.handle('cover:pickDir', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const r = await dialog.showOpenDialog(win, {
      title: '选择输出目录', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths.length) return { canceled: true };
    return { ok: true, path: r.filePaths[0] };
  });

  ipcMain.handle('cover:cancel', async () => {
    if (!current) return { ok: true, canceled: false };
    current.aborted = true;
    try { current.child.kill(); } catch (e) {}
    return { ok: true, canceled: true };
  });

  ipcMain.handle('cover:open', async (evt, p) => {
    try { if (p) await shell.openPath(String(p)); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });

  ipcMain.handle('cover:run', async (evt, opts) => {
    const o = opts || {};
    if (current) return { ok: false, error: '已有一个翻唱任务在跑，先取消它' };
    if (!hasFile(o.audio)) return { ok: false, error: '请先选择源音频' };
    const singer = o.singer || {};
    if (!singer.kind || !singer.path) return { ok: false, error: '请选择声库或音色' };
    if (!o.outdir) return { ok: false, error: '请选择输出目录' };
    try { fs.mkdirSync(o.outdir, { recursive: true }); }
    catch (e) { return { ok: false, error: '输出目录不可写：' + (e && e.message) }; }

    const win = BrowserWindow.fromWebContents(evt.sender);
    const id = 'cover' + (++seq);
    const args = [o.audio, '--outdir', o.outdir];
    if (o.name) args.push('--name', String(o.name));
    if (singer.kind === 'gsv') {
      args.push('--gsv-voice', singer.path);
      const rt = gsvRuntime();
      const root = o.gsvRoot || rt.root;
      const py = o.gsvPython || rt.python;
      if (root) args.push('--gsv-root', String(root));
      if (py) args.push('--gsv-python', String(py));
      if (o.version) args.push('--gsv-version', String(o.version));
      if (o.align === false) args.push('--no-gsv-align');
    } else {
      args.push('--voicebank', singer.path);
    }
    args.push('--device', o.device || 'auto');
    if (o.clarityDb != null) args.push('--clarity-db', String(o.clarityDb));
    if (o.lyrics && o.lyrics !== 'auto') args.push('--lyrics', String(o.lyrics));
    if (o.noResume) args.push('--no-resume');
    if (o.sepModel) args.push('--sep-model', String(o.sepModel));
    if (o.sepConfig) args.push('--sep-config', String(o.sepConfig));
    if (o.sepArch) args.push('--sep-arch', String(o.sepArch));
    // 复用「音频处理」面板刚分离出来的音轨（用户在那里分离完可以直接过来翻唱）
    if (hasFile(o.vocals) && hasFile(o.instrumental)) {
      args.push('--vocals', String(o.vocals), '--instrumental', String(o.instrumental));
    }

    send(win, { id, phase: 'start', percent: 0, text: '开始…', done: false });
    const logs = [];
    const rt = gsvRuntime();
    const env = engineEnv({
      FUFUMIDI_COVER_VOICEBANK: singer.kind === 'gsv' ? singer.path : '',
      ...(rt.root ? { FUFUMIDI_GSV_ROOT: String(o.gsvRoot || rt.root) } : {}),
      ...(rt.python || o.gsvPython ? { FUFUMIDI_GSV_PYTHON: String(o.gsvPython || rt.python) } : {}),
      ...(o.gsvRoot ? { FUFUMIDI_GSV_ROOT: String(o.gsvRoot) } : {}),
    });
    const child = spawnEngine(args, {
      script: 'engine_cover.py',
      timeoutMs: 6 * 60 * 60 * 1000,
      env,
      onProgress: (p) => {
        const pct = Number(p && p.percent);
        const text = (p && (p.stage || '')) + ((p && p.part) ? (' ' + p.part + '/' + (p.parts || '?')) : '');
        send(win, { id, percent: isFinite(pct) ? pct : -1, text, stage: (p && p.stage) || '', done: false });
      },
      onLog: (line) => {
        logs.push(line);
        if (logs.length > 400) logs.shift();
        send(win, { id, percent: -1, log: line, done: false });
      },
      onError: (msg) => {
        current = null;
        send(win, { id, percent: 100, text: String(msg), done: true, ok: false, error: String(msg) });
      },
      onDone: (code, info) => {
        const aborted = !!(current && current.aborted);
        current = null;
        const result = (info && info.result) || null;
        const ok = !aborted && code === 0 && result && result.ok !== false;
        send(win, { id, percent: 100, done: true, ok, code, aborted,
          result, error: ok ? '' : ((result && result.error) || (info && info.err || '').slice(-600) || ('退出码 ' + code)),
          logs: logs.slice(-80) });
      },
    });
    current = { id, child, aborted: false, outdir: o.outdir };
    return { ok: true, id };
  });

  return { diffsingerSingers, gsvVoices, gsvRuntime };
}

module.exports = { registerCoverIpc };
