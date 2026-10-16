# -*- coding: utf-8 -*-
"""_make_pitch_evidence 的行为测试（合成音频，不依赖任何外部素材）。

四版判据的实测依据见 engine_muscriptor._make_pitch_evidence 的 docstring。
这里只钉住"引擎实际会怎么切"：
  1. 真正持续到某刻的音 → 切在那个时刻（不误伤）
  2. 到边界还在响 → None（不动）
  3. ★ 只被零星鼓点"接上"的音 → 切在**最后一段持续存在**处，而不是最后一个孤立峰
  4. ★ 头部（开头 1 秒）就没有支撑 → 返回 EVIDENCE_DROP 哨兵 = 删掉这颗幻觉音
  5. ★ 反过来的护栏：被配器盖住但确实一直在的弱音 → 不删（HEAD_BAND_REL 那条）
"""
import os
import sys

import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import engine_muscriptor as EM  # noqa: E402

SR = 16000


def _tone(freq, dur, amp=0.3, sr=SR):
    t = np.arange(int(round(dur * sr))) / float(sr)
    return (amp * np.sin(2 * np.pi * freq * t)).astype("float32")


def _put(buf, t0, sig, sr=SR):
    i = int(round(t0 * sr))
    buf[i:i + sig.size] += sig


def _noise(dur, amp=0.03, sr=SR, seed=7):
    rng = np.random.default_rng(seed)
    return (amp * rng.standard_normal(int(round(dur * sr)))).astype("float32")


def _freq(pitch):
    return 440.0 * 2.0 ** ((pitch - 69) / 12.0)


def _sustained_case():
    """pitch 60 从 1.0 s 响到 4.0 s；邻域里还垫着 55（更轻）与一层噪声。"""
    buf = np.zeros(8 * SR, dtype="float32")
    buf += _noise(8.0)
    _put(buf, 0.5, _tone(_freq(55), 6.5, amp=0.05))     # 邻域常驻，压低突出度
    _put(buf, 1.0, _tone(_freq(60), 3.0, amp=0.35))     # 目标：1.0~4.0 s
    return buf


def test_sustained_note_is_cut_where_the_audio_stops():
    fn = EM._make_pitch_evidence((_sustained_case(), SR))
    assert fn is not None
    cut = fn(60, 1.0, 5.0)
    assert cut is not None, "音频在 4.0 s 就停了，证据必须给出收尾时刻"
    assert 3.6 <= cut <= 4.2, cut


def test_still_sounding_at_boundary_returns_none():
    fn = EM._make_pitch_evidence((_sustained_case(), SR))
    assert fn(60, 1.0, 4.1) is None


def test_strong_attack_does_not_truncate_a_real_sustain():
    """★ 第四版核心：起音是尖峰时，绝不许按"跟起音比"把真实延音切掉。

    构造：1.0 s 一记很响的起音（振幅 2.0），随后 1.1~4.5 s 是正常电平的延音（0.2）。
    第三版判据是「阈值 = 0.35 × 起音突出度」—— 起音突出度上千，延音只有几十，
    于是整颗音会被切到起音处（**误切真实长音**，用户明确不许）。
    第四版改用绝对判据（突出度 ≥ 1.6 且带内有能量），延音全程算数 → 收在 4.5 s 附近。
    """
    buf = np.zeros(8 * SR, dtype="float32")
    buf += _noise(8.0)
    _put(buf, 0.5, _tone(_freq(55), 6.5, amp=0.05))
    _put(buf, 1.0, _tone(_freq(60), 0.10, amp=2.0))     # 尖峰起音
    _put(buf, 1.1, _tone(_freq(60), 3.4, amp=0.20))     # 之后的真实延音
    fn = EM._make_pitch_evidence((buf, SR))
    cut = fn(60, 1.0, 5.5)
    assert cut is not None, "延音在 4.5 s 就停了，必须给收尾时刻"
    assert cut > 4.0, "真实延音被起音尖峰误切到 %.2f s 了" % cut


