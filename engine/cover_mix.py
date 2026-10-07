# -*- coding: utf-8 -*-
"""翻唱工作流 · 混音与后期（把实测出来的规则固化）。

三条规则都有实测出处：
  1. **音量关系不拍脑袋**：用分离出来的原唱人声轨与伴奏轨量出原曲的「人声/伴奏能量比」，
     把合成人声压到同一比例（轻涟 1.169、下一个远方 0.478）。可选再叠一个清晰度提升。
  2. **配平必须在后期链之后**：EQ 会改响度（实测 +5.5dB 存在感让峰值涨 10dB），
     先配平再 EQ 会让成品人声莫名变响、和伴奏脱节。
  3. **吐字靠辅音区**：实测合成人声在 2.5–6kHz 比真人低 6~7dB（元音重、辅音弱），
     所以默认在 3.5kHz 补 +2.5dB、400Hz 收 -1dB；双延迟加厚默认关闭（会糊辅音），
     混响压到 0.95s / 9%。
  4. 每一级断言峰值合理，出问题在写盘前抛错（自写 peaking EQ 忘 a0 归一化会在静音段炸到 1e7）。
"""
import os

import numpy as np
from scipy.signal import butter, sosfiltfilt, fftconvolve

SR = 44100

#: 默认人声 EQ（频率, 增益dB, Q）——「吐字优先」预设
DEFAULT_VOCAL_EQ = [(450, -1.0, 1.0), (3500, 2.5, 0.9)]


def load_mono(path, sr=SR):
    import soundfile as sf
    y, s = sf.read(path, always_2d=True)
    x = y.mean(axis=1).astype('float64')
    if s != sr:
        import librosa
        x = librosa.resample(x, orig_sr=s, target_sr=sr)
    return x


def biquad_sos(kind, f0, gain_db=0.0, q=1.0, sr=SR):
    """RBJ 双二阶（按 a0 归一化）→ SOS 一行。"""
    A = 10 ** (gain_db / 40.0)
    w0 = 2 * np.pi * f0 / sr
    cw, sw = np.cos(w0), np.sin(w0)
    alpha = sw / (2 * q)
    if kind == 'peak':
        b0, b1, b2 = 1 + alpha * A, -2 * cw, 1 - alpha * A
        a0, a1, a2 = 1 + alpha / A, -2 * cw, 1 - alpha / A
    elif kind == 'highshelf':
        beta = 2 * np.sqrt(A) * alpha
        b0 = A * ((A + 1) + (A - 1) * cw + beta)
        b1 = -2 * A * ((A - 1) + (A + 1) * cw)
        b2 = A * ((A + 1) + (A - 1) * cw - beta)
        a0 = (A + 1) - (A - 1) * cw + beta
        a1 = 2 * ((A - 1) - (A + 1) * cw)
        a2 = (A + 1) - (A - 1) * cw - beta
    else:
        raise ValueError(kind)
    return np.array([[b0 / a0, b1 / a0, b2 / a0, 1.0, a1 / a0, a2 / a0]])


def band_shares(path, sr=SR):
    """返回 (200-1k, 1k-2.5k, 2.5k-6k) 三段能量占比 —— 用来核对吐字（辅音区）。"""
    import librosa
    x = load_mono(path, sr)
    S = np.abs(librosa.stft(x, n_fft=2048, hop_length=512)) ** 2
    f = librosa.fft_frequencies(sr=sr, n_fft=2048)
    tot = S[(f >= 100) & (f <= 10000)].sum() + 1e-12
    return np.array([S[(f >= 200) & (f <= 1000)].sum(),
                     S[(f >= 1000) & (f <= 2500)].sum(),
                     S[(f >= 2500) & (f <= 6000)].sum()]) / tot


