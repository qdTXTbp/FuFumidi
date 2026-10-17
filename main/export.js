// ============================================================
// P0-4 导出落盘服务（main/export.js）
// ============================================================
// 职责：把渲染进程编码好的字节 + 元数据落盘，写同名 .manifest.json 供核对/复现。
//   · 原子写：先写 .tmp 再 rename（导出一半被杀不会留下半个 WAV）；
//   · 命名安全化：去掉 Windows 非法字符、控制字符、结尾点空格；
//   · 纯函数（sanitizeName / buildManifest / writeExport）不 require electron，
//     方便 scripts/test-export.mjs 直接单测；electron 只在 registerExportIpc 里用。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const MAX_BYTES = 2 * 1024 * 1024 * 1024;   // 2GB 上限（3 小时 24bit 立体声也够）

/** Windows 文件名安全化：非法字符替换为 _，去控制字符，压缩空白，去结尾点/空格 */
function sanitizeName(name, ext) {
  let base = String(name == null ? '' : name).replace(/\.[^.\\/]+$/, '');   // 去掉自带扩展名
  base = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim();
  base = base.replace(/[. ]+$/, '');
  if (!base) base = 'export';
  if (base.length > 120) base = base.slice(0, 120);
  const e = String(ext || 'wav').replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '') || 'wav';
  return base + '.' + e;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 构造 manifest（纯函数；不含时间戳以外的环境信息） */
function buildManifest(o = {}) {
  const bytes = o.bytes || Buffer.alloc(0);
  const fileName = o.fileName || sanitizeName(o.name, o.ext);
  return {
    format: 'fufumidi-export',
    version: 1,
    createdAt: new Date(o.now == null ? Date.now() : o.now).toISOString(),
    file: { name: fileName, size: bytes.length, sha256: sha256(bytes) },
    audio: {
      format: o.format || 'wav',
      bitDepth: o.bitDepth == null ? 16 : o.bitDepth,
      sampleRate: o.sampleRate == null ? 44100 : o.sampleRate,
      channels: o.channels == null ? 2 : o.channels,
      durationSec: o.durationSec == null ? null : Math.round(o.durationSec * 1000) / 1000,
      lufs: o.lufs == null ? null : Math.round(o.lufs * 10) / 10,
      peakDb: o.peakDb == null ? null : Math.round(o.peakDb * 100) / 100,
      targetLufs: o.targetLufs == null ? null : o.targetLufs,
    },
    source: { name: o.sourceName || '', app: o.appVersion || '' },
  };
}

/**
 * 原子写导出文件 + sidecar manifest。
 * @param {{dir:string, name:string, ext?:string, bytes:Buffer|Uint8Array, manifest:object}} o
 * @returns {{ok:boolean, path?:string, manifestPath?:string, error?:string}}
 */
