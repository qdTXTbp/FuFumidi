import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { inspectEntries, safeExtractAllTo } from '../main/zip-safe.js';

test('zip-safe 同时接受 AdmZip 实例与压缩包路径', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-zip-safe-'));
  const zipPath = path.join(dir, 'runtime.zip');
  const out = path.join(dir, 'out');
  try {
    const z = new AdmZip();
    z.addFile('site/pkg/__init__.py', Buffer.from(''));
    z.addFile('amt/model.ckpt', Buffer.from('ckpt'));
    z.writeZip(zipPath);
    const a = inspectEntries(zipPath, out);
    assert.equal(a.ok, true);
    assert.equal(a.count, 2);
    const r = safeExtractAllTo(zipPath, out);
    assert.equal(r.ok, true);
    assert.equal(fs.existsSync(path.join(out, 'amt', 'model.ckpt')), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
