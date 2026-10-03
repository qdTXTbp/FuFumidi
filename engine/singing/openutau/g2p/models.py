# -*- coding: utf-8 -*-
r"""G2p 模型（`g2p-*.zip`）的定位与装载 —— 对应上游的 `Data.Resources.g2p_*`。

上游把 13 个 G2p 模型包作为 **.NET 内嵌资源**编译进 `OpenUtau.Core.dll`
（声明在 `G2p/Data/Resources.resx`），运行时用 `Data.Resources.g2p_fr` 拿字节。
本仓库是文件系统形态，所以改成**按名字找文件**。

## zip 里有两种布局（务必区分）
| 布局 | 内容 | 用在 |
|---|---|---|
| **标准** | `dict.txt` + `phones.txt` + **`g2p.onnx`** | 除 ja-mono 外的 12 个 |
| **纯词典** | `hiragana/katakana/romaji/special.txt` + `phones.txt`（**无 onnx**） | `g2p-ja-mono.zip`（11KB） |

`g2p-ja-mono` 没有 ONNX → `session is None` → `G2pPack.predict` 返回 `[]`，
`query` 全部走词典命中。这不是降级、就是它本来的设计（它覆写了 `LoadPack`）。

## ★ 运行时依赖
- 神经网络 G2p 需要 **ONNX Runtime**。本应用的 `resources/python` **已经带了**
  （实测 `onnxruntime 1.28.0`），但**不要在模块顶层 import** —— 引擎进程可能
  跑在没有 onnxruntime 的解释器里（开发时的系统 Python 就是）。
  统一走 `set_onnx_session_factory()`（见 `pack.py`）按需注入。
- 没注入工厂时 `session is None`，`predict` 返回空数组、`query` 退化为纯词典 ——
  这是 `pack.py` 既有的设计，不是这里新加的降级。
"""

import io
import os
import zipfile
from typing import Dict, List, Optional

#: 13 个模型包的文件名（与上游 `G2p/Data/*.zip` 一一对应）
MODEL_FILES = (
    'g2p-arpabet-plus.zip', 'g2p-arpabet.zip', 'g2p-de-marzipan.zip', 'g2p-de.zip',
    'g2p-es.zip', 'g2p-fil.zip', 'g2p-fr-millefeuille.zip', 'g2p-fr.zip',
    'g2p-it.zip', 'g2p-ja-mono.zip', 'g2p-ko.zip', 'g2p-pt.zip', 'g2p-ru.zip',
)

#: 语种代码 → 模型文件名（G2p 类的 `NAME`/上游 `G2pXXX` 的对应关系由各子类自己声明）
MODEL_BY_LANG: Dict[str, str] = {
    'ar': 'g2p-arpabet.zip',
    'ar+': 'g2p-arpabet-plus.zip',
    'de': 'g2p-de.zip',
    'de_marzipan': 'g2p-de-marzipan.zip',
    'es': 'g2p-es.zip',
    'fil': 'g2p-fil.zip',
    'fr': 'g2p-fr.zip',
    'fr_millefeuille': 'g2p-fr-millefeuille.zip',
    'it': 'g2p-it.zip',
    'ja_mono': 'g2p-ja-mono.zip',
    'ko': 'g2p-ko.zip',
    'pt': 'g2p-pt.zip',
    'ru': 'g2p-ru.zip',
}

_search_paths: List[str] = []


def add_search_path(path: str) -> None:
    """把一个目录加入模型搜索路径（前面的优先）。"""
    if path and path not in _search_paths:
        _search_paths.insert(0, path)


def search_paths() -> List[str]:
    """返回当前搜索路径列表（默认路径在前）。"""
    return list(_search_paths)


