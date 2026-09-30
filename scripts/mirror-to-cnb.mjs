#!/usr/bin/env node
// ============================================================
// 把 GitHub 上的资源镜像到 CNB（国内源），供应用「下载源 = 自动 / 国内」时走国内线路
//
// 用法（令牌只从环境变量读，不要写进脚本）：
//   $env:CNB_TOKEN = '<CNB 访问令牌>'
//
//   # 1) Release 资产镜像：把 GitHub 某 tag 的附件传到 CNB 的某个 tag 下
//   node scripts/mirror-to-cnb.mjs release --repo qdTXTbp/FuFumidi --tag v2.1.0 --dst-tag gpu-v1 --match "^fufumidi-gpu-"
//   node scripts/mirror-to-cnb.mjs release --repo qdTXTbp/FuFumidi --tag soundfonts-v1 --dst-tag soundfonts-v1
//   node scripts/mirror-to-cnb.mjs release --repo monologue82/FuFumidiSoundFonts --tag v1 --dst-tag soundfonts-v1
//
//   # 2) 仓库文件树镜像：把 GitHub 仓库整树推到 CNB 仓库（供 /-/git/raw/<ref>/<path> 直读）
//   node scripts/mirror-to-cnb.mjs tree --repo monologue82/Models --dst-repo FuFuCloud-mirror/Models --ref main --fetch
//   #    --local <dir> 可指定「本地已有同结构目录」：命中且校验一致就不下载（大幅省流）
//   node scripts/mirror-to-cnb.mjs tree --repo monologue82/Models --dst-repo FuFuCloud-mirror/Models --fetch --local D:/FuFuMIDI/Models-upload2
//
//   # 3) 目录文件镜像（壁纸等，含 Git LFS 真身）→ CNB Release 资产 + 清单
//   node scripts/mirror-to-cnb.mjs files --repo monologue82/Media --dir wallpapers --dst-tag wallpapers-v1
//
//   # 4) 仓库资产镜像：把 GitHub Release 资产提交进一个 CNB 仓库（供 git raw 直读）
//   node scripts/mirror-to-cnb.mjs assets --repo qdTXTbp/FuFumidi --tag v2.1.0 --match "^fufumidi-gpu-" --dst-repo FuFuCloud-mirror/FuFumidiGPU
//
// 注意：tree 模式会**整树覆盖**目标分支（合成提交）；assets 模式是在现有分支上**追加**。
//       同一个仓库两者都用时，必须先 tree 再 assets；之后再单独跑 tree 会把 assets 的内容冲掉。
//
// 特性：幂等（已存在的同名资产 / 同尺寸文件会跳过）、可中断续跑、逐文件校验字节数。
// ============================================================
'use strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKEN = process.env.CNB_TOKEN || '';
const CNB_API = 'https://api.cnb.cool';
const CNB_HOST = 'cnb.cool';
const DEFAULT_CNB_REPO = 'FuFuCloud-mirror/FuFuMIDI';
// 正式版 tag（v4.4.0 这种）必须挂上 CNB 的 latest 锚点。
// 应用在「下载源 = 自动 / 国内」时是读 `/-/releases/latest/download/latest.yml` 的
// `version:` 字段来判断有没有新版本的（见 main/update.js 的 fetchCnbRelease）——
// 锚点没跟上的话，走国内源的用户永远收不到更新提示，且不会有任何报错。
// 注意：CNB 的 latest **不是**「自动取最高 semver」，而是 release 上的 is_latest 标记，
// 只能在建 release 时用 make_latest 指定（或事后 PATCH）。
const RELEASE_VERSION_TAG_RE = /^v\d+\.\d+\.\d+$/;
const TMP = path.join(os.tmpdir(), 'fufumidi-cnb-mirror');
fs.mkdirSync(TMP, { recursive: true });

const H_CNB = ['-H', `Authorization: Bearer ${TOKEN}`, '-H', 'Accept: application/vnd.cnb.api+json'];
const H_JSON = [...H_CNB, '-H', 'Content-Type: application/json'];

// GitHub 下载镜像链。注意：**这里的顺序只是兜底**，实际用哪条由启动时的实测速度决定。
// 实测（2026-09-19）：直连 17.8MB/s、jasonzeng 8.9MB/s、ghfast 1.4MB/s、gh-proxy 1.1MB/s、
// ghproxy.net 0.26MB/s —— 静态顺序很容易一直踩到慢源，所以改成 rankLines() 动态排序。
const GH_MIRRORS = [
  { id: 'jasonzeng', prefix: 'https://gh.jasonzeng.dev/' },
  { id: 'ghfast', prefix: 'https://ghfast.top/' },
  { id: 'gh-proxy', prefix: 'https://gh-proxy.com/' },
  { id: 'ghproxy-net', prefix: 'https://ghproxy.net/' },
];

function curl(args, opts = {}) {
  return execFileSync('curl.exe', ['-sS', '--ssl-no-revoke', ...args], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts,
  });
}
function curlJson(args) {
  const s = String(curl(args) || '').trim();
  try { return JSON.parse(s); } catch (e) { return { _raw: s.slice(0, 300), _parseError: String(e && e.message) }; }
}
function jsonBody(obj) {
  const p = path.join(TMP, 'body-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json');
  // 无 BOM 的 UTF-8，否则 CNB 会报 invalid character 'ï'
  fs.writeFileSync(p, JSON.stringify(obj), { encoding: 'utf8' });
  return p;
}
function cnbJson(method, url, body) {
  const f = body ? jsonBody(body) : null;
  try {
    return curlJson([...H_JSON, '-X', method, ...(f ? ['--data', '@' + f] : []), url]);
  } finally { if (f) { try { fs.unlinkSync(f); } catch (_) {} } }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const human = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + 'GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + 'MB' : (n / 1024).toFixed(0) + 'KB');

/** 探针：任意大文件都可以，用 Range 只拉 4MB 测速（带缓存，整轮只测一次） */
const PROBE_URL = 'https://github.com/qdTXTbp/FuFumidi/releases/download/v2.1.0/fufumidi-gpu-directml.zip';
let _rankCache = null;
async function rankLines() {
  if (_rankCache) return _rankCache;
  const list = [...GH_MIRRORS.map((m) => ({ id: m.id, url: m.prefix + PROBE_URL })), { id: 'direct', url: PROBE_URL }];
  const scored = await Promise.all(list.map(async (it) => {
    const t0 = Date.now();
    try {
      await curlAsync(['-L', '-f', '-s', '-m', '25', '--connect-timeout', '10', '-r', '0-4194303', '-o', 'NUL', it.url]);
    } catch (e) { return { id: it.id, mbps: 0 }; }
    return { id: it.id, mbps: 4 / Math.max(0.05, (Date.now() - t0) / 1000) };
  }));
  scored.sort((a, b) => b.mbps - a.mbps);
  console.log('    线路实测：' + scored.map((s) => `${s.id}=${s.mbps.toFixed(1)}MB/s`).join('  '));
  _rankCache = scored.map((s) => s.id);
  return _rankCache;
}

async function mirrorCandidates(url) {
  // 实测：gh 系列镜像**无法**代理 LFS media 域名（404/403/连接重置），只有直连可用
  if (/^https:\/\/media\.githubusercontent\.com\//i.test(url)) return [url];
  // github.com 的 release 资产 / raw 文件可套加速前缀：按实测速度排序，直连兜底
  if (/^https:\/\/(github\.com|raw\.githubusercontent\.com)\//i.test(url)) {
    const rank = await rankLines();
    const out = rank.map((id) => {
      const m = GH_MIRRORS.find((x) => x.id === id);
      return m ? m.prefix + url : url;
    });
    return [...new Set(out)];
  }
  return [url];
}

/** 异步 curl：必须用 spawn（execFileSync 会阻塞 Node 主线程，
 *  并发下载会退化成串行，且一个卡住的连接能把整个任务冻死）。 */
function curlAsync(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('curl.exe', ['-sS', '--ssl-no-revoke', ...args], { stdio: 'ignore', windowsHide: true });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error('curl exit ' + code))));
  });
}

