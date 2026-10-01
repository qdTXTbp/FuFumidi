# -*- coding: utf-8 -*-
"""照搬一致性校验（M2-a/M2-b 地基）：Python vs OpenUTAU 的 C# 源码。

延续 test_ustx_schema_matches_source.py 的做法 —— **把"照搬"交给机器强制**：
  1. `Format.Ustx` 的常量表逐条比对（键名 + 字面值）
  2. `USingerType` 的枚举值逐条比对（注意它是 Flags 且数值不连续）
  3. `TimeAxis` 的功能验证（tick↔ms / bar↔beat / 非法 bpm 的防御）
  4. `Phonemizer` 基类的轨道默认值语义（VEL → 辅音伸缩比）

参考源码缺失时自动 SKIP。可离线运行。
"""

import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

REF = os.environ.get('OPENUTAU_REF') or r'D:/FuFuMIDI/_ref/OpenUtau/OpenUtau.Core'

from singing.openutau import (  # noqa: E402
    NAME_IN_OCTAVE, MusicMath, Oto, OtoSet, Phonemizer, Preferences, Subbank, TimeAxis,
    UOto, UOtoSet, USinger, USingerType, USubbank,
)
from singing.openutau.renderer import SINGER_TYPE_FROM_NAME, SINGER_TYPE_NAMES  # noqa: E402
from singing.ustx import UExpressionDescriptor, UProject, UTrack  # noqa: E402
from singing.ustx.format import Ustx  # noqa: E402

_PASS, _FAIL = [], []


def check(label, cond, detail=''):
    (_PASS if cond else _FAIL).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label, ('\n       ' + detail) if (detail and not cond) else ''))


def _read(rel):
    p = os.path.join(REF, rel)
    return open(p, encoding='utf-8-sig').read().replace('\r\n', '\n') if os.path.isfile(p) else None


def test_format_constants():
    src = _read('Format/Ustx.cs')
    if src is None:
        print('  SKIP 找不到 Format/Ustx.cs')
        return
    want = dict(re.findall(r'public const string (\w+) = "([^"]*)";', src))
    got = {k: v for k, v in vars(Ustx).items() if k.isupper() and isinstance(v, str)}
    check('Format.Ustx: 常量个数一致（%d）' % len(want), len(want) == len(got),
          'C#=%d 我们=%d' % (len(want), len(got)))
    diff = {k: (want.get(k), got.get(k)) for k in set(want) | set(got) if want.get(k) != got.get(k)}
    check('Format.Ustx: 每个常量的字面值一致', not diff, '不一致: %r' % diff)


def test_singer_type_enum():
    src = _read('Ustx/USinger.cs')
    if src is None:
        print('  SKIP 找不到 Ustx/USinger.cs')
        return
    m = re.search(r'enum USingerType\s*\{([^}]*)\}', src)
    if not m:
        check('USingerType: 在源码中找到枚举', False)
        return
    want = {}
    for name, val in re.findall(r'(\w+)\s*=\s*(0x[0-9a-fA-F]+)', m.group(1)):
        want[name.upper()] = int(val, 16)
    got = {k: v for k, v in vars(USingerType).items() if k.isupper() and isinstance(v, int)}
    check('USingerType: 枚举项与值一致（%d 项）' % len(want), want == got,
          'C#=%r 我们=%r' % (want, got))
    # 短名映射也要齐
    for t, short in SINGER_TYPE_NAMES.items():
        check('SingerTypeNames: %s -> %s' % (short, hex(t)), short in src)


class _DummyPhonemizer(Phonemizer):
    name = 'dummy'
    tag = 'TEST DUMMY'
    language = 'ZH'

    def set_singer(self, singer):
        pass

    def process(self, notes, prev, next_, prev_neighbour, next_neighbour, prevs):
        return self.make_simple_result('a')


