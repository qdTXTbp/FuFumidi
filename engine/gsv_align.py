# -*- coding: utf-8 -*-
"""GPT-SoVITS 逐句重合成之后的**对齐与客观量** —— 时长拉伸 + F0 校正 + 度量。

## 为什么需要它

本地 vendored 的 GPT-SoVITS 是**纯 TTS**：`SoVITS.infer(ssl, y, text, …)` **没有 F0 入口**，
旋律只能由「参考音频的 mel」带出来。路线 A+ 的做法是：

    原唱这一句 → 当参考音 → 重合成（旋律/节奏跟着原唱）→ 再校正 → 拿音色

重合成出来的东西**近似**跟着原唱，但有两个必然偏差：

1. **时长**：TTS 的输出长度由语义 token 数决定，与原句差几到几十个百分点
   → 必须拉伸到目标区间，否则整首歌的歌词会越唱越偏（串行累积）。
2. **音高**：参考音的 mel 只是"提示"，F0 轮廓会漂（尤其长句、滑音、转音）
   → 用 WORLD（pyworld）把输出的 F0 换成参考音的 F0，保留音色（sp/ap 不动）。

★ 降级链是**有意的**：没有 pyworld 就只做时长对齐，并把
  `f0_corrected=False` 写进结果 —— 不假装校正过。

## 客观量（用来判断「这一句到底像不像」）

* `f0_corr`：输出与参考的 F0 轮廓相关（对数音高域、只取双方都有声的帧）
* `dur_ratio`：拉伸前后时长比
* `mfcc_dist_ref` / `mfcc_dist_voice`：MFCC 均值距离 —— 前者小表示"唱得像原唱"，
  后者小表示"像声库参考音"（音色）。**这两个是打架的**，A+ 要的是
  「f0_corr 高（旋律像）+ mfcc_dist_voice 小（音色是目标）」。

★ 判定门（`gate`）：`f0_corr >= 0.6` 认为路线 A 成立；`< 0.3` 说明参考音没能带出旋律，
  应换路线 B（专门的 SVC）。这是**决策依据**，不是打分。
"""

import os
from typing import Dict, Optional, Tuple

import numpy as np

#: 拉伸上限（超过就说明参考音选错了，硬拉只会出电音）
MAX_STRETCH = 1.6
#: 默认分析帧移（与 pyworld 的 frame_period=5ms 对齐）
FRAME_MS = 5.0


def load_mono(path: str) -> Tuple[np.ndarray, int]:
    """读成单声道 float32（`(y, sr)`）。"""
    import soundfile as sf
    y, sr = sf.read(path, always_2d=True)
    return np.ascontiguousarray(y.mean(axis=1).astype(np.float32)), int(sr)


def save_mono(path: str, y, sr: int) -> str:
    import soundfile as sf
    d = os.path.dirname(path)
    if d:
        os.makedirs(d, exist_ok=True)
    sf.write(path, np.asarray(y, dtype=np.float32), int(sr))
    return path


def resample(y, sr: int, target_sr: int):
    """重采样（librosa；只差几十 Hz 时也走它，保证长度按比例正确）。"""
    if sr == target_sr:
        return np.asarray(y, dtype=np.float32)
    import librosa
    return librosa.resample(np.asarray(y, dtype=np.float32), orig_sr=sr, target_sr=target_sr)


def rms(x) -> float:
    a = np.asarray(x, dtype=np.float32)
    return float(np.sqrt(np.mean(a * a))) if a.size else 0.0


# ---------------------------------------------------------------- F0