/** 大文件分块 Range 下载。
 *  实测（2026-09-24 晚高峰）：镜像（ghfast）对「整文件长连接」会连上但 0 字节（18 分钟只过 0.2MB）；
 *  但对 4MB Range 请求稳定返回（5 个不同偏移 100% 成功，0.1~0.36MB/s）。
 *  所以大文件改成「4MB 分块 + 多连接并行 + 分块级重试」：把一条会僵死的长连接换成很多条短连接，
 *  每块严格校验字节数，再写到目标文件的对应偏移（写完必然连续，不用再拼接）。 */
const CHUNKED_MIN = 64 * 1024 * 1024;
const RANGE_CHUNK = 4 * 1024 * 1024;
const RANGE_WORKERS = 6;
async function downloadChunked(cands, dest, total) {
  const parts = Math.ceil(total / RANGE_CHUNK);
  const fd = fs.openSync(dest, 'w');
  let cursor = 0, done = 0, bytes = 0;
  try {
    const worker = async () => {
      for (;;) {
        const i = cursor++;
        if (i >= parts) return;
        const start = i * RANGE_CHUNK;
        const end = Math.min(start + RANGE_CHUNK, total) - 1;
        const want = end - start + 1;
        const tmp = `${dest}.p${i}`;
        let ok = false, lastErr = '';
        for (let a = 0; a < cands.length * 2 && !ok; a++) {
          try {
            try { fs.unlinkSync(tmp); } catch (_) {}
            await curlAsync(['-L', '-f', '-m', '300', '--connect-timeout', '15',
              '--speed-limit', '2048', '--speed-time', '30', '-r', `${start}-${end}`, '-o', tmp, cands[a % cands.length]]);
            const buf = fs.readFileSync(tmp);
            if (buf.length !== want) throw new Error(`分块字节数不符 ${buf.length}/${want}`);
            fs.writeSync(fd, buf, 0, buf.length, start);
            bytes += buf.length; ok = true;
          } catch (e) { lastErr = e.message; }
          finally { try { fs.unlinkSync(tmp); } catch (_) {} }
        }
        if (!ok) throw new Error(`分块 ${i}（${start}-${end}）失败：${lastErr}`);
        done++;
        if (done % 20 === 0 || done === parts) console.log(`      [分块] ${done}/${parts}（${human(bytes)}/${human(total)}）`);
      }
    };
    await Promise.all(Array.from({ length: Math.min(RANGE_WORKERS, parts) }, worker));
  } finally { fs.closeSync(fd); }
  const sz = fs.statSync(dest).size;
  if (sz !== total) throw new Error(`分块下载后大小不符 ${sz}/${total}`);
  return { size: sz, via: `分块×${parts}` };
}

/** 带镜像回退的下载，校验字节数（避免半截文件 / 错误页被当成资源）。
 *  停滞保护：30s 内平均速度低于 2KB/s 即判为坏源并换下一个（大文件坏源不会一直挂着）。 */
async function download(url, dest, expectedSize) {
  const cands = await mirrorCandidates(url);
  if (expectedSize > CHUNKED_MIN) return await downloadChunked(cands, dest, expectedSize);
  let lastErr = '';
  for (let i = 0; i < cands.length; i++) {
    const tag = i === cands.length - 1 ? '直连' : '镜像' + (i + 1);
    try {
      try { fs.unlinkSync(dest); } catch (_) {}
      console.log(`      [${tag}] 尝试下载...`);
      await curlAsync([
        '-L', '-f', '-m', '1800', '--retry', '2', '--retry-delay', '2',
        '--connect-timeout', '20', '--speed-limit', '2048', '--speed-time', '30',
        '-o', dest, cands[i],
      ]);
      const sz = fs.statSync(dest).size;
      if (expectedSize && sz !== expectedSize) { lastErr = `${tag} 大小不符 ${sz}/${expectedSize}`; continue; }
      return { size: sz, via: tag };
    } catch (e) { lastErr = `${tag} ${e.message}`; }
  }
  throw new Error('所有镜像下载失败: ' + lastErr);
}

// ---------------- release 模式 ----------------
async function ensureRelease(repo, tag, commitish) {
  const got = cnbJson('GET', `${CNB_API}/${repo}/-/releases/tags/${encodeURIComponent(tag)}`);
  if (got && got.id) {
    // 已存在：早期版本这里固定写 make_latest:false，正式版镜像完也不会挂上 latest 锚点。
    // 补一次 PATCH，让重跑镜像脚本能自愈（不必手工改 CNB 上的 release）。
    if (RELEASE_VERSION_TAG_RE.test(tag) && got.is_latest === false) {
      cnbJson('PATCH', `${CNB_API}/${repo}/-/releases/${got.id}`, { make_latest: 'true' });
      console.log('  已把 latest 锚点指向: ' + tag);
    }
    return { rel: got, created: false };
  }
  // 目标 tag 在 CNB 仓库里不存在时，必须给 target_commitish，CNB 才会据此建标签
  const created = cnbJson('POST', `${CNB_API}/${repo}/-/releases`, {
    tag_name: tag, name: tag, body: '镜像自 GitHub', prerelease: false,
    make_latest: RELEASE_VERSION_TAG_RE.test(tag) ? 'true' : 'false',
    target_commitish: commitish || 'main',
  });
  if (created && created.id) return { rel: created, created: true };
  throw new Error('创建 release 失败: ' + JSON.stringify(created).slice(0, 200));
}

