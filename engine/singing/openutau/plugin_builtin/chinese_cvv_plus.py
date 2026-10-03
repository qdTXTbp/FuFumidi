# -*- coding: utf-8 -*-
"""中文 CVV+ 音素化器 —— **照搬**
`OpenUtau.Plugin.Builtin/ChineseCVVPlusPhonemizer.cs`（374 行）。

C# 声明：`[Phonemizer("Chinese CVV Plus Phonemizer", "ZH CVV+", "2xxbin", language: "ZH")]`

本文件含 C# 里同名的**三段**：
1. `ChineseCVVPlusConfigYaml` —— 声库目录下 `zhcvvplus.yaml` 的配置模型
   （两个 `[YamlIgnore]` 计算属性 `TailVowels` / `Consonants`）；
2. 内嵌的 `FlowStyleIntegerSequences`（YamlDotNet 事件发射器，只为让数组写成行内样式）
   —— Python 侧是**载体差异**，见下；
3. `ChineseCVVPlusPhonemizer` 本身。

## 照搬时保留的语义（别"整理"掉）
1. ★ **`Consonants` 按长度降序**（`OrderByDescending(c => c.Length)`）。
   这直接决定 `GetLyricVowel` 里"zh/ch/sh 先于 z/c/s 被剥掉"。LINQ 的
   `OrderByDescending` 是**稳定**排序，Python 的 `sorted(..., reverse=True)` 同样稳定，
   等长元素的相对次序一致（已在断言里钉住）。
2. `GetLyricVowel` 的三步：先**累积并剥掉开头所有非字母字符**（`initialPrefix`），
   再取 `min(2, len)` 作前缀、其余作后缀，逐个声母 `StartsWith` 命中就
   **`Replace` 掉整个声母**；最后 `yu→v`、`y→i`、`w→u` 后 `Trim()`。
   注意 `Replace("yu","v")` 在 `y→i` **之前**，所以 `yu` 不会被先吃成 `iu`。
3. ★ **`TailVowels` 用 `Concat(...).ToDictionary(...)` 合并快/慢两张表** ——
   `ToDictionary` 在**键重复时会抛**。Python 的 `dict.update` 会静默覆盖，
   所以这里显式在重复时抛错，让同一层 `except` 接住（否则会安静地算出不同结果）。
4. `isExistPhonemeInOto` / `GetOtoAlias` 是**三段式**查询：
   `phoneme+alt`（带 toneShift）→ `phoneme`（带 toneShift）→ `phoneme`（**不带 toneShift**）。
   第三段的 `note.tone` 用的是原始音高，别顺手统一。
5. `phoneticHint` 分支：按 `,` 切分，每段 `Trim()` 后查 oto；位置是
   `totalDuration - (totalDuration / n) * (n - index)` —— **C# 整数除法**（`//`）。
6. ★ `Process` 最外层 `try/catch` 把**任何**异常变成单音素 `"ERROR"`。
   于是「歌词为空 → `lyric.First()` 抛」「`Config` 还是 null → NRE」这些情况
   在上游都表现为 `ERROR` 音素。这里照搬，`self.config` 初值保持 `None`。
7. ≥ 上游怪癖：`SingleVowelsReferenceTimimgTick` 字段名里 **`Timimg` 是拼错的**
   （应为 Timing），yaml 键也照抄这个拼写，否则用户已有的配置文件读不到。
8. ≥ 上游怪癖：`SetSinger` 里**第一次** `CreateConfigChineseCVVPlus` 不在 try 内 ——
   声库目录只读时会直接把异常抛出 `SetSinger`（不是静默跳过）。照搬，并写进断言。

## ★ 载体差异
- `FlowStyleIntegerSequences` 是 YamlDotNet 的 `ChainedEventEmitter`，作用只是让
  **序列**写成 `[a, b]` 行内样式。Python 侧用 PyYAML 的 `default_flow_style=None`
  等价（标量序列走行内、映射走块状）。**配置文件的键名与结构保持一致**，
  所以 OpenUTAU 与 FuFumidi 可以互相读对方写出来的 `zhcvvplus.yaml`。
- `File.ReadAllText` → `utf-8-sig`（带 BOM 也能读）。
"""

