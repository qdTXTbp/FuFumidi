# -*- coding: utf-8 -*-
"""拉丁语系双音素（diphone）音素化器基类 —— **照搬**
`OpenUtau.Plugin.Builtin/LatinDiphonePhonemizer.cs`（35 行，**抽象、不注册**）。

它只做一件事：把"上一符号 + 本符号"**拼成一个双音素别名**去查 oto。
`ArpasingPhonemizer` / `FrenchCMUSphinxPhonemizer` / `GermanDiphonePhonemizer`
都继承它。

## 照搬时保留的语义
`GetPhonemeOrFallback` 的**五段回落顺序**（比 `Monophone` 多一段）：
1. `"{prevSymbol} {symbol}{alt}"`（双音素 + 备用索引）
2. `"{prevSymbol} {symbol}"`（双音素）
3. `vowelFallback[symbol]` 里**逐个**试 `"{prevSymbol} {fallback}"`
4. ★ **`"- {symbol}"`** —— 单音素回落到"词首格式"（`Monophone` 没有这一段）
5. 全落空 → 返回 `"{prevSymbol} {symbol}{alt}"`（**带 `alt` 后缀**，同 `Monophone` 的 quirk）

★ 注意第 1 与第 5 段拼的是**同一个字符串** —— 也就是说"查不到就原样返回那个查过但
不存在的别名"。看起来像冗余，但它是**上游行为**：返回值会变成本音符的音素名，
下游拿它再去查 oto 时会落空并走别的回落。照搬不改。
"""

from .phoneme_based import PhonemeBasedPhonemizer


class LatinDiphonePhonemizer(PhonemeBasedPhonemizer):
    """对应 `LatinDiphonePhonemizer`。"""

    def get_phoneme_or_fallback(self, prev_symbol: str, symbol: str, tone: int,
                                color: str, alt: str) -> str:
        """对应 `GetPhonemeOrFallback`。"""
        if alt:
            oto = self.mapped_oto('%s %s%s' % (prev_symbol, symbol, alt), tone, color)
            if oto is not None:
                return oto.alias
        oto1 = self.mapped_oto('%s %s' % (prev_symbol, symbol), tone, color)
        if oto1 is not None:
            return oto1.alias
        fallbacks = self.vowel_fallback.get(symbol)
        if fallbacks:
            for fallback in fallbacks:
                oto2 = self.mapped_oto('%s %s' % (prev_symbol, fallback), tone, color)
                if oto2 is not None:
                    return oto2.alias
        # ★ 这一段是 Monophone 没有的：回落到"词首格式"
        oto3 = self.mapped_oto('- %s' % symbol, tone, color)
        if oto3 is not None:
            return oto3.alias
        return '%s %s%s' % (prev_symbol, symbol, alt)
