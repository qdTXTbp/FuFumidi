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
const Platform = require('./platform');
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
    } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
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
        } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      }
    } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    return { ok: true, dir, installed, catalog: LANG_CATALOG };
  };
  ipcMain.handle('omr:langStatus', () => langStatus());

  ipcMain.handle('omr:langInstall', async (evt, codes) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { try { win && win.webContents.send('omr:progress', p); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } };
    const want = (Array.isArray(codes) ? codes : [codes])
      .map((c) => String(c || '').trim())
      .filter((c) => /^[a-z_]{2,12}$/.test(c) && LANG_CATALOG.some((x) => x.code === c));
    if (!want.length) return { ok: false, error: '没有可安装的语言代码' };
    const dir = tessDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
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
      if (!got.ok) { try { fs.rmSync(dst, { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } return { ok: false, error: code + '：' + got.error }; }
      added.push(code);
    }
    send({ phase: 'done', percent: 100, text: '语言包就绪' });
    return Object.assign(langStatus(), { added });
  });

  ipcMain.handle('omr:langRemove', (_e, code) => {
    const c = String(code || '').trim();
    if (!/^[a-z_]{2,12}$/.test(c)) return { ok: false, error: '语言代码非法' };
    try { fs.rmSync(path.join(tessDir(), c + '.traineddata'), { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
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

  /* ★ 只查"文件在不在"会骗人：运行时从 3.11 升到 3.12 之后，老 venv 里的 numpy/onnxruntime
     扩展是 cp311，导入直接炸，但 status 依旧报「已安装」。用户实测就是这么被误导的
     （界面写已安装、一跑就 No module named 'numpy._core._multiarray_umath'）。
     现在真的跑一次 import，并把 providers 一并带出来（顺带告诉界面 GPU 有没有生效）。 */
  let homrProbeCache = { at: 0, ok: false, reason: '', providers: '' };
  function homrProbeVenv(vpy) {
    if (Date.now() - homrProbeCache.at < 60000 && homrProbeCache.at) return Promise.resolve(homrProbeCache);
    return new Promise((resolve) => {
      let buf = '', done = false;
      const fin = (v) => { if (!done) { done = true; resolve(v); } };
      let ch = null;
      try {
        ch = spawn(vpy, ['-c', 'import numpy,onnxruntime as o;print("OK",o.get_available_providers())'],
          { windowsHide: true, env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) });
      } catch (e) { fin({ code: -1, out: String((e && e.message) || e) }); return; }
      ch.stdout.on('data', (d) => { buf += d.toString('utf8'); });
      ch.stderr.on('data', (d) => { buf += d.toString('utf8'); });
      ch.on('close', (code) => fin({ code, out: buf }));
      ch.on('error', (e) => fin({ code: -1, out: String((e && e.message) || e) }));
      setTimeout(() => { try { ch.kill(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } fin({ code: -2, out: 'probe timeout' }); }, 60000);
    }).then((r) => {
      const m = /OK (.*)/.exec(r.out || '');
      homrProbeCache = {
        at: Date.now(), ok: r.code === 0 && !!m,
        providers: m ? String(m[1]).trim() : '',
        reason: (r.code === 0 && m) ? '' : String(r.out || '').trim().split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 220),
      };
      return homrProbeCache;
    });
  }
  async function homrStatus() {
    const py = path.join(homrVenv(), Platform.venvPythonRelative(process.platform));
    const weights = [];
    let bytes = 0;
    for (const w of HOMR_WEIGHTS) {
      let has = false, size = 0;
      try {
        const st = fs.statSync(path.join(homrSite(), w.dir, w.file));
        has = st.size > 1024 * 1024;      // 半截文件不算装好
        size = st.size;
      } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      weights.push({ file: w.file, installed: has, bytes: size });
      bytes += size;
    }
    const hasVenv = fs.existsSync(py);
    const probe = hasVenv ? await homrProbeVenv(py) : { ok: false, reason: '未创建运行环境', providers: '' };
    return {
      ok: true, installed: fs.existsSync(homrExePath()) || hasVenv,
      // ready 现在要求"权重齐 + venv 真的能 import" —— 半坏的 venv 不再算就绪
      ready: weights.every((w) => w.installed) && probe.ok,
      broken: hasVenv && !probe.ok,
      reason: probe.reason,
      providers: probe.providers,
      gpu: /CUDA/i.test(probe.providers || ''),
      version: HOMR_VERSION, dir: homrDir(), exe: homrExePath(),
      weights, weightBytes: bytes, missing: weights.filter((w) => !w.installed).length,
      license: 'AGPL-3.0（权重含 PrIMuS 非商用数据）',
    };
  }
  ipcMain.handle('omr:homrStatus', () => homrStatus());

  ipcMain.handle('omr:homrInstall', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { try { win && win.webContents.send('omr:progress', p); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } };
    const basePy = typeof bundledPython === 'function' ? bundledPython() : '';
    if (!basePy) return { ok: false, error: '没有找到内置 Python 运行时，无法创建独立环境' };
    const venv = homrVenv();
    const vpy = path.join(venv, Platform.venvPythonRelative(process.platform));
    try { fs.mkdirSync(homrDir(), { recursive: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    const run = (exe, args, onOut, timeoutMs) => new Promise((resolve) => {
      let out = '', done = false;
      const ch = spawn(exe, args, { windowsHide: true, cwd: homrDir(),
        env: Object.assign({}, process.env, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }) });
      const fin = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, out }); };
      const timer = setTimeout(() => { try { ch.kill(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } fin(-1); }, timeoutMs || 30 * 60 * 1000);
      const grab = (d) => { const s = String(d); out += s; if (onOut) onOut(s); };
      ch.stdout.on('data', grab);
      ch.stderr.on('data', grab);
      ch.on('close', fin);
      ch.on('error', (e) => { out += String((e && e.message) || e); fin(-1); });
    });
    try {
      // ★ 版本护栏：pyvenv.cfg 记着创建 venv 时的 Python 版本。运行时升级（3.11 → 3.12）之后，
      //   老 venv 里的扩展全是 cp311，pip 重装也救不回来 —— 只能整个删掉重建。
      const pyMinor = async (exe) => {
        const r = await run(exe, ['-c', 'import sys;print("%d.%d" % sys.version_info[:2])'], null, 30000);
        return ((r.out || '').match(/(\d+\.\d+)/) || [])[1] || '';
      };
      const wantMinor = await pyMinor(basePy);
      let haveMinor = '';
      try { haveMinor = ((fs.readFileSync(path.join(venv, 'pyvenv.cfg'), 'utf8').match(/version\s*=\s*(\d+\.\d+)/) || [])[1]) || ''; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      if (fs.existsSync(vpy) && haveMinor && wantMinor && haveMinor !== wantMinor) {
        send({ phase: 'homr-venv', percent: 2, text: '内置运行时已升到 Python ' + wantMinor + '，正在重建识谱环境…' });
        try { fs.rmSync(venv, { recursive: true, force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      }
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
          // ★ onnxruntime-gpu：识谱（homr）走 ONNX 推理，装上它才会用 CUDA；
          //   没有 N 卡时 onnxruntime-gpu 自己回退 CPU，不会更差。
          const r = await run(vpy, ['-m', 'pip', 'install', '--no-input', '--disable-pip-version-check',
                                    'homr==' + HOMR_VERSION, 'onnxruntime-gpu', '-i', idx], (s) => {
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
      try { fs.mkdirSync(tmp, { recursive: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      for (let i = 0; i < HOMR_WEIGHTS.length; i++) {
        const w = HOMR_WEIGHTS[i];
        const dstFile = path.join(homrSite(), w.dir, w.file);
        try { if (fs.statSync(dstFile).size > 1024 * 1024) continue; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
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
        try { fs.rmSync(zipTmp, { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
        let have = false;
        try { have = fs.statSync(dstFile).size > 1024 * 1024; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
        if (!have) {
          // 退回 homr 自带的下载器（它知道该下什么、放哪里；就是慢）
          send({ phase: 'homr-weights', percent: base, text: '改用 homr 自带下载…' });
          const r = await run(homrExePath(), ['--init'], null, 60 * 60 * 1000);
          try { have = fs.statSync(dstFile).size > 1024 * 1024; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
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

  /* ------------------------------------------------------------------
     M3-2 超分辨率预处理（waifu2x-ncnn-vulkan）—— **用户自行安装**
     低清扫描件专用：Audiveris 的 ScaleBuilder 要求行距 ≥ 11px，低于它整页判 invalid。
     实测一张行距 2.4px 的总谱页：不超分 0 个音符（"Sheet ignored"），超分 ×2 后 **253 个音符**。
     解压 39.5 MB（1 个 exe + 3 组模型），MIT 许可，按需下载、删目录即卸载。
     ------------------------------------------------------------------ */
  const SR_VERSION = '20250915';
  const SR_ZIP = 'waifu2x-ncnn-vulkan-' + SR_VERSION + '-windows.zip';
  const SR_UPSTREAM = 'https://github.com/nihui/waifu2x-ncnn-vulkan/releases/download/' + SR_VERSION + '/' + SR_ZIP;
  //: 通道顺序按实测：gh-proxy.com 下这 35.5 MB 只用 8 s（峰值 4 MB/s）；直链在部分网络会卡在几十 KB/s。
  const SR_URLS = ['https://gh-proxy.com/' + SR_UPSTREAM, 'https://ghfast.top/' + SR_UPSTREAM,
    'https://ghproxy.net/' + SR_UPSTREAM, SR_UPSTREAM];
  const SR_MODELS = ['models-cunet', 'models-upconv_7_photo', 'models-upconv_7_anime_style_art_rgb'];

  function srDir() { return path.join(Paths.dataRoot(), 'omr', 'waifu2x'); }
  function srExePath() { return path.join(srDir(), 'waifu2x-ncnn-vulkan.exe'); }

  function srStatus() {
    let exeBytes = 0;
    try { exeBytes = fs.statSync(srExePath()).size; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
    const models = SR_MODELS.map((m) => {
      let bytes = 0;
      try {
        const dir = path.join(srDir(), m);
        for (const f of fs.readdirSync(dir)) { try { bytes += fs.statSync(path.join(dir, f)).size; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
      } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      return { name: m, installed: bytes > 1024 * 1024, bytes };
    });
    const bytes = exeBytes + models.reduce((s, m) => s + m.bytes, 0);
    return {
      ok: true,
      installed: exeBytes > 1024 * 1024 && models.some((m) => m.installed),
      version: SR_VERSION, dir: srDir(), exe: srExePath(),
      models, bytes, missing: models.filter((m) => !m.installed).length,
      license: 'MIT（waifu2x-ncnn-vulkan · nihui）',
      upstream: SR_UPSTREAM,
    };
  }
  ipcMain.handle('omr:srStatus', () => srStatus());

  ipcMain.handle('omr:srInstall', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { try { win && win.webContents.send('omr:progress', p); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } };
    try {
      fs.mkdirSync(srDir(), { recursive: true });
      const tmpZip = path.join(Paths.tempDir(), SR_ZIP);
      const tmpDst = path.join(Paths.tempDir(), 'waifu2x-unzip');
      try { fs.rmSync(tmpDst, { recursive: true, force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      try { fs.mkdirSync(tmpDst, { recursive: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      send({ phase: 'sr-download', percent: 2, text: '下载超分辨率组件（35 MB）' });
      const got = await downloadAny(SR_URLS, tmpZip, (pct) => {
        send({ phase: 'sr-download', percent: Math.min(90, 2 + Math.round(88 * pct / 100)), text: '下载超分辨率组件（35 MB）' });
      }, { minSize: 20 * 1024 * 1024 });
      if (!got || !got.ok) return { ok: false, error: '下载失败：' + String((got && got.error) || '').slice(0, 200) };
      send({ phase: 'sr-unzip', percent: 94, text: '解压…' });
      // zip 里多一层 waifu2x-ncnn-vulkan-<版本>-windows/ —— 把里面的东西挪到 srDir 根下
      const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
        'Expand-Archive -Path "' + tmpZip + '" -DestinationPath "' + tmpDst + '" -Force; ' +
        'Get-ChildItem -Path "' + tmpDst + '" -Directory | Select-Object -First 1 | ForEach-Object { ' +
        'Move-Item -Path (Join-Path $_.FullName "*") -Destination "' + srDir() + '" -Force }'],
      { windowsHide: true });
      await new Promise((res) => { ps.on('close', () => res()); ps.on('error', () => res()); });
      try { fs.rmSync(tmpZip, { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      try { fs.rmSync(tmpDst, { recursive: true, force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      const st = srStatus();
      if (!st.installed) return { ok: false, error: '解压后没找到 waifu2x-ncnn-vulkan.exe' };
      send({ phase: 'done', percent: 100, text: '超分辨率组件就绪' });
      return st;
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  ipcMain.handle('omr:srRemove', () => {
    try { fs.rmSync(srDir(), { recursive: true, force: true }); return srStatus(); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  ipcMain.handle('omr:remove', () => {
    try { fs.rmSync(engineDir(), { recursive: true, force: true }); return status(); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 下载 + 解包（进度通过 omr:progress 推给渲染层）
  ipcMain.handle('omr:install', async (evt) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    const send = (p) => { try { win && win.webContents.send('omr:progress', p); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } };
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
      if (!v.ok) { try { fs.unlinkSync(tmp); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } return { ok: false, error: v.error }; }
      send({ phase: 'extract', percent: 88, text: '解包识谱引擎…' });
      const dir = engineDir();
      fs.mkdirSync(dir, { recursive: true });
      const ex = await extractMsi(tmp, dir);
      try { fs.unlinkSync(tmp); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      if (!ex.ok) return { ok: false, error: ex.error };
      send({ phase: 'done', percent: 100, text: '识谱引擎就绪' });
      return status();
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (e2) { try { require('./log').write('WARN', 'optional failure', String((e2 && e2.stack) || e2)); } catch (_) { /* log failure ignored */ } }
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
        if (Date.now() - lastData > 15000) { clearInterval(watchdog); try { req.abort(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } done({ ok: false, error: '通道卡住（15s 无数据）' }); }
      }, 5000);
      const done = (v) => { if (!settled) { settled = true; clearInterval(watchdog); resolve(v); } };
      req.on('response', (res) => {
        if (res.statusCode !== 200) { try { res.resume(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } return done({ ok: false, error: 'HTTP ' + res.statusCode }); }
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
        } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
      }, 800);
      const fin = (v) => { clearInterval(timer); resolve(v); };
      child.on('error', (e) => fin({ ok: false, error: String((e && e.message) || e) }));
      child.on('close', (code) => {
        let size = 0;
        try { size = fs.statSync(dest).size; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
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
      try { fs.rmSync(dest, { force: true }); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
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