def test_phonemizer_base():
    p = _DummyPhonemizer()
    check('Phonemizer: 注册信息来自类属性', p.name == 'dummy' and p.tag == 'TEST DUMMY')
    r = p.make_simple_result('la')
    check('Phonemizer: MakeSimpleResult 返回单音素', len(r.phonemes) == 1 and r.phonemes[0].phoneme == 'la')
    check('Phonemizer: 默认 LegacyMapping=False', p.legacy_mapping is False)

    # 轨道默认值：VEL 描述符 50 → 2^(1-0.5)=√2
    proj = UProject()
    proj.expressions['vel'] = UExpressionDescriptor(abbr='vel', name='Velocity', min=0, max=200,
                                                    default_value=100)
    proj.expressions['vel'].custom_default_value = 50
    p.set_up([], proj, proj.tracks[0])
    check('Phonemizer: GetParentConsonantStretchRatio 用轨道 CustomDefaultValue',
          abs(p.get_parent_consonant_stretch_ratio() - 2 ** 0.5) < 1e-9,
          'got %r' % p.get_parent_consonant_stretch_ratio())
    # 没有该描述符时回落 1
    p2 = _DummyPhonemizer()
    p2.set_up([], UProject(), UTrack())
    check('Phonemizer: 无 VEL 描述符时比值=1', p2.get_parent_consonant_stretch_ratio() == 1)

    # TrackExpressions 优先于 project.expressions
    proj2 = UProject()
    proj2.expressions['shft'] = UExpressionDescriptor(abbr='shft', min=-24, max=24, default_value=0)
    proj2.expressions['shft'].custom_default_value = 3
    tr = proj2.tracks[0]
    tr.track_expressions.append(UExpressionDescriptor(abbr='shft', min=-24, max=24, default_value=0))
    tr.track_expressions[0].custom_default_value = -7
    p3 = _DummyPhonemizer()
    p3.set_up([], proj2, tr)
    check('Phonemizer: 轨道表达式优先于工程表达式', p3.get_parent_tone_shift() == -7,
          'got %r' % p3.get_parent_tone_shift())


def test_timeaxis():
    proj = UProject()
    ta = TimeAxis()
    ta.build_segments(proj)
    # resolution=480, 120bpm, 4/4 → 每 tick = 60000/(120*480) ms；1 拍(480tick) = 500ms
    check('TimeAxis: 480 tick = 500 ms', abs(ta.tick_pos_to_ms_pos(480) - 500.0) < 1e-9,
          'got %r' % ta.tick_pos_to_ms_pos(480))
    check('TimeAxis: ms→tick 往返', ta.ms_pos_to_tick_pos(500.0) == 480,
          'got %r' % ta.ms_pos_to_tick_pos(500.0))
    check('TimeAxis: bpm=120', ta.get_bpm_at_tick(0) == 120)
    bar, beat, rem = ta.tick_pos_to_bar_beat(1920)      # 1920 tick = 1 小节
    check('TimeAxis: 1920 tick = 第 2 小节第 1 拍', (bar, beat, rem) == (1, 0, 0), 'got %r' % ((bar, beat, rem),))
    check('TimeAxis: bar/beat→tick', ta.bar_beat_to_tick_pos(1, 0) == 1920,
          'got %r' % ta.bar_beat_to_tick_pos(1, 0))
    check('TimeAxis: next_bar_beat 跨小节进位', ta.next_bar_beat(0, 3) == (1, 0),
          'got %r' % (ta.next_bar_beat(0, 3),))

    # 非法 bpm 的防御（照搬 C# IsValidBpm 的用意）
    proj2 = UProject()
    proj2.tempos = [__import__('singing.ustx.model', fromlist=['UTempo']).UTempo(position=0, bpm=0)]
    ta2 = TimeAxis()
    ta2.build_segments(proj2)
    check('TimeAxis: bpm=0 回落默认 120', ta2.get_bpm_at_tick(0) == 120,
          'got %r' % ta2.get_bpm_at_tick(0))
    check('TimeAxis: 超界 tick 夹到末段不抛异常', ta3_ok(ta2))


def ta3_ok(ta):
    try:
        ta.tick_pos_to_ms_pos(10 ** 12)
        ta.tick_pos_to_ms_pos(float('nan'))
        return True
    except Exception:
        return False


def test_musicmath():
    src = _read('Util/MusicMath.cs')
    if src is None:
        print('  SKIP 找不到 Util/MusicMath.cs')
        return
    block = re.search(r'NameInOctave\s*=\s*new Dictionary<string, int>\s*\{(.*?)\};', src, re.S)
    if not block:
        check('MusicMath: 从源码解析 NameInOctave', False)
        return
    want = {}
    for name, val in re.findall(r'\{\s*"([^"]+)"\s*,\s*(\d+)\s*\}', block.group(1)):
        want[name] = int(val)
    check('MusicMath: NameInOctave 与源码一致（%d 项）' % len(want), want == NAME_IN_OCTAVE,
          'C#=%r 我们=%r' % (want, NAME_IN_OCTAVE))
    # 功能：C4=60，C#4=61，Db4=61，越界返回 -1
    cases = [('C4', 60), ('C#4', 61), ('Db4', 61), ('A4', 69), ('B3', 59), ('C-1', 0)]
    for name, exp in cases:
        got = MusicMath.name_to_tone(name)
        check('MusicMath.NameToTone(%s)=%d' % (name, exp), got == exp, 'got %r' % got)
    for bad in ('X4', 'Cx', '', 'C'):
        check('MusicMath.NameToTone(%r) 返回 -1' % bad, MusicMath.name_to_tone(bad) == -1,
              'got %r' % MusicMath.name_to_tone(bad))


