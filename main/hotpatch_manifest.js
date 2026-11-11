// ============================================================
// 热补丁清单：格式、路径白名单、Ed25519 签名/验签（纯函数，无 Electron 依赖）
// ------------------------------------------------------------
// 与「版本更新」完全解耦：清单是一个放在仓库固定路径的小 JSON，不带版本号。
// push 两个文件（hotpatch.json + zip）即生效，用户不下载 700MB 安装包。
//
// 安全边界（ deliberately narrow ）：
//   · 只允许覆盖 app.asar.unpacked 下的**真实文件**（主要是 engine/**/*.py）。
//     app.asar 是单文件归档，改内部字节会破坏头部 integrity 与 exe 内嵌哈希，
//     那属于「必须整包发版」的范畴，不在这里做。
//   · 禁止可执行文件 / 原生模块 / 路径穿越 / 绝对路径 / 超大文件。
//   · 清单与补丁包都必须过 Ed25519 验签（公钥内嵌在 update_sign.js）。
// ============================================================
'use strict';
const crypto = require('crypto');
const path = require('path');
const { UPDATE_PUBKEY, sha256File } = require('./update_sign');

const FORMAT = 'fufumidi-hotpatch/v1';
const CANON_HEADER = 'fufumidi-hotpatch/v1';

// 体积上限：补丁的定位是「几个小文件」，不是第二个安装包
const MAX_FILES = 60;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 16 * 1024 * 1024;
const MAX_NOTES = 2000;

// 相对安装目录（dirname(process.execPath)）的可覆盖前缀
const ALLOWED_PREFIXES = [
  'resources/app.asar.unpacked/engine/',
  'resources/app.asar.unpacked/renderer/',
];
const ALLOWED_EXT = new Set([
  '.py', '.json', '.yaml', '.yml', '.txt', '.md', '.js', '.css', '.ini', '.cfg',
]);
const FORBIDDEN_EXT = new Set([
  '.exe', '.dll', '.pyd', '.so', '.dylib', '.node', '.asar', '.bin', '.pyc',
]);

/** 规范化相对路径；非法返回 null。只接受 / 分隔的 POSIX 风格路径。 */
function normalizeRel(p) {
  if (typeof p !== 'string' || !p || p.indexOf('\0') >= 0) return null;
  if (/^[A-Za-z]:/.test(p) || p.startsWith('/') || p.startsWith('\\')) return null;
  if (p.includes('\\')) return null;              // 不许 Windows 分隔符混进来
  const norm = path.posix.normalize(p);
  if (norm === '.' || norm.startsWith('../') || norm.includes('/../') || norm.endsWith('/..')) return null;
  if (norm.startsWith('/') || norm !== p.replace(/\/+/g, '/')) return null;
  return norm;
}

/** 目标路径是否落在允许覆盖的白名单内。返回 {ok, reason, rel} */
function validateRelPath(p) {
  const rel = normalizeRel(p);
  if (!rel) return { ok: false, reason: '非法路径（绝对路径/盘符/../分隔符）' };
  if (!ALLOWED_PREFIXES.some((pre) => rel.startsWith(pre) && rel.length > pre.length)) {
    return { ok: false, reason: '不在允许覆盖的目录内：' + rel, rel };
  }
  const ext = path.posix.extname(rel).toLowerCase();
  if (FORBIDDEN_EXT.has(ext)) return { ok: false, reason: '禁止覆盖可执行文件/原生模块：' + rel, rel };
  if (!ALLOWED_EXT.has(ext)) return { ok: false, reason: '不允许的文件类型：' + rel, rel };
  return { ok: true, rel };
}

