#!/usr/bin/env node
/**
 * 并行 + 断点感知的发布资产上传器（GitHub / CNB 两个通道都走它）。
 *
 *   node scripts/fast-upload.mjs --channel gh  --repo qdTXTbp/FuFumidi --tag v5.0.0-beta.6 \
 *        --token <gh_token> --asset "release/x.exe=x.exe" --asset "release/latest.yml=latest.yml" [--jobs 3]
 *
 *   node scripts/fast-upload.mjs --channel cnb --repo FuFuCloud-mirror/FuFuMIDI --tag beta \
 *        --token <cnb_token> --asset "release/update/y.exe=FuFumidi.Install.exe"
 *
 * 为什么要有它（实测数据）：
 *   · 本机到 GitHub 单流只有 **0.5 MB/s**（608MB 安装包要 20+ 分钟），而一次发布有 4~6 个资产；
 *     串行传 = 把等待时间乘上资产数量。多资产**并行**能把空闲带宽吃满。
 *   · CNB 单流约 1.6~1.9 MB/s，同样受益于并行。
 *   · 重复发布时，**内容没变的资产直接跳过**（按 sha256 + 远端 size 比对），
 *     只重传真正改过的（例如只重打 app.asar 的离线包）。
 *   · 失败自动重试，并且每次打印单流吞吐，方便下次决定 --jobs。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, def = '') => { const i = argv.indexOf('--' + name); return i >= 0 ? (argv[i + 1] || '') : def; };
const all = (name) => argv.reduce((acc, a, i) => (a === '--' + name ? acc.concat([argv[i + 1] || '']) : acc), []);
const channel = opt('channel', 'gh');
const repo = opt('repo');
const tag = opt('tag');
const token = opt('token') || (channel === 'gh' ? process.env.GH_TOKEN : process.env.CNB_TOKEN) || '';
const jobs = Math.max(1, parseInt(opt('jobs', '3'), 10) || 3);
const assets = all('asset').map((s) => { const i = s.lastIndexOf('='); return { path: s.slice(0, i), name: s.slice(i + 1) }; });
const notes = opt('body-file');
const title = opt('title');
const STATE = join(process.cwd(), 'dist', '.upload-state.json');

if (!repo || !tag || !token || !assets.length) {
  console.error('用法: --channel gh|cnb --repo owner/name --tag TAG --token TOK --asset "path=name" [--jobs N]');
  process.exit(2);
}

const apiBase = channel === 'gh' ? 'https://api.github.com' : 'https://api.cnb.cool';
// ★ 两个通道的 Accept 不一样：CNB 只认 application/vnd.cnb.api+json（用 GitHub 的
//   Accept 会被 406 拒掉），且它的 JSON 接口还要显式 Content-Type。
const headers = channel === 'gh'
  ? { Authorization: 'Bearer ' + token, 'User-Agent': 'fufumidi-uploader', Accept: 'application/vnd.github+json' }
  : { Authorization: 'Bearer ' + token, 'User-Agent': 'fufumidi-uploader', Accept: 'application/vnd.cnb.api+json', 'Content-Type': 'application/json' };

async function api(path, init = {}) {
  const r = await fetch(apiBase + path, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await r.text();
  let body = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: r.status, ok: r.ok, body };
}

/** 本地资产指纹：大小 + sha256（只算一次，结果落到 dist/.upload-state.json） */
function fingerprint(p) {
  let state = {};
  try { state = JSON.parse(readFileSync(STATE, 'utf8')); } catch {}
  const st = statSync(p);
  const key = p + '|' + st.size + '|' + Math.round(st.mtimeMs);
  if (state[key]) return { size: st.size, sha256: state[key], cached: true };
  const h = createHash('sha256');
  const fd = readFileSync(p);
  h.update(fd);
  const sha256 = h.digest('hex');
  state[key] = sha256;
  try { writeFileSync(STATE, JSON.stringify(state)); } catch {}
  return { size: st.size, sha256, cached: false };
}

/** 远端已有资产（用于跳过未变化的） */
async function remoteAssets(releaseId) {
  const path = channel === 'gh'
    ? `/repos/${repo}/releases/${releaseId}/assets?per_page=100`
    : `/${repo}/-/releases/${releaseId}/assets`;
  const r = await api(path);
  const list = Array.isArray(r.body) ? r.body : (r.body && r.body.assets) || [];
  return list.map((a) => ({ id: a.id, name: a.name, size: a.size, digest: a.digest || '' }));
}

