# -*- coding: utf-8 -*-
"""UST flags 解析 —— **照搬** `OpenUtau.Core/Classic/Flags/UstFlag.cs`(18) +
`UstFlagParser.cs`(50)。

UTAU 的 flag 是一串紧贴的记号，比如 `"g0B0H-5.5N"`：
字母/斜杠是 flag 名（`key`），紧跟其后的 `-`/`+`/数字是它的数值（`value`）。
`.ust` 格式与 UTAU 的 flag 列都用它 —— 这就是 **`.ust` 导入导出**的前置件。

## ★ 照搬时保留的语义（这个解析器很微妙，别"整理"）
1. **循环跑到 `i == text.Length`（含）**，此时做**最后一次 flush**。
   flush 条件是 `i == len || ((IsLetter(c) || c == '/') && wasDigit)` ——
   ★ C# 里 `&&` 优先级高于 `||`，等价于 `A || (B && C)`，不是 `(A || B) && C`。
2. **数值解析失败不报错**，一律当 `0`（`int.TryParse` 失败 → `value = 0`）。
3. `key` 为空时**不产出** flag（避免把开头的数字当成无名 flag）。
4. ★ `IsSingleCharacterFlag` 只有 **`N` / `e` / `u`** 三个 —— 它们**不带数值**
   （UTAU 里的 `N`=洗气、`e`/`u` 是连音标记）。命中时**立刻产出** `UstFlag(c, 0)`。
   ★ 注意那条 `continue` **跳过了 `wasDigit = False`** —— 这是上游行为：
     所以 `N` 之后如果紧跟数字，`wasDigit` 仍是上一轮的值。照搬。
5. `/` 当作 flag 名的一部分（Ust 的 flag 名里可能有斜杠，如 `p/`）。

## 载体差异
- C# 的 `readonly` 字段 `Key` / `Value` → `frozen` 式只读属性（普通属性 + 命名约定）。
- `HashSet<char>` → `set` 字面量。
"""

from dataclasses import dataclass
from typing import List

#: 对应 `IsSingleCharacterFlag` 的 `new HashSet<char> { 'N', 'e', 'u' }`
#: —— 这三个 flag **不带数值**，是 UTAU 的单字符 flag（洗气 / 连音）
SINGLE_CHARACTER_FLAGS = frozenset('Neu')


@dataclass(frozen=True)
class UstFlag:
    """对应 `UstFlag`（C# 是 `readonly` 字段，这里用 frozen dataclass）。"""

    key: str
    value: int = 0

    def __str__(self) -> str:
        """对应 `ToString() => Key + Value`（★注意没有分隔符，`g0` 而不是 `g=0`）。"""
        return '%s%d' % (self.key, self.value)


class UstFlagParser:
    """对应 `UstFlagParser`（无状态，直接 `parse()` 即可）。"""

    @staticmethod
    def is_single_character_flag(ch: str) -> bool:
        """对应私有的 `IsSingleCharacterFlag`。"""
        return ch in SINGLE_CHARACTER_FLAGS

    def parse(self, text: str) -> List[UstFlag]:
        """对应 `Parse(text)` → `IList<UstFlag>`。空输入返回**空列表**（不是 None）。"""
        flags: List[UstFlag] = []
        if not text:
            return flags

        key_chars: List[str] = []
        value_chars: List[str] = []
        was_digit = False

        n = len(text)
        # ★ 跑到 n（含）——最后一轮负责把尾巴 flush 出来
        for i in range(n + 1):
            at_end = i == n
            c = text[i] if not at_end else ''
            is_name_char = (not at_end) and (c.isalpha() or c == '/')
            if at_end or (is_name_char and was_digit):
                key = ''.join(key_chars)
                try:
                    value = int(''.join(value_chars))
                except ValueError:
                    value = 0                     # ★ 解析失败一律当 0（照搬）
                if key:
                    flags.append(UstFlag(key, value))
                key_chars.clear()
                value_chars.clear()
            if at_end:
                break
            if c in '-+' or c.isdigit():
                value_chars.append(c)
                was_digit = True
            elif c.isalpha() or c == '/':
                if not key_chars and self.is_single_character_flag(c):
                    flags.append(UstFlag(c, 0))
                    # ★ 照搬上游：这里 continue，**没有**把 was_digit 置回 False
                    continue
                key_chars.append(c)
                was_digit = False
        return flags