// ============================================================
// 插件安装服务：从插件平台下载 → 展示清单 → 用户确认 → 安全解压安装
// ============================================================
//
// 设计取舍（为什么是「两段式」而不是「一键装完」）：
//   平台目前没有发布签名，安装环节等于在给第三方 zip 开后门。
//   所以这里刻意拆成 download（只落缓存，不解压）与 install（用户确认后才落地），
//   中间插一个 inspect 让用户看清「这个包里到底有什么、要装到哪」。
//   将来平台加了签名，只需在 install 里加一道验签，不必改调用方。
//
// 安全约束：
//   - 解压复用 zip-safe.js 的 safeExtractAllTo（zip-slip / 解压炸弹 / 重名条目防御）
//   - 上限比通用解压严得多：插件不该有 thousands 条目或 GB 体积
//   - 只允许写用户插件目录，且目标插件 id 必须与包内 plugin.json 一致
//   - 已安装同 id 插件视为「升级」，需显式 overwrite，且旧版本先备份
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { safeExtractAllTo } = require('./zip-safe');
const Paths = require('./paths');

/** 插件包体积上限：与平台端 MAX_UPLOAD_BYTES 对齐（20 MB） */
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
/** 解压后总大小上限：给 zip 压缩率留余量，但仍然远小于通用的 8 GiB */
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;
/** 条目数上限 */
const MAX_ENTRIES = 2000;

const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/i;

/** 缓存中的待安装包：token → 元信息。token 由随机 hex 组成，用完即删 */
const pending = new Map();

function cacheDir() {
  // Paths.ensure 是内部函数没导出；tempDir() 只 ensure 了 temp 这一层，
  // 子目录（temp/plugin-install）还得自己建。
  return ensureDir(path.join(Paths.tempDir(), 'plugin-install'));
}

/** 确保目录存在（fs.mkdirSync 幂等） */
function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  return dir;
}

/**
 * 移动目录：优先 rename（快、原子），跨设备时退回「复制 + 删除」。
 *
 * ★ 必须处理 EXDEV：fs.renameSync 在源与目标位于不同卷时会抛
 *   `EXDEV: cross-device link not permitted`。这不是边缘情况 ——
 *   数据根目录可被用户改到别的盘，而暂存目录固定在 temp 下。
 */
function movePath(src, dest) {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (e) {
    if (!e || (e.code !== 'EXDEV' && e.code !== 'EPERM')) throw e;
  }
  // 跨设备：逐级复制后删源
  fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
  try { fs.rmSync(src, { recursive: true, force: true }); } catch (e) {}
}

function randToken() {
  return crypto.randomBytes(16).toString('hex');
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function readInstalledManifest(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  } catch (e) {
    return null;
  }
}

/** 递归列出已安装插件：{ id, dir, name, version } */
function listInstalled(userPluginsDir) {
  const out = [];
  let entries = [];
  try { entries = fs.readdirSync(userPluginsDir, { withFileTypes: true }); } catch (e) { return out; }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(userPluginsDir, ent.name);
    const m = readInstalledManifest(dir);
    if (!m || !m.id) continue;
    out.push({ id: m.id, dir, name: m.name || m.id, version: m.version || '0.0.0' });
  }
  return out;
}

// ---------------------------------------------------------------- 下载

/**
 * 下载插件包到缓存目录。只落盘、不解压、不安装。
 * @returns {{ok:true, token:string, ...}} 待安装信息
 */