def f0_curve(y, sr: int, fmin: float = 65.0, fmax: float = 1000.0,
             hop: int = 256, n_fft: int = 2048):
    """pyin 的 F0 曲线（Hz，无声帧是 nan）。"""
    import librosa
    y = np.asarray(y, dtype=np.float32)
    if y.size < n_fft * 2:
        return np.zeros(0, dtype=np.float32)
    # 先带通到 120–1000Hz 再 pyin：实测能把分离残留的低频伴奏/齿音对 F0 的干扰压下去
    S = np.abs(librosa.stft(y, n_fft=n_fft, hop_length=hop))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=n_fft)
    band = ((freqs >= 120) & (freqs <= 1200)).astype(np.float32)
    yb = librosa.istft(S * band[:, None], hop_length=hop, length=len(y))
    f0, _voiced, _p = librosa.pyin(yb, fmin=fmin, fmax=fmax, sr=sr,
                                   frame_length=n_fft, hop_length=hop, fill_na=np.nan)
    return np.asarray(f0, dtype=np.float32)


def f0_corr(a, b) -> float:
    """两个 F0 曲线的相关（对数音高域，只取双方都有声的帧）。无效 → -1。"""
    a = np.asarray(a, dtype=np.float64)
    b = np.asarray(b, dtype=np.float64)
    n = min(len(a), len(b))
    if n < 20:
        return -1.0
    a, b = a[:n], b[:n]
    m = np.isfinite(a) & np.isfinite(b) & (a > 0) & (b > 0)
    if int(m.sum()) < 20:
        return -1.0
    la, lb = np.log2(a[m]), np.log2(b[m])
    if la.std() < 1e-6 or lb.std() < 1e-6:
        return -1.0
    return float(np.corrcoef(la, lb)[0, 1])


