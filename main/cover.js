// ============================================================
// 翻唱工作流（主进程）：一首歌 → 分离 → 变声 → 混音 → 成品
// ------------------------------------------------------------
// 引擎侧只有一份实现：engine/engine_cover.py（CLI 与界面走同一条路，
// 分离又复用「音频处理」面板同一个入口 music2midi.py separate）。
//
// 音色只有一条通道：**导入的 SVC 模型**（engine/engine_svc.py convert）。
// 旧的两条（GPT-SoVITS 逐句参考重合成、DiffSinger 声库接 RVC）已删除 ——
// SVC 直接把原唱人声换成目标音色，旋律/节奏/咬字本来就来自原唱，
// 不需要歌词也不需要音符表（扒谱环节整段去掉）。
//
// 模型不内置、不代下载（CC-BY-NC-4.0），由用户导入：见 main/svc.js。
// ============================================================
'use strict';

const Paths = require('./paths');
const SVC = require('./svc');

function registerCoverIpc({ ipcMain, BrowserWindow, path, fs, dialog, shell, spawnEngine,
                            engineEnv, readSettings }) {
  //: 当前运行中的翻唱任务（同一时刻只允许一个：它会占满 CPU/GPU）
  let current = null;
  let seq = 0;

  function send(win, payload) {
    if (win && !win.isDestroyed()) win.webContents.send('cover:progress', payload);
  }

  function hasFile(p) { try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; } }

  /* ---------------- 音色 = 导入的 SVC 模型 ---------------- */
  function svcSingers() {
    return SVC.list().filter((m) => m.engine === 'rvc').map((m) => ({
      kind: 'svc', id: m.id, name: m.name, dir: m.dir,
      ready: m.ready, note: SVC.noteLabel(m), arch: SVC.archLabel(m),
      sr: m.sr || 0, lang: m.lang || '', work: m.work || '',
    }));
  }

  /* ---------------- IPC ---------------- */

  ipcMain.handle('cover:env', async () => {
    return { ok: true, dataRoot: Paths.dataRoot(), modelsRoot: Paths.modelsDir(),
      svcRoot: SVC.svcRoot(), singers: svcSingers().length };
  });

  ipcMain.handle('cover:singers', async () => {
    try { return { ok: true, svc: svcSingers() }; }
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
    if (!singer.id) return { ok: false, error: '请选择一个导入的翻唱模型' };
    if (!o.outdir) return { ok: false, error: '请选择输出目录' };
    try { fs.mkdirSync(o.outdir, { recursive: true }); }
    catch (e) { return { ok: false, error: '输出目录不可写：' + (e && e.message) }; }

    const win = BrowserWindow.fromWebContents(evt.sender);
    const id = 'cover' + (++seq);
    // ★ 子命令必须在前：engine_cover.py 是 `{analyze,convert,mix,all}` 子命令式 CLI，
    //   少了这个 all，argparse 会把音频路径当成子命令名直接报错
    const args = ['all', o.audio, '--outdir', o.outdir, '--svc-model', String(singer.id)];
    if (o.name) args.push('--name', String(o.name));
    // ---- SVC 参数（常用 + 高级，全部走引擎，界面不自己实现任何 DSP）
    const num = (v, d) => (v == null || v === '' ? d : Number(v));
    args.push('--transpose', String(num(o.transpose, 0)));
    if (o.f0Method) args.push('--f0-method', String(o.f0Method));
    args.push('--index-rate', String(num(o.indexRate, 0.3)));
    args.push('--filter-radius', String(num(o.filterRadius, 3)));
    args.push('--rms-mix-rate', String(num(o.rmsMixRate, 0.25)));
    args.push('--protect', String(num(o.protect, 0.33)));
    args.push('--chunk-sec', String(num(o.chunkSec, 60)));
    if (o.autoPredictF0) args.push('--auto-predict-f0');
    args.push('--device', o.device || 'auto');
    if (o.clarityDb != null) args.push('--clarity-db', String(o.clarityDb));
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
    const env = engineEnv({});
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

  return { svcSingers };
}

module.exports = { registerCoverIpc };
