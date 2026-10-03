# -*- coding: utf-8 -*-
r"""路径管理 —— **照搬** `OpenUtau.Core/Util/PathManager.cs`。

## 为什么需要

上游所有跟"往哪写文件"有关的代码都问 `PathManager.Inst`：
缓存（`ds-*.wav` / `*.tensorcache`）、依赖（声码器 / 通用组件）、日志、偏好。
我们这边这些是**散落的字符串拼接**（`diffsinger/pipeline.py` 里的
`FUFUMIDI_CACHE_DIR` 或 `tempfile`），导致：

* 缓存位置随环境变量/临时目录变 → 换次运行就重算一遍
* 没法和上游共享缓存目录

## ★ 三平台策略（照搬 :16-72）
| 平台 | DataPath | CachePath | HomePathIsAscii |
|---|---|---|---|
| macOS | `~/Library/OpenUtau` | `~/Library/Caches/OpenUtau` | **恒 true**（:22） |
| Linux | `$XDG_DATA_HOME/OpenUtau`（缺省 `~/.local/share`） | `$XDG_CACHE_HOME/OpenUtau`（缺省 `~/.cache`） | **恒 true**（:42） |
| Windows | 便携：appDir；已安装：`%USERPROFILE%\OpenUtau`（靠 `installed.txt` 判定，:53-59） | `DataPath/Cache` | ★ **实测**（:61-69） |

★ 只有 Windows 分支会算 `HomePathIsAscii`（用 `StringInfo.GetTextElementEnumerator`
逐字素判断，`s.Length != 1 || s[0] >= 128` 就判 false）—— macOS/Linux 恒 true。
用途见 `PathManager` 消费者：非 ASCII 路径下部分原生库会出问题。
"""

import os
import sys
from dataclasses import dataclass
from typing import List, Optional

#: 覆盖检测用（对应 `File.Exists(appDir/installed.txt)`，:54）
_INSTALLED_MARKER = 'installed.txt'


def _is_macos() -> bool:
    return sys.platform == 'darwin'


def _is_linux() -> bool:
    return sys.platform.startswith('linux')


def _home_path_is_ascii(data_path: str) -> bool:
    """对应 :61-69 的 Windows 分支（只有它会算；macOS/Linux 恒 true）。

    ★ 判据是"逐**字素**（grapheme）"，`s.Length != 1 || s[0] >= 128` 即非 ASCII。
      Python 的 `str` 是 Unicode 标量序列，没有 C# 的字素簇概念；
      对路径这个场景（不含 emoji 组合字符）用码点判断是等价的。
    """
    for ch in data_path:
        if ord(ch) >= 128:
            return False
    return True


