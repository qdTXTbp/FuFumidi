# -*- coding: utf-8 -*-
r"""声库体检 —— **照搬** `OpenUtau.Core/Classic/VoicebankErrorChecker.cs`（338 行）。

装完一个 UTAU 声库之后跑一遍，把"哪儿不对"一次性列出来：`Errors`（要修）与
`Infos`（只是提醒）。用户装了声库却唱不出声，多半就是这里的某一条。

## ★ 照搬时保留的语义
1. **只报问题、不修**：`Check()` 收集完就结束，绝不写回 oto.ini。
2. ★ `CheckCaseMatchForFileReference(voicebank.BasePath, …)` 的文件列表里，
   上游写的是 **`"chatacter.txt"`** —— **这是上游的拼写错误**（应为 `character.txt`）。
   照搬：意味着 `character.txt` 的大小写其实**没被检查**。别"顺手修好"，那会让
   体检结果与上游不一致。
3. ★ 分级不同：
   | 情况 | 级别 |
   |---|---|
   | 采样率 ≠ 44100、位深 ≠ 16 | **Error** |
   | 声道数 ≠ 1（立体声） | **Info** |
   | 别名首尾有空格 / 中间多个空格 / 含全角空格 / 是 NFD | **Info** |
   | 文件名大小写与实际不符 | **Error** |
   | 忽略大小写后文件名重复 | **Error** |
4. ★ **别名以 `#Charset:` 开头的 oto 行直接跳过**（那是编码声明，不是条目），
   `file_trace.line` 为空也跳过。
5. `TryGetFileDuration` **带缓存**（`file_durations`）—— 同一个 wav 被多条 oto 引用时
   只量一次；但**缓存只在成功时写入**。
6. `CheckOto` 的十项检查**全部独立**，一项不合法不会短路后面的（用 `valid` 标记汇总）。
7. ★ `cutoff` 的计算：`oto.Cutoff < 0 ? oto.Offset - oto.Cutoff : fileDuration - oto.Cutoff`
   —— 负 cutoff 按"从 offset 往前"解释，正 cutoff 按"从文件末尾往前"解释。
8. `FindDuplication` **跨所有 oto set**，且只查**非空白**别名。
9. `CheckNFDFiles`：把同一条 wav 的所有 oto 归组，比较 `wav` 字段与该组**首条**
   `file_trace.line` 里 `=` 前的部分；不一致且 wav 名是 NFD → Error。

## ★ 载体差异
- C# 的 `Directory.GetFiles` / `ToLower()`（**当前区域**）→ Python 的 `os.listdir` +
  `unicodedata.normalize('NFD', …)`。C# 的 `IsNormalized()`（.NET 的 NFD 判定）→
  等价实现见 `_is_normalized`。
- C# 的 `MessageCustomizableException` / 通知 UI → 只产出 `VoicebankError` 数据，
  文案由调用方按 `message_key` 本地化。
- `Wave.OpenFile` → 用 `wave` 标准库读（`wave.py` 里已有一份等价实现）。
"""

import os
import unicodedata
import wave as _wave
from dataclasses import dataclass, field
from typing import Dict, List, Optional


from .voicebank_loader import CHAR_TXT, CHAR_YAML, VoicebankLoader
from ..oto import Oto, Voicebank


def _is_normalized(s: str) -> bool:
    """对应 .NET 的 `string.IsNormalized()`（默认 NFD）。

    ★ .NET 的 NFD 分解与 `unicodedata.normalize('NFD', …)` 在常用字符上一致；
      我们按"NFD 后与原串相同"来判定。
    """
    return unicodedata.normalize('NFD', s) == s


@dataclass
class VoicebankError:
    """对应 `VoicebankError`（`message_key` + 参数 + 出处）。"""

    message_key: str = ''
    strings: List[str] = field(default_factory=list)
    trace: Optional[object] = None
    sound_file: str = ''
    e: Optional[BaseException] = None


class _WaveInfo:
    """`Wave.OpenFile` 的等价物：只要时长与格式。"""

    def __init__(self, path: str):
        with _wave.open(path, 'rb') as w:
            self.sample_rate = w.getframerate()
            self.channels = w.getnchannels()
            self.bits_per_sample = w.getsampwidth() * 8
            self.total_ms = w.getnframes() * 1000.0 / float(w.getframerate())


