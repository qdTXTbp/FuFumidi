# -*- coding: utf-8 -*-
"""单音素音素化器基类 —— **照搬** `OpenUtau.Plugin.Builtin/MonophonePhonemizer.cs`（31 行）。

只做两件事：**关掉自动收尾**（`addTail = false`），以及实现
`GetPhonemeOrFallback`（"一个符号 → 一个别名"）。

## 照搬时保留的语义
- 构造函数里 `addTail = false`：与基类默认（true）**相反** —— 单音素声库不需要
  自动追加 `"-"` 收尾音。
- `GetPhonemeOrFallback` 的**四段回落顺序**：
  1. `"{symbol}{alt}"`（带备用索引）；
  2. 裸 `symbol`；
  3. `vowelFallback[symbol]` 里**逐个**试（每种语言自己的元音回落表，例如
     `aa → ah`、`ae → ah`）；
  4. 都没命中 → **返回 `"{symbol}{alt}"` 这个字符串本身**（不报错、不返回 null）。
     ★ 注意第 4 步返回的**不是** `symbol`，而是**带 `alt` 后缀**的串 ——
     这是 C# 原文，容易看漏（看起来像"回落成原符号"，实际会带上备用索引）。
"""

from .phoneme_based import PhonemeBasedPhonemizer


class MonophonePhonemizer(PhonemeBasedPhonemizer):
    """对应 `MonophonePhonemizer`。"""

    def __init__(self):
        super().__init__()
        # ★ 与基类默认（True）相反
        self.add_tail = False

    def get_phoneme_or_fallback(self, prev_symbol: str, symbol: str, tone: int,
                                color: str, alt: str) -> str:
        """对应 `GetPhonemeOrFallback`。"""
        if alt:
            oto = self.mapped_oto('%s%s' % (symbol, alt), tone, color)
            if oto is not None:
                return oto.alias
        oto1 = self.mapped_oto(symbol, tone, color)
        if oto1 is not None:
            return oto1.alias
        fallbacks = self.vowel_fallback.get(symbol)
        if fallbacks:
            for fallback in fallbacks:
                oto2 = self.mapped_oto(fallback, tone, color)
                if oto2 is not None:
                    return oto2.alias
        return '%s%s' % (symbol, alt)
