# -*- coding: utf-8 -*-
r"""A 层：音素化器 —— **照搬** `OpenUtau.Core/DiffSinger/DiffSingerBasePhonemizer.cs`。

`dsdur/` 的时长模型（`linguistic.onnx` + `dur.onnx`）在这里跑，产出带
`positionMs` / `durationMs` 的 `UPhoneme` 列表。**渲染器（B 层）只消费这些 ms 值**，
自己不做任何时长预测 —— 这就是上游的分层，也是我们旧实现最大的偏差。

## ★ 三个最容易写错的地方

1. **`framesBetweenTickPos`（:306-309）用 `(int)` 截断，不是 `floor`**：
   ```csharp
   return (int)(TickPosToMsPos(tickPos2)/frameMs) - (int)(TickPosToMsPos(tickPos1)/frameMs);
   ```
   `phrasePhonemes[0].Position` 是**负数**（减了 500ms padding），
   `floor(-10.8) = -11` 而 `(int)(-10.8) = -10` —— 差 1 帧，首辅音整段错位。
   → 必须 `math.trunc`。
2. **对齐算法丢掉了 `durationFrames[0]`**（:484 `GetRange(1, count0-1)`），
   所以 `positions` 的长度是 `tokens-1`，回写时用 `positions[phIndex - 1]`
   （:514）—— 那个 `-1` **是补偿，不是 off-by-one**，别"顺手修掉"。
3. **首组的 ratio 硬编码 = `frameMs`**（:488），只做"帧→毫秒"的单位换算、**不缩放**；
   其余组才按 `ratio = (nextMs - curMs) / alignGroup.Sum()` 缩放。
"""

import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Sequence, Tuple

from . import RenderError
from .g2p import get_symbols, lang_id_of
from .voicebank import DsSinger

#: 对应 `:35` `string defaultPause = "SP";` —— 音素化失败时的占位
DEFAULT_PAUSE = 'SP'
#: 对应 `:354` `float padding = 500f;` —— 句首辅音预留（ms）
PADDING_MS = 500.0


@dataclass
class DsPhoneme:
    """对应 `struct dsPhoneme`（:522-527）。"""

    symbol: str
    speaker: str = ''

    def language(self) -> str:
        from .utils import phoneme_language
        return phoneme_language(self.symbol)


@dataclass
class PhonemesPerNote:
    """对应 `class phonemesPerNote`（:536-554）——「按字分组」的容器。"""

    position: int                     # tick
    tone: int
    phonemes: List[DsPhoneme] = field(default_factory=list)


@dataclass
class UPhoneme:
    """对应 `OpenUtau.Core/Ustx/UPhoneme.cs`（渲染器消费的就是这个）。

    ★ `duration_ms` / `end_ms` 由对齐算法决定（:476-518），**不是**音符时长的直接切分。
    """

    position: int                     # 相对 part 的 tick
    phoneme: str
    duration: int = 0                 # tick
    position_ms: float = 0.0
    duration_ms: float = 0.0
    end_ms: float = 0.0
    #: 所属音符的结束 tick（由 `process_part` 填，供 `ValidateDuration` 用）
    _note_end_tick: int = 0


# ---------------------------------------------------------------- ProcessWord

