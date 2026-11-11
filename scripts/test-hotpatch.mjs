#!/usr/bin/env node
// ============================================================
// 热补丁回归：签名/白名单/内容校验/原子覆盖/回滚/更新后重放/构建工具
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AdmZip = require('adm-zip');
const HM = require('../main/hotpatch_manifest.js');
const HP = require('../main/hotpatch.js');

const REL = 'resources/app.asar.unpacked/engine/audio_io.py';
const REL2 = 'resources/app.asar.unpacked/engine/engine_muscriptor.py';

function keys() {
  const kp = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }),
    publicKeyB64: kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}
function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'fuhp-test-')); }
function sha(buf) { return HM.sha256Buffer(buf); }

/** 造一个合法补丁：返回 manifest、zip、公钥、密钥、两个文件的内容 */
function fixture(overrides = {}) {
  const k = keys();
  const a = Buffer.from('print("patched-a")\n');
  const b = Buffer.from('print("patched-b")\n');
  const zip = new AdmZip();
  zip.addFile(REL, a);
  zip.addFile(REL2, b);
  const zipBuf = zip.toBuffer();
  const files = [
    { path: REL, size: a.length, sha256: sha(a) },
    { path: REL2, size: b.length, sha256: sha(b) },
  ];
  const manifest = HM.signHotpatch({
    format: HM.FORMAT,
    id: '2026-11-11-01',
    notes: 'test patch',
    target: { min: '6.4.0', max: '6.4.99' },
    package: { name: 'hotpatch-2026-11-11-01.zip', size: zipBuf.length, sha256: sha(zipBuf) },
    files,
    ...overrides,
  }, k.privateKeyPem);
  return { ...k, manifest, zipBuf, a, b, files };
}

/* ---------------- 清单与签名 ---------------- */

test('签名可验证，任何字段被篡改都拒绝', () => {
  const f = fixture();
  assert.equal(HM.verifyHotpatch(f.manifest, { publicKeyB64: f.publicKeyB64, currentVersion: '6.4.10' }).ok, true);
  for (const mutate of [
    (m) => { m.notes = 'evil'; },
    (m) => { m.files[0].sha256 = 'c'.repeat(64); },
    (m) => { m.package.sha256 = 'd'.repeat(64); },
    (m) => { m.id = 'other-id'; },
    (m) => { m.target.max = '6.4.0'; },
    (m) => { m.files.push({ path: REL2, size: 1, sha256: 'e'.repeat(64) }); },
  ]) {
    const m = JSON.parse(JSON.stringify(f.manifest));
    mutate(m);
    assert.equal(HM.verifyHotpatch(m, { publicKeyB64: f.publicKeyB64 }).ok, false);
  }
  // 换一把公钥也验不过
  assert.equal(HM.verifyHotpatch(f.manifest, { publicKeyB64: keys().publicKeyB64 }).ok, false);
});

test('目标路径白名单：拒绝穿越、asar 内、盘符、可执行文件', () => {
  for (const p of [
    '../evil.py', 'resources/app.asar.unpacked/engine/../../evil.py',
    'C:/Windows/x.py', '/etc/passwd', 'resources\\app.asar.unpacked\\engine\\x.py',
    'resources/app.asar/main/update.js',            // asar 内，整包发版范畴
    'resources/app.asar.unpacked/engine/x.exe',
    'resources/app.asar.unpacked/engine/x.pyc',
    'resources/app.asar.unpacked/engine/x.dll',
    'resources/python/python.exe',                  // 运行时目录，不在白名单
    'resources/app.asar.unpacked/engine/',          // 目录本身
  ]) {
    assert.equal(HM.validateRelPath(p).ok, false, '应拒绝：' + p);
  }
  assert.equal(HM.validateRelPath(REL).ok, true);
  assert.equal(HM.validateRelPath('resources/app.asar.unpacked/renderer/dist/vendor/js-synth/a.js').ok, true);
});

