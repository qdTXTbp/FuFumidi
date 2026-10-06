// 频谱底图（计划书 §4.3 音素工作区 / §4.7 oto 编辑器）
//
// 时域波形能看出"在哪里切分"，频域才能把辅音/元音的差别看清 —— 这是 vLabeler 那类标注工具
// 把频谱垫在波形下面的原因。这里做最朴素的一条链，不引第三方依赖：
//
//   分帧 → Hann 窗 → radix-2 FFT → 幅度取 dB（相对峰值） → 查 256 色调色板 → 位图 → 拉伸到目标矩形
//
// 实测量级：3 秒 44.1kHz 音频、N=1024、hop=256 → 约 500 帧，STFT 十几毫秒，可以在重绘里直接跑。
// 低频在下、高频在上（与所有标注工具一致）。

const PALETTE = [
  [0.00, 0x08, 0x0a, 0x12],
  [0.20, 0x16, 0x1c, 0x42],
  [0.42, 0x3b, 0x2a, 0x7a],
  [0.62, 0x8f, 0x2f, 0x7a],
  [0.80, 0xd9, 0x60, 0x3a],
  [0.92, 0xf2, 0xb1, 0x3c],
  [1.00, 0xff, 0xf4, 0xd6],
];

let LUT = null;
function lut() {
  if (LUT) return LUT;
  const t = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const v = i / 255;
    let a = PALETTE[0], b = PALETTE[PALETTE.length - 1];
    for (let k = 0; k < PALETTE.length - 1; k++) {
      if (v >= PALETTE[k][0] && v <= PALETTE[k + 1][0]) { a = PALETTE[k]; b = PALETTE[k + 1]; break; }
    }
    const span = (b[0] - a[0]) || 1;
    const f = (v - a[0]) / span;
    t[i * 3] = Math.round(a[1] + (b[1] - a[1]) * f);
    t[i * 3 + 1] = Math.round(a[2] + (b[2] - a[2]) * f);
    t[i * 3 + 2] = Math.round(a[3] + (b[3] - a[3]) * f);
  }
  LUT = t;
  return t;
}

const _fftCache = new Map();
function fftTables(n) {
  let t = _fftCache.get(n);
  if (t) return t;
  const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = Math.sin(2 * Math.PI * i / n); }
  const rev = new Uint32Array(n);
  let bits = 0;
  while ((1 << bits) < n) bits++;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
    rev[i] = r;
  }
  t = { cos, sin, rev };
  _fftCache.set(n, t);
  return t;
}

/** 原地复数 FFT（输入 re/im 长度 n，n 必须是 2 的幂） */
function fft(re, im, n) {
  const { cos, sin, rev } = fftTables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1, step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const c = cos[k * step], s = sin[k * step];
        const ur = re[i + k + half], ui = im[i + k + half];
        const vr = ur * c + ui * s, vi = -ur * s + ui * c;
        re[i + k + half] = re[i + k] - vr; im[i + k + half] = im[i + k] - vi;
        re[i + k] += vr; im[i + k] += vi;
      }
    }
  }
}

/**
 * 算一张幅度谱图。
 * @returns {{ frames:number, bins:number, db:Float32Array, sr:number, fft:number, hop:number, peak:number }}
 *          db 按帧优先存放：db[frame * bins + bin]，值域 [-floorDb, 0]（相对峰值）
 */
export function computeSpectrogram(data, sr, opts = {}) {
  const n = opts.fft || 1024;
  const bins = n / 2 + 1;
  const total = data ? data.length : 0;
  if (!total || !sr) return { frames: 0, bins, db: new Float32Array(0), sr, fft: n, hop: n / 2, peak: 0 };
  let hop = opts.hop || n / 4;
  const maxFrames = opts.maxFrames || 900;
  if (Math.floor((total - n) / hop) + 1 > maxFrames) hop = Math.max(1, Math.ceil((total - n) / (maxFrames - 1)));
  const frames = Math.max(1, Math.floor((total - n) / hop) + 1);
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  const re = new Float32Array(n), im = new Float32Array(n);
  const db = new Float32Array(frames * bins);
  let peak = 0;
  for (let f = 0; f < frames; f++) {
    const off = f * hop;
    for (let i = 0; i < n; i++) { re[i] = (data[off + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im, n);
    for (let b = 0; b < bins; b++) {
      const m = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
      db[f * bins + b] = m;
      if (m > peak) peak = m;
    }
  }
  const floorDb = opts.floorDb || 78;
  const norm = peak > 0 ? 1 / peak : 0;
  for (let i = 0; i < db.length; i++) {
    const v = db[i] * norm;
    const d = v > 0 ? 20 * Math.log10(v) : -floorDb;
    db[i] = Math.max(-floorDb, Math.min(0, d));
  }
  return { frames, bins, db, sr, fft: n, hop, peak, floorDb };
}

let _off = null;
function offscreen(w, h) {
  if (!_off) _off = document.createElement('canvas');
  if (_off.width !== w) _off.width = w;
  if (_off.height !== h) _off.height = h;
  return _off;
}

/**
 * 把谱图画进 2D 上下文。**低频在下**（第 0 个 bin 画在矩形底部）。
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} spec computeSpectrogram 的返回值
 */
export function drawSpectrogram(ctx, spec, x, y, w, h, opts = {}) {
  if (!spec || !spec.frames || !spec.bins) return false;
  const floorDb = spec.floorDb || opts.floorDb || 78;
  const cv = offscreen(spec.frames, spec.bins);
  const octx = cv.getContext('2d');
  const img = octx.createImageData(spec.frames, spec.bins);
  const px = img.data, t = lut();
  for (let f = 0; f < spec.frames; f++) {
    for (let b = 0; b < spec.bins; b++) {
      const v = 1 + spec.db[f * spec.bins + b] / floorDb;      // -floorDb → 0，0dB → 1
      const c = Math.max(0, Math.min(255, Math.round(v * 255))) * 3;
      const o = ((spec.bins - 1 - b) * spec.frames + f) * 4;    // 低频在下 → 行倒着写
      px[o] = t[c]; px[o + 1] = t[c + 1]; px[o + 2] = t[c + 2]; px[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(cv, 0, 0, spec.frames, spec.bins, x, y, w, h);
  ctx.restore();
  if (opts.grid !== false) drawFreqGrid(ctx, spec, x, y, w, h);
  return true;
}

function drawFreqGrid(ctx, spec, x, y, w, h) {
  const nyq = spec.sr / 2;
  const marks = [500, 1000, 2000, 4000, 8000, 16000].filter(f => f < nyq);
  ctx.save();
  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  for (const f of marks) {
    const yy = y + h - (f / nyq) * h;
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(x + w, yy); ctx.stroke();
    const label = f >= 1000 ? (f / 1000) + 'k' : String(f);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillText(label, x + 4, yy - 6);
  }
  ctx.restore();
}