function writeExport(o = {}) {
  const dir = o.dir;
  if (!dir) return { ok: false, error: '缺少导出目录' };
  const buf = Buffer.isBuffer(o.bytes) ? o.bytes : Buffer.from(o.bytes || []);
  if (!buf.length) return { ok: false, error: '没有可写出的音频数据' };
  if (buf.length > MAX_BYTES) return { ok: false, error: '文件过大（> 2GB）' };
  const fileName = sanitizeName(o.name, o.ext);
  const target = path.join(dir, fileName);
  const tmp = target + '.tmp';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, target);
    const manifest = o.manifest || buildManifest({ bytes: buf, fileName, name: o.name, ext: o.ext });
    manifest.file = manifest.file || { name: fileName, size: buf.length, sha256: sha256(buf) };
    manifest.file.path = target;
    const manifestPath = target.replace(/\.[^.]+$/, '') + '.manifest.json';
    const mt = manifestPath + '.tmp';
    fs.writeFileSync(mt, JSON.stringify(manifest, null, 2), 'utf8');
    fs.renameSync(mt, manifestPath);
    return { ok: true, path: target, manifestPath, manifest };
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 注册 IPC（由 main.js 调用；electron 依赖只在这里出现） */
function registerExportIpc({ ipcMain, dialog, app, path: nodePath, center } = {}) {
  if (!ipcMain) return;
  ipcMain.handle('export:audio', async (_e, payload) => {
    const p = payload || {};
    // C2：导出属于“长任务必须登记”的范畴（这里写盘很快，但链路/取消/跳转语义先接上）
    const task = center ? center.register({ kind: 'export', title: '导出音频：' + String(p.name || '未命名') }) : null;
    try {
      const bytes = p.bytes ? Buffer.from(p.bytes) : Buffer.alloc(0);
      if (!bytes.length) return { ok: false, error: '没有可导出的音频数据' };
      if (bytes.length > MAX_BYTES) return { ok: false, error: '文件过大（> 2GB）' };
      const ext = String(p.ext || (p.format === 'float32' ? 'wav' : 'wav')).replace(/^\./, '');
      let target = p.targetPath ? String(p.targetPath) : '';
      if (!target) {
        const downloads = app ? app.getPath('downloads') : process.cwd();
        const def = nodePath ? nodePath.join(downloads, sanitizeName(p.name, ext)) : sanitizeName(p.name, ext);
        const r = await dialog.showSaveDialog({
          title: '导出音频',
          defaultPath: def,
          filters: [{ name: ext.toUpperCase() + ' 音频', extensions: [ext] }],
        });
        if (r.canceled || !r.filePath) return { ok: false, canceled: true };
        target = r.filePath;
      }
      const dir = nodePath ? nodePath.dirname(target) : '.';
      const base = nodePath ? nodePath.basename(target).replace(/\.[^.]+$/, '') : 'export';
      const res = writeExport({
        dir, name: base, ext,
        bytes,
        manifest: buildManifest({
          bytes, name: base, ext, format: p.format || 'wav', bitDepth: p.bitDepth,
          sampleRate: p.sampleRate, channels: p.channels, durationSec: p.durationSec,
          lufs: p.lufs, peakDb: p.peakDb, targetLufs: p.targetLufs, sourceName: p.sourceName,
          appVersion: (() => { try { return app.getVersion(); } catch (e) { return ''; } })(),
        }),
      });
      // 用户自己选了路径可能带不同目录：writeExport 按 dir+name 写，这里保证落在同一目录/同名
      if (res.ok && nodePath) {
        const want = nodePath.join(dir, nodePath.basename(target));
        if (res.path !== want) {
          try { fs.renameSync(res.path, want); res.path = want; } catch (e) {}
        }
      }
      if (task) {
        if (res && res.ok) { task.progress(1, '已写出 ' + (res.path || '')); task.done({ path: res.path, manifestPath: res.manifestPath }); }
        else task.fail((res && res.error) || '导出失败');
      }
      return res;
    } catch (e) {
      if (task) task.fail(e);
      return { ok: false, error: String((e && e.message) || e) };
    }
  });

  // P0-4c：分轨导出打包为单个 ZIP（避免 N 次保存对话框，并保持文件名与曲名一致）
  ipcMain.handle('export:stems-zip', async (_e, payload) => {
    const p = payload || {};
    const task = center ? center.register({ kind: 'export', title: '打包分轨：' + String(p.suggestedName || 'stems.zip') }) : null;
    try {
      const filesIn = Array.isArray(p.files) ? p.files : [];
      if (!filesIn.length) return { ok: false, error: '没有可打包的分轨文件' };
      if (filesIn.length > 100) return { ok: false, error: '分轨数量过多（>100）' };
      const items = [];
      let total = 0;
      for (const f of filesIn) {
        const buf = f && f.bytes ? Buffer.from(f.bytes) : Buffer.alloc(0);
        if (!buf.length) continue;
        total += buf.length;
        if (total > MAX_BYTES) return { ok: false, error: '分轨总大小超过 2GB' };
        items.push({ name: sanitizeName(f.name, f.ext || 'wav'), bytes: buf });
      }
      if (!items.length) return { ok: false, error: '没有可打包的音频数据' };
      const suggested = sanitizeName(p.suggestedName || 'stems', 'zip');
      let target = process.env.FUFUMIDI_E2E === '1' && p.targetPath ? String(p.targetPath) : '';
      if (!target) {
        const downloads = app ? app.getPath('downloads') : process.cwd();
        const def = nodePath ? nodePath.join(downloads, suggested) : suggested;
        const r = await dialog.showSaveDialog({
          title: '分轨打包导出',
          defaultPath: def,
          filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }],
        });
        if (r.canceled || !r.filePath) return { ok: false, canceled: true };
        target = r.filePath;
      }
      const zip = new AdmZip();
      for (const it of items) zip.addFile(it.name, it.bytes);
      zip.writeZip(target);
      const size = fs.statSync(target).size;
      if (task) { task.progress(1, '已写出 ' + target); task.done({ path: target, count: items.length }); }
      return { ok: true, path: target, count: items.length, bytes: size };
    } catch (e) {
      if (task) task.fail(e);
      return { ok: false, error: String((e && e.message) || e) };
    }
  });
}

module.exports = { registerExportIpc, writeExport, buildManifest, sanitizeName, sha256, MAX_BYTES };