test('适用版本范围与体积/数量上限', () => {
  const f = fixture();
  assert.equal(HM.verifyHotpatch(f.manifest, { publicKeyB64: f.publicKeyB64, currentVersion: '6.3.9' }).ok, false);
  assert.equal(HM.verifyHotpatch(f.manifest, { publicKeyB64: f.publicKeyB64, currentVersion: '6.5.0' }).ok, false);
  assert.equal(HM.verifyHotpatch(f.manifest, { publicKeyB64: f.publicKeyB64, currentVersion: '6.4.0' }).ok, true);
  const big = JSON.parse(JSON.stringify(f.manifest));
  big.files[0].size = HM.MAX_FILE_BYTES + 1;
  assert.equal(HM.verifyHotpatch(big, { publicKeyB64: f.publicKeyB64 }).ok, false);
  const many = JSON.parse(JSON.stringify(f.manifest));
  many.files = Array.from({ length: HM.MAX_FILES + 1 }, (_, i) => ({ path: REL, size: 1, sha256: 'a'.repeat(64) }));
  assert.equal(HM.verifyHotpatch(many, { publicKeyB64: f.publicKeyB64 }).ok, false);
});
test('cmpVersion 是数值比较，不是字符串比较', () => {
  assert.ok(HM.cmpVersion('6.4.10', '6.4.9') > 0);
  assert.ok(HM.cmpVersion('6.10.0', '6.9.9') > 0);
});

/* ---------------- zip 内容校验 ---------------- */

test('planFromZip 逐文件校验 size/sha256，拒绝清单外条目与非法路径', () => {
  const f = fixture();
  assert.equal(HP.planFromZip(f.zipBuf, f.manifest.files).ok, true);
  assert.equal(HP.planFromZip(f.zipBuf, [{ ...f.manifest.files[0], sha256: 'a'.repeat(64) }]).ok, false);
  assert.equal(HP.planFromZip(f.zipBuf, f.manifest.files.slice(0, 1)).ok, false, '清单外文件必须拒绝');
  const evil = new AdmZip();
  evil.addFile('../../evil.py', Buffer.from('x'));
  evil.addFile(REL, f.a);
  evil.addFile(REL2, f.b);
  assert.equal(HP.planFromZip(evil.toBuffer(), f.manifest.files).ok, false);
});

/* ---------------- 覆盖、重放、回滚 ---------------- */

test('applyToDisk 原子覆盖 + 完整更新冲掉后 targetsMatch 变 false + 回滚恢复原文件', () => {
  const root = tmp();
  const targetRoot = path.join(root, 'install');
  const stateRoot = path.join(root, 'data', 'hotpatch');
  const p = path.join(targetRoot, ...REL.split('/'));
  const p2 = path.join(targetRoot, ...REL2.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'original-a');
  // REL2 原本不存在 → 回滚时应删除

  const f = fixture();
  const plan = HP.planFromZip(f.zipBuf, f.manifest.files);
  assert.equal(plan.ok, true);
  assert.equal(HP.applyToDisk(plan, { targetRoot, stateRoot, id: f.manifest.id }).ok, true);
  assert.equal(fs.readFileSync(p, 'utf8'), f.a.toString());
  assert.equal(fs.readFileSync(p2, 'utf8'), f.b.toString());
  assert.equal(HP.targetsMatch(f.manifest.files, targetRoot), true);

  // 模拟 kachina 完整更新把 app.asar.unpacked 整体换回基线
  fs.writeFileSync(p, 'original-a');
  assert.equal(HP.targetsMatch(f.manifest.files, targetRoot), false);

  HP._internals.atomicJson(HP.stateFile(stateRoot), {
    applied: [{ id: f.manifest.id, at: 'now', files: [REL, REL2] }],
    lastCheck: '', lastError: '',
  });
  const rb = HP.rollback(stateRoot, targetRoot);
  assert.equal(rb.ok, true);
  assert.equal(fs.readFileSync(p, 'utf8'), 'original-a');
  assert.equal(fs.existsSync(p2), false, '补丁新增的文件回滚后应删除');
});

/* ---------------- 端到端 check() ---------------- */

function ctxFor(f, root, overrides = {}) {
  const targetRoot = path.join(root, 'install');
  const stateRoot = path.join(root, 'data', 'hotpatch');
  const cacheDir = path.join(stateRoot, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(path.join(cacheDir, f.manifest.package.name), f.zipBuf);
  // 缓存已预置：任何对 .zip 的请求都视为「不该发生的下载」
  const net = {
    fetch: async (url) => {
      if (String(url).includes('.zip')) throw new Error('不应下载 zip：应命中本地缓存');
      return { ok: true, text: async () => JSON.stringify(f.manifest) };
    },
  };
  return {
    net, fs, path,
    appVersion: '6.4.10',
    readSettings: () => ({}),
    source: 'cnb',
    publicKeyB64: f.publicKeyB64,
    targetRoot, stateRoot,
    ...overrides,
  };
}

test('check：首次应用 → 再次检查 up-to-date → 被冲掉后自动重放', async () => {
  const root = tmp();
  const f = fixture();
  const c = ctxFor(f, root);
  const p = path.join(c.targetRoot, ...REL.split('/'));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, 'original');

  const r1 = await HP.check(c);
  assert.equal(r1.status, 'applied', JSON.stringify(r1));
  assert.equal(fs.readFileSync(p, 'utf8'), f.a.toString());

  const r2 = await HP.check(c);
  assert.equal(r2.status, 'up-to-date');

  // 完整更新把文件换回基线 → 下次启动自动重放，且不重新下载（走 cache）
  fs.writeFileSync(p, 'original');
  const r3 = await HP.check(c);
  assert.equal(r3.status, 'replayed', JSON.stringify(r3));
  assert.equal(fs.readFileSync(p, 'utf8'), f.a.toString());
});

