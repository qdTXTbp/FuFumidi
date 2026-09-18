// ============================================================
// 主进程更新服务：GitHub releases 检查 / 下载 / 打开
// ============================================================
'use strict';
const Paths = require('./paths');

const UPDATE_MIRRORS = [
  'https://ghfast.top/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  'https://gh-proxy.com/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  'https://ghproxy.net/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  'https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
];

function registerUpdateIpc({ ipcMain, shell, BrowserWindow, app, path, fs, net }) {
  // 与 build/kachina.config.json 的 source id 一一对应（顺序与 UPDATE_MIRRORS 一致）
  const UPDATE_SOURCE_IDS = ['ghfast', 'ghproxy', 'ghproxy-net', 'github'];
  // 更新包下载源候选（kachina 更新器 --source 取 id）
  const UPDATE_SOURCES = [
    { id: 'ghfast', uri: 'https://ghfast.top/https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe' },
    { id: 'ghproxy', uri: 'https://gh-proxy.com/https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe' },
    { id: 'ghproxy-net', uri: 'https://ghproxy.net/https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe' },
    { id: 'github', uri: 'https://github.com/qdTXTbp/FuFumidi/releases/latest/download/FuFumidi.Install.exe' },
  ];
  // 最近一次「检查更新」实际访问成功的镜像（先探测它，命中率高）
  let lastGoodSource = null;

  // HEAD 探测可用下载源（每个 6s 超时），失败自动换下一个；全部失败回退最近可达源，再退官方直连
  async function pickUpdateSource() {
    const ordered = UPDATE_SOURCES.slice();
    if (lastGoodSource) {
      const i = ordered.findIndex(s => s.id === lastGoodSource);
      if (i > 0) { const hit = ordered.splice(i, 1)[0]; ordered.unshift(hit); }
    }
    for (const s of ordered) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
        const r = await net.fetch(s.uri, { method: 'HEAD', headers: { 'user-agent': 'FuFumidi/3.1.16' }, signal: ctrl.signal });
        clearTimeout(to);
        if (r.ok) return s.id;
      } catch (e) { /* 该源不可达，尝试下一个 */ }
    }
    return lastGoodSource || 'github';
  }

  async function fetchLatestRelease() {
    let lastErr = null;
    for (let i = 0; i < UPDATE_MIRRORS.length; i++) {
      const base = UPDATE_MIRRORS[i];
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
        const r = await net.fetch(base, { headers: { 'user-agent': 'FuFumidi/3.1.16' }, signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
        const d = await r.json();
        if (d && d.tag_name) { lastGoodSource = UPDATE_SOURCE_IDS[i]; return d; }
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
    // 优先写数据根目录的 temp/（不占 C 盘）；该目录已在 kachina.config.json 的
    // ignoreFolderPath 中，更新器不会在替换安装目录时把它删掉。不可写时回退系统 Temp。
    let dest = path.join(Paths.tempDir(), 'fufumidi-update', 'FuFumidi.Install.exe');
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    } catch (_) {
      dest = path.join(app.getPath('temp'), 'fufumidi-update', 'FuFumidi.Install.exe');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    }
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

  // 3.2.7：设置 → 卸载。启动 NSIS 卸载器（与主程序同级），随后退出主程序释放文件占用，
  // 卸载器自身的确认窗口由用户操作；detached 保证主程序退出后卸载流程继续
  ipcMain.handle('app:uninstall', async () => {
    try {
      const dir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getAppPath(), 'release', 'win-unpacked');
      const un = path.join(dir, 'Uninstall FuFumidi.exe');
      if (!fs.existsSync(un)) return { ok: false, error: '未找到卸载程序：' + un + '（免安装便携版无卸载器，请直接删除目录）' };
      const { spawn } = require('child_process');
      const child = spawn(un, [], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => { try { app.quit(); } catch (e) {} }, 600);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 增量更新流程（kachina 更新器方案，见 UPDATING.md）：
  //  1) 更新器内嵌源配置（ghfast 等镜像，指向 releases/latest/download/FuFumidi.Install.exe）
  //     —— 由更新器自行差分下载（Range 请求）并显示进度，主进程不做整包预下载
  //  2) 主进程探测可用下载源（HEAD，最多约 24s）→ 拉起 FuFumidi.update.exe
  //  3) 主进程再写一份独立守护脚本，用 WMI（Win32_Process.Create）把它拉起来 ——
  //     不能直接 spawn：detached 的 PowerShell 起不来，不 detached 的又会随主进程结束。
  //     守护脚本先等更新器出现、再等它退出（完成文件替换）→ 短暂等待落盘 → 启动新版主程序
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
      // 守护脚本也放数据根目录 temp/（同样被更新器 ignoreFolderPath 保护）
      let daemon = path.join(Paths.tempDir(), 'fufumidi-restart.ps1');
      try { fs.mkdirSync(path.dirname(daemon), { recursive: true }); }
      catch (_) { daemon = path.join(app.getPath('temp'), 'fufumidi-restart.ps1'); }
      // 路径按普通字符串写进脚本：PowerShell 双引号里反斜杠不是转义字符，不需要加倍
      const _q = (p) => '"' + p + '"';
      const _log = path.join(path.dirname(daemon), 'fufumidi-restart.log');
      // 必须用 String.raw：普通模板字符串会把 `'resources\app.asar'` 里的 `\a` 当转义吃掉，
      // 生成出来的路径变成 `resourcesapp.asar` —— 那个「等 asar 写稳」的检查因此一直是空转。
      fs.writeFileSync(daemon, '\ufeff' + String.raw`$procName = 'FuFumidi.update'
$log = ${_q(_log)}
function L($m) { try { Add-Content -LiteralPath $log -Value ((Get-Date).ToString('HH:mm:ss') + ' ' + $m) } catch {} }
L '[guard] start'
# 1) 先等更新器**出现**（最多 90s）。
#    主进程在拉起更新器之前要探测下载源（最多约 24s），更新器因此可能晚几十秒才起；
#    若这里只查一次就往下走，守护进程会在「还没有更新器」时误判成「更新已结束」，
#    提前把旧版主程序拉起来 —— 随后被更新器杀掉，等真正替换完成就再也没人重启它。
$t0 = (Get-Date)
$appeared = $false
while ((Get-Date) -lt $t0.AddSeconds(90)) {
  if (Get-Process -Name $procName -ErrorAction SilentlyContinue) { $appeared = $true; break }
  Start-Sleep -Milliseconds 500
}
L ('updater appeared=' + $appeared)
# 2) 再等它退出（此时文件替换才真正结束）。更新器窗口若停在完成态等用户关闭，
#    这里最多等 10 分钟，超时也照常拉起主程序，不让用户面对一个空桌面。
if ($appeared) {
  $deadline = (Get-Date).AddSeconds(600)
  while (Get-Process -Name $procName -ErrorAction SilentlyContinue) {
    if ((Get-Date) -gt $deadline) { L 'wait timeout'; break }
    Start-Sleep -Seconds 1
  }
  L 'updater exited'
}
Start-Sleep -Seconds 3
# 更新器替换 core 文件（app.asar 数十 MB）需数秒：等 asar 头完整且稳定后再启动主程序，
# 避免读到半写/缺失的 asar 一启动即崩溃或触发完整性误报（最多等 60s）
$asar = Join-Path ${_q(updaterDir)} 'resources\app.asar'
L ('asar path=' + $asar)
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
  if ($ok -or ((Get-Date) -gt $t0.AddSeconds(60))) { L ('asar ready=' + $ok); break }
  Start-Sleep -Milliseconds 500
}
L 'starting app'
Start-Process -FilePath ${_q(mainExe)} -WorkingDirectory ${_q(updaterDir)}
L 'app started'
`, 'utf8');
      // 顺序很重要：**先探测下载源、再起更新器、最后起守护进程**。
      // 反过来（旧写法：先起守护、再探测源、最后起更新器）会让守护进程在「更新器还没出现」
      // 的那一刻就查到空结果，误判成「更新已结束」而提前拉起旧版主程序 —— 随后被更新器杀掉，
      // 真正替换完成后再也没人重启它，用户只看到一个停在完成态的更新器窗口。
      // 探测下载源要走 HEAD 请求（最多约 24s），所以这一步必须排在守护进程之前。
      // 主进程也往同一个日志里写几行：更新流程不生效时，看这一份就能知道卡在哪一步。
      const _t = (m) => { try { fs.appendFileSync(_log, new Date().toTimeString().slice(0, 8) + ' [main] ' + m + '\n'); } catch (_) {} };
      let source = 'github';
      _t('probing update source');
      try { source = await pickUpdateSource(); } catch (_) {}
      _t('source=' + source);
      try {
        const upd = spawn(updaterPath, ['-I', '-O', '--source', source], { cwd: updaterDir, detached: true, stdio: 'ignore' });
        upd.on('error', (e) => _t('updater spawn error: ' + String((e && e.message) || e)));
        upd.unref();
        _t('updater spawned pid=' + upd.pid);
      } catch (e) {
        _t('updater spawn threw: ' + String((e && e.message) || e));
        return { ok: false, error: '启动更新器失败：' + String((e && e.message) || e) };
      }
      // 守护进程为什么要绕一层 WMI：
      //   1) detached 的 PowerShell 根本起不来 —— 实测 DETACHED_PROCESS 下
      //      `powershell.exe -File` 一秒内退出、退出码 0、脚本一行都没执行（宿主机与
      //      虚拟机都能复现，与脚本内容无关）；
      //   2) 而不 detached 的子进程会随主进程一起结束，也活不到"更新器退出"那一刻；
      //   3) Win32_Process.Create 建出来的进程挂在 WmiPrvSE 下，既不在本进程的进程树里、
      //      也不带 DETACHED_PROCESS，PowerShell 能正常执行脚本。
      // 实测：主进程退出后守护脚本仍把后续流程跑完（日志 start / after 3s / done 齐全）。
      const psExe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const launcher = path.join(path.dirname(daemon), 'fufumidi-guard-launch.ps1');
      try {
        const cmd = psExe + ' -NoProfile -ExecutionPolicy Bypass -File "' + daemon + '"';
        fs.writeFileSync(launcher, 'Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = \'' + cmd + '\' } | Out-Null\r\n', 'utf8');
      } catch (e) { _t('launcher write failed: ' + String((e && e.message) || e)); }
      const launchGuard = () => new Promise((res) => {
        let done = false;
        const fin = (why) => { if (!done) { done = true; _t('launcher ' + why); res(); } };
        try {
          const p = spawn(psExe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher], { stdio: 'ignore', windowsHide: true });
          p.on('error', (e) => fin('error: ' + String((e && e.message) || e)));
          p.on('exit', (c) => fin('exit code=' + c));
        } catch (e) { fin('threw: ' + String((e && e.message) || e)); }
        setTimeout(() => fin('timeout'), 20000);
      });
      await launchGuard();
      // 确认守护进程真的起来了（它第一件事就是往日志里写 [guard] start）再让本进程退出：
      // 否则主进程先没了，守护是否起来就无从判断，出了问题也只剩「应用没回来」一个现象。
      const t0 = Date.now();
      while (Date.now() - t0 < 10000) {
        let seen = false;
        try { seen = fs.readFileSync(_log, 'utf8').indexOf('[guard]') >= 0; } catch (_) {}
        if (seen) { _t('guard confirmed alive'); break; }
        await new Promise((r) => setTimeout(r, 200));
      }
      // 更新器要替换主程序 exe；若本进程仍运行，exe 被内存映射（user-mapped section）占用，
      // 更新器覆盖时会报 CREATE_TARGET_FILE_ERR / os error 1224。故先让应用自行退出，
      // 释放 exe 映射，再交给守护进程等待更新器完成后拉起新版本。
      try { setTimeout(() => { try { app.exit(0); } catch (_) {} }, 400); } catch (_) {}
      return { ok: true, launching: true, updaterPath, source };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerUpdateIpc };
