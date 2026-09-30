// ============================================================
// DiffSinger 模块化集成 IPC
// ------------------------------------------------------------
// 设计原则（与「安装后 100% 离线」的应用定位一致）：
//   1. DiffSinger 是**完全可选**模块 —— 未启用时零下载、零推理依赖安装，
//      应用行为与原先完全一致；
//   2. 启用（settings.diffsinger_enabled）后才按需安装两类组件：
//      a) Python 推理依赖（onnxruntime / pyyaml，pip 安装，流式日志）；
//      b) 通用 NSF-HiFiGAN 声码器（openvpi 社区声码器，多源断点续传下载）；
//   3. 声库独立管理（本地导入 zip / 公开声库一键下载），与 UTAU 声库同级存放；
//   4. 渲染走 engine/engine_diffsinger.py（ONNX 推理），复用引擎 JSON 协议。
//
// 目录约定（数据根目录下，不占 C 盘）：
//   <root>/diffsinger/
//     runtime.json          组件安装状态（声码器文件名 / 安装时间）
//     vocoder/              通用 NSF-HiFiGAN（onnx + 配置）
//   <root>/diffsinger-voicebanks/<name>/   声库（含 dsconfig.yaml）
// ============================================================
'use strict';
const Paths = require('./paths');
const DS = require('./download-source');

