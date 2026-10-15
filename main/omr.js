// ============================================================
// 识谱增强引擎（Audiveris）的检测 / 安装 / 卸载
// ============================================================
// 为什么要「应用内装」而不是让用户自己下：
//   自带经典识谱在低清谱面上变化音几乎认不出来（实测 6 页只认出 8~62 个），
//   换成 Audiveris 后同一份谱面音符数 2062、结构和时值都正确 —— 差别是量级。
//   但它是 81MB 的外部程序（Java 生态），不能塞进安装包，所以做成可选增强包：
//   用户在「变谱」页看到提示 → 一键下载 → 免安装解包到数据根目录 → 立刻可用。
//
// ★ 用 MSI 的 administrative install（msiexec /a ... TARGETDIR=...）解包，不写注册表、
//   不装进 Program Files，卸载就是删目录（实测可行，且不需要管理员权限）。
'use strict';
const { spawn, execFile } = require('child_process');
const Paths = require('./paths');
const createFastDownload = require('./fast-download');

const VERSION = '5.11.0';
const MSI_NAME = 'Audiveris-5.11.0-windowsConsole-x86_64.msi';
// 上游发布物的固定指纹（2026-10-13 实测）
const MSI_BYTES = 85062430;
const MSI_SHA256 = '5f1b4e96a12c53c7da426814b76e599363c4181e291855996e0a6878dda95f71';
const MSI_URL = 'https://github.com/Audiveris/audiveris/releases/download/' + VERSION + '/' + MSI_NAME;
// ★ 通道列表（2026-10-13 加）：直链在部分网络下被限到 **30 KB/s**（本机实测 0.03 MB/s），
//   81 MB 要走约 45 分钟 —— 而本文件的看门狗 15 秒无数据就放弃，用户很可能装不上。
//   走镜像实测 **1.12 MB/s，约 37 倍**。顺序不重要：downloadFast 会先给各通道测速再选最快的，
//   失败才按序回退。镜像写法与 scripts/bundle-python312.js 的 GIT_MIRRORS、mirror-to-cnb.mjs 一致。
const MSI_URLS = [
  MSI_URL,
  'https://ghfast.top/' + MSI_URL,
  'https://gh-proxy.com/' + MSI_URL,
  'https://gh.jasonzeng.dev/' + MSI_URL,
];

function engineDir() { return require('path').join(Paths.dataRoot(), 'omr', 'audiveris'); }
function exePath() { return require('path').join(engineDir(), 'Audiveris', 'Audiveris.exe'); }

/* ------------------------------------------------------------------
 * OCR 语言包（Tesseract traineddata）
 *
 * ★ 为什么需要独立管：Audiveris 5.5 起不再预装任何 OCR 语言（官方文档明说），
 *   而没有语言时它的 TEXTS 步会被整段跳过 —— 速度记号、乐器名、和弦名一个都读不到。
 *   实测（本机安装目录里 0 个 *.traineddata）：日志 No installed OCR languages，
 *   把 TESSDATA_PREFIX 指到我们自己的 tessdata 后变成 Installed OCR languages: eng，
 *   并真的跑起 TEXTS 步。语言包只有几 MB —— 小体积换大信息量。
 *
 * 目录：<数据根>/omr/tessdata/<code>.traineddata，由引擎侧以 TESSDATA_PREFIX 指过去，
 * 不写进 Audiveris 安装目录（它卸载/重装就没了）。
 * ------------------------------------------------------------------ */
