# -*- coding: utf-8 -*-
"""测试共享 fixture。

test_singing_adapters.py 是脚本/pytest 双模式文件：脚本模式下由 main()
手动串接参数，pytest 收集模式下同名参数按 fixture 解析。这里补上它需要的
tmp / vb_dir 两个 fixture，pytest 模式即可正常运行，且不动该文件本体
（脚本模式 main() 零影响）。
"""

import os

import pytest


@pytest.fixture
def tmp(tmp_path) -> str:
    """临时工作目录，返回 str 路径（对齐脚本模式 tempfile.mkdtemp 的返回类型）。"""
    return str(tmp_path)


@pytest.fixture
def vb_dir(tmp: str) -> str:
    """最小可用 UTAU 音源目录（220Hz 正弦 a.wav + oto.ini）。"""
    from test_singing_adapters import make_voicebank

    return make_voicebank(os.path.join(tmp, "utau-vb"))
