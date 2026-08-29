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
        const mirrors = [f.url, 'https://gh.jasonzeng.dev/' + f.url, 'https://ghfast.top/' + f.url, 'https://ghproxy.net/' + f.url, 'https://gh-proxy.com/' + f.url];
        let okDl = false;
        for (const u of mirrors) {
          try {
            const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.12' } });
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

  // CUDA 增强包 pip 源回退链：国内镜像优先（阿里云 pytorch-wheels / 上海交大），官方兜底。
  // torch 需 cu128 专用 wheel（镜像 pytorch-wheels/cu128），onnxruntime-gpu 等走 PyPI 镜像。
  const CUDA_PIP_SOURCES = [
    { torch: 'https://mirrors.aliyun.com/pytorch-wheels/cu128', pypi: 'https://mirrors.aliyun.com/pypi/simple', label: '阿里云' },
    { torch: 'https://mirror.sjtu.edu.cn/pytorch-wheels/cu128', pypi: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '上海交大' },
    { torch: 'https://download.pytorch.org/whl/cu128', pypi: 'https://pypi.org/simple', label: '官方' },
  ];
  const DIRECTML_PIP_SOURCES = [
    { torch: null, pypi: 'https://mirrors.aliyun.com/pypi/simple', label: '阿里云' },
    { torch: null, pypi: 'https://pypi.tuna.tsinghua.edu.cn/simple', label: '清华' },
    { torch: null, pypi: null, label: '官方' },
  ];

  // CUDA 增强包安装后的可用性自检：确保 torch.cuda 真正可用（Blackwell 需 cu128）
  async function verifyCudaInstall() {
    const code = [
      "import json",
      "try:",
      "    import torch",
      "    if not torch.cuda.is_available():",
      "        print('###CUDA ' + json.dumps({'ok': False, 'error': 'torch.cuda.is_available()=False'})); raise SystemExit",
      "    cap = tuple(torch.cuda.get_device_capability(0))",
      "    cv = str(torch.version.cuda or '')",
      "    info = {'ok': True, 'name': torch.cuda.get_device_name(0), 'capability': '%d.%d' % cap, 'blackwell': cap[0] >= 9, 'cuda_version': cv}",
      "    try:",
      "        info['need_cu128'] = bool(info['blackwell'] and (not cv or float(cv) < 12.8))",
      "    except Exception:",
      "        info['need_cu128'] = True",
      "    print('###CUDA ' + json.dumps(info))",
      "except Exception as e:",
      "    print('###CUDA ' + json.dumps({'ok': False, 'error': str(e)}))",
    ].join('\n');
    const r = await runEngineInline(code);
    const m = (r.out || '').match(/###CUDA\s+(\{.*\})/);
    if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    return { ok: false, error: String((r.out || r.error || '验证输出解析失败')).slice(-300) };
  }

  ipcMain.handle('gpu:installAuto', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('gpu:progress', p); };
    try {
      const py = resolvePython();
      const code = 'from engine_gpu import detect; import json; print(\'###RESULT \' + json.dumps(detect()))';
      const rr = await runEngineInline(code);
      const d = parsePyJson(rr.out) || {};
      const gpuDetect = {
        vendor: d.vendor || null,
        name: d.name || '',
        blackwell: !!(d.blackwell),
        needCu128: !!(d.need_cu128),
        available: !!d.available,
        backend: d.backend || '',
      };
      // 已安装增强包 → 直接提示
      const installed = installedGpuKinds();
      if (installed.length) {
        return { ok: true, already: true, kind: installed[0], kinds: installed, gpu: gpuDetect };
      }
      if (!d.vendor) {
        return { ok: false, error: '未检测到可用的独立显卡（NVIDIA / AMD / Intel），无法安装 GPU 加速；可在下方「本地导入 ZIP」手动安装增强包', gpu: gpuDetect };
      }
      const kind = d.vendor === 'nvidia' ? 'cuda' : 'directml';
      const req = kind === 'cuda' ? 'requirements-gpu-cuda.txt' : 'requirements-gpu-directml.txt';
      const reqPath = path.join(engineDir(), req);
      if (!fs.existsSync(reqPath)) return { ok: false, error: 'GPU requirement file missing: ' + reqPath, kind, gpu: gpuDetect };
      const targetSite = gpuEnhanceSite(kind);
      await stopEngineWorker();
      fs.mkdirSync(targetSite, { recursive: true });
      const sourceSets = kind === 'cuda' ? CUDA_PIP_SOURCES : DIRECTML_PIP_SOURCES;
      // 逐个源尝试：国内镜像优先，全部失败则报最后一源的错误
      let result = null;
      for (const src of sourceSets) {
        send({ percent: 1, text: '检测到 ' + (d.name || d.vendor) + '，开始安装 ' + (kind === 'cuda' ? 'CUDA（cu128）' : 'DirectML') + ' 加速（源：' + src.label + '）…', installing: true });
        const args = ['-m', 'pip', 'install', '--target', targetSite, '-r', reqPath, '--no-input', '--disable-pip-version-check'];
        if (kind === 'cuda') { args.push('-i', src.torch, '--extra-index-url', src.pypi); }
        else if (src.pypi) { args.push('-i', src.pypi); }
        result = await new Promise((res) => {
          const c = spawn(py, args, { env: engineEnv() });
          let out = '', err = '';
          const push = (s) => {
            out += s;
            const lines = s.split(/\r?\n/);
            for (const l of lines) {
              const t = l.trim();
              if (!t) continue;
              if (/^(Collecting|Downloading|Installing|Successfully|Requirement already|Using cached|Looking in)/.test(t)) {
                send({ percent: -1, text: t.slice(0, 120), installing: true });
              }
            }
          };
          c.stdout.on('data', (x) => push(x.toString('utf8')));
          c.stderr.on('data', (x) => { err += x.toString('utf8'); push(x.toString('utf8')); });
          c.on('close', (code) => res({ code, out: out.slice(-800), err: err.slice(-800) }));
          c.on('error', (e) => res({ code: -1, err: String(e) }));
        });
        if (result.code === 0) break;
        send({ percent: -1, text: '源「' + src.label + '」安装失败，切换下一镜像…', installing: true });
      }
      if (result.code === 0) {
        writeGpuManifest(kind, { source: 'auto' });
        // CUDA：安装后自检，确保 torch.cuda 真正可用（覆盖 Blackwell / RTX 50 系 cu128）
        if (kind === 'cuda') {
          send({ percent: 90, text: 'CUDA 增强包安装完成，正在验证 GPU 可用性…', installing: true });
          const verified = await verifyCudaInstall();
          if (verified && verified.ok) {
            send({ percent: 100, done: true });
            return {
              ok: true, kind, verified,
              gpu: Object.assign({}, gpuDetect, {
                available: true, backend: 'cuda', vendor: 'nvidia',
                name: verified.name || gpuDetect.name,
                blackwell: !!verified.blackwell,
                need_cu128: !!verified.need_cu128,
              }),
              out: result.out, err: result.err,
            };
          }
          // 自检失败：给出可操作的明确指引
          const hint = (verified && verified.blackwell)
            ? '检测到 Blackwell（RTX 50 系）显卡，但 CUDA 版本低于 12.8 无法驱动。请更新 NVIDIA 驱动（R570+ 支持 CUDA 12.8）后重新安装。'
            : 'CUDA 增强包已安装但 torch.cuda 不可用。请检查：① NVIDIA 显卡驱动是否已安装且较新；② 网络是否完整下载了 torch cu128 包。仍不行可到 GitHub Release 下载 fufumidi-gpu-cuda 预打包增强包，在「本地导入 ZIP」中安装。';
          return { ok: false, kind, verified, gpu: gpuDetect, error: hint, out: result.out, err: result.err };
        }
        send({ percent: 100, done: true });
        return { ok: true, kind, gpu: gpuDetect, out: result.out, err: result.err };
      }
      return { ok: false, kind, error: '所有安装源（阿里云/交大/官方）均失败：' + (result.err || result.out || '安装失败').slice(-300) + '。可到 GitHub Release 下载 fufumidi-gpu-cuda / fufumidi-gpu-directml 预打包增强包，在「本地导入 ZIP」中安装。', out: result.out, err: result.err, gpu: gpuDetect };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerGpuIpc };
