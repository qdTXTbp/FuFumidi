// 上传 soundfonts-dist/<id>/ 下的 SF2 到 monologue82/FuFumidiSoundFonts 的 GitHub Release（大文件走 asset）。
// PAT 从环境变量 FUFPAT 读取（不入文件）。用法：
//   $env:FUFPAT='ghp_...'; node scripts/upload-soundfonts.mjs [tag]
import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const distRoot = path.join(root, 'soundfonts-dist');
const REPO = 'monologue82/FuFumidiSoundFonts';
const PAT = process.env.FUFPAT;
if (!PAT) { console.error('缺少环境变量 FUFPAT'); process.exit(1); }

const H = { Authorization: `Bearer ${PAT}`, 'User-Agent': 'FuFumidi-upload', Accept: 'application/vnd.github+json' };

async function api(url, method = 'GET', body, isForm = false) {
  const headers = { ...H };
  if (body && !isForm) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body && isForm ? body : (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch (e) {}
  if (!res.ok) throw new Error(`${res.status} ${json && (json.message || JSON.stringify(json)) || text}`);
  return json;
}

const tag = process.argv[2] || 'v1';
const uploadUrl = `https://uploads.github.com/repos/${REPO}/releases`;

// 1) 收集待上传文件
const files = [];
for (const id of readdirSync(distRoot, { withFileTypes: true })) {
  if (!id.isDirectory()) continue;
  const dir = path.join(distRoot, id.name);
  const sf = readdirSync(dir).find(f => /\.(sf2|sf3)$/i.test(f));
  if (sf) {
    const p = path.join(dir, sf);
    files.push({ id: id.name, name: sf, path: p, size: statSync(p).size });
  }
}
if (!files.length) { console.error('soundfonts-dist 中未找到 .sf2 文件'); process.exit(1); }
console.log(`待上传 ${files.length} 个：`, files.map(f => `${f.id}(${(f.size / 1048576).toFixed(1)}MB)`).join(', '));

// 2) 创建 Release（可能已存在 tag → 复用）
async function ensureRelease() {
  try { return await api(`https://api.github.com/repos/${REPO}/releases/tags/${tag}`); }
  catch (e) { return api(`https://api.github.com/repos/${REPO}/releases`, 'POST', { tag_name: tag, name: `SoundFonts ${tag}`, draft: false, prerelease: false }); }
}
const rel = await ensureRelease();
console.log(`[release] ${tag} id=${rel.id}`);

// 3) 逐个上传 asset（保留同名覆盖）
let okCount = 0;
for (const f of files) {
  // GitHub 会把 asset 文件名中的空格规范化为 '.'，比较时按同样规则匹配，避免误判重复
  const slugKey = f.name.replace(/ /g, '.');
  const existing = (rel.assets || []).find(a => a.name === f.name || a.name === slugKey);
  if (existing) { console.log(`[skip] ${f.name} → asset ${existing.name} 已存在`); okCount++; continue; }
  console.log(`[up] ${f.name} (${(f.size / 1048576).toFixed(1)}MB) ...`);
  const { readFile } = await import('node:fs/promises');
  const data = await readFile(f.path);
  const res = await fetch(`${uploadUrl}/${rel.id}/assets?name=${encodeURIComponent(f.name)}`, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(data.byteLength) },
    body: data, redirect: 'follow',
  });
  const txt = await res.text();
  if (!res.ok) { console.error(`  FAIL ${res.status} ${txt.slice(0,200)}`); continue; }
  const j = JSON.parse(txt);
  console.log(`  ok browser_download_url=${j.browser_download_url}`);
  okCount++;
}
console.log(`\n完成：成功上传 ${okCount}/${files.length}。Release: https://github.com/${REPO}/releases/tag/${tag}`);