# -*- coding: utf-8 -*-
"""G2p 模型装载 + 日语单音 G2P 的**端到端**验证。

这个测试的意义：证明「模型 zip → 词典 → 查词」整条链在**本机真的通**，
而不只是类写对了。跑的是上游仓库里真实的 `g2p-ja-mono.zip`（11KB）。
"""
import io
import os
import shutil
import sys
import tempfile
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.g2p import models                          # noqa: E402
from singing.openutau.g2p.japanese_monophone import (            # noqa: E402
    GRAPHEMES, PHONEMES, JapaneseMonophoneG2p, build_grapheme_indexes)

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _repo():
    return os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))


def _src():
    p = os.path.join(_repo(), '_ref', 'OpenUtau', 'OpenUtau.Core', 'G2p',
                     'JapaneseMonophoneG2p.cs')
    return open(p, encoding='utf-8-sig').read().replace('\r\n', '\n') \
        if os.path.isfile(p) else ''


def main():
    src = _src()

    # ---------------- 源码一致性
    print('--- 源码一致性 ---')
    check('源码: 覆写 LoadPack（自定义 zip 布局）', 'protected Tuple<IG2p, InferenceSession> LoadPack(' in src)
    check('★ 源码: 读 4 份词典、不读 g2p.onnx',
          all(('Zip.ExtractText(data, "%s")' % n) in src
              for n in ('hiragana.txt', 'katakana.txt', 'romaji.txt', 'special.txt'))
          and 'g2p.onnx' not in src)
    # ★ 同一属性被赋 4 次（上游死代码），逐个确认真的在
    check('★ 源码: Dict 被赋给 4 个静态变量（死代码，照搬）',
          all(('Dict = %s;' % v) in src
              for v in ('hiragana', 'katakana', 'romaji', 'special')), src.count('Dict = '))
    check('源码: graphemeIndexes 用 Skip(4) + i + 4',
          'graphemes\n                        .Skip(4)' in src
          and 't.Item2 + 4' in src)
    check('源码: 构造时 lock + 静态缓存', 'lock (lockObj)' in src
          and 'if (graphemeIndexes == null)' in src)

    # ---------------- 表的完整性
    print('--- 静态表 ---')
    # ★ 真实长度是 188 / 52（我最初目测写成 170 / 48，被自己的测试打脸）。
    #   下面用「与 zip 里的 phones.txt 对齐」来钉死，而不是写死数字 ——
    #   这样上游改表时会立刻红，比硬编码长度可靠得多。
    check('graphemes 188 项、前 4 项是空串占位',
          len(GRAPHEMES) == 188 and GRAPHEMES[:4] == ('', '', '', ''), len(GRAPHEMES))
    check('phonemes 52 项、前 4 项是空串占位',
          len(PHONEMES) == 52 and PHONEMES[:4] == ('', '', '', ''), len(PHONEMES))
    check('字素含平假名/片假名/气息音/连音符/休止符',
          all(s in GRAPHEMES for s in ('あ', 'ん', 'ア', 'ン', '息', '吸', '-', 'R')))
    gi = build_grapheme_indexes()
    check('★ build_grapheme_indexes 的下标从 4 起（Skip(4)+i+4 的结果）',
          gi['あ'] == 4 + GRAPHEMES[4:].index('あ') and min(gi.values()) == 4,
          (min(gi.values()), gi.get('あ')))
    check('空串（前 4 个占位）不进索引表', '' not in gi)

    # ---------------- 模型发现
    print('--- 模型装载 ---')
    found = models.find_model('g2p-ja-mono.zip')
    check('★ 在开发环境能找到上游的 g2p-ja-mono.zip（无需复制 25MB）',
          found is not None, models.search_paths())
    if not found:
        print()
        print('结果: %d passed, %d failed' % (len(_P), len(_F)))
        return 1
    data = models.load_model_bytes('g2p-ja-mono.zip')
    check('读出的字节是合法 zip', zipfile.is_zipfile(io.BytesIO(data)), len(data))
    names = models.zip_names(data)
    check('★ zip 里是 4 份词典 + phones.txt，且**没有** g2p.onnx',
          set(names) == {'hiragana.txt', 'katakana.txt', 'romaji.txt', 'special.txt',
                         'phones.txt'},
          names)
    check('has_onnx 判定为 False（纯词典）', models.has_onnx(data) is False)
    check('13 个模型名都在清单里', len(models.MODEL_FILES) == 13)
    check('语种→模型映射覆盖 13 个', len(models.MODEL_BY_LANG) == 13
          and models.MODEL_BY_LANG['ja_mono'] == 'g2p-ja-mono.zip')
    check('list_available 能列出可用性（不抛）', isinstance(models.list_available(), dict))

    # 找不到时的报错要能自解释
    try:
        models.load_model_bytes('g2p-不存在.zip')
        check('找不到模型时抛 FileNotFoundError', False)
    except FileNotFoundError as e:
        check('★ 找不到模型时的报错列出了搜索过的目录', '已搜索' in str(e), str(e)[:120])

    # ---------------- 端到端：真查词
    print('--- 端到端（真词典查询）---')
    g = JapaneseMonophoneG2p(pack=data)
    check('构造成功，词典已建', g.dict is not None)
    check('★ session 为 None（这个 G2p 不走神经网络）', g.session is None, g.session)
    check('字素表/音素表已填（索引数 = 字素数 - 4 个占位）',
          len(g.grapheme_indexes) == len(GRAPHEMES) - 4
          and len(g.phonemes) == len(PHONEMES),
          (len(g.grapheme_indexes), len(g.phonemes)))
    # ★ 最强的一条：音素表去掉前 4 个占位后，必须与 zip 里 phones.txt 的第一列**逐项相同**。
    #   这既验证了「前 4 个空串是占位约定」，也验证了表没抄错。
    with zipfile.ZipFile(io.BytesIO(data)) as _z:
        _phones = [ln.strip().split()[0] for ln in
                   _z.read('phones.txt').decode('utf-8').splitlines()
                   if len(ln.strip().split()) == 2]
    check('★ PHONEMES[4:] 与 zip 里 phones.txt 的符号列**逐项一致**（表没抄错）',
          list(PHONEMES[4:]) == _phones,
          (list(PHONEMES[4:])[:6], _phones[:6], len(PHONEMES[4:]), len(_phones)))

    # ★ 片假名在词典里映射到**大写**元音（`ア  A`），不是小写 `a` —— 这是数据本身如此
    for kana, expect_first in (('あ', 'a'), ('ん', 'N'), ('ア', 'A'), ('か', 'k'),
                               ('きゃ', 'ky')):
        got = g.query(kana)
        ok = bool(got) and got[0] == expect_first
        check('query(%r) → %r' % (kana, expect_first), ok, got)
    check('predict 在没有 session 时返回空数组（照搬 C# 的 Session==null 分支）',
          g.predict('あ') == [], g.predict('あ'))
    # is_valid_symbol 判的是**音素符号**（来自 phones.txt），不是字素。
    # 所以 'あ'（字素）返回 False、'a'（音素）返回 True —— 别拿字素去试。
    check('is_valid_symbol 判的是音素符号而非字素：a→True / あ→False',
          g.is_valid_symbol('a') is True and g.is_valid_symbol('あ') is False,
          (g.is_valid_symbol('a'), g.is_valid_symbol('あ')))
    check('未登录字素返回 None', g.query('ZZZ') is None, g.query('ZZZ'))

    # 四份词典都进了同一个 builder（ひらがな/カタカナ/romaji/special 各能查到）
    check('★ 四份词典都进了同一个词典（平假名/片假名/罗马字/特殊 都能查）',
          all(g.query(x) for x in ('あ', 'ア', 'a', '息')),
          [g.query(x) for x in ('あ', 'ア', 'a', '息')])

    # 缓存：再构造一次应复用
    g2 = JapaneseMonophoneG2p()
    check('第二次构造走进程级缓存（dict 同一对象）', g2.dict is g.dict)

    # ---------------- ONNX 会话工厂（另 12 个要用）
    print('--- ONNX 会话工厂（供神经网络 G2p 用）---')
    ok = models.install_onnx_session_factory()
    check('装 ONNX 会话工厂（开发机有 onnxruntime → True）', ok is True)
    from singing.openutau.g2p import pack as packmod
    check('工厂已注册到 pack 模块', packmod._SESSION_FACTORY is not None)

    # ---------------- 打包接线（防"代码在、模型没进包"）
    print('--- 打包接线 ---')
    res = os.path.join(_repo(), 'FuFumidi', 'resources')
    g2p_dir = os.path.join(res, 'g2p')
    check('★ resources/g2p/ 存在且含全部 13 个模型',
          os.path.isdir(g2p_dir) and len(models.MODEL_FILES) == 13
          and sum(1 for f in models.MODEL_FILES if os.path.isfile(os.path.join(g2p_dir, f))) == 13,
          sorted(os.listdir(g2p_dir))[:4] if os.path.isdir(g2p_dir) else '目录不存在')
    # ★ 必须与 python/ 互为兄弟（打包后 <app>/resources/{python,g2p}）
    check('★ resources/g2p 与 resources/python 互为兄弟目录（models.py 的路径推导依赖这一点）',
          os.path.isdir(os.path.join(res, 'python')) and os.path.isdir(g2p_dir))
    # electron-builder 必须把 resources/g2p 分发到 win-unpacked（resources/** 已排除出 asar）
    yml = os.path.join(_repo(), 'FuFumidi', 'electron-builder.yml')
    txt = io.open(yml, encoding='utf-8').read() if os.path.isfile(yml) else ''
    check('★ electron-builder.yml 的 extraResources 含 resources/g2p → g2p',
          'from: "resources/g2p"' in txt and 'to: g2p' in txt)
    check('resources/** 仍被排除出 asar（否则 25MB 会重复进包）',
          '"!resources/**"' in txt)
    # 引擎启动必须装会话工厂
    eng = io.open(os.path.join(_repo(), 'FuFumidi', 'engine', 'engine_openutau.py'),
                  encoding='utf-8').read()
    check('★ 引擎 main() 里调用了 setup_g2p（进程级接线）',
          'def setup_g2p(' in eng and '    setup_g2p()' in eng)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())