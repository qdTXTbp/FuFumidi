# -*- coding: utf-8 -*-
"""粤语 CVVC 音素化器 —— **照搬**
`OpenUtau.Plugin.Builtin/CantoneseCVVCPhonemizer.cs`（18 行）。

C# 声明：
`[Phonemizer("Cantonese CVVC Phonemizer", "ZH-YUE CVVC", "Lotte V", language: "ZH-YUE")]`

**全文件只有一处差异**：它继承 `ChineseCVVCPhonemizer`，只重写 `Romanize`，
把「汉字 → 拼音」换成「汉字 → 粤拼」。其余（`presamp.ini` 的 `[VOWEL]` /
`[CONSONANT]` / `[REPLACE]` 三张表、VC/CV 拆分、`vcLen` 算法）**一行不差**地
复用中文 CVVC —— 所以这里也只重写 `romanize`，不复制任何逻辑。

★ 载体差异：粤拼表来自 NuGet `csharp-pinyin` 的 `Pinyin.Jyutping.Instance`，
Python 侧没有等价的标准库 → 走 `base_chinese` 的可注入钩子
（`set_jyutping_converter`），未注入时惰性探测 `ToJyutping` / `pycantonese`，
都没有则**汉字原样返回**。这与 C# 的 `Pinyin.Error.Default`（转不出来保留原样）
**语义相同**，只是降级发生得更早一些。
"""

from ..base_chinese import BaseChinesePhonemizer
from ..phonemizer import register
from .chinese_cvvc import ChineseCVVCPhonemizer


@register
class CantoneseCVVCPhonemizer(ChineseCVVCPhonemizer):
    """对应 `CantoneseCVVCPhonemizer`。"""

    name = 'Cantonese CVVC Phonemizer'
    tag = 'ZH-YUE CVVC'
    author = 'Lotte V'
    language = 'ZH-YUE'

    def romanize(self, lyrics):
        """对应 `Romanize`：改用粤拼，其余与中文 CVVC 完全一致。"""
        return BaseChinesePhonemizer.romanize_jyutping(lyrics)
