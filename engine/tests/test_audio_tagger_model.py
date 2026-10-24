# -*- coding: utf-8 -*-
"""乐器组标签模型（AudioSet）的查找顺序与「可下载」契约。

2026-10-24：它从「只随包」改成「随包兜底 + 资源中心可下载更新」。
本文件钉住两件事：
  1. 引擎侧查找顺序 —— 数据根里的下载副本优先于随包那份（否则下载了也不生效）；
  2. 主进程侧的条目字段自洽（dest 与引擎查找目录同名、marker 与包内结构一致）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import audio_tagger


def test_candidates_put_downloaded_copy_before_bundled(monkeypatch, tmp_path):
    """下载副本（FUFUMIDI_MODELS_DIR/audio-tagger）必须排在随包目录之前。"""
    models = tmp_path / "models"
    models.mkdir()
    monkeypatch.setenv("FUFUMIDI_MODELS_DIR", str(models))
    monkeypatch.delenv("FUFUMIDI_AUDIO_TAGGER_DIR", raising=False)
    cands = [os.path.normcase(os.path.abspath(c)) for c in audio_tagger.model_dir_candidates()]
    downloaded = os.path.normcase(os.path.abspath(str(models / "audio-tagger")))
    bundled = os.path.normcase(os.path.abspath(audio_tagger.BUNDLED_DIR))
    assert downloaded in cands, cands
    assert bundled in cands, cands
    assert cands.index(downloaded) < cands.index(bundled), "下载副本必须优先：" + repr(cands)


def test_env_override_still_wins(monkeypatch, tmp_path):
    forced = tmp_path / "forced"
    forced.mkdir()
    monkeypatch.setenv("FUFUMIDI_AUDIO_TAGGER_DIR", str(forced))
    monkeypatch.setenv("FUFUMIDI_MODELS_DIR", str(tmp_path / "models"))
    cands = [os.path.normcase(os.path.abspath(c)) for c in audio_tagger.model_dir_candidates()]
    assert cands[0] == os.path.normcase(os.path.abspath(str(forced))), cands


def test_find_model_dir_prefers_downloaded(monkeypatch, tmp_path):
    """数据根里有完整副本时，必须用那一份（哪怕随包那份也在）。"""
    models = tmp_path / "models"
    dl = models / "audio-tagger"
    dl.mkdir(parents=True)
    (dl / "model.int8.onnx").write_bytes(b"x")
    (dl / "class_labels_indices.csv").write_text("index,mid,display_name\n", encoding="utf-8")
    monkeypatch.setenv("FUFUMIDI_MODELS_DIR", str(models))
    monkeypatch.delenv("FUFUMIDI_AUDIO_TAGGER_DIR", raising=False)
    got = audio_tagger.find_model_dir()
    assert os.path.normcase(os.path.abspath(got)) == os.path.normcase(os.path.abspath(str(dl))), got
    # 标签文件也要从同一目录取
    assert audio_tagger.labels_path().startswith(str(dl))


def test_find_model_dir_empty_when_nothing(monkeypatch, tmp_path):
    monkeypatch.setenv("FUFUMIDI_MODELS_DIR", str(tmp_path / "nope"))
    monkeypatch.delenv("FUFUMIDI_AUDIO_TAGGER_DIR", raising=False)
    # 随包目录在这个仓库里确实存在，所以只要确保「没有下载副本时仍能回落到随包那份」即可
    got = audio_tagger.find_model_dir()
    if os.path.isdir(audio_tagger.BUNDLED_DIR):
        assert os.path.normcase(os.path.abspath(got)) == \
            os.path.normcase(os.path.abspath(audio_tagger.BUNDLED_DIR)), got
    else:
        assert got == "", got


def test_registry_entry_matches_engine_layout():
    """主进程条目 dest / unpackMarker 必须与引擎查找目录、包内结构一致。

    ★ 这类不一致**不报错**：下载完了引擎还找不到（或反过来），最难查。
    """
    import io
    import re
    p = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                     "..", "main", "models.js")
    src = io.open(p, encoding="utf-8").read()
    m = re.search(r"audio_tagger:\s*\{(.*?)\n    \},", src, re.S)
    assert m, "models.js 里找不到 audio_tagger 条目"
    body = m.group(1)
    assert "dest: 'audio-tagger'" in body, body[:400]
    assert "unpack: true" in body
    assert "unpackMarker: 'model.int8.onnx'" in body
    # 双端都要有地址（GitHub url + CNB mirrors）
    assert "monologue82/Models/releases/download/models-extra-v1" in body
    assert "cnb.cool/FuFuCloud-mirror/Models/-/releases/download/models-extra-v1" in body
    assert re.search(r"sha256: '[0-9a-f]{64}'", body)
    assert "bundled: 'audio-tagger'" in body, "必须标 bundled，否则界面会误报未安装"
