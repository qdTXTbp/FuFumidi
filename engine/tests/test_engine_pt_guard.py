# -*- coding: utf-8 -*-
"""钢琴模型的「最短音符」碎音护栏（engine_pt._sane_min_note_ms）。

★ 2026-10-15 实测（30 秒样例，piano_pt / CUDA / quality）：

| 起音 | 判定 | 最短音符 | 音符数 | 耗时 |
|---|---|---|---|---|
| 0.30 | 0.10 | 60ms | 71 | 3.2s |
| 0.30 | 0.10 | 10ms | 86 | 3.2s |
| 0.00 | 0.10 | 10ms | 8196 | 3.4s |
| 0.00 | 0.01 | 10ms | **8037** | **15.8s** |
| 0.00 | 0.01 | 30ms | 414 | 3.2s |
| 0.00 | 0.05 | 30ms | 220 | 3.3s |

结论：**最短音符 = 10ms 等于把过滤器关掉**（阈值放宽后 71 → 8037 个音符，3 分钟样例实测
47967 个音符 / 517 秒）。30ms 就把它压回与默认 60ms 同量级，且远低于默认值、不挡正常用法。
"""
import os
import sys

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import engine_pt as EP  # noqa: E402


def test_floor_value_is_30ms():
    assert EP._MIN_NOTE_MS_FLOOR == 30


def test_too_small_value_is_lifted_and_explained():
    """10ms → 30ms，并且**说明原因**（不静默改用户的值）。"""
    logs = []
    assert EP._sane_min_note_ms(10, logs.append) == 30
    assert len(logs) == 1, logs
    assert '太短' in logs[0] and '8037' in logs[0], logs


def test_sane_values_pass_through_unchanged():
    logs = []
    for v in (30, 45, 60, 300):
        assert EP._sane_min_note_ms(v, logs.append) == v
    assert logs == []


def test_missing_value_uses_default_without_complaining():
    logs = []
    assert EP._sane_min_note_ms(None, logs.append) == 60
    assert logs == []


def test_string_value_from_json_is_accepted():
    assert EP._sane_min_note_ms('50') == 50
    assert EP._sane_min_note_ms('12') == 30


def test_bad_log_callback_never_breaks_transcription():
    """日志回调抛异常不许影响转录（引擎各处都按这个约定）。"""
    def boom(_s):
        raise RuntimeError('log down')

    assert EP._sane_min_note_ms(10, boom) == 30
    assert EP._sane_min_note_ms(10, None) == 30


def test_transcribe_pt_applies_the_guard(tmp_path):
    """接线检查：transcribe_pt 在真正解码之前就用上了护栏（拿不存在的文件当触发点）。"""
    logs = []
    try:
        EP.transcribe_pt(str(tmp_path / 'nope.wav'), str(tmp_path / 'o.mid'),
                         min_note_ms=10, log_cb=logs.append)
    except Exception:
        pass                                    # 文件不存在 → 解码阶段抛错，护栏在那之前就跑过了
    assert any('太短' in s for s in logs), logs