import io
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import yaml

from ..phonemizer import Note, Phoneme, Phonemizer, Result, register

#: Python 字段名 → yaml 键名（与 C# 的属性名逐字一致，含那处拼写错误 `Timimg`）
_YAML_KEY = {
    'vowel_tail_prefix': 'VowelTailPrefix',
    'use_single_nasal_vowel': 'UseSingleNasalVowel',
    'use_single_multiple_vowel': 'UseSingleMultipleVowel',
    'use_retan': 'UseRetan',
    'supported_tail_breath': 'SupportedTailBreath',
    'consonant_dict': 'ConsonantDict',
    'single_vowel_dict': 'SingleVowelDict',
    'nasal_vowel_dict': 'NasalVowelDict',
    'multiple_vowel_dict': 'MultipleVowelDict',
    'fast_tail_vowel_timing_tick': 'FastTailVowelTimingTick',
    'single_vowels_reference_timimg_tick': 'SingleVowelsReferenceTimimgTick',
    'fast_tail_vowel_dict': 'FastTailVowelDict',
    'slow_tail_vowel_dict': 'SlowTailVowelDict',
}

_DEFAULT_CONSONANTS = ['zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l',
                       'z', 'c', 's', 'r', 'j', 'q', 'x', 'g', 'k', 'h']
_DEFAULT_SINGLE_VOWELS = ['a', 'o', 'e', 'i', 'u', 'v', 'er']
_DEFAULT_NASAL_VOWELS = ['an', 'en', 'ang', 'eng', 'ong', 'ian', 'iang', 'ing', 'iong',
                         'uan', 'uen', 'un', 'uang', 'ueng', 'van', 'vn']
_DEFAULT_MULTIPLE_VOWELS = ['ai', 'ei', 'ao', 'ou', 'ia', 'iao', 'ie', 'iou', 'ua', 'uo',
                            'uai', 'uei', 'ui', 've']
_DEFAULT_FAST_TAIL = {'ia': 'ia', 'ie': 'ie', 'ua': 'ua', 'uo': 'uo', 've': 've'}
_DEFAULT_SLOW_TAIL = {
    'ai': 'ai', 'ei': 'ei', 'ao': 'ao', 'ou': 'ou',
    'an': 'an', 'en': 'en', 'ang': 'ang', 'eng': 'eng', 'ong': 'ong',
    'iao': 'ao', 'iu': 'ou', 'iou': 'ou',
    'ian': 'ian', 'in': 'in', 'iang': 'ang', 'ing': 'ing', 'iong': 'ong',
    'uai': 'ai', 'ui': 'ei', 'uei': 'ei',
    'uan': 'an', 'un': 'uen', 'uang': 'ang', 'ueng': 'eng',
    'van': 'en', 'vn': 'vn',
}


def _is_letter(ch: str) -> bool:
    """对应 C# 的 `char.IsLetter`（单字符判定）。"""
    return bool(ch) and ch.isalpha()


