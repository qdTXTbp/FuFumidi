# -*- coding: utf-8 -*-
r"""生成 `g2p/<name>.py`（11 个标准布局 G2p 里的 10 个）—— **从 C# 源码抽取**。

为什么生成：这 10 个 G2p 每个都有两张**几十项的静态表**（`graphemes` / `phonemes`），
手抄必错、错了极难发现（表现为"某个字母/音素被读错"）。所以：

1. 本脚本从 `OpenUtau.Core/G2p/<Name>G2p.cs` 里逐项解析两张表 + 判断 `LoadPack`
   的调用变体（有没有 prep 函数、是 lower 还是原样）；
2. 生成对应的 Python 模块（带"由本脚本生成"的醒目标头 + C# 源码行号）；
3. `tests/test_g2p_models.py` 会**逐项验证生成的表与 C# 源码一致**。

## 三种 `LoadPack` 变体（从 C# 里识别出来）
| 变体 | C# 写法 | 出现在 |
|---|---|---|
| `none` | `LoadPack(Data.Resources.g2p_xx)` | FrenchMillefeuille / German / GermanMarzipan / Portuguese / Russian |
| `lower_rmtail` | `LoadPack(res, s => s.ToLowerInvariant(), s => RemoveTailDigits(s.ToLowerInvariant()))` | Filipino / Spanish / ArpabetPlus |
| `ident_rmtail` | `LoadPack(res, s => s, s => RemoveTailDigits(s))` | Italian |

## 不在生成范围内的两个
- `ArpabetG2p`（已手工搬过，在 `arpabet.py`）
- `KoreanG2p` —— 它**额外覆写了 `Predict`**（Hangul 分解成 jamo），
  逻辑不是模板能表达的，手写。

## 用法
    python engine/singing/openutau/g2p/_gen_g2p_modules.py
"""

import io
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))

#: (C# 文件名, Python 模块名, 预期变体) —— 变体由脚本自己**验证**，不符就报错
TARGETS = (
    ('FilipinoG2p.cs', 'filipino', None),
    ('FrenchG2p.cs', 'french', None),
    ('FrenchMillefeuilleG2p.cs', 'french_millefeuille', None),
    ('GermanG2p.cs', 'german', None),
    ('GermanMarzipanG2p.cs', 'german_marzipan', None),
    ('ItalianG2p.cs', 'italian', None),
    ('PortugueseG2p.cs', 'portuguese', None),
    ('RussianG2p.cs', 'russian', None),
    ('SpanishG2p.cs', 'spanish', None),
    ('ArpabetPlusG2p.cs', 'arpabet_plus', None),
)

_CLASS_RE = re.compile(r'public class (\w+G2p)\s*:\s*G2pPack')
_ARRAY_RE = re.compile(r'private static readonly string\[\]\s+(\w+)\s*=\s*new string\[\]\s*\{(.*?)\};',
                       re.S)
_LOADPACK_RE = re.compile(r'var tuple = LoadPack\((.*?)\);', re.S)
_RESOURCE_RE = re.compile(r'Data\.Resources\.(g2p_[a-z_]+)')


def _repo_root():
    """<repo>/engine/singing/openutau/g2p → <repo>（往上 5 级到 D:/FuFuMIDI）。"""
    p = _HERE
    for _ in range(5):
        p = os.path.dirname(p)
    return p


def _cs_path(name):
    for cand in (os.path.join(_repo_root(), '_ref', 'OpenUtau', 'OpenUtau.Core', 'G2p', name),
                 os.path.join(_repo_root(), '..', 'OpenUtau', 'OpenUtau.Core', 'G2p', name)):
        if os.path.isfile(cand):
            return cand
    raise SystemExit('找不到 %s（期望 <repo>/_ref/OpenUtau/OpenUtau.Core/G2p/%s）' % (name, name))


def _strings(body):
    """取出 C# 字符串数组里的所有字面量（按源码顺序）。"""
    out = []
    for m in re.finditer(r'"((?:[^"\\]|\\.)*)"', body):
        s = m.group(1)
        out.append(s.replace('\\"', '"').replace('\\\\', '\\'))
    return out


