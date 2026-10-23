// ============================================================
// P1-8 更新包签名与验签（Ed25519，Node 内置 crypto）
// ============================================================
// 为什么不是 minisign：应用内已经有 Node，Ed25519 原生支持；签名格式自定义但更简单，
// 验签逻辑小到可以审阅。签名对象是「版本 + 文件名 + 安装包 sha256」的规范串：
//
//   fufumidi-update/v1\n<version>\n<fileName>\n<sha256>
//
// update-manifest.json 随 Release 发布（与 latest.yml 并列），安装包下载完成后先验签再启动更新器。
// 私钥只存在于构建机（默认 E:\Midi\_attic\update-signing\ed25519-private.pem，绝不入库）；
// 公钥内嵌在本文件 —— 轮换公钥必须同时发版，老版本只能验老公钥。
'use strict';
const crypto = require('crypto');
const fs = require('fs');

/** 内嵌公钥（SPKI DER base64）；对应私钥在构建机，见 docs/UPDATE-SIGNING.md */
const UPDATE_PUBKEY =
  'MCowBQYDK2VwAyEAncX9NsnTXiizpBTnEuqwWwvPqqkzzoFc9XF5I6S2/bM=';

const FORMAT = 'fufumidi-update-signature/v1';
const CANON_HEADER = 'fufumidi-update/v1';

function canonicalPayload(version, fileName, sha256) {
  return CANON_HEADER + '\n' + String(version || '') + '\n' + String(fileName || '') + '\n' + String(sha256 || '');
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (d) => h.update(d));
    s.on('error', reject);
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** 用私钥签安装包 → update-manifest.json 对象（构建机执行） */
async function signManifest(opts) {
  const { filePath, version, fileName, privateKeyPem } = opts || {};
  if (!filePath || !fs.existsSync(filePath)) throw new Error('安装包不存在：' + filePath);
  if (!privateKeyPem) throw new Error('缺少签名私钥');
  const sha256 = await sha256File(filePath);
  const name = fileName || require('path').basename(filePath);
  const payload = canonicalPayload(version, name, sha256);
  const sig = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKeyPem);
  return {
    format: FORMAT,
    version: String(version || ''),
    file: name,
    size: fs.statSync(filePath).size,
    sha256,
    sig: sig.toString('base64'),
  };
}

/**
 * 验签：sha256 必须与 manifest 一致，签名必须能由内嵌公钥验证。
 * @returns {Promise<{ok:boolean, error?:string, sha256?:string, size?:number, version?:string}>}
 */
async function verifyManifest(opts) {
  const { filePath, manifest, publicKeyB64 } = opts || {};
  try {
    if (!filePath || !fs.existsSync(filePath)) return { ok: false, error: '安装包不存在' };
    if (!manifest || manifest.format !== FORMAT) return { ok: false, error: '签名清单格式不支持：' + (manifest && manifest.format) };
    if (!manifest.version || !manifest.file || !manifest.sha256 || !manifest.sig) return { ok: false, error: '签名清单缺字段' };
    const size = fs.statSync(filePath).size;
    if (manifest.size && Number(manifest.size) !== size) return { ok: false, error: '安装包大小不符（' + size + ' ≠ ' + manifest.size + '）' };
    const sha256 = await sha256File(filePath);
    if (sha256 !== manifest.sha256) return { ok: false, error: '安装包 sha256 不符', sha256: sha256 };
    const payload = canonicalPayload(manifest.version, manifest.file, manifest.sha256);
    const pub = crypto.createPublicKey({ key: Buffer.from(publicKeyB64 || UPDATE_PUBKEY, 'base64'), format: 'der', type: 'spki' });
    const ok = crypto.verify(null, Buffer.from(payload, 'utf8'), pub, Buffer.from(String(manifest.sig), 'base64'));
    if (!ok) return { ok: false, error: '签名验证失败', sha256: sha256 };
    return { ok: true, sha256: sha256, size: size, version: manifest.version };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/** 从多个候选 URL 抓 update-manifest.json（哪个先成功用哪个；失败返回 null，不抛） */
async function fetchManifest(candidates, net) {
  for (const url of (candidates || [])) {
    if (!url) continue;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 12000);
      try {
        const r = await net.fetch(url, {
          headers: { 'user-agent': 'FuFumidi', accept: 'application/json' },
          signal: ctrl.signal,
        });
        if (!r.ok) continue;
        const text = await r.text();
        if (!text || text.length > 256 * 1024) continue;
        const j = JSON.parse(text);
        if (j && j.format === FORMAT) return j;
      } finally { clearTimeout(to); }
    } catch (e) { /* 换下一个源 */ }
  }
  return null;
}

module.exports = { UPDATE_PUBKEY, FORMAT, canonicalPayload, sha256File, signManifest, verifyManifest, fetchManifest };
