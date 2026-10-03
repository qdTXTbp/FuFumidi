# -*- coding: utf-8 -*-
"""声库源文件的临时缓存 —— **照搬** `OpenUtau.Core/Classic/VoicebankFiles.cs`（122 行）。

外部 resampler 需要的不只是"一个 wav 路径"，还需要**同一份素材旁边的一堆分析文件**
（`.frq` / `.llsm` / `.uspec` / `.dio` / …）。老 UTAU 的做法是"把它们复制到缓存目录、
名字对齐、再让 resampler 去读"，本类就负责这趟搬运，以及"素材本身要解码成 wav"。

## 照搬时保留的语义（别"整理"掉）
1. 缓存文件名是 `src-{singerId}-{oto.Set}-{oto.File}{ext}` 的**三段 XXH32** 十六进制
   （各 8 位小写、零填充）。`oto.Set` / `oto.File` 都参与哈希，所以同一个 wav 在不同
   oto 集合下会得到不同的缓存名。
2. ★ `GetMetaFiles` 里 `tempNoExt` 用的是 **source 的扩展名长度**去截 `sourceTemp`
   （`sourceTemp.Substring(0, sourceTemp.Length - ext.Length)`），而 `tempFrqExt` 用的是
   `tempExt` —— 一个文件里两种取法。两边扩展名通常都是 `.wav` 所以看不出问题，
   但这是上游原文，**照搬**。
3. `CopyOrStamp` 的 `required` 参数**两个调用点都传 false** —— 也就是说
   "源文件不存在"只会静默跳过（真正必须存在的是 `DecodeOrStamp`，它无条件抛）。
4. `DecodeOrStamp` 只对**扩展名恰好是 `.wav`** 的直接复制；其余一律走解码。
5. `ReleaseSourceTemp` 清的是缓存目录**顶层**、创建时间早于 **7 天**的**文件**
   （目录不动），且**没有 try/catch** —— 目录不存在会直接抛。
6. `GetFrqFile` / `GetMrqFile` 是静态工具：前者是"同名换 `_wav.frq`"，后者固定是
   同目录下的 `desc.mrq`。

## ★ 载体差异
- C# 是 `SingletonBase<VoicebankFiles>`（`VoicebankFiles.Inst`）。Python 侧用**可注入的
  模块级实例**：`get_voicebank_files()` / `set_voicebank_files(...)`。
- `PathManager.Inst.CachePath` → `resampler_item.host.cache_path`（函数内取）。
- 解码链折叠：C# 是 `Wave.OpenFile(...)` + NAudio 的 `WaveFileWriter.WriteWavFileToStream`
  （按素材自己的采样率写）；这里走项目既有的 `Wave.get_samples` + `Wave.write_mono16_wav`
  （44100 单声道 16 位）。**这一步只影响外部路径的临时输入**，自包含路径（Worldline）
  不经过它。
"""

import os
import shutil
import time
from typing import List, Optional, Tuple

from ..renderers import get_cache_lock
from ..wave import Wave
from .voicebank_loader import cs_get_extension


def _host():
    """取当前宿主（`PathManager.Inst` 的替身）。函数内导入避免包初始化成环。"""
    from . import resampler_item
    return resampler_item.host


def _hash_hex(s: str) -> str:
    """对应 `HashHex`：`XXH32.DigestOf(UTF8(s))` 的 8 位小写十六进制。"""
    from ..xxhash import digest_of32
    return '%08x' % digest_of32((s or '').encode('utf-8'))


