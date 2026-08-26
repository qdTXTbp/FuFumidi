// ============================================================
// 主进程视频服务：WebM/WAV 离线合成 MP4
// ============================================================
'use strict';

function registerVideoIpc({ ipcMain, dialog, BrowserWindow, app, path, fs, runEngineInline, parsePyJson }) {
  // 视频导出：接收渲染器录制的 WebM（可视化 + 可选离线渲染的 WAV 音频）→ 内置 ffmpeg 合成 MP4
  ipcMain.handle('video:transcode', async (evt, opts) => {
    try {
      if (!opts || !opts.data) return { ok: false, error: 'empty' };
      const win = BrowserWindow.fromWebContents(evt.sender);
      const save = await dialog.showSaveDialog({
        title: '导出视频 MP4',
        defaultPath: path.join(app.getPath('downloads'), 'FuFumidi-video.mp4'),
        filters: [{ name: 'MP4 视频', extensions: ['mp4'] }],
      });
      if (save.canceled || !save.filePath) return { ok: false, canceled: true };
      const tmpDir = path.join(app.getPath('temp'), 'fufumidi-video');
      fs.mkdirSync(tmpDir, { recursive: true });
      const webm = path.join(tmpDir, Date.now() + '.webm');
      fs.writeFileSync(webm, Buffer.from(opts.data));
      let wav = null;
      if (opts.audio && opts.audio.byteLength) {
        wav = path.join(tmpDir, Date.now() + '.wav');
        fs.writeFileSync(wav, Buffer.from(opts.audio));
      }
      const out = save.filePath;
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', webm];
      if (wav) args.push('-i', wav, '-map', '0:v:0', '-map', '1:a:0');
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
