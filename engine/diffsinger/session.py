# -*- coding: utf-8 -*-
r"""ONNX 会话与**张量缓存** —— 照搬
`OpenUtau.Core/Util/Onnx.cs`（`getInferenceSession` / `VerifyInputNames`）与
`OpenUtau.Core/DiffSinger/DiffSingerCache.cs`（:13-215）。

## ★ `VerifyInputNames`（`Onnx.cs:190-207`）是**双向严格比对**
模型有而我们没给 → 抛；我们给了而模型没有 → 也抛。上游靠它抓「声库 `dsconfig` 的
`use*Embed` 与 onnx 签名不匹配」。**必须保留** —— 否则错配会退化成 onnxruntime 的
`Invalid rank for input` 这类难以定位的形状错误。

## ★ 缓存的字节布局（照搬 `DiffSingerCache`）

**算键**（:22-32）：
```
BinaryWriter:
    Write(identifier)                       # ulong 小端 8 字节（模型字节的 XXH64）
    foreach (v in inputs.OrderBy(Name, InvariantCulture))   # ★ 按名字排序
        SerializeNamedOnnxValue(v)
hash = XXH64.DigestOf(全部字节);  filename = $"ds-{hash:x16}.tensorcache"
```

**写文件**（:72-83）：`Write("TENSORCACHE")` → `Write(int32 count)` → 逐个序列化。
**读文件**（:35-60）：先校验 header（不符 → 抛 `InvalidDataException`），
反序列化异常时 `Delete()` 并返回 None（**不抛给调用方**）。

**张量序列化**（:174-198）：
```
Write(name)      # BinaryWriter.Write(string) = 7-bit varint 长度 + UTF-8（不是 4 字节）
Write((int)dtype)# TensorElementType
Write(rank)      # int32
Write(每个 dim)  # int32
Write(size)      # int32
Write(原始字节)  # Buffer.BlockCopy（小端原样）
```
★ 字符串张量是**逐元素** `Write(string)`（:186-189），不走 BlockCopy。

★ `identifier` 是**模型字节的 hash**（`singer.acousticHash` / `vocoder.hash`），
  与输入张量**分开** → 换模型自动失效、输入不变时键不变。
"""

import os
import struct
from typing import Dict, List, Optional, Sequence, Tuple

from . import RenderError

_PROVIDERS: Optional[Sequence[str]] = None

#: `DiffSingerCache.cs:14`
FORMAT_HEADER = 'TENSORCACHE'

#: ★ ORT 的 `TensorElementType` 数值 == onnx `TensorProto.DataType`（ORT 按它实现）。
#:   这些值是**从 onnx 权威读出来的**，不是记忆 —— 写错会导致与上游缓存
#:   **互不兼容**且静默（两边都觉得自己对）。
_DTYPE = {
    'float32': 1, 'uint8': 2, 'int8': 3, 'uint16': 4, 'int16': 5,
    'int32': 6, 'int64': 7, 'bool': 9, 'float16': 10, 'float64': 11,
    'uint32': 12, 'uint64': 13,
}
_DTYPE_NAME = {v: k for k, v in _DTYPE.items()}


# ---------------------------------------------------------------- provider

def resolve_providers(device: str = 'auto') -> List[str]:
    """`auto/cuda/dml/cpu` → onnxruntime provider 列表（GPU 不可用时降级 CPU）。

    ★ 结果**去重保序** —— 重复列同一个 provider 会触发
      `UserWarning: Duplicate provider 'CPUExecutionProvider' encountered`
      （实测踩过 :105-106）。
    """
    global _PROVIDERS
    if _PROVIDERS is not None:
        return list(_PROVIDERS)
    try:
        import onnxruntime as ort
    except ImportError:
        raise RenderError('缺少 onnxruntime，无法渲染')
    avail = set(ort.get_available_providers())
    want = {'auto': 'CUDAExecutionProvider', 'cuda': 'CUDAExecutionProvider',
            'dml': 'DmlExecutionProvider', 'cpu': 'CPUExecutionProvider'}.get(
                str(device).lower(), 'CUDAExecutionProvider')
    if want in avail:
        provs = [want] + [p for p in ('CPUExecutionProvider',) if p in avail]
    else:
        provs = ['CPUExecutionProvider']
    seen, out = set(), []
    for p in provs:
        if p not in seen:
            seen.add(p)
            out.append(p)
    _PROVIDERS = out
    return list(_PROVIDERS)


