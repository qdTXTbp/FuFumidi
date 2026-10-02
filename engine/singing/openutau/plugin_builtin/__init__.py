# -*- coding: utf-8 -*-
"""`OpenUtau.Plugin.Builtin` —— **照搬** OpenUTAU 内置音素化器。

这些是"歌词 → 音素"的具体实现，是**任何**渲染链路的前置：没有音素化就没有
`PhraseSource`，`RenderPhrase` 再完备也跑不起来。它们完全无原生依赖、纯逻辑，
所以优先照搬。

已照搬：
  - `japanese_vcv.py`    Japanese VCV Phonemizer (legacy)（JapaneseVCVPhonemizer.cs 116 行）
  - `chinese_vcv.py`     Chinese VCV Phonemizer（ChineseVCVPhonemizer.cs 241 行）
  - `japanese_cvvc.py`   Japanese CVVC Phonemizer (legacy)（JapaneseCVVCPhonemizer.cs 298 行）
  - `phoneme_based.py`   `PhonemeBasedPhonemizer` 基类（226 行，**抽象、不注册**）
  - `monophone.py`       `MonophonePhonemizer` 基类（31 行，**抽象、不注册**）
  - `chinese_cvv.py`     Chinese CVV（十月式整音扩张）（ChineseCVVPhonemizer.cs 133 行，
                         含手写的 `ChineseCVVG2p`）

未照搬（后续）：
  - `ChineseCVVPlusPhonemizer.cs` / `ArpasingPhonemizer.cs`(62)
    （Arpasing 还牵出整条 `OpenUtau.Core/G2p` 链路：`LatinDiphonePhonemizer` +
    `G2pDictionary` / `G2pFallbacks` / `ArpabetG2p` + 随包词典）
  - 其余内置 phonemizer 与 `OpenUtau.Plugin.Builtin` 下的字典类（Presamp / VCV 等）

导入本包即完成注册（对应 C# 的 `[Phonemizer(...)]` 特性在程序集加载时注册）。
"""

from . import chinese_cvvc  # noqa: F401
from . import chinese_vcv  # noqa: F401
from . import chinese_cvv  # noqa: F401
from . import japanese_cvvc  # noqa: F401
from .monophone import MonophonePhonemizer  # noqa: F401
from .phoneme_based import PhonemeBasedPhonemizer  # noqa: F401
from . import japanese_vcv  # noqa: F401

__all__ = ['japanese_vcv', 'chinese_vcv', 'chinese_cvvc', 'japanese_cvvc', 'chinese_cvv',
           'PhonemeBasedPhonemizer', 'MonophonePhonemizer']
