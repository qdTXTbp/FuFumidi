// ============================================================
// 主进程动态壁纸服务：桌面视频发现、GitHub 壁纸库列取与下载
// ============================================================
'use strict';

const path = require('path');
const fs = require('fs');

async function fetchThumbData(net, url) {
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': 'FuFumidi' } });
    if (!res.ok || !res.body) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    const mime = /\.png$/i.test(url) ? 'image/png' : 'image/jpeg';
    return 'data:' + mime + ';base64,' + buf.toString('base64');
  } catch (e) { return ''; }
}

function registerWallpaperIpc({ ipcMain, app, fs: f, net }) {
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

  // 动态壁纸库：从 GitHub Media 仓库列出壁纸（视频 + 同名缩略图），供用户选择下载
  const WALLPAPER_REPO = 'monologue82/Media';
  const WALLPAPER_DIR = 'wallpapers';
  const WALLPAPER_RAW = `https://raw.githubusercontent.com/${WALLPAPER_REPO}/main/${WALLPAPER_DIR}`;
  ipcMain.handle('wallpaper:list', async () => {
    try {
      const res = await net.fetch(`https://api.github.com/repos/${WALLPAPER_REPO}/contents/${WALLPAPER_DIR}`, {
        headers: { 'User-Agent': 'FuFumidi', Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return { ok: false, error: 'GitHub API ' + res.status };
      const items = await res.json();
      const vids = items.filter(x => x.type === 'file' && /\.(mp4|webm|mov)$/i.test(x.name));
      const thumbs = items.filter(x => x.type === 'file' && /\.(jpg|jpeg|png)$/i.test(x.name));
      const list = [];
      for (const f of vids) {
        const base = f.name.replace(/\.(mp4|webm|mov)$/i, '');
        const th = thumbs.find(t => t.name.replace(/\.(jpg|jpeg|png)$/i, '') === base);
        let thumb = th ? `${WALLPAPER_RAW}/${encodeURIComponent(th.name)}` : '';
        if (thumb) thumb = await fetchThumbData(net, thumb);
        list.push({ name: f.name, video: `${WALLPAPER_RAW}/${encodeURIComponent(f.name)}`, thumb });
      }
      return { ok: true, list };
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
      const res = await net.fetch(url, { headers: { 'User-Agent': 'FuFumidi' } });
      if (!res.ok || !res.body) return { ok: false, error: '下载失败 HTTP ' + res.status };
      const ws = f.createWriteStream(dest);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) ws.write(Buffer.from(value));
      }
      await new Promise((r) => ws.end(r));
      return { ok: true, path: dest, name: safe };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
}

module.exports = { registerWallpaperIpc };
