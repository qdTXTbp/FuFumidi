# -*- coding: utf-8 -*-
"""WP2-3 / WP2-4：Aria-AMT 与 Transkun 的定版与"配置/权重配对"回归。

这两条此前**没有任何测试**，而它们各自有一个"静默出错"的口子：

- Aria：CLI 是 `transcribe <model_name> <checkpoint_path>`，两个位置参数**配对**。
  权重靠"目录里第一个 .safetensors"选的话，放第二个变体进来就会拿 A 的结构跑 B 的权重，
  **不报错**、只是结果错。→ `_find_checkpoint(model_dir, variant)` 现在按 variant 匹配。
- 两个 aria 包从 GitHub 装且**不带 ref**，dist 版本号又都是没用的 0.0.1。
  → `deps.ARIA_PINS` 钉 commit，git+ 与 zip 兜底两条路取**同一个** commit。
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import engine_aria  # noqa: E402
import deps  # noqa: E402

CHECKPOINTS = [
    'piano-medium-double-1.0.safetensors',
    'piano-medium-single-1.0.safetensors',
]


def _mk(tmp_path, names):
    d = tmp_path / 'aria_amt'
    d.mkdir(parents=True, exist_ok=True)
    for n in names:
        (d / n).write_bytes(b'x')
    return str(d)


def test_find_checkpoint_matches_variant(tmp_path):
    """两个变体同时存在时，必须选**与 variant 匹配**的那个（这是修掉的那个 bug）。"""
    d = _mk(tmp_path, CHECKPOINTS)
    got = engine_aria._find_checkpoint(d, 'medium-single')
    assert os.path.basename(got) == 'piano-medium-single-1.0.safetensors', got
    got = engine_aria._find_checkpoint(d, 'medium-double')
    assert os.path.basename(got) == 'piano-medium-double-1.0.safetensors', got


def test_find_checkpoint_falls_back_and_is_stable(tmp_path):
    """没有匹配项时回退到排序后的第一个 —— **必须稳定**，同一目录两次选同一个文件。"""
    d = _mk(tmp_path, CHECKPOINTS)
    first = engine_aria._find_checkpoint(d, 'medium-triple')
    assert os.path.basename(first) == 'piano-medium-double-1.0.safetensors', first
    assert engine_aria._find_checkpoint(d, 'medium-triple') == first
    assert engine_aria._find_checkpoint(d) == first
    assert engine_aria._find_checkpoint(d, None) == first


def test_find_checkpoint_edges(tmp_path):
    """空目录 / 不存在的目录 → None；隐藏文件不算权重。"""
    assert engine_aria._find_checkpoint('') is None
    assert engine_aria._find_checkpoint(None) is None
    assert engine_aria._find_checkpoint(str(tmp_path / 'nope')) is None
    assert engine_aria._find_checkpoint(_mk(tmp_path / 'empty', [])) is None
    assert engine_aria._find_checkpoint(_mk(tmp_path / 'h', ['.hidden.safetensors'])) is None
    d2 = _mk(tmp_path / 'sub', ['.hidden.safetensors', 'real.safetensors'])
    assert os.path.basename(engine_aria._find_checkpoint(d2)) == 'real.safetensors'


def test_aria_pins_are_real_commits():
    """两个 git 包必须钉 40 位 commit，且 git+ 与 zip 两条路取同一个 commit。"""
    assert set(deps.ARIA_PINS) == set(deps.GIT_SOURCES)
    for pkg, sha in deps.ARIA_PINS.items():
        assert re.fullmatch(r'[0-9a-f]{40}', sha), (pkg, sha)
        specs = deps._aria_specs(pkg)
        assert any(s.endswith('.git@' + sha) for s in specs), specs[:3]
        assert any(s.endswith('/archive/' + sha + '.zip') for s in specs), specs[-2:]
        # ★ 不许再有按分支取的写法 —— 那会让 git 可用与否装出不同版本
        assert not any('refs/heads/' in s for s in specs), specs
        assert not any(s.endswith('.git') for s in specs), specs


def test_transkun_is_pinned_exactly():
    """transkun 必须是 == 定版，不能是 >=（默认值会随上游漂移）。"""
    req = open(os.path.join(ENGINE, 'requirements-bundle.txt'), encoding='utf-8').read()
    assert 'transkun==2.0.1' in req
    assert not re.search(r'^transkun>=', req, re.M)


def test_engine_modules_importable():
    """这两个引擎模块必须能导入，available() 返回布尔。

    （它们的 CLI 还有若干未暴露的开关，理由写在 requirements-bundle.txt 里；
    这里只钉住"模块本身是健康的"。）
    """
    import engine_transkun
    assert isinstance(engine_aria.available(), bool)
    assert isinstance(engine_transkun.available(), bool)
