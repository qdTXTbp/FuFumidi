# -*- coding: utf-8 -*-
r"""UTAU 旧插件（外部 exe/bat）体系 —— **照搬** `OpenUtau.Core/Classic/` 下 5 个文件：

| C# | 行 | Python |
|---|---|---|
| `IPlugin.cs` | 8 | `IPlugin`（协议） |
| `Plugin.cs` | 44 | `Plugin` |
| `PluginLoader.cs` | 70 | `PluginLoader` |
| `PluginRunner.cs` | 105 | `PluginRunner` |
| `ExeInstaller.cs` | 25 | `ExeType` / `ExeInstaller` |

UTAU 的"插件"其实是**最老的那种外部编辑器**：它读一份 `.ust` 风格的临时文件
（`Ust.WritePlugin` 写、`Ust.ParsePlugin` 读），改完退出。我们靠**前后哈希比对**
判断它到底改没改。

## ★ 照搬时保留的语义
1. ★ **`Array.ForEach(s, temp => temp.Trim())` 是上游的无效代码** —— 字符串不可变，
   `Trim()` 的返回值被丢弃，所以 `s[0]` / `s[1]` **并没有被 trim**。
   照搬（**不要**"修好"它）：于是 `name = Foo`（等号后有空格）这种写法会因为
   键名变成 `"name "` 而匹配不上，最终报 "Failed to load"。这是真实兼容行为。
2. 键名走 `ToLowerInvariant()`，值**不**转小写。
3. `name` 的正则 `(.+)\(&([A-Za-z0-9])\)`：命中则 `shortcut` = 字母、
   `name` = 原名 + `" (X)"`（**名字里会多出这个后缀**）。
4. `execute` 的值若以 `.\` 开头**去掉前两字符**，再与 `plugin.txt` **所在目录**拼接。
5. `name` 或 `executable` 任一为空（`IsNullOrWhiteSpace`）→ 抛 `FileFormatException`。
6. ★ **`Plugin.Run` 的 Wine 分支**：非 Windows + 配了 wine 路径 + 扩展名是
   `.exe`/`.bat` 时，用 wine 启动并注入 `LANG=ja_JP.utf8`（.NET 的
   `ProcessStartInfo.Environment` 是**追加**语义，不是替换环境）。
7. ★ **`PluginRunner` 靠 MD5 前后比对**决定要不要回读：哈希相同（或任一为 None）
   → 记 "has not changed" 并**直接返回**，不回读。
8. `PluginRunner.Execute` 的 `first`/`last` 任一为 None → **静默返回**（不报错）。

## ★ 载体差异
- C# 的 `Preferences.Default.WinePath` / `PathManager.Inst.*` / `DocManager.Inst.*`
  → 走 `ClassicHost`（`resampler_item.host`）与**可注入的回调**；`DocManager` 的
  通知（`SingersChangedNotification` / `ProgressBarNotification`）在引擎侧没有 UI 通道，
  改成返回 `(file_name, dest_path)` 让调用方去发通知。
- `async/await` → 同步 `subprocess.run`（引擎侧本来就是串行跑的）。
"""

import hashlib
import os
import re
import subprocess
from dataclasses import dataclass, field
from typing import Callable, List, Optional

class ExeType:
    """对应 `enum ExeType { resampler, wavtool }`（枚举值与成员同名，全小写）。"""

    resampler = 'resampler'
    wavtool = 'wavtool'


#: 模块级便捷别名（照搬 C# 里 `ExeType.wavtool` 的用法，同时方便测试）
RESAMPLER = ExeType.resampler
WAVTOOL = ExeType.wavtool


class FileFormatError(Exception):
    """对应 `System.IO.FileFormatException`。"""


class FileNotFoundError_(Exception):
    """对应 `System.IO.FileNotFoundException`（不叫内置的 FileNotFoundError 以免混淆）。"""


class IPlugin:
    """对应 `interface IPlugin`：插件协议。

    C# 是 `interface`（只有 `Encoding` 属性与 `Run(tempFile)`），
    Python 侧用**基类**表达（鸭子类型其实也够，但基类能让缺方法时早失败）。
    """

    @property
    def encoding(self) -> str:
        raise NotImplementedError

    def run(self, temp_file: str) -> None:
        raise NotImplementedError


