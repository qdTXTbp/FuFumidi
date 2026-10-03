# -*- coding: utf-8 -*-
"""验证 11 个标准布局 G2p（10 个生成的 + Korean 手写）。

三条主线：
  1. **表保真**：逐项比对每个模块的 `GRAPHEMES`/`PHONEMES` 与 C# 源码里的字面量序列；
     并确认 `LoadPack` 的 prep 参数与源码一致（这是本轮真实踩过的坑）。
  2. **模型 + 构造**：用上游**真实的** `g2p-*.zip` 构造每个 G2p，跑一次真查询。
  3. **占位约定**：索引从 4 起；`phones.txt` 与音素表对齐。
"""
import importlib
import io
import os
import re
import shutil
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.g2p import models                          # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _repo():
    return os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))


def _cs(name):
    p = os.path.join(_repo(), '_ref', 'OpenUtau', 'OpenUtau.Core', 'G2p', name)
    return io.open(p, encoding='utf-8-sig').read().replace('\r\n', '\n') \
        if os.path.isfile(p) else ''


#: (C# 文件, Python 模块, 类名, 预期 prep_grapheme, 预期 prep_phoneme)
TARGETS = (
    ('FilipinoG2p.cs', 'filipino', 'FilipinoG2p', 'lower', 'lower_rmtail'),
    ('FrenchG2p.cs', 'french', 'FrenchG2p', 'identity', 'identity'),
    ('FrenchMillefeuilleG2p.cs', 'french_millefeuille', 'FrenchMillefeuilleG2p',
     'identity', 'identity'),
    ('GermanG2p.cs', 'german', 'GermanG2p', 'identity', 'identity'),
    ('GermanMarzipanG2p.cs', 'german_marzipan', 'GermanMarzipanG2p',
     'identity', 'identity'),
    ('ItalianG2p.cs', 'italian', 'ItalianG2p', 'identity', 'rmtail'),
    ('PortugueseG2p.cs', 'portuguese', 'PortugueseG2p', 'identity', 'identity'),
    ('RussianG2p.cs', 'russian', 'RussianG2p', 'identity', 'identity'),
    ('SpanishG2p.cs', 'spanish', 'SpanishG2p', 'lower', 'identity'),
    ('ArpabetPlusG2p.cs', 'arpabet_plus', 'ArpabetPlusG2p', 'lower', 'lower_rmtail'),
)

_ARRAY_RE = re.compile(
    r'private static readonly string\[\]\s+(\w+)\s*=\s*new string\[\]\s*\{(.*?)\};', re.S)


def _cs_arrays(src, key):
    for m in _ARRAY_RE.finditer(src):
        if m.group(1) == key:
            return re.findall(r'"((?:[^"\\]|\\.)*)"', m.group(2))
    return None


def _prep_text(mod_src):
    """从生成的 Python 里取出 `self.load_pack(data, X, Y)` 的两个 prep 表达式。

    ★ 必须匹配到**行尾**：早先用非贪婪 `(.+?)\)`，会在 `remove_tail_digits(` 的
      那个左括号处截断，把 `...s.lower()` 截成 `...s.lower(`，导致分类误判。
    """
    m = re.search(r'self\.load_pack\(data,(.*)\)\s*$', mod_src, re.M)
    if not m:
        return None, None
    parts = [x.strip() for x in m.group(1).split(', ')]
    return (parts[0] if parts else None, parts[1] if len(parts) > 1 else None)


def _classify(expr):
    if expr is None:
        return 'identity'
    e = expr.replace(' ', '')
    if e in ('None', 'lambda s:s'):
        return 'identity'
    # 生成出来的 Python 写的是 `s.lower()`，C# 原文是 `s.ToLowerInvariant()` —— 两种都要认
    low = 'tolower' in e or '.lower()' in e
    tail = 'removetaildigits' in e or 'remove_tail_digits' in e
    if low and tail:
        return 'lower_rmtail'
    if tail:
        return 'rmtail'
    if low:
        return 'lower'
    return 'identity'


