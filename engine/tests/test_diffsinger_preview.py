# -*- coding: utf-8 -*-
r"""增量预览的验收（「实时预览」的核心机制）。

照搬基准：
* `DiffSingerRealCurveScheduler.cs` 的 200ms 去抖 + 可取消
* `RenderPriority.cs` 的播放/编辑优先级（在 `render_priority` 里单独测）
* 乐句级缓存 `ds-{hash:x16}-depth{:.2f}-steps{n}.wav`（`DiffSingerRenderer.cs:123`）

★ 要验的四件事：
  1. **缓存命中就不重渲**（hash 没变 → 不调用渲染）
  2. **只渲失效句**（改一个音符 → 只重渲那一句，其余命中）
  3. **连续编辑合并成一轮**（几十次 touch 只开一轮渲染）
  4. **新一轮编辑取消上一轮**（旧的一轮中途停下，不浪费）
"""
import asyncio
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau.diffsinger.preview import (  # noqa: E402
    DEBOUNCE_MS, PreviewScheduler, plan_preview,
)

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    shown = '' if cond or detail is None else ('\n       ' + str(detail))
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, shown))


class Ph:
    """最小 RenderPhrase：只需要 hash / position / end。"""

    def __init__(self, h, pos, end):
        self.hash = h
        self.position = pos
        self.end = end

    def __repr__(self):
        return 'Ph(%x,%d)' % (self.hash, self.position)


def write_cache(cache_dir, phrase, depth=1.0, steps=20):
    """按渲染器的命名规则放一个假的缓存文件（内容不重要）。"""
    name = 'ds-%016x-depth%.2f-steps%d.wav' % (phrase.hash, depth, steps)
    with open(os.path.join(cache_dir, name), 'wb') as f:
        f.write(b'RIFF0000WAVE')
    return name


async def main():
    tmp = tempfile.mkdtemp(prefix='fufumidi-preview-')

    print('--- plan_preview：命中判定 ---')
    a, b = Ph(0xAAAA, 0, 100), Ph(0xBBBB, 200, 300)
    p0 = plan_preview([a, b], tmp)
    check('  两个都没缓存 → 全要渲', len(p0.pending) == 2 and not p0.cached,
          (len(p0.pending), len(p0.cached)))
    write_cache(tmp, a)
    p1 = plan_preview([a, b], tmp)
    check('★ 缓存了 a → 只剩 b 要渲', len(p1.pending) == 1 and p1.pending[0] is b,
          (p1.pending, p1.cached))
    check('  a 被判为命中', p1.cached == [a], p1.cached)
    check('  total 守恒', p1.total == 2)
    # ★ 文件名必须与渲染器一致，否则永远 miss
    check('★ 缓存文件名与渲染器规则一致（ds-<16hex>-depth1.00-steps20.wav）',
          os.path.isfile(os.path.join(tmp, 'ds-%016x-depth1.00-steps20.wav' % a.hash)))
    # depth/steps 进文件名 → 改参数即失效（这是有意的）
    check('  改 depth 后不再命中（参数进文件名，有意为之）',
          len(plan_preview([a], tmp, depth=0.6).pending) == 1)
    check('  无 cache_dir → 全要渲（不缓存模式）',
          len(plan_preview([a], None).pending) == 1)

    print()
    print('--- 调度器：只渲失效句 ---')
    rendered = []
    ready = []

    async def fake_render(ph):
        rendered.append(ph.hash)
        await asyncio.sleep(0.01)
        return b'samples'

    sched = PreviewScheduler(
        render_one=fake_render, cache_dir=tmp, debounce_ms=30,
        on_phrase_ready=lambda ph, smp, was_cached: ready.append((ph.hash, was_cached)))
    sched.start()
    sched.touch([a, b])                       # a 有缓存，b 没有
    await asyncio.sleep(0.2)
    check('★ 只渲了 b（a 命中缓存）', rendered == [b.hash], rendered)
    check('  a 走的是 cached 回调', (a.hash, True) in ready, ready)
    check('  b 走的是 rendered 回调', (b.hash, False) in ready, ready)
    check('  统计：rounds=1 rendered=1 cached=1',
          (sched.stats['rounds'], sched.stats['rendered'], sched.stats['cached']) == (1, 1, 1),
          sched.stats)

    print()
    print('--- ★ 连续编辑合并成一轮（去抖）---')
    rendered.clear(); ready.clear()
    c = Ph(0xCCCC, 400, 500)
    for _ in range(20):                       # 模拟拖动：连点 20 次
        sched.touch([c])
        await asyncio.sleep(0.002)            # 远小于 30ms 去抖窗口
    await asyncio.sleep(0.25)
    check('★ 20 次 touch 只渲 1 次', len(rendered) == 1, rendered)
    check('  轮次数只 +1', sched.stats['rounds'] == 2, sched.stats['rounds'])

    print()
    print('--- ★ 新一轮编辑取消上一轮 ---')
    rendered.clear(); ready.clear()
    order = []

    async def slow_render(ph):
        order.append(('start', ph.hash))
        await asyncio.sleep(0.15)             # 故意慢
        order.append(('end', ph.hash))
        return b'x'

    s2 = PreviewScheduler(render_one=slow_render, cache_dir=None, debounce_ms=20)
    s2.start()
    slow = [Ph(0x1111, 0, 100), Ph(0x2222, 200, 300), Ph(0x3333, 400, 500)]
    s2.touch(slow)                            # 开一轮（3 句，每句 150ms）
    await asyncio.sleep(0.10)                 # 第一句渲到一半
    s2.touch([Ph(0x4444, 0, 100)])            # 用户又改了 → 取消旧的
    await asyncio.sleep(0.4)
    check('★ 旧一轮被取消（第 2/3 句没渲）',
          not any(h in (0x2222, 0x3333) for a, h in order if a == 'start'),
          order)
    check('  新一轮把最后那次编辑渲了',
          any(a == 'start' and h == 0x4444 for a, h in order), order)
    check('  记到了取消计数', s2.stats['canceled'] >= 1, s2.stats)

    print()
    print('--- 停 / drain ---')
    await sched.stop()
    check('  stop() 后 started=False', sched.started is False)
    check('  已不再有新轮次',
          (await _settle(sched), True)[1])

    s3 = PreviewScheduler(render_one=fake_render, cache_dir=None, debounce_ms=20)
    s3.start()
    s3.touch([Ph(0x5555, 0, 100)])
    await asyncio.sleep(0.15)
    before = s3.stats['rendered']
    await s3.drain()
    check('  drain() 返回后该轮已完成', s3.stats['rendered'] >= before)
    await s3.stop()

    print()
    print('--- 空 touch 不炸 ---')
    s4 = PreviewScheduler(render_one=fake_render, cache_dir=None, debounce_ms=10)
    s4.start()
    s4.touch([])
    s4.touch([])
    await asyncio.sleep(0.1)
    check('  空批次不产生轮次', s4.stats['rounds'] == 0, s4.stats)
    await s4.stop()

    print()
    print('--- 上游去抖常量 ---')
    check('  DEBOUNCE_MS == 200（照搬 DiffSingerRealCurveScheduler）',
          DEBOUNCE_MS == 200, DEBOUNCE_MS)

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


async def _settle(sched):
    n = sched.stats['rounds']
    await asyncio.sleep(0.1)
    return sched.stats['rounds'] == n


if __name__ == '__main__':
    sys.exit(asyncio.run(main()))
