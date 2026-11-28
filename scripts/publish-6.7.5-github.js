// GitHub 正式版发布：v6.7.5 标为 latest，正式通道与 beta 通道都会升到这一版。
// 用法：GH_TOKEN=<pat> node scripts/publish-6.7.5-github.js
// beta 通道也允许正式版（main/update-channel.js 的 allowsRelease），所以不需要动 beta 锚点；
// 而且测试通道回退到正式版时**必须**走稳定锚点下载，动锚点反而会让更新失败。
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TOKEN = process.env.GH_TOKEN;
if (!TOKEN) { console.error('缺少 GH_TOKEN 环境变量'); process.exit(1); }
const REPO = 'qdTXTbp/FuFumidi';
const VER = '6.7.5';
const TAG = 'v' + VER;
const PUB = path.join(__dirname, '..', 'release', 'publish-' + VER);
const NOTES = path.join(PUB, 'FuFumidi-' + VER + '-release-notes.md');

const FILES = [
  'FuFumidi.update.exe',
  'metadata-' + VER + '.json',
  'FuFumidi-Setup-' + VER + '.exe',
  'FuFumidi.Install.exe',
  'FuFumidi-Setup-' + VER + '.exe.blockmap',
  'FuFumidi-' + VER + '-release-notes.md',
  'update-manifest.json',
  'latest.yml',
  'FuFumidi-' + VER + '-win-x64-unpacked.zip',
];

function gh(method, urlPath, bodyFile) {
  const args = ['-sS', '--ssl-no-revoke', '--max-time', '120', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'user-agent: fufumidi-publish'];
  if (bodyFile) args.push('-H', 'Content-Type: application/json', '--data-binary', '@' + bodyFile);
  args.push('https://api.github.com' + urlPath);
  const out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  try { return JSON.parse(out); } catch (e) { return { _raw: out.slice(0, 300) }; }
}

function createRelease(tag, name, body, pre) {
  const f = path.join(PUB, '_gh_body_' + tag + '.json');
  fs.writeFileSync(f, JSON.stringify({
    tag_name: tag, name, body,
    draft: false, prerelease: pre,
  }));
  const rel = gh('POST', '/repos/' + REPO + '/releases?make_latest=true', f);
  try { fs.unlinkSync(f); } catch (_) {}
  if (!rel.id) throw new Error('建 release ' + tag + ' 失败: ' + JSON.stringify(rel).slice(0, 260));
  return rel;
}

function ensureRelease(tag, name, body, pre) {
  const rel = gh('GET', '/repos/' + REPO + '/releases/tags/' + tag);
  if (rel.id) {
    console.log('release ' + tag + ' 已存在 id=' + rel.id + ' | prerelease=' + rel.prerelease + ' | assets=' + rel.assets.length);
    if (rel.prerelease !== pre) {
      const patch = path.join(PUB, '_gh_patch.json');
      fs.writeFileSync(patch, JSON.stringify({ prerelease: pre }));
      gh('PATCH', '/repos/' + REPO + '/releases/' + rel.id, patch);
      try { fs.unlinkSync(patch); } catch (_) {}
      console.log('  已把 prerelease 修正为 ' + pre + '（确保 stable 不收到）');
    }
    return rel;
  }
  const created = createRelease(tag, name, body, pre);
  console.log('release ' + tag + ' 已创建 id=' + created.id);
  return created;
}

function deleteAsset(asset) {
  gh('DELETE', '/repos/' + REPO + '/releases/assets/' + asset.id);
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

function fillAssets(rel, label) {
  let cur = gh('GET', '/repos/' + REPO + '/releases/' + rel.id);
  const have = new Map(cur.assets.map((a) => [a.name, a]));
  for (const f of FILES) {
    if (have.has(f)) {
      const a = have.get(f);
      if (a.size === fs.statSync(path.join(PUB, f)).size) { console.log('  跳过（同尺寸）: ' + f); continue; }
      console.log('  覆盖旧资产: ' + f);
      deleteAsset(a);
    }
    if (!upload(rel.id, f)) throw new Error(label + ' 上传失败: ' + f);
  }
  cur = gh('GET', '/repos/' + REPO + '/releases/' + rel.id);
  const bad = FILES.filter((f) => {
    const a = cur.assets.find((x) => x.name === f);
    return !a || a.size !== fs.statSync(path.join(PUB, f)).size;
  });
  if (bad.length) throw new Error(label + ' 资产不一致: ' + bad.join(', '));
  console.log(label + ' 远端 ' + cur.assets.length + ' 项，尺寸全部一致');
}

(async () => {
  const missing = FILES.filter((f) => !fs.existsSync(path.join(PUB, f)));
  if (missing.length) { console.error('缺文件:', missing.join(', ')); process.exit(1); }
  const notes = fs.readFileSync(NOTES, 'utf8');

  const ver = ensureRelease(TAG, 'FuFumidi ' + VER, notes, false);
  fillAssets(ver, TAG);

  const latest = gh('GET', '/repos/' + REPO + '/releases/latest');
  console.log('稳定通道 latest = ' + latest.tag_name + '（应为 ' + TAG + '）');
  if (latest.tag_name !== TAG) { console.error('危险：正式版没有成为 latest，正式通道收不到更新！'); process.exit(3); }
  console.log('完成。正式通道读 /releases/latest；beta 通道因允许正式版，同样会升到 ' + TAG + '。');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
