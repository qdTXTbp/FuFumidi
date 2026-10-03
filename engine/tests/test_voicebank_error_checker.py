# -*- coding: utf-8 -*-
"""验证 `Classic/VoicebankErrorChecker.cs`（声库体检）。

造若干个**真实有缺陷的声库**（大小写不符、采样率错、缺文件、别名重复、
offset 越界、文件名 NFD…），逐条核对 message_key。
"""
import os
import shutil
import struct
import sys
import tempfile
import wave

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.classic.voicebank_error_checker import (  # noqa: E402
    VoicebankErrorChecker)

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _repo():
    return os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))


def _src():
    p = os.path.join(_repo(), '_ref', 'OpenUtau', 'OpenUtau.Core', 'Classic',
                     'VoicebankErrorChecker.cs')
    return open(p, encoding='utf-8-sig').read().replace('\r\n', '\n') \
        if os.path.isfile(p) else ''


def write_wav(path, seconds=1.0, rate=44100, channels=1, width=2):
    with wave.open(path, 'wb') as w:
        w.setnchannels(channels)
        w.setsampwidth(width)
        w.setframerate(rate)
        frames = int(seconds * rate)
        if width == 2:
            raw = b''.join(struct.pack('<h', 0) for _ in range(frames * channels))
        else:
            raw = b'\x00' * (frames * channels * width)
        w.writeframes(raw)


def make_vb(root, name, oto_lines, wavs=('a.wav',), **wavkw):
    vb = os.path.join(root, name)
    os.makedirs(os.path.join(vb, 'wav'), exist_ok=True)
    with open(os.path.join(vb, 'character.txt'), 'w', encoding='utf-8') as f:
        f.write('name=%s\n' % name)
    for wname in wavs:
        write_wav(os.path.join(vb, 'wav', wname), **wavkw)
    with open(os.path.join(vb, 'oto.ini'), 'w', encoding='utf-8') as f:
        f.write('[oto.ini]\n' + '\n'.join(oto_lines) + '\n')
    return vb


def keys(errors, infos):
    return ([e.message_key for e in errors], [i.message_key for i in infos])


def main():
    src = _src()
    root = tempfile.mkdtemp(prefix='fufumidi-vbcheck-')
    try:
        # ---------------- 源码一致性
        print('--- 源码一致性 ---')
        check('源码: character.txt 缺失 → txtnotfound',
              'messageKey = "singererror.txtnotfound"' in src)
        check('源码: character.yaml 缺失只记 Info（不算错）',
              'Infos.Add' in src and 'singererror.yamlnotfound' in src)
        check('★ 源码: 末尾检查的文件名是 "chatacter.txt"（上游拼写错误，照搬）',
              '"chatacter.txt",' in src)
        check('源码: #Charset: 开头的行直接跳过',
              'line.StartsWith("#Charset:")' in src)
        check('源码: 采样率/位深是 Error，声道是 Info',
              'messageKey = "singererror.samplerate"' in src
              and 'Infos.Add(new VoicebankError' in src
              and 'messageKey = "singererror.mono"' in src)
        check('源码: 负 cutoff 按 offset 往前解释',
              'oto.Cutoff < 0 ? oto.Offset - oto.Cutoff : fileDuration - oto.Cutoff' in src)
        check('源码: 错误分类抽样（offsetshort / cutoffconsonant / wrongcase / duplicatename）',
              all(('singererror.' + k) in src for k in
                  ('offsetshort', 'cutoffconsonant', 'wrongcase', 'duplicatename',
                   'duplicatealias', 'wavisnfd')))
        check('★ 源码: 末尾检查的文件名拼错成 chatacter.txt（照搬）',
              '"chatacter.txt"' in src)
        check('★ 源码: 键名 aliasisnfd', '"singererror.aliasisnfd"' in src)
        check('源码: 重复别名跨所有 oto set 查找',
              'voicebank.OtoSets\n                .SelectMany(set => set.Otos)' in src
              or 'SelectMany(set => set.Otos)' in src)

        # ---------------- 1. 缺 character.txt
        empty = os.path.join(root, 'empty')
        os.makedirs(empty)
        c = VoicebankErrorChecker(empty, empty)
        c.check()
        check('★ 缺 character.txt → 只报 txtnotfound',
              keys(c.errors, c.infos)[0] == ['singererror.txtnotfound'],
              keys(c.errors, c.infos))

        # ---------------- 2. 缺 character.yaml 只算 Info
        vb = make_vb(root, 'NoYaml', ['wav/a.wav=a,0,0,0,0,0'])
        c2 = VoicebankErrorChecker(vb, vb)
        c2.check()
        check('★ 缺 character.yaml → Info 而非 Error',
              'singererror.yamlnotfound' in [i.message_key for i in c2.infos]
              and 'singererror.yamlnotfound' not in [e.message_key for e in c2.errors],
              keys(c2.errors, c2.infos))

        # ---------------- 3. 完全正常
        vb3 = make_vb(root, 'Good', ['wav/a.wav=a,0,0,0,0,0'])
        c3 = VoicebankErrorChecker(vb3, vb3)
        c3.check()
        # ★ 上游 `ParseOtoSet` 会把 **段头 `[oto.ini]` 也当条目解析**（C# 与 Python 都如此，
        #   见 C# 的 `while (!reader.EndOfStream) { ParseOto(line, …) }`），
        #   于是它是一条 `is_valid=False` 的 oto → 体检必然报一条 invalidoto。
        #   这是**上游真实行为**（不是我们搬错），照搬并在此钉住。
        check('★ 上游把段头 [oto.ini] 也当条目 → 正常声库也恰好有 1 条 invalidoto',
              [e.message_key for e in c3.errors] == ['singererror.invalidoto'],
              keys(c3.errors, c3.infos))
        check('正常声库除段头外无其它错误（Info 只有缺 character.yaml 一条）',
              len(c3.errors) == 1
              and [i.message_key for i in c3.infos] == ['singererror.yamlnotfound'],
              keys(c3.errors, c3.infos))

        # ---------------- 4. 采样率 / 位深 / 声道
        vb4 = make_vb(root, 'BadFmt', ['wav/a.wav=a,0,0,0,0,0'],
                      wavs=('a.wav',), rate=22050, width=1, channels=2)
        c4 = VoicebankErrorChecker(vb4, vb4)
        c4.check()
        ek, ik = keys(c4.errors, c4.infos)
        check('★ 采样率 22050 → Error samplerate', 'singererror.samplerate' in ek, ek)
        check('★ 立体声 → Info mono（不是 Error）',
              'singererror.mono' in ik and 'singererror.mono' not in ek, (ek, ik))
        check('★ 8 位 → Error bitdepth', 'singererror.bitdepth' in ek, ek)

        # ---------------- 5. 缺音频文件
        vb5 = os.path.join(root, 'NoWav')
        os.makedirs(vb5)
        with open(os.path.join(vb5, 'character.txt'), 'w', encoding='utf-8') as f:
            f.write('name=NoWav\n')
        with open(os.path.join(vb5, 'oto.ini'), 'w', encoding='utf-8') as f:
            f.write('[oto.ini]\nwav/missing.wav=a,0,0,0,0,0\n')
        c5 = VoicebankErrorChecker(vb5, vb5)
        c5.check()
        ek5 = [e.message_key for e in c5.errors]
        # ★ loader 的 `check_wav_exist` **已经**把这条 oto 标成 invalid，
        #   而体检对 invalid 的处理是"记 invalidoto 并 continue" —— 所以
        #   `soundmissing` 根本轮不到（上游同样如此：它也在 IsValid 处 continue）。
        #   也就是说：缺文件在体检里表现为 invalidoto，不是 soundmissing。
        check('★ 缺 wav：loader 已标 invalid → 体检记 invalidoto（不是 soundmissing，上游行为）',
              ek5 == ['singererror.invalidoto', 'singererror.invalidoto'], ek5)

        # ---------------- 6. offset / cutoff 越界
        vb6 = make_vb(root, 'BadOffset',
                      ['wav/a.wav=a,-100,0,0,0,0', 'wav/a.wav=b,99999,0,0,0,0'],
                      wavs=('a.wav',), seconds=0.5)
        c6 = VoicebankErrorChecker(vb6, vb6)
        c6.check()
        ek6 = [e.message_key for e in c6.errors]
        check('★ offset 为负 → offsetshort', 'singererror.offsetshort' in ek6, ek6)
        check('★ offset 超出文件时长 → offsetoutofduration',
              'singererror.offsetoutofduration' in ek6, ek6)

        # ---------------- 7. 别名重复
        vb7 = make_vb(root, 'Dup', ['wav/a.wav=a,0,0,0,0,0', 'wav/a.wav=a,0,0,0,0,0'])
        c7 = VoicebankErrorChecker(vb7, vb7)
        c7.check()
        check('★ 同名别名出现两次 → duplicatealias（且只报一条）',
              [e.message_key for e in c7.errors].count('singererror.duplicatealias') == 1,
              keys(c7.errors, c7.infos))

        # ---------------- 8. 大小写不符
        vb8 = os.path.join(root, 'WrongCase')
        os.makedirs(os.path.join(vb8, 'wav'))
        with open(os.path.join(vb8, 'character.txt'), 'w', encoding='utf-8') as f:
            f.write('name=WrongCase\n')
        # ★ wav 必须与 oto.ini **同目录**：上游 `CheckCaseMatchForFileReference(OtoSet)`
        #   只 `Directory.GetFiles(oto.ini 所在目录)` —— 放在子目录里的 wav 不参与比大小写。
        write_wav(os.path.join(vb8, 'A.wav'))
        with open(os.path.join(vb8, 'oto.ini'), 'w', encoding='utf-8') as f:
            f.write('[oto.ini]\na.wav=a,0,0,0,0,0\n')   # 实际是 A.wav
        c8 = VoicebankErrorChecker(vb8, vb8)
        c8.check()
        ek8 = [e.message_key for e in c8.errors]
        check('★ oto 写 a.wav 但磁盘是 A.wav → wrongcase',
              'singererror.wrongcase' in ek8, ek8)
        check('（段头那条 invalidoto 同时存在，属预期）',
              ek8.count('singererror.invalidoto') == 1, ek8)
        wc = next((e for e in c8.errors if e.message_key == 'singererror.wrongcase'), None)
        check('wrongcase 带上了"写的名"与"实际名"两个路径',
              wc is not None and len(wc.strings) == 2
              and wc.strings[0].endswith('a.wav') and wc.strings[1].endswith('A.wav'),
              wc.strings if wc else None)

        # ---------------- 9. 别名空格 / 全角 / NFD
        import unicodedata
        # ★ 必须用 **NFC 合成形**（'が' = U+304C），不是 NFD 分解形！
        #   .NET 的 `string.IsNormalized()` 判的是"**已经是 NFD**"，所以
        #   写成 NFD 反而是**合规**的、不会报 aliasisnfd；要触发这条提示
        #   得给它一个合成的（NFC）别名。我一开始用 NFD，方向搞反了。
        nfd = unicodedata.normalize('NFC', 'が')
        assert nfd == 'が' and nfd != unicodedata.normalize('NFD', 'が')
        # ★ 必须写 `#Charset:utf-8`（**冒号后不能有空格**）：本仓库的 `get_encoding`
        #   刻意拒绝含空白的编码名，好让 `#Charset: utf-8`（带空格）被判为"没有声明"
        #   —— 因为上游 `line.Replace("#Charset:", "")` 得到带前导空格的串，
        #   而 .NET 的 `Encoding.GetEncoding(" utf-8")` 会抛。照搬这个严格度。
        #   没声明编码时按 cp932 解码，NFD 的组合浊音符会被吃掉 → 测不到 alisnfd。
        vb9 = os.path.join(root, 'Spaces')
        os.makedirs(os.path.join(vb9, 'wav'))
        with open(os.path.join(vb9, 'character.txt'), 'w', encoding='utf-8') as f:
            f.write('name=Spaces\n')
        write_wav(os.path.join(vb9, 'wav', 'a.wav'))
        with open(os.path.join(vb9, 'oto.ini'), 'w', encoding='utf-8') as f:
            f.write('#Charset:utf-8\n[oto.ini]\nwav/a.wav= a ,0,0,0,0,0\n')

        c9 = VoicebankErrorChecker(vb9, vb9)
        c9.check()
        ik9 = [i.message_key for i in c9.infos]

        # NFD 单独造一个声库（只含那一条 oto）—— 混在别的 alias 旁边时行为不稳定
        vb9b = os.path.join(root, 'Nfd')
        os.makedirs(os.path.join(vb9b, 'wav'))
        with open(os.path.join(vb9b, 'character.txt'), 'w', encoding='utf-8') as f:
            f.write('name=Nfd\n')
        write_wav(os.path.join(vb9b, 'wav', 'a.wav'))
        with open(os.path.join(vb9b, 'oto.ini'), 'w', encoding='utf-8') as f:
            f.write('#Charset:utf-8\n[oto.ini]\nwav/a.wav=%s,0,0,0,0,0\n' % nfd)
        c9b = VoicebankErrorChecker(vb9b, vb9b)
        c9b.check()
        ik9b = [i.message_key for i in c9b.infos]
        check('★ 别名首尾空格 → Info aliasstartwithspace',
              'singererror.aliasstartwithspace' in ik9, ik9)
        check('★ 别名是 NFD → Info aliasisnfd（独立声库、单条 oto）',
              'singererror.aliasisnfd' in ik9b, (ik9b, [e.message_key for e in c9b.errors]))

        # ---------------- 10. ★ 上游拼写错误的副作用
        vb10 = os.path.join(root, 'CharCase')
        os.makedirs(vb10)
        # character.txt 大小写不符（character.TXT）
        with open(os.path.join(vb10, 'character.TXT'), 'w', encoding='utf-8') as f:
            f.write('name=CharCase\n')
        with open(os.path.join(vb10, 'oto.ini'), 'w', encoding='utf-8') as f:
            f.write('[oto.ini]\n')
        c10 = VoicebankErrorChecker(vb10, vb10)
        c10.check()
        ek10 = [e.message_key for e in c10.errors]
        # ★ Windows 路径**大小写不敏感**：`os.path.isfile('character.txt')` 能命中
        #   `character.TXT`，所以既不会 txtnotfound、也不会 wrongcase。
        #   换言之 "chatacter.txt" 那个上游拼写错误在 Windows 上完全看不出来
        #   （在大小写敏感的平台上才会暴露成"漏检 character.txt"）。
        check('★ Windows 路径大小写不敏感 → character.TXT 被当成了 character.txt（未报 txtnotfound）',
              'singererror.txtnotfound' not in ek10, ek10)

        print()
        print('结果: %d passed, %d failed' % (len(_P), len(_F)))
        for f in _F:
            print('  FAILED:', f)
        return 1 if _F else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())