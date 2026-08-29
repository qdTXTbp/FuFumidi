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
      runtime: 'piano',
    },
    // 通用多乐器转录（Kyutai MuScriptor，默认不随 Release 分发，需到资源中心下载）
    // 注意：MuScriptor 权重经 monologue82/Models 仓库分卷分发（gh.jasonzeng.dev 加速 + 多镜像回退，
    // 25MB part 并行下载 → 合并 → SHA256 校验），无需 HuggingFace 授权。
    muscriptor_small: {
      id: 'muscriptor_small',
      name: 'MuScriptor Small',
      note: '多乐器转录 · 103M 参数 · 约 400 MB · GitHub 镜像分卷下载',
      type: 'ghsplit',
      sizeKey: 'small',
      repo: 'monologue82/Models',
      dest: path.join('muscriptor', 'small'),
      minSize: 5e7,
      downloadable: true,
      runtime: 'muscriptor',
    },
    muscriptor_medium: {
      id: 'muscriptor_medium',
      name: 'MuScriptor Medium',
      note: '多乐器转录 · 307M 参数（推荐）· 约 1.2 GB · GitHub 镜像分卷下载',
      type: 'ghsplit',
      sizeKey: 'medium',
      repo: 'monologue82/Models',
      dest: path.join('muscriptor', 'medium'),
      minSize: 2e8,
      downloadable: true,
      runtime: 'muscriptor',
    },
    muscriptor_large: {
      id: 'muscriptor_large',
      name: 'MuScriptor Large',
      note: '多乐器转录 · 1.4B 参数 · 约 5.2 GB · GitHub 镜像分卷下载',
      type: 'ghsplit',
      sizeKey: 'large',
      repo: 'monologue82/Models',
      dest: path.join('muscriptor', 'large'),
      minSize: 9e8,
      downloadable: true,
      runtime: 'muscriptor',
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
      runtime: 'aria',
    },
  };
  // HuggingFace 渠道：官方 / hf-mirror
  const HF_HOSTS = { huggingface: 'huggingface.co', 'hf-mirror': 'hf-mirror.com' };
  const _modelCancels = new Set();
  const _modelAborts = new Map();
  const _modelPause = new Set();
  // 进行中的下载集合：即便页面关闭/切换也保持，模型清单可据此标记「下载中」
  const _activeDownloads = new Set();

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
    push(pt.name, path.join(dir, pt.dest), pt.note, { id: pt.id, downloadable: true, active: _activeDownloads.has(pt.id), runtime: pt.runtime });
    const dm = demucsModelFile();
    items.push({ id: 'demucs_htdemucs', name: '人声分离模型', path: dm || '', size: dm ? (() => { try { return fs.statSync(dm).size; } catch (e) { return 0; } })() : 0, exists: !!dm, downloadable: !dm, runtime: 'separate', note: dm ? 'demucs htdemucs 已内置（约 80 MB）' : 'demucs htdemucs（未安装，可一键下载，国内自动走镜像）' });
    // 扩展模型（MuScriptor / Aria-AMT 等）：整目录检查
    for (const k of Object.keys(MODEL_REGISTRY)) {
      if (k === 'piano_transcription') continue;
      const m = MODEL_REGISTRY[k];
      const dest = path.join(dir, m.dest);
      // 目录总大小（排除临时隐藏目录，如 .parts），用于展示
      const dirSize = (() => { try { let s = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) s += st.size; else for (const f of fs.readdirSync(p)) { if (f === '.parts') continue; walk(path.join(p, f)); } }; walk(dest); return s; } catch (e) { return 0; } })();
      let exists = false, size = 0;
      if (m.type === 'ghsplit') {
        // 分卷下载：以最终合并产物为准，避免下载中的 .parts 被误判为「已就绪」
        const finalFile = path.join(dest, 'model.safetensors');
        if (fs.existsSync(finalFile)) { size = fs.statSync(finalFile).size; exists = size >= m.minSize; }
      } else {
        exists = dirSize >= m.minSize; size = dirSize;
      }
      items.push({
        id: m.id, name: m.name, path: dest, size, exists, active: _activeDownloads.has(m.id),
        downloadable: true, note: m.note, type: m.type, repo: m.repo, gated: !!m.gated, runtime: m.runtime,
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
      // 目录型（MuScriptor/Aria 分卷或整仓）按目录递归删除；单文件直接删
      const st = fs.statSync(p);
      if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
      else fs.unlinkSync(p);
      // 一并清理可能存在的临时内容
      try { fs.rmSync(p + '.tmp', { recursive: true, force: true }); } catch (_) {}
      try { fs.rmSync(p + '.part', { recursive: true, force: true }); } catch (_) {}
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
  // 分卷压缩包：把 .001/.002 等按顺序拼接回单文件（7z 分卷 zip/7z 均适用）
  async function combineSplitArchive(firstPart, outFile) {
    const dir = path.dirname(firstPart);
    const base = path.basename(firstPart).replace(/\.\d{3,}$/, '');
    const parts = [];
    for (let i = 1; ; i++) {
      const p = path.join(dir, base + '.' + String(i).padStart(3, '0'));
      if (fs.existsSync(p)) parts.push(p);
      else break;
    }
    if (parts.length < 2) return firstPart;
    const ws = fs.createWriteStream(outFile);
    for (const p of parts) {
      await new Promise((res, rej) => {
        const rs = fs.createReadStream(p);
        rs.on('error', rej);
        rs.on('end', res);
        rs.pipe(ws, { end: false });
      });
    }
    await new Promise((res, rej) => ws.end(err => err ? rej(err) : res()));
    return outFile;
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
      const splitMatch = filePath.match(/\.(zip|7z|tar|gz|tgz|txz)\.[0-9]{3,}$/i);
      const isSplit = !!splitMatch;
      const validExt = isSplit ? '.' + splitMatch[1].toLowerCase() : ext;
      if (!['.zip', '.7z', '.tar', '.gz', '.tgz', '.tar.gz', '.txz', '.tar.xz'].includes(validExt)) return { ok: false, error: '不支持的压缩包格式' };
      const tmp = path.join(app.getPath('temp'), 'fufumidi-model-import-' + Date.now());
      fs.mkdirSync(tmp, { recursive: true });
      try {
        let archiveFile = filePath;
        if (isSplit) {
          const combinedName = path.join(tmp, 'combined' + validExt);
          archiveFile = await combineSplitArchive(filePath, combinedName);
        }
        await extractLocalArchive(archiveFile, tmp);
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
      // 打开失败（EPERM：杀软锁定/权限）或写入中途出错时，'error' 事件若无人监听会把主进程打崩；
      // 错误已由下方 write/end 回调捕获并回抛给重试逻辑，这里仅消费事件避免未捕获异常。
      ws.on('error', () => {});
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
  // GitHub Models 仓库分卷下载（MuScriptor：分卷 → 并行下载 → 合并 + SHA256 校验）
  // 特性：① 下载前对多源自动测速选最快 ② 分卷最多 4 路并行 ③ 按序合并 ④ SHA256 校验
  // 访问走 gh.jasonzeng.dev 加速，raw 直连 / ghfast / gh-proxy 作回退
  const SPLIT_CONCURRENCY = 4;
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
    const parts = parseInt(meta.parts, 10) || 0;
    if (!parts) throw new Error('分卷清单缺少 parts');
    const destDir = path.join(modelsDir(), spec.dest);
    fs.mkdirSync(destDir, { recursive: true });
    const outFile = path.join(destDir, meta.model || 'model.safetensors');
    const total = meta.size || 0;
    // 已存在且完整 → 直接返回（避免重复下载）
    if (fs.existsSync(outFile)) {
      const sz = fs.statSync(outFile).size;
      if (sz >= (spec.minSize || 0)) {
        if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: spec.id, received: sz, total: sz, percent: 100, done: true });
        return { ok: true, path: destDir, size: sz, existed: true };
      }
      // 上次中断残留的半成品 → 清理，避免误判已就绪
      try { fs.unlinkSync(outFile); } catch (_) {}
    }
    // 清理上次异常留下的临时合并文件
    try { fs.rmSync(outFile + '.tmp', { force: true }); } catch (_) {}
    const partsDir = path.join(destDir, '.parts');
    fs.mkdirSync(partsDir, { recursive: true });

    // 2) 测速：对每个源下载 part01 前 256KB，取最快
    const probe = async (host, bytes = 256 * 1024) => {
      const t0 = Date.now();
      try {
        const u = `${host}/${repo}/${base}/${partName(meta, 1)}`;
        const r = await net.fetch(u, { headers, signal: ctrl.signal });
        if (!r.ok || !r.body) return { host, mbps: 0 };
        const reader = r.body.getReader();
        let got = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          got += value.length;
          if (got >= bytes) { try { await reader.cancel(); } catch (e) {} break; }
        }
        const ms = Math.max(1, Date.now() - t0);
        return { host, mbps: got / 1024 / 1024 / (ms / 1000) };
      } catch (e) { return { host, mbps: 0 }; }
    };
    const speeds = await Promise.all(hosts.map(h => probe(h)));
    speeds.sort((a, b) => b.mbps - a.mbps);
    const primaryHost = speeds[0].mbps > 0 ? speeds[0].host : hosts[0];
    if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: spec.id, text: `测速完成，选用 ${primaryHost.replace('https://', '')}（${speeds[0].mbps.toFixed(1)} MB/s）`, received: 0, total, percent: 0, done: false });

    // 3) 并行下载分卷（并发 SPLIT_CONCURRENCY，全部写入 .parts/）
    function partName(meta, i) { return (meta.model || 'model.safetensors') + '.part' + String(i).padStart(2, '0'); }
    const downloadPart = async (i) => {
      const name = partName(meta, i);
      const dest = path.join(partsDir, name);
      // 已完整下载的卷直接复用（断点续传）
      if (fs.existsSync(dest)) {
        const sz = fs.statSync(dest).size;
        if (sz >= (i < parts ? 25 * 1024 * 1024 : 0) && sz > 0) { received += sz; return; }
      }
      const tmp = dest + '.part';
      let ok = false;
      for (const h of [primaryHost, ...hosts.filter(x => x !== primaryHost)]) {
        if (_modelCancels.has(spec.id)) throw new Error('canceled');
        if (_modelPause.has(spec.id)) throw new Error('paused');
        try {
          const r = await net.fetch(`${h}/${repo}/${base}/${name}`, { headers, signal: ctrl.signal });
          if (!r.ok || !r.body) throw new Error('HTTP ' + r.status + ' · ' + name);
          const ws = fs.createWriteStream(tmp);
          ws.on('error', () => {}); // 消费 'error' 事件，防 EPERM 等未捕获异常打崩主进程
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
          fs.renameSync(tmp, dest);
          ok = true;
          break;
        } catch (e) { lastErr = e; try { fs.unlinkSync(tmp); } catch (_) {} }
      }
      if (!ok) throw lastErr || new Error('下载分卷失败：' + name);
    };

    let received = 0;
    const partsList = Array.from({ length: parts }, (_, i) => i + 1);
    let cursor = 0;
    try {
      const workers = Array.from({ length: Math.min(SPLIT_CONCURRENCY, parts) }, async () => {
        while (cursor < partsList.length) {
          const i = partsList[cursor++];
          await downloadPart(i);
        }
      });
      await Promise.all(workers);
      // 4) 按序合并（先写临时文件再原子重命名，中断不会留下半成品最终文件）
      const tmpOut = outFile + '.tmp';
      fs.rmSync(tmpOut, { force: true });
      const ws = fs.createWriteStream(tmpOut);
      ws.on('error', () => {}); // 消费 'error' 事件，防未捕获异常打崩主进程
      for (let i = 1; i <= parts; i++) {
        const p = path.join(partsDir, partName(meta, i));
        if (!fs.existsSync(p)) throw new Error('分卷缺失：' + partName(meta, i));
        await new Promise((resolve, reject) => {
          const rs = fs.createReadStream(p);
          rs.on('error', reject);
          rs.pipe(ws, { end: false });
          rs.on('end', resolve);
        });
      }
      await new Promise((res2, rej2) => ws.end(err => (err ? rej2(err) : res2())));
      fs.renameSync(tmpOut, outFile);
      // 5) 校验
      const size = fs.statSync(outFile).size;
      if (meta.sha256) {
        const hash = await sha256File(outFile);
        if (hash !== meta.sha256) { try { fs.unlinkSync(outFile); } catch (e) {} throw new Error('SHA256 校验失败：' + hash.slice(0, 12) + '（分卷可能不完整）'); }
      }
      if (size < spec.minSize) throw new Error('下载文件不完整：' + size + ' bytes');
      if (win && !win.isDestroyed()) win.webContents.send('model:progress', { id: spec.id, received: size, total: size, percent: 100, done: true });
      return { ok: true, path: destDir, size };
    } catch (e) {
      if (!_modelPause.has(spec.id) && !_modelCancels.has(spec.id)) { try { fs.unlinkSync(outFile); } catch (_) {} }
      try { fs.rmSync(outFile + '.tmp', { force: true }); } catch (_) {}
      throw e;
    } finally {
      try { fs.rmSync(partsDir, { recursive: true, force: true }); } catch (_) {}
    }
  }

  ipcMain.handle('model:download', async (evt, id, channel) => {
    const spec = MODEL_REGISTRY[id];
    if (!spec || !spec.downloadable) return { ok: false, error: 'unknown model: ' + id };
    const win = BrowserWindow.fromWebContents(evt.sender);
    // 同一模型已在下载中：阻止重复开启（页面切换/刷新后再进入也不会开第二份）
    if (_activeDownloads.has(id)) return { ok: false, error: '模型下载已在进行中，请稍候', active: true };
    _activeDownloads.add(id);
    // HuggingFace 整仓下载（MuScriptor / Aria-AMT）
    if (spec.type === 'hf') {
      const destDir = path.join(modelsDir(), spec.dest);
      const curSize = fs.existsSync(destDir) ? (() => { try { let s = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) s += st.size; else for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }; walk(destDir); return s; } catch (e) { return 0; } })() : 0;
      if (curSize >= spec.minSize) {
        _activeDownloads.delete(id);
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
        _modelCancels.delete(id); _modelPause.delete(id); _activeDownloads.delete(id);
      }
    }
    // GitHub Models 仓库分卷下载（MuScriptor）
    if (spec.type === 'ghsplit') {
      const destDir = path.join(modelsDir(), spec.dest);
      const curSize = fs.existsSync(destDir) ? (() => { try { let s = 0; const walk = (p) => { const st = fs.statSync(p); if (st.isFile()) s += st.size; else for (const f of fs.readdirSync(p)) walk(path.join(p, f)); }; walk(destDir); return s; } catch (e) { return 0; } })() : 0;
      if (curSize >= spec.minSize) {
        _activeDownloads.delete(id);
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
        _modelCancels.delete(id); _modelPause.delete(id); _activeDownloads.delete(id);
      }
    }
    const dest = path.join(modelsDir(), spec.dest);
    if (fs.existsSync(dest) && fs.statSync(dest).size >= spec.minSize) {
      _activeDownloads.delete(id);
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
      const headers = { 'user-agent': 'FuFumidi/3.1.14' };
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
      out.on('error', () => {}); // 消费 'error' 事件，防 EPERM 等未捕获异常打崩主进程
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
      _activeDownloads.delete(id);
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
