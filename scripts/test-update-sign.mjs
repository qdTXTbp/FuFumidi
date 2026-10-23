// P1-8 更新包签名/验签（Ed25519）：正常、篡改、错 key、格式错误全路径
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { signManifest, verifyManifest, canonicalPayload, FORMAT } = require('../main/update_sign.js');

function tmpExe(bytes = 4096) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'fufumidi-sign-')), 'FuFumidi-Setup-9.9.9.exe');
  fs.writeFileSync(p, Buffer.alloc(bytes, 0x4d));
  return p;
}
const pair = crypto.generateKeyPairSync('ed25519');
const privPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubB64 = pair.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

test('P1-8 规范串：版本/文件名/sha256 一变签名就不对', () => {
  assert.equal(canonicalPayload('6.0.0', 'a.exe', 'abc'), 'fufumidi-update/v1\n6.0.0\na.exe\nabc');
  assert.notEqual(canonicalPayload('6.0.0', 'a.exe', 'abc'), canonicalPayload('6.0.1', 'a.exe', 'abc'));
});

test('P1-8 签名→验签成功（注入临时公钥）', async () => {
  const exe = tmpExe();
  const manifest = await signManifest({ filePath: exe, version: '9.9.9', privateKeyPem: privPem });
  assert.equal(manifest.format, FORMAT);
  assert.equal(manifest.version, '9.9.9');
  assert.equal(manifest.size, 4096);
  assert.equal(manifest.sha256.length, 64);
  const r = await verifyManifest({ filePath: exe, manifest, publicKeyB64: pubB64 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.version, '9.9.9');
});

test('P1-8 安装包被篡改：sha256 不符直接失败', async () => {
  const exe = tmpExe(2048);
  const manifest = await signManifest({ filePath: exe, version: '9.9.9', privateKeyPem: privPem });
  fs.appendFileSync(exe, Buffer.from('evil'));
  const r = await verifyManifest({ filePath: exe, manifest, publicKeyB64: pubB64 });
  assert.equal(r.ok, false);
  assert.ok(/大小不符|sha256 不符/.test(r.error), r.error);
});

test('P1-8 同大小但内容不同：sha256 校验挡住', async () => {
  const exe = tmpExe(1024);
  const manifest = await signManifest({ filePath: exe, version: '9.9.9', privateKeyPem: privPem });
  fs.writeFileSync(exe, Buffer.alloc(1024, 0x5a));
  const r = await verifyManifest({ filePath: exe, manifest, publicKeyB64: pubB64 });
  assert.equal(r.ok, false);
  assert.match(r.error, /sha256 不符/);
});

test('P1-8 清单被改版本/签名：验签失败', async () => {
  const exe = tmpExe();
  const manifest = await signManifest({ filePath: exe, version: '9.9.9', privateKeyPem: privPem });
  const r1 = await verifyManifest({ filePath: exe, manifest: Object.assign({}, manifest, { version: '9.9.10' }), publicKeyB64: pubB64 });
  assert.equal(r1.ok, false);
  const r2 = await verifyManifest({ filePath: exe, manifest: Object.assign({}, manifest, { sig: Buffer.alloc(64).toString('base64') }), publicKeyB64: pubB64 });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /签名验证失败/);
});

test('P1-8 换一把公钥验签失败', async () => {
  const exe = tmpExe();
  const manifest = await signManifest({ filePath: exe, version: '9.9.9', privateKeyPem: privPem });
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const r = await verifyManifest({ filePath: exe, manifest, publicKeyB64: other });
  assert.equal(r.ok, false);
});

test('P1-8 坏清单/坏路径安全失败（不抛）', async () => {
  const exe = tmpExe();
  assert.equal((await verifyManifest({ filePath: exe, manifest: null })).ok, false);
  assert.equal((await verifyManifest({ filePath: exe, manifest: { format: 'x' } })).ok, false);
  assert.equal((await verifyManifest({ filePath: exe + '.nope', manifest: { format: FORMAT } })).ok, false);
});