function registerDiffsingerIpc({ ipcMain, BrowserWindow, path, fs, os, app, dialog, net, spawn, spawnEngine, resolvePython, engineEnv, readSettings, writeSettings }) {

  /* ---------------- 目录与常量 ---------------- */
  const dsRoot = () => Paths.diffsingerRoot();
  const vbRoot = () => Paths.diffsingerVoicebanksDir();
  const vocoderDir = () => path.join(dsRoot(), 'vocoder');
  const runtimeFile = () => path.join(dsRoot(), 'runtime.json');

  // 通用声码器：openvpi 社区声码器项目（DiffSinger Community Vocoder Project）
  // nsf-hifigan-44.1k-hop512-128bin-2024.02（CC BY-NC-SA 4.0，非商用；许可证随包分发）
  // zip 内含 ONNX 模型， acoustic 模型输出 128 bin mel → 波形。
  // 双源分发（发布流程见 scripts/diffsinger-mirror/README.md）：
  //   国内 = CNB 镜像仓库 Release 资产；全球 = 同名 GitHub 自有仓库 Release；openvpi 官方仅兜底。
  // 按 settings.download_source 排序候选，失败自动换源 + 断点续传。
  const VOCODER_SPEC = {
    id: 'nsf_hifigan_44.1k_2024.02',
    name: 'NSF-HiFiGAN 通用声码器',
    note: 'openvpi 社区声码器 · 44.1kHz / 128 mel bins · 约 55 MB · CC BY-NC-SA 4.0（非商用）',
    tag: 'vocoder-2024.02',
    file: 'nsf_hifigan_44.1k_hop512_128bin_2024.02.zip',
    ghUrl: 'https://github.com/FuFuCloud-mirror/DiffSinger/releases/download/vocoder-2024.02/nsf_hifigan_44.1k_hop512_128bin_2024.02.zip',
    fallbackUrl: 'https://github.com/openvpi/vocoders/releases/download/nsf-hifigan-44.1k-hop512-128bin-2024.02/nsf_hifigan_44.1k_hop512_128bin_2024.02.zip',
    officialUrl: 'https://github.com/openvpi/vocoders/releases',
    cnb: { repo: DS.CNB_MIRROR_REPOS.diffsinger, tag: 'vocoder-2024.02', file: 'nsf_hifigan_44.1k_hop512_128bin_2024.02.zip' },
  };
  // 推理依赖：ONNX Runtime（CPU）+ YAML 解析。numpy 由引擎环境自带。
  const DS_PY_DEPS = ['onnxruntime', 'pyyaml'];

  // 公开声库注册表：仅收录「作者公开托管、可自由下载」的仓库（同 UTAU 声库中心原则）。
  // 条目均来自声库作者自己的 GitHub Release，使用条款原样展示，由使用者自行遵守。
  // 合规说明：仅 openvpi 声码器（CC BY-NC-SA 4.0 明确允许再分发）会镜像到 CNB；
  // 第三方声库（如 Ria 白名单条款未授权模型权重再分发）只走作者 GitHub 源，不做镜像。
  const VB_REGISTRY = [
    {
      id: 'ria_multi_dict',
      dirName: 'Ria',
      name: 'Ria（多字典版）',
      author: 'RibosomeK',
      lang: '日本語 · 多字典（支持跨语种）',
      desc: '开源 DiffSinger 日文声库（多字典分支）：平假名 + 外来语片假名覆盖完整。v0.4-multi-dict。',
      license: '白名单条款 · 详见仓库 README（输出音频需注明声库名）',
      ghUrl: 'https://github.com/RibosomeK/RiaDiffSinger/releases/download/v0.4-multi-dict/Ria-v0.4-multi-dict.zip',
      officialUrl: 'https://github.com/RibosomeK/RiaDiffSinger',
    },
  ];

  /* ---------------- 小工具 ---------------- */
  const enabled = () => !!((readSettings && readSettings().diffsinger_enabled));
  function readRuntime() {
    try { return JSON.parse(fs.readFileSync(runtimeFile(), 'utf8')); } catch (e) { return {}; }
  }
  function writeRuntime(patch) {
    try {
      fs.mkdirSync(dsRoot(), { recursive: true });
      const cur = readRuntime();
      fs.writeFileSync(runtimeFile(), JSON.stringify({ ...cur, ...patch, updatedAt: new Date().toISOString() }, null, 2), 'utf8');
    } catch (e) {}
  }
  function findInTree(root, fileName, depth = 4) {
    // 深度受限地查找文件（声库根可能是 zip 解压后的子目录）
    if (depth < 0 || !root || !fs.existsSync(root)) return null;
    if (fs.existsSync(path.join(root, fileName))) return root;
    let names = [];
    try { names = fs.readdirSync(root); } catch (e) { return null; }
    for (const n of names) {
      const p = path.join(root, n);
      let isDir = false;
      try { isDir = fs.statSync(p).isDirectory(); } catch (e) { continue; }
      if (!isDir) continue;
      const r = findInTree(p, fileName, depth - 1);
      if (r) return r;
    }
    return null;
  }
  function dirBytes(root) {
    let sum = 0;
    try {
      for (const n of fs.readdirSync(root)) {
        const p = path.join(root, n);
        const st = fs.statSync(p);
        if (st.isDirectory()) sum += dirBytes(p); else sum += st.size;
      }
    } catch (e) {}
    return sum;
  }
  const vbInstalled = (it) => !!findInTree(path.join(vbRoot(), it.dirName), 'dsconfig.yaml', 0);

  /** 资产候选地址：按 settings.download_source 偏好排序（国内源 CNB 打头 / 全球源 GitHub 打头），失败轮换 */
  function assetUrls(spec) {
    const source = readSettings ? (readSettings().download_source || 'auto') : 'auto';
    const ghUrls = [
      ...DS.githubMirrorCandidates(spec.ghUrl),
      ...DS.githubMirrorCandidates(spec.fallbackUrl || ''),
    ].filter(Boolean);
    const cnbUrl = spec.cnb ? DS.cnbRepoReleaseUrl(spec.cnb.repo, spec.cnb.tag, spec.cnb.file) : '';
    return DS.orderUrls(cnbUrl, ghUrls, source);
  }
  /** 当前源标签（进度展示用）：候选列表第一个的 host 归属 */
  function sourceLabelOf(urls) {
    const u = String(urls[0] || '');
    if (u.includes('cnb.cool')) return '国内源 · CNB';
    if (u.includes('FuFuCloud-mirror/DiffSinger')) return '全球源 · GitHub（自有仓库）';
    if (u.includes('openvpi')) return '全球源 · openvpi 官方';
    return '全球源 · GitHub 镜像';
  }

  const hostOf = (u) => { try { return new URL(u).host; } catch (e) { return ''; } };

  /* ---------------- 通用下载器（多源轮换 + 断点续传 + 停滞看门狗） ---------------- */
  async function downloadWithMirrors({ urls, out, minSize, onProgress, isUserAbort }) {
    const STALL_MS = 25000;
    const MAX_ROUNDS = 10;
    const part = out + '.part';
    let ws = null, lastErr = null;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      const url = urls[round % urls.length];
      const ctrl = new AbortController();
      _dlAborts.set(out, { ctrl, isUserAbort });
      try {
        let have = 0;
        try { have = fs.statSync(part).size; } catch (e) {}
        const headers = { 'user-agent': 'FuFumidi' };
        if (have > 0) headers['range'] = 'bytes=' + have + '-';
        const r = await net.fetch(url, { headers, signal: ctrl.signal, redirect: 'follow' });
        if (r.status === 416) {
          try { fs.rmSync(part, { force: true }); } catch (e2) {}
          throw new Error('断点越界已重置');
        }
        if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);
        const clen = parseInt(r.headers.get('content-length') || '0', 10);
        const resumable = r.status === 206 && have > 0;
        if (!resumable && have > 0) { try { fs.rmSync(part, { force: true }); } catch (e2) {} have = 0; }
        const total = clen ? have + clen : 0;
        ws = fs.createWriteStream(part, { flags: resumable ? 'a' : 'w' });
        ws.on('error', () => {});
        const reader = r.body.getReader();
        let lastData = Date.now();
        const watchdog = setInterval(() => {
          if (Date.now() - lastData > STALL_MS) {
            try { reader.cancel('stalled'); } catch (e2) {}
            try { ctrl.abort(); } catch (e2) {}
          }
        }, 3000);
        let got = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            lastData = Date.now();
              got += value.length;
              const received = have + got;
              onProgress && onProgress({ received, total, host: hostOf(url) });
              await new Promise((res2, rej2) => ws.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
          }
        } finally { clearInterval(watchdog); }
        await new Promise((res2, rej2) => ws.end(err => (err ? rej2(err) : res2())));
        ws = null;
        const st = fs.statSync(part);
        if (st.size < (minSize || 200000)) { lastErr = new Error('下载文件过小（' + st.size + ' B），可能被代理拦截'); continue; }
        try { fs.rmSync(out, { force: true }); } catch (e2) {}
        fs.renameSync(part, out);
        return { size: st.size };
      } catch (e) {
        lastErr = e;
        try { if (ws) ws.destroy(); } catch (e2) {}
        ws = null;
        if (isUserAbort && isUserAbort.aborted) return { cancelled: true };
        onProgress && onProgress({ retry: round + 1, host: hostOf(url), error: '第 ' + (round + 1) + ' 轮失败，自动换源/续传…' });
        if (round === MAX_ROUNDS - 1) {
          throw new Error('下载失败（已多源轮换 ' + MAX_ROUNDS + ' 轮）：' + ((lastErr && lastErr.message) || '网络不可达'));
        }
      }
    }
    throw lastErr || new Error('下载失败');
  }
  const _dlAborts = new Map();

  /* ---------------- 状态查询 ---------------- */
  // 依赖检测结果短缓存：避免每次进入页面都起一个 Python 子进程
  let _depsCache = { at: 0, data: null };
  function checkDeps(force) {
    const now = Date.now();
    if (!force && _depsCache.data && now - _depsCache.at < 30000) return Promise.resolve(_depsCache.data);
    return new Promise((resolve) => {
      try {
        spawnEngine(['deps', '--check'], {
          script: 'engine_diffsinger.py',
          timeoutMs: 60000,
          onDone: (code, r) => {
            const data = (r && r.result && r.result.ok) ? r.result : { ok: false, missing: [], installed: [], error: (r && (r.err || r.out || '') || '').slice(-300) || ('引擎退出码 ' + code) };
            _depsCache = { at: Date.now(), data };
            resolve(data);
          },
          onError: (e) => {
            const data = { ok: false, missing: DS_PY_DEPS, installed: [], error: String(e) };
            _depsCache = { at: Date.now(), data };
            resolve(data);
          },
        });
      } catch (err) {
        resolve({ ok: false, missing: DS_PY_DEPS, installed: [], error: String((err && err.message) || err) });
      }
    });
  }

  ipcMain.handle('diffsinger:status', async () => {
    try {
      const enabledNow = enabled();
      const deps = enabledNow ? await checkDeps(false) : { ok: false, missing: DS_PY_DEPS, installed: [], skipped: true };
      const rt = readRuntime();
      const vocoderInstalled = (() => {
        try {
          const dir = vocoderDir();
          if (!fs.existsSync(dir)) return false;
          return fs.readdirSync(dir).some(n => /\.onnx$/i.test(n));
        } catch (e) { return false; }
      })();
      let voicebanks = [];
      try {
        voicebanks = fs.readdirSync(vbRoot())
          .filter(n => { try { return fs.statSync(path.join(vbRoot(), n)).isDirectory(); } catch (e) { return false; } })
          .filter(n => !!findInTree(path.join(vbRoot(), n), 'dsconfig.yaml', 0));
      } catch (e) {}
      return {
        ok: true,
        enabled: enabledNow,
        deps: { installed: deps.installed || [], missing: deps.missing || [], ok: !!(deps.ok), error: deps.error || '', skipped: !!deps.skipped },
        vocoder: { installed: vocoderInstalled, dir: vocoderDir(), spec: VOCODER_SPEC, runtime: rt },
        voicebankDir: vbRoot(),
        voicebankCount: voicebanks.length,
        ready: enabledNow && !!(deps.ok) && vocoderInstalled,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /* ---------------- 启用 / 禁用 ---------------- */
  // 启用只写设置，不自动下载任何东西；组件由用户在界面上确认后安装。
  // 禁用保留已下载数据（可随时重新启用复用），如需释放磁盘用 uninstallRuntime。
  ipcMain.handle('diffsinger:setEnabled', async (_e, on) => {
    try {
      const s = readSettings();
      s.diffsinger_enabled = !!on;
      writeSettings(s);
      return { ok: true, enabled: !!on };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /* ---------------- 组件安装（依赖 + 声码器） ---------------- */
  // installRuntime：启用 DiffSinger 后手动触发。步骤：
  //   1) pip 安装推理依赖（onnxruntime / pyyaml），流式输出安装日志；
  //   2) 下载通用 NSF-HiFiGAN 声码器（多源 + 断点续传 + 进度）。
  const _runtimeBusy = { active: false };
  ipcMain.handle('diffsinger:installRuntime', async (evt) => {
    if (!enabled()) return { ok: false, error: '请先启用 DiffSinger 模块' };
    if (_runtimeBusy.active) return { ok: false, error: '组件安装已在进行中' };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('diffsinger:runtimeProgress', p); };
    _runtimeBusy.active = true;
    try {
      // ---- 步骤 1：Python 依赖 ----
      send({ phase: 'deps', percent: 0, text: '正在检查 Python 推理依赖…', done: false });
      const before = await checkDeps(true);
      if (!(before && before.ok)) {
        const py = resolvePython();
        // pip 源策略：用户下载源偏好「国内优先」时先用清华镜像，失败换官方；
        // 其余情况先官方源，失败换清华镜像。
        const mirrorFirst = (readSettings && readSettings().download_source) === 'cnb';
        const pkgs = DS_PY_DEPS.filter(d => !(before.installed || []).includes(d));
        const runPip = (extraArgs) => new Promise((resolvePip) => {
          const args = ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check', ...extraArgs, ...(pkgs.length ? pkgs : DS_PY_DEPS)];
          const child = spawn(py, args, {
            windowsHide: true,
            env: engineEnv({ PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
          });
          let outBuf = '';
          let lastSend = 0;
          const pump = (d) => {
            outBuf += d.toString('utf8');
            // pip 进度条用 \r 刷新：按 \r 也切段，限频发送
            const lines = outBuf.split(/[\r\n]+/);
            outBuf = lines.pop();
            const now = Date.now();
            if (now - lastSend < 400) return;
            lastSend = now;
            const text = lines.filter(Boolean).slice(-3).join(' | ');
            if (text) send({ phase: 'deps', percent: -1, text: text.slice(0, 300), done: false });
          };
          child.stdout.on('data', pump);
          child.stderr.on('data', pump);
          child.on('error', (e) => resolvePip({ ok: false, error: String(e) }));
          child.on('close', (code) => resolvePip({ ok: code === 0, code }));
        });
        send({ phase: 'deps', percent: 40, text: '正在安装推理依赖（onnxruntime / pyyaml）…', done: false });
        let r = await runPip(mirrorFirst ? ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'] : []);
        if (!r.ok) {
          // 换镜像再来一轮（默认源失败 → 清华镜像；镜像先行失败 → 官方源）
          send({ phase: 'deps', percent: 60, text: '首选源失败，正在切换 pip 源重试…', done: false });
          r = await runPip(mirrorFirst ? [] : ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple']);
        }
        if (!r.ok) {
          throw new Error('推理依赖安装失败（pip 退出码 ' + r.code + '）。请检查网络或手动执行：pip install ' + DS_PY_DEPS.join(' '));
        }
        const after = await checkDeps(true);
        if (!(after && after.ok)) {
          throw new Error('依赖安装后校验未通过：' + ((after && after.error) || '未知错误'));
        }
      }
      send({ phase: 'deps', percent: 100, text: '推理依赖就绪', done: true, step: 'deps' });

      // ---- 步骤 2：通用声码器 ----
      const vDir = vocoderDir();
      const hasOnnx = (() => {
        try { return fs.existsSync(vDir) && fs.readdirSync(vDir).some(n => /\.onnx$/i.test(n)); } catch (e) { return false; }
      })();
      if (!hasOnnx) {
        send({ phase: 'vocoder', percent: 0, text: '正在下载通用声码器（NSF-HiFiGAN，约 55 MB）…', done: false });
        const dlDir = path.join(Paths.tempDir(), 'diffsinger-dl');
        fs.mkdirSync(dlDir, { recursive: true });
        const zipPath = path.join(dlDir, 'vocoder.zip');
        const vUrls = assetUrls(VOCODER_SPEC);
        await downloadWithMirrors({
          urls: vUrls,
          out: zipPath,
          minSize: 1e6,
          isUserAbort: _runtimeBusy,
          onProgress: (p) => send({
            phase: 'vocoder', percent: p.total ? Math.min(96, Math.round(p.received / p.total * 96)) : 0,
            received: p.received, total: p.total, host: p.host, text: p.error || ('当前源：' + sourceLabelOf(vUrls)), done: false,
          }),
        });
        send({ phase: 'vocoder', percent: 97, text: '正在解压声码器…', done: false });
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(zipPath);
        const stage = path.join(dlDir, 'vocoder-extract');
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
        fs.mkdirSync(stage, { recursive: true });
        zip.extractAllTo(stage, true);
        // 找 onnx（可能在子目录），连同配置一起归一化到 vocoder/
        const files = [];
        const walk = (d) => {
          for (const n of fs.readdirSync(d)) {
            const p = path.join(d, n);
            const st = fs.statSync(p);
            if (st.isDirectory()) walk(p);
            else if (/\.(onnx|json|ya?ml)$/i.test(n)) files.push(p);
          }
        };
        walk(stage);
        const onnxF = files.find(f => /\.onnx$/i.test(f));
        if (!onnxF) throw new Error('声码器包里没有找到 ONNX 模型（包结构可能已变更）');
        fs.rmSync(vDir, { recursive: true, force: true });
        fs.mkdirSync(vDir, { recursive: true });
        const keep = files.filter(f => /\.onnx$/i.test(f) || /config|\.yaml|\.json$/i.test(path.basename(f)));
        for (const f of keep) fs.copyFileSync(f, path.join(vDir, path.basename(f)));
        writeRuntime({ vocoder: { file: path.basename(onnxF), spec: VOCODER_SPEC.id } });
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
        try { fs.rmSync(zipPath, { force: true }); } catch (e2) {}
      } else {
        send({ phase: 'vocoder', percent: 100, text: '声码器已就绪', done: true, step: 'vocoder', existed: true });
      }
      send({ phase: 'vocoder', percent: 100, text: 'DiffSinger 组件安装完成', done: true, step: 'all' });
      return { ok: true };
    } catch (err) {
      const msg = String((err && err.message) || err);
      send({ phase: 'error', percent: 0, text: msg, done: true });
      return { ok: false, error: msg };
    } finally {
      _runtimeBusy.active = false;
      _dlAborts.delete(path.join(Paths.tempDir(), 'diffsinger-dl', 'vocoder.zip'));
    }
  });

  ipcMain.handle('diffsinger:cancelRuntimeInstall', async () => {
    _runtimeBusy.active = false; // 标记用户中止（pip 子进程无法安全强杀时自然收尾）
    const keys = [..._dlAborts.keys()];
    for (const k of keys) {
      const ent = _dlAborts.get(k);
      try { if (ent && ent.ctrl) ent.ctrl.abort(); } catch (e) {}
    }
    return { ok: true };
  });

  // 清理运行时数据（保留/一并清理声库可选）。只在数据根目录内的约定路径上生效。
  ipcMain.handle('diffsinger:uninstallRuntime', async (_e, opts) => {
    try {
      const alsoVoicebanks = !!(opts && opts.alsoVoicebanks);
      const root = path.resolve(dsRoot());
      const inDataRoot = (p) => {
        try { return path.resolve(p).startsWith(path.resolve(Paths.dataRoot()) + path.sep); } catch (e) { return false; }
      };
      if (inDataRoot(root)) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (e) {} }
      if (alsoVoicebanks) {
        const vdir = path.resolve(vbRoot());
        if (inDataRoot(vdir)) { try { fs.rmSync(vdir, { recursive: true, force: true }); } catch (e) {} }
      }
      _depsCache = { at: 0, data: null };
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /* ---------------- 声库管理 ---------------- */
  ipcMain.handle('diffsinger:listVoicebanks', () => {
    try {
      const root = vbRoot();
      if (!fs.existsSync(root)) return { ok: true, list: [] };
      const list = [];
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        let isDir = false;
        try { isDir = fs.statSync(dir).isDirectory(); } catch (e) {}
        if (!isDir) continue;
        const cfgDir = findInTree(dir, 'dsconfig.yaml', 0);
        if (cfgDir) list.push({ name, dir: cfgDir, size: dirBytes(dir) });
      }
      return { ok: true, list };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 导入本地声库 zip / OpenUTAU 依赖包（.oudep = 改后缀的 zip，通常是声码器）
  // directPath：拖拽导入时由渲染端传入，跳过文件对话框
  ipcMain.handle('diffsinger:importVoicebankZip', async (_e, directPath) => {
    try {
      let files;
      if (directPath && typeof directPath === 'string' && /\.(zip|oudep)$/i.test(directPath) && fs.existsSync(directPath)) {
        files = [directPath];
      } else {
        const r = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'DiffSinger 声库', extensions: ['zip', 'oudep'] }],
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
        files = r.filePaths;
      }
      const zipPath = files[0];
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const isOudep = /\.oudep$/i.test(zipPath);
      const dlDir = path.join(Paths.tempDir(), 'diffsinger-dl');
      fs.mkdirSync(dlDir, { recursive: true });
      const stage = path.join(dlDir, 'import-' + Date.now());
      zip.extractAllTo(stage, true);
      const norm = (p) => String(p).replace(/\\/g, '/');
      try {
        // OpenUTAU 归档常带一层顶层目录：找到含目标的子目录
        const stripTop = (dir) => {
          let cur = dir;
          for (let i = 0; i < 2; i++) {
            const subs = fs.readdirSync(cur).filter(n => { try { return fs.statSync(path.join(cur, n)).isDirectory(); } catch (e) { return false; } });
            const files2 = fs.readdirSync(cur).filter(n => { try { return fs.statSync(path.join(cur, n)).isFile(); } catch (e) { return false; } });
            if (!subs.length || files2.length) return cur;
            const cand = path.join(cur, subs[0]);
            const hasTarget = fs.existsSync(path.join(cand, 'dsconfig.yaml')) || fs.readdirSync(cand).some(n => /\.onnx$/i.test(n));
            if (hasTarget) { cur = cand; continue; }
            return cur;
          }
          return cur;
        };
        if (isOudep) {
          // 依赖包：装到通用声码器位
          const src = stripTop(stage);
          const files2 = [];
          const walk = (d) => {
            for (const n of fs.readdirSync(d)) {
              const p = path.join(d, n);
              const st = fs.statSync(p);
              if (st.isDirectory()) walk(p);
              else if (/\.(onnx|json|ya?ml)$/i.test(n)) files2.push(p);
            }
          };
          walk(src);
          const onnxF = files2.find(f => /\.onnx$/i.test(f));
          if (!onnxF) throw new Error('该依赖包里没有 ONNX 模型');
          const vDir = vocoderDir();
          fs.rmSync(vDir, { recursive: true, force: true });
          fs.mkdirSync(vDir, { recursive: true });
          for (const f of files2) fs.copyFileSync(f, path.join(vDir, path.basename(f)));
          writeRuntime({ vocoder: { file: path.basename(onnxF), imported: true } });
          return { ok: true, kind: 'vocoder', name: path.basename(zipPath), dir: vDir };
        }
        // 声库包：找 dsconfig.yaml
        const cfgDir = findInTree(stage, 'dsconfig.yaml', 4);
        if (!cfgDir) throw new Error('压缩包里没有找到 dsconfig.yaml（请确认是 DiffSinger / OpenUTAU 声库）');
        let name = path.basename(zipPath, path.extname(zipPath)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
        name = name || ('voicebank_' + Date.now());
        const root = vbRoot();
        fs.mkdirSync(root, { recursive: true });
        let dest = path.join(root, name);
        let i = 2;
        while (fs.existsSync(dest)) { dest = path.join(root, name + '_' + i++); }
        fs.mkdirSync(dest, { recursive: true });
        const items = fs.readdirSync(cfgDir);
        for (const n of items) {
          const p = path.join(cfgDir, n);
          const st = fs.statSync(p);
          if (st.isDirectory()) fs.cpSync(p, path.join(dest, n), { recursive: true });
          else fs.copyFileSync(p, path.join(dest, n));
        }
        if (!findInTree(dest, 'dsconfig.yaml', 0)) throw new Error('安装后未找到 dsconfig.yaml');
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
        return { ok: true, kind: 'voicebank', name, dir: dest, size: dirBytes(dest) };
      } finally {
        try { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
      }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('diffsinger:deleteVoicebank', async (_e, dir) => {
    try {
      if (!dir || typeof dir !== 'string') return { ok: false, error: '参数错误' };
      const rootResolved = path.resolve(vbRoot());
      const resolved = path.resolve(dir);
      if (!resolved.startsWith(rootResolved + path.sep)) return { ok: false, error: '只能删除已导入的声库目录' };
      if (!fs.existsSync(resolved)) return { ok: false, error: '声库不存在' };
      fs.rmSync(resolved, { recursive: true, force: true });
      // 清理可能残留的空父目录（声库根在子目录时）
      let cur = path.dirname(resolved);
      while (cur.length > rootResolved.length) {
        try {
          if (fs.readdirSync(cur).length) break;
          fs.rmdirSync(cur);
        } catch (e) { break; }
        cur = path.dirname(cur);
      }
      return { ok: true, dir: resolved };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  /* ---------------- 公开声库下载 ---------------- */
  ipcMain.handle('diffsinger:voicebankRegistry', () => {
    try {
      return {
        ok: true, dir: vbRoot(),
        list: VB_REGISTRY.map((it) => {
          const installed = vbInstalled(it);
          return {
            id: it.id, name: it.name, author: it.author, lang: it.lang, desc: it.desc,
            license: it.license, officialUrl: it.officialUrl,
            installed, dir: path.join(vbRoot(), it.dirName), size: installed ? dirBytes(path.join(vbRoot(), it.dirName)) : 0,
          };
        }),
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('diffsinger:downloadVoicebank', async (_e, id) => {
    const win = BrowserWindow.fromWebContents(_e.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('diffsinger:voicebankProgress', p); };
    const it = VB_REGISTRY.find(x => x.id === id);
    if (!it) return { ok: false, error: '未知声库: ' + id };
    if (vbInstalled(it)) {
      send({ id, percent: 100, done: true, phase: 'done' });
      return { ok: true, existed: true, name: it.name, dir: path.join(vbRoot(), it.dirName) };
    }
    if (!enabled()) return { ok: false, error: '请先启用 DiffSinger 模块' };
    const dlDir = path.join(Paths.tempDir(), 'diffsinger-dl');
    fs.mkdirSync(dlDir, { recursive: true });
    const zipPath = path.join(dlDir, it.id + '.zip');
    const entry = { isUserAbort: false };
    try {
      const vUrls = assetUrls(it);
      await downloadWithMirrors({
        urls: vUrls,
        out: zipPath,
        minSize: 5e5,
        isUserAbort: entry,
        onProgress: (p) => send({
          id, phase: 'download',
          percent: p.total ? Math.min(88, Math.round(p.received / p.total * 88)) : 0,
          received: p.received, total: p.total, done: false, error: p.error || '', host: p.host,
        }),
      });
      send({ id, phase: 'extract', percent: 90, done: false });
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const stage = path.join(dlDir, it.id + '-extract');
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
      fs.mkdirSync(stage, { recursive: true });
      zip.extractAllTo(stage, true);
      const cfgDir = findInTree(stage, 'dsconfig.yaml', 4);
      if (!cfgDir) throw new Error('声库包里没有 dsconfig.yaml（包结构可能已变更）');
      const finalDir = path.join(vbRoot(), it.dirName);
      try { fs.rmSync(finalDir, { recursive: true, force: true }); } catch (e2) {}
      fs.mkdirSync(path.dirname(finalDir), { recursive: true });
      fs.cpSync(cfgDir, finalDir, { recursive: true });
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
      try { fs.rmSync(zipPath, { force: true }); } catch (e2) {}
      if (!findInTree(finalDir, 'dsconfig.yaml', 0)) throw new Error('安装后未找到 dsconfig.yaml');
      send({ id, phase: 'done', percent: 100, done: true });
      return { ok: true, name: it.name, dir: finalDir, size: dirBytes(finalDir) };
    } catch (err) {
      send({ id, phase: 'error', percent: 0, done: true, error: String((err && err.message) || err) });
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('diffsinger:cancelVoicebankDownload', async (_e, id) => {
    const it = VB_REGISTRY.find(x => x.id === id);
    if (!it) return { ok: false, error: '未知声库' };
    const key = path.join(Paths.tempDir(), 'diffsinger-dl', it.id + '.zip');
    const ent = _dlAborts.get(key);
    if (ent) { ent.isUserAbort = true; try { ent.ctrl.abort(); } catch (e) {} }
    return { ok: true };
  });

  /* ---------------- 声库信息与渲染 ---------------- */
  // 统一的「启用 + 组件就绪」前置检查：错误信息给出分步指引
  function precheck(voicebank) {
    if (!enabled()) return { ok: false, error: 'DiffSinger 模块未启用：请到「模块与声库」页启用并安装组件' };
    if (!voicebank || typeof voicebank !== 'string' || !fs.existsSync(voicebank)) {
      return { ok: false, error: '未选择声库或声库目录不存在' };
    }
    return { ok: true };
  }

  ipcMain.handle('diffsinger:inspectVoicebank', (evt, cfg) => new Promise((resolve) => {
    const { voicebank } = cfg || {};
    const pre = precheck(voicebank);
    if (!pre.ok) return resolve(pre);
    try {
      spawnEngine(['inspect', '--voicebank', String(voicebank)], {
        script: 'engine_diffsinger.py',
        onDone: (code, r) => {
          if (r && r.result && r.result.ok) return resolve(r.result);
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-400))
            || ('引擎退出码 ' + code);
          resolve({ ok: false, error: err });
        },
        onError: (e) => resolve({ ok: false, error: String(e) }),
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  }));

  // 渲染 DiffSinger 工程 → 人声 WAV。
  // cfg = { voicebank, notes: [{startBeat, durBeat, pitch, lyric, ...}], bpm, vocoder? }
  // notes 用「拍」为单位（四分音符=1），引擎侧按 bpm 换算秒。
  ipcMain.handle('diffsinger:render', (evt, cfg) => new Promise((resolve) => {
    const { voicebank, notes, bpm } = cfg || {};
    const pre = precheck(voicebank);
    if (!pre.ok) return resolve(pre);
    if (!notes || !Array.isArray(notes) || !notes.length) return resolve({ ok: false, error: '没有音符可渲染' });
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('diffsinger:renderProgress', p); };
    try {
      const out = path.join(Paths.tempDir(), 'fufumidi', `diffsinger_render_${Date.now()}.wav`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const args = [
        'render',
        '--voicebank', String(voicebank),
        '--notes', JSON.stringify(notes),
        '--bpm', String(Math.max(20, Math.min(400, Number(bpm) || 120))),
        '--out', out,
      ];
      // 声码器优先级：声库自带 > 通用组件位
      const vd = vocoderDir();
      try {
        if (fs.existsSync(vd)) {
          const onnx = fs.readdirSync(vd).find(n => /\.onnx$/i.test(n));
          if (onnx) args.push('--vocoder', path.join(vd, onnx));
        }
      } catch (e) {}
      spawnEngine(args, {
        script: 'engine_diffsinger.py',
        timeoutMs: 20 * 60 * 1000,
        onProgress: (p) => { try { send(p); } catch (e) {} },
        onDone: (code, r) => {
          if (r && r.result && r.result.ok && r.result.out && fs.existsSync(r.result.out)) {
            try {
              const bytes = fs.readFileSync(r.result.out);
              return resolve({
                ok: true, out: r.result.out, duration_ms: r.result.duration_ms, bytes,
                warnings: r.result.warnings || [],
                engineVersion: r.result.engine_version || '',
              });
            } catch (e) {
              return resolve({ ok: true, out: r.result.out, error: String(e) });
            }
          }
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-600))
            || ('引擎退出码 ' + code);
          resolve({ ok: false, error: err });
        },
        onError: (e) => resolve({ ok: false, error: String(e) }),
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  }));
}

module.exports = { registerDiffsingerIpc };