@dataclass
class PathManager:
    """`PathManager` 的 Python 等价物（不是单例 —— 便于测试注入）。"""

    root_path: str
    data_path: str
    cache_path: str
    home_path_is_ascii: bool = True
    is_installed: bool = False
    app_image_path: Optional[str] = None
    is_app_image: bool = False

    # ------------------------------------------------------------------ 构造

    @classmethod
    def detect(cls, app_dir: Optional[str] = None,
               home: Optional[str] = None) -> 'PathManager':
        """照搬 :16-72 的三分支。`app_dir` 缺省用本文件的上级目录。"""
        if app_dir is None:
            app_dir = os.path.dirname(os.path.dirname(os.path.dirname(
                os.path.abspath(__file__))))
        app_dir = os.path.normpath(app_dir)
        if home is None:
            home = os.path.expanduser('~')

        if _is_macos():
            return cls(root_path=app_dir,
                       data_path=os.path.join(home, 'Library', 'OpenUtau'),
                       cache_path=os.path.join(home, 'Library', 'Caches', 'OpenUtau'),
                       home_path_is_ascii=True)      # :21-22
        if _is_linux():
            data_home = os.environ.get('XDG_DATA_HOME') or \
                os.path.join(home, '.local', 'share')
            cache_home = os.environ.get('XDG_CACHE_HOME') or \
                os.path.join(home, '.cache')
            app_image = os.environ.get('APPIMAGE') or ''
            is_app_image = bool(app_image) and os.path.isfile(app_image) and \
                os.environ.get('IS_OPENUTAU_APPIMAGE') == 'true'
            return cls(root_path=app_dir,
                       data_path=os.path.join(data_home, 'OpenUtau'),
                       cache_path=os.path.join(cache_home, 'OpenUtau'),
                       home_path_is_ascii=True,      # :42
                       app_image_path=app_image or None,
                       is_app_image=is_app_image)
        # Windows / 便携模式
        is_installed = os.path.isfile(os.path.join(app_dir, _INSTALLED_MARKER))
        data_path = os.path.join(home, 'OpenUtau') if is_installed else app_dir
        return cls(root_path=app_dir,
                   data_path=data_path,
                   cache_path=os.path.join(data_path, 'Cache'),
                   home_path_is_ascii=_home_path_is_ascii(data_path),
                   is_installed=is_installed)

    # ------------------------------------------------------------- 派生路径

    @property
    def singers_path_old(self) -> str:
        """`:80`"""
        return os.path.join(self.data_path, 'Content', 'Singers')

    @property
    def singers_path(self) -> str:
        """`:81`"""
        return os.path.join(self.data_path, 'Singers')

    @property
    def resamplers_path(self) -> str:
        """`:87`"""
        return os.path.join(self.data_path, 'Resamplers')

    @property
    def wavtools_path(self) -> str:
        """`:88`"""
        return os.path.join(self.data_path, 'Wavtools')

    @property
    def dependency_path(self) -> str:
        """`:89` —— 通用组件位（声码器 / 通用 NSF-HiFiGAN 放这儿）"""
        return os.path.join(self.data_path, 'Dependencies')

    @property
    def plugins_path(self) -> str:
        """`:90`"""
        return os.path.join(self.data_path, 'Plugins')

    @property
    def dictionaries_path(self) -> str:
        """`:91`"""
        return os.path.join(self.data_path, 'Dictionaries')

    @property
    def templates_path(self) -> str:
        """`:92`"""
        return os.path.join(self.data_path, 'Templates')

    @property
    def logs_path(self) -> str:
        """`:93`"""
        return os.path.join(self.data_path, 'Logs')

    @property
    def log_file_path(self) -> str:
        """`:94`"""
        return os.path.join(self.logs_path, 'log.txt')

    @property
    def prefs_file_path(self) -> str:
        """`:95`"""
        return os.path.join(self.data_path, 'prefs.json')

    @property
    def themes_path(self) -> str:
        """`:96`"""
        return os.path.join(self.data_path, 'Themes')

    def ensure_cache_dirs(self) -> str:
        """建好缓存根目录并返回（上游在 `OpenUtau()` 里做，这里做成显式调用）。"""
        os.makedirs(self.cache_path, exist_ok=True)
        return self.cache_path

    def sing_path(self, *parts: str) -> str:
        return os.path.join(self.singers_path, *parts)

    def as_dict(self) -> dict:
        return {
            'rootPath': self.root_path, 'dataPath': self.data_path,
            'cachePath': self.cache_path,
            'homePathIsAscii': self.home_path_is_ascii,
            'isInstalled': self.is_installed,
            'isAppImage': self.is_app_image,
            'singersPath': self.singers_path,
            'dependencyPath': self.dependency_path,
            'logsPath': self.logs_path,
        }


_DEFAULT: Optional[PathManager] = None


def get_path_manager() -> PathManager:
    """进程级默认实例（照搬 `PathManager.Inst` 的单例语义）。"""
    global _DEFAULT
    if _DEFAULT is None:
        _DEFAULT = PathManager.detect()
    return _DEFAULT
