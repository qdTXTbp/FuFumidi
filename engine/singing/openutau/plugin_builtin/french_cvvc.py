"""FrenchCVVCPhonemizer —— `OpenUtau.Plugin.Builtin/FrenchCVVCPhonemizer.cs`(757) 全文件照搬。

注册名：`FR CVVC`（`[Phonemizer("French CVVC Phonemizer", "FR CVVC", "Mim", language: "FR")]`）。
"""
from typing import List, Optional

from ..phonemizer import Note, PhonemeAttributes, register
from .syllable_based import Ending, Syllable, SyllableBasedPhonemizer

VOWELS = (
    'ah', 'ae', 'eh', 'ee', 'oe', 'ih', 'oh', 'oo', 'ou', 'uh',
    'en', 'in', 'on', 'oi', 'ui',
    'a', 'ai', 'e', 'i', 'o', 'u', 'eu',
)

CONSONANTS = (
    'b', 'd', 'f', 'g', 'j', 'k', 'l', 'm', 'n', 'p', 'r', 's', 'sh', 't', 'v', 'w', 'y', 'z',
    'gn', '.', '-', 'R', 'BR', '_hh',
)

#: 子类硬编码的音素替换表；会进 G2pRemapper.replacements，但**不**覆盖基类字段。
#: ★ C# 构造时 `.Where(parts[0] != parts[1])` 会**丢弃自映射**（ee=ee / oe=oe / oo=oo /
#: ou=ou / in=in / on=on / gn=gn / 4=4）。
_REPL_MAP = {
    'aa': 'ah', 'ai': 'ae', 'ei': 'eh', 'eu': 'ee', 'ii': 'ih',
    'au': 'oh', 'uu': 'uh', 'an': 'en', 'un': 'in', 'uy': 'ui',
    'bb': 'b', 'dd': 'd', 'ff': 'f', 'gg': 'g', 'jj': 'j', 'kk': 'k', 'll': 'l', 'mm': 'm',
    'nn': 'n', 'pp': 'p', 'rr': 'r', 'ss': 's', 'ch': 'sh', 'tt': 't', 'vv': 'v', 'ww': 'w',
    'yy': 'y', 'zz': 'z', '4': 'l', 'hh': 'h',
}

_SHORT_CONSONANTS = ('r',)
_LONG_CONSONANTS = ('t', 'k', 'g', 'p', 's', 'sh', 'j')

#: Fraloids 专用元音转换（ValidateAlias 内用）。
_FRALOIDS_REPLACEMENT = {
    'ah': 'a', 'ae': 'ai', 'ee': 'e', 'ih': 'i', 'oh': 'o', 'uh': 'u', 'oe': 'eu',
}


