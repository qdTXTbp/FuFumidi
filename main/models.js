// ============================================================
// 主进程模型服务：模型注册表、下载/暂停/取消、目录监听
// ============================================================
'use strict';

const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

function registerModelsIpc({ ipcMain, BrowserWindow, app, path, fs, net, modelsDir, demucsModelFile, sha256File, readSettings }) {
  const _folderWatchers = new Map();

  // 内置模型注册表：本地模型清单 + 缺失模型官方源一键下载（带进度/取消）
  // 条目字段：
  //   url       单文件直链（可选，自动叠加 gh 镜像回退）
  //   repo      HuggingFace 仓库（type='hf'，走 HF 官方 / hf-mirror 双渠道，整仓递归下载）
  //   dest      本地相对路径（文件或目录）
  const MODEL_REGISTRY = {
    piano_transcription: {
      id: 'piano_transcription',
      name: '钢琴转录模型',
      note: 'piano-transcription CRNN（含踏板检测）· 约 166 MB',
      dest: path.join('piano_transcription', 'note_F1=0.9677_pedal_F1=0.9186.pth'),
      url: 'https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1',
      minSize: 1.6e8,
      downloadable: true,
    },
    // 通用多乐器转录（Kyutai MuScriptor，默认不随 Release 分发，需到资源中心下载）
    // 注意：MuScriptor 为 gated 模型（CC BY-NC 4.0），须先在 HuggingFace 接受协议，
    // 并经 monologue82/Models 仓库分卷分发（gh.jasonzeng.dev 加速，100MB part 合并）。
    muscriptor_small: {
      id: 'muscriptor_small',
      name: 'MuScriptor Small',
      note: '多乐器转录 · 103M 参数 · 约 400 MB · 需 HF 授权',
      type: 'ghsplit',
      sizeKey: 'small',
      repo: 'monologue82/Models',
      dest: path.join('muscriptor', 'small'),
      minSize: 5e7,
      downloadable: true,
      gated: true,
    },
    muscriptor_medium: {
      id: 'muscriptor_medium',
      name: 'MuScriptor Medium',
      note: '多乐器转录 · 307M 参数（推荐）· 约 1.2 GB · 需 HF 授权',
      type: 'ghsplit',
      sizeKey: 'medium',
      repo: 'monologue82/Models',
      dest: path.join('muscriptor', 'medium'),
      minSize: 2e8,
      downloadable: true,
      gated: true,
    },
    muscriptor_large: {
      id: 'muscriptor_large',
      name: 'MuScriptor Large',
      note: '多乐器转录 · 1.4B 参数 · 约 5.2 GB · 需 HF 授权',
      type: 'ghsplit',
      sizeKey: 'large',
      repo: 'monologue82/Models',
      dest: path.join('muscriptor', 'large'),
      minSize: 9e8,
      downloadable: true,
      gated: true,
    },
    // 钢琴转录（EleutherAI Aria-AMT）
    aria_amt: {
      id: 'aria_amt',
      name: 'Aria-AMT 钢琴',
      note: 'EleutherAI · 钢琴转录（Apache-2.0）· 约 680 MB',
      type: 'hf',
      repo: 'AEmotionStudio/aria-amt-models',
      dest: path.join('aria_amt'),
      minSize: 1e8,
      downloadable: true,
    },
  };
  // HuggingFace 渠道：官方 / hf-mirror
  const HF_HOSTS = { huggingface: 'huggingface.co', 'hf-mirror': 'hf-mirror.com' };
  const _modelCancels = new Set();
  const _modelAborts = new Map();
  const _modelPause = new Set();

  ipcMain.handle('model:list', async () => {
    const dir = modelsDir();
    const items = [];
    const push = (name, p, note, extra) => {
      try {
        const st = fs.statSync(p);
        items.push(Object.assign({ name, path: p, size: st.size, exists: true, note: note || '' }, extra || {}));
      } catch (e) { items.push(Object.assign({ name, path: p, size: 0, exists: false, note: note || '' }, extra || {})); }
    };
    push('通用转录（int8 量化）', path.join(dir, 'basic_pitch_quant.onnx'), 'basic-pitch ONNX int8 量化模型（CPU 加速）');
    const pt = MODEL_REGISTRY.piano_transcription;
    push(pt.name, path.join(dir, pt.dest), pt.note, { id: pt.id, downloadable: true });
    const dm = demucsModelFile();
    items.push({ id: 'demucs_htdemucs', name: '人声分离模型', path: dm || '', size: dm ? (() => { try { return fs.statSync(dm).size; } catch (e) { return 0; } })() : 0, exists: !!dm, downloadable: !dm, note: dm ? 'demucs htdemucs 已内置（约 80 MB）' : 'demucs htdemucs（未安装，可一键下载，国内自动走镜像）' });
    // 扩展模型（MuScriptor / Aria-AMT 等）：整目录检查
    for (const k of Object.keys(MODEL_REGISTRY)) {
      if (k === 'piano_transcription') continue;
      const m = MODEL_REGISTRY[k];
      const dest = path.join(dir, m.dest);
      const exists = fs.existsSync(dest);
      const size = exists ? (() => { try { let s = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) s += st.size; else for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }; walk(dest); return s; } catch (e) { return 0; } })() : 0;
      items.push({
        id: m.id, name: m.name, path: dest, size, exists: exists && size >= m.minSize,
        downloadable: true, note: m.note, type: m.type, repo: m.repo, gated: !!m.gated,
      });
    }
    return items;
  });
  ipcMain.handle('model:cancel', async (_e, id) => {
    if (id) { _modelCancels.add(id); try { const c = _modelAborts.get(id); if (c) c.abort(); } catch (e) {} }
    return { ok: true };
  });
  ipcMain.handle('model:delete', async (_e, id) => {
    try {
      let p = null;
      if (id === 'demucs_htdemucs') p = demucsModelFile();
      else if (MODEL_REGISTRY[id]) p = path.join(modelsDir(), MODEL_REGISTRY[id].dest);
      if (!p || !fs.existsSync(p)) return { ok: false, error: 'not found' };
      fs.unlinkSync(p);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  // 本地模型压缩包导入：自动识别 MuScriptor Small/Medium/Large、Aria-AMT、钢琴模型等
  const MODEL_DEST_MATCHERS = [
    { re: /muscriptor[\\/]small[\\/]/i, dest: 'muscriptor/small' },
    { re: /muscriptor[\\/]medium[\\/]/i, dest: 'muscriptor/medium' },
    { re: /muscriptor[\\/]large[\\/]/i, dest: 'muscriptor/large' },
    { re: /aria_amt[\\/]/i, dest: 'aria_amt' },
    { re: /piano_transcription[\\/]/i, dest: 'piano_transcription' },
  ];
  function walkFiles(dir, out = []) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) walkFiles(p, out);
      else out.push(p);
    }
    return out;
  }
  function extractLocalArchive(file, outDir) {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.zip') {
      const zip = new AdmZip(file);
      zip.extractAllTo(outDir, true);
      return;
    }
    if (ext === '.7z') {
      const exe = (() => { try { return process.env.SEVENZIP || '7z'; } catch (e) { return '7z'; } })();
      return new Promise((resolve, reject) => {
        const p = spawn(exe, ['x', '-y', '-o' + outDir, file], { stdio: 'ignore', windowsHide: true });
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve() : reject(new Error('7z 解压失败，请确认系统已安装 7-Zip 或在 PATH 中')));
      });
    }
    if (ext === '.tar' || ext === '.gz' || ext === '.tgz' || ext === '.tar.gz' || ext === '.txz' || ext === '.tar.xz') {
      const args = ext === '.gz' || ext === '.tgz' || ext === '.tar.gz'
        ? ['-xzf', file, '-C', outDir]
        : ['-xf', file, '-C', outDir];
      return new Promise((resolve, reject) => {
        const p = spawn('tar', args, { stdio: 'ignore', windowsHide: true });
        p.on('error', reject);
        p.on('close', code => code === 0 ? resolve() : reject(new Error('tar 解压失败')));
      });
    }
    throw new Error('仅支持 .zip / .7z / .tar / .tar.gz 模型压缩包');
  }
  function detectModelDest(extractedDir, archiveName) {
    const files = walkFiles(extractedDir);
    for (const m of MODEL_DEST_MATCHERS) {
      if (files.some(f => m.re.test(f))) return m.dest;
    }
    const n = String(archiveName || '').toLowerCase();
    if (n.includes('muscriptor_small') || n.includes('muscriptor-small') || n.includes('muscriptor small')) return 'muscriptor/small';
    if (n.includes('muscriptor_medium') || n.includes('muscriptor-medium') || n.includes('muscriptor medium')) return 'muscriptor/medium';
    if (n.includes('muscriptor_large') || n.includes('muscriptor-large') || n.includes('muscriptor large')) return 'muscriptor/large';
    if (n.includes('aria_amt')) return 'aria_amt';
    if (n.includes('piano_transcription') || n.includes('piano transcription')) return 'piano_transcription';
    return null;
  }
  function findModelSourceDir(root, dest) {
    const parts = dest.split('/');
    const last = parts[parts.length - 1];
    const dirs = [];
    const walk = (dir) => {
      for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!f.isDirectory()) continue;
        const p = path.join(dir, f.name);
        dirs.push(p);
        walk(p);
      }
    };
    walk(root);
    // 优先匹配完整路径（muscriptor/small 等）；退而求其次匹配目录名
    for (const d of dirs) {
      const rel = path.relative(root, d).split(path.sep).join('/');
      if (rel.toLowerCase() === dest.toLowerCase()) return d;
    }
    for (const d of dirs) {
      if (path.basename(d).toLowerCase() === last.toLowerCase() && d.toLowerCase().includes(parts[0].toLowerCase())) return d;
    }
    for (const d of dirs) {
      if (path.basename(d).toLowerCase() === last.toLowerCase()) return d;
    }
    return root;
  }
  ipcMain.handle('model:importLocal', async (_e, filePath) => {
    try {
      if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '压缩包不存在' };
      const ext = path.extname(filePath).toLowerCase();
      if (!['.zip', '.7z', '.tar', '.gz', '.tgz', '.tar.gz', '.txz', '.tar.xz'].includes(ext)) return { ok: false, error: '不支持的压缩包格式' };
      const tmp = path.join(app.getPath('temp'), 'fufumidi-model-import-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      try {
        await extractLocalArchive(filePath, tmp);
        const dest = detectModelDest(tmp, path.basename(filePath));
        if (!dest) return { ok: false, error: '无法识别压缩包中的模型类型（MuScriptor / Aria-AMT / 钢琴模型）' };
        const srcDir = findModelSourceDir(tmp, dest);
        const destDir = path.join(modelsDir(), dest);
        fs.mkdirSync(destDir, { recursive: true });
        fs.rmSync(destDir, { recursive: true, force: true });
        fs.mkdirSync(destDir, { recursive: true });
        // 复制模型文件（不含隐藏文件/临时解压目录）
        const files = walkFiles(srcDir);
        let totalSize = 0;
        for (const f of files) {
          const rel = path.relative(srcDir, f);
          const out = path.join(destDir, rel);
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.copyFileSync(f, out);
          totalSize += fs.statSync(out).size;
        }
        return { ok: true, path: destDir, size: totalSize, model: dest };
      } finally {
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
      }
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
  ipcMain.handle('folder:setWatch', (_e, dir, enabled) => {
    try {
      const win = BrowserWindow.fromWebContents(_e.sender);
      const key = win ? win.id : 0;
      if (_folderWatchers.has(key)) { try { _folderWatchers.get(key).close(); } catch (e) {} _folderWatchers.delete(key); }
      if (!enabled || !dir || !fs.existsSync(dir)) return { ok: true };
      const exts = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma', '.mp4', '.mkv', '.avi', '.mov', '.webm']);
      let timer = null;
      const w = fs.watch(dir, { persistent: false }, (_ev, filename) => {
        if (!filename) return;
        const full = path.join(dir, filename.toString());
        if (exts.has(path.extname(full).toLowerCase())) {
          clearTimeout(timer);
          timer = setTimeout(() => { if (win && !win.isDestroyed()) win.webContents.send('folder-watch:file', full); }, 300);
        }
      });
      _folderWatchers.set(key, w);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  });
  ipcMain.handle('model:pause', async (_e, id) => {
    if (id) { _modelPause.add(id); try { const c = _modelAborts.get(id); if (c) c.abort(); } catch (e) {} }
    return { ok: true };
  });
  // HuggingFace 整仓下载（HF 官方 / hf-mirror 双渠道；MuScriptor / Aria-AMT）
  async function downloadHfRepo(spec, channel, win, ctrl, token) {
    const host = HF_HOSTS[channel] || HF_HOSTS.huggingface;
    const destDir = path.join(modelsDir(), spec.dest);
    fs.mkdirSync(destDir, { recursive: true });
    const auth = {};
    if (token) auth.Authorization = 'Bearer ' + token;
    const headers = { 'user-agent': 'FuFumidi', ...auth };
    // gated 模型未带 Token 时直接给出明确指引，避免下载到一半才 401
    if (spec.gated && !token) throw new Error('该模型需要 HuggingFace 授权：请先在 huggingface.co/' + spec.repo + ' 页面接受许可协议，并在上方填写 HF Token（huggingface.co/settings/tokens 创建）');
    const api = `https://${host}/api/models/${spec.repo}/tree/main?recursive=true`;
    const res = await net.fetch(api, { headers, signal: ctrl.signal });
    if (!res.ok) throw new Error('HF API HTTP ' + res.status + (res.status === 401 || res.status === 403 ? '（需授权：请检查 HF Token 是否有效且已接受模型协议）' : ''));
    const tree = await res.json();
    const files = (tree || []).filter(f => f.type === 'file' && !/^\./.test(path.basename(f.path)));
    if (!files.length) throw new Error('仓库文件列表为空');
    const total = files.reduce((s, f) => s + (f.size || 0), 0);
    let received = 0;
    for (const f of files) {
      const rel = f.path;
      const out = path.join(destDir, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const url = `https://${host}/${spec.repo}/resolve/main/${rel.split('/').map(encodeURIComponent).join('/')}`;
      const r = await net.fetch(url, { headers, signal: ctrl.signal });
      if (!r.ok || !r.body) throw new Error('下载失败 HTTP ' + r.status + ' · ' + rel + (r.status === 401 || r.status === 403 ? '（该模型需授权：请填写有效 HF Token 并先在 HF 页面接受协议）' : ''));
      const ws = fs.createWriteStream(out);
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (_modelCancels.has(spec.id)) { try { reader.cancel(); } catch (e) {} throw new Error('canceled'); }
        if (_modelPause.has(spec.id)) { try { reader.cancel(); } catch (e) {} throw new Error('paused'); }
        received += value.length;
        const pct = total ? Math.min(99, Math.round(received / total * 100)) : 0;
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: spec.id, received, total, percent: pct, done: false });
        await new Promise((res2, rej2) => ws.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
      }
      await new Promise((res2, rej2) => ws.end(err => (err ? rej2(err) : res2())));
    }
    let size = 0;
    const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) size += st.size; else for (const f of fs.readdirSync(p)) walk(path.join(p, f)); };
    walk(destDir);
    if (size < spec.minSize) throw new Error('下载文件不完整：' + size + ' bytes');
    if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: spec.id, received: size, total: size, percent: 100, done: true });
    return { ok: true, path: destDir, size };
  }
  // GitHub Models 仓库分卷下载（MuScriptor）：自动测速 + 多源并行分卷 + SHA256 校验
  async function downloadSplitRepo(spec, win, ctrl) {
    const repo = spec.repo || 'monologue82/Models';
    const base = 'main/muscriptor/' + spec.sizeKey;
    const hosts = [
      'https://gh.jasonzeng.dev/https://raw.githubusercontent.com',
      'https://raw.githubusercontent.com',
      'https://ghfast.top/https://raw.githubusercontent.com',
      'https://gh-proxy.com/https://raw.githubusercontent.com',
    ];
    const headers = { 'user-agent': 'FuFumidi' };

    // 1) 分卷清单（manifest.json）：parts 数 / 总大小 / SHA256
    let manifest = null, lastErr = null;
    for (const h of hosts) {
      try {
        const r = await net.fetch(`${h}/${repo}/main/manifest.json`, { headers, signal: ctrl.signal });
        if (r.ok) { manifest = await r.json(); break; }
      } catch (e) { lastErr = e; }
    }
    const meta = manifest && manifest.muscriptor && manifest.muscriptor[spec.sizeKey];
    if (!meta || !meta.parts) throw new Error('分卷清单获取失败：请确认 Models 仓库已发布 ' + spec.sizeKey + ' 分卷（manifest.json）');

    const destDir = path.join(modelsDir(), spec.dest);
    fs.mkdirSync(destDir, { recursive: true });
    const outFile = path.join(destDir, meta.model || 'model.safetensors');
    const total = meta.size || 0;
    const modelName = meta.model || 'model.safetensors';
    const partNameFor = (i) => modelName + '.part' + String(i).padStart(2, '0');

    // 2) 自动测速：每个源下载首 1MB，按实测速度排序
    async function measureHost(h, signal) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 10000);
      let bytes = 0;
      try {
        const r = await net.fetch(`${h}/${repo}/${base}/${partNameFor(1)}`, { headers, signal: ac.signal });
        if (!r.ok || !r.body) return 0;
        const reader = r.body.getReader();
        const start = Date.now();
        while (bytes < 1024 * 1024) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
        }
        const secs = (Date.now() - start) / 1000;
        return secs > 0 ? bytes / secs : 0;
      } catch (e) { return 0; } finally { clearTimeout(timer); }
    }
    const measured = await Promise.all(hosts.map(async h => ({ h, speed: await measureHost(h, ctrl.signal) })));
    const sorted = measured.filter(x => x.speed > 0).sort((a, b) => b.speed - a.speed).map(x => x.h);
    const bestHosts = (sorted.length ? sorted : hosts).slice(0, Math.min(3, hosts.length));
    if (!bestHosts.length) bestHosts.push(hosts[0]);

    // 3) 并行分卷下载：每个 part 落到临时目录，完成后按顺序合并
    const tmpDir = path.join(destDir, '.download');
    fs.mkdirSync(tmpDir, { recursive: true });
    const partFiles = new Array(meta.parts);
    let received = 0;
    let lastProgress = 0;
    let failed = null;

    const sendProgress = () => {
      const now = Date.now();
      if (!total || now - lastProgress < 300) return;
      lastProgress = now;
      const pct = total ? Math.min(99, Math.round(received / total * 100)) : 0;
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: spec.id, received, total, percent: pct, done: false });
    };

    async function downloadPart(i) {
      const partName = partNameFor(i);
      const partFile = path.join(tmpDir, partName);
      // 从最合适的源开始，失败后按测速顺序回退
      const startHostIdx = (i - 1) % bestHosts.length;
      for (let k = 0; k < bestHosts.length; k++) {
        const h = bestHosts[(startHostIdx + k) % bestHosts.length];
        try {
          const r = await net.fetch(`${h}/${repo}/${base}/${partName}`, { headers, signal: ctrl.signal });
          if (!r.ok || !r.body) throw new Error('HTTP ' + r.status + ' · ' + partName);
          const ws = fs.createWriteStream(partFile);
          const reader = r.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (_modelCancels.has(spec.id)) { try { reader.cancel(); } catch (e) {} throw new Error('canceled'); }
            if (_modelPause.has(spec.id)) { try { reader.cancel(); } catch (e) {} throw new Error('paused'); }
            received += value.length;
            sendProgress();
            await new Promise((res2, rej2) => ws.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
          }
          await new Promise((res2, rej2) => ws.end(err => (err ? rej2(err) : res2())));
          partFiles[i - 1] = partFile;
          return partFile;
        } catch (e) {
          lastErr = e;
          try { fs.unlinkSync(partFile); } catch (_) {}
          if (_modelCancels.has(spec.id) || _modelPause.has(spec.id)) throw e;
        }
      }
      throw lastErr || new Error('下载分卷失败：' + partName);
    }

    const conc = Math.min(4, meta.parts);
    let next = 1;
    async function worker() {
      while (!failed && next <= meta.parts) {
        const i = next++;
        try { await downloadPart(i); }
        catch (e) { if (!failed) { failed = e; try { ctrl.abort(); } catch (_) {} } throw e; }
      }
    }

    try {
      await Promise.all(Array.from({ length: conc }, () => worker()));
      if (failed) throw failed;
      // 4) 合并分卷
      const ws = fs.createWriteStream(outFile);
      for (const pf of partFiles) {
        if (!pf) throw new Error('分卷缺失：' + pf);
        await new Promise((res2, rej2) => {
          const rs = fs.createReadStream(pf);
          rs.on('error', rej2);
          rs.on('end', res2);
          rs.pipe(ws, { end: false });
        });
      }
      await new Promise((res2, rej2) => ws.end(err => (err ? rej2(err) : res2())));
      const size = fs.statSync(outFile).size;
      // SHA256 校验（与 manifest 一致）
      if (meta.sha256) {
        const hash = await sha256File(outFile);
        if (hash !== meta.sha256) { try { fs.unlinkSync(outFile); } catch (e) {} throw new Error('SHA256 校验失败：' + hash.slice(0, 12) + '（分卷可能不完整）'); }
      }
      if (size < spec.minSize) throw new Error('下载文件不完整：' + size + ' bytes');
      fs.rmSync(tmpDir, { recursive: true, force: true });
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: spec.id, received: size, total: size, percent: 100, done: true });
      return { ok: true, path: destDir, size };
    } catch (e) {
      // 清理临时分卷；取消/暂停时保留以便之后续传
      if (!_modelPause.has(spec.id) && !_modelCancels.has(spec.id)) {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        try { fs.unlinkSync(outFile); } catch (_) {}
      }
      throw e;
    }
  }

  ipcMain.handle('model:download', async (evt, id, channel) => {
    const spec = MODEL_REGISTRY[id];
    if (!spec || !spec.downloadable) return { ok: false, error: 'unknown model: ' + id };
    const win = BrowserWindow.fromWebContents(evt.sender);
    // HuggingFace 整仓下载（MuScriptor / Aria-AMT）
    if (spec.type === 'hf') {
      const destDir = path.join(modelsDir(), spec.dest);
      const curSize = fs.existsSync(destDir) ? (() => { try { let s = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) s += st.size; else for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }; walk(destDir); return s; } catch (e) { return 0; } })() : 0;
      if (curSize >= spec.minSize) {
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: curSize, total: curSize, percent: 100, done: true });
        return { ok: true, path: destDir, size: curSize, existed: true };
      }
      _modelCancels.delete(id); _modelPause.delete(id);
      const ctrl = new AbortController(); _modelAborts.set(id, ctrl);
      const hfToken = (readSettings && readSettings().hf_token) || '';
      try {
        return await downloadHfRepo(spec, channel || 'huggingface', win, ctrl, hfToken);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, error: msg, canceled: _modelCancels.has(id), paused: _modelPause.has(id) });
        return { ok: false, error: msg, canceled: _modelCancels.has(id), paused: _modelPause.has(id) };
      } finally {
        _modelAborts.delete(id);
        _modelCancels.delete(id); _modelPause.delete(id);
      }
    }
    // GitHub Models 仓库分卷下载（MuScriptor）
    if (spec.type === 'ghsplit') {
      const destDir = path.join(modelsDir(), spec.dest);
      const curSize = fs.existsSync(destDir) ? (() => { try { let s = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) s += st.size; else for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }; walk(destDir); return s; } catch (e) { return 0; } })() : 0;
      if (curSize >= spec.minSize) {
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: curSize, total: curSize, percent: 100, done: true });
        return { ok: true, path: destDir, size: curSize, existed: true };
      }
      _modelCancels.delete(id); _modelPause.delete(id);
      const ctrl = new AbortController(); _modelAborts.set(id, ctrl);
      try {
        return await downloadSplitRepo(spec, win, ctrl);
      } catch (e) {
        const msg = String((e && e.message) || e);
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, error: msg, canceled: _modelCancels.has(id), paused: _modelPause.has(id) });
        return { ok: false, error: msg, canceled: _modelCancels.has(id), paused: _modelPause.has(id) };
      } finally {
        _modelAborts.delete(id);
        _modelCancels.delete(id); _modelPause.delete(id);
      }
    }
    const dest = path.join(modelsDir(), spec.dest);
    if (fs.existsSync(dest) && fs.statSync(dest).size >= spec.minSize) {
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: fs.statSync(dest).size, total: fs.statSync(dest).size, percent: 100, done: true });
      return { ok: true, path: dest, size: fs.statSync(dest).size, existed: true };
    }
    _modelCancels.delete(id);
    _modelPause.delete(id);
    const tmp = dest + '.part';
    const ctrl = new AbortController();
    _modelAborts.set(id, ctrl);
    const timeout = setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, 120000);
    let out = null, start = 0, keepPart = false;
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (fs.existsSync(tmp)) start = fs.statSync(tmp).size;
      const headers = { 'user-agent': 'FuFumidi/2.0.0' };
      if (start > 0) headers['Range'] = 'bytes=' + start + '-';
      const urls = [spec.url, 'https://ghfast.top/' + spec.url, 'https://gh-proxy.com/' + spec.url, 'https://ghproxy.net/' + spec.url];
      let res = null;
      for (const u of urls) {
        try {
          res = await net.fetch(u, { headers, signal: ctrl.signal });
          if (res.ok && res.body) break; else res = null;
        } catch (e) { res = null; }
      }
      if (!res) throw new Error('所有下载源均失败');
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const total = (parseInt(res.headers.get('content-length') || '0', 10) || 0) + start;
      out = fs.createWriteStream(tmp, { flags: start > 0 ? 'a' : 'w' });
      const reader = res.body.getReader();
      let received = start, lastSend = 0;
      const sendP = (done) => {
        const now = Date.now();
        if (!done && now - lastSend < 300) return;
        lastSend = now;
        const pct = total ? Math.min(99, Math.round(received / total * 100)) : 0;
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received, total, percent: pct, done: !!done });
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (_modelPause.has(id)) { try { reader.cancel(); } catch (e) {} throw new Error('paused'); }
        if (_modelCancels.has(id)) { try { reader.cancel(); } catch (e) {} throw new Error('canceled'); }
        received += value.length;
        sendP(false);
        await new Promise((res2, rej2) => out.write(Buffer.from(value), err => (err ? rej2(err) : res2())));
      }
      await new Promise((res2, rej2) => out.end(err => (err ? rej2(err) : res2())));
      sendP(true);
      if (_modelPause.has(id)) throw new Error('paused');
      if (_modelCancels.has(id)) throw new Error('canceled');
      fs.renameSync(tmp, dest);
      const size = fs.statSync(dest).size;
      if (size < spec.minSize) throw new Error('下载文件不完整：' + size + ' bytes');
      if (spec.sha256) {
        const hash = await sha256File(dest);
        if (hash !== spec.sha256) { try { fs.unlinkSync(dest); } catch (e) {} throw new Error('SHA256 校验失败：' + hash); }
      }
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, received: size, total: size, percent: 100, done: true });
      return { ok: true, path: dest, size };
    } catch (e) {
      if (out) { try { out.destroy(); } catch (_) {} }
      await new Promise(r => setTimeout(r, 150));
      const msg = String((e && e.message) || e);
      const paused = _modelPause.has(id);
      keepPart = paused;
      if (!paused && !_modelCancels.has(id)) { try { fs.unlinkSync(tmp); } catch (_) {} }
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id, error: msg, canceled: _modelCancels.has(id), paused });
      return { ok: false, error: msg, canceled: _modelCancels.has(id), paused };
    } finally {
      clearTimeout(timeout);
      _modelCancels.delete(id);
      _modelAborts.delete(id);
      _modelPause.delete(id);
      try { if (!keepPart && fs.existsSync(tmp) && !fs.existsSync(dest)) fs.unlinkSync(tmp); } catch (_) {}
    }
  });

  function closeAll() {
    for (const w of _folderWatchers.values()) { try { w.close(); } catch {} }
    _folderWatchers.clear();
  }

  return { closeAll };
}

module.exports = { registerModelsIpc };