def denoise_ref(x, sr: int, prop: float = 1.6):
    """参考音谱减降噪 —— **实测把输出的「沙沙声」砍掉一半**。

    为什么必须做：逐句合成的参考音是**分离出来的人声**，里面带着分离残留的宽带底噪；
    GPT-SoVITS 会把这个底噪连同音色一起学进输出。同一句、同一权重，只把参考音降噪：
    输出谱平坦度 0.235 → 0.116（越低越不「沙」；原唱本身是 0.013）。
    用最静的一成帧估底噪，再做谱减（纯 librosa，不引新依赖）。
    """
    import librosa
    n = 1024
    S = librosa.stft(np.asarray(x, dtype=np.float32), n_fft=n, hop_length=n // 4)
    mag, ph = np.abs(S), np.angle(S)
    e = mag.mean(axis=0)
    thr = np.percentile(e, 12)
    sel = e <= max(thr, float(e.min()) + 1e-9)
    if not sel.any():
        return np.asarray(x, dtype=np.float32)
    noise = np.median(mag[:, sel], axis=1, keepdims=True)
    clean = np.maximum(mag - prop * noise, mag * 0.08)
    return librosa.istft(clean * ph, hop_length=n // 4, length=len(x)).astype(np.float32)


def norm_curve(curve, n: int = 200):
    """把 F0 曲线在**有声跨度**上重采样成 n 点（时间归一化）。

    ★ 为什么要归一化：整段拉伸（fit_duration）本来就会让两条轮廓在时间轴上错开，
      逐帧直接相关会把「同一段旋律、只是快慢不同」判成不相关（实测 -0.4）。
      归一化之后量的是**旋律形状**（相对音高走向），与快慢无关 —— 这才是路线 A 要证的。
    """
    c = np.asarray(curve, dtype=np.float64)
    good = np.isfinite(c) & (c > 0)
    if int(good.sum()) < 10:
        return None
    idx = np.flatnonzero(good)
    seg = c[idx[0]:idx[-1] + 1]
    x = np.arange(len(seg))
    g = np.isfinite(seg) & (seg > 0)
    v = np.interp(x, x[g], seg[g])
    return np.interp(np.linspace(0, len(v) - 1, n), x, v)


def f0_shape_corr(out, out_sr: int, ref, ref_sr: int, n: int = 200) -> float:
    """时间归一化后的 F0 相关（拉伸不敏感）。无效 → -1。"""
    a = norm_curve(f0_curve(resample(out, out_sr, 22050), 22050), n)
    b = norm_curve(f0_curve(resample(ref, ref_sr, 22050), 22050), n)
    if a is None or b is None:
        return -1.0
    return f0_corr(a, b)


def _stretch_curve(curve, n_out: int):
    """把参考 F0 曲线在**有声帧**上线性重采样到 `n_out` 帧（无声段保持 nan）。"""
    curve = np.asarray(curve, dtype=np.float64)
    if curve.size == 0 or n_out <= 0:
        return np.full(max(0, n_out), np.nan)
    idx = np.arange(len(curve))
    good = np.isfinite(curve) & (curve > 0)
    if int(good.sum()) < 2:
        return np.full(n_out, np.nan)
    out = np.interp(np.linspace(0, len(curve) - 1, n_out), idx[good], curve[good])
    # 原曲线里"没声"的位置（首尾静音）也标成 nan，避免把静音硬唱出音高
    mask = np.interp(np.linspace(0, len(curve) - 1, n_out), idx, good.astype(np.float64)) > 0.5
    out[~mask] = np.nan
    return out


# ---------------------------------------------------------------- 时长

def fit_duration(y, sr: int, target_sec: float, max_stretch: float = MAX_STRETCH):
    """把 `y` 拉伸到 `target_sec`（相位声码器）。返回 `(y2, ratio, 实际时长)`。

    ★ 只做**整段均匀**拉伸：GPT-SoVITS 的输出与原句是同一句话，长度差主要来自语速，
      均匀拉伸就是对的；做非线性对齐（DTW）会把音节拉歪，实测更难听。
    """
    cur = len(y) / float(sr)
    if target_sec <= 0 or cur <= 0:
        return np.asarray(y, dtype=np.float32), 1.0, cur
    ratio = target_sec / cur
    if abs(ratio - 1.0) < 0.01:
        return np.asarray(y, dtype=np.float32), 1.0, cur
    ratio = float(np.clip(ratio, 1.0 / max_stretch, max_stretch))
    import librosa
    y2 = librosa.effects.time_stretch(np.asarray(y, dtype=np.float32), rate=1.0 / ratio)
    return y2.astype(np.float32), ratio, len(y2) / float(sr)


# ---------------------------------------------------------------- F0 校正

def correct_f0(y, sr: int, ref, ref_sr: int, max_shift_semitone: float = 7.0):
    """用 WORLD 把输出的 F0 换成参考音的 F0（音色/音质谱包络不动）。

    返回 `(y2, info)`；`info = {'ok': bool, 'reason': str, 'frames': int, 'shift_median': float}`。
    pyworld 缺失、采样率不一致、或参考几乎无声 → 原样返回并说明原因（**不假装做过**）。
    """
    info = {'ok': False, 'reason': '', 'frames': 0, 'shift_median': 0.0}
    try:
        import pyworld as pw
    except Exception as e:                       # noqa: BLE001
        info['reason'] = 'pyworld 不可用（%s）' % str(e)[:60]
        return np.asarray(y, dtype=np.float32), info
    y64 = np.asarray(y, dtype=np.float64)
    if y64.size < sr // 4:
        info['reason'] = '输出太短'
        return np.asarray(y, dtype=np.float32), info
    try:
        f0, sp, ap = pw.wav2world(y64, int(sr), frame_period=FRAME_MS)
    except Exception as e:                       # noqa: BLE001
        info['reason'] = 'wav2world 失败：%s' % str(e)[:60]
        return np.asarray(y, dtype=np.float32), info
    ref_r = resample(ref, ref_sr, sr) if int(ref_sr) != int(sr) else np.asarray(ref, dtype=np.float32)
    ref_curve = f0_curve(ref_r, sr, hop=max(1, int(sr * FRAME_MS / 1000.0)))
    target = _stretch_curve(ref_curve, len(f0))
    ok = np.isfinite(target) & (target > 0)
    if int(ok.sum()) < 10:
        info['reason'] = '参考音几乎没有有声帧'
        return np.asarray(y, dtype=np.float32), info
    new = f0.copy()
    # ★ 只替换**输出也有声**的帧：否则会把辅音/气声硬变成浊音（听感是"机械"）
    voiced = new > 0
    use = ok & voiced
    if not use.any():
        info['reason'] = '输出没有可替换的有声帧'
        return np.asarray(y, dtype=np.float32), info
    shift = 12.0 * np.log2(np.maximum(target[use], 1e-6) / np.maximum(new[use], 1e-6))
    shift = np.clip(shift, -max_shift_semitone, max_shift_semitone)
    new[use] = new[use] * (2.0 ** (shift / 12.0))
    info['frames'] = int(use.sum())
    info['shift_median'] = float(np.median(shift))
    try:
        out = pw.synthesize(new, sp, ap, int(sr), frame_period=FRAME_MS)
    except Exception as e:                       # noqa: BLE001
        info['reason'] = 'synthesize 失败：%s' % str(e)[:60]
        return np.asarray(y, dtype=np.float32), info
    info['ok'] = True
    info['reason'] = 'WORLD F0 校正（替换 %d 帧，中位偏移 %.2f 半音）' % (info['frames'], info['shift_median'])
    return np.asarray(out, dtype=np.float32), info


# ---------------------------------------------------------------- 电平

def match_level(y, ref, max_db: float = 8.0):
    """把 `y` 的 RMS 拉到 `ref` 的 RMS（限幅 ±max_db）。

    ★ 逐句做：TTS 每句的响度并不一致，不配平的话成品里会「一句响一句轻」
      —— 这正是用户说的「词语不连贯」的一种来源。
    """
    a = np.asarray(y, dtype=np.float32)
    r0, r1 = rms(a), rms(ref)
    if r0 <= 1e-6 or r1 <= 1e-6:
        return a, 0.0
    db = float(np.clip(20.0 * np.log10(r1 / r0), -max_db, max_db))
    return (a * (10.0 ** (db / 20.0))).astype(np.float32), db


def fade_edges(y, sr: int, ms: float = 15.0):
    a = np.asarray(y, dtype=np.float32).copy()
    n = min(int(sr * ms / 1000.0), len(a) // 2)
    if n > 0:
        ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
        a[:n] *= ramp
        a[-n:] *= ramp[::-1]
    return a


# ---------------------------------------------------------------- 度量

def mfcc_mean(y, sr: int, n_mfcc: int = 20):
    import librosa
    if len(y) < 2048:
        return np.zeros(n_mfcc, dtype=np.float32)
    M = librosa.feature.mfcc(y=np.asarray(y, dtype=np.float32), sr=sr, n_mfcc=n_mfcc)
    return M.mean(axis=1).astype(np.float32)


def mfcc_dist(a, b) -> float:
    return float(np.linalg.norm(np.asarray(a) - np.asarray(b)))


def metrics(out, out_sr: int, ref, ref_sr: int, voice_ref=None, voice_sr: int = 0) -> Dict:
    """一套客观量（见模块说明）。`voice_ref` 是声库自带的参考音，用来量"音色像不像目标"。"""
    o = resample(out, out_sr, 22050)
    r = resample(ref, ref_sr, 22050)
    d = {'dur_out': round(len(out) / float(out_sr), 3),
         'dur_ref': round(len(ref) / float(ref_sr), 3)}
    d['f0_corr'] = round(f0_corr(f0_curve(o, 22050), f0_curve(r, 22050)), 3)
    # ★ 决策看的是**时间归一化**后的相关（见 norm_curve）：拉伸不敏感，量的是旋律形状
    d['f0_shape'] = round(f0_shape_corr(o, 22050, r, 22050), 3)
    mo, mr = mfcc_mean(o, 22050), mfcc_mean(r, 22050)
    d['mfcc_dist_ref'] = round(mfcc_dist(mo, mr), 2)
    if voice_ref is not None and len(voice_ref):
        v = resample(voice_ref, voice_sr or out_sr, 22050)
        d['mfcc_dist_voice'] = round(mfcc_dist(mo, mfcc_mean(v, 22050)), 2)
    key = d['f0_shape'] if d['f0_shape'] > -1 else d['f0_corr']
    d['gate'] = ('A' if key >= 0.6 else ('B' if key < 0.3 else 'A?'))
    return d
