// oto.ini 文本编码：Shift-JIS（CP932）与 UTF-8
//
// 为什么需要它：UTAU 传统声库的 oto.ini 是 Shift-JIS，导出成 UTF-8 进 UTAU 就是乱码
// （UTAU 不看 BOM，也不做编码嗅探）。而渲染进程里 TextEncoder **只会出 UTF-8**，
// 浏览器也不提供 Shift-JIS 编码器（只有解码器 TextDecoder('shift_jis')）——
// 于是这里带一张由 Python 的 cp932 编解码表导出的映射表（./shift_jis_table.js，生成文件，不要手改）。
//
// 覆盖：JIS X 0208 + NEC 特殊字符（①〜⑳、㈱ 等）+ IBM 扩展 + 半角片假名 + 全角英数；
// ASCII（<0x80）直通。**没收录的字符（例如简体汉字「你」）编码成 '?'**——
// 导出前用 otoUnsupported() 提示用户，别让它悄悄变成问号。
//
// 验证方式（安装版实测）：把编码结果交给**同一个页面的** TextDecoder('shift_jis') 解回来，
// 必须与原字符串逐字相等；再对若干已知字断言字节（あ=82A0、ア=8341、漢=8ABF、ー=815B）。
import { SJIS1_B64, SJIS1_UNI, SJIS2_B64, SJIS2_UNI } from './shift_jis_table.js';

function b64ToBytes(b64) {
  let bin;
  if (typeof atob === 'function') bin = atob(b64);
  else bin = Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i) & 0xFF;
  return out;
}

function buildMap(uni, width) {
  const bytes = b64ToBytes(width === 1 ? SJIS1_B64 : SJIS2_B64);
  const m = new Map();
  for (let i = 0; i < uni.length; i++) {
    const v = width === 1 ? bytes[i] : ((bytes[i * 2] << 8) | bytes[i * 2 + 1]);
    m.set(uni.charCodeAt(i), v);
  }
  return m;
}

const M2 = buildMap(SJIS2_UNI, 2);   // 双字节（汉字、假名、全角符号）
const M1 = buildMap(SJIS1_UNI, 1);   // 单字节（半角片假名、¥、‾ 等）

/** 可选编码。id 会写进 localStorage（fufumidi_oto_enc） */
export const OTO_ENCODINGS = [
  { id: 'sjis', label: 'Shift-JIS', hint: 'UTAU 传统声库（推荐）' },
  { id: 'utf8', label: 'UTF-8', hint: 'OpenUtau / 现代工具' },
];

export function isOtoEncoding(id) { return id === 'utf8' || id === 'sjis'; }

export function encodeShiftJis(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80) { out.push(cp); continue; }
    const b2 = M2.get(cp);
    if (b2 !== undefined) { out.push((b2 >> 8) & 0xFF, b2 & 0xFF); continue; }
    const b1 = M1.get(cp);
    if (b1 !== undefined) { out.push(b1); continue; }
    out.push(0x3F);                       // '?'
  }
  return Uint8Array.from(out);
}

export function encodeOtoText(text, enc = 'sjis') {
  const s = String(text == null ? '' : text);
  return enc === 'utf8' ? new TextEncoder().encode(s) : encodeShiftJis(s);
}

/** 回读（验收与导入都用它）：浏览器自带 shift_jis 解码器就是 CP932 */
export function decodeOtoBytes(bytes, enc = 'sjis') {
  return new TextDecoder(enc === 'utf8' ? 'utf-8' : 'shift_jis').decode(bytes);
}

/** 这个编码下编不出来的字符（去重，最多 12 个）——导出前提示用 */
export function otoUnsupported(text) {
  const miss = [];
  for (const ch of String(text == null ? '' : text)) {
    const cp = ch.codePointAt(0);
    if (cp < 0x80 || M2.has(cp) || M1.has(cp)) continue;
    if (miss.indexOf(ch) < 0) miss.push(ch);
    if (miss.length >= 12) break;
  }
  return miss;
}

/** 自检用：表里有多少条映射 */
export function sjisTableInfo() { return { two: M2.size, one: M1.size }; }
