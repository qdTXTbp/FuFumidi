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
    """引擎所在目录。**只用来找旧位置的预设**，不再作为写入落点。"""
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


def _data_root():
    """用户数据根目录 —— 与 engine_rvc 的模型目录解析**同一条规则**（gsv_env 已随翻唱改走 RVC 删除）。

    优先级：FUFUMIDI_DATA_DIR → FUFUMIDI_MODELS_DIR 的上一级 → 引擎目录的上一级。
    主进程跑引擎时一定会设 FUFUMIDI_MODELS_DIR，所以实战里走的是第二条。

    ★★ 为什么必须搬到这里：原来的落点是引擎目录（见 _base_dir），而引擎装在
    `<安装目录>/resources/app.asar.unpacked/engine/`。**整包更新会替换 resources/**，
    于是用户的预设与「上次用的那个」会被静默清空 —— 实测确认过。
    预设属于用户数据，必须落在数据根（FuFumidiData）里，跟模型/声库同一处。
    """
    env = os.environ.get("FUFUMIDI_DATA_DIR")
    if env and os.path.isdir(env):
        return os.path.abspath(env)
    models = os.environ.get("FUFUMIDI_MODELS_DIR") or ""
    if models:
        return os.path.abspath(os.path.dirname(models.rstrip("\\/")))
    return os.path.abspath(os.path.join(_base_dir(), os.pardir))


#: 用户预设的**新**落点（数据根下，更新不会碰）
PRESETS_FILE = os.path.join(_data_root(), "presets.json")

#: **旧**落点（引擎目录内）。只做一次性迁移的来源，**永不删除** —— 留着当回滚路径。
LEGACY_PRESETS_FILE = os.path.join(_base_dir(), "presets.json")

#: 迁移只在「新文件不存在」时做一次
_migrated = False


