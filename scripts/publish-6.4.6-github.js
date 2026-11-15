// GitHub 发布：v6.4.6（与 CNB 同一份资产清单，见 release/publish-6.4.6/README-发布说明.txt）
// 用法：GH_TOKEN=<pat> node scripts/publish-6.4.6-github.js [文件名...]
//   不带参数 = 全部 8 项；带参数 = 只处理指定文件（断点续传用）
// 网络注意：本机 git/curl 走本地代理时 schannel 吊销检查会随机挂（CRYPT_E_NO_REVOCATION_CHECK），
// 所有 curl 一律带 --ssl-no-revoke；node 的 fetch 不认代理环境变量，所以 API 也走 curl。
// 权限要求（2026-11-01 踩坑）：fine-grained PAT 需要 **Contents: Read and write**；
//   只有 read 时建 release / 建 ref 一律 403 "Resource not accessible by personal access token"。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(1); }
const REPO = 'qdTXTbp/FuFumidi';
const TAG = 'v6.4.6';
const PUB = path.join(__dirname, '..', 'release', 'publish-6.4.6');

function gh(method, urlPath, bodyFile) {
  const args = ['-sS', '--ssl-no-revoke', '--max-time', '120', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'user-agent: fufumidi-publish'];
  if (bodyFile) args.push('-H', 'Content-Type: application/json', '--data-binary', '@' + bodyFile);
  args.push('https://api.github.com' + urlPath);
  return JSON.parse(execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
}

function upload(relId, file) {
  const p = path.join(PUB, file);
  const size = fs.statSync(p).size;
  for (let i = 1; i <= 3; i++) {
    try {
      const out = execFileSync('curl', ['-sS', '--ssl-no-revoke', '--max-time', '3600', '-X', 'POST',
        '-H', 'Authorization: Bearer ' + TOKEN,
        '-H', 'Content-Type: application/octet-stream',
        '-H', 'Content-Length: ' + size,
        '--data-binary', '@' + p,
        '-w', '\n%{http_code}',
        'https://uploads.github.com/repos/' + REPO + '/releases/' + relId + '/assets?name=' + encodeURIComponent(file),
      ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      const nl = out.lastIndexOf('\n');
      const code = out.slice(nl + 1).trim();
      if (code === '201') { console.log('  ✓ ' + file + ' (' + (size / 1048576).toFixed(1) + 'MB)'); return true; }
      console.log('  ✗ HTTP ' + code + ' → ' + out.slice(0, nl).slice(0, 200) + '（第 ' + i + ' 次）');
    } catch (e) {
      console.log('  ✗ ' + (e.stderr || e.message).slice(0, 160) + '（第 ' + i + ' 次）');
    }
  }
  return false;
}

(async () => {
  const filter = process.argv.slice(2);
  const files = filter.length ? filter : [
    'FuFumidi.update.exe',
    'metadata-6.4.6.json',
    'FuFumidi-Setup-6.4.6.exe',
    'FuFumidi.Install.exe',
    'FuFumidi-Setup-6.4.6.exe.blockmap',
    'FuFumidi-6.4.6-release-notes.md',
    'update-manifest.json',
    'latest.yml',
  ];
  let missing = files.filter((f) => !fs.existsSync(path.join(PUB, f)));
  if (missing.length) { console.error('缺文件:', missing.join(', ')); process.exit(1); }

  // release 幂等创建
  let rel = gh('GET', '/repos/' + REPO + '/releases/tags/' + TAG);
  if (rel.id) {
    console.log('release 已存在 id=' + rel.id, '| assets=' + rel.assets.length);
  } else {
    const bodyFile = path.join(PUB, '_gh_body.json');
    if (!fs.existsSync(bodyFile)) {
      fs.writeFileSync(bodyFile, JSON.stringify({
        tag_name: TAG, name: 'FuFumidi 6.4.6',
        body: fs.readFileSync(path.join(PUB, 'FuFumidi-6.4.6-release-notes.md'), 'utf8'),
        draft: false, prerelease: false,
      }));
    }
    rel = gh('POST', '/repos/' + REPO + '/releases?make_latest=true', bodyFile);
    if (!rel.id) { console.error('建 release 失败:', JSON.stringify(rel).slice(0, 260)); process.exit(1); }
    console.log('release 已创建 id=' + rel.id, '| target =', rel.target_commitish);
  }

  // 上传（已有同名资产跳过）
  const have = new Set(rel.assets.map((a) => a.name));
  let failed = [];
  for (const f of files) {
    if (have.has(f)) { console.log('  跳过（已存在）:', f); continue; }
    if (!upload(rel.id, f)) failed.push(f);
  }
  if (failed.length) { console.error('上传失败:', failed.join(', ')); process.exit(2); }

  // 校验：远端资产尺寸 == 本地
  const v = gh('GET', '/repos/' + REPO + '/releases/tags/' + TAG);
  console.log('远端资产 ' + v.assets.length + ' 项:');
  let bad = 0;
  for (const f of files) {
    const a = v.assets.find((x) => x.name === f);
    const local = fs.statSync(path.join(PUB, f)).size;
    const ok = a && a.size === local;
    if (!ok) bad++;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + f, a ? (a.size / 1048576).toFixed(1) + 'MB' : '(缺失)', ok ? '' : 'local=' + local);
  }
  console.log(bad ? '有 ' + bad + ' 项不一致！' : '全部一致。latest 判定看 https://github.com/' + REPO + '/releases/latest');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