def process_word(notes: Sequence, symbols: Sequence[str],
                 g2p, speaker_at) -> List[PhonemesPerNote]:
    """对应 `ProcessWord`（:262-304）—— 把一个字的音素分配到它的各个音符上。

    返回**长度 ≥ 1** 的分组列表：`[0]` 装**元音之前的辅音**（`Position = -1`），
    之后每个起首音素开一组。

    ★ 三条分配规则（:280-292）：
      1. 全是辅音（无元音）→ 第 0 个音素起头
      2. 遇元音 → 该元音起头
      3. `辅音-半元音-元音` 三元组 → **半元音**起头（不是元音！）
    ★ `+~` / `+*` 开头的延音音符不参与分配（`nonExtensionNotes`）。
    """
    for symbol in symbols:
        # 对应 :264-269：符号类型未定义就直接抛
        if not g2p.is_valid_symbol(symbol):
            raise RenderError(
                '音素 "%s" 没有类型定义，请把它加进 dsdur/dsdict-<lang>.yaml' % symbol)

    word = [PhonemesPerNote(-1, notes[0].tone)]
    ds_ph = [DsPhoneme(s, speaker_at(notes[0], i)) for i, s in enumerate(symbols)]
    is_vowel = [g2p.is_vowel(p.symbol) for p in ds_ph]
    is_glide = [g2p.is_glide(p.symbol) for p in ds_ph]
    non_ext = [n for n in notes
               if not (str(getattr(n, 'lyric', '')).startswith('+~')
                       or str(getattr(n, 'lyric', '')).startswith('+*'))]

    is_start = [False] * len(ds_ph)
    if not any(is_vowel):
        is_start[0] = True                              # :280-282
    for i in range(len(ds_ph)):
        if is_vowel[i]:
            if i >= 2 and is_glide[i - 1] and not is_vowel[i - 2]:
                is_start[i - 1] = True                 # :287-289 半元音起头
            else:
                is_start[i] = True                     # :290

    ni = 0
    for i in range(len(ds_ph)):
        if is_start[i] and ni < len(non_ext):
            note = non_ext[ni]
            word.append(PhonemesPerNote(note.position, note.tone))
            ni += 1
        word[-1].phonemes.append(ds_ph[i])              # :302
    return word


# ---------------------------------------------------------------- 帧距

def frames_between_ticks(axis, tick1: int, tick2: int, frame_ms: float) -> int:
    """对应 `framesBetweenTickPos`（:306-309）。

    ★ **向零截断**（C# 的 `(int)` 对负数是截断），不是 `floor`。
    """
    return (int(math.trunc(axis.tick_pos_to_ms_pos(tick2) / frame_ms))
            - int(math.trunc(axis.tick_pos_to_ms_pos(tick1) / frame_ms)))


# ---------------------------------------------------------------- 对齐

def cumulative_sum(values: Sequence[float], start: float = 0.0) -> List[float]:
    """对应 `:311-317` 的 `CumulativeSum`。"""
    out, total = [], start
    for v in values:
        total += v
        out.append(total)
    return out


def stretch(source: Sequence[float], ratio: float, end_pos: float) -> List[float]:
    """对应 `:327-336` 的 `stretch` —— 把音素帧数按 `ratio` 缩放并摆到 `end_pos`。

    * `source`：音素帧数
    * `ratio`：缩放比例（首组是 `frame_ms`，其余是位置差/帧数和）
    * `end_pos`：目标终点（ms）
    * 返回：各音素的**位置**（ms），长度 = `len(source)`

    ★ 上游是 `CumulativeSum(source.Select(x => x*ratio).Prepend(0), startPos)`
      —— **先 `Prepend(0)`** 再累积，最后 `RemoveAt(Count-1)`。
      那个 `Prepend(0)` 不是可选的：首组音素常常只有 SP 一个（首字是单辅音时
      `wordPhonemes[0].Phonemes` 为空），于是 `source` 为空 ——
      有 Prepend 时 `result = [startPos]` 再 `RemoveAt(0)` → 空列表，流程正常；
      漏掉它会得到空列表再 `RemoveAt(-1)`，直接抛。
    """
    total = sum(source) * ratio
    start_pos = end_pos - total
    result = cumulative_sum([0.0] + [x * ratio for x in source], start_pos)
    result.pop()                                          # :334 RemoveAt(Count-1)
    return result


def align_positions(phonemes_per_note: Sequence[PhonemesPerNote], duration_frames,
                    axis, frame_ms: float) -> List[float]:
    """对应 `:476-496` 的对齐段 → 每个音素的**位置**（ms）。

    ★ `duration_frames[0]` 被丢弃（:484），所以返回长度 = `tokens - 1`，
      `positions[k]` 对应**全局第 k+1 个**音素。
    """
    counts = [len(n.phonemes) for n in phonemes_per_note]
    ms_positions = [axis.tick_pos_to_ms_pos(n.position)
                    for n in phonemes_per_note[1:]]      # :481 Skip(1)
    ph_align = list(zip(cumulative_sum(counts, 0), ms_positions))   # :479-482

    positions: List[float] = []
    first_count = ph_align[0][0]
    # ★ :484 GetRange(1, count0-1) —— 首元素（SP）被丢掉
    group = list(duration_frames[1:first_count])
    # ★ :488 首组 ratio 硬编码 = frameMs（帧→毫秒，不缩放）
    positions.extend(stretch(group, frame_ms, ph_align[0][1]))
    for cur, nxt in zip(ph_align, ph_align[1:]):         # :490-496
        group = list(duration_frames[cur[0]:nxt[0]])
        total = sum(group)
        if total <= 0:
            continue
        ratio = (nxt[1] - cur[1]) / total
        positions.extend(stretch(group, ratio, nxt[1]))
    return positions


