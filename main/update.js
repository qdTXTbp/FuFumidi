// ============================================================
// 主进程更新服务：GitHub releases 检查 / 下载 / 打开
// ============================================================
'use strict';
const Paths = require('./paths');
const DS = require('./download-source');
const createFastDownload = require('./fast-download');
const { updaterLooksConfigured } = require('./update_util');
const ST = require('./update-speedtest');
const { fetchManifest, verifyManifest } = require('./update_sign');

// ── 更新通道 ────────────────────────────────────────────────────────────────
// stable：用 GitHub 的 releases/latest 锚点。该端点会自动跳过 prerelease，
//         所以测试版永远不会顶掉正式用户看到的版本。
// beta  ：用固定 tag `beta` 的 release，每次内测以同一资产名覆盖上传。
//         必须是固定 tag —— kachina 更新器的源地址编译在 exe 里，只能靠
//         `--source <id>` 选源，没法在运行时换成带版本号的动态 URL。
const GH_REPO = 'qdTXTbp/FuFumidi';
const GH_WEB = 'https://github.com/' + GH_REPO + '/';
const GH_API = 'https://api.github.com/repos/' + GH_REPO + '/';
const UA = 'FuFumidi/3.1.16';

// 镜像前缀（空串 = 官方直连）。id 与 build/kachina.config.json 的 source 一一对应，
// 测试通道的 id 加 -beta 后缀（ghfast-beta …）。
const UPDATE_MIRRORS = [
  { id: 'ghfast', prefix: 'https://ghfast.top/', label: 'ghfast.top', kind: 'mirror' },
  { id: 'ghproxy', prefix: 'https://gh-proxy.com/', label: 'gh-proxy.com', kind: 'mirror' },
  { id: 'ghproxy-net', prefix: 'https://ghproxy.net/', label: 'ghproxy.net', kind: 'mirror' },
  { id: 'github', prefix: '', label: 'GitHub 官方', kind: 'github' },
];
// 更新包下载地址 / 版本查询接口，按通道取值
const CHANNEL_ASSET_PATH = {
  stable: 'releases/latest/download/FuFumidi.Install.exe',
  beta: 'releases/download/beta/FuFumidi.Install.exe',
};
const CHANNEL_API_PATH = {
  stable: 'releases/latest',
  beta: 'releases?per_page=20',
};
// 测试通道的版本 tag 形如 v4.4.0-beta.1 / v4.4.0-rc.2
const BETA_TAG_RE = /^v?\d+\.\d+\.\d+-(?:beta|rc)\.\d+$/i;

function normChannel(v) { return String(v || '').toLowerCase() === 'beta' ? 'beta' : 'stable'; }
function sourceIdOf(mirrorId, channel) { return normChannel(channel) === 'beta' ? mirrorId + '-beta' : mirrorId; }

