# -*- coding: utf-8 -*-
"""验证 `Classic/` 插件体系 6 个文件（IPlugin/Plugin/PluginLoader/PluginRunner/
ExeInstaller/PresampWatcher）。

重点是几条"别顺手修好"的行为：`Array.ForEach(s, t => t.Trim())` 在上游是**无效代码**、
`name` 的正则会给名字**加后缀**、哈希相同就**不回读**、`first/last` 为 None **静默返回**。
插件体系是**真跑外部进程**的，所以这里造一个"用 python 假冒的插件 exe"来做端到端。
"""
import io
import os
import shutil
import stat
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.classic import plugin as P                        # noqa: E402
from singing.openutau.presamp_watcher import PresampWatcher             # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _repo():
    return os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))


def _src(name):
    p = os.path.join(_repo(), '_ref', 'OpenUtau', 'OpenUtau.Core', 'Classic', name)
    return open(p, encoding='utf-8-sig').read().replace('\r\n', '\n') \
        if os.path.isfile(p) else ''


def _mk_plugin(root, name, lines, dirname='plug'):
    d = os.path.join(root, dirname)
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, 'plugin.txt'), 'w', encoding='shift_jis', newline='') as f:
        f.write('\n'.join(lines) + '\n')
    return d


def _mk_fake_exe(path, body):
    """造一个能在 Windows 上直接跑的"插件"（.bat）。"""
    with open(path, 'w', encoding='ascii', newline='\r\n') as f:
        f.write('@echo off\r\n' + body + '\r\n')
    return path