@dataclass
class Plugin(IPlugin):
    """对应 `Plugin : IPlugin`（`plugin.txt` 里的一条配置）。"""

    name: str = ''
    executable: str = ''
    all_notes: bool = False
    use_shell: bool = False
    shortcut: str = ''
    _encoding: str = 'shift_jis'

    @property
    def encoding(self) -> str:
        """对应 `Encoding { get => encoding; set => encoding = value; }`（默认 shift_jis）。"""
        return self._encoding

    @encoding.setter
    def encoding(self, value: str) -> None:
        self._encoding = value

    def __str__(self) -> str:
        """对应 `ToString() => Name`。"""
        return self.name

    def run(self, temp_file: str) -> None:
        """对应 `Run(tempFile)`：启动外部程序并**等它退出**。"""
        if not os.path.isfile(self.executable):
            raise FileNotFoundError_('Executable %s not found.' % self.executable)
        from . import resampler_item
        wine_path = getattr(resampler_item.host, 'wine_path', '') or ''
        ext = os.path.splitext(self.executable)[1].lower()
        use_wine = (os.name != 'nt' and wine_path
                    and ext in ('.exe', '.bat'))
        cwd = os.path.dirname(self.executable)
        # ★ 上游写的是 `Arguments = $"\"{tempFile}\""` —— 那对引号是 **Windows 命令行的
        #   参数转义约定**（拼给 cmd.exe 的整串），不是"参数里含引号"。
        #   Python 的 subprocess 自己会做引号转义，所以这里传**裸路径**；
        #   若照抄那对引号，路径里会多出字面量引号，cmd 直接报
        #   「文件名、目录名或卷标语法不正确」（实测踩过）。
        if use_wine:
            env = dict(os.environ)
            env['LANG'] = 'ja_JP.utf8'          # ★ .NET 是追加语义，不是替换整个环境
            subprocess.run([wine_path, self.executable, temp_file],
                           cwd=cwd, env=env, check=True)
        else:
            # C# 的 UseShellExecute=true 在 Python 侧没有等价物；Windows 上直接
            # 调 CreateProcess，行为与 shell=false 相同，这里保持一致。
            subprocess.run([self.executable, temp_file], cwd=cwd, check=True)


class PluginLoader:
    """对应 `class PluginLoader`（`LoadAll` + 私有的 `ParsePluginTxt`）。"""

    #: 对应 `Regex("(.+)\\(&([A-Za-z0-9])\\)")`
    NAME_SHORTCUT_RE = re.compile(r'(.+)\(&([A-Za-z0-9])\)')

    @staticmethod
    def load_all(base_path: str) -> List[Plugin]:
        """对应 `LoadAll(basePath)`：**递归**找所有 `plugin.txt` 并解析。"""
        os.makedirs(base_path, exist_ok=True)
        out: List[Plugin] = []
        for root, _dirs, files in os.walk(base_path):
            for name in files:
                if name == 'plugin.txt':
                    out.append(PluginLoader.parse_plugin_txt(os.path.join(root, name)))
        return out

    @staticmethod
    def parse_plugin_txt(file_path: str) -> Plugin:
        """对应 `ParsePluginTxt(filePath, encoding)`（编码固定 shift_jis）。

        ★ 注意 `Array.ForEach(s, temp => temp.Trim())` 在上游是**无效代码**
          （字符串不可变，返回值被丢弃）—— 所以这里**故意不 trim**。照搬。
        """
        with open(file_path, 'r', encoding='shift_jis', errors='replace',
                  newline=None) as f:
            plugin = Plugin()
            other_lines: List[str] = []
            for raw in f:
                line = raw.rstrip('\r\n')
                s = line.split('=')
                if len(s) != 2:
                    s = line.split(':')
                if len(s) == 2:
                    key = s[0].lower()                 # 对应 ToLowerInvariant()
                    if key == 'name':
                        m = PluginLoader.NAME_SHORTCUT_RE.search(s[1])
                        if m:
                            plugin.shortcut = m.group(2)
                            plugin.name = m.group(1) + ' (' + plugin.shortcut + ')'
                        else:
                            plugin.name = s[1]
                    elif key == 'execute':
                        execute = s[1]
                        if execute.startswith('.\\'):
                            execute = execute[2:]
                        plugin.executable = os.path.join(
                            os.path.dirname(file_path), execute)
                    elif key == 'notes' and s[1] == 'all':
                        plugin.all_notes = True
                    elif key == 'shell' and s[1] == 'use':
                        plugin.use_shell = True
                    elif key == 'encoding':
                        plugin.encoding = s[1]
                    else:
                        other_lines.append(line)
                else:
                    other_lines.append(line)
            # ★ 上游的 other_lines 收集了但**从未使用**（死代码），照搬保留
            _ = other_lines
            if not plugin.name.strip() or not plugin.executable.strip():
                raise FileFormatError(
                    'Failed to load %s using encoding shift_jis' % file_path)
            return plugin