/** semver-ish 比较（x.y.z，允许 -beta.N 后缀；仅用于补丁适用版本范围） */
function cmpVersion(a, b) {
  const pa = String(a || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** 稳定规范串：签名与验签必须用完全相同的构造，绝不依赖 JSON 键顺序。 */
function canonical(manifest) {
  const m = manifest || {};
  const t = m.target || {};
  const pk = m.package || {};
  const lines = [
    CANON_HEADER,
    String(m.id || ''),
    String(m.notes || ''),
    String(t.min || '') + '|' + String(t.max || ''),
    String(pk.name || '') + '|' + String(pk.size || '') + '|' + String(pk.sha256 || ''),
  ];
  const files = Array.isArray(m.files) ? m.files.slice() : [];
  files.sort((x, y) => String(x && x.path).localeCompare(String(y && y.path)));
  for (const f of files) lines.push(String(f.path) + '\t' + String(f.size) + '\t' + String(f.sha256));
  return lines.join('\n');
}

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 构建机：给清单补 Ed25519 签名（不校验字段，调用前先 validateManifest） */
function signHotpatch(manifest, privateKeyPem) {
  if (!privateKeyPem) throw new Error('缺少签名私钥');
  const out = JSON.parse(JSON.stringify(manifest));
  delete out.sig;
  out.sig = crypto.sign(null, Buffer.from(canonical(out), 'utf8'), privateKeyPem).toString('base64');
  return out;
}

/**
 * 校验清单结构 + 白名单 + 体积 + 签名 + 适用版本。
 * @returns {{ok:boolean, error?:string, files?:Array}}
 */
function verifyHotpatch(manifest, opts) {
  const o = opts || {};
  const m = manifest;
  try {
    if (!m || m.format !== FORMAT) return { ok: false, error: '补丁清单格式不支持：' + (m && m.format) };
    if (!/^[A-Za-z0-9._-]{1,80}$/.test(String(m.id || ''))) return { ok: false, error: '补丁 id 非法' };
    if (String(m.notes || '').length > MAX_NOTES) return { ok: false, error: '说明文字过长' };
    const t = m.target || {};
    if (o.currentVersion) {
      if (t.min && cmpVersion(o.currentVersion, t.min) < 0) return { ok: false, error: '当前版本低于补丁适用范围' };
      if (t.max && cmpVersion(o.currentVersion, t.max) > 0) return { ok: false, error: '当前版本高于补丁适用范围' };
    }
    const pk = m.package || {};
    if (!/^[A-Za-z0-9._-]+\.zip$/i.test(String(pk.name || ''))) return { ok: false, error: '补丁包名非法' };
    if (!Number.isInteger(pk.size) || pk.size <= 0 || pk.size > MAX_PACKAGE_BYTES) return { ok: false, error: '补丁包体积超限' };
    if (!/^[a-f0-9]{64}$/i.test(String(pk.sha256 || ''))) return { ok: false, error: '补丁包 sha256 非法' };
    const files = m.files;
    if (!Array.isArray(files) || !files.length || files.length > MAX_FILES) return { ok: false, error: '补丁文件数异常' };
    let total = 0;
    const seen = new Set();
    for (const f of files) {
      const v = validateRelPath(f && f.path);
      if (!v.ok) return { ok: false, error: v.reason };
      if (seen.has(v.rel)) return { ok: false, error: '重复的目标路径：' + v.rel };
      seen.add(v.rel);
      if (!Number.isInteger(f.size) || f.size < 0 || f.size > MAX_FILE_BYTES) return { ok: false, error: '文件体积超限：' + v.rel };
      if (!/^[a-f0-9]{64}$/i.test(String(f.sha256 || ''))) return { ok: false, error: '文件 sha256 非法：' + v.rel };
      total += f.size;
    }
    if (total > MAX_TOTAL_BYTES) return { ok: false, error: '补丁总解压体积超限' };
    if (!m.sig) return { ok: false, error: '补丁清单缺签名' };
    const pub = crypto.createPublicKey({
      key: Buffer.from(o.publicKeyB64 || UPDATE_PUBKEY, 'base64'), format: 'der', type: 'spki',
    });
    const ok = crypto.verify(null, Buffer.from(canonical(m), 'utf8'), pub, Buffer.from(String(m.sig), 'base64'));
    if (!ok) return { ok: false, error: '补丁清单签名验证失败' };
    return { ok: true, files: files.map((f) => ({ path: validateRelPath(f.path).rel, size: f.size, sha256: f.sha256 })) };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  FORMAT, MAX_FILES, MAX_FILE_BYTES, MAX_TOTAL_BYTES, MAX_PACKAGE_BYTES,
  ALLOWED_PREFIXES,
  normalizeRel, validateRelPath, cmpVersion, canonical,
  sha256Buffer, sha256File, signHotpatch, verifyHotpatch,
};
