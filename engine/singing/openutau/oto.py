# -*- coding: utf-8 -*-
"""音源「原音设定」模型 —— 照搬 `OpenUtau.Core/Ustx/USinger.cs` 的 UOto 部分
（外加它构造时依赖的 `Classic/VoiceBank.cs` 的原始结构，与 `Util/MusicMath.cs` 的音名换算）。

为什么先搬这一块：**音素化器与所有渲染器都要靠 oto 查表**——
`UPhoneme` 验证音素时要 `singer.TryGetOto()`，渲染器要 `oto.Preutter/Overlap/Consonant/Cutoff`。
把它搬到位，后面两条线才站得住。

## 照搬时保留的语义（别"整理"掉）
- `offset/consonant/preutter` 的 setter 会 `max(0, round(v, 3))`；`cutoff/overlap`
  **只 round 不夹紧**（可以是负的）—— 负 cutoff 表示不做淡出，是有意义的取值。
- 这四个小数一律 **round 到 3 位**，这是 OpenUTAU 的既有约定，写回文件时依赖它。
- `Color` 是**拼接**结果：子音色为空时显示 `(main)`。
- `Prefix/Suffix` 只取**第一个** subbank 的。

## 与 C# 的等价性差异
- `WriteBack()` 依赖 `INotifyPropertyChanged` 的事件链，Python 无对应机制，
  这里只做数值回写（事件留待 M3 前端需要时再接）。
- `IsColorMatch` 在 C# 里若 `Subbanks` 为 null 会抛 NullReference；Python 这里同样会抛
  （TypeError），未做"更友好"的处理 —— 保持行为一致比"更健壮"更重要。
- `Subbank` 在 C# 里其实定义于 **VoicebankConfig.cs**（`VoiceBank.cs` 只是用它）。
  这里没把它挪进 `classic/voicebank_config.py`，是因为 `oto.py` 位于 `classic/`
  **之外**，反向导入会触发 `classic` 包的初始化，而 `classic/__init__.py` 又要
  延迟到 `openutau/__init__.py` 末尾才导入（渲染器注册顺序）—— 构成循环。
  代之以：类留在 `oto.py`，`voicebank_config.py` 反过来 `from ..oto import Subbank`。
- `FileTrace`（定义在 `Classic/VoicebankLoader.cs`）同理不能顶层导入，
  `Oto.file_trace` 用**前向引用**标注，见该字段的注释。
- `Voicebank.TextFileEncoding` 在 C# 是 `Encoding` 对象；Python 侧存编码**名**
  （如 `'cp932'`），由 `VoicebankLoader` 负责名字 ↔ codec 的换算。
- C# 的三个 `ToString()`（`Voicebank→Name` / `OtoSet→Name` / `Oto→Alias`）都搬了；
  其中 `Voicebank.ToString()` 可能是 null，Python 的 `__str__` 必须返回 str，兜了空串。
"""

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Dict, List, Optional

# MusicMath 已按 C# 的文件边界独立成 music_math.py（Util/MusicMath.cs），
# 这里只做转发，保持 `from .oto import MusicMath, NAME_IN_OCTAVE` 的写法可用。
from .music_math import NAME_IN_OCTAVE, MusicMath  # noqa: F401
from .singer import USingerType

if TYPE_CHECKING:
    # `FileTrace` 定义在 `classic/VoicebankLoader.cs`；**运行时**不能导入
    # （`voicebank_loader` 反过来要 `Oto`，会成环），只用于类型标注。
    from .classic.voicebank_loader import FileTrace


# ---------------------------------------------------------------- 原始结构（Classic/VoiceBank.cs）

@dataclass
class Subbank:
    """对应 VoicebankConfig.cs 的 `Subbank`（定义位置见模块 docstring 的说明）。"""

    color: str = ''
    prefix: str = ''
    suffix: str = ''
    tone_ranges: Optional[List[str]] = None


@dataclass
class Oto:
    """对应 Classic/VoiceBank.cs 的 Oto（oto.ini 的一条原始记录）。"""

    alias: str = ''
    phonetic: str = ''
    wav: str = ''
    offset: float = 0
    consonant: float = 0
    cutoff: float = 0
    preutter: float = 0
    overlap: float = 0
    #: C# 里 `public bool IsValid;` —— 引用/值类型默认是 **false**，
    #: 只有 `VoicebankLoader.ParseOto` 六个字段全部解析成功才置 true。
    #: 别"顺手"改成 True：那会让"没解析出来"的条目被当成有效原音。
    is_valid: bool = False
    error: str = ''
    #: 对应 C# 的 `FileTrace? FileTrace`。类型是 `Classic/VoicebankLoader.cs` 里定义的
    #: `FileTrace` 对象（**不是字符串**）；标注用的导入在 `TYPE_CHECKING` 块里。
    file_trace: Optional['FileTrace'] = None

    def __str__(self):
        """对应 C# 的 `Oto.ToString() => Alias`（见陷阱 #8：别留默认的内存地址版）。"""
        return self.alias


