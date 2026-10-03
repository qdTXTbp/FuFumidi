# -*- coding: utf-8 -*-
r"""多句编排的验收（M3）。

照搬基准：`OpenUtau.Core/Render/RenderEngine.cs`
（`RenderPartRequest` :75-89、布局循环 :300-321、`RenderRequests` :325-441、
`MixPlanner.RegisterPcm`）。

★ 核心判据：**`phraseOffsetMs = positionMs - leadingMs`（:318）**——
  漏掉 `leadingMs` 会让整轨右移一个 head（8 帧 ≈ 93ms）。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.diffsinger.render_engine import (  # noqa: E402
    MixPlanner, RenderPartRequest, build_render_requests, render_requests,
)

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


FMS = 1000.0 * 512 / 44100
HEAD = 8 * FMS          # 92.88 ms


class _Renderer:
    """最小渲染器：layout 照搬 DiffSinger 的（leadingMs = head）。"""

    def __init__(self):
        self.rendered = []

    def layout(self, phrase):
        class R:
            pass
        r = R()
        r.samples = None
        r.leading_ms = HEAD
        r.position_ms = phrase.position_ms
        r.estimated_length_ms = HEAD + phrase.duration_ms + HEAD
        return r

    async def render(self, phrase, *a, **k):
        self.rendered.append(phrase)
        import numpy as np
        # 每句给一段可区分长度的静音，长度 = durationMs
        n = int(phrase.duration_ms / 1000.0 * 44100)
        return type('Res', (), {'samples': np.zeros(n, dtype='float32'),
                                 'sample_rate': 44100, 'leading_ms': HEAD,
                                 'position_ms': phrase.position_ms,
                                 'estimated_length_ms': HEAD + phrase.duration_ms + HEAD})()


class _Phrase:
    def __init__(self, position, position_ms, duration_ms, end):
        self.position = position
        self.position_ms = position_ms
        self.duration_ms = duration_ms
        self.end = end
        self.hash = position & 0xFFFF
        self.renderer = _Renderer()


class _Part:
    def __init__(self, phrases):
        self.phrases = phrases
    def __repr__(self):
        return 'Part(%d 句)' % len(self.phrases)


async def _run(coro):
    return await coro


def main():
    import asyncio
    import numpy as np

    # 两句：第 1 句 200ms，第 2 句 300ms，起点分别在 500ms / 1500ms。
    # ★ tick 必须**自洽**：`position` / `end` 都是 tick（480 tick = 500ms @120bpm）
    p1 = _Phrase(0, 500.0, 200.0, 400)        # tick 0   → 500ms，时长 200ms → end 400 tick
    p2 = _Phrase(960, 1500.0, 300.0, 1760)    # tick 960 → 1500ms，时长 300ms → end 1760 tick
    part = _Part([p1, p2])

    print('--- build_render_requests：布局循环（:300-321）---')
    reqs = build_render_requests([part], get_phrases=lambda p: p.phrases)
    check('产出 1 个 RenderPartRequest', len(reqs) == 1, len(reqs))
    r = reqs[0]
    check('  装进 2 句', len(r.phrases) == 2, len(r.phrases))
    check('★ offset/estimated 与 phrases 平行（各 2 个）',
          len(r.phrase_offset_ms) == 2 and len(r.phrase_estimated_length_ms) == 2,
          (r.phrase_offset_ms, r.phrase_estimated_length_ms))
    # ★ 句1: offset = 500 - 92.88 = 407.12
    check('★ 句1 offsetMs = positionMs - leadingMs = %.2f' % (500 - HEAD),
          abs(r.phrase_offset_ms[0] - (500.0 - HEAD)) < 1e-6, r.phrase_offset_ms[0])
    check('★ 句2 offsetMs = %.2f' % (1500 - HEAD),
          abs(r.phrase_offset_ms[1] - (1500.0 - HEAD)) < 1e-6, r.phrase_offset_ms[1])
    check('★ estimatedLengthMs 含首尾 padding（句1 = %.2f）'
          % (HEAD + 200 + HEAD),
          abs(r.phrase_estimated_length_ms[0] - (HEAD + 200 + HEAD)) < 1e-6,
          r.phrase_estimated_length_ms[0])
    check('  ★ 漏掉 leadingMs 会右移 %.2f ms（这正是要防的错）' % HEAD,
          r.phrase_offset_ms[0] != 500.0)

    print()
    print('--- 选区过滤（:308-312）---')
    # 上游 :308-312：`phrase.end > startTick && (endTick == -1 || phrase.position < endTick)`
    reqs2 = build_render_requests([part], start_tick=0, end_tick=600,
                                  get_phrases=lambda p: p.phrases)
    n2 = len(reqs2[0].phrases) if reqs2 else 0
    check('★ end_tick=600 → 只留 position<600 的句（句1 在 tick0 → 留 1 句）',
          n2 == 1, n2)
    reqs3 = build_render_requests([part], start_tick=1000, end_tick=-1,
                                  get_phrases=lambda p: p.phrases)
    n3 = len(reqs3[0].phrases) if reqs3 else 0
    check('  start_tick=1000 → 只留 end>1000 的句（句2 end=1760 → 留 1 句）',
          n3 == 1, n3)
    reqs4 = build_render_requests([part], start_tick=0, end_tick=0,
                                  get_phrases=lambda p: p.phrases)
    check('  ★ 选区完全在前面（end_tick=0）→ 不产出 request', not reqs4, reqs4)

    print()
    print('--- render_requests：逐句渲染（:325-441 的串行核心）---')
    out = asyncio.run(_run(render_requests(reqs)))
    check('产出 2 条结果', len(out) == 2, len(out))
    check('  每条带 hash/offset/estimated/samples',
          all(all(k in o for k in ('hash', 'offset_ms', 'estimated_length_ms', 'samples'))
              for o in out), sorted(out[0]) if out else None)
    check('  completed 递增 1→2',
          [o['completed'] for o in out] == [1, 2], [o['completed'] for o in out])
    check('  ★ 两句都真的被渲染了',
          len(p1.renderer.rendered) == 1 and len(p2.renderer.rendered) == 1,
          (len(p1.renderer.rendered), len(p2.renderer.rendered)))
    check('  completed_phrases 归零（每轮新建，:85）', r.completed_phrases == 2,
          r.completed_phrases)

    print()
    print('--- 取消（:356-358）---')
    seen = []
    out2 = asyncio.run(_run(render_requests(
        reqs, on_phrase_done=lambda d, t: seen.append((d, t)),
        should_cancel=lambda: len(seen) >= 1)))
    check('★ should_cancel 生效（只渲了 1 句就停）', len(out2) == 1, len(out2))
    check('  进度回调收到 (done, total) 且 total=2', seen and seen[0] == (1, 2), seen)

    print()
    print('--- MixPlanner：按 offset 落位（RegisterPcm）---')
    planner = MixPlanner()
    for o in out:
        planner.register_pcm(o['part'], o['hash'], o['offset_ms'],
                             o['estimated_length_ms'], 1.0, o['samples'])
    check('track_count == 1', planner.track_count() == 1, planner.track_count())
    res = planner.get_result()
    total = res['samples']
    # 末尾 = max(offset + estimated) = 1500-92.88 + 92.88+300+92.88 = 1892.88 ms
    want_ms = 1500.0 - HEAD + (HEAD + 300 + HEAD)
    check('★ 整轨长度 = max(offset+estimated) = %.2f ms' % want_ms,
          abs(res['estimated_length_ms'] - want_ms) < 1.0, res['estimated_length_ms'])
    check('  采样数与长度一致',
          abs(len(total) / 44100.0 * 1000 - want_ms) < 30,
          len(total) / 44100.0 * 1000)
    check('  ★ 尾部 padding 没被截掉（含 head+tail）',
          len(total) / 44100.0 * 1000 > 1500.0,
          len(total) / 44100.0 * 1000)

    print()
    print('--- 两句不重叠时各自独立（应能看出两个峰）---')
    planner2 = MixPlanner()
    a = np.zeros(int(0.2 * 44100), dtype='float32'); a[:] = 1.0
    b = np.zeros(int(0.3 * 44100), dtype='float32'); b[:] = 1.0
    p_a, p_b = _Part([]), _Part([])
    planner2.register_pcm(p_a, 1, 0.0, 200.0, 1.0, a)
    planner2.register_pcm(p_b, 2, 1000.0, 300.0, 1.0, b)
    t2 = planner2.get_result()['samples']
    nz = np.nonzero(np.abs(t2) > 0.5)[0]
    seg = (nz[-1] - nz[0]) / 44100.0
    check('★ 两段相隔约 1 秒（跨度 %.2fs）', 1.0 < seg < 1.3, seg)

    print()
    print('--- 空输入 ---')
    check('build_render_requests([]) → []', build_render_requests([]) == [])
    check('render_requests([]) → []', asyncio.run(_run(render_requests([]))) == [])
    check('MixPlanner 空 → get_result() 为 None', MixPlanner().get_result() is None)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())
