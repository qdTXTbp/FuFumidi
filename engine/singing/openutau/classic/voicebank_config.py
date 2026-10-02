# -*- coding: utf-8 -*-
"""声库配置 —— **照搬** `OpenUtau.Core/Classic/VoicebankConfig.cs`（91 行）。

一个声库目录里可以放 `character.yaml`，用来**覆盖** `character.txt` 里的信息
（名字、图标、立绘、默认音素化器、子音色…），并声明 `oto.ini` 的编码。
`VoicebankLoader`（下一步 r3）读它，`Voicebank` 把结果摊平。

## 照搬时保留的语义（别"整理"掉）
- **写盘用 OpenUTAU 的全局 Yaml 配置**：下划线命名 + `OmitNull` + `DisableAliases`
  （`Util/Yaml.cs`）。所以 `PortraitOpacity` 的键是 `portrait_opacity`，
  未知键读取时一律忽略。
- **`OmitNull` 不是 `OmitDefaults`**：只有 `null` 才省略。因此 `portrait_opacity: 0.67`
  与 `portrait_height: 0` 这些**默认值照样写出来**。别写成"等于默认就不写"。
- 于是字符串字段的默认值是 `None`（C# 引用类型默认 null），**不是空串** ——
  改成 `''` 会让写出的 character.yaml 凭空多出一堆空键。
- `UseFilenameAsAlias` 是 `bool?`（三态）：`None` = 没声明，`False` = 明确关闭。
  不能塌成 `bool`。
- `SymbolSet` 照搬，即使上游注明 **"Not used by OpenUtau at the moment."**。
- 枚举按**名字**存（YamlDotNet 默认行为），所以 `SymbolSetPreset` 用字符串常量。

## 与 C# 的等价性差异
- `Save(Stream)` / `Load(Stream)` 在 Python 侧收**文件路径**（与
  `Classic/ResamplerManifest.Load(path)` 的既有写法一致）。这是**载体差异**。
- C# 的 `[YamlValues]` 特性只是给编辑器的下拉候选项，Python 侧保留对应的
  取值来源（`SingerTypeValues`）但不搬特性本身。
- `PortraitOpacity` 在 C# 是 `float`（float32），Python 是 double；
  写盘两者都是 `0.67`，见 `Util/Yaml.cs` 的浮点格式。
"""

from dataclasses import dataclass
from typing import Dict, List, Optional

from ...ustx.io import dump_yaml, load_yaml
# `Subbank` 的 C# 定义确实在本文件（VoicebankConfig.cs），但 Python 侧它留在
# `oto.py` —— 理由见 `oto.py` 模块 docstring 的循环导入说明，这里只做引用。
from ..oto import Subbank
from ..singer import SINGER_TYPE_FROM_NAME


class SymbolSetPreset:
    """对应 VoicebankConfig.cs 的 `enum SymbolSetPreset`（序列化为名字）。

    C# 原定义：`enum SymbolSetPreset { unknown, hiragana, arpabet }`，
    隐式取值 0/1/2。按本项目的枚举约定（见 `ustx/model.py` 开头），
    Python 侧存**名字**。
    """

    UNKNOWN = 'unknown'
    HIRAGANA = 'hiragana'
    ARPABET = 'arpabet'


class SingerTypeValues:
    """对应 C# 的 `SingerTypeValues : IYamlValueSource`（`singer_type` 的候选值）。

    C# 让编辑器写 `singer_type` 时能选：值就是
    `SingerTypeUtils.SingerTypeFromName.Keys`（本仓库的 `SINGER_TYPE_FROM_NAME`）。
    引擎侧不读它，搬过来是为了不丢东西。
    """

    @staticmethod
    def get_values() -> List[str]:
        return list(SINGER_TYPE_FROM_NAME.keys())


@dataclass
class SymbolSet:
    """对应 VoicebankConfig.cs 的 `SymbolSet`。

    上游注明 "Not used by OpenUtau at the moment."，照搬并保留该注释的含义：
    改成"有用"属于行为变更，应单独立项。
    """

    preset: str = SymbolSetPreset.UNKNOWN
    head: str = '-'
    tail: str = 'R'


@dataclass
class VoicebankConfig:
    """对应 VoicebankConfig.cs 的 `VoicebankConfig`（`character.yaml`）。

    字段顺序 = 声明顺序 = 写盘顺序；`None` 不写盘（OmitNull）。
    各字段的 C# 默认值见 `VoicebankConfig.cs` 的对应行。
    """

    #: [Description] Name shown for this singer. Overrides the name in character.txt.
    name: Optional[str] = None
    #: 其它语言的名字，按语言码索引（`ja-JP: 名前`）。
    localized_names: Optional[Dict[str, str]] = None
    #: 额外搜索词（昵称、罗马音等）。
    search_terms: Optional[List[str]] = None
    #: 声库种类：utau / enunu / diffsinger / voicevox。未指定时按目录内容猜。
    #: C# 用 `[YamlValues(typeof(SingerTypeValues))]` 标注候选值。
    singer_type: Optional[str] = None
    #: 文本文件编码（character.txt / oto.ini），如 shift_jis / utf-8。
    #: 未指定时 C# 默认 shift_jis；`oto.ini` 还能用 `#Charset:` 自行声明。
    text_file_encoding: Optional[str] = None
    #: 图标，相对声库目录。
    image: Optional[str] = None
    #: 钢琴卷帘里显示的立绘，相对声库目录。
    portrait: Optional[str] = None
    #: 立绘不透明度，0（透明）~ 1（不透明）。C# 默认 `0.67f`。
    portrait_opacity: float = 0.67
    #: 立绘缩放到的像素高度。0 表示"高于 800 像素的缩到 800"。
    portrait_height: int = 0
    author: Optional[str] = None
    voice: Optional[str] = None
    web: Optional[str] = None
    version: Optional[str] = None
    #: "试听"播放的音频，相对声库目录。
    sample: Optional[str] = None
    #: 选中该歌手时默认使用的音素化器（写全类型名）。
    #: 候选值由 `Api/PhonemizerFactory.cs` 的 `PhonemizerTypeValues` 提供（尚未移植）。
    default_phonemizer: Optional[str] = None
    #: 描述别名里用到的符号集（上游注明当前未被使用）。
    symbol_set: Optional[SymbolSet] = None
    #: 子音色与音域，靠别名的 prefix/suffix 区分。
    subbanks: Optional[List[Subbank]] = None
    #: 仅 UTAU 声库：除别名外，是否把样本**文件名去扩展名**也当别名。
    #: 三态：`None` = 未声明。
    use_filename_as_alias: Optional[bool] = None

    def save(self, path: str) -> None:
        """对应 C# 的 `Save(Stream)`（UTF-8，OpenUTAU 全局 Yaml 设置）。"""
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            f.write(dump_yaml(self))

    @staticmethod
    def load(path: str) -> 'VoicebankConfig':
        """对应 C# 的 `Load(Stream)`（UTF-8；未知键忽略）。"""
        with open(path, 'r', encoding='utf-8-sig') as f:
            return load_yaml(VoicebankConfig, f.read())