def parse(name):
    path = _cs_path(name)
    src = io.open(path, encoding='utf-8-sig').read().replace('\r\n', '\n')
    cls = _CLASS_RE.search(src)
    if not cls:
        raise SystemExit('%s 里找不到 G2pPack 子类' % name)
    arrays = {}
    lines = {}
    for m in _ARRAY_RE.finditer(src):
        arrays[m.group(1)] = _strings(m.group(2))
        lines[m.group(1)] = src[:m.start()].count('\n') + 1
    for key in ('graphemes', 'phonemes'):
        if key not in arrays or not arrays[key]:
            raise SystemExit('%s 里找不到 %s' % (name, key))
    call = _LOADPACK_RE.search(src)
    if not call:
        raise SystemExit('%s 里找不到 LoadPack 调用' % name)
    call_text = call.group(1)
    res = _RESOURCE_RE.search(call_text)
    if not res:
        raise SystemExit('%s 的 LoadPack 里没认出资源名' % name)
    # ★ 两个 prep 参数**各自独立**判定（第一版只认"两个标记同时出现"，
    #   结果 SpanishG2p 的 `LoadPack(res, s => s.ToLowerInvariant())`（只传了
    #   prepGrapheme、prepPhoneme 缺省）被判成 none → prep_grapheme 被置空，
    #   西班牙语字素不再小写化。教训：可选参数要**逐个**判，不能打包成一个标签。
    args = _split_args(call_text)
    prep_g = _classify_prep(args[1]) if len(args) > 1 else 'identity'
    prep_p = _classify_prep(args[2]) if len(args) > 2 else 'identity'
    return {
        'class': cls.group(1), 'graphemes': arrays['graphemes'],
        'phonemes': arrays['phonemes'], 'lines': lines, 'resource': res.group(1),
        'prep_grapheme': prep_g, 'prep_phoneme': prep_p,
        'variant': '%s+%s' % (prep_g, prep_p),
        'src': os.path.basename(path),
    }


def _split_args(text):
    """按**顶层**逗号切分实参（跳过 lambda 体内的逗号与括号内的逗号）。"""
    out, buf, depth = [], [], 0
    for ch in text:
        if ch in '([':
            depth += 1
        elif ch in ')]':
            depth -= 1
        if ch == ',' and depth == 0:
            out.append(''.join(buf).strip())
            buf = []
        else:
            buf.append(ch)
    out.append(''.join(buf).strip())
    return out


def _classify_prep(arg):
    """把一个 prep 实参归类成 `identity` / `lower` / `rmtail` / `lower_rmtail`。"""
    a = arg.replace(' ', '').lower()
    if not a or a == 'null':
        return 'identity'
    low = 'tolowerinvariant' in a
    tail = 'removetaildigits' in a
    if low and tail:
        return 'lower_rmtail'
    if tail:
        return 'rmtail'
    if low:
        return 'lower'
    return 'identity'


_PREP_EXPR = {
    'identity': 'lambda s: s',
    'lower': 'lambda s: s.lower()',
    'rmtail': 'lambda s: self.remove_tail_digits(s)',
    'lower_rmtail': 'lambda s: self.remove_tail_digits(s.lower())',
}

_PREP_DOC = {
    'identity': '`s => s`（恒等）',
    'lower': '`s => s.ToLowerInvariant()`',
    'rmtail': '`s => RemoveTailDigits(s)`',
    'lower_rmtail': '`s => RemoveTailDigits(s.ToLowerInvariant())`',
}

_PREP = {
    'none': ("None, None",
             "无 prep（`LoadPack(res)`，两个参数都是默认恒等）"),
    'lower_rmtail': ("lambda s: s.lower(),\n                     lambda s: self.remove_tail_digits(s.lower())",
                     "grapheme 与 phoneme 都先 `ToLowerInvariant()`；phoneme 再去掉尾数字"),
    'ident_rmtail': ("lambda s: s,\n                     lambda s: self.remove_tail_digits(s)",
                     "grapheme 原样；phoneme 去掉尾数字（`s => s` 是恒等函数，上游仍显式写了）"),
}

_PACK_FILE = {
    'g2p_fil': 'g2p-fil.zip', 'g2p_fr': 'g2p-fr.zip',
    'g2p_fr_millefeuille': 'g2p-fr-millefeuille.zip', 'g2p_de': 'g2p-de.zip',
    'g2p_de_marzipan': 'g2p-de-marzipan.zip', 'g2p_it': 'g2p-it.zip',
    'g2p_pt': 'g2p-pt.zip', 'g2p_ru': 'g2p-ru.zip', 'g2p_es': 'g2p-es.zip',
    'g2p_arpabet_plus': 'g2p-arpabet-plus.zip',
}

