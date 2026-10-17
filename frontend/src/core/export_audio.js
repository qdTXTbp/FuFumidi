// ============================================================
// P0-4 音频导出核心（PCM / 位深 / dither / 限幅 / 响度）
// ============================================================
// 只做纯 DSP 与编码：输入是若干条 Float32Array（每声道一条），输出 WAV 字节或测量报告。
// 不碰 DOM / IPC / 文件系统（主进程落盘在 main/export.js），所以能在 Node 里单测。
//
// 位深约定：
//   · 16  → PCM16（可选 TPDF dither）
//   · 24  → PCM24（3 字节小端有符号）
//   · 32  → IEEE float32（WAVE format 3）
//
// 响度按 ITU-R BS.1770-4 的 K 加权（高架 + 高通两级 biquad）+ 400ms 块 / 75% 重叠 + 门限。
// 这是"够用的工程实现"：与专业表差通常 <0.3 LU；导出报告里的目标误差就是拿它量的。

const MAX_CH = 8;

function asChannels(channels) {
  if (!channels) return [];
  if (channels instanceof Float32Array) return [channels];
  if (Array.isArray(channels) && channels.length && channels[0] instanceof Float32Array) return channels;
  // 兼容 AudioBuffer
  if (channels && channels.numberOfChannels && typeof channels.getChannelData === 'function') {
    const out = [];
    for (let i = 0; i < channels.numberOfChannels; i++) out.push(channels.getChannelData(i));
    return out;
  }
  return [];
}
function clampf(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
function dbToGain(db) { return Math.pow(10, db / 20); }
function gainToDb(g) { return 20 * Math.log10(Math.max(1e-12, g)); }

/** TPDF dither 噪声（单位：LSB）：两个均匀分布相加，峰值 ±1 LSB */
export function tpdfNoise() { return (Math.random() - Math.random()); }

/* ---------------- WAV 编码 ---------------- */

/* 小工具：Latin-1 写字符串（BWF/INFO 字段规定 ASCII；中文会被截断为 '?'，避免写出非法字节） */
function latin1Bytes(s, max) {
  const str = String(s == null ? '' : s);
  const n = Math.min(max, str.length);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = str.charCodeAt(i);
    out[i] = c >= 0 && c <= 0xff ? c : 0x3f;
  }
  return out;
}
function fillString(buf, off, len, s) {
  const bytes = latin1Bytes(s, len);
  for (let i = 0; i < len; i++) buf[off + i] = bytes[i] || 0;
}
/** 构造一个 RIFF 子 chunk（含 8 字节头与偶数对齐填充） */
function riffChunk(id, payload) {
  const pad = payload.length % 2;
  const out = new Uint8Array(8 + payload.length + pad);
  const v = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) v.setUint8(i, id.charCodeAt(i));
  v.setUint32(4, payload.length, true);
  out.set(payload, 8);
  return out;
}
/** BWF bext chunk（602 字节负载；未提供的字段填 0） */
function bextChunk(meta) {
  const payload = new Uint8Array(602);
  fillString(payload, 0, 256, meta.description);        // Description
  fillString(payload, 256, 32, meta.originator);        // Originator
  fillString(payload, 288, 32, meta.originatorReference); // OriginatorReference
  fillString(payload, 320, 10, meta.originationDate);   // OriginationDate (yyyy-mm-dd)
  fillString(payload, 330, 8, meta.originationTime);    // OriginationTime (hh:mm:ss)
  const v = new DataView(payload.buffer);
  const tr = Math.max(0, Math.round(Number(meta.timeReference) || 0));
  v.setUint32(338, tr >>> 0, true);                     // TimeReferenceLow
  v.setUint32(342, Math.floor(tr / 4294967296) >>> 0, true); // TimeReferenceHigh
  v.setUint16(346, 1, true);                            // BWF version 1
  // 412-421：响度字段（0x7FFF = 未知）；这里一律未知，行尾 180 字节保留
  for (const off of [412, 414, 416, 418, 420]) v.setInt16(off, 0x7fff, true);
  return riffChunk('bext', payload);
}
/** LIST INFO chunk（INAM/IART/ISFT/ICMT/ICRD） */
function infoChunk(meta) {
  const fields = [
    ['INAM', meta.title], ['IART', meta.artist], ['ISFT', meta.software],
    ['ICMT', meta.comment], ['ICRD', meta.date],
  ].filter((x) => x[1]);
  if (!fields.length) return null;
  const sub = [];
  let bodyLen = 4;   // 'INFO'
  for (const [id, val] of fields) {
    const text = latin1Bytes(val, 512);
    const size = text.length + 1;             // 含结尾 NUL
    const pad = size % 2;
    bodyLen += 8 + size + pad;
    sub.push({ id, text, size, pad });
  }
  const out = new Uint8Array(bodyLen);
  const v = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) v.setUint8(i, 'INFO'.charCodeAt(i));
  let off = 4;
  for (const s of sub) {
    for (let i = 0; i < 4; i++) v.setUint8(off + i, s.id.charCodeAt(i));
    v.setUint32(off + 4, s.size, true);
    out.set(s.text, off + 8);
    // 结尾 NUL 与 pad 已是 0
    off += 8 + s.size + s.pad;
  }
  return riffChunk('LIST', out);
}

