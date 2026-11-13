// 主进程「导出默认目录」解析：优先用户设置，非法时回落系统下载目录
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { exportDefaultDir, saveDefaultPath } = require('../../main/export-dir.js');

const app = { getPath: () => '/fake/Downloads' };

test('设置了有效目录 → 直接用，不再落到 downloads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-export-'));
  try {
    assert.equal(exportDefaultDir(app, () => ({ 'export.default_dir': dir })), dir);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('设置指向被删的目录 / 指向文件 → 回落 downloads', () => {
  const gone = path.join(os.tmpdir(), 'fufumidi-no-such-dir-' + Date.now());
  assert.equal(exportDefaultDir(app, () => ({ 'export.default_dir': gone })), '/fake/Downloads');
  const file = path.join(os.tmpdir(), 'fufumidi-a-file-' + Date.now());
  fs.writeFileSync(file, 'x');
  try { assert.equal(exportDefaultDir(app, () => ({ 'export.default_dir': file })), '/fake/Downloads'); }
  finally { fs.rmSync(file, { force: true }); }
});

test('未配置 / 设置读取抛错 → 回落 downloads', () => {
  assert.equal(exportDefaultDir(app, () => ({})), '/fake/Downloads');
  assert.equal(exportDefaultDir(app, () => { throw new Error('settings broken'); }), '/fake/Downloads');
});

test('连 downloads 都拿不到 → 返回空串，不抛异常', () => {
  const broken = { getPath: () => { throw new Error('no app'); } };
  assert.equal(exportDefaultDir(broken, () => ({})), '');
});

test('saveDefaultPath：有效目录时拼上文件名，无目录时只给文件名', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-export-'));
  try {
    assert.equal(saveDefaultPath(app, path, 'score.musicxml', () => ({ 'export.default_dir': dir })),
      path.join(dir, 'score.musicxml'));
    assert.equal(saveDefaultPath({ getPath: () => { throw new Error('x'); } }, path, 'score.musicxml', () => ({})),
      'score.musicxml');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