async function download(opts) {
  const { baseUrl, slug, version, timeoutMs = 120000 } = opts || {};
  if (!baseUrl || !slug) return { ok: false, error: '缺少 baseUrl 或 slug' };

  const url = new URL(
    `/api/store/plugins/${encodeURIComponent(slug)}/download`,
    baseUrl.replace(/\/+$/, '')
  );
  url.searchParams.set('source', 'app');
  if (version) url.searchParams.set('version', version);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const started = Date.now();
  let res;
  try {
    res = await fetch(url.toString(), {
      signal: ctrl.signal,
      headers: { Accept: 'application/zip' },
    });
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e && e.name === 'AbortError' ? '下载超时' : ('下载失败：' + (e && e.message || e)) };
  }
  clearTimeout(timer);

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (e) {}
    return { ok: false, error: detail || ('下载失败（HTTP ' + res.status + '）') };
  }

  // 平台出错时可能仍返回 200 + JSON（网关改写等），先看内容类型，
  // 否则会把一段 JSON 当 zip 存下来，报「压缩包无法读取」这种让人摸不着头脑的错
  const ctype = String(res.headers.get('content-type') || '').toLowerCase();
  if (ctype && !ctype.includes('zip') && !ctype.includes('octet-stream')) {
    let detail = '';
    try { detail = (await res.clone().json()).error || ''; } catch (e) {}
    return { ok: false, error: detail || ('平台返回的不是插件包（Content-Type: ' + ctype + '）') };
  }

  // 先看 Content-Length，超限就直接拒绝，不浪费带宽
  const declared = Number(res.headers.get('content-length') || 0);
  if (declared && declared > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: `插件包超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB 上限` };
  }

  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return { ok: false, error: '下载到的包是空的' };
  if (buf.length > MAX_DOWNLOAD_BYTES) {
    return { ok: false, error: `插件包超过 ${MAX_DOWNLOAD_BYTES / 1024 / 1024}MB 上限` };
  }

  const token = randToken();
  const zipPath = path.join(cacheDir(), token + '.zip');
  fs.writeFileSync(zipPath, buf);

  const meta = {
    token,
    zipPath,
    slug,
    size: buf.length,
    sha256: sha256(buf),
    serverVersion: res.headers.get('x-plugin-version') || version || '',
    downloadedAt: Date.now(),
  };
  pending.set(token, meta);

  return { ok: true, ...inspect(meta, userPluginsDirOf(opts)) };
}

function userPluginsDirOf(opts) {
  return (opts && opts.userPluginsDir) || null;
}

// ---------------------------------------------------------------- 检查

/**
 * 解析已下载的包：读清单、列文件、报告将要覆盖的既有安装。
 * 这一步不解压到插件目录，只在缓存里读。
 */