/**
 * 把多声道 Float32 样本编码成 WAV。
 * @param {Float32Array[]|AudioBuffer} channels
 * @param {number} sampleRate
 * @param {{bitDepth?:16|24|32, dither?:boolean, metadata?:object}} opts
 *   metadata（可选，P1-7 溯源）：{ description, originator, originatorReference,
 *   originationDate, originationTime, timeReference, title, artist, software, comment, date }
 * @returns {Uint8Array}
 */
export function encodeWav(channels, sampleRate, opts = {}) {
  const chs = asChannels(channels);
  if (!chs.length) throw new Error('encodeWav: 没有声道数据');
  if (chs.length > MAX_CH) throw new Error('encodeWav: 声道数过多');
  const sr = Math.max(1000, Math.round(sampleRate || 44100));
  const bitDepth = opts.bitDepth === 24 ? 24 : (opts.bitDepth === 32 ? 32 : 16);
  const float = bitDepth === 32;
  const dither = !!opts.dither && bitDepth === 16;
  const ch = chs.length;
  const frames = chs[0].length;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = ch * bytesPerSample;
  const dataSize = frames * blockAlign;

  const fmtPayload = new Uint8Array(16);
  const fv = new DataView(fmtPayload.buffer);
  fv.setUint16(0, float ? 3 : 1, true);           // 3 = IEEE float
  fv.setUint16(2, ch, true);
  fv.setUint32(4, sr, true);
  fv.setUint32(8, sr * blockAlign, true);
  fv.setUint16(12, blockAlign, true);
  fv.setUint16(14, bitDepth, true);
  const parts = [riffChunk('fmt ', fmtPayload)];
  const meta = opts.metadata && typeof opts.metadata === 'object' ? opts.metadata : null;
  if (meta) {
    const needBext = !!(meta.description || meta.originator || meta.originatorReference ||
      meta.originationDate || meta.originationTime || meta.timeReference);
    if (needBext) parts.push(bextChunk(meta));
    const info = infoChunk(meta);
    if (info) parts.push(info);
  }
  const extraLen = parts.reduce((a, p) => a + p.length, 0);
  const riffSize = 4 + extraLen + 8 + dataSize;
  const buf = new ArrayBuffer(8 + riffSize);
  const out = new Uint8Array(buf);
  const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, riffSize, true); ws(8, 'WAVE');
  let off = 12;
  for (const p of parts) { out.set(p, off); off += p.length; }
  ws(off, 'data'); v.setUint32(off + 4, dataSize, true);
  off += 8;
  let o2 = off;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < ch; c++) {
      let x = chs[c][i];
      if (!Number.isFinite(x)) x = 0;
      x = clampf(x, -1, 1);
      if (float) { v.setFloat32(o2, x, true); o2 += 4; continue; }
      if (bitDepth === 16) {
        let s = x * 32767;
        if (dither) s += tpdfNoise();          // TPDF 峰值 ±1 LSB，等效有效值约 0.41 LSB
        const q = Math.max(-32768, Math.min(32767, Math.round(s)));
        v.setInt16(o2, q, true); o2 += 2;
      } else {
        // 24-bit：放大到 2^23-1，写 3 字节小端；负数用二补码
        let s = Math.round(x * 8388607);
        if (s < 0) s += 16777216;
        s = Math.max(0, Math.min(16777215, s));
        v.setUint8(o2, s & 0xff); v.setUint8(o2 + 1, (s >> 8) & 0xff); v.setUint8(o2 + 2, (s >> 16) & 0xff);
        o2 += 3;
      }
    }
  }
  return new Uint8Array(buf);
}

/**
 * 解析 WAV 头（校验用）：按 chunk 扫描而不是固定偏移 —— P1-7 之后 data 前面可能有 bext/LIST，
 * 固定偏移会把 chunk 头当样本长度读错。
 */
