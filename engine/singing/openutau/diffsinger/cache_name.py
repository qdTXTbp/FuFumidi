# -*- coding: utf-8 -*-
"""乐句 wav 缓存文件名 —— **一个地方生成，两个地方使用**。

格式：`ds-{hash:x16}-depth{d:.2f}-steps{s}[-voc{t}].wav`

★ 为什么必须带 `-voc{t}`：缓存键里不含声码器的话，用户换了声码器仍会命中上一次的
  `ds-*.wav`，表现为「界面调了没反应」—— 这类漏参数的坑本仓库已经踩过三次
  （muscriptor_instruments / beat_grid / max_note_hold 都曾在别处漏过一跳）。

★ 为什么**只在给了覆盖时才加**：没给覆盖（绝大多数情况）必须沿用旧名字，
  否则一次升级会把所有已有的乐句缓存作废、全部重渲一遍。
"""

import os
import zlib


def vocoder_tag(vocoder):
    """声码器覆盖的短标签（8 位十六进制）；没给覆盖时返回空串。

    用 realpath 的小写做 crc32 —— 同一个声码器换个写法（大小写/相对路径）也要落到同一个
    文件名上，否则会出现"同一份缓存存了两遍"。
    """
    if not vocoder:
        return ''
    try:
        p = os.path.realpath(str(vocoder)).lower()
    except Exception:
        p = str(vocoder).lower()
    return '%08x' % (zlib.crc32(p.encode('utf-8', 'replace')) & 0xffffffff)


def phrase_cache_name(phrase_hash, depth, steps, vocoder=None):
    """乐句 wav 的文件名（含声码器标签，若有覆盖）。"""
    tag = vocoder_tag(vocoder)
    base = 'ds-%016x-depth%.2f-steps%d' % (phrase_hash, depth, steps)
    return base + ('-voc' + tag if tag else '') + '.wav'
