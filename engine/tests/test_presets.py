# -*- coding: utf-8 -*-
"""presets.py 纯逻辑测试。

约束：不 import 任何重型 ML 库（torch / basic_pitch / demucs / piano_transcription）。
presets.py 顶层只 import json/os/sys 与 engine 的 DEFAULTS/MODES，可轻量导入。

写测试前已读 presets.py 确认：
  - load_presets() -> (presets: dict[str -> {"mode", "params"}], last_used: str)
  - _builtin_presets() -> dict[str -> {"mode", "params"}]  ★ v3 起**每个模型一套**，共 6 个
  - MODEL_DEFAULT_PRESET: dict[模型键 -> 内置预设名]
  - load_model_preset_map() / set_model_preset(key, name)
  - save_preset(name, mode, params) -> bool
  - delete_preset(name) -> bool
  - save_last_used(name) -> None
  - preset_names() -> list[str]

所有会写盘的用例都用 monkeypatch 把 PRESETS_FILE 重定向到 tmp_path，
绝不触碰真实引擎目录下的 presets.json。
"""

import presets
from engine import MODES, MUSCRIPTOR_SIZES


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
    # 每个模型的内置默认预设必须始终存在
    assert "Basic Pitch · 最优" in presets_map


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


def test_every_model_has_a_default_preset():
    """每个模型键都必须指向真实存在的内置预设 —— 否则「切模型自动套默认」会静默失效。"""
    builtins = presets._builtin_presets()
    assert presets.MODEL_DEFAULT_PRESET, "模型默认预设表不能为空"
    for key, name in presets.MODEL_DEFAULT_PRESET.items():
        assert name in builtins, f"模型 {key!r} 指向的预设 {name!r} 不存在"


def test_preset_params_carry_the_model_key():
    """预设自带归属模型 —— 前端「套用预设」时靠它把子模型也切过去。

    ★ MuScriptor 三个规格**共用同一套**默认预设（参数完全一样，只有规格不同）。
      由此产生一条前端契约：**切规格自动套默认预设时不许写回 model / model_size**，
      否则 small → medium → large 每次都会被打回 medium（本用例就是为钉住它而存在）。
    """
    builtins = presets._builtin_presets()
    for key, name in presets.MODEL_DEFAULT_PRESET.items():
        if key == "separate":
            continue                                  # 分离模式没有子模型
        params = builtins[name]["params"]
        if key.startswith("muscriptor_"):
            assert params["model"] == "muscriptor"
            assert params["model_size"] in MUSCRIPTOR_SIZES
            assert key.split("_", 1)[1] in MUSCRIPTOR_SIZES
        else:
            assert params["model"] == key, f"{name} 的 model={params.get('model')!r} 与键 {key!r} 不符"
    # 三个规格确实共用一套（共用是有意的，不是漏了）
    shared = {presets.MODEL_DEFAULT_PRESET["muscriptor_" + s] for s in MUSCRIPTOR_SIZES}
    assert len(shared) == 1


def test_quality_policy_highest_quality_and_stable():
    """用户定的判据：**最高质量 + 保证稳定性，不考虑速度与性能**。

    · 只影响速度/资源的 → 一律取最重的一档；
    · 影响结果、值越高越不稳定的 → 中性值（不拿"越高越准"的猜测换不确定性）。
    """
    for name, p in presets._builtin_presets().items():
        assert p["params"].get("perf") == "quality", f"{name} 没选最重的性能档"
    b = presets._builtin_presets()
    ms = b["MuScriptor · 最优"]["params"]
    assert (ms["temperature"], ms["cfg_coef"], ms["beam_size"]) == (1.0, 1.0, 1)
    assert ms["precision"] == "fp32"
    assert ms["prelude_forcing"] is True            # 跨块延音：把默认行为写成显式值
    assert ms["max_note_hold"] == 0                 # 不截断：僵尸音由音频证据收尾（见 test_muscriptor_sustain_evidence）
    #   2026-10-18 A/B 后这两项曾被固化为默认（音色切换 5→0、F1 0.4914→0.7692），
    #   后来 b42e097「精简高级参数面板」把它们连带删掉，默认悄悄退回"不干预乐器组"，
    #   于是 MuScriptor 逐 5 秒块自由改判乐器（用户报障：每隔一段时间换一种乐器）。
    #   面板可以不暴露，默认行为不能退化 —— 这里钉住，别再被"精简"顺手删掉。
    assert ms["muscriptor_instruments"] == "probe_segments"   # 按 6.2.1 做法逐段探测乐器组
    assert b["钢琴 · 最优"]["params"]["include_pedal"] is True
    assert b["分离 · 最优"]["params"]["include_drums"] is True
    assert b["分离 · 最优"]["params"]["stem_format"] == "wav"


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
    presets.save_preset("Basic Pitch · 最优", "piano", {"custom": 1})
    presets_map, _ = presets.load_presets()
    assert presets_map["Basic Pitch · 最优"]["mode"] == "piano"
    assert presets_map["Basic Pitch · 最优"]["params"]["custom"] == 1


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
    presets.save_last_used("Basic Pitch · 最优")
    _, last_used = presets.load_presets()
    assert last_used == "Basic Pitch · 最优"