export function decodeWavHeader(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 44) return null;
  const str = (o, l) => String.fromCharCode.apply(null, Array.from(u8.subarray(o, o + l)));
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') return null;
  const v = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let off = 12;
  let fmt = 0, channels = 0, sampleRate = 0, bits = 0, dataSize = 0, extra = [];
  while (off + 8 <= u8.length) {
    const id = str(off, 4);
    const size = v.getUint32(off + 4, true);
    const body = off + 8;
    if (id === 'fmt ' && body + 16 <= u8.length) {
      fmt = v.getUint16(body, true);
      channels = v.getUint16(body + 2, true);
      sampleRate = v.getUint32(body + 4, true);
      bits = v.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataSize = size;
    } else {
      extra.push(id);
    }
    off = body + size + (size % 2);
  }
  const bytesPerSample = bits / 8;
  return {
    format: fmt, float: fmt === 3, channels, sampleRate, bits, dataSize,
    frames: Math.floor(dataSize / (channels * bytesPerSample)), durationSec: 0,
    extraChunks: extra,
  };
}

/* ---------------- 测量 ---------------- */

/** 峰值（dBFS）；空数据返回 -Infinity */
export function measurePeakDb(channels) {
  const chs = asChannels(channels);
  let peak = 0;
  for (const c of chs) for (let i = 0; i < c.length; i++) {
    const a = Math.abs(c[i]);
    if (a > peak) peak = a;
  }
  return peak > 0 ? gainToDb(peak) : -Infinity;
}

/** RMS（dBFS，所有声道合并） */
export function measureRmsDb(channels) {
  const chs = asChannels(channels);
  let n = 0, sum = 0;
  for (const c of chs) { n += c.length; for (let i = 0; i < c.length; i++) sum += c[i] * c[i]; }
  if (!n || sum <= 0) return -Infinity;
  return gainToDb(Math.sqrt(sum / n));
}

/* K 加权：BS.1770 两级 biquad（任意采样率用 RBJ 公式重算） */
function kWeightCoeffs(fs) {
  const stage1 = (() => {
    const f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
    const A = Math.pow(10, G / 40);
    const w0 = 2 * Math.PI * f0 / fs;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const alpha = sin / (2 * Q);
    const sq = Math.sqrt(A);
    const b0 = A * ((A + 1) + (A - 1) * cos + 2 * sq * alpha);
    const b1 = -2 * A * ((A - 1) + (A + 1) * cos);
    const b2 = A * ((A + 1) + (A - 1) * cos - 2 * sq * alpha);
    const a0 = (A + 1) - (A - 1) * cos + 2 * sq * alpha;
    const a1 = 2 * ((A - 1) - (A + 1) * cos);
    const a2 = (A + 1) - (A - 1) * cos - 2 * sq * alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  })();
  const stage2 = (() => {
    const f0 = 38.13547087602444, Q = 0.5003270373238773;
    const w0 = 2 * Math.PI * f0 / fs;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const alpha = sin / (2 * Q);
    const b0 = (1 + cos) / 2, b1 = -(1 + cos), b2 = (1 + cos) / 2;
    const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
    return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
  })();
  return { stage1, stage2 };
}
function biquad(input, cf) {
  const y = new Float32Array(input.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const x0 = input[i];
    const out = cf.b0 * x0 + cf.b1 * x1 + cf.b2 * x2 - cf.a1 * y1 - cf.a2 * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = out; y[i] = out;
  }
  return y;
}

/**
 * 综合响度（ITU-R BS.1770-4 简化实现：K 加权 + 400ms 块 / 75% 重叠 + -70/-10 LU 门限）。
 * 返回 integrated LUFS（数值）；静音返回 -Infinity。
 */
export function measureLufs(channels, sampleRate) {
  const chs = asChannels(channels);
  if (!chs.length) return -Infinity;
  const fs = Math.max(8000, Math.round(sampleRate || 44100));
  const cf = kWeightCoeffs(fs);
  const weighted = chs.map((c) => biquad(biquad(c, cf.stage1), cf.stage2));
  const frames = Math.min.apply(null, weighted.map((c) => c.length));
  const block = Math.max(1, Math.round(fs * 0.4));
  const hop = Math.max(1, Math.round(fs * 0.1));
  if (frames < block) return -Infinity;

  const loud = [];
  for (let start = 0; start + block <= frames; start += hop) {
    let sum = 0;
    for (const w of weighted) {
      for (let i = start; i < start + block; i++) sum += w[i] * w[i];
    }
    const ms = sum / block;   // 每块所有声道加权功率之和（声道权重=1）
    if (ms > 1e-12) loud.push(-0.691 + 10 * Math.log10(ms));
  }
  if (!loud.length) return -Infinity;
  // 绝对门限 -70 LUFS
  let gated = loud.filter((l) => l > -70);
  if (!gated.length) return -Infinity;
  // 相对门限：绝对门限后的均值再 -10
  const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  const rel = mean(gated) - 10;
  gated = gated.filter((l) => l > rel);
  if (!gated.length) return -Infinity;
  return mean(gated);
}

