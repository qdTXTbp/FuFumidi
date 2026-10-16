# -*- coding: utf-8 -*-
"""转录前的音频链：高通 → 降噪 → 电平统一（2026-10-15「噪声 → 密集假音符」方案 A / B）。

**实测依据**（数据与实验台在 _attic/tmp，回归用例见 engine/tests/test_audio_chain.py）：

1. 干净素材逐级注入噪声：SNR 24/18/12 dB 只让音符数 +5~13%，**SNR 6 dB 时 +95~187%**（100 → 287）。
   而**纯噪声段**（演唱会最安静的两段 −42 / −30 dBFS）是 **0 个音符** —— 造音符的是
   「噪声混在音乐里」，不是静音段乱出音。
2. 同一段现场录音**只差 6 dB 电平**：音符数 69 → 249（3.6×）；干净素材 ±12 dB 只浮动 ±30%。
   → 素材电平是个完全不受控的变量，必须钉住（恒定归一）。
3. 旧谱减法（取前 0.3 秒估噪、无谱底）把一段现场音乐从 69 个音符变成 **0 个**，
   把电平归回原值后仍是 0 → 它不是降噪，是**毁音频**。所以噪声谱要从「最安静的帧」估，
   并且留谱底，否则过减出来的音乐噪声反而更像起音。

顺序不可换：**高通去隆隆声 → 降噪 → 电平归一**（归一放最后，把前面所有电平副作用一起吸收）。

三个入口：`process_wav_inplace`（文件，muscriptor/basic 用）、`process_array_inplace`（数组，钢琴用）、
`measure` / `advice`（体检 + 建议，转录前就会打进运行日志）。
"""

import os
import shutil
import tempfile
import time

#: 降噪档位。off=不处理；light=改进版谱减法；strong=真去噪模型（需要模型文件）。
DENOISE_MODES = ('off', 'light', 'strong')
#: 送入引擎的目标电平（RMS）。固定值 = 素材电平不再影响结果规模。
#: ★ 取 −16 dBFS 而不是拍脑袋的 −20：常见商业成品的 RMS 就在 −14 ~ −16 dBFS，
#:   取同一档 → **正常素材几乎不变**（不制造惊喜），只把偏低的素材抬到同一档。
#:   实测：现场音乐段 −14.4 dBFS（音符 69）、注噪素材 −15.4 dBFS（音符 287），
#:   两者都在这一档附近，所以钉住它之后结果可复现、可比较。
TARGET_RMS_DBFS = -16.0
#: 高通拐点：去隆隆声 / 手持风噪（实测单独用会把音符数 69→220，所以只作为链路的一环）
HP_HZ = 45.0
#: 归一的最大增益（防止把近乎静音的素材放大成一堆量化噪声）
MAX_GAIN_DB = 18.0
#: 安静段「高频占比」偏高时给一句可操作提示（**不是自动判据** —— 见 measure 的说明）
HISS_HINT = 0.10
#: 整段电平低于此值视为「几乎没有内容」
SILENT_DBFS = -60.0


def resolve_mode(params):
    """降噪档位：denoise_mode 优先；兼容旧的 denoise: bool（true → light）。"""
    p = params or {}
    m = str(p.get('denoise_mode') or '').strip().lower()
    if m in DENOISE_MODES:
        return m
    return 'light' if p.get('denoise') else 'off'


def _log(cb, msg):
    if cb:
        try:
            cb(msg)
        except Exception:
            pass


def _dbfs(x):
    import math
    return 20.0 * math.log10(max(float(x), 1e-9))