# ---------------------------------------------------------------- 主流程

def build_linguistic_inputs(singer: DsSinger, tokens: Sequence[int],
                            word_div: Sequence[int], word_dur: Sequence[int],
                            languages: Optional[Sequence[int]] = None
                            ) -> Dict[str, object]:
    """组装 `dsdur` linguistic 的输入（:394-426）。

    ★ 多语声库（`use_lang_id: true`，如 Ria）的 linguistic 签名里多一个
      `languages` 输入，形状与 `tokens` 一致（`[1, n_tokens]`）：
      每个音素的语言 id 取**符号前缀**（`zh/aa` → 3），无前缀的 AP/CL/SP →
      0（`GetValueOrDefault(PhonemeLanguage(phoneme), 0)`，:421）。
      `Onnx.VerifyInputNames` 是**双向严格**的 —— 少给会抛「缺少 languages」，
      多给会抛「多余 languages」，所以这里必须按 `use_lang_id` 精确开关。
    """
    import numpy as np
    feeds: Dict[str, object] = {
        'tokens': np.asarray([list(tokens)], dtype=np.int64),
        'word_div': np.asarray([list(word_div)], dtype=np.int64),
        'word_dur': np.asarray([list(word_dur)], dtype=np.int64),
    }
    if singer.dur.use_lang_id:
        if languages is None or len(languages) != len(tokens):
            raise RenderError(
                '多语声库（use_lang_id=true）需要与音素等长的 languages：'
                '期望 %d 个，实际 %s' % (len(tokens),
                                    '未提供' if languages is None else len(languages)))
        feeds['languages'] = np.asarray([list(languages)], dtype=np.int64)
    return feeds


def process_part(singer: DsSinger, phrase_notes: Sequence[Sequence],
                 axis, g2p, lang_code: str, providers,
                 warn: Optional[List[str]] = None) -> List[UPhoneme]:
    """对应 `ProcessPart`（:353-519）→ 展平的 `UPhoneme` 列表。

    `phrase_notes`：已按"是否连排"切好的句，每句是 `Note` 的列表（每个元素本身是
    `Note` 数组 —— 对应上游的 `Note[][] phrase`，即"一个字的多个音符"）。
    """
    from .session import run_session
    warn = warn if warn is not None else []
    frame_ms = singer.dur.frame_ms                       # ★ A 层用 dsdur 的 frameMs
    tokens_map = singer.phoneme_tokens

    notes = phrase_notes
    last_note = notes[-1][-1]
    end_tick = last_note.position + last_note.duration   # :358

    # ---- phrasePhonemes（n+2 组）: :359-393
    pp: List[PhonemesPerNote] = [
        PhonemesPerNote(-1, notes[0][0].tone, [DsPhoneme('SP')])]
    note_ph_index: List[int] = [1]                       # :362 ★ 初值是 1（0 是 SP）
    word_found: List[bool] = []
    for wi, word in enumerate(notes):
        raw, rejected = get_symbols(g2p, tokens_map, str(word[0].lyric),
                                    getattr(word[0], 'phonetic_hint', None), lang_code)
        symbols = [s for s in raw if s in tokens_map]     # :369
        rejected = list(rejected) + [s for s in raw if s not in tokens_map]
        if rejected:
            warn.append('位置 %d 的歌词无法识别：%s' % (word[0].position, ' '.join(rejected)))
        if not symbols:
            symbols = [DEFAULT_PAUSE]                     # :378-383
            word_found.append(False)
        else:
            word_found.append(True)
        wps = process_word(word, symbols, g2p, lambda n, i: '')
        pp[-1].phonemes.extend(wps[0].phonemes)           # :385 首辅音并入上一组
        pp.extend(wps[1:])                                # :386
        note_ph_index.append(note_ph_index[-1]
                             + sum(len(n.phonemes) for n in wps))
    pp.append(PhonemesPerNote(end_tick, last_note.tone))  # :390
    # ★ :391-393 padding 只在这里减一次（作用在 pp[0]）
    pp[0].position = axis.ms_pos_to_tick_pos(
        axis.tick_pos_to_ms_pos(pp[1].position) - PADDING_MS)
    if len(pp) != len(notes) + 2:                        # 自检：:359 的结构约定
        raise RenderError('phrasePhonemes 结构异常：期望 %d 组，实际 %d'
                          % (len(notes) + 2, len(pp)))

    # ---- linguistic: :394-443
    tokens = [tokens_map[p.symbol] for n in pp for p in n.phonemes]  # :396-398
    # ★ 多语声库的语言 id（与 tokens **同序等长**）：取符号的语言前缀，查 dsdur 的语言表
    languages = [lang_id_of(p.symbol, singer.language_ids)
                 for n in pp for p in n.phonemes]                 # :421
    word_div = [len(n.phonemes) for n in pp[:-1]]                    # :399-401 Take(N-1)
    word_dur = [frames_between_ticks(axis, a.position, b.position, frame_ms)
                for a, b in zip(pp, pp[1:])]                         # :403-405
    feeds = build_linguistic_inputs(singer, tokens, word_div, word_dur, languages)
    enc_out, x_masks = run_session(singer.model('linguistic'), feeds, providers,
                                   'dsdur linguistic')

    # ---- dur: :444-474
    ph_midi = [n.tone for n in pp for _ in n.phonemes]               # :445-447
    dur_feeds = {
        'encoder_out': enc_out,
        'x_masks': x_masks,
        'ph_midi': _i64_2d(ph_midi),
    }
    outs = run_session(singer.model('dur'), dur_feeds, providers, 'dsdur dur')
    duration_frames = [float(x) for x in outs[0].reshape(-1)]

    # ---- 对齐: :476-496
    positions = align_positions(pp, duration_frames, axis, frame_ms)

    # ---- 回写: :498-518
    all_ph = [p for n in pp for p in n.phonemes]
    result: List[UPhoneme] = []
    for wi, word in enumerate(notes):
        if not word_found[wi]:
            continue
        if str(word[0].lyric).startswith('+'):             # :507-509
            continue
        note_pos_ms = axis.tick_pos_to_ms_pos(word[0].position)
        for ph in range(note_ph_index[wi], note_ph_index[wi + 1]):
            if ph >= len(all_ph):
                break
            symbol = all_ph[ph].symbol
            if not symbol:                                  # :512 跳过空串
                continue
            # ★ positions[ph - 1]：-1 是补偿 durationFrames[0] 被丢弃（:484）
            pos_ms = positions[ph - 1]
            offset_tick = axis.ticks_between_ms_pos(note_pos_ms, pos_ms)
            base_tick = word[0].position + offset_tick
            # ★ 末音素的时长要靠「所属音符的 end」撑住（`UPhoneme.ValidateDuration`，
            #   `Ustx/UPhoneme.cs:68-84` 用的是 `leadingNote.extended_end`），
            #   否则每个字最后一个音素时长会是 0。
            u = UPhoneme(position=base_tick, phoneme=symbol)
            u._note_end_tick = word[-1].position + word[-1].duration
            result.append(u)
    _finalize_durations(result, axis)
    return result


def _i64_2d(values: Sequence[int]):
    import numpy as np
    return np.asarray([list(values)], dtype=np.int64)


def _finalize_durations(phones: List[UPhoneme], axis) -> None:
    """按 `UPhoneme.ValidateDuration`（`Ustx/UPhoneme.cs:68-84`）补齐 tick/ms 时长。

    * `duration = extended_end - position`，其中 `extended_end` 取**所属音符的 end**
      （`leadingNote.extended_end`），并被**下一个音素的位置**截断
    * `position_ms` / `end_ms` 由 tick 换算
    """
    for i, ph in enumerate(phones):
        # ★ 音符 end 打底（末音素靠它撑住时长），下一个音素位置再截断
        end_tick = ph._note_end_tick or ph.position
        if i + 1 < len(phones):
            end_tick = min(end_tick, phones[i + 1].position)
        ph.duration = max(0, end_tick - ph.position)
        ph.position_ms = axis.tick_pos_to_ms_pos(ph.position)
        ph.end_ms = axis.tick_pos_to_ms_pos(ph.position + ph.duration)
        ph.duration_ms = ph.end_ms - ph.position_ms
