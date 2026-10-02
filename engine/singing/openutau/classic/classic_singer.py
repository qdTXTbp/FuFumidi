# -*- coding: utf-8 -*-
"""UTAU 声库歌手 —— **照搬** `OpenUtau.Core/Classic/ClassicSinger.cs`（243 行）。

`USinger` 的具体实现：把 `Voicebank`（`character.txt` + `character.yaml` + 摊平的
`oto.ini`）变成可查询的 oto 表，并按**音色（prefix/suffix）** 与**音高**做映射。

## 照搬时保留的语义（别"整理"掉）
1. **`data` 是一次性发布的不可变快照**（C# 注释：`Load()` 的产物作为一个不可变单元发布，
   让别的线程永远看不到"半建好的 oto 表"）。所以 `Load()` 先在一份新 `OtoData` 上建完，
   最后**一次赋值** `data = d`。别改成"边建边往 self 里塞"。
2. `subbanks` 的排序是 `Prefix.Length + Suffix.Length` **降序**（长的优先匹配），
   然后**按 pattern 字符串分组**（同 prefix+suffix 的归一组）。
   `GroupBy` 保持"首次出现"的键顺序，组内保持源顺序。
3. 命中的正则组 1 **会写回原始 `Oto.Phonetic`**（`oto.Phonetic = m.Groups[1].Value`），
   然后再构造 `UOto` —— 顺序不能反，`UOto` 是在构造时把 `phonetic` 抄走的。
4. `otoMap` 在别名冲突时**保留先出现的那个**（`if (!ContainsKey) Add`），
   冲突分支在 C# 里是**空的**（注释掉了一行日志）。照搬。
5. `SearchTerms` 每条 oto 加两项：别名小写去空格；以及**日文罗马字**化后同样处理 ——
   后者包在 `try { } catch { }` 里（库抛错就只留第一项）。
6. `TryGetMappedOto(phoneme, tone, color)` 先按 **color + toneSet 命中**的 subbank
   拼 `prefix+phoneme+suffix` 查；查不到再退到"**空 color** 且 toneSet 命中"的
   subbank，最后退到裸别名。两处 `List.Find` 都是**取第一个**命中的。
7. `GetSuggestions`：`TryAdd` 语义 = 键已存在就不覆盖；非 alias 模式先按
   **拼音长度升序、再按字典序**重排，重排之后再继续加别名项。
8. `Save()` 直接访问 `oto_watcher`（可能为 None）—— C# 同样是 NRE 风险：
   `oto_watcher` 只在 `Reload()` 里创建，没加载过就 `Save()` 会崩。**照搬不修**。
9. `FreeMemory()` 里 `data = OtoData.Empty` 用的是**共享的那个空实例**，
   不是新建 —— 所以两个被释放的歌手会指向同一个空对象（只读，无碍）。

## 与 C# 的载体差异
- `WanaKanaNet.ToRomaji`（第三方日文罗马字库）：Python 侧做成**可注入钩子**
  （`set_romaji_converter`）。未注入时**跳过罗马字搜索词** —— 这与 C# 里
  "库调用抛异常被空 catch 吞掉"的**结果完全一致**，所以不是行为差异。
- `OtoWatcher` 的文件监视后端与 `SingerManager.Inst.ScheduleReload` 都是宿主能力，
  见 `oto_watcher.py` 的说明。
- `IDisposable` → `dispose()`（并额外支持 `with` 用法）。
- `volatile OtoData data`：Python 没有 `volatile`；这里靠"整体替换引用"达到同样的
  "读者要么看到旧的、要么看到新的"效果（CPython 的引用赋值是原子的）。
"""

import logging
import os
import re
import threading
from typing import Any, Callable, Dict, List, Optional, Tuple

from ..oto import UOto, UOtoSet, USubbank, Subbank, Voicebank
from ..singer import USinger
from .oto_watcher import OtoWatcher
from .voicebank_loader import VoicebankLoader

logger = logging.getLogger(__name__)