@dataclass
class ChineseCVVPlusConfigYaml:
    """对应 `ChineseCVVPlusConfigYaml`（字段默认值与 C# 逐项一致）。"""

    vowel_tail_prefix: str = '_'
    use_single_nasal_vowel: bool = False
    use_single_multiple_vowel: bool = False
    use_retan: bool = False
    supported_tail_breath: List[str] = field(default_factory=lambda: ['-'])
    consonant_dict: List[str] = field(default_factory=lambda: list(_DEFAULT_CONSONANTS))
    single_vowel_dict: List[str] = field(default_factory=lambda: list(_DEFAULT_SINGLE_VOWELS))
    nasal_vowel_dict: List[str] = field(default_factory=lambda: list(_DEFAULT_NASAL_VOWELS))
    multiple_vowel_dict: List[str] = field(default_factory=lambda: list(_DEFAULT_MULTIPLE_VOWELS))
    fast_tail_vowel_timing_tick: int = 100
    # ★ 上游拼写错误照搬（见模块 docstring 第 7 条）
    single_vowels_reference_timimg_tick: int = 480
    fast_tail_vowel_dict: Dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_FAST_TAIL))
    slow_tail_vowel_dict: Dict[str, str] = field(default_factory=lambda: dict(_DEFAULT_SLOW_TAIL))

    # ---------------------------------------------------------------- [YamlIgnore] 计算属性

    @property
    def tail_vowels(self) -> Dict[str, str]:
        """对应 `TailVowels`：快表 `Concat` 慢表后 `ToDictionary`。

        ★ `ToDictionary` 在**键重复时抛异常**；这里显式复刻该行为，
        不让 `dict.update` 静默覆盖（那会安静地算出与上游不同的结果）。
        """
        merged: Dict[str, str] = {}
        for k, v in list(self.fast_tail_vowel_dict.items()) + list(self.slow_tail_vowel_dict.items()):
            if k in merged:
                raise ValueError('An item with the same key has already been added. Key: %s' % k)
            merged[k] = v
        return merged

    @property
    def consonants(self) -> List[str]:
        """对应 `Consonants`：按长度**降序**（稳定排序，等长保持原次序）。"""
        return sorted(self.consonant_dict, key=len, reverse=True)


def config_to_yaml(cfg: Optional['ChineseCVVPlusConfigYaml'] = None) -> str:
    """把配置序列化成 yaml 文本（对应 `SerializerBuilder().WithEventEmitter(...)`）。

    `default_flow_style=None` ⇒ 标量序列写成 `[a, b]`、映射写成块状，
    与 C# 那个 `FlowStyleIntegerSequences` 的意图一致。
    """
    cfg = cfg or ChineseCVVPlusConfigYaml()
    out = dict((_YAML_KEY[f], getattr(cfg, f)) for f in _YAML_KEY)
    return yaml.safe_dump(out, default_flow_style=None, allow_unicode=True, sort_keys=False)


def config_from_yaml(text: str) -> Optional['ChineseCVVPlusConfigYaml']:
    """从 yaml 文本读配置；**未知键忽略**（对应 `IgnoreUnmatchedProperties`）。

    解析不出映射（空文件 / 非映射内容）时返回 `None` —— C# 的
    `Deserialize<T>` 在这种输入下同样得到 null，随后由调用方回落默认值。
    """
    try:
        data = yaml.safe_load(text)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    cfg = ChineseCVVPlusConfigYaml()
    for fname, key in _YAML_KEY.items():
        if key not in data:
            continue
        v = data[key]
        if v is None:
            continue
        default = getattr(cfg, fname)
        try:
            if isinstance(default, list):
                setattr(cfg, fname, list(v))
            elif isinstance(default, dict):
                setattr(cfg, fname, dict(v))
            elif isinstance(default, bool):
                setattr(cfg, fname, bool(v))
            elif isinstance(default, int):
                setattr(cfg, fname, int(v))
            else:
                setattr(cfg, fname, v if isinstance(v, str) else str(v))
        except (TypeError, ValueError):
            continue                      # 类型不对就当没写这一项，保持默认值
    return cfg


