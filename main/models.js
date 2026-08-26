// ============================================================
// 主进程模型服务：模型注册表、下载/暂停/取消、目录监听
// ============================================================
'use strict';

function registerModelsIpc({ ipcMain, BrowserWindow, app, path, fs, net, modelsDir, demucsModelFile, sha256File }) {
  const _folderWatchers = new Map();

  // 内置模型注册表：本地模型清单 + 缺失模型官方源一键下载（带进度/取消）
  const MODEL_REGISTRY = {
    piano_transcription: {
      id: 'piano_transcription',
      name: '钢琴转录模型',
      note: 'piano-transcription CRNN（含踏板检测）· 约 166 MB',
      dest: path.join('piano_transcription', 'note_F1=0.9677_pedal_F1=0.9186.pth'),
      url: 'https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1',
      minSize: 1.6e8,
      downloadable: true,
    },
  };
  const _modelCancels = new Set();
  const _modelAborts = new Map();
  const _modelPause = new Set();

  ipcMain.handle('model:list', async () => {
    const dir = modelsDir();
    const items = [];
    const push = (name, p, note, extra) => {
      try {
        const st = fs.statSync(p);
        items.push(Object.assign({ name, path: p, size: st.size, exists: true, note: note || '' }, extra || {}));
      } catch (e) { items.push(Object.assign({ name, path: p, size: 0, exists: false, note: note || '' }, extra || {})); }
    };
    push('通用转录（int8 量化）', path.join(dir, 'basic_pitch_quant.onnx'), 'basic-pitch ONNX int8 量化模型（CPU 加速）');
    const pt = MODEL_REGISTRY.piano_transcription;
    push(pt.name, path.join(dir, pt.dest), pt.note, { id: pt.id, downloadable: true });
    const dm = demucsModelFile();
    items.push({ id: 'demucs_htdemucs', name: '人声分离模型', path: dm || '', size: dm ? (() => { try { return fs.statSync(dm).size; } catch (e) { return 0; } })() : 0, exists: !!dm, downloadable: !dm, note: dm ? 'demucs htdemucs 已内置（约 80 MB）' : 'demucs htdemucs（未安装，可一键下载，国内自动走镜像）' });
    return items;
  });
  ipcMain.handle('model:cancel', async (_e, id) => {
    if (id) { _modelCancels.add(id); try { const c = _modelAborts.get(id); if (c) c.abort(); } catch (e) {} }
    return { ok: true };
  });
  ipcMain.handle('model:delete', async (_e, id) => {
    try {
      let p = null;
      if (id === 'demucs_htdemucs') p = demucsModelFile();
      else if (MODEL_REGISTRY[id]) p = path.join(modelsDir(), MODEL_REGISTRY[id].dest);
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'not found' };
      fs.unlinkSync(p);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('folder:setWatch', (_e, dir, enabled) => {
    try {
      const win = BrowserWindow.fromWebContents(_e.sender);
      const key = win ? win.id : 0;
      if (_folderWatchers.has(key)) { try { _folderWatchers.get(key).close(); } catch (e) {} _folderWatchers.delete(key); }
      if (!enabled || !dir || !fs.existsSync(dir)) return { ok: true };
      const exts = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.mp4', '.mkv', '.avi', '.mov', '.webm']);
      let timer = null;
      const w = fs.watch(dir, { persistent: false }, (_ev, filename) => {
        if (!filename) return;
        const full = path.join(dir, filename.toString());
        if (exts.has(path.extname(full).toLowerCase())) {
          clearTimeout(timer);
          timer = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('folder-watch:file', full); }, 300);
        }
      });
      _folderWatchers.set(key, w);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('model:pause', async (_e, id) => {
    if (id) { _modelPause.add(id); try { const c = _modelAborts.get(id); if (c) c.abort(); } catch (e) {} }
    return { ok: true };
  });
  ipcMain.handle('model:download', async (evt, id) => {
    const spec = MODEL_REGISTRY[id];
    if (!spec || !spec.url) return { ok: false, error: 'unknown model: ' + id };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const dest = path.join(modelsDir(), spec.dest);
    if (fs.existsSync(dest) && fs.statSync(dest).size >= spec.minSize) {
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: fs.statSync(dest).size, total: fs.statSync(dest).size, percent: 100, done: true });
      return { ok: true, path: dest, size: fs.statSync(dest).size, existed: true };
    }
    _modelCancels.delete(id);
    _modelPause.delete(id);
    const tmp = dest + '.part';
    const ctrl = new AbortController();
    _modelAborts.set(id, ctrl);
    const timeout = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 120000);
    let out = null, start = 0, keepPart = false;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(tmp)) start = fs.statSync(tmp).size;
      const headers = { 'user-agent': 'FuFumidi/2.0.0' };
      if (start > 0) headers['Range'] = 'bytes=' + start + '-';
      const urls = [spec.url, 'https://ghfast.top/' + spec.url, 'https://gh-proxy.com/' + spec.url, 'https://ghproxy.net/' + spec.url];
      let res = null;
      for (const u of urls) {
        try {
          res = await net.fetch(u, { headers, signal: ctrl.signal });
          if (res.ok && res.body) break; else res = null;
        } catch (e) { res = null; }
      }
      if (!res) throw new Error('所有下载源均失败');
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = (parseInt(res.headers.get('content-length') || '0', 10) || 0) + start;
      out = fs.createWriteStream(tmp, { flags: start > 0 ? 'a' : 'w' });
      const reader = res.body.getReader();
      let received = start, lastSend = 0;
      const sendP = (done) => {
        const now = Date.now();
        if (!done && now - lastSend < 300) return;
        lastSend = now;
        const pct = total ? Math.min(99, Math.round(received / total * 100)) : 0;
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received, total, percent: pct, done: !!done });
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (_modelPause.has(id)) { try { reader.cancel(); } catch (e) {} throw new Error('paused'); }
        if (_modelCancels.has(id)) { try { reader.cancel(); } catch (e) {} throw new Error('canceled'); }
        received += value.length;
        sendP(false);
        await new Promise((res2, rej2) => out.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
      }
      await new Promise((res2, rej2) => out.end(err => (err ? rej2(err) : res2())));
      sendP(true);
      if (_modelPause.has(id)) throw new Error('paused');
      if (_modelCancels.has(id)) throw new Error('canceled');
      fs.renameSync(tmp, dest);
      const size = fs.statSync(dest).size;
      if (size < spec.minSize) throw new Error('下载文件不完整：' + size + ' bytes');
      if (spec.sha256) {
        const hash = await sha256File(dest);
        if (hash !== spec.sha256) { try { fs.unlinkSync(dest); } catch (e) {} throw new Error('SHA256 校验失败：' + hash); }
      }
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: size, total: size, percent: 100, done: true });
      return { ok: true, path: dest, size };
    } catch (e) {
      if (out) { try { out.destroy(); } catch (_) {} }
      await new Promise(r => setTimeout(r, 150));
      const msg = String((e && e.message) || e);
      const paused = _modelPause.has(id);
      keepPart = paused;
      if (!paused && !_modelCancels.has(id)) { try { fs.unlinkSync(tmp); } catch (_) {} }
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, error: msg, canceled: _modelCancels.has(id), paused });
      return { ok: false, error: msg, canceled: _modelCancels.has(id), paused };
    } finally {
      clearTimeout(timeout);
      _modelCancels.delete(id);
      _modelAborts.delete(id);
      _modelPause.delete(id);
      try { if (!keepPart && fs.existsSync(tmp) && !fs.existsSync(dest)) fs.unlinkSync(tmp); } catch (_) {}
    }
  });

  function closeAll() {
    for (const w of _folderWatchers.values()) { try { w.close(); } catch {} }
    _folderWatchers.clear();
  }

  return { closeAll };
}

module.exports = { registerModelsIpc };