class VoicebankFiles:
    """对应 `VoicebankFiles`。"""

    # ------------------------------------------------------------------ 路径

    def get_source_temp_path(self, singer_id: str, oto, ext: Optional[str] = None) -> str:
        """对应 `GetSourceTempPath`。"""
        if not ext:
            ext = cs_get_extension(getattr(oto, 'file', '') or '')
        cache_path = getattr(_host(), 'cache_path', '') or ''
        return os.path.join(cache_path, 'src-%s-%s-%s%s' % (
            _hash_hex(singer_id), _hash_hex(getattr(oto, 'oto_set', '') or ''),
            _hash_hex(getattr(oto, 'file', '') or ''), ext))

    @staticmethod
    def get_frq_file(source: str) -> str:
        """对应 `GetFrqFile`：`xxx.wav` → `xxx_wav.frq`。"""
        ext = cs_get_extension(source)
        no_ext = source[:len(source) - len(ext)]
        return no_ext + ext.replace('.', '_') + '.frq'

    @staticmethod
    def get_mrq_file(source: str) -> str:
        """对应 `GetMrqFile`：固定是同目录下的 `desc.mrq`。"""
        return os.path.join(os.path.dirname(source), 'desc.mrq')

    # ------------------------------------------------------------------ 元文件

    @staticmethod
    def get_meta_files(source: str, source_temp: str) -> List[Tuple[str, str]]:
        """对应 `GetMetaFiles`（13 对；上游原文里 `.lessaudio` 那对被注释掉了）。

        ★ `temp_no_ext` 用的是 **source 的 ext 长度**（见模块 docstring 第 2 条）。
        """
        ext = cs_get_extension(source)
        no_ext = source[:len(source) - len(ext)]
        frq_ext = ext.replace('.', '_') + '.frq'
        temp_ext = cs_get_extension(source_temp)
        temp_no_ext = source_temp[:len(source_temp) - len(ext)]
        temp_frq_ext = temp_ext.replace('.', '_') + '.frq'
        return [
            (no_ext + frq_ext, temp_no_ext + temp_frq_ext),
            (source + '.llsm', source_temp + '.llsm'),
            (source + '.uspec', source_temp + '.uspec'),
            (source + '.dio', source_temp + '.dio'),
            (source + '.star', source_temp + '.star'),
            (source + '.platinum', source_temp + '.platinum'),
            (source + '.frc', source_temp + '.frc'),
            (source + '.pmk', source_temp + '.pmk'),
            (source + '.vs4ufrq', source_temp + '.vs4ufrq'),
            (no_ext + '.rudb', temp_no_ext + '.rudb'),
            (no_ext + '.sc.npz', temp_no_ext + '.sc.npz'),
            (no_ext + '.sc', temp_no_ext + '.sc'),
            (no_ext + '.hifi.npz', temp_no_ext + '.hifi.npz'),
        ]

    # ------------------------------------------------------------------ 搬运

    def copy_source_temp(self, source: str, temp: str) -> None:
        """对应 `CopySourceTemp`：素材解码到缓存 + 元文件一并搬过去。"""
        with get_cache_lock(temp):
            self.decode_or_stamp(source, temp)
            for src, dst in self.get_meta_files(source, temp):
                self.copy_or_stamp(src, dst, False)

    def copy_back_meta_files(self, source: str, temp: str) -> None:
        """对应 `CopyBackMetaFiles`：**反向**搬（缓存 → 素材旁）。"""
        with get_cache_lock(temp):
            for src, dst in self.get_meta_files(source, temp):
                self.copy_or_stamp(dst, src, False)

    @staticmethod
    def copy_or_stamp(source: str, dest: str, required: bool) -> None:
        """对应 `CopyOrStamp`：源不存在时只有 `required` 才抛。"""
        if not os.path.isfile(source):
            if required:
                raise FileNotFoundError('Source file %s not found' % source)
        elif not os.path.isfile(dest):
            shutil.copyfile(source, dest)

    @staticmethod
    def decode_or_stamp(source: str, dest: str) -> None:
        """对应 `DecodeOrStamp`：`.wav` 直接复制，其余解码成 wav。"""
        if not os.path.isfile(source):
            raise FileNotFoundError('Source file %s not found' % source)
        if os.path.isfile(dest):
            return
        if cs_get_extension(source) == '.wav':
            shutil.copyfile(source, dest)
            return
        samples = Wave.get_samples(source)
        Wave.write_mono16_wav(dest, samples)

    # ------------------------------------------------------------------ 清理

    def release_source_temp(self) -> None:
        """对应 `ReleaseSourceTemp`：清掉缓存目录里超过 7 天的文件（目录不动）。"""
        expire = time.time() - 7 * 24 * 60 * 60
        path = getattr(_host(), 'cache_path', '') or ''
        for name in os.listdir(path):
            full = os.path.join(path, name)
            if not os.path.isfile(full):
                continue
            try:
                if os.path.getctime(full) < expire:
                    os.remove(full)
            except OSError:
                pass


#: 模块级实例（对应 C# 的 `VoicebankFiles.Inst`，但**可注入**）
_default: Optional[VoicebankFiles] = None


def get_voicebank_files() -> VoicebankFiles:
    """对应 `VoicebankFiles.Inst`（惰性创建）。"""
    global _default
    if _default is None:
        _default = VoicebankFiles()
    return _default


def set_voicebank_files(files: Optional[VoicebankFiles]) -> None:
    """替换/清空模块级实例（测试与宿主注入用）。"""
    global _default
    _default = files
