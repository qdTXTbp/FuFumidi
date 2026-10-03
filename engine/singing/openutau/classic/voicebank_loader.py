# -*- coding: utf-8 -*-
"""声库加载 —— **照搬** `OpenUtau.Core/Classic/VoicebankLoader.cs`（549 行）。

一个声库目录里放 `character.txt`（必需）+ 可选的 `character.yaml`（见
`voicebank_config.py`）、`oto.ini`、`prefix.map`、`prefix/*.map`，本模块把它们读成
`oto.Voicebank`。`char`/`oto` 的编码默认 shift_jis（= .NET 的 code page 932），
`oto.ini` 还能用首部的 `#Charset:` 行自行声明。

## 照搬时保留的语义（别"整理"掉）
- **空白行走 `ParseOto` 的早退分支**：返回的 `Oto` 只有 `file_trace`，
  `is_valid=False`、`error` 为空。于是 oto 表里会混进"无效条目" —— 这是上游行为，
  `write_oto_set` 正是靠它把无法解析的原始行**原样写回**。
- **`parse_double(None)` 算成功且值为 0**：所以 `a.wav=a` 这种截断行会被判
  `is_valid=True`（五个数值全 0）；只有"非空且不是数字"才报错。
- **`Array.ForEach(s, temp => temp.Trim())` 是死代码**：`string` 不可变，trim 结果被丢弃。
  所以 `name = Foo`（等号两侧有空格）**认不出来**，会落进 `other_info`。
- **`AddAliasForMissingFiles` 造出来的条目 `IsValid` 是 false**（对象初始化器没写它）。
  看着像 bug，但 `ClassicSinger` 只收 `IsValid` 的条目 —— 照搬并留待单独立项。
- `ParseOtoSet` 里 `if (oto != null)` 是死分支（`ParseOto` 从不返回 null）。
- `kConfigYaml`（`"config.yaml"`）定义了但**没人用**，照搬留着。
- 遗留判型的第三个条件 `SingerType != Enunu` 在前面刚判过 Enunu，等于恒真
  （即"落到 Classic"）；照搬，不改成 `else`。
- `Reload()` 不清 `DefaultPhonemizer`（见 `oto.Voicebank.reload`）。
- `ApplyConfig` 会把 config 里 `Subbank` 的空字段**就地**改成空串，并把**同一批对象**
  塞进 `bank.subbanks`（C# 引用语义）—— 照搬。
- `GetOtoDeclaredEncoding` 只看**前 10 行**，且 `Replace("#Charset:", "")` **不 trim** ——
  于是 `#Charset: utf-8`（冒号后有空格）会因编码名非法而被判成"没声明"。

## 与 C# 的等价性差异（载体，不是行为）
- `Stream` 参数一律换成**文件路径**（C# 是 `File.OpenRead(...)` + `StreamReader`），
  `Encoding` 换成 Python 的**编码名**字符串。
- .NET 的 `"shift_jis"` 实为 **code page 932**，故映射到 `'cp932'`
  （Python 的 `'shift_jis'` 是 JIS，边缘字符不同）。
- `new StreamReader(stream, encoding)` 默认**检测 BOM**、解码失败用替换回退；
  `_read_text` 照做（`errors='replace'`）。替换字符 .NET 是 `'?'`、Python 是 `U+FFFD`。
- C# 的 `ReadLine()` 只按 `\\r\\n / \\r / \\n` 切分，`_read_lines` 精确对齐
  （`str.splitlines()` 会多认 `\\v`、`\\u2028` 等，故不用它）。
- `Dictionary` / `HashSet` 的枚举顺序：C# 未定义，Python 是插入序。子音色的先后
  可能因此不同（`parse_prefix_map`）；`Directory.GetFiles` 的顺序也依赖文件系统，
  这里统一 `sorted(...)` 以求可复现。
- `Serilog` 的 `Log.Error/Information` → 标准库 `logging`。
- C# `double.ToString()` 用**当前区域性**（这里没有 `InvariantCulture`），
  在逗号小数点的系统上会写出坏 oto.ini —— 上游缺陷；Python 固定用 `'.'`（`_cs_double`）。
- `Path.GetRelativePath` 在跨盘符时 C# 返回原路径，Python 的 `os.path.relpath` 抛
  `ValueError`，这里按 C# 语义兜住（`_get_relative_path`）。
"""

