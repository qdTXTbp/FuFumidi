// oto.ini 解析 / 生成 / 判码（M8f 声库管理 2.0）
//
// oto.ini 一行一个原音设定：
//     wav 文件名=别名,offset,consonant,blank,preutterance,overlap
// 有的行只有 5 个数字（老文件会省掉 overlap），所以**多出来的字段一律原样保留**再写回去 ——
// 我们只改用户动过的那几个数字，其它内容一个字节都不动。
//
// 编码：UTAU 传统声库是 Shift-JIS，也有 UTF-8 的库。判定规则：
//   先按 UTF-8 严格解码，解不开（或解出替换字符 U+FFFD）就当 Shift-JIS。
//   写回时用**读进来时判定的同一种编码**，不让一次编辑把整个库的编码换掉。
import { decodeOtoBytes, encodeOtoText } from './shift_jis.js';

/**
 * @typedef {object} OtoEntry
 * @property {string} file   采样文件名（不含目录），例 "a.wav"
 * @property {string} alias  别名（引擎按歌词查的就是它）
 * @property {number} offset
 * @property {number} consonant
 * @property {number} blank
 * @property {number} preutterance
 * @property {number} overlap
 * @property {string[]} extra  第 7 个及以后的字段（原样保留）
 *
 * @typedef {object} OtoFile
 * @property {OtoEntry[]} entries
 * @property {string[]} passthrough  不是 "键=值" 的行（原样留着）
 * @property {string[]} loose        字段数不足、无法构成条目的行（原样留着）
 */

const num = (s) => {
  const v = parseFloat(String(s).trim());
  return Number.isFinite(v) ? v : 0;
};

/**
 * 解析 oto.ini 文本。
 * @param {string} text
 * @returns {OtoFile}
 */
export function parseOto(text) {
  const out = { entries: [], passthrough: [], loose: [] };
  const lines = String(text == null ? '' : text).replace(/\r\n?/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const eq = raw.indexOf('=');
    if (eq < 0) { out.passthrough.push(raw); continue; }
    const file = raw.slice(0, eq).trim();
    const rest = raw.slice(eq + 1).split(',');
    if (!file || rest.length < 2) { out.loose.push(raw); continue; }
    out.entries.push({
      file,
      alias: String(rest[0] == null ? '' : rest[0]).trim(),
      offset: num(rest[1]),
      consonant: num(rest[2]),
      blank: num(rest[3]),
      preutterance: num(rest[4]),
      overlap: rest.length > 5 ? num(rest[5]) : 0,
      extra: rest.slice(6),
      /* ★ 原始文本：有些库（实测 Iona_Beta）写的是 `0.0 / 404.9` 这种浮点串。
         若不保留原文，保存一次就会把整个文件的数字重排一遍（0.0 → 0）——
         用户只改了一个格子，diff 却是整份文件。这里记下来，没动过的字段原样吐回。 */
      raw: {
        alias: rest[0] == null ? '' : String(rest[0]),
        offset: rest.length > 1 ? String(rest[1]) : '',
        consonant: rest.length > 2 ? String(rest[2]) : '',
        blank: rest.length > 3 ? String(rest[3]) : '',
        preutterance: rest.length > 4 ? String(rest[4]) : '',
        overlap: rest.length > 5 ? String(rest[5]) : '',
      },
    });
  }
  return out;
}

/**
 * 判定行尾风格。日系 UTAU 声库的 oto.ini 常常是 CRLF，
 * **写回时必须保持原样** —— 否则用户只改了一个数字，整个文件却被换行符改了个遍（diff 满天飞）。
 * @param {string} text
 * @returns {'\r\n'|'\n'}
 */
export function detectEol(text) {
  const s = String(text == null ? '' : text);
  const crlf = (s.match(/\r\n/g) || []).length;
  const lf = (s.match(/\n/g) || []).length;
  return crlf > 0 && crlf >= lf - crlf ? '\r\n' : '\n';
}

/**
 * 生成 oto.ini 文本。
 * @param {OtoFile} file
 * @param {'\r\n'|'\n'} [eol] 行尾，默认 LF；写回时传原来那种（见 detectEol）
 * @returns {string}
 */
export function formatOto(file, eol) {
  const sep = eol === '\r\n' ? '\r\n' : '\n';
  /** 数值没被改过 → 用原文（保住 0.0 / 404.9 这类写法）；改过 → 用当前数值 */
  const pick = (e, key) => {
    const rawv = e.raw && e.raw[key];
    if (rawv != null && String(rawv).trim() !== '' && Number(rawv) === Number(e[key])) return String(rawv).trim();
    return String(e[key]);
  };
  const pickAlias = (e) => {
    const rawv = e.raw && e.raw.alias;
    if (rawv != null && String(rawv).trim() === String(e.alias)) return String(rawv).trim();
    return String(e.alias);
  };
  const lines = [];
  for (const p of (file && file.passthrough) || []) lines.push(p);
  for (const e of (file && file.entries) || []) {
    const tail = (e.extra && e.extra.length) ? ',' + e.extra.join(',') : '';
    lines.push(`${e.file}=${pickAlias(e)},${pick(e, 'offset')},${pick(e, 'consonant')},${pick(e, 'blank')},${pick(e, 'preutterance')},${pick(e, 'overlap')}${tail}`);
  }
  for (const l of (file && file.loose) || []) lines.push(l);
  return lines.length ? lines.join(sep) + sep : '';
}

/** base64 → Uint8Array */
export function b64ToBytes(b64) {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xFF;
  return out;
}

/** Uint8Array → base64（分块，避免大文件爆栈） */
export function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(bin);
}

/**
 * 判码 + 解码。
 * @param {Uint8Array} bytes
 * @returns {{ text: string, encoding: 'utf8'|'sjis', hadBom: boolean }}
 */
export function decodeOtoFile(bytes) {
  const hadBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.indexOf('\uFFFD') < 0) {
      return { text: hadBom ? text.slice(1) : text, encoding: 'utf8', hadBom };
    }
  } catch (e) { /* 不是合法 UTF-8 → 当 Shift-JIS */ }
  return { text: decodeOtoBytes(bytes, 'sjis'), encoding: 'sjis', hadBom: false };
}

/** 按指定编码出字节（写回时用读进来的那种） */
export function encodeOtoFile(text, encoding) {
  return encodeOtoText(text, encoding === 'utf8' ? 'utf8' : 'sjis');
}

/**
 * 保存前给用户看一眼改了什么。
 * @returns {{ changed: number, added: number, removed: number }}
 */
export function diffOto(before, after) {
  const key = (e) => e.file + '|' + e.alias;
  const b = new Map(((before && before.entries) || []).map((e) => [key(e), e]));
  const a = new Map(((after && after.entries) || []).map((e) => [key(e), e]));
  let changed = 0, added = 0, removed = 0;
  for (const [k, e] of a) {
    const old = b.get(k);
    if (!old) { added += 1; continue; }
    if (old.offset !== e.offset || old.consonant !== e.consonant || old.blank !== e.blank
      || old.preutterance !== e.preutterance || old.overlap !== e.overlap) changed += 1;
  }
  for (const k of b.keys()) if (!a.has(k)) removed += 1;
  return { changed, added, removed };
}