@dataclass
class ReplaceNoteEventArgs:
    """对应嵌套类 `ReplaceNoteEventArgs`。"""

    part: object
    to_remove: List[object] = field(default_factory=list)
    to_add: List[object] = field(default_factory=list)


@dataclass
class PluginErrorEventArgs:
    """对应嵌套类 `PluginErrorEventArgs`。"""

    message: str = ''
    exception: Optional[BaseException] = None


class PluginRunner:
    """对应 `PluginRunner`：写临时文件 → 跑插件 → 比对哈希 → 回读 diff。"""

    def __init__(self, cache_path: str,
                 on_replace_note: Optional[Callable[[ReplaceNoteEventArgs], None]] = None,
                 on_error: Optional[Callable[[PluginErrorEventArgs], None]] = None):
        self.cache_path = cache_path
        self.on_replace_note = on_replace_note
        self.on_error = on_error

    @staticmethod
    def from_host(on_replace_note=None, on_error=None) -> 'PluginRunner':
        """对应 `static PluginRunner from(PathManager, DocManager)`。

        C# 里 `DocManager` 那一半是"撤销组 + 移除/新增音符命令"与"错误通知"；
        引擎侧没有命令栈与 UI，所以交给调用方注入两个回调。
        """
        from . import resampler_item
        return PluginRunner(getattr(resampler_item.host, 'cache_path', '') or '',
                            on_replace_note, on_error)

    def execute(self, project, part, first, last, plugin: IPlugin) -> None:
        """对应 `Execute(project, part, first, last, plugin)`。"""
        if first is None or last is None:
            return                                   # ★ 静默返回，不报错
        from . import ust
        try:
            os.makedirs(self.cache_path, exist_ok=True)
            temp_file = os.path.join(self.cache_path, 'temp.tmp')
            sequence = ust.write_plugin(project, part, first, last, temp_file,
                                        encoding=plugin.encoding)
            before_hash = self.hash_file(temp_file)
            plugin.run(temp_file)
            after_hash = self.hash_file(temp_file)
            if before_hash is None or after_hash is None or before_hash == after_hash:
                return                               # ★ 没改动 → 不回读
            to_remove, to_add = ust.parse_plugin(
                project, part, first, last, sequence, temp_file,
                encoding=plugin.encoding)
            if self.on_replace_note:
                self.on_replace_note(ReplaceNoteEventArgs(part, to_remove, to_add))
        except Exception as e:                       # noqa: BLE001
            if self.on_error:
                self.on_error(PluginErrorEventArgs('Failed to execute plugin', e))
            else:
                raise

    @staticmethod
    def hash_file(file_path: str) -> Optional[bytes]:
        """对应 `HashFile`：MD5 整文件；文件读不到就返回 None（对应 C# 的可空 byte[]）。"""
        try:
            with open(file_path, 'rb') as f:
                return hashlib.md5(f.read()).digest()
        except OSError:
            return None


class ExeInstaller:
    """对应 `ExeInstaller.Install`（把外部 resampler/wavtool 装进工具目录）。"""

    @staticmethod
    def install(file_path: str, exe_type: str):
        """对应 `Install(filePath, exeType)` → 返回 `(file_name, dest_path)`。

        ★ C# 装完会往 `DocManager` 发"歌手列表变了"+"进度条"两条通知；
          引擎侧没有这条通道，所以**只做拷贝**并把结果交回给调用方去发通知。
        """
        from . import resampler_item
        file_name = os.path.basename(file_path)
        dest_path = (getattr(resampler_item.host, 'wavtools_path', '')
                     if exe_type == WAVTOOL
                     else getattr(resampler_item.host, 'resamplers_path', ''))
        os.makedirs(dest_path, exist_ok=True)
        dest_name = os.path.join(dest_path, file_name)
        import shutil
        shutil.copyfile(file_path, dest_name)        # C# 的 File.Copy(…, true) = 覆盖
        return file_name, dest_path