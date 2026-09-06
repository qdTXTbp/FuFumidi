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
        const r = await net.fetch(base, { headers: { 'user-agent': 'FuFumidi/3.1.16' }, signal: ctrl.signal });
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
        const r = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.16' }, signal: ctrl.signal });
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
        const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.16' } });
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

  // 增量更新流程（kachina 更新器方案，见 UPDATING.md）：
  //  1) 更新器内嵌源配置（ghfast 等镜像，指向 releases/latest/download/FuFumidi.Install.exe）
  //     —— 由更新器自行差分下载（Range 请求）并显示进度，主进程不做整包预下载
  //  2) 主进程写入独立守护脚本并 spawn（detached），随后拉起 FuFumidi.update.exe
  //  3) 守护脚本轮询等待更新器退出（超时 420s）→ 短暂等待文件替换落盘 → 启动新版主程序
  ipcMain.handle('update:launchUpdater', async (evt) => {
    try {
      const { spawn } = require('child_process');
      const updaterDir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getAppPath(), 'release', 'win-unpacked');
      const updaterPath = path.join(updaterDir, 'FuFumidi.update.exe');
      const mainExe = path.join(updaterDir, 'FuFumidi.exe');
      if (!fs.existsSync(updaterPath)) {
        return { ok: false, error: '更新器不存在：' + updaterPath + '（请使用新版便携版 / 重新下载完整安装包）' };
      }
      // 1) 守护脚本：等更新器退出（完成替换）→ 短暂等待落盘 → 启动新版主程序
      //    独立进程跑，脱离主进程，即便主程序被更新器结束也能继续完成重启
      const daemon = path.join(app.getPath('temp'), 'fufumidi-restart.ps1');
      const _exe = JSON.stringify(mainExe).replace(/\\/g, '\\\\'); // JSON 字符串含反斜杠，需经双引号包裹并转义
      const _dir = JSON.stringify(updaterDir);
      fs.writeFileSync(daemon, `$procName = 'FuFumidi.update'
$deadline = (Get-Date).AddSeconds(420)
while (Get-Process -Name $procName -ErrorAction SilentlyContinue) {
  if ((Get-Date) -gt $deadline) { break }
  Start-Sleep -Seconds 1
}
Start-Sleep -Seconds 3
# 更新器替换 core 文件（app.asar 数十 MB）需数秒：等 asar 头完整且稳定后再启动主程序，
# 避免读到半写/缺失的 asar 一启动即崩溃或触发完整性误报（最多等 60s）
$asar = Join-Path ${_dir} 'resources\app.asar'
$t0 = (Get-Date)
while ($true) {
  $ok = $false
  $st = Get-Item $asar -ErrorAction SilentlyContinue
  if ($st -and $st.Length -gt 1048576) {
    try {
      $fs = [System.IO.File]::OpenRead($asar)
      $b = New-Object byte[] 8
      [void]$fs.Read($b, 0, 8)
      $fs.Close()
      $headerSize = [BitConverter]::ToUInt32($b, 4)
      if ([BitConverter]::ToUInt32($b, 0) -eq 4 -and $headerSize -gt 0 -and $headerSize -lt $st.Length) { $ok = $true }
    } catch { $ok = $false }
  }
  if ($ok -or ((Get-Date) -gt $t0.AddSeconds(60))) { break }
  Start-Sleep -Milliseconds 500
}
Start-Process -FilePath ${_exe} -WorkingDirectory ${_dir}
`, 'utf8');
      try {
        const guard = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', daemon], { detached: true, stdio: 'ignore' });
        guard.unref();
      } catch (e) { /* 守护启动失败不阻塞更新 */ }
      // 2) 拉起 kachina 增量更新器（-I 非交互、-O 强制在线、--source ghfast 指定镜像源）
      //    更新器自带窗口显示下载进度；会自行结束主程序进程并替换文件
      try {
        const upd = spawn(updaterPath, ['-I', '-O', '--source', 'ghfast'], { cwd: updaterDir, detached: true, stdio: 'ignore' });
        upd.unref();
      } catch (e) {
        return { ok: false, error: '启动更新器失败：' + String((e && e.message) || e) };
      }
      // 更新器要替换主程序 exe；若本进程仍运行，exe 被内存映射（user-mapped section）占用，
      // 更新器覆盖时会报 CREATE_TARGET_FILE_ERR / os error 1224。故先让应用自行退出，
      // 释放 exe 映射，再交给守护进程等待更新器完成后拉起新版本。
      try { setTimeout(() => { try { app.exit(0); } catch (_) {} }, 400); } catch (_) {}
      return { ok: true, launching: true, updaterPath };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerUpdateIpc };
