// ============================================================
// UTAU 声库制作 IPC：声库导出 + 人声渲染 + 现成声库导入
// ============================================================
'use strict';

function registerUtauIpc({ ipcMain, path, fs, os, app, dialog, spawnEngine }) {
  const vbRoot = () => path.join(app.getPath('userData'), 'voicebanks');

  // 已导入声库列表：userData/voicebanks 下含 oto.ini 的目录
  ipcMain.handle('utau:listVoicebanks', () => {
    try {
      const root = vbRoot();
      if (!fs.existsSync(root)) return { ok: true, list: [] };
      const list = [];
      for (const name of fs.readdirSync(root)) {
        const dir = path.join(root, name);
        if (!fs.statSync(dir).isDirectory()) continue;
        if (fs.existsSync(path.join(dir, 'oto.ini'))) list.push({ name, dir });
      }
      return { ok: true, list };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 导入现成声库 zip → 解压到 userData/voicebanks，返回声库目录
  ipcMain.handle('utau:importVoicebankZip', async () => {
    try {
      const win = dialog;
      let files;
      if (typeof dialog.showOpenDialog === 'function') {
        const r = await dialog.showOpenDialog({
          properties: ['openFile'],
          filters: [{ name: 'UTAU 声库', extensions: ['zip'] }],
        });
        if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
        files = r.filePaths;
      } else {
        files = typeof win === 'function' ? [await win()] : [];
      }
      const zipPath = files && files[0];
      if (!zipPath) return { ok: false, canceled: true };

      const AdmZip = require('adm-zip');
      const zip = new AdmZip(zipPath);
      const root = vbRoot();
      fs.mkdirSync(root, { recursive: true });
      // 声库名取 zip 文件名（去扩展名，清洗）
      let name = path.basename(zipPath, path.extname(zipPath)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      name = name || ('voicebank_' + Date.now());
      let dest = path.join(root, name);
      let i = 2;
      while (fs.existsSync(dest)) { dest = path.join(root, name + '_' + i++); }
      fs.mkdirSync(dest, { recursive: true });
      zip.extractAllTo(dest, true);
      // 归一化：若解压后只有一层子目录且含 oto.ini，把该层作为声库根
      const inner = fs.readdirSync(dest).filter(n => fs.statSync(path.join(dest, n)).isDirectory());
      if (inner.length === 1) {
        const cand = path.join(dest, inner[0]);
        if (fs.existsSync(path.join(cand, 'oto.ini'))) {
          dest = path.join(dest, name); // fallback
          if (!fs.existsSync(dest)) { fs.renameSync(cand, dest); }
          else { dest = cand; }
        }
      } else {
        // 顶层即可（oto.ini 平铺在 zip 根）
      }
      const vbDir = fs.existsSync(path.join(dest, 'oto.ini')) ? dest : null;
      if (!vbDir) {
        // 找 zip 内任意含 oto.ini 的子目录
        let found = null;
        const walk = d => {
          for (const n of fs.readdirSync(d)) {
            const p = path.join(d, n);
            if (fs.statSync(p).isDirectory()) { if (fs.existsSync(path.join(p, 'oto.ini'))) { found = p; return; } walk(p); }
          }
        };
        walk(dest);
        if (found) vbDir = found;
      }
      const outDir = vbDir || dest;
      return { ok: true, name: path.basename(outDir), dir: outDir };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 删除已导入的声库目录（只能删除 userData/voicebanks 下的声库）
  ipcMain.handle('utau:deleteVoicebank', async (_e, dir) => {
    try {
      if (!dir || typeof dir !== 'string') return { ok: false, error: '参数错误' };
      const root = vbRoot();
      const resolved = path.resolve(dir);
      const rootResolved = path.resolve(root);
      if (!resolved.startsWith(rootResolved + path.sep)) return { ok: false, error: '只能删除已导入的声库目录' };
      if (!fs.existsSync(resolved)) return { ok: false, error: '声库不存在' };
      fs.rmSync(resolved, { recursive: true, force: true });
      return { ok: true, dir: resolved };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  ipcMain.handle('utau:exportVoicebank', async (_e, opts) => {
    try {
      const { dir, files } = opts || {};
      if (!dir || typeof dir !== 'string' || !Array.isArray(files)) {
        return { ok: false, error: '参数错误' };
      }
      if (!fs.existsSync(dir)) return { ok: false, error: '保存目录不存在' };
      for (const f of files) {
        const name = String((f && f.name) || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
        if (!name) continue;
        const buf = Buffer.from(String((f && f.data) || ''), 'base64');
        fs.writeFileSync(path.join(dir, name), buf);
      }
      return { ok: true, dir, count: files.length };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 导出声库为 zip 压缩包：选择保存路径后打包 oto.ini + wav 文件
  ipcMain.handle('utau:exportVoicebankZip', async (_e, opts) => {
    try {
      const { files } = opts || {};
      if (!Array.isArray(files) || !files.length) return { ok: false, error: '参数错误' };
      const defaultDir = app.getPath('downloads') || os.homedir();
      const r = await dialog.showSaveDialog({
        title: '导出声库压缩包',
        defaultPath: path.join(defaultDir, 'voicebank.zip'),
        filters: [{ name: 'UTAU 声库', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      const AdmZip = require('adm-zip');
      const zip = new AdmZip();
      for (const f of files) {
        const name = String((f && f.name) || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
        if (!name) continue;
        const buf = Buffer.from(String((f && f.data) || ''), 'base64');
        zip.addFile(name, buf);
      }
      zip.writeZip(r.filePath);
      return { ok: true, path: r.filePath, count: files.length };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) };
    }
  });

  // 渲染 UTAU 工程 → 人声 WAV（调 engine_utau.py render-track，返回字节供预览）
  ipcMain.handle('utau:renderTrack', (evt, cfg) => new Promise((resolve) => {
    const { voicebank, notes, sampleNote, bpm } = cfg || {};
    try {
      if (!voicebank || !notes || !Array.isArray(notes) || !notes.length) {
        return resolve({ ok: false, error: '缺少声库目录或音符' });
      }
      const out = path.join(os.tmpdir(), 'fufumidi', `utau_render_${Date.now()}.wav`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      const args = [
        'render-track', '--voicebank', String(voicebank),
        '--notes', JSON.stringify(notes),
        '--sample-note', String(sampleNote || 'C4'),
        '--out', out,
      ];
      spawnEngine(args, {
        script: 'engine_utau.py',
        onDone: (code, r) => {
          if (r && r.result && r.result.ok && r.result.out && fs.existsSync(r.result.out)) {
            try {
              const bytes = Array.from(fs.readFileSync(r.result.out));
              return resolve({ ok: true, out: r.result.out, duration_ms: r.result.duration_ms, bytes });
            } catch (e) {
              return resolve({ ok: true, out: r.result.out, error: String(e) });
            }
          }
          const err = (r && r.result && r.result.error)
            || (r && (r.err || r.out || '').slice(-400))
            || `引擎退出码 ${code}`;
          resolve({ ok: false, error: err });
        },
        onError: (e) => resolve({ ok: false, error: String(e) }),
      });
    } catch (err) {
      resolve({ ok: false, error: String((err && err.message) || err) });
    }
  }));
}

module.exports = { registerUtauIpc };