@dataclass
class OtoSet:
    """对应 Classic/VoiceBank.cs 的 OtoSet（一个 oto.ini 文件）。"""

    file: str = ''
    name: str = ''
    otos: List[Oto] = field(default_factory=list)

    def __str__(self):
        return self.name


@dataclass
class Voicebank:
    """对应 Classic/VoiceBank.cs 的 `Voicebank`（`character.txt` + `character.yaml`
    + oto 摊平之后的声库信息；具体加载见 `Classic/VoicebankLoader.cs`）。

    注意几个默认值：`portrait_opacity` 在这里是 **0**（C# 的字段默认值），
    与 `character.yaml` 里的 `PortraitOpacity = 0.67f` **不是**同一个默认 ——
    只有配置文件写了 portrait 时才会被覆盖成 0.67。
    `singer_type` 默认 `USingerType.Classic`。
    """

    base_path: Optional[str] = None
    file: Optional[str] = None
    name: Optional[str] = None
    localized_names: Dict[str, str] = field(default_factory=dict)
    search_terms: List[str] = field(default_factory=list)
    image: Optional[str] = None
    portrait: Optional[str] = None
    portrait_opacity: float = 0.0
    portrait_height: int = 0
    author: Optional[str] = None
    voice: Optional[str] = None
    web: Optional[str] = None
    version: Optional[str] = None
    sample: Optional[str] = None
    other_info: Optional[str] = None
    default_phonemizer: Optional[str] = None
    #: C# 是 `Encoding`；Python 侧存**编码名**（如 `'cp932'`），载体差异。
    text_file_encoding: Optional[str] = None
    singer_type: int = USingerType.CLASSIC
    oto_sets: List['OtoSet'] = field(default_factory=list)
    subbanks: List[Subbank] = field(default_factory=list)
    id: Optional[str] = None
    #: 三态 `bool?`：`None` = 未声明。
    use_filename_as_alias: Optional[bool] = None

    def reload(self) -> None:
        """对应 C# 的 `Reload()`：清空后重新加载。

        照搬的怪癖：**不清 `default_phonemizer`**（C# 同样没清），
        且 `base_path` / `file` 保留（`LoadVoicebank` 还要靠它们重新定位）。
        改成"清干净"属于行为变更，应单独立项。
        """
        self.name = None
        self.localized_names.clear()
        self.search_terms.clear()
        self.image = None
        self.portrait = None
        self.portrait_opacity = 0
        self.portrait_height = 0
        self.author = None
        self.voice = None
        self.web = None
        self.version = None
        self.sample = None
        self.other_info = None
        self.text_file_encoding = None
        self.singer_type = USingerType.CLASSIC
        self.oto_sets.clear()
        self.subbanks.clear()
        self.id = None
        self.use_filename_as_alias = None
        # 延迟导入：本模块在 `classic/` 之外，顶层导入会构成循环（见模块 docstring）。
        from .classic.voicebank_loader import VoicebankLoader

        VoicebankLoader.load_voicebank(self)

    def __str__(self):
        """对应 C# 的 `Voicebank.ToString() => Name`。

        C# 允许返回 null，Python 的 `__str__` 必须返回 str，所以这里兜了个空串。
        """
        return self.name or ''


# ---------------------------------------------------------------- UOto 一族（Ustx/USinger.cs）

class UOtoSet:
    """对应 USinger.cs 的 UOtoSet。"""

    __slots__ = ('_oto_set', 'location')

    def __init__(self, oto_set: OtoSet, singers_path: str):
        import os
        self._oto_set = oto_set
        if oto_set.file:
            self.location = os.path.join(singers_path, os.path.dirname(oto_set.file))
        else:
            self.location = ''

    @property
    def name(self) -> str:
        return self._oto_set.name

    def __str__(self):
        return self.name


