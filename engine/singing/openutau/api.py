# -*- coding: utf-8 -*-
r"""音素化器注册表 —— **照搬** `OpenUtau.Core/Api/PhonemizerFactory.cs`（69 行）。

编辑器与宿主靠它「按名字/类型找到并实例化音素化器」。上游靠 **.NET 反射 + 自定义特性**：

```csharp
var attr = type.GetCustomAttribute<PhonemizerAttribute>();
if (attr == null || string.IsNullOrEmpty(attr.Name) || string.IsNullOrEmpty(attr.Tag)) return null;
```

## ★ 载体差异（本文件最需要说明的一处）
Python 没有反射取特性，所以把 `PhonemizerAttribute` 的四个字段
（`Name` / `Tag` / `Author` / `Language`）**映射成类属性** `name` / `tag` / `author` /
`language` —— 本仓库已搬的 16 个音素化器（`openutau/plugin_builtin/*.py`）就是这么声明的：

```python
@register
class CantoneseCVVCPhonemizer(ChineseCVVCPhonemizer):
    name = 'Cantonese CVVC Phonemizer'
    tag = 'ZH-YUE CVVC'
    author = 'Lotte V'
    language = 'ZH-YUE'
```

★ 所以 `get(cls)` 里的「读特性」变成 `getattr(cls, ...)`，判定条件
  （`name`/`tag` 任一为空就返回 `None`）照搬不变。

★ 注意 `phonemizer.py` 里另有��个 `_REGISTRY` + `@register` 装饰器（按 `tag` 索引）。
  那是**本仓库早期**为了让音素化器能被按 tag 查到而加的，与 C# 的
  `PhonemizerFactory`（**按类索引** + 有序列表）不是同一套东西。两者并存不冲突：
  `@register` 服务运行期快速按 tag 查，`PhonemizerFactory` 服务编辑器列举与
  `default_phonemizer`（存的是**类型全名**）反查。移植时保留两套，不合并。

## ★ 照搬的行为细节
1. `create()` 造实例后只设 `Name` / `Tag` / `Language` —— ★ **`Author` 不设**
   （它只用于 `to_string` 的展示文案）。照搬。
2. `get(cls)`：命中缓存直接返回；否则读特性，`name`/`tag` 任一为空 → **返回 None**。
   ★ 上游最后是 `factories.GetOrAdd(type, factory)` —— **缓存命中时也会先构造一个
     factory 再丢掉**（`GetOrAdd` 的 valueFactory 是急切求值的）。这是上游的小浪费，
     照搬的写法在 Python 里等价于"先构造再查字典"，无副作用，保留即可。
3. `get_by_type_name()`：在**已缓存**的工厂里线性比对 `type.FullName`。C# 的
   `Type.FullName` 对应 Python 的 `cls.__module__ + '.' + cls.__qualname__`。
4. `build_list()`：`OrderBy(f => f.tag)` —— ★ .NET 的 `OrderBy` 是**稳定**排序，
   所以 tag 相同的工厂保持 `factories` 的枚举顺序。Python 的 `sorted` 同样稳定
   （且 `factories` 是 `dict`，保持插入序），行为一致。
5. `get_all()` 返回 `build_list()` 排好序的数组；**没调 `build_list()` 时是空数组**
   （C# 初始化为 `[]`），不是 `None`。
6. `PhonemizerTypeValues.get_values()`：`GetAll() ?? 空` → `(type.FullName ?? type.Name, to_string())`
   的列表，供编辑器给 `default_phonemizer` 提供下拉候选。
"""

from typing import Dict, List, Optional


def _type_full_name(cls: type) -> str:
    """对应 .NET 的 `Type.FullName`：`命名空间.类名`（嵌套类用 `+`）。

    Python 用 `模块.限定名`；嵌套类 C# 是 `Outer+Inner`，这里用 `.`（本仓库无同名嵌套，
    且 `default_phonemizer` 存的是这个字符串，改分隔符会破坏已有配置的兼容）。
    """
    return '%s.%s' % (cls.__module__, cls.__qualname__)