def main():
    # ---------------- 1. 生成器幂等
    print('--- 生成器 ---')
    import subprocess
    # ★ 用 __file__ 推包路径：`_ref` 在仓库**之外**（<repo>/_ref），而生成器在
    #   仓库**之内**（FuFumidi/engine/...），用 _repo() 拼会少一层。
    gen = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                       'singing', 'openutau', 'g2p', '_gen_g2p_modules.py')
    r = subprocess.run([sys.executable, gen], capture_output=True, text=True)
    out = r.stdout or ''
    check('生成器可重复运行', r.returncode == 0, out or r.stderr)
    check('★ 重跑后 10 个模块全部"已是最新"（表与上游一致、没被手改）',
          out.count('已是最新') == 10, out)

    # ★ 先装 ONNX 会话工厂再建实例：G2p 的 `session` 是**进程级缓存**里的一部分，
    #   一旦在"没装工厂"时构造过，缓存里就是 session=None，之后再装工厂也不生效
    #   （必须 reset_cache 后重建）。生产上也是启动时装，所以这里照做。
    print('--- ONNX 会话工厂 ---')
    factory_ok = models.install_onnx_session_factory()
    check('装 ONNX 会话工厂（本机有 onnxruntime → True）', factory_ok is True)

    # ---------------- 2. 逐个 G2p 校验
    print('--- 逐个 G2p：表保真 + prep 参数 + 真实模型构造 ---')
    for cs_name, mod_name, cls_name, exp_g, exp_p in TARGETS:
        src = _cs(cs_name)
        mod = importlib.import_module('singing.openutau.g2p.' + mod_name)
        mod_src = io.open(mod.__file__, encoding='utf-8').read()

        # 2a. 表逐项一致
        for key, attr in (('graphemes', 'GRAPHEMES'), ('phonemes', 'PHONEMES')):
            want = _cs_arrays(src, key)
            got = list(getattr(mod, attr))
            check('%-22s %s 逐项一致（%d 项）' % (mod_name, key, len(want)),
                  want == got, _first_diff(want, got))

        # 2b. prep 参数（★ 本轮真实踩过的坑）
        g_expr, p_expr = _prep_text(mod_src)
        check('%-22s prepGrapheme=%s / prepPhoneme=%s' % (mod_name, exp_g, exp_p),
              _classify(g_expr) == exp_g and _classify(p_expr) == exp_p,
              (_classify(g_expr), _classify(p_expr), g_expr, p_expr))

        # 2c. 资源名与包名对应
        want_res = re.search(r'Data\.Resources\.(g2p_[a-z_]+)', src)
        want_pack = 'g2p-' + want_res.group(1)[len('g2p_'):].replace('_', '-') + '.zip'
        check('%-22s PACK_NAME=%s' % (mod_name, want_pack),
              mod.PACK_NAME == want_pack, mod.PACK_NAME)

        # 2d. 真实模型构造 + 查询
        if not models.model_available(mod.PACK_NAME):
            check('%-22s 模型 %s 就位' % (mod_name, mod.PACK_NAME), False)
            continue
        cls = getattr(mod, cls_name)
        try:
            cls.reset_cache()
        except AttributeError:
            pass
        try:
            g = cls()
        except Exception as e:                                # noqa: BLE001
            check('%-22s 构造成功' % mod_name, False, repr(e)[:120])
            continue
        check('%-22s 构造成功（词典已建、%d 字素 / %d 音素）'
              % (mod_name, len(g.grapheme_indexes), len(g.phonemes)),
              g.dict is not None and len(g.grapheme_indexes) == len(mod.GRAPHEMES) - 4)
        # 索引下标从 4 起
        if g.grapheme_indexes:
            check('%-22s 索引最小值是 4（前 4 个空串占位）' % mod_name,
                  min(g.grapheme_indexes.values()) == 4,
                  min(g.grapheme_indexes.values()))
        # ★ 神经网络 G2p 的 `dict.txt` 收的是**整词**（多字符），单个字素查不到 ——
        #   所以要**从 dict.txt 里取真词**来查，不能拿 grapheme_indexes 的键去试。
        words = []
        with zipfile.ZipFile(io.BytesIO(models.load_model_bytes(mod.PACK_NAME))) as z:
            for line in z.read('dict.txt').decode('utf-8').splitlines():
                if line.startswith(';;;'):
                    continue
                parts = line.strip().split('  ')
                if len(parts) == 2:
                    words.append(parts[0])
        # ★ 查词必须施加 prep_grapheme：`lower` 型 G2p 的词典键是**小写**的
        prep_g = _classify(_prep_text(mod_src)[0])
        words = [w.lower() for w in words] if prep_g == 'lower' else words
        hit = None
        for w in words:
            q = g.query(w)
            if q:
                hit = (w, q)
                break
        check('%-22s 能从 dict.txt 取词查到音素（如 %r）' % (mod_name, hit[0] if hit else None),
              hit is not None)

    # ---------------- 3. 占位约定：音素表尾部与 phones.txt 对齐
    print('--- 占位约定 ---')
    for cs_name, mod_name, _cls, _g, _p in TARGETS[:3]:
        mod = importlib.import_module('singing.openutau.g2p.' + mod_name)
        data = models.load_model_bytes(mod.PACK_NAME)
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            names = z.namelist()
            check('%-22s 模型是标准布局（含 g2p.onnx）' % mod_name,
                  'g2p.onnx' in names and 'dict.txt' in names, names)
            phones = [ln.strip().split()[0] for ln in
                      z.read('phones.txt').decode('utf-8').splitlines()
                      if len(ln.strip().split()) == 2]
        # 有的 G2p 音素表比 phones.txt 多（多出来的不是占位），所以只验证"是子序列/前缀关系"
        # ★ 概念澄清：`phonemes` 是**神经网络的输出字母表**，`phones.txt` 是
        #   **词典的音素库存**，两者**本就不必相同**（french_millefeuille 第 13 项
        #   就是 phones='aa' 而表里是 'uy'）。所以别断言两者相等，改断言真正的不变式。
        mod = importlib.import_module('singing.openutau.g2p.' + mod_name)
        check('%-22s PHONEMES 前 4 项是空串占位' % mod_name,
              tuple(mod.PHONEMES[:4]) == ('', '', '', ''), mod.PHONEMES[:4])
        # 词典里应当认得 phones.txt 里的音素（施加 prepPhoneme 后）
        prep_p = _classify(_prep_text(mod_src)[1])
        g = getattr(mod, _cls_of(mod_name))()
        probe = [x.lower() for x in phones] if prep_p in ('lower', 'lower_rmtail') else phones
        known = sum(1 for x in probe if g.dict.is_valid_symbol(x))
        check('%-22s 词典认得 phones.txt 里的音素（%d/%d）' % (mod_name, known, len(probe)),
              known >= len(probe) * 0.9, (known, len(probe)))

    # ---------------- 4. ONNX 推理端到端（本轮真抓到 3 个潜伏 bug 的地方）
    print('--- ONNX 推理（真跑模型）---')
    if not factory_ok:
        check('跳过推理部分（没有 onnxruntime）', True)
    else:
        # ★ 三个曾经潜伏的 bug，各用一条断言钉住：
        #   ① run() 的第一个位置参数是"输出名"（不传就崩）
        #   ② 输入 dtype 必须 int32（numpy 默认 int64 会被模型拒）
        #   ③ 输出 shape 是 [1]（取 [0][0]，不是 [0][0][0]）
        for mod_name, cls_name, word, want_any in (
                ('korean', 'KoreanG2p', '한국', ('h', 'k', 'g', 'a')),
                ('french', 'FrenchG2p', 'bonjour', ('bb', 'on', 'jj', 'ou', 'rr')),
                ('russian', 'RussianG2p', 'привет', ('p', 'r', 'i', 'v')),
                ('spanish', 'SpanishG2p', 'hola', ('o', 'l', 'a')),
                ('italian', 'ItalianG2p', 'ciao', ('a', 'o', 'i'))):
            mod = importlib.import_module('singing.openutau.g2p.' + mod_name)
            try:
                mod.reset_cache()
            except AttributeError:
                pass
            g = getattr(mod, cls_name)()
            check('%-10s session 已建立（ONNX）' % mod_name, g.session is not None)
            pred = g.predict(word)
            check('★ %-10s predict(%r) 出结果 %r' % (mod_name, word, pred),
                  bool(pred) and any(x in want_any for x in pred), pred)
        # 韩语的谚文分解（这是它覆写 predict 的唯一理由）
        from singing.openutau.g2p.korean import try_divide_hangeul
        for ch, want in (('가', 'ㄱㅏ '), ('한', 'ㅎㅏㄴ'), ('글', 'ㄱㅡㄹ')):
            check('谚文分解 %s → %r' % (ch, want), try_divide_hangeul(ch) == want,
                  try_divide_hangeul(ch))
        check('非谚文字符返回 None', try_divide_hangeul('a') is None)
        check('区外码点 U+D7A0 返回 None', try_divide_hangeul(chr(0xD7A0)) is None)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


def _cls_of(mod_name):
    for _cs, m, cls, _g, _p in TARGETS:
        if m == mod_name:
            return cls
    raise KeyError(mod_name)


def _first_diff(a, b):
    for i in range(max(len(a), len(b))):
        x = a[i] if i < len(a) else '<缺>'
        y = b[i] if i < len(b) else '<缺>'
        if x != y:
            return '第 %d 项不同: C#=%r Python=%r' % (i, x, y)
    return '长度不同: %d vs %d' % (len(a), len(b))


if __name__ == '__main__':
    sys.exit(main())