def measure(wav, sr, nperseg=1024, noverlap=768, quiet_frac=0.2):
    """音频体检：噪声底 / 动态范围 / 峰值 / 削波 / 安静段高频占比（**只报数据，不自动判定**）。

    ★ 为什么「不自动判定」——试过三条路子，都会被真实音乐骗：
      ① 帧 RMS 的 p10/p95 差（想当 SNR）：干净素材 8.9 dB、注了 SNR 6 dB 噪声的 6.8 dB ——
         它量的是**音乐自己的动态**，不是噪声，完全无判别力；
      ② 全带谱平坦度：44.1kHz 下很干净（干净 0.054 / 6 dB 噪声 0.778），但**采样率一变就废**
         （16kHz 解码后干净素材也涨到 0.26、现场音乐段 0.57）——引擎跑的是 16kHz，判据不能靠它；
      ③ 3kHz 以上占宽（本函数报的那个）：换采样率稳定（44.1k vs 16k 差 ≤0.03），
         合成素材能分开（干净 0.026 / 12 dB 0.060 / 6 dB 0.140），**但真实现场音乐段也是 0.138**
         —— 和 6 dB 噪声并列，所以它只能当"参考数字"，不能当"判决"。
      → 结论：体检只报事实 + 一句"要判断的话怎么判断"，档位交给用户（他听得到，我们听不到）。
    """
    import numpy as np
    x = np.asarray(wav, dtype='float32')
    base = {'noise_dbfs': -120.0, 'quiet_flatness': 0.0, 'hiss_ratio': 0.0,
            'dynamic_range_db': 0.0, 'level_dbfs': -120.0, 'peak_dbfs': -120.0,
            'clipped_pct': 0.0, 'silent': True}
    if x.size == 0:
        return base
    level = _dbfs(float(np.sqrt((x ** 2).mean()) + 1e-12))
    peak = float(np.abs(x).max())
    base.update({'level_dbfs': round(level, 1), 'peak_dbfs': round(_dbfs(peak), 1),
                 'clipped_pct': round(float((np.abs(x) >= 0.999).mean() * 100.0), 3),
                 'silent': level < SILENT_DBFS})
    try:
        from scipy.signal import stft
        _, _, Z = stft(x, fs=sr, nperseg=min(nperseg, max(64, len(x) // 2)), noverlap=noverlap)
        mag = np.abs(Z)
        if mag.size == 0:
            return base
        fe = (mag ** 2).sum(axis=0)
        k = max(1, int(quiet_frac * fe.size))
        idx = np.argsort(fe)[:k] if fe.size > 1 else np.arange(fe.size)
        q = mag[:, idx]
        freqs = np.linspace(0, sr / 2.0, mag.shape[0])
        band = (freqs >= 300.0) & (freqs <= min(6000.0, sr / 2.0))
        qb = q[band] if band.any() else q
        geo = np.exp(np.log(qb + 1e-12).mean(axis=0))
        ari = qb.mean(axis=0) + 1e-12
        quiet_lvl = _dbfs(float(np.sqrt((q ** 2).mean())))
        tot = float((q ** 2).sum()) or 1e-20
        hint_band = (freqs > 3000.0) & (freqs < sr / 2.0)
        hf = float(((q[hint_band] ** 2).sum()) / tot) if hint_band.any() else 0.0
        base.update({
            'noise_dbfs': round(quiet_lvl, 1),
            'quiet_flatness': round(float(np.mean(geo / ari)), 3),
            'hiss_ratio': round(hf, 4),
            'dynamic_range_db': round(level - quiet_lvl, 1),
        })
    except Exception:
        pass
    return base


def hiss_hint(hiss_ratio, silent=False):
    """安静段高频占比偏高 → 给一句**可操作提示**（不是判决：真实现场音乐也会偏高）。"""
    if silent:
        return None
    try:
        h = float(hiss_ratio)
    except (TypeError, ValueError):
        return None
    return 'hiss' if h >= HISS_HINT else None


def highpass(wav, sr, hz=HP_HZ):
    """四阶 Butterworth 高通。失败时原样返回（绝不因为预处理让转录失败）。"""
    try:
        import numpy as np
        from scipy.signal import butter, sosfilt
        if hz <= 0 or hz >= sr / 2.0:
            return wav
        sos = butter(4, hz / (sr / 2.0), btype='high', output='sos')
        return np.asarray(sosfilt(sos, np.asarray(wav, dtype='float32')), dtype='float32')
    except Exception:
        return wav


def _frame_energy(mag):
    import numpy as np
    return (mag ** 2).sum(axis=0)


def quiet_frame_stats(wav, sr, nperseg=1024, noverlap=768):
    """安静帧统计：返回 (动态跨度 dB, 接近噪声底的帧占比)。失败返回 (0, 0)。"""
    try:
        import numpy as np
        from scipy.signal import stft
        x = np.asarray(wav, dtype='float32')
        if len(x) < nperseg * 2:
            return 0.0, 0.0
        _, _, Z = stft(x, fs=sr, nperseg=nperseg, noverlap=noverlap)
        fe = _frame_energy(np.abs(Z))
        if fe.size < 8:
            return 0.0, 0.0
        e10 = float(np.percentile(fe, 10))
        e50 = float(np.percentile(fe, 50))
        if e10 <= 0 or e50 <= 0:
            return 0.0, 0.0
        return (round(10.0 * float(np.log10(e50 / e10)), 1),
                round(float((fe <= e10 * 2.0).mean()), 3))
    except Exception:
        return 0.0, 0.0


def can_denoise(wav, sr, min_spread_db=6.0, min_quiet_frac=0.05):
    """这段素材里有没有「可识别的安静帧」？没有就别做谱减法。

    ★ 为什么必须有这个门槛：任何基于「噪声谱」的方法在**持续音**上都会把乐音当噪声
      （持续 2 秒的正弦在最小统计里和噪声一模一样）。实测这一条把 tone+noise 的
      RMS 从 0.30 打到 0.012 —— 正是旧实现「把一段现场音乐变成 0 个音符」的机制。
      判据：帧能量中位数比 10 分位高 ≥6 dB，且接近 10 分位的帧占比 ≥5%。
      不满足就**不动音频**（由体检去建议「强」= 模型降噪，那是另一条路）。
    """
    spread_db, quiet_frac = quiet_frame_stats(wav, sr)
    return spread_db >= min_spread_db and quiet_frac >= min_quiet_frac


def denoise_spectral(wav, sr, alpha=1.5, floor=0.12, nperseg=1024, noverlap=768):
    """改进版谱减法：噪声谱取**安静帧**，用软增益（Wiener 式）并留增益下限 floor。

    与旧实现（旧版 preprocess.denoise）的差别：
      · 旧：噪声谱 = 前 0.3 秒的平均幅度 → 开头不是静音就整段跑偏；
      · 旧：max(mag - k*noise, 0) 无谱底 → 过减后残留孤立峰（音乐噪声），反而更像起音；
      · 新：① 先过 can_denoise 门槛（持续音不动它，见上）；
            ② 噪声谱 = 接近噪声底的那批帧；③ 增益下限 floor（−18 dB）保住谐波结构。
    实测：旧实现在一段现场音乐上把 69 个音符变成 0 个（电平归回后仍是 0）。
    """
    try:
        import numpy as np
        from scipy.signal import stft, istft
    except Exception:
        return wav
    x = np.asarray(wav, dtype='float32')
    if len(x) < nperseg * 2 or not can_denoise(wav, sr):
        return wav
    try:
        _, _, Z = stft(x, fs=sr, nperseg=nperseg, noverlap=noverlap)
        mag = np.abs(Z)
        phase = np.angle(Z)
        fe = _frame_energy(mag)
        if fe.size == 0:
            return wav
        e10 = float(np.percentile(fe, 10))
        idx = np.where(fe <= e10 * 2.0)[0]
        if idx.size == 0:
            return wav
        noise = mag[:, idx].mean(axis=1, keepdims=True)
        gain = np.maximum(1.0 - float(alpha) * noise / (mag + 1e-12), float(floor))
        _, out = istft((gain * mag) * np.exp(1j * phase), fs=sr, nperseg=nperseg, noverlap=noverlap)
        out = np.asarray(out[:len(x)], dtype='float32')
        if not np.isfinite(out).all():
            return wav                      # 数值异常就退回原音频，绝不输出坏数据
        return out
    except Exception:
        return wav


def normalize_level(wav, sr, target_dbfs=TARGET_RMS_DBFS, max_gain_db=MAX_GAIN_DB):
    """把 RMS 归一到固定目标（默认 −20 dBFS）并做峰值保护。返回 (wav, gain_db)。"""
    import numpy as np
    x = np.asarray(wav, dtype='float32')
    if x.size == 0:
        return x, 0.0
    rms = float(np.sqrt((x ** 2).mean()) + 1e-12)
    if rms <= 1e-6:
        return x, 0.0                        # 近乎静音：不动（放大只会得到量化噪声）
    gain_db = float(target_dbfs) - _dbfs(rms)
    gain_db = min(gain_db, float(max_gain_db))
    gain = 10.0 ** (gain_db / 20.0)
    peak = float(np.abs(x).max())
    if peak * gain > 0.99:
        gain = 0.99 / max(peak, 1e-9)
        gain_db = 20.0 * np.log10(max(gain, 1e-9))
    return (x * gain).astype('float32'), round(float(gain_db), 1)


def _dbfs(x):
    import math
    return 20.0 * math.log10(max(float(x), 1e-9))


def _resample_to(mono, sr0, sr):
    """把数组重采样到目标采样率（去噪模型大多跑 44.1kHz，而引擎要 16k）。"""
    if sr0 == sr:
        return mono, sr
    try:
        import numpy as np
        import librosa
        return np.asarray(librosa.resample(np.asarray(mono, dtype='float32'), orig_sr=sr0, target_sr=sr), dtype='float32'), sr
    except Exception:
        from preprocess import _resample
        return np.asarray(_resample(mono, sr0, sr), dtype='float32'), sr


def make_strong_runner(log_cb=None):
    """「强」档的执行器：交给 engine_msst 用去噪模型处理整段（找不到模型就返回 None）。"""
    def run(path):
        try:
            from engine_msst import denoise_file
        except Exception:
            return None
        return denoise_file(path, log_cb=log_cb)
    return run


def _write_tmp(mono, sr):
    import soundfile as sf
    fd, p = tempfile.mkstemp(prefix='fufumidi-chain-', suffix='.wav')
    os.close(fd)
    sf.write(p, mono, sr, subtype='PCM_16')
    return p


def _apply(mono, sr, params, log_cb, strong_runner, tmp_path=None):
    """链路本体：高通 → 降噪 → 归一。返回 (mono, sr, 记录)。任何一步失败都退回原音频。"""
    import numpy as np
    before = measure(mono, sr)
    mode = resolve_mode(params)
    applied = []
    own_tmp = None
    # ★ 高通**不默认启用**：2026-10-15 用「已知旋律 + 6dB 噪声」的基准测出来它是**有害的** ——
    #   加上 45Hz 高通后假音符 16 → 239（同一段音频、同一电平、过滤后 RMS 一致），
    #   在真实现场录音上也一致（69 → 220 个音符）。它本来是"去隆隆声"的好意，
    #   但实测没带来任何收益，只制造假音符。要试请显式打开（见 highpass()）。
    if mode != 'off' and os.environ.get('FUFUMIDI_HP_HZ'):
        hz = float(os.environ.get('FUFUMIDI_HP_HZ') or HP_HZ)
        mono = highpass(mono, sr, hz)
        applied.append('highpass%gHz' % hz)
    actual = mode
    if mode == 'strong':
        done = False
        if strong_runner is not None and not before['silent']:
            if tmp_path is None:
                tmp_path = _write_tmp(mono, sr)
                own_tmp = tmp_path
            try:
                new_path = strong_runner(tmp_path)
                if new_path and os.path.isfile(new_path):
                    import soundfile as sf
                    d2, sr2 = sf.read(new_path, dtype='float32', always_2d=True)
                    mono = np.asarray(d2.mean(axis=1) if d2.ndim > 1 else d2, dtype='float32')
                    sr = sr2
                    done = True
            except Exception as e:
                _log(log_cb, '[预处理] 强降噪模型失败：%s' % e)
        if done:
            applied.append('model')
        else:
            _log(log_cb, '[预处理] 强降噪不可用（没有可用的去噪模型）—— 本次按「轻」处理；'
                        '到资源中心下载「降噪 · UVR-DeNoise」后重试')
            actual = 'light'
    if actual == 'light':
        if can_denoise(mono, sr):
            mono = denoise_spectral(mono, sr)
            applied.append('spectral')
        else:
            # 诚实说明：这段素材没有可识别的安静段，谱减法无从下手（持续音会被误当噪声）
            applied.append('spectral-skipped(nonstationary)')
            _log(log_cb, '[预处理] 谱减法跳过：这段素材没有可识别的安静段'
                         '（持续音在谱减法里会被误当噪声抹掉）—— 若噪声重，请用「强」（去噪模型）')
    mono, gain_db = normalize_level(mono, sr)
    applied.append('level%+0.1fdB' % gain_db)
    if own_tmp:
        try:
            shutil.rmtree(os.path.dirname(own_tmp), ignore_errors=True)
        except Exception:
            pass
    after = measure(mono, sr)
    res = {'mode': mode, 'actual': actual, 'applied': applied, 'gain_db': gain_db,
           'before': before, 'after': after}
    _log(log_cb, '[预处理] 降噪=%s · %s' % (mode, ' + '.join(applied)))
    _log(log_cb, '[体检] 噪声底 %.1f dBFS · 动态范围 %.1f dB · 峰值 %.1f dBFS · 安静段高频占比 %.3f'
         % (before['noise_dbfs'], before['dynamic_range_db'], before['peak_dbfs'], before['hiss_ratio']))
    if mode == 'off' and hiss_hint(before['hiss_ratio'], before['silent']) == 'hiss':
        _log(log_cb, '[体检] 安静段高频占比 %.3f 偏高（宽带噪声的典型特征）—— 若安静处确实听得到嘶声/观众声，'
                     '把「降噪」设为「强」再转一次对比（实测噪声重时假音符会翻倍）' % before['hiss_ratio'])
    if before['clipped_pct'] > 0.1:
        _log(log_cb, '[预处理] 注意：原始音频有 %.2f%% 的采样点到顶（削波），降噪无法恢复' % before['clipped_pct'])
    return mono, sr, res


def process_array_inplace(mono, sr, params=None, log_cb=None, strong_runner=None):
    """数组入口（钢琴链路：音频已经在内存里）。返回处理后的数组（采样率不变）。"""
    t0 = time.perf_counter()
    out, _sr, res = _apply(mono, sr, params, log_cb, strong_runner)
    out, _ = _resample_to(out, _sr, sr)          # 去噪模型可能改了采样率，必须换回来
    res['seconds'] = round(time.perf_counter() - t0, 2)
    return out


def process_wav_inplace(path, sr, params=None, log_cb=None, strong_runner=None):
    """文件入口：就地处理一个 WAV（引擎解码出来的临时 wav）。返回体检 + 处理记录。

    `sr` 是调用方要求的采样率（muscriptor 16k / basic 22.05k）：处理后一定回到这个采样率，
    因为下游模型就是按它准备的。
    """
    import soundfile as sf
    t0 = time.perf_counter()
    data, sr0 = sf.read(path, dtype='float32', always_2d=True)
    mono = data.mean(axis=1).astype('float32') if data.ndim > 1 else data.astype('float32')
    out, sr_out, res = _apply(mono, sr0, params, log_cb, strong_runner, tmp_path=path)
    out, _ = _resample_to(out, sr_out, sr)
    sf.write(path, out, sr, subtype='PCM_16')
    res['seconds'] = round(time.perf_counter() - t0, 2)
    return res