import bisect
import codecs
import glob
import logging
import os
import re
import unicodedata
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from ..music_math import MusicMath
from ..oto import Oto, OtoSet, Subbank, Voicebank
from ..singer import SINGER_TYPE_FROM_NAME, Preferences, USingerType
from .voicebank_config import VoicebankConfig

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------- 常量（对应 C# 的 `public const string kXxx`）
CHAR_TXT = 'character.txt'
CHAR_YAML = 'character.yaml'
ENUCONFIG_YAML = 'enuconfig.yaml'
DSCONFIG_YAML = 'dsconfig.yaml'
#: C# 里定义了但**没人用**（`kConfigYaml`）。
CONFIG_YAML = 'config.yaml'
OTO_INI = 'oto.ini'

#: C# 两处 `Encoding.GetEncoding("shift_jis")` 的默认值。
DEFAULT_ENCODING = 'cp932'

#: `.NET Encoding.GetEncoding(name)` → Python codec 名。
#: 关键：.NET 的 `"shift_jis"` 实为 **code page 932**（Windows-31J）。
_ENCODING_MAP = {
    'shift_jis': 'cp932',
    'shift-jis': 'cp932',
    'shiftjis': 'cp932',
    'sjis': 'cp932',
    'ms932': 'cp932',
    'utf-8': 'utf-8',
    'utf8': 'utf-8',
    'unicode': 'utf-16',
}

#: `double.TryParse(s, NumberStyles.Float, InvariantCulture, ...)` 接受的形式。
_FLOAT_RE = re.compile(r'^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$')

#: StreamReader 默认检测的 BOM（UTF-32 必须排在 UTF-16 前面：FF FE 00 00 以前缀 FF FE 开头）。
_BOMS = (
    (codecs.BOM_UTF8, 'utf-8-sig'),
    (codecs.BOM_UTF32_LE, 'utf-32'),
    (codecs.BOM_UTF32_BE, 'utf-32'),
    (codecs.BOM_UTF16_LE, 'utf-16'),
    (codecs.BOM_UTF16_BE, 'utf-16'),
)


@dataclass
class FileTrace:
    """对应 VoicebankLoader.cs 的 `FileTrace`（某条 oto 行的来源位置）。

    C# 有无参构造与**拷贝构造**两个；Python 用 `copy()` 表达拷贝构造。
    `parse_oto` 每行都必须复制一份，否则所有 oto 会共享同一个可变对象（陷阱 #1）。
    """

    file: str = ''
    line_number: int = 0
    line: str = ''

    def copy(self) -> 'FileTrace':
        """对应 C# 的拷贝构造 `new FileTrace(other)`。"""
        return FileTrace(self.file, self.line_number, self.line)

    def __str__(self):
        """对应 `ToString()`：注意行号显示为 **lineNumber + 1**（内部是 0 基）。"""
        return '"%s"\nat line %d:\n"%s"' % (self.file, self.line_number + 1, self.line)


# ---------------------------------------------------------------- 小工具

def get_encoding(name: str) -> str:
    """对应 `Encoding.GetEncoding(name)`：编码名 → Python codec 名；非法则抛 `LookupError`。

    `GetOtoDeclaredEncoding` 正是靠"名字非法会抛"这一点把 `#Charset: utf-8`
    （冒号后有空格）判成"没有声明"。Python 的 `codecs.lookup` 会把空白归一化掉，
    所以这里**显式拒绝**含空白的名字，保持与 .NET 一致的严格度。
    """
    if not name or any(c.isspace() for c in name):
        raise LookupError('unknown encoding: %r' % (name,))
    codec = _ENCODING_MAP.get(name.lower(), name)
    codecs.lookup(codec)
    return codec


def _read_text(path: str, encoding_name: str) -> str:
    """对应 `new StreamReader(File.OpenRead(path), encoding)`（**默认检测 BOM**）。"""
    with open(path, 'rb') as f:
        data = f.read()
    for bom, codec in _BOMS:
        if data.startswith(bom):
            return data.decode(codec, errors='replace')
    return data.decode(encoding_name, errors='replace')


def _read_lines(text: str) -> List[str]:
    """对应 `StreamReader.ReadLine()`：只认 `\\r\\n` / `\\r` / `\\n`。

    末尾换行不产生多余空行（`ReadLine` 在 EOF 返回 null）。
    """
    lines = re.split(r'\r\n|\r|\n', text)
    if lines and lines[-1] == '':
        lines.pop()
    return lines