function tessDir() { return require('path').join(Paths.dataRoot(), 'omr', 'tessdata'); }
const LANG_CATALOG = [
  { code: 'eng', name: '英语（速度记号、力度、乐器名多为英文缩写）' },
  { code: 'chi_sim', name: '简体中文（标题、中文乐器名）' },
  { code: 'chi_tra', name: '繁体中文' },
  { code: 'jpn', name: '日语' },
];
// ★ 必须用**完整版** tessdata，不能用 tessdata_fast：
//   Audiveris 是用 Tesseract 的 legacy 模式初始化的，而 tessdata_fast 只有 LSTM 权重 ——
//   实测装 fast 版会得到「Installed OCR languages: eng」但紧跟着
//   `Could not initialize TessBaseAPI languages: eng in legacy mode`，识别结果与不装完全一样；
//   换成完整版（eng 约 23 MB，含 legacy + LSTM）后立刻读出了乐器名与曲目信息：
//   part-name 从清一色 Voice 变成 Flute 1,2 / Oboe1,2 / Horn (F) 1,2 / Trumpet (Bb) 1,2 …
const LANG_REPO = 'tesseract-ocr/tessdata';
const LANG_RAW = 'https://raw.githubusercontent.com/' + LANG_REPO + '/main/';
// 通道顺序按实测可用性：GitHub 直链在部分网络被墙，镜像反而稳（本机实测 ghfast 23 MB 一次成功）。
const LANG_URLS = (code) => [
  'https://ghfast.top/' + LANG_RAW + code + '.traineddata',
  'https://gh-proxy.com/' + LANG_RAW + code + '.traineddata',
  'https://gh.jasonzeng.dev/' + LANG_RAW + code + '.traineddata',
  LANG_RAW + code + '.traineddata',
];
// 低于这个体积的不是完整版（fast 版 2~4 MB，且 Audiveris 用不了）—— 装了也不算数，界面会提示重装。
const LANG_MIN_BYTES = 5 * 1024 * 1024;

