# -*- coding: utf-8 -*-
"""中文音素化器的公共基类 —— **照搬** `OpenUtau.Core/BaseChinesePhonemizer.cs`（51 行）。

它只做一件事：把音符歌词里的**单个汉字**换成无声调拼音，让后面的中文音素化器
（VCV / CVVC / CVV…）可以直接按拼音查 oto。

## 照搬时保留的语义（别"整理"掉）
- **只替换"长度为 1 的汉字"**：`Romanize()` 先把"是汉字的歌词"收集起来批量转拼音，
  再在循环里用 `Length == 1 && IsHanzi(...)` 逐项替换。也就是说多字歌词（`tian`、
  `你好`）**原样保留**，不会被转换。
- `ChangeLyric` 是**造一个新的 Note**（不是就地改字段），只搬走
  `lyric / phoneticHint / tone / position / duration / phonemeAttributes`
  这几项 —— 其余字段（尤其是 `phonemeExpressions` 之类）会被**丢掉**。
  这是 C# 原文，照搬不改。
- `RomanizeNotes` 里 C# 写的是 `Enumerable.Zip(groups, ResultLyrics, ChangeLyric).Last()`
  —— `Zip` 是惰性的，`.Last()` 只是为了**强制枚举完**（副作用在 `ChangeLyric` 里）。
  Python 用普通 for 循环等价实现，别省略。
- 转换失败（拿不到拼音结果）时**原样返回**，不抛异常。

## ★ 与 C# 的载体差异
- C# 用 NuGet 包 `csharp-pinyin` 的 `Pinyin.Instance`。Python 侧用 **pypinyin**
  （已在本项目依赖里，`engine/engine_diffsinger.py` 也在用）。
  两者在"无声调拼音"上的输出一致，包括 `ü` 的写法：pypinyin 的 `Style.NORMAL` 给出
  `nv` / `lv` / `yun` / `jun`，正好对得上中文音素器表里的 `v` / `vn` 两类韵母。
- `IsHanzi` 这里按「**长度为 1 且为汉字**」实现。理由是让 `Romanize()` 里
  "先收集、再按 `Length == 1` 替换"两处**共用同一个判据**：否则当某条歌词是多字汉字串
  （如 `你好`）时，它会被收集进待转换表、却在替换循环里被跳过，导致 `pinyinIndex`
  **错位**、把后面的字配上错误的拼音。C# 侧若 `IsHanzi` 接受多字符串就存在这个错位；
  这里用同一判据把风险消掉（多字汉字串本来就该由用户每个音符填一个字）。
"""

import re
from typing import Iterable, List

from .phonemizer import Note

#: CJK 统一表意文字（含扩展 A）。够覆盖中文歌词用到的字。
_HANZI_RE = re.compile(r'^[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]$')

_PINYIN_MODULE = None


def _pypinyin():
    """惰性加载 pypinyin（未安装时返回 None，功能降级但不崩）。"""
    global _PINYIN_MODULE
    if _PINYIN_MODULE is None:
        try:
            import pypinyin
            _PINYIN_MODULE = pypinyin
        except Exception:
            _PINYIN_MODULE = False
    return _PINYIN_MODULE or None


def is_hanzi(s: str) -> bool:
    """对应 `Pinyin.Instance.IsHanzi(string)`（见模块 docstring 的判据说明）。"""
    return bool(s) and len(s) == 1 and _HANZI_RE.match(s) is not None


def hanzi_to_pinyin(s: str) -> str:
    """单个汉字 → 无声调拼音（对应 `HanziToPinyin(..., Style.NORMAL, ...)`）。

    转不出来时原样返回 —— C# 的 `Error.Default` 也是"保留原样"而不是抛错。
    """
    pp = _pypinyin()
    if pp is None:
        return s
    try:
        result = pp.pinyin(s, style=pp.Style.NORMAL, errors='default')
    except Exception:
        return s
    if not result or not result[0]:
        return s
    return result[0][0]


# ---------------------------------------------------------------- 粤拼（Cantonese）
# C# 的粤语音素化器用的是 NuGet `csharp-pinyin` 的 `Pinyin.Jyutping.Instance`
# （自带粤拼表）。Python 侧没有等价的标准库，按项目既有套路
# （`classic_singer.set_romaji_converter` 处理 WanaKanaNet 那次）做成**可注入钩子**：
#   ① 注入了转换器 → 用它；
#   ② 否则惰性探测常见粤拼库（ToJyutping / pycantonese）；
#   ③ 都没有 → **原样返回**。
# 第 ③ 条正是 C# 里 `Pinyin.Error.Default` 的语义（转不出来就保留原样），
# 所以不是行为差异，只是"这台机器上没有粤拼表"——与 pypinyin 缺失时的降级一致。
_JYUTPING_CONVERTER = None
_JYUTPING_AUTO = None
_JYUTPING_TRIED = False


def set_jyutping_converter(fn) -> None:
    """注入「汉字 → 无声调粤拼」转换器（`fn(str) -> str`）。传 `None` 清除注入。

    与 `classic_singer.set_romaji_converter` 同一套路：宿主能力而不是引擎逻辑。
    """
    global _JYUTPING_CONVERTER
    _JYUTPING_CONVERTER = fn


