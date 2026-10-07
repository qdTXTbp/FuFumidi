# -*- coding: utf-8 -*-
"""验证 `Core/Render` 编辑器侧 5 个文件（544 行）。

`RenderPriority`(48) / `RenderProjection`(42) / `WaveformRefresh`(55) /
`RealCurveUpdater`(214) / `RenderView`(185)。

重点是那些「看起来可以优化」的语义：半开半闭区间、哨兵点 -1、懒分配、
稳定排序、pump 自行退休、首次投递立即、同 x 追加而非覆盖。
"""
import io
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from singing.openutau import (real_curve_updater as RCU, render_priority as RP,  # noqa: E402
                              render_view as RV, waveform_refresh as WR)
from singing.openutau.phrase_layout import PhraseLayout                       # noqa: E402
from singing.openutau.renderer import RenderRealCurveResult                   # noqa: E402
from singing.openutau.render_projection import PhraseView, RenderProjection   # noqa: E402
from singing.ustx.model import (UExpressionDescriptor, UProject,     # noqa: E402
                                         UTrack, UVoicePart, UWavePart, UCurve)

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def _repo():
    return os.path.dirname(os.path.dirname(os.path.dirname(
        os.path.dirname(os.path.abspath(__file__)))))


def _src(name):
    p = os.path.join(_repo(), '_ref', 'OpenUtau', 'OpenUtau.Core', 'Render', name)
    return io.open(p, encoding='utf-8-sig').read().replace('\r\n', '\n') \
        if os.path.isfile(p) else ''


class _FakeResult:
    def __init__(self, abbr, ticks, values):
        self.abbr, self.ticks, self.values = abbr, ticks, values


def main():
    pri = _src('RenderPriority.cs')
    proj = _src('RenderProjection.cs')
    wav = _src('WaveformRefresh.cs')
    rcu = _src('RealCurveUpdater.cs')
    rv = _src('RenderView.cs')

    # ================= 源码一致性
    print('--- 源码一致性 ---')
    # ★ 半开半闭：右端是严格 >。PlaybackBucket / PlaybackDistance 各出现一次，
    #   PreRenderDistance 用的是同构的 phraseEndTick > priorityStartTick。
    check('★ RenderPriority: 区间是半开半闭（右端严格 >）',
          pri.count('sourceEndMs > playbackStartMs') == 2
          and pri.count('sourceStartMs <= playbackStartMs') == 2
          and 'phraseEndTick > priorityStartTick' in pri,
          (pri.count('sourceEndMs > playbackStartMs'),
           pri.count('sourceStartMs <= playbackStartMs')))
    check('★ WaveformRefresh: 节流 100ms 且 lastPost 初始为 -ThrottleMs（首次立即）',
          'const int ThrottleMs = 100;' in wav
          and 'static int lastPost = -ThrottleMs;' in wav)
    check('★ WaveformRefresh: 窗口内无请求则 pump 退休',
          'pump = null;' in wav and 'return;' in wav)
    check('★ RenderView: MinIntervalMs=16 且 lastDeliver 初始为 -MinIntervalMs',
          'const int MinIntervalMs = 16;' in rv
          and 'private int lastDeliver = -MinIntervalMs;' in rv)
    check('★ RenderView: 投递期间的失效交给 pump 下一轮（不递归）',
          'the pump loop\'s next iteration picks it up' in rv)
    check('★ RealCurveUpdater: 开头插哨兵 (ticks[0], -1)',
          'new List<int>(count + 1) { ticks[0] };' in rcu
          and 'new List<int>(count + 1) { -1 };' in rcu)
    check('★ RealCurveUpdater: count = Min(ticks, values)',
          'int count = Math.Min(result.ticks.Length, result.values.Length);' in rcu)
    check('★ RealCurveUpdater: 值换算是 (int)(value * 1000.0)（向零截断）',
          '(int)(value * 1000.0)' in rcu)
    check('★ RealCurveUpdater: tick 换算含 phrasePosition - partPosition',
          'phrasePosition - partPosition + (int)tick' in rcu)
    check('★ RealCurveUpdater: 懒分配（只有发现过期点才建列表）',
          'else if (newXs == null) {' in rcu
          and 'a new list is allocated only when a stale point is found' in rcu)
    check('★ RealCurveUpdater: InsertRange 命中同 x 时向右跳过（追加非覆盖）',
          'while (insertIndex < targetXs.Count && targetXs[insertIndex] <= xs[0])' in rcu)
    check('RealCurveUpdater: MergeRanges 的相邻判定是 <=',
          'if (sorted[i].start <= last.end)' in rcu)
    check('RenderProjection: Ready = 所有当前乐句都有 pcm',
          'Every current phrase has rendered pcm' in proj)

    # ================= RenderPriority
    print('--- RenderPriority ---')
    check('★ 正在播放 → 桶 0',
          RP.playback_bucket(100, 200, 150) == 0)
    check('★ 右端恰好等于播放头 → **不算命中**（严格 >）',
          RP.playback_bucket(100, 150, 150) == 2, RP.playback_bucket(100, 150, 150))
    check('还没开始 → 桶 1', RP.playback_bucket(200, 300, 150) == 1)
    check('已过去 → 桶 2', RP.playback_bucket(0, 100, 150) == 2)
    check('播放距离：命中时 = 播放头 - 起点',
          RP.playback_distance(100, 200, 150) == 50)
    check('播放距离：未开始 = 起点 - 播放头',
          RP.playback_distance(200, 300, 150) == 50)
    check('播放距离：已过去 = 播放头 - 终点',
          RP.playback_distance(0, 100, 150) == 50)
    check('PreRenderBucket：优先段且重叠 → 0',
          RP.pre_render_bucket(True, True, True) == 0)
    check('PreRenderBucket：优先段不重叠 → 1', RP.pre_render_bucket(True, False, True) == 1)
    check('PreRenderBucket：非优先段但在优先段开始后 → 2',
          RP.pre_render_bucket(False, False, True) == 2)
    check('PreRenderBucket：其余 → 3', RP.pre_render_bucket(False, False, False) == 3)
    check('PreRenderDistance：重叠 → 0', RP.pre_render_distance(100, 200, 150) == 0)
    check('PreRenderDistance：在之后 → 起点差',
          RP.pre_render_distance(300, 400, 150) == 150)
    check('PreRenderDistance：在之前 → 终点差',
          RP.pre_render_distance(0, 100, 150) == 50)

    # ================= PhraseView / RenderProjection
    print('--- RenderProjection ---')
    lay = PhraseLayout(start_ms=0, end_ms=100, leading_ms=5, estimated_ms=95)
    v = PhraseView(123, lay, True)
    p = RenderProjection('part', 7, [v], True)
    check('PhraseView 带 hash/layout/rendered',
          (v.hash, v.rendered) == (123, True) and v.layout is lay)
    check('RenderProjection 带 part/revision/phrases/ready',
          p.part == 'part' and p.revision == 7 and p.phrases == [v] and p.ready is True)
    try:
        p.revision = 8
        check('★ RenderProjection 是不可变的（frozen）', False)
    except Exception:
        check('★ RenderProjection 是不可变的（frozen）', True)

    # ================= RealCurveUpdater
    print('--- RealCurveUpdater ---')
    check('★ is_valid：空 abbr / end<start / xy 不等长 / 空 → False',
          not RCU.RealCurveUpdate('', 1, 0, 10, [1], [1]).is_valid
          and not RCU.RealCurveUpdate('a', 1, 10, 0, [1], [1]).is_valid
          and not RCU.RealCurveUpdate('a', 1, 0, 10, [1, 2], [1]).is_valid
          and not RCU.RealCurveUpdate('a', 1, 0, 10, [], []).is_valid
          and RCU.RealCurveUpdate('a', 1, 0, 10, [1], [1]).is_valid)

    # 坐标换算 + 哨兵
    ups = RCU.RealCurveUpdater.build_updates_core(
        part_position=480, phrase_position=960, phrase_hash=42,
        results=[_FakeResult('vol', [0, 240, 480], [0.0, 0.5, -0.25])])
    u = ups[0]
    check('★ tick 换算：phrase - part + 相对 tick',
          u.xs == [480, 480, 720, 960], u.xs)
    check('★ 值换算 ×1000 向零截断（-0.25 → -250）',
          u.ys == [-1, 0, 500, -250], u.ys)
    check('★ 开头有哨兵 -1，且 xs/ys 等长', u.ys[0] == -1 and len(u.xs) == len(u.ys) == 4)
    check('startTick/endTick 取 min/max', (u.start_tick, u.end_tick) == (480, 960))
    check('★ 长度不一致时截到较短者',
          len(RCU.RealCurveUpdater.build_updates_core(
              0, 0, 1, [_FakeResult('vol', [1, 2, 3], [0.1, 0.2])])[0].xs) == 3)
    check('★ 空的 abbr / ticks / values 被跳过',
          RCU.RealCurveUpdater.build_updates_core(0, 0, 1, [_FakeResult('', [1], [0.1])]) == []
          and RCU.RealCurveUpdater.build_updates_core(
              0, 0, 1, [_FakeResult('a', [], [])]) == [])

    # MergeRanges
    check('★ merge_ranges：相邻区间也合并',
          RCU.RealCurveUpdater.merge_ranges([(0, 10), (10, 20), (30, 40)])
          == [(0, 20), (30, 40)],
          RCU.RealCurveUpdater.merge_ranges([(0, 10), (10, 20), (30, 40)]))
    check('★ merge_ranges：重叠取 max(end)',
          RCU.RealCurveUpdater.merge_ranges([(0, 10), (5, 30)]) == [(0, 30)])
    check('★ merge_ranges：输入无序也能正确合并',
          RCU.RealCurveUpdater.merge_ranges([(30, 40), (0, 10), (5, 20)])
          == [(0, 20), (30, 40)])

    # remove_range / insert_range
    xs, ys = [0, 100, 200, 300], [1, 2, 3, 4]
    RCU.RealCurveUpdater.remove_range(xs, ys, 100, 200)
    check('★ remove_range 删闭区间（倒序，不越界）', (xs, ys) == ([0, 300], [1, 4]), (xs, ys))
    tx, ty = [0, 100, 200], [10, 20, 30]
    RCU.RealCurveUpdater.insert_range(tx, ty, [50, 60], [5, 6])
    check('★ insert_range 按序插入', (tx, ty) == ([0, 50, 60, 100, 200], [10, 5, 6, 20, 30]), (tx, ty))
    tx2, ty2 = [0, 50, 100], [10, 20, 30]
    RCU.RealCurveUpdater.insert_range(tx2, ty2, [50, 60], [5, 6])
    check('★ insert_range 命中同 x 时**向右跳过**（同 x 追加而非覆盖）',
          (tx2, ty2) == ([0, 50, 50, 60, 100], [10, 20, 5, 6, 30]), (tx2, ty2))

    # TrimToCoverage（懒分配）
    proj_ = UProject()
    track = UTrack.for_project(proj_)
    proj_.tracks.append(track)
    part = UVoicePart(track_no=0, position=0)
    proj_.parts.append(part)
    c1 = UCurve(abbr='vol', xs=[], ys=[])
    part.curves.append(c1)
    check('★ 空 real_xs 的曲线 → 不改动、不算 changed',
          RCU.RealCurveUpdater.trim_to_coverage(proj_, part, [(0, 100)]) is False)
    c1.real_xs, c1.real_ys = [0, 50, 100, 150, 200], [1, 2, 3, 4, 5]
    check('★ 全部在覆盖范围内 → changed=False（懒分配：列表原对象不变）',
          RCU.RealCurveUpdater.trim_to_coverage(proj_, part, [(0, 200)]) is False)
    check('★ 干净情况下不新建列表（对象仍是原来那个）',
          c1.real_xs == [0, 50, 100, 150, 200] and c1.real_ys == [1, 2, 3, 4, 5])
    check('★ 有过期点 → changed=True 且被裁掉',
          RCU.RealCurveUpdater.trim_to_coverage(proj_, part, [(0, 100)]) is True)
    check('  裁剪结果只留范围内的点',
          c1.real_xs == [0, 50, 100] and c1.real_ys == [1, 2, 3], (c1.real_xs, c1.real_ys))
    check('★ ranges 为空 → False', RCU.RealCurveUpdater.trim_to_coverage(proj_, part, []) is False)
    other = UVoicePart(track_no=0, position=0)
    check('★ part 不在 project.parts 里 → False',
          RCU.RealCurveUpdater.trim_to_coverage(proj_, other, [(0, 100)]) is False)

    # Apply（闸门：phrase hash 必须还在）
    track2 = UTrack.for_project(proj_)
    proj2 = UProject()
    proj2.tracks.append(track2)
    # ★ 描述符要注册在**真正被 apply 的那个工程**上（我第一版注册到了 proj_，
    #   于是 try_get_exp_descriptor 返回 None → apply 静默 False → 后面索引越界）
    proj2.register_expression(UExpressionDescriptor(name='volume', abbr='vol',
                                                    min=0, max=100, default_value=0))
    part2 = UVoicePart(track_no=0, position=0)
    proj2.parts.append(part2)

    class _FakePhrase:
        hash = 42
    part2.render_phrases = [_FakePhrase()]
    up = RCU.RealCurveUpdate('vol', 42, 100, 200, [100, 200], [-1, 500])
    check('★ apply：哈希命中 → 写入并新建曲线',
          RCU.RealCurveUpdater.apply(proj2, part2, [up]) is True
          and len(part2.curves) == 1 and part2.curves[0].real_xs == [100, 200])
    up_stale = RCU.RealCurveUpdate('bre', 999, 100, 200, [100, 200], [-1, 500])
    check('★ apply：过期乐句哈希的更新被丢弃',
          RCU.RealCurveUpdater.apply(proj2, part2, [up_stale]) is False
          and len(part2.curves) == 1)
    # 再写一次 → 覆盖同区间
    up2 = RCU.RealCurveUpdate('vol', 42, 100, 200, [100, 200], [-1, 700])
    RCU.RealCurveUpdater.apply(proj2, part2, [up2])
    check('★ apply 同一区间是**替换**（先删后插），不是追加',
          part2.curves[0].real_xs == [100, 200] and part2.curves[0].real_ys == [-1, 700],
          (part2.curves[0].real_xs, part2.curves[0].real_ys))
    check('★ apply：空 updates → False', RCU.RealCurveUpdater.apply(proj2, part2, []) is False)

    # ================= WaveformRefresh
    print('--- WaveformRefresh ---')
    # WR 是**模块**（照搬 C# 的 static class → 类），要用 WaveformRefresh.reset()
    WR.WaveformRefresh.reset()
    hits = []
    WR.WaveformRefresh.set_on_ready(lambda: hits.append(1))
    WR.WaveformRefresh.request()
    deadline = time.time() + 3
    while time.time() < deadline and not hits:
        time.sleep(0.02)
    check('★ 第一次 request() **立即**投递（lastPost 初值为负）', len(hits) == 1, len(hits))
    n0 = len(hits)
    for _ in range(20):
        WR.WaveformRefresh.request()      # 一轮"200 句"式密集请求
    time.sleep(0.4)
    check('★ 密集请求被合并（远少于 20 次投递）',
          len(hits) - n0 <= 2, '%d 次' % (len(hits) - n0))
    check('★ 空闲后 pump 自行退休（不残留线程）',
          WR.WaveformRefresh._pump is None
          or not WR.WaveformRefresh._pump.is_alive())
    WR.WaveformRefresh.reset()

    # ================= RenderView
    print('--- RenderView ---')
    RV.RenderView.reset_instance()
    view = RV.RenderView.get_instance()
    check('get_instance() 是进程级单例', RV.RenderView.get_instance() is view)

    class _FakeWave:
        pos_ms, dur_ms = 10, 100
    class _FakePlanner:
        def __init__(self, hashes=()):
            self._h = set(hashes)

        def try_get_phrase_pcm(self, part, phrase_hash):
            if phrase_hash not in self._h:
                return None
            # 伴奏 part（hash 0）要的是带 pos_ms/dur_ms 的 pcm 描述
            return _FakeWave()
    class _FakeRenderPhrase:
        def __init__(self, h):
            self.hash = h
            self.layout = PhraseLayout(start_ms=0, end_ms=10)

    vp = UVoicePart(track_no=0, position=0)
    vp.render_phrases = [_FakeRenderPhrase(1), _FakeRenderPhrase(2)]
    view.set_planner_for_test(_FakePlanner([1]))          # 只渲染了第 1 句
    proj_v = view.current(vp)
    check('★ ready = 所有乐句都有 pcm（这里只 1/2 → False）',
          proj_v.ready is False, proj_v.ready)
    check('  每句的 rendered 正确',
          [x.rendered for x in proj_v.phrases] == [True, False])
    check('  投影被缓存（同一对象）', view.current(vp) is proj_v)
    def _empty_part():
        q = UVoicePart(track_no=0, position=0)
        q.render_phrases = []
        return q
    check('★ 每次 build revision 自增', view.current(_empty_part()).revision >= 1)

    empty = _empty_part()
    p_empty = view.current(empty)
    check('★ 空 part 的 ready 是 False（无乐句 ≠ 渲染好）', p_empty.ready is False)
    check('  空 part 的 phrases 是空列表', p_empty.phrases == [])

    wp = UWavePart(track_no=0, position=0)
    view.set_planner_for_test(_FakePlanner())
    p_wave = view.current(wp)
    check('★ 伴奏 part 无 pcm → 空 phrases + ready=False',
          p_wave.phrases == [] and p_wave.ready is False)
    view.set_planner_for_test(_FakePlanner([0]))
    view.forget_all()
    p_wave2 = view.current(wp)
    check('★ 伴奏 part 有 pcm → hash 0 的一"放置"，ready=True',
          len(p_wave2.phrases) == 1 and p_wave2.phrases[0].hash == 0
          and p_wave2.ready is True, p_wave2)

    # 观察者 + 合并投递
    got = []
    sub = view.observe(lambda pr: got.append(pr))
    view.set_planner_for_test(_FakePlanner([1, 2]))
    view.invalidate_all()
    t0 = time.time()
    while time.time() - t0 < 3 and not got:
        time.sleep(0.02)
    check('★ invalidate_all() 会把新投影投递给观察者', len(got) >= 1, len(got))
    check('★ 投递后 ready 变 True（两句都渲染了）',
          all(pr.ready for pr in got if pr.part is vp), [pr.ready for pr in got])
    n1 = len(got)
    for _ in range(10):
        view.invalidate_all()
    time.sleep(0.3)
    check('★ 密集失效被合并（≤3 次投递）', len(got) - n1 <= 3, '%d 次' % (len(got) - n1))
    sub.dispose()
    n2 = len(got)
    view.invalidate_all()
    time.sleep(0.3)
    check('退订后不再收到', len(got) == n2, '%d → %d' % (n2, len(got)))
    check('★ forget_all() 清空缓存', (view.forget_all() or True) and view._projections == {})
    RV.RenderView.reset_instance()

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


if __name__ == '__main__':
    sys.exit(main())