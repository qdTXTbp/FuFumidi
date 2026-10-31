// ============================================================
// 压缩包安全解压（zip-slip / 解压炸弹 / 重名条目的纵深防御）
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

/**
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
 * 规则只有一份（`validateEntries`），三条入口共用：
 *   · `safeExtractAllTo`   —— 同步，AdmZip 实例或路径（历史签名，声库/插件等继续用）
 *   · `safeExtractFile`    —— 异步，路径；小包走 adm-zip，大包走流式解压
 *   · `inspectEntries`     —— 只校验不解压
 *
 * ★ 为什么要有流式解压（2026-10-31）：`adm-zip` 构造时把**整个包 `readFileSync`
 *   进内存**（adm-zip.js: `inBuffer = fs.readFileSync(input)`）。可选引擎的运行时包
 *   动辄 5 GB（MIROS = 5.36 GB 单包），整包读进主进程 → 内存暴涨 + 主进程卡死几分钟，
 *   低内存机器直接 OOM。大包因此改走「只读中央目录 → 逐条目 inflateRaw 流式落盘」，
 *   内存占用与包体积无关，且解压期间主进程不阻塞。
 * ============================================================ */

const SIG_LOCAL = 0x04034b50;
const SIG_CEN = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;

const DEFAULT_MAX_ENTRIES = 20000;
const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB
/** 超过这个体积不再交给 adm-zip（它整包读内存），改走流式解压 */
const DEFAULT_STREAM_THRESHOLD = 1024 * 1024 * 1024;    // 1 GiB
/** 中央目录本身的上限：正常包远小于此（5 GB 的包目录约几 MB），超出即视为异常 */
const MAX_CENTRAL_DIR = 64 * 1024 * 1024;

function errorOf(e) {
  return String((e && e.message) || e);
}

/** 从 fd 的 pos 处读满整个 buffer（readSync 可能短读） */
function readExact(fd, buf, len, pos) {
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (!n) throw new Error('读到文件末尾（文件不完整）');
    got += n;
  }
}

/**
 * 只读中央目录，列出条目元数据。**与包体积无关的内存占用**（5 GB 的包也只读几 MB）。
 * 支持 zip64（>4 GiB 的偏移/尺寸）与「包前面被塞了数据」的自解压前缀。
 *
 * @param {string} file
 * @returns {{entries:Array<{name:string,size:number,csize:number,method:number,lho:number,isDir:boolean,utf8:boolean}>, }>}
 */
