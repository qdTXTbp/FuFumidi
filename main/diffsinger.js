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
const { safeExtractAllTo } = require('./zip-safe');
const DS = require('./download-source');
const createFastDownload = require('./fast-download');

function registerDiffsingerIpc({ ipcMain, BrowserWindow, path, fs, os, app, dialog, net, spawn, spawnEngine, resolvePython, engineEnv, readSettings, writeSettings }) {

  /* ---------------- 目录与常量 ---------------- */
  const dsRoot = () => Paths.diffsingerRoot();
  const vbRoot = () => Paths.diffsingerVoicebanksDir();
  const vocoderDir = () => path.join(dsRoot(), 'vocoder');
  const runtimeFile = () => path.join(dsRoot(), 'runtime.json');

  // 通用声码器：openvpi 社区声码器项目（DiffSinger Community Vocoder Project）
  // nsf-hifigan-44.1k-hop512-128bin-2024.02（CC BY-NC-SA 4.0，非商用；许可证随包分发）
  // 注意：同名 .zip 包内只有 model.ckpt（PyTorch 权重，onnxruntime 用不了），
  // 真正带 ONNX 的是 .oudep（OpenUTAU 依赖包，实为 zip：*.onnx + vocoder.yaml + oudep.yaml + NOTICE）。
  // 双源分发（发布流程见 scripts/diffsinger-mirror/README.md）：
  //   国内 = CNB 镜像仓库 Release 资产；全球 = 同名 GitHub 自有仓库 Release；openvpi 官方仅兜底。
  // 按 settings.download_source 排序候选，失败自动换源 + 断点续传。
  const VOCODER_SPEC = {
    id: 'nsf_hifigan_44.1k_2024.02',
    name: 'NSF-HiFiGAN 通用声码器',
    note: 'openvpi 社区声码器 · 44.1kHz / 128 mel bins · 约 50 MB（.oudep） · CC BY-NC-SA 4.0（非商用）',
    tag: 'vocoder-2024.02',
    file: 'nsf_hifigan_44.1k_hop512_128bin_2024.02.oudep',
    ghUrl: 'https://github.com/FuFuCloud-mirror/DiffSinger/releases/download/vocoder-2024.02/nsf_hifigan_44.1k_hop512_128bin_2024.02.oudep',
    fallbackUrl: 'https://github.com/openvpi/vocoders/releases/download/nsf-hifigan-44.1k-hop512-128bin-2024.02/nsf_hifigan_44.1k_hop512_128bin_2024.02.oudep',
    officialUrl: 'https://github.com/openvpi/vocoders/releases',
    cnb: { repo: DS.CNB_MIRROR_REPOS.diffsinger, tag: 'vocoder-2024.02', file: 'nsf_hifigan_44.1k_hop512_128bin_2024.02.oudep' },
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
  // ★ 模块**默认启用、不再需要手动点一次「启用模块」**。
  //   这里恒为 true：老用户 settings.json 里可能存着 diffsinger_enabled=false，
  //   若还按它拦截，那些人升级后会突然"AI 歌声合成不可用" —— 所以彻底不再据此拦截。
  //   `diffsinger:setEnabled` 仍保留（前端还有「禁用」开关），但它只影响显式关闭。
  const enabled = () => true;
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

  /** 剥掉压缩包/文件夹外层多余的包裹目录：返回真正含内容的目录 */
  function stripWrapperDir(dir, maxDepth = 3) {
    let cur = dir;
    for (let i = 0; i < maxDepth; i++) {
      let entries = [];
      try { entries = fs.readdirSync(cur); } catch (e) { return cur; }
      const dirs = [], files = [];
      for (const n of entries) {
        try { (fs.statSync(path.join(cur, n)).isDirectory() ? dirs : files).push(n); } catch (e) {}
      }
      // 平台噪音目录忽略（macOS zip 会带 __MACOSX）
      const realDirs = dirs.filter(n => n !== '__MACOSX' && !n.startsWith('.'));
      if (realDirs.length !== 1 || files.length) return cur;
      const cand = path.join(cur, realDirs[0]);
      // 只有候选里才有「实质内容」时才继续下钻
      let inner = [];
      try { inner = fs.readdirSync(cand); } catch (e) { return cur; }
      const hasPayload = inner.some(n => /dsconfig\.ya?ml$/i.test(n) || /\.onnx$/i.test(n))
        || inner.some(n => { try { return fs.statSync(path.join(cand, n)).isDirectory(); } catch (e) { return false; } });
      if (!hasPayload) return cur;
      cur = cand;
    }
    return cur;
  }

  /** 在目录树里定位声库根（含 dsconfig.yaml 且不是子模型目录的那层）
   *  返回 { root, name } 或 null。优先选层级最浅的那个（避免误命中 dsdur/dspitch 子配置）。 */
  function detectVoicebankRoot(start) {
    const found = [];
    const walk = (d, depth) => {
      if (depth > 4) return;
      let entries = [];
      try { entries = fs.readdirSync(d); } catch (e) { return; }
      if (entries.includes('dsconfig.yaml')) {
        const score = voicebankRootScore(d);
        if (score > 0) found.push({ root: d, depth, score });
        return; // 命中就不再往这个子树里找（子模型目录另有自己的 dsconfig）
      }
      for (const n of entries) {
        if (n === '__MACOSX' || n.startsWith('.')) continue;
        const p = path.join(d, n);
        let isDir = false;
        try { isDir = fs.statSync(p).isDirectory(); } catch (e) { continue; }
        if (isDir) walk(p, depth + 1);
      }
    };
    walk(start, 0);
    if (!found.length) return null;
    found.sort((a, b) => (b.score - a.score) || (a.depth - b.depth));

    // 声库显示名：character.txt 的 name= 优先，其次 dsconfig 的 name，最后目录名
    const best = found[0].root;
    let name = '';
    try {
      const ct = path.join(best, 'character.txt');
      if (fs.existsSync(ct)) {
        const m = fs.readFileSync(ct, 'utf8').match(/^\s*name\s*=\s*(.+?)\s*$/mi);
        if (m) name = m[1].trim();
      }
    } catch (e) {}
    if (!name) {
      try {
        const y = fs.readFileSync(path.join(best, 'dsconfig.yaml'), 'utf8');
        const m = y.match(/^\s*name\s*:\s*(.+?)\s*$/mi);
        if (m) name = m[1].replace(/^["']|["']$/g, '').trim();
      } catch (e) {}
    }
    if (!name) name = path.basename(best);
    return { root: best, name };
  }

  /** 给一个 dsconfig.yaml 所在目录打分：主声库根的特征（有 acoustic / 顶层 onnx）分高 */
  function voicebankRootScore(dir) {
    let score = 0;
    let cfg = '';
    try { cfg = fs.readFileSync(path.join(dir, 'dsconfig.yaml'), 'utf8'); } catch (e) { return 0; }
    // 主声库根：dsconfig 里带 acoustic 字段，且同级目录有 onnx
    if (/^\s*acoustic\s*:/mi.test(cfg)) score += 10;
    if (/^\s*(vocoder|sample_rate|hop_size)\s*:/mi.test(cfg)) score += 2;
    try {
      if (fs.readdirSync(dir).some(n => /\.onnx$/i.test(n))) score += 5;
    } catch (e) {}
    const base = path.basename(dir).toLowerCase();
    // 子模型目录明显不是根
    if (/^(dsdur|dspitch|dsvariance|dsvocoder|dsacoustic)$/.test(base)) score -= 20;
    return score;
  }

  /** 汇总声库内识别到的模型与词典，用于导入后展示 / 排查 */
  function collectModelSummary(root) {
    const models = { acoustic: '', linguistic: '', dur: '', pitch: '', variance: '', vocoder: '', hasVocoderDir: false };
    const files = [];
    const walk = (d, depth) => {
      if (depth > 3) return;
      let entries = [];
      try { entries = fs.readdirSync(d); } catch (e) { return; }
      for (const n of entries) {
        const p = path.join(d, n);
        let isDir = false;
        try { isDir = fs.statSync(p).isDirectory(); } catch (e) { continue; }
        if (isDir) { walk(p, depth + 1); continue; }
        if (/\.onnx$/i.test(n)) files.push({ name: n, rel: path.relative(root, p).replace(/\\/g, '/'), size: (() => { try { return fs.statSync(p).size; } catch (e) { return 0; } })() });
      }
    };
    walk(root, 0);
    const pick = (re) => { const f = files.find(f => re.test(f.rel) || re.test(f.name)); return f ? f.rel : ''; };
    models.acoustic = pick(/aco|acoustic/i);
    models.linguistic = pick(/linguistic/i);
    models.dur = pick(/(^|[/\\])dur|\.dur\./i);
    models.pitch = pick(/\.pitch\.|pit\.|pitch_/i);
    models.variance = pick(/variance|var\./i);
    models.vocoder = pick(/hifigan|vocoder|dspvocoder/i);
    models.hasVocoderDir = fs.existsSync(path.join(root, 'dsvocoder'));
    models.totalOnnx = files.length;
    models.files = files.slice(0, 40);
    return models;
  }

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

  /* ---------------- 通用下载器（多源测速选最快 + 分段并发 + 断点续传） ----------------
     实现见 main/fast-download.js，与「模型下载」共用同一条链路。

     为什么换掉旧实现：旧版是「按固定顺序单连接 + 25 秒无字节才换源」，在真实网络下
     表现为「有时 50MB/s、有时几百 KB」—— 只要排在第一位的源只是**慢**（而不是断），
     看门狗永远不触发，于是一路以几百 KB/s 爬完整个上百 MB 的声库包。
     现在改为：① 各候选源先用一小段实测速度，按速度选最快的；② 支持 Range 的源
     切 4 段并发下载（对象存储/Release 单连接普遍被限速）；③ 单连接兜底路径里再加
     「低速轮换」，慢源会被主动放弃并换到下一个（已下字节通过 .part 续传）。 */
  const _dlAborts = new Map();
  const FastDL = createFastDownload({ net, fs, path });

  async function downloadWithMirrors({ urls, out, minSize, onProgress, isUserAbort }) {
    const entry = isUserAbort || {};
    return await FastDL.downloadFast({
      urls,
      dest: out,
      minSize,
      headers: { 'user-agent': 'FuFumidi' },
      isUserAbort: entry,
      ctrl: entry.ctrl || null,
      onProgress,
    });
  }

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

  ipcMain.handle('diffsinger:status', async (_evt, opts) => {
    try {
      const enabledNow = enabled();
      // force：跳过 30s 短缓存重新探测。GPU 增强包安装/卸载后必须用它，
      // 否则「推理后端」会继续显示安装前的 provider 列表（用户以为没生效）。
      const force = !!(opts && opts.force);
      const deps = enabledNow ? await checkDeps(force) : { ok: false, missing: DS_PY_DEPS, installed: [], skipped: true };
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
        gpu: deps.gpu || null,
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
  // 组件安装的中止信号：旧实现只用 _runtimeBusy.active 当「忙碌」标志，
  // 而下载器读的是 .aborted —— 两边对不上，导致「取消安装」对声码器下载完全无效。
  const _runtimeAbort = { aborted: false, ctrl: null };
  ipcMain.handle('diffsinger:installRuntime', async (evt) => {
    if (!enabled()) return { ok: false, error: '请先启用 DiffSinger 模块' };
    if (_runtimeBusy.active) return { ok: false, error: '组件安装已在进行中' };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('diffsinger:runtimeProgress', p); };
    _runtimeBusy.active = true;
    _runtimeAbort.aborted = false;
    _runtimeAbort.ctrl = new AbortController();
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
        send({ phase: 'vocoder', percent: 0, text: '正在下载通用声码器（NSF-HiFiGAN，约 50 MB）…', done: false });
        const dlDir = path.join(Paths.tempDir(), 'diffsinger-dl');
        fs.mkdirSync(dlDir, { recursive: true });
        const zipPath = path.join(dlDir, 'vocoder.zip');
        const vUrls = assetUrls(VOCODER_SPEC);
        _dlAborts.set(zipPath, _runtimeAbort);
        try {
          await downloadWithMirrors({
            urls: vUrls,
            out: zipPath,
            minSize: 1e6,
            isUserAbort: _runtimeAbort,
            onProgress: (p) => send({
              phase: 'vocoder', percent: p.total ? Math.min(96, Math.round(p.received / p.total * 96)) : 0,
              received: p.received, total: p.total, host: p.host,
              text: p.text || p.error || ('当前源：' + sourceLabelOf(vUrls)),
              speed: p.speed || 0, done: false,
            }),
          });
        } finally { _dlAborts.delete(zipPath); }
        send({ phase: 'vocoder', percent: 97, text: '正在解压声码器…', done: false });
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(zipPath);
        const stage = path.join(dlDir, 'vocoder-extract');
        try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
        fs.mkdirSync(stage, { recursive: true });
        const _zsafe = safeExtractAllTo(zip, stage);

        if (!_zsafe.ok) throw new Error('压缩包安全校验未通过：' + _zsafe.error);
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
      const canceled = !!(err && err.cancelled) || _runtimeAbort.aborted;
      send({ phase: canceled ? 'canceled' : 'error', percent: 0, text: canceled ? '已取消安装' : msg, done: true });
      return { ok: false, error: canceled ? '' : msg, canceled };
    } finally {
      _runtimeBusy.active = false;
      _runtimeAbort.aborted = false;
      _runtimeAbort.ctrl = null;
      _dlAborts.delete(path.join(Paths.tempDir(), 'diffsinger-dl', 'vocoder.zip'));
    }
  });

  ipcMain.handle('diffsinger:cancelRuntimeInstall', async () => {
    _runtimeAbort.aborted = true;   // 让下载器（而不是只看 active 标志）真正感知中止
    _runtimeBusy.active = false;
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

  // 导入本地声库：zip / .oudep（依赖包）/ 已解压的文件夹
  // directPath：拖拽导入时由渲染端传入，跳过文件对话框
  ipcMain.handle('diffsinger:importVoicebankZip', async (_e, directPath) => {
    try {
      let picked = null;
      if (directPath && typeof directPath === 'string' && fs.existsSync(directPath)) {
        picked = directPath;
      } else {
        const r = await dialog.showOpenDialog({
          properties: ['openFile', 'openDirectory'],
          filters: [{ name: 'DiffSinger 声库', extensions: ['zip', 'oudep'] }],
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
        picked = r.filePaths[0];
      }

      const isDir = (() => { try { return fs.statSync(picked).isDirectory(); } catch (e) { return false; } })();
      const isOudep = /\.oudep$/i.test(picked);
      let stage = null;
      let cleanupStage = false;

      if (!isDir) {
        if (!/\.(zip|oudep)$/i.test(picked)) {
          return { ok: false, error: '不支持的文件类型：请选择 .zip / .oudep 声库包，或直接选择已解压的声库文件夹' };
        }
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(picked);
        const dlDir = path.join(Paths.tempDir(), 'diffsinger-dl');
        fs.mkdirSync(dlDir, { recursive: true });
        stage = path.join(dlDir, 'import-' + Date.now());
        const _zsafe = safeExtractAllTo(zip, stage);

        if (!_zsafe.ok) throw new Error('压缩包安全校验未通过：' + _zsafe.error);
        cleanupStage = true;
      } else {
        stage = picked;
      }

      try {
        // ---- 依赖包（.oudep）：装到通用声码器位 ----
        if (isOudep) {
          const src = stripWrapperDir(stage);
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
          return { ok: true, kind: 'vocoder', name: path.basename(picked), dir: vDir };
        }

        // ---- 声库包：定位含 dsconfig.yaml 的目录 ----
        const info = detectVoicebankRoot(stage);
        if (!info) {
          throw new Error('没有找到 dsconfig.yaml。请确认这是 DiffSinger / OpenUTAU 声库（压缩包内应含 dsconfig.yaml 与 *.onnx），或直接选择已解压的声库文件夹');
        }
        const { root: cfgDir, name: detectedName } = info;

        // 名字优先级：压缩包/文件夹名 → character.txt 的 name= → dsconfig 的 name
        let name = isDir
          ? path.basename(picked.replace(/[/\\]+$/, ''))
          : path.basename(picked, path.extname(picked));
        name = String(name || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
        if (!name) name = detectedName || ('voicebank_' + Date.now());

        if (isDir && path.resolve(cfgDir) === path.resolve(picked)) {
          // 用户直接选了「已经是声库根」的文件夹：复制一份到声库库，不原地注册
        }
        const root = vbRoot();
        fs.mkdirSync(root, { recursive: true });
        let dest = path.join(root, name);
        let i = 2;
        while (fs.existsSync(dest)) { dest = path.join(root, name + '_' + i++); }

        fs.mkdirSync(dest, { recursive: true });
        for (const n of fs.readdirSync(cfgDir)) {
          const p = path.join(cfgDir, n);
          let st;
          try { st = fs.statSync(p); } catch (e) { continue; }
          const target = path.join(dest, n);
          if (st.isDirectory()) fs.cpSync(p, target, { recursive: true });
          else fs.copyFileSync(p, target);
        }

        const check = detectVoicebankRoot(dest);
        if (!check) throw new Error('安装后未找到 dsconfig.yaml（可能解压失败或权限不足）');

        // 收集声库摘要，便于前端展示与排查
        const models = collectModelSummary(dest);
        return {
          ok: true, kind: 'voicebank', name, dir: dest, size: dirBytes(dest),
          models, detectedName, fromDir: isDir,
        };
      } finally {
        if (cleanupStage) {
          try { if (stage && fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
        }
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
    const entry = { isUserAbort: false, aborted: false, ctrl: new AbortController() };
    _dlAborts.set(zipPath, entry);
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
          received: p.received, total: p.total, done: false,
          error: p.error || '', host: p.host, speed: p.speed || 0,
          text: p.text || (p.error ? '' : (p.host ? ('来源 ' + p.host) : '')),
        }),
      });
      send({ id, phase: 'extract', percent: 90, done: false });
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const stage = path.join(dlDir, it.id + '-extract');
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
      fs.mkdirSync(stage, { recursive: true });
      const _zsafe = safeExtractAllTo(zip, stage);

      if (!_zsafe.ok) throw new Error('压缩包安全校验未通过：' + _zsafe.error);
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
      const canceled = !!(err && err.cancelled) || entry.aborted;
      const msg = canceled ? '' : String((err && err.message) || err);
      send({ id, phase: canceled ? 'canceled' : 'error', percent: 0, done: true, error: msg, canceled });
      return { ok: false, error: msg, canceled };
    } finally {
      _dlAborts.delete(zipPath);
    }
  });

  ipcMain.handle('diffsinger:cancelVoicebankDownload', async (_e, id) => {
    const it = VB_REGISTRY.find(x => x.id === id);
    if (!it) return { ok: false, error: '未知声库' };
    const key = path.join(Paths.tempDir(), 'diffsinger-dl', it.id + '.zip');
    const ent = _dlAborts.get(key);
    // ent 就是下载器持有的那个 entry，标记 + abort 都能被立刻感知
    if (ent) { ent.isUserAbort = true; ent.aborted = true; try { ent.ctrl.abort(); } catch (e) {} }
    return { ok: true };
  });

  /* ---------------- ModelScope 声库目录（资源中心 · 模型管理 → DiffSinger） ---------------- */
  // 数据源：ModelScope aihobbyist/ACG-DiffSinger-VoiceDB（作者 @红血球AE3803，CC-BY-NC-4.0）。
  // 清单一律由 scripts/diffsinger-ms/sync.mjs 从官方 API 抽取生成到 diffsinger-ms-catalog.js，
  // UI 只消费生成的静态模块 —— 保证「完整列出、不遗漏、不截断」，且可随上游更新一键同步。
  // 下载地址全部为 ModelScope 官方直连（全球同源），不做任何镜像替换。
  const MSCat = (() => { try { return require('./diffsinger-ms-catalog'); } catch (e) { return null; } })();

  ipcMain.handle('diffsinger:msCatalog', () => {
    try {
      if (!MSCat) return { ok: false, error: '声库目录数据缺失（请重新构建应用）' };
      const root = vbRoot();
      const installedNames = (() => {
        try {
          if (!fs.existsSync(root)) return new Set();
          return new Set(fs.readdirSync(root).filter((n) => {
            try { return fs.statSync(path.join(root, n)).isDirectory(); } catch (e) { return false; }
          }));
        } catch (e) { return new Set(); }
      })();
      const works = MSCat.WORKS.map((w) => ({
        id: w.id,
        label: w.label,
        source: w.source,
        categories: w.categories.map((c) => ({
          source: c.source,
          label: c.label,
          desc: c.desc,
          models: c.models.map((m) => ({
            name: m.name,
            work: m.work,
            workId: m.workId,
            category: m.category,
            desc: m.desc,
            path: m.path,
            size: m.size,
            placeholder: !!m.placeholder,
            url: m.url,
            installed: installedNames.has(m.name),
          })),
        })),
      }));
      return {
        ok: true,
        repo: MSCat.MS_REPO,
        repoUrl: `https://www.modelscope.cn/models/${MSCat.MS_REPO.owner}/${MSCat.MS_REPO.name}`,
        author: '@红血球AE3803',
        license: 'CC-BY-NC-4.0（非商用）',
        stats: MSCat.STATS,
        works,
        dir: root,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 直连 ModelScope 官方地址下载声库，下载完自动解压并注册到本地声库库。
  // cfg: { name, path, url?, size? }（url 缺省时按上游路径现算，确保始终指向官方地址）
  //
  // 进度双通道：
  //   - `diffsinger:msProgress` 给资源中心板块内部用（含 phase，区分下载/解压）；
  //   - `model:progress`        给全局顶部下载通知条用（与常规模型下载同一条链路），
  //     因此 AI 声库下载同样拥有弹窗、实时速度、展开面板与进出动画。
  ipcMain.handle('diffsinger:msDownload', async (_e, cfg) => {
    const win = BrowserWindow.fromWebContents(_e.sender);
    const name = String((cfg && cfg.name) || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim();
    const id = name || ('ms_' + Date.now());
    const evtId = 'dsms:' + id;   // 顶部通知条用独立命名空间，避免与模型 id 撞车
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('diffsinger:msProgress', { id, ...p }); };
    // label 供全局下载通知条显示（形如「神里绫华（原神）」），比裸 id 可读
    const recForLabel = MSCat ? MSCat.BY_PATH.get(String((cfg && cfg.path) || '')) : null;
    const gLabel = recForLabel ? (recForLabel.name + (recForLabel.work ? '（' + recForLabel.work + '）' : '')) : id;
    const sendG = (p) => { if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: evtId, label: gLabel, ...p }); };
    // 解压/拷贝阶段没有字节进度，用匀速爬条填充这段等待，避免界面看起来卡住
    let compressTimer = null;
    const startCompressTicker = (label, from, to) => {
      stopCompressTicker();
      let pct = from;
      send({ phase: 'extract', percent: pct, text: label, done: false });
      sendG({ received: 1, total: 1, percent: pct, done: false, text: label, speed: 0 });
      compressTimer = setInterval(() => {
        pct = Math.min(to, pct + Math.max(0.4, (to - pct) * 0.18));
        send({ phase: 'extract', percent: Math.round(pct), text: label, done: false });
        sendG({ received: 1, total: 1, percent: Math.round(pct), done: false, text: label, speed: 0 });
      }, 400);
    };
    const stopCompressTicker = () => { if (compressTimer) { clearInterval(compressTimer); compressTimer = null; } };
    // ★ `zipPath` / `entry` 必须在 `try` **之外**声明：下面的 `finally` 要引用它们。
    //   放在 `try` 里的 `const` 对 `finally` 不可见 → 每次跑到 `finally` 必抛
    //   "zipPath is not defined"，并把**已经成功的结果一起顶掉**（表现为下载完却报错）。
    let zipPath = '';
    let entry = null;
    try {
      if (!MSCat) return { ok: false, error: '声库目录数据缺失（请重新构建应用）' };
      const rec = MSCat.BY_PATH.get(String((cfg && cfg.path) || ''));
      if (!rec) return { ok: false, error: '目录中不存在该声库条目' };
      if (rec.placeholder) return { ok: false, error: '该声库在上游仓库中尚未上传权重（仅占位文件），暂不可下载' };
      if (!enabled()) return { ok: false, error: '请先启用 DiffSinger 模块' };

      const dlDir = path.join(Paths.tempDir(), 'diffsinger-dl');
      fs.mkdirSync(dlDir, { recursive: true });
      zipPath = path.join(dlDir, 'ms-' + id + '.zip');
      entry = { isUserAbort: false, aborted: false, ctrl: new AbortController() };
      _dlAborts.set(zipPath, entry);
      // 直连官方地址；不追加任何镜像候选，保证全球同源一致
      const url = rec.url || MSCat.msFileUrl(rec.path);
      const totalHint = Number(rec.size) || 0;
      send({ phase: 'download', percent: 0, received: 0, total: totalHint, text: '正在连接 ModelScope 官方源…', done: false });
      sendG({ received: 0, total: totalHint, percent: 0, done: false, text: 'ModelScope 官方源 · ' + (rec.category || ''), speed: 0 });

      // 速度由下载器直接给出（多源测速 / 分段并发都在下载器内部完成，这里不再自算）
      await downloadWithMirrors({
        urls: [url],
        out: zipPath,
        minSize: 1e5,
        isUserAbort: entry,
        onProgress: (p) => {
          const pct = p.total ? Math.min(88, Math.round((p.received / p.total) * 88)) : 0;
          send({
            phase: 'download', percent: pct, received: p.received, total: p.total || totalHint,
            speed: p.speed || 0, text: p.text || p.error || '', done: false, host: p.host,
          });
          sendG({
            received: p.received, total: p.total || totalHint, percent: pct, done: false,
            speed: p.speed || 0, text: p.text || p.error || (p.host ? ('来源 ' + p.host) : ''), host: p.host,
          });
        },
      });
      startCompressTicker('正在解压声库包…', 88, 94);
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const stage = path.join(dlDir, 'ms-' + id + '-extract');
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
      fs.mkdirSync(stage, { recursive: true });
      const _zsafe = safeExtractAllTo(zip, stage);

      if (!_zsafe.ok) throw new Error('压缩包安全校验未通过：' + _zsafe.error);
      send({ phase: 'extract', percent: 94, text: '正在校验声库结构…', done: false });
      const cfgDir = findInTree(stage, 'dsconfig.yaml', 4);
      if (!cfgDir) throw new Error('声库包里没有 dsconfig.yaml（包结构可能已变更）');
      startCompressTicker('正在安装到声库目录…', 95, 99);
      const root = vbRoot();
      fs.mkdirSync(root, { recursive: true });
      let finalDir = path.join(root, id);
      let i = 2;
      while (fs.existsSync(finalDir)) { finalDir = path.join(root, id + '_' + i++); }
      fs.cpSync(cfgDir, finalDir, { recursive: true });
      try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
      try { fs.rmSync(zipPath, { force: true }); } catch (e2) {}
      if (!findInTree(finalDir, 'dsconfig.yaml', 0)) throw new Error('安装后未找到 dsconfig.yaml');
      stopCompressTicker();
      send({ phase: 'done', percent: 100, text: '安装完成', done: true });
      sendG({ received: 1, total: 1, percent: 100, done: true, text: '安装完成', speed: 0 });
      return { ok: true, name: id, dir: finalDir, size: dirBytes(finalDir), source: 'modelscope' };
    } catch (err) {
      stopCompressTicker();
      const canceled = !!(err && err.cancelled) || !!(entry && (entry.isUserAbort || entry.aborted));
      const msg = canceled ? '' : String((err && err.message) || err);
      send({ phase: canceled ? 'canceled' : 'error', percent: 0, done: true, error: msg });
      sendG({ received: 0, total: 0, percent: 0, done: true, error: msg, canceled, speed: 0 });
      return { ok: false, error: msg, canceled };
    } finally {
      _dlAborts.delete(zipPath);
    }
  });

  ipcMain.handle('diffsinger:msCancelDownload', (_e, name) => {
    const id = String(name || '');
    const key = path.join(Paths.tempDir(), 'diffsinger-dl', 'ms-' + id + '.zip');
    const ent = _dlAborts.get(key);
    if (ent) { ent.isUserAbort = true; ent.aborted = true; try { ent.ctrl.abort(); } catch (e) {} }
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

  // 歌词输入建议（仿 SV2 的「输入即候选」）。
  // cfg = { text, language, voicebank }
  // ★ language 是**轨道级**设置（照搬新版上游 USingerTrack.Language），
  //   不从歌词自动判断 —— 与 OpenUtau 一致。
  ipcMain.handle('diffsinger:suggestLyric', (evt, cfg) => new Promise((resolve) => {
    const c = cfg || {};
    const args = ['suggest', String(c.text == null ? '' : c.text)];
    if (c.language) args.push('--language', String(c.language));
    if (c.voicebank) args.push('--voicebank', String(c.voicebank));
    args.push('--limit', String(c.limit || 12));
    try {
      spawnEngine(args, {
        script: 'engine_diffsinger.py',
        onDone: (code, r) => {
          if (r && r.result && r.result.ok) return resolve(r.result);
          resolve({ ok: false, items: [], error: (r && r.result && r.result.error) || ('引擎退出码 ' + code) });
        },
        onError: (e) => resolve({ ok: false, items: [], error: String(e) }),
      });
    } catch (err) {
      resolve({ ok: false, items: [], error: String((err && err.message) || err) });
    }
  }));

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
    const range = (cfg && cfg.range) || null;
    const device = (cfg && cfg.device) || 'auto';
    const pitchCurve = (cfg && cfg.pitchCurve) || null;   // P3 音高曲线：[{beat, cents}]
    const pre = precheck(voicebank);
    if (!pre.ok) return resolve(pre);
    if (!notes || !Array.isArray(notes) || !notes.length) return resolve({ ok: false, error: '没有音符可渲染' });
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { if (win && !win.isDestroyed()) win.webContents.send('diffsinger:renderProgress', p); };
    let notesJson = null;   // 长音符序列的临时落盘文件，渲染结束（成功或失败）都要回收
    // 统一出口：清理临时音符文件后再 resolve，避免长曲反复渲染堆积垃圾
    const done = (r) => {
      if (notesJson) { try { fs.unlinkSync(notesJson); } catch (e) {} notesJson = null; }
      resolve(r);
      return undefined;
    };
    try {
      const out = path.join(Paths.tempDir(), 'fufumidi', `diffsinger_render_${Date.now()}.wav`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // 音符序列走「@临时文件」而不是命令行字面量：
      // Windows CreateProcess 的命令行上限约 32K 字符，而 DiffSinger 每个音符要带
      // 颤音/音分等 10 个字段（约 150 字节），整曲（数百音符）必然触发
      // spawn ENAMETOOLONG。engine_utau.py 早已采用同一约定（--notes @file）。
      notesJson = path.join(Paths.tempDir(), 'fufumidi', `diffsinger_notes_${Date.now()}_${process.pid}.json`);
      // 有音高曲线时载荷升级为 {notes, pitchCurve}（引擎兼容裸 list，见 engine_diffsinger.py）
      fs.writeFileSync(notesJson, JSON.stringify(
        (pitchCurve && pitchCurve.length) ? { notes, pitchCurve } : notes
      ), 'utf8');
      const params = (cfg && cfg.params) || {};
      const args = [
        'render',
        '--voicebank', String(voicebank),
        '--notes', '@' + notesJson,
        '--bpm', String(Math.max(20, Math.min(400, Number(bpm) || 120))),
        '--out', out,
      ];
      // ★ 轨道级参数（前端 singer.ts 一直在发 params）：以前整包丢掉，
      //   多语声库因此永远按 zh 音素化、采样深度/步数也调不动。
      if (params.language) args.push('--language', String(params.language));
      if (Number.isFinite(Number(params.depth))) args.push('--depth', String(Number(params.depth)));
      if (Number.isFinite(Number(params.steps))) args.push('--steps', String(Math.round(Number(params.steps))));
      // 范围渲染：只合成选区内音符（带前后文），未传或 full 时整曲渲染
      let rangeArg = null;
      if (range && !range.full && range.startBeat != null && range.endBeat != null
          && Number(range.endBeat) > Number(range.startBeat)) {
        rangeArg = { startBeat: Number(range.startBeat), endBeat: Number(range.endBeat) };
        args.push('--start-beat', String(rangeArg.startBeat), '--end-beat', String(rangeArg.endBeat));
        const ctx = range.contextSec == null ? 0.5 : Math.max(0, Math.min(10, Number(range.contextSec)));
        args.push('--context-sec', String(ctx));
      }
      // 推理后端：auto 交给引擎按可用性自动选择（GPU 优先）
      if (device && device !== 'auto') args.push('--device', String(device));
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
              return done({
                ok: true, out: r.result.out, duration_ms: r.result.duration_ms, bytes,
                warnings: r.result.warnings || [],
                engineVersion: r.result.engine_version || '',
                pipeline: r.result.pipeline || '',
                device: r.result.device || null,
                range: r.result.range || null,
              });
            } catch (e) {
              return done({ ok: true, out: r.result.out, error: String(e) });
            }
          }
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-600))
            || ('引擎退出码 ' + code);
          done({ ok: false, error: err });
        },
        onError: (e) => done({ ok: false, error: String(e) }),
      });
    } catch (err) {
      done({ ok: false, error: String((err && err.message) || err) });
    }
  }));

  /* ---------------- 统一声库清单（UTAU + DiffSinger 融合） ---------------- */
  // 音频制作侧允许在 UTAU 声库与 DiffSinger AI 声库之间切换；两个工作台共享同一份
  // 清单，避免各自维护一套列表。返回每条带 kind 标签：
  //   kind: 'utau' | 'diffsinger'
  // UTAU 声库来自 Paths.voicebanksDir()，DiffSinger 来自 Paths.diffsingerVoicebanksDir()。
  ipcMain.handle('voicebank:unified', () => {
    const scan = (root, kind) => {
      const out = [];
      try {
        if (!root || !fs.existsSync(root)) return out;
        for (const name of fs.readdirSync(root)) {
          const dir = path.join(root, name);
          try { if (!fs.statSync(dir).isDirectory()) continue; } catch (e) { continue; }
          // DiffSinger 声库必须含 dsconfig.yaml 才算有效
          let ok = true;
          if (kind === 'diffsinger') {
            try {
              if (!fs.existsSync(path.join(dir, 'dsconfig.yaml'))
                  && !findInTree(dir, 'dsconfig.yaml', 1)) ok = false;
            } catch (e) { ok = false; }
          }
          if (!ok) continue;
          let size = 0;
          try { size = dirBytes(dir); } catch (e) {}
          out.push({ kind, name, dir, size, id: kind + ':' + name });
        }
      } catch (e) {}
      return out;
    };
    // 两侧各自容错：任一目录不可访问（未创建 / 权限）时不连累另一侧
    let utauRoot = '', dsRoot = '';
    try { utauRoot = Paths.voicebanksDir(); } catch (e) {}
    try { dsRoot = Paths.diffsingerVoicebanksDir(); } catch (e) {}
    try {
      const utau = scan(utauRoot, 'utau');
      const ds = scan(dsRoot, 'diffsinger');
      return {
        ok: true,
        list: [...utau, ...ds],
        utauRoot,
        diffsingerRoot: dsRoot,
        utauCount: utau.length,
        diffsingerCount: ds.length,
      };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });
}

module.exports = { registerDiffsingerIpc };
