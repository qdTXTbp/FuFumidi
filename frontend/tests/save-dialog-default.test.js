// 集成回归：MusicXML 导出走 file:saveBinary 时，保存框必须打开在「导出默认目录」。
// 不启 Electron GUI，直接驱动主进程 handler；settings 模块用 require.cache 注入桩。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const settingsPath = require.resolve('../../main/settings.js');
let configured = '';
require.cache[settingsPath] = {
  id: settingsPath, filename: settingsPath, loaded: true,
  exports: { readSettings: () => ({ 'export.default_dir': configured }) },
};
const { registerDialogsIpc } = require('../../main/dialogs.js');

function harness(tmpDir) {
  const handlers = new Map();
  let saveOpts = null;
  const dialog = {
    showSaveDialog: async (o) => {
      saveOpts = o;
      return { canceled: false, filePath: path.join(tmpDir, 'out.musicxml') };
    },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  };
  registerDialogsIpc({
    ipcMain: { handle: (n, fn) => handlers.set(n, fn) },
    dialog, path, fs,
    app: { getPath: () => '/fake/Downloads' },
    spawnEngine: () => {},
  });
  return { handlers, getSaveOpts: () => saveOpts };
}

test('配置有效目录 → MusicXML 保存框 defaultPath 落在该目录', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-save-'));
  try {
    configured = dir;
    const h = harness(dir);
    assert.equal(typeof h.handlers.get('file:saveBinary'), 'function');
    const r = await h.handlers.get('file:saveBinary')(null, { name: '夜曲.musicxml', data: [60, 63] });
    assert.equal(r.ok, true);
    assert.equal(h.getSaveOpts().defaultPath, path.join(dir, '夜曲.musicxml'));
    assert.ok(fs.existsSync(path.join(dir, 'out.musicxml')), '字节应真的写盘');
  } finally { configured = ''; fs.rmSync(dir, { recursive: true, force: true }); }
});

test('未配置 → 仍回落系统下载目录（旧行为不变）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-save-'));
  try {
    configured = '';
    const h = harness(dir);
    await h.handlers.get('file:saveBinary')(null, { name: 'a.musicxml', data: [60] });
    assert.equal(h.getSaveOpts().defaultPath, path.join('/fake/Downloads', 'a.musicxml'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('dialog:pickDirectory 支持 defaultPath（设置里二次选目录不用重新找）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-pick-'));
  try {
    let openOpts = null;
    const handlers = new Map();
    registerDialogsIpc({
      ipcMain: { handle: (n, fn) => handlers.set(n, fn) },
      dialog: {
        showSaveDialog: async () => ({ canceled: true }),
        showOpenDialog: async (o) => { openOpts = o; return { canceled: true, filePaths: [] }; },
      },
      path, fs, app: { getPath: () => '/fake/Downloads' }, spawnEngine: () => {},
    });
    assert.equal(await handlers.get('dialog:pickDirectory')(null, { defaultPath: dir }), null);
    assert.equal(openOpts.defaultPath, dir);
    await handlers.get('dialog:pickDirectory')(null, undefined);
    assert.equal(openOpts.defaultPath, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
