// 乐句级增量渲染（计划书 §4.6）
//
// ## 要解决的问题
// 调一个音就要重渲整轨。UTAU 单次渲染实测 ~0.7–1.0 秒（引擎启动占大头），
// 而用户改的往往只是**一句**——重渲整轨等于把没变的部分又算一遍。
//
// ## 做法（"乐句窗口 + 拼接"，不改引擎协议）
// 1. 按"音符间隙 > gapBeats"把轨切成乐句；
// 2. 每句的音频取整轨时间轴上的一个**窗口**（切点落在乐句之间静音的中点，
//    所以切断处本来就是静音，不会切掉字头/尾音）；
// 3. 缓存每句的字节 + 指纹（指纹 = 这句实际发给引擎的 payload + 上下文串）；
// 4. 重渲时：指纹没变的句子**直接用缓存**；变了的句子合成**一次**引擎调用
//    （payload 带绝对拍位，所以返回的音频与整轨时间轴对齐，再按窗口切出来即可）；
// 5. 把所有窗口拼回一条整轨 WAV。
//
// 全是本地解析：**不用 AudioContext**（它会按系统采样率重采样，切片偏移就全错了），
// 只认引擎实际产出的 PCM16 / float32 WAV。
import { encodeWav16 } from './utau_tools.js';

/** 相邻乐句间隔超过这个拍数就切开（1 拍 ≈ 中速下的一个字；静音间隔通常远大于它） */
export const PHRASE_GAP_BEATS = 1;

/** FNV-1a 32 位：短、稳定、够用（指纹不是安全哈希） */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * 按间隙把音符切成乐句。
 * @returns [{ startBeat, endBeat, idx }]，idx 是**在传入数组里的下标**（与发给引擎的 payload 对齐）
 */
export function splitPhrases(notes, gapBeats = PHRASE_GAP_BEATS) {
  const list = (notes || []).map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.startBeat - b.n.startBeat || a.i - b.i);
  const out = [];
  let cur = null;
  for (const { n, i } of list) {
    const end = n.startBeat + Math.max(0, n.durBeat);
    if (cur && n.startBeat - cur.endBeat <= gapBeats) {
      cur.endBeat = Math.max(cur.endBeat, end);
      cur.idx.push(i);
    } else {
      cur = { startBeat: n.startBeat, endBeat: end, idx: [i] };
      out.push(cur);
    }
  }
  return out;
}

/** 一句的指纹：把这句实际下发的 payload + 上下文串哈希掉（少发一个字段就不会误判成"没变"） */
export function phraseSignature(payloadSlice, ctxKey) {
  return fnv1a(ctxKey + '|' + JSON.stringify(payloadSlice));
}

/**
 * 每句在时间轴上的窗口（毫秒）。切点取相邻乐句之间的中点 —— 那里是静音，切了听不出来。
 * 最后一句一直延伸到整轨时长（含尾音衰减）。
 */
export function phraseWindows(phrases, bpm, totalMs) {
  const beatMs = 60000 / Math.max(1, bpm);
  const wins = [];
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i], prev = phrases[i - 1], next = phrases[i + 1];
    const startBeat = prev ? (prev.endBeat + p.startBeat) / 2 : 0;
    const endBeat = next ? (p.endBeat + next.startBeat) / 2 : p.endBeat;
    wins.push({ startMs: Math.max(0, startBeat * beatMs), endMs: Math.max(0, endBeat * beatMs) });
  }
  if (wins.length) wins[wins.length - 1].endMs = Math.max(wins[wins.length - 1].endMs, totalMs);
  return wins;
}

/** 解析 WAV（PCM16 / float32；多声道取平均）→ { sr, frames, data: Float32Array } */
export function parseWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const str = (o, n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(u8[o + i]); return s; };
  if (u8.length < 12 || str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') {
    return { sr: 44100, frames: 0, data: new Float32Array(0), bad: true };
  }
  let fmt = 1, channels = 1, sr = 44100, bits = 16, dataOff = -1, dataLen = 0;
  let o = 12;
  while (o + 8 <= u8.length) {
    const id = str(o, 4);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ') {
      fmt = dv.getUint16(body, true);
      channels = Math.max(1, dv.getUint16(body + 2, true));
      sr = dv.getUint32(body + 4, true) || 44100;
      bits = dv.getUint16(body + 14, true) || 16;
    } else if (id === 'data') {
      dataOff = body; dataLen = Math.min(size, u8.length - body);
    }
    o = body + size + (size % 2);
  }
  if (dataOff < 0 || dataLen <= 0) return { sr, frames: 0, data: new Float32Array(0), bad: true };
  const bytesPer = Math.max(1, bits >> 3);
  const frames = Math.floor(dataLen / (bytesPer * channels));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const at = dataOff + (f * channels + c) * bytesPer;
      if (fmt === 3) acc += dv.getFloat32(at, true);
      else if (bits === 16) acc += dv.getInt16(at, true) / 32768;
      else if (bits === 8) acc += (dv.getUint8(at) - 128) / 128;
      else if (bits === 32) acc += dv.getInt32(at, true) / 2147483648;
      else acc += dv.getInt16(at, true) / 32768;
    }
    out[f] = acc / channels;
  }
  return { sr, frames, data: out };
}

/** 从一次渲染结果里切出 [startMs, endMs) 这一段（越界自动夹住） */
export function sliceSegment(wav, startMs, endMs) {
  const sr = wav.sr || 44100;
  const a = Math.max(0, Math.round((startMs / 1000) * sr));
  const b = Math.min(wav.data.length, Math.round((endMs / 1000) * sr));
  const data = b > a ? wav.data.subarray(a, b) : new Float32Array(0);
  return { bytes: encodeWav16(data, sr), sr, samples: data.length, startMs, endMs };
}

/**
 * 把所有乐句窗口拼回一条整轨。
 *
 * 窗口是**不相交且首尾相接**的（切点在静音中点），所以这里用直接写入而不是求和 ——
 * 求和会把边界上重复采样叠成两倍。
 */
export function composeSegments(segments, totalMs, sr = 44100) {
  const rate = sr || 44100;
  const total = Math.max(1, Math.round((totalMs / 1000) * rate));
  const out = new Float32Array(total);
  for (const seg of segments) {
    if (!seg || !seg.bytes || !seg.bytes.length) continue;
    const w = parseWav(seg.bytes);
    const at = Math.max(0, Math.round((seg.startMs / 1000) * w.sr));
    for (let i = 0; i < w.data.length; i++) {
      const j = at + i;
      if (j >= total) break;
      out[j] = w.data[i];
    }
  }
  return encodeWav16(out, rate);
}