@register
class FrenchCVVCPhonemizer(SyllableBasedPhonemizer):
    """对应 C# `FrenchCVVCPhonemizer`。

    字段 `usesFraloids` 会在每次 `Process*` 开头根据 ``HasOto("a", tone)`` 重新判定，
    与 C# 一致（实例状态，不是配置）。
    """

    name = 'French CVVC Phonemizer'
    tag = 'FR CVVC'
    author = 'Mim'
    language = 'FR'

    def __init__(self) -> None:
        super().__init__()
        self.uses_fraloids: bool = False

    def get_vowels(self) -> List[str]:
        return list(VOWELS)

    def get_consonants(self) -> List[str]:
        return list(CONSONANTS)

    def get_dictionary_name(self) -> str:
        return 'cmudict_fr.txt'

    def get_dictionary_phonemes_replacement(self) -> dict:
        return dict(_REPL_MAP)

    # ------------------------------------------------------------------ #
    # ProcessSyllable
    # ------------------------------------------------------------------ #
    def process_syllable(self, syllable: Syllable) -> List[str]:
        prev_v = syllable.prev_v
        cc = list(syllable.cc)
        v = syllable.v

        # C# 里 lastC / firstC 是死局部变量，照搬保留命名但不用
        _last_c = len(cc) - 1  # noqa: F841
        _first_c = 0           # noqa: F841

        base_phoneme: Optional[str] = None
        phonemes: List[str] = []

        if prev_v == 'ui':
            prev_v = 'ih'

        # Convert to Fraloids
        if self.has_oto('a', syllable.tone):
            self.uses_fraloids = True
            v = self.validate_alias(v)
            prev_v = self.validate_alias(prev_v)
        else:
            self.uses_fraloids = False

        # --------------------------- STARTING V ------------------------------- #
        if syllable.is_starting_v:
            base_phoneme = self._check_alias_formatting(v, 'cv', syllable.vowel_tone, '')

        # --------------------------- is VV ------------------------------- #
        elif syllable.is_vv:
            if not self.can_make_alias_extension(syllable):
                vv_check = prev_v + v
                # TODO clean exception of fraloids ai/a + i conflict
                if self.uses_fraloids and vv_check == 'ai':
                    base_phoneme = self._check_alias_formatting(v, 'vvFr', syllable.vowel_tone, prev_v)
                else:
                    base_phoneme = self._check_alias_formatting(v, 'vv', syllable.vowel_tone, prev_v)
                    if base_phoneme == v:
                        if prev_v in ('ih', 'i'):
                            base_phoneme = 'y' + v
                        if prev_v == 'ou':
                            base_phoneme = 'w' + v
                        if not self.has_oto(base_phoneme, syllable.tone):
                            base_phoneme = v
            else:
                # the previous alias will be extended
                base_phoneme = None

        # --------------------------- STARTING CV ------------------------------- #
        elif syllable.is_starting_cv_with_one_consonant:
            cv = cc[0] + v
            base_phoneme = self._check_alias_formatting(cv, 'cv', syllable.tone, '')
            if '-' not in base_phoneme:
                self.try_add_phoneme(phonemes, syllable.tone,
                                     self._check_alias_formatting(cc[0], 'rcv', syllable.tone, ''))

        # --------------------------- STARTING CCV ------------------------------- #
        elif syllable.is_starting_cv_with_more_than_one_consonant:
            rccv = ''.join(cc) + v
            rccv = self._check_alias_formatting(rccv, 'rcv', syllable.tone, '')
            if self.has_oto(rccv, syllable.vowel_tone):
                base_phoneme = rccv
            else:
                base_phoneme = cc[-1] + v

                max_ = len(cc)
                min_ = 0

                # try -CC of all lengths
                for i in range(len(cc)):
                    rcc = ''.join(cc[:max_])
                    rcc = self._check_alias_formatting(rcc, 'rcv', syllable.tone, '')
                    if self.has_oto(rcc, syllable.tone):
                        phonemes.append(rcc)
                        break
                    max_ -= 1

                if self._find_last_valid_alias(phonemes, cc) == len(cc) - 1:
                    pass  # GOOD JOB :)
                else:
                    min_ = len(cc) - self._find_last_valid_alias(phonemes, cc)
                    max_ = len(cc)
                    # try CCV of all lengths
                    for i in range(min_):
                        rccv2 = ''.join(cc[i:]) + v
                        if not self.has_oto(rccv2, syllable.tone):
                            rccv2 = self.validate_alias(rccv2)
                        if self.has_oto(rccv2, syllable.vowel_tone):
                            base_phoneme = rccv2
                            break
                        max_ -= 1

                    # try _CV else add CV
                    under_cv = '_' + cc[-1] + v
                    if self.has_oto(under_cv, syllable.vowel_tone) and max_ == len(cc) - min_:
                        base_phoneme = under_cv

                    # try CC of all lengths
                    for i in range(len(cc) - max_):
                        rcc = ''.join(cc[:min_])
                        if self.has_oto(rcc, syllable.tone):
                            phonemes.append(rcc)
                            break
                        min_ -= 1

                    if self._find_last_valid_alias(phonemes, cc) == len(cc) - 1:
                        pass  # GOOD JOB :)
                    else:
                        min_ = self._find_last_valid_alias(phonemes, cc)
                        # add remaining CC
                        for i in range(min_, len(cc) - max_):
                            ccc = cc[i]
                            ccc = self._check_alias_formatting(ccc, 'endccOe', syllable.tone, cc[i])

                            # exception of y sound
                            if cc[i + 1] == 'y' and self._check_coe_ending(ccc, syllable.tone) in ccc:
                                if self.uses_fraloids:
                                    ccc = cc[i] + 'i'
                                else:
                                    ccc = cc[i] + 'ih'
                            phonemes.append(ccc)

        # --------------------------- IS VCV ------------------------------- #
        elif syllable.is_vcv_with_one_consonant:
            vcv = prev_v + ' ' + cc[0] + v
            if self.has_oto(vcv, syllable.vowel_tone):
                base_phoneme = vcv
            else:
                cv = cc[0] + v
                base_phoneme = cv

                # Fraloids "Vn"/"V n" conflict solve
                vc = ''
                if self.uses_fraloids:
                    vc = prev_v + ' ' + cc[0]
                    vc = self._replace_fraloids_conflict(vc, syllable.tone)
                    if self.has_oto(vc, syllable.tone):
                        phonemes.append(vc)
                    else:
                        vc = prev_v + cc[0]
                        if self.has_oto(vc, syllable.tone):
                            phonemes.append(vc)

                if not phonemes:
                    vc = self._check_alias_formatting(cc[0], 'vc', syllable.tone, prev_v)
                    if self.has_oto(vc, syllable.tone):
                        phonemes.append(vc)

        # ------------- IS VCV WITH MORE THAN ONE CONSONANT --------------- #
        else:
            base_phoneme = cc[-1] + v
            max_ = len(cc)
            min_ = 0

            # Fraloids "Vn"/"V n" conflict solve
            vc = ''
            if self.uses_fraloids:
                vc = prev_v + ' ' + cc[0]
                vc = self._replace_fraloids_conflict(vc, syllable.tone)
                if self.has_oto(vc, syllable.tone):
                    phonemes.append(vc)

            if not phonemes:
                # try VCC of all lengths
                for i in range(len(cc)):
                    vcc = ''.join(cc[:len(cc) - i])
                    vcc = self._check_alias_formatting(vcc, 'vc', syllable.tone, prev_v)
                    if self.has_oto(vcc, syllable.tone):
                        phonemes.append(vcc)
                        break

            min_ = len(cc) - self._find_last_valid_alias(phonemes, cc)
            max_ = len(cc)
            # try CCV of all lengths
            for i in range(min_):
                ccv = ''.join(cc[i:]) + v
                if not self.has_oto(ccv, syllable.tone):
                    ccv = self.validate_alias(ccv)
                if self.has_oto(ccv, syllable.vowel_tone):
                    base_phoneme = ccv
                    break
                max_ -= 1

            # try _CV else add CV
            under_cv = '_' + cc[-1] + v
            if self.has_oto(under_cv, syllable.vowel_tone) and max_ == len(cc) - min_:
                base_phoneme = under_cv

            min_ = self._find_last_valid_alias(phonemes, cc)
            if min_ == len(cc):
                pass  # GOOD JOB :) //
            else:
                min_ -= 1
                # add remaining CC
                for i in range(min_, len(cc) - max_):
                    ccc = cc[i]
                    if i + 1 >= len(cc):
                        break

                    ccc = self._check_alias_formatting(ccc, 'endccOe', syllable.tone, cc[i + 1])

                    if (self._check_coe_ending(ccc, syllable.tone) in ccc
                            or ccc == cc[i]):
                        if cc[i] == cc[i + 1]:
                            break
                        if i == 0 and cc[i + 1] != 'y':
                            continue

                    # exception of y sound
                    if cc[i + 1] == 'y' and self._check_coe_ending(ccc, syllable.tone) in ccc:
                        if self.uses_fraloids:
                            ccc = cc[i] + 'i'
                        else:
                            ccc = cc[i] + 'ih'

                    if ccc == cc[i]:
                        if i + 2 <= len(cc):
                            break

                    phonemes.append(ccc)

        if base_phoneme is not None:
            phonemes.append(base_phoneme)
        return phonemes

    # ------------------------------------------------------------------ #
    # ProcessEnding
    # ------------------------------------------------------------------ #
    def process_ending(self, ending: Ending) -> List[str]:
        cc = list(ending.cc)
        v = ending.prev_v
        phonemes: List[str] = []

        # Convert to Fraloids
        if self.has_oto('a', ending.tone):
            self.uses_fraloids = True
            v = self.validate_alias(v)
        else:
            self.uses_fraloids = False

        # --------------------------- ENDING V ------------------------------- #
        if ending.is_ending_v:
            end_v = self._check_alias_formatting(v, 'end', ending.tone, '')
            self.try_add_phoneme(phonemes, ending.tone, end_v)

            # TODO: clean exceptions
            if not phonemes:
                end_v = v + ' R'
                self.try_add_phoneme(phonemes, ending.tone, end_v)
                if not phonemes:
                    end_v = v + ' BR'
                    self.try_add_phoneme(phonemes, ending.tone, end_v)
                    if not phonemes:
                        end_v = v + '_hh'
                        self.try_add_phoneme(phonemes, ending.tone, end_v)

        # --------------------------- ENDING VC ------------------------------- #
        elif ending.is_ending_vc_with_one_consonant:
            vc = ''

            # Fraloids "Vn"/"V n" conflict solve
            if self.uses_fraloids:
                vc = v + ' ' + cc[0]
                vc = self._replace_fraloids_conflict(vc, ending.tone)
                if self.has_oto(vc, ending.tone):
                    phonemes.append(vc)

            if not phonemes:
                vc = self._check_alias_formatting(v + cc[0], 'endVc', ending.tone, '')
                if self.has_oto(vc, ending.tone):
                    phonemes.append(vc)
                else:
                    vc = self._check_alias_formatting(cc[0], 'vc', ending.tone, v)
                    phonemes.append(vc)

            if '-' not in vc:
                self.try_add_phoneme(phonemes, ending.tone,
                                     self._check_alias_formatting(cc[0], 'end', ending.tone, ''))

        # --------------------------- ENDING VCC ------------------------------- #
        else:
            max_ = len(cc)

            # Fraloids "Vn"/"V n" conflict solve
            vc = ''
            if self.uses_fraloids:
                vc = v + ' ' + cc[0]
                vc = self._replace_fraloids_conflict(vc, ending.tone)
                if self.has_oto(vc, ending.tone):
                    phonemes.append(vc)

            if not phonemes:
                # try VCC of all lengths
                for i in range(len(cc)):
                    typ = 'endVc'
                    if i > 0:
                        typ = 'blank'

                    vcc = ''.join(cc[:len(cc) - i])
                    temp = v + vcc
                    temp = self._check_alias_formatting(temp, typ, ending.tone, '')
                    if self.has_oto(temp, ending.tone):
                        vcc = temp
                        phonemes.append(vcc)
                        break
                    else:
                        temp = v + ' ' + vcc
                        temp = self._check_alias_formatting(temp, typ, ending.tone, '')
                        if self.has_oto(temp, ending.tone):
                            vcc = temp
                            phonemes.append(vcc)
                            break
                    max_ -= 1

            if self._find_last_valid_alias(phonemes, cc) == len(cc):
                end = self._check_alias_formatting(cc[-1], 'end', ending.tone, '')
                self.try_add_phoneme(phonemes, ending.tone, end)
            else:
                # add remaining CC
                for i in range(max_ - 1, len(cc)):
                    ccc = cc[i]

                    # if last C & it has CC- then break the loop
                    if i + 1 == len(cc) - 1:
                        ccc = cc[i] + cc[i + 1]
                        ccc = self._check_alias_formatting(ccc, 'end', ending.tone, '')
                        if self.has_oto(ccc, ending.tone):
                            phonemes.append(ccc)
                            break

                    # else try CC
                    if i + 1 < len(cc):
                        ccc = cc[i]
                        ccc = self._check_alias_formatting(ccc, 'endcc', ending.tone, cc[i + 1])
                        if self.has_oto(ccc, ending.tone):
                            phonemes.append(ccc)
                            continue

                    if i > 0:
                        ccc = cc[i]
                        ccc = self._check_alias_formatting(ccc, 'endcOe', ending.tone, '')

                    if self.has_oto(ccc, ending.tone):
                        phonemes.append(ccc)

        return phonemes

    # ------------------------------------------------------------------ #
    # ValidateAlias
    # ------------------------------------------------------------------ #
    def validate_alias(self, alias: str, tone: int = 0) -> str:
        # TODO: add "oi" exception
        if self.has_oto(alias, tone):
            return alias

        base_resolved = super().validate_alias(alias, tone)
        if base_resolved and base_resolved != alias:
            if self.has_oto(base_resolved, tone):
                return base_resolved
            alias = base_resolved

        # fraloids conversion
        if self.uses_fraloids:
            for key, value in _FRALOIDS_REPLACEMENT.items():
                alias = alias.replace(key, value)

        for oi in ('wah', 'wa'):
            alias = alias.replace(oi, 'oi')

        return alias

    # ------------------------------------------------------------------ #
    # helpers
    # ------------------------------------------------------------------ #
    def _replace_fraloids_conflict(self, vc: str, tone: int) -> str:
        fraloids_vcs = {
            'o n': 'on2',
            'e n': 'en2',
            'i n': 'in2',
            'u n': 'un2',
        }

        if self.has_oto(vc, tone) or vc == 'ai n':
            return vc

        for key, value in fraloids_vcs.items():
            vc = vc.replace(key, value)
        return vc

    def _check_coe_ending(self, cv: str, tone: int) -> str:
        # TODO: Improve cOe check
        if self.has_oto(cv, tone) and 'oe' in cv:
            return 'oe'
        if 'eu' in cv:
            return 'eu'
        return 'no Coe Ending'

    @property
    def no_gap(self) -> bool:
        return True

    def get_transition_basic_length_ms(self, alias: str, tone: int, attr: PhonemeAttributes) -> float:
        return self.get_transition_basic_length_ms_by_oto(alias, tone, attr)

    def _check_alias_formatting(self, alias: str, typ: str, tone: int, prev_v: str) -> str:
        """对应 C# `CheckAliasFormatting`。aliasFormats 数组顺序与内容完全照搬。"""
        alias_formats = ['-', '- ', '', '-', ' -', '', prev_v, prev_v + ' ', '_', '',
                         prev_v, ' ' + prev_v, '', 'oe', 'eu']
        starting_i = 0
        ending_i = len(alias_formats)

        # ---- TODO: CLEAN THIS //
        if typ == 'end':
            starting_i = 3
            ending_i = starting_i + 1
        elif typ == 'endC':
            starting_i = 2
            ending_i = starting_i + 1
        elif typ == 'endVc':
            starting_i = 3
            ending_i = starting_i + 2
        elif typ == 'vc':
            starting_i = 6
            ending_i = starting_i + 1
        elif typ == 'endcc':
            starting_i = 6
            ending_i = starting_i + 1
        elif typ == 'rcv':
            starting_i = 0
            ending_i = starting_i + 1
        elif typ == 'vv':
            starting_i = 6
            ending_i = starting_i + 3
        elif typ == 'vvFr':
            starting_i = 7
            ending_i = starting_i + 3
        elif typ == 'cc':
            starting_i = 6
            ending_i = starting_i + 1
        elif typ == 'endccOe':
            starting_i = 10
            ending_i = starting_i + 4
        elif typ == 'endcOe':
            starting_i = 12
            ending_i = starting_i + 2
        elif typ == 'blank':
            starting_i = 2
            ending_i = starting_i
        elif typ == 'cv':
            starting_i = 0
            ending_i = starting_i + 2
        # ---- TODO: CLEAN THIS ^^^^^^ //

        for i in range(starting_i, ending_i + 1):
            if 'end' in typ:
                alias_format = alias + alias_formats[i]
            else:
                alias_format = alias_formats[i] + alias
            if self.has_oto(alias_format, tone):
                return alias_format

        return 'no alias found'

    def _find_last_valid_alias(self, input_phonemes: List[str], word_phonemes: List[str]) -> int:
        last_alias_index = 0
        for i in range(len(input_phonemes)):
            last_alias_index = 0
            for k in range(len(word_phonemes)):
                if word_phonemes[k] not in input_phonemes[i]:
                    break
                last_alias_index += 1
        return last_alias_index

    # ------------------------------------------------------------------ #
    # GetSymbols
    # ------------------------------------------------------------------ #
    def get_symbols(self, note: Note) -> Optional[List[str]]:
        original = super().get_symbols(note)
        if original is None:
            return None

        arpabet = ['aa', 'ai', 'ei', 'eu', 'ii', 'au', 'uu', 'an', 'un', 'uy',
                   'bb', 'dd', 'ff', 'gg', 'jj', 'kk', 'll', 'mm', 'nn', 'pp',
                   'rr', 'ss', 'ch', 'tt', 'vv', 'ww', 'yy', 'zz']
        petitmot = ['ah', 'ae', 'eh', 'ee', 'ih', 'oh', 'uh', 'en', 'in', 'ui',
                    'b', 'd', 'f', 'g', 'j', 'k', 'l', 'm', 'n', 'p',
                    'r', 's', 'sh', 't', 'v', 'w', 'y', 'z']

        convert: List[str] = []
        for s in original:
            c = s
            for i, a in enumerate(arpabet):
                if s == a:
                    c = petitmot[i]
                    break
            convert.append(c)

        if convert is None:
            return None

        modified: List[str] = []
        for s in convert:
            if s == 'gn':
                modified.extend(['n', 'y'])
            else:
                modified.append(s)
        return modified