def _default_paths() -> List[str]:
    """默认搜索路径（按优先级）：

    1. 环境变量 `FUFUMIDI_G2P_DIR`（部署/测试时最直接）；
    2. ★ **由 `sys.executable` 推出的 `<resources>/g2p/`** —— 这一条同时覆盖**开发**与**打包**：
       两种形态的目录布局**完全相同**（`extraResources` 分别是 `to: python` 与 `to: g2p`）：

           <app>/resources/python/python.exe     ← sys.executable
           <app>/resources/g2p/g2p-fr.zip       ← 模型

       ★ 所以是 **python 目录的同级**（`dirname(dirname(exe))/g2p`），不是 python 自己的同级。
         我第一版写成「exe 同级」→ 变成 `resources/python/g2p`，不存在；当时测试仍显示
         13/13，是因为 `_ref` 兜底路径兜住了 —— **兜底会掩盖路径推导错误**，
         所以修完必须掐掉兜底单独验一次。
       好处：生产与开发都**零配置**，且不依赖 cwd（cwd 会被更新器/快捷方式改掉）。
    3. `arpabet.set_data_dir()` 注入的目录（向后兼容既有调用方）；
    4. 开发时回落 `_ref/OpenUtau/OpenUtau.Core/G2p/Data/`
       —— 让开发机**不用复制 25MB** 也能跑测试。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    # engine/singing/openutau/g2p → 一路上到 D:/FuFuMIDI
    repo = here
    for _ in range(5):
        repo = os.path.dirname(repo)
    out = []
    env = os.environ.get('FUFUMIDI_G2P_DIR')
    if env:
        out.append(env)
    # ★ 打包与开发都成立：g2p/ 与 python/ 是**兄弟目录**
    import sys as _sys
    exe = getattr(_sys, 'executable', None)
    if exe:
        py_dir = os.path.dirname(os.path.abspath(exe))          # .../resources/python
        out.append(os.path.join(os.path.dirname(py_dir), 'g2p'))   # .../resources/g2p
    # 兼容既有 arpabet.py 的注入方式（宿主可能已经调过 set_data_dir）
    try:
        from .arpabet import g2p_data_dir
        legacy = g2p_data_dir()
        if legacy:
            out.append(legacy)
    except Exception:                                    # noqa: BLE001
        pass
    out.append(os.path.join(repo, 'FuFumidi', 'resources', 'g2p'))
    out.append(os.path.join(repo, '_ref', 'OpenUtau', 'OpenUtau.Core', 'G2p', 'Data'))
    return out


def find_model(file_name: str) -> Optional[str]:
    """找到模型 zip 的绝对路径；找不到返回 None。"""
    for d in _search_paths + _default_paths():
        p = os.path.join(d, file_name)
        if os.path.isfile(p):
            return p
    return None


def load_model_bytes(file_name: str) -> bytes:
    """读出模型 zip 的字节（对应 `Data.Resources.g2p_*`）。

    找不到就抛 `FileNotFoundError`，并把**搜过的所有目录**列出来 ——
    这样"为什么找不到模型"一眼能看出来，不用猜。
    """
    path = find_model(file_name)
    if path is None:
        tried = _search_paths + _default_paths()
        raise FileNotFoundError(
            '找不到 G2p 模型 %s；已搜索：\n  %s' % (file_name, '\n  '.join(tried)))
    with open(path, 'rb') as f:
        return f.read()


def model_available(file_name: str) -> bool:
    """模型是否就位（UI 用来决定要不要提示"该语种需要下载模型"）。"""
    return find_model(file_name) is not None


def list_available() -> Dict[str, bool]:
    """`{语种: 模型是否就位}`，供 UI 一次性查询。"""
    return {lang: model_available(fn) for lang, fn in MODEL_BY_LANG.items()}


# ---------------------------------------------------------------- ONNX 会话


def make_onnx_session_factory():
    """造一个 `set_onnx_session_factory` 用的工厂：`(bytes) -> onnxruntime.InferenceSession`。

    ★ 顶层**不** import onnxruntime —— 引擎进程的解释器未必带它。
    第一次真正建会话时才 import；import 失败就抛，调用方（`pack.py`）会保留
    `session = None` 并退化成纯词典。
    """
    import onnxruntime                                   # 延迟到真正需要时
    opts = onnxruntime.SessionOptions()
    # 上游没设线程数；CPU 上 G2p 推理很轻，限制一下免得抢渲染线程的核。
    opts.intra_op_num_threads = max(1, min(2, (os.cpu_count() or 2) // 2))
    opts.inter_op_num_threads = 1

    def _factory(data: bytes):
        return onnxruntime.InferenceSession(io.BytesIO(data).read(), opts,
                                            providers=['CPUExecutionProvider'])

    return _factory


def install_onnx_session_factory() -> bool:
    """把 ONNX 会话工厂装到 `pack.py`。装成功返回 True。

    没有 onnxruntime 时返回 False（**不抛**）—— 那就让所有神经网络 G2p 退化成
    纯词典，界面照常可用，只是多音字消歧会弱一些。
    """
    from . import pack
    try:
        pack.set_onnx_session_factory(make_onnx_session_factory())
        return True
    except Exception:                                    # noqa: BLE001
        pack.set_onnx_session_factory(None)
        return False


def zip_names(data: bytes) -> List[str]:
    """列出模型 zip 里的条目（诊断用：一眼看出是标准布局还是纯词典布局）。"""
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return z.namelist()


def has_onnx(data: bytes) -> bool:
    """模型包是否含 `g2p.onnx`（即是否为神经网络 G2p）。"""
    return 'g2p.onnx' in zip_names(data)
