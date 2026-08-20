# -*- coding: utf-8 -*-
"""presets.py 纯逻辑测试。

约束：不 import 任何重型 ML 库（torch / basic_pitch / demucs / piano_transcription）。
presets.py 顶层只 import json/os/sys 与 engine 的 DEFAULTS/MODES，可轻量导入。

写测试前已读 presets.py 确认：
  - load_presets() -> (presets: dict[str -> {"mode", "params"}], last_used: str)
  - save_preset(name, mode, params) -> bool
  - delete_preset(name) -> bool
  - save_last_used(name) -> None
  - preset_names() -> list[str]

所有会写盘的用例都用 monkeypatch 把 PRESETS_FILE 重定向到 tmp_path，
绝不触碰真实引擎目录下的 presets.json。
"""

import presets
from engine import MODES


def test_load_presets_returns_tuple():
    result = presets.load_presets()
    assert isinstance(result, tuple)
    assert len(result) == 2
    presets_map, last_used = result
    assert isinstance(presets_map, dict)
    assert isinstance(last_used, str)


def test_load_presets_contains_builtin():
    presets_map, _ = presets.load_presets()
    assert len(presets_map) >= 1
    # 内置兜底预设必须始终存在
    assert "通用·标准" in presets_map


def test_every_preset_has_valid_structure():
    presets_map, _ = presets.load_presets()
    for name, p in presets_map.items():
        assert isinstance(name, str) and name
        assert isinstance(p, dict)
        assert "mode" in p, f"预设 {name!r} 缺 mode"
        assert p["mode"] in MODES, f"预设 {name!r} 的 mode={p['mode']!r} 非法"
        assert isinstance(p["params"], dict)
        assert len(p["params"]) >= 1, f"预设 {name!r} 的 params 为空"


def test_builtin_presets_cover_all_modes():
    presets_map, _ = presets.load_presets()
    modes_covered = {p["mode"] for p in presets_map.values()}
    assert set(MODES) == modes_covered, f"内置预设未覆盖全部模式: {modes_covered}"


def test_standard_preset_params_nonempty():
    presets_map, _ = presets.load_presets()
    standard = presets_map["通用·标准"]
    assert standard["mode"] == "universal"
    assert "onset_threshold" in standard["params"]


def test_save_preset_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    ok = presets.save_preset("我的预设", "piano", {"threshold": 0.5, "merge": True})
    assert ok is True
    presets_map, _ = presets.load_presets()
    assert "我的预设" in presets_map
    assert presets_map["我的预设"]["mode"] == "piano"
    assert presets_map["我的预设"]["params"]["threshold"] == 0.5


def test_save_preset_blank_name_fails(monkeypatch, tmp_path):
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    assert presets.save_preset("", "piano", {}) is False
    assert presets.save_preset("   ", "piano", {}) is False


def test_save_preset_overrides_builtin(monkeypatch, tmp_path):
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    # 覆盖内置同名预设
    presets.save_preset("通用·标准", "piano", {"custom": 1})
    presets_map, _ = presets.load_presets()
    assert presets_map["通用·标准"]["mode"] == "piano"
    assert presets_map["通用·标准"]["params"]["custom"] == 1


def test_delete_preset(monkeypatch, tmp_path):
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    presets.save_preset("临时预设", "universal", {})
    assert "临时预设" in presets.preset_names()
    assert presets.delete_preset("临时预设") is True
    assert "临时预设" not in presets.preset_names()
    # 删除不存在的预设返回 False
    assert presets.delete_preset("不存在的预设") is False


def test_save_last_used_roundtrip(monkeypatch, tmp_path):
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    presets.save_last_used("通用·标准")
    _, last_used = presets.load_presets()
    assert last_used == "通用·标准"


def test_preset_names_contains_builtin_and_custom(monkeypatch, tmp_path):
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    presets.save_preset("追加预设", "separate", {})
    names = presets.preset_names()
    assert isinstance(names, list)
    assert "通用·标准" in names
    assert "追加预设" in names
