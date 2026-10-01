# -*- coding: utf-8 -*-
"""`.ustx` 数据模型的往返测试（照搬 OpenUTAU 后的验收）。

测的是「**语义往返一致 + 键名合法**」，不是与 OpenUTAU 逐字节相同的排版
（它另有 FlowEmitter 控制折行，见 io.py 的说明）。

覆盖：
  1. 键名符合 `UnderscoredNamingConvention`（ustxVersion → ustx_version 等）
  2. 省略 null（OmitNull）、跳过 [YamlIgnore]
  3. dumps → loads 语义一致（含音高/颤音/表达式/曲线/掩码曲线/伴奏片段/FX）
  4. 读取时未知键被忽略（IgnoreUnmatchedProperties，向后兼容新版本文件）
  5. BeforeSave 会把 parts 按类型拆分并按 (track_no, position) 排序

可离线运行：python engine/tests/test_ustx_roundtrip.py
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import yaml  # noqa: E402

from singing.ustx import (  # noqa: E402
    PitchPoint,
    PitchPointShape,
    UMixFx,
    UNote,
    UPhonemeOverride,
    UPitch,
    UProject,
    UCurve,
    UExpression,
    UExpressionDescriptor,
    UExpressionType,
    UMaskedCurve,
    UMaskedRun,
    UTrack,
    UVibrato,
    UVoicePart,
    UWavePart,
    dumps,
    loads,
    to_plain,
)

_PASS, _FAIL = [], []


def check(label, cond, detail=''):
    (_PASS if cond else _FAIL).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, ('  ' + detail) if (detail and not cond) else ''))


def sample_project():
    p = UProject(name='测试工程', comment='照搬 OpenUTAU 的 ustx 模型')
    p.ustx_version = '0.6'
    p.expressions['dyn'] = UExpressionDescriptor(
        name='Dynamics', abbr='dyn', type=UExpressionType.NUMERICAL,
        min=-240, max=120, default_value=0, is_flag=False, flag='')
    p.expressions['clr'] = UExpressionDescriptor(
        name='Voice Color', abbr='clr', type=UExpressionType.OPTIONS,
        options=['', 'Soft', 'Power'], default_value=0)

    track = p.tracks[0]
    track.track_name = 'Track1'
    track.track_color = 'Blue'
    track.singer = 'liu2_ying2'
    track.renderer = ''
    track.volume = 100
    track.pan = 0
    track.mix_fx = UMixFx(enabled=True, eq_mid_db=2.5)
    track.track_expressions = [UExpressionDescriptor(name='Tension', abbr='ten', min=0, max=200)]
    track.voice_color_names = ['', 'Soft']

    note = UNote(
        position=0, duration=480, tone=60, lyric='la', tuning=-5,
        pitch=UPitch(data=[PitchPoint(x=-40, y=0, shape=PitchPointShape.IO),
                           PitchPoint(x=0, y=30, shape=PitchPointShape.L)],
                     snap_first=True),
        vibrato=UVibrato(length=25, period=175, depth=25, shift=0, drift=0, vol_link=0),
        phoneme_expressions=[UExpression(abbr='dyn', index=None),
                             UExpression(abbr='clr', index=1)],
        phoneme_overrides=[UPhonemeOverride(index=0, preutter_delta=12.5)],
    )
    part = UVoicePart(name='Part1', comment='', track_no=0, position=0, duration=960)
    part.notes.append(note)
    part.curves.append(UCurve(xs=[0, 480], ys=[0, 100], abbr='dyn'))
    part.masked_curves.append(UMaskedCurve(abbr='pitd', runs=[UMaskedRun(x=0, ys=[0.0, 1.0])]))

    wave = UWavePart(name='Vocal', track_no=1, position=480,
                     relative_path='Vocal/take.wav', file_duration_ms=1234.5,
                     skip=0, trim=10, fadein=5, fadeout=7)
    # 故意让顺序颠倒，验证 BeforeSave 会按 (track_no, position) 排序
    p.parts = [wave, part]
    return p


def test_keys_and_omit():
    import re
    text = dumps(sample_project())
    for k in ('ustx_version', 'output_dir', 'cache_dir', 'exp_selectors',
              'time_signatures', 'tempos', 'track_no', 'track_name', 'track_color',
              'mix_fx', 'eq_mid_db', 'voice_color_names', 'phoneme_expressions',
              'phoneme_overrides', 'preutter_delta', 'snap_first', 'default_value',
              'reverb_pre_delay_ms'):
        # 键可能出现在任意缩进层级，所以按「行首空白 + 键名 + 冒号」匹配
        check('键名合法: %s' % k, re.search(r'(?m)^\s*%s:' % re.escape(k), text) is not None)
    # 旧驼峰键不应出现
    check('不出现驼峰键 ustxVersion', 'ustxVersion' not in text)
    check('不出现驼峰键 trackName', 'trackName' not in text)
    # [YamlIgnore] 的运行时字段不写盘
    check('YamlIgnore: parts 不写盘', '\nparts:' not in text)
    check('YamlIgnore: phonemes 不写盘', '\nphonemes:' not in text)
    check('YamlIgnore: phonemes_revision 不写盘', 'phonemes_revision' not in text)
    # OmitNull：没设 TrackExpressions 的轨道不写该键
    plain = yaml.safe_load(text)
    tr = plain['tracks'][0]
    check('OmitNull: 未设置的 expression_graph 不写', 'expression_graph' not in tr)
    check('OmitNull: voice_parts 里没有 null 字段', all(v is not None for v in tr.values()))
    return text


def test_roundtrip():
    p = sample_project()
    text = dumps(p)
    q = loads(text)
    check('往返: name/comment 一致', q.name == p.name and q.comment == p.comment)
    check('往返: 表达式表一致',
          to_plain(q.expressions) == to_plain(p.expressions),
          'got %r' % list(q.expressions))
    check('往返: 轨道数一致', len(q.tracks) == len(p.tracks))
    check('往返: 轨道 FX 一致', to_plain(q.tracks[0].mix_fx) == to_plain(p.tracks[0].mix_fx))
    check('往返: 轨道表达式一致',
          to_plain(q.tracks[0].track_expressions) == to_plain(p.tracks[0].track_expressions))
    check('往返: parts 已并回（2 个）', len(q.parts) == 2, 'got %d' % len(q.parts))
    check('往返: BeforeSave 按 (track_no, position) 排序',
          [x.track_no for x in q.parts] == [0, 1], 'got %r' % [x.track_no for x in q.parts])

    vp = [x for x in q.parts if isinstance(x, UVoicePart)][0]
    n0, w0 = vp.notes[0], None
    check('往返: 音符基本字段', (n0.position, n0.duration, n0.tone, n0.lyric) == (0, 480, 60, 'la'))
    check('往返: tuning 保留负值', n0.tuning == -5)
    check('往返: 音高点', [(pp.x, pp.y, pp.shape) for pp in n0.pitch.data]
          == [(-40.0, 0.0, PitchPointShape.IO), (0.0, 30.0, PitchPointShape.L)])
    check('往返: snap_first', n0.pitch.snap_first is True)
    check('往返: 颤音', to_plain(n0.vibrato) == to_plain(p.parts[1].notes[0].vibrato))
    check('往返: 音素表达式', to_plain(n0.phoneme_expressions) == to_plain(p.parts[1].notes[0].phoneme_expressions))
    check('往返: 音素重载', to_plain(n0.phoneme_overrides) == to_plain(p.parts[1].notes[0].phoneme_overrides))
    check('往返: 曲线', to_plain(vp.curves) == to_plain(p.parts[1].curves))
    check('往返: 掩码曲线', to_plain(vp.masked_curves) == to_plain(p.parts[1].masked_curves))
    wp = [x for x in q.parts if isinstance(x, UWavePart)][0]
    check('往返: 伴奏片段', to_plain(wp) == to_plain(p.parts[0]))
    # 二次往返必须稳定（幂等）
    check('往返幂等: dumps(loads(x)) == dumps(x)', dumps(loads(text)) == text)


def test_unknown_keys_ignored():
    text = dumps(sample_project())
    text += '\nfuture_field_from_newer_ustx: 42\n'
    p = loads(text)
    check('未知键被忽略（不抛异常且解析成功）', p.name == '测试工程')


def main():
    print('--- 键名 / OmitNull / YamlIgnore ---')
    test_keys_and_omit()
    print('--- 语义往返 ---')
    test_roundtrip()
    print('--- 未知键兼容 ---')
    test_unknown_keys_ignored()
    print('\n结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
    return 1 if _FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
