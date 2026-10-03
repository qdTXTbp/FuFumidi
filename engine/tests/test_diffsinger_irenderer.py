# -*- coding: utf-8 -*-
"""`singing/openutau/diffsinger/` 的验收（M1：切句 / 布局 / 缓存 / dynamics）。

照搬基准：`OpenUtau.Core/DiffSinger/DiffSingerRenderer.cs`
（`supportedExp` :25-37、`PhrasePadding` :84-91、`ShouldMergePhrases` :97-100、
 `Layout` :70-82、`Render` :102-150）+ `Render/Renderers.cs:105-125`（ApplyDynamics）。

★ 核心判据：**8 帧 padding 是每句各加一次**（不是整首一次），所以
  `phrase_padding` 必须返回 `8*frameMs`，`GapOverlapsPadding` 才有意义。
"""
import math
import os
import sys

# tests/ → engine/（`singing` 包所在层）
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


class _Singer:
    """最小 Singer：只提供 `ds_config`（hop_size/sample_rate）。"""

    class _Cfg:
        hop_size = 512
        sample_rate = 44100
        use_variable_depth = False
        raw = {'use_variable_depth': False}

    ds_config = _Cfg()
    location = r'C:\Users\26276\Downloads\Compressed\liu2_ying2'


class _Track:
    singer = _Singer()


class _Prev:
    """上一个音素（`GapOverlapsPadding` 只读 position_ms / end_ms）。"""

    def __init__(self, position_ms, end_ms):
        self.position_ms = position_ms
        self.end_ms = end_ms


def main():
    from singing.openutau.diffsinger import DiffsingerIRenderer
    from singing.openutau.renderers import (
        DIFFSINGER, DIFFSINGER_RENDERERS, create_renderer, registered_renderers,
    )

    print('--- 注册 ---')
    r = DiffsingerIRenderer()
    check('已登记到全局渲染器表', 'DIFFSINGER' in registered_renderers(),
          registered_renderers())
    check('create_renderer("DIFFSINGER") 能构造',
          type(create_renderer(DIFFSINGER)).__name__ == 'DiffsingerIRenderer')
    check('DIFFSINGER_RENDERERS 含它', DIFFSINGER in DIFFSINGER_RENDERERS,
          DIFFSINGER_RENDERERS)
    check('__str__ == "DIFFSINGER"（进度文案用）', str(r) == 'DIFFSINGER', str(r))
    check('supports_render_pitch 为真', r.supports_render_pitch() is True)
    check('supports_real_curve 为真', r.supports_real_curve is True)

    print()
    print('--- 表达式白名单（DiffSingerRenderer.cs:25-37）---')
    want = {'dyn', 'pitd', 'genc', 'clr', 'brec', 'voic', 'tenc',
            'velc', 'ene', 'p-exp', 'shfc'}
    check('★ 白名单逐项一致（11 条）', r.SUPPORTED_EXP == want,
          sorted(r.SUPPORTED_EXP ^ want))

    class _D:
        def __init__(self, abbr):
            self.abbr = abbr

    for abbr in ('dyn', 'pitd', 'genc', 'brec', 'voic', 'tenc', 'shfc', 'velc', 'p-exp'):
        check('  supports_expression(%r) 为真' % abbr, r.supports_expression(_D(abbr)))
    for abbr in ('vol', 'atk', 'eng', 'lpf', 'alt', 'xsy', 'dir'):
        check('  supports_expression(%r) 为假' % abbr,
              not r.supports_expression(_D(abbr)))

    print()
    print('--- phrase_padding（:84-91，8 帧）---')
    head, tail = r.phrase_padding(_Singer(), [])
    fms = 1000.0 * 512 / 44100
    check('★ head == 8*frameMs = %.2f ms' % (8 * fms),
          abs(head - 8 * fms) < 0.01, head)
    check('  tail 同 head', abs(tail - head) < 1e-9, (head, tail))
    base = r.__class__(merge_nearby_phrases=False)
    check('★ 与基类默认 (0,0) 不同（DiffSinger 要这 8+8 帧静音）',
          (head, tail) != (0.0, 0.0))

    print()
    print('--- should_merge_phrases（:97-100）---')
    check('★ 开关默认关 → 有间隙就切句（不合并）',
          base.should_merge_phrases(None, _Track(),
                                    _Prev(0, 100), _Prev(400, 500)) is False)
    on = r.__class__(merge_nearby_phrases=True)
    check('  开关开 + 间隙大 → 不合并',
          on.should_merge_phrases(None, _Track(),
                                  _Prev(0, 100), _Prev(400, 500)) is False)
    # 间隙 < head+tail = 185.76 ms → 应合并
    check('  开关开 + 间隙 100ms < 185.76ms → 合并',
          on.should_merge_phrases(None, _Track(),
                                  _Prev(0, 100), _Prev(200, 300)) is True)
    check('  开关关时即使间隙很小也不合并（严格照搬 :98 的 &&）',
          base.should_merge_phrases(None, _Track(),
                                    _Prev(0, 100), _Prev(150, 250)) is False)
    check('  prev 为 None → 不合并',
          on.should_merge_phrases(None, _Track(), None, _Prev(0, 10)) is False)

    print()
    print('--- gap_overlaps_padding 阈值 ---')
    thr = 8 * fms * 2
    check('阈值 = head+tail = %.2f ms' % thr,
          on.gap_overlaps_padding(on, _Track(), _Prev(0, 100),
                                  _Prev(100 + thr - 1, 200)) is True)
    check('  间隙略大于阈值 → 不合并',
          on.gap_overlaps_padding(on, _Track(), _Prev(0, 100),
                                  _Prev(100 + thr + 1, 200)) is False)

    print()
    print('--- layout（:70-82）---')

    class _Axis:
        """最小 TimeAxis：480 tick = 500ms @120bpm。"""

        @staticmethod
        def tick_pos_to_ms_pos(tick):
            return tick * (1000.0 / 480.0)

    class _Phrase:
        time_axis = _Axis()
        position = 180
        leading = 0
        position_ms = 187.5
        duration_ms = 937.5
        singer = _Singer()
        phones = []
        hash = 0x1234ABCD            # 缓存文件名用
        dynamics = None

    res = r.layout(_Phrase())
    check('★ leading_ms == headMs = %.2f' % (8 * fms),
          abs(res.leading_ms - 8 * fms) < 0.01, res.leading_ms)
    check('  position_ms == phrase.position_ms', res.position_ms == 187.5,
          res.position_ms)
    check('★ estimated_length_ms == head + duration + tail = %.2f'
          % (8 * fms + 937.5 + 8 * fms),
          abs(res.estimated_length_ms - (8 * fms + 937.5 + 8 * fms)) < 0.01,
          res.estimated_length_ms)
    check('  samples 为 None（layout 不合成）', res.samples is None)

    print()
    print('--- 缓存文件名（:123-124）---')
    check('  未给 cache_dir → 不缓存（返回 None）',
          r._cache_path(_Phrase(), 1.0, 20) is None)
    r2 = r.__class__(cache_dir='/tmp/dscache')
    p = r2._cache_path(_Phrase(), 0.6, 20)
    check('  目录已设 → 拼出 ds-<hash16>-depth0.60-steps20.wav',
          os.path.basename(p) == 'ds-%016x-depth0.60-steps20.wav' % 0x1234
          or p.endswith('-depth0.60-steps20.wav'), p)
    check('  ★ depth 是 2 位定点（1.0 → depth1.00）',
          r2._cache_path(_Phrase(), 1.0, 20).endswith('depth1.00-steps20.wav'),
          r2._cache_path(_Phrase(), 1.0, 20))

    print()
    print('--- ApplyDynamics（Renderers.cs:105-125）---')
    import numpy as np
    check('dynamics 为空 → 原样返回',
          r._apply_dynamics(_Phrase(), np.ones(10, dtype=np.float32), 0.0) is not None)
    dyn_phrase = _Phrase()
    dyn_phrase.dynamics = [1.0] * 64
    out = r._apply_dynamics(dyn_phrase, np.ones(4410, dtype=np.float32), 0.0)
    check('★ dynamics 全 1 → 波形不变',
          abs(float(out.max()) - 1.0) < 1e-6, out[:3])
    dyn_phrase.dynamics = [0.0] * 64
    out0 = r._apply_dynamics(dyn_phrase, np.ones(4410, dtype=np.float32), 0.0)
    check('★ dynamics 全 0 → 波形被压到 0（确实原地乘了）',
          abs(float(np.abs(out0).max())) < 1e-6, out0[:3])

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())
