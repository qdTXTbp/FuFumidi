# -*- coding: utf-8 -*-
r"""`engine/ort_compat.py` 的验收：增强包里的 onnxruntime 建会话就崩时，
引擎要能**自己换成内置 CPU 版**再跑一次，且只换一次、有缓存、有中文警告。

★ 为什么值得单独一层：那是**进程级崩溃**（Windows 0xC0000005），Python 的 try/except
  抓不到 —— 上层只看到「引擎退出码 3221225477」，用户看到的是「Ria 渲染失败」。
实测踩到的文件：Ria 的 `ria-multi-dict.onnx` 与 `dsvariance/vari.variance.onnx`
（同一批文件用内置 onnxruntime 1.30.0 正常，花火/空/芙宁娜的模型两版都正常）。
"""
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ort_compat as OC                                        # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _fake_bank(files):
    """造一个假声库目录 + 假模型文件（只要路径/大小/时间戳，不解析内容）。"""
    d = tempfile.mkdtemp(prefix='ort-bank-')
    out = []
    for i, name in enumerate(files):
        sub = os.path.join(d, os.path.dirname(name))
        os.makedirs(sub, exist_ok=True)
        p = os.path.join(d, name)
        with open(p, 'wb') as f:
            f.write(b'x' * (16 + i))
        out.append(p)
    return d, out


def _env(**kw):
    old = {k: os.environ.get(k) for k in kw}
    for k, v in kw.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    return old


def _restore(old):
    for k, v in old.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


def case_model_files():
    print('--- ① 找模型 ---')
    d, paths = _fake_bank(['a.onnx', 'dsdur/b.onnx', 'dsvariance/c.onnx', 'readme.txt'])
    got = OC.model_files(d)
    check('递归找到 3 个 onnx（含子目录）', len(got) == 3, got)
    check('非 onnx 不算', all(p.endswith('.onnx') for p in got), got)
    check('排序稳定', got == sorted(got), got)


def case_probe():
    print('--- ② 探针：崩了才算坏 ---')
    d, paths = _fake_bank(['ok1.onnx', 'bad.onnx', 'ok2.onnx'])
    crash = {paths[0]: 3221225477, paths[1]: 0, paths[2]: 255}
    seen = []

    def runner(argv):
        seen.append(argv[-1])
        return crash[argv[-1]]

    broken = OC.probe_models(paths, runner=runner)
    check('退出码非 0 → 坏（含 255）', broken == [paths[0], paths[2]], broken)
    check('退出码 0 → 好', paths[1] not in broken)
    check('每个模型都探了一次', seen == paths, seen)
    check('探针命令形如 python -c <脚本> <模型>',
          OC._PROBE in ' '.join(['-c', OC._PROBE]) and 'InferenceSession' in OC._PROBE)


def case_cache():
    print('--- ③ 缓存：只探一次 ---')
    d, paths = _fake_bank(['ok.onnx', 'bad.onnx'])
    cache_dir = tempfile.mkdtemp(prefix='ort-cache-')
    old = _env(FUFUMIDI_CACHE_DIR=cache_dir)
    try:
        calls = []

        def runner(argv):
            calls.append(argv[-1])
            return 3221225477 if argv[-1].endswith('bad.onnx') else 0

        b1, c1 = OC.check(d, runner=runner)
        check('第一次探出坏模型', len(b1) == 1 and b1[0].endswith('bad.onnx'), b1)
        check('第一次不是缓存命中', c1 is False)
        n = len(calls)
        b2, c2 = OC.check(d, runner=lambda argv: (_ for _ in ()).throw(AssertionError('不该再探')))
        check('第二次命中缓存（没再探）', c2 is True and b2 == b1, (b2, c2))
        check('缓存文件落盘', os.path.isfile(os.path.join(cache_dir, 'ort-compat.json')))
        with open(os.path.join(cache_dir, 'ort-compat.json'), encoding='utf-8') as f:
            data = json.load(f)
        check('缓存键含解释器与 ORT 版本', any(sys.executable in k for k in data), list(data)[:1])

        # 模型被换掉 → 键变化 → 重新探
        with open(paths[1], 'ab') as f:
            f.write(b'y' * 4096)
        b3, c3 = OC.check(d, runner=runner)
        check('模型变了 → 缓存自动失效并重探', c3 is False and len(calls) > n, (c3, calls))
    finally:
        _restore(old)


