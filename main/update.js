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
        const r = await net.fetch(base, { headers: { 'user-agent': 'FuFumidi/3.1.11' }, signal: ctrl.signal });
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
        const r = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.11' }, signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
        const d = await r.json();
        if (d && d.tag_name) return d;
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('无法访问 GitHub');
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
    const mirrors = [url, 'https://ghfast.top/' + url, 'https://gh-proxy.com/' + url, 'https://ghproxy.net/' + url];
    const dest = path.join(app.getPath('temp'), 'fufumidi-update', 'FuFumidi-update' + path.extname(new URL(url).pathname));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let lastErr = null;
    for (const u of mirrors) {
      try {
        const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.11' } });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const total = parseInt(res.headers.get('content-length') || '0', 10) || 0;
        const out = fs.createWriteStream(dest + '.part');
        const reader = res.body.getReader();
        let received = 0, lastSend = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          const now = Date.now();
          if (now - lastSend > 300) { lastSend = now; if (win && !win.isDestroyed()) win.webContents.send('update:progress', { received, total, percent: total ? Math.min(99, Math.round(received / total * 100)) : 0 }); }
          await new Promise((res2, rej2) => out.write(Buffer.from(value), err => err ? rej2(err) : res2()));
        }
        await new Promise((res2, rej2) => out.end(err => err ? rej2(err) : res2()));
        fs.renameSync(dest + '.part', dest);
        if (win && !win.isDestroyed()) win.webContents.send('update:progress', { received, total, percent: 100, done: true });
        return { ok: true, path: dest };
      } catch (e) { lastErr = e; try { fs.unlinkSync(dest + '.part'); } catch {} }
    }
    return { ok: false, error: String((lastErr && lastErr.message) || lastErr) };
  });
  ipcMain.handle('update:open', async (_e, p) => {
    try { shell.openPath(p); return { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
  });
  // 启动 kachina 更新器（BetterGI 同款增量更新器）：比对文件差异，只下载有改动的部分。
  // 更新器自身在线下载 Install 包并在窗口内显示进度（多镜像源：ghfast / gh-proxy / ghproxy.net / GitHub 官方）。

  // 更新源候选（与 kachina.config.json 的 source id 对应）；启动更新前 HEAD 探测挑一个可达的，避免镜像不稳定
  const UPDATE_SOURCES = [
    { id: 'ghfast', uri: 'https://ghfast.top/https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe' },
    { id: 'ghproxy', uri: 'https://gh-proxy.com/https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe' },
    { id: 'ghproxy-net', uri: 'https://ghproxy.net/https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe' },
    { id: 'github', uri: 'https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe' },
  ];
  async function pickUpdateSource() {
    for (const s of UPDATE_SOURCES) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
        const r = await net.fetch(s.uri, { method: 'HEAD', headers: { 'user-agent': 'FuFumidi/3.1.11' }, signal: ctrl.signal });
        clearTimeout(to);
        if (r.ok) return s.id;
      } catch (e) { /* 探测失败，尝试下一个源 */ }
    }
    return 'ghfast'; // 全部失败：回退默认（更新器窗口会展示错误，用户可手动打开更新器切换源）
  }

  ipcMain.handle('app:getVersion', () => app.getVersion());

  ipcMain.handle('update:launchUpdater', async (evt, version) => {
    try {
      // 直接拉起 kachina 更新器在线更新：下载进度由更新器窗口内显示（BetterGI 同款），
      // 不再由主程序预下载离线包（镜像直连在主程序侧易失败且无窗口反馈）。
      const updaterDir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getAppPath(), 'release', 'update');
      const updaterExe = path.join(updaterDir, 'FuFumidi.update.exe');
      if (!fs.existsSync(updaterExe)) return { ok: false, error: '更新器不存在：' + updaterExe + '（请使用新版便携版 / 重新下载）' };
      const { spawn } = require('child_process');
      // 先启动独立守护：更新器会先结束本进程，更新完成后由守护自动重新启动主程序。
      // （kachina 非交互模式不会自动拉起主程序，故用 PowerShell 守护轮询更新器退出后重启）
      try {
        const mainExe = path.join(updaterDir, 'FuFumidi.exe');
        const daemon = path.join(app.getPath('temp'), 'fufumidi-restart.ps1');
        fs.writeFileSync(daemon, `param([string]$exePath, [int]$timeout = 300)
$deadline = (Get-Date).AddSeconds($timeout)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Name "FuFumidi.update" -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Seconds 2
}
Start-Sleep -Seconds 3
# 重启前做一次核心文件完整性快速自检：更新器异常中断时不再重启损坏的程序
$resources = Join-Path (Split-Path $exePath) "resources"
$asar = Join-Path $resources "app.asar"
if (Test-Path $asar) {
  $sz = (Get-Item $asar).Length
  if ($sz -lt 1MB) { exit 3 }
} else {
  exit 4
}
Start-Process -FilePath $exePath -WorkingDirectory (Split-Path $exePath)
`, 'utf8');
        const guard = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', daemon, '-exePath', mainExe], { detached: true, stdio: 'ignore' });
        guard.unref();
      } catch (e) { /* 守护启动失败不阻塞更新 */ }
      // 探测可用镜像源（HEAD 6 秒超时，失败自动换下一个），避免单一镜像不稳定导致下载损坏
      const source = await pickUpdateSource();
      const args = ['-I', '-O', '--source', source];
      const cp = spawn(updaterExe, args, { cwd: updaterDir, detached: true, stdio: 'ignore' });
      cp.unref();
      return { ok: true, source };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerUpdateIpc };
