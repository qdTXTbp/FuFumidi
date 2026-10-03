# -*- coding: utf-8 -*-
r"""ML 音素化器的**切句**层 —— **照搬**
`OpenUtau.Core/MachineLearningPhonemizer.cs`（:20-115）。

## 上游的三段结构

```csharp
SetUp(groups, project, track):        // :20-59
    Romanize(groups.Select(g => g[0].lyric));          // ① 先罗马化（汉字→拼音）
    Enumerable.Zip(groups, RomanizedLyrics, ChangeLyric).Last();   // ② 写回 lyric
    var phrase = new List<Note[]> { groups[0] };
    for (i = 1..n):                                       // ③ 按「是否连排」切句
        if (groups[i-1][^1].position + groups[i-1][^1].duration == groups[i][0].position)
            phrase.Add(groups[i]);                        //    连排 → 不切
        else { ProcessPart(phrase); phrase = { groups[i] }; }   // 有间隙 → 处理当前句
    if (phrase.Count > 0) ProcessPart(phrase);           // ④ ★ flush 最后一句

Process(notes, ...):                  // :62-84
    // 纯查表：partResult[notes[0].position] → Phoneme[]

CleanUp(): partResult.Clear(); unrecognizedLyrics.Clear();   // :86-89
```

## ★ 三个容易照搬错的点

1. **罗马化在切句之前**（:30-31）。`ChangeLyric` 只换 `lyric`，保留
   `phoneticHint`/`tone`/`position`/`duration`/`phonemeAttributes`。
   C# 用 `.Last()` 强制枚举（`Zip` 是惰性的）—— Python 里就是普通 for 循环。
2. **判据是 tick 精确相等**（`position + duration == position`），不是"间隙小于阈值"。
   差 1 tick 就切句。
3. **单句异常不中断整首**（:43-50）：`try/catch` 记日志 + 存
   `lastProcessPartException`，继续下一句；`Process` 时才把那个异常抛出来。
   漏掉 `if (phrase.Count > 0) ProcessPart(phrase)`（:51-59）会**丢掉最后一句**。
"""

from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional, Sequence, Tuple


@dataclass
class MLNote:
    """`MachineLearningPhonemizer` 眼中的单个音符（只用到这些字段）。

    ★ 只保留 `ChangeLyric`（:100-113）与切句判据需要的字段；
      `phonemeAttributes` 在我们这里没有对应物（`.ustx` 用 `phoneme_expressions`）。
    """

    position: int
    duration: int
    tone: int = 60
    lyric: str = ''
    phonetic_hint: Optional[str] = None


@dataclass
class MlPhonemizer:
    """`MachineLearningPhonemizer` 的可复用部分。

    `process_part` 是抽象方法（:91）—— 由具体的音素化器实现（对 DiffSinger 来说
    就是跑 `dsdur` 的 linguistic + dur + 对齐算法）。它收到**一个句子的音符**，
    负责把音素写进 `part_result`，**key = 该句首个音符的 tick**（:95-102）。
    """

    #: `partResult`：首音 tick → [(音素, 相对tick), ...]（:23-24）
    part_result: Dict[int, List[Tuple[str, int]]] = field(default_factory=dict)
    #: `unrecognizedLyrics`：首音 tick → 原始歌词（:25）
    unrecognized_lyrics: Dict[int, str] = field(default_factory=dict)
    #: 单句处理失败时记住（:26 `lastProcessPartException`）
    last_process_part_exception: Optional[BaseException] = None
    set_up_exception: Optional[BaseException] = None
    #: 切句时是否把某句判为「无法识别」——由实现方通过 `process_part` 写入
    process_part: Optional[Callable[[List[List[MLNote]]], None]] = None
    romanize_impl: Optional[Callable[[Sequence[str]], List[str]]] = None

    # ------------------------------------------------------------------ SetUp

    def set_up(self, groups: Sequence[Sequence[MLNote]]) -> None:
        """对应 `:20-59`。`groups` 是「按 Extends 分组」的音符组（一个字可能多个音符）。"""
        self.part_result.clear()
        self.unrecognized_lyrics.clear()
        self.last_process_part_exception = None
        self.set_up_exception = None
        if not groups:
            return

        groups = [list(g) for g in groups]

        # ---- ① 罗马化（:30）——汉字→拼音，在**切句之前**
        if self.romanize_impl is not None:
            lyrics = [g[0].lyric for g in groups]
            romanized = self.romanize_impl(lyrics)
            # ---- ② ChangeLyric（:31、:100-113）：只换 lyric，其余字段照搬
            for g, lyric in zip(groups, romanized):
                g[0] = self._change_lyric(g[0], lyric)

        # ---- ③ 切句（:33-50）
        if self.process_part is None:
            raise RuntimeError('MlPhonemizer.process_part 未设置')
        phrase: List[List[MLNote]] = [groups[0]]
        for i in range(1, len(groups)):
            prev_note = groups[i - 1][-1]          # `groups[i-1][^1]`
            cur_note = groups[i][0]                 # `groups[i][0]`
            # ★ 判据是 tick **精确相等**（:38）
            if prev_note.position + prev_note.duration == cur_note.position:
                phrase.append(groups[i])            # 连排 → 同句
            else:
                self._run_part(phrase)              # 有间隙 → 处理当前句
                phrase = [groups[i]]
        # ---- ④ ★ flush 最后一句（:51-59）—— 漏掉会丢掉尾句
        if phrase:
            self._run_part(phrase)

    def _run_part(self, phrase: List[List[MLNote]]) -> None:
        """跑一句，**异常不中断整首**（:43-50）。"""
        if not phrase:
            return
        try:
            self.process_part(phrase)
        except Exception as e:                        # noqa: BLE001
            self.last_process_part_exception = e
            text = ' '.join(g[0].lyric for g in phrase)
            import sys
            sys.stderr.write('[diffsinger] 音素化失败（句：%s）：%s\n' % (text, e))

    @staticmethod
    def _change_lyric(note: MLNote, lyric: str) -> MLNote:
        """对应 `ChangeLyric`（:100-113）—— 逐字段照搬，只换 `lyric`。"""
        return MLNote(
            position=note.position,
            duration=note.duration,
            tone=note.tone,
            lyric=lyric,
            phonetic_hint=note.phonetic_hint,
        )

    # ------------------------------------------------------------------ Process

    def process(self, notes: Sequence[MLNote]) -> List[Tuple[str, int]]:
        """对应 `:62-84` —— **纯查表**。

        抛错语义要与上游一致：
        * 歌词为空 → `"Phoneme not found for this note"`
        * 歌词非空但未识别 → `Unrecognized phoneme "<lyric>"`
        * 整句没跑成功 → `Phonemizer failed to process.` + 内层异常
        * 其它 → `Part result not found`
        """
        if not notes:
            raise ValueError('Phoneme not found for this note')
        key = notes[0].position
        if key in self.unrecognized_lyrics:
            lyric = self.unrecognized_lyrics[key] or ''
            if not lyric:
                raise ValueError('Phoneme not found for this note')
            raise ValueError('Unrecognized phoneme "%s"' % lyric)
        if key not in self.part_result:
            cause = self.last_process_part_exception or self.set_up_exception
            if cause is not None:
                raise ValueError('Phonemizer failed to process.') from cause
            raise ValueError('Part result not found')
        return list(self.part_result[key])

    def clean_up(self) -> None:
        """对应 `:86-89`。"""
        self.part_result.clear()
        self.unrecognized_lyrics.clear()
