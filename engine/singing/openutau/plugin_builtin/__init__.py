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
  - `latin_diphone.py`   `LatinDiphonePhonemizer` 基类（35 行，**抽象、不注册**）
  - `chinese_cvv.py`     Chinese CVV（十月式整音扩张）（ChineseCVVPhonemizer.cs 133 行，
                         含手写的 `ChineseCVVG2p`）
  - `syllable_based.py`  `SyllableBasedPhonemizer` 基类（**2204 行**，最重的一条线，
                         **抽象、不注册**；含 YAML 配置装载 + 规则引擎 + 边界替换）
  - `french_vccv.py`    French VCCV m2RUg Phonemizer（FrenchVCCVPhonemizer.cs 294 行；
                         **`SyllableBased` 基类的第一个真实用户**）
  - `french_cvvc.py`    French CVVC Phonemizer（FrenchCVVCPhonemizer.cs 757 行；
                         同语言家族的第二个真实用户，验证基类 + 复杂别名格式化）

未照搬（后续）：
  - `SyllableBasedPhonemizer` 家族的其余 15 个具体子类（EnglishVCCV / EnglishCVVC 等）
  - `ChineseCVVPlusPhonemizer.cs` / `ArpasingPhonemizer.cs`(62) 等其余内置 phonemizer
  - `OpenUtau.Plugin.Builtin` 下的字典类（Presamp / VCV 等）

导入本包即完成注册（对应 C# 的 `[Phonemizer(...)]` 特性在程序集加载时注册）。
"""

from . import chinese_cvvc  # noqa: F401
from . import chinese_vcv  # noqa: F401
from . import chinese_cvv  # noqa: F401
from . import japanese_cvvc  # noqa: F401
from .french_cvvc import FrenchCVVCPhonemizer  # noqa: F401
from .french_vccv import FrenchVCCVPhonemizer  # noqa: F401
from .latin_diphone import LatinDiphonePhonemizer  # noqa: F401
from .monophone import MonophonePhonemizer  # noqa: F401
from .phoneme_based import PhonemeBasedPhonemizer  # noqa: F401
from .syllable_based import SyllableBasedPhonemizer  # noqa: F401
from . import japanese_vcv  # noqa: F401

__all__ = ['japanese_vcv', 'chinese_vcv', 'chinese_cvvc', 'japanese_cvvc', 'chinese_cvv',
           'PhonemeBasedPhonemizer', 'MonophonePhonemizer', 'LatinDiphonePhonemizer',
           'SyllableBasedPhonemizer', 'FrenchVCCVPhonemizer', 'FrenchCVVCPhonemizer']
