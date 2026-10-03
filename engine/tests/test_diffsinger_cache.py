# -*- coding: utf-8 -*-
r"""M4 验收：wav 缓存 + ApplyDynamics（**顺序**是全部要点）。

照搬基准：
* `DiffSingerRenderer.cs:123-141` —— `ds-{hash:x16}-depth{depth:f2}-steps{steps}.wav`，
  命中就读、读失败只记日志并重渲
* `DiffSingerRenderer.cs:139` 写盘 → `:143` `ApplyDynamics`

★ **顺序不可错**：磁盘上的 wav **不含** dynamics，`ApplyDynamics` 在**每次**
  返回前都跑 —— 这样缓存命中时不会漏增益、也不会二次增益。
  若把 dynamics 烘进缓存，缓存命中就会重复乘一次。
"""
import asyncio
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402

from singing.openutau.diffsinger import DiffsingerIRenderer  # noqa: E402
from singing.openutau.diffsinger import diffsinger_renderer as impl  # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


class _Axis:
    @staticmethod
    def tick_pos_to_ms_pos(tick):
        return tick * (1000.0 / 480.0)


class _Phrase:
    """最小 RenderPhrase：只需 hash / position / leading / ms / dynamics / phones。"""

    def __init__(self, dynamics=None, hash_value=0xABCD1234, duration_ms=200.0):
        self.hash = hash_value
        self.position = 0
        self.leading = 0
        self.position_ms = 0.0
        self.duration_ms = duration_ms
        self.time_axis = _Axis()
        self.phones = []
        self.dynamics = dynamics
        self.cache_files = []
        self.singer = None
        self.renderer = None
        self._render_count = 0

    def add_cache_file(self, path):
        self.cache_files.append(path)

    def delete_cache_files(self):
        for p in list(self.cache_files):
            try:
                os.remove(p)
            except OSError:
                pass
        self.cache_files = []


async def _fake_render(phrase, progress=None, cancellation=None, **kw):
    """冒充 `diffsinger` 的真实合成：给一段**已带 dynamics 的**波形。

    ★ 真实链路里 dynamics 是在 vocoder 之后由 `ApplyDynamics` 乘的；这里让
      `_render_phrase_audio` 直接返回"干声"，再由渲染器乘 dynamics，
      这样才能验证"缓存里不含 dynamics"。
    """
    phrase._render_count += 1
    n = int(phrase.duration_ms / 1000.0 * 44100)
    # ★ 真实 `_render_phrase_audio` 返回的是 **ndarray**（不是 RenderResult），
    #   渲染器再把它包进 RenderResult。这里必须照搬，否则测的是错的接口。
    return np.full(n, 0.5, dtype=np.float32)