@register
class ChineseCVVPlusPhonemizer(Phonemizer):
    """对应 `ChineseCVVPlusPhonemizer`。

    C# 里它继承 `BaseChinesePhonemizer`，但**全程没有用到**那个基类的
    `Romanize`（本音素化器直接吃拼音/粤拼歌词，不做汉字转换），所以这里按
    项目既有做法直接继承 `Phonemizer`（`base_chinese.BaseChinesePhonemizer`
    本身也不继承 `Phonemizer`，见其 docstring）。
    """

    name = 'Chinese CVV Plus Phonemizer'
    tag = 'ZH CVV+'
    author = '2xxbin'
    language = 'ZH'

    def __init__(self):
        super().__init__()
        self.singer = None
        # ★ 初值保持 None：C# 里 `Config` 未初始化，`Process` 在没有 `SetSinger`
        #   的情况下会 NRE → 被外层 catch 成 "ERROR" 音素。这里同理。
        self.config: Optional[ChineseCVVPlusConfigYaml] = None

    # ------------------------------------------------------------------ 歌手 / 配置

    def set_singer(self, singer) -> None:
        """对应 `SetSinger`：读声库目录下的 `zhcvvplus.yaml`，缺了就写一份默认的。"""
        if singer is None:
            return
        config_path = os.path.join(singer.location or '', 'zhcvvplus.yaml')

        # ★ 上游怪癖：这一次 CreateConfig **不在 try 内** —— 目录只读时会直接抛出
        #   `SetSinger`（不是静默跳过）。照搬，见 test 里的断言。
        if not os.path.isfile(config_path):
            self.create_config(config_path)

        try:
            with io.open(config_path, 'r', encoding='utf-8-sig') as f:
                content = f.read()
            self.config = config_from_yaml(content)
        except Exception:                             # noqa: BLE001
            try:
                self.create_config(config_path)
            except Exception:                         # noqa: BLE001
                pass

        self.singer = singer
        if self.config is None:
            self.config = ChineseCVVPlusConfigYaml()

    def create_config(self, config_path: str) -> None:
        """对应 `CreateConfigChineseCVVPlus`：把默认配置写到声库目录。"""
        text = config_to_yaml(ChineseCVVPlusConfigYaml())
        parent = os.path.dirname(config_path)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        with io.open(config_path, 'w', encoding='utf-8') as f:
            f.write(text)

    # ------------------------------------------------------------------ 歌词 → 韵母

    def get_lyric_vowel(self, lyric: str) -> str:
        """对应 `GetLyricVowel`。

        ★ 歌词为空时 `lyric.First()` 在 C# 抛 `InvalidOperationException`，
        这里对应 `lyric[0]` 的 `IndexError` —— 两者都被 `Process` 的外层 catch
        变成 `"ERROR"` 音素，语义相同。
        """
        initial_prefix = ''

        # 剥掉开头的非字母字符（例如 "- qian" 的前导字符）
        while not _is_letter(lyric[0]):
            initial_prefix += lyric[0]
            lyric = lyric[1:]
            if len(lyric) == 0:
                return lyric

        # 只取前两个字符做声母剥离，避免把韵母一起吃掉（ian 不能变成 ia）
        prefix = lyric[0:min(2, len(lyric))]
        suffix = lyric[2:] if len(lyric) > 2 else ''

        for consonant in self.config.consonants:
            if prefix.startswith(consonant):
                prefix = prefix.replace(consonant, '')

        body = (prefix + suffix).replace('yu', 'v').replace('y', 'i').replace('w', 'u').strip()
        return '%s%s' % (initial_prefix, body)

    # ------------------------------------------------------------------ oto 查询

    def _color_shift_alt(self, note: Note):
        """取 index==0 的覆盖值，缺失则回落轨道默认（对应那段 `?? default`）。"""
        attr = next((a for a in (note.phoneme_attributes or []) if a.index == 0), None)
        if attr is not None:
            color = attr.voice_color if attr.voice_color is not None else self.get_parent_voice_color()
            shift = attr.tone_shift if attr.tone_shift is not None else self.get_parent_tone_shift()
            alt = attr.alternate if attr.alternate is not None else self.get_parent_alternate()
        else:
            color = self.get_parent_voice_color()
            shift = self.get_parent_tone_shift()
            alt = self.get_parent_alternate()
        return color, shift, alt

    def is_exist_phoneme_in_oto(self, phoneme: str, note: Note) -> bool:
        """对应 `isExistPhonemeInOto`（三段式查询，任一命中即真）。"""
        color, shift, alt = self._color_shift_alt(note)
        if phoneme == '':
            return False
        alt_suffix = str(alt) if alt is not None else ''
        if self.mapped_oto(phoneme + alt_suffix, note.tone + shift, color) is not None:
            return True
        if self.mapped_oto(phoneme, note.tone + shift, color) is not None:
            return True
        if self.mapped_oto(phoneme, note.tone, color) is not None:
            return True
        return False

    def get_oto_alias(self, phoneme: str, note: Note) -> str:
        """对应 `GetOtoAlias`（三段式，全落空则返回 `phoneme` 本身）。"""
        color, shift, alt = self._color_shift_alt(note)
        alt_suffix = str(alt) if alt is not None else ''
        oto = self.mapped_oto(phoneme + alt_suffix, note.tone + shift, color)
        if oto is not None:
            return oto.alias
        oto = self.mapped_oto(phoneme, note.tone + shift, color)
        if oto is not None:
            return oto.alias
        oto = self.mapped_oto(phoneme, note.tone, color)
        if oto is not None:
            return oto.alias
        return phoneme

    # ------------------------------------------------------------------ 主逻辑

    def process(self, notes: List[Note], prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prevs=None) -> Result:
        try:
            note = notes[0]
            total_duration = sum(n.duration for n in notes)
            phoneme = note.lyric
            lyric_vowel = self.get_lyric_vowel(note.lyric)

            # ---- 1) 音素提示：按逗号切分，位置均分
            if note.phonetic_hint is not None:
                hints = note.phonetic_hint.split(',')
                n = len(hints)
                return Result(phonemes=[
                    Phoneme(
                        phoneme=self.get_oto_alias(hint.strip(), note),
                        # 位置被均分成 n 份（C# 整数除法）
                        position=total_duration - ((total_duration // n) * (n - index)),
                    )
                    for index, hint in enumerate(hints)
                ])

            # ---- 2) 句末换气："{前邻韵母} {本音符歌词}"
            if phoneme in self.config.supported_tail_breath and prev_neighbour is not None:
                phoneme = self.get_oto_alias(
                    '%s %s' % (self.get_lyric_vowel(prev_neighbour.lyric), phoneme), note)
                return Result(phonemes=[Phoneme(phoneme=phoneme)])

            # ---- 3) Retan：首音符且 `- 歌词` 在 oto 里存在
            if (self.config.use_retan and prev_neighbour is None
                    and self.is_exist_phoneme_in_oto('- %s' % phoneme, note)):
                phoneme = self.get_oto_alias('- %s' % phoneme, note)

            # ---- 4) 需要尾韵母时插一个尾韵母
            if lyric_vowel in self.config.tail_vowels:
                tail_phoneme = '%s%s' % (self.config.vowel_tail_prefix,
                                         self.config.tail_vowels[lyric_vowel])
                is_nasal = lyric_vowel in self.config.nasal_vowel_dict
                is_multiple = lyric_vowel in self.config.multiple_vowel_dict
                # ★ 照搬 C# 的括号与优先级：`A && (B || C) || D || E`
                if ((total_duration <= self.config.single_vowels_reference_timimg_tick
                     and ((self.config.use_single_nasal_vowel and is_nasal)
                          or (self.config.use_single_multiple_vowel and is_multiple)))
                        or ((not self.config.use_single_nasal_vowel) and is_nasal)
                        or ((not self.config.use_single_multiple_vowel) and is_multiple)):
                    # 为了自然，尾韵母放在音符的 1/3 处
                    tail_position = total_duration - total_duration // 3
                    if lyric_vowel in self.config.fast_tail_vowel_dict:
                        tail_position = self.config.fast_tail_vowel_timing_tick
                    return Result(phonemes=[
                        Phoneme(phoneme=self.get_oto_alias(phoneme, note)),
                        Phoneme(phoneme=self.get_oto_alias(tail_phoneme, note),
                                position=tail_position),
                    ])

            # ---- 5) 其余情况：单音素
            return Result(phonemes=[Phoneme(phoneme=self.get_oto_alias(phoneme, note))])
        except Exception:                             # noqa: BLE001
            # ★ 上游把**任何**异常都变成 "ERROR" 音素（注释只写了日志，行为是返回 ERROR）
            return Result(phonemes=[Phoneme(phoneme='ERROR')])
