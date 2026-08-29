// ============================================================
// UTAU 声库制作工具（纯 JS 实现，算法与 engine/engine_utau.py 一致）
// - splitSyllables: 静音切分（10ms 帧 RMS + dB 阈值 + 短静音合并）
// - autoOtoParams:  CV 自动标注（能量定起止 + ZCR 过零率判辅音/元音边界）
// - encodeWav16:    Float32 单声道 → PCM16 WAV ArrayBuffer
// - decodeAudioData: ArrayBuffer → { data: Float32Array, sr }
// ============================================================

function r1(x) { return Math.round(x * 10) / 10; }

/** 短时 RMS 包络。返回 Float64Array，每帧一值。 */
export function frameEnv(data, sr, frameMs = 10) {
  const hop = Math.max(1, Math.round((sr * frameMs) / 1000));
  const n = data.length;
  const frames = Math.max(1, Math.floor(n / hop));
  const env = new Float64Array(frames);
  for (let i = 0; i < frames; i++) {
    const s = i * hop;
    const e = Math.min(n, s + hop);
    let sum = 0;
    for (let j = s; j < e; j++) { const v = data[j]; sum += v * v; }
    env[i] = Math.sqrt(sum / (e - s));
  }
  return env;
}

/** 按静音间隙切分音节。返回 [{ startMs, endMs }]。 */
export function splitSyllables(data, sr, opts = {}) {
  const { minSilenceMs = 120, minSyllableMs = 80, silenceDb = -40 } = opts;
  const frameMs = 10;
  const env = frameEnv(data, sr, frameMs);
  let ref = 0;
  for (let i = 0; i < env.length; i++) if (env[i] > ref) ref = env[i];
  if (ref <= 1e-9) return [];
  const thr = ref * Math.pow(10, silenceDb / 20);

  const regions = [];
  let inRun = false, start = 0;
  for (let i = 0; i < env.length; i++) {
    const v = env[i] > thr;
    if (v && !inRun) { start = i; inRun = true; }
    else if (!v && inRun) { regions.push([start, i]); inRun = false; }
  }
  if (inRun) regions.push([start, env.length]);

  const minSilF = Math.max(1, Math.round(minSilenceMs / frameMs));
  const minSylF = Math.max(1, Math.round(minSyllableMs / frameMs));
  const merged = [];
  for (const r of regions) {
    if (merged.length && (r[0] - merged[merged.length - 1][1]) < minSilF) {
      merged[merged.length - 1][1] = r[1];
    } else merged.push(r.slice());
  }
  return merged
    .filter(r => (r[1] - r[0]) >= minSylF)
    .map(r => ({ startMs: r1(r[0] * frameMs), endMs: r1(r[1] * frameMs) }));
}

/**
 * CV 音源单采样自动标注。返回 { offset, consonant, blank, preutterance, overlap }（ms）。
 * 判定：能量定有声起止；ZCR（过零率）判辅音→元音边界（噪声高、元音低）。
 */
export function autoOtoParams(data, sr) {
  const frameMs = 5;
  const hop = Math.max(1, Math.round((sr * frameMs) / 1000));
  const n = data.length;
  const frames = Math.max(1, Math.floor(n / hop));
  const env = new Float64Array(frames);
  const zcr = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const s = i * hop;
    const e = Math.min(n, s + hop);
    let sum = 0, z = 0;
    for (let j = s; j < e; j++) {
      const v = data[j];
      sum += v * v;
      if (j > s && (data[j] < 0) !== (data[j - 1] < 0)) z++;
    }
    env[i] = Math.sqrt(sum / (e - s));
    zcr[i] = z;
  }
  const defaults = () => ({ offset: 0, consonant: 50, blank: 20, preutterance: 50, overlap: 20 });
  let peak = 0;
  for (let i = 0; i < frames; i++) if (env[i] > peak) peak = env[i];
  if (peak <= 1e-12) return defaults();

  const sorted = Array.from(env).sort((a, b) => a - b);
  const floor = sorted[Math.min(frames - 1, Math.floor(frames * 0.1))] + 1e-12;
  const thr = Math.max(floor * 3, peak * 0.02);

  let start = 0;
  while (start < frames && env[start] < thr) start++;
  let end = frames - 1;
  while (end > start && env[end] < thr) end--;
  if (end <= start) return defaults();

  const vowelThr = 40;
  let run = 0, vowelStart = null;
  for (let i = start; i < frames; i++) {
    if (zcr[i] < vowelThr) {
      run++;
      if (vowelStart === null && run >= 3) vowelStart = i - run + 1;
    } else run = 0;
  }
  if (vowelStart === null) vowelStart = Math.min(start + 8, frames - 1);

  const offset = Math.max(0, start * frameMs - 10);
  const consonant = Math.max(5, (vowelStart - start) * frameMs);
  const preutterance = consonant;
  const overlap = Math.min(30, preutterance * 0.3);
  const blank = Math.max(5, (n / sr) * 1000 - (end + 1) * frameMs);
  return {
    offset: r1(offset), consonant: r1(consonant), blank: r1(blank),
    preutterance: r1(preutterance), overlap: r1(overlap),
  };
}

/** Float32 单声道（-1..1）→ PCM16 WAV 的 Uint8Array。 */
export function encodeWav16(mono, sr) {
  const n = mono.length;
  const bytesPerSample = 2;
  const dataSize = n * bytesPerSample;
  const buf = new ArrayBuffer(44 + dataSize);
  const dv = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, 'RIFF'); dv.setUint32(4, 36 + dataSize, true); writeStr(8, 'WAVE');
  writeStr(12, 'fmt '); dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sr, true); dv.setUint32(28, sr * bytesPerSample, true);
  dv.setUint16(32, bytesPerSample, true); dv.setUint16(34, 16, true);
  writeStr(36, 'data'); dv.setUint32(40, dataSize, true);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, mono[i]));
    dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

/** 解码音频为单声道 float32。 */
export async function decodeAudioData(arrayBuffer) {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) throw new Error('浏览器不支持 AudioContext');
  const ctx = new AC();
  try {
    const ab = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return { data: ab.getChannelData(0), sr: ab.sampleRate };
  } finally {
    try { ctx.close(); } catch (e) {}
  }
}

/** Uint8Array → base64（分块避免栈溢出）。 */
export function bytesToBase64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
