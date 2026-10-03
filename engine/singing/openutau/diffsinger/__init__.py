# -*- coding: utf-8 -*-
"""DiffSinger 的 `IRenderer` 实现（照搬 `OpenUtau.Core/DiffSinger/DiffSingerRenderer.cs`）。

★ 与 `singing/adapters/diffsinger.py` 的区别：
  - 那个实现**简化协议** `api.Renderer`（`render(req)` 整曲一把梭）
  - 这个实现**完整协议** `openutau.renderer.IRenderer`（`render(phrase)` 逐句），
    由 `PhraseSource` / `RenderPhrase` 驱动，从而接上**工程管理与片段管理**
    （切句、wav 缓存、ApplyDynamics、hash）
"""
from .diffsinger_renderer import (  # noqa: F401
    ENE, PEXP, VELC, DiffsingerIRenderer, _factory,
)
from .ml_phonemizer import MLNote, MlPhonemizer  # noqa: F401
from .render_engine import (  # noqa: F401
    MixPlanner, RenderPartRequest, build_render_requests, render_requests,
)

# ★ 导入本包即完成 `DIFFSINGER` 的注册（与 `singing/openutau/classic/__init__.py:48`
#   的 `register_classic_renderer` 同一时机）。少了这一步，
#   `create_renderer('DIFFSINGER')` 会因为**注册表里没有**而返回 None
#   （`renderers.py` 刻意不反向依赖各渲染器，避免循环导入）。
from ..renderers import register_renderer as _register_renderer  # noqa: E402
from ..renderers import DIFFSINGER as _DIFFSINGER               # noqa: E402

_register_renderer(_DIFFSINGER, _factory)

__all__ = [
    'DiffsingerIRenderer', 'VELC', 'ENE', 'PEXP', 'MLNote', 'MlPhonemizer',
    'RenderPartRequest', 'build_render_requests', 'render_requests', 'MixPlanner',
]