test('check：签名不对 / 源不可用 / 版本不匹配都安全跳过，不写任何文件', async () => {
  const root = tmp();
  const f = fixture();
  const p = path.join(root, 'install', ...REL.split('/'));

  const bad = await HP.check(ctxFor(f, root, { publicKeyB64: keys().publicKeyB64 }));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /签名/);
  assert.equal(fs.existsSync(p), false);

  const noNet = await HP.check(ctxFor(f, root, { net: { fetch: async () => { throw new Error('offline'); } } }));
  assert.equal(noNet.status, 'unreachable');
  assert.equal(fs.existsSync(p), false);

  const wrongVer = await HP.check(ctxFor(f, root, { appVersion: '6.3.0' }));
  assert.equal(wrongVer.status, 'invalid');
  assert.equal(fs.existsSync(p), false);

  // 仓库还没发布任何补丁（所有源 404）是正常状态，不应记成失败
  const none = await HP.check(ctxFor(f, root, {
    net: { fetch: async () => ({ ok: false, status: 404 }) },
  }));
  assert.equal(none.status, 'none');
  assert.equal(none.ok, true);

  // 现实网络：raw.githubusercontent 被墙 + 另一个源明确 404 → 仍然是「无补丁」，不是「全部不可用」
  let mixedN = 0;
  const mixed = await HP.check(ctxFor(f, root, {
    net: {
      fetch: async () => {
        mixedN++;
        if (mixedN === 1) return { ok: false, status: 404 };
        throw new Error('blocked');
      },
    },
  }));
  assert.equal(mixed.status, 'none');
  assert.equal(mixed.ok, true);
  assert.equal(HP.readState(ctxFor(f, root).stateRoot).lastError, '');
});

test('urlsFor 按下载源偏好排序，两端都在候选里', () => {
  const cnb = HP.urlsFor('hotpatch.json', 'cnb');
  const gh = HP.urlsFor('hotpatch.json', 'github');
  assert.ok(cnb[0].includes('cnb.cool'));
  assert.ok(gh[0].includes('ghfast.top') || gh[0].includes('raw.githubusercontent.com'));
  assert.ok(cnb.some((u) => u.includes('raw.githubusercontent.com')));
  assert.ok(gh.some((u) => u.includes('cnb.cool')));
  // 两个远端的默认分支都是 master（git ls-remote --symref 实测）；写 main 会永远 404
  for (const u of [...cnb, ...gh]) assert.ok(u.includes('/master/'), '分支必须是 master：' + u);
});

/* ---------------- 构建工具端到端 ---------------- */

test('build-hotpatch 生成可验签的清单与 zip', () => {
  const root = tmp();
  const k = keys();
  const keyFile = path.join(root, 'key.pem');
  fs.writeFileSync(keyFile, k.privateKeyPem);
  const out = path.join(root, 'out');
  execFileSync(process.execPath, [
    path.join(process.cwd(), 'scripts/build-hotpatch.mjs'),
    '--id', 'unit-01',
    '--files', 'engine/audio_io.py',
    '--notes', 'unit test',
    '--min', '6.4.0', '--max', '6.4.99',
    '--key', keyFile,
    '--pub', k.publicKeyB64,
    '--out', out,
  ], { cwd: process.cwd(), encoding: 'utf8' });
  const manifest = JSON.parse(fs.readFileSync(path.join(out, 'hotpatch.json'), 'utf8'));
  const zipBuf = fs.readFileSync(path.join(out, manifest.package.name));
  const v = HM.verifyHotpatch(manifest, { publicKeyB64: k.publicKeyB64, currentVersion: '6.4.10' });
  assert.equal(v.ok, true, v.error);
  assert.equal(manifest.package.size, zipBuf.length);
  assert.equal(sha(zipBuf), manifest.package.sha256);
  const plan = HP.planFromZip(zipBuf, v.files);
  assert.equal(plan.ok, true, plan.error);
  assert.equal(plan.files[0].rel, REL);
});
