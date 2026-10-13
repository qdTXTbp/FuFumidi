# -*- coding: utf-8 -*-
"""多说话人嵌入（照搬上游 DiffSingerSpeakerEmbedManager）的测试。

★ 素材是**自己造的**：本机没有多说话人声库（5 个声库全是单说话人），上游仓库里也没有
  任何 `.emb` 文件。所以这里按上游的格式手工写 `.emb`（裸 float32 × hiddenSize，无头），
  用它把**语义**钉死：顺序、形状、路径段匹配、以及逐帧那条"和 > 1 才归一"的边界。

  能证明的：字节格式、对齐、张量形状与归一化规则与上游一致。
  不能证明的：真实声库上的听感与 hiddenSize 是否与模型匹配 —— 那需要一个真声库。
"""

import os
import struct
import sys

import numpy as np
import pytest

_HERE = os.path.dirname(os.path.abspath(__file__))
_ENGINE = os.path.dirname(_HERE)
if _ENGINE not in sys.path:
    sys.path.insert(0, _ENGINE)

from diffsinger.speaker_embed import (  # noqa: E402
    DEFAULT_HIDDEN_SIZE, SpeakerEmbedError, embeds_by_frame, embeds_by_phone,
    load_speaker_embed, speaker_index_by_suffix, speakers_matrix,
)


def write_emb(path, values):
    """按上游格式写：裸 float32 小端，无文件头。"""
    with open(path, "wb") as f:
        for v in values:
            f.write(struct.pack("<f", float(v)))


def test_default_hidden_size_is_upstream_value():
    assert DEFAULT_HIDDEN_SIZE == 256      # DiffSingerConfig.cs:32


def test_load_emb_roundtrip_and_errors(tmp_path):
    write_emb(str(tmp_path / "a.emb"), [0.5, -1.25, 2.0, 0.0])
    got = load_speaker_embed(str(tmp_path), "a", 4)
    assert got.dtype == np.float32
    assert list(got) == [0.5, -1.25, 2.0, 0.0]
    with pytest.raises(SpeakerEmbedError):
        load_speaker_embed(str(tmp_path), "nope", 4)
    write_emb(str(tmp_path / "short.emb"), [1.0, 2.0])
    with pytest.raises(SpeakerEmbedError):
        load_speaker_embed(str(tmp_path), "short", 4)


def test_speakers_matrix_column_order(tmp_path):
    write_emb(str(tmp_path / "s0.emb"), [1, 0, 0])
    write_emb(str(tmp_path / "s1.emb"), [0, 1, 0])
    m = speakers_matrix(str(tmp_path), ["s0", "s1"], 3)
    assert m.shape == (3, 2)
    assert list(m[:, 0]) == [1, 0, 0] and list(m[:, 1]) == [0, 1, 0]


def test_index_by_suffix_exact_then_path_tail_then_fallback():
    sp = ["alice", "grp/bob", "grp/sub/carol"]
    assert speaker_index_by_suffix(sp, "alice") == 0
    assert speaker_index_by_suffix(sp, "grp/bob") == 1
    assert speaker_index_by_suffix(sp, "bob") == 1          # 段尾匹配
    assert speaker_index_by_suffix(sp, "sub/carol") == 2
    assert speaker_index_by_suffix(sp, "unknown") == 0      # 上游回退第一个
    with pytest.raises(SpeakerEmbedError):
        speaker_index_by_suffix([], "x")


def test_embeds_by_phone_shape_and_values(tmp_path):
    write_emb(str(tmp_path / "a.emb"), [1, 0, 0, 0])
    write_emb(str(tmp_path / "b.emb"), [0, 1, 0, 0])
    embs = speakers_matrix(str(tmp_path), ["a", "b"], 4)
    out = embeds_by_phone(["a", "b"], 4, ["a", "b", "a"], embs)
    assert out.shape == (1, 3, 4)
    assert list(out[0, 0]) == [1, 0, 0, 0]
    assert list(out[0, 1]) == [0, 1, 0, 0]
    assert list(out[0, 2]) == [1, 0, 0, 0]


def test_embeds_by_frame_no_curve_is_default_speaker(tmp_path):
    write_emb(str(tmp_path / "a.emb"), [1, 0])
    write_emb(str(tmp_path / "b.emb"), [0, 1])
    embs = speakers_matrix(str(tmp_path), ["a", "b"], 2)
    out = embeds_by_frame(["a", "b"], 2, 3, [1, 1, 1], {}, embs)
    assert out.shape == (1, 3, 2)
    for fid in range(3):
        assert list(out[0, fid]) == [0, 1]        # 全是默认说话人 b


def test_embeds_by_frame_curve_exactly_one_keeps_curve_speaker(tmp_path):
    """曲线值 100 → ×0.01 = 1.0：和**不 > 1**，所以不再补默认说话人（上游的边界）。"""
    write_emb(str(tmp_path / "a.emb"), [1, 0])
    write_emb(str(tmp_path / "b.emb"), [0, 1])
    embs = speakers_matrix(str(tmp_path), ["a", "b"], 2)
    out = embeds_by_frame(["a", "b"], 2, 2, [1, 1], {0: np.array([100.0, 100.0])}, embs)
    for fid in range(2):
        assert list(out[0, fid]) == [1, 0], out[0, fid]


def test_embeds_by_frame_mixes_and_normalizes(tmp_path):
    """50 → 0.5：差额 0.5 补给默认说话人；200 → 2.0：和 > 1，按和归一。"""
    write_emb(str(tmp_path / "a.emb"), [1, 0])
    write_emb(str(tmp_path / "b.emb"), [0, 1])
    embs = speakers_matrix(str(tmp_path), ["a", "b"], 2)
    half = embeds_by_frame(["a", "b"], 2, 1, [1], {0: np.array([50.0])}, embs)
    assert list(half[0, 0]) == pytest.approx([0.5, 0.5])
    over = embeds_by_frame(["a", "b"], 2, 1, [1], {0: np.array([200.0])}, embs)
    assert list(over[0, 0]) == pytest.approx([1.0, 0.0])