def _is_blank(s: Optional[str]) -> bool:
    """对应 `string.IsNullOrWhiteSpace`。"""
    return s is None or s.strip() == ''


def _is_blank_or_empty(s: Optional[str]) -> bool:
    """对应 `string.IsNullOrEmpty`。"""
    return s is None or s == ''


def _element_at_or_default(parts: List[str], index: int) -> Optional[str]:
    """对应 LINQ 的 `ElementAtOrDefault`（越界给 None）。"""
    return parts[index] if index < len(parts) else None


def _remove_extension(file_path: str) -> str:
    """对应 `RemoveExtension(filePath)`（`Path.GetExtension` + `Substring`）。"""
    ext = os.path.splitext(file_path)[1]
    return file_path[:-len(ext)] if ext else file_path


def _get_relative_path(base_path: str, target: str) -> str:
    """对应 `Path.GetRelativePath`（跨盘符时 C# 返回原路径；Python 会抛，兜住）。"""
    try:
        return os.path.relpath(target, base_path)
    except ValueError:
        return target


def _list_dirs(directory: str) -> List[str]:
    """对应 `Directory.GetDirectories`（排序以求可复现，见模块 docstring）。"""
    return sorted(entry.path for entry in os.scandir(directory) if entry.is_dir())


def _glob_wavs(directory: str) -> List[str]:
    """对应 `Directory.GetFiles/EnumerateFiles(dir, "*.wav", TopDirectoryOnly)`。

    Windows 上 .NET 的 `*.wav` 大小写不敏感；Python 的 `glob` 经 `fnmatch` 走
    `os.path.normcase`，在 Windows 上同样不敏感。
    """
    return sorted(glob.glob(os.path.join(directory, '*.wav')))


def _cs_double(v: float) -> str:
    """C# `double.ToString()`（无格式、无 InvariantCulture）的等价输出。

    .NET Core 3.0+ 用"最短可往返"表示，与 Python 的 `repr` 一致；差别只有
    整数值省略 `.0`（`0.0 → "0"`）与指数用大写 `E`（`1e-05 → "1E-05"`）。
    """
    s = repr(float(v))
    if 'e' in s or 'E' in s:
        mantissa, _, exp = s.partition('e')
        if mantissa.endswith('.0'):
            mantissa = mantissa[:-2]
        return '%sE%+03d' % (mantissa, int(exp))
    return s[:-2] if s.endswith('.0') else s


#: 公开别名：`ExeWavtool` / `UnixWavtool` 的 `:G999` 参数格式化也要用同一个实现。
#: 理由与 `music_math.as_float32` 一样 —— **只留一份**，否则两处格式化会悄悄漂移，
#: 而它们写出来的是要交给外部 resampler/wavtool 的命令行，差一个字符就可能被拒。
cs_double = _cs_double


def cs_get_extension(path: str) -> str:
    """对应 .NET 的 `Path.GetExtension`。

    ★ 与 `os.path.splitext` 有**两处**差异，都会影响 `ToolsManager` 判"这是不是
    可执行工具"（它按扩展名分派 Exe/Unix/Linux 三种加载器）：

    | 输入 | `Path.GetExtension` | `os.path.splitext` |
    |---|---|---|
    | `.bashrc` | `.bashrc`（**整段算扩展名**） | `''` |
    | `a.` | `''`（尾点是空扩展名） | `'.'` |

    所以这里不复用 `splitext`，而是照 .NET 的"从末尾找点、点在最后则无扩展名"实现。
    """
    base = os.path.basename(path or '')
    i = base.rfind('.')
    if i < 0 or i == len(base) - 1:
        return ''
    return base[i:]


def parse_double(s: Optional[str]) -> Tuple[bool, float]:
    """对应 `ParseDouble(s, out value)`（`NumberStyles.Float` + `InvariantCulture`）。

    C# 里 `string.IsNullOrEmpty(s)` 直接算**成功**、值为 0 —— 所以缺数值字段的
    截断行会被判成功，`parse_oto` 于是把 `is_valid` 置 true。
    """
    if _is_blank_or_empty(s):
        return True, 0.0
    t = s.strip()
    if not _FLOAT_RE.match(t):
        return False, 0.0
    return True, float(t)