# ---------------------------------------------------------------- 会话

def verify_input_names(session, feeds: Dict[str, object]) -> None:
    """对应 `Onnx.VerifyInputNames`（:190-207）—— 双向严格比对，缺/多都抛。"""
    want = {i.name for i in session.get_inputs()}
    have = set(feeds)
    missing = sorted(want - have)
    unexpected = sorted(have - want)
    if missing or unexpected:
        raise RenderError(
            '模型输入不匹配 —— 缺少 %s / 多余 %s。'
            '请检查声库 dsconfig.yaml 的 use*Embed 开关是否与 onnx 签名一致。'
            % (missing or '无', unexpected or '无'))


def make_session(model_path: str, providers: Sequence[str]):
    """建立 `InferenceSession`（对应 `Onnx.getInferenceSession`）。"""
    import onnxruntime as ort
    if not os.path.isfile(model_path):
        raise RenderError('找不到模型：%s' % model_path)
    so = ort.SessionOptions()
    try:
        return ort.InferenceSession(model_path, so, providers=list(providers))
    except Exception:                                  # noqa: BLE001
        if 'CPUExecutionProvider' in list(providers):
            raise
        return ort.InferenceSession(model_path, so, providers=['CPUExecutionProvider'])


# ---------------------------------------------------------------- 字节流

def _write_string(buf: bytearray, s: str) -> None:
    """C# `BinaryWriter.Write(string)`：**7-bit varint 长度 + UTF-8**（不是 4 字节长度）。"""
    data = s.encode('utf-8')
    n = len(data)
    while n >= 0x80:
        buf.append((n & 0x7F) | 0x80)
        n >>= 7
    buf.append(n)
    buf.extend(data)


def _read_string(f) -> str:
    """C# `BinaryReader.ReadString()` 的 7-bit varint 长度 + UTF-8。"""
    n = 0
    shift = 0
    while True:
        b = f.read(1)
        if not b:
            raise EOFError('缓存文件意外结束（读字符串长度）')
        b = b[0]
        n |= (b & 0x7F) << shift
        if not (b & 0x80):
            break
        shift += 7
    return f.read(n).decode('utf-8')


def _serialize_value(buf: bytearray, name: str, arr) -> None:
    """对应 `SerializeNamedOnnxValue` + `SerializeTensor`（:87-198）。"""
    import numpy as np
    a = np.ascontiguousarray(arr)
    key = a.dtype.name
    if key not in _DTYPE:
        raise RenderError('tensorcache 不支持 dtype %r（%s）' % (key, name))
    _write_string(buf, name)
    buf.extend(struct.pack('<i', _DTYPE[key]))        # dtype
    buf.extend(struct.pack('<i', a.ndim))             # rank
    for d in a.shape:                                  # shape
        buf.extend(struct.pack('<i', int(d)))
    buf.extend(struct.pack('<i', int(a.size)))         # size
    buf.extend(a.tobytes(order='C'))                   # BlockCopy（小端原样）


def _deserialize_value(f):
    name = _read_string(f)
    (dtype,) = struct.unpack('<i', f.read(4))
    (rank,) = struct.unpack('<i', f.read(4))
    shape = [struct.unpack('<i', f.read(4))[0] for _ in range(rank)]
    (size,) = struct.unpack('<i', f.read(4))
    key = _DTYPE_NAME.get(dtype)
    if key is None:
        raise RenderError('tensorcache 未知 dtype=%d' % dtype)
    import numpy as np
    raw = f.read(size * np.dtype(key).itemsize)
    return name, np.frombuffer(raw, dtype=key).reshape(shape).copy()


# ---------------------------------------------------------------- 缓存