async function uploadAsset(repo, releaseId, name, size, localFile) {
  let lastErr = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    // 每次重试都重新申请上传 URL：签名 URL 有时会失效，重新申请是最省事的自愈方式
    const info = cnbJson('POST', `${CNB_API}/${repo}/-/releases/${releaseId}/asset-upload-url`, { asset_name: name, size, overwrite: true });
    if (!info || !info.upload_url) throw new Error('获取上传URL失败: ' + JSON.stringify(info).slice(0, 200));
    try {
      const t0 = Date.now();
      // stdio 必须给 stderr 留管道：原来 'ignore' 吞掉了 curl 的真实报错，失败只剩一句
      // "Command failed: curl.exe ..."，完全看不出是超时、连接重置还是别的。
      // --speed-limit/--speed-time：上传卡住（0 字节/秒）60s 就判死，重新申请 URL 重传。
      curl(['-m', '3600', '--connect-timeout', '20', '--speed-limit', '1024', '--speed-time', '60',
        '-X', 'PUT', '--upload-file', localFile, info.upload_url], { stdio: ['ignore', 'pipe', 'pipe'] });
      if (info.verify_url) curl([...H_CNB, '-X', 'POST', info.verify_url]);
      console.log(`[上传 ${((Date.now() - t0) / 1000).toFixed(0)}s] `);
      return;
    } catch (e) {
      lastErr = String((e && e.stderr) || (e && e.message) || e).split('\n').filter(Boolean)[0] || '未知错误';
      console.log(`      [上传失败 第 ${attempt} 次] ${lastErr}`);
      if (attempt < 3) await sleep(attempt * 5000);
    }
  }
  throw new Error('上传失败（已重试 3 次）: ' + lastErr);
}

async function runRelease({ repo, tag, dstRepo, dstTag, match, commitish }) {
  const rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { 'user-agent': 'FuFumidi-mirror', accept: 'application/vnd.github+json' },
  })).json();
  if (!rel || !rel.assets) throw new Error('拉取 GitHub release 失败：' + JSON.stringify(rel).slice(0, 200));
  const re = match ? new RegExp(match) : null;
  const want = rel.assets.filter((a) => !re || re.test(a.name));
  console.log(`[release] ${repo}@${tag} → CNB ${dstRepo}@${dstTag}`);
  console.log(`  目标资产 ${want.length} 个 | 合计 ${human(want.reduce((s, a) => s + a.size, 0))}`);
  if (!want.length) return;

  const { rel: cnbRel, created } = await ensureRelease(dstRepo, dstTag, commitish);
  if (created) console.log('  新建 CNB release: ' + dstTag);
  const existing = new Set((cnbRel.assets || []).map((a) => a.name));

  let ok = 0, skip = 0, fail = 0;
  for (const a of want) {
    if (existing.has(a.name)) { console.log(`  - 已存在，跳过: ${a.name}`); skip++; continue; }
    const local = path.join(TMP, `${repo.replace(/\//g, '_')}__${dstTag}__${a.name}`);
    try {
      process.stdout.write(`  ↓ ${a.name} (${human(a.size)}) 下载中... `);
      const dl = await download(a.browser_download_url, local, a.size);
      process.stdout.write(`[${dl.via}] 上传中... `);
      await uploadAsset(dstRepo, cnbRel.id, a.name, dl.size, local);
      console.log('完成');
      ok++;
    } catch (e) {
      console.log('失败: ' + e.message);
      fail++;
    } finally { try { fs.unlinkSync(local); } catch (_) {} }
    await sleep(200);
  }
  // 「完成：」前缀是保活守护判定任务结束的标志；有失败时必须换成「未完成：」，
  // 否则守护会误判为已完工而停止重启，失败资产就永远不会被重试。
  const summary = `成功 ${ok} / 跳过 ${skip} / 失败 ${fail}`;
  if (fail) {
    console.log(`  未完成：${repo}@${tag} → ${dstRepo}@${dstTag}（${summary}）`);
    process.exitCode = 1;
  } else {
    console.log(`  完成：${repo}@${tag} → ${dstRepo}@${dstTag}（${summary}）`);
  }
}