function registerUpdateIpc({ ipcMain, shell, BrowserWindow, app, path, fs, net, readSettings }) {
  // 统一高速下载器（规范入口，见 docs/DOWNLOADS.md）
  const FastDL = createFastDownload({ net, fs, path });
  // 最近一次「检查更新」实际访问成功的源 id（先探测它，命中率高）
  let lastGoodSource = null;

  // 当前下载源偏好：'auto' | 'cnb' | 'github'（见 main/download-source.js）
  function pref() {
    try { return DS.normSource(readSettings && readSettings() && readSettings().download_source); } catch (e) { return 'auto'; }
  }
  // 用户测速后手动选定的线路（持久化在设置里）。它只是**提到最前**、不是"锁定"：
  // 不可达时后面的回退链照旧生效（这是安全属性，别改成硬绑定）。
  function preferred() {
    try { return String((readSettings && readSettings() && readSettings().update_preferred_source) || ''); } catch (e) { return ''; }
  }
  // 某个通道下、按偏好排序的更新源（CNB 国内 / GitHub 镜像 · 官方）
  function orderedUpdateSources(channel) {
    const ch = normChannel(channel);
    const cnb = { id: sourceIdOf('cnb', ch), uri: ch === 'beta' ? DS.cnbTagUrl('beta', 'FuFumidi.Install.exe') : DS.cnbLatestUrl('FuFumidi.Install.exe'), label: 'CNB 国内源', kind: 'cnb' };
    const gh = UPDATE_MIRRORS.map(m => ({ id: sourceIdOf(m.id, ch), uri: m.prefix + GH_WEB + CHANNEL_ASSET_PATH[ch], label: m.label, kind: m.kind }));
    const github = gh[gh.length - 1];            // 官方直连（UPDATE_MIRRORS 末位 prefix 为空）
    const mirrors = gh.slice(0, gh.length - 1);  // 国内加速镜像
    // 国内优先：[CNB, 镜像…, GitHub 官方]；全球优先：[GitHub 官方, 镜像…, CNB 兜底]
    const order = DS.preferCnb(pref()) ? [cnb, ...gh] : [github, ...mirrors, cnb];
    return ST.orderCandidates(order, preferred());
  }
  // 从 CNB 的 latest.yml 读最新版本（公开地址，无需认证），合成 GitHub release 同构对象
  async function fetchCnbRelease(channel) {
    const ch = normChannel(channel);
    const versionUrl = ch === 'beta' ? DS.cnbTagUrl('beta', 'latest.yml') : DS.cnbVersionUrl();
    const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
    let text;
    try {
      const r = await net.fetch(versionUrl, { headers: { 'user-agent': UA }, signal: ctrl.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      text = await r.text();
    } finally { clearTimeout(to); }
    const m = String(text).match(/^version:\s*["']?([^\s"']+)/m);
    if (!m) throw new Error('CNB 版本信息缺失');
    const ver = m[1].replace(/^v/i, '');
    const instUrl = ch === 'beta' ? DS.cnbTagUrl('beta', 'FuFumidi.Install.exe') : DS.cnbLatestUrl('FuFumidi.Install.exe');
    return { tag_name: 'v' + ver, body: '', assets: [{ name: 'FuFumidi.Install.exe', browser_download_url: instUrl, size: 0 }] };
  }

  // HEAD 探测可用下载源（每个 6s 超时），失败自动换下一个；全部失败回退最近可达源，再退官方直连
  async function pickUpdateSource(channel) {
    const ch = normChannel(channel);
    const ordered = orderedUpdateSources(channel);
    if (lastGoodSource) {
      const i = ordered.findIndex(s => s.id === lastGoodSource);
      if (i > 0) { const hit = ordered.splice(i, 1)[0]; ordered.unshift(hit); }
    }
    for (const s of ordered) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 6000);
        const r = await net.fetch(s.uri, { method: 'HEAD', headers: { 'user-agent': UA }, signal: ctrl.signal });
        clearTimeout(to);
        if (r.ok) return s.id;
      } catch (e) { /* 该源不可达，尝试下一个 */ }
    }
    return lastGoodSource || sourceIdOf('github', ch);
  }

  // 测试通道的最新版：releases 列表里第一个 prerelease 版本。
  // 必须排除固定锚点 release（tag 就叫 `beta`）—— 它只承载分发资产，不对应版本。
  function pickBetaRelease(list) {
    if (!Array.isArray(list)) return null;
    for (const r of list) {
      if (r && r.prerelease && BETA_TAG_RE.test(String(r.tag_name || ''))) return r;
    }
    return null;
  }

  // 拉某个通道的 release（多镜像回退）
  async function fetchChannelRelease(channel) {
    const ch = normChannel(channel);
    let lastErr = null;
    for (const m of UPDATE_MIRRORS) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
        const r = await net.fetch(m.prefix + GH_API + CHANNEL_API_PATH[ch], { headers: { 'user-agent': UA }, signal: ctrl.signal });
        clearTimeout(to);
        if (!r.ok) { lastErr = new Error('HTTP ' + r.status); continue; }
        const d = await r.json();
        const rel = ch === 'beta' ? pickBetaRelease(d) : d;
        if (rel && rel.tag_name) { lastGoodSource = sourceIdOf(m.id, ch); return rel; }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('无法访问 GitHub');
  }

  // 决定该给用户报哪个版本：测试通道优先取最新测试版，没有测试版时回退正式版
  //（这样测试通道用户不会被卡在旧测试版上，正式版发布后能正常升上去）
  async function resolveRelease(channel) {
    const ch = normChannel(channel);
    // 正式版 + 国内优先：先读 CNB 的 latest.yml（公开地址、免认证）拿版本号
    if (ch === 'stable' && DS.preferCnb(pref())) {
      try { return { release: await fetchCnbRelease('stable'), channel: 'stable' }; } catch (e) { /* 回退 GitHub */ }
    }
    if (ch === 'beta') {
      try { const r = await fetchChannelRelease('beta'); if (r) return { release: r, channel: 'beta' }; } catch (e) {}
    }
    return { release: await fetchChannelRelease('stable'), channel: 'stable' };
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
    const endpoints = UPDATE_MIRRORS.map(m => m.prefix + GH_API + 'releases/tags/' + tag);
    for (const u of endpoints) {
      try {
        const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 12000);
        const r = await net.fetch(u, { headers: { 'user-agent': UA }, signal: ctrl.signal });
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
  /** 更新包签名清单候选地址（CNB latest/beta + GitHub latest/beta + 镜像） */
  function updateManifestUrls(channel) {
    const ch = normChannel(channel);
    const gh = ch === 'beta'
      ? 'https://github.com/' + GH_REPO + '/releases/download/beta/update-manifest.json'
      : 'https://github.com/' + GH_REPO + '/releases/latest/download/update-manifest.json';
    const cnb = ch === 'beta'
      ? DS.cnbTagUrl('beta', 'update-manifest.json')
      : DS.cnbLatestUrl('update-manifest.json');
    return [cnb, ...DS.githubMirrorCandidates(gh)];
  }
  function currentChannel() {
    try { return normChannel(readSettings && readSettings() && readSettings().update_channel); } catch (e) { return 'stable'; }
  }

  async function downloadInstallPackage(url, win) {
    // 按下载源偏好排序：国内优先 → CNB 打头；全球优先 → GitHub（含镜像）打头。
    // githubMirrorCandidates 对非 GitHub 地址原样返回，避免把 CNB 地址套上 gh 镜像前缀。
    const cnbUrl = DS.cnbLatestUrl('FuFumidi.Install.exe');
    const ghChain = DS.githubMirrorCandidates(url);
    const ordered = DS.preferCnb(pref()) ? [cnbUrl, ...ghChain] : [...ghChain, cnbUrl];
    const mirrors = [...new Set(ordered)].filter(Boolean);
    // 优先写数据根目录的 temp/（不占 C 盘）；该目录已在 kachina.config.json 的
    // ignoreFolderPath 中，更新器不会在替换安装目录时把它删掉。不可写时回退系统 Temp。
    let dest = path.join(Paths.tempDir(), 'fufumidi-update', 'FuFumidi.Install.exe');
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    } catch (_) {
      dest = path.join(app.getPath('temp'), 'fufumidi-update', 'FuFumidi.Install.exe');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    }
    // 安装包百兆起步，单连接要几分钟；统一入口会先测速、再按需分段并发（Release 资产支持 Range）。
    // 仍然只写 temp 目录，失败/中断不影响当前安装。
    try {
      const r = await FastDL.downloadFast({
        urls: mirrors,
        dest,
        minSize: 10 * 1024 * 1024,   // 安装包不可能小于 10MB：过小必是错误页
        headers: { 'user-agent': 'FuFumidi' },
        label: 'FuFumidi.Install.exe',
        onProgress: (p) => { if (!p.done) sendUpdateProgress(win, p.received || 0, p.total || 0, false); },
      });
      sendUpdateProgress(win, r.size, r.size, true);
      // P1-8：下载完成后先验签再允许启动更新器。
      // 兼容策略：Release 没有 update-manifest.json（旧版本）时跳过并告警；
      // 一旦清单存在，验签失败就删除安装包并拒绝更新（不提供"忽略"开关）。
      let verified = false;
      try {
        const manifest = await fetchManifest(updateManifestUrls(currentChannel()), net);
        if (manifest) {
          const v = await verifyManifest({ filePath: dest, manifest: manifest });
          if (!v.ok) {
            try { fs.unlinkSync(dest); } catch (e) {}
            return { ok: false, error: '安装包签名校验失败：' + v.error, verified: false };
          }
          verified = true;
          console.log('[update] 安装包签名验证通过：v' + v.version + ' · ' + v.sha256);
        } else {
          console.warn('[update] Release 未提供 update-manifest.json，本次跳过签名校验（旧版本兼容）');
        }
      } catch (e) {
        console.warn('[update] 签名校验异常，跳过：' + String((e && e.message) || e));
      }
      return { ok: true, path: dest, size: r.size, segments: r.segments, verified: verified };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ── 线路测速（BetterGI / FufuLauncher 式：列表 + 延迟 + 速率）─────────────
  // 每条线路只取 SPEEDTEST_BYTES 就断开，并在取够后主动 cancel ——
  // 测速不该把 150 MB 的安装包下完（这是与被测工具一致的做法）。
  async function probeSource(s) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), ST.SPEEDTEST_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const r = await net.fetch(s.uri, {
        headers: { 'user-agent': UA, range: 'bytes=0-' + (ST.SPEEDTEST_BYTES - 1) },
        signal: ctrl.signal,
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      // 首字节时间 = 延迟。它和"速率"是两件事：延迟高、带宽大的线路，
      // 下小文件反而慢 —— 所以两个数都要显示。
      const latencyMs = Date.now() - t0;
      let bytes = 0;
      let head = null;
      if (r.body && typeof r.body.getReader === 'function') {
        const reader = r.body.getReader();
        try {
          while (bytes < ST.SPEEDTEST_BYTES) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (chunk.value && chunk.value.length) {
              if (!head) head = chunk.value;
              bytes += chunk.value.length;
            }
          }
        } finally { try { await reader.cancel(); } catch (e) {} }
      }
      // ★ 拿到的必须真是安装包：安装包是 PE，头两个字节必然是 "MZ"。
      //   镜像返回 200 但塞了 HTML 拦截页/改写内容时，只看 HTTP 状态会把它判成"最快"，
      //   用户选了才开始下载失败。（FufuLauncher 用 ProbeMd5 校验镜像，同一思路。）
      if (head && head.length >= 2 && !(head[0] === 0x4d && head[1] === 0x5a)) {
        throw new Error('返回的不是安装包（可能被镜像拦截或改写）');
      }
      const elapsedMs = Date.now() - t0;
      return Object.assign({}, s, {
        ok: true, latencyMs, bytes, elapsedMs,
        speedMBps: ST.computeSpeedMBps(bytes, latencyMs, elapsedMs),
      });
    } catch (e) {
      return Object.assign({}, s, {
        ok: false, error: (e && e.message) || String(e),
        latencyMs: null, speedMBps: 0, bytes: 0,
      });
    } finally { clearTimeout(to); }
  }

  ipcMain.handle('update:sources', async (_e, channel) => orderedUpdateSources(channel)
    .map(s => ({ id: s.id, label: s.label, kind: s.kind, channel: normChannel(channel) })));

  ipcMain.handle('update:speedtest', async (evt, channel) => {
    const list = orderedUpdateSources(channel);
    const out = [];
    let next = 0;
    // 并发 3：再多会互相抢带宽，测出来的速率就不准了；再少则整张表等太久。
    const worker = async () => {
      while (next < list.length) {
        const s = list[next++];
        const row = await probeSource(s);
        out.push(row);
        try { if (!evt.sender.isDestroyed()) evt.sender.send('update:speedtest:progress', row); } catch (e) {}
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, list.length) }, worker));
    return ST.summarize(out);
  });

  // 把用户选定的线路提到最前（并清掉"最近成功的源"，否则旧选择会压过新选择）
  ipcMain.handle('update:setPreferredSource', async (_e, id) => {
    const v = String(id || '');
    lastGoodSource = v || null;
    return v;
  });

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
  // channel: 'stable' | 'beta'。返回的 channel 是「这个 latest 实际来自哪个通道」，
  // 拉起更新器时必须把它一起传回去 —— 否则会出现「报的是测试版版本、却从正式锚点下载」。
  ipcMain.handle('update:check', async (_e, channel) => {
    try {
      const { release: rel, channel: hit } = await resolveRelease(channel);
      const asset = assetForPlatform(rel);
      const ver = (rel.tag_name || '').replace(/^v/i, '');
      // 下载源：**直连优先**。以前这里无条件把资源地址套上 ghfast.top ——
      // 等于让所有用户的更新都经过一个第三方代理（代理挂了就更新不了，代理也能改包）。
      // 现在只把代理当兜底：downloadInstallPackage 本来就是多源回退（见本文件上方），
      // 直连失败会自动落到镜像链。
      const directUrl = asset ? asset.browser_download_url : null;
      const mirrorUrl = DS.preferCnb(pref())
        ? DS.cnbLatestUrl('FuFumidi.Install.exe')
        : directUrl;
      return { ok: true, current: app.getVersion(), latest: ver, tag: rel.tag_name, channel: hit, notes: (rel.body || '').slice(0, 500), url: asset ? asset.browser_download_url : null, name: asset ? asset.name : null, mirror: mirrorUrl, source: pref() };
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

  /** 配置好的更新器资产地址（随 Release 上传的 FuFumidi.update.exe） */
  function updaterUrls(channel) {
    const ch = normChannel(channel);
    const cnb = ch === 'beta' ? DS.cnbTagUrl('beta', 'FuFumidi.update.exe') : DS.cnbLatestUrl('FuFumidi.update.exe');
    const gh = 'https://github.com/' + GH_REPO + '/releases/' + (ch === 'beta' ? 'download/beta' : 'latest/download') + '/FuFumidi.update.exe';
    return [cnb, ...DS.githubMirrorCandidates(gh)];
  }
  /** 已安装更新器未嵌入配置时：下载 Release 里带配置的更新器到 temp，返回其路径 */
  async function downloadConfiguredUpdater(channel) {
    let dest = path.join(Paths.tempDir(), 'fufumidi-update', 'FuFumidi.update.exe');
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); }
    catch (_) {
      dest = path.join(app.getPath('temp'), 'fufumidi-update', 'FuFumidi.update.exe');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
    }
    const mirrors = [...new Set(updaterUrls(channel))].filter(Boolean);
    const r = await FastDL.downloadFast({
      urls: mirrors,
      dest,
      minSize: 4 * 1024 * 1024,
      headers: { 'user-agent': 'FuFumidi' },
      label: 'FuFumidi.update.exe',
    });
    if (r && r.size && updaterLooksConfigured(fs.readFileSync(dest))) {
      try { fs.chmodSync(dest, 0o755); } catch (_) {}
      return { ok: true, path: dest, size: r.size };
    }
    return { ok: false, error: '下载到的更新器仍未嵌入应用配置（大小 ' + (r && r.size) + '）' };
  }

  // 增量更新流程（kachina 更新器方案，见 UPDATING.md）：
  //  1) 更新器内嵌源配置（ghfast 等镜像，指向 releases/latest/download/FuFumidi.Install.exe）
  //     —— 由更新器自行差分下载（Range 请求）并显示进度，主进程不做整包预下载
  //  2) 主进程探测可用下载源（HEAD，最多约 24s）→ 拉起 FuFumidi.update.exe
  //  3) 主进程再写一份独立守护脚本，用 WMI（Win32_Process.Create）把它拉起来 ——
  //     不能直接 spawn：detached 的 PowerShell 起不来，不 detached 的又会随主进程结束。
  //     守护脚本先等更新器出现、再等它退出（完成文件替换）→ 短暂等待落盘 → 启动新版主程序
  ipcMain.handle('update:launchUpdater', async (evt, channel) => {
    try {
      const { spawn } = require('child_process');
      const updaterDir = app.isPackaged ? path.dirname(process.execPath) : path.join(app.getAppPath(), 'release', 'win-unpacked');
      let updaterPath = path.join(updaterDir, 'FuFumidi.update.exe');
      const mainExe = path.join(updaterDir, 'FuFumidi.exe');
      if (!fs.existsSync(updaterPath)) {
        return { ok: false, error: '更新器不存在：' + updaterPath + '（请使用新版便携版 / 重新下载完整安装包）' };
      }
      // ★ 旧安装包/手动部署可能留下「未嵌入应用配置」的更新器：它会把安装路径认成
      //   C:Program FilesKachinaInstaller，点更新直接报「安装包损坏，请重新下载」。
      //   这里检测并自动改用 Release 里带配置的更新器；下载失败则明确报原因（不再让用户猜）。
      let stagedUpdater = '';
      try {
        if (!updaterLooksConfigured(fs.readFileSync(updaterPath))) {
          try { fs.appendFileSync(path.join(Paths.tempDir(), 'fufumidi-restart.log'), new Date().toTimeString().slice(0, 8) + ' [main] installed updater lacks embedded config; fetching configured one\n'); } catch (_) {}
          const got = await downloadConfiguredUpdater(channel);
          if (!got.ok) {
            return { ok: false, error: '已安装的更新器未嵌入应用配置，自动获取新版更新器失败：' + (got.error || '未知错误') + '。请下载完整安装包覆盖安装。' };
          }
          stagedUpdater = got.path;
          updaterPath = got.path;
        }
      } catch (e) {
        return { ok: false, error: '检查/修复更新器失败：' + String((e && e.message) || e) };
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
      const ch = normChannel(channel);
      let source = sourceIdOf('github', ch);
      _t('channel=' + ch);
      _t('probing update source');
      try { source = await pickUpdateSource(ch); } catch (_) {}
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