/* ---------------- 限幅 / 响度归一 ---------------- */

/**
 * 前瞻式总线限幅（所有声道共用同一条增益曲线，保持声像）。
 * @returns {{channels: Float32Array[], reductionDb: number}}
 */
export function applyLimiter(channels, sampleRate, opts = {}) {
  const chs = asChannels(channels).map((c) => new Float32Array(c));
  if (!chs.length) return { channels: [], reductionDb: 0 };
  const fs = Math.max(1000, Math.round(sampleRate || 44100));
  const ceiling = dbToGain(opts.ceilingDb == null ? -1 : opts.ceilingDb);
  const lookahead = Math.max(1, Math.round(fs * ((opts.lookaheadMs == null ? 5 : opts.lookaheadMs) / 1000)));
  const release = Math.max(1, Math.round(fs * ((opts.releaseMs == null ? 100 : opts.releaseMs) / 1000)));
  const frames = Math.min.apply(null, chs.map((c) => c.length));
  const env = new Float64Array(frames);
  const relCoef = Math.exp(-1 / release);
  let e = 0;
  for (let i = 0; i < frames; i++) {
    let peak = 0;
    for (const c of chs) { const a = Math.abs(c[i]); if (a > peak) peak = a; }
    // 上升瞬间跟随（attack 由 lookahead 延迟吸收），下降用释放时间常数
    e = peak > e ? peak : relCoef * e + (1 - relCoef) * peak;
    env[i] = e;
  }
  const gain = new Float64Array(frames);
  let minGain = 1;
  for (let i = 0; i < frames; i++) {
    const g = env[i] > ceiling ? ceiling / env[i] : 1;
    gain[i] = g;
    if (g < minGain) minGain = g;
  }
  // 前瞻：把 i 的增益提前 lookahead 应用（上限 1，保证不越过 ceiling）
  for (let i = 0; i < frames; i++) {
    const gi = Math.min(gain[i], i + lookahead < frames ? gain[i + lookahead] : 1);
    for (const c of chs) c[i] *= gi;
  }
  return { channels: chs, reductionDb: minGain < 1 ? -gainToDb(minGain) : 0 };
}

/**
 * 响度归一 + 限幅；返回新声道与报告（输入/输出 LUFS、目标误差、峰值、限幅量）。
 * @param {{targetLufs:number, ceilingDb?:number, maxGainDb?:number, limiter?:boolean}} opts
 */
export function normalizeLoudness(channels, sampleRate, opts = {}) {
  const chs = asChannels(channels).map((c) => new Float32Array(c));
  const sr = Math.max(1000, Math.round(sampleRate || 44100));
  const inputLufs = measureLufs(chs, sr);
  const inputPeakDb = measurePeakDb(chs);
  const target = Number(opts.targetLufs);
  const report = { inputLufs, inputPeakDb, targetLufs: target, gainDb: 0, outputLufs: inputLufs, outputPeakDb: inputPeakDb, reductionDb: 0, errorDb: 0 };
  if (!Number.isFinite(target) || !Number.isFinite(inputLufs)) return { channels: chs, report };
  let gainDb = target - inputLufs;
  const maxGainDb = opts.maxGainDb == null ? 24 : Number(opts.maxGainDb);
  gainDb = Math.max(-60, Math.min(maxGainDb, gainDb));
  if (opts.loudnessOff) gainDb = 0;
  const g = dbToGain(gainDb);
  for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= g;
  report.gainDb = gainDb;
  let out = chs;
  if (opts.limiter !== false) {
    const lim = applyLimiter(chs, sr, { ceilingDb: opts.ceilingDb == null ? -1 : opts.ceilingDb, lookaheadMs: 5, releaseMs: 100 });
    out = lim.channels;
    report.reductionDb = lim.reductionDb;
  }
  report.outputLufs = measureLufs(out, sr);
  report.outputPeakDb = measurePeakDb(out);
  report.errorDb = report.outputLufs - target;
  return { channels: out, report };
}

/** 渲染时长（秒），按最小声道长度算 */
export function durationSec(channels, sampleRate) {
  const chs = asChannels(channels);
  if (!chs.length) return 0;
  const frames = Math.min.apply(null, chs.map((c) => c.length));
  return frames / Math.max(1, sampleRate || 44100);
}
