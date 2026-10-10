# -*- coding: utf-8 -*-
"""把协作者那批**独立脚本式**引擎测试接进 pytest（CI 只跑 pytest，否则它们永远不会被执行）。

背景：engine/tests/test_ustx_convert.py / test_note_expressions.py / test_vibrato_link.py /
test_curve_render.py / test_multi_tempo_render.py / test_engine_serve.py 都是
`if __name__ == '__main__':` 的自校验脚本（内部用 check() 累计断言），pytest 收集不到，
所以 typecheck/CI 全绿也代表不了它们过没过。这里用子进程逐个跑，退出码非 0 即失败。

注意：脚本里的 check() 用 print 输出含 "−"（U+2212）的说明文字，在 GBK 控制台下会
UnicodeEncodeError 崩掉（断言其实已过）。因此这里强制 PYTHONIOENCODING=utf-8 后再跑。
"""
import os
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPTS = [
    'test_ustx_convert.py',
    'test_note_expressions.py',
    'test_vibrato_link.py',
    'test_curve_render.py',
    'test_multi_tempo_render.py',
    'test_engine_serve.py',
]


@pytest.mark.parametrize('name', SCRIPTS)
def test_contributor_selfcheck_script(name):
    path = os.path.join(HERE, name)
    if not os.path.exists(path):
        pytest.skip(name + ' 不存在')
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    r = subprocess.run([sys.executable, path], cwd=HERE, env=env,
                       capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=600)
    assert r.returncode == 0, name + ' 自校验失败：\n' + (r.stdout or '')[-1500:] + '\n' + (r.stderr or '')[-800:]
