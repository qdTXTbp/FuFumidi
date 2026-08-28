// ============================================================
// 主进程动态壁纸服务：桌面视频发现、GitHub 壁纸库列取与下载
// ============================================================
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

function streamDownload(url, dest, onProgress, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'FuFumidi' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(streamDownload(next, dest, onProgress, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const total = parseInt(res.headers['content-length'] || '0', 10) || 0;
      let received = 0;
      let lastPct = -1;
      const ws = fs.createWriteStream(dest);
      // 单 data 监听（不再同时 pipe，避免双监听）；进度按 ~2% 间隔节流，避免高频事件闪烁
      res.on('data', (chunk) => {
        received += chunk.length;
        const pct = total ? Math.round(received / total * 100) : 0;
        if (onProgress && total > 0 && (pct >= lastPct + 2 || pct === 100)) {
          lastPct = pct;
          try { onProgress(Math.max(0, Math.min(1, received / total))); } catch (e) {}
        }
        if (!ws.write(chunk)) {
          res.pause();
          ws.once('drain', () => res.resume());
        }
      });
      res.on('end', () => { ws.end(); });
      ws.on('finish', () => { try { if (onProgress) onProgress(1); } catch (e) {} resolve(); });
      ws.on('error', reject);
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

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
  const thumbCacheDir = path.join(app.getPath('userData'), 'wallpaper-thumbs');
  try { f.mkdirSync(thumbCacheDir, { recursive: true }); } catch (e) {}
  // 远程壁纸目录缓存：5 分钟内直接复用 GitHub API 结果
  async function fetchRemoteList() {
    const cacheFile = path.join(thumbCacheDir, 'wallpaper-list.json');
    try {
      if (f.existsSync(cacheFile)) {
        const age = Date.now() - f.statSync(cacheFile).mtimeMs;
        if (age < 5 * 60 * 1000) {
          const cached = JSON.parse(f.readFileSync(cacheFile, 'utf8'));
          if (cached && Array.isArray(cached.vids) && Array.isArray(cached.thumbs)) return cached;
        }
      }
    } catch (e) {}
    const res = await net.fetch(`https://api.github.com/repos/${WALLPAPER_REPO}/contents/${WALLPAPER_DIR}`, {
      headers: { 'User-Agent': 'FuFumidi', Accept: 'application/vnd.github+json' },
    });
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
        let thumb = th ? `${WALLPAPER_RAW}/${encodeURIComponent(th.name)}` : '';
        if (thumb) {
          const safeName = (th.name || f.name).replace(/[\\/:*?"<>|]/g, '_');
          thumb = await fetchThumbDataCached(net, thumb, path.join(thumbCacheDir, safeName));
        }
        return { name: f.name, video: `${WALLPAPER_MEDIA}/${encodeURIComponent(f.name)}`, remote: `${WALLPAPER_MEDIA}/${encodeURIComponent(f.name)}`, thumb };
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
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
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
      const thumb = path.join(dir, name.replace(/\.(mp4|webm|mov)$/i, '') + '.jpg');
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
      const tmp = dest + '.part';
      const sendP = (p) => {
        try { if (evt && !evt.sender.isDestroyed()) evt.sender.send('wallpaper:downloadProgress', { name: safe, progress: p }); } catch (e) {}
      };
      sendP(0);
      await streamDownload(url, tmp, (p) => sendP(p));
      // 完整性校验：0 字节 = 下载失败/被拦截，删除残留避免假壁纸
      let size = 0;
      try { size = f.statSync(tmp).size; } catch (e) {}
      if (size <= 0) {
        try { f.unlinkSync(tmp); } catch (e) {}
        return { ok: false, error: '下载文件为空（网络受限或文件被拦截），已回退在线壁纸' };
      }
      // 改名到正式文件名（原子替换：先删旧再改名），并写完成标记 .ok
      if (f.existsSync(dest)) { try { f.unlinkSync(dest); } catch (e) {} }
      f.renameSync(tmp, dest);
      try { f.writeFileSync(dest + '.ok', '1', 'utf8'); } catch (e) {}
      sendP(1);
      return { ok: true, path: dest, name: safe, size };
    } catch (e) {
      const safe = String(name || 'wallpaper').replace(/[\\/:*?"<>|]/g, '_');
      const tmp = path.join(dir, safe + '.part');
      try { if (f.existsSync(tmp)) f.unlinkSync(tmp); } catch (e2) {}
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

module.exports = { registerWallpaperIpc };