function inspect(meta, userPluginsDir) {
  if (!meta || !pending.has(meta.token)) return { ok: false, error: '下载记录已失效，请重新下载' };

  let AdmZip;
  try { AdmZip = require('adm-zip'); } catch (e) { return { ok: false, error: '缺少 adm-zip 依赖' }; }

  let zip;
  try { zip = new AdmZip(meta.zipPath); } catch (e) {
    return { ok: false, error: '压缩包无法读取：' + (e && e.message || e) };
  }

  const entries = [];
  let unpacked = 0;
  try {
    for (const e of zip.getEntries()) {
      if (e.isDirectory) continue;
      const size = e.header && e.header.size ? e.header.size : 0;
      unpacked += size;
      entries.push({ name: e.entryName, size });
    }
  } catch (e) {
    return { ok: false, error: '读取压缩包条目失败：' + (e && e.message || e) };
  }

  const problems = [];
  if (entries.length === 0) problems.push('压缩包是空的');
  if (entries.length > MAX_ENTRIES) problems.push(`条目数 ${entries.length} 超过上限 ${MAX_ENTRIES}`);
  if (unpacked > MAX_UNPACKED_BYTES) {
    problems.push(`解压后约 ${(unpacked / 1024 / 1024).toFixed(1)}MB，超过上限 ${MAX_UNPACKED_BYTES / 1024 / 1024}MB`);
  }
  for (const e of entries) {
    const n = String(e.name).replace(/\\/g, '/');
    if (n.startsWith('/') || /^[a-zA-Z]:/.test(n) || n.split('/').includes('..')) {
      problems.push('包内含不安全的文件路径：' + e.name);
      break;
    }
  }

  // 定位 plugin.json（根目录或一层包装目录）
  const manifestEntry = pickManifestEntry(entries.map((e) => e.name));
  if (!manifestEntry) {
    return { ok: false, error: '包里找不到 plugin.json，不是有效的插件包', problems, fileCount: entries.length };
  }

  let manifest = null;
  try {
    const raw = zip.readAsText(manifestEntry);
    manifest = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: 'plugin.json 解析失败：' + (e && e.message || e) };
  }

  const id = String(manifest.id || '');
  if (!PLUGIN_ID_RE.test(id)) {
    return { ok: false, error: `plugin.json 里的 id「${id}」不合法`, problems };
  }
  // 包目录名必须与 id 一致，否则解压后宿主扫不到（宿主按 plugin.json 定位）
  const rootName = manifestEntry.includes('/') ? manifestEntry.slice(0, manifestEntry.indexOf('/')) : '';
  if (rootName && rootName !== id) {
    problems.push(`包顶层目录名「${rootName}」与插件 id「${id}」不一致，解压后请注意目录层级`);
  }

  // 顶层目录 → 目标插件目录的相对偏移
  const prefix = rootName ? rootName + '/' : '';
  const targetDirName = rootName || id;

  let existing = null;
  if (userPluginsDir) {
    const found = listInstalled(userPluginsDir).find((p) => p.id === id);
    if (found) existing = found;
  }

  return {
    ok: problems.length === 0,
    token: meta.token,
    sha256: meta.sha256,
    size: meta.size,
    fileCount: entries.length,
    unpackedBytes: unpacked,
    manifest: {
      id,
      name: manifest.name || id,
      version: manifest.version || '0.0.0',
      author: manifest.author || '',
      description: String(manifest.description || '').slice(0, 300),
      entry: manifest.entry || 'index.js',
      renderer: manifest.renderer || null,
      commands: Array.isArray(manifest.commands) ? manifest.commands.slice(0, 50) : [],
    },
    files: entries
      .map((e) => ({ path: String(e.name).slice(prefix.length), size: e.size }))
      .filter((e) => e.path)
      .sort((a, b) => a.path.localeCompare(b.path)),
    targetDirName,
    prefix,
    existing: existing ? { dir: existing.dir, version: existing.version } : null,
    isUpgrade: !!existing,
    problems,
    // problems 非空时 ok=false：调用方应把这些当「警告」展示给用户，而非直接静默放行
    warnings: problems,
  };
}

/** 在条目名里找 plugin.json：优先根目录，其次路径最短的 */
function pickManifestEntry(names) {
  const cands = names.filter((n) => {
    const base = String(n).replace(/\\/g, '/').split('/').pop() || '';
    return base.toLowerCase() === 'plugin.json';
  });
  if (!cands.length) return null;
  cands.sort((a, b) => {
    const da = String(a).split('/').length, db = String(b).split('/').length;
    return da - db || String(a).length - String(b).length;
  });
  return cands[0];
}

// ---------------------------------------------------------------- 安装

/**
 * 执行安装。把缓存里的包解压到用户插件目录，然后触发 rescan。
 * @param {boolean} overwrite 是否允许覆盖已安装的同 id 插件（升级）
 */
