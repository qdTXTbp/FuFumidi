# -*- coding: utf-8 -*-
"""
参数预设：保存 / 加载 / 删除
============================
预设以 JSON 保存在工具目录下 presets.json，支持任意命名；
内置预设作为默认兜底，用户保存的预设会覆盖/新增。
"""

import json
import os
import sys

from engine import DEFAULTS, MODES


def _base_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


PRESETS_FILE = os.path.join(_base_dir(), "presets.json")


def _builtin_presets():
    """内置预设（始终存在，用户可在界面里覆盖/隐藏同名预设）。"""
    u = DEFAULTS["universal"]
    p = DEFAULTS["piano"]
    s = DEFAULTS["separate"]
    return {
        # 推荐默认（新装即默认「人声：最优」；切到钢琴模式自动换「钢琴：最优」）
        "人声：最优": {
            "mode": "separate",
            "params": {**s, "onset_threshold": 0.05, "frame_threshold": 0.25,
                       "minimum_note_length": 100, "include_drums": True,
                       "denoise": True, "normalize": True, "auto_bpm": True},
        },
        "钢琴：最优": {
            "mode": "piano",
            "params": {**p, "onset_threshold": 0.05, "frame_threshold": 0.06,
                       "min_note_ms": 20, "merge_gap_ms": 0, "include_pedal": True,
                       "denoise": True, "normalize": True},
        },
        "通用·标准": {"mode": "universal", "params": dict(u)},
        "通用·更干净": {
            "mode": "universal",
            "params": {**u, "onset_threshold": 0.60, "frame_threshold": 0.45,
                       "minimum_note_length": 180, "minimum_frequency": 60},
        },
        "通用·更灵敏": {
            "mode": "universal",
            "params": {**u, "onset_threshold": 0.40, "frame_threshold": 0.25,
                       "minimum_note_length": 80},
        },
        "通用·人声主旋律": {
            "mode": "universal",
            "params": {**u, "melodia_trick": True, "minimum_frequency": 130,
                       "maximum_frequency": 1050, "minimum_note_length": 150},
        },
        "通用·人声纯净": {
            "mode": "universal",
            "params": {**u, "onset_threshold": 0.45, "frame_threshold": 0.35,
                       "minimum_note_length": 160, "minimum_frequency": 80,
                       "maximum_frequency": 1000, "melodia_trick": True,
                       "merge_overlap": True, "merge_gap_ms": 40},
        },
        "通用·吉他拨弦": {
            "mode": "universal",
            "params": {**u, "frame_threshold": 0.30, "minimum_note_length": 100,
                       "minimum_frequency": 80, "maximum_frequency": 4000,
                       "melodia_trick": False},
        },
        "通用·低音乐器": {
            "mode": "universal",
            "params": {**u, "frame_threshold": 0.35, "minimum_note_length": 200,
                       "minimum_frequency": 30, "maximum_frequency": 500,
                       "melodia_trick": False},
        },
        "钢琴·标准": {"mode": "piano", "params": dict(p)},
        "钢琴·快速琶音": {
            "mode": "piano",
            "params": {**p, "onset_threshold": 0.25, "min_note_ms": 40,
                       "merge_gap_ms": 25, "include_pedal": False},
        },
        "分离·标准": {"mode": "separate", "params": dict(s)},
        "分离·带鼓组": {"mode": "separate", "params": {**s, "include_drums": True}},
    }


def _read_file():
    try:
        with open(PRESETS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _write_file(data):
    try:
        with open(PRESETS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return True
    except Exception:
        return False


def load_presets():
    """返回 (presets: dict[name -> {mode, params}], last_used: str)。

    - 内置预设在前，用户自定义覆盖/新增在后；
    - 内置预设可被「隐藏删除」（hidden_builtins），隐藏后不再出现；
    - order 记录用户手动排序，未列出的预设追加到末尾；
    - 从未用过任何预设时，默认推荐「人声：最优」。
    """
    data = _read_file()
    hidden = set(data.get("hidden_builtins", []) or [])
    presets = {}
    for name, p in _builtin_presets().items():
        if name not in hidden:
            presets[name] = p
    presets.update(data.get("presets", {}))   # 用户自定义/覆盖
    order = data.get("order") or []
    if order:
        ordered = {}
        for name in order:
            if name in presets:
                ordered[name] = presets.pop(name)
        ordered.update(presets)
        presets = ordered
    last = data.get("last_used", "")
    if not last:
        last = "人声：最优"
    return presets, last


def save_preset(name, mode, params):
    """保存/覆盖一个预设，返回是否成功。"""
    name = (name or "").strip()
    if not name:
        return False
    data = _read_file()
    data.setdefault("presets", {})
    data["presets"][name] = {"mode": mode, "params": dict(params or {})}
    return _write_file(data)


def delete_preset(name):
    """删除预设：内置预设进入隐藏列表（下次不再显示，可一键恢复）；用户预设直接删除。"""
    name = (name or "").strip()
    if not name:
        return False
    data = _read_file()
    if name in _builtin_presets():
        hidden = data.get("hidden_builtins", []) or []
        if name not in hidden:
            hidden.append(name)
        data["hidden_builtins"] = hidden
        data.get("presets", {}).pop(name, None)   # 清除同名用户覆盖，避免隐藏后复活
        order = [n for n in (data.get("order") or []) if n != name]
        data["order"] = order or None
        return _write_file(data)
    if name in data.get("presets", {}):
        del data["presets"][name]
        order = [n for n in (data.get("order") or []) if n != name]
        data["order"] = order or None
        return _write_file(data)
    return False


def restore_all_builtins():
    """恢复全部内置预设（清空隐藏列表）。"""
    data = _read_file()
    data["hidden_builtins"] = []
    return _write_file(data)


def reorder_preset(name, delta):
    """在展示顺序里把预设 name 上移/下移 delta 位（-1 上移 / 1 下移），并持久化。返回新顺序。"""
    presets, _ = load_presets()
    names = list(presets.keys())
    if name not in names or not delta:
        return names
    i = names.index(name)
    j = i + int(delta)
    if j < 0 or j >= len(names):
        return names
    names[i], names[j] = names[j], names[i]
    data = _read_file()
    data["order"] = names
    _write_file(data)
    return names


def save_last_used(name):
    data = _read_file()
    data["last_used"] = name
    _write_file(data)


def preset_names():
    presets, _ = load_presets()
    return list(presets.keys())
