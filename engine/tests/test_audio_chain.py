# -*- coding: utf-8 -*-
"""转录前音频链（engine/audio_chain.py）—— 方案 A（降噪）/ B（电平统一）/ C（体检）的地基。

实测背景（真实素材，见 _attic 实验台）：
  · 干净素材注入噪声：SNR 24/18/12 dB → 音符数 +5~13%；**SNR 6 dB → +95~187%**（100 → 287）
  · 同一段现场录音只差 6 dB 电平：音符数 69 → 249
  · 旧谱减法（前 0.3 秒估噪、无谱底）把现场音乐从 69 个音符变成 0 个
这里用合成信号把这些性质钉住，不依赖外部素材。
"""
import os
import sys

import numpy as np
import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import audio_chain as AC  # noqa: E402

SR = 16000


def _tone(seconds=2.0, freq=440.0, amp=0.3, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    return (amp * np.sin(2 * np.pi * freq * t)).astype('float32')


def _noise(seconds=2.0, amp=0.05, sr=SR, seed=0):
    rng = np.random.default_rng(seed)
    return (amp * rng.normal(0, 1, int(seconds * sr))).astype('float32')


# ---------- 档位解析 ----------

def test_resolve_mode_prefers_new_key_and_accepts_legacy_bool():
    assert AC.resolve_mode({'denoise_mode': 'strong'}) == 'strong'
    assert AC.resolve_mode({'denoise_mode': 'off'}) == 'off'
    assert AC.resolve_mode({'denoise': True}) == 'light'      # 旧前端/旧预设
    assert AC.resolve_mode({'denoise': False}) == 'off'
    assert AC.resolve_mode({}) == 'off'
    assert AC.resolve_mode({'denoise_mode': '乱写', 'denoise': True}) == 'light'


# ---------- 体检（C 的地基） ----------

def test_measure_reports_facts_for_clean_and_noisy_material():
    """体检只报事实：安静段高频占比对「纯噪声」明显高于「纯乐音」。

    ★ 它**不是判决**：真实现场音乐段也是 0.13，和 SNR 6 dB 的合成素材并列 ——
      所以档位交给用户（见 measure 的说明），这里只钉住「噪声确实会抬高这个数」。
    """
    clean = AC.measure(_tone(), SR)
    noisy = AC.measure(_noise(amp=0.2), SR)
    assert clean['hiss_ratio'] < 0.15, clean
    assert noisy['hiss_ratio'] > 0.3, noisy
    assert AC.hiss_hint(clean['hiss_ratio']) is None
    assert AC.hiss_hint(noisy['hiss_ratio']) == 'hiss'


def test_measure_reports_level_peak_and_silence():
    m = AC.measure(_tone(amp=0.5), SR)
    assert -20 < m['level_dbfs'] < -6, m
    assert m['peak_dbfs'] > -8, m
    assert m['silent'] is False
    assert AC.measure(np.zeros(SR, dtype='float32'), SR)['silent'] is True
    assert AC.hiss_hint(0.9, silent=True) is None      # 没内容就别提示降噪


def test_measure_keys_are_stable_for_downstream_consumers():
    m = AC.measure(_tone(amp=0.1), SR)
    for k in ('noise_dbfs', 'quiet_flatness', 'hiss_ratio', 'dynamic_range_db',
              'level_dbfs', 'peak_dbfs', 'clipped_pct', 'silent'):
        assert k in m, k

# ---------- 降噪 ----------

def _burst_tone(seconds=2.0, sr=SR, amp=0.3, on=0.25, off=0.25, freq=440.0, noise=0.02, seed=3):
    """有音 / 无音交替的信号 + 恒定底噪 —— 真实音乐的样子（持续正弦是稳态的，不算）。"""
    t = np.arange(int(seconds * sr)) / sr
    env = ((t % (on + off)) < on).astype('float32')
    sig = amp * env * np.sin(2 * np.pi * freq * t)
    rng = np.random.default_rng(seed)
    return (sig + noise * rng.normal(0, 1, len(t))).astype('float32'), env


def test_can_denoise_rejects_stationary_material():
    """持续音 / 纯噪声都不该做谱减法 —— 没有可识别的安静段，硬做就是把乐音当噪声。"""
    assert AC.can_denoise(_tone(amp=0.3), SR) is False
    assert AC.can_denoise(_noise(amp=0.05), SR) is False
    burst, _ = _burst_tone()
    assert AC.can_denoise(burst, SR) is True


def test_spectral_denoise_keeps_the_tone_alive():
    """旧实现会把内容抹平（现场音乐 69 → 0 个音符）；新实现必须保住乐音、只压噪声。"""
    x, env = _burst_tone()
    y = AC.denoise_spectral(x, SR)
    assert y.shape == x.shape
    assert np.isfinite(y).all()
    tone = env > 0.5
    gap = ~tone
    rms = lambda a: float(np.sqrt((a ** 2).mean()))
    assert rms(y[tone]) > 0.6 * rms(x[tone]), (rms(y[tone]), rms(x[tone]))   # 乐音还在
    assert rms(y[gap]) < rms(x[gap]), (rms(y[gap]), rms(x[gap]))            # 空隙里的噪声被压了


def test_spectral_denoise_passes_stationary_input_through_untouched():
    x = _tone(amp=0.3)
    y = AC.denoise_spectral(x, SR)
    assert np.allclose(x, y), '没有安静段时必须原样返回'


def test_denoise_never_raises_on_tiny_or_broken_input():
    assert AC.denoise_spectral(np.zeros(10, dtype='float32'), SR).shape == (10,)
    assert AC.denoise_spectral(np.zeros(0, dtype='float32'), SR).shape == (0,)


# ---------- 电平统一（B） ----------

def test_normalize_level_hits_the_target():
    x = _tone(amp=0.05)
    y, gain = AC.normalize_level(x, SR)
    rms_db = 20 * np.log10(float(np.sqrt((y ** 2).mean())))
    assert abs(rms_db - AC.TARGET_RMS_DBFS) < 0.6, rms_db
    assert gain > 0


def test_normalize_level_never_clips():
    y, gain = AC.normalize_level(_tone(amp=0.9), SR)
    assert float(np.abs(y).max()) <= 1.0
    assert gain < 0                                     # 已经很响 → 压下来
    y2, _ = AC.normalize_level(np.clip(_tone(amp=1.4), -1, 1).astype('float32'), SR)
    assert float(np.abs(y2).max()) <= 1.0

def test_normalize_level_caps_absurd_gain():
    x = _tone(amp=1e-5)
    y, gain = AC.normalize_level(x, SR)
    assert gain <= AC.MAX_GAIN_DB + 0.01, gain


# ---------- 高通 ----------

def test_highpass_kills_rumble_keeps_mid_tone():
    t = np.arange(SR) / SR
    rumble = (0.3 * np.sin(2 * np.pi * 15 * t)).astype('float32')
    mid = (0.3 * np.sin(2 * np.pi * 1000 * t)).astype('float32')
    y = AC.highpass(rumble + mid, SR)
    assert float(np.sqrt((y ** 2).mean())) > 0.15, '中频乐音不能被削掉'
    y2 = AC.highpass(rumble, SR)
    assert float(np.sqrt((y2 ** 2).mean())) < 0.05, '15Hz 隆隆声该被压掉'


# ---------- 链路入口 ----------

def test_process_array_off_still_normalizes_and_logs(tmp_path):
    logs = []
    y = AC.process_array_inplace(_tone(amp=0.05), SR, {'denoise_mode': 'off'}, logs.append)
    rms_db = 20 * np.log10(float(np.sqrt((y ** 2).mean())))
    assert abs(rms_db - AC.TARGET_RMS_DBFS) < 0.6
    assert any('体检' in s for s in logs), logs
    assert any('降噪=off' in s for s in logs), logs


def test_process_wav_writes_back_at_requested_sr(tmp_path):
    import soundfile as sf
    p = str(tmp_path / 'a.wav')
    sf.write(p, _tone(amp=0.02, sr=44100), 44100, subtype='PCM_16')
    logs = []
    AC.process_wav_inplace(p, SR, {'denoise_mode': 'light'}, logs.append)
    d, sr = sf.read(p, dtype='float32')
    assert sr == SR, sr                       # 下游模型是按 16k 准备的，必须换回来
    assert len(d) > 0
    assert any('降噪=light' in s for s in logs), logs


def test_strong_without_model_falls_back_to_light_and_says_so():
    """不允许出现「开关打开但什么都没发生」—— 没有模型必须明说并退回 light。"""
    logs = []
    y = AC.process_array_inplace(_tone(amp=0.05), SR, {'denoise_mode': 'strong'}, logs.append,
                                 strong_runner=lambda p: None)
    assert y.shape[0] > 0
    assert any('强降噪不可用' in s for s in logs), logs


def test_strong_uses_the_runner_and_resamples_back():
    """强档跑完必须回到调用方要求的采样率（去噪模型多是 44.1k，引擎要 16k）。"""
    import soundfile as sf
    calls = []

    def runner(path):
        calls.append(path)
        out = str(path) + '.denoised.wav'
        sf.write(out, _tone(amp=0.2, sr=44100), 44100, subtype='PCM_16')
        return out

    logs = []
    y = AC.process_array_inplace(_tone(amp=0.05), SR, {'denoise_mode': 'strong'}, logs.append,
                                 strong_runner=runner)
    assert calls, '强档必须真的调用了去噪模型'
    assert len(y) == SR * 2, len(y)             # 44.1k→16k 换回来，长度回到 2 秒
    assert any('model' in s for s in logs), logs


def test_strong_failure_is_reported_not_hidden():
    logs = []

    def boom(_p):
        raise RuntimeError('model exploded')

    AC.process_array_inplace(_tone(amp=0.05), SR, {'denoise_mode': 'strong'}, logs.append, strong_runner=boom)
    assert any('失败' in s for s in logs), logs
    assert any('强降噪不可用' in s for s in logs), logs


def test_make_strong_runner_returns_none_when_no_model(monkeypatch):
    """没有装去噪模型时，runner 返回 None（由链路说明并退回 light）。"""
    monkeypatch.delenv('FUFUMIDI_MODELS_DIR', raising=False)
    run = AC.make_strong_runner(None)
    assert run('whatever.wav') is None