def test_oto_model():
    # 夹紧/取整规则：offset/consonant/preutter 夹到 ≥0 且 round 3 位；cutoff/overlap 只 round
    raw = Oto(alias='a', phonetic='a', wav='a.wav',
              offset=-5.12345, consonant=2.00049, cutoff=-3.14159,
              preutter=10.55555, overlap=-1.23456)
    us = UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb')
    u = UOto(raw, us, None)
    check('UOto: offset 夹到 ≥0 且 round3', u.offset == 0.0, 'got %r' % u.offset)
    check('UOto: consonant round3', u.consonant == 2.0, 'got %r' % u.consonant)
    check('UOto: cutoff 保留负值只 round3', u.cutoff == -3.142, 'got %r' % u.cutoff)
    check('UOto: preutter round3', u.preutter == 10.556, 'got %r' % u.preutter)
    check('UOto: overlap 保留负值只 round3', u.overlap == -1.235, 'got %r' % u.overlap)
    check('UOto: file 拼到 otoSet.location', u.file.replace('\\', '/').endswith('/vb/a.wav'),
          'got %r' % u.file)
    d = UOto.of_dummy('ka')
    check('UOto.OfDummy: alias/phonetic 都是给定值', d.alias == 'ka' and d.phonetic == 'ka')
    check('UOto: 无 subbanks 时 Color 为空', u.color == '' and u.prefix == '' and u.suffix == '')

    # USubbank：ToneRanges 字符串 → tone_set
    sb = USubbank(Subbank(color='Soft', prefix='P', suffix='S', tone_ranges=['C4', 'E4-G4']))
    check('USubbank: 单音 + 闭区间展开', sb.tone_set == [60, 64, 65, 66, 67], 'got %r' % sb.tone_set)
    check('USubbank: ToneRangesString 回写', sb.tone_ranges_string == 'C4,E4-G4',
          'got %r' % sb.tone_ranges_string)
    check('USubbank: 非法音名静默跳过', USubbank(Subbank(tone_ranges=['X9'])).tone_set == [])
    # 注意：无参路径 `UOto()` 下 subbanks 保持 null（与 C# 一致），
    # 所以测 subbank 相关行为必须走「带原始 oto」的构造路径。
    check('UOto: 无参构造时 subbanks 为 None（与 C# 一致）', UOto().subbanks is None)
    ok_set = UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb')
    us2 = UOto(Oto(alias='a', wav='a.wav'), ok_set, [USubbank(Subbank(color=''))])
    check('UOto: Color 空子音色显示 (main)', us2.color == '(main)', 'got %r' % us2.color)
    check('UOto: IsColorMatch 命中空色', us2.is_color_match(''), '未命中空色')
    check('UOto: IsColorMatch 未命中非空色', not us2.is_color_match('Soft'))


