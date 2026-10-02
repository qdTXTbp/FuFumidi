# -*- coding: utf-8 -*-
"""歌手的抽象基类 —— 照搬 `OpenUtau.Core/Ustx/USinger.cs`（343 行）。

`USinger` 是「声库」在引擎里的门面：音素化器要它（`SetSinger` / `MapPhoneme`），
渲染器也要它（查 oto）。**具体实现（UTAU / DiffSinger / ENUNU…）是子类**，
本文件只搬基类与它自带的默认行为。

## 照搬时保留的语义
- 几乎所有成员都是 `virtual` 且**默认返回空/null** —— 基类本身"什么都没实现"，
  这是有意的：`TryGetOto` 默认返回 `(False, None)`，子类不覆盖就等于"查不到"。
- `TryGetMappedOto(phoneme, tone, ...)` 的默认实现**就是转调 `TryGetOto`**
  （即"不做音高映射"），两个重载都如此。
- `LocalizedName` 的回落链：`LocalizedNames` 为 null → 用 `Name`；
  取不到当前语言 → 用 `Name`；`Found == False` 时统一加 `[Missing] ` 前缀。
  语言取自 `SortingOrder`，为空则取 `Language`。
- `Equals` / `GetHashCode` **只比较 Id**（C# 注释说明：ustx 与偏好里只记 Id）。
- `CreateMissing(name)` 造出的实例 `found=False, loaded=False`，只有名字。

## 与 C# 的等价性差异
- `Preferences.Default`（全局单例，提供 SortingOrder / Language / FavoriteSingers）
  Python 侧没有全局设置单例，这里用一个可注入的轻量对象 `Preferences` 顶替，
  字段名与语义对齐；测试里可直接改它。这是**载体差异，不是行为差异**。
- `INotifyPropertyChanged` 事件链未搬（Python 无对应机制），
  只保留 `oto_dirty` 的取值与赋值语义。
"""

from typing import Any, Dict, List, Optional


class USingerType:
    """对应 USinger.cs 的 `[Flags] enum USingerType`（**数值**，不是字符串）。

    C# 原定义：Classic = 0x1, Enunu = 0x2, Vogen = 0x4, DiffSinger = 0x5, Voicevox = 0x6。
    注意它是 Flags 枚举且数值不连续（DiffSinger=0x5 同时含 0x1|0x4），照搬时不要"整理"成 0..n。
    """

    CLASSIC = 0x1
    ENUNU = 0x2
    VOGEN = 0x4
    DIFFSINGER = 0x5
    VOICEVOX = 0x6


# 对应 SingerTypeUtils.SingerTypeNames（枚举 → 渲染器/声库目录用的短名）
SINGER_TYPE_NAMES = {
    USingerType.CLASSIC: 'utau',
    USingerType.ENUNU: 'enunu',
    USingerType.DIFFSINGER: 'diffsinger',
    USingerType.VOICEVOX: 'voicevox',
}

# 对应 SingerTypeUtils.SingerTypeFromName（反向表）
SINGER_TYPE_FROM_NAME = {
    'utau': USingerType.CLASSIC,
    'enunu': USingerType.ENUNU,
    'diffsinger': USingerType.DIFFSINGER,
    'voicevox': USingerType.VOICEVOX,
}


class Preferences:
    """`Preferences.Default` 的替身（见模块 docstring 的等价性说明）。

    只保留 USinger 与 Renderers 用到的几项；字段名与 C# 对齐，便于逐项核对。
    （`Renderers.GetDefaultRenderer` 会读 `DefaultRenderer`，默认值是**空串**。）
    """

    sorting_order: Optional[str] = None
    language: Optional[str] = None
    favorite_singers: List[str] = []
    #: 对应 C# `Preferences.Default.DefaultRenderer`（默认 `string.Empty`）
    default_renderer: str = ''
    #: 对应 C# `Preferences.Default.NumRenderThreads`（默认 2，Classic 并行渲染用）
    num_render_threads: int = 2
    #: 对应 C# `Preferences.Default.LoadDeepFolderSinger`（**默认 true**）：
    #: `VoicebankLoader.SearchAll` 据此决定是递归找 character.txt 还是只看一级子目录。
    load_deep_folder_singer: bool = True


