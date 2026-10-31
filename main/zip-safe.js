// ============================================================
// 压缩包安全解压（zip-slip / 解压炸弹 / 重名条目的纵深防御）
// ============================================================
'use strict';
const path = require('path');
const fs = require('fs');
const AdmZip = require('adm-zip');
const yauzl = require('yauzl');

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
    if (typeof zip === 'string') zip = new AdmZip(zip);
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
  if (typeof zip === 'string') zip = new AdmZip(zip);
  const check = inspectEntries(zip, dest, opts);
  if (!check.ok) return check;
  try {
    zip.extractAllTo(dest, (opts && opts.overwrite) !== false);
  } catch (e) {
    return { ok: false, error: '解压失败：' + e, count: 0, bytes: 0 };
  }
  return { ok: true, count: check.count, bytes: check.bytes };
}

/**
 * 大压缩包（>2 GiB）的流式安全解压：Node 的 fs.readFileSync 有 2 GiB 上限，
 * adm-zip 会把整包读进内存，MIROS 的 5.36 GB 运行时包会直接报
 * ERR_FS_FILE_TOO_LARGE: File size ... is greater than 2 GiB。
 *
 * yauzl 只读中央目录、逐条目流式解压，支持 ZIP64；这里复用与 inspectsEntries
 * 相同的 zip-slip / 重名 / 解压炸弹规则。
 */
function safeExtractAllToLarge(archive, dest, opts) {
  const maxEntries = (opts && opts.maxEntries) || 20000;
  const maxTotalBytes = (opts && opts.maxTotalBytes) || (16 * 1024 * 1024 * 1024);
  return new Promise((resolve) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true }, (err, zip) => {
      if (err || !zip) return resolve({ ok: false, error: '读取压缩包失败：' + (err && err.message || err), count: 0, bytes: 0 });
      const base = path.resolve(dest);
      const seen = new Set();
      let count = 0, total = 0, done = false, ended = false, pendingWrites = 0;
      const finish = () => {
        if (!ended || pendingWrites !== 0 || done) return; done = true;
        resolve({ ok: true, count, bytes: total });
      };
      const fail = (msg) => {
        if (done) return; done = true;
        try { zip.close(); } catch (_) {}
        resolve({ ok: false, error: msg, count: 0, bytes: 0 });
      };
      try { fs.mkdirSync(base, { recursive: true }); } catch (e) { return fail('创建解压目录失败：' + e.message); }
      zip.on('error', (e) => fail('读取压缩包条目失败：' + e.message));
      zip.on('end', () => { ended = true; finish(); });
      zip.on('entry', (entry) => {
        if (done) return;
        const raw = entry.fileName || '';
        if (!raw) return fail('压缩包含无名条目');
        if (raw.indexOf('\0') >= 0) return fail('压缩包条目名含 NUL 字节');
        const name = raw.replace(/\\/g, '/');
        if (name.charAt(0) === '/' || /^[A-Za-z]:/.test(name) || name.startsWith('//')) return fail('压缩包含绝对路径条目：' + raw);
        if (name.split('/').some((seg) => seg === '..')) return fail('压缩包含越界条目（..）：' + raw);
        // 拒绝 Unix symlink（外部属性高 16 位为 S_IFLNK）
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) return fail('压缩包含符号链接：' + raw);
        const key = name.toLowerCase();
        if (seen.has(key)) return fail('压缩包含重名条目：' + raw);
        seen.add(key);
        count += 1;
        if (count > maxEntries) return fail('压缩包条目过多（' + count + ' > ' + maxEntries + '）');
        const size = Number(entry.uncompressedSize) || 0;
        total += size;
        if (total > maxTotalBytes) return fail('压缩包解压后体积超限（' + (total / 1073741824).toFixed(2) + ' GiB）');
        const resolved = path.resolve(base, name);
        if (resolved !== base && !resolved.startsWith(base + path.sep)) return fail('压缩包条目解析后越界：' + raw);
        if (/\/$/.test(name)) {
          try { fs.mkdirSync(resolved, { recursive: true }); } catch (e) { return fail('创建目录失败：' + e.message); }
          return zip.readEntry();
        }
        let stream;
        try { stream = fs.createWriteStream(resolved); } catch (e) { return fail('创建文件失败：' + e.message); }
        // 父目录可能尚未出现（zip 里不保证目录条目在前）
        try { fs.mkdirSync(path.dirname(resolved), { recursive: true }); } catch (e) { /* 写流会给出更具体错误 */ }
        zip.openReadStream(entry, (e2, rs) => {
          if (e2) return fail('读取条目失败：' + e2.message);
          rs.on('error', (e3) => fail('解压条目失败：' + e3.message));
          stream.on('error', (e3) => fail('写入文件失败：' + e3.message));
          pendingWrites += 1;
          stream.on('close', () => { pendingWrites -= 1; if (!done) zip.readEntry(); finish(); });
          rs.pipe(stream);
        });
      });
      zip.readEntry();
    });
  });
}

module.exports = { inspectEntries, safeExtractAllTo, safeExtractAllToLarge };
