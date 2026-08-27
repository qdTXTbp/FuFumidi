// ============================================================
// 主进程 GPU 增强包 IPC：状态、安装、卸载、下载与自动检测
// ============================================================
'use strict';

function registerGpuIpc({
  ipcMain,
  dialog,
  BrowserWindow,
  app,
  path,
  fs,
  net,
  spawn,
  stopEngineWorker,
  resetBaseToCpu,
  installedGpuKinds,
  gpuEnhanceDir,
  gpuEnhanceSite,
  inferGpuKind,
  writeGpuManifest,
  installGpuSite,
  isSplitPackagePath,
  combineSplitParts,
  engineDir,
  engineEnv,
  resolvePython,
  runEngineInline,
  parsePyJson,
}) {
  ipcMain.handle('gpu:status', async () => {
    try {
      const dirs = installedGpuKinds();
      return { ok: true, directml: dirs.indexOf('directml') >= 0, cuda: dirs.indexOf('cuda') >= 0, isolated: true, paths: dirs };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('gpu:uninstall', async (_e, kind) => {
    const k = String(kind || '').toLowerCase();
    if (k !== 'cuda' && k !== 'directml') return { ok: false, error: '未知的增强包类型' };
    const dir = gpuEnhanceDir(k);
    const existed = fs.existsSync(dir);
    await stopEngineWorker();
    if (existed) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    const restored = await resetBaseToCpu();
    return { ok: true, removed: existed, restored };
  });

  ipcMain.handle('gpu:listPackages', async () => {
    try {
      const r = await fetch('https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=10', { headers: { 'User-Agent': 'FuFumidi-Update' } });
      const data = await r.json();
      const out = [];
      for (const rel of data) {
        const assets = rel.assets || [];
        for (const a of assets) {
          if (a.name && /^fufumidi-gpu-directml\.zip$/i.test(a.name)) {
            out.push({ tag: rel.tag_name, name: a.name, url: a.browser_download_url, size: a.size, kind: 'directml' });
          }
          if (a.name && /^fufumidi-gpu-cuda\.zip$/i.test(a.name)) {
            out.push({ tag: rel.tag_name, name: a.name, url: a.browser_download_url, size: a.size, kind: 'cuda' });
          }
        }
        const cudaParts = assets.filter(a => a.name && /^fufumidi-gpu-cuda(?:-parts)?\.(zip\.\d{3}|part\d+)$/i.test(a.name));
        if (cudaParts.length) {
          cudaParts.sort((a, b) => {
            const ma = String(a.name).match(/(\d+)\s*$/), mb = String(b.name).match(/(\d+)\s*$/);
            return (ma ? parseInt(ma[1],10) : 0) - (mb ? parseInt(mb[1],10) : 0);
          });
          out.push({
            tag: rel.tag_name,
            name: 'fufumidi-gpu-cuda-parts (split)',
            kind: 'cuda',
            split: true,
            size: cudaParts.reduce((sum, a) => sum + (a.size || 0), 0),
            url: cudaParts[0].browser_download_url,
            files: cudaParts.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size }))
          });
        }
      }
      return { ok: true, packages: out };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('dialog:pickZip', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const r = await dialog.showOpenDialog(win, { title: '选择 GPU 增强包', filters: [{ name: 'GPU 增强包', extensions: ['zip', '001', '002', '003', 'part1', 'part2', 'part3', 'part4', 'part5'] }], properties: ['openFile', 'multiSelections'] });
    if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
    return r.filePaths;
  });

  ipcMain.handle('gpu:importLocal', async (evt, localPath, kind) => {
    const localPaths = Array.isArray(localPath) ? localPath : [localPath];
    if (!localPaths.length || localPaths.some(p => !p || !fs.existsSync(p))) return { ok: false, error: '本地文件不存在' };
    try {
      const first = localPaths[0];
      const detected = inferGpuKind(first);
      const k = String(detected || kind || '').toLowerCase();
      if (k !== 'cuda' && k !== 'directml') return { ok: false, error: '无法识别增强包类型，请先选择 DirectML 或 CUDA 包/分卷' };
      const zipTmp = path.join(app.getPath('temp'), 'fufumidi-gpu-import.zip');
      if (localPaths.length > 1 || isSplitPackagePath(first)) {
        await combineSplitParts(localPaths, zipTmp);
      } else {
        fs.copyFileSync(first, zipTmp);
      }
      const extractDir = path.join(app.getPath('temp'), 'fufumidi-gpu-import');
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      const psCmd = 'Expand-Archive -Path "' + zipTmp + '" -DestinationPath "' + extractDir + '" -Force';
      const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', psCmd], { windowsHide: true });
      await new Promise((res, rej) => { ps.on('close', c => c === 0 ? res() : rej(new Error('解压失败'))); ps.on('error', rej); });
      const spSrc = path.join(extractDir, 'site-packages');
      if (!fs.existsSync(spSrc)) return { ok: false, error: '压缩包内缺少 site-packages 目录' };
      await stopEngineWorker();
      installGpuSite(k, spSrc, { name: path.basename(first), source: 'local' });
      try { fs.unlinkSync(zipTmp); } catch {}
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
      return { ok: true, kind: k, split: localPaths.length > 1 || isSplitPackagePath(first) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('gpu:packageUrl', async (_e, kind) => {
    try {
      const suffix = kind === 'cuda' ? 'cuda' : 'directml';
      const r = await fetch('https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest', { headers: { 'User-Agent': 'FuFumidi-Update' } });
      const rel = await r.json();
      const assets = (rel.assets || []).filter(a => a.name && a.name.toLowerCase().includes('gpu-' + suffix) && a.name.toLowerCase().endsWith('.zip'));
      if (!assets.length) return { ok: false, error: '未找到 GPU 增强包资产：fufumidi-gpu-' + suffix + '.zip' };
      const a = assets[0];
      return { ok: true, url: a.browser_download_url, name: a.name, size: a.size };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('gpu:downloadPackage', async (evt, opts) => {
    if (!opts || (!opts.url && !(opts.files && opts.files.length))) return { ok: false, error: 'empty url' };
    const kind = String(opts.kind || inferGpuKind(opts.name || (opts.files && opts.files[0] && (opts.files[0].name || opts.files[0].url)) || opts.url) || '').toLowerCase();
    if (kind !== 'cuda' && kind !== 'directml') return { ok: false, error: '无法识别增强包类型' };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const dlDir = path.join(app.getPath('temp'), 'fufumidi-gpu-dl');
    const extractDir = path.join(app.getPath('temp'), 'fufumidi-gpu-extract');
    const zipTmp = path.join(app.getPath('temp'), 'fufumidi-gpu-dl.zip');
    fs.rmSync(dlDir, { recursive: true, force: true });
    fs.mkdirSync(dlDir, { recursive: true });
    let lastErr = null;
    try {
      const files = (Array.isArray(opts.files) && opts.files.length) ? opts.files : [{ name: opts.name || '', url: opts.url, size: opts.size || 0 }];
      const isSplit = files.length > 1 || /.part\d+$|\.zip\.\d{3}$/i.test(files[0].name || '');
      const totalAll = files.reduce((sum, f) => sum + (f.size || 0), 0);
      let receivedAll = 0;
      const paths = [];
      for (const f of files) {
        if (!f || !f.url) throw new Error('missing file url');
        const name = f.name || decodeURIComponent((new URL(f.url).pathname.split('/').pop() || 'part'));
        const outPath = path.join(dlDir, name);
        const mirrors = [f.url, 'https://ghfast.top/' + f.url, 'https://ghproxy.net/' + f.url, 'https://gh-proxy.com/' + f.url];
        let okDl = false;
        for (const u of mirrors) {
          try {
            const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/2.1.0' } });
            if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
            const out = fs.createWriteStream(outPath);
            const reader = res.body.getReader();
            let received = 0, lastSend = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              received += value.length; receivedAll += value.length;
              const now = Date.now();
              if (now - lastSend > 300) {
                lastSend = now;
                if (win && !win.isDestroyed()) win.webContents.send('gpu:progress', { received: receivedAll, total: totalAll, percent: totalAll ? Math.min(99, Math.round(receivedAll/totalAll*100)) : 0 });
              }
              await new Promise((res2, rej2) => out.write(Buffer.from(value), err => err ? rej2(err) : res2()));
            }
            await new Promise((res2, rej2) => out.end(err => err ? rej2(err) : res2()));
            okDl = true;
            break;
          } catch (e) { lastErr = e; }
        }
        if (!okDl) throw lastErr || new Error('download failed');
        paths.push(outPath);
      }
      if (isSplit) {
        await combineSplitParts(paths, zipTmp);
      } else {
        fs.copyFileSync(paths[0], zipTmp);
      }
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      const psCmd = 'Expand-Archive -Path "' + zipTmp + '" -DestinationPath "' + extractDir + '" -Force';
      const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', psCmd], { windowsHide: true });
      await new Promise((res2, rej2) => { ps.on('close', c => c === 0 ? res2() : rej2(new Error('extract failed'))); ps.on('error', rej2); });
      const spSrc = path.join(extractDir, 'site-packages');
      if (!fs.existsSync(spSrc)) throw new Error('压缩包内缺少 site-packages 目录');
      await stopEngineWorker();
      installGpuSite(kind, spSrc, { name: opts.name || 'fufumidi-gpu-' + kind + '.zip', url: opts.url, source: 'download', split: isSplit });
      try { fs.unlinkSync(zipTmp); } catch {}
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
      if (win && !win.isDestroyed()) win.webContents.send('gpu:progress', { received: receivedAll, total: totalAll, percent: 100, done: true });
      return { ok: true, kind };
    } catch (e) {
      try { fs.unlinkSync(zipTmp); } catch {}
      try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('gpu:installAuto', async () => {
    try {
      const py = resolvePython();
      const code = 'from engine_gpu import detect; import json; print(\'###RESULT \' + json.dumps(detect()))';
      const rr = await runEngineInline(code);
      const d = parsePyJson(rr.out);
      const vendor = (d && d.vendor) || 'unknown';
      const kind = vendor === 'nvidia' ? 'cuda' : 'directml';
      const req = kind === 'cuda' ? 'requirements-gpu-cuda.txt' : 'requirements-gpu-directml.txt';
      const reqPath = path.join(engineDir(), req);
      if (!fs.existsSync(reqPath)) return { ok: false, error: 'GPU requirement file missing: ' + reqPath };
      const targetSite = gpuEnhanceSite(kind);
      await stopEngineWorker();
      fs.mkdirSync(targetSite, { recursive: true });
      const result = await new Promise((res) => {
        const c = spawn(py, ['-m', 'pip', 'install', '--target', targetSite, '-r', reqPath, '--no-input', '--disable-pip-version-check'], { env: engineEnv() });
        let out = '', err = '';
        c.stdout.on('data', d => out += d);
        c.stderr.on('data', d => err += d);
        c.on('close', code => res({ code, out: out.slice(-600), err: err.slice(-600) }));
        c.on('error', e => res({ code: -1, err: String(e) }));
      });
      if (result.code === 0) {
        writeGpuManifest(kind, { source: 'auto' });
      }
      return { ok: result.code === 0, kind, out: result.out, err: result.err };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerGpuIpc };
