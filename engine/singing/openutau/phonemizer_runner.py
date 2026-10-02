# -*- coding: utf-8 -*-
"""音素化调度核心 —— **照搬** `OpenUtau.Core/Api/PhonemizerRunner.cs`（261 行）里
**音素化本身**的那部分：`Phonemize` 静态方法（119–231 行）+ 请求/响应数据类。

## 与 C# 的载体差异（不是行为差异）
- C# 的 `PhonemizerRunner` 是「后台线程 + `BlockingCollection` 请求队列 + UI 调度器回投」
  的**编辑器基础设施**；线程部分属于 M3/宿主。这里只搬 `Phonemize` 的**纯同步核心**，
  请求排队、去重（同 part 只跑最新）、进度条通知（`SetSingerWithProgress` 的
  "300ms 后才显示"）都由宿主决定 —— 行为契约（输入→输出）逐行对齐。
- `DocManager.Inst.Project/ tracks[...]` 等编辑器单例，改为**调用方显式传参**。
- `Log.Error` → `logging`。
"""

import logging
from dataclasses import dataclass, field
from typing import Any, List, Optional

from .phonemizer import Note, Phoneme, Result

logger = logging.getLogger(__name__)


@dataclass
class PhonemizerRequest:
    """对应 C# 的 `PhonemizerRequest`。

    ★ C# 里 `SetUp` 用的 project/track 是从 `DocManager.Inst`（编辑器单例）取的；
    这里改为显式字段（载体差异）。
    """

    singer: Any = None
    part: Any = None
    timestamp: int = 0
    note_indexes: List[int] = field(default_factory=list)
    notes: List[List[Note]] = field(default_factory=list)
    phonemizers: List[Any] = field(default_factory=list)
    note_phonemizer_indices: List[int] = field(default_factory=list)
    time_axis: Any = None
    project: Any = None
    track: Any = None


@dataclass
class PhonemizerResponse:
    """对应 C# 的 `PhonemizerResponse`。"""

    part: Any = None
    timestamp: int = 0
    note_indexes: List[int] = field(default_factory=list)
    phonemes: List[List[Phoneme]] = field(default_factory=list)


def set_singer_with_progress(phonemizer, singer) -> None:
    """对应 `SetSingerWithProgress`（**去掉** UI 通知部分）。

    C# 用一个 300ms 的 Timer 决定"要不要闪进度条"；无 UI 的宿主没有这一层，
    只保留 `SetSinger` 本体（进度回调由宿主自己包）。
    """
    phonemizer.set_singer(singer)


def phonemize(request: PhonemizerRequest) -> PhonemizerResponse:
    """对应 C# 的 `static PhonemizerResponse Phonemize(PhonemizerRequest)`（119–231 行）。

    核心循环（**从最后一个音符组往前**）：
    1. `SetSinger` / `SetTiming` / `SetUp`（SetUp 失败记 `SetUpException`，之后该组短路）；
    2. 计算 prev/next 及"是否紧邻"（前一组末音符的 end ≥ 本组首音符 position）；
    3. ★ **endPushback**：下一组首音素落在本组末音符 end 之前时，把本组末音符的
       duration **延长**差值（`Math.Min(0, ...)`）—— 否则溢出的音素会被夹进负时长；
    4. `Process(...)`；异常 → 单个 `"error"` 音素（带异常对象）；
    5. `LegacyMapping` 时按声库把音素名**就地替换**成 oto 别名；
    6. ★ 每个音素的 position **加上本组首音符的 position**（音素化器输出的是组内相对值）。
    """
    notes = request.notes
    phonemizers = request.phonemizers

    if request.singer is None or not phonemizers:
        return PhonemizerResponse(
            note_indexes=request.note_indexes,
            part=request.part,
            phonemes=[],
            timestamp=request.timestamp,
        )

    for p in phonemizers:
        p.set_up_exception = None
        try:
            set_singer_with_progress(p, request.singer)
        except Exception as e:
            logger.error('phonemizer failed to set singer.', exc_info=e)
            p.set_up_exception = e
        p.set_timing(request.time_axis)
        if p.set_up_exception is None:
            try:
                p.set_up(notes, request.project, request.track)
            except Exception as e:
                logger.error('phonemizer failed to setup.', exc_info=e)
                p.set_up_exception = e

    result: List[List[Phoneme]] = []
    for i in range(len(notes) - 1, -1, -1):
        phonemizer = phonemizers[request.note_phonemizer_indices[i]]
        if phonemizer.set_up_exception is not None:
            # 短路：给这一组返回一个 error 音素
            result.insert(0, [Phoneme(
                phoneme='error',
                position=notes[i][0].position,
                error=phonemizer.set_up_exception,
            )])
            continue

        prev_is_neighbour = False
        next_is_neighbour = False
        prevs: Optional[List[Note]] = None
        prev: Optional[Note] = None
        next_: Optional[Note] = None
        if i > 0:
            prevs = notes[i - 1]
            prev = notes[i - 1][0]
            prev_last = notes[i - 1][-1]
            prev_is_neighbour = prev_last.position + prev_last.duration >= notes[i][0].position
        if i < len(notes) - 1:
            next_ = notes[i + 1][0]
            this_last = notes[i][-1]
            next_is_neighbour = this_last.position + this_last.duration >= next_.position

        if next_ is not None and result and len(result[0]) > 0:
            end = notes[i][-1].position + notes[i][-1].duration
            end_pushback = min(0, result[0][0].position - end)
            notes[i][-1].duration += end_pushback

        try:
            phonemizer_result: Result = phonemizer.process(
                notes[i], prev, next_,
                prev if prev_is_neighbour else None,
                next_ if next_is_neighbour else None,
                prevs if prev_is_neighbour else [])
        except Exception as e:
            logger.error('phonemizer error %s', notes[i][0].lyric, exc_info=e)
            phonemizer_result = Result(phonemes=[Phoneme(phoneme='error', error=e)])

        if phonemizer.legacy_mapping:
            for k, phoneme in enumerate(phonemizer_result.phonemes):
                found, oto = request.singer.try_get_mapped_oto(
                    phoneme.phoneme, notes[i][0].tone)
                if found and oto is not None:
                    phonemizer_result.phonemes[k].phoneme = oto.alias

        for j in range(len(phonemizer_result.phonemes)):
            phonemizer_result.phonemes[j].position += notes[i][0].position
        result.insert(0, phonemizer_result.phonemes)

    for p in phonemizers:
        try:
            p.clean_up()
        except Exception as e:
            logger.error('phonemizer failed to cleanup.', exc_info=e)

    return PhonemizerResponse(
        note_indexes=request.note_indexes,
        part=request.part,
        phonemes=result,
        timestamp=request.timestamp,
    )