#: 日文罗马字转换钩子（对应 `WanaKanaNet.ToRomaji`）。
#: 未注入 → 跳过（等价于 C# 里那次调用抛错被 `catch {}` 吞掉）。
_ROMAJI_CONVERTER: Optional[Callable[[str], str]] = None


def set_romaji_converter(fn: Optional[Callable[[str], str]]) -> None:
    """注入罗马字转换器（宿主在启动时调；传 None 恢复为"跳过"）。"""
    global _ROMAJI_CONVERTER
    _ROMAJI_CONVERTER = fn


def _to_romaji(text: str) -> str:
    if _ROMAJI_CONVERTER is None:
        raise RuntimeError('未注入罗马字转换器（对应 C# 的 WanaKanaNet 缺失）')
    return _ROMAJI_CONVERTER(text)


class OtoData:
    """对应 `OtoData`（`Load()` 的产物，一次发布、只读使用）。"""

    __slots__ = ('oto_sets', 'subbanks', 'otos', 'oto_map', 'errors')

    def __init__(self):
        self.oto_sets: List[UOtoSet] = []
        self.subbanks: List[USubbank] = []
        self.otos: List[UOto] = []
        self.oto_map: Dict[str, UOto] = {}
        self.errors: List[str] = []


#: 对应 `OtoData.Empty`（**共享**的同一个空实例）
OTO_DATA_EMPTY = OtoData()