def test_preset_names_contains_builtin_and_custom(monkeypatch, tmp_path):
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    presets.save_preset("追加预设", "separate", {})
    names = presets.preset_names()
    assert isinstance(names, list)
    assert "Basic Pitch · 最优" in names
    assert "追加预设" in names


def test_storage_moves_to_data_root_and_migrates(tmp_path, monkeypatch):
    """★ 回归：用户预设必须落在**数据根**，并从上一次的旧位置一次性迁移。

    旧落点是引擎目录（`<安装目录>/resources/app.asar.unpacked/engine/`）——
    整包更新会替换 resources/，用户的预设与「上次用的那个」会被静默清空。所以：
      1) 新落点必须在 FUFUMIDI_DATA_DIR 下；
      2) 旧位置有内容时抄一份过去，且**旧文件原样保留**（回滚路径）。
    这条测试用 reload 重新计算模块级常量（PRESETS_FILE 是导入时求值的）。
    """
    import importlib
    import json
    monkeypatch.setenv('FUFUMIDI_DATA_DIR', str(tmp_path))
    monkeypatch.delenv('FUFUMIDI_MODELS_DIR', raising=False)
    mod = importlib.reload(presets)
    try:
        assert str(tmp_path) in mod.PRESETS_FILE
        # 旧位置用临时文件模拟，**不要**去碰真实的 engine/presets.json
        legacy = tmp_path / 'legacy-presets.json'
        monkeypatch.setattr(mod, 'LEGACY_PRESETS_FILE', str(legacy))
        monkeypatch.setattr(mod, '_migrated', False)
        with open(legacy, 'w', encoding='utf-8') as f:
            json.dump({'presets': {'我的自定义': {'mode': 'universal', 'params': {'temperature': 1.3}}},
                       'last_used': '我的自定义', 'hidden_builtins': ['通用·更干净'],
                       'order': ['我的自定义']}, f, ensure_ascii=False)
        p, last = mod.load_presets()
        assert '我的自定义' in p and last == '我的自定义'
        with open(mod.PRESETS_FILE, encoding='utf-8') as f:
            wrote = json.load(f)
        assert wrote['presets']['我的自定义']['params']['temperature'] == 1.3
        # ★ v3 起 hidden_builtins 只对**当前**内置名有意义：'通用·更干净' 已不是内置，
        #   留着它只会让用户以后存一个同名预设被静默隐藏，所以迁移时清掉。
        assert wrote['hidden_builtins'] == [] and wrote['order'] == ['我的自定义']
        assert legacy.exists(), '旧文件必须留着当回滚路径'
        # 写入要带 schema_version（将来只加迁移分支、不改老分支）
        mod.save_preset('再存一个', 'piano', {'merge_gap_ms': 30})
        with open(mod.PRESETS_FILE, encoding='utf-8') as f:
            d2 = json.load(f)
        assert d2['schema_version'] == mod.SCHEMA_VERSION
        assert '再存一个' in d2['presets']
    finally:
        monkeypatch.undo()
        importlib.reload(presets)