def test_singer_base():
    src = _read('Ustx/USinger.cs')
    if src is None:
        print('  SKIP 找不到 Ustx/USinger.cs')
        return
    # 两个名字表的 4 项映射要与源码一致
    for short, enum_name in (('utau', 'Classic'), ('enunu', 'Enunu'),
                             ('diffsinger', 'DiffSinger'), ('voicevox', 'Voicevox')):
        check('SingerTypeNames: %s 出现在源码映射里' % short,
              re.search(r'\{\s*USingerType\.%s,\s*"%s"\s*\}' % (enum_name, short), src) is not None)
        check('SingerTypeFromName: %s 反向映射正确' % short,
              SINGER_TYPE_FROM_NAME[short] == getattr(USingerType, enum_name.upper()))

    u = USinger()
    check('USinger: 基类默认查不到 oto（False, None）', u.try_get_oto('a') == (False, None))
    check('USinger: TryGetMappedOto 默认转调 TryGetOto（不做音高映射）',
          u.try_get_mapped_oto('a', 60, 'Soft') == (False, None))
    check('USinger: 默认 Otos 是空表（C# 的 emptyOtos）', u.otos == [])
    check('USinger: 默认 Loaded = found && loaded', u.is_loaded is False)

    m = USinger.create_missing('Ghost')
    check('USinger: CreateMissing 只有名字且未找到', m.name == 'Ghost' and not m.has_found)
    check('USinger: 未找到时 localized_name 带 [Missing] 前缀',
          m.localized_name == '[Missing] Ghost', 'got %r' % m.localized_name)

    # 语言回落链：SortingOrder → Language → Name
    class _LocalizedSinger(USinger):
        @property
        def localized_names(self):
            return {'zh': '中文名', 'ja': '日本語名'}

    real = _LocalizedSinger('DefaultName')
    real.found = True
    old_sort, old_lang = Preferences.sorting_order, Preferences.language
    try:
        Preferences.sorting_order = 'ja'
        Preferences.language = 'zh'
        check('USinger: SortingOrder 优先于 Language', real.localized_name == '日本語名',
              'got %r' % real.localized_name)
        Preferences.sorting_order = None
        check('USinger: SortingOrder 为空时用 Language', real.localized_name == '中文名',
              'got %r' % real.localized_name)
        Preferences.language = 'fr'
        check('USinger: 语言取不到时回落 Name', real.localized_name == 'DefaultName',
              'got %r' % real.localized_name)
        Preferences.language = None
        check('USinger: 语言全空时回落 Name', real.localized_name == 'DefaultName',
              'got %r' % real.localized_name)
    finally:
        Preferences.sorting_order, Preferences.language = old_sort, old_lang

    # Equals 只比 Id
    class _IdSinger(USinger):
        def __init__(self, sid, name=''):
            super().__init__(name)
            self._sid = sid

        @property
        def id(self):
            return self._sid

    check('USinger: equals 只比 Id', _IdSinger('a', 'X').equals(_IdSinger('a', 'Y')) is True)
    check('USinger: Id 不同则不等', _IdSinger('a').equals(_IdSinger('b')) is False)
    check('USinger: equals(None) 为 False', _IdSinger('a').equals(None) is False)
    # 收藏走 Preferences（替身）
    Preferences.favorite_singers = []
    s1 = _IdSinger('fav1')
    s1.is_favourite = True
    check('USinger: IsFavourite 写入偏好', Preferences.favorite_singers == ['fav1'])
    s1.is_favourite = False
    check('USinger: IsFavourite 取消收藏', Preferences.favorite_singers == [])


