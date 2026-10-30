// ============================================================
// 主进程文件/对话框服务：原生选择器、目录扫描与二进制读写
// ============================================================
'use strict';

function registerDialogsIpc({ ipcMain, dialog, path, fs, app, spawnEngine }) {
  // 原生对话框
  ipcMain.handle('dialog:pickAudio', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '音频 / 视频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'webm'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  // 批量转录：一次选择多个音频 / 视频
  ipcMain.handle('dialog:pickAudioFiles', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音频 / 视频', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'mp4', 'mkv', 'avi', 'mov', 'webm'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  // 批量转录：递归列出文件夹内音频/视频（上限 2000 / 8 层）
  ipcMain.handle('dir:listAudioFiles', async (_e, dir) => {
    try {
      if (!dir || !fs.existsSync(dir)) return [];
      const exts = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wma', '.mp4', '.mkv', '.avi', '.mov', '.webm', '.aiff', '.aif', '.au', '.snd', '.caf', '.m4v', '.m4s', '.ts', '.mpg', '.mpeg', '.flv', '.3gp', '.amr', '.mka']);
      const out = [];
      const walk = (d, depth) => {
        if (out.length >= 2000 || depth > 8) return;
        let items;
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
          if (out.length >= 2000) return;
          try {
            if (it.isDirectory()) walk(path.join(d, it.name), depth + 1);
            else if (it.isFile() && exts.has(path.extname(it.name).toLowerCase())) out.push(path.join(d, it.name));
          } catch {}
        }
      };
      walk(dir, 0);
      out.sort((a, b) => a.localeCompare(b, 'zh'));
      return out;
    } catch (e) { return []; }
  });
  ipcMain.handle('dialog:pickImage', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickFile', async (_e, opts) => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: (opts && opts.filters) || [{ name: '文件', extensions: ['*'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:pickDirectory', async () => {
    const r = await dialog.showOpenDialog({ properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  // 模型本地压缩包导入（.zip / .7z / .tar）
  ipcMain.handle('dialog:pickModelArchive', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: '模型压缩包', extensions: ['zip', '7z', 'tar', 'gz', 'tgz', 'tar.gz', 'txz', '001', '002', '003', 'z01', 'z02'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  // 内置 SoundFont 列表（随应用分发，用户直接选择，无需加载外部文件）
  ipcMain.handle('soundfont:list', async () => {
    try {
      const dir = path.join(__dirname, '..', 'renderer', 'vendor', 'soundfonts');
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir)
        .filter(f => /\.(sf2|sf3)$/i.test(f))
        .map(f => ({ id: f, name: f.replace(/\.[^.]+$/, ''), path: path.join(dir, f) }));
    } catch (e) { return []; }
  });
  // MusicXML 导入
  ipcMain.handle('dialog:pickMusicXML', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'MusicXML', extensions: ['xml', 'musicxml', 'mxl'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // 歌单“导入文件夹”：递归列出目录下的 MIDI 文件（上限 2000 / 8 层，避免误选整盘卡死）
  ipcMain.handle('dir:listMidiFiles', async (_e, dir) => {
    try {
      if (!dir || !fs.existsSync(dir)) return [];
      const exts = new Set(['.mid', '.midi', '.kar', '.rmi']);
      const out = [];
      const walk = (d, depth) => {
        if (out.length >= 2000 || depth > 8) return;
        let items;
        try { items = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        for (const it of items) {
          if (out.length >= 2000) return;
          try {
            if (it.isDirectory()) walk(path.join(d, it.name), depth + 1);
            else if (it.isFile() && exts.has(path.extname(it.name).toLowerCase())) out.push(path.join(d, it.name));
          } catch {}
        }
      };
      walk(dir, 0);
      out.sort((a, b) => a.localeCompare(b, 'zh'));
      return out;
    } catch (e) { return []; }
  });
  // 读取本地文件（转录结果回载）——异步 + 大小上限，避免阻塞主进程
  ipcMain.handle('file:readBinary', async (_e, p) => {
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile() || st.size > 64 * 1024 * 1024) return null;
      const buf = await fs.promises.readFile(p);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch { return null; }
  });
  // 读取 SoundFont（SF2/SF3 通常数十 MB 到数百 MB，单独放宽上限）
  // ★ SF3 支持：js-synthesizer 的 fluidsynth wasm 里 fluid_stat/fluid_file_test 是桩，
  //   sf3 的 Ogg 采样解不出来（装载成功但永远无声）。读取前先用引擎侧 sf3tool.py
  //   把 sf3 解码转成标准 sf2（缓存同名 .conv.sf2，源文件更新自动重转），见 engine/sf3tool.py。
  const _sf3Converting = new Map();   // cachePath -> Promise（防并发重复转换）
  async function _ensureSf2Converted(sf3Path, sf3Stat) {
    const cachePath = sf3Path.replace(/\.sf3$/i, '') + '.conv.sf2';
    let fresh = false;
    try {
      const cst = await fs.promises.stat(cachePath);
      fresh = cst.mtimeMs >= sf3Stat.mtimeMs;
    } catch (e) { fresh = false; }
    if (fresh) return cachePath;
    let task = _sf3Converting.get(cachePath);
    if (!task) {
      task = new Promise((resolve) => {
        try {
          spawnEngine(['convert', '--in', sf3Path, '--out', cachePath], {
            script: 'sf3tool.py',
            timeoutMs: 300000,
            onDone: (code, r) => {
              if (r && r.result && r.result.ok) {
                console.log('[soundfont] sf3 → sf2 转换完成：', cachePath,
                  JSON.stringify(r.result));
                resolve(cachePath);
              } else {
                console.warn('[soundfont] sf3 转换失败：', (r && r.result && r.result.error) || (r && r.err) || ('exit ' + code));
                resolve(null);
              }
            },
            onError: (e) => { console.warn('[soundfont] sf3 转换器启动失败：', String(e)); resolve(null); },
          });
        } catch (e) { resolve(null); }
      });
      _sf3Converting.set(cachePath, task);
      task.finally(() => _sf3Converting.delete(cachePath));
    }
    return task;
  }
  ipcMain.handle('file:readSoundFont', async (_e, p) => {
    try {
      const st = await fs.promises.stat(p);
      if (!st.isFile() || st.size > 512 * 1024 * 1024) return null;
      let target = p;
      if (/\.sf3$/i.test(p)) {
        target = await _ensureSf2Converted(p, st);
        if (!target) return null;   // 转换失败 → 前端按「读取失败」回退内置音色
      }
      const buf = await fs.promises.readFile(target);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    } catch { return null; }
  });

  // 保存二进制（WAV / MIDI 导出）：原生保存对话框 → fs 写盘。
  // 绕开 Electron 33 失效的下载子系统：<a download> 经 will-download 的
  // preventDefault+setSavePath+resume 后下载会被 0 字节取消（blob/data/http 均如此）。
  ipcMain.handle('file:writeBinary', async (_e, target, data) => {
    try { await fs.promises.writeFile(target, Buffer.from(data)); return { ok: true }; }
    catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  });
  ipcMain.handle('file:saveBinary', async (_e, opts) => {
    try {
      const name = (opts && opts.name) || 'download.bin';
      const ext = path.extname(name).toLowerCase() || '';
      const filters = ext === '.wav'
        ? [{ name: 'WAV 音频', extensions: ['wav'] }]
        : ext === '.mid' || ext === '.midi'
          ? [{ name: 'MIDI 音频', extensions: ['mid', 'midi'] }]
          : [{ name: '文件', extensions: ['*'] }];
      const r = await dialog.showSaveDialog({
        title: '保存文件',
        defaultPath: path.join(app.getPath('downloads'), name),
        filters,
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      const buf = (opts && opts.data != null) ? Buffer.from(opts.data) : Buffer.alloc(0);
      await fs.promises.writeFile(r.filePath, buf);
      return { ok: true, path: r.filePath };
    } catch (e) { return { ok: false, canceled: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerDialogsIpc };
