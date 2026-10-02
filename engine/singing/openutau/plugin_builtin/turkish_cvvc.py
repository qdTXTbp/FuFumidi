"""TurkishCVVCPhonemizer —— `OpenUtau.Plugin.Builtin/TurkishCVVCPhonemizer.cs`(356) 全文件照搬。

注册名：`TR CVVC`（`[Phonemizer("Turkish CVVC Phonemizer", "TR CVVC", "ise", language: "TR")]`）。

注意：这个类**不是** `SyllableBasedPhonemizer` 的子类，它直接继承 `Phonemizer`，
自己实现歌词分段、VC 边界计算与 oto 查询。
"""
import unicodedata
from dataclasses import dataclass
from typing import List, Optional

from ..phonemizer import Note, Phoneme, PhonemeAttributes, PhonemeExpression, Phonemizer, Result, register
from ..format import Ustx

GLOTTAL_STOPS = ('?', 'q')

VOWELS = ('a', 'e', 'ae', 'eu', 'i', 'o', 'oe', 'u', 'ue')

SUSTAINED_CONSONANTS = ('Y', 'L', 'LY', 'M', 'N', 'NG')

CONSONANTS = (
    '9', 'b', 'c', 'ch', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'm', 'n', 'ng',
    'p', 'r', 'rr', "r'", 's', 'sh', 't', 'v', 'w', 'y', 'z',
    'by', 'dy', 'gy', 'hy', 'ky', 'ly', 'my', 'ny', 'py', 'ry', 'ty',
    'Y', 'L', 'LY', 'M', 'N', 'NG', '-', '?', 'q',
)


def _bankers_round(x: float) -> int:
    """C# `Convert.ToInt32(double)` 的银行家舍入（四舍六入五成双）。"""
    return int(round(x))


def _to_str(value: Optional[int]) -> str:
    """C# `test + alt` 语义：alt 为 null 时追加空串，否则追加字符串。"""
    return '' if value is None else str(value)


@dataclass
class _SegmentedLyric:
    lyric: str
    start_c1: str
    start_c2: str
    vow: str
    end_c1: str
    end_c2: str
    has_9_before_vow: bool

    @classmethod
    def empty(cls, has_9_before_vow: bool = False) -> '_SegmentedLyric':
        return cls('', '', '', '', '', '', has_9_before_vow)

    def has_consonant_before_vowel(self) -> bool:
        return self.start_c1 != ''

    def has_consonant_after_vowel(self) -> bool:
        return self.end_c1 != ''


@register
class TurkishCVVCPhonemizer(Phonemizer):
    """对应 C# `TurkishCVVCPhonemizer`。

    这是一个**直接继承 `Phonemizer`** 的实现，不经过 `SyllableBasedPhonemizer`。
    """

    name = 'Turkish CVVC Phonemizer'
    tag = 'TR CVVC'
    author = 'ise'
    language = 'TR'

    def __init__(self) -> None:
        super().__init__()
        self.singer = None

    def set_singer(self, singer) -> None:
        self.singer = singer

    # ------------------------------------------------------------------ #
    # oto 查询 helper
    # ------------------------------------------------------------------ #
    def _check_oto_until_hit(self, inputs: List[str], note: Note):
        """对应 C# `checkOtoUntilHit`：按顺序试查，返回命中的 UOto（含颜色/alt 回落）。"""
        if self.singer is None:
            return None

        attr: PhonemeAttributes = next(
            (a for a in note.phoneme_attributes if a.index == 0),
            PhonemeAttributes())
        color = attr.voice_color if attr.voice_color is not None else self.get_parent_voice_color()
        shift = attr.tone_shift if attr.tone_shift is not None else self.get_parent_tone_shift()
        alt = attr.alternate if attr.alternate is not None else self.get_parent_alternate()

        otos = []
        for test in inputs:
            # C#: test + alt（alt 为 null 时相当于 test + ""）
            found, oto = self.singer.try_get_mapped_oto(test + _to_str(alt),
                                                        note.tone + shift, color)
            if not found and oto is None:
                found, oto = self.singer.try_get_mapped_oto(test, note.tone + shift, color)
            if found and oto is not None:
                otos.append(oto)

        if otos:
            for o in otos:
                if (getattr(o, 'color', None) or '') == color:
                    return o
            return otos[0]
        return None

    # ------------------------------------------------------------------ #
    # 歌词分段
    # ------------------------------------------------------------------ #
    def _convert_to_oto_styled_lyric(self, lyric: str) -> str:
        lyric = lyric.replace('ç', 'ch')
        lyric = lyric.replace('ş', 'sh')
        lyric = lyric.replace('ğ', '9')
        lyric = lyric.replace('æ', 'ae')
        lyric = lyric.replace('E', 'ae')
        lyric = lyric.replace('ı', 'eu')
        lyric = lyric.replace('ö', 'oe')
        lyric = lyric.replace('ü', 'ue')
        return lyric

    def _get_segmented_phonemes(self, lyric: str) -> _SegmentedLyric:
        """对应 C# `getSegmentedPhonemes`：把歌词拆成 [StartC1, StartC2, Vow, EndC1, EndC2]。"""
        lyric = self._convert_to_oto_styled_lyric(lyric)
        phonemes = ['', '', '', '', '']
        has_9_before_vow = False
        char_index = 0
        i = 0
        while i < 5 and char_index < len(lyric):
            two_char = ''
            if char_index + 2 <= len(lyric):
                two_char = lyric[char_index:char_index + 2]
            one_char = lyric[char_index]

            if i < 2 and one_char == '9':
                has_9_before_vow = True
                char_index += 1
            elif two_char in VOWELS:
                i = 2
                phonemes[i] = two_char
                char_index += 2
            elif one_char in VOWELS:
                i = 2
                phonemes[i] = one_char
                char_index += 1
            elif two_char in CONSONANTS and i != 2:
                phonemes[i] = two_char
                char_index += 2
            elif one_char in CONSONANTS and i != 2:
                phonemes[i] = one_char
                char_index += 1
            else:
                # not found
                i -= 1
                char_index += 1

            i += 1
            if char_index >= len(lyric):
                break

        return _SegmentedLyric(lyric=lyric,
                               start_c1=phonemes[0], start_c2=phonemes[1],
                               vow=phonemes[2],
                               end_c1=phonemes[3], end_c2=phonemes[4],
                               has_9_before_vow=has_9_before_vow)

    def _get_alternative_consonant(self, consonant: str, vow: str) -> str:
        if vow in ('e', 'i', 'ue', 'oe'):
            y = 'Y' if consonant.upper() == consonant else 'y'
            if consonant + y in CONSONANTS:
                return consonant + y
        return consonant

    def _check_pchtk(self, c: str) -> str:
        if c in ('p', 'ch', 't', 'k'):
            return ''
        return '-'

    def _get_note_start(self, current: _SegmentedLyric, prev: _SegmentedLyric) -> List[str]:
        note_start = current.start_c1 + current.start_c2 + current.vow
        has_no_prev_neighbour = prev.start_c1 == '' and prev.vow == ''
        result = ['- ' + note_start, note_start, current.lyric]

        if has_no_prev_neighbour:
            return result

        if current.start_c1 == '':
            if prev.has_consonant_after_vowel():
                # vc + V
                if prev.end_c1.upper() in SUSTAINED_CONSONANTS:
                    result[0] = prev.end_c1.upper() + ' ' + current.vow
            elif prev.vow != '':
                # v + V
                if current.has_9_before_vow:
                    result[0] = prev.vow + ' 9' + current.vow
                else:
                    result[0] = prev.vow + ' ' + current.vow
            return result

        return [note_start, current.lyric]

    def _get_consonant_ending(self, current: _SegmentedLyric, has_next: bool,
                              next_: _SegmentedLyric) -> List[str]:
        v_ = current.vow + ' '

        if current.end_c1 in GLOTTAL_STOPS:
            return [v_ + current.end_c1]

        if has_next:
            if current.end_c1 != '' and current.end_c1 == next_.start_c1:
                return [v_ + self._get_alternative_consonant(current.end_c1, current.vow)]

            if next_.start_c1 in ('g', 'k'):
                if current.end_c1 == 'n':
                    current.end_c1 = 'ng'
                elif current.end_c1 == 'N':
                    current.end_c1 = 'NG'

        if not current.has_consonant_after_vowel():
            if not has_next:
                return [v_ + '-']
            if next_.has_consonant_before_vowel():
                # V + c
                return [v_ + self._get_alternative_consonant(next_.start_c1, next_.vow)]
            # V + v
            return ['']

        return [v_ + current.end_c1 + self._check_pchtk(current.end_c1),
                v_ + current.end_c1]

    # ------------------------------------------------------------------ #
    # Process
    # ------------------------------------------------------------------ #
    def process(self, notes: List[Note], prev: Optional[Note],
                next_: Optional[Note], prev_neighbour: Optional[Note],
                next_neighbour: Optional[Note], prevs: List[Note]) -> Result:
        note = notes[0]
        current_lyric = unicodedata.normalize('NFC', note.lyric)

        if current_lyric and current_lyric[0] == '.':
            return Result(phonemes=[Phoneme(phoneme=current_lyric[1:])])

        phonemes_current = self._get_segmented_phonemes(current_lyric)
        phonemes_prev = _SegmentedLyric.empty()
        phonemes_next = _SegmentedLyric.empty()

        if prev_neighbour is not None:
            phonemes_prev = self._get_segmented_phonemes(
                unicodedata.normalize('NFC', prev_neighbour.lyric))
        if next_neighbour is not None:
            phonemes_next = self._get_segmented_phonemes(
                unicodedata.normalize('NFC', next_neighbour.lyric))

        note_start_input = self._get_note_start(phonemes_current, phonemes_prev)
        note_end_input = self._get_consonant_ending(phonemes_current,
                                                    next_neighbour is not None,
                                                    phonemes_next)
        note_start = ''
        note_end = ''
        note_end_cc = ''

        if phonemes_current.end_c2 != '':
            # + VCC
            note_end_input = [phonemes_current.vow + ' ' + phonemes_current.end_c1
                              + self._check_pchtk(phonemes_current.end_c1)]
            note_end_cc = phonemes_current.end_c1 + phonemes_current.end_c2 + ' -'

        o1 = self._check_oto_until_hit(note_start_input, note)
        if o1 is not None:
            note_start = getattr(o1, 'alias', '')

        o2 = self._check_oto_until_hit(note_end_input, note)
        if o2 is not None:
            note_end = getattr(o2, 'alias', '')
        else:
            note_end = ''

        o3 = self._check_oto_until_hit([note_end_cc], note)
        if o3 is not None:
            note_end_cc = getattr(o3, 'alias', '')
        else:
            note_end_cc = ''

        if note_start != '' and note_end == '' and note_end_cc == '':
            return Result(phonemes=[Phoneme(phoneme=note_start)])

        if note_start != '' and note_end != '':
            total_duration = sum(n.duration for n in notes)
            last_length_from_oto = 120
            is_cv_coeff = 1.8 if phonemes_current.has_consonant_after_vowel() else 1.0
            is_end_coeff = 1 if next_neighbour is not None else 2

            if next_neighbour is not None:
                attr0 = next((a for a in next_neighbour.phoneme_attributes if a.index == 0),
                             PhonemeAttributes())
                shift0 = attr0.tone_shift if attr0.tone_shift is not None else self.get_parent_tone_shift()
                color0 = attr0.voice_color if attr0.voice_color is not None else self.get_parent_voice_color()
                found0, oto0 = self.singer.try_get_mapped_oto(
                    self._get_note_start(phonemes_next, phonemes_current)[0],
                    note.tone + shift0, color0)
                if found0 and oto0 is not None:
                    overlap = getattr(oto0, 'overlap', 0.0)
                    preutter = getattr(oto0, 'preutter', 0.0)
                    if overlap < 0:
                        last_length_from_oto = self.time_axis.ms_pos_to_tick_pos(preutter - overlap)
                    else:
                        last_length_from_oto = self.time_axis.ms_pos_to_tick_pos(preutter)

            attr1 = next((a for a in note.phoneme_attributes if a.index == 1),
                         PhonemeAttributes())
            csr1 = attr1.consonant_stretch_ratio if attr1.consonant_stretch_ratio is not None else self.get_parent_consonant_stretch_ratio()
            vc_length = _bankers_round(min(total_duration / (2 * is_end_coeff),
                                           last_length_from_oto * is_cv_coeff * csr1))

            if note_end_cc == '':
                return Result(phonemes=[
                    Phoneme(phoneme=note_start),
                    Phoneme(phoneme=note_end, position=total_duration - vc_length),
                ])

            cc_length_from_oto = 60
            attr2 = next((a for a in note.phoneme_attributes if a.index == 2),
                         PhonemeAttributes())
            if next_neighbour is not None:
                shift2 = attr2.tone_shift if attr2.tone_shift is not None else self.get_parent_tone_shift()
                color2 = attr2.voice_color if attr2.voice_color is not None else self.get_parent_voice_color()
                found1, oto1 = self.singer.try_get_mapped_oto(note_end_cc,
                                                              note.tone + shift2, color2)
                if found1 and oto1 is not None:
                    overlap1 = getattr(oto1, 'overlap', 0.0)
                    preutter1 = getattr(oto1, 'preutter', 0.0)
                    if overlap1 < 0:
                        cc_length_from_oto = self.time_axis.ms_pos_to_tick_pos(preutter1 - overlap1)
                    else:
                        cc_length_from_oto = self.time_axis.ms_pos_to_tick_pos(preutter1)

            csr2 = attr2.consonant_stretch_ratio if attr2.consonant_stretch_ratio is not None else self.get_parent_consonant_stretch_ratio()
            vc_length = _bankers_round(min(total_duration / 3,
                                           cc_length_from_oto * csr1))
            cc_length = _bankers_round(min(total_duration / 3,
                                           last_length_from_oto * csr2))

            return Result(phonemes=[
                Phoneme(phoneme=note_start),
                Phoneme(phoneme=note_end, position=total_duration - vc_length - cc_length),
                Phoneme(phoneme=note_end_cc, position=total_duration - cc_length,
                        expressions=[PhonemeExpression(abbr=Ustx.VOL, value=70)]),
            ])

        return Result(phonemes=[Phoneme(phoneme=current_lyric)])
