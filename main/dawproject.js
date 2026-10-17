// ============================================================
// P2-5 DAWproject 导出（主进程）：把渲染进程生成的 XML 文件列表写成 ZIP
// ============================================================
// 容器契约：.dawproject = ZIP，内含 project.xml（必需）+ metadata.xml（可选），UTF-8 文本。
// 渲染进程负责模型 → XML（core/dawproject.js），主进程只负责落盘与保存对话框。
// E2E 模式（FUFUMIDI_E2E=1）允许调用方直接给 filePath，绕过原生保存对话框。
'use strict';
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');

const MAX_TOTAL = 64 * 1024 * 1024;
const ALLOWED = new Set(['project.xml', 'metadata.xml']);

function safeName(n) {
  const base = String(n == null ? '' : n).replace(/\\/g, '/').split('/').pop().trim();
  if (!base || base === '.' || base === '..' || /[\u0000-\u001f]/.test(base)) return '';
  return base.slice(0, 160);
}

function normalizeFiles(filesIn) {
  if (!Array.isArray(filesIn) || !filesIn.length) return { ok: false, error: '没有可写入的文件' };
  const out = [];
  const seen = new Set();
  let total = 0;
  for (const f of filesIn) {
    const name = safeName(f && f.name);
    if (!name || seen.has(name)) continue;
    if (!ALLOWED.has(name)) continue;
    const data = String((f && f.data) || '');
    if (!data || data.length > MAX_TOTAL) continue;
    total += data.length;
    if (total > MAX_TOTAL) return { ok: false, error: '工程内容过大' };
    seen.add(name);
    out.push({ name, data });
  }
  if (!out.some((f) => f.name === 'project.xml')) return { ok: false, error: '缺少 project.xml' };
  return { ok: true, files: out };
}

function registerDawprojectIpc({ ipcMain, dialog, BrowserWindow, app }) {
  ipcMain.handle('dawproject:export', async (evt, payload) => {
    const p = payload || {};
    const v = normalizeFiles(p.files);
    if (!v.ok) return { ok: false, error: v.error };
    const suggested = safeName(p.suggestedName || 'project.dawproject') || 'project.dawproject';
    const name = /\.dawproject$/i.test(suggested) ? suggested : suggested + '.dawproject';
    let filePath = '';
    const e2e = process.env.FUFUMIDI_E2E === '1' && p.filePath;
    if (e2e) {
      filePath = path.resolve(String(p.filePath));
    } else {
      const r = await dialog.showSaveDialog(BrowserWindow.getFocusedWindow(), {
        title: '导出 DAWproject',
        defaultPath: path.join(app.getPath('documents'), name),
        filters: [{ name: 'DAWproject', extensions: ['dawproject'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      filePath = r.filePath;
    }
    try {
      const zip = new AdmZip();
      for (const f of v.files) zip.addFile(f.name, Buffer.from(f.data, 'utf8'));
      zip.writeZip(filePath);
      return { ok: true, filePath, bytes: fs.statSync(filePath).size, files: v.files.map((f) => f.name) };
    } catch (e) {
      return { ok: false, error: '写入 DAWproject 失败：' + String(e && e.message || e) };
    }
  });
}

module.exports = { registerDawprojectIpc };