function readCentralDirectory(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size < 22) throw new Error('文件太小，不是有效的 zip');

    const tailLen = Math.min(size, 22 + 65535);
    const tail = Buffer.allocUnsafe(tailLen);
    readExact(fd, tail, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('找不到 zip 结尾记录（文件可能没下完，或不是 zip）');
    const eocdAbs = size - tailLen + eocd;

    let total = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    // anchor = 「中央目录结束」在文件里的实际位置，用来推算前缀数据造成的偏移
    let anchor = eocdAbs;

    const needZip64 = cdSize === 0xffffffff || cdOff === 0xffffffff;
    if (needZip64) {
      const locOff = eocdAbs - 20;
      if (locOff < 0) throw new Error('zip64 定位记录缺失（文件不完整？）');
      const loc = Buffer.allocUnsafe(20);
      readExact(fd, loc, 20, locOff);
      if (loc.readUInt32LE(0) !== SIG_EOCD64_LOC) throw new Error('zip64 定位记录损坏');
      const z64Off = Number(loc.readBigUInt64LE(8));
      if (!(z64Off >= 0) || z64Off + 56 > size) throw new Error('zip64 目录偏移越界');
      const z64 = Buffer.allocUnsafe(56);
      readExact(fd, z64, 56, z64Off);
      if (z64.readUInt32LE(0) !== SIG_EOCD64) throw new Error('zip64 目录记录损坏');
      total = Number(z64.readBigUInt64LE(32));
      cdSize = Number(z64.readBigUInt64LE(40));
      cdOff = Number(z64.readBigUInt64LE(48));
      anchor = z64Off;
    }

    if (!(cdOff >= 0) || !(cdSize >= 0) || cdOff + cdSize > size) {
      throw new Error('中央目录越界（文件不完整？）');
    }
    if (cdSize > MAX_CENTRAL_DIR) {
      throw new Error('中央目录异常大（' + cdSize + ' bytes），拒绝解析');
    }

    const cd = Buffer.allocUnsafe(cdSize);
    readExact(fd, cd, cdSize, cdOff);
    const delta = anchor - (cdOff + cdSize); // 自解压包/被拼接过的包：本地头偏移要整体平移

    const entries = [];
    let p = 0;
    while (p + 46 <= cd.length) {
      if (cd.readUInt32LE(p) !== SIG_CEN) break;
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      let csize = cd.readUInt32LE(p + 20);
      let usize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const cmtLen = cd.readUInt16LE(p + 32);
      let lho = cd.readUInt32LE(p + 42);
      const nameStart = p + 46;
      const nameEnd = nameStart + nameLen;
      if (nameEnd + extraLen + cmtLen > cd.length) throw new Error('中央目录条目越界（文件不完整？）');

      // zip64 扩展字段（0x0001）：只有对应字段为 0xFFFFFFFF 时才占位
      if (usize === 0xffffffff || csize === 0xffffffff || lho === 0xffffffff) {
        const eEnd = nameEnd + extraLen;
        let e = nameEnd;
        while (e + 4 <= eEnd) {
          const id = cd.readUInt16LE(e);
          const sz = cd.readUInt16LE(e + 2);
          if (id === 0x0001) {
            let q = e + 4;
            if (usize === 0xffffffff && q + 8 <= eEnd) { usize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (csize === 0xffffffff && q + 8 <= eEnd) { csize = Number(cd.readBigUInt64LE(q)); q += 8; }
            if (lho === 0xffffffff && q + 8 <= eEnd) { lho = Number(cd.readBigUInt64LE(q)); q += 8; }
            break;
          }
          e += 4 + sz;
        }
      }

      const utf8 = (flags & 0x0800) !== 0;
      // 非 UTF-8 标记的名字按 latin1 还原（与 adm-zip 的 CP437 一样是 1 字节 1 字符，
      // 用于越界判断等价；这类包仍走 adm-zip 解，见 safeExtractFile）
      const name = cd.subarray(nameStart, nameEnd).toString(utf8 ? 'utf8' : 'latin1');
      entries.push({ name, size: usize, csize, method, lho: lho + delta, flags, utf8, isDir: /\/$/.test(name) });
      p = nameEnd + extraLen + cmtLen;
    }

    if (!entries.length) throw new Error('压缩包为空');
    if (total > 0 && total !== entries.length && total !== 0xffff) {
      throw new Error('条目数与结尾记录不一致（' + entries.length + ' != ' + total + '），可能被截断');
    }
    return { entries, zip64: needZip64 };
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* fd 已关闭 / 进程退出中，无补救动作 */ }
  }
}

/**
 * 安全规则本体（唯一实现）。entries 只需有 `name` 与 `size`。
 *
 * @param {Array<{name:string,size:number}>} entries
 * @param {string} dest
 * @param {{maxEntries?:number,maxTotalBytes?:number}} [opts]
 * @returns {{ok:boolean, error?:string, count:number, bytes:number}}
 */