def test_v3_removes_old_builtins_but_keeps_user_data(monkeypatch, tmp_path):
    """★ 硬约束：删老内置预设**不许**动用户数据。

    v3 把 13 个按用途命名的内置预设全删了。迁移只允许做三件事：
      · 清掉 hidden_builtins 里**已不是内置**的旧名（留着会误伤同名的用户预设）；
      · 清掉 order 里既不是内置、也不是用户预设的死键；
      · presets（用户预设）**一个都不动** —— 哪怕名字与老内置一模一样，那也是用户存的。
    """
    import json
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    v2 = {
        "schema_version": 2,
        "presets": {"我的预设": {"mode": "universal", "params": {"onset_threshold": 0.42}},
                    "通用·标准": {"mode": "piano", "params": {"custom": 1}}},
        "hidden_builtins": ["通用·标准", "Basic Pitch · 最优"],
        "order": ["通用·标准", "我的预设"],
        "last_used": "人声：最优",
    }
    with open(presets.PRESETS_FILE, "w", encoding="utf-8") as f:
        json.dump(v2, f, ensure_ascii=False)

    p, last = presets.load_presets()

    # 13 个老内置名确实全删了
    assert not [n for n in presets.REMOVED_BUILTINS if n in presets._builtin_presets()]
    # 用户预设一字不丢（含与老内置同名的那个）
    assert p["我的预设"]["params"]["onset_threshold"] == 0.42
    assert p["通用·标准"]["mode"] == "piano" and p["通用·标准"]["params"]["custom"] == 1
    # 新内置**没有**被残留的旧名误伤
    assert "Basic Pitch · 最优" not in p      # 这条是真的被用户隐藏了
    assert "钢琴 · 最优" in p
    # last_used 指向已不存在的预设 → 空串，交给前端按模型默认决定
    assert last == ""

    raw = json.load(open(presets.PRESETS_FILE, encoding="utf-8"))
    assert presets.SCHEMA_VERSION == 3 and raw["schema_version"] == 3
    assert raw["hidden_builtins"] == ["Basic Pitch · 最优"]
    assert raw["order"] == ["通用·标准", "我的预设"]
    assert sorted(raw["presets"]) == ["我的预设", "通用·标准"]

    # 迁移是幂等的：再读一次不该改文件
    presets.load_presets()
    assert json.load(open(presets.PRESETS_FILE, encoding="utf-8")) == raw


def test_frontend_fallback_presets_match_engine():
    """前端那份「网页版兜底预设」必须与引擎内置预设**同名** —— 否则网页版自动套默认找不到预设。

    桌面端的预设名由 presets.list 下发，不会漂移；会漂移的是 ViewTranscribe.vue 里手写的
    兜底表（只在无桥接的网页版用到，平时跑不到）。这条用例把两边钉在一起：
    改名字必须两边一起改。
    """
    import io
    import os
    path = os.path.normpath(os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        os.pardir, os.pardir, 'frontend', 'src', 'views', 'ViewTranscribe.vue'))
    assert os.path.exists(path), f'找不到前端文件：{path}'
    with io.open(path, encoding='utf-8') as f:
        src = f.read()
    names = set(presets._builtin_presets()) | set(presets.MODEL_DEFAULT_PRESET.values())
    for name in sorted(names):
        assert name in src, f'前端兜底表缺少内置预设名 {name!r}（改名字要两边一起改）'
    for key in sorted(presets.MODEL_DEFAULT_PRESET):
        assert (key + ':') in src, f'前端兜底表缺少模型键 {key!r}'


def test_model_preset_binding_roundtrip(monkeypatch, tmp_path):
    """「用户指定某模型用某个预设」的落点 —— 也是「记住用户选择」的载体。"""
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    assert presets.load_model_preset_map() == {}          # 从没绑定过 = 全用内置默认
    assert presets.set_model_preset("", "x") is False      # 空键不写
    presets.save_preset("我的预设", "piano", {"min_note_ms": 60})
    assert presets.set_model_preset("aria", "我的预设") is True
    assert presets.load_model_preset_map() == {"aria": "我的预设"}
    # 解绑 → 回到内置默认（界面的「恢复该模型默认」）
    assert presets.set_model_preset("aria", "") is True
    assert presets.load_model_preset_map() == {}


def test_deleting_a_preset_unbinds_models_pointing_at_it(monkeypatch, tmp_path):
    """预设被删掉后绑定必须一起解掉 —— 否则切模型会去套一个不存在的预设，界面像"没反应"。"""
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    presets.save_preset("临时", "piano", {"min_note_ms": 60})
    presets.set_model_preset("aria", "临时")
    assert presets.delete_preset("临时") is True
    assert presets.load_model_preset_map() == {}


def test_last_used_resets_when_preset_is_gone(monkeypatch, tmp_path):
    """last_used 指向已删除的预设时返回空串 —— 由前端按模型默认决定，不硬塞一个名字。"""
    monkeypatch.setattr(presets, "PRESETS_FILE", str(tmp_path / "presets.json"))
    presets.save_last_used("早就删了的预设")
    _, last = presets.load_presets()
    assert last == ""
