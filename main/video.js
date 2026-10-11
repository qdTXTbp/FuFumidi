// ============================================================
// 主进程视频服务：WebM/WAV 离线合成 MP4
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

  // 视频导出：接收渲染器录制的 WebM（可视化 + 可选离线渲染的 WAV 音频）→ 内置 ffmpeg 合成 MP4
  ipcMain.handle('video:transcode', async (evt, opts) => {
    try {
      if (!opts || !opts.data) return { ok: false, error: 'empty' };
      const win = BrowserWindow.fromWebContents(evt.sender);
      const save = await dialog.showSaveDialog({
        title: '导出视频 MP4',
        // ★ 默认文件名 = 歌曲名（opts.name 由渲染进程带上），例如「饿狼传说-张学友.mp4」
        defaultPath: path.join(app.getPath('downloads'), safeVideoBase(opts.name) + '.mp4'),
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      });
      if (save.canceled || !save.filePath) return { ok: false, canceled: true };
      const tmpDir = path.join(Paths.tempDir(), 'fufumidi-video');
      fs.mkdirSync(tmpDir, { recursive: true });
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
        // 自定义导出范围时，音频从 startSec 偏移（-ss 置于 -i 前为输入 seek），
        // 与画面 tick = startSec+el 对齐，避免音乐从头播、画面从中段开始导致的曲速错位
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
      try { fs.unlinkSync(webm); if (wav) fs.unlinkSync(wav); } catch (e) {}
      const d = parsePyJson(rr.out);
      if (d && d.ok) return { ok: true, path: out };
      return { ok: false, error: (d && d.err) || (rr.out || 'ffmpeg failed').slice(-300) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerVideoIpc };
