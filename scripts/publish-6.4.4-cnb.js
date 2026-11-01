#!/usr/bin/env node
// 把 release/publish-6.4.4/ 的资产发布到 CNB release tag v6.4.4（make_latest）。
// 复用 cnb-mirror-releases.js 的 API 口径（token 在该文件与 git remote 里）。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOKEN = '1k116d2fIemvN8dfht2OAJlHJcL';
const CNB_REPO = 'FuFuCloud-mirror/FuFuMIDI';
const CNB_API = 'https://api.cnb.cool';
const TAG = 'v6.4.4';
const DIR = path.resolve(__dirname, '..', 'release', 'publish-6.4.4');

const H_CNB = ['-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Accept: application/vnd.cnb.api+json'];
const H_JSON = [...H_CNB, '-H', 'Content-Type: application/json'];

function curlString(args) {
  return String(execFileSync('curl.exe', ['-sS', '--ssl-no-revoke', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) || '').trim();
}
function curlJson(args) {
  const s = curlString(args);
  try { return JSON.parse(s); } catch (e) { return { _raw: s.slice(0, 300) }; }
}
function writeBody(obj) {
  const p = path.join(__dirname, '..', 'release', `_body-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (n > 1e6 ? (n / 1048576).toFixed(1) + 'MB' : (n / 1024).toFixed(0) + 'KB');

function findRelease() {
  return curlJson([...H_CNB, `${CNB_API}/${CNB_REPO}/-/releases/tags/${encodeURIComponent(TAG)}`]);
}

async function createRelease() {
  const body = fs.readFileSync(path.join(DIR, 'FuFumidi-6.4.4-release-notes.md'), 'utf8');
  const bodyFile = writeBody({ tag_name: TAG, name: 'FuFumidi 6.4.4', body, prerelease: false, make_latest: 'true', target_commitish: require('child_process').execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
  try {
    const created = curlJson([...H_JSON, '-X', 'POST', '--data', '@' + bodyFile, `${CNB_API}/${CNB_REPO}/-/releases`]);
    if (created && created.id) return created;
    throw new Error('创建失败: ' + (created._raw || JSON.stringify(created).slice(0, 300)));
  } finally { try { fs.unlinkSync(bodyFile); } catch (_) {} }
}

async function uploadAsset(releaseId, name, localFile) {
  const size = fs.statSync(localFile).size;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const bodyFile = writeBody({ asset_name: name, size, overwrite: true });
      const info = curlJson([...H_JSON, '-X', 'POST', '--data', '@' + bodyFile, `${CNB_API}/${CNB_REPO}/-/releases/${releaseId}/asset-upload-url`]);
      try { fs.unlinkSync(bodyFile); } catch (_) {}
      if (!info || !info.upload_url) throw new Error('取上传URL失败: ' + (info._raw || JSON.stringify(info).slice(0, 200)));
      execFileSync('curl.exe', ['-sS', '--ssl-no-revoke', '-m', '3600', '--connect-timeout', '20',
        '--speed-limit', '1024', '--speed-time', '60',
        '-X', 'PUT', '--upload-file', localFile, info.upload_url], { stdio: ['ignore', 'pipe', 'pipe'] });
      if (info.verify_url) curlString([...H_CNB, '-X', 'POST', info.verify_url]);
      return size;
    } catch (e) {
      const msg = String((e && e.message) || e).split('\n')[0];
      console.log(`    [重试 ${attempt}/3] ${name}: ${msg}`);
      if (attempt < 3) await sleep(5000);
      else throw e;
    }
  }
}

(async () => {
  const filter = process.argv.slice(2);
  const files = (filter.length ? filter : [
    'latest.yml',
    'update-manifest.json',
    'FuFumidi-6.4.4-release-notes.md',
    'FuFumidi.Install.exe.blockmap',
    'FuFumidi-Setup-6.4.4.exe.blockmap',
    'FuFumidi.Install.exe',
    'FuFumidi-Setup-6.4.4.exe',
  ]);

  let rel = findRelease();
  if (rel && rel.id) {
    console.log('release v6.4.4 已存在 id=' + rel.id + '，直接往里补资产');
  } else {
    console.log('创建 release v6.4.4 ...');
    rel = await createRelease();
    console.log('created id=' + rel.id);
  }

  let uploaded = 0;
  for (const f of files) {
    const local = path.join(DIR, f);
    if (!fs.existsSync(local)) throw new Error('缺文件: ' + local);
    const t0 = Date.now();
    const size = await uploadAsset(rel.id, f, local);
    uploaded++;
    console.log(`  [${uploaded}/${files.length}] ${f} (${fmt(size)}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  console.log('全部上传完成');
})().catch((e) => { console.error('PUBLISH FAILED:', e.message); process.exit(1); });
