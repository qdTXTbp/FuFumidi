# -*- coding: utf-8 -*-
"""转录选项回归：分段识别**默认不开启** / 静音分段与分段探测保持移除 / 其它默认值。

★ 演变（两次用户反馈，别弄混）：
  · 2026-10-21「取消分块转录功能，分块转录会导致各分块质量参差不齐」
    → 当时把三种分块形态整体删掉了。
  · 2026-10-23「改成不强制开启分段识别，允许用户手动切换」
    → 「识别片段长度」（segment_sec）恢复成**可选**能力：默认 0 = 模型原生块长，
      只有用户显式调离 0 才生效；**预设一律不写这个键**（6.1.x 给每个模型都写了值，
      切模型就自动套上，那就是"强制开启"）。
    → 另两种分块（静音分段 segment_silence*、分段探测 probe_segments）**保持移除**。

所以本文件的断言分两半：
  A. 预设 / 前端默认值不许写 segment_sec（"不强制开启"的机器保证）；
  B. 静音分段与分段探测的模块/档位必须仍然不存在（"保持移除"的机器保证）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import presets as P
import engine_pt

#: 保持移除的分块键（预设里不许出现；模块也必须不存在）
STILL_DEAD_KEYS = (
    "segment_silence",
    "silence_db",
    "min_silence",
    "max_segment",
    "segment_pad",
    "probe_segment_sec",
)
#: 已恢复为可选的键：预设里同样不许写（那就是"强制开启"）
OPT_IN_KEYS = ("segment_sec",)


def test_builtin_presets_never_force_segment_sec():
    """★ 核心断言：内置预设一律不写识别片段长度。

    6.1.x 的预设给每个模型都写了值（Basic 0 / MuScriptor 5s / 钢琴 10s /
    Aria 30s / Transkun 16s），切模型就自动套上 —— 用户明确要求改成
    「不强制开启分段识别，允许用户手动切换」，所以这里一个值都不许有。
    """
    b = P._builtin_presets()
    for name, spec in b.items():
        params = spec.get("params") or {}
        for k in OPT_IN_KEYS + STILL_DEAD_KEYS:
            assert k not in params, "%s 仍写了 %s（这会让分段识别变成强制开启）" % (name, k)
    # MuScriptor 的乐器组只允许 none / limit / 整曲 probe（分段探测档已移除）
    mi = b["MuScriptor · 最优"]["params"].get("muscriptor_instruments")
    assert mi in (None, "none", "probe"), mi


def test_builtin_presets_keep_expected_shape():
    """改默认值不能顺手改掉别的默认值。"""
    b = P._builtin_presets()
    ms = b["MuScriptor · 最优"]["params"]
    assert ms["model_size"] == "medium"
    assert ms["prelude_forcing"] is True
    assert ms["precision"] == "fp32"
    assert ms["max_note_hold"] == 0
    assert b["钢琴 · 最优"]["params"]["model"] == "piano_pt"
    assert b["hFT-Transformer · 最优"]["params"]["model"] == "hft"
    for key in ("muscriptor_small", "muscriptor_medium", "muscriptor_large"):
        assert P.MODEL_DEFAULT_PRESET[key] == "MuScriptor · 最优"


def test_builtin_denoise_off_by_default():
    b = P._builtin_presets()
    for name in ("Basic Pitch · 最优", "MuScriptor · 最优", "钢琴 · 最优", "分离 · 最优"):
        assert b[name]["params"].get("denoise_mode") == "off"


def test_segment_modules_state():
    """静音分段 / 分段探测的模块必须不存在；segment_options 必须存在（已恢复为可选）。"""
    eng = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    for f in ("segmenter.py", "segment_probe.py"):
        assert not os.path.exists(os.path.join(eng, f)), "%s 应保持删除" % f
    assert os.path.exists(os.path.join(eng, "segment_options.py")), \
        "segment_options.py 应存在（识别片段长度已恢复为可选能力）"


def test_muscriptor_instruments_mode_rejects_segments():
    """'probe_segments'/'segments' 旧值按整曲探测兼容，绝不返回分段模式。"""
    import instrument_probe
    for raw in ("probe_segments", "segments", "PROBE_SEGMENTS"):
        assert instrument_probe.parse_mode(raw)[0] == "probe", raw
    assert instrument_probe.parse_mode("voice,drums")[0] == "limit"
    assert instrument_probe.parse_mode("none")[0] == "none"
    assert instrument_probe.parse_mode("")[0] == "none"


def test_piano_batch_cap_low_memory():
    assert engine_pt._batch_cap("quality", "cuda") == 32
    assert engine_pt._batch_cap("quality", "cuda", "low") == 16
    assert engine_pt._batch_cap("fast", "cuda", "low") == 4
    # CPU 先减半，再低显存减半
    assert engine_pt._batch_cap("quality", "cpu", "low") == 8
    assert engine_pt._batch_cap("quality", "cpu", "allow") == 16