class ClassicSinger(USinger):
    """对应 `ClassicSinger`。"""

    def __init__(self, voicebank: Voicebank):
        super().__init__('')
        self.voicebank = voicebank
        # 对应 C# 构造函数里的 `found = true;`
        self.found = True
        # ★ 存到私有字段：基类把 `avatar_data` 定义成**只读 property**（无 setter），
        #   直接 `self.avatar_data = ...` 会抛 AttributeError。
        self._avatar_data: Optional[bytes] = None
        #: 对应 `volatile OtoData data = OtoData.Empty;`
        self.data = OTO_DATA_EMPTY
        self.oto_watcher: Optional[OtoWatcher] = None
        #: 对应 `Dictionary<string, IFrqFiles> Frqs`
        self.frqs: Dict[str, Any] = {}
        #: 对应 `public object SessionLock { get; } = new object();`
        #: ★ C# 是 `lock (SessionLock)`（= `Monitor`，**可重入**）→ 用 `RLock`。
        #:   与 `Renderers.get_cache_lock` 同一个坑（见移植文档陷阱 21）。
        self.session_lock = threading.RLock()

    # ------------------------------------------------------------------ 元信息（全部转发给 voicebank）

    @property
    def id(self) -> str:
        return self.voicebank.id

    @property
    def name(self) -> str:
        return self.voicebank.name

    @property
    def localized_names(self) -> Optional[Dict[str, str]]:
        return self.voicebank.localized_names

    @property
    def search_terms(self) -> List[str]:
        return self.voicebank.search_terms

    @property
    def singer_type(self) -> int:
        return self.voicebank.singer_type

    @property
    def base_path(self) -> str:
        return self.voicebank.base_path

    @property
    def author(self) -> str:
        return self.voicebank.author

    @property
    def voice(self) -> str:
        return self.voicebank.voice

    @property
    def location(self) -> str:
        """对应 `Path.GetDirectoryName(voicebank.File)`。"""
        return os.path.dirname(self.voicebank.file) if self.voicebank.file else ''

    @property
    def web(self) -> str:
        return self.voicebank.web

    @property
    def version(self) -> str:
        return self.voicebank.version

    @property
    def other_info(self) -> str:
        return self.voicebank.other_info

    @property
    def errors(self) -> List[str]:
        return self.data.errors

    @property
    def avatar_data(self) -> Optional[bytes]:
        """对应 `AvatarData => avatarData`（覆盖基类的只读属性）。"""
        return self._avatar_data

    @property
    def avatar(self) -> Optional[str]:
        if self.voicebank.image is None:
            return None
        return os.path.join(self.location, self.voicebank.image)

    @property
    def portrait(self) -> Optional[str]:
        if self.voicebank.portrait is None:
            return None
        return os.path.join(self.location, self.voicebank.portrait)

    @property
    def portrait_opacity(self) -> float:
        return self.voicebank.portrait_opacity

    @property
    def portrait_height(self) -> int:
        return self.voicebank.portrait_height

    @property
    def default_phonemizer(self) -> str:
        return self.voicebank.default_phonemizer

    @property
    def sample(self) -> Optional[str]:
        if self.voicebank.sample is None:
            return None
        return os.path.join(self.location, self.voicebank.sample)

    @property
    def text_file_encoding(self) -> str:
        return self.voicebank.text_file_encoding

    @property
    def subbanks(self) -> List[USubbank]:
        return self.data.subbanks

    @property
    def otos(self) -> List[UOto]:
        return self.data.otos

    @property
    def use_filename_as_alias(self) -> Optional[bool]:
        return self.voicebank.use_filename_as_alias

    @use_filename_as_alias.setter
    def use_filename_as_alias(self, value: Optional[bool]) -> None:
        self.voicebank.use_filename_as_alias = value

    # ------------------------------------------------------------------ 生命周期

    def ensure_loaded(self) -> None:
        """对应 `EnsureLoaded`：已加载就直接返回。"""
        if self.loaded:
            return
        self.reload()

    def reload(self) -> None:
        """对应 `Reload`：重载声库并**原子发布**新的 oto 数据。"""
        if not self.found:
            return
        try:
            self.voicebank.reload()
            self._load()
            self.loaded = True
            if self.oto_watcher is None:
                self.oto_watcher = OtoWatcher(self, self.location)
            self.oto_dirty = False
        except Exception as e:      # C# 只记日志、不抛
            logger.error('Failed to load %s: %s', self.voicebank.file, e)

    def _load(self) -> None:
        """对应私有的 `Load()`。"""
        # ---- 头像二进制（读不到就置 None，只记日志）
        avatar = self.avatar
        if avatar is not None and os.path.isfile(avatar):
            try:
                with open(avatar, 'rb') as f:
                    self._avatar_data = f.read()
            except Exception as e:
                self._avatar_data = None
                logger.error('Failed to load avatar data: %s', e)
        else:
            self._avatar_data = None
            logger.error("Avatar can't be found")

        d = OtoData()
        # 长的 prefix+suffix 优先；OrderByDescending 是**稳定**排序
        ordered = sorted(self.voicebank.subbanks,
                         key=lambda s: len(s.prefix) + len(s.suffix), reverse=True)
        d.subbanks.extend(USubbank(s) for s in ordered)

        # 按 pattern **分组**（同 prefix+suffix 合成一组）；键的首次出现顺序即分组顺序
        groups: Dict[str, List[USubbank]] = {}
        for subbank in d.subbanks:
            pattern = '^%s(.*)%s$' % (re.escape(subbank.prefix), re.escape(subbank.suffix))
            groups.setdefault(pattern, []).append(subbank)
        compiled = [(re.compile(p), members) for p, members in groups.items()]

        dummy = [USubbank(Subbank())]
        for oto_set in self.voicebank.oto_sets:
            u_set = UOtoSet(oto_set, self.voicebank.base_path)
            d.oto_sets.append(u_set)
            for oto in oto_set.otos:
                if not oto.is_valid:
                    if oto.error:
                        d.errors.append(oto.error)
                    continue
                u_oto = None
                for regex, members in compiled:
                    m = regex.search(oto.alias)
                    if m:
                        # ★ 先写回原始 Oto 的 phonetic，再构造 UOto（顺序不能反）
                        oto.phonetic = m.group(1)
                        u_oto = UOto(oto, u_set, members)
                        break
                if u_oto is None:
                    u_oto = UOto(oto, u_set, dummy)
                d.otos.append(u_oto)
                if oto.alias not in d.oto_map:
                    d.oto_map[oto.alias] = u_oto
                # else: C# 这里是一段被注释掉的日志（冲突时保留先出现的），照搬为空

        for oto in d.oto_map.values():
            oto.search_terms.append(oto.alias.lower().replace(' ', ''))
            try:
                oto.search_terms.append(
                    _to_romaji(oto.alias).lower().replace(' ', ''))
            except Exception:
                # C# 是 `try { } catch { }`：库抛错就只留第一项
                pass

        # 单次原子发布：读者要么看到旧的快照、要么看到这一个
        self.data = d

    def save(self) -> None:
        """对应 `Save()`：暂停 watcher → 写回所有 oto → 落盘 oto.ini。

        ★ `oto_watcher` 可能为 `None`（没加载过就保存）—— C# 同样会 NRE。照搬不修。
        """
        try:
            self.oto_watcher.paused = True
            for oto in self.otos:
                oto.write_back()
            VoicebankLoader.write_oto_sets(self.voicebank)
        finally:
            self.oto_watcher.paused = False

    def dispose(self) -> None:
        """对应 `Dispose()`。"""
        if self.oto_watcher is not None:
            self.oto_watcher.dispose()
        self.oto_watcher = None

    def free_memory(self) -> None:
        """对应 `FreeMemory()`：释放 oto 表并把 `loaded` 置回 false。"""
        logger.info('Freeing memory for singer %s', self.id)
        with self.session_lock:
            self.dispose()
            self.data = OTO_DATA_EMPTY      # ★ 是**共享**的空实例，不是新建
            self.loaded = False

    # ------------------------------------------------------------------ oto 查询

    def try_get_oto(self, phoneme: str):
        """对应 `TryGetOto`。返回 `(found, oto)`。"""
        oto = self.data.oto_map.get(phoneme)
        return (oto is not None), oto

    def try_get_mapped_oto(self, phoneme: str, tone: int,
                           color: Optional[str] = None):
        """对应两个重载：`(phoneme, tone)` 与 `(phoneme, tone, color)`。

        合并规则：给了 `color` 且非 None 走带音色的那条（C# 的 3 参重载），
        否则走 2 参重载。返回 `(found, oto)`。
        """
        if color is None:
            return self._try_get_mapped_oto(self.data, phoneme, tone)
        d = self.data
        subbank = next((s for s in d.subbanks
                        if s.color == color and tone in s.tone_set), None)
        if subbank is not None:
            oto = d.oto_map.get('%s%s%s' % (subbank.prefix, phoneme, subbank.suffix))
            if oto is not None:
                return True, oto
        return self._try_get_mapped_oto(d, phoneme, tone)

    @staticmethod
    def _try_get_mapped_oto(data: OtoData, phoneme: str, tone: int):
        """对应静态 `TryGetMappedOto(OtoData d, string phoneme, int tone, out UOto oto)`。

        先找**空 color** 且 `toneSet` 含该音高的 subbank（`List.Find` 取第一个）。
        """
        subbank = next((s for s in data.subbanks
                        if not s.color and tone in s.tone_set), None)
        if subbank is not None:
            oto = data.oto_map.get('%s%s%s' % (subbank.prefix, phoneme, subbank.suffix))
            if oto is not None:
                return True, oto
        oto = data.oto_map.get(phoneme)
        return (oto is not None), oto

    # ------------------------------------------------------------------ 编辑器

    def get_suggestions(self, text: str, is_alias: bool) -> Dict[str, UOto]:
        """对应 `GetSuggestions`。"""
        if text is not None:
            text = text.lower().replace(' ', '')
        all_otos = not text
        filtered = [oto for oto in self.data.oto_map.values()
                    if all_otos or any(text in term for term in oto.search_terms)]

        result: Dict[str, UOto] = {}
        if not is_alias:
            for oto in filtered:
                if oto.phonetic:
                    if oto.phonetic not in result:      # TryAdd
                        result[oto.phonetic] = oto
            # 先按键长升序，再按字典序 —— 然后**在重排后的 dict 上继续加别名**
            result = {k: result[k] for k in sorted(result, key=lambda k: (len(k), k))}
        for oto in filtered:
            if oto.alias:
                if oto.alias not in result:             # TryAdd
                    result[oto.alias] = oto
        return result

    def load_portrait(self) -> Optional[bytes]:
        """对应 `LoadPortrait()`。"""
        if not self.portrait:
            return None
        with open(self.portrait, 'rb') as f:
            return f.read()
