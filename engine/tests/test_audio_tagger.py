# -*- coding: utf-8 -*-
"""专用音频标签模型：标签→乐器组纯逻辑（不依赖 onnxruntime/torch）。"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from audio_tagger import groups_from_scores, AUDIOSET_TO_GROUPS, load_labels  # noqa: F401


def test_maps_clear_instruments():
    g, agg = groups_from_scores({"Piano": 0.8, "Singing": 0.7, "Drum kit": 0.3})
    assert "acoustic_piano" in g
    assert "voice" in g
    assert "drums" in g
    assert agg["acoustic_piano"] == 0.8


def test_low_confidence_is_not_locked():
    g, _ = groups_from_scores({"Piano": 0.02, "Drum kit": 0.01})
    assert g == []


def test_forced_drums_only_when_confident():
    g, _ = groups_from_scores({"Drum kit": 0.001, "Piano": 0.5}, always_keep=("drums",))
    assert "drums" not in g
    assert "acoustic_piano" in g


def test_caps_groups():
    scores = {k: 0.9 for k in ("Piano", "Singing", "Cello", "Flute", "Trumpet", "Drum kit", "Organ")}
    g, _ = groups_from_scores(scores, max_groups=3)
    assert len(g) == 3


def test_empty_scores():
    assert groups_from_scores({}) == ([], {})
