# -*- coding: utf-8 -*-
"""resampler 的自描述清单 —— **照搬** `OpenUtau.Core/Classic/ResamplerManifest.cs`（28 行）。

一个 resampler 可以在自己旁边放一个同名 `.yaml`，声明它认识哪些表达式 flag；
`expressionFilter` 为真时，只有清单里列出的表达式才会转成命令行 flag
（见 `ExeResampler.SupportsFlag`）。

## 照搬时保留的语义
- `Load` 之后**表达式键统一转小写**，同一个键出现多次时**取第一个**（C# 的
  `GroupBy(...).ToDictionary(g => g.Key, g => g.First().Value)`）——
  不是"后者覆盖前者"，别顺手改成 `dict.update`。
- 反序列化用的是 OpenUTAU 的全局 Yaml 配置（下划线命名 + 忽略未知键），
  所以 `expressionFilter` 的 YAML 键是 `expression_filter`。
"""

from dataclasses import dataclass, field
from typing import Any, Dict

from ...ustx.io import from_plain
from ...ustx.model import UExpressionDescriptor


@dataclass
class ResamplerManifest:
    """对应 C# 的 `ResamplerManifest`。"""

    expressions: Dict[str, UExpressionDescriptor] = field(default_factory=dict)
    # C#: `public bool expressionFilter = false;`
    expression_filter: bool = False

    @staticmethod
    def load(path: str) -> 'ResamplerManifest':
        """对应 `ResamplerManifest.Load(path)`（读 UTF-8 YAML + 键小写化）。"""
        import yaml

        with open(path, 'r', encoding='utf-8-sig') as f:
            data = yaml.safe_load(f) or {}
        manifest = from_plain(ResamplerManifest, data)
        merged: Dict[str, Any] = {}
        for key, value in manifest.expressions.items():
            lowered = key.lower()
            # 第一个优先（C# 的 group.First()），不是后者覆盖
            if lowered not in merged:
                merged[lowered] = value
        manifest.expressions = merged
        return manifest
