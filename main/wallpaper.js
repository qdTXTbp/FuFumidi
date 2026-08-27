// ============================================================
// 主进程动态壁纸服务：桌面视频发现、GitHub 壁纸库列取与下载
// ============================================================
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');

function streamDownload(url, dest, redirects = 0) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'FuFumidi' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 5) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(streamDownload(next, dest, redirects + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
      const ws = fs.createWriteStream(dest);
      res.pipe(ws);
      ws.on('finish', () => resolve());
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
        if (exts.has(ext)) candidates.push(path.join(dir, file));
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
        return { name: f.name, video: `${WALLPAPER_MEDIA}/${encodeURIComponent(f.name)}`, thumb };
      }));
      const list = remoteThumbs;
      return { ok: true, list: (await listLocalWallpapers()).concat(list) };
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

  // 动态壁纸下载：流式下载视频到 userData/wallpapers，返回本地路径
  ipcMain.handle('wallpaper:download', async (_e, url, name) => {
    try {
      if (!url || !/^https?:\/\//i.test(url)) return { ok: false, error: '无效 URL' };
      const dir = path.join(app.getPath('userData'), 'wallpapers');
      f.mkdirSync(dir, { recursive: true });
      const safe = String(name || 'wallpaper').replace(/[\\/:*?"<>|]/g, '_');
      const dest = path.join(dir, safe);
      await streamDownload(url, dest);
      return { ok: true, path: dest, name: safe };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerWallpaperIpc };
