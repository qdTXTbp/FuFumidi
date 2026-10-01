# -*- coding: utf-8 -*-
"""`.ustx` 读写 —— 对齐 OpenUTAU `OpenUtau.Core/Util/Yaml.cs` 的序列化设置。

照搬的四处关键设置（`Yaml.cs`）：
  1. `WithNamingConvention(UnderscoredNamingConvention)` —— `ustxVersion` → `ustx_version`。
     （我们靠 model.py 里属性和 YAML 键同名来实现，不需要映射表。）
  2. `ConfigureDefaultValuesHandling(OmitNull)` —— **值为 None 的字段不写**。
  3. `DisableAliases` —— 不产生 YAML 锚点/别名（PyYAML 里用 ignore_aliases=True）。
  4. `IgnoreUnmatchedProperties`（读）—— **未知键一律忽略**，便于向后兼容新版本文件。

注意：**不追求与 OpenUTAU 逐字节相同的排版**（它还有个 FlowEmitter 控制折行），
只保证「语义往返一致 + 键名合法」——即 OpenUTAU 能读我们写的、我们能读它写的。

`BeforeSave` / `AfterLoad` 也照搬 UProject.cs：
  - 保存前：把运行时统一的 `parts` 按类型拆成 `voice_parts` / `wave_parts`，
    并各自按 (track_no, position) 排序；保存后清空这两个临时字段。
  - 读取后：把 `voice_parts` / `wave_parts` 并回 `parts`。
"""

import dataclasses
import typing

import yaml

from .model import UPart, UProject, UVoicePart, UWavePart


class _NoAliasDumper(yaml.SafeDumper):
    """对应 DisableAliases：相同对象也不产生 &anchor / *alias。"""

    def ignore_aliases(self, data):
        return True


# ---------------------------------------------------------------- 对象 → 纯数据

def _yaml_key(f) -> str:
    """字段在 YAML 里的键名。

    默认就是字段名；仅当 C# 用了**关键字标识符**（如 `public float @in`）时才需要别名 ——
    Python 里 `in`/`out` 是关键字，不能直接当属性名，所以用 `metadata={'yaml_name': ...}`
    指定真实键名，保证写出来的 .ustx 与 OpenUTAU 完全一致。
    """
    return f.metadata.get('yaml_name') or f.name


def to_plain(obj):
    """把 model 转成 dict/list/标量（跳过 [YamlIgnore]、跳过 None）。"""
    if dataclasses.is_dataclass(obj) and not isinstance(obj, type):
        out = {}
        for f in dataclasses.fields(obj):
            if f.metadata.get('yaml') is False:
                continue
            v = getattr(obj, f.name)
            if v is None:            # OmitNull
                continue
            out[_yaml_key(f)] = to_plain(v)
        return out
    if isinstance(obj, (list, tuple)):
        return [to_plain(v) for v in obj]
    if isinstance(obj, dict):
        return {k: to_plain(v) for k, v in obj.items()}
    return obj


# ---------------------------------------------------------------- 纯数据 → 对象

def _unwrap_optional(tp):
    """Optional[X] / X|None → (X, True)。"""
    args = typing.get_args(tp)
    if args and type(None) in args:
        rest = [a for a in args if a is not type(None)]
        return (rest[0] if len(rest) == 1 else typing.Union[tuple(rest)]), True
    return tp, False


def _convert(tp, v):
    if v is None:
        return None
    tp, _ = _unwrap_optional(tp)
    if tp is typing.Any or tp is None:
        return v
    origin = typing.get_origin(tp)
    args = typing.get_args(tp)
    if origin in (list, typing.List):
        inner = args[0] if args else typing.Any
        return [_convert(inner, i) for i in v]
    if origin in (dict, typing.Dict):
        inner = args[1] if len(args) > 1 else typing.Any
        return {k: _convert(inner, val) for k, val in v.items()}
    if dataclasses.is_dataclass(tp) and isinstance(v, dict):
        return from_plain(tp, v)
    return v


def from_plain(cls, data):
    """按数据类声明构造；**未知键忽略**（对应 IgnoreUnmatchedProperties）。"""
    if data is None:
        return None
    if not isinstance(data, dict):
        return data
    hints = typing.get_type_hints(cls)
    kwargs = {}
    for f in dataclasses.fields(cls):
        key = _yaml_key(f)
        if key not in data:
            continue
        kwargs[f.name] = _convert(hints.get(f.name, typing.Any), data[key])
    return cls(**kwargs)


# ---------------------------------------------------------------- BeforeSave / AfterLoad

def before_save(project: UProject) -> None:
    """照搬 UProject.BeforeSave：把 parts 拆成 voice_parts / wave_parts 并排序。"""
    parts = list(project.parts or [])
    if not parts:
        # 没有运行时 parts 时，沿用已有的 voice_parts/wave_parts（例如刚从文件读出来）
        parts = list(project.voice_parts or []) + list(project.wave_parts or [])

    def key(p):
        return (getattr(p, 'track_no', 0), getattr(p, 'position', 0))

    project.voice_parts = sorted([p for p in parts if isinstance(p, UVoicePart)],
                                 key=key) or None
    project.wave_parts = sorted([p for p in parts if isinstance(p, UWavePart)],
                                key=key) or None


def after_save(project: UProject) -> None:
    """照搬 UProject.AfterSave：清空序列化临时字段。"""
    project.voice_parts = None
    project.wave_parts = None


def after_load(project: UProject) -> None:
    """照搬 UProject.AfterLoad：把 voice_parts / wave_parts 并回 parts。"""
    merged = []
    if project.voice_parts:
        merged.extend(project.voice_parts)
    if project.wave_parts:
        merged.extend(project.wave_parts)
    project.parts = merged
    project.voice_parts = None
    project.wave_parts = None


# ---------------------------------------------------------------- 对外接口

def dumps(project: UProject) -> str:
    before_save(project)
    try:
        text = yaml.dump(to_plain(project), Dumper=_NoAliasDumper,
                         allow_unicode=True, sort_keys=False,
                         default_flow_style=False, width=10 ** 6)
    finally:
        after_save(project)
    return text


def loads(text: str) -> UProject:
    data = yaml.safe_load(text) or {}
    project = from_plain(UProject, data)
    after_load(project)
    return project


def load_ustx(path: str) -> UProject:
    with open(path, 'r', encoding='utf-8-sig') as f:
        return loads(f.read())


def save_ustx(project: UProject, path: str) -> None:
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(dumps(project))
