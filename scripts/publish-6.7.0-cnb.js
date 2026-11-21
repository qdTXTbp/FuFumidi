// CNB 正式版发布：v6.7.0 标为 latest。beta 通道同样会收到（允许正式版）。
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOKEN = process.env.CNB_TOKEN;
if (!TOKEN) { console.error("缺少 CNB_TOKEN 环境变量"); process.exit(1); }
const CNB_REPO = 'FuFuCloud-mirror/FuFuMIDI';
const CNB_API = 'https://api.cnb.cool';
const VER = '6.7.0';
const TAG = 'v' + VER;
const DIR = path.resolve(__dirname, '..', 'release', 'publish-' + VER);
const NOTES = path.join(DIR, 'FuFumidi-' + VER + '-release-notes.md');

const H_CNB = ['-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Accept: application/vnd.cnb.api+json'];
const H_JSON = [...H_CNB, '-H', 'Content-Type: application/json'];

const FILES = [
  'latest.yml',
  'update-manifest.json',
  'FuFumidi-' + VER + '-release-notes.md',
  'FuFumidi.update.exe',
  'metadata-' + VER + '.json',
  'FuFumidi-Setup-' + VER + '.exe.blockmap',
  'FuFumidi.Install.exe',
  'FuFumidi-Setup-' + VER + '.exe',
  'FuFumidi-' + VER + '-win-x64-unpacked.zip',
];

function curlString(args) {
  return String(execFileSync('curl.exe', ['-sS', '--ssl-no-revoke', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }) || '').trim();
}
function curlJson(args) {
  const s = curlString(args);
  try { return JSON.parse(s); } catch (e) { return { _raw: s.slice(0, 300) }; }
}
function writeBody(obj) {
  const p = path.join(__dirname, '..', 'release', `_beta_body-${Date.now()}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (n > 1e6 ? (n / 1048576).toFixed(1) + 'MB' : (n / 1024).toFixed(0) + 'KB');

function findRelease(tag) {
  return curlJson([...H_CNB, `${CNB_API}/${CNB_REPO}/-/releases/tags/${encodeURIComponent(tag)}`]);
}

function createRelease(tag, name, body, makeLatest, pre) {
  const bodyFile = writeBody({
    tag_name: tag, name, body,
    prerelease: Boolean(pre), make_latest: makeLatest, target_commitish: 'master',
  });
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

async function fillAssets(tag, label, body) {
  let rel = findRelease(tag);
  if (rel && rel.id) {
    console.log(`release ${tag} 已存在 id=${rel.id}，直接覆盖资产`);
  } else {
    console.log(`创建 release ${tag} ...`);
    rel = await createRelease(tag, label, body, 'true', false);
    console.log('created id=' + rel.id);
  }
  let uploaded = 0;
  for (const f of FILES) {
    const local = path.join(DIR, f);
    if (!fs.existsSync(local)) throw new Error('缺文件: ' + local);
    const t0 = Date.now();
    const size = await uploadAsset(rel.id, f, local);
    uploaded++;
    console.log(`  [${uploaded}/${FILES.length}] ${f} (${fmt(size)}, ${((Date.now() - t0) / 1000).toFixed(0)}s)`);
  }
  const end = findRelease(tag);
  console.log(`${label} 远端资产 ${(end.assets || []).length} 项，is_latest=${end.is_latest}`);
  return end;
}

(async () => {
  const missing = FILES.filter((f) => !fs.existsSync(path.join(DIR, f)));
  if (missing.length) { console.error('缺文件:', missing.join(', ')); process.exit(1); }
  const notes = fs.readFileSync(NOTES, 'utf8');

  const ver = await fillAssets(TAG, 'FuFumidi ' + VER, notes);

  if (ver.is_latest !== true) { console.error('危险：正式版没有成为 CNB latest！'); process.exit(3); }
  const stable = curlJson([...H_CNB, `${CNB_API}/${CNB_REPO}/-/releases/latest`]);
  console.log('CNB 稳定通道 latest = ' + (stable.tag_name || '(查询失败)') + '（应为 ' + TAG + '）');
  console.log('完成。beta 通道允许正式版，同样会升到 ' + TAG + '。');
})().catch((e) => { console.error('PUBLISH FAILED:', e.message); process.exit(1); });
