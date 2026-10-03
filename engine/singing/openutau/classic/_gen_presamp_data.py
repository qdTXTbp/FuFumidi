# -*- coding: utf-8 -*-
r"""生成 `classic/_presamp_data.py` —— 数据表**从上游 C# 源码直接抽取**，不手抄。

为什么生成而不是手抄：`Presamp.cs` 里 `defVowels` / `defConsonants` / `defReplace` /
`defPitches` 是**几百行日文与音高名**，手抄必错，且错了很难发现（只表现为某个
片假名唱错）。所以：

1. 本脚本从 `OpenUtau.Core/Classic/Presamp.cs` 里**逐条解析**这些表；
2. 生成 `classic/_presamp_data.py`（带"由本脚本生成"的醒目标头 + 每张表对应的
   C# 原文行号区间）；
3. `tests/test_presamp.py` 会**重新生成一遍并逐字节比对**，所以上游改了表、
   而生成文件没跟着变，测试立刻红。

## 用法
    python engine/singing/openutau/classic/_gen_presamp_data.py

找不到 `_ref/OpenUtau` 时直接报错退出（不静默跳过）—— 静默跳过会让"没生成"看起来
和"生成成功"一样。
"""

import io
import os
import re
import sys

_HERE = os.path.dirname(os.path.abspath(__file__))


def _repo_root():
    """<repo>/engine/singing/openutau/classic → <repo>

    要往上退 **5** 级：classic → openutau → singing → engine → <repo>。
    """
    p = _HERE
    for _ in range(5):
        p = os.path.dirname(p)
    return p


def find_cs():
    for cand in (os.path.join(_repo_root(), '_ref', 'OpenUtau', 'OpenUtau.Core',
                              'Classic', 'Presamp.cs'),
                 os.path.join(_repo_root(), '..', 'OpenUtau', 'OpenUtau.Core',
                              'Classic', 'Presamp.cs')):
        if os.path.isfile(cand):
            return cand
    raise SystemExit('找不到 Presamp.cs（期望 <repo>/_ref/OpenUtau/OpenUtau.Core/Classic/Presamp.cs）')


def _block(src, name):
    """取 `private readonly static <type> name = ... ;` 的初始化体与行号区间。"""
    m = re.search(r'(private readonly static [^\n]*\b%s\b[^\n]*=\s*)' % re.escape(name), src)
    if not m:
        raise SystemExit('在 Presamp.cs 里找不到 %s' % name)
    start = m.end() - 1
    depth, i = 0, start
    while i < len(src):
        if src[i] == '{':
            depth += 1
        elif src[i] == '}':
            depth -= 1
            if depth == 0:
                break
        i += 1
    line_no = src[:m.start()].count('\n') + 1
    return src[start:i + 1], line_no


def _string_list(body):
    """从 `{ "a", "b" }` 形态里取出所有双引号字符串（顺序即 C# 顺序）。"""
    return re.findall(r'"((?:[^"\\]|\\.)*)"', body)


def _kv_dict(body):
    """从 `{ { "k", "v" }, ... }` 形态里取出 (k, v) 对。"""
    return re.findall(r'\{\s*"((?:[^"\\]|\\.)*)"\s*,\s*"((?:[^"\\]|\\.)*)"\s*\}', body)


def main():
    cs_path = find_cs()
    src = io.open(cs_path, encoding='utf-8-sig').read().replace('\r\n', '\n')

    vowels_body, vowels_line = _block(src, 'defVowels')
    cons_body, cons_line = _block(src, 'defConsonants')
    repl_body, repl_line = _block(src, 'defReplace')
    nums_body, nums_line = _block(src, 'defNums')
    apps_body, apps_line = _block(src, 'defAppends')
    pitch_body, pitch_line = _block(src, 'defPitches')

    vowels = _string_list(vowels_body)
    consonants = _string_list(cons_body)
    replace = _kv_dict(repl_body)
    nums = _string_list(nums_body)
    appends = _string_list(apps_body)
    pitches = _string_list(pitch_body)

    for label, items, src_line in (('defVowels', vowels, vowels_line),
                                   ('defConsonants', consonants, cons_line),
                                   ('defReplace', replace, repl_line),
                                   ('defNums', nums, nums_line),
                                   ('defAppends', appends, apps_line),
                                   ('defPitches', pitches, pitch_line)):
        if not items:
            raise SystemExit('%s 抽取为空 —— 上游结构变了？' % label)

    out = io.StringIO()
    out.write('# -*- coding: utf-8 -*-\n')
    out.write('r"""presamp.ini 的**出厂默认表** —— 由 `_gen_presamp_data.py` 从\n')
    out.write('`OpenUtau.Core/Classic/Presamp.cs` 抽取生成，**不要手改**。\n\n')
    out.write('要改这里，请改生成脚本后重跑；`tests/test_presamp.py` 会逐字节比对，\n')
    out.write('上游表变了而本文件没变 → 测试立刻失败。\n\n')
    out.write('对应的 C# 源码行号：\n')
    for label, line, count in (('defVowels', vowels_line, len(vowels)),
                               ('defConsonants', cons_line, len(consonants)),
                               ('defReplace', repl_line, len(replace)),
                               ('defNums', nums_line, len(nums)),
                               ('defAppends', apps_line, len(appends)),
                               ('defPitches', pitch_line, len(pitches))):
        out.write('  %-15s 第 %d 行起，%d 条\n' % (label, line, count))
    out.write('"""\n\n')
    out.write('from typing import Dict, List, Tuple\n\n')
    out.write('#: 对应 `defVowels`（`a=あ=ぁ,あ,…=100`）\n')
    out.write('DEF_VOWELS: List[str] = [\n')
    for v in vowels:
        out.write('    %r,\n' % v)
    out.write(']\n\n')
    out.write('#: 对应 `defConsonants`（`ch=ch,ち,…=1`；末位 1 = NotClossfade）\n')
    out.write('DEF_CONSONANTS: List[str] = [\n')
    for v in consonants:
        out.write('    %r,\n' % v)
    out.write(']\n\n')
    out.write('#: 对应 `defReplace`（罗马字/片假名 → 假名）\n')
    out.write('DEF_REPLACE: Dict[str, str] = {\n')
    for k, v in replace:
        out.write('    %r: %r,\n' % (k, v))
    out.write('}\n\n')
    out.write('#: 对应 `defNums`\n')
    out.write('DEF_NUMS: List[str] = %r\n\n' % (nums,))
    out.write('#: 对应 `defAppends`（情绪后缀，如强/弱/囁…）\n')
    out.write('DEF_APPENDS: List[str] = %r\n\n' % (appends,))
    out.write('#: 对应 `defPitches`（音高后缀，含 ↑↓→←high/low/mid）\n')
    out.write('DEF_PITCHES: List[str] = %r\n' % (pitches,))

    target = os.path.join(_HERE, '_presamp_data.py')
    text = out.getvalue()
    old = io.open(target, encoding='utf-8').read() if os.path.isfile(target) else None
    if old == text:
        print('[ok] _presamp_data.py 已是最新（%d 字节）' % len(text))
    else:
        io.open(target, 'w', encoding='utf-8', newline='\n').write(text)
        print('[ok] 已生成 %s（%d 字节）：母音 %d / 辅音 %d / 替换 %d / 数字 %d / 后缀 %d / 音高 %d'
              % (target, len(text), len(vowels), len(consonants), len(replace),
                 len(nums), len(appends), len(pitches)))


if __name__ == '__main__':
    main()