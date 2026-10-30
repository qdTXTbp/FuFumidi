// ============================================================
// 主进程视频服务：编码流落盘 + ffmpeg 封装 MP4
//
// 渲染进程把编码后的视频流**边产边写**到临时文件（video:exportBegin/Write/Abort/End），
// 主进程只负责落盘与封装。这样长片不再把整段视频堆在内存里（10 分钟 4K 约 1.2 GB），
// 也让「导出时长」不再需要人为设上限。
//
// 编码由渲染进程的 WebCodecs VideoEncoder 完成（优先硬件 —— 本机 4K 走 NVENC，每帧约 1 ms
// 提交耗时）；因此这里视频是 **stream copy**，不再用 libx264 重编码一遍 ——
// 旧链路「录 VP9 → 解码 → x264 重编码」是整机满载的主要来源之一。
// ============================================================
'use strict';
const Paths = require('./paths');

function registerVideoIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline, parsePyJson }) {
  /** 导出视频的默认文件名 —— **用歌曲名**（渲染进程把曲名一起传过来）。
   *
   *  主进程必须自己再洗一遍：曲名里可能有 Windows 非法字符（反斜杠、斜杠、冒号、星号、问号、
   *  引号、尖括号、竖线）与控制字符，直接拼进 defaultPath 会让保存对话框拿到非法路径
   *  （实测表现为对话框弹不出来或路径被截断）。规则与 main/library.js 的 safeBase 一致：
   *  去扩展名 → 非法字符换 _ → 去首尾的点与空格 → 超长截断。
   *  另外挡掉 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）—— 这类名字建不出文件。
   *  曲名为空时退回原来的 FuFumidi-video。 */
  function safeVideoBase(name) {
    let base = String(name || '').replace(/\.(mid|midi|kar|rmi)$/i, '');
    base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
    if (!base) return 'FuFumidi-video';
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) base = '_' + base;
    return base.length > 100 ? base.slice(0, 100) : base;
  }

  // ---- 导出流：渲染进程边编码边写，主进程只落盘 ----
  // id → { path, fd, bytes, container }。异常退出留下的孤儿流由下次 begin 清理。
  const STREAMS = new Map();
  function tmpDirOf() {
    const d = path.join(Paths.tempDir(), 'fufumidi-video');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
  function dropStream(id, removeFile) {
    const st = STREAMS.get(id);
    if (!st) return;
    try { fs.closeSync(st.fd); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    if (removeFile) { try { fs.unlinkSync(st.path); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
    STREAMS.delete(id);
  }
  /** 清掉临时目录里的陈旧产物。
   *  崩溃、强杀、导出中途刷新页面都不会走到 abort，半成品会留在盘上；
   *  历史上 video:transcode 的 .webm/.wav 也会落在这个目录（实测见 122 MB 残留）。
   *  按修改时间扫一遍即可 —— 正在导出的文件一直在写，mtime 是新的，不会被误删。 */
  function sweepStale(maxAgeMs) {
    try {
      const dir = tmpDirOf();
      const now = Date.now();
      for (const name of fs.readdirSync(dir)) {
        const p = path.join(dir, name);
        try { if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      }
    } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
  }

  ipcMain.handle('video:exportBegin', async (_e, opts) => {
    try {
      sweepStale(6 * 3600 * 1000);   // 6 小时前的残留一律清掉
      // 只保留最近 4 条：异常退出留下的孤儿流不该无限堆积占临时空间
      const ids = [...STREAMS.keys()];
      while (ids.length > 3) dropStream(ids.shift(), true);
      const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const container = (opts && opts.container === 'webm') ? 'webm' : 'h264';
      const p = path.join(tmpDirOf(), id + '.' + (container === 'webm' ? 'webm' : 'h264'));
      const fd = fs.openSync(p, 'w');
      STREAMS.set(id, { path: p, fd, bytes: 0, container });
      return { ok: true, id, container, path: p };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('video:exportWrite', async (_e, opts) => {
    const st = STREAMS.get(opts && opts.id);
    if (!st) return { ok: false, error: 'stream-not-found' };
    try {
      const buf = Buffer.from(opts.data);
      // 同步追加：调用方 await 本方法即形成背压，编码快于写盘时不会把内存顶爆
      fs.writeSync(st.fd, buf, 0, buf.length);
      st.bytes += buf.length;
      return { ok: true, bytes: st.bytes };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('video:exportAbort', async (_e, opts) => {
    dropStream(opts && opts.id, true);
    return { ok: true };
  });

  ipcMain.handle('video:exportEnd', async (evt, opts) => {
    const st = STREAMS.get(opts && opts.id);
    if (!st) return { ok: false, error: 'stream-not-found' };
    try { fs.closeSync(st.fd); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    st.fd = null;
    const cleanup = () => { dropStream(opts.id, true); };
    if (!st.bytes) { cleanup(); return { ok: false, error: 'empty-stream' }; }
    try {
      // targetPath 仅供自动化冒烟使用（跳过保存对话框）；界面一律不传。
      let out = opts.targetPath ? String(opts.targetPath) : '';
      if (!out) {
        const win = BrowserWindow.fromWebContents(evt.sender);
        const save = await dialog.showSaveDialog(win || undefined, {
          title: '导出视频 MP4',
          // ★ 默认文件名 = 歌曲名（opts.name 由渲染进程带上），例如「饿狼传说-张学友.mp4」
          defaultPath: path.join(app.getPath('downloads'), safeVideoBase(opts.name) + '.mp4'),
          filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
        });
        if (save.canceled || !save.filePath) { cleanup(); return { ok: false, canceled: true }; }
        out = save.filePath;
      }
      let wav = null;
      if (opts.audio && Buffer.from(opts.audio).length) {
        wav = path.join(tmpDirOf(), Date.now() + '.wav');
        fs.writeFileSync(wav, Buffer.from(opts.audio));
      }
      const fps = Math.max(1, Math.min(240, Number(opts.fps) || 24));
      const args = ['-y', '-hide_banner', '-loglevel', 'error'];
      if (st.container === 'h264') {
        // 裸 H.264（Annex B）：渲染进程逐帧编码，时间戳严格等距。
        // ★ -r 必须放在 -i **之前**（输入侧），并且和 -framerate 一起给：
        //   Chrome 的 H.264 编码器会在 SPS 的 VUI 里写一个离谱的帧率（实测裸流被 ffprobe 读成
        //   r_frame_rate=1200000/1），ffmpeg 拿这个探测值当包时长，几十帧之后时长就塌成 1 个 tick ——
        //   实测 149 秒的 4K60 成片被封装成 **0.84 秒**：帧数是对的、时间戳全错，
        //   播放器表现就是「一秒放完 / 卡死」。输入侧显式 -r 覆盖探测值后，
        //   同一段裸流 duration 从 0.834 s 恢复成 5.000 s。
        args.push('-r', String(fps), '-f', 'h264', '-framerate', String(fps));
      }
      args.push('-i', st.path);
      if (wav) {
        // 自定义导出范围时，音频从 startSec 偏移（-ss 置于 -i 前为输入 seek），
        // 与画面 tick = startSec+el 对齐，避免音乐从头播、画面从中段开始导致的曲速错位
        const off = opts && opts.audioOffset ? Math.max(0, Number(opts.audioOffset)) : 0;
        if (off > 0) args.push('-ss', String(off));
        args.push('-i', wav, '-map', '0:v:0', '-map', '1:a:0');
      }
      // ★ -c:v copy：视频已是 H.264（硬件编码产物），这里只封装 + 编音频，不再重编码一遍。
      //   旧链路是「VP9 录屏 → 解码 → libx264 重编码」，4K 下这一段是纯 CPU 满载。
      args.push('-c:v', 'copy', '-pix_fmt', 'yuv420p');
      if (wav) args.push('-c:a', 'aac');
      // ★ 用 -t 按精确时长收尾，**不要用 -shortest**：裸 H.264 输入的包没有时间戳，
      //   ffmpeg 判定视频长度是 0，-shortest 会把整条音轨当成「比视频长」而全部丢掉
      //   （实测输出只剩一条视频流）。渲染进程知道确切时长（帧数 / 帧率），直接给它。
      const dur = Number(opts.duration);
      if (isFinite(dur) && dur > 0) args.push('-t', dur.toFixed(6));
      else args.push('-shortest');
      args.push('-movflags', '+faststart', out);
      const code =
        'import json, subprocess\n' +
        'import imageio_ffmpeg\n' +
        'ff = imageio_ffmpeg.get_ffmpeg_exe()\n' +
        'r = subprocess.run([ff] + ' + JSON.stringify(args) +
        ', capture_output=True)\n' +
        "print(json.dumps({'ok': r.returncode == 0, 'err': (r.stderr or b'').decode('utf-8', 'replace')[-300:]}))";
      const rr = await runEngineInline(code);
      const d = parsePyJson(rr.out);
      try { fs.unlinkSync(st.path); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      if (wav) { try { fs.unlinkSync(wav); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
      STREAMS.delete(opts.id);
      if (d && d.ok) return { ok: true, path: out, bytes: st.bytes, copy: true };
      return { ok: false, error: (d && d.err) || (rr.out || 'ffmpeg failed').slice(-300) };
    } catch (e) { cleanup(); return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 旧通道：整段 WebM + WAV 一次性送进来（保留兼容；界面已改走流式导出）
  ipcMain.handle('video:transcode', async (evt, opts) => {
    try {
      if (!opts || !opts.data) return { ok: false, error: 'empty' };
      const win = BrowserWindow.fromWebContents(evt.sender);
      const save = await dialog.showSaveDialog(win || undefined, {
        title: '导出视频 MP4',
        defaultPath: path.join(app.getPath('downloads'), safeVideoBase(opts.name) + '.mp4'),
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      });
      if (save.canceled || !save.filePath) return { ok: false, canceled: true };
      const tmpDir = tmpDirOf();
      const webm = path.join(tmpDir, Date.now() + '.webm');
      fs.writeFileSync(webm, Buffer.from(opts.data));
      let wav = null;
      if (opts.audio && Buffer.from(opts.audio).length) {
        wav = path.join(tmpDir, Date.now() + '.wav');
        fs.writeFileSync(wav, Buffer.from(opts.audio));
      }
      const out = save.filePath;
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', webm];
      if (wav) {
        const off = opts && opts.audioOffset ? Math.max(0, Number(opts.audioOffset)) : 0;
        if (off > 0) args.push('-ss', String(off));
        args.push('-i', wav, '-map', '0:v:0', '-map', '1:a:0');
      }
      args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', out);
      const code =
        'import json, subprocess\n' +
        'import imageio_ffmpeg\n' +
        'ff = imageio_ffmpeg.get_ffmpeg_exe()\n' +
        'r = subprocess.run([ff] + ' + JSON.stringify(args) +
        ', capture_output=True)\n' +
        "print(json.dumps({'ok': r.returncode == 0, 'err': (r.stderr or b'').decode('utf-8', 'replace')[-300:]}))";
      const rr = await runEngineInline(code);
      try { fs.unlinkSync(webm); if (wav) fs.unlinkSync(wav); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      const d = parsePyJson(rr.out);
      if (d && d.ok) return { ok: true, path: out };
      return { ok: false, error: (d && d.err) || (rr.out || 'ffmpeg failed').slice(-300) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerVideoIpc };
