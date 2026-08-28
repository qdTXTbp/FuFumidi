// ============================================================
// 主进程更新服务：GitHub releases 检查 / 下载 / 打开
// ============================================================
'use strict';

const UPDATE_MIRRORS = [
  'https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  'https://ghfast.top/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  'https://ghproxy.net/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
  'https://gh-proxy.com/https://api.github.com/repos/qdTXTbp/FuFumidi/releases/latest',
];

function registerUpdateIpc({ ipcMain, shell, BrowserWindow, app, path, fs, net }) {
  async function fetchLatestRelease() {
    let lastErr = null;
    for (const base of UPDATE_MIRRORS) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
        const r = await net.fetch(base, { headers: { 'user-agent': 'FuFumidi/3.1.2' }, signal: ctrl.signal });
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
  ipcMain.handle('update:download', async (evt, url) => {
    if (!url) return { ok: false, error: 'empty url' };
    const win = BrowserWindow.fromWebContents(evt.sender);
    const mirrors = [url, 'https://ghfast.top/' + url, 'https://gh-proxy.com/' + url, 'https://ghproxy.net/' + url];
    const dest = path.join(app.getPath('temp'), 'fufumidi-update', 'FuFumidi-update' + path.extname(new URL(url).pathname));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    let lastErr = null;
    for (const u of mirrors) {
      try {
        const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.2' } });
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
  // 启动 kachina 更新器（BetterGI 同款增量更新器）：比对文件差异，只下载有改动的部分
  // 流程：主程序先用镜像下载离线包 → 起本地 HTTP 源（更新器走 local 源，避开外部网络 TLS/HTTP2 干扰）
  //       → 更新器差分下载 → 结束进程 → 替换 → 重启
  const LOCAL_PORT = 37779; // 与 Build/kachina.config.json 的 local 源端口一致
  let _localServer = null;

  function startLocalUpdateServer(pkgPath) {
    try {
      const http = require('http');
      if (_localServer) { try { _localServer.close(); } catch (e) {} _localServer = null; }
      const server = http.createServer((req, res) => {
        const url = req.url || '';
        if (url === '/FuFumidi.Install.exe' && req.method === 'GET') {
          try {
            const stat = fs.statSync(pkgPath);
            const range = req.headers.range;
            if (range) {
              const m = range.match(/bytes=(\d+)-(\d*)/);
              const start = m ? parseInt(m[1], 10) : 0;
              const end = (m && m[2]) ? parseInt(m[2], 10) : stat.size - 1;
              res.writeHead(206, { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
              const rs = fs.createReadStream(pkgPath, { start, end });
              rs.on('error', () => res.destroy());
              rs.pipe(res);
            } else {
              res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': stat.size });
              const rs = fs.createReadStream(pkgPath);
              rs.on('error', () => res.destroy());
              rs.pipe(res);
            }
          } catch (e) { res.writeHead(404); res.end(); }
        } else { res.writeHead(404); res.end('not found'); }
      });
      server.listen(LOCAL_PORT, '127.0.0.1');
      _localServer = server;
      return server;
    } catch (e) { return null; }
  }

  function stopLocalUpdateServer() {
    if (_localServer) { try { _localServer.close(); } catch (e) {} _localServer = null; }
  }

  // 下载离线包到临时目录（多镜像回退），返回本地路径
  async function downloadInstallPackage(version) {
    const url = `https://github.com/qdTXTbp/FuFumidi/releases/download/v${version}/FuFumidi.Install.${version}.exe`;
    const mirrors = [url, 'https://ghfast.top/' + url, 'https://gh-proxy.com/' + url, 'https://ghproxy.net/' + url];
    const destDir = path.join(app.getPath('temp'), 'fufumidi-update');
    fs.mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, `FuFumidi.Install.${version}.exe`);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 5 * 1024 * 1024) return dest; // 已下载过直接复用
    let lastErr = null;
    for (const u of mirrors) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 300000);
        const res = await net.fetch(u, { headers: { 'user-agent': 'FuFumidi/3.1.2' }, signal: ctrl.signal });
        clearTimeout(to);
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const ws = fs.createWriteStream(dest + '.part');
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await new Promise((res2, rej2) => ws.write(Buffer.from(value), err => err ? rej2(err) : res2()));
        }
        await new Promise((res2, rej2) => ws.end(err => err ? rej2(err) : res2()));
        fs.renameSync(dest + '.part', dest);
        if (fs.statSync(dest).size > 5 * 1024 * 1024) return dest;
      } catch (e) { lastErr = e; try { fs.unlinkSync(dest + '.part'); } catch (_) {} }
    }
    throw lastErr || new Error('下载离线包失败');
  }

  ipcMain.handle('update:launchUpdater', async (evt, version) => {
    try {
      const updaterDir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getAppPath(), 'release', 'win-unpacked');
      const updaterExe = path.join(updaterDir, 'FuFumidi.update.exe');
      if (!fs.existsSync(updaterExe)) return { ok: false, error: '更新器不存在：' + updaterExe + '（请使用新版便携版 / 重新下载）' };
      // 1) 确定目标版本（未传则查最新）
      let latest = version;
      if (!latest) {
        const rel = await fetchLatestRelease();
        latest = String(rel.tag_name || '').replace(/^v/i, '');
      }
      if (!latest) return { ok: false, error: '无法确定目标版本' };
      // 2) 下载离线包
      const pkg = await downloadInstallPackage(latest);
      // 3) 起本地更新源
      if (!startLocalUpdateServer(pkg)) return { ok: false, error: '无法启动本地更新源' };
      // 4) 拉起更新器（local 源，绕过外部网络 TLS/HTTP2 干扰）
      const { spawn } = require('child_process');
      const cp = spawn(updaterExe, ['-I', '--source', 'local'], { cwd: updaterDir, detached: true, stdio: 'ignore' });
      cp.unref();
      // 5) 更新器完成后清理本地源（守护：更新器退出后关闭服务器）
      setTimeout(() => { try { if (_localServer) _localServer.close(); _localServer = null; } catch (e) {} }, 5 * 60 * 1000);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerUpdateIpc };
