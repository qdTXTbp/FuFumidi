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

function registerOmrIpc({ ipcMain, BrowserWindow, app, path, fs, shell, net }) {
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

  async function downloadAny(urls, dest, onProgress) {
    const list = Array.isArray(urls) ? urls : [urls];
    try {
      const r = await FastDL.downloadFast({
        urls: list,
        dest,
        minSize: 1024 * 1024,
        expectSize: MSI_BYTES,
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
