// ============================================================
// 压缩包安全解压（zip-slip / 解压炸弹 / 重名条目的纵深防御）
// ============================================================
'use strict';
const path = require('path');

/**
 * 解压前的条目校验。
 *
 * 为什么需要它：`adm-zip` 的历史漏洞（GHSA-vwc7-r8mq-g2x9 跟随目标目录里的符号链接
 * 造成任意文件覆盖、GHSA-p634-w6r4-rjp2 重名条目导致 `getEntry()` 与
 * `extractAllTo()` 解析到不同内容、GHSA-rcw4-f5rp-g42v 解压炸弹）**都属于"解不可信
 * 的包"这一类**。升到 0.6.1 已经修掉大部分，但本应用解的全是**第三方内容**
 * （用户导入的 UTAU 声库、公开仓库的 DiffSinger 声库、ModelScope 声库、模型包），
 * 所以这里再加一道与版本无关的闸：任何一条不满足就**整包拒绝**，不做部分解压。
 *
 * 规则：
 *   1. 条目名不得为空、不得含 NUL；
 *   2. 不得是绝对路径、不得带盘符（`C:`）、不得含 `..` 段 —— 否则会写到 dest 之外；
 *   3. 不得与同包内另一条目重名 —— 重名会让"按名取"与"按序解"指向不同内容；
 *   4. 条目数与解压后总大小不得超过上限（解压炸弹 DoS）。
 *
 * @param {import('adm-zip')} zip  已读入的 AdmZip
 * @param {string} dest           解压目标目录
 * @param {{maxEntries?:number,maxTotalBytes?:number}} [opts]
 * @returns {{ok:boolean, error?:string, count:number, bytes:number}}
 */
function inspectEntries(zip, dest, opts) {
  const maxEntries = (opts && opts.maxEntries) || 20000;
  const maxTotalBytes = (opts && opts.maxTotalBytes) || (8 * 1024 * 1024 * 1024); // 8 GiB
  let entries;
  try {
    entries = zip.getEntries();
  } catch (e) {
    return { ok: false, error: '读取压缩包条目失败：' + e, count: 0, bytes: 0 };
  }
  if (!entries || !entries.length) {
    return { ok: false, error: '压缩包为空', count: 0, bytes: 0 };
  }
  if (entries.length > maxEntries) {
    return { ok: false, error: `压缩包条目过多（${entries.length} > ${maxEntries}）`, count: 0, bytes: 0 };
  }

  const seen = new Set();
  const base = path.resolve(dest);
  let total = 0;
  for (const e of entries) {
    const name = String(e.entryName == null ? '' : e.entryName);
    if (!name) return { ok: false, error: '压缩包含无名条目', count: 0, bytes: 0 };
    if (name.indexOf('\0') >= 0) {
      return { ok: false, error: '压缩包条目名含 NUL 字节：' + JSON.stringify(name), count: 0, bytes: 0 };
    }
    // 归一化成 Windows 风格再判绝对路径 / 盘符，避免 `C:\x` 与 `/x` 两种逃逸
    const norm = name.replace(/\\/g, '/');
    if (norm.charAt(0) === '/' || /^[A-Za-z]:/.test(norm) || norm.startsWith('//')) {
      return { ok: false, error: '压缩包含绝对路径条目：' + name, count: 0, bytes: 0 };
    }
    if (norm.split('/').some((seg) => seg === '..')) {
      return { ok: false, error: '压缩包含越界条目（..）：' + name, count: 0, bytes: 0 };
    }
    const key = norm.toLowerCase();          // Windows 上大小写不敏感
    if (seen.has(key)) {
      return { ok: false, error: '压缩包含重名条目：' + name, count: 0, bytes: 0 };
    }
    seen.add(key);

    // 双保险：拼出来必须仍在 dest 之内
    const resolved = path.resolve(base, norm);
    if (resolved !== base && !resolved.startsWith(base + path.sep)) {
      return { ok: false, error: '压缩包条目解析后越界：' + name, count: 0, bytes: 0 };
    }

    const size = Number(e.header && e.header.size) || 0;
    if (size > 0) {
      total += size;
      if (total > maxTotalBytes) {
        return {
          ok: false,
          error: `压缩包解压后体积超限（${(total / 1073741824).toFixed(2)} GiB > ${(maxTotalBytes / 1073741824).toFixed(0)} GiB）`,
          count: 0, bytes: 0,
        };
      }
    }
  }
  return { ok: true, count: entries.length, bytes: total };
}

/**
 * 校验通过才解压的 `extractAllTo`。
 *
 * @param {import('adm-zip')} zip
 * @param {string} dest
 * @param {{mainWindow?:any, maxEntries?:number, maxTotalBytes?:number, overwrite?:boolean}} [opts]
 * @returns {{ok:boolean, error?:string, count?:number, bytes?:number}}
 */
function safeExtractAllTo(zip, dest, opts) {
  const check = inspectEntries(zip, dest, opts);
  if (!check.ok) return check;
  try {
    zip.extractAllTo(dest, (opts && opts.overwrite) !== false);
  } catch (e) {
    return { ok: false, error: '解压失败：' + e, count: 0, bytes: 0 };
  }
  return { ok: true, count: check.count, bytes: check.bytes };
}

module.exports = { inspectEntries, safeExtractAllTo };