class PhonemizerFactory:
    """对应 `PhonemizerFactory`（一个具体音素化器类型的注册条目）。"""

    def __init__(self, type_: type, name: str = '', tag: str = '', author: str = '',
                 language: str = ''):
        # C# 字段名是 `type`，但那是 Python 内建函数的同名词；用 type_ 存、type 属性对外
        self.type = type_
        self.name = name
        self.tag = tag
        self.author = author
        self.language = language

    def create(self):
        """对应 `Create()`：造实例并设好 `Name` / `Tag` / `Language`。

        ★ **`Author` 不设**（上游如此）—— 它只用于 `__str__` 的展示文案。
        """
        phonemizer = self.type()
        phonemizer.name = self.name
        phonemizer.tag = self.tag
        phonemizer.language = self.language
        return phonemizer

    def __str__(self) -> str:
        """对应 `ToString()`：有 author 就加 "(Contributed by …)"。"""
        if not self.author:
            return '[%s] %s' % (self.tag, self.name)
        return '[%s] %s (Contributed by %s)' % (self.tag, self.name, self.author)

    # ---------------------------------------------------------------- 静态注册表

    #: 对应 `static ConcurrentDictionary<Type, PhonemizerFactory> factories`
    _factories: Dict[type, 'PhonemizerFactory'] = {}
    #: 对应 `static PhonemizerFactory[] orderedFactories = []`
    _ordered: List['PhonemizerFactory'] = []

    @staticmethod
    def get(cls: type) -> Optional['PhonemizerFactory']:
        """对应 `Get(Type type)`：取（或建）该类型的工厂；不合格返回 `None`。

        "不合格"= 没有 `name` / `tag` 类属性，或任一为空 —— 对应上游
        「`attr == null || IsNullOrEmpty(attr.Name) || IsNullOrEmpty(attr.Tag)`」。
        """
        hit = PhonemizerFactory._factories.get(cls)
        if hit is not None:
            return hit
        name = getattr(cls, 'name', '') or ''
        tag = getattr(cls, 'tag', '') or ''
        if not name or not tag:
            return None
        factory = PhonemizerFactory(
            cls, name, tag,
            getattr(cls, 'author', '') or '',
            getattr(cls, 'language', '') or '')
        # ★ 上游是 `factories.GetOrAdd(type, factory)`：命中时也会先构造再丢弃。
        #   这里 `setdefault` 语义与之等价（无副作用）。
        return PhonemizerFactory._factories.setdefault(cls, factory)

    @staticmethod
    def get_by_type_name(type_full_name: str) -> Optional['PhonemizerFactory']:
        """对应 `Get(string typeFullName)`：在**已缓存**的工厂里按类型全名线性找。

        ★ 只查已缓存的 —— 没被 `get()` 过就注册过的类型，这里查不到（上游同样如此）。
        """
        for factory in PhonemizerFactory._factories.values():
            if _type_full_name(factory.type) == type_full_name:
                return factory
        return None

    @staticmethod
    def build_list() -> None:
        """对应 `BuildList()`：按 `tag` 排好序存进 `_ordered`（★ 排序是**稳定**的）。"""
        PhonemizerFactory._ordered = sorted(PhonemizerFactory._factories.values(),
                                           key=lambda f: f.tag)

    @staticmethod
    def get_all() -> List['PhonemizerFactory']:
        """对应 `GetAll()`：返回排好序的数组；**没调 `build_list()` 就是空列表**。"""
        return list(PhonemizerFactory._ordered)

    @staticmethod
    def registered_types() -> Dict[type, 'PhonemizerFactory']:
        """本仓库附加：直接拿注册表快照（诊断/测试用；C# 无对应物）。"""
        return dict(PhonemizerFactory._factories)

    @staticmethod
    def reset() -> None:
        """清空两个静态表（**仅供测试**；C# 的静态字典活到进程结束）。"""
        PhonemizerFactory._factories.clear()
        PhonemizerFactory._ordered.clear()


class PhonemizerTypeValues:
    """对应 `PhonemizerTypeValues : IYamlValueSource`（`default_phonemizer` 的候选值）。

    上游给编辑器写 `default_phonemizer` 字段时提供下拉：
    键是**类型全名**（`default_phonemizer` 存的就是它），值是展示文案。
    引擎侧不读，搬过来是为了不丢东西 —— 与 `voicebank_config.SingerTypeValues` 同一模式。
    """

    @staticmethod
    def get_values() -> List[tuple]:
        """→ `[(type_full_name, 展示文案), …]`（按 `get_all()` 的顺序）。"""
        return [(_type_full_name(f.type), str(f)) for f in PhonemizerFactory.get_all()]


# ---------------------------------------------------------------- 音素化器安装器


class PhonemizerInstaller:
    """对应 `OpenUtau.Core/Api/PhonemizerInstaller.cs`（17 行）。"""

    @staticmethod
    def install(file_path: str):
        """对应 `Install(filePath)` → 返回 `(file_name, dest_path)`。

        把 `.dll` 拷到 `PathManager.Inst.PluginsPath`。★ C# 拷完会往 `DocManager`
        发"歌手列表变了"+"进度条"两条通知；引擎侧没有这条通道，
        所以**只做拷贝**并把结果交回给调用方去发通知
        （与 `ExeInstaller.install` 同一处理）。
        """
        import os
        import shutil
        from .classic import resampler_item
        file_name = os.path.basename(file_path)
        dest_path = getattr(resampler_item.host, 'plugins_path', '')
        os.makedirs(dest_path, exist_ok=True)
        dest_name = os.path.join(dest_path, file_name)
        shutil.copyfile(file_path, dest_name)     # C# 的 File.Copy(…, true) = 覆盖
        return file_name, dest_path