// ---------------- tree 模式 ----------------
// 用 git 把源仓库整树推到 CNB 仓库；CNB 的 /-/git/raw/<ref>/<path> 即可匿名直读。
// 大仓库（如 37GB 的模型仓库）的推送策略：
//   按体积切成 ~512MB 的块，每块以「远端当前提交」为父提交、只叠加本块缺的文件后 force-push。
//   这样每块只传自己新增的对象，且重启后会从远端现状续推（已推数据绝不重传）。
//   切勿改成无父提交的根提交 —— 那样每块都会让 git 把整棵树当全新对象重算，慢到不可用。
function gitIn(work, args, opts = {}) {
  // core.quotepath=false：否则中文路径会被输出成带引号的八进制转义，拼 URL 就错了
  return execFileSync('git', ['-c', 'core.quotepath=false', '-C', work, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

/** 确保 CNB 仓库存在（必须公开 —— CNB 的 raw 端点禁止秘密仓库） */
function ensureRepo(dstRepo, description) {
  const [org, name] = dstRepo.split('/');
  const probe = cnbJson('GET', `${CNB_API}/${dstRepo}/-/settings/push-limit`);
  if (probe && probe.errcode) {
    const created = cnbJson('POST', `${CNB_API}/${org}/-/repos`, { name, visibility: 'public', description: description || '镜像自 GitHub' });
    console.log(`  创建 CNB 仓库 ${dstRepo}: ${JSON.stringify(created).slice(0, 120)}`);
  } else {
    console.log('  CNB 仓库已存在: ' + dstRepo);
  }
}

/** 逐文件构建一个「合成提交」：不 clone（直连 GitHub 拉大仓库会卡死在 0 字节），
 *  改为按文件清单逐个下载 → hash-object -w 入库 → 组装出等价整树，作为后续分批推送的源。
 *  好处：单文件失败可重试/续跑，不会被一个 38GB 的 pack 流拖死。 */
async function prepareSyntheticSource({ work, repo, branch, concurrency = 8, localRoot }) {
  fs.mkdirSync(work, { recursive: true });
  if (!fs.existsSync(path.join(work, 'HEAD'))) gitIn(work, ['init', '--bare', '-b', branch]);

  const api = `https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`;
  const tree = await (await fetch(api, { headers: { 'user-agent': 'FuFumidi-mirror', accept: 'application/vnd.github+json' } })).json();
  if (!tree || !Array.isArray(tree.tree)) throw new Error('拉文件清单失败：' + JSON.stringify(tree).slice(0, 200));
  const blobs = tree.tree.filter((x) => x.type === 'blob');
  console.log(`  文件清单：${blobs.length} 个 | 合计 ${human(blobs.reduce((s, x) => s + (x.size || 0), 0))}`);
  console.log('  （GitHub API 报的体积对 LFS 文件是指针大小，真身另算）');
  if (localRoot) console.log(`  本地直传目录：${localRoot}（命中且 blob 校验一致就不下载）`);

  // 临时索引不删：保留下来即可「续跑」——已入库且大小一致的文件直接跳过，不再重下
  const idx = path.join(TMP, 'build-' + path.basename(work) + '.index');
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  if (fs.existsSync(idx)) console.log('  检测到上次的索引，续跑（已入库文件会跳过）');
  else gitIn(work, ['read-tree', '--empty'], { env });

  const lfsUrl = (p) => `https://media.githubusercontent.com/media/${repo}/${branch}/${p}`;
  const rawUrl = (p) => `https://raw.githubusercontent.com/${repo}/${branch}/${encodeURIComponent(p).replace(/%2F/gi, '/')}`;

  // 已入库判定：索引里有该路径且 blob 大小与远端一致
  // 注意必须带上 env（GIT_INDEX_FILE），否则读到的是裸库默认索引 → 续跑永远失效
  const inIndex = (p) => {
    try {
      const line = gitIn(work, ['ls-files', '-s', '--', p], { stdio: ['ignore', 'pipe', 'ignore'], env }).trim();
      if (!line) return false;
      const sha = line.split(/\s+/)[1];
      const size = parseInt(gitIn(work, ['cat-file', '-s', sha], { stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 10);
      return size;
    } catch (e) { return 0; }
  };

  // LFS 文件的仓库里只有 ~130 字节的指针，本地却是真身，blob sha 天然对不上；
  // 这种情况用「指针里的 oid sha256」校验本地真身。
  // 注意不能只按体积判断是不是指针（README / .gitattributes 也很小）——必须看 blob 内容。
  const pointerOidCache = new Map();
  async function pointerOid(sha) {
    if (pointerOidCache.has(sha)) return pointerOidCache.get(sha);
    let oid = '';
    try {
      const r = await fetch(`https://api.github.com/repos/${repo}/git/blobs/${sha}`, { headers: { 'user-agent': 'FuFumidi-mirror', accept: 'application/vnd.github+json' } });
      if (r.ok) {
        const d = await r.json();
        const txt = Buffer.from(d.content || '', 'base64').toString('utf8');
        const m = txt.match(/oid sha256:([0-9a-f]{64})/i);
        oid = m ? m[1].toLowerCase() : '';
      }
    } catch (e) { /* 取不到就退回下载 */ }
    pointerOidCache.set(sha, oid);
    return oid;
  }
  /** 该条目是否 LFS 指针（按 blob 内容判定；只有小文件才去查，省请求） */
  async function lfsOidOf(it) {
    if (!((it.size || 0) > 0 && (it.size || 0) < 300)) return '';
    return pointerOid(it.sha);
  }
  const sha256File = (p) => new Promise((res, rej) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => res(h.digest('hex')));
    s.on('error', rej);
  });

  let done = 0, bytes = 0, failed = 0, skipped = 0, localUsed = 0;
  const cursor = { i: 0 };
  const worker = async () => {
    for (;;) {
      const n = cursor.i++;
      if (n >= blobs.length) return;
      const it = blobs[n];
      const local = path.join(TMP, 'dl-' + path.basename(it.path));
      try {
        // 续跑：上次已完整入库的直接跳过
        const have = inIndex(it.path);
        if (have && have === (it.size || 0)) { skipped++; }
        else {
          // ① 本地已有同路径文件 → 校验后直接入库（零下载）
          let indexed = false;
          const lfsOid = await lfsOidOf(it);
          if (localRoot) {
            const lp = path.join(localRoot, ...it.path.split('/'));
            try {
              const lsize = fs.existsSync(lp) ? fs.statSync(lp).size : -1;
              if (lfsOid) {
                // LFS：本地是真身，用指针里的 oid sha256 校验
                if (lsize > 300) {
                  if ((await sha256File(lp)) === lfsOid) {
                    const sha = gitIn(work, ['hash-object', '-w', '--no-filters', lp]).trim();
                    gitIn(work, ['update-index', '--add', '--cacheinfo', `100644,${sha},${it.path}`], { env });
                    localUsed++; indexed = true;
                  } else {
                    console.log(`    [本地 LFS 真身与指针不一致，改为下载] ${it.path}`);
                  }
                }
              } else if (lsize === (it.size || 0)) {
                const sha = gitIn(work, ['hash-object', '-w', '--no-filters', lp]).trim();
                if (sha === it.sha) {
                  gitIn(work, ['update-index', '--add', '--cacheinfo', `100644,${sha},${it.path}`], { env });
                  localUsed++; indexed = true;
                } else {
                  console.log(`    [本地文件与远端不一致，改为下载] ${it.path}`);
                }
              }
            } catch (e) { /* 本地不可用 → 走下载 */ }
          }
          if (!indexed) {
            // ② 下载：LFS 指针走 media 真身，其余走 raw（raw 需经镜像前缀，直连不可用）
            const dl = lfsOid
              ? await download(lfsUrl(it.path), local, 0)
              : await download(rawUrl(it.path), local, it.size || 0);
            if (lfsOid && (await sha256File(local)) !== lfsOid) throw new Error('LFS 真身 sha256 校验失败');
            const sha = gitIn(work, ['hash-object', '-w', '--no-filters', local]).trim();
            gitIn(work, ['update-index', '--add', '--cacheinfo', `100644,${sha},${it.path}`], { env });
            bytes += dl.size;
          }
        }
        done++;
        if (done % 20 === 0 || done === blobs.length) {
          console.log(`    ${done}/${blobs.length} 个文件（本次下载 ${human(bytes)}，本地命中 ${localUsed}，续跑跳过 ${skipped}）`);
        }
      } catch (e) {
        failed++;
        console.log(`    [失败] ${it.path}: ${e.message}`);
      } finally { try { fs.unlinkSync(local); } catch (_) {} }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));

  const treeSha = gitIn(work, ['write-tree'], { env }).trim();
  const env2 = { ...env, GIT_AUTHOR_NAME: 'FuFumidi Mirror', GIT_AUTHOR_EMAIL: 'mirror@fufumidi.local', GIT_COMMITTER_NAME: 'FuFumidi Mirror', GIT_COMMITTER_EMAIL: 'mirror@fufumidi.local' };
  const commit = gitIn(work, ['commit-tree', treeSha, '-m', `mirror: ${repo}@${branch}`], { env: env2 }).trim();
  gitIn(work, ['update-ref', `refs/heads/${branch}`, commit]);
  console.log(`  合成提交 ${commit.slice(0, 12)}：成功 ${done} / 失败 ${failed}（本地直传 ${localUsed}，续跑跳过 ${skipped}）`);
  if (failed) process.exitCode = 1;
  return commit;
}

async function runTree({ repo, dstRepo, ref, only, gitUrl, fetch, localRoot, concurrency }) {
  if (!dstRepo) throw new Error('tree 模式需要 --dst-repo');
  ensureRepo(dstRepo, `镜像自 GitHub ${repo}`);

  // 2) 取得源提交：两种方式
  //    --fetch：逐文件下载（推荐，大仓库不会被单个 pack 流拖死）
  //    默认  ：git clone --mirror（小仓库更快；直连拉大仓库会卡死，可用 --git-url 走代理）
  const branch = ref || 'main';
  const work = path.join(TMP, dstRepo.replace(/\//g, '_') + '.git');
  let src;
  if (fetch) {
    console.log('  逐文件拉取模式（不 clone）...');
    src = await prepareSyntheticSource({ work, repo, branch, concurrency: concurrency ? parseInt(concurrency, 10) : 8, localRoot });
  } else {
    const cloneUrl = gitUrl || `https://github.com/${repo}.git`;
    if (!fs.existsSync(work)) {
      console.log(`  clone --mirror ${cloneUrl}（大仓库耗时较长）...`);
      execFileSync('git', ['clone', '--mirror', cloneUrl, work], { stdio: 'inherit' });
    } else {
      console.log('  复用本地裸库: ' + work);
      gitIn(work, ['fetch', '--prune', 'origin', '+refs/*:refs/*'], { stdio: 'inherit' });
    }
    src = gitIn(work, ['rev-parse', `refs/heads/${branch}`]).trim();
    console.log(`  源 ref ${branch} = ${src.slice(0, 12)}`);
  }

  // 2.5) Git LFS（仅 clone 路径需要）：裸库只拿到指针文件，且 git-lfs 拉真身在这条网络下会卡死，
  //      所以自己按 media 域名下载真身，再用 hash-object -w 写进对象库替换指针。
  //      逐文件模式已经在下载时直接取真身，无需这一步。
  const lfsBlobs = {};   // 仓库内路径 → 真身 blob sha
  if (!fetch) {
    const allBlobs = gitIn(work, ['ls-tree', '-r', src]).split('\n').filter(Boolean);
    for (const line of allBlobs) {
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const meta = line.slice(0, tab).split(/\s+/);
      const p = line.slice(tab + 1);
      if (meta[0] !== '100644') continue;
      let size = 0;
      try { size = parseInt(gitIn(work, ['cat-file', '-s', meta[2]]).trim(), 10) || 0; } catch (e) { continue; }
      if (size > 300) continue;   // LFS 指针只有 ~130 字节
      let ptr = '';
      try { ptr = gitIn(work, ['cat-file', 'blob', meta[2]]); } catch (e) { continue; }
      if (!ptr.startsWith('version https://git-lfs.github.com/spec/v1')) continue;
      const sm = ptr.match(/^size\s+(\d+)\s*$/m);
      const expect = sm ? parseInt(sm[1], 10) : 0;   // 指针里写着真身体积，用它校验，防止半截/错误页
      const url = `https://media.githubusercontent.com/media/${repo}/${branch}/${p}`;
      const local = path.join(TMP, 'lfs-' + meta[2].slice(0, 8) + '-' + path.basename(p));
      try {
        process.stdout.write(`  LFS 真身 ${p} (${human(expect)}) 下载中... `);
        const dl = await download(url, local, expect);
        // --no-filters：按原始字节入库，避免 autocrlf / 属性过滤把二进制改坏
        const newSha = gitIn(work, ['hash-object', '-w', '--no-filters', local]).trim();
        lfsBlobs[p] = newSha;
        console.log(`完成 (${human(dl.size)} via ${dl.via})`);
      } catch (e) {
        console.log('失败: ' + e.message);
        process.exitCode = 1;
      } finally { try { fs.unlinkSync(local); } catch (_) {} }
    }
  }

  const auth = `https://cnb:${TOKEN}@${CNB_HOST}/${dstRepo}.git`;
  // 推送阶段必须用**独立**索引：暂存索引（build-*.index）是逐文件下载的续跑依据，
  // 若被这里 read-tree 远端基底覆盖，下次续跑会误判「文件没下过」而重新下载全部文件。
  const idx = path.join(TMP, dstRepo.replace(/\//g, '_') + '.push.index');
  // commit-tree 需要作者/提交者身份；不依赖用户全局 git 配置
  const env = {
    ...process.env,
    GIT_INDEX_FILE: idx,
    GIT_AUTHOR_NAME: 'FuFumidi Mirror', GIT_AUTHOR_EMAIL: 'mirror@fufumidi.local',
    GIT_COMMITTER_NAME: 'FuFumidi Mirror', GIT_COMMITTER_EMAIL: 'mirror@fufumidi.local',
  };

  // 4) 全量文件清单（path → {mode, sha, size}）：一次 ls-tree -r -l 拿齐，避免逐条起进程
  const allFiles = new Map();
  const rlOut = gitIn(work, ['ls-tree', '-r', '-l', src], { maxBuffer: 256 * 1024 * 1024 });
  for (const line of rlOut.split('\n')) {
    if (!line) continue;
    const tab = line.indexOf('\t');
    if (tab < 0) continue;
    const meta = line.slice(0, tab).split(/\s+/);      // [mode, type, sha, size]
    if (meta[1] !== 'blob') continue;
    const p = line.slice(tab + 1);
    allFiles.set(p, { mode: meta[0], sha: meta[2], size: parseInt(meta[3], 10) || 0 });
  }
  // LFS 指针换成真身 blob（体积按真身计）
  for (const [p, sha] of Object.entries(lfsBlobs)) {
    const cur = allFiles.get(p);
    if (cur) allFiles.set(p, { ...cur, sha, size: parseInt(gitIn(work, ['cat-file', '-s', sha]).trim(), 10) || cur.size });
  }
  console.log(`  文件清单：${allFiles.size} 个`);

  // 5.5) 体积红线提醒：CNB 的 git raw 读取上限是 100 MiB（推得进仓库，但 /-/git/raw/ 会返回
  //      errcode 2000033「raw file size xxx MiB exceeded 100 MiB」，即推上去了却读不出来）。
  //      超过 100 MiB 的文件必须另外作为 Release 资产镜像，否则应用走「国内源」时会 413。
  //      （注意别和 git 推送上限 256 MiB 混淆 —— 那是另一个更宽松的限制。）
  const RAW_LIMIT = 100 * 1024 * 1024;
  const overRaw = [...allFiles.entries()].filter(([, f]) => f.size > RAW_LIMIT).sort((a, b) => b[1].size - a[1].size);
  console.log(`  ≤100MiB 走 git raw 可直读：${allFiles.size - overRaw.length} 个`);
  if (overRaw.length) {
    console.log(`  ⚠ 超过 100MiB 的 ${overRaw.length} 个文件在 raw 端点会 413，需另作 Release 资产镜像：`);
    for (const [p, f] of overRaw) console.log(`      ${(f.size / 1048576).toFixed(1)}MB  ${p}`);
  }

  // 5) 分块：按累计体积切成 ~CHUNK_MB 的块，保证单次 push 不会大到超时
  const CHUNK_BYTES = (Number(process.env.MIRROR_CHUNK_MB) || 512) * 1024 * 1024;
  const paths = [...allFiles.keys()].sort();
  const chunks = [];
  let cur = { paths: [], bytes: 0, label: '' };
  for (const p of paths) {
    const sz = allFiles.get(p).size;
    if (cur.paths.length && cur.bytes + sz > CHUNK_BYTES) { chunks.push(cur); cur = { paths: [], bytes: 0, label: '' }; }
    if (!cur.paths.length) cur.label = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '(顶层文件)';
    cur.paths.push(p); cur.bytes += sz;
  }
  if (cur.paths.length) chunks.push(cur);
  const chosen = only ? chunks.filter((c) => c.label.startsWith(only)) : chunks;
  console.log(`  推送分块：${chosen.length} 个（每块约 ${human(CHUNK_BYTES)}）`);

  // 6) 取远端当前提交作为基底：每块都以远端当前状态为起点 + 作为新提交的父提交。
  //    这样每块只传输自己新增的对象，且天然可续跑（重启后从远端现状继续，不会重传已推数据）。
  //    注意：绝不能再用「无父提交的根提交」——那样每块都会让 git 把整棵树当成全新对象重算。
  let base = '';
  try {
    gitIn(work, ['fetch', auth, `+refs/heads/${branch}:refs/remotes/cnb/${branch}`], { stdio: 'ignore' });
    base = gitIn(work, ['rev-parse', `refs/remotes/cnb/${branch}`]).trim();
    const remoteCount = gitIn(work, ['ls-tree', '-r', '--name-only', base]).split('\n').filter(Boolean).length;
    console.log(`  远端基底 ${base.slice(0, 12)}（已有 ${remoteCount} 个文件），从现状续推`);
    try { gitIn(work, ['read-tree', base], { env }); } catch (e) { /* 索引稍后按块重建 */ }
  } catch (e) {
    console.log('  远端暂无可续跑分支，从空开始');
  }

  // 远端已有哪些路径（path → blob sha），用于跳过已推完的文件
  const remoteFiles = new Map();
  if (base) {
    for (const line of gitIn(work, ['ls-tree', '-r', base], { maxBuffer: 256 * 1024 * 1024 }).split('\n')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      if (tab < 0) continue;
      const meta = line.slice(0, tab).split(/\s+/);
      if (meta[1] !== 'blob') continue;
      remoteFiles.set(line.slice(tab + 1), meta[2]);
    }
  }

  let pushedChunks = 0, skippedChunks = 0, failedChunks = [];
  for (let ci = 0; ci < chosen.length; ci++) {
    const c = chosen[ci];
    const missing = c.paths.filter((p) => remoteFiles.get(p) !== allFiles.get(p).sha);
    if (!missing.length) { skippedChunks++; continue; }

    const t0 = Date.now();
    const tag = `${c.label}（${missing.length}/${c.paths.length} 个文件，${human(missing.reduce((s, p) => s + allFiles.get(p).size, 0))}）`;
    let ok = false, lastErr = '';
    for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
      try {
        // 每块都从「远端当前基底」重建索引：只把本块缺的文件叠上去
        gitIn(work, ['read-tree', ...(base ? [base] : ['--empty'])], { env });
        for (const p of missing) {
          const f = allFiles.get(p);
          gitIn(work, ['update-index', '--add', '--cacheinfo', `${f.mode},${f.sha},${p}`], { env });
        }
        const tree = gitIn(work, ['write-tree'], { env }).trim();
        const commit = gitIn(work, ['commit-tree', tree, ...(base ? ['-p', base] : []), '-m', `mirror: ${repo} → ${dstRepo} (${c.label})`]).trim();
        console.log(`  [${new Date().toTimeString().slice(0, 8)}] push ${ci + 1}/${chosen.length} ${tag} 第 ${attempt} 次...`);
        // --progress：stderr 被重定向到文件时 git 默认静默，加它才能在日志里看到实际传输量与速率
        // pack.window=0 / pack.compression=0：模型权重是已压缩的二进制，delta 搜索与 zlib 全是白烧 CPU。
        //   实测（2026-09-24）：单块 500MB 的「Writing objects」只占 ~122s（1.8~2.5MiB/s 是链路上限），
        //   但整块耗时 378.6s —— 多出来的 ~250s 就花在这两步上，关掉即可。
        gitIn(work, ['-c', 'pack.window=0', '-c', 'pack.compression=0', 'push', '--progress', '--force', auth, `${commit}:refs/heads/${branch}`], { stdio: 'inherit' });
        base = commit;
        for (const p of missing) remoteFiles.set(p, allFiles.get(p).sha);
        ok = true; pushedChunks++;
        console.log(`  [${new Date().toTimeString().slice(0, 8)}] 完成块 ${c.label}，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        lastErr = String(e && e.message || e).split('\n')[0];
        console.log(`    失败（第 ${attempt} 次）：${lastErr}`);
        if (attempt < 4) await sleep(attempt * 5000);
      }
    }
    if (!ok) {
      // 不中断整轮：其余块照常推（它们的索引会从最后一个成功的 base 重建），这块留待下轮补
      console.log(`  [放弃本轮] ${c.label}：${lastErr}`);
      failedChunks.push(c.label);
    }
  }
  // 「完成：」前缀是保活守护判定任务结束的标志，所以只有全部块成功时才输出它；
  // 有失败块时改用「未完成：」，否则守护会误判为已完工而停止重启。
  if (failedChunks.length) {
    console.log(`  未完成：${repo} → ${dstRepo}@${branch}（推送 ${pushedChunks} 块，跳过 ${skippedChunks} 块，失败 ${failedChunks.length} 块待下轮补）`);
    process.exitCode = 1;
  } else {
    console.log(`  完成：${repo} → ${dstRepo}@${branch}（推送 ${pushedChunks} 块，跳过 ${skippedChunks} 块）`);
  }
}

// ---------------- files 模式 ----------------
// 把 GitHub 仓库某个目录下的文件（含 Git LFS 视频）镜像成 CNB Release 资产，
// 并额外上传一份 `wallpapers.json` 清单，供应用在「下载源 = 自动 / 国内」时直接列目录
// （CNB 的 contents / raw 接口需要鉴权，匿名列目录只能靠这份清单）。
async function runFiles({ repo, ref, dir, dstRepo, dstTag, commitish, manifestName }) {
  const branch = ref || 'main';
  const api = `https://api.github.com/repos/${repo}/contents/${dir}?ref=${branch}`;
  const items = await (await fetch(api, { headers: { 'user-agent': 'FuFumidi-mirror', accept: 'application/vnd.github+json' } })).json();
  if (!Array.isArray(items)) throw new Error('列目录失败：' + JSON.stringify(items).slice(0, 200));

  const isVideo = (n) => /\.(mp4|webm|mov)$/i.test(n);
  const isImage = (n) => /\.(jpg|jpeg|png)$/i.test(n);
  const wanted = items.filter((x) => x.type === 'file' && (isVideo(x.name) || isImage(x.name)));
  console.log(`[files] ${repo}@${branch}/${dir} → CNB ${dstRepo}@${dstTag}`);
  console.log(`  文件 ${wanted.length} 个（视频 ${wanted.filter((x) => isVideo(x.name)).length} / 图片 ${wanted.filter((x) => isImage(x.name)).length}）`);
  if (!wanted.length) return;

  const { rel: cnbRel, created } = await ensureRelease(dstRepo, dstTag, commitish);
  if (created) console.log('  新建 CNB release: ' + dstTag);
  const existing = new Set((cnbRel.assets || []).map((a) => a.name));

  const manifest = { videos: [], thumbs: [] };
  for (const it of wanted) {
    // LFS 文件的 contents API 只给指针大小，真身必须走 media 域名
    const srcUrl = isVideo(it.name)
      ? `https://media.githubusercontent.com/media/${repo}/${branch}/${dir}/${encodeURIComponent(it.name)}`
      : `https://raw.githubusercontent.com/${repo}/${branch}/${dir}/${encodeURIComponent(it.name)}`;
    let realSize = it.size || 0;
    try {
      const hr = await fetch(srcUrl, { method: 'HEAD', headers: { 'user-agent': 'FuFumidi-mirror' } });
      const cl = parseInt(hr.headers.get('content-length') || '0', 10);
      if (cl > 0) realSize = cl;
    } catch (e) { /* 探测失败就退回 API 给的 size */ }

    const entry = { name: it.name, asset: it.name, size: realSize };
    (isVideo(it.name) ? manifest.videos : manifest.thumbs).push(entry);
    if (existing.has(it.name)) { console.log(`  - 已存在，跳过: ${it.name}`); continue; }

    const local = path.join(TMP, `${repo.replace(/\//g, '_')}__${dstTag}__${it.name}`);
    try {
      process.stdout.write(`  ↓ ${it.name} (${human(realSize)}) 下载中... `);
      const dl = await download(srcUrl, local, realSize || 0);
      process.stdout.write(`[${dl.via}] 上传中... `);
      await uploadAsset(dstRepo, cnbRel.id, it.name, dl.size, local);
      console.log('完成');
    } catch (e) {
      console.log('失败: ' + e.message);
      process.exitCode = 1;
    } finally { try { fs.unlinkSync(local); } catch (_) {} }
    await sleep(200);
  }

  // 清单：无论文件是否已存在都要重传一份最新的（应用靠它列目录）
  const mName = manifestName || 'wallpapers.json';
  const mFile = path.join(TMP, `${dstTag}__${mName}`);
  fs.writeFileSync(mFile, JSON.stringify(manifest, null, 2), 'utf8');
  const mSize = fs.statSync(mFile).size;
  process.stdout.write(`  ↑ 清单 ${mName} (${human(mSize)})... `);
  await uploadAsset(dstRepo, cnbRel.id, mName, mSize, mFile);
  console.log('完成');
  try { fs.unlinkSync(mFile); } catch (_) {}
}

// ---------------- assets 模式 ----------------
// 把 GitHub 的 Release 资产（音色库 SF2 / GPU 增强包这类「只在 Release 上、仓库树里没有」的文件）
// 提交进一个 CNB 仓库，供 /-/git/raw/<ref>/<path> 匿名直读。
// 远端已有分支内容会保留（在现有提交之上追加），可反复跑。
async function runAssets({ repo, tag, match, dstRepo, branch, subdir }) {
  if (!dstRepo) throw new Error('assets 模式需要 --dst-repo');
  const br = branch || 'main';
  ensureRepo(dstRepo, `镜像自 GitHub ${repo} 的 Release 资产`);

  const rel = await (await fetch(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    headers: { 'user-agent': 'FuFumidi-mirror', accept: 'application/vnd.github+json' },
  })).json();
  if (!rel || !rel.assets) throw new Error('拉取 GitHub release 失败：' + JSON.stringify(rel).slice(0, 200));
  const re = match ? new RegExp(match) : null;
  const want = rel.assets.filter((a) => !re || re.test(a.name));
  console.log(`[assets] ${repo}@${tag} → CNB ${dstRepo}@${br}${subdir ? '/' + subdir : ''}`);
  console.log(`  目标资产 ${want.length} 个 | 合计 ${human(want.reduce((s, a) => s + a.size, 0))}`);
  if (!want.length) return;

  const work = path.join(TMP, dstRepo.replace(/\//g, '_') + '.assets.git');
  fs.mkdirSync(work, { recursive: true });
  if (!fs.existsSync(path.join(work, 'HEAD'))) gitIn(work, ['init', '--bare', '-b', br]);
  const auth = `https://cnb:${TOKEN}@${CNB_HOST}/${dstRepo}.git`;

  let parent = '';
  try {
    // 必须 fetch 到 refs/remotes/... ：fetch 不允许直接更新本地已检出的分支
    // （refs/heads/<br> 就是 HEAD 指向的分支），否则会失败 → parent 为空 → 把远端已有内容冲掉
    gitIn(work, ['fetch', auth, `+refs/heads/${br}:refs/remotes/cnb/${br}`], { stdio: 'ignore' });
    parent = gitIn(work, ['rev-parse', `refs/remotes/cnb/${br}`]).trim();
    console.log(`  沿用已有提交 ${parent.slice(0, 12)}`);
  } catch (e) {
    console.log('  远端暂无该分支，从空开始');
  }

  const idx = path.join(TMP, 'assets-' + path.basename(work) + '.index');
  try { fs.unlinkSync(idx); } catch (_) {}
  const env = {
    ...process.env, GIT_INDEX_FILE: idx,
    GIT_AUTHOR_NAME: 'FuFumidi Mirror', GIT_AUTHOR_EMAIL: 'mirror@fufumidi.local',
    GIT_COMMITTER_NAME: 'FuFumidi Mirror', GIT_COMMITTER_EMAIL: 'mirror@fufumidi.local',
  };
  if (parent) gitIn(work, ['read-tree', parent], { env });
  else gitIn(work, ['read-tree', '--empty'], { env });

  let ok = 0, fail = 0, skip = 0;
  for (const a of want) {
    const p = (subdir ? subdir.replace(/\/+$/, '') + '/' : '') + a.name;
    const local = path.join(TMP, 'as-' + a.name);
    try {
      // 已在远端同尺寸 → 跳过（重跑不必重下 1GB 级文件）
      if (parent) {
        try {
          const oldSize = parseInt(gitIn(work, ['cat-file', '-s', `${parent}:${p}`], { stdio: ['ignore', 'pipe', 'ignore'] }).trim(), 10);
          if (oldSize === a.size) { console.log(`  - 已存在，跳过: ${a.name}`); skip++; continue; }
        } catch (e) { /* 路径不存在 → 照常下载 */ }
      }
      process.stdout.write(`  ↓ ${a.name} (${human(a.size)}) 下载中... `);
      const dl = await download(a.browser_download_url, local, a.size);
      process.stdout.write(`[${dl.via}] 入库中... `);
      const sha = gitIn(work, ['hash-object', '-w', '--no-filters', local]).trim();
      gitIn(work, ['update-index', '--add', '--cacheinfo', `100644,${sha},${p}`], { env });
      console.log('完成');
      ok++;
    } catch (e) { console.log('失败: ' + e.message); fail++; }
    finally { try { fs.unlinkSync(local); } catch (_) {} }
  }
  if (!ok && !skip) { console.log('  无可推送内容'); if (fail) process.exitCode = 1; return; }

  const tree = gitIn(work, ['write-tree'], { env }).trim();
  const commit = gitIn(work, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', `assets: ${repo}@${tag}`]).trim();
  gitIn(work, ['update-ref', `refs/heads/${br}`, commit]);
  console.log('  push ...');
  gitIn(work, ['push', '--force', auth, `${commit}:refs/heads/${br}`], { stdio: 'inherit' });
  console.log(`  完成：成功 ${ok} / 跳过 ${skip} / 失败 ${fail}`);
  if (fail) process.exitCode = 1;
}

// ---------------- CLI ----------------
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true;
    else out._.push(a);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const mode = args._[0];
if (!TOKEN) { console.error('缺少 CNB_TOKEN 环境变量（令牌不要写进脚本）'); process.exit(1); }
if (mode === 'release') {
  runRelease({
    repo: args.repo, tag: args.tag,
    dstRepo: args['dst-repo'] || DEFAULT_CNB_REPO, dstTag: args['dst-tag'] || args.tag,
    match: args.match, commitish: args.commitish,
  }).catch((e) => { console.error('异常:', e.message); process.exit(1); });
} else if (mode === 'tree') {
  runTree({ repo: args.repo, dstRepo: args['dst-repo'], ref: args.ref, only: args.only, gitUrl: args['git-url'], fetch: !!args.fetch, localRoot: args.local, concurrency: args.concurrency ? parseInt(args.concurrency, 10) : undefined }).catch((e) => { console.error('异常:', e.message); process.exit(1); });
} else if (mode === 'files') {
  runFiles({
    repo: args.repo, ref: args.ref, dir: args.dir,
    dstRepo: args['dst-repo'] || DEFAULT_CNB_REPO, dstTag: args['dst-tag'],
    commitish: args.commitish, manifestName: args['manifest-name'],
  }).catch((e) => { console.error('异常:', e.message); process.exit(1); });
} else if (mode === 'assets') {
  runAssets({
    repo: args.repo, tag: args.tag, match: args.match,
    dstRepo: args['dst-repo'], branch: args.branch, subdir: args.subdir,
  }).catch((e) => { console.error('异常:', e.message); process.exit(1); });
} else {
  console.error('用法:');
  console.error('  release  --repo <gh> --tag <tag> [--dst-repo <cnb>] [--dst-tag <tag>] [--match <regex>] [--commitish <ref>]');
  console.error('  tree     --repo <gh> --dst-repo <cnb> [--ref main] [--fetch] [--local <本地目录>] [--concurrency 8] [--git-url <url>] [--only <顶层目录>]');
  console.error('  files    --repo <gh> --dir <目录> --dst-tag <tag> [--ref main] [--dst-repo <cnb>]');
  console.error('  assets   --repo <gh> --tag <tag> --dst-repo <cnb> [--match <regex>] [--branch main] [--subdir <dir>]');
  process.exit(1);
}
