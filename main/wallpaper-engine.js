// Wallpaper Engine local source: detect/scan, loopback asset server, WebWallGL render page.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const WE_APPID = '431960';
const DEFAULT_STEAM_DIRS = [
  'C:\\Program Files (x86)\\Steam', 'C:\\Program Files\\Steam',
  'D:\\Steam', 'D:\\SteamLibrary', 'E:\\SteamLibrary',
];
let server = null;
let origin = '';
let serverToken = '';
let projects = new Map();
let inventory = { at: 0, items: [], installDir: '', libraries: [], error: '' };

function exists(p) { try { return fs.existsSync(p); } catch (e) { return false; } }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function regQuerySteam() {
  return new Promise((resolve) => {
    const reg = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    execFile(reg, ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }, (err, stdout) => {
      if (err) return resolve('');
      const m = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout || '');
      resolve(m ? m[1].trim().replace(/\//g, '\\') : '');
    });
  });
}
function vdfLibraries(steamRoot) {
  const p = path.join(steamRoot, 'steamapps', 'libraryfolders.vdf');
  let text = ''; try { text = fs.readFileSync(p, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const m of text.matchAll(/^\s*"path"\s+"([^"]+)"\s*$/gm)) {
    const dir = m[1].replace(/\\\\/g, '\\');
    if (!out.includes(dir)) out.push(dir);
  }
  return out;
}
function isWeRoot(dir) {
  if (!dir) return false;
  return ['wallpaper64.exe', 'wallpaper32.exe', 'launcher.exe', 'projects'].some((n) => exists(path.join(dir, n)));
}
async function detect() {
  const envRoots = String(process.env.FUFUMIDI_WE_DIR || process.env.WALLPAPER_ENGINE_DIR || '').split(/[;,]/).map((s) => s.trim()).filter(Boolean);
  const steamRoot = await regQuerySteam();
  const roots = [...envRoots, ...DEFAULT_STEAM_DIRS];
  if (steamRoot) roots.unshift(steamRoot);
  const libraries = [];
  for (const root of roots) {
    if (!root) continue;
    if (!libraries.includes(root)) libraries.push(root);
    for (const lib of [root, ...vdfLibraries(root)]) if (!libraries.includes(lib)) libraries.push(lib);
  }
  let installDir = '';
  const candidates = [...envRoots];
  for (const lib of libraries) candidates.push(path.join(lib, 'steamapps', 'common', 'wallpaper_engine'));
  for (const c of candidates) { if (isWeRoot(c)) { installDir = c; break; } }
  return { installed: !!installDir, installDir, libraries };
}
function projectType(proj, file) {
  let t = String(proj && proj.type || '').toLowerCase();
  if (!['scene', 'video', 'web', 'application'].includes(t)) {
    if (/\.(mp4|webm|mkv|avi|mov)$/i.test(file || '')) t = 'video';
    else if (/\.(html?|js)$/i.test(file || '')) t = 'web';
    else t = 'scene';
  }
  return t;
}
function resolveMain(dir, declared, type) {
  const cands = type === 'scene' ? [declared, 'scene.pkg', 'scene.json'] : [declared];
  for (const c of cands) { if (c && exists(path.join(dir, c))) return c; }
  if (type === 'scene') {
    try { const p = fs.readdirSync(dir).filter((n) => /\.pkg$/i.test(n)); if (p.length === 1) return p[0]; } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
  }
  return declared || '';
}
function scanSync(installed) {
  const roots = [];
  if (installed.installDir) for (const sub of ['myprojects', 'defaultprojects']) { const p = path.join(installed.installDir, 'projects', sub); if (exists(p)) roots.push(p); }
  for (const lib of installed.libraries || []) { const p = path.join(lib, 'steamapps', 'workshop', 'content', WE_APPID); if (exists(p)) roots.push(p); }
  const found = new Map();
  for (const root of roots) {
    let names = []; try { names = fs.readdirSync(root); } catch (e) { continue; }
    for (const name of names) {
      const dir = path.join(root, name);
      try { if (!fs.statSync(dir).isDirectory()) continue; } catch (e) { continue; }
      const proj = readJson(path.join(dir, 'project.json'));
      if (!proj || !proj.file) continue;
      const type = projectType(proj, proj.file);
      const file = resolveMain(dir, proj.file, type);
      if (!file) continue;
      const id = crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 16);
      if (found.has(id)) continue;
      found.set(id, { id, title: String(proj.title || name), type, file, preview: proj.preview ? String(proj.preview) : '', dir, source: 'wallpaper-engine', workshopId: /^\d+$/.test(name) ? name : '' });
    }
  }
  return [...found.values()].sort((a, b) => String(a.title).localeCompare(String(b.title)));
}
function publicItem(it) {
  return {
    id: it.id, title: it.title, type: it.type, source: 'wallpaper-engine',
    workshopId: it.workshopId || '',
    preview: it.preview ? '/preview/' + encodeURIComponent(it.id) : '',
    icon: it.type,
  };
}
async function buildInventory(force) {
  if (!force && inventory.items.length && Date.now() - inventory.at < 30000) return inventory;
  const d = await detect();
  const items = d.installed ? scanSync(d) : [];
  projects = new Map(items.map((it) => [it.id, it]));
  inventory = { at: Date.now(), installed: !!d.installed, items: items.map(publicItem), installDir: d.installDir, libraries: d.libraries, error: d.installed ? '' : '未检测到 Wallpaper Engine' };
  return inventory;
}
function contentType(p) {
  const e = path.extname(p).toLowerCase();
  return ({ '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.pkg': 'application/octet-stream', '.tex': 'application/octet-stream', '.svg': 'image/svg+xml' }[e] || 'application/octet-stream');
}
function send(res, status, body, headers) { try { res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' }, headers || {})); res.end(body); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } }
function serveFile(req, res, file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return send(res, 404, 'not found');
    const type = contentType(file), range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      let start = m && m[1] ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : st.size - 1;
      if (start >= st.size) return send(res, 416, '', { 'Content-Range': 'bytes */' + st.size });
      end = Math.min(end, st.size - 1);
      res.writeHead(206, { 'Content-Type': type, 'Content-Length': end - start + 1, 'Content-Range': 'bytes ' + start + '-' + end + '/' + st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (e) { send(res, 404, 'not found'); }
}
function safeJoin(dir, rel) {
  const base = path.resolve(dir);
  const p = path.resolve(base, rel || '');
  return p === base || p.startsWith(base + path.sep) ? p : null;
}
function ensureServer() {
  if (server) return Promise.resolve(origin);
  serverToken = crypto.randomBytes(18).toString('hex');
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      try {
        const u = new URL(req.url || '/', 'http://127.0.0.1');
        const prefix = '/we/' + serverToken;
        if (!u.pathname.startsWith(prefix)) return send(res, 403, 'forbidden');
        const rest = u.pathname.slice(prefix.length) || '/';
        if (rest === '/inventory') {
          buildInventory(false).then((inv) => send(res, 200, JSON.stringify({ ok: true, items: inv.items, installed: !!inv.installDir, installDir: inv.installDir, error: inv.error }), { 'Content-Type': 'application/json; charset=utf-8' })).catch((e) => send(res, 500, JSON.stringify({ ok: false, error: String(e) }), { 'Content-Type': 'application/json' }));
          return;
        }
        if (rest === '/render' || rest === '/render/') {
          try { return send(res, 200, fs.readFileSync(path.join(__dirname, 'wallpaper-engine-render.html'), 'utf8'), { 'Content-Type': 'text/html; charset=utf-8' }); } catch (e) { return send(res, 500, 'render page missing'); }
        }
        if (rest === '/engine.js') {
          let p = '';
          try { p = path.join(path.dirname(require.resolve('webwallgl/package.json')), 'webwallgl.global.min.js'); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } }
          if (!p) return send(res, 404, 'webwallgl missing');
          return serveFile(req, res, p);
        }
        const pm = /^\/preview\/([^/]+)$/.exec(rest);
        if (pm) { const it = projects.get(decodeURIComponent(pm[1])); if (!it || !it.preview) return send(res, 404, 'no preview'); const f = safeJoin(it.dir, it.preview); if (!f) return send(res, 403, 'bad path'); return serveFile(req, res, f); }
        const fm = /^\/files\/([^/]+)\/(.*)$/.exec(rest);
        if (fm) { const it = projects.get(decodeURIComponent(fm[1])); if (!it) return send(res, 404, 'no project'); const f = safeJoin(it.dir, decodeURIComponent(fm[2] || '')); if (!f) return send(res, 403, 'bad path'); return serveFile(req, res, f); }
        return send(res, 404, 'not found');
      } catch (e) { send(res, 500, 'error'); }
    });
    server.on('error', () => { server = null; origin = ''; resolve(''); });
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; origin = 'http://127.0.0.1:' + port + '/we/' + serverToken; resolve(origin); });
    if (server.unref) server.unref();
  });
}
function registerWallpaperEngineIpc({ ipcMain, shell, app }) {
  ipcMain.handle('wallpaperEngine:detect', async () => detect());
  ipcMain.handle('wallpaperEngine:inventory', async (_e, force) => {
    const inv = await buildInventory(!!force);
    const base = await ensureServer();
    return { ok: true, ...inv, items: inv.items.map((it) => ({ ...it, preview: it.preview && base ? base + it.preview : '' })) };
  });
  ipcMain.handle('wallpaperEngine:view', async (_e, id) => {
    const inv = await buildInventory(false);
    const it = inv.items.find((x) => x.id === id);
    if (!it) return { ok: false, error: '壁纸不存在' };
    const base = await ensureServer();
    if (!base) return { ok: false, error: '资源服务启动失败' };
    const p = projects.get(id);
    const q = new URLSearchParams({ id, type: it.type, fit: 'cover', fps: '30', file: p ? p.file : '', preview: it.preview ? base + '/preview/' + encodeURIComponent(id) : '' });
    return { ok: true, url: base + '/render?' + q.toString(), item: it };
  });
  ipcMain.handle('wallpaperEngine:openFolder', async () => { const d = await detect(); if (d.installDir && shell) shell.openPath(d.installDir); return { ok: !!d.installDir }; });
  if (app && app.on) app.on('before-quit', () => { try { if (server) server.close(); } catch (e) { try { require('./log').write('WARN', 'optional failure', String((e && e.stack) || e)); } catch (_) { /* log failure ignored */ } } server = null; origin = ''; });
}
module.exports = { registerWallpaperEngineIpc, detect, scanSync };