class USinger:
    """歌手基类（对应 C# `USinger`）。"""

    _empty_otos: List[Any] = []

    def __init__(self, name: str = ''):
        self._name = name
        self.found = False
        self.loaded = False
        self._oto_dirty = False

    # ---------------------------------------------------------------- 元信息（子类覆盖）
    @property
    def id(self) -> str:
        return ''

    @property
    def name(self) -> str:
        return self._name

    @property
    def localized_names(self) -> Optional[Dict[str, str]]:
        return None

    @property
    def search_terms(self) -> List[str]:
        return []

    @property
    def singer_type(self) -> int:
        return 0

    @property
    def base_path(self) -> str:
        return ''

    @property
    def author(self) -> str:
        return ''

    @property
    def voice(self) -> str:
        return ''

    @property
    def location(self) -> str:
        return ''

    @property
    def web(self) -> str:
        return ''

    @property
    def version(self) -> str:
        return ''

    @property
    def other_info(self) -> str:
        return ''

    @property
    def errors(self) -> List[str]:
        return []

    @property
    def avatar(self) -> str:
        return ''

    @property
    def avatar_data(self) -> Optional[bytes]:
        return None

    @property
    def portrait(self) -> str:
        return ''

    @property
    def portrait_opacity(self) -> float:
        return 0.0

    @property
    def portrait_height(self) -> int:
        return 0

    @property
    def sample(self) -> str:
        return ''

    @property
    def default_phonemizer(self) -> str:
        return ''

    @property
    def text_file_encoding(self) -> str:
        return 'utf-8'          # C# 默认 Encoding.UTF8

    @property
    def subbanks(self) -> List[Any]:
        return []

    @property
    def otos(self) -> List[Any]:
        return self._empty_otos

    # ---------------------------------------------------------------- 状态
    @property
    def has_found(self) -> bool:
        """对应 C# 的 `Found`（不叫 found 是为了不和字段本身重名）。"""
        return self.found

    @property
    def is_loaded(self) -> bool:
        """对应 C# 的 `Loaded => found && loaded`。"""
        return self.found and self.loaded

    @property
    def oto_dirty(self) -> bool:
        return self._oto_dirty

    @oto_dirty.setter
    def oto_dirty(self, value: bool):
        self._oto_dirty = value

    @property
    def is_favourite(self) -> bool:
        return self.id in Preferences.favorite_singers

    @is_favourite.setter
    def is_favourite(self, value: bool):
        if value:
            if self.id not in Preferences.favorite_singers:
                Preferences.favorite_singers.append(self.id)
        else:
            try:
                Preferences.favorite_singers.remove(self.id)
            except ValueError:
                pass

    @property
    def localized_name(self) -> str:
        """显示名：语言回落链见模块 docstring；`found=False` 时加 `[Missing] ` 前缀。"""
        names = self.localized_names
        if names is None:
            return self.name if self.found else '[Missing] %s' % self.name
        language = Preferences.sorting_order or Preferences.language
        if not language:
            return self.name if self.found else '[Missing] %s' % self.name
        localized = names.get(language)
        if localized is not None:
            return localized if self.found else '[Missing] %s' % localized
        return self.name if self.found else '[Missing] %s' % self.name

    # ---------------------------------------------------------------- 生命周期（子类覆盖）
    def ensure_loaded(self) -> None:
        pass

    def reload(self) -> None:
        pass

    def save(self) -> None:
        pass

    # ---------------------------------------------------------------- oto 查询
    def try_get_oto(self, phoneme: str):
        """返回 `(found, oto)`。基类默认查不到（对应 C# 的 `oto = default; return false;`）。"""
        return False, None

    def try_get_mapped_oto(self, phoneme: str, tone: int, color: Optional[str] = None):
        """默认实现**就是转调 try_get_oto**（即不做音高映射）。

        C# 有两个重载：`(phoneme, tone)` 与 `(phoneme, tone, color)`，二者默认都转调 `TryGetOto`。
        这里合并为一个（color 省略即为前者），语义一致。
        """
        return self.try_get_oto(phoneme)

    def get_suggestions(self, text: str, is_alias: bool) -> Dict[str, Any]:
        return {}

    def load_portrait(self) -> Optional[bytes]:
        return None

    def load_sample(self) -> Optional[bytes]:
        return None

    def free_memory(self) -> None:
        pass

    # ---------------------------------------------------------------- 其它
    def __str__(self):
        return self.localized_name

    def equals(self, other: Optional['USinger']) -> bool:
        """只比 Id（C# 注释：ustx 与偏好里只记 Id）。"""
        return other is not None and other.id == self.id

    def __hash__(self):
        return hash(self.id)

    @staticmethod
    def create_missing(name: str) -> 'USinger':
        s = USinger(name)
        s.found = False
        s.loaded = False
        return s