class USubbank:
    """对应 USinger.cs 的 USubbank（含 ToneRanges → tone_set 的解析）。"""

    def __init__(self, subbank: Subbank):
        self.subbank = subbank
        self.tone_set = []              # C# 是 SortedSet<int>；Python 用有序去重列表
        if subbank.tone_ranges is not None:
            self.tone_ranges_string = ','.join(subbank.tone_ranges)
            for r in subbank.tone_ranges:
                self._add_tone_range(r)
        else:
            self.tone_ranges_string = ''

    @property
    def color(self) -> str:
        return self.subbank.color

    @color.setter
    def color(self, v: str):
        self.subbank.color = v

    @property
    def prefix(self) -> str:
        return self.subbank.prefix

    @prefix.setter
    def prefix(self, v: str):
        self.subbank.prefix = v

    @property
    def suffix(self) -> str:
        return self.subbank.suffix

    @suffix.setter
    def suffix(self, v: str):
        self.subbank.suffix = v

    @property
    def tone_ranges_string(self) -> str:
        return self._tone_ranges_string

    @tone_ranges_string.setter
    def tone_ranges_string(self, value: str):
        self.subbank.tone_ranges = [p for p in value.split(',') if p]   # 去掉空项
        self._tone_ranges_string = value

    def _add_tone_range(self, rng: str):
        """照搬 AddToneRange：`C4` 单音；`C4-D5` 闭区间。非法项静默跳过。"""
        parts = rng.split('-')
        if len(parts) == 1:
            tone = MusicMath.name_to_tone(parts[0])
            if tone > 0:
                self._add(tone)
        elif len(parts) == 2:
            start = MusicMath.name_to_tone(parts[0])
            end = MusicMath.name_to_tone(parts[1])
            if start > 0 and end > 0:
                for t in range(start, end + 1):
                    self._add(t)

    def _add(self, tone: int):
        if tone not in self.tone_set:
            self.tone_set.append(tone)
            self.tone_set.sort()

    def __str__(self):
        return 'color:%s, suffix:%s' % (self.color, self.suffix)


class UOto:
    """对应 USinger.cs 的 UOto（可供渲染/编辑器使用的原音条目）。"""

    def __init__(self, oto: Optional[Oto] = None, oto_set: Optional[UOtoSet] = None,
                 subbanks: Optional[List[USubbank]] = None):
        import os
        self.alias = ''
        self.phonetic = ''
        self.oto_set = ''
        self.subbanks: Optional[List[USubbank]] = None
        self.file = ''
        self.display_file = ''
        self.frq = None
        self.search_terms: List[str] = []
        self._oto = oto
        self._offset = 0.0
        self._consonant = 0.0
        self._cutoff = 0.0
        self._preutter = 0.0
        self._overlap = 0.0
        if oto is not None:
            self.alias = oto.alias
            self.phonetic = oto.phonetic
            self.oto_set = oto_set.name if oto_set is not None else ''
            self.subbanks = subbanks
            self.file = os.path.join(oto_set.location, oto.wav) if (oto_set is not None and oto.wav) else ''
            self.display_file = oto.wav
            self.offset = oto.offset
            self.consonant = oto.consonant
            self.cutoff = oto.cutoff
            self.preutter = oto.preutter
            self.overlap = oto.overlap

    # --- 取值：注意夹紧/取整规则（照搬 setter）
    @property
    def offset(self) -> float:
        return self._offset

    @offset.setter
    def offset(self, v: float):
        self._offset = max(0.0, round(v, 3))

    @property
    def consonant(self) -> float:
        return self._consonant

    @consonant.setter
    def consonant(self, v: float):
        self._consonant = max(0.0, round(v, 3))

    @property
    def cutoff(self) -> float:
        return self._cutoff

    @cutoff.setter
    def cutoff(self, v: float):
        self._cutoff = round(v, 3)          # 不夹紧：负 cutoff 是有意义的

    @property
    def preutter(self) -> float:
        return self._preutter

    @preutter.setter
    def preutter(self, v: float):
        self._preutter = max(0.0, round(v, 3))

    @property
    def overlap(self) -> float:
        return self._overlap

    @overlap.setter
    def overlap(self, v: float):
        self._overlap = round(v, 3)         # 不夹紧：负 overlap 是有意义的

    # --- 派生显示值
    @property
    def color(self) -> str:
        if self.subbanks is None:
            return ''
        return ', '.join((s.color if (s.color or '').strip() else '(main)') for s in self.subbanks)

    @property
    def prefix(self) -> str:
        return self.subbanks[0].prefix if self.subbanks else ''

    @property
    def suffix(self) -> str:
        return self.subbanks[0].suffix if self.subbanks else ''

    @staticmethod
    def of_dummy(alias: str) -> 'UOto':
        u = UOto()
        u.alias = alias
        u.phonetic = alias
        return u

    def is_color_match(self, color: str) -> bool:
        return any(s.color == color for s in self.subbanks)

    def write_back(self) -> None:
        """把（可能被编辑器改过的）数值写回原始 Oto 对象。"""
        if self._oto is None:
            return
        self._oto.offset = self._offset
        self._oto.consonant = self._consonant
        self._oto.cutoff = self._cutoff
        self._oto.preutter = self._preutter
        self._oto.overlap = self._overlap

    def __str__(self):
        return self.alias