def test_phoneme_model():
    from singing.openutau import UPhoneme
    from singing.ustx import UExpression, UExpressionDescriptor, UExpressionType, UNote

    proj = UProject()
    tr = proj.tracks[0]
    proj.expressions['vel'] = UExpressionDescriptor(
        abbr='vel', name='Velocity', type=UExpressionType.NUMERICAL,
        min=0, max=200, default_value=100, flag='V')
    proj.expressions['gen'] = UExpressionDescriptor(
        abbr='gen', name='Gender', type=UExpressionType.NUMERICAL,
        min=0, max=100, default_value=50, flag='g', skip_output_if_default=True)
    proj.expressions['clr'] = UExpressionDescriptor(
        abbr='clr', name='VoiceColor', type=UExpressionType.OPTIONS,
        options=['', 'Soft'], default_value=0, is_flag=True)
    # 轨道自己的 gen 覆盖工程的（GetExpressionDescriptors 是「替换」不是「合并」）
    tr.track_expressions.append(UExpressionDescriptor(
        abbr='gen', name='TrackGender', type=UExpressionType.NUMERICAL,
        min=0, max=100, default_value=50, flag='g', skip_output_if_default=False))

    descs = UPhoneme.get_expression_descriptors(proj, tr)
    abbrs = [d.abbr for d in descs]
    check('GetExpressionDescriptors: 轨道同名项替换工程项（不重复）',
          abbrs.count('gen') == 1 and 'gen' in abbrs, 'got %r' % abbrs)
    check('GetExpressionDescriptors: 保留工程里其它项', 'vel' in abbrs and 'clr' in abbrs)

    note = UNote(position=0, duration=480, tone=60, lyric='la')
    ph = UPhoneme()
    ph.index = 0
    ph.parent = note
    ph.position_ms = 0
    ph.end_ms = 500
    ph.duration = 480

    # GetExpression 优先级：音符音素表达式 > 音素化器表达式 > 描述符默认值
    v, explicit = ph.get_expression(proj, tr, 'vel')
    check('GetExpression: 都没有时回落描述符默认值（100）且 explicit=False',
          (v, explicit) == (100.0, False), 'got %r' % ((v, explicit),))
    note.phonemizer_expressions.append(
        UExpression(index=0, abbr='vel', descriptor=proj.expressions['vel'], _value=77))
    v, explicit = ph.get_expression(proj, tr, 'vel')
    check('GetExpression: 音素化器表达式优先于默认值，且 explicit=False',
          (v, explicit) == (77.0, False), 'got %r' % ((v, explicit),))
    note.phoneme_expressions.append(
        UExpression(index=0, abbr='vel', descriptor=proj.expressions['vel'], _value=55))
    v, explicit = ph.get_expression(proj, tr, 'vel')
    check('GetExpression: 用户音素表达式最优先，且 explicit=True',
          (v, explicit) == (55.0, True), 'got %r' % ((v, explicit),))

    # BuildResamplerFlags
    flags = ph.build_resampler_flags(descs, lambda a: ph.get_expression(proj, tr, a)[0])
    names = [f[0] for f in flags]
    check('BuildResamplerFlags: vel 产出 flag V', ('V', 55, 'vel') in flags, 'got %r' % flags)
    check('BuildResamplerFlags: gen 默认值且未 skip 时仍产出 flag g',
          ('g', 50, 'gen') in flags, 'got %r' % flags)
    # clr 是 Options+isFlag → 产出 options[值]
    check('BuildResamplerFlags: Options 取 options[值]', ('', None, 'clr') in flags, 'got %r' % flags)

    # skipOutputIfDefault：把工程的 gen 拿来单测（它带 skip_output_if_default=True）
    only_gen = [proj.expressions['gen']]
    skipped = UPhoneme.build_resampler_flags(only_gen, lambda a: 50.0)
    check('BuildResamplerFlags: skipOutputIfDefault 且等于默认值 → 跳过', skipped == [],
          'got %r' % skipped)
    kept = UPhoneme.build_resampler_flags(only_gen, lambda a: 60.0)
    check('BuildResamplerFlags: 不等于默认值 → 产出', kept == [('g', 60, 'gen')], 'got %r' % kept)

    # GetFadeIn / GetFadeOut 的固定兜底值
    ph2 = UPhoneme()
    ph2.crossfade, ph2.overlapped = True, False
    check('GetFadeIn: 未重叠时兜底 5', ph2.get_fade_in() == 5, 'got %r' % ph2.get_fade_in())
    ph2.overlapped = True
    ph2.overlap = 12.5
    check('GetFadeIn: crossfade&&overlapped 时用 overlap', ph2.get_fade_in() == 12.5)
    check('GetFadeOut: 无 Next 时兜底 35', ph2.get_fade_out() == 35, 'got %r' % ph2.get_fade_out())

    # ValidateEnvelope 的点位计算（vol=100 / atk=100 / dec=0 → 直线满幅）
    proj.expressions['vol'] = UExpressionDescriptor(abbr='vol', default_value=100, min=0, max=100)
    proj.expressions['atk'] = UExpressionDescriptor(abbr='atk', default_value=100, min=0, max=100)
    proj.expressions['dec'] = UExpressionDescriptor(abbr='dec', default_value=0, min=0, max=100)
    ph.error = False
    ph.preutter = 50
    ph.tail_intrude = 0
    ph.tail_overlap = 0
    ph.attack_time_delta = None
    ph.release_time_delta = None
    ph.crossfade, ph.overlapped = False, False
    ph._validate_envelope(proj, tr, note)
    pts = [(round(p.x, 3), round(p.y, 3)) for p in ph.envelope.data]
    check('ValidateEnvelope: x = (-50, -45, 0, 465, 500)',
          [p[0] for p in pts] == [-50, -45, 0, 465, 500], 'got %r' % pts)
    check('ValidateEnvelope: y = (0, 100, 100, 100, 0)',
          [p[1] for p in pts] == [0, 100, 100, 100, 0], 'got %r' % pts)


def main():
    print('--- Format.Ustx 常量 ---')
    test_format_constants()
    print('--- USingerType / SingerTypeUtils ---')
    test_singer_type_enum()
    print('--- USinger 基类 ---')
    test_singer_base()
    print('--- MusicMath 音名换算 ---')
    test_musicmath()
    print('--- UOto / USubbank 模型 ---')
    test_oto_model()
    print('--- UPhoneme 模型 ---')
    test_phoneme_model()
    print('--- Phonemizer 基类 ---')
    test_phonemizer_base()
    print('--- TimeAxis ---')
    test_timeaxis()
    print('\n结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
    return 1 if _FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