function validateEntries(entries, dest, opts) {
  const maxEntries = (opts && opts.maxEntries) || DEFAULT_MAX_ENTRIES;
  const maxTotalBytes = (opts && opts.maxTotalBytes) || DEFAULT_MAX_TOTAL_BYTES;
  if (!entries || !entries.length) return { ok: false, error: '压缩包为空', count: 0, bytes: 0 };
  if (entries.length > maxEntries) {
    return { ok: false, error: `压缩包条目过多（${entries.length} > ${maxEntries}）`, count: 0, bytes: 0 };
  }

  const seen = new Set();
  const base = path.resolve(dest);
  let total = 0;
  for (const e of entries) {
    const name = String(e.name == null ? '' : e.name);
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

    const size = Number(e.size) || 0;
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
 * 校验条目。`input` 可以是 AdmZip 实例，也可以是路径 —— **两种都接受**：
 * 此前只接受实例，调用方传了路径就变成 `TypeError: zip.getEntries is not a function`
 * （2026-10-31 线上问题：MIROS 5 GB 运行时包下完、卡在解包这一步）。
 *
 * @param {import('adm-zip')|string} input
 * @param {string} dest
 * @param {{maxEntries?:number,maxTotalBytes?:number}} [opts]
 */
function inspectEntries(input, dest, opts) {
  if (typeof input === 'string') {
    // 大包不 new AdmZip（整包读内存）：直接读中央目录
    let size = 0;
    try { size = fs.statSync(input).size; } catch (e) { return { ok: false, error: '压缩包不存在：' + errorOf(e), count: 0, bytes: 0 }; }
    if (size > ((opts && opts.streamThreshold) || DEFAULT_STREAM_THRESHOLD)) {
      try {
        return validateEntries(readCentralDirectory(input).entries, dest, opts);
      } catch (e) {
        return { ok: false, error: '读取压缩包条目失败：' + errorOf(e), count: 0, bytes: 0 };
      }
    }
    let zip;
    try { zip = new (require('adm-zip'))(input); } catch (e) {
      return { ok: false, error: '读取压缩包条目失败：' + errorOf(e), count: 0, bytes: 0 };
    }
    return inspectEntries(zip, dest, opts);
  }

  let entries;
  try {
    entries = input.getEntries();
  } catch (e) {
    return { ok: false, error: '读取压缩包条目失败：' + errorOf(e), count: 0, bytes: 0 };
  }
  if (!entries || !entries.length) return { ok: false, error: '压缩包为空', count: 0, bytes: 0 };
  const flat = entries.map((e) => ({
    name: String(e.entryName == null ? '' : e.entryName),
    size: Number(e.header && e.header.size) || 0,
  }));
  return validateEntries(flat, dest, opts);
}

/**
 * 流式解压（大包专用）：逐条目 inflateRaw 落盘，内存占用与包体积无关。
 * 前提：条目已通过 `validateEntries` —— 本函数只做机械搬运，不再判越界以外的策略。
 */
async function extractStream(file, entries, dest, opts) {
  const base = path.resolve(dest);
  const onProgress = opts && opts.onProgress;
  const totalBytes = entries.reduce((a, e) => a + (e.isDir ? 0 : e.size), 0);
  const state = { done: 0, last: 0 };
  const report = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - state.last < 250) return;
    state.last = now;
    try { onProgress(state.done, totalBytes, entries.length); } catch (_) { /* 进度回调异常不能打断解压 */ }
  };
  const counter = () => new Transform({
    transform(chunk, enc, cb) {
      state.done += chunk.length;
      report(false);
      cb(null, chunk);
    },
  });

  const fd = fs.openSync(file, 'r');
  try {
    for (const e of entries) {
      const norm = e.name.replace(/\\/g, '/');
      const target = path.resolve(base, norm);
      if (e.isDir) { fs.mkdirSync(target, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // overwrite:false 语义与 adm-zip 对齐：同名文件已存在就跳过（不报错）
      if ((opts && opts.overwrite) === false && fs.existsSync(target)) continue;

      // 数据起点只能从本地文件头算（中央目录的 nameLen/extraLen 可能与本地头不同）
      const lh = Buffer.allocUnsafe(30);
      readExact(fd, lh, 30, e.lho);
      if (lh.readUInt32LE(0) !== SIG_LOCAL) throw new Error('本地文件头损坏：' + e.name);
      const dataStart = e.lho + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);

      if (!e.csize) { fs.writeFileSync(target, Buffer.alloc(0)); continue; }
      if (e.method !== 0 && e.method !== 8) {
        throw new Error('不支持的压缩方式 ' + e.method + '：' + e.name);
      }
      const rs = fs.createReadStream(file, { start: dataStart, end: dataStart + e.csize - 1 });
      const ws = fs.createWriteStream(target);
      if (e.method === 0) await pipeline(rs, counter(), ws);
      else await pipeline(rs, zlib.createInflateRaw(), counter(), ws);
      report(false);   // 条目很多（MIROS 1.2 万条）时只在节流窗口内上报，别把 IPC 打满
    }
    report(true);      // 收尾必报一次，进度条才能到 100%
  } finally {
    try { fs.closeSync(fd); } catch (_) { /* fd 已关闭 / 进程退出中，无补救动作 */ }
  }
}

/**
 * 按路径安全解压（异步）。小包仍交给 adm-zip（保持它的编码/权限行为），
 * 大包走流式 —— 两者共用同一份校验规则。
 *
 * @param {string} file
 * @param {string} dest
 * @param {{maxEntries?:number, maxTotalBytes?:number, overwrite?:boolean, forceStream?:boolean,
 *          streamThreshold?:number, onProgress?:(done:number,total:number,count:number)=>void}} [opts]
 * @returns {Promise<{ok:boolean, stage?:'check'|'extract', error?:string, count?:number, bytes?:number, streamed?:boolean}>}
 */
async function safeExtractFile(file, dest, opts) {
  const threshold = (opts && opts.streamThreshold) || DEFAULT_STREAM_THRESHOLD;
  let entries;
  try {
    entries = readCentralDirectory(file).entries;
  } catch (e) {
    return { ok: false, stage: 'check', error: '读取压缩包条目失败：' + errorOf(e), count: 0, bytes: 0 };
  }
  const check = validateEntries(entries, dest, opts);
  if (!check.ok) return { ok: false, stage: 'check', error: check.error, count: 0, bytes: 0 };

  const size = (() => { try { return fs.statSync(file).size; } catch (_) { return 0; } })();
  const streamed = (opts && opts.forceStream) || size > threshold;
  try {
    if (!streamed) {
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(file);
      zip.extractAllTo(dest, (opts && opts.overwrite) !== false);
    } else {
      await extractStream(file, entries, dest, opts || {});
    }
  } catch (e) {
    return { ok: false, stage: 'extract', error: '解压失败：' + errorOf(e), count: 0, bytes: 0, streamed };
  }
  return { ok: true, stage: 'ok', count: check.count, bytes: check.bytes, streamed };
}

/**
 * 校验通过才解压的 `extractAllTo`（同步，历史签名）。
 *
 * @param {import('adm-zip')|string} input AdmZip 实例 **或** 压缩包路径
 * @param {string} dest
 * @param {{maxEntries?:number, maxTotalBytes?:number, overwrite?:boolean}} [opts]
 * @returns {{ok:boolean, error?:string, count?:number, bytes?:number}}
 */
function safeExtractAllTo(input, dest, opts) {
  let zip = input;
  if (typeof input === 'string') {
    const stat = (() => { try { return fs.statSync(input); } catch (_) { return null; } })();
    if (!stat) return { ok: false, error: '压缩包不存在：' + input, count: 0, bytes: 0 };
    // 大包不能进 adm-zip（整包读内存）；调用方应改用异步的 safeExtractFile
    if (stat.size > DEFAULT_STREAM_THRESHOLD) {
      return { ok: false, error: '压缩包过大（' + (stat.size / 1073741824).toFixed(2) + ' GiB），请改用 safeExtractFile 流式解压', count: 0, bytes: 0 };
    }
    try {
      const AdmZip = require('adm-zip');
      zip = new AdmZip(input);
    } catch (e) {
      return { ok: false, error: '读取压缩包失败：' + errorOf(e), count: 0, bytes: 0 };
    }
  }
  const check = inspectEntries(zip, dest, opts);
  if (!check.ok) return check;
  try {
    zip.extractAllTo(dest, (opts && opts.overwrite) !== false);
  } catch (e) {
    return { ok: false, error: '解压失败：' + errorOf(e), count: 0, bytes: 0 };
  }
  return { ok: true, count: check.count, bytes: check.bytes };
}

module.exports = {
  inspectEntries, validateEntries, readCentralDirectory,
  safeExtractAllTo, safeExtractFile, extractStream,
  DEFAULT_MAX_ENTRIES, DEFAULT_MAX_TOTAL_BYTES, DEFAULT_STREAM_THRESHOLD,
};