function install(opts) {
  const { token, userPluginsDir, overwrite = false, removePending = true } = opts || {};
  if (!token) return { ok: false, error: '缺少 token' };
  const meta = pending.get(token);
  if (!meta) return { ok: false, error: '下载记录已失效，请重新下载' };
  if (!userPluginsDir) return { ok: false, error: '缺少插件目录' };

  const info = inspect(meta, userPluginsDir);

  // inspect 里的 problems 是安全类问题（路径穿越、体积超限等），一律拒绝安装
  const fatal = (info.problems || []).filter((p) =>
    /不安全|超过上限|条目数|是空的/.test(p)
  );
  if (fatal.length) {
    return { ok: false, error: '压缩包安全校验未通过', problems: fatal };
  }
  if (!info.manifest) {
    return { ok: false, error: info.error || '无法识别插件包' };
  }
  if (info.isUpgrade && !overwrite) {
    return {
      ok: false,
      needsConfirm: true,
      error: `已安装「${info.manifest.name}」${info.existing.version}，确认要升级到 ${info.manifest.version} 吗？`,
    };
  }

  ensureDir(userPluginsDir);

  // 先解压到暂存目录，校验通过后再移动到位 ——
  // 避免解到一半失败留下半个插件目录
  const stage = path.join(Paths.tempDir(), 'plugin-install', 'stage-' + token);
  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
  ensureDir(stage);

  let AdmZip;
  try { AdmZip = require('adm-zip'); } catch (e) { return { ok: false, error: '缺少 adm-zip 依赖' }; }

  const zip = new AdmZip(meta.zipPath);
  const zs = safeExtractAllTo(zip, stage, {
    maxEntries: MAX_ENTRIES,
    maxTotalBytes: MAX_UNPACKED_BYTES,
  });
  if (!zs.ok) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
    return { ok: false, error: '解压安全校验未通过：' + zs.error };
  }

  // 解压后定位真正的插件根（含 plugin.json 的那层）
  const srcRoot = info.prefix ? path.join(stage, info.prefix) : stage;
  const manifestPath = path.join(srcRoot, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
    return { ok: false, error: '解压后找不到 plugin.json' };
  }
  // 清单里的 entry 必须在包里真实存在，否则装上也是坏的
  const entryRel = String(info.manifest.entry || 'index.js').replace(/\\/g, '/');
  if (!fs.existsSync(path.join(srcRoot, entryRel))) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
    return { ok: false, error: `清单声明的入口 ${entryRel} 在包里不存在` };
  }

  // 到位：目标目录 = <userPlugins>/<targetDirName>
  const destDir = path.join(userPluginsDir, info.targetDirName);
  const realDest = path.resolve(destDir);
  const realRoot = path.resolve(userPluginsDir);
  // 双保险：目标必须落在插件根目录内
  if (realDest !== realRoot && !realDest.startsWith(realRoot + path.sep)) {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}
    return { ok: false, error: '目标路径越界，已中止' };
  }

  let backupDir = null;
  try {
    if (fs.existsSync(destDir)) {
      // 升级：先把旧版挪到备份，出问题可回滚
      backupDir = path.join(Paths.tempDir(), 'plugin-install', 'backup-' + token + '-' + Date.now());
      ensureDir(path.dirname(backupDir));
      movePath(destDir, backupDir);
    }
    movePath(srcRoot, destDir);
  } catch (e) {
    // 回滚
    try {
      if (backupDir && fs.existsSync(backupDir) && !fs.existsSync(destDir)) {
        movePath(backupDir, destDir);
      }
    } catch (e2) {}
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e2) {}
    return { ok: false, error: '安装失败：' + (e && e.message || e) };
  }

  try { fs.rmSync(stage, { recursive: true, force: true }); } catch (e) {}

  if (removePending) {
    pending.delete(token);
    try { fs.rmSync(meta.zipPath, { force: true }); } catch (e) {}
  }

  return {
    ok: true,
    id: info.manifest.id,
    name: info.manifest.name,
    version: info.manifest.version,
    dir: destDir,
    isUpgrade: info.isUpgrade,
    upgradedFrom: info.existing ? info.existing.version : null,
    fileCount: info.fileCount,
    backupDir,
  };
}

/** 放弃一次待安装的下载 */
function discard(token) {
  const meta = pending.get(token);
  if (!meta) return { ok: false, error: '记录不存在' };
  pending.delete(token);
  try { fs.rmSync(meta.zipPath, { force: true }); } catch (e) {}
  return { ok: true };
}

module.exports = { download, inspect, install, discard, listInstalled, MAX_DOWNLOAD_BYTES, MAX_UNPACKED_BYTES };
