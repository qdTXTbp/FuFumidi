// ============================================================
// 主进程更新服务：GitHub releases 检查 / 下载 / 打开
// ============================================================
'use strict';

const UPDATE_MIRRORS = [
  'https://ghfast.top/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  'https://gh-proxy.com/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  'https://ghproxy.net/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  'https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
];

function registerUpdateIpc({ ipcMain, shell, BrowserWindow, app, path, fs, net }) {
  async function fetchLatestRelease() {
    let lastErr = null;
    for (const base of UPDATE_MIRRORS) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
        const r = await net.fetch(base, { headers: { 'user-agent': 'FuFumidi/3.1.12' }, signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
        const d = await r.json();
        if (d && d.tag_name) return d;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('无法访问 GitHub');
  }
  function assetForPlatform(release) {
    const p = process.platform, arch = process.arch;
    const assets = release.assets || [];
    if (p === 'win32') return assets.find(a => /.exe$/i.test(a.name));
    if (p === 'darwin') return assets.find(a => arch === 'arm64' ? /arm64.*.dmg$/i.test(a.name) : /.dmg$/i.test(a.name) && !/arm64/i.test(a.name));
    if (p === 'linux') return assets.find(a => /.AppImage$/i.test(a.name));
    return null;
  }
  // 按 tag 拉取 release 说明（更新完成后首次启动的更新日志补充，多镜像回退）
  async function fetchReleaseNotes(tag) {
    let lastErr = null;
    const endpoints = [
      'https://ghfast.top/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/tags/' + tag,
      'https://gh-proxy.com/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/tags/' + tag,
      'https://ghproxy.net/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/tags/' + tag,
      'https://api.github.com/repos/qdTXTbp/FuFumidi/releases/tags/' + tag,
    ];
    for (const u of endpoints) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
        const r = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.12' }, signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
        const d = await r.json();
        if (d && d.tag_name) return d;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('无法访问 GitHub');
  }

  function sendUpdateProgress(win, received, total, done) {
    if (!win || win.isDestroyed()) return;
    win.webContents.send('update:progress', { received, total, percent: total ? Math.min(99, Math.round(received / total * 100)) : 0, done: !!done });
  }

  // 主进程下载完整离线安装包（多镜像回退 + 进度 + 大小校验）。
  // 关键：下载只写临时目录，失败/中断不影响当前安装——绝不边下边改已安装文件
  async function downloadInstallPackage(url, win) {
    const mirrors = [url, 'https://ghfast.top/' + url, 'https://gh-proxy.com/' + url, 'https://ghproxy.net/' + url];
    const dest = path.join(app.getPath('temp'), 'fufumidi-update', 'FuFumidi.Install.exe');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let lastErr = null;
    for (const u of mirrors) {
      try {
        const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.12' } });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
        const out = fs.createWriteStream(dest + '.part');
        out.on('error', () => {}); // 消费 'error'，防写入失败（EPERM 等）打崩主进程
        const reader = res.body.getReader();
        let received = 0, lastSend = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          const now = Date.now();
          if (now - lastSend > 300) { lastSend = now; sendUpdateProgress(win, received, total, false); }
          await new Promise((res2, rej2) => out.write(Buffer.from(value), err => err ? rej2(err) : res2()));
        }
        await new Promise((res2, rej2) => out.end(err => err ? rej2(err) : res2()));
        // 大小校验：明显小于声明则视为损坏，丢弃并换源重试
        const sz = fs.statSync(dest + '.part').size;
        if (total && sz < total * 0.9) throw new Error('下载不完整 ' + sz + '/' + total);
        fs.renameSync(dest + '.part', dest);
        sendUpdateProgress(win, sz, total, true);
        return { ok: true, path: dest, size: sz };
      } catch (e) { lastErr = e; try { fs.unlinkSync(dest + '.part'); } catch (_) {} }
    }
    return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
  }

  ipcMain.handle('update:list', async () => {
    try {
      const r = await fetch('https://api.github.com/repos/qdTXTbp/FuFumidi/releases?per_page=10', { headers: { 'User-Agent': 'FuFumidi-Update' } });
      const data = await r.json();
      return data.map(x => ({ tag: x.tag_name, name: x.name, assets: (x.assets || []).map(a => ({ name: a.name, url: a.browser_download_url, size: a.size })), body: (x.body || '').slice(0, 240) }));
    } catch (e) { return { error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('update:openExternal', async (_e, url) => {
    try { shell.openExternal(url); return { ok: true }; } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('update:check', async () => {
    try {
      const rel = await fetchLatestRelease();
      const asset = assetForPlatform(rel);
      const ver = (rel.tag_name || '').replace(/^v/i, '');
      return { ok: true, current: app.getVersion(), latest: ver, tag: rel.tag_name, notes: (rel.body || '').slice(0, 500), url: asset ? asset.browser_download_url : null, name: asset ? asset.name : null, mirror: asset ? ('https://ghfast.top/' + asset.browser_download_url) : null };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // 更新完成后首次启动：按 tag 拉取该版本完整 release 说明（离线时前端回退到内置 changelog）
  ipcMain.handle('update:notes', async (_e, tag) => {
    try {
      const rel = await fetchReleaseNotes(String(tag || '').replace(/^v/i, 'v'));
      return { ok: true, body: rel.body || '' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('update:download', async (evt, url) => {
    if (!url) return { ok: false, error: 'empty url' };
    const win = BrowserWindow.fromWebContents(evt.sender);
    return downloadInstallPackage(url, win);
  });
  ipcMain.handle('update:open', async (_e, p) => {
    try { shell.openPath(p); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
  });

  ipcMain.handle('app:getVersion', () => app.getVersion());

  // 更新流程（防损坏设计）：
  //  1) 主进程下载完整离线安装包到临时目录（多镜像回退 + 进度 + 大小校验）——下载中断只留临时文件，不影响当前安装
  //  2) 下载成功且校验通过后，才拉起本地安装器静默安装（无网络依赖，不边下边改已安装文件）
  //  3) 守护脚本在安装器退出后校验核心文件完整性，完整才重启主程序
  ipcMain.handle('update:launchUpdater', async (evt, version) => {
    const win = BrowserWindow.fromWebContents(evt.sender);
    try {
      const rel = await fetchLatestRelease();
      const asset = assetForPlatform(rel);
      if (!asset) return { ok: false, error: '未找到更新安装包' };
      // 1) 主进程预下载（失败/取消不影响当前安装）
      const dl = await downloadInstallPackage(asset.browser_download_url, win);
      if (!dl.ok) return { ok: false, error: '更新包下载失败：' + dl.error + '（当前安装未受影响，可稍后重试）' };
      // 2) 守护脚本：等待本地安装器退出，校验核心文件完整后重启主程序
      const { spawn } = require('child_process');
      const updaterDir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getAppPath(), 'release', 'win-unpacked');
      const mainExe = path.join(updaterDir, 'FuFumidi.exe');
      const procName = path.basename(dl.path, '.exe'); // FuFumidi.Install
      const daemon = path.join(app.getPath('temp'), 'fufumidi-restart.ps1');
      fs.writeFileSync(daemon, `param([string]$exePath, [string]$procName, [int]$timeout = 600)
$deadline = (Get-Date).AddSeconds($timeout)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Name $procName -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 3
# 核心文件完整性校验：安装中断/损坏时不再重启残缺程序（避免「关掉安装器就损坏工具」）
$resources = Join-Path (Split-Path $exePath) "resources"
$asar = Join-Path $resources "app.asar"
if (-not (Test-Path $exePath)) { exit 5 }
if (-not (Test-Path $asar)) { exit 4 }
$sz = (Get-Item $asar).Length
if ($sz -lt 1MB) { exit 3 }
Start-Process -FilePath $exePath -WorkingDirectory (Split-Path $exePath)
`, 'utf8');
      try {
        const guard = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', daemon, '-exePath', mainExe, '-procName', procName], { detached: true, stdio: 'ignore' });
        guard.unref();
      } catch (e) { /* 守护启动失败不阻塞更新 */ }
      // 3) 本地静默安装（-I 非交互；安装包已在本地，无网络依赖）
      const cp = spawn(dl.path, ['-I'], { cwd: path.dirname(dl.path), detached: true, stdio: 'ignore' });
      cp.unref();
      return { ok: true, installPath: dl.path, size: dl.size };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerUpdateIpc };
