# -*- coding: utf-8 -*-
"""`OpenUtau.Plugin.Builtin` —— **照搬** OpenUTAU 内置音素化器。

这些是"歌词 → 音素"的具体实现，是**任何**渲染链路的前置：没有音素化就没有
`PhraseSource`，`RenderPhrase` 再完备也跑不起来。它们完全无原生依赖、纯逻辑，
所以优先照搬。

已照搬：
  - `japanese_vcv.py`    Japanese VCV Phonemizer (legacy)（JapaneseVCVPhonemizer.cs 116 行）

未照搬（后续）：
  - `ChineseVCVPhonemizer.cs`(241) / `ChineseCVVCPhonemizer.cs`(264) / `ArpasingPhonemizer.cs`(62)
  - 其余内置 phonemizer 与 `OpenUtau.Plugin.Builtin` 下的字典类（Presamp / VCV 等）

导入本包即完成注册（对应 C# 的 `[Phonemizer(...)]` 特性在程序集加载时注册）。
"""

from . import japanese_vcv  # noqa: F401

__all__ = ['japanese_vcv']