def test_unsupported_pitch_is_dropped():
    """★ 头部没有支撑 → DROP 哨兵（引擎据此把整颗音删掉）。

    构造：36 号音（65 Hz）**3.0 s 才进来**，而模型声称它从 1.0 s 就在响；
    1.0~2.6 s 只有邻域里的 70 Hz 响音。于是"自称开始的地方"确实没有这颗音 ——
    这正是星铁LIVE 26:20 那颗 24.65 秒 D1 的形状（起音突出度 0.88）。
    """
    buf = np.zeros(8 * SR, dtype="float32")
    buf += _noise(8.0, amp=0.02)
    _put(buf, 1.0, _tone(_freq(70), 1.6, amp=0.5))      # 邻域里的响音（盖住 36 号）
    _put(buf, 3.0, _tone(_freq(36), 3.0, amp=0.4))      # 36 号音 3.0 s 才进来
    fn = EM._make_pitch_evidence((buf, SR))
    got = fn(36, 1.0, 6.5)
    assert got is not None, "头部没有支撑时必须给判定，不许放行"
    assert got is EM.EVIDENCE_DROP, "应当返回 EVIDENCE_DROP 哨兵，实际 %r" % (got,)
    assert fn.stats["drop"] == 1
    # 同一个音高，从它**真正**开始的地方起算 → 不许删，只按音频真实结束点收尾
    got2 = fn(36, 3.0, 6.5)
    assert got2 is not None and 5.5 <= got2 <= 6.2, got2   # 6.15：STFT 窗略过音尾


def test_short_note_with_unsupported_head_is_not_dropped():
    """★ 删除只对**长音**生效：短音的收尾点本来就是模型逐音给的，宁可不删。

    实测依据：星铁LIVE 全片不加这道门会删 57 颗，其中 51 颗是 2~4 秒的短音、
    散在全片各处（很可能是真实音符只是起音被盖住）。
    """
    buf = np.zeros(8 * SR, dtype="float32")
    buf += _noise(8.0, amp=0.02)
    _put(buf, 1.0, _tone(_freq(70), 1.6, amp=0.5))
    _put(buf, 3.0, _tone(_freq(36), 3.0, amp=0.4))
    fn = EM._make_pitch_evidence((buf, SR))
    got = fn(36, 1.0, 5.0)          # 跨度 4 秒 < 5 秒门槛
    assert got is not EM.EVIDENCE_DROP, "短音不许被删"
    assert fn.stats["drop"] == 0


def test_masked_but_present_note_is_kept():
    """★ 反过来的护栏：音高确实一直在（只是被盖住、不突出）→ 一个都不许删。

    这是第四版最容易误伤的一类：弱乐器长音被配器盖住时，突出度上不去，
    但带内能量全程都在 —— HEAD_BAND_REL 那条判据专门放行它。
    """
    buf = np.zeros(8 * SR, dtype="float32")
    buf += _noise(8.0, amp=0.06)                        # 很响的宽带噪声（盖住 60 号音）
    _put(buf, 1.0, _tone(_freq(60), 4.0, amp=0.02))     # 一直在，但抬不起头
    fn = EM._make_pitch_evidence((buf, SR))
    assert fn(60, 1.0, 5.0) is None, "被盖住的真实弱音不许被判定为「不存在」"
    assert fn.stats["drop"] == 0


def test_no_evidence_when_audio_too_short():
    assert EM._make_pitch_evidence((np.zeros(100, dtype="float32"), SR)) is None


def test_evidence_reads_wav_file(tmp_path):
    import soundfile as sf
    p = tmp_path / "a.wav"
    sf.write(str(p), _sustained_case(), SR)
    fn = EM._make_pitch_evidence(str(p))
    assert fn is not None
    assert fn(60, 1.0, 5.0) is not None
