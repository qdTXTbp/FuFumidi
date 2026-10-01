# -*- coding: utf-8 -*-
"""singing 抽象层：渲染器 / 音素化器接口 + 注册表。

对应 OpenUTAU 的两条主抽象：
  - `OpenUtau.Core/Render/IRenderer.cs`      → 本模块的 `Renderer`
  - `OpenUtau.Core/Api/Phonemizer.cs`        → 本模块的 `Phonemizer`

设计原则（M1 的硬约束）：**只做接口与适配，不改行为**。
现有 `engine_utau.py` / `engine_diffsinger.py` 的内部实现一行不动，
由 `singing/adapters/*` 包一层薄适配器把它们接进这两条抽象；
适配器必须与直接调用原函数结果逐位一致（见 `engine/tests/test_singing_adapters.py`）。
真正的重写（worldline、DiffSinger 流水线拆分、多语言 phonemizer）属于 M2+。

按名字解析：
    from singing import get_renderer, get_phonemizer
    r = get_renderer('utau', voicebank_dir=...)     # 或 'utau'
    p = get_phonemizer('diffsinger', voicebank_dir=...)
"""

import importlib
from abc import ABC, abstractmethod
from typing import Dict, List, Optional

from .types import PhonemizedNote, RenderContext, RenderPitchResult, RenderRequest, RenderResult

# 适配器模块：import 时自行注册。新增引擎只改这里。
_ADAPTER_MODULES = (
    'singing.adapters.utau',
    'singing.adapters.diffsinger',
)

_RENDERERS: Dict[str, type] = {}
_PHONEMIZERS: Dict[str, type] = {}


class Renderer(ABC):
    """把「乐句」渲染成波形。对齐 OpenUTAU IRenderer。"""

    name: str = ''            # 注册名，如 'utau' / 'diffsinger'
    #: 该渲染器能处理的引擎类型（供 UI 与路由判断）
    kinds: tuple = ()

    def __init__(self, voicebank_dir: str = '', **opts):
        self.voicebank_dir = voicebank_dir
        self.opts = opts

    @abstractmethod
    def render(self, req: RenderRequest, ctx: Optional[RenderContext] = None) -> RenderResult:
        """渲染 req.notes 对应的波形。失败应抛异常，不要把错误塞进 samples。"""

    def pitch(self, req: RenderRequest, ctx: Optional[RenderContext] = None) -> RenderPitchResult:
        """帧级音高。不是所有渲染器都能给（默认不支持）。"""
        raise NotImplementedError('该渲染器未实现 pitch()')


class Phonemizer(ABC):
    """把每个音符的歌词拆成音素序列。对齐 OpenUTAU Phonemizer。"""

    name: str = ''
    kinds: tuple = ()

    def __init__(self, voicebank_dir: str = '', **opts):
        self.voicebank_dir = voicebank_dir
        self.opts = opts

    @abstractmethod
    def phonemize(self, notes: List[dict], ctx: Optional[RenderContext] = None) -> List[PhonemizedNote]:
        """notes 沿用现有 IPC 的音符结构（含 lyric）。返回每个音符的音素。"""


# ---------------------------------------------------------------- 注册表

def register_renderer(cls: type) -> type:
    if not getattr(cls, 'name', ''):
        raise ValueError('Renderer 必须有非空 name')
    _RENDERERS[cls.name] = cls
    return cls


def register_phonemizer(cls: type) -> type:
    if not getattr(cls, 'name', ''):
        raise ValueError('Phonemizer 必须有非空 name')
    _PHONEMIZERS[cls.name] = cls
    return cls


def _ensure_loaded() -> None:
    for mod in _ADAPTER_MODULES:
        try:
            importlib.import_module(mod)
        except Exception:
            # 单个适配器缺失（如缺 torch/onnxruntime）不应连累其它适配器
            continue


def renderer_names() -> List[str]:
    _ensure_loaded()
    return sorted(_RENDERERS)


def phonemizer_names() -> List[str]:
    _ensure_loaded()
    return sorted(_PHONEMIZERS)


def get_renderer(name: str, **kw) -> Renderer:
    _ensure_loaded()
    cls = _RENDERERS.get(str(name or '').lower())
    if cls is None:
        raise KeyError('未知的渲染器「%s」，可用：%s' % (name, ', '.join(sorted(_RENDERERS)) or '（无）'))
    return cls(**kw)


def get_phonemizer(name: str, **kw) -> Phonemizer:
    _ensure_loaded()
    cls = _PHONEMIZERS.get(str(name or '').lower())
    if cls is None:
        raise KeyError('未知的音素化器「%s」，可用：%s' % (name, ', '.join(sorted(_PHONEMIZERS)) or '（无）'))
    return cls(**kw)