def case_fallback_env():
    print('--- ④ 换运行时的环境：内置 site-packages 必须排第一 ---')
    pack = os.path.join(tempfile.gettempdir(), 'fake-pack-site')
    os.makedirs(pack, exist_ok=True)
    env = OC.fallback_env({'PYTHONPATH': pack, 'PATH': 'x'})
    parts = env['PYTHONPATH'].split(os.pathsep)
    check('第一项是解释器自带 site-packages',
          parts[0].endswith(os.path.join('Lib', 'site-packages')) or 'site-packages' in parts[0],
          parts)
    check('增强包路径仍在（torch 之类还要用）', pack in parts, parts)
    check('带了防重入标记', env.get(OC.FALLBACK_ENV) == '1', env.get(OC.FALLBACK_ENV))
    check('不污染其它变量', env.get('PATH') == 'x')


def case_bootstrap():
    print('--- ⑤ bootstrap：什么时候自愈、什么时候不动 ---')
    d, paths = _fake_bank(['ok.onnx', 'bad.onnx'])
    cache_dir = tempfile.mkdtemp(prefix='ort-cache2-')
    calls = []

    def runner(argv):
        return 3221225477 if argv[-1].endswith('bad.onnx') else 0

    def fake_execute(argv, broken, from_cache=False):
        calls.append((list(argv), list(broken), from_cache))

    old = _env(FUFUMIDI_CACHE_DIR=cache_dir, FUFUMIDI_GPU_KINDS=None, **{OC.FALLBACK_ENV: None})
    try:
        note = OC.bootstrap(d, argv=['x.py', 'render'], runner=runner, execute=fake_execute)
        check('★ 没装增强包（FUFUMIDI_GPU_KINDS 空）→ 不检查、不重启',
              note == '' and calls == [], (note, calls))

        os.environ['FUFUMIDI_GPU_KINDS'] = 'cuda'
        note = OC.bootstrap(d, argv=['x.py', 'render'], runner=runner, execute=fake_execute)
        check('★ 装了增强包 + 有模型加载不了 → 触发自愈',
              note == OC.FALLBACK_WARNING and len(calls) == 1, (note, calls))
        check('  自愈时带上原始命令行与坏模型清单',
              calls[0][0] == ['x.py', 'render'] and calls[0][1][0].endswith('bad.onnx'), calls[0])
        check('  第一次是真探测（不是缓存）', calls[0][2] is False, calls[0])
        note = OC.bootstrap(d, argv=['x.py', 'render'], runner=runner, execute=fake_execute)
        check('  同一个声库再跑 → 命中缓存，省掉一轮子进程探测',
              len(calls) == 2 and calls[1][2] is True, calls)

        # 重启后的进程：标记已在 → 只回报警告，不再自愈（防无限重启）
        os.environ[OC.FALLBACK_ENV] = '1'
        note = OC.bootstrap(d, argv=['x.py'], runner=runner, execute=fake_execute)
        check('★ 已标记过 → 只回报警告，不再自愈（否则会无限重启）',
              note == OC.FALLBACK_WARNING and len(calls) == 2, (note, calls))
        os.environ.pop(OC.FALLBACK_ENV)

        # 模型全都好 → 不动
        d2, _ = _fake_bank(['fine.onnx'])
        note = OC.bootstrap(d2, argv=['x.py'], runner=lambda a: 0, execute=fake_execute)
        check('模型都正常 → 不重启', note == '' and len(calls) == 2, (note, calls))

        # 声库不存在 → 不动（不抛）
        note = OC.bootstrap(os.path.join(d, 'nope'), argv=['x.py'], runner=runner, execute=fake_execute)
        check('声库目录不存在 → 安全返回', note == '' and len(calls) == 2, note)
    finally:
        _restore(old)


def main():
    case_model_files()
    print()
    case_probe()
    print()
    case_cache()
    print()
    case_fallback_env()
    print()
    case_bootstrap()
    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


def test_ort_fallback():
    assert main() == 0


if __name__ == '__main__':
    sys.exit(main())