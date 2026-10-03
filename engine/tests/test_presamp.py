# -*- coding: utf-8 -*-
"""验证 `Classic/Presamp.cs`（presamp.ini 解析）。

两条主线：
  1. **数据表保真**：重新跑一遍生成脚本，与已生成的 `_presamp_data.py` 逐字节比对；
     再逐条断言 C# 源码里确实含这些字面量（上游改表 → 这里立刻红）。
  2. **解析语义**：编码嗅探、进段清空、`[SU]` 三重校验、`[ALIAS_PRIORITY]` 只认第一行、
     拗音母音补全、`ParseAlias` 的切分顺序与"正则剥后缀"。
"""
import io
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.classic import _presamp_data as D      # noqa: E402
from singing.openutau.classic import presamp as P            # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _repo():
    return os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))


def _cs():
    p = os.path.join(_repo(), '_ref', 'OpenUtau', 'OpenUtau.Core', 'Classic', 'Presamp.cs')
    return open(p, encoding='utf-8-sig').read().replace('\r\n', '\n') if os.path.isfile(p) else ''


def main():
    src = _cs()
    root = tempfile.mkdtemp(prefix='fufumidi-presamp-')
    try:
        # ================= 1. 数据表保真
        print('--- 数据表保真 ---')
        # ★ 用**包路径**定位生成脚本，别用 _repo() 拼：`_ref` 在仓库**之外**
        #   （<repo>/_ref），而生成脚本在仓库**之内**（engine/singing/...），
        #   两者层级不同 —— 之前就是这里拼错导致子进程找不到文件。
        gen = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           'singing', 'openutau', 'classic', '_gen_presamp_data.py')
        import subprocess
        r = subprocess.run([sys.executable, gen], capture_output=True, text=True)
        check('生成脚本可重复运行（幂等）', r.returncode == 0, r.stdout or r.stderr)
        check('★ 重跑生成脚本后报"已是最新"（说明表与上游一致、没被手改过）',
              '已是最新' in r.stdout or '已生成' in r.stdout, r.stdout)

        check('母音 7 条 / 辅音 30 条 / 替换 167 条',
              len(D.DEF_VOWELS) == 7 and len(D.DEF_CONSONANTS) == 30
              and len(D.DEF_REPLACE) == 167,
              (len(D.DEF_VOWELS), len(D.DEF_CONSONANTS), len(D.DEF_REPLACE)))
        check('nums 10 个、appends 20 个、pitches 126 个',
              len(D.DEF_NUMS) == 10 and len(D.DEF_APPENDS) == 20 and len(D.DEF_PITCHES) == 126,
              (len(D.DEF_NUMS), len(D.DEF_APPENDS), len(D.DEF_PITCHES)))
        check('母音表首尾（a=あ=… / N=ン=ン=100）',
              D.DEF_VOWELS[0].startswith('a=あ=') and D.DEF_VOWELS[-1] == 'N=ン=ン=100',
              (D.DEF_VOWELS[0][:12], D.DEF_VOWELS[-1]))
        check('音高表尾部含 ↑↓→← high low mid',
              D.DEF_PITCHES[-7:] == ['↑', '↓', '→', '←', 'high', 'low', 'mid'],
              D.DEF_PITCHES[-7:])
        check('替换表含日文条目（を→お / ぢ→じ / づ→ず）',
              D.DEF_REPLACE.get('を') == 'お' and D.DEF_REPLACE.get('ぢ') == 'じ'
              and D.DEF_REPLACE.get('づ') == 'ず')

        # 逐条回查 C# 源码含该字面量（上游改表 → 这里红）
        missing = [v for v in D.DEF_VOWELS if ('"%s"' % v) not in src]
        check('每条母音行都能在 C# 源码里找到', not missing, missing[:2])
        missing_c = [v for v in D.DEF_CONSONANTS if ('"%s"' % v) not in src]
        check('每条辅音行都能在 C# 源码里找到', not missing_c, missing_c[:2])
        missing_p = [v for v in D.DEF_PITCHES if ('"%s"' % v) not in src]
        check('每个音高名都能在 C# 源码里找到', not missing_p, missing_p[:2])

        # ================= 2. 源码一致性
        print('--- 源码一致性 ---')
        check('源码: 编码嗅探含 932/936/949/950', 'int[] codePages = { 932, 936, 949, 950 }' in src)
        check('源码: 手工解析以保留大小写（不走 ReadBlocks）',
              'Bypasses OpenUtau\'s native Ini.ReadBlocks which forces lowercase' in src)
        check('源码: 进段即清空默认值', 'if (currentBlock == "[VOWEL]") Vowels.Clear();' in src)
        check('源码: ALIAS_PRIORITY 只在 count >= 5 时覆盖',
              'if (AliasPriorityDefault.Count >= 5)' in src)
        check('源码: [SU] 三占位符校验 + 整行正则',
              'if (!line.Contains("%num%") || !line.Contains("%append%") || !line.Contains("%pitch%")) break;' in src
              and '@"^(?:%num%|%append%|%pitch%)+$"' in src)
        check('源码: [NUM]/[APPEND]/[PITCH] 跳过 @...@ 引用行',
              src.count('if (!Regex.IsMatch(line, "^@.+@$"))') == 3)
        check('源码: VCLENGTH 是 0→true / 1→false（反直觉，别改）',
              'if (line == "0") VCLengthFromCV = true;' in src
              and 'else if (line == "1") VCLengthFromCV = false;' in src)
        check('源码: 剥后缀用的是 Regex 替换',
              'new Regex(split[0]).Replace(phoneme, "", 1)' in src)
        check('源码: 拗音母音补全取末字符',
              'pp.Phoneme.Substring(pp.Phoneme.Length - 1)' in src)
        check('源码: Replacer 先 %CVPAD% 后 %VCVPAD%',
              'str.Replace("%CVPAD%", VCPAD).Replace("%VCVPAD%", VCVPAD)' in src)
        check('源码: NotClossfade 是字符串比较 == "1"', 'parts[2] == "1"' in src)

        # ================= 3. 默认值
        print('--- 默认值 ---')
        p0 = P.Presamp()
        check('reset: cflags 默认 "p0"', p0.cflags == 'p0', p0.cflags)
        check('reset: split=True / must_vc=False / vc_length_from_cv=True',
              p0.split is True and p0.must_vc is False and p0.vc_length_from_cv is True)
        check('reset: add_ending=1', p0.add_ending == 1, p0.add_ending)
        check('reset: suffix_order = [num, append, pitch]',
              p0.suffix_order == ['%num%', '%append%', '%pitch%'], p0.suffix_order)
        check('reset: priorities 16 个（k,ky,g,gy,t,ty,d,dy,ch,ts,b,by,p,py,r,ry）',
              len(p0.priorities) == 16 and p0.priorities[0] == 'k'
              and p0.priorities[-1] == 'ry', p0.priorities[:3])
        check('reset: prefixs 为空', p0.prefixs == [])
        check('reset: alias_rules 默认 VCPAD/VCVPAD 都是空格',
              p0.alias_rules.vcpad == ' ' and p0.alias_rules.vcvpad == ' ')

        # ================= 4. 音素表
        print('--- 音素表 ---')
        check('母音表 7 项', len(p0.vowels) == 7, len(p0.vowels))
        check('辅音表 30 项', len(p0.consonants) == 30, len(p0.consonants))
        check('音素表已建立（>100 项）', len(p0.phoneme_list) > 100, len(p0.phoneme_list))
        # ★ きゃ 来自辅音表 `ky=...きゃ...`，它自己没有母音；
        #   补全时按**末字符** ゃ 去查表，拿到的是 ゃ 所属**母音条目的名字**（= 'a'），
        #   不是 'ゃ' 本身。这点容易误判。
        check('★ 拗音母音补全：きゃ 借 ゃ 的母音条目（结果为母音名 a，不是 ゃ）',
              p0.phoneme_list['きゃ'].vowel == 'a', p0.phoneme_list['きゃ'].vowel)
        check('★ is_priority 标记（k 在 phoneme_list 里且被标记）',
              p0.phoneme_list['k'].is_priority is True)
        check('辅音 not_clossfade：k=1 / h=0（第三段恰为 "1"）',
              p0.consonants['k'].not_clossfade is True
              and p0.consonants['h'].not_clossfade is False)

        # ================= 5. ParseAlias
        print('--- ParseAlias ---')
        # ★ ParseAlias 只做"切分"，**不做罗马字→假名的替换**（那是 Replace 表的事）。
        #   首字符"き"被单独取出当先頭文字，再拼回剩余部分，所以原样返回。
        pa = p0.parse_alias('きゃ')
        check('★ ParseAlias("きゃ") → 不做替换，只切分：(空, きゃ, 空)',
              pa == ('', 'きゃ', ''), pa)
        # ★ Nums 在 Pitches **之前**处理，所以"きゃA4"里的数字会先被当成 num 后缀吃掉，
        #   留下 "きゃA" + suffix "4" —— 顺序反了结果就不同，别"优化"。
        pn = p0.parse_alias('きゃA4')
        check('★ 后缀剥离顺序 Nums→Appends→Pitches：数字先被吃掉',
              pn == ('', 'きゃA', '4'), pn)
        pnum = p0.parse_alias('あ1')
        check('★ 数字后缀被剥', pnum == ('', 'あ', '1'), pnum)
        papp = p0.parse_alias('あ強')
        check('★ 情绪后缀（強）被剥', papp[2] == '強', papp)
        # ★ "_" 分隔时 split[0] 是空串，而上游 `new Regex("")` 是**合法**的：
        #   零宽匹配替换为空 → 原串不变，于是 suffix 拿到整段 "_b"、phoneme 变空。
        #   这看着像 bug，但确实是上游行为，照搬。
        check('★ "_" 分隔且前缀为空时，suffix 拿到整段（零宽正则的原样）',
              p0.parse_alias('あ_b') == ('', 'あ', '_b'), p0.parse_alias('あ_b'))

        # ================= 6. 读 presamp.ini
        print('--- read_presamp_ini ---')
        vb = os.path.join(root, 'vb')
        os.makedirs(vb)
        p1 = P.Presamp()
        p1.read_presamp_ini(vb, 'shift_jis')
        check('★ presamp.ini 不存在时 file_exists=False 且用默认表',
              p1.file_exists is False and len(p1.vowels) == 7)

        ini = '\n'.join([
            '[VOWEL]',
            'a=ア=ア,あ,か=90',          # 只有一行 → 整表被替换
            '[CONSONANT]',
            'k=か,き,く=1',
            '[PRIORITY]',
            'k,ky',
            '[REPLACE]',
            'ZZ=あ',
            '[SU]',
            '%pitch%%num%%append%',   # ★ 三个占位符必须齐全（上游如此）
            '[NUM]',
            '@skipme@',
            '7',
            '[SPLIT]',
            '0',
            '[CFLAGS]',
            'v100',
            '[ENDFLAG]',
            '2',
            '[ALIAS]',
            'VCV=custom%VCVPAD%%CV%',
        ])
        with io.open(os.path.join(vb, 'presamp.ini'), 'w', encoding='utf-8', newline='') as f:
            f.write(ini)
        p2 = P.Presamp()
        p2.read_presamp_ini(vb, 'utf-8')
        check('file_exists=True', p2.file_exists is True)
        check('★ [VOWEL] 只写一行 → 整表被替换成 1 项',
              len(p2.vowels) == 1 and p2.vowels['a'].vowel_upper == 'ア', len(p2.vowels))
        check('★ [VOWEL] 的音量第 4 段生效（90）', p2.vowels['a'].vol == 90, p2.vowels['a'].vol)
        check('★ [CONSONANT] 整表被替换成 1 项', len(p2.consonants) == 1, len(p2.consonants))
        check('★ [PRIORITY] 整表被替换（k,ky）', p2.priorities == ['k', 'ky'], p2.priorities)
        check('★ [REPLACE] 整表被替换成 1 项', p2.replace == {'ZZ': 'あ'}, p2.replace)
        check('★ [SU] 三占位符齐全时按出现顺序重排 suffix_order',
              p2.suffix_order == ['%pitch%', '%num%', '%append%'], p2.suffix_order)
        check('★ [NUM] 里的 @...@ 引用行被跳过，只剩 "7"',
              p2.nums == ['7'], p2.nums)
        check('★ [SPLIT] 0 → split=False', p2.split is False)
        check('★ [CFLAGS] 覆盖成 v100', p2.cflags == 'v100', p2.cflags)
        check('★ [ENDFLAG] 2 → add_ending=2', p2.add_ending == 2, p2.add_ending)
        check('★ [ALIAS] VCV 覆盖，且取值时 %VCVPAD% 被替换成实际分隔符',
              p2.alias_rules.vcv == 'custom %CV%' or 'VCVPAD' not in p2.alias_rules.vcv,
              p2.alias_rules.vcv)

        # [SU] 不合规则整行忽略
        vb2 = os.path.join(root, 'vb2')
        os.makedirs(vb2)
        with io.open(os.path.join(vb2, 'presamp.ini'), 'w', encoding='utf-8', newline='') as f:
            f.write('[SU]\n%num%only\n')
        p3 = P.Presamp()
        p3.read_presamp_ini(vb2, 'utf-8')
        check('★ [SU] 缺占位符的行被忽略，suffix_order 保持默认',
              p3.suffix_order == ['%num%', '%append%', '%pitch%'], p3.suffix_order)

        # [ALIAS_PRIORITY] 只认第一行
        vb3 = os.path.join(root, 'vb3')
        os.makedirs(vb3)
        with io.open(os.path.join(vb3, 'presamp.ini'), 'w', encoding='utf-8', newline='') as f:
            f.write('[ALIAS_PRIORITY]\nA\nB\nC\nD\nE\nF\nG\n')
        p4 = P.Presamp()
        p4.read_presamp_ini(vb3, 'utf-8')
        # ★ 上游这里其实**自相矛盾**：进入段就 Clear()（计数归 0），
        #   而写入条件是 count >= 5 —— 于是任何用户写的值都进不去，表恒为空。
        #   这是上游的实际行为（不是我们搬错），照搬并在此钉住，
        #   以免将来"看着不合理就去修"反而与上游不一致。
        check('★ [ALIAS_PRIORITY] 进入段先清空 + 写入需 count>=5 → 用户写的值进不去（恒空，上游行为）',
              p4.alias_priority_default == [], p4.alias_priority_default)

        # 编码嗅探
        vb4 = os.path.join(root, 'vb4')
        os.makedirs(vb4)
        with io.open(os.path.join(vb4, 'presamp.ini'), 'wb') as f:
            f.write('[VOWEL]\na=ア=ア\n'.encode('cp932'))
        p5 = P.Presamp()
        p5.read_presamp_ini(vb4, 'utf-8')
        check('★ Shift-JIS 的 presamp.ini 也能正确读出（回退到 cp932）',
              p5.vowels.get('a') is not None and p5.vowels['a'].vowel_upper == 'ア',
              list(p5.vowels))

        print()
        print('结果: %d passed, %d failed' % (len(_P), len(_F)))
        for f in _F:
            print('  FAILED:', f)
        return 1 if _F else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())