class VoicebankErrorChecker:
    """对应 `VoicebankErrorChecker`。"""

    def __init__(self, path: str, base_path: str):
        self.path = path
        self.errors: List[VoicebankError] = []
        self.infos: List[VoicebankError] = []
        self.voicebank = Voicebank()
        self.voicebank.file = os.path.join(path, CHAR_TXT)
        self.voicebank.base_path = base_path
        self._file_durations: Dict[str, float] = {}

    # ---------------------------------------------------------------- 主流程

    def check(self) -> None:
        """对应 `Check()`。"""
        if not os.path.isfile(self.voicebank.file):
            self.errors.append(VoicebankError(message_key='singererror.txtnotfound'))
            return
        char_yaml = os.path.join(self.path, CHAR_YAML)
        if not os.path.isfile(char_yaml):
            self.infos.append(VoicebankError(message_key='singererror.yamlnotfound'))
        try:
            VoicebankLoader.load_voicebank(self.voicebank)
        except Exception as e:                                   # noqa: BLE001
            self.errors.append(VoicebankError(message_key='singererror.failedload', e=e))
            return

        for oto_set in self.voicebank.oto_sets:
            directory = os.path.join(self.path, os.path.dirname(oto_set.file))
            for oto in oto_set.otos:
                line = getattr(oto.file_trace, 'line', None)
                if not line or line.startswith('#Charset:'):
                    continue
                if not oto.is_valid:
                    self.errors.append(VoicebankError(
                        trace=oto.file_trace, message_key='singererror.invalidoto'))
                    continue
                file_path = os.path.join(directory, oto.wav)
                duration = self._try_get_file_duration(file_path, oto)
                if duration is None:
                    continue
                if duration <= 0:
                    self.errors.append(VoicebankError(
                        sound_file=file_path, message_key='singererror.invalidduration',
                        strings=[_cs_num(duration)]))
                    continue
                self._check_oto(oto, duration)
            self._check_nfd_files(oto_set)

        duplicates = self._find_duplication()
        if duplicates:
            message = ''
            for oto in duplicates:
                t = oto.file_trace
                message += '\n%s line %s: %s' % (getattr(t, 'file', ''),
                                                getattr(t, 'line_number', ''), oto.alias)
            self.errors.append(VoicebankError(
                message_key='singererror.duplicatealias', strings=[message]))

        for oto_set in self.voicebank.oto_sets:
            self._check_case_match_for_file_reference_set(oto_set)
            self._check_duplicated_name_ignoring_case(oto_set)
        # ★ 上游这里写的是 "chatacter.txt"（**拼写错误**），照搬。
        #   副作用：`character.txt` 的大小写其实没被检查。
        self._check_case_match_for_file_reference(
            self.voicebank.base_path,
            ['chatacter.txt', 'character.yaml', 'prefix.map'])

    # ---------------------------------------------------------------- 各项检查

    def _try_get_file_duration(self, file_path: str, oto: Oto) -> Optional[float]:
        """对应 `TryGetFileDuration(...)` → `(ok, duration)`（带缓存，缓存只在成功时写）。"""
        if file_path in self._file_durations:
            return self._file_durations[file_path]
        if not os.path.isfile(file_path):
            self.errors.append(VoicebankError(
                trace=oto.file_trace, sound_file=file_path,
                message_key='singererror.soundmissing'))
            return None
        try:
            info = _WaveInfo(file_path)
        except Exception as e:                                   # noqa: BLE001
            self.errors.append(VoicebankError(
                sound_file=file_path, message_key='singererror.soundnotopened', e=e))
            return None
        duration = info.total_ms
        if info.sample_rate != 44100:
            self.errors.append(VoicebankError(
                sound_file=file_path, message_key='singererror.samplerate'))
        if info.channels != 1:
            self.infos.append(VoicebankError(
                sound_file=file_path, message_key='singererror.mono'))
        if info.bits_per_sample != 16:
            self.errors.append(VoicebankError(
                sound_file=file_path, message_key='singererror.bitdepth'))
        self._file_durations[file_path] = duration
        return duration

    def _check_oto(self, oto: Oto, file_duration: float) -> bool:
        """对应 `CheckOto(oto, fileDuration)`：十项检查**互不短路**。"""
        valid = True

        def err(key):
            nonlocal valid
            valid = False
            self.errors.append(VoicebankError(trace=oto.file_trace, message_key=key))

        if oto.offset < 0:
            err('singererror.offsetshort')
        if oto.offset > file_duration:
            err('singererror.offsetoutofduration')
        if oto.preutter < 0:
            err('singererror.preuttershort')
        if oto.preutter + oto.offset > file_duration:
            err('singererror.preutteroutofduration')
        if oto.consonant < 0:
            err('singererror.consonantshort')
        if oto.consonant + oto.offset > file_duration:
            err('singererror.consonantoutofduration')
        if oto.overlap + oto.offset > file_duration:
            err('singererror.overlapoutofduration')

        # ★ 负 cutoff = "从 offset 往前数"；正 cutoff = "从文件末尾往前数"
        cutoff = oto.offset - oto.cutoff if oto.cutoff < 0 else file_duration - oto.cutoff
        if cutoff < oto.offset + oto.preutter:
            err('singererror.cutoffpreutter')
        if cutoff < oto.offset + oto.overlap:
            err('singererror.cutoffoverlap')
        if cutoff <= oto.offset + oto.consonant:
            err('singererror.cutoffconsonant')
        if cutoff > file_duration:
            err('singererror.cutoffoutofduration')

        if oto.alias.startswith(' ') or oto.alias.endswith(' '):
            self.infos.append(VoicebankError(
                trace=oto.file_trace, message_key='singererror.aliasstartwithspace'))
        elif oto.alias.count(' ') > 1:
            self.infos.append(VoicebankError(
                trace=oto.file_trace, message_key='singererror.aliasmultiplespaces'))
        if '　' in oto.alias:
            self.infos.append(VoicebankError(
                trace=oto.file_trace, message_key='singererror.aliasfullwidthspaces'))
        if not _is_normalized(oto.alias):
            self.infos.append(VoicebankError(
                trace=oto.file_trace, message_key='singererror.aliasisnfd'))
        return valid

    def _check_nfd_files(self, oto_set) -> None:
        """对应 `CheckNFDFiles`：同一条 wav 的 oto 归组，比对首条的文件名。"""
        groups: Dict[str, List[Oto]] = {}
        for oto in oto_set.otos:
            if oto.is_valid:
                groups.setdefault(oto.wav, []).append(oto)
        for wav, group in groups.items():
            first_line = getattr(group[0].file_trace, 'line', None)
            if first_line is None:
                continue
            declared = first_line.split('=')[0].strip()
            if wav != declared and not _is_normalized(wav):
                self.errors.append(VoicebankError(
                    sound_file=os.path.join(os.path.dirname(oto_set.file), wav),
                    message_key='singererror.wavisnfd'))

    def _find_duplication(self) -> List[Oto]:
        """对应 `FindDuplication`：跨所有 oto set 找重复别名（只查非空白）。"""
        by_alias: Dict[str, List[Oto]] = {}
        for oto_set in self.voicebank.oto_sets:
            for oto in oto_set.otos:
                if oto.alias and oto.alias.strip():
                    by_alias.setdefault(oto.alias, []).append(oto)
        return [oto for group in by_alias.values() if len(group) > 1 for oto in group]

    def _check_case_match_for_file_reference_set(self, oto_set) -> bool:
        """对应 `CheckCaseMatchForFileReference(OtoSet)`。"""
        folder = os.path.dirname(os.path.abspath(oto_set.file))
        names = [oto.wav for oto in oto_set.otos]
        names.append(oto_set.file)          # ★ oto.ini 自己也查
        return self._check_case_match_for_file_reference(folder, set(names))

    def _check_case_match_for_file_reference(self, folder: str,
                                             correct_file_names) -> bool:
        """对应 `CheckCaseMatchForFileReference(folder, names)`：文件存在但大小写不同 → Error。"""
        valid = True
        try:
            actual = os.listdir(folder)
        except OSError:
            return True
        lower_to_actual = {}
        for name in actual:
            lower_to_actual.setdefault(name.lower(), name)   # 照搬 ToDictionary 的"后者不覆盖"→取首个
        for file_name in correct_file_names:
            if not file_name or not file_name.strip():
                continue
            hit = lower_to_actual.get(file_name.lower())
            if hit is None:
                continue
            if hit != file_name:
                valid = False
                self.errors.append(VoicebankError(
                    message_key='singererror.wrongcase',
                    strings=[os.path.join(folder, file_name),
                             os.path.join(folder, hit)]))
        return valid

    def _check_duplicated_name_ignoring_case(self, oto_set) -> bool:
        """对应 `CheckDuplicatedNameIgnoringCase`：忽略大小写后重名 → Error。"""
        seen = []
        for oto in oto_set.otos:
            if oto.wav and oto.wav.strip() and oto.wav not in seen:
                seen.append(oto.wav)
        groups: Dict[str, List[str]] = {}
        for name in seen:
            groups.setdefault(name.lower(), []).append(name)
        bad = [g for g in groups.values() if len(g) > 1]
        for group in bad:
            self.errors.append(VoicebankError(
                message_key='singererror.duplicatename',
                strings=[oto_set.name, ', '.join('"%s"' % x for x in group)]))
        return not bad


def _cs_num(v: float) -> str:
    """按 C# 默认 `ToString()` 输出（`3.5` → `"3.5"`、`2` → `"2"`）。"""
    f = float(v)
    return str(int(f)) if f == int(f) else repr(f)