def main():
    src_loader = _src('PluginLoader.cs')
    src_runner = _src('PluginRunner.cs')
    src_plugin = _src('Plugin.cs')
    src_inst = _src('ExeInstaller.cs')
    src_watch = _src('PresampWatcher.cs')
    root = tempfile.mkdtemp(prefix='fufumidi-plugin-')
    try:
        # ================= 源码一致性
        print('--- 源码一致性 ---')
        check('★ 源码: Array.ForEach(s, temp => temp.Trim()) 是无效代码（照搬不修）',
              'Array.ForEach(s, temp => temp.Trim());' in src_loader)
        check('源码: 键名 ToLowerInvariant、值不转小写',
              's[0] = s[0].ToLowerInvariant();' in src_loader)
        check('源码: name 的正则 (.+)\\(&([A-Za-z0-9])\\)',
              '(.+)\\\\(&([A-Za-z0-9])\\\\)' in src_loader)
        check('源码: execute 去掉 .\\ 前缀后与 plugin.txt 同目录拼接',
              'execute.Substring(2)' in src_loader
              and 'Path.Combine(Path.GetDirectoryName(filePath), execute)' in src_loader)
        check('源码: name/executable 任一空白就抛 FileFormatException',
              'string.IsNullOrWhiteSpace(plugin.Name)' in src_loader)
        check('★ 源码: PluginRunner 靠 MD5 前后比对，没变就不回读',
              'HashFile(tempFile)' in src_runner
              and 'Enumerable.SequenceEqual(beforeHash, afterHash)' in src_runner)
        check('★ 源码: first/last 为 null 直接 return（不报错）',
              'if (first == null || last == null) {' in src_runner)
        check('源码: Wine 分支注入 LANG=ja_JP.utf8',
              'startInfo.Environment.Add("LANG", "ja_JP.utf8")' in src_plugin)
        check('源码: ExeInstaller 按 wavtool/resampler 落到不同目录并覆盖拷贝',
              'File.Copy(filePath, destName, true)' in src_inst)
        check('源码: PresampWatcher 只监听 presamp.ini 且不含子目录',
              'watcher.Filter = "presamp.ini"' in src_watch
              and 'watcher.IncludeSubdirectories = false' in src_watch)

        # ================= PluginLoader
        print('--- PluginLoader ---')
        d = _mk_plugin(root, 'A', ['name=MyPlugin (&M)', 'execute=.\\tool.exe'])
        pl = P.PluginLoader.load_all(root)
        check('load_all 递归找到 plugin.txt', len(pl) == 1, len(pl))
        p0 = pl[0]
        # ★ 正则的 group(1) 是 `(.+)`，**贪婪**且把 " (" 前那个空格也吃进去了，
        #   于是拼出来是 'MyPlugin' + ' ' + ' (M)' → **两个空格**。上游同样如此。
        check('★ name 快捷键：名字被加上 " (M)"，且 group(1) 吃掉空格 → 出现两个空格',
              p0.name == 'MyPlugin  (M)' and p0.shortcut == 'M', (p0.name, p0.shortcut))
        check('★ execute 去掉 ".\\" 后与 plugin.txt 同目录拼接',
              p0.executable == os.path.join(d, 'tool.exe'), p0.executable)
        check('默认 encoding 是 shift_jis', p0.encoding == 'shift_jis', p0.encoding)

        # 无快捷键
        d2 = _mk_plugin(root, 'B', ['name=Plain', 'execute=.\\t.exe'], dirname='plug2')
        check('没有 (&X) 时名字原样', P.PluginLoader.load_all(root)[1].name == 'Plain')

        # notes=all / shell=use / encoding
        d3 = _mk_plugin(root, 'C', ['name=Opts', 'execute=t.exe', 'notes=all',
                                    'shell=use', 'encoding=utf-8'], dirname='plug3')
        p2 = [x for x in P.PluginLoader.load_all(root) if x.name == 'Opts'][0]
        check('notes=all / shell=use / encoding 都被解析',
              p2.all_notes is True and p2.use_shell is True and p2.encoding == 'utf-8',
              (p2.all_notes, p2.use_shell, p2.encoding))

        # 冒号也能当分隔符
        d4 = _mk_plugin(root, 'D', ['name: Colon', 'execute: t.exe'], dirname='plug4')
        # ★ 值同样**不 trim**（上游那个无效的 Array.ForEach），所以名字是 ' Colon'。
        check('★ 没有 "=" 时回退用 ":" 分隔；值不 trim → 名字带前导空格',
              any(x.name == ' Colon' for x in P.PluginLoader.load_all(root)),
              [x.name for x in P.PluginLoader.load_all(root)])

        # ★ 等号后有空格 → 键名带空格 → 匹配不上 → 最终报 Failed to load
        try:
            d5 = _mk_plugin(root, 'E', ['name = Spaced', 'execute=t.exe'], dirname='plug5')
            P.PluginLoader.load_all(root)
            check('★ 上游不 trim：键名 "name " 匹配不上 → 抛 FileFormatException', False)
        except P.FileFormatError:
            check('★ 上游不 trim：键名 "name " 匹配不上 → 抛 FileFormatException', True)

        # 缺 name
        try:
            _mk_plugin(root, 'F', ['execute=t.exe'], dirname='plug6')
            P.PluginLoader.load_all(root)
            check('缺 name → FileFormatException', False)
        except P.FileFormatError:
            check('缺 name → FileFormatException', True)

        # ================= Plugin.run（真跑外部进程）
        print('--- Plugin.run / PluginRunner（真跑外部 exe）---')
        bat = _mk_fake_exe(os.path.join(root, 'noop.bat'),
                           'copy /Y "%~1" "%~1.done" >NUL')
        p3 = P.Plugin(name='Noop', executable=bat)
        tmp = os.path.join(root, 'temp.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write('x')
        p3.run(tmp)
        check('★ Plugin.run 真的把外部程序跑起来了（临时文件被处理过）',
              os.path.exists(tmp + '.done'))

        try:
            P.Plugin(name='X', executable=os.path.join(root, 'nope.exe')).run(tmp)
            check('可执行文件不存在 → FileNotFoundError_', False)
        except P.FileNotFoundError_:
            check('可执行文件不存在 → FileNotFoundError_', True)

        # PluginRunner：first/last 为 None 静默返回
        r = P.PluginRunner(cache_path=os.path.join(root, 'cache'))
        r.execute(None, None, None, None, p3)
        check('★ first/last 为 None → 静默返回（不抛）', True)

        # 哈希相同 → 不回读（on_replace_note 不该被调）
        calls = []
        r2 = P.PluginRunner(cache_path=os.path.join(root, 'cache'),
                            on_replace_note=lambda a: calls.append(a),
                            on_error=lambda a: calls.append(a))
        r2.execute(None, None, object(), object(), p3)   # 会在 write_plugin 处失败 → 走 on_error
        check('★ 任一环节异常都转给 on_error（不往上抛）',
              calls and isinstance(calls[0], P.PluginErrorEventArgs)
              and calls[0].message == 'Failed to execute plugin',
              calls[:1])

        # ExeInstaller
        print('--- ExeInstaller ---')
        from singing.openutau.classic import resampler_item
        resampler_item.host.resamplers_path_override = os.path.join(root, 'resamp')
        resampler_item.host.wavtools_path_override = os.path.join(root, 'wavtool')
        src_exe = os.path.join(root, 'myres.exe')
        with open(src_exe, 'w') as f:
            f.write('MZ')
        fn, dest = P.ExeInstaller.install(src_exe, P.RESAMPLER)
        check('ExeInstaller 装到 resamplers 目录并覆盖拷贝',
              fn == 'myres.exe' and os.path.isfile(os.path.join(dest, 'myres.exe')))
        fn2, dest2 = P.ExeInstaller.install(src_exe, P.WAVTOOL)
        check('ExeInstaller 装到 wavtools 目录',
              fn2 == 'myres.exe' and os.path.isfile(os.path.join(dest2, 'myres.exe'))
              and dest2 != dest)

        # ================= PresampWatcher
        print('--- PresampWatcher ---')
        vb = os.path.join(root, 'vb')
        os.makedirs(vb, exist_ok=True)
        ini = os.path.join(vb, 'presamp.ini')
        with open(ini, 'w', encoding='utf-8') as f:
            f.write('[VOWEL]\n')
        hits = []
        w = PresampWatcher(vb, lambda: hits.append(1))
        w.start()
        try:
            time.sleep(0.2)
            with open(ini, 'a', encoding='utf-8') as f:
                f.write('a=ア=ア\n')
            deadline = time.time() + 4
            while time.time() < deadline and not hits:
                time.sleep(0.1)
            check('★ presamp.ini 变化后触发回调', bool(hits), hits)
            n = len(hits)
            # Paused 时变化被丢弃、不排队
            w.paused = True
            with open(ini, 'a', encoding='utf-8') as f:
                f.write('i=イ=イ\n')
            time.sleep(1.2)
            check('★ Paused 期间的变化被丢弃（不补触发）', len(hits) == n, (n, len(hits)))
        finally:
            w.dispose()
        check('dispose 后线程退出', w._thread is None)

        print()
        print('结果: %d passed, %d failed' % (len(_P), len(_F)))
        for f in _F:
            print('  FAILED:', f)
        return 1 if _F else 0
    finally:
        shutil.rmtree(root, ignore_errors=True)


if __name__ == '__main__':
    sys.exit(main())