def compute_hash(identifier: int, feeds: Dict[str, object]) -> Tuple[int, str]:
    """对应构造函数的算键部分（:22-32）→ `(hash, filename)`。

    ★ `identifier` 是**模型字节的 XXH64**，与输入张量分开；
      输入按**名字**排序 → 喂入顺序不影响键。
    """
    from singing.openutau import xxhash
    buf = bytearray()
    buf.extend(struct.pack('<Q', int(identifier) & 0xFFFFFFFFFFFFFFFF))
    for name in sorted(feeds, key=lambda s: s):         # OrderBy(Name, InvariantCulture)
        _serialize_value(buf, name, feeds[name])
    h = xxhash.xxh64(bytes(buf), 0)
    return h, 'ds-%016x.tensorcache' % h


class TensorCache:
    """对应 `DiffSingerCache`（:13-215）。"""

    def __init__(self, identifier: int, feeds: Dict[str, object]):
        self.hash, self.filename = compute_hash(identifier, feeds)

    def _path(self, cache_dir: str) -> str:
        return os.path.join(cache_dir, self.filename)

    def load(self, cache_dir: Optional[str]):
        """对应 `Load()`（:35-60）。反序列化失败 → 删除并返回 None，不抛。"""
        if not cache_dir:
            return None
        path = self._path(cache_dir)
        if not os.path.isfile(path):
            return None
        try:
            with open(path, 'rb') as f:
                header = _read_string(f)
                if header != FORMAT_HEADER:
                    # 对应 :41-43 —— header 不符是**硬错误**
                    raise RenderError('tensorcache 文件头不符（%s）：%s'
                                      % (self.filename, path))
                (count,) = struct.unpack('<i', f.read(4))
                out = []
                for _ in range(count):
                    out.append(_deserialize_value(f))
                return [v for _, v in out]
        except Exception as e:                           # noqa: BLE001
            import sys
            sys.stderr.write('[diffsinger] tensorcache 反序列化失败，删除后重算：%s\n' % e)
            self.delete(cache_dir)
            return None

    def save(self, cache_dir: Optional[str], outputs: Sequence) -> None:
        """对应 `Save()`（:72-83）。"""
        if not cache_dir:
            return
        buf = bytearray()
        _write_string(buf, FORMAT_HEADER)
        buf.extend(struct.pack('<i', len(outputs)))
        for i, arr in enumerate(outputs):
            _serialize_value(buf, 'o%d' % i, arr)
        try:
            os.makedirs(cache_dir, exist_ok=True)
            with open(self._path(cache_dir), 'wb') as f:
                f.write(buf)
        except OSError as e:
            import sys
            sys.stderr.write('[diffsinger] tensorcache 写入失败（忽略）：%s\n' % e)

    def delete(self, cache_dir: Optional[str]) -> None:
        """对应 `Delete()`（:62-69）。"""
        if not cache_dir:
            return
        try:
            os.remove(self._path(cache_dir))
        except OSError:
            pass


def run_session(model_path: str, feeds: Dict[str, object], providers: Sequence[str],
                label: str, identifier: Optional[int] = None,
                cache_dir: Optional[str] = None):
    """跑一次推理 → 输出列表；`identifier` 与 `cache_dir` 都给时走张量缓存。

    ★ 对应上游那几处调用点（`DiffSingerRenderer.cs:463/503`、
      `DiffSingerVariance.cs:174/269/279`、`DiffSingerBasePhonemizer.cs:429/467`、
      `DiffSingerPitch.cs:163`）—— 它们都传 `identifier`（模型 hash）。
    """
    if identifier is not None and cache_dir:
        cache = TensorCache(identifier, feeds)
        hit = cache.load(cache_dir)
        if hit is not None:
            return hit
    session = make_session(model_path, providers)
    verify_input_names(session, feeds)
    try:
        outs = session.run(None, feeds)
    except Exception as e:                             # noqa: BLE001
        raise RenderError('%s 推理失败：%s' % (label, str(e)[:200]))
    if identifier is not None and cache_dir:
        cache.save(cache_dir, outs)
    return list(outs)
