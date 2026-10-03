# -*- coding: utf-8 -*-
r"""M5 验收：tensor cache 的字节流与算键语义。

照搬基准：`OpenUtau.Core/DiffSinger/DiffSingerCache.cs`
（算键 :22-32、读 :35-60、写 :72-83、`SerializeTensor` :174-198）。

★ 要验的三个语义：
  1. **输入按名字排序** → 喂入顺序不影响键（`OrderBy(Name, InvariantCulture)`）
  2. **`identifier` 与输入分开** → 换模型（改 identifier）键就变
  3. **字节级往返**：float32/float64/int64/bool 写进去能原样读回来
"""
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402

from diffsinger import session as S  # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


def main():
    tmp = tempfile.mkdtemp(prefix='fufumidi-tc-')

    print('--- 7-bit varint 字符串（BinaryWriter.Write(string)）---')
    for s in ('', 'a', 'f0', 'breathiness', 'x' * 200, '速度'):
        buf = bytearray()
        S._write_string(buf, s)
        with open(os.path.join(tmp, '_s.bin'), 'wb') as f:
            f.write(buf)
        with open(os.path.join(tmp, '_s.bin'), 'rb') as f:
            got = S._read_string(f)
        check('  %-12r 往返一致（%d 字节）' % (s[:12], len(buf)), got == s, got)
    # ★ 关键：不是 4 字节定长
    buf = bytearray()
    S._write_string(buf, 'ab')
    check('★ 长度用 7-bit varint（"ab" = 2 字节，不是 4+2）', len(buf) == 3, len(buf))
    buf = bytearray()
    S._write_string(buf, 'x' * 200)
    check('  200 字符 → 长度占 2 字节 varint', len(buf) == 200 + 2, len(buf))

    print()
    print('--- dtype 数值（ORT TensorElementType == onnx DataType）---')
    for name, want in (('float32', 1), ('uint8', 2), ('int8', 3), ('int32', 6),
                       ('int64', 7), ('bool', 9), ('float64', 11), ('uint32', 12)):
        check('  %-8s = %2d' % (name, want), S._DTYPE[name] == want, S._DTYPE[name])

    print()
    print('--- 张量字节级往返（SerializeTensor :174-198）---')
    cases = [
        ('f0', np.array([[1.5, -2.25, 0.0]], dtype=np.float32)),
        ('tokens', np.array([[1, 2, 3]], dtype=np.int64)),
        ('durations', np.array([[8, 17, 16]], dtype=np.int64)),
        ('retake', np.ones((1, 4, 3), dtype=bool)),
        ('depth', np.array([0.6], dtype=np.float32)),
        ('steps', np.array([20], dtype=np.int64)),
        ('mel', np.arange(24, dtype=np.float32).reshape(1, 4, 6)),
    ]
    for name, arr in cases:
        buf = bytearray()
        S._serialize_value(buf, name, arr)
        path = os.path.join(tmp, '_t.bin')
        with open(path, 'wb') as f:
            f.write(buf)
        with open(path, 'rb') as f:
            got_name, got = S._deserialize_value(f)
        same = (got_name == name and got.dtype == arr.dtype
                and got.shape == arr.shape and np.array_equal(got, arr))
        check('  %-10s %-10s %-12s 往返一致' % (name, arr.dtype.name, arr.shape),
              same, (got_name, got.dtype, got.shape))

    print()
    print('--- 算键：输入按名字排序 → 顺序无关（:26）---')
    a = np.array([[1.0, 2.0]], dtype=np.float32)
    b = np.array([[3]], dtype=np.int64)
    h1, n1 = S.compute_hash(123, {'x': a, 'y': b})
    h2, n2 = S.compute_hash(123, {'y': b, 'x': a})      # ★ 换顺序
    check('★ 喂入顺序不同 → 键相同', (h1, n1) == (h2, n2), (n1, n2))
    h3, n3 = S.compute_hash(123, {'x': a, 'z': b})      # ★ 换个名字
    check('  换个输入名 → 键不同', n1 != n3, (n1, n3))
    check('  文件名形如 ds-<16位hex>.tensorcache',
          n1.startswith('ds-') and n1.endswith('.tensorcache') and len(n1) == 3 + 16 + 12,
          n1)

    print()
    print('--- identifier 与输入分开（换模型 → 键变）---')
    h4, n4 = S.compute_hash(124, {'x': a, 'y': b})      # ★ 只改 identifier
    check('★ identifier 变了 → 键不同（换模型自动失效）', n1 != n4, (n1, n4))
    h5, n5 = S.compute_hash(123, {'x': a * 2, 'y': b})  # ★ 输入值变
    check('  输入值变了 → 键不同', n1 != n5, (n1, n5))

    print()
    print('--- TensorCache 存 / 取往返 ---')
    c = S.TensorCache(999, {'f0': a})
    check('  文件名与 compute_hash 一致', c.filename == S.compute_hash(999, {'f0': a})[1])
    outs = [np.arange(6, dtype=np.float32).reshape(1, 2, 3),
            np.array([1, 2], dtype=np.int64)]
    c.save(tmp, outs)
    check('  缓存文件已写', os.path.isfile(os.path.join(tmp, c.filename)),
          c.filename)
    got = S.TensorCache(999, {'f0': a}).load(tmp)
    check('  取回 2 个输出', got is not None and len(got) == 2,
          None if got is None else len(got))
    if got:
        check('  ★ 输出逐值一致', np.array_equal(got[0], outs[0])
              and np.array_equal(got[1], outs[1]))
    with open(os.path.join(tmp, c.filename), 'rb') as f:
        head = S._read_string(f)
        (cnt,) = struct.unpack('<i', f.read(4))
    check('  ★ 文件头 == "TENSORCACHE"', head == 'TENSORCACHE', head)
    check('  ★ 紧随其后是 int32 count', cnt == 2, cnt)

    print()
    print('--- 坏缓存：删除并返回 None，不抛（:55-59）---')
    with open(os.path.join(tmp, c.filename), 'wb') as f:
        f.write(b'garbage-not-a-tensorcache')
    c2 = S.TensorCache(999, {'f0': a})
    got2 = c2.load(tmp)
    check('  坏文件 → 返回 None', got2 is None, got2)
    check('  ★ 坏文件被删除', not os.path.isfile(os.path.join(tmp, c2.filename)))

    print()
    print('--- header 不符 → 硬错误（:41-43）---')
    c3 = S.TensorCache(999, {'f0': a})
    buf = bytearray()
    S._write_string(buf, 'WRONGHEADER')
    buf.extend(struct.pack('<i', 0))
    with open(os.path.join(tmp, c3.filename), 'wb') as f:
        f.write(buf)
    got3 = c3.load(tmp)
    check('  ★ header 不符 → 返回 None（并被当作坏文件删除）', got3 is None, got3)
    check('  且文件被删', not os.path.isfile(os.path.join(tmp, c3.filename)))

    print()
    print('--- 不给 cache_dir → 完全不缓存（:37-38）---')
    c4 = S.TensorCache(999, {'f0': a})
    check('  load(None) → None', c4.load(None) is None)
    c4.save(None, outs)                                # 不应抛
    check('  save(None, …) 不抛', True)

    print()
    print('--- 不支持的 dtype 明确报错（:172-176）---')
    try:
        S._serialize_value(bytearray(), 'x', np.array(['a', 'b']))
        check('  字符串张量 → RenderError', False)
    except Exception as e:  # noqa: BLE001
        check('  字符串张量 → RenderError（说明不支持）',
              'dtype' in str(e) or '不支持' in str(e), str(e)[:60])

    print()
    print('--- resolve_providers 去重（:105-106 踩过的坑）---')
    S._PROVIDERS = None
    provs = S.resolve_providers('cpu')
    check('  无重复项', len(provs) == len(set(provs)), provs)
    check('  含 CPUExecutionProvider', 'CPUExecutionProvider' in provs, provs)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())
