# -*- coding: utf-8 -*-
"""验证 `Classic/Flags/UstFlagParser`（.ust 导入导出的前置件）。

用 C# 的真实用例逐条比对：`Parse` 的循环边界、单字符 flag、数值解析失败、
以及那个 `continue` 跳过 `wasDigit = False` 的上游行为。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.classic.ust_flag import UstFlag, UstFlagParser  # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def p(text):
    return [str(f) for f in UstFlagParser().parse(text)]


def main():
    # ★ 上游参考在 <repo>/_ref/OpenUtau；tests 的上两级是 <repo>/engine 的上一级
    repo = os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))
    cs_path = os.path.join(repo, '_ref', 'OpenUtau', 'OpenUtau.Core',
                           'Classic', 'Flags', 'UstFlagParser.cs')
    flag_cs = os.path.join(os.path.dirname(cs_path), 'UstFlag.cs')
    src = open(cs_path, encoding='utf-8-sig').read().replace('\r\n', '\n') \
        if os.path.isfile(cs_path) else ''

    # ---------------- 源码一致性
    check('源码: 循环跑到 text.Length（含）', 'i <= text.Length' in src, cs_path)
    check('源码: flush 条件是 || 与 && 的组合',
          "char.IsLetter(text[i]) || text[i] == '/') && wasDigit" in src)
    check('源码: 单字符 flag 只有 N / e / u', "{ 'N', 'e', 'u' }" in src.replace('"', "'"))
    check('源码: 数值解析失败一律当 0', 'value = 0;' in src)
    check('源码: 单字符 flag 命中后 continue（不重置 wasDigit）',
          'flags.Add(new UstFlag(c.ToString(), 0));' in src and 'continue;' in src)
    if os.path.isfile(flag_cs):
        check('源码: UstFlag.ToString 是 Key + Value（无分隔符）',
              'return Key + Value;' in open(flag_cs, encoding='utf-8-sig').read())

    # ---------------- ToString
    check('UstFlag("g", 0) → "g0"', str(UstFlag('g', 0)) == 'g0', str(UstFlag('g', 0)))
    check('UstFlag("H", -5) → "H-5"', str(UstFlag('H', -5)) == 'H-5', str(UstFlag('H', -5)))

    # ---------------- 基本解析
    check('空串 → []', p('') == [] and p(None) == [])
    check('"g0" → ["g0"]', p('g0') == ['g0'], p('g0'))
    check('"g0B0" → ["g0","B0"]', p('g0B0') == ['g0', 'B0'], p('g0B0'))
    check('"g0B100H-5" → ["g0","B100","H-5"]',
          p('g0B100H-5') == ['g0', 'B100', 'H-5'], p('g0B100H-5'))
    check('★ "H-5.5" → ["H-55"]（"." 既不进 value 也不进 key，被**静默丢弃**，'
          '于是两个 5 拼成 -55）',
          p('H-5.5') == ['H-55'], p('H-5.5'))

    # ---------------- 单字符 flag（N/e/u）
    check('★ "N" → ["N0"]（单字符 flag 立即产出，无数值）', p('N') == ['N0'], p('N'))
    check('★ "N5" → ["N0"]（5 进了 value 但 key 为空 → 末尾 flush 时不产出）',
          p('N5') == ['N0'], p('N5'))
    check('"g0Ne" → ["g0","N0","e0"]', p('g0Ne') == ['g0', 'N0', 'e0'], p('g0Ne'))
    check('"u" → ["u0"]', p('u') == ['u0'], p('u'))
    check('★ 非单字符 flag 走 key 累积："V" → ["V0"]（无数字，末尾 flush 时 value 兜 0）',
          p('V') == ['V0'], p('V'))

    # ---------------- 数值解析失败
    check('★ "g-" → ["g0"]（"-" 解析失败按 0）', p('g-') == ['g0'], p('g-'))
    check('"g+" → ["g0"]', p('g+') == ['g0'], p('g+'))

    # ---------------- key 为空不产出
    check('★ 纯数字 "123" → []（key 为空 → 不产出）', p('123') == [], p('123'))
    check('★ 以数字开头 "5g0" → ["g0"]（5 被丢弃）', p('5g0') == ['g0'], p('5g0'))

    # ---------------- 斜杠
    check('斜杠算 flag 名的一部分："p/" → ["p/0"]', p('p/') == ['p/0'], p('p/'))

    # ---------------- 尾部无数值
    check('"g" → ["g0"]（结尾无数字）', p('g') == ['g0'], p('g'))

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())