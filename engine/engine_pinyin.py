#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""汉字 → 拼音（无声调）。

「调教」页的中文声库要用它：
  * UTAU 中文声库的别名就是拼音（a / ai / bu / hao…），引擎按别名逐字查 oto，
    不转拼音就只能唱 ASCII；
  * DiffSinger 引擎内部自带 pypinyin（见 engine_diffsinger.py），不需要这一步。

协议与其它引擎一致：stdout 打一行 `###RESULT {json}`。

用法：
  python engine_pinyin.py --tokens '["不","爱","G"]'
  python engine_pinyin.py --text '不爱的'
"""
import argparse
import json
import sys


def _result(obj, code=0):
    sys.stdout.write('###RESULT ' + json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    return code


def _to_pinyin(text):
    """一个 token → 音节列表（非汉字逐字符返回，保证不丢字）。"""
    from pypinyin import lazy_pinyin, Style
    items = lazy_pinyin(text, style=Style.NORMAL, errors=lambda x: list(x))
    out = []
    for it in items:
        s = str(it).strip()
        if s:
            out.append(s)
    return out


def main():
    ap = argparse.ArgumentParser(description='汉字 → 拼音（无声调）')
    ap.add_argument('--tokens', default=None, help='JSON 数组：逐个 token 转（推荐，保持与音符一一对应）')
    ap.add_argument('--text', default=None, help='整段文本（按字转）')
    args = ap.parse_args()
    try:
        from pypinyin import lazy_pinyin  # noqa: F401  仅探测依赖
    except Exception as e:  # noqa: BLE001
        return _result({'ok': False, 'error': '缺少 pypinyin：%s' % e}, 1)
    try:
        if args.tokens is not None:
            toks = json.loads(args.tokens)
            if not isinstance(toks, list):
                raise ValueError('tokens 应为 JSON 数组')
            per = [_to_pinyin(str(x)) for x in toks]
        elif args.text is not None:
            per = [_to_pinyin(str(args.text))]
        else:
            raise ValueError('需要 --tokens 或 --text')
    except Exception as e:  # noqa: BLE001
        return _result({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}, 1)
    flat = [s for grp in per for s in grp]
    return _result({'ok': True, 'syllables': flat, 'per_token': per,
                    'tokens': len(per), 'count': len(flat)})


if __name__ == '__main__':
    sys.exit(main())