_TMPL = '''# -*- coding: utf-8 -*-
r"""{cls} —— **照搬** `OpenUtau.Core/G2p/{src}`（{nlines} 行）。

★ 本文件由 `_gen_g2p_modules.py` **从 C# 源码生成，不要手改**
  （两张静态表各几十项，手抄必错）。要改请改生成脚本后重跑；
  `tests/test_g2p_models.py` 会逐项验证表与 C# 一致。

## 静态表（生成自 C#，行号见下）
| 表 | 项数 | C# 源码行 |
|---|---|---|
{row_table}

★ `graphemes` 的**前 4 项是空串占位**（上游的编码约定），构造时用
  `Skip(4)` + `i + 4` 建索引 —— 也就是真实下标从 4 起。照搬，别改成从 0 开始。

## LoadPack 变体：`{variant}`
{prep_doc}

## 与 C# 的载体差异
- `Data.Resources.{resource}`（程序集**内嵌资源**）→ 磁盘上的 `{pack}`
  （路径由 `g2p/models.py` 解析）。
- `InferenceSession` → `G2pPack` 的**可注入会话工厂**（`models.install_onnx_session_factory()`）。
  没装 onnxruntime 时 `session is None` → 未登录词预测返回空、`query` 退化为纯词典
  （这正是 C# 里 `Session == null` 的既有分支，不是我们新加的降级）。
- C# 的 `lock (lockObj)` + 静态字段做"每进程只装一次" → Python 侧模块级缓存
  （模型 1.7MB + ONNX 会话，重复装载代价大）。
"""

import threading
from typing import Dict, List, Optional

from . import models
from .pack import G2pPack

#: 包文件名（对应上游的 `Data.Resources.{resource}`）
PACK_NAME = {pack!r}

#: 对应 C# 的 `graphemes`（**前 4 项是空串占位**）
GRAPHEMES = (
{graphemes}
)

#: 对应 C# 的 `phonemes`
PHONEMES = (
{phonemes}
)

_CACHE_LOCK = threading.Lock()
#: 对应 C# 的静态缓存（graphemeIndexes / dict / session / predCache）
_CACHE: Optional[Dict[str, object]] = None


def build_grapheme_indexes(graphemes=GRAPHEMES) -> Dict[str, int]:
    """对应 `graphemes.Skip(4).Select((g, i) => Tuple.Create(g, i)).ToDictionary(t => t.Item1, t => t.Item2 + 4)`。

    ★ `i` 是 **Skip 之后**的下标，所以最终键值是 `i + 4`。
    """
    out: Dict[str, int] = {{}}
    for i, g in enumerate(graphemes[4:]):
        out[g] = i + 4
    return out


class {cls}(G2pPack):
    """对应 `{cls}`。第一次构造时真读包（之后走进程级缓存）。"""

    def __init__(self, pack: Optional[bytes] = None):
        super().__init__()
        global _CACHE
        with _CACHE_LOCK:
            if _CACHE is None:
                data = pack if pack is not None else models.load_model_bytes(PACK_NAME)
                built, session = self.load_pack(data, {prep})
                _CACHE = {{
                    'grapheme_indexes': build_grapheme_indexes(),
                    'phonemes': list(PHONEMES),
                    'dict': built,
                    'session': session,
                    'pred_cache': {{}},
                }}
            cache = _CACHE

        self.grapheme_indexes = cache['grapheme_indexes']
        self.phonemes = cache['phonemes']
        self.dict = cache['dict']
        self.session = cache['session']
        self.pred_cache = cache['pred_cache']

    @staticmethod
    def reset_cache() -> None:
        """清进程级缓存（**仅供测试**；C# 的静态字段活到进程结束）。"""
        global _CACHE
        with _CACHE_LOCK:
            _CACHE = None
'''


def _tuple_literal(items, indent='    '):
    out = []
    for i in range(0, len(items), 6):
        chunk = items[i:i + 6]
        out.append(indent + ' '.join('%r,' % s for s in chunk).replace("'", '"', 0))
    return '\n'.join(out)


def render(name, mod, info):
    cls = info['class']
    pack = _PACK_FILE[info['resource']]
    prep = '%s, %s' % (_PREP_EXPR[info['prep_grapheme']],
                        _PREP_EXPR[info['prep_phoneme']])
    prep_doc = '`prepGrapheme` = %s\n`prepPhoneme`  = %s' % (
        _PREP_DOC[info['prep_grapheme']], _PREP_DOC[info['prep_phoneme']])
    nlines = sum(1 for _ in io.open(_cs_path(name), encoding='utf-8-sig', errors='replace'))
    rows = []
    for key, label in (('graphemes', '`graphemes`'), ('phonemes', '`phonemes`')):
        rows.append('| %s | %d | 第 %d 行 |' % (label, len(info[key]), info['lines'][key]))
    # prep 需要 self（remove_tail_digits 是实例方法）
    return _TMPL.format(
        cls=cls, src=info['src'], nlines=nlines, row_table='\n'.join(rows),
        variant=info['variant'], prep_doc=prep_doc, resource=info['resource'],
        pack=pack, prep=prep,
        graphemes=_tuple_literal(info['graphemes']),
        phonemes=_tuple_literal(info['phonemes']))


def main():
    for name, mod, expect in TARGETS:
        info = parse(name)
        if expect and info['variant'] != expect:
            print('  [跳过] %s：变体是 %s，与预期 %s 不同' % (name, info['variant'], expect))
            continue
        text = render(name, mod, info)
        target = os.path.join(_HERE, mod + '.py')
        old = io.open(target, encoding='utf-8').read() if os.path.isfile(target) else None
        if old == text:
            print('[ok] %-24s 已是最新（%d 字节，变体 %s）' % (mod + '.py', len(text), info['variant']))
        else:
            io.open(target, 'w', encoding='utf-8', newline='\n').write(text)
            print('[ok] 已生成 %-24s %d 字节｜%s %d 项 / %s %d 项｜变体 %s'
                  % (mod + '.py', len(text), 'graphemes', len(info['graphemes']),
                     'phonemes', len(info['phonemes']), info['variant']))


if __name__ == '__main__':
    main()