function registerOmrIpc({ ipcMain, BrowserWindow, app, path, fs, shell, net, bundledPython }) {
  // 统一高速下载器（规范入口，见 docs/DOWNLOADS.md）
  const FastDL = createFastDownload({ net, fs, path });
  const status = () => {
    const exe = exePath();
    let installed = false, size = 0;
    try {
      installed = fs.existsSync(exe);
      if (installed) size = fs.statSync(exe).size;
    } catch (e) {}
    return { ok: true, installed, exe, version: VERSION, bytes: size, url: MSI_URL };
  };

  ipcMain.handle('omr:status', () => status());

  ipcMain.handle('omr:openDir', () => {
    try { fs.mkdirSync(engineDir(), { recursive: true }); shell.openPath(engineDir()); return { ok: true }; }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  /* ---- OCR 语言包：状态 / 安装 / 卸载 ---- */
  const langStatus = () => {
    const dir = tessDir();
    const installed = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (!f.toLowerCase().endsWith('.traineddata')) continue;
        const p = path.join(dir, f);
        try {
          const st = fs.statSync(p);
          if (st.size < LANG_MIN_BYTES) continue;          // 半截文件不算装好
          installed.push({ code: f.slice(0, -'.traineddata'.length), bytes: st.size });
        } catch (e) {}
      }
    } catch (e) {}
    return { ok: true, dir, installed, catalog: LANG_CATALOG };
  };
  ipcMain.handle('omr:langStatus', () => langStatus());

  ipcMain.handle('omr:langInstall', async (evt, codes) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { try { win && win.webContents.send('omr:progress', p); } catch (e) {} };
    const want = (Array.isArray(codes) ? codes : [codes])
      .map((c) => String(c || '').trim())
      .filter((c) => /^[a-z_]{2,12}$/.test(c) && LANG_CATALOG.some((x) => x.code === c));
    if (!want.length) return { ok: false, error: '没有可安装的语言代码' };
    const dir = tessDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    const added = [];
    for (let i = 0; i < want.length; i++) {
      const code = want[i];
      const base = Math.round((i / want.length) * 100);
      const span = Math.round(100 / want.length);
      send({ phase: 'lang', percent: base, text: '下载语言包 ' + code });
      const dst = path.join(dir, code + '.traineddata');
      const got = await downloadAny(LANG_URLS(code), dst, (pct) => {
        send({ phase: 'lang', percent: Math.min(99, base + Math.round(span * (pct / 100))), text: '下载语言包 ' + code });
      }, { minSize: LANG_MIN_BYTES, expectSize: 0 });
      if (!got.ok) { try { fs.rmSync(dst, { force: true }); } catch (e) {} return { ok: false, error: code + '：' + got.error }; }
      added.push(code);
    }
    send({ phase: 'done', percent: 100, text: '语言包就绪' });
    return Object.assign(langStatus(), { added });
  });

  ipcMain.handle('omr:langRemove', (_e, code) => {
    const c = String(code || '').trim();
    if (!/^[a-z_]{2,12}$/.test(c)) return { ok: false, error: '语言代码非法' };
    try { fs.rmSync(path.join(tessDir(), c + '.traineddata'), { force: true }); } catch (e) {}
    return langStatus();
  });

  /* ------------------------------------------------------------------
   * homr（AI 识谱）—— 用户自行安装的第二个识别引擎
   *
   * ★ 为什么单独一个 venv：homr 0.7 要求 numpy>=2.4，而应用自带的运行时是 numpy 1.26
   *   （librosa / onnxruntime / basic_pitch 都按它固定）—— 装进同一个环境会把引擎拆了。
   *   所以用自带 python 建**独立 venv**（不继承 site-packages），只放 homr 与它的依赖。
   * ★ 为什么不随安装包分发：homr 代码是 AGPL-3.0，权重还含**非商用**训练数据（PrIMuS，
   *   CC BY-NC）—— 与 Audiveris 同一条路：只在应用内由用户点一下装，卸载就是删目录。
   * 体积：pip 依赖约 200 MB（onnxruntime 占大头）+ 权重 3 个包（CPU 版）。
   * ------------------------------------------------------------------ */
  const HOMR_VERSION = '0.7.0';
  const HOMR_CKPT = 'https://github.com/liebharc/homr/releases/download/onnx_checkpoints/';
  //: CPU 推理要的三个权重包。名字与 homr 0.7.0 源码里的 filepaths 一一对应
  //: （segmentation/config.py、transformer/configs.py）——引擎侧 HOMR_WEIGHTS 是同一份表。
  const HOMR_WEIGHTS = [
    { zip: 'segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.zip', dir: 'segmentation',
      file: 'segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.onnx' },
    { zip: 'encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.zip', dir: 'transformer',
      file: 'encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx' },
    { zip: 'decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.zip', dir: 'transformer',
      file: 'decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.onnx' },
  ];
  // 通道：GitHub 直链在部分网络很慢，镜像实测更快（与 MSI_URLS / LANG_URLS 同一套写法）
  // ★ 顺序按**实测**排：同一时刻 ghfast.top 只有 30 KB/s（与 docs 里 GitHub 直链被限速同一个坑），
  //   而 gh-proxy.com 实测 2.11 MB/s —— 慢通道放最后，FastDL 还会自己再测速挑一个。
  const HOMR_CKPT_URLS = (z) => ['https://gh-proxy.com/' + HOMR_CKPT + z,
                                 'https://gh.jasonzeng.dev/' + HOMR_CKPT + z,
                                 'https://ghfast.top/' + HOMR_CKPT + z, HOMR_CKPT + z];
  // pip 索引：国内镜像优先，官方兜底（homr 的依赖里 onnxruntime 最大）
  const PIP_INDEXES = ['https://pypi.tuna.tsinghua.edu.cn/simple',
                       'https://mirrors.aliyun.com/pypi/simple', 'https://pypi.org/simple'];

  function homrDir() { return path.join(Paths.dataRoot(), 'omr', 'homr'); }
  function homrVenv() { return path.join(homrDir(), 'venv'); }
  function homrSite() { return path.join(homrVenv(), 'Lib', 'site-packages', 'homr'); }
  function homrExePath() { return path.join(homrVenv(), 'Scripts', 'homr.exe'); }

  function homrStatus() {
    const py = path.join(homrVenv(), 'Scripts', 'python.exe');
    const weights = [];
    let bytes = 0;
    for (const w of HOMR_WEIGHTS) {
      let has = false, size = 0;
      try {
        const st = fs.statSync(path.join(homrSite(), w.dir, w.file));
        has = st.size > 1024 * 1024;      // 半截文件不算装好
        size = st.size;
      } catch (e) {}
      weights.push({ file: w.file, installed: has, bytes: size });
      bytes += size;
    }
    return {
      ok: true, installed: fs.existsSync(homrExePath()) || fs.existsSync(py),
      ready: weights.every((w) => w.installed),
      version: HOMR_VERSION, dir: homrDir(), exe: homrExePath(),
      weights, weightBytes: bytes, missing: weights.filter((w) => !w.installed).length,
      license: 'AGPL-3.0（权重含 PrIMuS 非商用数据）',
    };
  }
  ipcMain.handle('omr:homrStatus', () => homrStatus());

  ipcMain.handle('omr:homrInstall', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { try { win && win.webContents.send('omr:progress', p); } catch (e) {} };
    const basePy = typeof bundledPython === 'function' ? bundledPython() : '';
    if (!basePy) return { ok: false, error: '没有找到内置 Python 运行时，无法创建独立环境' };
    const venv = homrVenv();
    const vpy = path.join(venv, 'Scripts', 'python.exe');
    try { fs.mkdirSync(homrDir(), { recursive: true }); } catch (e) {}
    const run = (exe, args, onOut, timeoutMs) => new Promise((resolve) => {
      let out = '', done = false;
      const ch = spawn(exe, args, { windowsHide: true, cwd: homrDir(),
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) });
      const fin = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
      const timer = setTimeout(() => { try { ch.kill(); } catch (e) {} fin(-1); }, timeoutMs || 30 * 60 * 1000);
      const grab = (d) => { const s = String(d); out += s; if (onOut) onOut(s); };
      ch.stdout.on('data', grab);
      ch.stderr.on('data', grab);
      ch.on('close', fin);
      ch.on('error', (e) => { out += String((e && e.message) || e); fin(-1); });
    });
    try {
      // 1) 独立 venv（不继承 site-packages —— 这是 homr 能装进来的前提）
      if (!fs.existsSync(vpy)) {
        send({ phase: 'homr-venv', percent: 2, text: '创建 homr 独立运行环境…' });
        const r = await run(basePy, ['-m', 'venv', venv], null, 5 * 60 * 1000);
        if (!fs.existsSync(vpy)) return { ok: false, error: '创建 venv 失败：' + r.out.slice(-300) };
      }
      // 2) pip install homr（已装就跳过；镜像按序回退）
      const probe = await run(vpy, ['-c', 'import homr'], null, 120000);
      if (probe.code !== 0) {
        let lastErr = '';
        for (const idx of PIP_INDEXES) {
          send({ phase: 'homr-pip', percent: 8, text: '安装 homr 依赖（' + idx.replace(/^https?:\/\//, '').split('/')[0] + '）…' });
          const r = await run(vpy, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
                                    'homr==' + HOMR_VERSION, '-i', idx], (s) => {
            const m = /Downloading ([^\s]+)/.exec(s);
            if (m) send({ phase: 'homr-pip', percent: 12, text: '下载 ' + m[1].slice(0, 48) });
          }, 30 * 60 * 1000);
          if (r.code === 0) { lastErr = ''; break; }
          lastErr = r.out.slice(-400);
        }
        if (lastErr) return { ok: false, error: '安装 homr 失败：' + lastErr };
      }
      // 3) 权重：先用统一下载器（镜像可回退、走看门狗），失败再退回 homr --init
      const tmp = path.join(Paths.tempDir(), 'homr-weights');
      try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) {}
      for (let i = 0; i < HOMR_WEIGHTS.length; i++) {
        const w = HOMR_WEIGHTS[i];
        const dstFile = path.join(homrSite(), w.dir, w.file);
        try { if (fs.statSync(dstFile).size > 1024 * 1024) continue; } catch (e) {}
        const base = 55 + Math.round((i / HOMR_WEIGHTS.length) * 35);
        const label = '下载 AI 权重 ' + (i + 1) + '/' + HOMR_WEIGHTS.length;
        send({ phase: 'homr-weights', percent: base, text: label });
        const zipTmp = path.join(tmp, w.zip);
        const got = await downloadAny(HOMR_CKPT_URLS(w.zip), zipTmp, (pct) => {
          send({ phase: 'homr-weights', percent: Math.min(96, base + Math.round(8 * pct / 100)), text: label });
        }, { minSize: 1024 * 1024, expectSize: 0 });
        if (got.ok) {
          const target = path.join(homrSite(), w.dir);
          fs.mkdirSync(target, { recursive: true });
          const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
            'Expand-Archive -Path "' + zipTmp + '" -DestinationPath "' + target + '" -Force'], { windowsHide: true });
          await new Promise((res) => { ps.on('close', () => res()); ps.on('error', () => res()); });
        }
        try { fs.rmSync(zipTmp, { force: true }); } catch (e) {}
        let have = false;
        try { have = fs.statSync(dstFile).size > 1024 * 1024; } catch (e) {}
        if (!have) {
          // 退回 homr 自带的下载器（它知道该下什么、放哪里；就是慢）
          send({ phase: 'homr-weights', percent: base, text: '改用 homr 自带下载…' });
          const r = await run(homrExePath(), ['--init'], null, 60 * 60 * 1000);
          try { have = fs.statSync(dstFile).size > 1024 * 1024; } catch (e) {}
          if (!have) return { ok: false, error: '下载权重失败：' + String((got && got.error) || '').slice(0, 160) + ' / ' + r.out.slice(-200) };
        }
      }
      send({ phase: 'done', percent: 100, text: 'homr 就绪' });
      return homrStatus();
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('omr:homrRemove', () => {
    try { fs.rmSync(homrDir(), { recursive: true, force: true }); return homrStatus(); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('omr:remove', () => {
    try { fs.rmSync(engineDir(), { recursive: true, force: true }); return status(); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 下载 + 解包（进度通过 omr:progress 推给渲染层）
  ipcMain.handle('omr:install', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { try { win && win.webContents.send('omr:progress', p); } catch (e) {} };
    const tmp = path.join(Paths.tempDir(), 'audiveris-' + Date.now() + '.msi');
    try {
      fs.mkdirSync(path.dirname(tmp), { recursive: true });
      send({ phase: 'download', percent: 0, text: '下载识谱引擎…' });
      const got = await downloadAny(MSI_URLS, tmp, (pct) => send({ phase: 'download', percent: pct, text: '下载识谱引擎…' }));
      if (!got.ok) return { ok: false, error: got.error };
      // ★ 完整性校验（2026-10-13 加）：此前这个 81 MB 的安装包**下载后不校验任何指纹**，
      //   直接 msiexec /a 解包执行；而上游 release 本身也不提供校验文件。
      //   HTTPS 只保护传输过程，不保护「这个发布物本身是不是我们预期的那个」。
      //   这与 VENDOR.md 对内置二进制逐个钉 SHA-256 是同一套纪律。
      send({ phase: 'verify', percent: 87, text: '校验识谱引擎…' });
      const v = verifyMsi(tmp);
      if (!v.ok) { try { fs.unlinkSync(tmp); } catch (e) {} return { ok: false, error: v.error }; }
      send({ phase: 'extract', percent: 88, text: '解包识谱引擎…' });
      const dir = engineDir();
      fs.mkdirSync(dir, { recursive: true });
      const ex = await extractMsi(tmp, dir);
      try { fs.unlinkSync(tmp); } catch (e) {}
      if (!ex.ok) return { ok: false, error: ex.error };
      send({ phase: 'done', percent: 100, text: '识谱引擎就绪' });
      return status();
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) {}
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // ★ 下载走 Electron 的 net（Chromium 网络栈）：它自动使用系统代理并跟随重定向。
  //   实测直接用 Node 的 https 在需要代理的机器上会卡死到超时（PowerShell 能下、Node 不能），
  //   而 GitHub Release 还会 302 到 objects.githubusercontent.com。
  function downloadNet(url, dest, onProgress) {
    return new Promise((resolve) => {
      let req;
      try {
        req = net.request({ method: 'GET', url, redirect: 'follow' });
      } catch (e) { return resolve({ ok: false, error: String((e && e.message) || e) }); }
      let settled = false;
      let lastData = Date.now();
      const watchdog = setInterval(() => {
        // 卡住检测：15 秒没有任何新数据就放弃这条通道（实测某些网络下 Chromium 栈会被限到 1MB/4min）
        if (Date.now() - lastData > 15000) { clearInterval(watchdog); try { req.abort(); } catch (e) {} done({ ok: false, error: '通道卡住（15s 无数据）' }); }
      }, 5000);
      const done = (v) => { if (!settled) { settled = true; clearInterval(watchdog); resolve(v); } };
      req.on('response', (res) => {
        if (res.statusCode !== 200) { try { res.resume(); } catch (e) {} return done({ ok: false, error: 'HTTP ' + res.statusCode }); }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0, lastTick = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          got += chunk.length;
          lastData = Date.now();
          const now = Date.now();
          if (now - lastTick > 250) { lastTick = now; onProgress && onProgress(total ? Math.min(86, Math.round((got / total) * 86)) : 40); }
          out.write(chunk);
        });
        res.on('end', () => out.end(() => done({ ok: true, bytes: got })));
        res.on('error', (e) => done({ ok: false, error: String((e && e.message) || e) }));
        out.on('error', (e) => done({ ok: false, error: String((e && e.message) || e) }));
      });
      req.on('error', (e) => done({ ok: false, error: String((e && e.message) || e) }));
      req.end();
    });
  }

  // 兜底：Node 的 http(s)（无代理环境一样能用）
  // 第三条通道：交给 PowerShell 的 Invoke-WebRequest —— 它走**系统代理**（WinINET）。
  // 实测同一台机器上 81MB / 60 秒下完，而 Chromium 栈与 Node 直连会被限到几乎不动
  // （4 分钟 1MB）。所以这条不是「有更好」，而是「这台机器上唯一能用的」。
  function downloadPs(url, dest, onProgress) {
    return new Promise((resolve) => {
      const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        "Invoke-WebRequest -Uri '" + url + "' -OutFile '" + dest.replace(/'/g, "''") + "' -UseBasicParsing"],
        { windowsHide: true });
      const timer = setInterval(() => {
        try {
          const st = fs.statSync(dest);
          onProgress && onProgress(Math.min(86, Math.round((st.size / (81 * 1024 * 1024)) * 86)));
        } catch (e) {}
      }, 800);
      const fin = (v) => { clearInterval(timer); resolve(v); };
      child.on('error', (e) => fin({ ok: false, error: String((e && e.message) || e) }));
      child.on('close', (code) => {
        let size = 0;
        try { size = fs.statSync(dest).size; } catch (e) {}
        if (code === 0 && size > 1024 * 1024) return fin({ ok: true, bytes: size });
        fin({ ok: false, error: 'PowerShell 下载失败（退出码 ' + code + '，' + size + ' 字节）' });
      });
    });
  }

  // 三级回退：Chromium 栈 → Node 直连 → 系统代理（PowerShell）
  // 下载通道：统一入口优先，其后才是「Chromium 栈 → Node 直连 → 系统代理（PowerShell）」三级回退。
  // 统一入口带来测速 / 分段并发 / 断点续传 / 停滞看门狗 / 大小校验；
  // 三级回退保留的原因是企业代理环境里可能只有 PowerShell 走得通。
  function verifyMsi(p) {
    let size = 0;
    try { size = fs.statSync(p).size; } catch (e) { return { ok: false, error: '安装包不存在' }; }
    if (size !== MSI_BYTES) {
      return { ok: false, error: '安装包大小不符：' + size + '/' + MSI_BYTES + '（传输被截断，已丢弃，可重试）' };
    }
    const h = require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
    if (h !== MSI_SHA256) {
      return { ok: false, error: '安装包指纹不符（期望 ' + MSI_SHA256.slice(0, 16) + '…，实得 ' + h.slice(0, 16) + '…），已丢弃' };
    }
    return { ok: true };
  }

  async function downloadAny(urls, dest, onProgress, opts) {
    const o = opts || {};
    const list = Array.isArray(urls) ? urls : [urls];
    const minSize = o.minSize || 1024 * 1024;
    const expectSize = o.expectSize === undefined ? MSI_BYTES : o.expectSize;
    try {
      const r = await FastDL.downloadFast({
        urls: list,
        dest,
        minSize,
        expectSize,
        headers: { 'user-agent': 'FuFumidi' },
        label: 'OMR 组件',
        onProgress: (p) => { if (!p.done && onProgress) onProgress(Math.min(86, p.percent || 0)); },
      });
      return { ok: true, via: 'fastdl', bytes: r.size };
    } catch (e) {
      // 落到下面的老通道；失败原因一并带上，便于诊断
      console.log('[omr] 统一下载器失败，回退老通道：' + String((e && e.message) || e));
    }
    // 回退通道：前两条跑主通道（不通时最快失败），PowerShell 那条走系统代理，逐镜像试。
    const tries = [];
    if (net) tries.push(['net', () => downloadNet(list[0], dest, onProgress)]);
    tries.push(['node', () => downloadNode(list[0], dest, onProgress)]);
    for (const u of list) tries.push(['powershell', () => downloadPs(u, dest, onProgress)]);
    let last = { ok: false, error: '没有可用的下载通道' };
    for (const pair of tries) {
      try { fs.rmSync(dest, { force: true }); } catch (e) {}
      const r = await pair[1]();
      if (r.ok) return Object.assign({ via: pair[0] }, r);
      last = Object.assign({ via: pair[0] }, r);
    }
    return last;
  }

  function downloadNode(url, dest, onProgress, depth = 0) {
    return new Promise((resolve) => {
      if (depth > 6) return resolve({ ok: false, error: '重定向次数过多' });
      const http = url.startsWith('https') ? require('https') : require('http');
      const req = http.get(url, { headers: { 'User-Agent': 'FuFumidi' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(download(res.headers.location, dest, onProgress, depth + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return resolve({ ok: false, error: '下载失败：HTTP ' + res.statusCode }); }
        const total = Number(res.headers['content-length'] || 0);
        let got = 0, lastTick = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (chunk) => {
          got += chunk.length;
          const now = Date.now();
          if (now - lastTick > 250) {
            lastTick = now;
            onProgress && onProgress(total ? Math.min(86, Math.round((got / total) * 86)) : 40);
          }
        });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve({ ok: true, bytes: got })));
        out.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }));
      });
      req.on('error', (e) => resolve({ ok: false, error: String(e && e.message || e) }));
      req.setTimeout(180000, () => { req.destroy(); resolve({ ok: false, error: '下载超时' }); });
    });
  }

  function extractMsi(msi, target) {
    return new Promise((resolve) => {
      // /a = administrative install：只解包到 TARGETDIR，不安装
      const args = ['/a', msi, '/qn', 'TARGETDIR=' + target];
      execFile('msiexec', args, { timeout: 10 * 60 * 1000, windowsHide: true }, (err, _out, errOut) => {
        if (!fs.existsSync(exePath())) {
          return resolve({ ok: false, error: '解包失败：' + String((err && err.message) || errOut || '未知错误').slice(0, 300) });
        }
        resolve({ ok: true });
      });
    });
  }
}

module.exports = { registerOmrIpc, exePath, engineDir, VERSION };