def _auto_jyutping():
    """惰性探测可用的粤拼库，返回 `fn(hanzi) -> str` 或 `None`（只探测一次）。"""
    global _JYUTPING_AUTO, _JYUTPING_TRIED
    if _JYUTPING_TRIED:
        return _JYUTPING_AUTO
    _JYUTPING_TRIED = True
    try:                                    # pip install ToJyutping
        import ToJyutping                    # type: ignore

        def _conv_tojyutping(s, _m=ToJyutping):
            res = _m.get_jyutping(s)
            # 形态：[(字, 粤拼 或 None), ...]
            if isinstance(res, list) and res:
                first = res[0]
                if isinstance(first, (list, tuple)) and len(first) >= 2 and first[1]:
                    return str(first[1])
            return s

        _JYUTPING_AUTO = _conv_tojyutping
        return _JYUTPING_AUTO
    except Exception:
        pass
    try:                                    # pip install pycantonese
        import pycantonese                   # type: ignore

        def _conv_pycantonese(s, _m=pycantonese):
            res = _m.characters_to_jyutping(s)
            if res and isinstance(res[0], (list, tuple)) and len(res[0]) >= 2 and res[0][1]:
                return str(res[0][1])
            return s

        _JYUTPING_AUTO = _conv_pycantonese
        return _JYUTPING_AUTO
    except Exception:
        pass
    _JYUTPING_AUTO = None
    return None


def jyutping_available() -> bool:
    """当前能否做汉字→粤拼（注入过，或本机装了受支持的粤拼库）。"""
    return (_JYUTPING_CONVERTER is not None) or (_auto_jyutping() is not None)


def hanzi_to_jyutping(s: str) -> str:
    """单个汉字 → 无声调粤拼；转不出来**原样返回**（同 C# 的 `Error.Default`）。"""
    if not s:
        return s
    conv = _JYUTPING_CONVERTER or _auto_jyutping()
    if conv is None:
        return s
    try:
        out = conv(s)
    except Exception:
        return s
    return out or s


class BaseChinesePhonemizer:
    """对应 `BaseChinesePhonemizer`。

    注意 C# 里它是 `abstract class ... : Phonemizer`，而本 Python 类**不继承**
    `Phonemizer` —— 因为实际用它的是 `ChineseVCVPhonemizer` 这类直接继承
    `Phonemizer` 的音素化器，它们只是**调用**这里的静态方法，并不继承它。
    继承关系照搬反而会引入一个多余的 MRO 层。
    """

    @staticmethod
    def change_lyric(group: List[Note], lyric: str) -> List[Note]:
        """对应 `ChangeLyric`：造一个新的首音符（只保留 C# 列出的那几个字段）。"""
        old = group[0]
        group[0] = Note(
            lyric=lyric,
            phonetic_hint=old.phonetic_hint,
            tone=old.tone,
            position=old.position,
            duration=old.duration,
            phoneme_attributes=old.phoneme_attributes,
        )
        return group

    @staticmethod
    def romanize(lyrics: Iterable[str]) -> List[str]:
        """对应 `Romanize`：把其中的单字汉字换成无声调拼音。"""
        lyrics_array = list(lyrics)
        hanzi_lyrics = [s for s in lyrics_array if is_hanzi(s)]
        if not hanzi_lyrics:
            return lyrics_array
        pinyin_result = [hanzi_to_pinyin(s) for s in hanzi_lyrics]
        if pinyin_result is None:
            return lyrics_array
        pinyin_index = 0
        for i in range(len(lyrics_array)):
            if len(lyrics_array[i]) == 1 and is_hanzi(lyrics_array[i]):
                lyrics_array[i] = pinyin_result[pinyin_index]
                pinyin_index += 1
        return lyrics_array

    @staticmethod
    def romanize_jyutping(lyrics: Iterable[str]) -> List[str]:
        """`CantoneseCVVCPhonemizer.Romanize` 的对应实现（用**粤拼**而非拼音）。

        结构与 `romanize` 逐句对应（先收集、再按 `Length == 1 && IsHanzi` 替换），
        只把转换器换成 `hanzi_to_jyutping`。

        ★ 照搬保留：C# 那条 `if (jyutpingResult == null) return lyricsArray;` 同样是
        **死分支**（`HanziToPinyin(...).ToStrList()` 不会返回 null）—— 见 `romanize`
        里同款守卫的说明，别"顺手修好"。
        """
        lyrics_array = list(lyrics)
        hanzi_lyrics = [s for s in lyrics_array if is_hanzi(s)]
        jyutping_result = [hanzi_to_jyutping(s) for s in hanzi_lyrics]
        if jyutping_result is None:
            return lyrics_array
        jyutping_index = 0
        for i in range(len(lyrics_array)):
            if len(lyrics_array[i]) == 1 and is_hanzi(lyrics_array[i]):
                lyrics_array[i] = jyutping_result[jyutping_index]
                jyutping_index += 1
        return lyrics_array

    @staticmethod
    def romanize_notes(groups: List[List[Note]]) -> List[List[Note]]:
        """对应 `RomanizeNotes`：就地替换每个分组的首音符歌词。"""
        result_lyrics = BaseChinesePhonemizer.romanize([g[0].lyric for g in groups])
        # C# 的 `Zip(...).Last()` 只是为了强制枚举完（副作用在 ChangeLyric 里）
        for group, lyric in zip(groups, result_lyrics):
            BaseChinesePhonemizer.change_lyric(group, lyric)
        return groups