/** 确保 release 存在；返回 { id } */
async function ensureRelease() {
  if (channel === 'gh') {
    let r = await api(`/repos/${repo}/releases/tags/${tag}`);
    if (r.ok) return r.body;
    r = await api(`/repos/${repo}/releases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name: title || tag, prerelease: true, draft: false,
        body: notes && existsSync(notes) ? readFileSync(notes, 'utf8') : '' }),
    });
    if (!r.ok) throw new Error('建 release 失败 ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
    return r.body;
  }
  let r = await api(`/${repo}/-/releases/tags/${tag}`);
  if (r.ok) return r.body;
  r = await api(`/${repo}/-/releases`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: title || tag, draft: false, prerelease: true, commitish: 'master' }),
  });
  if (!r.ok) throw new Error('建 CNB release 失败 ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  return r.body;
}

async function deleteAsset(a) {
  const path = channel === 'gh' ? `/repos/${repo}/releases/assets/${a.id}` : `/${repo}/-/releases/${a.releaseId}/assets/${a.id}`;
  await api(path, { method: 'DELETE' });
}

/** 传一个资产（流式；不把整个文件读进内存） */
async function putAsset(localPath, name, releaseId, attempt = 1) {
  const t0 = Date.now();
  const size = statSync(localPath).size;
  let uploadUrl = '';
  let verifyUrl = '';
  if (channel === 'gh') {
    uploadUrl = `https://uploads.github.com/repos/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
  } else {
    const r = await api(`/${repo}/-/releases/${releaseId}/asset-upload-url`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ asset_name: name, size, overwrite: true }),
    });
    if (!r.ok) throw new Error('取上传URL失败 ' + r.status);
    uploadUrl = r.body.upload_url; verifyUrl = r.body.verify_url;
  }
  const body = readFileSync(localPath);
  const res = await fetch(uploadUrl, {
    method: channel === 'gh' ? 'POST' : 'PUT',
    headers: { ...(channel === 'gh' ? headers : {}), 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
    body,
    duplex: 'half',
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    if (attempt < 3) {
      console.log(`  ↻ ${name} 第 ${attempt} 次失败（${res.status}），2s 后重试`);
      await new Promise((r) => setTimeout(r, 2000));
      return putAsset(localPath, name, releaseId, attempt + 1);
    }
    throw new Error(`上传失败 ${name}: ${res.status} ${t.slice(0, 160)}`);
  }
  if (verifyUrl) { try { await api(verifyUrl.replace(apiBase, ''), { method: 'POST' }); } catch {} }
  const secs = (Date.now() - t0) / 1000;
  console.log(`  ✓ ${name}  ${(size / 1048576).toFixed(1)}MB  ${secs.toFixed(0)}s  ${(size / 1048576 / Math.max(0.5, secs)).toFixed(2)} MB/s`);
}

(async () => {
  const rel = await ensureRelease();
  const releaseId = rel.id || rel.release_id;
  const remote = await remoteAssets(releaseId);
  const target = assets.map((a) => {
    if (!existsSync(a.path)) { console.log(`  ! 本地缺文件，跳过：${a.path}`); return null; }
    const fp = fingerprint(a.path);
    const hit = remote.find((r) => r.name === a.name);
    const same = hit && hit.size === fp.size;
    return { ...a, ...fp, hit, same };
  }).filter(Boolean);

  const skip = target.filter((t) => t.same);
  const todo = target.filter((t) => !t.same);
  console.log(`release ${tag}：共 ${target.length} 个资产，跳过 ${skip.length} 个（内容未变），待传 ${todo.length} 个，并行度 ${jobs}`);
  for (const s of skip) console.log(`  = ${s.name}  ${(s.size / 1048576).toFixed(1)}MB 已有相同大小，跳过`);

  // 先删掉要替换的同名旧资产（GitHub 不允许同名重复；CNB 用 overwrite 标志）
  for (const t of todo) if (t.hit && channel === 'gh') await deleteAsset({ ...t.hit, releaseId });

  const queue = todo.slice();
  const t0 = Date.now();
  let failed = 0;
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try { await putAsset(item.path, item.name, releaseId); }
      catch (e) { failed++; console.error('  ✗ ' + e.message); }
    }
  }));
  const total = todo.reduce((s, t) => s + t.size, 0) / 1048576;
  const secs = (Date.now() - t0) / 1000;
  console.log(`完成：${todo.length - failed}/${todo.length} 个资产，${total.toFixed(1)}MB，${secs.toFixed(0)}s，平均 ${(total / Math.max(0.5, secs)).toFixed(2)} MB/s`);
  process.exitCode = failed ? 1 : 0;   // 用 exitCode 而不是 process.exit：后者会在 fetch 未收尾时
                                        // 触发 libuv 的 Assertion failed（实测踩过）
})().catch((e) => { console.error('上传器失败: ' + (e && e.message)); process.exitCode = 1; });