def main():
    tmp = tempfile.mkdtemp(prefix='fufumidi-dscache-')
    # 让 _render_phrase_audio 走我们的假实现
    impl._render_phrase_audio = _fake_render
    try:
        print('--- 缓存文件名（:123-124）---')
        r = DiffsingerIRenderer(cache_dir=tmp)
        ph = _Phrase()
        p1 = r._cache_path(ph, 0.6, 20)
        check('  名字形如 ds-<16位hex>-depth0.60-steps20.wav',
              os.path.basename(p1) == 'ds-00000000abcd1234-depth0.60-steps20.wav'
              or (os.path.basename(p1).startswith('ds-')
                  and os.path.basename(p1).endswith('-depth0.60-steps20.wav')),
              os.path.basename(p1))
        check('  depth 1.0 → depth1.00（2 位定点，:123 的 {depth:f2}）',
              r._cache_path(ph, 1.0, 20).endswith('depth1.00-steps20.wav'),
              os.path.basename(r._cache_path(ph, 1.0, 20)))
        check('  steps 参与文件名',
              r._cache_path(ph, 1.0, 5).endswith('steps5.wav'),
              os.path.basename(r._cache_path(ph, 1.0, 5)))
        check('  未设 cache_dir → 不缓存',
              DiffsingerIRenderer()._cache_path(ph, 1.0, 20) is None)

        print()
        print('--- 第一次渲染：写缓存（:124-141）---')
        ph_dyn = _Phrase(dynamics=[0.5] * 128, hash_value=0x1111)
        res1 = asyncio.run(r.render(ph_dyn))
        check('渲染成功', res1 is not None and res1.samples is not None)
        check('  真的合成了一次', ph_dyn._render_count == 1, ph_dyn._render_count)
        cache_file = r._cache_path(ph_dyn, 1.0, 20)
        check('  缓存文件已落盘', os.path.isfile(cache_file), cache_file)
        check('  AddCacheFile 已登记', cache_file in ph_dyn.cache_files,
              ph_dyn.cache_files)
        if os.path.isfile(cache_file):
            disk = impl._read_wav_mono(cache_file)
            check('★ 缓存里是**干声**（峰值 0.5，未乘 dynamics）',
                  disk is not None and abs(float(np.abs(disk).max()) - 0.5) < 1e-3,
                  None if disk is None else float(np.abs(disk).max()))
            check('★ 返回的波形**已乘** dynamics（峰值 ≈ 0.5*0.5=0.25）',
                  abs(float(np.abs(res1.samples).max()) - 0.25) < 1e-3,
                  float(np.abs(res1.samples).max()))
            check('  缓存长度 == 干声长度（dynamics 只是原地乘，不改长度）',
                  len(disk) == len(res1.samples), (len(disk), len(res1.samples)))

        print()
        print('--- 第二次渲染：命中缓存（:128-134）---')
        ph_hit = _Phrase(dynamics=[0.5] * 128, hash_value=0x1111)
        res2 = asyncio.run(r.render(ph_hit))
        check('★ 命中缓存 → **没有**再合成', ph_hit._render_count == 0,
              ph_hit._render_count)
        check('  返回的波形长度与第一次一致', len(res2.samples) == len(res1.samples),
              (len(res2.samples), len(res1.samples)))
        check('★ 命中缓存时 dynamics **仍被应用一次**（不漏增益）',
              abs(float(np.abs(res2.samples).max()) - 0.25) < 1e-3,
              float(np.abs(res2.samples).max()))
        check('  ★ 没有二次增益（不是 0.125）',
              abs(float(np.abs(res2.samples).max()) - 0.125) > 1e-3,
              float(np.abs(res2.samples).max()))

        print()
        print('--- 缓存损坏：记日志并重渲（:132-134）---')
        ph_bad = _Phrase(dynamics=[1.0] * 128, hash_value=0x2222)
        bad_file = r._cache_path(ph_bad, 1.0, 20)
        with open(bad_file, 'wb') as f:
            f.write(b'not a wav file at all')
        res3 = asyncio.run(r.render(ph_bad))
        check('★ 坏缓存 → 重新合成', ph_bad._render_count == 1, ph_bad._render_count)
        check('  仍返回有效波形', res3.samples is not None
              and len(res3.samples) > 0)
        check('  坏文件被覆盖成真 wav', impl._read_wav_mono(bad_file) is not None)

        print()
        print('--- delete_cache_files（RenderPhrase.cs:634-661）---')
        ph_del = _Phrase(hash_value=0x3333)
        asyncio.run(r.render(ph_del))
        cf = r._cache_path(ph_del, 1.0, 20)
        check('  缓存存在', os.path.isfile(cf), cf)
        ph_del.delete_cache_files()
        check('★ 删掉了', not os.path.isfile(cf))
        check('  登记也清空', ph_del.cache_files == [], ph_del.cache_files)

        print()
        print('--- layout 与 render 的 leading/position 一致（:70-82）---')
        class _S:
            class _C:
                hop_size = 512
                sample_rate = 44100
            ds_config = _C()
        ph_l = _Phrase(hash_value=0x4444, duration_ms=200.0)
        ph_l.singer = _S()
        lay = r.layout(ph_l)
        check('  layout.leading_ms == 8 帧', abs(lay.leading_ms - 92.88) < 0.01,
              lay.leading_ms)
        check('  ★ estimated_length_ms 含首尾 padding',
              abs(lay.estimated_length_ms - (92.88 + 200 + 92.88)) < 0.01,
              lay.estimated_length_ms)
        check('  ★ offset = position - leading = %.2f' % (0.0 - lay.leading_ms),
              abs((lay.position_ms - lay.leading_ms) + 92.88) < 0.01)

        print()
        print('--- _singer_dir / _as_acoustic_config ---')
        check('  _singer_dir 认 location',
              impl._singer_dir(type('S', (), {'location': r'C:\vb'})()) == r'C:\vb')
        check('  _singer_dir 认 dir',
              impl._singer_dir(type('S', (), {'dir': r'C:\vb2'})()) == r'C:\vb2')
        check('  都没有 → 报错',
              _raises(lambda: impl._singer_dir(object()), ValueError))
        cfg = impl._as_acoustic_config(
            type('C', (), {'use_continuous_acceleration': True,
                           'use_variable_depth': True,
                           'raw': {'max_depth': 0.6}})())
        check('  _as_acoustic_config 适配 use_* 开关',
              cfg.use_continuous_acceleration and cfg.use_variable_depth)
        check('  ★ max_depth=0.6 原值（contAcc=true 不除 1000）',
              abs(cfg.max_depth - 0.6) < 1e-9, cfg.max_depth)
        from diffsinger.config import resolve_depth
        check('  ★ resolve_depth → min(1.0, 0.6) = 0.6',
              abs(resolve_depth(cfg, 1.0) - 0.6) < 1e-9, resolve_depth(cfg, 1.0))

        print()
        print('结果: %d passed, %d failed' % (len(_P), len(_F)))
        for f in _F:
            print('  FAILED:', f)
        return 1 if _F else 0
    finally:
        impl._render_phrase_audio = _orig_render


def _raises(fn, exc):
    try:
        fn()
        return False
    except exc:
        return True
    except Exception:
        return False


_orig_render = impl._render_phrase_audio

if __name__ == '__main__':
    sys.exit(main())