def _migrate_legacy_once():
    """新落点还没有文件、而旧落点有内容 → 抄一份过去。

    只读旧文件、不删不改；拷完即可继续用。这样即便迁移逻辑将来出问题，
    旧文件仍在原处，用户随时能手工找回。
    """
    global _migrated
    if _migrated:
        return
    _migrated = True
    try:
        if os.path.exists(PRESETS_FILE) or not os.path.exists(LEGACY_PRESETS_FILE):
            return
        with open(LEGACY_PRESETS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict) or not data:
            return
        # 旧文件是「空壳」（只有键、没内容）就不迁，免得把空状态固化过去
        if not (data.get("presets") or data.get("last_used") or data.get("hidden_builtins")
                or data.get("order")):
            return
        os.makedirs(os.path.dirname(PRESETS_FILE) or ".", exist_ok=True)
        with open(PRESETS_FILE, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


#: 模型标识 → 内置默认预设名。
#: ★ 契约：前端 `ViewTranscribe.currentModelKey()` 必须产出同一套键。
#: 切模型时前端查这张表套用默认预设；用户在界面上指定过就写进 model_preset（见 set_model_preset）。
MODEL_DEFAULT_PRESET = {
    "basic":             "Basic Pitch · 最优",
    "yourmt3":            "YourMT3+ · 最优",
    "miros":              "MIROS · 最优",
    "muscriptor_small":  "MuScriptor · 最优",
    "muscriptor_medium": "MuScriptor · 最优",
    "muscriptor_large":  "MuScriptor · 最优",
    "piano_pt":          "钢琴 · 最优",
    "aria":              "Aria-AMT · 最优",
    "transkun":          "Transkun · 最优",
    "hft":               "hFT-Transformer · 最优",
    "separate":          "分离 · 最优",
}

#: 旧版按「用途」命名的 13 个内置预设，v3 起**全部删除**。
#: 迁移时只用来确认"这个名字已经不是内置了"；**绝不删 data["presets"] 里的同名条目**
#: —— 那可能是用户自己存下来的预设，属用户数据。列表本身也被测试用来钉住"确实删干净了"。
REMOVED_BUILTINS = (
    "人声：最优", "钢琴：最优",
    "通用·标准", "通用·更干净", "通用·更灵敏", "通用·人声主旋律", "通用·人声纯净",
    "通用·吉他拨弦", "通用·低音乐器",
    "钢琴·标准", "钢琴·快速琶音",
    "分离·标准", "分离·带鼓组",
)


def _builtin_presets():
    """内置预设：**每个模型一套**（旧版那 13 套按用途命名的已全部删除）。

    判据（用户明确）：**最高质量 + 保证稳定性，不考虑速度与性能**。落到参数上：

    · **只影响速度/资源的 → 一律取最重的一档**：`perf=quality`（全核 + 批量上限最高）、
      `precision=fp32`（bf16 改数值精度，属影响质量的开关）、TTA 开（引擎文档：
      「小幅提升质量，推理时间 ×3」—— 纯速度代价）。
    · **影响结果、且"值越高越不稳定"的 → 取中性值**：`temperature=1.0`、
      `cfg_coef=1.0`、`beam_size=1`。中性值**就是**稳定性锚点 ——
      "越高越准"没有任何实测支撑，不拿它换不确定性。
    · **不干预 > 强行干预**：`muscriptor_instruments='none'`（不硬禁乐器组）。少一层猜测就少一层引入错误的机会。
    · ★ **`max_note_hold` 保持 0（不截断）**：僵尸音符已改为**音频证据式收尾** ——
      引擎在块边界按音频判断该音是否还有能量，没能量才收尾（收在静音开始处）。
      按时长硬截断会误伤音频里真实存在的长音（用户明确否掉）。上限仍保留为可选兜底。
    · 每个模型只写**它自己适用**的键，不适用的不写 —— 界面按"预设没给就保留当前值"应用，
      惰性字段只会让状态来源变得不可读。

    两处**不必写**的：Aria 的 `variant`（engine_aria 缺省就是 `medium-double`，
    资源中心只镜像这一个变体）；Transkun 的 `device`（缺省 auto）。

    ★ 由此推出一条**前端契约**：MuScriptor 三个规格共用上面这一套预设，所以
      「切模型/切规格 → 自动套该模型默认」时**不许把 model / model_size 写回去**，
      否则每次切规格都会被打回 `medium`。前端用 `applyPresetParams(p, {keepModel:true})`
      走这条路径；用户**手动点「应用预设」**时才允许连子模型一起切。
    """
    u = DEFAULTS["universal"]
    p = DEFAULTS["piano"]
    s = DEFAULTS["separate"]
    basic = {
        "model": "basic",
        "onset_threshold": 0.5, "frame_threshold": 0.3,
        "minimum_note_length": 128.0,
        "melodia": True,              # 主旋律强化开（关掉 = 界面的「低音增强」）
        "min_freq": 0, "max_freq": 0,  # 0 = 不限制音高范围
        "beat_grid": True,            # 节拍网格检测：装了 beat_this 就开
        "tempo": 0,                   # 0 = 引擎默认 120（自动 BPM 优先）
        "perf": "quality",
        "denoise_mode": "off", "auto_bpm": False,
        # ★ 2026-10-21：「识别片段长度」已移除 —— 分块转录实测块间质量参差不齐。
        #   所有模型一律用各自的原生块长（= 训练块长），预设里不再有这个键。
    }
    piano = {
        "onset_threshold": 0.3, "frame_threshold": 0.1,
        "min_note_ms": 60, "merge_gap_ms": 30,
        "include_pedal": True,        # 踏板：钢琴转录的必需信息，绝不默认丢
        "perf": "quality",
        "denoise_mode": "off", "auto_bpm": False,
    }
    sep = {k: v for k, v in s.items() if k in
           ("onset_threshold", "frame_threshold", "minimum_note_length", "midi_tempo")}
    return {
        "Basic Pitch · 最优": {"mode": "universal", "params": dict(basic)},
        "YourMT3+ · 最优": {"mode": "universal", "params": {**basic, "model": "yourmt3"}},
        "MIROS · 最优": {"mode": "universal", "params": {**basic, "model": "miros"}},
        "MuScriptor · 最优": {
            "mode": "universal",
            "params": {
                **basic,
                "model": "muscriptor", "model_size": "medium",
                "temperature": 1.0, "cfg_coef": 1.0, "beam_size": 1,
                "prelude_forcing": True,
                "precision": "fp32",
                "max_note_hold": 0,       # ★ 不截断：僵尸音改由**音频证据**收尾（见 engine_muscriptor 的 _make_pitch_evidence）
                # ★ 2026-10-21：静音分段与「识别片段长度」均已移除（分块转录，块间质量参差）。
                #   MuScriptor 一律用上游训练/推理块长 5s；跨块延音由 _stitch_chunk_boundaries 缝合。
            },
        },
        "钢琴 · 最优": {"mode": "piano", "params": {**piano, "model": "piano_pt"}},
        "Aria-AMT · 最优": {"mode": "piano", "params": {**piano, "model": "aria"}},
        "Transkun · 最优": {"mode": "piano", "params": {**piano, "model": "transkun"}},
        "hFT-Transformer · 最优": {"mode": "piano", "params": {**piano, "model": "hft"}},
        "分离 · 最优": {
            "mode": "separate",
            "params": {
                **sep,
                "include_drums": True,     # 鼓组轨开
                "stem_format": "wav",      # 分轨格式 wav（无损）
                "perf": "quality",
                "denoise_mode": "off", "auto_bpm": False,
            },
        },
    }


#: 数据格式版本。改动结构时**只加迁移分支、不改老分支** —— 这样老用户的文件永远读得进来。
SCHEMA_VERSION = 3


def _migrate_schema(data):
    """结构迁移。返回 (data, changed)。**只加分支，永不修改已有分支。**

    v3：内置预设从「按用途命名的 13 套」改成「每个模型一套」，旧内置名不复存在。
        · `hidden_builtins` 里残留的旧名要清掉 —— 留着的话，用户以后存一个同名预设会被
          静默隐藏（隐藏语义只对内置有意义，所以按"当前内置名"过滤）；
        · `order` 里残留的旧名是死键，一并清掉；
        · `presets`（用户预设）**一个都不动**。
    """
    v = data.get("schema_version") or 0
    changed = v != SCHEMA_VERSION
    if v < 3:
        builtin_names = set(_builtin_presets().keys())
        live = builtin_names | set((data.get("presets") or {}).keys())
        hb = [n for n in (data.get("hidden_builtins") or []) if n in builtin_names]
        if hb != list(data.get("hidden_builtins") or []):
            data["hidden_builtins"] = hb
        od = [n for n in (data.get("order") or []) if n in live]
        if od != list(data.get("order") or []):
            data["order"] = od or None
    return data, changed


def _unbind_model_presets(data, name):
    """预设被删掉时，把"指向它的模型绑定"一并解掉。

    否则切到那个模型会去套用一个已经不存在的预设，界面表现为"什么都没发生"。
    """
    m = dict(data.get("model_preset") or {})
    for k in [k for k, v in m.items() if v == name]:
        m.pop(k, None)
    data["model_preset"] = m

def _read_file():
    _migrate_legacy_once()
    try:
        with open(PRESETS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        data = data if isinstance(data, dict) else {}
    except Exception:
        return {}
    data, changed = _migrate_schema(data)
    if changed:
        # 迁移结果立刻落盘：_write_file 会顺手把 schema_version 盖成最新，
        # 于是这个分支只会走一次（幂等）。
        _write_file(data)
    return data


def _write_file(data):
    try:
        data = dict(data or {})
        data["schema_version"] = SCHEMA_VERSION
        os.makedirs(os.path.dirname(PRESETS_FILE) or ".", exist_ok=True)
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
    # v3：last_used 可能指向已删除的老内置预设。那种情况返回空串，由前端按
    # 「当前模型的默认预设」决定 —— 不再像旧版那样硬塞一个「人声：最优」。
    last = data.get("last_used", "")
    if last not in presets:
        last = ""
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
        _unbind_model_presets(data, name)
        return _write_file(data)
    if name in data.get("presets", {}):
        del data["presets"][name]
        order = [n for n in (data.get("order") or []) if n != name]
        data["order"] = order or None
        _unbind_model_presets(data, name)
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


def reorder_preset_to(name, index):
    """把预设 name 拖到展示顺序的 index 位置（0 起），并持久化。返回新顺序。

    供界面拖拽排序使用：一次定位，不需要反复 ±1。
    """
    presets, _ = load_presets()
    names = list(presets.keys())
    if name not in names:
        return names
    names.remove(name)
    index = max(0, min(len(names), int(index or 0)))
    names.insert(index, name)
    data = _read_file()
    data["order"] = names
    _write_file(data)
    return names


def save_last_used(name):
    data = _read_file()
    data["last_used"] = name
    _write_file(data)


def load_model_preset_map():
    """模型键 → **用户指定**的预设名。键见 MODEL_DEFAULT_PRESET。

    没列出的模型 = 用内置默认。这张表就是「记住用户的选择」的落点：
    它与 preset 数据同在数据根，整包更新不会碰。
    """
    data = _read_file()
    m = data.get("model_preset") or {}
    return {k: v for k, v in m.items()
            if isinstance(k, str) and isinstance(v, str) and v}


def set_model_preset(key, name):
    """把某个模型绑定到某个预设；name 传空 = 解绑、回到内置默认。"""
    key = (key or "").strip()
    if not key:
        return False
    data = _read_file()
    m = dict(data.get("model_preset") or {})
    name = (name or "").strip()
    if name:
        m[key] = name
    else:
        m.pop(key, None)
    data["model_preset"] = m
    return _write_file(data)


def preset_names():
    presets, _ = load_presets()
    return list(presets.keys())