def mix_song(dry_paths, inst_path, orig_vocal_path, out_wav, sung_regions,
             vocal_eq=None, inst_eq=None, vocal_boost_db=2.0, doubling=False,
             reverb_sec=0.95, reverb_wet=0.09, log=print):
    """干声（可多段，同一时间轴） + 伴奏 → 成品 WAV。返回统计字典。"""
    import soundfile as sf

    drys = [load_mono(p) for p in dry_paths]
    inst = load_mono(inst_path)
    orig = load_mono(orig_vocal_path)
    n = max([len(inst)] + [len(d) for d in drys])
    dry = np.zeros(n)
    for d in drys:
        pad = np.zeros(n); pad[:len(d)] = d; dry += pad
    inst = np.pad(inst, (0, max(0, n - len(inst))))
    orig = np.pad(orig, (0, max(0, n - len(orig))))
    # ★ 句间静音闸：逐句合成的干声在**句子之间**也有低电平底噪（模型输出 + 分离残留），
    #   而后面的压缩（×1.25）、吐字 EQ（3.5kHz +2.5dB）与混响会把它一起抬起来 ——
    #   听感就是「一直有电流声/沙沙声」。演唱区间是已知的，把区间外压掉即可（20ms 淡入淡出）。
    if len(sung_regions):
        keep = np.zeros(n, dtype=np.float32)
        for a, b in sung_regions:
            keep[max(0, int((float(a) - 0.05) * SR)):min(n, int((float(b) + 0.18) * SR))] = 1.0
        ramp = int(0.02 * SR)
        if ramp > 1:
            keep = np.convolve(keep, np.ones(ramp, dtype=np.float32) / ramp, mode='same')
        dry = dry * np.clip(keep, 0.0, 1.0)

    def rms_regions(x):
        parts = [x[int(a * SR):int(b * SR)] for a, b in sung_regions if int(b * SR) <= len(x)]
        if not parts:
            return float(np.sqrt(np.mean(x ** 2) + 1e-20))
        return float(np.sqrt(np.mean(np.concatenate(parts) ** 2) + 1e-20))

    def guard(x, stage):
        pk = float(np.max(np.abs(x)))
        if not np.isfinite(pk) or pk > 20:
            raise RuntimeError('后期链在「%s」爆掉（peak=%.3g）' % (stage, pk))
        return x

    x = guard(dry, '载入')
    parts = [butter(2, 85 / (SR / 2), btype='high', output='sos')]
    for f0, g, q in (vocal_eq if vocal_eq is not None else DEFAULT_VOCAL_EQ):
        parts.append(biquad_sos('peak', f0, g, q))
    x = guard(sosfiltfilt(np.vstack(parts), x), 'EQ')
    win = int(0.010 * SR)
    env = np.sqrt(np.convolve(x ** 2, np.ones(win) / win, mode='same') + 1e-12)
    thr = 10 ** (-18 / 20)
    g = np.ones_like(env)
    over = env > thr
    g[over] = (thr + (env[over] - thr) / 3.0) / env[over]
    rel = int(0.120 * SR)
    g = np.convolve(g, np.ones(rel) / rel, mode='same')
    x = guard(x * g * 1.25, '压缩')
    if doubling:
        d1 = np.concatenate([np.zeros(int(0.013 * SR)), x])[:len(x)]
        d2 = np.concatenate([np.zeros(int(0.027 * SR)), x])[:len(x)]
        x = guard(x + 0.15 * d1 + 0.10 * d2, '加厚')
    rng = np.random.default_rng(11)
    ir_len = int(reverb_sec * SR)
    t = np.arange(ir_len) / SR
    ir = rng.standard_normal(ir_len) * np.exp(-2.6 * t)
    ir[:int(0.025 * SR)] = 0
    ir /= np.sqrt(np.sum(ir ** 2))
    wet = fftconvolve(x, ir, mode='full')[:len(x)]
    x = guard((1 - reverb_wet) * x + reverb_wet * wet / max(1e-9, np.max(np.abs(wet))) * np.max(np.abs(x)), '混响')

    r_inst, r_orig, r_now = rms_regions(inst), rms_regions(orig), rms_regions(x)
    boost = 10 ** (float(vocal_boost_db or 0) / 20.0)
    adj = (r_inst * (r_orig / max(1e-9, r_inst)) * boost) / max(1e-9, r_now)
    x = x * adj
    for f0, g2, q in (inst_eq if inst_eq is not None else [(3200, -1.5, 0.8)]):
        inst = sosfiltfilt(biquad_sos('peak', f0, g2, q), inst)
    mix = inst + x
    mix = mix / max(1e-9, float(np.max(np.abs(mix)))) * 0.891
    sf.write(out_wav, np.stack([mix, mix], axis=1).astype('float32'), SR)
    dry_out = x / max(1e-9, float(np.max(np.abs(x)))) * 0.7
    dry_wav = os.path.splitext(out_wav)[0] + '_干声.wav'
    sf.write(dry_wav, np.stack([dry_out, dry_out], axis=1).astype('float32'), SR)
    stats = {'seconds': round(len(mix) / SR, 1), 'peak': round(float(np.max(np.abs(mix))), 3),
             'orig_vocal_over_inst': round(r_orig / max(1e-9, r_inst), 3),
             'level_match_db': round(20 * np.log10(adj), 2),
             'clarity_boost_db': round(20 * np.log10(boost), 2),
             'dry': dry_wav}
    log('混音：原曲人声/伴奏 %(orig_vocal_over_inst)s，配平 %(level_match_db)s dB（其中清晰度 %(clarity_boost_db)s dB），'
        '成品 %(seconds)s 秒，峰值 %(peak)s' % stats)
    return stats
