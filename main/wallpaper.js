// ============================================================
// 主进程动态壁纸服务：桌面视频发现、GitHub 壁纸库列取与下载
// ============================================================
'use strict';
const DS = require('./download-source');

const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const Paths = require('./paths');
const createFastDownload = require('./fast-download');



async function fetchThumbData(net, url) {
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': 'FuFumidi' } });
    if (!res.ok || !res.body) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = /\.png$/i.test(url) ? 'image/png' : 'image/jpeg';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) { return ''; }
}

async function fetchThumbDataCached(net, url, cachePath) {
  try {
    if (fs.existsSync(cachePath)) {
      return 'data:image/jpeg;base64,' + fs.readFileSync(cachePath).toString('base64');
    }
    const data = await fetchThumbData(net, url);
    if (data && data.startsWith('data:image/')) {
      const base64 = data.split(',')[1];
      if (base64) {
        try { fs.writeFileSync(cachePath, Buffer.from(base64, 'base64')); } catch (e) {}
      }
    }
    return data;
  } catch (e) { return ''; }
}

function registerWallpaperIpc({ ipcMain, app, fs: f, net, runEngineInline, parsePyJson }) {
  // 统一高速下载器（规范入口，见 docs/DOWNLOADS.md）
  const FastDL = createFastDownload({ net, fs, path });
  // 动态壁纸：发现桌面上的视频文件（mp4/webm/mov），供渲染进程作为壁纸源
  ipcMain.handle('wallpaper:defaults', async () => {
    try {
      const desktop = app.getPath('desktop');
      const exts = new Set(['.mp4', '.webm', '.mov']);
      const out = [];
      if (f.existsSync(desktop)) {
        for (const file of f.readdirSync(desktop)) {
          const ext = path.extname(file).toLowerCase();
          if (exts.has(ext)) out.push(path.join(desktop, file));
        }
      }
      out.sort((a, b) => a.localeCompare(b, 'zh'));
      return { ok: true, files: out.slice(0, 4) };
    } catch (e) { return { ok: false, files: [] }; }
  });

  async function ensureLocalThumb(videoPath, dir) {
    try {
      const base = path.basename(videoPath).replace(/\.(mp4|webm|mov)$/i, '');
      const thumbPath = path.join(dir, base + '.jpg');
      if (f.existsSync(thumbPath)) {
        return 'data:image/jpeg;base64,' + f.readFileSync(thumbPath).toString('base64');
      }
      if (!runEngineInline) return '';
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', thumbPath];
      const code =
        'import json, subprocess\n' +
        'import imageio_ffmpeg\n' +
        'ff = imageio_ffmpeg.get_ffmpeg_exe()\n' +
        'r = subprocess.run([ff] + ' + JSON.stringify(args) + ', capture_output=True)\n' +
        "print(json.dumps({'ok': r.returncode == 0, 'err': (r.stderr or b'').decode('utf-8', 'replace')[-300:]}))";
      const rr = await runEngineInline(code);
      const d = parsePyJson ? parsePyJson(rr.out) : null;
      if (d && d.ok && f.existsSync(thumbPath)) {
        return 'data:image/jpeg;base64,' + f.readFileSync(thumbPath).toString('base64');
      }
      return '';
    } catch (e) { return ''; }
  }

  async function listLocalWallpapers() {
    try {
      const dir = path.join(app.getPath('userData'), 'wallpapers');
      if (!f.existsSync(dir)) return [];
      const exts = new Set(['.mp4', '.webm', '.mov']);
      const candidates = [];
      for (const file of f.readdirSync(dir)) {
        const ext = path.extname(file).toLowerCase();
        if (!exts.has(ext)) continue;
        if (file.endsWith('.part')) continue;   // 下载中的临时文件，不算已下载
        const full = path.join(dir, file);
        // 过滤损坏/未完成的空文件（0 字节），避免列出假壁纸导致应用后黑屏
        try { if (f.statSync(full).size <= 0) continue; } catch (e) { continue; }
        // 只把「完整下载」的壁纸视为已下载（下载完成会写 .ok 标记）
        if (!f.existsSync(full + '.ok')) continue;
        candidates.push(full);
      }
      const thumbs = await Promise.all(candidates.map(videoPath => ensureLocalThumb(videoPath, dir)));
      const out = candidates.map((videoPath, i) => ({ name: path.basename(videoPath), video: videoPath, thumb: thumbs[i], local: true }));
      out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      return out;
    } catch (e) { return []; }
  }

  // 动态壁纸库：从 GitHub Media 仓库列出壁纸（视频 + 同名缩略图），供用户选择下载
  const WALLPAPER_REPO = 'monologue82/Media';
  const WALLPAPER_DIR = 'wallpapers';
  const WALLPAPER_RAW = `https://raw.githubusercontent.com/${WALLPAPER_REPO}/main/${WALLPAPER_DIR}`;
  // Git LFS 视频需通过 media.githubusercontent.com 获取真实文件
  const WALLPAPER_MEDIA = `https://media.githubusercontent.com/media/${WALLPAPER_REPO}/main/${WALLPAPER_DIR}`;
  // CNB 侧同一仓库的整树镜像：视频真身与缩略图都能走 git raw 直读（比 media 域名快得多）
  const cnbWallpaperUrl = (name) => DS.cnbRepoRawUrl(DS.CNB_MIRROR_REPOS.media, 'main', `${WALLPAPER_DIR}/${name}`);
  // 但 CNB 的 git raw 单文件上限是 100 MiB（超过返回 errcode 2000033
  // "raw file size xxx MiB exceeded 100 MiB"），推得进仓库却读不出来。
  // 超限壁纸只能作为 Release 资产（对象存储）分发 —— 与音色库、GPU 包同一套规则。
  const CNB_WP_RELEASE_FILES = new Set(['studio_video_1716732543213.mp4']);
  /** 壁纸在国内源的地址：超限的走 Release 资产，其余走 git raw 直读 */
  const cnbBestWallpaperUrl = (name) => (CNB_WP_RELEASE_FILES.has(name)
    ? DS.cnbRepoReleaseUrl(DS.CNB_MIRROR_REPOS.media, 'wallpapers-v1', name)
    : cnbWallpaperUrl(name));
  const thumbCacheDir = Paths.cacheDir('wallpaper-thumbs');
  try { f.mkdirSync(thumbCacheDir, { recursive: true }); } catch (e) {}
  async function ensureFolderThumb(videoPath) {
    try {
      const st = f.statSync(videoPath);
      const key = crypto.createHash('sha1').update(String(videoPath) + '|' + st.size + '|' + st.mtimeMs).digest('hex').slice(0, 20);
      const thumbPath = path.join(thumbCacheDir, key + '.jpg');
      if (f.existsSync(thumbPath) && f.statSync(thumbPath).size > 0) return thumbPath;
      if (!runEngineInline) return '';
      const args = ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', thumbPath];
      const code =
        'import json, subprocess\n' +
        'import imageio_ffmpeg\n' +
        'ff = imageio_ffmpeg.get_ffmpeg_exe()\n' +
        'r = subprocess.run([ff] + ' + JSON.stringify(args) + ', capture_output=True)\n' +
        "print(json.dumps({'ok': r.returncode == 0, 'err': (r.stderr or b'').decode('utf-8', 'replace')[-300:]}))";
      const rr = await runEngineInline(code);
      const d = parsePyJson ? parsePyJson(rr.out) : null;
      if (d && d.ok && f.existsSync(thumbPath) && f.statSync(thumbPath).size > 0) return thumbPath;
    } catch (e) {}
    return '';
  }
  // 远程壁纸目录缓存：5 分钟内直接复用 GitHub API 结果
  async function fetchRemoteList() {
    const cacheFile = path.join(thumbCacheDir, 'wallpaper-list.json');
    let stale = null;
    try {
      if (f.existsSync(cacheFile)) {
        const age = Date.now() - f.statSync(cacheFile).mtimeMs;
        if (age < 5 * 60 * 1000) {
          const cached = JSON.parse(f.readFileSync(cacheFile, 'utf8'));
          if (cached && Array.isArray(cached.vids) && Array.isArray(cached.thumbs)) stale = cached;
          if (cached && Array.isArray(cached.vids) && Array.isArray(cached.thumbs)) return cached;
        }
      }
    } catch (e) {}
    let res;
    try { res = await Promise.race([
      net.fetch(`https://api.github.com/repos/${WALLPAPER_REPO}/contents/${WALLPAPER_DIR}`, {
        headers: { 'User-Agent': 'FuFumidi', Accept: 'application/vnd.github+json' },
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('壁纸列表请求超时')), 5000)),
    ]); } catch (err) {
      if (stale) return stale;
      throw err;
    }
    if (!res.ok) throw new Error('GitHub API ' + res.status);
    const items = await res.json();
    const vids = items.filter(x => x.type === 'file' && /\.(mp4|webm|mov)$/i.test(x.name));
    const thumbs = items.filter(x => x.type === 'file' && /\.(jpg|jpeg|png)$/i.test(x.name));
    try { f.writeFileSync(cacheFile, JSON.stringify({ vids, thumbs })); } catch (e) {}
    return { vids, thumbs };
  }
  ipcMain.handle('wallpaper:list', async () => {
    try {
      const { vids, thumbs } = await fetchRemoteList();
      const remoteThumbs = await Promise.all(vids.map(async (f) => {
        const base = f.name.replace(/\.(mp4|webm|mov)$/i, '');
        const th = thumbs.find(t => t.name.replace(/\.(jpg|jpeg|png)$/i, '') === base);
        const safeName = ((th && th.name) || f.name).replace(/[\\/:*?"<>|]/g, '_');
        // 缩略图：按下载源偏好先试 CNB 镜像，失败再回退 GitHub raw
        let thumb = '';
        if (th) {
          for (const u of DS.orderUrls(cnbWallpaperUrl(th.name), `${WALLPAPER_RAW}/${encodeURIComponent(th.name)}`)) {
            thumb = await fetchThumbDataCached(net, u, path.join(thumbCacheDir, safeName));
            if (thumb) break;
          }
        }
        // 视频地址：国内优先给 CNB 镜像（视频是 LFS，GitHub media 域名在国内很慢）；
        // 超限视频由 cnbBestWallpaperUrl 自动改用 Release 资产
        const videoUrl = DS.orderUrls(cnbBestWallpaperUrl(f.name), `${WALLPAPER_MEDIA}/${encodeURIComponent(f.name)}`)[0];
        return { name: f.name, video: videoUrl, remote: videoUrl, thumb };
      }));
      // 合并本地壁纸：远程项若本地已有同名文件 → 标记为已下载（local），不重复新增项
      const locals = await listLocalWallpapers();
      const localByBase = new Map();
      for (const l of locals) localByBase.set(l.name.replace(/\.(mp4|webm|mov)$/i, '').toLowerCase(), l);
      const list = remoteThumbs.map((r) => {
        const base = r.name.replace(/\.(mp4|webm|mov)$/i, '').toLowerCase();
        const loc = localByBase.get(base);
        if (loc) return { ...r, local: true, video: loc.video, thumb: loc.thumb || r.thumb };
        return r;
      });
      // 仅本地存在的壁纸（用户自行导入）也展示
      const seen = new Set(list.map(r => r.name.replace(/\.(mp4|webm|mov)$/i, '').toLowerCase()));
      const extra = locals.filter(l => !seen.has(l.name.replace(/\.(mp4|webm|mov)$/i, '').toLowerCase()));
      return { ok: true, list: list.concat(extra) };
    } catch (e) {
      try {
        const locals = await listLocalWallpapers();
        if (locals.length) return { ok: true, list: locals, offline: true, error: String((e && e.message) || e) };
      } catch (err) {}
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // 删除本地壁纸：移除视频与对应缩略图
  ipcMain.handle('wallpaper:removeLocal', async (_e, nameOrPath) => {
    try {
      const name = path.basename(String(nameOrPath || ''));
      if (!name) return { ok: false, error: 'invalid name' };
      const dir = path.join(app.getPath('userData'), 'wallpapers');
      const video = path.resolve(dir, name);
      if (!video.startsWith(path.resolve(dir) + path.sep)) return { ok: false, error: 'path outside wallpaper dir' };
      if (!f.existsSync(video)) return { ok: false, error: 'not found' };
      f.unlinkSync(video);
      try { f.unlinkSync(video + '.ok'); } catch (e) {}   // 完成标记一并删除
      const thumb = path.join(dir, name.replace(/\.(mp4|webm|mov|jpg|jpeg|png|webp|avif|gif)$/i, '') + '.jpg');
      if (f.existsSync(thumb)) f.unlinkSync(thumb);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 本地壁纸导入：将用户选择的视频复制到 userData/wallpapers，加入壁纸库
  ipcMain.handle('wallpaper:addLocal', async (event, srcPath) => {
    try {
      if (!srcPath || typeof srcPath !== 'string' || !f.existsSync(srcPath)) return { ok: false, error: '本地文件不存在' };
      const ext = path.extname(srcPath).toLowerCase();
      if (!['.mp4', '.webm', '.mov'].includes(ext)) return { ok: false, error: '不支持的视频格式' };
      const dir = path.join(app.getPath('userData'), 'wallpapers');
      f.mkdirSync(dir, { recursive: true });
      const base = path.basename(srcPath).replace(/[\/:*?"<>|]/g, '_') || 'local-wallpaper.mp4';
      let dest = path.join(dir, base);
      let n = 1;
      const extname = path.extname(base);
      const stem = extname ? base.slice(0, -extname.length) : base;
      while (f.existsSync(dest) && path.resolve(dest) !== path.resolve(srcPath)) {
        dest = path.join(dir, stem + '-' + n + extname);
        n += 1;
      }
      const totalSize = f.statSync(srcPath).size || 0;
      let copied = 0;
      const notify = (p) => {
        try { if (event && !event.sender.isDestroyed()) event.sender.send('wallpaper:addLocalProgress', { path: dest, progress: Math.max(0, Math.min(1, p)) }); } catch (e) {}
      };
      notify(0);
      await new Promise((resolve, reject) => {
        const rs = f.createReadStream(srcPath);
        const ws = f.createWriteStream(dest);
        rs.on('data', (chunk) => {
          copied += chunk.length;
          if (totalSize > 0) notify(copied / totalSize);
        });
        ws.on('finish', resolve);
        ws.on('error', reject);
        rs.on('error', reject);
        rs.pipe(ws);
      });
      notify(1);
      return { ok: true, path: dest, name: path.basename(dest) };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 动态壁纸下载：流式下载视频到 userData/wallpapers，返回本地路径（带进度 + 完整性校验）
  // 先写 .part 临时文件，下载完整后再改名，避免中途退出残留被当作"已下载"
  ipcMain.handle('wallpaper:download', async (evt, url, name) => {
    const dir = path.join(app.getPath('userData'), 'wallpapers');
    try {
      if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: '无效 URL' };
      f.mkdirSync(dir, { recursive: true });
      const safe = String(name || 'wallpaper').replace(/[\\/:*?"<>|]/g, '_');
      const dest = path.join(dir, safe);
      const sendP = (p) => {
        try { if (evt && !evt.sender.isDestroyed()) evt.sender.send('wallpaper:downloadProgress', { name: safe, progress: p }); } catch (e) {}
      };
      sendP(0);
      // 候选源：CNB 镜像（国内快）与 GitHub media，按下载源偏好排序，逐个回退
      const cnb = cnbBestWallpaperUrl(safe);   // 超限视频自动改用 Release 资产地址
      const gh = `${WALLPAPER_MEDIA}/${encodeURIComponent(safe)}`;
      const candidates = /^https:\/\/cnb\.cool\//i.test(url)
        ? DS.orderUrls(url, gh)
        : DS.orderUrls(cnb, /^https:\/\/media\.githubusercontent\.com\//i.test(url) ? url : gh);
      // 下载字节交给统一入口：多源并发测速 + 分段并发 + 断点续传 + 停滞看门狗 + 完整性校验。
      // 旧实现自己写 http/https 流 —— 没有测速、没有续传，断了就从 0 重来，被限速也只能一路慢到底。
      const r = await FastDL.downloadFast({
        urls: candidates,
        dest,
        minSize: 64 * 1024,
        headers: { 'user-agent': 'FuFumidi' },
        label: safe,
        onProgress: (p) => { if (!p.done) sendP(Math.max(0, Math.min(0.99, (p.percent || 0) / 100))); },
      });
      const size = r.size;
      if (size <= 0) return { ok: false, error: '下载文件为空（网络受限或文件被拦截），已回退在线壁纸' };
      // 完成标记：与视频同名，界面据此判定「已下载」
      try { f.writeFileSync(dest + '.ok', '1', 'utf8'); } catch (e) {}
      sendP(1);
      return { ok: true, path: dest, name: safe, size };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // 在线静态壁纸：Wallhaven 公开 API；网络不可用时优雅回退到公开壁纸源
  async function fetchJsonWithTimeout(url, timeoutMs = 10000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await net.fetch(url, {
        headers: { 'User-Agent': 'FuFumidi/6.2.1', Accept: 'application/json' },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally { clearTimeout(timer); }
  }
  async function bingWallpaperFallback() {
    const j = await fetchJsonWithTimeout('https://www.bing.com/HPImageArchive.aspx?format=js&idx=0&n=8&mkt=zh-CN', 8000);
    const imgs = Array.isArray(j && j.images) ? j.images : [];
    return imgs.map((img, i) => {
      const base = String(img.urlbase || '');
      const full = 'https://www.bing.com' + base + '_1920x1080.jpg';
      const thumb = 'https://www.bing.com' + base + '_400x240.jpg';
      const nameBase = String(img.hsh || ('bing-' + (i + 1)));
      return { id: 'bing-' + nameBase, name: 'bing-' + nameBase + '.jpg', image: full, thumb, kind: 'image', source: 'Bing 每日壁纸', copyright: String(img.copyright || '') };
    }).filter(x => x.image);
  }
  ipcMain.handle('wallpaper:searchWallhaven', async (_e, q, page) => {
    const query = String(q || 'wallpaper').trim() || 'wallpaper';
    const p = Math.max(1, Math.min(60, Number(page) || 1));
    try {
      const api = 'https://wallhaven.cc/api/v1/search?q=' + encodeURIComponent(query) + '&page=' + p + '&purity=100&categories=100&sorting=relevance&order=desc';
      const j = await fetchJsonWithTimeout(api, 12000);
      const data = Array.isArray(j && j.data) ? j.data : [];
      if (!data.length) throw new Error('Wallhaven 未返回图片');
      const list = data.map((it) => {
        const ext = (path.extname(String(it.path || '')).toLowerCase() || '.jpg');
        return { id: 'wh-' + it.id, name: 'wallhaven-' + it.id + ext, image: it.path, remote: it.path, thumb: (it.thumbs && (it.thumbs.large || it.thumbs.original || it.thumbs.small)) || it.path, kind: 'image', source: 'Wallhaven', resolution: it.resolution || '', category: it.category || '' };
      }).filter(x => x.image);
      const meta = (j && j.meta) || {};
      return { ok: true, list, page: Number(meta.current_page) || p, last: Number(meta.last_page) || p, source: 'Wallhaven' };
    } catch (e) {
      try {
        const list = await bingWallpaperFallback();
        if (list.length) return { ok: true, list, page: 1, last: 1, source: 'Bing 每日壁纸', warning: String((e && e.message) || e) };
      } catch (e2) {}
      return { ok: false, error: '在线壁纸搜索失败：' + String((e && e.message) || e) };
    }
  });

  // 直链下载：图片直接落盘，视频走统一高速下载器；按 content-type/扩展名判断静态/动态
  ipcMain.handle('wallpaper:downloadUrl', async (_e, url, name) => {
    try {
      const src = String(url || '');
      if (!/^https?:\/\//i.test(src)) return { ok: false, error: '无效 URL' };
      const dir = path.join(app.getPath('userData'), 'wallpapers');
      f.mkdirSync(dir, { recursive: true });
      let ct = '';
      try {
        const head = await net.fetch(src, { method: 'HEAD', headers: { 'User-Agent': 'FuFumidi' } });
        ct = String(head.headers.get('content-type') || '').toLowerCase();
      } catch (e) {}
      const urlPath = (() => { try { return new URL(src).pathname; } catch (e) { return src; } })();
      const extOfUrl = (path.extname(urlPath) || '').toLowerCase();
      const imageExt = /\.(jpe?g|png|webp|avif|gif|bmp)$/i.test(extOfUrl);
      const videoExt = /\.(mp4|webm|mov|mkv)$/i.test(extOfUrl);
      const isImage = /^image\//i.test(ct) || imageExt;
      const isVideo = /^video\//i.test(ct) || videoExt;
      const safeBase = String(name || path.basename(urlPath) || 'wallpaper').replace(/[\\/:*?"<>|]/g, '_').replace(/\.(jpe?g|png|webp|avif|gif|bmp|mp4|webm|mov|mkv)$/i, '');
      const stamp = Date.now().toString(36);
      if (isImage || (!isVideo && !isImage)) {
        const res = await net.fetch(src, { headers: { 'User-Agent': 'FuFumidi' } });
        if (!res.ok) return { ok: false, error: '下载失败：HTTP ' + res.status };
        const buf = Buffer.from(await res.arrayBuffer());
        if (!buf.length) return { ok: false, error: '下载文件为空' };
        const ext = extOfUrl && imageExt ? extOfUrl : (ct.includes('png') ? '.png' : ct.includes('webp') ? '.webp' : ct.includes('gif') ? '.gif' : '.jpg');
        const dest = path.join(dir, safeBase + '-' + stamp + ext);
        f.writeFileSync(dest, buf);
        return { ok: true, path: dest, name: path.basename(dest), kind: 'image', size: buf.length };
      }
      const ext = extOfUrl && videoExt ? extOfUrl : '.mp4';
      const dest = path.join(dir, safeBase + '-' + stamp + ext);
      const r = await FastDL.downloadFast({ urls: [src], dest, minSize: 64 * 1024, headers: { 'user-agent': 'FuFumidi' }, label: safeBase });
      if (!r || !r.size) return { ok: false, error: '视频下载失败' };
      try { f.writeFileSync(dest + '.ok', '1', 'utf8'); } catch (e) {}
      return { ok: true, path: dest, name: path.basename(dest), kind: 'video', size: r.size };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });

  // 外部文件夹壁纸：只登记路径、不复制文件；递归扫描常见图片/视频格式
  ipcMain.handle('wallpaper:scanFolder', async (_e, dir) => {
    try {
      const root = String(dir || '');
      if (!root || !f.existsSync(root) || !f.statSync(root).isDirectory()) return { ok: false, error: '文件夹不存在' };
      const imageExt = new Set(['.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.bmp']);
      const videoExt = new Set(['.mp4', '.webm', '.mov', '.mkv']);
      const out = [];
      const walk = (d, depth) => {
        if (out.length >= 600 || depth > 3) return;
        let items = [];
        try { items = f.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
        for (const it of items) {
          if (out.length >= 600 || it.name.startsWith('.')) continue;
          const full = path.join(d, it.name);
          if (it.isDirectory()) { walk(full, depth + 1); continue; }
          if (!it.isFile()) continue;
          const ext = path.extname(it.name).toLowerCase();
          const kind = imageExt.has(ext) ? 'image' : videoExt.has(ext) ? 'video' : '';
          if (!kind) continue;
          let size = 0; try { size = f.statSync(full).size; } catch (e) {}
          if (size <= 0) continue;
          out.push({ path: full, name: it.name, kind, size });
        }
      };
      walk(root, 0);
      out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
      return { ok: true, list: out };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerWallpaperIpc };
