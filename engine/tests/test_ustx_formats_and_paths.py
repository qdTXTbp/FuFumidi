# -*- coding: utf-8 -*-
r"""M6 验收：格式嗅探 + PathManager + project.saved。

照搬基准：
* `OpenUtau.Core/Format/Formats.cs:23-52`（`DetectProjectFormat`）
* `OpenUtau.Core/Util/PathManager.cs:16-96`（三平台策略 + 派生路径）
* `singing/openutau/classic/ust.py:402/523` 依赖 `project.saved`
"""
import io
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.path_manager import PathManager, _home_path_is_ascii   # noqa: E402
from singing.ustx import format as UFormat                          # noqa: E402
from singing.ustx import formats as FM                              # noqa: E402
from singing.ustx.model import UProject                             # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


def main():
    tmp = tempfile.mkdtemp(prefix='fufumidi-fmt-')

    print('--- DetectProjectFormat（Formats.cs:23-52）---')
    cases = [
        ('a.ustx', 'name: x\nustx_version: "0.10"\ntracks: []\n', 'USTX'),
        ('b.ust', '[#SETTING]\nTempo=120\n', 'UST'),
        # ★ Ust 判据**优先于** Ustx（:35-38 的顺序）—— .ust 里出现 ustx_version
        #   仍应判成 UST
        ('c.ust', 'ustx_version: "0.10"\n[#SETTING]\n', 'UST'),
        ('d.json', '{"ustxVersion": "0.10"}', 'USTX'),
        ('e.mid', None, 'MIDI'),
        ('f.xml', '<?xml?><score-partwise version="3.1">', 'MUSICXML'),
        ('g.ufdata', '{"formatVersion": 1}', 'UFDATA'),
        ('h.svp', '{"version": 1, "database": 2}', 'SVP'),
        ('i.svp2', '{"mouthOpening": 0.5}', 'SVP'),
        ('j.unk', 'hello world\n', 'UNKNOWN'),
    ]
    for name, content, want in cases:
        fp = os.path.join(tmp, name)
        if content is None:
            with open(fp, 'wb') as f:
                f.write(b'MThd\x00\x00\x00\x06')
        else:
            with io.open(fp, 'w', encoding='utf-8') as f:
                f.write(content)
        got = FM.detect_project_format(fp).name
        check('  %-8s → %s' % (name, want), got == want, got)
        os.remove(fp)

    print()
    print('--- 只看前 10 行（:25-28）---')
    fp = os.path.join(tmp, 'deep.ust')
    with io.open(fp, 'w', encoding='utf-8') as f:
        f.write('x\n' * 20)                 # 前 10 行没有判据
        f.write('[#SETTING]\n')             # 第 21 行才有
    check('★ 前 10 行没有判据 → UNKNOWN（不整文件读）',
          FM.detect_project_format(fp).name == 'UNKNOWN',
          FM.detect_project_format(fp).name)
    with io.open(fp, 'w', encoding='utf-8') as f:
        f.write('x\n' * 5)
        f.write('ustx_version: "0.10"\n')    # 第 6 行
        f.write('y\n' * 20)
    check('  判据在前 10 行内 → 能认出',
          FM.detect_project_format(fp).name == 'USTX')
    os.remove(fp)

    print()
    print('--- 不存在的文件 → UNKNOWN（不抛）---')
    check('  文件不存在',
          FM.detect_project_format(os.path.join(tmp, 'nope.ustx')).name == 'UNKNOWN')

    print()
    print('--- is_readable / read_project 的分派 ---')
    check('  USTX / UST 可读', FM.is_readable(FM.ProjectFormat.USTX)
          and FM.is_readable(FM.ProjectFormat.UST))
    check('  VSQ3 不可读', not FM.is_readable(FM.ProjectFormat.VSQ3))
    # ★ 必须是**真实内容**的文件 —— 嗅探只看前 10 行，没有内容会判成 UNKNOWN
    vsq3 = os.path.join(tmp, 'x.vsq3')
    with io.open(vsq3, 'w', encoding='utf-8') as f:
        f.write('VSQ3.00\n[Common]\nVersion=DSB301\n')
    try:
        FM.read_project([vsq3])
        check('  ★ 读不支持的格式 → NotImplementedError（不静默返回 None）', False)
    except NotImplementedError as e:
        check('  ★ 读不支持的格式 → NotImplementedError（不静默返回 None）',
              'VSQ3' in str(e), str(e))
    except Exception as e:  # noqa: BLE001
        check('  ★ 读不支持的格式 → NotImplementedError', False, type(e).__name__)
    check('  空列表 → None（:59-61）', FM.read_project([]) is None)

    print()
    print('--- PathManager 派生路径（:80-96）---')
    pm = PathManager.detect(app_dir=os.path.join(tmp, 'app'), home=os.path.join(tmp, 'home'))
    check('  data_path 非空', bool(pm.data_path), pm.data_path)
    check('  singers_path = data_path/Singers',
          pm.singers_path == os.path.join(pm.data_path, 'Singers'), pm.singers_path)
    check('  singers_path_old = data_path/Content/Singers（旧版目录）',
          pm.singers_path_old == os.path.join(pm.data_path, 'Content', 'Singers'))
    check('  dependency_path = data_path/Dependencies（通用组件位）',
          pm.dependency_path == os.path.join(pm.data_path, 'Dependencies'))
    check('  log_file_path = logs/log.txt',
          pm.log_file_path == os.path.join(pm.logs_path, 'log.txt'))
    check('  prefs_file_path = data_path/prefs.json',
          pm.prefs_file_path == os.path.join(pm.data_path, 'prefs.json'))
    check('  themes / resamplers / wavtools / dictionaries / templates',
          pm.themes_path.endswith('Themes') and pm.resamplers_path.endswith('Resamplers')
          and pm.wavtools_path.endswith('Wavtools')
          and pm.dictionaries_path.endswith('Dictionaries')
          and pm.templates_path.endswith('Templates'))

    print()
    print('--- installed.txt 判定便携 vs 已安装（:53-59）---')
    app = os.path.join(tmp, 'app2')
    os.makedirs(app, exist_ok=True)
    pm_portable = PathManager.detect(app_dir=app, home=os.path.join(tmp, 'home'))
    check('  无 installed.txt → 便携（data_path = appDir）',
          not pm_portable.is_installed and pm_portable.data_path == app,
          (pm_portable.is_installed, pm_portable.data_path))
    with io.open(os.path.join(app, 'installed.txt'), 'w', encoding='utf-8') as f:
        f.write('')
    pm_inst = PathManager.detect(app_dir=app, home=os.path.join(tmp, 'home'))
    check('  有 installed.txt → 已安装（data_path = home/OpenUtau）',
          pm_inst.is_installed
          and pm_inst.data_path == os.path.join(tmp, 'home', 'OpenUtau'),
          (pm_inst.is_installed, pm_inst.data_path))
    os.remove(os.path.join(app, 'installed.txt'))

    print()
    print('--- HomePathIsAscii（:61-69，只有 Windows 分支算）---')
    check('  纯 ASCII 路径 → True', _home_path_is_ascii(r'C:\Users\abc\OpenUtau'))
    check('  ★ 含中文 → False', not _home_path_is_ascii(r'C:\Users\张三\OpenUtau'))
    check('  ★ 含日文 → False', not _home_path_is_ascii(r'C:\Users\あ\OpenUtau'))
    check('  ★ 含 emoji（非 BMP）→ False', not _home_path_is_ascii(r'C:\Users\😀\X'))

    print()
    print('--- project.saved（ust.py:402/523 依赖它）---')
    p = UProject()
    check('  初始 saved=False / file_path=""',
          p.saved is False and not p.file_path, (p.saved, p.file_path))
    out = os.path.join(tmp, 'saved.ustx')
    UFormat.save(out, p)
    check('★ save() 后 saved=True', p.saved is True, p.saved)
    check('★ save() 后 file_path 指向写入位置',
          os.path.normpath(p.file_path or '') == os.path.normpath(out),
          p.file_path)
    check('  ★ 文件确实写了', os.path.isfile(out))
    p2 = UProject()
    auto = os.path.join(tmp, 'auto.ustx')
    UFormat.autosave(auto, p2)
    check('  autosave() **不**标记 saved（对照 :191 的语义）',
          p2.saved is False, p2.saved)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())
