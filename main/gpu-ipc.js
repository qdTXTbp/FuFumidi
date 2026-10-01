// ============================================================
// 主进程 GPU 增强包 IPC：状态、安装、卸载、下载与自动检测
//
// 支持三种 kind：cuda / directml / rocm（见 main/gpu.js 的 KIND_PY）。
// ★ ROCm 的轮子只有 cp312，必须在 Python 3.12 运行时下才生效；
//   3.11 下安装/启用都会被拒（并给出可操作的说明），避免下 1.9GB 却装而无用。
// ============================================================
'use strict';
const Paths = require('./paths');
const DS = require('./download-source');

/** 从 GitHub Release 资产地址里取出 tag：.../releases/download/<tag>/<file> */
function ghReleaseTagOf(url) {
  const m = String(url || '').match(/\/releases\/download\/([^/]+)\//);
  return m ? m[1] : '';
}

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
  // ---- 新增：类型与 Python 版本约束 ----
  GPU_KINDS,
  KIND_LABEL,
  isGpuKind,
  requiredPython,
  fitsPython,
  readGpuManifest,
  currentPythonMinor,
  pythonForMinor,
  engineDir,
  engineEnv,
  resolvePython,
  runEngineInline,
  parsePyJson,
}) {
  // 安装/下载的可取消状态：pip 子进程引用 + 下载 AbortController
  let _gpuInstallProc = null;
  let _gpuDownloadCtl = null;
  let _gpuCanceled = false;

  function _killProcTree(pid) {
    try {
      if (!pid) return;
      const { spawnSync } = require('child_process');
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      else { try { process.kill(-pid, 'SIGKILL'); } catch (e) {} }
    } catch (e) {}
  }

  /** 该 kind 的语言/环境前置条件（供 UI 与错误信息复用） */
  function kindPrereq(kind) {
    const need = requiredPython(kind);
    const cur = currentPythonMinor();
    const ok = fitsPython(kind, cur);
    const hasRuntime = need ? !!pythonForMinor(need) : false;
    return { kind, label: KIND_LABEL[kind] || kind, requiresPython: need, currentPython: cur, fits: ok, hasRuntime };
  }

  /** 不满足前置条件时的可操作提示（返回 null 表示可用） */
  function prereqError(kind) {
    const p = kindPrereq(kind);
    if (p.fits) return null;
    if (p.requiresPython === '3.12') {
      return 'ROCm 增强包只有 Python 3.12（cp312）轮子，内置运行时是 Python ' + p.currentPython + '，'
        + '需先安装独立的 Python 3.12 引擎运行时才能启用（当前未检测到）。';
    }
    return '该增强包要求 Python ' + p.requiresPython + '，当前运行时是 ' + p.currentPython + '。';
  }

  // 取消进行中的 GPU 增强包安装/下载：杀掉 pip 进程树并中止下载流。
  ipcMain.handle('gpu:cancelInstall', async () => {
    _gpuCanceled = true;
    try { if (_gpuDownloadCtl) _gpuDownloadCtl.abort(); } catch (e) {}
    try { if (_gpuInstallProc && _gpuInstallProc.pid) _killProcTree(_gpuInstallProc.pid); } catch (e) {}
    return { ok: true };
  });

  ipcMain.handle('gpu:status', async () => {
    try {
      const dirs = installedGpuKinds();
      const out = { ok: true, isolated: true, paths: dirs, kinds: dirs, currentPython: currentPythonMinor() };
      for (const k of GPU_KINDS) {
        out[k] = dirs.indexOf(k) >= 0;
        if (dirs.indexOf(k) >= 0) out[k + 'Active'] = !!fitsPython(k, currentPythonMinor());
      }
      // rocm 已安装但当前解释器不满足 → 需切到 3.12 才生效
      out.needsPython312 = dirs.indexOf('rocm') >= 0 && !fitsPython('rocm', currentPythonMinor());
      out.canPython312 = !!pythonForMinor('3.12');
      return out;
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('gpu:uninstall', async (_e, kind) => {
    const k = String(kind || '').toLowerCase();
    if (!isGpuKind(k)) return { ok: false, error: '未知的增强包类型' };
    const dir = gpuEnhanceDir(k);
    const existed = fs.existsSync(dir);
    await stopEngineWorker();
    if (existed) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    }
    const restored = await resetBaseToCpu();
    return { ok: true, removed: existed, restored };
  });

  // GPU 增强包资产挂在**历史 tag** 上（如 v2.1.0 / gpu-v2），不在 releases/latest 里，
  // 所以必须遍历 release 列表找到「第一个带 fufumidi-gpu-* 资产的 release」，不能只看 latest。
  // 两边都查：GitHub 是资产名的权威来源；CNB 镜像仓库有一份同结构副本。
  // 按下载源偏好决定先查哪边（与 update.js / download-source.js 的语义一致），
  // 任一侧不可达或没找到就自动换另一侧 —— 国内网络下 GitHub API 常不通，靠回退仍能列出并下载。
  const GPU_ASSET_RE = /^fufumidi-gpu-/i;
  // 发现阶段必须限时：不加超时的话 GitHub 在国内会挂很久，设置页会一直转圈
  const timeoutSignal = (ms) => {
    try { return AbortSignal.timeout(ms); } catch (e) { return undefined; }
  };
  function firstGpuRelease(list) {
    if (!Array.isArray(list)) return null;
    for (const rel of list) {
      if ((rel.assets || []).some((a) => GPU_ASSET_RE.test(a.name || ''))) return rel;
    }
    return null;
  }
  async function githubGpuReleases() {
    const r = await fetch('https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=100',
      { headers: { 'User-Agent': 'FuFumidi-Update' }, signal: timeoutSignal(8000) });
    const data = await r.json();
    return Array.isArray(data) ? data : null;
  }
  // 注意端点选择：api.cnb.cool 需要鉴权（匿名请求 401 "user is not logged in"），
  // 应用是公开分发的、不能内嵌令牌，所以这里必须走 **cnb.cool 的 Web 同名路径** ——
  // 它匿名可取，且要带上 Accept: application/vnd.cnb.api+json（否则返回 HTML 页面）。
  // page_size 要显式给，默认只返回 10 条，可能漏掉带 GPU 资产的那个 release。
  async function cnbGpuReleases() {
    const repo = DS.CNB_MIRROR_REPOS.fufumidi;
    const r = await fetch(`https://cnb.cool/${repo}/-/releases?page=1&page_size=100`,
      { headers: { Accept: 'application/vnd.cnb.api+json' }, signal: timeoutSignal(8000) });
    const j = await r.json();
    const list = Array.isArray(j) ? j : (j.releases || null);
    return Array.isArray(list) ? list : null;
  }
  async function findGpuRelease() {
    // 必须显式把当前偏好传进去：preferCnb() 不传参时等价于 preferCnb(undefined)，
    // 会被 normSource 归到 'auto' 而恒为 true，导致「全球优先」也去查 CNB。
    const chain = DS.preferCnb(DS.currentSource()) ? [cnbGpuReleases, githubGpuReleases] : [githubGpuReleases, cnbGpuReleases];
    for (const fetchList of chain) {
      try {
        const rel = firstGpuRelease(await fetchList());
        if (rel) return rel;
      } catch (e) { /* 换另一个源 */ }
    }
    return null;
  }

  /** 分卷资产名：fufumidi-gpu-<kind>.partN 或 fufumidi-gpu-<kind>[-parts].zip.00N */
  function splitPartsFor(assets, kind) {
    const re = new RegExp('^fufumidi-gpu-' + kind + '(?:-parts)?\\.(zip\\.\\d{3}|part\\d+)$', 'i');
    const parts = (assets || []).filter((a) => a.name && re.test(a.name));
    parts.sort((a, b) => splitNum(a.name) - splitNum(b.name));
    return parts;
  }
  function splitNum(name) {
    const m = String(name || '').match(/(\d+)\s*$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  ipcMain.handle('gpu:listPackages', async () => {
    try {
      const rel = await findGpuRelease();
      if (!rel) return { ok: true, packages: [] };
      const assets = rel.assets || [];
      const out = [];
      for (const kind of GPU_KINDS) {
        const single = assets.find((a) => a.name && a.name.toLowerCase() === ('fufumidi-gpu-' + kind + '.zip'));
        if (single) {
          out.push({ tag: rel.tag_name, name: single.name, url: single.browser_download_url, size: single.size, kind, requiresPython: requiredPython(kind) });
        }
        const parts = splitPartsFor(assets, kind);
        if (parts.length) {
          out.push({
            tag: rel.tag_name,
            name: 'fufumidi-gpu-' + kind + '-parts (split)',
            kind,
            split: true,
            requiresPython: requiredPython(kind),
            size: parts.reduce((sum, a) => sum + (a.size || 0), 0),
            url: parts[0].browser_download_url,
            files: parts.map(a => ({ name: a.name, url: a.browser_download_url, size: a.size }))
          });
        }
      }
      return { ok: true, packages: out, currentPython: currentPythonMinor() };
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
      if (!isGpuKind(k)) return { ok: false, error: '无法识别增强包类型，请先选择 CUDA / DirectML / ROCm 包或分卷' };
      const block = prereqError(k);
      if (block) return { ok: false, kind: k, error: block, requiresPython: requiredPython(k) };
      const zipTmp = path.join(Paths.tempDir(), 'fufumidi-gpu-import.zip');
      if (localPaths.length > 1 || isSplitPackagePath(first)) {
        await combineSplitParts(localPaths, zipTmp);
      } else {
        fs.copyFileSync(first, zipTmp);
      }
      const extractDir = path.join(Paths.tempDir(), 'fufumidi-gpu-import');
      fs.rmSync(extractDir, { recursive: true, force: true });
      fs.mkdirSync(extractDir, { recursive: true });
      const psCmd = 'Expand-Archive -Path "' + zipTmp + '" -DestinationPath "' + extractDir + '" -Force';
      const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', psCmd], { windowsHide: true });
      await new Promise((res, rej) => { ps.on('close', c => c === 0 ? res() : rej(new Error('解压失败'))); ps.on('error', rej); });
      const spSrc = path.join(extractDir, 'site-packages');
      if (!fs.existsSync(spSrc)) return { ok: false, error: '压缩包内缺少 site-packages 目录' };
      await stopEngineWorker();
      installGpuSite(k, spSrc, { name: path.basename(first), source: 'local', requiresPython: requiredPython(k) });
      try { fs.unlinkSync(zipTmp); } catch {}
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
      return { ok: true, kind: k, split: localPaths.length > 1 || isSplitPackagePath(first), requiresPython: requiredPython(k), active: !!fitsPython(k, currentPythonMinor()) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('gpu:packageUrl', async (_e, kind) => {
    try {
      if (!isGpuKind(kind)) return { ok: false, error: '未知的增强包类型' };
      const rel = await findGpuRelease();
      const assets = ((rel && rel.assets) || []).filter(a => a.name && a.name.toLowerCase().includes('gpu-' + kind) && a.name.toLowerCase().endsWith('.zip'));
      if (!assets.length) return { ok: false, error: '未找到 GPU 增强包资产：fufumidi-gpu-' + kind + '.zip' };
      const a = assets[0];
      return { ok: true, url: a.browser_download_url, name: a.name, size: a.size };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('gpu:downloadPackage', async (evt, opts) => {
    if (!opts || (!opts.url && !(opts.files && opts.files.length))) return { ok: false, error: 'empty url' };
    const kind = String(opts.kind || inferGpuKind(opts.name || (opts.files && opts.files[0] && (opts.files[0].name || opts.files[0].url)) || opts.url) || '').toLowerCase();
    if (!isGpuKind(kind)) return { ok: false, error: '无法识别增强包类型' };
    // 前置条件（如 ROCm 需 Python 3.12）：先拦下来，别让用户白下 1.9GB
    const block = prereqError(kind);
    if (block) return { ok: false, kind, error: block, requiresPython: requiredPython(kind) };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const dlDir = path.join(Paths.tempDir(), 'fufumidi-gpu-dl');
    const extractDir = path.join(Paths.tempDir(), 'fufumidi-gpu-extract');
    const zipTmp = path.join(Paths.tempDir(), 'fufumidi-gpu-dl.zip');
    fs.rmSync(dlDir, { recursive: true, force: true });
    fs.mkdirSync(dlDir, { recursive: true });
    let lastErr = null;
    _gpuCanceled = false;
    const ctl = new AbortController();
    _gpuDownloadCtl = ctl;   // 供 gpu:cancelInstall 中止下载流
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
        // 候选源：自有 CNB 镜像（按下载源偏好排前/排后）+ GitHub 各加速镜像。
        // GPU 包体积远超 CNB 的两个体积上限（git 推送 256 MiB / git raw 读取 100 MiB），
        // 所以镜像只能落在 CNB Release 资产上（对象存储），地址形如
        // /-/releases/download/<tag>/<file>；tag 与 GitHub 侧保持一致。
        const cnbUrl = ghReleaseTagOf(f.url) ? DS.cnbRepoReleaseUrl(DS.CNB_MIRROR_REPOS.fufumidi, ghReleaseTagOf(f.url), name) : null;
        const mirrors = DS.orderUrls(cnbUrl, DS.githubMirrorCandidates(f.url));
        let okDl = false;
        for (const u of mirrors) {
          if (_gpuCanceled) break;
          const out = fs.createWriteStream(outPath);
          // 必须挂一个空的 error 监听：WriteStream 的打开是异步的，若此时目录被清理
          // （下面 catch 里的 rmSync）/ 磁盘满 / 无权限，会 emit 'error'；没人接就是
          // 未处理事件 → 直接崩掉主进程。真正的写失败由下面 out.write 的回调上报并捕获。
          out.on('error', () => {});
          try {
            const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.16' }, signal: ctl.signal });
            if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
            const reader = res.body.getReader();
            let received = 0, lastSend = 0;
            while (true) {
              if (_gpuCanceled) { try { reader.cancel(); } catch (e) {} break; }
              const { done, value } = await reader.read();
              if (done) break;
              received += value.length; receivedAll += value.length;
              const now = Date.now();
              if (now - lastSend > 300) {
                lastSend = now;
                if (win && !win.isDestroyed()) win.webContents.send('gpu:progress', { received: receivedAll, total: totalAll, percent: totalAll ? Math.min(99, Math.round(receivedAll/totalAll*100)) : 0 });
              }
              await new Promise((res2, rej2) => out.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
            }
            await new Promise((res2, rej2) => out.end(err => (err ? rej2(err) : res2())));
            okDl = !_gpuCanceled;
            if (okDl) break;
            throw new Error('canceled');
          } catch (e) {
            lastErr = e;
            try { out.destroy(); } catch (_) {}
            if (_gpuCanceled) break;
          }
        }
        if (_gpuCanceled) break;
        if (!okDl) throw lastErr || new Error('download failed');
        paths.push(outPath);
      }
      if (_gpuCanceled) {
        try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch (e) {}
        return { ok: false, canceled: true, error: '已取消下载' };
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
      installGpuSite(kind, spSrc, { name: opts.name || 'fufumidi-gpu-' + kind + '.zip', url: opts.url, source: 'download', split: isSplit, requiresPython: requiredPython(kind) });
      try { fs.unlinkSync(zipTmp); } catch {}
      try { fs.rmSync(extractDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
      if (win && !win.isDestroyed()) win.webContents.send('gpu:progress', { received: receivedAll, total: totalAll, percent: 100, done: true });
      return { ok: true, kind, requiresPython: requiredPython(kind), active: !!fitsPython(kind, currentPythonMinor()) };
    } catch (e) {
      try { fs.unlinkSync(zipTmp); } catch {}
      try { fs.rmSync(dlDir, { recursive: true, force: true }); } catch {}
      if (_gpuCanceled) return { ok: false, canceled: true, error: '已取消下载' };
      return { ok: false, error: String((e && e.message) || e) };
    } finally {
      _gpuDownloadCtl = null;
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

  // 增强包安装后的可用性自检：确保 torch 真的认到对应后端
  //   cuda → torch.cuda.is_available()（Blackwell 需 cu128）
  //   rocm → torch.version.hip 非空
  async function verifyTorchBackend(kind) {
    const isCuda = kind === 'cuda';
    const code = [
      "import json",
      "try:",
      "    import torch",
      isCuda
        ? "    ok = bool(torch.cuda.is_available())"
        : "    ok = bool(getattr(torch.version, 'hip', None))",
      "    if not ok:",
      "        print('###BACKEND ' + json.dumps({'ok': False, 'error': 'backend unavailable'})); raise SystemExit",
      "    info = {'ok': True, 'torch': torch.__version__, 'hip': getattr(torch.version, 'hip', None), 'cuda_version': getattr(torch.version, 'cuda', None)}",
      isCuda ? "    cap = tuple(torch.cuda.get_device_capability(0))" : "    cap = None",
      isCuda ? "    info['name'] = torch.cuda.get_device_name(0)" : "    info['name'] = 'ROCm GPU'",
      isCuda ? "    info['capability'] = '%d.%d' % cap" : "    info['capability'] = None",
      isCuda ? "    info['blackwell'] = cap[0] >= 9" : "    info['blackwell'] = False",
      isCuda ? "    try: info['need_cu128'] = bool(info['blackwell'] and (not info['cuda_version'] or float(info['cuda_version']) < 12.8))" : "    info['need_cu128'] = False",
      isCuda ? "    except Exception: info['need_cu128'] = True" : "",
      "    print('###BACKEND ' + json.dumps(info))",
      "except Exception as e:",
      "    print('###BACKEND ' + json.dumps({'ok': False, 'error': str(e)}))",
    ].filter(Boolean).join('\n');
    const r = await runEngineInline(code);
    const m = (r.out || '').match(/###BACKEND\s+(\{.*\})/);
    if (m) { try { return JSON.parse(m[1]); } catch (e) {} }
    return { ok: false, error: String((r.out || r.error || '验证输出解析失败')).slice(-300) };
  }

  ipcMain.handle('gpu:installAuto', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('gpu:progress', p); };
    _gpuCanceled = false;   // 新一轮安装：清除上次的取消标记
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
      // 一键安装只覆盖「开箱即用」的两条路：NVIDIA → CUDA，AMD/Intel → DirectML。
      // ROCm 需要较新的 Radeon + Adrenalin 26.1.1+ 驱动，且必须配 Python 3.12 运行时，
      // 属于显式选择项（见下方「预打包增强包」列表），不在这里自动装。
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
        if (_gpuCanceled) break;
        send({ percent: 1, text: '检测到 ' + (d.name || d.vendor) + '，开始安装 ' + (kind === 'cuda' ? 'CUDA（cu128）' : 'DirectML') + ' 加速（源：' + src.label + '）…', installing: true });
        // --retries/--timeout：网络抖动自动重试；--cache-dir：已下载 wheel 复用，失败后续传
        const pipCache = Paths.pipCacheDir();
        const args = ['-m', 'pip', 'install', '--target', targetSite, '-r', reqPath, '--no-input', '--disable-pip-version-check',
                      '--retries', '5', '--timeout', '60', '--cache-dir', pipCache];
        if (kind === 'cuda') { args.push('-i', src.torch, '--extra-index-url', src.pypi); }
        else if (src.pypi) { args.push('-i', src.pypi); }
        result = await new Promise((res) => {
          const c = spawn(py, args, { env: engineEnv() });
          _gpuInstallProc = c;   // 供 gpu:cancelInstall 杀掉进程树
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
          c.on('close', (code) => { if (_gpuInstallProc === c) _gpuInstallProc = null; res({ code, out: out.slice(-800), err: err.slice(-800) }); });
          c.on('error', (e) => { if (_gpuInstallProc === c) _gpuInstallProc = null; res({ code: -1, err: String(e) }); });
        });
        if (_gpuCanceled) break;
        if (result.code === 0) break;
        send({ percent: -1, text: '源「' + src.label + '」安装失败，切换下一镜像…', installing: true });
      }
      // 用户取消：清理半装的 targetSite，避免残留损坏的 site-packages 被 PYTHONPATH 加载
      if (_gpuCanceled) {
        try { fs.rmSync(targetSite, { recursive: true, force: true }); } catch (e) {}
        send({ percent: 0, text: '已取消安装', done: true });
        return { ok: false, canceled: true, kind, error: '已取消安装' };
      }
      if (result.code === 0) {
        writeGpuManifest(kind, { source: 'auto', requiresPython: requiredPython(kind) });
        // CUDA：安装后自检，确保 torch.cuda 真正可用（覆盖 Blackwell / RTX 50 系 cu128）
        if (kind === 'cuda') {
          send({ percent: 90, text: 'CUDA 增强包安装完成，正在验证 GPU 可用性…', installing: true });
          const verified = await verifyTorchBackend('cuda');
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
      return { ok: false, kind, error: '所有安装源（阿里云/交大/官方）均失败：' + (result.err || result.out || '安装失败').slice(-300) + '。可到 GitHub Release 下载 fufumidi-gpu-cuda / fufumidi-gpu-directml / fufumidi-gpu-rocm 预打包增强包，在「本地导入 ZIP」中安装。', out: result.out, err: result.err, gpu: gpuDetect };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerGpuIpc };
