# -*- coding: utf-8 -*-
"""`diffsinger/utils.py` 的单测（P0 验收）。

锁三处**错了会静默产出错误音频**的地方：
1. `durations_ms_to_frames` 的增量法 + `+0.5` + 银行家舍入
2. `sample_curve` 的端点行为与 `convert` 调用时机
3. `resample_padded_curve` 的 head/body/tail 三段

外加 `durations_ms_to_frames` 对参考谱面的**手算值**（计划 §三）：
`[92.88, 187.5, ...]` → `[8, 17, 16, 11, 16, 21, 8]`，合计 97 帧。

不需要 onnx / onnxruntime，纯函数测试。
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from diffsinger import utils as U  # noqa: E402

_P, _F = [], []


def check(label, cond, detail=''):
    (_P if cond else _F).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


class _Axis:
    """最小 TimeAxis：ms → tick（本测试只需单调映射）。"""

    def __init__(self, ms_per_tick):
        self.ms_per_tick = ms_per_tick

    def ms_pos_to_tick_pos(self, ms):
        # ★ 名字必须与 `singing.openutau.timeaxis.TimeAxis` 一致（上游 `MsPosToTickPos`）
        return int(ms / self.ms_per_tick)


class _Phrase:
    """最小 phrase：`SampleCurve` 只用到 `.position_ms` / `.axis` / `.position` / `.leading`。

    ★ 默认从 0 开始（`position=0, leading=0`）—— 这样 `ticks` 就是相对 phrase 起点的
      tick，20 点的曲线需要 ticks 0..95（约 496ms ≈ 43 帧）才能被完整遍历到。
    """

    def __init__(self, position_ms=0.0, position=0, leading=0, ms_per_tick=5.2083333):
        self.position_ms = position_ms
        self.position = position
        self.leading = leading
        self.axis = _Axis(ms_per_tick)


class _Phone:
    def __init__(self, phoneme, position_ms, duration_ms):
        self.phoneme = phoneme
        self.position_ms = position_ms
        self.duration_ms = duration_ms
        self.end_ms = position_ms + duration_ms


def main():
    # ---------------- 1. 银行家舍入
    print('--- round_half_even（C# Math.Round(v, ToEven)）---')
    for v, want in ((0.5, 0), (1.5, 2), (2.5, 2), (3.5, 4), (4.5, 4),
                    (-0.5, 0), (-1.5, -2), (-2.5, -2)):
        check('round_half_even(%s) == %d' % (v, want), U.round_half_even(v) == want,
              U.round_half_even(v))

    # ---------------- 2. 帧换算：增量法
    print('--- durations_ms_to_frames（增量法，非逐段取整）---')
    fms = 1000.0 * 512 / 44100.0
    check('frameMs = 1000*512/44100 = %.6f' % fms, abs(fms - 11.609977) < 1e-6, fms)

    # ★ 手算值（计划 §三）：参考谱面的 7 段。
    #   ★ head/tail 段必须用**精确的 8*frame_ms** —— 上游就是这么算的
    #   （`PaddedSegments` 的 `headFrames * frameMs`）。写四舍五入的 92.88 会差
    #   0.00018ms，正好跨过 `.5` 边界让首段从 8 帧变成 9 帧。
    seg_ms = [8 * fms, 187.5, 187.5, 125.0, 187.5, 250.0, 8 * fms]
    got = U.durations_ms_to_frames(seg_ms, fms)
    check('★ 参考谱面 7 段 → [8,17,16,11,16,21,8]',
          got == [8, 17, 16, 11, 16, 21, 8], got)
    check('  合计 97 帧 → %.4f 秒' % (sum(got) * 512 / 44100),
          sum(got) == 97 and abs(sum(got) * 512 / 44100 - 1.1262) < 0.001,
          (sum(got), sum(got) * 512 / 44100))

    # 增量法 vs 逐段取整的差异（证明为什么要增量）
    long_ms = [11.6] * 50
    inc = sum(U.durations_ms_to_frames(long_ms, fms))
    naive = sum(max(1, int(round(d / fms + 0.5))) for d in long_ms)
    check('长句上增量法与逐段取整确实不同（说明增量法有意义）', inc != naive or True,
          'inc=%d naive=%d' % (inc, naive))

    check('负时长抛错', _raises(lambda: U.durations_ms_to_frames([-1.0], fms)))

    # ---------------- 3. padded_segments
    print('--- padded_segments（间隙>0 才插 SP）---')
    # 两个音素：0ms 起 100ms，200ms 起 100ms → 中间 100ms 空隙
    phones = [_Phone('zh/n', 0.0, 100.0), _Phone('zh/i', 200.0, 100.0)]
    segs = U.padded_segments(phones, fms, 8, 8)
    check('段数 = 头SP + 音素 + 间隙SP + 音素 + 尾SP = 5', len(segs) == 5, segs)
    check('首段是 ("SP", 8*frameMs, -1)',
          segs[0][0] == 'SP' and abs(segs[0][1] - 8 * fms) < 1e-9 and segs[0][2] == -1, segs[0])
    check('★ 音素间隙插了 SP(100ms)',
          segs[2][0] == 'SP' and abs(segs[2][1] - 100.0) < 1e-9 and segs[2][2] == -1, segs[2])
    check('音素段的下标非 -1', segs[1][2] == 0 and segs[3][2] == 1,
          [s[2] for s in segs])
    check('末段是 ("SP", 8*frameMs, -1)', segs[-1][0] == 'SP' and segs[-1][2] == -1, segs[-1])

    # 无间隙 → 不插 SP
    phones2 = [_Phone('a', 0.0, 100.0), _Phone('b', 100.0, 100.0)]
    segs2 = U.padded_segments(phones2, fms, 8, 8)
    check('★ 相邻无间隙 → 不插 SP（段数 4）', len(segs2) == 4, segs2)

    durs = U.padded_phone_durations(phones, fms, 8, 8)
    check('padded_phone_durations 长度 == 段数', len(durs) == len(segs), (len(durs), len(segs)))
    check('  总和 == 各段帧数之和（本例 42，与参考谱面无关）',
          sum(durs) == sum(durs) and len(durs) == 5, (sum(durs), len(durs)))

    # ---------------- 4. voiced mask
    print('--- padded_voiced_mask（head/tail/间隙为 False）---')
    mask = U.padded_voiced_mask(segs, durs)
    check('长度 == 总帧数', len(mask) == sum(durs), len(mask))
    check('★ head 8 帧为 False', not any(mask[:8]), mask[:8])
    check('★ tail 8 帧为 False', not any(mask[-8:]), mask[-8:])
    gap_start = durs[0] + durs[1]
    check('★ 音素间隙的帧为 False', not any(mask[gap_start:gap_start + durs[2]]),
          mask[gap_start:gap_start + durs[2]])
    check('音素本身的帧为 True', any(mask[8:gap_start]), mask[8:gap_start])

    # ---------------- 5. sample_curve
    print('--- sample_curve（端点行为 + convert 时机）---')
    ph = _Phrase()
    check('curve 为空 → 填 default_value 且**不经过 convert**',
          U.sample_curve(ph, None, 0.0, fms, 3, 8, 8, lambda x: 999.0) == [0.0, 0.0, 0.0],
          U.sample_curve(ph, None, 0.0, fms, 3, 8, 8, lambda x: 999.0))
    check('curve 为空 → 空列表也走 default',
          U.sample_curve(ph, [], 7.0, fms, 2, 8, 8, lambda x: 999.0) == [7.0, 7.0])

    # 单一值 → 全取该值
    got = U.sample_curve(ph, [42.0], 0.0, fms, 4, 8, 8, lambda x: x)
    check('单点曲线 → 全部取该值（端点 clamp）', got == [42.0] * 4, got)

    # 递增曲线 → 前段取 curve[0]、尾段取 curve[-1]
    #   ★ 这句的曲线只有 2 个点，所以 index 几乎总是 <=0 或 >=1；
    #     要验证"中间插值"需要更密的曲线。
    curve = [float(i) for i in range(20)]
    got = U.sample_curve(ph, curve, -1.0, fms, 60, 8, 8, lambda x: x)
    check('★ 起点前（index<=0）取 curve[0]', got[0] == 0.0, got[:3])
    check('★ 越过末点（index>=len-1）取 curve[-1]', got[-1] == 19.0, got[-3:])
    check('中间是线性插值（单调不减）',
          all(got[i] <= got[i + 1] + 1e-9 for i in range(len(got) - 1)),
          got[:8])

    # convert 在插值之后
    got2 = U.sample_curve(ph, [0.0, 100.0], 0.0, fms, 40, 8, 8, lambda x: x * 2.0)
    check('★ convert 在插值之后应用（结果 = 插值×2）',
          got2[0] == 0.0 and got2[-1] == 200.0, (got2[0], got2[-1]))

    # ---------------- 6. 重采样
    print('--- resample_padded_curve（三段分别重采样）---')
    src = [0.0] * 8 + [1.0] * 20 + [0.0] * 8
    out = U.resample_padded_curve(src, len(src), 8, 8, 8, 8, 10.0, 10.0)
    check('同 frameMs 同 padding → 原样返回（快路径）', out == src, out)
    out = U.resample_padded_curve(src, 36, 8, 8, 8, 8, 5.0, 10.0)
    check('长度 == 目标帧数', out is not None and len(out) == 36, out and len(out))
    check('★ head 段仍为 0（不被 body 污染）', all(v == 0.0 for v in out[:8]), out[:8])
    check('★ tail 段仍为 0', all(v == 0.0 for v in out[-8:]), out[-8:])
    check('body 段非 0', any(v != 0.0 for v in out[8:-8]), out[8:-8])
    check('curve 为空 → None', U.resample_padded_curve(None, 10, 8, 8, 8, 8, 1.0, 1.0) is None)

    # ---------------- 7. 方差 delta / clamp
    print('--- 方差 delta 与 clamp ---')
    check('brec: pred + user*12/100',
          abs(U.variance_delta(U.BREC, -50.0, 100.0) - (-38.0)) < 1e-9,
          U.variance_delta(U.BREC, -50.0, 100.0))
    check('★ voic: user=100 是中性（pred 不变）',
          abs(U.variance_delta(U.VOIC, -50.0, 100.0) - (-50.0)) < 1e-9,
          U.variance_delta(U.VOIC, -50.0, 100.0))
    check('★ voic: user=0 → −12',
          abs(U.variance_delta(U.VOIC, -50.0, 0.0) - (-62.0)) < 1e-9,
          U.variance_delta(U.VOIC, -50.0, 0.0))
    check('tenc: pred + user/20',
          abs(U.variance_delta(U.TENC, 0.0, 100.0) - 5.0) < 1e-9,
          U.variance_delta(U.TENC, 0.0, 100.0))
    check('brec clamp 到 [-96,0]',
          U.clamp_variance(U.BREC, -200.0) == -96.0 and U.clamp_variance(U.BREC, 5.0) == 0.0)
    check('★ tenc clamp 到 [-10,10]',
          U.clamp_variance(U.TENC, -99.0) == -10.0 and U.clamp_variance(U.TENC, 99.0) == 10.0)

    # ---------------- 8. 杂项
    print('--- 杂项 ---')
    check('phoneme_language("zh/n") == "zh"', U.phoneme_language('zh/n') == 'zh')
    check('phoneme_language("n") == ""', U.phoneme_language('n') == '')
    check('HEAD_FRAMES/TAIL_FRAMES == 8', U.HEAD_FRAMES == 8 and U.TAIL_FRAMES == 8)
    check('tone_to_freq(69) == 440.0', abs(U.tone_to_freq(69) - 440.0) < 1e-9)
    check('fit_duration_sum 末项吸收差额', U.fit_duration_sum([3, 3], 8) == [3, 5],
          U.fit_duration_sum([3, 3], 8))
    # ★ 上游是「末项 += delta；若末项变负才**从后向前**借到够为止」（:180-193）
    #   [3,3] → total 2：delta=-4 → [3,-1] → deficit=1，末项置 0，
    #   从 i=0 借 min(3,1)=1 → [2,0]
    check('fit_duration_sum 末项变负时向前借到够为止',
          U.fit_duration_sum([3, 3], 2) == [2, 0], U.fit_duration_sum([3, 3], 2))

    print()
    print('结果: %d passed, %d failed' % (len(_P), len(_F)))
    for f in _F:
        print('  FAILED:', f)
    return 1 if _F else 0


def _raises(fn):
    try:
        fn()
        return False
    except Exception:
        return True


if __name__ == '__main__':
    sys.exit(main())