# ---------------------------------------------------------------- 加载器

class VoicebankLoader:
    """对应 C# 的 `VoicebankLoader`。"""

    #: 对应 C# 的 `public static bool IsTest = false;`（置 true 时跳过 `check_wav_exist`）。
    is_test = False

    def __init__(self, base_path: str):
        self.base_path = base_path

    # ------------------------------------------------------------ 搜索

    def search_all(self) -> List[Voicebank]:
        """对应 `SearchAll()`：在 `base_path` 下找 `character.txt` 并逐个加载。

        对应 C#：
          - `Preferences.LoadDeepFolderSinger` 为真 → 递归全目录；
          - 为假 → 只看**一级子目录**里的 `character.txt`。
        """
        result: List[Voicebank] = []
        if not os.path.isdir(self.base_path):
            return result
        if Preferences.load_deep_folder_singer:
            files = sorted(glob.glob(
                os.path.join(self.base_path, '**', CHAR_TXT), recursive=True))
        else:
            files = [os.path.join(d, CHAR_TXT) for d in _list_dirs(self.base_path)
                     if os.path.isfile(os.path.join(d, CHAR_TXT))]
        for file_path in files:
            try:
                voicebank = Voicebank()
                VoicebankLoader.load_info(voicebank, file_path, self.base_path)
                result.append(voicebank)
            except Exception as e:                      # noqa: BLE001 —— 照搬 C# 的 catch (Exception)
                logger.error('Failed to load %s info.', file_path, exc_info=e)
        return result

    # ------------------------------------------------------------ 入口

    @staticmethod
    def load_voicebank(voicebank: Voicebank) -> None:
        """对应 `LoadVoicebank(voicebank)`。"""
        VoicebankLoader.load_info(voicebank, voicebank.file, voicebank.base_path)
        VoicebankLoader.load_subbanks(voicebank)
        VoicebankLoader.load_oto_sets(voicebank, os.path.dirname(voicebank.file))

    @staticmethod
    def load_info(voicebank: Voicebank, file_path: str, base_path: str) -> None:
        """对应 `LoadInfo(voicebank, filePath, basePath)`。"""
        directory = os.path.dirname(file_path)
        yaml_file = os.path.join(directory, CHAR_YAML)
        bank_config: Optional[VoicebankConfig] = None
        if os.path.isfile(yaml_file):
            try:
                bank_config = VoicebankConfig.load(yaml_file)
            except Exception as e:                      # noqa: BLE001
                logger.error('Failed to load yaml %s', yaml_file, exc_info=e)
        singer_type = (bank_config.singer_type or '') if bank_config is not None else ''
        if singer_type in SINGER_TYPE_FROM_NAME:
            voicebank.singer_type = SINGER_TYPE_FROM_NAME[singer_type]
        else:
            # Legacy detection code. Do not add more here.
            enuconfig_file = os.path.join(directory, ENUCONFIG_YAML)
            dsconfig_file = os.path.join(directory, DSCONFIG_YAML)
            if os.path.isfile(enuconfig_file):
                voicebank.singer_type = USingerType.ENUNU
            elif os.path.isfile(dsconfig_file):
                voicebank.singer_type = USingerType.DIFFSINGER
            elif voicebank.singer_type != USingerType.ENUNU:
                # 前面刚判过 Enunu，所以这个条件恒真 —— 等价于"落到 Classic"。照搬。
                voicebank.singer_type = USingerType.CLASSIC
        encoding = DEFAULT_ENCODING
        if bank_config is not None and not _is_blank_or_empty(bank_config.text_file_encoding):
            encoding = get_encoding(bank_config.text_file_encoding)   # 名字非法时抛出（与 C# 同）
        VoicebankLoader.parse_character_txt(voicebank, file_path, base_path, encoding)
        if bank_config is not None:
            VoicebankLoader.apply_config(voicebank, bank_config)

    @staticmethod
    def parse_character_txt(voicebank: Voicebank, file_path: str, base_path: str,
                            encoding_name: str) -> None:
        """对应 `ParseCharacterTxt(voicebank, stream, filePath, basePath, encoding)`。"""
        voicebank.base_path = base_path
        voicebank.file = file_path
        voicebank.text_file_encoding = encoding_name
        other_lines: List[str] = []
        for raw in _read_lines(_read_text(file_path, encoding_name)):
            line = raw.strip()
            s = line.split('=', 1)
            if len(s) < 2:
                s = line.split(':', 1)
            if len(s) < 2:
                s = line.split('：', 1)
            # C#: Array.ForEach(s, temp => temp.Trim()) —— 死代码，trim 结果被丢弃。
            # 照搬：所以 "name = Foo" 认不出来（s[0] 是 "name "，不等于 "name"）。
            if len(s) == 2:
                key = s[0].lower()
                value = s[1]
                if key == 'name':
                    voicebank.name = value
                elif key == '名前' and not voicebank.name:
                    voicebank.name = value
                elif key == 'image':
                    voicebank.image = value
                elif key == 'author' or key == 'created by':
                    voicebank.author = value
                elif key.startswith('voice') or key == 'cv':
                    voicebank.voice = value
                elif key == 'sample':
                    voicebank.sample = value
                elif key == 'web':
                    voicebank.web = value
                elif key == 'version':
                    voicebank.version = value
                else:
                    other_lines.append(line)
            else:
                other_lines.append(line)
        voicebank.other_info = '\n'.join(other_lines)
        voicebank.id = _get_relative_path(base_path, os.path.dirname(voicebank.file))
        if not voicebank.name:
            voicebank.name = 'No Name (%s)' % voicebank.id

    @staticmethod
    def apply_config(bank: Voicebank, bank_config: VoicebankConfig) -> None:
        """对应 `ApplyConfig(bank, bankConfig)`。"""
        if not _is_blank(bank_config.name):
            bank.name = bank_config.name
        if bank_config.localized_names is not None:
            for key, value in bank_config.localized_names.items():
                bank.localized_names[key] = value
        if bank_config.search_terms is not None:
            bank.search_terms.extend(t for t in bank_config.search_terms if not _is_blank(t))
        if not _is_blank(bank_config.image):
            bank.image = bank_config.image
        if not _is_blank(bank_config.portrait):
            bank.portrait = bank_config.portrait
            bank.portrait_opacity = bank_config.portrait_opacity
            bank.portrait_height = bank_config.portrait_height
        if not _is_blank(bank_config.author):
            bank.author = bank_config.author
        if not _is_blank(bank_config.voice):
            bank.voice = bank_config.voice
        if not _is_blank(bank_config.web):
            bank.web = bank_config.web
        if not _is_blank(bank_config.version):
            bank.version = bank_config.version
        if not _is_blank(bank_config.sample):
            bank.sample = bank_config.sample
        if not _is_blank(bank_config.default_phonemizer):
            bank.default_phonemizer = bank_config.default_phonemizer
        if bank_config.subbanks is not None and len(bank_config.subbanks) > 0:
            for subbank in bank_config.subbanks:
                # C# 是 `??=`：就地改 config 里的对象，再把**同一批对象**挂到 bank 上。
                if subbank.color is None:
                    subbank.color = ''
                if subbank.prefix is None:
                    subbank.prefix = ''
                if subbank.suffix is None:
                    subbank.suffix = ''
            bank.subbanks.extend(bank_config.subbanks)
        if bank.singer_type == USingerType.CLASSIC and bank_config.use_filename_as_alias is not None:
            bank.use_filename_as_alias = bank_config.use_filename_as_alias

    # ------------------------------------------------------------ 子音色 / prefix.map

    @staticmethod
    def load_subbanks(voicebank: Voicebank) -> None:
        """对应 `LoadSubbanks(voicebank)`（没有子音色就造一个空的占位）。"""
        if len(voicebank.subbanks) == 0:
            VoicebankLoader.load_prefix_map(voicebank)
        if len(voicebank.subbanks) == 0:
            voicebank.subbanks.append(Subbank(tone_ranges=[]))

    @staticmethod
    def load_prefix_map(voicebank: Voicebank) -> None:
        """对应 `LoadPrefixMap(voicebank)`（`prefix.map` + `prefix/*.map`）。"""
        directory = os.path.dirname(voicebank.file)
        file_path = os.path.join(directory, 'prefix.map')
        if os.path.isfile(file_path):
            VoicebankLoader.load_map(voicebank, file_path, '')

        # Append.map for presamp
        map_dir = os.path.join(directory, 'prefix')
        if os.path.isdir(map_dir):
            for map_path in sorted(glob.glob(os.path.join(map_dir, '*.map'))):
                VoicebankLoader.load_map(
                    voicebank, map_path, _remove_extension(os.path.basename(map_path)))

    @staticmethod
    def load_map(voicebank: Voicebank, file_path: str, color: str) -> None:
        """对应 `LoadMap(voicebank, filePath, color)`。

        ★ 音域扫描的怪癖照搬：`Contains(i) && i < 108` 让 **108（C8）永远不能作为
        区间起点**，只会走到 `else` 去结算上一个区间。
        """
        try:
            prefix_map = VoicebankLoader.parse_prefix_map(file_path, voicebank.text_file_encoding)
            for (prefix, suffix), tones in prefix_map.items():
                subbank = Subbank(color=color, prefix=prefix, suffix=color + suffix)
                tone_ranges: List[str] = []
                range_start: Optional[int] = None
                range_end: Optional[int] = None
                for i in range(24, 109):
                    if i in tones and i < 108:
                        if range_start is None:
                            range_start = i
                        else:
                            range_end = i
                    elif range_start is not None:
                        if range_end is not None:
                            tone_ranges.append('%s-%s' % (MusicMath.get_tone_name(range_start),
                                                           MusicMath.get_tone_name(range_end)))
                        else:
                            tone_ranges.append(MusicMath.get_tone_name(range_start))
                        range_start = None
                        range_end = None
                subbank.tone_ranges = tone_ranges
                voicebank.subbanks.append(subbank)
        except Exception as e:                          # noqa: BLE001
            logger.error('Failed to load %s', file_path, exc_info=e)

    @staticmethod
    def parse_prefix_map(file_path: str, encoding_name: str) -> Dict[Tuple[str, str], List[int]]:
        """对应 `ParsePrefixMap(stream, encoding)`（制表符三列：音名 / 前缀 / 后缀）。

        C# 用 `SortedSet<int>`，这里用**有序列表**对齐（去重 + `bisect.insort`）。
        返回的字典在 C# 里枚举顺序未定义、Python 是插入序 —— 载体差异。
        """
        result: Dict[Tuple[str, str], List[int]] = {}
        for line in _read_lines(_read_text(file_path, encoding_name)):
            s = line.split('\t')
            if len(s) == 3:
                tone = MusicMath.name_to_tone(s[0])
                tones = result.setdefault((s[1], s[2]), [])
                if tone not in tones:
                    bisect.insort(tones, tone)
        return result

    # ------------------------------------------------------------ oto

    @staticmethod
    def load_oto_sets(voicebank: Voicebank, dir_path: str) -> None:
        """对应 `LoadOtoSets(voicebank, dirPath)`（递归子目录）。"""
        oto_file = os.path.join(dir_path, OTO_INI)
        if os.path.isfile(oto_file):
            oto_set = VoicebankLoader.parse_oto_set(
                oto_file, voicebank.text_file_encoding, voicebank.use_filename_as_alias)
            voicebank_dir = os.path.dirname(voicebank.file)
            name = _get_relative_path(voicebank_dir, dir_path)
            # 这里不做 None 兜底：`parse_oto_set` 失败会返回 None，随后取 `.name`
            # 会抛 AttributeError —— 与 C# 的 NullReferenceException 同一结局（fail fast）。
            oto_set.name = '' if name == '.' else name
            voicebank.oto_sets.append(oto_set)
        for sub in _list_dirs(dir_path):
            VoicebankLoader.load_oto_sets(voicebank, sub)

    @staticmethod
    def parse_oto_set(file_path: str, encoding_name: Optional[str] = None,
                      use_filename_as_alias: Optional[bool] = None) -> Optional[OtoSet]:
        """对应 `ParseOtoSet(filePath, encoding, useFilenameAsAlias)`。

        C# 的重载 `ParseOtoSet(stream, filePath, encoding)` 是这里的内部步骤
        (`_parse_oto_set_text`)，Python 侧合并成一个方法。
        任何异常都会退化成返回 None（与 C# 的 catch + `return null` 一致）。
        """
        try:
            declared = VoicebankLoader.get_oto_declared_encoding(file_path)
            if declared is not None:
                encoding_name = declared
            oto_set = VoicebankLoader._parse_oto_set_text(file_path, encoding_name)
            if not VoicebankLoader.is_test:
                VoicebankLoader.check_wav_exist(oto_set)
            VoicebankLoader.add_alias_for_missing_files(oto_set)
            if use_filename_as_alias is True:
                VoicebankLoader.add_filename_alias(oto_set)
            return oto_set
        except Exception as e:                          # noqa: BLE001
            logger.error('Failed to load %s', file_path, exc_info=e)
            return None

    @staticmethod
    def get_oto_declared_encoding(file_path: str) -> Optional[str]:
        """对应 `GetOtoDeclaredEncoding(filePath)`（见模块 docstring 的怪癖说明）。"""
        for line in _read_lines(_read_text(file_path, DEFAULT_ENCODING))[:10]:
            line = line.strip()
            if line.startswith('#Charset:'):
                try:
                    return get_encoding(line.replace('#Charset:', ''))
                except LookupError:
                    return None
        return None

    @staticmethod
    def _parse_oto_set_text(file_path: str, encoding_name: str) -> OtoSet:
        """对应内层重载 `ParseOtoSet(stream, filePath, encoding)`（逐行解析）。"""
        oto_set = OtoSet(file=file_path)
        trace = FileTrace(file=file_path, line_number=0)
        for line in _read_lines(_read_text(file_path, encoding_name)):
            line = line.strip()
            trace.line = line
            try:
                oto = VoicebankLoader.parse_oto(line, trace)
                # C# 这里是 `if (oto != null)` —— parse_oto 从不返回 null，是死分支。照搬。
                if oto is not None:
                    oto_set.otos.append(oto)
                if oto.error:
                    logger.error('Failed to parse\n%s', oto.error)
            except Exception as e:                      # noqa: BLE001
                logger.error('Failed to parse\n%s', trace, exc_info=e)
            trace.line = None
            trace.line_number += 1
        return oto_set

    @staticmethod
    def parse_oto(line: str, trace: FileTrace) -> Oto:
        """对应 `ParseOto(line, trace)`。

        `FileTrace` 必须**复制**（C# 是 `new FileTrace(trace)`）：否则整份 oto 表
        会共享同一个可变对象，行号/行内容互相覆盖。
        """
        fmt = '<wav>=<alias>,<offset>,<consonant>,<cutoff>,<preutter>,<overlap>'
        oto = Oto(file_trace=trace.copy())
        if _is_blank(line):
            return oto
        parts = line.split('=')
        if len(parts) < 2:
            oto.error = 'Line does not match format %s.' % fmt
            return oto
        oto.wav = parts[0].strip()
        parts = parts[1].split(',')
        oto.alias = _element_at_or_default(parts, 0) or ''
        if not oto.alias:
            oto.alias = _remove_extension(oto.wav)
        oto.phonetic = oto.alias
        ok, oto.offset = parse_double(_element_at_or_default(parts, 1))
        if not ok:
            oto.error = '%s\nFailed to parse offset. Format is %s.' % (trace, fmt)
            return oto
        ok, oto.consonant = parse_double(_element_at_or_default(parts, 2))
        if not ok:
            oto.error = '%s\nFailed to parse consonant. Format is %s.' % (trace, fmt)
            return oto
        ok, oto.cutoff = parse_double(_element_at_or_default(parts, 3))
        if not ok:
            oto.error = '%s\nFailed to parse cutoff. Format is %s.' % (trace, fmt)
            return oto
        ok, oto.preutter = parse_double(_element_at_or_default(parts, 4))
        if not ok:
            oto.error = '%s\nFailed to parse preutter. Format is %s.' % (trace, fmt)
            return oto
        ok, oto.overlap = parse_double(_element_at_or_default(parts, 5))
        if not ok:
            oto.error = '%s\nFailed to parse overlap. Format is %s.' % (trace, fmt)
            return oto
        oto.is_valid = True
        return oto

    @staticmethod
    def add_alias_for_missing_files(oto_set: OtoSet) -> None:
        """对应 `AddAliasForMissingFiles(otoSet)`。

        ★ 注意造出来的条目 **`is_valid` 仍是 false**（C# 对象初始化器里没写），
        而 `ClassicSinger` 只收 `is_valid` 的条目 —— 照搬这个上游行为。
        """
        known_files = {oto.wav for oto in oto_set.otos if oto.is_valid}
        directory = os.path.dirname(oto_set.file)
        for path in _glob_wavs(directory):
            name = os.path.basename(path)
            if name not in known_files:
                oto = Oto(alias=_remove_extension(name), wav=name)
                oto.phonetic = oto.alias
                oto_set.otos.append(oto)

    @staticmethod
    def check_wav_exist(oto_set: OtoSet) -> None:
        """对应 `CheckWavExist(otoSet)`（用 Unicode NFC 归一化兜文件名差异）。"""
        groups: Dict[str, List[Oto]] = {}
        for oto in oto_set.otos:
            if oto.is_valid:
                groups.setdefault(oto.wav, []).append(oto)
        directory = os.path.dirname(oto_set.file)
        nfd_files: Dict[str, str] = {}
        for path in _glob_wavs(directory):
            name = os.path.basename(path)
            if not unicodedata.is_normalized('NFC', name):
                key = unicodedata.normalize('NFC', name)
                if key in nfd_files:
                    # C# 的 `ToDictionary` 遇重复键会抛 ArgumentException；
                    # 那会让上层 catch 掉整份 oto set（返回 null）。照搬这个结果。
                    raise ValueError('An item with the same key has already been added: %r' % key)
                nfd_files[key] = name
        for wav, group in groups.items():
            path = os.path.join(directory, wav)
            if not os.path.exists(path):
                if unicodedata.normalize('NFC', wav) in nfd_files:
                    fixed = nfd_files[unicodedata.normalize('NFC', wav)]
                    for oto in group:
                        oto.wav = fixed
                else:
                    logger.error('Sound file missing. %s', path)
                    for oto in group:
                        if _is_blank_or_empty(oto.error):
                            oto.error = 'Sound file missing. %s' % path
                        oto.is_valid = False

    @staticmethod
    def add_filename_alias(oto_set: OtoSet) -> None:
        """对应 `AddFilenameAlias(otoSet)`（`use_filename_as_alias` 为真时追加别名）。

        参考条目取该 wav **Offset 最小**的一条（C# `OrderBy(Offset).First()`，
        `OrderBy` 稳定 → 并列时取原顺序）。`file_trace` 是**共享**同一个对象
        （C# 直接赋引用），不是复制。
        """
        files: List[str] = []
        for oto in oto_set.otos:
            if oto.is_valid and oto.wav not in files:
                files.append(oto.wav)
        for wav in files:
            filename = _remove_extension(os.path.basename(wav))
            if not any(oto.alias == filename for oto in oto_set.otos):
                reference = min((o for o in oto_set.otos if o.wav == wav), key=lambda o: o.offset)
                oto_set.otos.append(Oto(
                    alias=filename,
                    phonetic=filename,
                    wav=wav,
                    offset=reference.offset,
                    consonant=reference.consonant,
                    cutoff=reference.cutoff,
                    preutter=reference.preutter,
                    overlap=reference.overlap,
                    is_valid=True,
                    error=reference.error,
                    file_trace=reference.file_trace,
                ))

    # ------------------------------------------------------------ 写回

    @staticmethod
    def write_oto_sets(voicebank: Voicebank) -> None:
        """对应 `WriteOtoSets(voicebank)`。"""
        for oto_set in voicebank.oto_sets:
            VoicebankLoader.write_oto_set(oto_set, oto_set.file, voicebank.text_file_encoding)
            logger.info('Write oto set %s', oto_set.name)

    @staticmethod
    def write_oto_set(oto_set: OtoSet, file_path: str, encoding_name: str) -> None:
        """对应 `WriteOtoSet(otoSet, stream, encoding)`。

        **无法解析的条目按 `file_trace.line` 原样写回**（配合 `parse_oto` 的早退分支，
        原始行不会在保存时丢失）。
        """
        with open(file_path, 'w', encoding=encoding_name, errors='replace',
                  newline='') as writer:
            for oto in oto_set.otos:
                if not oto.is_valid and oto.file_trace is not None:
                    writer.write(oto.file_trace.line or '')
                    writer.write('\n')
                    continue
                writer.write('%s=%s,%s,%s,%s,%s,%s' % (
                    oto.wav, oto.alias, _cs_double(oto.offset), _cs_double(oto.consonant),
                    _cs_double(oto.cutoff), _cs_double(oto.preutter), _cs_double(oto.overlap)))
                writer.write('\n')
            writer.flush()
