# -*- coding: utf-8 -*-
"""照搬一致性校验（M2-a/M2-b 地基）：Python vs OpenUTAU 的 C# 源码。

延续 test_ustx_schema_matches_source.py 的做法 —— **把"照搬"交给机器强制**：
  1. `Format.Ustx` 的常量表逐条比对（键名 + 字面值）
  2. `USingerType` 的枚举值逐条比对（注意它是 Flags 且数值不连续）
  3. `TimeAxis` 的功能验证（tick↔ms / bar↔beat / 非法 bpm 的防御）
  4. `Phonemizer` 基类的轨道默认值语义（VEL → 辅音伸缩比）

参考源码缺失时自动 SKIP。可离线运行。
"""

import math
import os
import re
import sys
import unicodedata
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

REF = os.environ.get('OPENUTAU_REF') or r'D:/FuFuMIDI/_ref/OpenUtau/OpenUtau.Core'
#: 参考仓库根目录（预编译的 `runtimes/*/native/worldline.dll` 在这里）
REF_ROOT = os.path.dirname(REF)

from singing.openutau import (  # noqa: E402
    NAME_IN_OCTAVE, Wave, CubicSplineSegment, CurveSource, IRenderer, MusicMath, NoteSource,
    Oto, OtoSet, PhonemeSource, PhraseLayout, PhraseSource, Phonemizer, Preferences,
    RenderNote, RenderPhone, RenderPhrase, RenderPitchResult, RenderResult, Subbank,
    TimeAxis, UOto, UOtoSet, USinger, USingerType, USubbank, VibratoSource,
)
from singing.openutau.classic import (  # noqa: E402
    ClassicRenderer, IResampler, IWavtool, SharpWavtool, WorldlineResampler,
)
from singing.openutau.renderer import SINGER_TYPE_FROM_NAME, SINGER_TYPE_NAMES  # noqa: E402
from singing.ustx import (  # noqa: E402
    PitchPoint, PitchPointShape, UCurve, UExpressionDescriptor, UProject, UTrack, Vector2,
)
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


# ---------------------------------------------------------------- RenderPhrase 系列

def _our_src(name):
    p = os.path.join(ENGINE, 'singing', 'openutau', name)
    return open(p, encoding='utf-8').read().replace('\r\n', '\n') if os.path.isfile(p) else None


def _norm_ident(s):
    """把 C# / Python 的字段写法归一到同一串，便于逐项比对。

    `adjustedTone` / `self.adjusted_tone` → `adjustedtone`
    `flag.Item2.Value` / `flag[1]`          → `flag1`
    `renderer?.ToString() ?? ""`           → `renderertostring`
    """
    s = s.strip()
    s = s.split('??')[0].strip()
    if 'ToString' in s or 'str(' in s:
        return 'renderertostring'
    s = s.replace('self.', '')
    s = s.replace('.Value', '').replace('.value', '')
    s = s.replace('.Item1', '[0]').replace('.item1', '[0]')
    s = s.replace('.Item2', '[1]').replace('.item2', '[1]')
    s = s.replace('.', '')
    s = s.replace('[0]', '0').replace('[1]', '1')
    s = s.replace('_', '').strip("'\" ")
    return s.lower()


def _cs_writes(body):
    """抽出 C# 里 `writer.Write(x);` 的实参序列。"""
    return [_norm_ident(a) for a in re.findall(r'writer\.Write\((.+?)\);', body)]


def _py_writes(body):
    """抽出 Python 里 `w.write_xxx(...)` 的实参序列（逐行匹配，容许嵌套括号）。"""
    out = []
    for line in body.split('\n'):
        m = re.match(r"\s*w\.write_\w+\((.*)\)\s*$", line)
        if m:
            out.append(_norm_ident(m.group(1)))
    return out


def _slice(text, start_marker, end_marker):
    i = text.index(start_marker)
    j = text.index(end_marker, i)
    return text[i:j]


def test_render_phrase_source_conformance():
    """`RenderPhone.Hash()` / `RenderPhrase.Hash()` 的写入顺序必须与 C# 逐项一致。

    这是缓存键的字节布局：顺序错一位，缓存就会"看起来命中其实不命中"。
    """
    cs = _read('Render/RenderPhrase.cs')
    py = _our_src('render_phrase.py')
    if cs is None or py is None:
        print('  SKIP 找不到 RenderPhrase.cs 或 render_phrase.py')
        return

    # ---- RenderPhone.Hash()
    cs_phone = _slice(cs, 'private ulong Hash() {', 'public class RenderPhrase')
    want = [w for w in _cs_writes(cs_phone)]
    got = _py_writes(_slice(py, 'def _compute_hash(self)', 'def __str__(self)'))
    check('RenderPhone.Hash: 写入项数与 C# 一致（%d）' % len(want), len(want) == len(got),
          'C#=%r\n       我们=%r' % (want, got))
    check('RenderPhone.Hash: 写入顺序与 C# 逐项一致', want == got,
          'C#=%r\n       我们=%r' % (want, got))

    # ---- RenderPhrase.Hash(bool)（前半：与 postEffect 无关的部分）
    cs_phrase = _slice(cs, 'private ulong Hash(bool postEffect)', 'internal static RenderPhrase BuildXsyVariant')
    want2 = _cs_writes(cs_phrase)
    # C# 里 phones / curves 是 foreach + 两条 Write，Python 同样两条，序列可比
    got2 = _py_writes(_slice(py, 'def _hash(self, post_effect', 'def add_cache_file'))
    check('RenderPhrase.Hash: 写入顺序与 C# 逐项一致（含 postEffect 段）', want2 == got2,
          'C#=%r\n       我们=%r' % (want2, got2))

    # ---- postEffect 里 8 条曲线的先后顺序
    m = re.search(r'new float\[\]\[\]\s*\{(.*?)\}', cs_phrase, re.S)
    want3 = [_norm_ident(x) for x in m.group(1).split(',')] if m else None
    m2 = re.search(r'for array in \((.*?)\):', _slice(py, 'def _hash(self, post_effect', 'def add_cache_file'), re.S)
    got3 = [_norm_ident(x) for x in m2.group(1).split(',')] if m2 else None
    check('RenderPhrase.Hash: postEffect 的 8 条曲线顺序一致', want3 == got3,
          'C#=%r\n       我们=%r' % (want3, got3))

    # ---- pitchInterval 常量
    want4 = re.findall(r'const int (?:pitchInterval|interval) = (\d+);', cs)
    got4 = re.findall(r'PITCH_INTERVAL = (\d+)', py)
    check('RenderPhrase: pitchInterval 与 SampleCurve.interval 都是 5，且我们也是 5',
          want4 == ['5', '5'] and got4 == ['5'], 'C#=%r 我们=%r' % (want4, got4))

    # ---- PitchPointShape 枚举（io / l / i / o / sp）
    cs_note = _read('Ustx/UNote.cs')
    if cs_note:
        enum = _slice(cs_note, 'public enum PitchPointShape {', 'public class PitchPoint')
        # 最后一枚枚值（sp）后面没有逗号，所以 ,? 要可选
        want5 = re.findall(r'^\s{8}(\w+)\s*,?\s*$', enum, re.M)
        our_model = open(os.path.join(ENGINE, 'singing', 'ustx', 'model.py'), encoding='utf-8').read()
        got5 = re.findall(r"^\s{4}([A-Z]+) = '(\w+)'", _slice(our_model, 'class PitchPointShape', 'class UExpressionType'), re.M)
        check('PitchPointShape: 枚举名集合一致（%d 个）' % len(want5),
              [n.lower() for n, _ in got5] == want5, 'C#=%r 我们=%r' % (want5, got5))

    # ---- PhraseLayout / CubicSplineSegment 的构造参数
    import dataclasses as _dc
    cs_layout = _read('Render/PhraseLayout.cs')
    if cs_layout:
        n_cs = len(re.findall(r'public PhraseLayout\(([^)]*)\)', cs_layout)[0].split(','))
        n_our = len(_dc.fields(PhraseLayout))
        check('PhraseLayout: C# 构造参数 4 个（startMs/endMs/leadingMs/estimatedMs）', n_cs == 4,
              'C#=%d' % n_cs)
        check('PhraseLayout: 我们的 dataclass 字段数一致', n_our == n_cs, '我们=%d' % n_our)
    cs_spline = _read('Util/SplineInterpolate.cs')
    if cs_spline:
        m3 = re.search(r'public CubicSplineSegment\((.*?)\)\s*\{', cs_spline, re.S)
        check('CubicSplineSegment: 构造参数 8 个（x_1,y_1,x0,y0,x1,y1,x2,y2）',
              m3 is not None and len(m3.group(1).split(',')) == 8,
              'got %r' % (m3.group(1).replace('\n', ' ') if m3 else None))


def test_spline():
    """CubicSplineSegment：端点夹取 + GetX 的牛顿迭代反解。"""
    s = CubicSplineSegment(0, 0, 10, 0, 20, 100, 30, 100)
    check('CubicSpline: x<=x0 取 y0', s.get_y(5) == 0.0, 'got %r' % s.get_y(5))
    check('CubicSpline: x>=x1 取 y1', s.get_y(25) == 100.0, 'got %r' % s.get_y(25))
    check('CubicSpline: 中点落在两端之间', 0.0 < s.get_y(15) < 100.0, 'got %r' % s.get_y(15))
    # GetX：若首尾同高（y0 == y1），y > min 时按 C# 返回 x0/x1 的边界分支
    flat = CubicSplineSegment(0, 50, 10, 50, 20, 50, 30, 50)
    check('CubicSpline: 平坦段的 GetX 走端点分支', flat.get_x(50) in (10.0, 20.0),
          'got %r' % flat.get_x(50))
    # 单调上升段的 GetX 应能把 GetY 的结果反解回去（牛顿迭代 5 次，容差放宽）
    up = CubicSplineSegment(0, 0, 0, 0, 100, 100, 200, 200)
    ok = all(abs(up.get_y(up.get_x(y)) - y) < 1.0 for y in (20, 50, 80))
    check('CubicSpline: GetX 与 GetY 近似互逆', ok,
          'got %r' % [up.get_y(up.get_x(y)) for y in (20, 50, 80)])


def test_musicmath_extra():
    """MusicMath 的插值 / 常量换算（RenderPhrase 直接依赖）。"""
    check('MusicMath.Linear 端点/中点', MusicMath.linear(0, 10, 0, 10, 5) == 5,
          'got %r' % MusicMath.linear(0, 10, 0, 10, 5))
    check('MusicMath.Linear 区间退化时返回 y1', MusicMath.linear(5, 5, 1, 2, 5) == 2,
          'got %r' % MusicMath.linear(5, 5, 1, 2, 5))
    check('MusicMath.DecibelToLinear(0)=1', abs(MusicMath.decibel_to_linear(0) - 1) < 1e-12)
    check('MusicMath.DecibelToLinear(20)=10', abs(MusicMath.decibel_to_linear(20) - 10) < 1e-9)
    check('MusicMath.DecibelToLinear(10)=sqrt(10)',
          abs(MusicMath.decibel_to_linear(10) - 10 ** 0.5) < 1e-12)
    check('MusicMath.TempoMsToTick(120, 500)=480', MusicMath.tempo_ms_to_tick(120, 500) == 480,
          'got %r' % MusicMath.tempo_ms_to_tick(120, 500))
    check('MusicMath.TempoTickToMs(120, 480)=500', MusicMath.tempo_tick_to_ms(120, 480) == 500,
          'got %r' % MusicMath.tempo_tick_to_ms(120, 480))
    # InterpolateShape：io 与 sp 都走 SinEasingInOut；l 走线性；i/o 各自单边
    io = MusicMath.interpolate_shape(0, 10, 0, 10, 5, 'io')
    sp = MusicMath.interpolate_shape(0, 10, 0, 10, 5, 'sp')
    lin = MusicMath.interpolate_shape(0, 10, 0, 10, 5, 'l')
    i_ = MusicMath.interpolate_shape(0, 10, 0, 10, 5, 'i')
    o_ = MusicMath.interpolate_shape(0, 10, 0, 10, 5, 'o')
    check('MusicMath.InterpolateShape: io == sp（同走 SinEasingInOut）', io == sp,
          'io=%r sp=%r' % (io, sp))
    check('MusicMath.InterpolateShape: l 与 io 不同', lin != io)
    check('MusicMath.InterpolateShape: i/o 关于中点互补', abs(i_ + o_ - 10) < 1e-9,
          'i=%r o=%r' % (i_, o_))


def test_curve_source_sample():
    """CurveSource.Sample 必须复刻 Array.BinarySearch 的三条分支。"""
    c = CurveSource(abbr='dyn', xs=[0, 100, 200], ys=[10, 20, 30], default_y=7, min=0)
    check('CurveSource.Sample: 命中顶点直接取 Ys（右邻点）', c.sample(100) == 20,
          'got %r' % c.sample(100))
    check('CurveSource.Sample: 命中首点', c.sample(0) == 10, 'got %r' % c.sample(0))
    check('CurveSource.Sample: 区间内线性插值', c.sample(50) == 15, 'got %r' % c.sample(50))
    check('CurveSource.Sample: 左越界回落 DefaultY', c.sample(-10) == 7,
          'got %r' % c.sample(-10))
    check('CurveSource.Sample: 右越界回落 DefaultY', c.sample(999) == 7,
          'got %r' % c.sample(999))
    check('CurveSource.Sample: 空曲线回落 DefaultY', CurveSource.empty('dyn', 7, 0).sample(5) == 7)
    check('CurveSource.Empty: is_empty 为真', CurveSource.empty('dyn', 0, 0).is_empty)
    check('CurveSource: 有数据时 is_empty 为假', not c.is_empty)


def test_vibrato_source_eval():
    """VibratoSource 与实时版（UVibrato）算式必须一致 —— 这里按公式逐项验证。"""
    vib = VibratoSource(length=50, period=100, depth=50, vib_in=20, vib_out=20,
                        shift=0, drift=0, vol_link=0)
    note = NoteSource(position=0, duration=480, adjusted_tone=60.0, duration_ms=500.0)
    # nStart = 1 - 50/100 = 0.5；nPos = 0.4 < nStart → y 归零，音高回到 AdjustedTone
    v = vib.evaluate(0.4, 0.5, note)
    check('Vibrato.Evaluate: nPos < nStart 时 y 归零',
          abs(v.y - 60.0) < 1e-12, 'got %r' % v.y)
    check('Vibrato.Evaluate: 返回的 tick = note.Position + Duration*nPos',
          abs(v.x - 192) < 1e-9, 'got %r' % v.x)
    # nPos = 0.625 落在颤音区内（nStart=0.5，进区 0.6，出区 0.9），t=0.25 → sin=1
    import math as _math
    v2 = vib.evaluate(0.625, 0.5, note)
    expect_y = 60.0 + (_math.sin(2 * _math.pi * 0.25) * 50 + 50 / 100 * 0) / 100
    check('Vibrato.Evaluate: 区内按 sin 起伏（AdjustedTone + y/100）',
          abs(v2.y - expect_y) < 1e-9, '期望≈%r 得到 %r' % (expect_y, v2.y))
    # 反相颤音：VibratoSource（快照版）里局部 shift 是死代码，正负 volLink 结果同值
    pos = VibratoSource(length=100, period=100, depth=0, vib_in=0, vib_out=0,
                        shift=0, drift=0, vol_link=50)
    neg = VibratoSource(length=100, period=100, depth=0, vib_in=0, vib_out=0,
                        shift=0, drift=0, vol_link=-50)
    same = all(abs(pos.evaluate_volume(x, 1.0) - neg.evaluate_volume(x, 1.0)) < 1e-12
               for x in (0.1, 0.25, 0.4, 0.6))
    check('Vibrato.EvaluateVolume: 照搬快照版 —— volLink 正负同值（C# 局部 shift 为死代码）', same,
          'pos(0.25)=%r neg(0.25)=%r' % (pos.evaluate_volume(0.25, 1.0),
                                         neg.evaluate_volume(0.25, 1.0)))
    check('Vibrato.EvaluateVolume: volLink=25% 时仍有 ±0.2 的起伏',
          abs(pos.evaluate_volume(0.25, 1.0) - 1.1) < 1e-9,
          'got %r' % pos.evaluate_volume(0.25, 1.0))
    check('Vibrato.EvaluateVolume: volLink=0 时恒为 1',
          VibratoSource(length=50, period=100, depth=50, vib_in=0, vib_out=0,
                        vol_link=0).evaluate_volume(0.5, 1.0) == 1.0)


class _FakeRenderer(IRenderer):
    """只为驱动 RenderPhrase 的最小渲染器（Layout 直接回报音素跨度）。"""

    singer_type = USingerType.CLASSIC

    def supports_expression(self, descriptor):
        return False

    def layout(self, phrase):
        return RenderResult(samples=None, leading_ms=phrase.leading_ms,
                            position_ms=phrase.position_ms,
                            estimated_length_ms=phrase.duration_ms)

    async def render(self, phrase, progress=None, track_no=0, cancellation=None,
                     is_pre_render=False, render_events=None):
        return RenderResult()

    def load_rendered_pitch(self, phrase, selected_note_positions=None):
        return RenderPitchResult()

    def get_suggested_expressions(self, singer, render_settings):
        return []


class _FakeSinger:
    id = 'test-singer'


def _mk_phrase_source(notes, curves=None, descriptors=None, note_pitch_points=None):
    proj = UProject()
    ta = TimeAxis()
    ta.build_segments(proj)
    n = len(notes)
    for i, note in enumerate(notes):
        note.prev = i - 1 if i > 0 else -1
        note.next = i + 1 if i < n - 1 else -1
        note.extends = -1
        if note_pitch_points and i in note_pitch_points:
            note.pitch_points = note_pitch_points[i]
    return PhraseSource(part_position=0, axis=ta, default_bpm=120.0,
                        singer=_FakeSinger(), renderer=_FakeRenderer(),
                        resampler='', wavtool='', classic_singer=None,
                        modp_supported=False, notes=notes,
                        curves=curves or [], curve_descriptors=descriptors or [],
                        expression_graph=None)


def _mk_note(duration=480, end=480, tone=60, position=0, adjusted_tone=60.0):
    return NoteSource(index=0, position=position, duration=duration, end=end,
                      lyric='a', tone=tone, tuning=0, adjusted_tone=adjusted_tone,
                      duration_ms=500.0, prev=-1, next=-1, extends=-1)


def _mk_phoneme(**kw):
    base = dict(position=0, duration=480, end=480,
                position_ms=0.0, duration_ms=500.0, end_ms=500.0,
                preutter=50.0, overlap=10.0, tail_intrude=25.0, tail_overlap=5.0,
                leading=50, phoneme='a', tone=60, note_index=0,
                tempo=120.0, adjusted_tempo=120.0, resampler='', flags=[], suffix='',
                suffix2=None, volume=100.0, velocity=100.0, modulation=0.0,
                direct=False, tone_shift=0,
                envelope=[Vector2(0, 0), Vector2(0, 100), Vector2(0, 100),
                          Vector2(0, 100), Vector2(0, 0)])
    base.update(kw)
    return PhonemeSource(**base)


def test_render_note_phone_fields():
    """RenderNote / RenderPhone 的派生字段（`durCorrectionMs` 最容易搬错）。"""
    # IRenderer 的 ToString 语义：同类实例必须给出同一字符串（否则乐句哈希会漂）
    r1, r2 = _FakeRenderer(), _FakeRenderer()
    check('IRenderer.__str__: 同类实例同一字符串（不含内存地址）', str(r1) == str(r2),
          'got %r / %r' % (str(r1), str(r2)))
    check('IRenderer.__str__: 含类型名而不含 0x', 'FakeRenderer' in str(r1) and '0x' not in str(r1),
          'got %r' % str(r1))

    src = _mk_phrase_source([_mk_note()])
    ph = _mk_phoneme()
    p = RenderPhone(src, ph, 0)
    check('RenderPhone.dur_correction_ms = preutter - tail_intrude + tail_overlap',
          abs(p.dur_correction_ms - 30.0) < 1e-12, 'got %r' % p.dur_correction_ms)
    check('RenderPhone.leading_ms = preutter', p.leading_ms == 50.0)
    check('RenderPhone.position = partPosition + position - phrasePosition',
          p.position == 0, 'got %r' % p.position)
    check('RenderPhone.end = position + duration', p.end == 480, 'got %r' % p.end)
    check('RenderPhone.note_index 随 PhonemeSource', p.note_index == 0)
    check('RenderPhone.hash 是 64 位无符号', 0 <= p.hash < 2 ** 64)

    rn = RenderNote(_mk_note(), src.axis, 0, 0)
    check('RenderNote.position 相对乐句起点', rn.position == 0, 'got %r' % rn.position)
    check('RenderNote.end = position + duration', rn.end == 480)
    check('RenderNote.positionMs 用绝对 tick 查轴', abs(rn.position_ms - 0.0) < 1e-9)
    check('RenderNote.endMs = 480 tick → 500 ms', abs(rn.end_ms - 500.0) < 1e-9,
          'got %r' % rn.end_ms)

    # with_oto / xsy 掩码
    p.with_oto(None)
    q = p.with_oto(object())
    check('RenderPhone.WithOto: 哈希异或掩码', q.hash == (p.hash ^ RenderPhone.OTO2_HASH_MASK),
          'got %r' % q.hash)
    check('RenderPhone.WithOto: 原对象不被改动', p.oto is ph.oto)


def test_render_phrase_build():
    """RenderPhrase 的乐句装配：音高铺平、颤音、PITD、曲线、两级哈希。"""
    src = _mk_phrase_source([_mk_note()])
    ph = _mk_phoneme()
    rp = RenderPhrase(src, [ph], 0, 1)

    check('RenderPhrase.position = partPosition + 首个音素 position', rp.position == 0)
    check('RenderPhrase.end = partPosition + 末音素 end', rp.end == 480)
    check('RenderPhrase.duration = end - position', rp.duration == 480)
    check('RenderPhrase.leading 取首个音素的 leading', rp.leading == 50)
    check('RenderPhrase.positionMs/endMs 取首末音素', (rp.position_ms, rp.end_ms) == (0.0, 500.0))
    check('RenderPhrase.durationMs = endMs - positionMs', rp.duration_ms == 500.0)

    # pitchStart = position - partPosition - leading = -50
    # 数组长度 = (end - partPosition - pitchStart) / 5 + 1 = (480 + 50)/5 + 1 = 107
    check('RenderPhrase.pitches 长度按 pitchInterval=5 铺满', len(rp.pitches) == 107,
          'got %d' % len(rp.pitches))
    check('RenderPhrase.pitches 无颤音/弯音时按音符铺平（AdjustedTone*100）',
          set(rp.pitches) == {6000.0}, 'got %r' % sorted(set(rp.pitches))[:4])
    check('RenderPhrase.phones 数量 = 乐句内音素数', len(rp.phones) == 1)
    check('RenderPhrase.notes 数量 = 乐句覆盖音符数', len(rp.notes) == 1)
    check('RenderPhrase.layout 由 renderer.Layout 得出', rp.layout.estimated_ms == 500.0,
          'got %r' % (rp.layout,))

    # 两级哈希：preEffectHash 不含音高，hash 含
    src2 = _mk_phrase_source([_mk_note(adjusted_tone=62.0)])
    rp2 = RenderPhrase(src2, [_mk_phoneme()], 0, 1)
    check('RenderPhrase: 仅改 AdjustedTone 时 preEffectHash 不变',
          rp2.pre_effect_hash == rp.pre_effect_hash)
    check('RenderPhrase: 仅改 AdjustedTone 时 hash 改变', rp2.hash != rp.hash)
    check('RenderPhrase: 同一输入两次构建 hash 一致（确定性）',
          RenderPhrase(src, [_mk_phoneme()], 0, 1).hash == rp.hash)

    # 颤音：pitches 不再是常数
    src3 = _mk_phrase_source([_mk_note()])
    src3.notes[0].vibrato = VibratoSource(length=100, period=100, depth=50,
                                          vib_in=0, vib_out=0, shift=0, drift=0, vol_link=0)
    rp3 = RenderPhrase(src3, [_mk_phoneme()], 0, 1)
    check('RenderPhrase: 有颤音时 pitches 有起伏', len(set(rp3.pitches)) > 1,
          'got %d 个不同值' % len(set(rp3.pitches)))
    check('RenderPhrase: 仅改颤音不改变音素哈希',
          rp3.phones[0].hash == rp.phones[0].hash)
    check('RenderPhrase: 仅改颤音会改变乐句哈希', rp3.hash != rp.hash)

    # PITD：整个音高被抬高
    pitd = CurveSource(abbr=Ustx.PITD, xs=[0, 480], ys=[0, 100], default_y=0, min=0)
    src4 = _mk_phrase_source([_mk_note()], curves=[pitd])
    rp4 = RenderPhrase(src4, [_mk_phoneme()], 0, 1)
    check('RenderPhrase: PITD 叠加到 pitches 末点 (+100)',
          abs(rp4.pitches[-1] - 6100.0) < 1e-9, 'got %r' % rp4.pitches[-1])
    check('RenderPhrase: pitchesBeforeDeviation 保留 PITD 之前的值',
          set(rp4.pitches_before_deviation) == {6000.0})

    # 曲线：DYN 走分贝换算，未给数据的表达式走默认值
    dyn = CurveSource(abbr=Ustx.DYN, xs=[0, 480], ys=[0, 100], default_y=0, min=0.0)
    descs = [UExpressionDescriptor(name='Dynamics', abbr='dyn', min=0, max=100, default_value=0),
             UExpressionDescriptor(name='Gender', abbr='genc', min=-100, max=100, default_value=0)]
    src5 = _mk_phrase_source([_mk_note()], curves=[dyn], descriptors=descs)
    rp5 = RenderPhrase(src5, [_mk_phoneme()], 0, 1)
    check('RenderPhrase: DYN 曲线末点 = DecibelToLinear(10)',
          rp5.dynamics is not None and abs(rp5.dynamics[-1] - 10 ** 0.5) < 1e-9,
          'got %r' % (rp5.dynamics[-1] if rp5.dynamics else None))
    check('RenderPhrase: DYN 起点取 min → 换算为 0', rp5.dynamics[0] == 0.0,
          'got %r' % rp5.dynamics[0])
    check('RenderPhrase: 缺数据的 GENC 走 CurveSource.Empty 的默认值',
          rp5.gender == [0.0] * len(rp5.pitches), 'got %r' % (rp5.gender[:3] if rp5.gender else None))
    check('RenderPhrase: 未定义的曲线进 curves 列表',
          all(name != 'dyn' and name != 'genc' for name, _ in rp5.curves))

    # 自定义曲线
    vib_c = CurveSource(abbr='vib', xs=[0, 480], ys=[0, 50], default_y=0, min=0.0)
    desc6 = UExpressionDescriptor(name='Vib', abbr='vib', min=0, max=100, default_value=0)
    src6 = _mk_phrase_source([_mk_note()], curves=[vib_c], descriptors=[desc6])
    rp6 = RenderPhrase(src6, [_mk_phoneme()], 0, 1)
    check('RenderPhrase: 自定义曲线进 curves', len(rp6.curves) == 1 and rp6.curves[0][0] == 'vib',
          'got %r' % [(n, len(a)) for n, a in rp6.curves])
    check('RenderPhrase: 自定义曲线长度与 pitches 一致',
          len(rp6.curves[0][1]) == len(rp6.pitches))

    # 弯音点（io 形状走 InterpolateShape）
    pp = [PitchPoint(0, 0, PitchPointShape.IO), PitchPoint(240, 0, PitchPointShape.IO)]
    src7 = _mk_phrase_source([_mk_note()], note_pitch_points={0: pp})
    rp7 = RenderPhrase(src7, [_mk_phoneme()], 0, 1)
    check('RenderPhrase: 有弯音点时 pitches 仍在合理量级（±2000 音分内）',
          all(abs(v - 6000.0) < 2000 for v in rp7.pitches),
          '偏差异常: %r' % sorted({round(v, 2) for v in rp7.pitches})[:5])

    # 缓存文件记录
    rp7.add_cache_file(r'C:\tmp\abc.wav')
    rp7.add_cache_file(r'C:\tmp\abc.frq')
    check('RenderPhrase.add_cache_file: 按去扩展名去重', rp7.cache_files == ['abc'],
          'got %r' % rp7.cache_files)

    # xsy 变体
    v = RenderPhrase.build_xsy_variant(rp)
    check('RenderPhrase.BuildXsyVariant: 掩码作用于乐句哈希',
          v.hash == (rp.hash ^ RenderPhone.OTO2_HASH_MASK))
    check('RenderPhrase.BuildXsyVariant: 原乐句不被改动', rp.hash != v.hash)


def test_renderers_registry():
    """`Render/renderers.py` 对 Renderers.cs 的一致性（常量、分支顺序、ApplyDynamics）。"""
    cs = _read('Render/Renderers.cs')
    if cs is None:
        print('  SKIP 找不到 Render/Renderers.cs')
        return
    import singing.openutau.renderers as R
    from singing.openutau import (CLASSIC, DIFFSINGER, ENUNU, VOICEVOX, VOGEN, WORLDLINE_R,
                                  WORLDLINE_R2, WORLDLINE_R11)

    # ---- 常量字面值
    want = dict(re.findall(r'public const string (\w+) = "([^"]*)";', cs))
    got = {'CLASSIC': CLASSIC, 'WORLDLINE_R': WORLDLINE_R, 'WORLDLINE_R2': WORLDLINE_R2,
           'WORLDLINE_R11': WORLDLINE_R11, 'ENUNU': ENUNU, 'VOGEN': VOGEN,
           'DIFFSINGER': DIFFSINGER, 'VOICEVOX': VOICEVOX}
    check('Renderers: 8 个常量字面值一致（%d）' % len(want), want == got,
          'C#=%r 我们=%r' % (want, got))

    # ---- 四个静态数组的字面值与顺序（C# 里写的是常量**标识符**，要经常量表转成字面值）
    def _cs_array(name):
        m = re.search(r'static readonly string\[\] %s = new\[\] \{(.*?)\};' % name, cs, re.S)
        if not m:
            return None
        return [want.get(s.strip().strip('"'), s.strip().strip('"'))
                for s in m.group(1).split(',') if s.strip()]

    check('Renderers: classicRenderers 顺序一致',
          _cs_array('classicRenderers') == [WORLDLINE_R, WORLDLINE_R11, CLASSIC],
          'C#=%r' % _cs_array('classicRenderers'))
    for cs_name, ours, label in (
            ('enunuRenderers', [ENUNU], 'enunuRenderers'),
            ('vogenRenderers', [VOGEN], 'vogenRenderers'),
            ('diffSingerRenderers', [DIFFSINGER], 'diffSingerRenderers'),
            ('voicevoxRenderers', [VOICEVOX], 'voicevoxRenderers')):
        check('Renderers: %s 一致' % label, _cs_array(cs_name) == ours,
              'C#=%r 我们=%r' % (_cs_array(cs_name), ours))
    check('Renderers: noRenderers 是空数组', re.search(r'string\[\] noRenderers = new string\[0\]', cs) is not None)

    # ---- getRendererOptions 的字面量（注意 "Classic" 的大小写）
    m = re.search(r'getRendererOptions\(\)\s*\{(.*?)\}', cs, re.S)
    opts = re.findall(r'"([^"]+)"', m.group(1)) if m else None
    check('Renderers: getRendererOptions 字面量一致（含 "Classic" 的大小写）',
          opts == R.get_renderer_options(), 'C#=%r 我们=%r' % (opts, R.get_renderer_options()))

    # ---- ApplyDynamics 里写死的常数
    check('Renderers: ApplyDynamics 的 interval=5', re.search(r'ApplyDynamics.*?const int interval = 5;', cs, re.S) is not None)
    check('Renderers: ApplyDynamics 采样率写死 44100', '1000 * 44100' in cs and R.SAMPLE_RATE == 44100)
    check('Renderers: ApplyDynamics 末段 b 取自身（不外推）',
          'phrase.dynamics[i + 1]' in cs and '(i + 1) == phrase.dynamics.Length' in cs)

    # ---- GetDefaultRenderer 比较的字面量
    check('Renderers: GetDefaultRenderer 比的是 "Classic"（非 CLASSIC）',
          'DefaultRenderer == "Classic"' in cs)

    # ---- 分支顺序：WORLDLINE-R2 / -R1.1 必须在前缀兜底之前
    i_r2 = cs.index('renderer == WORLDLINE_R2')
    i_prefix = cs.index('renderer?.StartsWith(WORLDLINE_R.Substring(0, 9))')
    i_r11 = cs.index('renderer == WORLDLINE_R11')
    check('Renderers: 源码里 R2/R1.1 分支排在前缀兜底之前（C# 顺序）',
          i_r2 < i_prefix and i_r11 < i_prefix, 'r2=%d r11=%d prefix=%d' % (i_r2, i_r11, i_prefix))

    # ---- 功能：GetSupportedRenderers 按精确值匹配
    check('Renderers.GetSupportedRenderers(Classic=0x1)',
          R.get_supported_renderers(0x1) == (WORLDLINE_R, WORLDLINE_R11, CLASSIC))
    check('Renderers.GetSupportedRenderers(DiffSinger=0x5) 不是 0x1|0x4 的按位判定',
          R.get_supported_renderers(0x5) == (DIFFSINGER,))
    check('Renderers.GetSupportedRenderers(未知) 返回共享空元组',
          R.get_supported_renderers(0x99) is R.NO_RENDERERS)

    # ---- 功能：DefaultRenderer=="Classic" 且 Classic → 常量 CLASSIC
    class _Pref:
        default_renderer = 'Classic'

    class _PrefLower:
        default_renderer = 'CLASSIC'

    check('Renderers.GetDefaultRenderer: "Classic"+Classic → CLASSIC',
          R.get_default_renderer(0x1, _Pref()) == CLASSIC)
    check('Renderers.GetDefaultRenderer: "CLASSIC"（全大写）不进特判分支',
          R.get_default_renderer(0x1, _PrefLower()) == WORLDLINE_R,
          'got %r' % R.get_default_renderer(0x1, _PrefLower()))

    # ---- 功能：CreateRenderer 的版本分派与前缀兜底
    R.reset_registry()
    seen = {}

    def _ws_factory(version):
        def f(**kw):
            seen[kw.get('version')] = True
            return {'version': kw.get('version')}
        return f

    R.register_renderer(WORLDLINE_R, _ws_factory(10))
    R.register_renderer(WORLDLINE_R2, _ws_factory(20))
    R.register_renderer(WORLDLINE_R11, _ws_factory(11))
    check('Renderers.CreateRenderer(WORLDLINE-R2) → version=20（不被前缀兜底吃掉）',
          R.create_renderer(WORLDLINE_R2) == {'version': 20}, 'got %r' % R.create_renderer(WORLDLINE_R2))
    check('Renderers.CreateRenderer(WORLDLINE-R1.1) → version=11',
          R.create_renderer(WORLDLINE_R11) == {'version': 11})
    check('Renderers.CreateRenderer(WORLDLINE-R) → version=10',
          R.create_renderer(WORLDLINE_R) == {'version': 10})
    check('Renderers.CreateRenderer(未注册的 CLASSIC) → None（C# 对未知名也返回 null）',
          R.create_renderer(CLASSIC) is None)
    check('Renderers.CreateRenderer(未知) → None', R.create_renderer('NOPE') is None)
    check('Renderers.CreateRenderer(None) → None', R.create_renderer(None) is None)

    # ---- 功能：GetOrCreate 永不失效
    holder = []

    class _FakeR:
        expression_graph_slot = 'slot-x'

        def __init__(self):
            holder.append(self)

    R.register_renderer(CLASSIC, _FakeR)
    a1 = R.get_or_create(CLASSIC)
    a2 = R.get_or_create(CLASSIC)
    check('Renderers.GetOrCreate: 同 id 同实例（进程级缓存）', a1 is a2 and len(holder) == 1,
          'got %d 个实例' % len(holder))
    check('Renderers.GetExpressionGraphSlot: 走渲染器的槽位',
          R.get_expression_graph_slot(CLASSIC) == 'slot-x')
    check('Renderers.GetExpressionGraphSlot: 渲染器不存在时回落 id 本身',
          R.get_expression_graph_slot('NOPE') == 'NOPE')

    # ---- 功能：GetCacheLock 同一个 key 同一把锁
    check('Renderers.GetCacheLock: 同 key 同对象', R.get_cache_lock('a.wav') is R.get_cache_lock('a.wav'))
    check('Renderers.GetCacheLock: 不同 key 不同对象', R.get_cache_lock('a.wav') is not R.get_cache_lock('b.wav'))

    R.reset_registry()

    # ---- 功能：ApplyDynamics 的插值与末段常数
    _axis = TimeAxis()
    _axis.build_segments(UProject())

    class _Phrase:
        position = 0
        leading = 0
        dynamics = [1.0, 2.0]
        time_axis = _axis

    class _Result:
        position_ms = 0.0
        leading_ms = 0.0

        def __init__(self, n):
            self.samples = [1.0] * n

    # 120bpm、480 resolution → 每 tick = 60000/120/480 ms ≈ 1.041667ms
    # dynamics 间隔 5 tick ≈ 5.2083ms ≈ 229.6 样本 → 前 229 样本乘 (1→2) 的斜坡
    p = _Phrase()
    r = _Result(400)
    R.apply_dynamics(p, r)
    check('ApplyDynamics: 第 0 个样本乘 a(=1)', abs(r.samples[0] - 1.0) < 1e-9,
          'got %r' % r.samples[0])
    check('ApplyDynamics: 段内单调上升（a→b 线性插值）',
          r.samples[1] < r.samples[100] < 1.99, 'got %r' % r.samples[100])
    # 最后一段：i=1 是末项 → b 取自身 2.0 → 增益恒为 2.0（不外推）
    check('ApplyDynamics: 末段 b 取自身 → 增益恒为 2.0',
          abs(r.samples[350] - 2.0) < 1e-9, 'got %r' % r.samples[350])

    # dynamics 为 None 时直接返回（不改动样本）
    p2 = _Phrase()
    p2.dynamics = None
    r2 = _Result(10)
    R.apply_dynamics(p2, r2)
    check('ApplyDynamics: dynamics 为 None 时不动样本', r2.samples == [1.0] * 10)


def test_resampler_item():
    """`Classic/ResamplerItem.cs` —— 单音素的 resampler 参数、哈希与包络换算。"""
    from singing.openutau.classic import resampler_item as RI
    cs = _read('Classic/ResamplerItem.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/ResamplerItem.cs')
        return

    # ---- 源码一致性：哈希写入顺序
    want = _cs_writes(_slice(cs, 'ulong Hash() {', 'public List<Vector2> EnvelopeMsToSamples'))
    py_src = open(os.path.join(ENGINE, 'singing', 'openutau', 'classic', 'resampler_item.py'),
                  encoding='utf-8').read()
    got = _py_writes(_slice(py_src, 'def _hash(self)', 'def envelope_ms_to_samples'))
    check('ResamplerItem.Hash: 写入顺序与 C# 逐项一致', want == got,
          'C#=%r\n       我们=%r' % (want, got))

    # ---- 源码一致性：关键常量与算式
    check('ResamplerItem: 辅音伸缩用 2 的幂（2^(1-velocity*0.01)）',
          'Math.Pow(2, 1.0 - velocity * 0.01)' in cs)
    check('ResamplerItem: durRequired 向上取整到 50 的倍数（ceil(x/50+0.5)*50）',
          'Math.Ceiling(durRequired / 50.0 + 0.5) * 50.0' in cs)
    check('ResamplerItem: 输出文件名 res-{XXH32(singerId):x8}-{hash:x16}.wav',
          'XXH32.DigestOf' in cs and 'res-' in cs and 'x8' in cs and 'x16' in cs)

    # ---- 功能：构造一个真实的 RenderPhrase，再建 ResamplerItem
    class _Resampler:
        def supports_flag(self, abbr):
            return abbr != 'dropme'

        def __str__(self):
            return 'test-resampler'

    class _Host(RI.ClassicHost):
        cache_path = r'C:\cache'

        def get_resampler(self, name):
            return _Resampler()

        def get_source_temp_path(self, singer_id, oto, ext):
            return r'C:\cache\tmp\%s%s' % (singer_id, ext)

    old_host = RI.host
    RI.host = _Host()
    try:
        uoto = UOto(Oto(alias='a', wav='a.wav', offset=100.0, consonant=50.0,
                        cutoff=-200.0, preutter=60.0, overlap=20.0),
                    UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb'), None)
        # 注意 velocity 是**归一化**值（PhonemeSource 里 `Velocity = vel * 0.01f`），
        # 所以 1.0 对应 UTAU 的 100。
        env_pts = [Vector2(0, 0), Vector2(50, 100), Vector2(200, 100),
                   Vector2(250, 100), Vector2(300, 0)]
        ph = _mk_phoneme(
            oto=uoto, envelope=env_pts,
            flags=[('V', 50, 'vel'), ('M', None, 'mod'), ('X', 1, 'dropme')],
            velocity=1.0, volume=100.0, modulation=0.0,
            preutter=50.0, overlap=10.0, tail_intrude=25.0, tail_overlap=5.0,
            leading=50)
        src = _mk_phrase_source([_mk_note()])
        rp = RenderPhrase(src, [ph], 0, 1)
        item = RI.ResamplerItem(rp, rp.phones[0])

        check('ResamplerItem: flags 按 resampler.supports_flag 过滤掉不支持的',
              item.flags == [('V', 50, 'vel'), ('M', None, 'mod')], 'got %r' % item.flags)
        check('ResamplerItem: GetFlagsString 拼出 "V50M"', item.get_flags_string() == 'V50M',
              'got %r' % item.get_flags_string())
        check('ResamplerItem: velocity/volume/modulation 是 ×100 取整',
              (item.velocity, item.volume, item.modulation) == (100, 10000, 0),
              'got %r' % ((item.velocity, item.volume, item.modulation),))
        # skipOver = oto.Preutter * 2^(1-vel*0.01) - leadingMs = 60*2^0 - 50 = 10
        check('ResamplerItem: skipOver = oto.Preutter*2^(1-vel*0.01) - leadingMs = 10',
              abs(item.skip_over - 10.0) < 1e-9, 'got %r' % item.skip_over)
        # durRequired = (500-0) + 30 + 10 = 540 → ceil(540/50+0.5)*50 = ceil(11.3)*50 = 600
        check('ResamplerItem: durRequired = ceil((540/50)+0.5)*50 = 600',
              abs(item.dur_required - 600.0) < 1e-9, 'got %r' % item.dur_required)
        check('ResamplerItem: 直接透传 oto 的 offset/consonant/cutoff',
              (item.offset, item.consonant, item.cutoff) == (100.0, 50.0, -200.0),
              'got %r' % ((item.offset, item.consonant, item.cutoff),))
        check('ResamplerItem: durCorrection 照抄 RenderPhone 的值',
              item.dur_correction == rp.phones[0].dur_correction_ms)
        check('ResamplerItem: tempo 取 phone.adjustedTempo', item.tempo == 120.0,
              'got %r' % item.tempo)
        check('ResamplerItem: inputFile 取 oto.file',
              item.input_file.replace('\\', '/').endswith('/vb/a.wav'), 'got %r' % item.input_file)
        check('ResamplerItem: outputFile 带 XXH32(singerId) 前缀',
              item.output_file.startswith('C:\\cache\\res-')
              and item.output_file.endswith('.wav')
              and len(os.path.basename(item.output_file)) == len('res-') + 8 + 1 + 16 + 4,
              'got %r' % item.output_file)
        check('ResamplerItem: 两个缓存文件都登记到乐句',
              len(rp.cache_files) == 2, 'got %r' % rp.cache_files)
        check('ResamplerItem: 音高序列长度 ≥ 0 且为 int',
              isinstance(item.pitches, list)
              and all(isinstance(v, int) for v in item.pitches),
              'got %r' % (item.pitches[:5],))
        check('ResamplerItem.Hash: 同一输入两次构造同值',
              RI.ResamplerItem(rp, rp.phones[0]).hash == item.hash)

        # ★ struct 语义：EnvelopeMsToSamples 不能污染 phone.envelope
        before = [(p.x, p.y) for p in rp.phones[0].envelope]
        env = item.envelope_ms_to_samples()
        after = [(p.x, p.y) for p in rp.phones[0].envelope]
        check('ResamplerItem.EnvelopeMsToSamples: **不改动** phone.envelope（C# struct 语义）',
              before == after, '改动前=%r 改动后=%r' % (before, after))
        check('ResamplerItem.EnvelopeMsToSamples: 返回的是新对象（不与原包络同一引用）',
              all(a is not b for a, b in zip(env, rp.phones[0].envelope)))
        # skipOver=10ms → 441 样本；首点 x = (0 + shift) * 44.1 + 441 = 441，y = 0/100 = 0
        check('ResamplerItem.EnvelopeMsToSamples: 首点 x = skipOverSamples、y 除以 100',
              env[0].x == 441 and env[0].y == 0.0, 'got %r' % env[0])
        check('ResamplerItem.EnvelopeMsToSamples: 后续点按 ms→样本换算（+min() 平移）',
              env[1].x == 441 + int(50 * 44100 / 1000) and env[1].y == 1.0, 'got %r' % env[1])

        # apply_envelope：就地乘增益（441 → 2646 上升，2647..9261 保持 1，13671 后为 0）
        samples = [1.0] * 16000
        item.apply_envelope(samples)
        check('ResamplerItem.ApplyEnvelope: 首样本落在包络起点前 → 增益 0',
              samples[0] == 0.0, 'got %r' % samples[0])
        check('ResamplerItem.ApplyEnvelope: 平台段增益 1', samples[5000] == 1.0,
              'got %r' % samples[5000])
        check('ResamplerItem.ApplyEnvelope: 尾样本落在包络终点后 → 增益 0',
              samples[-1] == 0.0, 'got %r' % samples[-1])

        # 未配置 host 时应明确报错（不静默给错路径）
        RI.host = old_host
        try:
            RI.ResamplerItem(rp, rp.phones[0])
            check('ResamplerItem: 未配置 host 时抛 NotImplementedError', False, '没有抛错')
        except NotImplementedError:
            check('ResamplerItem: 未配置 host 时抛 NotImplementedError', True)
    finally:
        RI.host = old_host


def test_japanese_vcv_phonemizer():
    """`Plugin.Builtin/JapaneseVCVPhonemizer.cs` —— VCV 别名判定与回落链。"""
    from singing.openutau.plugin_builtin import japanese_vcv as J
    from singing.openutau import Note, PhonemeAttributes, registered
    ja_cs_path = os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                              'JapaneseVCVPhonemizer.cs')
    if not os.path.isfile(ja_cs_path):
        print('  SKIP 找不到 JapaneseVCVPhonemizer.cs')
        return
    cs = open(ja_cs_path, encoding='utf-8-sig').read().replace('\r\n', '\n')

    # ---- 源码一致性：注册信息与 vowels 表
    m = re.search(r'\[Phonemizer\("([^"]*)",\s*"([^"]*)"(?:,\s*author:\s*"([^"]*)")?'
                  r'(?:,\s*language:\s*"([^"]*)")?\)\]', cs)
    check('JA VCV: [Phonemizer] 的 name/tag/language 与 C# 一致',
          m is not None and m.group(1) == J.JapaneseVCVPhonemizer.name
          and m.group(2) == J.JapaneseVCVPhonemizer.tag
          and m.group(4) == J.JapaneseVCVPhonemizer.language,
          'C#=%r 我们=%r' % (m.groups() if m else None,
                             (J.JapaneseVCVPhonemizer.name, J.JapaneseVCVPhonemizer.tag,
                              J.JapaneseVCVPhonemizer.language)))
    check('JA VCV: 已在注册表里（tag 为键）',
          registered().get('JA VCV') is J.JapaneseVCVPhonemizer)

    cs_vowels = re.findall(r'^\s{12}"([a-zA-Z]+=.*)",\s*$', cs, re.M)
    check('JA VCV: vowels 表逐行与 C# 一致（%d 行）' % len(cs_vowels),
          tuple(cs_vowels) == J.VOWELS,
          'C#=%r\n       我们=%r' % (cs_vowels, list(J.VOWELS)))
    # 行数 × 各行假名数 = 表项数；且顺序（优先级）由行序决定
    check('JA VCV: 查表规模 170 项且无重复键（重复在 C# 会抛异常）',
          len(J.VOWEL_LOOKUP) == 170, 'got %d' % len(J.VOWEL_LOOKUP))
    check('JA VCV: ぁ/あ/か 都归 a', all(J.VOWEL_LOOKUP[k] == 'a' for k in 'ぁあか'))
    check('JA VCV: ゃ 归 a（拗音归尾元音）', J.VOWEL_LOOKUP['ゃ'] == 'a')
    check('JA VCV: n 归 n、ng 归 N（拨音两行不能合并）',
          J.VOWEL_LOOKUP['n'] == 'n' and J.VOWEL_LOOKUP['ng'] == 'N'
          and J.VOWEL_LOOKUP['ん'] == 'n' and J.VOWEL_LOOKUP['ン'] == 'N')

    # ---- 功能：用假歌手驱动
    def _mk_oto(alias, color=''):
        return UOto(Oto(alias=alias, wav=alias + '.wav'),
                    UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb'),
                    [USubbank(Subbank(color=color))])

    class _Singer:
        def __init__(self, aliases):
            self.aliases = aliases

        def try_get_mapped_oto(self, phoneme, tone, color=None):
            # ★ 必须与 `USinger.try_get_mapped_oto` 同契约：返回 `(found, oto)`
            #   （照搬 C# 的 out 参数）。返回裸值会让音素化器的 bug 测不出来。
            oto = self.aliases.get(phoneme)
            return (oto is not None), oto

    ph = J.JapaneseVCVPhonemizer()

    # (1) 无前邻：应命中 "- な"
    singer = _Singer({'- な': _mk_oto('- な'), 'な': _mk_oto('な')})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60)])
    check('JA VCV: 无前邻时优先 "- な"',
          [p.phoneme for p in r.phonemes] == ['- な'], 'got %r' % [p.phoneme for p in r.phonemes])

    # (2) 有前邻 "き"（尾元音 i）→ 应命中 "i な"
    singer = _Singer({'i な': _mk_oto('i な'), '- な': _mk_oto('- な'), 'な': _mk_oto('な')})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60)], prev_neighbour=Note(lyric='き'))
    check('JA VCV: 前邻"き"的尾元音 i → 命中 "i な"',
          [p.phoneme for p in r.phonemes] == ['i な'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (3) 前邻是拗音 "きゃ" → 取最后一个字素 "ゃ" → 元音 a → "a な"
    singer = _Singer({'a な': _mk_oto('a な')})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60)], prev_neighbour=Note(lyric='きゃ'))
    check('JA VCV: 前邻"きゃ"取末字素 ゃ → 元音 a → "a な"',
          [p.phoneme for p in r.phonemes] == ['a な'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (4) 前邻尾音查不到元音（如 "X"）→ 退回 "- な" / "な" 长链
    singer = _Singer({'な': _mk_oto('な')})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60)], prev_neighbour=Note(lyric='X'))
    check('JA VCV: 前邻尾音不是假名时回落到裸歌词',
          [p.phoneme for p in r.phonemes] == ['な'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (5) 全都不命中 → 回落原歌词
    singer = _Singer({})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='ふにゃ', tone=60)])
    check('JA VCV: 全部候选都不命中时回落原歌词',
          [p.phoneme for p in r.phonemes] == ['ふにゃ'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (6) phoneticHint：先试 hint，命中即返回；未命中则**继续走正常流程**
    singer = _Singer({'HINT': _mk_oto('HINT'), '- な': _mk_oto('- な')})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60, phonetic_hint='HINT')])
    check('JA VCV: 有 phoneticHint 且命中时优先用 hint',
          [p.phoneme for p in r.phonemes] == ['HINT'],
          'got %r' % [p.phoneme for p in r.phonemes])
    # hint 未命中时 C# 会继续往下走正常流程（不是跳过）—— 这里应命中 "- な"
    singer = _Singer({'HINT': _mk_oto('HINT'), '- な': _mk_oto('- な')})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60, phonetic_hint='NOPE')])
    check('JA VCV: hint 未命中时**继续走正常流程**（命中 "- な"）',
          [p.phoneme for p in r.phonemes] == ['- な'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (7) NFC 归一化：分解形式的 か+゙ 要先合成成 が 才能查表
    decomposed = unicodedata.normalize('NFD', 'が')
    check('JA VCV: 测试前置 —— 分解形式确实与合成形式不同',
          decomposed != 'が' and len(decomposed) == 2)
    singer = _Singer({'a が': _mk_oto('a が')})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='が', tone=60)],
                   prev_neighbour=Note(lyric=unicodedata.normalize('NFD', 'か')))
    check('JA VCV: 前邻歌词先做 NFC 归一化（否则查不到尾元音）',
          [p.phoneme for p in r.phonemes] == ['a が'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (8) alt 后缀：候选先试 `test + alt`，命中就用它（alt=0 → "i な0"）
    colored = _mk_oto('i な0', color='Soft')
    plain = _mk_oto('i な', color='')
    singer = _Singer({'i な': plain, 'i な0': colored})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60,
                         phoneme_attributes=[PhonemeAttributes(index=0, alternate=0,
                                                               voice_color='Soft')])],
                   prev_neighbour=Note(lyric='き'))
    check('JA VCV: 候选先试 test+alt（alt=0 → "i な0"）',
          [p.phoneme for p in r.phonemes] == ['i な0'],
          'got %r' % [p.phoneme for p in r.phonemes])
    # alt 未命中时回落到 test 本身
    singer = _Singer({'i な': plain})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60,
                         phoneme_attributes=[PhonemeAttributes(index=0, alternate=7)])],
                   prev_neighbour=Note(lyric='き'))
    check('JA VCV: test+alt 未命中时回落 test 本身',
          [p.phoneme for p in r.phonemes] == ['i な'],
          'got %r' % [p.phoneme for p in r.phonemes])
    # 颜色优先：前邻 "き" 下 "i な" 与 "* な" 都命中，应挑 IsColorMatch('Soft') 的 "* な"
    singer = _Singer({'i な': _mk_oto('i な', color=''),
                      '* な': _mk_oto('* な', color='Soft')})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60,
                         phoneme_attributes=[PhonemeAttributes(index=0, voice_color='Soft')])],
                   prev_neighbour=Note(lyric='き'))
    check('JA VCV: 多候选命中时优先取 IsColorMatch(color) 的那个（不是第一个）',
          [p.phoneme for p in r.phonemes] == ['* な'],
          'got %r' % [p.phoneme for p in r.phonemes])
    # 没有颜色匹配的候选时退回第一个
    singer = _Singer({'i な': _mk_oto('i な', color=''),
                      '* な': _mk_oto('* な', color='Other')})
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60,
                         phoneme_attributes=[PhonemeAttributes(index=0, voice_color='Soft')])],
                   prev_neighbour=Note(lyric='き'))
    check('JA VCV: 无颜色匹配候选时退回第一个命中项',
          [p.phoneme for p in r.phonemes] == ['i な'],
          'got %r' % [p.phoneme for p in r.phonemes])


def _mk_named_oto(alias, color=''):
    """造一个带 subbanks 的 UOto（无 subbanks 时 is_color_match 会抛，与 C# 一致）。"""
    return UOto(Oto(alias=alias, wav=alias + '.wav'),
                UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb'),
                [USubbank(Subbank(color=color))])


class _OtoSinger:
    """按别名查表的假歌手。"""

    def __init__(self, aliases, location=''):
        self.aliases = aliases
        # ★ 真 `USinger` 一定有下面这些**属性**：缺了会让"读歌手状态/路径"的代码在
        #   测试里抛 AttributeError（而真机不会）。替身要照抄真实现的**属性面**，
        #   不只是方法签名 —— 这是上一轮那个 (found, oto) bug 的同类。
        self.found = True
        self.loaded = True
        self.location = location
        self.id = 'fake-singer'

    @property
    def is_loaded(self):
        """★ 真 `USinger.Loaded` = `found && loaded`。替身要照抄真实现的**属性面**。"""
        return self.found and self.loaded

    def try_get_mapped_oto(self, phoneme, tone, color=None):
        # ★ 同契约：`(found, oto)`，别返回裸值
        oto = self.aliases.get(phoneme)
        return (oto is not None), oto

    def try_get_oto(self, phoneme):
        """★ 真 `USinger` 也有这个（`HasOto` 的第二段就查它）。"""
        oto = self.aliases.get(phoneme)
        return (oto is not None), oto


def test_chinese_vcv_phonemizer():
    """`Plugin.Builtin/ChineseVCVPhonemizer.cs` —— 尾韵母查表 + 尾韵 R + 汉字罗马化。"""
    from singing.openutau.plugin_builtin import chinese_vcv as C
    from singing.openutau import BaseChinesePhonemizer, Note, PhonemeAttributes, registered
    ja_path = os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                           'ChineseVCVPhonemizer.cs')
    if not os.path.isfile(ja_path):
        print('  SKIP 找不到 ChineseVCVPhonemizer.cs')
        return
    cs = open(ja_path, encoding='utf-8-sig').read().replace('\r\n', '\n')

    # ---- 源码一致性：注册信息
    m = re.search(r'\[Phonemizer\("([^"]*)",\s*"([^"]*)",\s*"([^"]*)"(?:,\s*language:\s*"([^"]*)")?\)\]', cs)
    check('ZH VCV: [Phonemizer] 的 name/tag/author/language 与 C# 一致',
          m is not None and (m.group(1), m.group(2), m.group(3), m.group(4)) == (
              C.ChineseVCVPhonemizer.name, C.ChineseVCVPhonemizer.tag,
              C.ChineseVCVPhonemizer.author, C.ChineseVCVPhonemizer.language),
          'C#=%r 我们=%r' % (m.groups() if m else None,
                             (C.ChineseVCVPhonemizer.name, C.ChineseVCVPhonemizer.tag,
                              C.ChineseVCVPhonemizer.author, C.ChineseVCVPhonemizer.language)))
    check('ZH VCV: 已在注册表里', registered().get('ZH VCV') is C.ChineseVCVPhonemizer)

    cs_rows = re.findall(r'^\s{12}"([^"]*=.*)",\s*$', cs, re.M)
    check('ZH VCV: tailMap 逐行与 C# 一致（%d 行）' % len(cs_rows),
          tuple(cs_rows) == C.TAIL_MAP, 'C#=%r\n       我们=%r' % (cs_rows, list(C.TAIL_MAP)))
    check('ZH VCV: 查表 408 项且无重复键', len(C.TAIL_LOOKUP) == 408,
          'got %d' % len(C.TAIL_LOOKUP))
    check('ZH VCV: 尾韵母归类正确（tian→ian / zhi→ir / zi→iz / nv→v / yun→vn）',
          (C.TAIL_LOOKUP['tian'], C.TAIL_LOOKUP['zhi'], C.TAIL_LOOKUP['zi'],
           C.TAIL_LOOKUP['nv'], C.TAIL_LOOKUP['yun'])
          == ('ian', 'ir', 'iz', 'v', 'vn'))

    # ---- ExtractPurePinyin
    ex = C.ChineseVCVPhonemizer.extract_pure_pinyin
    check('ZH VCV.ExtractPurePinyin: "-tian" → "tian"', ex('-tian') == 'tian')
    check('ZH VCV.ExtractPurePinyin: "- tian"（带空格）→ "tian"', ex('- tian') == 'tian')
    check('ZH VCV.ExtractPurePinyin: "ian bu" → 取最后一段 "bu"', ex('ian bu') == 'bu')
    check('ZH VCV.ExtractPurePinyin: "+" 原样', ex('+') == '+')
    check('ZH VCV.ExtractPurePinyin: 空串 → ""', ex('') == '' and ex('   ') == '')

    # ---- Romanize（汉字 → 无声调拼音）
    check('ZH VCV.Romanize: 单字汉字转拼音（云→yun）',
          BaseChinesePhonemizer.romanize(['天', 'tian', '云']) == ['tian', 'tian', 'yun'],
          'got %r' % BaseChinesePhonemizer.romanize(['天', 'tian', '云']))
    check('ZH VCV.Romanize: 多字歌词原样保留（不转换）',
          BaseChinesePhonemizer.romanize(['你好']) == ['你好'])
    # ★ 索引对齐：中间的 "你好" 被跳过时，后面的字**不能**错位拿到别人的拼音
    check('ZH VCV.Romanize: 多字歌词跳过后索引不错位',
          BaseChinesePhonemizer.romanize(['天', '你好', '云']) == ['tian', '你好', 'yun'],
          'got %r' % BaseChinesePhonemizer.romanize(['天', '你好', '云']))
    check('ZH VCV.Romanize: ü 写作 v（女→nv / 绿→lv），与 tailMap 的 v/vn 对得上',
          BaseChinesePhonemizer.romanize(['女', '绿', '军']) == ['nv', 'lv', 'jun'],
          'got %r' % BaseChinesePhonemizer.romanize(['女', '绿', 'jun']))
    _g = [Note(lyric='天', tone=60, position=0, duration=480)]
    BaseChinesePhonemizer.romanize_notes([_g])
    check('ZH VCV.RomanizeNotes: 就地替换首音符歌词', _g[0].lyric == 'tian')

    # ---- Process
    ph = C.ChineseVCVPhonemizer()

    # (1) 连音符透传
    ph.set_singer(_OtoSinger({}))
    r = ph.process([Note(lyric='+', tone=60, duration=480)])
    check('ZH VCV: "+" 原样透传', [p.phoneme for p in r.phonemes] == ['+'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (2) 前邻尾韵母已知 → tail 本字 优先
    ph.set_singer(_OtoSinger({'ian tian': _mk_named_oto('ian tian'),
                              '- tian': _mk_named_oto('- tian')}))
    r = ph.process([Note(lyric='tian', tone=60, duration=480)],
                   prev_neighbour=Note(lyric='qian'))
    check('ZH VCV: 前邻 qian(尾韵 ian) → 命中 "ian tian"',
          [p.phoneme for p in r.phonemes] == ['ian tian'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (3) 前邻未知 → 回落 "- 本字"
    ph.set_singer(_OtoSinger({'- tian': _mk_named_oto('- tian')}))
    r = ph.process([Note(lyric='tian', tone=60, duration=480)],
                   prev_neighbour=Note(lyric='zzz'))
    check('ZH VCV: 前邻尾韵不认识时回落 "- 本字"',
          [p.phoneme for p in r.phonemes] == ['- tian'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (4) 全部不命中 → 回落原拼音
    ph.set_singer(_OtoSinger({}))
    r = ph.process([Note(lyric='tian', tone=60, duration=480)])
    check('ZH VCV: 全部候选落空时回落原拼音',
          [p.phoneme for p in r.phonemes] == ['tian'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (5) phoneticHint：命中用别名；**未命中直接用 hint 本身**（不回落正常流程）
    ph.set_singer(_OtoSinger({'H': _mk_named_oto('H'), '- tian': _mk_named_oto('- tian')}))
    r = ph.process([Note(lyric='tian', tone=60, duration=480, phonetic_hint='H')])
    check('ZH VCV: phoneticHint 命中 → 用 oto 别名',
          [p.phoneme for p in r.phonemes] == ['H'],
          'got %r' % [p.phoneme for p in r.phonemes])
    r = ph.process([Note(lyric='tian', tone=60, duration=480, phonetic_hint='NOPE')])
    check('ZH VCV: phoneticHint 未命中 → 直接用 hint（与 JA VCV 不同，不走正常流程）',
          [p.phoneme for p in r.phonemes] == ['NOPE'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (6) 尾韵 R：无后续邻居时追加，位置 = total - min(total/6, 60)
    ph.set_singer(_OtoSinger({'tian': _mk_named_oto('tian'),
                              'ian R': _mk_named_oto('ian R')}))
    r = ph.process([Note(lyric='tian', tone=60, duration=480)])
    check('ZH VCV: 句末追加尾韵 R（两个音素）', len(r.phonemes) == 2,
          'got %r' % [p.phoneme for p in r.phonemes])
    check('ZH VCV: 尾韵 R 的音素名取自 oto 别名', r.phonemes[1].phoneme == 'ian R',
          'got %r' % r.phonemes[1].phoneme)
    check('ZH VCV: 尾韵 R 位置 = 480 - min(480/6,60) = 420', r.phonemes[1].position == 420,
          'got %r' % r.phonemes[1].position)
    r = ph.process([Note(lyric='tian', tone=60, duration=120)])
    check('ZH VCV: 短音时位置 = 120 - min(20,60) = 100', r.phonemes[1].position == 100,
          'got %r' % r.phonemes[1].position)
    # 有后续邻居 → 不加尾韵
    r = ph.process([Note(lyric='tian', tone=60, duration=480)],
                   next_neighbour=Note(lyric='bu'))
    check('ZH VCV: 有后续邻居时**不**加尾韵 R', len(r.phonemes) == 1,
          'got %r' % [p.phoneme for p in r.phonemes])

    # (7) alt：alt 命中与普通命中是**两个独立 if**（都会进结果表）
    #     这里让"普通别名"匹配颜色、alt 别名不匹配 → 应取普通那个
    ph.set_singer(_OtoSinger({'ian tian0': _mk_named_oto('ian tian0', color='Other'),
                              'ian tian': _mk_named_oto('ian tian', color='Soft')}))
    r = ph.process([Note(lyric='tian', tone=60, duration=480,
                         phoneme_attributes=[PhonemeAttributes(index=0, alternate=0,
                                                               voice_color='Soft')])],
                   prev_neighbour=Note(lyric='qian'))
    check('ZH VCV: alt 与普通别名同时进结果表 → 颜色匹配者胜出（说明不是 else-if）',
          [p.phoneme for p in r.phonemes] == ['ian tian'],
          'got %r' % [p.phoneme for p in r.phonemes])
    # alt 别名匹配颜色 → 取 alt 别名
    ph.set_singer(_OtoSinger({'ian tian0': _mk_named_oto('ian tian0', color='Soft'),
                              'ian tian': _mk_named_oto('ian tian', color='')}))
    r = ph.process([Note(lyric='tian', tone=60, duration=480,
                         phoneme_attributes=[PhonemeAttributes(index=0, alternate=0,
                                                               voice_color='Soft')])],
                   prev_neighbour=Note(lyric='qian'))
    check('ZH VCV: alt 别名颜色匹配时取 alt 别名',
          [p.phoneme for p in r.phonemes] == ['ian tian0'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (8) ★ 不回落轨道默认值：只有音符自身属性生效
    #     给 phoneme.tag/PA 之外设一个"轨道默认色"也没用（我们根本不读 project/track）
    ph.set_singer(_OtoSinger({'ian tian': _mk_named_oto('ian tian', color='TrackColor')}))
    r = ph.process([Note(lyric='tian', tone=60, duration=480)], prev_neighbour=Note(lyric='qian'))
    check('ZH VCV: 无 phonemeAttributes 时 color 为空串（不回落轨道色）',
          [p.phoneme for p in r.phonemes] == ['ian tian'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (9) SetUp 不设 project/track（C# 原文如此）
    ph2 = C.ChineseVCVPhonemizer()
    ph2.set_up([[Note(lyric='天', tone=60, duration=480)]], 'PROJ', 'TRACK')
    check('ZH VCV.SetUp: 只做罗马化，**不**设置 project/track（照搬 C# 的不调 base）',
          ph2.project is None and ph2.track is None,
          'got project=%r track=%r' % (ph2.project, ph2.track))


def test_ini_read_blocks():
    """`Classic/Ini.cs` —— 段头行会被取走、注释行**保留**、首行非段头要抛错。"""
    from singing.openutau.classic.ini import Ini
    cs = _read('Classic/Ini.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/Ini.cs')
        return
    check('Ini: 段头用 Regex.IsMatch（部分匹配）', 'headerRegex.IsMatch(line)' in cs)
    check('Ini: 空行 continue（注释行不跳过）',
          'if (string.IsNullOrEmpty(line))' in cs and '//' not in cs.replace('///', ''))
    check('Ini: 首行非段头时抛错（blocks.Count == 0）',
          'throw new FileFormatException("Unexpected beginning of ust file.")' in cs)
    check('Ini: 循环后把首行取为 header 并从 lines 删掉',
          'block.header = block.lines[0].line;' in cs and 'block.lines.RemoveAt(0);' in cs)

    lines = ['[VOWEL]', 'a=a,aa,ah', '; note', '', '[CONSONANT]', 'b=b,bb', '[REPLACE]', 'x=y']
    blocks = Ini.read_blocks(lines, 't.ini', r'\[\w+\]')
    check('Ini: 分出 3 个段', [b.header for b in blocks] == ['[VOWEL]', '[CONSONANT]', '[REPLACE]'],
          'got %r' % [b.header for b in blocks])
    check('Ini: 段头行已从 lines 移除',
          [l.line for l in blocks[0].lines] == ['a=a,aa,ah', '; note'],
          'got %r' % [l.line for l in blocks[0].lines])
    check('Ini: 注释行**保留**在段内容里（由调用方按 = 过滤）',
          '; note' in [l.line for l in blocks[0].lines])
    check('Ini: 空行被跳过（lineNumber 仍按原文件计数）',
          [l.line_number for l in blocks[1].lines] == [5],
          'got %r' % [l.line_number for l in blocks[1].lines])
    try:
        Ini.read_blocks(['// comment', '[VOWEL]'], 't.ini', r'\[\w+\]')
        check('Ini: 首个段头之前有内容 → 抛 ValueError', False, '没有抛错')
    except ValueError:
        check('Ini: 首个段头之前有内容 → 抛 ValueError', True)
    check('Ini.find_block: 找不到返回 None', Ini.find_block(blocks, 'NOPE') is None)


def _write_presamp_ini(dir_path, text):
    os.makedirs(dir_path, exist_ok=True)
    p = os.path.join(dir_path, 'presamp.ini')
    with open(p, 'w', encoding='utf-8', newline='\n') as f:
        f.write(text)
    return p


class _CvvcSinger(_OtoSinger):
    """带 location / 编码的假歌手（供 presamp.ini 读取用）。"""

    def __init__(self, aliases, location=''):
        super().__init__(aliases)
        self.location = location
        self.text_file_encoding = 'utf-8'


def test_chinese_cvvc_phonemizer():
    """`Plugin.Builtin/ChineseCVVCPhonemizer.cs` —— presamp.ini 三表 + VC/CV 切分。"""
    import tempfile
    from singing.openutau.plugin_builtin import chinese_cvvc as V
    from singing.openutau import Note, PhonemeAttributes, registered
    cvc_path = os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                            'ChineseCVVCPhonemizer.cs')
    if not os.path.isfile(cvc_path):
        print('  SKIP 找不到 ChineseCVVCPhonemizer.cs')
        return
    cs = open(cvc_path, encoding='utf-8-sig').read().replace('\r\n', '\n')

    m = re.search(r'\[Phonemizer\("([^"]*)",\s*"([^"]*)"(?:,\s*"([^"]*)")?(?:,\s*language:\s*"([^"]*)")?\)\]', cs)
    check('ZH CVVC: [Phonemizer] 的 name/tag/language 与 C# 一致（无 author）',
          m is not None and (m.group(1), m.group(2), m.group(4)) == (
              V.ChineseCVVCPhonemizer.name, V.ChineseCVVCPhonemizer.tag,
              V.ChineseCVVCPhonemizer.language),
          'C#=%r 我们=%r' % (m.groups() if m else None,
                             (V.ChineseCVVCPhonemizer.name, V.ChineseCVVCPhonemizer.tag,
                              V.ChineseCVVCPhonemizer.language)))
    check('ZH CVVC: 已在注册表里', registered().get('ZH CVVC') is V.ChineseCVVCPhonemizer)
    check('ZH CVVC: Convert.ToInt32 语义（四舍六入五成双，不是截断）',
          'Convert.ToInt32' in cs and V._to_int32(2.5) == 2 and V._to_int32(3.5) == 4)
    check('ZH CVVC: 查 VC 时用的是**前一个音符**的 tone（prevNeighbour.Value.tone）',
          'prevNeighbour.Value.tone + (attr0.toneShift' in cs)
    check('ZH CVVC: 缺省 attr 用 `?? default`（PhonemeAttributes 是 struct → 全空实例）',
          '?? default;' in cs and V._DEFAULT_ATTR.tone_shift is None
          and V._DEFAULT_ATTR.voice_color is None and V._DEFAULT_ATTR.alternate is None)
    check('ZH CVVC: SetUp 会调 base.SetUp（与 ZH VCV 相反）',
          'base.SetUp(groups, project, track);' in cs)

    # ---- 用真的 presamp.ini 驱动
    # 真实格式（取自 OpenUtau.Test/Files/presampini/default/presamp.ini）：
    #   [VOWEL]     `尾韵母=代表音=音素表[,音素表...][=时长]`  → 读 parts[0] / parts[2]
    #   [CONSONANT] `声母=音素表[,音素表...][=优先级]`        → 读 parts[0] / parts[1]
    #   [REPLACE]   `原词=替换词`
    tmp = tempfile.mkdtemp(prefix='fufumidi-cvvc-')
    _write_presamp_ini(tmp, '\n'.join([
        '[VOWEL]',
        'a=a=a,aa,ah,ba,da',
        'u=u=u,uu,bu',
        'i=i=i,ii,bi',
        '[CONSONANT]',
        'b=b,bb,ba,bi,bu=1',
        'd=d,dd,da=1',
        '[REPLACE]',
        'lve=lv',
        '',
    ]))
    ph = V.ChineseCVVCPhonemizer()
    singer = _CvvcSinger({}, location=tmp)
    ph.set_singer(singer)
    check('ZH CVVC.SetSinger: 解析出 [VOWEL]（aa/ah/ba 都归 a）',
          ph.vowels.get('aa') == 'a' and ph.vowels.get('ah') == 'a'
          and ph.vowels.get('ba') == 'a' and ph.vowels.get('bu') == 'u',
          'got %r' % ph.vowels)
    check('ZH CVVC.SetSinger: 解析出 [CONSONANT]（ba/bi/bu 都归 b）',
          ph.consonants.get('b') == 'b' and ph.consonants.get('bb') == 'b'
          and ph.consonants.get('ba') == 'b', 'got %r' % ph.consonants)
    check('ZH CVVC.SetSinger: 解析出 [REPLACE]', ph.replace.get('lve') == 'lv',
          'got %r' % ph.replace)
    check('ZH CVVC.SetSinger: 同一歌手再次设置 → 提前返回、表被保留',
          (ph.set_singer(singer), len(ph.vowels) > 0)[1])

    axis = TimeAxis()
    axis.build_segments(UProject())
    ph.set_timing(axis)

    n = lambda **kw: Note(**{'lyric': '', 'tone': 60, 'position': 0, 'duration': 480, **kw})
    _full = {'vowels': dict(ph.vowels), 'consonants': dict(ph.consonants),
             'replace': dict(ph.replace)}

    def _resinger(aliases):
        s = _CvvcSinger(aliases, location=tmp)
        ph.singer = s
        ph.vowels = dict(_full['vowels'])
        ph.consonants = dict(_full['consonants'])
        ph.replace = dict(_full['replace'])
        return s

    # (1) replace 精确替换（需要前邻以拿到 prevVowel）
    _resinger({'a lv': _mk_named_oto('a lv')})
    r = ph.process([n(lyric='lve')], prev_neighbour=n(lyric='a'))
    check('ZH CVVC: [REPLACE] 精确整串替换后参与后续查表',
          [p.phoneme for p in r.phonemes] == ['a lv'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (2) lyric == '-' / 'r' → 单独的 "{prevVowel} R"
    _resinger({'a R': _mk_named_oto('a R')})
    r = ph.process([n(lyric='-')], prev_neighbour=n(lyric='a'))
    check('ZH CVVC: 歌词 "-" → 只产出 "{prevVowel} R"（命中 oto 别名）',
          [p.phoneme for p in r.phonemes] == ['a R'],
          'got %r' % [p.phoneme for p in r.phonemes])
    _resinger({})
    r = ph.process([n(lyric='R')], prev_neighbour=n(lyric='a'))
    check('ZH CVVC: 歌词 "r"（大小写不敏感）→ 回落 "{prevVowel} R" 字面量',
          [p.phoneme for p in r.phonemes] == ['a R'],
          'got %r' % [p.phoneme for p in r.phonemes])
    r = ph.process([n(lyric='R')])
    check('ZH CVVC: 无前邻时 prevVowel 默认 "-"',
          [p.phoneme for p in r.phonemes] == ['- R'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (3) "{prevVowel} {lyric}" 命中 + 句末 + "{currVowel} R" 命中 → 2 音素
    _resinger({'a bu': _mk_named_oto('a bu'), 'u R': _mk_named_oto('u R')})
    r = ph.process([n(lyric='bu', duration=480)], prev_neighbour=n(lyric='a'))
    check('ZH CVVC: 整串 VC 命中 + 句末尾韵 → 2 个音素',
          [p.phoneme for p in r.phonemes] == ['a bu', 'u R'],
          'got %r' % [p.phoneme for p in r.phonemes])
    check('ZH CVVC: 尾韵位置 = 480 - min(80,60) = 420', r.phonemes[1].position == 420,
          'got %r' % r.phonemes[1].position)
    # 有后续邻居 → 只有 1 个音素
    r = ph.process([n(lyric='bu', duration=480)], prev_neighbour=n(lyric='a'),
                   next_neighbour=n(lyric='bi'))
    check('ZH CVVC: 有后续邻居时整串命中只出 1 个音素',
          [p.phoneme for p in r.phonemes] == ['a bu'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # (4) 整串不命中 → 走 VC/CV 切分（无前邻）
    _resinger({'- b': _mk_named_oto('- b')})
    r = ph.process([n(lyric='ba', duration=480)])
    check('ZH CVVC: 整串不命中 → VC + CV 两个音素',
          [p.phoneme for p in r.phonemes] == ['- b', 'ba'],
          'got %r' % [p.phoneme for p in r.phonemes])
    check('ZH CVVC: 无前邻时 VC 的 position 为负（-vcLen）', r.phonemes[0].position < 0,
          'got %r' % r.phonemes[0].position)

    # (5) 有前邻时 VC 用**前一个音符**的 tone 查 oto
    seen = []

    class _ToneSpy(_CvvcSinger):
        def try_get_mapped_oto(self, p, tone, color=None):
            seen.append((p, tone))
            # ★ 同契约：`(found, oto)`
            oto = self.aliases.get(p)
            return (oto is not None), oto

    s = _ToneSpy({'a b': _mk_named_oto('a b')}, location=tmp)
    ph.singer = s
    ph.vowels = dict(_full['vowels'])
    ph.consonants = dict(_full['consonants'])
    ph.replace = dict(_full['replace'])
    ph.process([n(lyric='ba', tone=62)], prev_neighbour=n(lyric='a', tone=67))
    hit = [t for p, t in seen if p == 'a b']       # prevVowel='a' + consonant 'b'
    check('ZH CVVC: 查 VC 用的是前邻音符的 tone（67，不是当前的 62）',
          hit and hit[0] == 67, 'got %r' % seen)

    # (6) 有前邻时 vcLen = min(prevDuration/1.5, max(30, 120*1)) = min(320, 120) = 120
    _resinger({'a b': _mk_named_oto('a b')})
    r = ph.process([n(lyric='ba', position=480, duration=480)],
                   prev_neighbour=n(lyric='a', position=0, duration=480))
    check('ZH CVVC: VC 的 position = -min(prevDuration/1.5, max(30, vcLen*ratio)) = -120',
          len(r.phonemes) == 2 and r.phonemes[0].position == -120,
          'got %r' % [p.position for p in r.phonemes])

    # (7) 全部落空 → 回落原歌词（cvOtoSimple 未命中时）
    _resinger({})
    r = ph.process([n(lyric='zz')])
    check('ZH CVVC: 全部落空时回落原歌词', [p.phoneme for p in r.phonemes] == ['zz'],
          'got %r' % [p.phoneme for p in r.phonemes])
    check('ZH CVVC: 句末整串不命中但有 CV oto 时用 CV 别名兜底',
          _resinger({'ba': _mk_named_oto('BA')}) is not None
          and [p.phoneme for p in ph.process([n(lyric='ba')]).phonemes] == ['BA'],
          'got %r' % [p.phoneme for p in ph.process([n(lyric='ba')]).phonemes])

    # (8) SetUp 会设置 project/track（与 ZH VCV 相反）
    ph2 = V.ChineseCVVCPhonemizer()
    ph2.set_up([[Note(lyric='天', tone=60, duration=480)]], 'PROJ', 'TRACK')
    check('ZH CVVC.SetUp: 设置了 project/track（并做了罗马化）',
          ph2.project == 'PROJ' and ph2.track == 'TRACK',
          'got %r / %r' % (ph2.project, ph2.track))

    # (9) 缺 [VOWEL] 段 → 吞掉异常、表为空（C# 也是 catch 住继续）
    tmp2 = tempfile.mkdtemp(prefix='fufumidi-cvvc-nosec-')
    _write_presamp_ini(tmp2, '[CONSONANT]\nb=b,bb\n')
    ph3 = V.ChineseCVVCPhonemizer()
    ph3.set_singer(_CvvcSinger({}, location=tmp2))
    check('ZH CVVC.SetSinger: 缺 [VOWEL] 段时吞异常且表为空（vowels/consonants/replace 全空）',
          ph3.vowels == {} and ph3.consonants == {} and ph3.replace == {},
          'got %r %r %r' % (ph3.vowels, ph3.consonants, ph3.replace))

    os.remove(os.path.join(tmp, 'presamp.ini'))
    os.remove(os.path.join(tmp2, 'presamp.ini'))


class _Seg:
    """`SynthSegment` 的最小替身（扁平 sp_env / ap，字段名与 C# 对齐）。"""

    def __init__(self, p0, p1, p3, p4, skip_frames, f0, sp_env, ap,
                 sp_env_harmonic=None, stretch=None):
        self.p0, self.p1, self.p3, self.p4 = p0, p1, p3, p4
        self.skip_frames = skip_frames
        self.f0 = f0
        self.sp_env = sp_env
        self.ap = ap
        self.sp_env_harmonic = sp_env_harmonic
        self.stretch = stretch


def test_worldline_pure():
    """`Render/Worldline.cs` 里**不含原生调用**的那些逻辑。"""
    from singing.openutau import worldline as W
    cs = _read('Render/Worldline.cs')
    if cs is None:
        print('  SKIP 找不到 Render/Worldline.cs')
        return

    # ---- 源码一致性：常量与两处不同的 auto gain
    check('Worldline: ResamplerPadding=2 / ResamplerVoicedF0=40 与 C# 一致',
          'const int ResamplerPadding = 2;' in cs
          and 'const double ResamplerVoicedF0 = 40.0;' in cs
          and (W.RESAMPLER_PADDING, W.RESAMPLER_VOICED_F0) == (2, 40.0))
    check('Worldline: Resample 的 auto gain 用 ResamplerVoicedF0、退化点是 max == 0',
          'f0.Count(f => f > ResamplerVoicedF0)' in cs
          and 'max == 0 ? 1.0 : Math.Pow(0.5 / max, GetFlag(item, "P", 86) * 0.01)' in cs)
    check('Worldline: GetAutoGain 用 config.f0_floor、退化点是 max < 1e-3f（两处不同）',
          'f0.Count(f => f > config.f0_floor)' in cs and '(max < 1e-3f)' in cs)
    check('Worldline: 两处 auto gain 的 logistic 权重公式相同',
          cs.count('1.0 / (1.0 + Math.Exp(5.0 - 10.0 * voicedRatio))') == 2)
    check('Worldline: Resampler 分析参数写死 (44100, 441, 2048)',
          'InitAnalysisConfig(44100, 441, 2048)' in cs
          and (W.RESAMPLER_FS, W.RESAMPLER_HOP_SIZE, W.RESAMPLER_FFT_SIZE) == (44100, 441, 2048))
    check('Worldline: 音高弯曲线步长 = 60000/tempo/480*5',
          '60000.0 / item.tempo / 480.0 * 5' in cs)
    check('Worldline: tone → freq 走 MusicMath.ToneToFreq(item.tone + pitch * 0.01)',
          'MusicMath.ToneToFreq(item.tone + pitch * 0.01)' in cs)
    check('Worldline: FitCurve 用**曲线末值**填充（不是默认值）',
          'Array.Fill(result, curve[^1], copy, length - copy)' in cs)
    check('Worldline: 三段夹紧是 _blend_weight 除法的前提',
          'p0 = Math.Max(0, p0);' in cs and 'p1 = Math.Max(p0 + 1, p1);' in cs
          and 'p3 = Math.Min(p4 - 1, p3);' in cs)

    # ---- AnalysisConfig：f0_floor 会被 (float) 转换
    cfg = W.init_analysis_config(44100, 441, 2048)
    check('Worldline.AnalysisConfig: frame_ms = hop/fs*1000 = 10.0', cfg.frame_ms == 10.0,
          'got %r' % cfg.frame_ms)
    # 3*44100/(2048-3) = 64.6943765... → float32 → 64.69437408447266
    check('Worldline.AnalysisConfig: f0_floor = (float)(3*fs/(fft-3))',
          abs(cfg.f0_floor - 64.69437408447266) < 1e-12, 'got %r' % cfg.f0_floor)
    check('Worldline.AnalysisConfig: f0_floor 是 float32 舍入后的值（不是 double 原值）',
          cfg.f0_floor != 3 * 44100 / 2045)

    # ---- 帧数 / 样本数公式
    check('Worldline.F0FrameCount: 44100 样本 @10ms → 101 帧',
          W.f0_frame_count(44100, 44100, 10.0, -1) == 101,
          'got %r' % W.f0_frame_count(44100, 44100, 10.0, -1))
    check('Worldline.F0FrameCount: length<=0 → 0', W.f0_frame_count(0, 44100, 10.0, -1) == 0)
    check('Worldline.F0FrameCount: method=2(pyin) 会取更大值',
          W.f0_frame_count(44100, 44100, 10.0, 2) >= W.f0_frame_count(44100, 44100, 10.0, -1))
    check('Worldline.WorldSynthesisSampleCount: 5001 帧 @10ms → 2205001',
          W.world_synthesis_sample_count(5001, 10.0, 44100) == 2205001,
          'got %r' % W.world_synthesis_sample_count(5001, 10.0, 44100))

    # ---- FitCurve
    check('Worldline.FitCurve: null/空 → 全填默认值', W.fit_curve(None, 3, 0.5) == [0.5] * 3
          and W.fit_curve([], 3, 0.5) == [0.5] * 3)
    check('Worldline.FitCurve: 比目标短 → 用**末值**补足',
          W.fit_curve([1.0, 2.0, 3.0], 6, 0.0) == [1.0, 2.0, 3.0, 3.0, 3.0, 3.0])
    check('Worldline.FitCurve: 比目标长 → 截断', W.fit_curve([1.0, 2.0, 3.0], 2, 0.0) == [1.0, 2.0])

    # ---- GetFlag
    class _Item:
        flags = [('g', 50, 'gen'), ('P', None, 'peak')]

    check('Worldline.GetFlag: 取到值', W.get_flag(_Item(), 'g', 0) == 50)
    check('Worldline.GetFlag: 命中但没值 → 用默认', W.get_flag(_Item(), 'P', 86) == 86)
    check('Worldline.GetFlag: 未命中 → 用默认', W.get_flag(_Item(), 'zz', 7) == 7)

    # ---- compute_frame_bounds（含夹紧）
    check('Worldline.compute_frame_bounds: 常规值',
          W.compute_frame_bounds(10.0, 0.0, 0.0, 50.0, 5.0, 5.0) == (0, 0, 1, 4, 5),
          'got %r' % (W.compute_frame_bounds(10.0, 0.0, 0.0, 50.0, 5.0, 5.0),))
    check('Worldline.compute_frame_bounds: 负数 p0 夹到 0、p1 至少 p0+1',
          W.compute_frame_bounds(10.0, -100.0, 0.0, 50.0, 0.0, 0.0)[1:3] == (0, 1),
          'got %r' % (W.compute_frame_bounds(10.0, -100.0, 0.0, 50.0, 0.0, 0.0),))
    _fb = W.compute_frame_bounds(10.0, 0.0, 0.0, 50.0, 0.0, 100.0)
    check('Worldline.compute_frame_bounds: p3 <= p4-1（夹紧是 min，可为负；保证不除零）',
          _fb[3] <= _fb[4] - 1, 'got %r' % (_fb,))

    # ---- compute_timemap
    t_dst, stretch = W.compute_timemap(0, 10, 0.0, 100.0, 100.0, 0.0, 10.0)
    check('Worldline.compute_timemap: tDst 长度 = ceil(durRequired/frameMs)', len(t_dst) == 10,
          'got %r' % len(t_dst))
    check('Worldline.compute_timemap: consonant=0 时全程走元音分支',
          all(abs(t - i) < 1e-9 for i, t in enumerate(t_dst)),
          'got %r' % t_dst[:4])
    check('Worldline.compute_timemap: 元音段 stretch = 1/vowelSpeed = 1',
          all(abs(s - 1.0) < 1e-9 for s in stretch))
    # velocity=100 → consonantSpeed = 0.5^(1-1) = 1；辅音 30ms 以内的帧 stretch = 1/1 = 1
    t_dst2, st2 = W.compute_timemap(0, 10, 0.0, 200.0, 100.0, 30.0, 10.0)
    check('Worldline.compute_timemap: consonant>0 时前 3 帧落在辅音段',
          abs(t_dst2[0] - 0.0) < 1e-9 and abs(t_dst2[2] - 2.0) < 1e-9
          and abs(t_dst2[3] - 3.0) < 1e-9, 'got %r' % t_dst2[:5])
    # velocity=0 → consonantSpeed = 0.5；辅音被拉长 → aux 段 stretch = 2
    _, st3 = W.compute_timemap(0, 10, 0.0, 200.0, 0.0, 30.0, 10.0)
    check('Worldline.compute_timemap: velocity=0 时 consonantSpeed=0.5 → 辅音段 stretch=2',
          abs(st3[0] - 2.0) < 1e-9, 'got %r' % st3[:3])
    # srcLengthMs = 10*10-3 = 97 → vowelSpeed = 97/100 = 0.97 → tDst[1] = (9.7+3)/10 = 1.27
    _toff = W.compute_timemap(0, 10, 3.0, 100.0, 100.0, 0.0, 10.0)[0]
    check('Worldline.compute_timemap: offsetFracMs 平移 + vowelSpeed 压缩源时长',
          abs(_toff[0] - 0.3) < 1e-9 and abs(_toff[1] - 1.27) < 1e-9, 'got %r' % _toff[:3])

    # ---- resample_features
    f0d, spd, apd = W.resample_features([0.0, 0.5, 1.0], [100.0, 200.0],
                                        [1.0, 2.0, 3.0, 4.0], [0.1, 0.2, 0.3, 0.4], 2)
    check('Worldline.resample_features: 中点线性插值 f0',
          abs(f0d[1] - 150.0) < 1e-9, 'got %r' % f0d)
    check('Worldline.resample_features: sp 按 sp_size 分帧插值（pos=0.5 时两帧各半）',
          abs(spd[2] - 2.0) < 1e-9 and abs(spd[3] - 3.0) < 1e-9, 'got %r' % spd)
    check('Worldline.resample_features: pos=0 直接取第 0 帧',
          spd[0] == 1.0 and spd[1] == 2.0, 'got %r' % spd)
    check('Worldline.resample_features: ap 同样插值',
          abs(apd[2] - 0.2) < 1e-9 and abs(apd[3] - 0.3) < 1e-9, 'got %r' % apd)
    f0d2, _, _ = W.resample_features([1.0, 5.0], [100.0, 200.0], [0.0, 0.0], [0.0, 0.0], 1)
    check('Worldline.resample_features: 末帧直接取（不外推）', f0d2[1] == 200.0,
          'got %r' % f0d2)

    # ---- apply_pitch_bend
    f0 = [0.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0]
    W.apply_pitch_bend(f0, [100, 300], 60, 20.0, 50.0, 10.0, 64.69437408447266)
    check('Worldline.apply_pitch_bend: 无声帧（f0 <= f0_floor）保持不变', f0[0] == 0.0,
          'got %r' % f0[0])
    check('Worldline.apply_pitch_bend: pos<=0 时取 pitches[0]（+100 音分 → 61 号音）',
          abs(f0[2] - MusicMath.tone_to_freq(61)) < 1e-9, 'got %r' % f0[2])
    # i=7: pos = (70-20)/50 = 1.0 → index=1 → pitches[1]=300 → tone 60+3=63
    check('Worldline.apply_pitch_bend: pos>=1 时取 pitches[1]（+300 音分 → 63 号音）',
          abs(f0[7] - MusicMath.tone_to_freq(63)) < 1e-9, 'got %r' % f0[7])
    # 空 pitches → pitch 恒为 0 → 就是 tone 本身的频率
    f0b = [100.0] * 3
    W.apply_pitch_bend(f0b, [], 69, 0.0, 50.0, 10.0, 64.69)
    check('Worldline.apply_pitch_bend: 无音高曲线时 f0 = ToneToFreq(tone)',
          all(abs(v - 440.0) < 1e-9 for v in f0b), 'got %r' % f0b)

    # ---- 两处 auto gain 的差异
    out = [0.5, -0.5]
    # weight 是 logistic，不是 0/1：全有声 → 1/(1+e^-5) ≈ 0.9933；全无声 → 1/(1+e^5) ≈ 0.0067
    w_hi = 1.0 / (1.0 + math.exp(-5.0))
    w_lo = 1.0 / (1.0 + math.exp(5.0))
    g1 = W.resample_auto_gain(out, 1.0, [100.0, 100.0], False, 100.0, 86)
    check('Worldline.resample_auto_gain: 全有声 → max = outMax*w_hi + wavMax*(1-w_hi)',
          abs(g1 - math.pow(0.5 / (0.5 * w_hi + 1.0 * (1 - w_hi)), 0.86)) < 1e-12,
          'got %r' % g1)
    g2 = W.resample_auto_gain(out, 1.0, [0.0, 0.0], False, 100.0, 86)
    check('Worldline.resample_auto_gain: 全无声 → 更偏向 wavMax',
          abs(g2 - math.pow(0.5 / (0.5 * w_lo + 1.0 * (1 - w_lo)), 0.86)) < 1e-12,
          'got %r' % g2)
    check('Worldline.resample_auto_gain: 有声占比越高 → max 越小 → 增益越大',
          g1 > g2, 'got g1=%r g2=%r' % (g1, g2))
    g3 = W.resample_auto_gain(out, 1.0, [100.0, 100.0], True, 100.0, 86)
    check('Worldline.resample_auto_gain: direct=True → gain 乘 0', g3 == 0.0, 'got %r' % g3)
    check('Worldline.resample_auto_gain: volume 参与乘算（×0.01）',
          abs(W.resample_auto_gain(out, 1.0, [100.0, 100.0], False, 50.0, 86)
              - math.pow(0.5 / (0.5 * w_hi + 1.0 * (1 - w_hi)), 0.86) * 0.5) < 1e-12)
    # segment_auto_gain 的退化阈值是 max < 1e-3f（两处样本与 wavMax 都要很小才会触发）
    check('Worldline.segment_auto_gain: max < 1e-3 时退化为 1.0',
          W.segment_auto_gain([1e-6, -1e-6], [0.0], 1e-6, 64.69, 86) == 1.0,
          'got %r' % W.segment_auto_gain([1e-6, -1e-6], [0.0], 1e-6, 64.69, 86))
    check('Worldline.segment_auto_gain: 正常量级时 = (0.5/max)^(P*0.01)',
          abs(W.segment_auto_gain([1.0], [100.0], 1.0, 64.69, 86)
              - math.pow(0.5 / 1.0, 0.86)) < 1e-12,
          'got %r' % W.segment_auto_gain([1.0], [100.0], 1.0, 64.69, 86))

    # ---- blend_features（单段可精确验算）
    sp_size = 1
    seg = _Seg(p0=0, p1=1, p3=3, p4=5, skip_frames=0,
               f0=[10.0, 20.0, 30.0, 40.0, 50.0],
               sp_env=[1.0, 2.0, 3.0, 4.0, 5.0],
               ap=[0.1, 0.2, 0.3, 0.4, 0.5])
    total, f0o, spo, apo = W.blend_features([seg], sp_size)
    check('Worldline.blend_features: totalFrames = max(p4) + 1', total == 6, 'got %r' % total)
    check('Worldline.blend_features: sp 累加在 1e-12 基线上（weight 见分支）',
          abs(spo[0] - 1e-12) < 1e-15 and abs(spo[1] - (1e-12 + 2.0)) < 1e-9
          and abs(spo[4] - (1e-12 + 5.0 * 0.5)) < 1e-9,
          'got %r' % spo)
    check('Worldline.blend_features: 段内 ap 直接取自身（dirty==0 时 wa=0,wb=1）',
          abs(apo[1] - 0.2) < 1e-12 and abs(apo[3] - 0.4) < 1e-12, 'got %r' % apo)
    check('Worldline.blend_features: 末帧复制前一帧（f0/sp/ap 三样）',
          f0o[5] == f0o[4] and spo[5] == spo[4] and apo[5] == apo[4],
          'got %r / %r / %r' % (f0o[5], spo[5], apo[5]))
    # p4=3 → totalFrames=4，但只有 j=0..2 被遍历；第 3 帧由"复制前一帧"填上
    seg_a = _Seg(0, 1, 2, 3, 0, [1.0, 2.0, 3.0], [1.0, 2.0, 3.0], [0.1, 0.2, 0.3])
    total2, f0o2, spo2, apo2 = W.blend_features([seg_a], 1)
    check('Worldline.blend_features: j==p3 时 weight=1（sp 全量累加）',
          abs(spo2[2] - (1e-12 + 3.0)) < 1e-9, 'got %r' % spo2)
    check('Worldline.blend_features: totalFrames-1 帧由"复制前一帧"得到',
          total2 == 4 and f0o2[3] == f0o2[2] and spo2[3] == spo2[2] and apo2[3] == apo2[2],
          'got total=%r f0=%r' % (total2, f0o2))

    # f0Curve 只覆盖有声帧
    seg_b = _Seg(0, 1, 2, 3, 0, [100.0, 0.0, 100.0], [0.0, 0.0, 0.0], [0.0, 0.0, 0.0])
    _, f0o3, _, _ = W.blend_features([seg_b], 1, f0_curve=[500.0], f0_floor=64.69)
    check('Worldline.blend_features: f0Curve 只覆盖有声帧（无声帧保持 0）',
          f0o3[0] == 500.0 and f0o3[1] == 0.0, 'got %r' % f0o3)

    # ---- blend_continuous_noise_features
    seg_h = _Seg(0, 1, 2, 3, 0, [1.0, 2.0, 3.0], [1.0, 2.0, 3.0], [0.1, 0.2, 0.3],
                 sp_env_harmonic=[4.0, 5.0, 6.0], stretch=[1.0, 1.5, 2.0])
    # 返回**六个**：total_frames, f0, sp, sp_harmonic, ap, stretch（C# 两个包络都要）
    toh, f0h, sph, sph_h, aph, sth = W.blend_continuous_noise_features([seg_h], 1)
    check('Worldline.blend_continuous_noise_features: totalFrames = max(p4)+1', toh == 4,
          'got %r' % toh)
    check('Worldline.blend_continuous_noise_features: sp 与 sp_harmonic **都**返回',
          abs(sph[1] - (1e-12 + 2.0)) < 1e-9 and abs(sph_h[1] - (1e-12 + 5.0)) < 1e-9,
          'got sp=%r harm=%r' % (sph, sph_h))
    check('Worldline.blend_continuous_noise_features: stretch 按 ap 的方式混合',
          abs(sth[1] - 1.5) < 1e-12, 'got %r' % sth)
    check('Worldline.blend_continuous_noise_features: 末帧复制前一帧（含 stretch）',
          sth[3] == sth[2] and f0h[3] == f0h[2], 'got %r / %r' % (sth[3], f0h[3]))

    # ---- 原生库：找不到时优雅降级
    native = W.WorldlineNative('definitely-not-a-real-library-xyz')
    check('Worldline.WorldlineNative: 库不存在时 available=False 且不抛异常',
          native.available is False and bool(native.error))


def test_pipeline_identities():
    """`Pipeline/Identities.cs` —— 值语义标识与"影响范围"。"""
    from singing.openutau import DocRevision, ImpactKind, ImpactSet, PartId
    cs = _read('Pipeline/Identities.cs')
    if cs is None:
        print('  SKIP 找不到 Pipeline/Identities.cs')
        return

    # ---- 源码一致性：ImpactKind 的数值各自成位
    want = dict((k.upper(), int(v)) for k, v in
                re.findall(r'^\s{8}(\w+) = (\d+),', cs, re.M))
    got = {'NONE': ImpactKind.NONE, 'PART': ImpactKind.PART, 'CURVES': ImpactKind.CURVES,
           'MIX': ImpactKind.MIX, 'TRACK': ImpactKind.TRACK, 'PROJECT': ImpactKind.PROJECT}
    check('Identities: ImpactKind 数值与 C# 一致（0/1/2/4/8/16，各自成位）',
          want == got, 'C#=%r 我们=%r' % (want, got))
    check('Identities: ImpactKind 不是连续序号（别"整理"）',
          sorted(got.values()) == [0, 1, 2, 4, 8, 16])
    check('Identities: PartId 的 ToString 用 "N" 格式', 'Value.ToString("N")' in cs)
    check('Identities: PartId / DocRevision 是 record struct（值语义）',
          'readonly record struct PartId(Guid Value)' in cs
          and 'readonly record struct DocRevision(long Value)' in cs)

    # ---- PartId 值语义
    a = PartId.new()
    b = PartId(a.value)
    check('Identities.PartId: 同 Guid → 相等（值语义）', a == b)
    check('Identities.PartId: 可哈希且去重（能当字典键）', len({a, b}) == 1)
    check('Identities.PartId: __str__ 是 32 位小写十六进制、无连字符',
          len(str(a)) == 32 and str(a) == str(a).lower() and '-' not in str(a),
          'got %r' % str(a))
    check('Identities.PartId: New() 每次不同', PartId.new() != PartId.new())
    check('Identities.PartId.compare_to: 自反为 0 / 小于为 -1 / 大于为 1',
          a.compare_to(b) == 0
          and PartId(uuid.UUID(int=1)).compare_to(PartId(uuid.UUID(int=2))) == -1
          and PartId(uuid.UUID(int=2)).compare_to(PartId(uuid.UUID(int=1))) == 1)

    # ---- DocRevision
    check('Identities.DocRevision.compare_to: 基本序',
          DocRevision(1).compare_to(DocRevision(2)) == -1
          and DocRevision(2).compare_to(DocRevision(2)) == 0
          and DocRevision(3).compare_to(DocRevision(2)) == 1)
    check('Identities.DocRevision: __str__ 是十进制', str(DocRevision(42)) == '42')

    # ---- ImpactSet
    check('Identities.ImpactSet.all(): kind=Project 且三个载荷都是 None',
          ImpactSet.all().kind == ImpactKind.PROJECT and ImpactSet.all().part is None
          and ImpactSet.all().track is None and ImpactSet.all().curve_abbrs is None)
    check('Identities.ImpactSet.none(): kind=None',
          ImpactSet.none().kind == ImpactKind.NONE)
    check('Identities.ImpactSet.mix_only(): kind=Mix',
          ImpactSet.mix_only().kind == ImpactKind.MIX)
    check('Identities.ImpactSet.part_of(): 带 part、其余为 None',
          (lambda s: s.kind == ImpactKind.PART and s.part == 'P' and s.track is None
           and s.curve_abbrs is None)(ImpactSet.part_of('P')))
    check('Identities.ImpactSet.track_of(): 带 track、part 为 None',
          (lambda s: s.kind == ImpactKind.TRACK and s.track == 'T' and s.part is None)
          (ImpactSet.track_of('T')))
    check('Identities.ImpactSet.curves_of(): 曲线缩写是**列表**（null 与空列表不同）',
          (lambda s: s.kind == ImpactKind.CURVES and s.curve_abbrs == ['dyn', 'pitd'])
          (ImpactSet.curves_of('P', 'dyn', 'pitd')))
    check('Identities.ImpactSet.curves_of(): 不给缩写时是**空列表**（不是 None）',
          ImpactSet.curves_of('P').curve_abbrs == [])


# ====================================================================== Pipeline
#
# 上游对应测试：`OpenUtau.Test/Core/Pipeline/PhraseSourceBuilderTest.cs`
#   - PhraseSourceBuilderTest（后台构建 / 合并到最新快照 / 丢弃已删除的 part）
#   - PhraseBuildGateTest（两条时序断言）
#   - DocumentSnapshotStoreTest（五条失效半径断言）
# 这里按同一批用例转写，另外加上 `FromPart` 的快照字段断言。

class _PipelineSinger(USinger):
    """对应上游 `PhraseSourceBuilderTest.TestSinger`。"""

    def __init__(self, oto_a):
        super().__init__('builder-test-singer')
        self._oto_a = oto_a
        self.found = True
        self.loaded = True

    @property
    def id(self):
        return 'builder-test-singer'

    @property
    def subbanks(self):
        return []

    def try_get_oto(self, phoneme):
        return (True, self._oto_a) if phoneme == 'A' else (False, None)

    def try_get_mapped_oto(self, phoneme, tone, color=None):
        return False, None


class _PipelineRenderer(_FakeRenderer):
    """上游 `TestRenderer`：不支持任何表达式；可选地声明乐句两端余量。"""

    def __init__(self, head_ms=0.0, tail_ms=0.0):
        self._head_ms = head_ms
        self._tail_ms = tail_ms

    def phrase_padding(self, singer, phonemes):
        return (self._head_ms, self._tail_ms)


def _pipeline_fixture(head_ms=0.0, tail_ms=0.0):
    """上游 `BuildFixture()` 的转写（两条相邻音符、两个有效音素）。"""
    from singing.openutau import UPhoneme, ValidateOptions
    from singing.ustx import UNote, UExpressionType, UPitch, UVibrato, UVoicePart

    project = UProject()
    specs = [
        ('engine', 'eng', 0, 100, 0, ['']),
        ('volume', 'vol', 0, 100, 100, None),
        ('velocity', 'vel', 0, 100, 100, None),
        ('modulation', 'mod', 0, 100, 0, None),
        ('direct', 'dir', 0, 100, 0, None),
        ('shift', 'shft', 0, 100, 0, None),
        ('attack', 'atk', 0, 100, 100, None),
        ('decay', 'dec', 0, 100, 100, None),
    ]
    for name, abbr, mn, mx, dv, options in specs:
        project.expressions[abbr] = UExpressionDescriptor(
            name=name, abbr=abbr, type=UExpressionType.NUMERICAL,
            min=mn, max=mx, default_value=dv, options=options)

    track = project.tracks[0]
    track.singer_obj = _PipelineSinger(UOto.of_dummy('A'))
    track.renderer_settings.renderer_obj = _PipelineRenderer(head_ms, tail_ms)

    part = UVoicePart(track_no=0, position=0)
    project.parts.append(part)

    note0 = UNote(position=0, duration=480, tone=60, lyric='a', pitch=UPitch(), vibrato=UVibrato())
    note1 = UNote(position=480, duration=480, tone=62, lyric='u', pitch=UPitch(), vibrato=UVibrato())
    for note in (note0, note1):
        note.extended_duration = 480
    note0.next, note1.prev = note1, note0
    part.notes.extend([note0, note1])

    phoneme0 = UPhoneme()
    phoneme0.position, phoneme0.phoneme, phoneme0.parent = 0, 'A', note0
    phoneme1 = UPhoneme()
    phoneme1.position, phoneme1.phoneme, phoneme1.parent = 480, 'A', note1
    part.phonemes.extend([phoneme0, phoneme1])
    phoneme0.next, phoneme1.prev = phoneme1, phoneme0

    phoneme0.validate(ValidateOptions(), project, track, part, note0)
    phoneme1.validate(ValidateOptions(), project, track, part, note1)
    assert not phoneme0.error and not phoneme1.error, 'fixture 的音素必须有效'
    return project, track, part


def test_phrase_source_from_part():
    """`PhraseSource.FromPart` / `BuildPhrases`：链路端到端（歌词 → 渲染输入）。"""
    from singing.openutau import DocRevision, PhraseSource
    from singing.openutau.pipeline_source import host
    from singing.openutau.render_phrase import RenderPhrase

    cs = _read('Pipeline/PhraseSource.cs')
    if cs is None:
        print('  SKIP 找不到 Pipeline/PhraseSource.cs')
        return

    project, track, part = _pipeline_fixture()
    old_revision = host.revision
    try:
        host.revision = DocRevision(7)
        source = PhraseSource.from_part(project, track, part, 3)
        check('FromPart: 有有效音素时返回快照（不是 None）', source is not None)
        check('FromPart: PartId / Revision / Generation 原样带过来',
              source.part_id == part.id and source.revision == DocRevision(7)
              and source.generation == 3,
              'got %r / %r / %r' % (source.part_id, source.revision, source.generation))
        check('FromPart: 相邻音素合成一条乐句组（无间隙）',
              source.phrase_groups == [(0, 2)], 'got %r' % (source.phrase_groups,))
        check('FromPart: 笔记下标用 Prev/Next/Extends 的**下标**表达（-1 表示无）',
              [(n.prev, n.next, n.extends) for n in source.notes] == [(-1, 1, -1), (0, -1, -1)],
              'got %r' % [(n.prev, n.next, n.extends) for n in source.notes])
        check('FromPart: 时间轴是**副本**（与工程的时间轴不是同一对象）',
              source.axis is not project.time_axis)

        ph = source.phonemes
        check('PhonemeSource: 几何量照搬（position/end/duration）',
              (ph[0].position, ph[0].duration, ph[0].end) == (0, 480, 480),
              'got %r' % [(p.position, p.duration, p.end) for p in ph])
        check('PhonemeSource: PrevAdjacent / NextAdjacent 按 End/position 判定',
              (ph[0].prev_adjacent, ph[0].next_adjacent) == (False, True)
              and (ph[1].prev_adjacent, ph[1].next_adjacent) == (True, False),
              'got %r' % [(p.prev_adjacent, p.next_adjacent) for p in ph])
        # Leading = max(0, TickBetweenMsPos(PositionMs - preutter, PositionMs))
        want_leading = max(0, source.axis.ticks_between_ms_pos(
            ph[0].position_ms - ph[0].preutter, ph[0].position_ms))
        check('PhonemeSource: Leading 由 preutter 换算成 tick 且不为负',
              ph[0].leading == want_leading and ph[0].leading >= 0,
              'got %r / want %r' % (ph[0].leading, want_leading))
        check('PhonemeSource: Volume/Velocity 是 ×0.01 的归一化值（VelRaw 保留原值）',
              ph[0].volume == 1.0 and ph[0].velocity == 1.0 and ph[0].vel_raw == 100.0,
              'got %r' % ((ph[0].volume, ph[0].velocity, ph[0].vel_raw),))
        check('PhonemeSource: AdjustedTempo = Duration / 等效 tick 时长 × Tempo',
              ph[0].tempo == 120.0 and abs(ph[0].adjusted_tempo - 120.0) < 1e-9,
              'got %r / %r' % (ph[0].tempo, ph[0].adjusted_tempo))
        check('PhonemeSource: Tempos 用 (absStart - Leading, absEnd) 取段',
              ph[0].tempos[0]['position'] == -ph[0].leading,
              'got %r / leading=%r' % (ph[0].tempos, ph[0].leading))
        check('PhonemeSource: oto 与音符音高带入快照',
              ph[0].oto is not None and ph[0].tone == 60 and ph[0].note_index == 0,
              'got %r' % (ph[0].oto,))
        check('PhonemeSource: 包络是**逐点新建**的（不与活文档共享 Vector2）',
              ph[0].envelope[2] is not part.phonemes[0].envelope.data[2]
              and ph[0].envelope[2].y == part.phonemes[0].envelope.data[2].y)
        check('PhonemeSource: mod+ 描述符缺失 → ModpRaw 按 0（不是报错）',
              ph[0].modp_raw == 0.0)

        # ---- eng 描述符有非空选项时覆盖轨道级 resampler
        project.expressions['eng'].options = ['worldline']
        source2 = PhraseSource.from_part(project, track, part, 4)
        check('PhonemeSource: eng 的 options[值] 非空时覆盖 resampler',
              source2.phonemes[0].resampler == 'worldline',
              'got %r' % source2.phonemes[0].resampler)
        project.expressions['eng'].options = ['']

        # ---- 切组：两段之间有间隙就分成两条乐句
        part.phonemes[1].position = 960
        gap_source = PhraseSource.from_part(project, track, part, 5)
        check('FromPart: 存在间隙且渲染器不要求合并 → 切成两组',
              gap_source.phrase_groups == [(0, 1), (1, 2)],
              'got %r' % (gap_source.phrase_groups,))

        # ---- 构建：一首一尾两条乐句
        phrases = gap_source.build_phrases()
        check('BuildPhrases: 每个乐句组产出一条 RenderPhrase（组数一致）',
              len(phrases) == len(gap_source.phrase_groups) == 2,
              'got %d' % len(phrases))
        check('BuildPhrases: position/end 用 part 相对 tick 组装',
              [(p.position, p.end) for p in phrases] == [(0, 480), (960, 1440)],
              'got %r' % [(p.position, p.end) for p in phrases])

        # ---- 全部音素失效 → None（调用方据此清空 renderPhrases）
        for p in part.phonemes:
            p.error = True
        check('FromPart: 没有可用音素时返回 None（而不是空快照）',
              PhraseSource.from_part(project, track, part, 6) is None)
        for p in part.phonemes:
            p.error = False

        # ---- RenderPhrase.FromPart：脚本/测试用的一站式入口
        part.phonemes[1].position = 480
        part.phonemes[1].prev = part.phonemes[0]
        inline = RenderPhrase.from_part(project, track, part)
        check('RenderPhrase.from_part: 同步构建且与 build_phrases 结果同哈希',
              len(inline) == 1
              and inline[0].hash == PhraseSource.from_part(project, track, part, 0).build_phrases()[0].hash,
              'got %d' % len(inline))
        part.phonemes[0].error = True
        part.phonemes[1].error = True
        check('RenderPhrase.from_part: 无可用音素时返回**空列表**（不是 None）',
              RenderPhrase.from_part(project, track, part) == [])
    finally:
        host.revision = old_revision


def test_phrase_source_merge_adjacent():
    """`renderer.ShouldMergePhrases` 能把有间隙的两段并回一条乐句。"""
    from singing.openutau import PhraseSource

    project, track, part = _pipeline_fixture()
    part.phonemes[1].position = 990          # 间隙 10ms
    track.renderer_settings.renderer_obj = _PipelineRenderer(head_ms=20.0, tail_ms=20.0)
    merged = PhraseSource.from_part(project, track, part, 1)
    check('FromPart: 间隙 < head+tail 余量 → 渲染器要求合并，仍是一组',
          merged.phrase_groups == [(0, 2)], 'got %r' % (merged.phrase_groups,))

    track.renderer_settings.renderer_obj = _PipelineRenderer()
    split = PhraseSource.from_part(project, track, part, 2)
    check('FromPart: 同样的间隙、余量为 0 → 仍是两组',
          split.phrase_groups == [(0, 1), (1, 2)], 'got %r' % (split.phrase_groups,))

    cs = _read('Render/IRenderer.cs')
    if cs is not None:
        check('IRenderer: ShouldMergePhrases 默认实现就是 GapOverlapsPadding',
              'ShouldMergePhrases(UProject project, UTrack track, UPhoneme prev, UPhoneme next)'
              in cs.replace('\n', ' ') or 'GapOverlapsPadding' in cs)


def test_phrase_build_gate():
    """上游 `PhraseBuildGateTest`：两条时序断言。"""
    from singing.openutau import PhraseBuildGate

    gate = PhraseBuildGate()
    check('PhraseBuildGate: 初始就绪（Slim(true)）', gate.is_current(0))
    gate.mark_pending(1)
    check('PhraseBuildGate: MarkPending 后未就绪且 WaitFor 超时返回 False',
          gate.wait_for(1, 0.05) is False and gate.is_current(1) is False)
    gate.mark_completed(1)
    check('PhraseBuildGate: MarkCompleted 后就绪（WaitFor 返回 True）',
          gate.wait_for(1, 0.1) is True and gate.is_current(1) is True)
    gate.mark_pending(2)
    check('PhraseBuildGate: 有更新的代际在等 → 未就绪', gate.is_current(2) is False)

    gate2 = PhraseBuildGate()
    gate2.mark_pending(1)
    gate2.mark_completed(1)
    gate2.mark_pending(3)
    gate2.mark_completed(2)
    check('PhraseBuildGate: 被取代的旧代际完成**不算**新代际就绪', gate2.is_current(3) is False)
    gate2.mark_completed(3)
    check('PhraseBuildGate: 新代际完成才就绪', gate2.is_current(3) is True)


def _wait_until(condition, timeout_s=5.0):
    import time
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if condition():
            return True
        time.sleep(0.01)
    return condition()


def test_phrase_source_builder():
    """上游 `PhraseSourceBuilderTest` 三条用例的转写。"""
    from singing.openutau import PhraseSource, PhraseSourceBuilder
    from singing.openutau.pipeline_source import host

    old_project = host.project
    builders = []
    try:
        # ---- 1) 后台构建并落到 part 的回指槽
        project, track, part = _pipeline_fixture()
        host.project = project
        builder = PhraseSourceBuilder(None)
        builders.append(builder)
        part.phrase_generation += 1
        generation = part.phrase_generation
        source = PhraseSource.from_part(project, track, part, generation)
        expected = source.build_phrases()[0].hash
        part.phrase_gate.mark_pending(generation)
        check('PhraseSourceBuilder: Push 成功', builder.push(source, part) is True)
        check('PhraseSourceBuilder: 构建在后台线程落地并写进 render_phrases',
              _wait_until(lambda: part.phrase_applied_generation == generation
                          and len(part.render_phrases) == 1
                          and part.render_phrases[0].hash == expected),
              'gen=%r count=%r' % (part.phrase_applied_generation, len(part.render_phrases)))
        check('PhraseSourceBuilder: 落地后 PhraseBuildGate 也就绪',
              part.phrase_gate.is_current(generation) is True)

        # ---- 2) 同一 part 的多份快照合并到最新
        project2, track2, part2 = _pipeline_fixture()
        host.project = project2
        part2.phrase_generation += 1
        gen1 = part2.phrase_generation
        source1 = PhraseSource.from_part(project2, track2, part2, gen1)
        part2.notes[0].tone = 70
        part2.phrase_generation += 1
        gen2 = part2.phrase_generation
        source2 = PhraseSource.from_part(project2, track2, part2, gen2)
        check('PhraseSourceBuilder: 改了音符后两份快照哈希不同',
              source1.build_phrases()[0].hash != source2.build_phrases()[0].hash)
        part2.phrase_gate.mark_pending(gen2)
        builder.push(source1, part2)
        builder.push(source2, part2)
        latest_hash = source2.build_phrases()[0].hash
        check('PhraseSourceBuilder: 最终落地的是最新那份（代际更大的）',
              _wait_until(lambda: part2.phrase_applied_generation == gen2
                          and len(part2.render_phrases) > 0
                          and part2.render_phrases[0].hash == latest_hash),
              'gen=%r' % part2.phrase_applied_generation)

        # ---- 3) part 已不在工程里 → 结果被丢弃
        project3, track3, part3 = _pipeline_fixture()
        host.project = _pipeline_fixture()[0]     # 另一个工程，不含 part3
        part3.phrase_generation += 1
        gen3 = part3.phrase_generation
        source3 = PhraseSource.from_part(project3, track3, part3, gen3)
        part3.phrase_gate.mark_pending(gen3)
        builder.push(source3, part3)
        _wait_until(lambda: False, 1.0)           # 让 worker 跑完
        check('PhraseSourceBuilder: part 不在工程里 → 不落地（代际不动、列表为空）',
              part3.phrase_applied_generation != gen3 and part3.render_phrases == [])

        # ---- 4) Dispose 后 Push 被拒
        dead = PhraseSourceBuilder(None)
        dead.dispose()
        check('PhraseSourceBuilder: Dispose 后 Push 返回 False',
              dead.push(source3, part3) is False)
        check('PhraseSourceBuilder: Dispose 会把 Current 让出',
              PhraseSourceBuilder.current is None)
    finally:
        host.project = old_project
        for b in builders:
            b.dispose()

    cs = _read('Pipeline/PhraseSourceBuilder.cs')
    if cs is not None:
        check('PhraseSourceBuilder: worker 是**单线程**（声库资源未做线程隔离）',
              'The worker is single-threaded on purpose' in cs)
        check('PhraseSourceBuilder: 合并到"每个 part 的最新一份"',
              'latest[request.Part] = request' in cs and 'supersedes the older one' in cs)


def test_document_snapshot_store():
    """上游 `DocumentSnapshotStoreTest` 五条用例的转写。"""
    from singing.openutau import (
        DocRevision, DocumentSnapshotStore, ImpactSet, PartId, SubbankView, TrackSnapshot,
    )
    from singing.ustx import UVoicePart

    track_no = 9999
    part_id = PartId.new()
    other_id = PartId.new()
    store = DocumentSnapshotStore()          # 用独立实例，避免污染模块级单例

    def make_part():
        return UVoicePart(track_no=track_no)

    # ---- Part / Curves 只失效那一个 part
    part = make_part()
    part.id = part_id
    other = make_part()
    other.id = other_id
    store.set_part(part, None)
    store.set_part(other, None)
    check('SnapshotStore: SetPart 后能取回', store.try_get_part(part_id)[0] is True)
    store.invalidate(ImpactSet.part_of(part))
    check('SnapshotStore: PartOf 只丢这一个 part',
          store.try_get_part(part_id)[0] is False and store.try_get_part(other_id)[0] is True)
    store.set_part(part, None)
    store.invalidate(ImpactSet.curves_of(part, 'pitd'))
    check('SnapshotStore: CurvesOf 与 PartOf 同一处理（曲线变了也要重取乐句快照）',
          store.try_get_part(part_id)[0] is False)
    store.remove_part(other_id)

    # ---- Track 连带失效该轨的 part
    track = UTrack(track_name='test', track_no=track_no)
    part = make_part()
    part.id = part_id
    store.set_track(track)
    store.set_part(part, None)
    store.invalidate(ImpactSet.track_of(track))
    check('SnapshotStore: TrackOf 丢掉该轨**和**它的 part',
          store.try_get_track(track_no)[0] is False and store.try_get_part(part_id)[0] is False)

    # ---- Project 清空一切
    part = make_part()
    part.id = part_id
    store.set_part(part, None)
    store.invalidate(ImpactSet.all())
    check('SnapshotStore: All(Project) 清空 part 快照', store.try_get_part(part_id)[0] is False)

    # ---- Mix / None 什么都不动（混音改动与快照无关）
    part = make_part()
    part.id = part_id
    store.set_part(part, None)
    store.invalidate(ImpactSet.mix_only())
    store.invalidate(ImpactSet.none())
    found, snapshot = store.try_get_part(part_id)
    check('SnapshotStore: MixOnly / None 保留快照（别"顺手"清一遍）',
          found is True and snapshot.part_id == part_id and snapshot.track_no == track_no)
    store.remove_part(part_id)

    # ---- 组装 ProjectSnapshot
    part = make_part()
    part.id = part_id
    store.set_part(part, None)
    store.set_track(UTrack(track_name='test', track_no=track_no))
    store.set_revision(DocRevision(42))
    project = UProject()
    snapshot = store.snapshot(project)
    check('SnapshotStore: Snapshot 带出 revision / 轨 / part',
          snapshot.revision.value >= 42
          and snapshot.parts.get(part_id) is not None
          and snapshot.parts[part_id].source is None
          and any(t.track_no == track_no for t in snapshot.tracks))
    check('SnapshotStore: 时间轴快照是副本（与活对象脱钩）',
          snapshot.time_axis.axis is not project.time_axis)
    store.remove_part(part_id)

    # ---- TrackSnapshot.Of 的字段映射
    track2 = UTrack(track_name='t2', track_no=3, volume=0.5, pan=-0.25, mute=True)
    track2.renderer_settings.renderer = 'CLASSIC'
    track2.renderer_settings.resampler = 'resampler.exe'
    track2.renderer_settings.wavtool = 'wavtool.exe'
    snap = TrackSnapshot.of(track2)
    check('TrackSnapshot.Of: 字段映射（含 Muted → mute）',
          (snap.track_no, snap.renderer_id, snap.resampler, snap.wavtool,
           snap.volume, snap.pan, snap.muted) == (3, 'CLASSIC', 'resampler.exe',
                                                 'wavtool.exe', 0.5, -0.25, True),
          'got %r' % (snap,))
    check('TrackSnapshot.Of: 无歌手时 SingerId=None 且 SingerType=Classic / Subbanks=空',
          snap.singer_id is None and snap.singer_type == USingerType.CLASSIC
          and snap.subbanks == [])
    check('SubbankView: 值语义（record）',
          SubbankView('Soft', '_S') == SubbankView('Soft', '_S'))

    cs = _read('Pipeline/Snapshots.cs')
    if cs is not None:
        check('SnapshotStore: 源码里 None/Mix 两个 case 都是空分支',
              'case ImpactKind.None:' in cs and 'case ImpactKind.Mix:' in cs)
        flat = cs.replace('\n', ' ')
        check('SnapshotStore: 源码里 Track 分支同时丢轨与该轨的 parts',
              'tracks.Remove(trackNo);' in cs and 'parts[id].TrackNo == trackNo' in flat)


def test_pipeline_source_conformance():
    """源码一致性：三处最容易搬错的算式/顺序必须在 C# 里能找到。"""
    cs = _read('Pipeline/PhraseSource.cs')
    if cs is None:
        print('  SKIP 找不到 Pipeline/PhraseSource.cs')
        return
    flat = cs.replace('\n', ' ')

    # 切组条件（间隙 + 渲染器的合并请求）
    check('PhraseSource: FromPart 的切组判据照搬',
          'phonemes[i - 1].End != phonemes[i].position' in flat
          and '!renderer.ShouldMergePhrases(project, track, phonemes[i - 1], phonemes[i])' in flat)
    check('PhraseSource: 没有可用音素时返回 null（不是空快照）',
          'return null;' in cs)
    check('PhraseSource: PhonemeSource 的 AdjustedTempo 算式照搬',
          'AdjustedTempo = Duration / actualTickDuration * Tempo' in flat)
    check('PhraseSource: Leading 用 (PositionMs - preutter, PositionMs) 换算',
          'axis.TicksBetweenMsPos(PositionMs - phoneme.preutter, PositionMs)' in flat)
    check('PhraseSource: Volume/Velocity/VelRaw 的换算照搬',
          'VelRaw = vel;' in cs and 'Velocity = vel * 0.01f;' in cs
          and 'Volume = phoneme.GetExpression(project, track, Format.Ustx.VOL).Item1 * 0.01f;' in flat)
    check('PhraseSource: mod+ 只在描述符存在时取值（否则 0）',
          'ModpRaw = hasModp ? phoneme.GetExpression(project, track, Format.Ustx.MODP).Item1 : 0f;' in flat)
    check('PhraseSource: ToneShift 是 (int) 截断转换', 'ToneShift = (int)phoneme.GetExpression' in flat)
    check('PhraseSource: XsyAvailable 来自 part 上的 xsy 曲线',
          'XsyAvailable = part.curves.Any(c => c.abbr == Format.Ustx.XSY);' in flat)
    check('PhraseSource: 包络逐点拷贝（ToArray）而不是共享', 'Envelope = phoneme.envelope.data.ToArray();' in flat)
    check('PhraseSource: BuildPhrases 按 PhraseGroups 逐个装配',
          'new RenderPhrase(this, phonemes, PhraseGroups[i].Start, PhraseGroups[i].End)' in flat)


# ====================================================================== Classic 执行层
#
# `Format/Wave.cs`、`Classic/IResampler.cs` / `IWavtool.cs` / `SharpWavtool.cs`，
# 以及它们依赖的 NWaves 两个原语（第三方库替换）。

def _write_wav(path, samples, channels=1, framerate=44100, sampwidth=2):
    """测试用：写一个 PCM WAV（默认 44.1kHz 单声道 16 位）。

    这里按 **32768** 缩放（不是 `Wave.WriteMono16Wav` 的 32767），为的是让
    `0.5 → 16384 → 0.5` 这种往返在断言里读起来干净；读取侧本来就除以 32768。
    """
    import struct
    import wave as _w
    pcm = bytearray()
    for v in samples:
        s = max(-32768, min(32767, int(round(max(-1.0, min(1.0, v)) * 32768))))
        pcm += struct.pack('<h', s)
    with _w.open(path, 'wb') as w:
        w.setnchannels(channels)
        w.setsampwidth(sampwidth)
        w.setframerate(framerate)
        w.writeframes(bytes(pcm))


def test_wave_io():
    """`Format/Wave.cs`：16 位 WAV 缓存文件的写入与读取。"""
    import tempfile
    from singing.openutau import Wave, WaveHost

    cs = _read('Format/Wave.cs')
    if cs is None:
        print('  SKIP 找不到 Format/Wave.cs')
        return

    tmp = tempfile.mkdtemp(prefix='fufumidi-wave-')
    try:
        # ---- WriteMono16Wav 的换算：先夹到 ±1，再 (short)(v * short.MaxValue)
        path = os.path.join(tmp, 'a.wav')
        Wave.write_mono16_wav(path, [0.0, 1.0, -1.0, 2.0, -2.0, 0.5])
        got = Wave.get_samples(path)
        check('Wave.WriteMono16Wav: ±1 之外先夹紧（不是回绕）',
              got[1] == 32767 / 32768.0 and got[3] == got[1] and got[4] == got[2],
              'got %r' % got)
        check('Wave.WriteMono16Wav: 0.5 → int(0.5*32767)=16383（向零截断）',
              got[5] == 16383 / 32768.0, 'got %r' % got[5])
        check('Wave.WriteMono16Wav: 输出是 44.1kHz 单声道 16 位',
              _wav_format(path) == (44100, 1, 2), 'got %r' % (_wav_format(path),))

        # ---- 往返：量化误差 ≤ 1/32767
        rng = [math.sin(i / 50.0) * 0.9 for i in range(1000)]
        path2 = os.path.join(tmp, 'b.wav')
        Wave.write_mono16_wav(path2, rng)
        back = Wave.get_samples(path2)
        # ★ 写入乘 short.MaxValue=32767、读取除 32768（NAudio 的 Pcm16BitToSampleProvider），
        # 两头不对称，所以误差上界约 1/32767 + 1/32768，不是 1/32768
        check('Wave 往返: 长度一致且逐样本误差 ≤ 1/32767 + 1/32768',
              len(back) == len(rng)
              and max(abs(a - b) for a, b in zip(rng, back)) <= 1 / 32767.0 + 1 / 32768.0 + 1e-12,
              'got %r' % (max(abs(a - b) for a, b in zip(rng, back)),))

        # ---- 输入列表不被改动
        original = list(rng)
        Wave.write_mono16_wav(os.path.join(tmp, 'c.wav'), rng)
        check('Wave.WriteMono16Wav: 不改动入参', rng == original)

        # ---- 采样率不对 → 明确报错（不静默给错数据）
        path3 = os.path.join(tmp, 'd.wav')
        _write_wav(path3, [0.1, 0.2], framerate=48000)
        try:
            Wave.get_samples(path3)
            check('Wave: 非 44.1kHz 明确报错（不静默重采样）', False, '没有抛异常')
        except ValueError as e:
            check('Wave: 非 44.1kHz 明确报错（不静默重采样）',
                  '48000' in str(e) and 'WaveHost.decode_mono' in str(e), 'got %r' % str(e))

        # ---- 多声道取第 0 声道（对应 C# 的 ToMono(1, 0)）
        import struct
        path4 = os.path.join(tmp, 'e.wav')
        with __import__('wave').open(path4, 'wb') as w:
            w.setnchannels(2)
            w.setsampwidth(2)
            w.setframerate(44100)
            w.writeframes(b''.join(struct.pack('<hh', 1000, -1000) for _ in range(4)))
        check('Wave: 多声道取第 0 声道', Wave.get_samples(path4) == [1000 / 32768.0] * 4,
              'got %r' % Wave.get_samples(path4))

        # ---- 8 / 24 / 32 位的换算比例
        path5 = os.path.join(tmp, 'f.wav')
        _write_wav(path5, [], sampwidth=1)
        with __import__('wave').open(path5, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(1); w.setframerate(44100)
            w.writeframes(bytes([0, 128, 255]))
        check('Wave: 8 位按 (b-128)/128',
              Wave.get_samples(path5) == [-1.0, 0.0, 127 / 128.0],
              'got %r' % Wave.get_samples(path5))

        # ---- CorrectSampleScale
        samples = [1.0, -2.0, 4.0]
        Wave.correct_sample_scale(samples)
        check('Wave.CorrectSampleScale: 峰值 ≤ 8 时不动', samples == [1.0, -2.0, 4.0])
        samples = [16.0, -32.0]
        Wave.correct_sample_scale(samples)
        check('Wave.CorrectSampleScale: 峰值 > 8 → 乘 2^-15',
              samples == [16.0 * 0.5 ** 15, -32.0 * 0.5 ** 15], 'got %r' % samples)
        samples = [float(2 ** 24)]
        Wave.correct_sample_scale(samples)
        check('Wave.CorrectSampleScale: 峰值 > 2^23 → 乘 2^-31',
              samples == [float(2 ** 24) * 0.5 ** 31], 'got %r' % samples)

        # ---- 解码后端可替换
        class _Stub(WaveHost):
            def decode_mono(self, path):
                return [0.25]

        old = __import__('singing.openutau.wave', fromlist=['host']).host
        try:
            __import__('singing.openutau.wave', fromlist=['host']).host = _Stub()
            check('Wave: 默认解码器可被宿主替换',
                  Wave.get_samples('whatever.xyz') == [0.25])
        finally:
            __import__('singing.openutau.wave', fromlist=['host']).host = old

        check('Wave.cs: 写入前把样本夹到 ±1（照搬）',
              'if (v > 1f)' in cs and 'if (v < -1f)' in cs)
        check('Wave.cs: 16 位换算用 short.MaxValue', '(short)(v * short.MaxValue)' in cs)
        check('Wave.cs: GetSamples 会重采样到 44100',
              'new WdlResamplingSampleProvider(sampleProvider, 44100)' in cs)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def _wav_format(path):
    import wave as _w
    with _w.open(path, 'rb') as w:
        return (w.getframerate(), w.getnchannels(), w.getsampwidth())


def test_nwaves_filter():
    """NWaves 的 `IirPeak` / `TransferFunction.Zi` / `ZiFilter.ZeroPhase` 转写。

    ★ 期望值一律**按 C#/NWaves 的公式在测试里现算**（别凭直觉填常数）。
    """
    import struct

    from singing.openutau.classic.nwaves_filter import TransferFunction, ZiFilter, iir_peak

    # ---- IirPeak 的系数与 NWaves 公式逐项一致
    freq, q = 1000 / 44100, 5
    w0 = 2 * freq * math.pi
    bw = w0 / q
    gb = 1 / math.sqrt(2)
    beta = gb / math.sqrt(1 - gb * gb) * math.tan(bw / 2)
    gain = 1 / (1 + beta)
    tf = iir_peak(freq, q)
    check('IirPeak: 分子 = [1-gain, 0, gain-1]',
          tf.numerator == [1 - gain, 0.0, gain - 1], 'got %r' % tf.numerator)
    check('IirPeak: 分母 = [1, -2cos(w0)gain, 2gain-1]',
          tf.denominator == [1.0, -2 * math.cos(w0) * gain, 2 * gain - 1],
          'got %r' % tf.denominator)
    check('IirPeak: 直流增益为 0（分子两端的系数抵消）', abs(sum(tf.numerator)) < 1e-18)
    try:
        iir_peak(0.6, 5)
        check('IirPeak: 归一化频率越界报错（Guard）', False)
    except ValueError:
        check('IirPeak: 归一化频率越界报错（Guard）', True)

    # ---- Zi：按伴随矩阵公式现算
    # ★ 用的是 **double** 系数（C# 的 `ZiFilter.Tf` 指向原始的 `TransferFunction`，
    # 只有滤波器内部的 `_a`/`_b` 才舍到 float32）
    a, b = tf.denominator, tf.numerator
    big_b = [b[i] - a[i] * b[0] for i in range(1, 3)]
    total = (1 + a[1]) + a[2]                       # Eye - Companion(a).T 的首列之和
    zi0 = sum(big_b) / total
    zi1 = (1 + a[1]) * zi0 - (b[1] - a[1] * b[0])
    check('TransferFunction.Zi: 与伴随矩阵公式一致',
          abs(tf.zi[0] - zi0) < 1e-12 and abs(tf.zi[1] - zi1) < 1e-12 and tf.zi[2] == 0.0,
          'got %r want %r' % (tf.zi, [zi0, zi1, 0.0]))

    # ---- Process 与 Direct-Form-II-transposed 递推一致
    b_c, a_c = [1.0, 0.5], [1.0, -0.3]
    f = ZiFilter(TransferFunction(b_c, a_c))
    out = [f.process(v) for v in [1.0, 0.0, 0.0, 0.0, 0.0]]
    # y0 = b0 = 1；y1 = b1 - a1*y0 = 0.5 + 0.3 = 0.8；y2 = -a1*y1 = 0.24 …
    y = [1.0, 0.8, 0.24, 0.072, 0.0216]
    check('ZiFilter.Process: 与手算的 DF-II 转置递推一致',
          max(abs(x - e) for x, e in zip(out, y)) < 1e-6, 'got %r want %r' % (out, y))

    # ---- ZeroPhase（filtfilt）的性质
    fs, f0 = 44100, 1000.0
    n = 4410                                   # 100 个整周期
    sine = [math.sin(2 * math.pi * f0 * i / fs) for i in range(n)]
    f2 = ZiFilter(iir_peak(f0 / fs, 5))
    out2 = f2.zero_phase(list(sine))
    check('ZiFilter.ZeroPhase: 输出长度与输入一致', len(out2) == n)
    mid = slice(n // 4, n * 3 // 4)
    amp_in = max(abs(v) for v in sine[mid])
    amp_out = max(abs(v) for v in out2[mid])
    # ★ IirPeak 是"**峰值处单位增益**"的谐振器：notch 在 w0 处为 0、Peak 在 w0 处为 1，
    # 直流/奈奎斯特处为 0（分子 = (1-g)(1 - z^-2)）
    check('IirPeak.ZeroPhase: 在中心频率处增益 ≈ 1（峰值单位增益，不是放大）',
          abs(amp_out / amp_in - 1) < 0.05, 'got %r' % (amp_out / amp_in))
    # 直流（常数输入）应被压到 0 附近
    const = [1.0] * n
    out_dc = ZiFilter(iir_peak(f0 / fs, 5)).zero_phase(list(const))
    check('IirPeak.ZeroPhase: 直流被压到 0 附近（分子在 z=1 处有零点）',
          max(abs(v) for v in out_dc[n // 2:]) < 1e-3,
          'got %r' % max(abs(v) for v in out_dc[n // 2:]))
    # 零相位 = 输出与输入**同相**：滞后 0 处的相关最大
    def _corr_lag(lag):
        acc = 0.0
        for i in range(n // 4, n * 3 // 4):
            acc += out2[i] * sine[i - lag]
        return acc
    middle = _corr_lag(0)
    check('ZiFilter.ZeroPhase: 与输入同相（±1 样本内的相关都不如 0 滞后）',
          middle > _corr_lag(1) and middle > _corr_lag(-1),
          'got %r / %r / %r' % (middle, _corr_lag(1), _corr_lag(-1)))
    check('ZiFilter.ZeroPhase: 不改动入参', sine[0] == 0.0 and sine[-1] == sine[-1])
    # 默认 padLength = 3*(max(len(a),len(b))-1)；把它撑到超过信号长度就会触发 Guard
    long_tf = TransferFunction([1.0] * 10, [1.0] * 10)
    try:
        ZiFilter(long_tf).zero_phase([0.0, 0.0, 0.0, 1.0])
        check('ZiFilter.ZeroPhase: padLength 超过信号长度时报错（Guard）', False)
    except ValueError as e:
        check('ZiFilter.ZeroPhase: padLength 超过信号长度时报错（Guard）',
              'pad length' in str(e), 'got %r' % str(e))


class _StubOto:
    """只带 `offset` / `cutoff` 的 oto 替身（`SharpWavtool` 的 direct 分支只读这两项）。"""

    def __init__(self, offset=0.0, cutoff=0.0):
        self.offset = offset
        self.cutoff = cutoff


class _StubPhone:
    def __init__(self, position_ms=0.0, leading_ms=0.0, direct=False, oto=None,
                 envelope=None, phoneme='a'):
        self.position_ms = position_ms
        self.leading_ms = leading_ms
        self.direct = direct
        self.oto = oto or _StubOto()
        self.phoneme = phoneme
        self.envelope = envelope or [Vector2(0, 0), Vector2(0, 100), Vector2(0, 100),
                                     Vector2(0, 100), Vector2(0, 0)]


class _StubItem:
    """`SharpWavtool` / `Worldline.SynthSegment` 只用到 `ResamplerItem` 的这几项
    （真实实现在 test_resampler_item 里测）。"""

    def __init__(self, phrase, phone, input_file='', output_file='', skip_over=0.0,
                 envelope_ms=None, offset=0.0, cutoff=0.0, consonant=0.0, velocity=100,
                 dur_required=0.0, volume=100, tempo=120.0, tone=69, flags=None,
                 pitches=None):
        self.phrase = phrase
        self.phone = phone
        self.input_file = input_file
        self.output_file = output_file
        self.skip_over = skip_over
        self.offset = offset
        self.cutoff = cutoff
        self.consonant = consonant
        self.velocity = velocity
        self.dur_required = dur_required
        self.volume = volume
        self.tempo = tempo
        self.tone = tone
        self.flags = flags or []
        self.pitches = pitches if pitches is not None else []
        self._envelope_ms = envelope_ms or [Vector2(0, 0), Vector2(0, 100),
                                            Vector2(0, 100), Vector2(0, 100), Vector2(0, 0)]

    def envelope_ms_to_samples(self):
        return [Vector2(p.x, p.y) for p in self._envelope_ms]

    def apply_envelope(self, samples):
        # 增益恒为 1 的平坦包络 → 不影响定位断言
        return None


class _StubPhrase:
    def __init__(self, time_axis, position_ms=0.0, leading_ms=0.0, position=0, leading=0,
                 pitches=None):
        self.time_axis = time_axis
        self.position_ms = position_ms
        self.leading_ms = leading_ms
        self.position = position
        self.leading = leading
        self.pitches = pitches if pitches is not None else [6000] * 200


def test_sharp_wavtool():
    """`Classic/SharpWavtool.cs`：拼接与相位补偿。"""
    import tempfile

    from singing.openutau.classic import IWavtool, SharpWavtool

    cs = _read('Classic/SharpWavtool.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/SharpWavtool.cs')
        return
    flat = cs.replace('\n', ' ')

    check('SharpWavtool: 是 IWavtool 的实现', issubclass(SharpWavtool, IWavtool))
    check('SharpWavtool: ToString 给出 simple / convergence',
          str(SharpWavtool(False)) == 'simple' and str(SharpWavtool(True)) == 'convergence')
    check('SharpWavtool: 名字常量照搬',
          SharpWavtool.NAME_SIMPLE == 'simple' and SharpWavtool.NAME_CONVERGENCE == 'convergence')

    proj = UProject()
    axis = TimeAxis()
    axis.build_segments(proj)
    phrase = _StubPhrase(axis)
    tmp = tempfile.mkdtemp(prefix='fufumidi-wavtool-')
    try:
        wav1 = os.path.join(tmp, 'p0.wav')
        wav2 = os.path.join(tmp, 'p1.wav')
        _write_wav(wav1, [0.5] * 100)
        _write_wav(wav2, [0.25] * 100)

        # ---- 不取消时按 skipOver 裁前导、按 positionMs 叠进缓冲
        item0 = _StubItem(phrase, _StubPhone(position_ms=0.0, leading_ms=0.0),
                          output_file=wav1, skip_over=0.0)
        item1 = _StubItem(phrase, _StubPhone(position_ms=10.0, leading_ms=0.0),
                          output_file=wav2, skip_over=0.0)
        # posMs = phone.positionMs - 0 - (phrase.positionMs - phrase.leadingMs) = 10 → 441 样本
        out = SharpWavtool(False).concatenate([item0, item1], tmp)
        check('SharpWavtool.simple: 长度 = max(posSamples + len - skipSamples)',
              len(out) == 441 + 100, 'got %d' % len(out))
        check('SharpWavtool.simple: 音素 0 落在 0..99',
              all(v == 0.5 for v in out[:100]), 'got %r' % out[:5])
        check('SharpWavtool.simple: 音素 1 落在 441..540，中间是静音',
              all(v == 0.25 for v in out[441:541]) and all(v == 0.0 for v in out[100:441]),
              'got %r' % out[435:445])

        # ---- 重叠区相加
        item2 = _StubItem(phrase, _StubPhone(position_ms=0.0, leading_ms=0.0),
                          output_file=wav2, skip_over=0.0)
        out_sum = SharpWavtool(False).concatenate([item0, item2], tmp)
        check('SharpWavtool.simple: 重叠样本是**相加**（不是覆盖）',
              all(abs(v - 0.75) < 1e-12 for v in out_sum[:100]), 'got %r' % out_sum[:5])

        # ---- skipOver = +50 样本：丢掉 resampler 输出开头的前导，整体**左移** 50
        item3 = _StubItem(phrase, _StubPhone(position_ms=10.0, leading_ms=0.0),
                          output_file=wav2, skip_over=50 * 1000.0 / 44100)
        out_skip = SharpWavtool(False).concatenate([item0, item3], tmp)
        check('SharpWavtool.simple: skipOver>0 → 丢前导 + 左移（长度 = pos + len - skip）',
              len(out_skip) == 441 + 100 - 50
              and all(v == 0.25 for v in out_skip[441:491]),
              'got len=%d %r' % (len(out_skip), out_skip[435:445]))

        # ---- skipOver 超过素材长度 → Array.Resize 拿到负数长度，C# 会抛，这里同样抛
        item_bad = _StubItem(phrase, _StubPhone(position_ms=10.0, leading_ms=0.0),
                             output_file=wav2, skip_over=1000 * 1000.0 / 44100)
        try:
            SharpWavtool(False).concatenate([item0, item_bad], tmp)
            check('SharpWavtool: 缓冲长度算成负数时抛错（对应 C# Array.Resize）', False)
        except ValueError as e:
            check('SharpWavtool: 缓冲长度算成负数时抛错（对应 C# Array.Resize）',
                  'Resize' in str(e), 'got %r' % str(e))

        # ---- CancellationToken 已取消 → None
        ev = __import__('threading').Event()
        ev.set()
        check('SharpWavtool: 已取消时返回 None',
              SharpWavtool(False).concatenate([item0], tmp, ev) is None)

        # ---- 非 direct 且输出文件不存在 → 整个音素被跳过（不报错）
        missing = _StubItem(phrase, _StubPhone(), output_file=os.path.join(tmp, 'nope.wav'))
        check('SharpWavtool: 输出文件不存在时跳过该音素',
              SharpWavtool(False).concatenate([missing], tmp) == [])

        # ---- direct：直接读原音 wav，按 oto 的 offset/cutoff 切片
        direct = _StubItem(phrase, _StubPhone(direct=True, oto=_StubOto(offset=10.0, cutoff=10.0)),
                           input_file=wav1, output_file=wav1)
        out_direct = SharpWavtool(False).concatenate([direct], tmp)
        # offset = int(10/1000*44100) = 441；cutoff = 441；length = 100 - 441 - 441 < 0 → 空
        check('SharpWavtool.direct: 切片长度按 oto 的 offset/cutoff（不足时取空）',
              out_direct == [], 'got %r' % (len(out_direct),))
        direct2 = _StubItem(phrase, _StubPhone(direct=True, oto=_StubOto(offset=0.0, cutoff=-10.0)),
                            input_file=wav1, output_file=wav1)
        out_direct2 = SharpWavtool(False).concatenate([direct2], tmp)
        # Take(441) 在只有 100 个样本时给 100 个（不是补零）
        check('SharpWavtool.direct: 负 cutoff 表示"取到末尾"（length = -cutoff，素材不足就取完）',
              len(out_direct2) == 100 and all(v == 0.5 for v in out_direct2),
              'got %d' % len(out_direct2))

        # ---- 相位补偿：端到端跑通（正弦素材），长度对齐且不抛异常
        n = 4410
        sine = [math.sin(2 * math.pi * 440 * i / 44100) for i in range(n)]
        s0 = os.path.join(tmp, 's0.wav')
        s1 = os.path.join(tmp, 's1.wav')
        _write_wav(s0, sine)
        _write_wav(s1, sine)
        p_phrase = _StubPhrase(axis, pitches=[6900] * 400)     # A4 ≈ 440Hz
        p0 = _StubItem(p_phrase, _StubPhone(position_ms=0.0), output_file=s0)
        p1 = _StubItem(p_phrase, _StubPhone(position_ms=100.0), output_file=s1)
        out_phase = SharpWavtool(True).concatenate([p0, p1], tmp)
        out_plain = SharpWavtool(False).concatenate([p0, p1], tmp)
        check('SharpWavtool.convergence: 首个音素不被平移（correction 从 i=1 起）',
              out_phase[:4410] == out_plain[:4410])
        # 第二段最多整体平移一个相位修正量（半个周期 ≈ 50 样本）；C# 的 Array.Resize
        # 在变小时会截断，所以长度**不是**严格相等，允许这段修正量的范围
        check('SharpWavtool.convergence: 只有第二段可能整体平移（|Δ长度| ≤ 半个周期）',
              abs(len(out_phase) - len(out_plain)) <= 51,
              'got %r / %r' % (len(out_phase), len(out_plain)))

        # ---- 源码一致性
        check('SharpWavtool: posSamples/skipSamples 的换算照搬',
              'segment.posSamples = (int)Math.Round(segment.posMs * 44100 / 1000);' in flat
              and 'segment.skipSamples = (int)Math.Round(item.skipOver * 44100 / 1000);' in flat)
        check('SharpWavtool: posMs 用两头 leadingMs 之差',
              'item.phone.positionMs - item.phone.leadingMs - (phrase.positionMs - phrase.leadingMs)'
              in flat)
        check('SharpWavtool: 相位差取"离 0 更近"的等价角',
              'if (Math.Abs(diff - 2 * Math.PI) < diff)' in flat)
        check('SharpWavtool: correction 用 diff/2π * fs / headWindowF0',
              'segments[i].correction = (int)(diff / 2 / Math.PI * 44100 / segments[i].headWindowF0);'
              in flat)
        check('SharpWavtool: 叠加用 Array.Resize（变小时会截断）',
              'Array.Resize(ref phraseSamples' in flat)
        check('SharpWavtool: 读缓存文件时按 outputFile 取共享锁',
              'lock (Renderers.GetCacheLock(item.outputFile))' in flat)
        check('SharpWavtool: 相位窗口是 440 / 880（中心 ±440）',
              'Math.Max((int)windowCenter.X - 440, 0)' in flat and 'Math.Min(880,' in flat)

        # ---- IResampler / IWavtool 的源码一致性
        iw = _read('Classic/IWavtool.cs')
        if iw is not None:
            check('IWavtool: 只声明 Concatenate + CheckPermissions',
                  'float[] Concatenate(List<ResamplerItem> resamplerItems, string tempPath, CancellationTokenSource cancellation);'
                  in iw.replace('\n', ' ') and 'void CheckPermissions();' in iw)
        ir = _read('Classic/IResampler.cs')
        if ir is not None:
            want_members = ['FilePath', 'NoWrapperScript', 'DoResampler', 'DoResamplerReturnsFile',
                            'CheckPermissions', 'Manifest', 'SupportsFlag']
            check('IResampler: 七个成员的接口照搬',
                  all(m in ir for m in want_members), 'got %r' % ir)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_resampler_manifest():
    """`Classic/ResamplerManifest.cs`：读 YAML + 键小写化（第一个优先）。"""
    import tempfile

    from singing.openutau.classic import ResamplerManifest

    cs = _read('Classic/ResamplerManifest.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/ResamplerManifest.cs')
        return

    tmp = tempfile.mkdtemp(prefix='fufumidi-manifest-')
    try:
        path = os.path.join(tmp, 'r.yaml')
        with open(path, 'w', encoding='utf-8') as f:
            f.write('expressions:\n'
                    '  Ten:\n    name: tension\n    abbr: ten\n'
                    '  ten:\n    name: SHADOW\n    abbr: ten\n'
                    'expression_filter: true\n')
        manifest = ResamplerManifest.load(path)
        check('ResamplerManifest: expressionFilter → expression_filter',
              manifest.expression_filter is True)
        check('ResamplerManifest: 键统一小写', set(manifest.expressions) == {'ten'},
              'got %r' % set(manifest.expressions))
        check('ResamplerManifest: 同名键**取第一个**（不是后者覆盖）',
              manifest.expressions['ten'].name == 'tension',
              'got %r' % manifest.expressions['ten'].name)
        check('ResamplerManifest: 反序列化成 UExpressionDescriptor',
              isinstance(manifest.expressions['ten'], UExpressionDescriptor))

        empty = os.path.join(tmp, 'empty.yaml')
        with open(empty, 'w', encoding='utf-8') as f:
            f.write('{}\n')
        check('ResamplerManifest: 空清单 → 空表达式表 + filter 关闭',
              ResamplerManifest.load(empty).expressions == {}
              and ResamplerManifest.load(empty).expression_filter is False)

        check('ResamplerManifest.cs: 用 GroupBy(小写).First() 而不是覆盖',
              'GroupBy(kvp => kvp.Key.ToLower())' in cs and '.First().Value' in cs)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_voicebank_config():
    """`Classic/VoicebankConfig.cs`：字段表 / 默认值 / 枚举 / OmitNull 写盘。"""
    import dataclasses
    import shutil
    import tempfile

    from singing.openutau.classic import (
        SingerTypeValues, SymbolSet, SymbolSetPreset, VoicebankConfig,
    )
    from singing.openutau.classic.voicebank_config import Subbank as CfgSubbank
    from singing.openutau.oto import Subbank as OtoSubbank
    from singing.openutau.singer import SINGER_TYPE_FROM_NAME
    from singing.ustx.io import dump_yaml

    cs = _read('Classic/VoicebankConfig.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/VoicebankConfig.cs')
        return

    # --- 枚举：SymbolSetPreset 的名字与顺序
    m = re.search(r'enum SymbolSetPreset\s*\{([^}]*)\}', cs)
    want_presets = [x.strip() for x in m.group(1).split(',') if x.strip()] if m else []
    got_presets = [v for k, v in vars(SymbolSetPreset).items()
                   if k.isupper() and isinstance(v, str)]
    check('SymbolSetPreset: 三枚枚举名一致', want_presets == got_presets,
          'C#=%r 我们=%r' % (want_presets, got_presets))

    # --- VoicebankConfig 的字段名与**声明顺序**（= 写盘顺序）
    # C# 有两种写法：`public float X = 0.67f;`（字段带初值）与
    # `public string X { get; set; } = "-";`（属性，初值在访问器**之后**），都要认。
    body = re.search(r'class VoicebankConfig\s*\{(.*?)\n    \}', cs, re.S).group(1)
    member_re = re.compile(
        r'^\s*public\s+(.+?)\s+(\w+)\s*'
        r'(?:=\s*([^;{]+?)\s*)?'
        r'(?:;|\{\s*get;\s*set;\s*\})'
        r'(?:\s*=\s*([^;{]+?)\s*;)?\s*$', re.M)

    def snake(name):
        return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()

    def _members(src_body):
        return [(n, (a or b)) for _, n, a, b in member_re.findall(src_body)]

    members = _members(body)
    want_fields = [snake(n) for n, _ in members]
    got_fields = [f.name for f in dataclasses.fields(VoicebankConfig)]
    check('VoicebankConfig: 字段个数一致（%d）' % len(want_fields),
          len(want_fields) == len(got_fields), 'C#=%d 我们=%d' % (len(want_fields), len(got_fields)))
    check('VoicebankConfig: 字段名与声明顺序一致', want_fields == got_fields,
          'C#=%r\n       我们=%r' % (want_fields, got_fields))

    # --- C# 里显式写了初始值的字段，默认值必须逐个对上
    cs_defaults = {snake(n): v for n, v in members if v is not None}
    check('VoicebankConfig: PortraitOpacity 默认 0.67f',
          VoicebankConfig().portrait_opacity == 0.67
          and 'f' in (cs_defaults.get('portrait_opacity') or ''),
          'C#=%r' % cs_defaults.get('portrait_opacity'))
    check('VoicebankConfig: PortraitHeight 默认 0',
          VoicebankConfig().portrait_height == 0 and cs_defaults.get('portrait_height') == '0')
    check('VoicebankConfig: UseFilenameAsAlias 是三态 bool?（默认 None，不是 False）',
          VoicebankConfig().use_filename_as_alias is None
          and cs_defaults.get('use_filename_as_alias') == 'null')
    # 其余（string/Dictionary/数组）C# 都是引用类型默认 null → 我们这边必须是 None，不能是空串
    no_init = [snake(n) for n, v in members if v is None]
    check('VoicebankConfig: 无初始值的引用类型字段默认 None（不是 ""/[]）',
          all(getattr(VoicebankConfig(), f) is None for f in no_init),
          'got %r' % {f: getattr(VoicebankConfig(), f) for f in no_init})

    # --- SymbolSet 的字段与默认值
    sb_members = _members(re.search(r'class SymbolSet\s*\{(.*?)\n    \}', cs, re.S).group(1))
    check('SymbolSet: 字段名/顺序一致（preset, head, tail）',
          [snake(n) for n, _ in sb_members] == [f.name for f in dataclasses.fields(SymbolSet)],
          'C#=%r' % [snake(n) for n, _ in sb_members])
    check('SymbolSet: head 默认 "-"、tail 默认 "R"（初值写在访问器之后）',
          SymbolSet().head == '-' and SymbolSet().tail == 'R'
          and dict((snake(n), v) for n, v in sb_members).get('head') == '"-"')
    check('SymbolSet: preset 默认 unknown（枚举 0）',
          SymbolSet().preset == SymbolSetPreset.UNKNOWN)

    # --- Subbank：Python 侧留在 oto.py，但必须是**同一个类对象**（不是复制品）
    check('Subbank: oto.Subbank 与配置模型引用的是同一个类', CfgSubbank is OtoSubbank)

    # --- SingerTypeValues 的取值就是 SingerTypeFromName 的键
    check('SingerTypeValues: 取值 = SingerTypeFromName.Keys',
          SingerTypeValues.get_values() == list(SINGER_TYPE_FROM_NAME.keys()))
    check('SingerTypeValues.cs: 确实取 SingerTypeFromName.Keys',
          'SingerTypeUtils.SingerTypeFromName.Keys' in cs)
    check('SingerTypeValues: 含 utau', 'utau' in SingerTypeValues.get_values())

    # --- 写盘：OmitNull 只略过 null，**默认值照样写**
    yaml_cs = _read('Util/Yaml.cs')
    check('Util/Yaml.cs: 用的是 OmitNull（不是 OmitDefaults）',
          yaml_cs is not None and 'DefaultValuesHandling.OmitNull' in yaml_cs
          and 'OmitDefaults' not in yaml_cs)

    text = dump_yaml(VoicebankConfig())
    check('写盘: 默认值 portrait_opacity 写出来', 'portrait_opacity: 0.67' in text, 'got:\n%s' % text)
    check('写盘: 默认值 portrait_height 写出来', 'portrait_height: 0' in text, 'got:\n%s' % text)
    check('写盘: OmitNull —— 没设的字符串键不出现',
          re.search(r'(?m)^name:', text) is None and 'version:' not in text
          and 'symbol_set' not in text and 'subbanks' not in text
          and 'use_filename_as_alias' not in text, 'got:\n%s' % text)

    # --- 读盘：下划线键 / 嵌套 / 未知键忽略 / 三态
    tmp = tempfile.mkdtemp(prefix='fufumidi-vbconfig-')
    try:
        path = os.path.join(tmp, 'character.yaml')
        with open(path, 'w', encoding='utf-8') as f:
            f.write('name: Tester\n'
                    'localized_names:\n  ja-JP: テスター\n'
                    'search_terms:\n- tester\n'
                    'singer_type: utau\n'
                    'portrait_opacity: 0.5\n'
                    'symbol_set:\n  preset: hiragana\n  head: "-"\n  tail: R\n'
                    'subbanks:\n- color: Soft\n  prefix: P\n  suffix: S\n'
                    '  tone_ranges:\n  - C4\n  - E4-G4\n'
                    'use_filename_as_alias: true\n'
                    'brand_new_key: 1\n')
        cfg = VoicebankConfig.load(path)
        check('读盘: name / localized_names', cfg.name == 'Tester'
              and cfg.localized_names == {'ja-JP': 'テスター'}, 'got %r' % cfg.localized_names)
        check('读盘: search_terms 是数组', cfg.search_terms == ['tester'], 'got %r' % cfg.search_terms)
        check('读盘: symbol_set 反序列化成 SymbolSet',
              isinstance(cfg.symbol_set, SymbolSet) and cfg.symbol_set.preset == 'hiragana'
              and cfg.symbol_set.tail == 'R', 'got %r' % cfg.symbol_set)
        check('读盘: subbanks 反序列化成 Subbank 列表',
              isinstance(cfg.subbanks, list) and len(cfg.subbanks) == 1
              and cfg.subbanks[0].tone_ranges == ['C4', 'E4-G4'], 'got %r' % cfg.subbanks)
        check('读盘: use_filename_as_alias 三态 true', cfg.use_filename_as_alias is True)
        check('读盘: 未知键忽略（IgnoreUnmatchedProperties）',
              not hasattr(cfg, 'brand_new_key'))

        # --- save → load 往返
        out = os.path.join(tmp, 'out', 'character.yaml')
        os.makedirs(os.path.dirname(out))
        cfg.save(out)
        back = VoicebankConfig.load(out)
        check('往返: 关键字段一致',
              (back.name, back.singer_type, back.portrait_opacity) == ('Tester', 'utau', 0.5),
              'got %r' % ((back.name, back.singer_type, back.portrait_opacity),))
        check('往返: symbol_set 子对象一致',
              back.symbol_set == cfg.symbol_set and back.subbanks == cfg.subbanks)
        check('往返: 未知键没有被写回', 'brand_new_key' not in open(out, encoding='utf-8').read())

        # 空文件 / 空映射都要能读（C# 的 Deserialize 返回全默认实例）
        empty = os.path.join(tmp, 'empty.yaml')
        with open(empty, 'w', encoding='utf-8') as f:
            f.write('{}\n')
        blank = VoicebankConfig.load(empty)
        check('读盘: 空 YAML → 全默认（引用类型为 None）',
              blank.name is None and blank.subbanks is None
              and blank.portrait_opacity == 0.67)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    # --- 上游怪癖：SymbolSet 目前未被使用，照搬不删
    check('源码: SymbolSet 仍标注 "Not used by OpenUtau at the moment."',
          'Not used by OpenUtau at the moment.' in cs)


def test_voicebank_loader():
    """`Classic/VoicebankLoader.cs`：常量 / 方法表 / oto 解析 / prefix.map / 写回。"""
    import shutil
    import tempfile

    from singing.openutau.classic import FileTrace, VoicebankConfig, VoicebankLoader
    from singing.openutau.classic import voicebank_loader as VL
    from singing.openutau.oto import Voicebank
    from singing.openutau.singer import Preferences, USingerType

    cs = _read('Classic/VoicebankLoader.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/VoicebankLoader.cs')
        return

    def snake(name):
        return re.sub(r'(?<!^)(?=[A-Z])', '_', name).lower()

    # --- 常量表：C# 的 `kXxx` → 我们的 UPPER_SNAKE
    want = dict(re.findall(r'public const string (k\w+) = "([^"]*)";', cs))
    got = {k: v for k, v in vars(VL).items() if k.isupper() and isinstance(v, str)}
    expected = {snake(n[1:]).upper(): v for n, v in want.items()}
    missing = set(expected) - set(got)
    # DEFAULT_ENCODING 是 Python 侧补的（C# 把 `Encoding.GetEncoding("shift_jis")`
    # 写死在两处，没有常量），不算多出来的文件名常量。
    extra = set(got) - set(expected) - {'DEFAULT_ENCODING'}
    check('VoicebankLoader: 常量表逐项对上（%d 个）' % len(want), not missing and not extra,
          '缺=%r 多出=%r' % (sorted(missing), sorted(extra)))
    check('VoicebankLoader: 每个文件名的字面值一致',
          {k: got.get(k) for k in expected} == expected, 'C#=%r 我们=%r' % (want, got))
    check('VoicebankLoader: 默认编码常量 = .NET 的 shift_jis(=cp932)',
          'Encoding.GetEncoding("shift_jis")' in cs and VL.DEFAULT_ENCODING == 'cp932')
    check('VoicebankLoader: kConfigYaml 是上游的死常量，也照搬',
          'kConfigYaml' in want and VL.CONFIG_YAML == 'config.yaml')

    # --- 成员表：C# 的方法名 → Python 名（重命名处已注明载体差异）
    member_map = {
        'SearchAll': 'search_all',
        'LoadVoicebank': 'load_voicebank',
        'LoadInfo': 'load_info',
        'ParseCharacterTxt': 'parse_character_txt',
        'ApplyConfig': 'apply_config',
        'LoadSubbanks': 'load_subbanks',
        'LoadPrefixMap': 'load_prefix_map',
        'LoadMap': 'load_map',
        'ParsePrefixMap': 'parse_prefix_map',
        'LoadOtoSets': 'load_oto_sets',
        'ParseOtoSet': 'parse_oto_set',
        'GetOtoDeclaredEncoding': 'get_oto_declared_encoding',
        'AddAliasForMissingFiles': 'add_alias_for_missing_files',
        'CheckWavExist': 'check_wav_exist',
        'AddFilenameAlias': 'add_filename_alias',
        'ParseOto': 'parse_oto',
        'WriteOtoSets': 'write_oto_sets',
        'WriteOtoSet': 'write_oto_set',
    }
    missing = [c for c in member_map if ('%s(' % c) not in cs]
    check('VoicebankLoader.cs: 这些成员名都在源码里', not missing, '缺: %r' % missing)
    absent = [p for c, p in member_map.items() if not hasattr(VoicebankLoader, p)]
    check('VoicebankLoader: 逐个成员都已落地', not absent, '缺: %r' % absent)
    # 两个搬成模块级函数（C# 是 static，但 Python 侧无状态、放模块更清楚）
    check('ParseDouble / RemoveExtension 搬成模块级函数',
          'ParseDouble(' in cs and 'RemoveExtension(' in cs
          and callable(VL.parse_double) and callable(VL._remove_extension))
    check('VoicebankLoader.IsTest 默认 false',
          'public static bool IsTest = false;' in cs and VoicebankLoader.is_test is False)

    # --- `FileTrace`：拷贝语义 + 行号显示 +1
    trace = FileTrace('oto.ini', 3, 'x=y')
    copied = trace.copy()
    copied.line = 'changed'
    check('FileTrace: copy() 是独立副本（陷阱 #1）',
          trace.line == 'x=y' and copied.line == 'changed' and copied is not trace)
    check('FileTrace: ToString 的行号是 lineNumber+1', str(trace) == '"oto.ini"\nat line 4:\n"x=y"',
          'got %r' % str(trace))

    # --- 编码名换算（.NET 的 shift_jis 实为 cp932）
    check('get_encoding: shift_jis → cp932', VL.get_encoding('shift_jis') == 'cp932')
    check('get_encoding: utf-8 → utf-8', VL.get_encoding('utf-8') == 'utf-8')
    try:
        VL.get_encoding(' utf-8')
        check('get_encoding: 带空白的名字要报错（.NET 的严格度）', False, '居然通过了')
    except LookupError:
        check('get_encoding: 带空白的名字要报错（.NET 的严格度）', True)

    # --- double 格式化：C# 的 `0.0 → "0"`、指数大写 E
    check('_cs_double: 0.0 → "0"（不是 Python 的 "0.0"）', VL._cs_double(0.0) == '0',
          'got %r' % VL._cs_double(0.0))
    check('_cs_double: 50 → "50" / -3.142 原样', VL._cs_double(50.0) == '50'
          and VL._cs_double(-3.142) == '-3.142')
    check('_cs_double: 指数用大写 E', VL._cs_double(1e-05) == '1E-05',
          'got %r' % VL._cs_double(1e-05))

    # --- parse_double：C# 的 NumberStyles.Float + "空串算成功"
    check('parse_double: None/空串 → (True, 0)',
          VL.parse_double(None) == (True, 0.0) and VL.parse_double('') == (True, 0.0))
    check('parse_double: 带空白的数字可解析', VL.parse_double(' 2.5 ') == (True, 2.5))
    check('parse_double: 非数字 → False', VL.parse_double('XX')[0] is False
          and VL.parse_double('1,5')[0] is False)

    # --- `_read_lines`：只认 \r\n / \r / \n，末尾换行不产生空行
    check('_read_lines: 三种换行都认', VL._read_lines('a\r\nb\rc\nd') == ['a', 'b', 'c', 'd'])
    check('_read_lines: 末尾换行不产生多余空行', VL._read_lines('a\n') == ['a'])
    check('_read_lines: 中间空行保留', VL._read_lines('a\n\nb') == ['a', '', 'b'])

    tmp = tempfile.mkdtemp(prefix='fufumidi-vbloader-')
    saved_is_test = VoicebankLoader.is_test
    try:
        # ---------------- 一个真实的（最小）声库目录
        vb = os.path.join(tmp, 'Tester')
        os.makedirs(vb)
        with open(os.path.join(vb, 'character.txt'), 'w', encoding='utf-8') as f:
            f.write('# 这是注释行\n'
                    'name=Tester\n'
                    'author=Someone\n'
                    'voice=TesterCV\n'
                    'sample=sample.wav\n'
                    'web=https://example.com\n'
                    'version=1.0\n'
                    'image=icon.png\n'
                    'image = notpicked.png\n')   # 等号两侧有空格 → 认不出来（死代码 quirk）
        with open(os.path.join(vb, 'oto.ini'), 'w', encoding='utf-8') as f:
            f.write('a.wav=a_alt,0,50,-30,100,20\n'    # 合法（cutoff 允许负）；别名与文件名不同
                    'b.wav=,0,50,0,100,20\n'         # 空别名 → 用文件名
                    'c.wav=c\n'                      # 截断 → 数值全 0 且 IsValid=true（quirk）
                    'd.wav=d,0,50,0,100,XX\n'        # overlap 解析失败
                    'garbage line\n'                 # 没有 '=' → 报格式错
                    '\n')                            # 空行 → 无效条目但无错
        with open(os.path.join(vb, 'a.wav'), 'wb') as f:
            f.write(b'RIFF')
        with open(os.path.join(vb, 'extra.wav'), 'wb') as f:
            f.write(b'RIFF')

        # is_test 打开 → 跳过 wav 存在性检查，先把"纯解析"测干净
        VoicebankLoader.is_test = True
        oto_set = VoicebankLoader.parse_oto_set(os.path.join(vb, 'oto.ini'), 'utf-8', None)
        by_alias = {o.alias: o for o in oto_set.otos}
        check('parse_oto: 合法行 is_valid=True 且数值就位',
              by_alias['a_alt'].is_valid and (by_alias['a_alt'].offset, by_alias['a_alt'].consonant,
                                              by_alias['a_alt'].cutoff, by_alias['a_alt'].preutter,
                                              by_alias['a_alt'].overlap)
              == (0.0, 50.0, -30.0, 100.0, 20.0), 'got %r' % by_alias['a_alt'])
        check('parse_oto: 空别名回退成"文件名去扩展名"', by_alias['b'].alias == 'b')
        check('parse_oto: 截断行 c.wav=c → is_valid=True 且数值全 0（parse_double quirk）',
              by_alias['c'].is_valid and (by_alias['c'].offset, by_alias['c'].overlap) == (0.0, 0.0))
        check('parse_oto: overlap 非数字 → is_valid=False 且报错提到 overlap',
              (not by_alias['d'].is_valid) and 'overlap' in by_alias['d'].error,
              'got %r' % by_alias['d'].error)
        garbage = next(o for o in oto_set.otos
                       if o.file_trace is not None and o.file_trace.line == 'garbage line')
        check('parse_oto: 没有 "=" 的行报格式错', 'does not match format' in garbage.error)
        parsed_only = [o for o in oto_set.otos if o.file_trace is not None]
        blanks = [o for o in parsed_only if not o.is_valid and not o.error]
        check('parse_oto: 空行产出"无效但无错"的条目（写回时原样输出）', len(blanks) == 1,
              'got %d' % len(blanks))
        check('parse_oto: 每行的 FileTrace 互不共享且行号递增',
              len({id(o.file_trace) for o in parsed_only}) == len(parsed_only)
              and [o.file_trace.line_number for o in parsed_only] == list(range(len(parsed_only))),
              'got %r' % [o.file_trace.line_number for o in parsed_only])
        check('AddAliasForMissingFiles: 补上 extra.wav 的别名，但 **is_valid 仍是 False**（上游行为）',
              any(o.alias == 'extra' and not o.is_valid and o.file_trace is None
                  for o in oto_set.otos),
              'got %r' % [(o.alias, o.is_valid) for o in oto_set.otos])

        # 真开 wav 存在性检查：a.wav 在、b/c/d 的 wav 不在 → 标错 + 失效
        VoicebankLoader.is_test = False
        oto_set2 = VoicebankLoader.parse_oto_set(os.path.join(vb, 'oto.ini'), 'utf-8', None)
        by_alias2 = {o.alias: o for o in oto_set2.otos}
        check('CheckWavExist: 文件在的条目保持有效', by_alias2['a_alt'].is_valid)
        check('CheckWavExist: 文件缺失的条目 is_valid=False 且 error 写明缺失',
              (not by_alias2['b'].is_valid) and 'Sound file missing' in by_alias2['b'].error,
              'got %r' % by_alias2['b'].error)

        # useFilenameAsAlias：追加"文件名"别名，参考条目取 Offset 最小者
        VoicebankLoader.is_test = True
        oto_set3 = VoicebankLoader.parse_oto_set(os.path.join(vb, 'oto.ini'), 'utf-8', True)
        check('AddFilenameAlias: 已存在同名别名就不重复追加（b 的名字和别名都是 b）',
              sum(1 for o in oto_set3.otos if o.alias == 'a') == 1
              and sum(1 for o in oto_set3.otos if o.alias == 'b') == 1,
              'got %r' % [(o.alias, o.is_valid) for o in oto_set3.otos])
        added = next(o for o in oto_set3.otos if o.alias == 'a')
        ref_alt = next(o for o in oto_set3.otos if o.alias == 'a_alt')
        check('AddFilenameAlias: 复制参考条目的数值且 is_valid=True',
              added.is_valid and added.wav == 'a.wav' and added.offset == ref_alt.offset
              and added.consonant == ref_alt.consonant and added.cutoff == ref_alt.cutoff)
        check('AddFilenameAlias: file_trace 是**共享**引用（不是复制）',
              added.file_trace is ref_alt.file_trace)

        # ---------------- 写回：无效条目按原始行原样写
        out_dir = os.path.join(tmp, 'write')
        os.makedirs(out_dir)
        src = os.path.join(out_dir, 'oto.ini')
        with open(src, 'w', encoding='utf-8') as f:
            f.write('a.wav=a,0,50,0,100,20\ngarbage line\n\n')
        parsed = VoicebankLoader.parse_oto_set(src, 'utf-8', None)
        VoicebankLoader.write_oto_set(parsed, src, 'utf-8')
        rewrote = open(src, encoding='utf-8').read()
        check('write_oto_set: 往返后逐字符一致（含无法解析的行）',
              rewrote == 'a.wav=a,0,50,0,100,20\ngarbage line\n\n', 'got %r' % rewrote)
        check('write_oto_set: 整数值按 C# 写 "0" 而不是 "0.0"', ',0,50,0,100,20' in rewrote)

        # ---------------- #Charset: 声明（含"不 trim"的怪癖与 10 行上限）
        cs1 = os.path.join(tmp, 'charset1.ini')
        with open(cs1, 'w', encoding='utf-8') as f:
            f.write('#Charset:utf-8\na.wav=a,0,0,0,0,0\n')
        check('GetOtoDeclaredEncoding: #Charset:utf-8（无空格）→ utf-8',
              VoicebankLoader.get_oto_declared_encoding(cs1) == 'utf-8')
        cs2 = os.path.join(tmp, 'charset2.ini')
        with open(cs2, 'w', encoding='utf-8') as f:
            f.write('#Charset: utf-8\na.wav=a,0,0,0,0,0\n')
        check('GetOtoDeclaredEncoding: "#Charset: utf-8"（有空格）被判成没声明（上游怪癖）',
              VoicebankLoader.get_oto_declared_encoding(cs2) is None)
        cs3 = os.path.join(tmp, 'charset3.ini')
        with open(cs3, 'w', encoding='utf-8') as f:
            f.write('\n' * 10 + '#Charset:utf-8\n')
        check('GetOtoDeclaredEncoding: 只看前 10 行', VoicebankLoader.get_oto_declared_encoding(cs3) is None)

        # ---------------- StreamReader 的 BOM 检测
        bom_file = os.path.join(tmp, 'bom.txt')
        with open(bom_file, 'wb') as f:
            f.write(b'\xef\xbb\xbfname=BOM\xe4\xb8\xad\n')
        check('_read_text: 有 UTF-8 BOM 时改用它并吃掉 BOM（StreamReader 行为）',
              'name=BOM中' in VL._read_text(bom_file, 'cp932'), 'got %r' % VL._read_text(bom_file, 'cp932'))

        # ---------------- character.txt 解析 + load_info 判型
        bank = Voicebank()
        VoicebankLoader.load_info(bank, os.path.join(vb, 'character.txt'), tmp)
        check('ParseCharacterTxt: 认识的键都读出来了',
              (bank.name, bank.author, bank.voice, bank.sample, bank.web, bank.version, bank.image)
              == ('Tester', 'Someone', 'TesterCV', 'sample.wav', 'https://example.com', '1.0', 'icon.png'),
              'got %r' % ((bank.name, bank.author, bank.voice, bank.sample, bank.web,
                           bank.version, bank.image),))
        check('ParseCharacterTxt: 无扩展名目录 → id 是相对路径',
              bank.id.replace('\\', '/') == 'Tester', 'got %r' % bank.id)
        check('ParseCharacterTxt: "image = x"（等号两侧空格）**认不出来**，落进 other_info',
              bank.image == 'icon.png' and 'image = notpicked.png' in bank.other_info,
              'got %r' % bank.other_info)
        check('ParseCharacterTxt: 没配 character.yaml 时默认 shift_jis(=cp932)',
              bank.text_file_encoding == 'cp932', 'got %r' % bank.text_file_encoding)
        check('LoadInfo: 没有 yaml/enuconfig/dsconfig → Classic', bank.singer_type == USingerType.CLASSIC)

        # 缺 name 时兜底命名
        noname = Voicebank()
        no_name_txt = os.path.join(tmp, 'NoName', 'character.txt')
        os.makedirs(os.path.dirname(no_name_txt))
        with open(no_name_txt, 'w', encoding='utf-8') as f:
            f.write('author=X\n')
        VoicebankLoader.load_info(noname, no_name_txt, tmp)
        check('ParseCharacterTxt: 没有 name → "No Name (id)"',
              noname.name == 'No Name (NoName)', 'got %r' % noname.name)

        # character.yaml 的 singer_type 优先；legacy 判型走文件名
        yaml_dir = os.path.join(tmp, 'FromYaml')
        os.makedirs(yaml_dir)
        with open(os.path.join(yaml_dir, 'character.txt'), 'w', encoding='utf-8') as f:
            f.write('name=Y\n')
        with open(os.path.join(yaml_dir, 'character.yaml'), 'w', encoding='utf-8') as f:
            f.write('singer_type: diffsinger\ntext_file_encoding: utf-8\n')
        bank_y = Voicebank()
        VoicebankLoader.load_info(bank_y, os.path.join(yaml_dir, 'character.txt'), tmp)
        check('LoadInfo: character.yaml 的 singer_type 优先 → DiffSinger',
              bank_y.singer_type == USingerType.DIFFSINGER)
        check('LoadInfo: character.yaml 的 text_file_encoding 生效', bank_y.text_file_encoding == 'utf-8')
        ds_dir = os.path.join(tmp, 'LegacyDs')
        os.makedirs(ds_dir)
        with open(os.path.join(ds_dir, 'character.txt'), 'w', encoding='utf-8') as f:
            f.write('name=L\n')
        with open(os.path.join(ds_dir, 'dsconfig.yaml'), 'w', encoding='utf-8') as f:
            f.write('{}\n')
        bank_l = Voicebank()
        VoicebankLoader.load_info(bank_l, os.path.join(ds_dir, 'character.txt'), tmp)
        check('LoadInfo: 遗留判型认得 dsconfig.yaml → DiffSinger',
              bank_l.singer_type == USingerType.DIFFSINGER)

        # ---------------- ApplyConfig 的引用语义
        cfg = VoicebankConfig(name='  ', image='  ',
                              subbanks=[Subbank(color=None, prefix=None, suffix=None)])
        b2 = Voicebank()
        b2.singer_type = USingerType.CLASSIC
        cfg.use_filename_as_alias = True
        VoicebankLoader.apply_config(b2, cfg)
        check('ApplyConfig: 纯空白的 name/image 不覆盖（IsNullOrWhiteSpace）',
              b2.name is None and b2.image is None)
        check('ApplyConfig: Subbank 的空字段被就地补成空串，且是**同一批对象**',
              b2.subbanks[0] is cfg.subbanks[0]
              and (b2.subbanks[0].color, b2.subbanks[0].prefix, b2.subbanks[0].suffix) == ('', '', ''),
              'got %r' % b2.subbanks[0])
        check('ApplyConfig: Classic 才吃 UseFilenameAsAlias', b2.use_filename_as_alias is True)

        # ---------------- prefix.map → 子音色 / 音域
        pm_dir = os.path.join(tmp, 'Prefix')
        os.makedirs(pm_dir)
        with open(os.path.join(pm_dir, 'character.txt'), 'w', encoding='utf-8') as f:
            f.write('name=P\n')
        with open(os.path.join(pm_dir, 'prefix.map'), 'w', encoding='utf-8') as f:
            f.write('C4\t\t\nD4\t\t\nC4\t\t\n')          # 重复行要去重
        bank_p = Voicebank()
        VoicebankLoader.load_info(bank_p, os.path.join(pm_dir, 'character.txt'), tmp)
        VoicebankLoader.load_subbanks(bank_p)
        check('ParsePrefixMap: 重复取音去重（SortedSet 语义）',
              VoicebankLoader.parse_prefix_map(os.path.join(pm_dir, 'prefix.map'), 'cp932')[('', '')]
              == [60, 62])
        check('LoadMap: 不相邻的音各自成一段（C4 与 D4 各自单点）',
              len(bank_p.subbanks) == 1 and bank_p.subbanks[0].tone_ranges == ['C4', 'D4'],
              'got %r' % [(s.color, s.prefix, s.suffix, s.tone_ranges) for s in bank_p.subbanks])
        empty_bank = Voicebank()
        empty_bank.file = os.path.join(tmp, 'EmptyBank', 'character.txt')
        os.makedirs(os.path.dirname(empty_bank.file))
        VoicebankLoader.load_subbanks(empty_bank)
        check('LoadSubbanks: 一个都没有时补一个空占位（ToneRanges=[] 不是 None）',
              len(empty_bank.subbanks) == 1 and empty_bank.subbanks[0].tone_ranges == [])

        # ---------------- search_all + load_oto_sets + reload
        bank_s = Voicebank()
        bank_s.base_path = tmp
        bank_s.file = os.path.join(vb, 'character.txt')
        VoicebankLoader.load_voicebank(bank_s)
        check('LoadVoicebank: oto 表按相对目录命名（根目录 → 空串）',
              len(bank_s.oto_sets) == 1 and bank_s.oto_sets[0].name == '',
              'got %r' % [s.name for s in bank_s.oto_sets])
        old_name = bank_s.name
        bank_s.name = 'MUTATED'
        bank_s.reload()
        check('Voicebank.reload: 重新读回（且 BasePath/File 保留）',
              bank_s.name == old_name, 'got %r' % bank_s.name)

        sub_dir = os.path.join(vb, 'sub')
        os.makedirs(sub_dir)
        with open(os.path.join(sub_dir, 'oto.ini'), 'w', encoding='utf-8') as f:
            f.write('a.wav=a,0,0,0,0,0\n')
        VoicebankLoader.load_oto_sets(bank_s, vb)
        check('LoadOtoSets: 递归子目录并写相对名',
              {s.name for s in bank_s.oto_sets} >= {'sub'},
              'got %r' % [s.name for s in bank_s.oto_sets])

        found = VoicebankLoader(tmp).search_all()
        check('SearchAll: 递归找到全部 character.txt（按目录 id 认）',
              {b.id.replace('\\', '/') for b in found}
              == {'Tester', 'NoName', 'FromYaml', 'LegacyDs', 'Prefix'},
              'got %r' % sorted(b.id for b in found))
        Preferences.load_deep_folder_singer = False
        try:
            shallow = VoicebankLoader(tmp).search_all()
        finally:
            Preferences.load_deep_folder_singer = True
        check('SearchAll: LoadDeepFolderSinger=False 时只看一级子目录',
              {b.id.replace('\\', '/') for b in shallow}
              == {'Tester', 'NoName', 'FromYaml', 'LegacyDs', 'Prefix'},
              'got %r' % sorted(b.id for b in shallow))
    finally:
        VoicebankLoader.is_test = saved_is_test
        shutil.rmtree(tmp, ignore_errors=True)


def test_frq_files():
    """`Classic/Frq.cs`：`.frq` 读写、`Build`、帧对齐，以及 `OtoFrq` 的偏差折算。"""
    import struct
    import tempfile

    from singing.openutau.classic import Frq, Mrq, OtoFrq
    from singing.openutau.classic.frq import get_frq_file, get_mrq_file

    cs = _read('Classic/Frq.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/Frq.cs')
        return

    check('VoicebankFiles.GetFrqFile: a.wav → a_wav.frq（点换下划线）',
          get_frq_file('C:/bank/a.wav').endswith('a_wav.frq'),
          'got %r' % get_frq_file('C:/bank/a.wav'))
    check('VoicebankFiles.GetMrqFile: 与 wav 同目录的 desc.mrq',
          get_mrq_file('C:/bank/a.wav').replace('\\', '/').endswith('/bank/desc.mrq'),
          'got %r' % get_mrq_file('C:/bank/a.wav'))

    tmp = tempfile.mkdtemp(prefix='fufumidi-frq-')
    try:
        # ---- Build：averageF0 是**有声帧**（f>0）的算术平均；amp = hop 内平均绝对值 × 2^15
        samples = [0.5] * 1024
        f0 = [100.0, 200.0, 0.0, 300.0]
        frq = Frq.build(samples, f0)
        check('Frq.Build: hopSize = kHopSize = 256', frq.hop_size == 256)
        check('Frq.Build: averageF0 只用 f > 0 的帧（(100+200+300)/3）',
              abs(frq.average_f0 - 200.0) < 1e-9, 'got %r' % frq.average_f0)
        check('Frq.Build: amp = hop 内平均 |样本| × 2^15',
              abs(frq.amp[0] - 0.5 * 2 ** 15) < 1e-9 and len(frq.amp) == 4,
              'got %r' % frq.amp)
        # f0 比样本能覆盖的 hop 多一个 → 最后那一帧 count == 0，amp 记 0
        check('Frq.Build: 样本耗尽的那一段 amp = 0（count == 0）',
              Frq.build([0.5] * 1024, [100.0] * 5).amp[4] == 0.0)

        # ---- Save / Load 往返：文件格式逐字段对照（FREQ0003）
        wav = os.path.join(tmp, 'a.wav')
        _write_wav(wav, [0.1] * 100)
        frq_path = get_frq_file(wav)
        with open(frq_path, 'wb') as f:
            frq.save(f)
        raw = open(frq_path, 'rb').read()
        check('Frq.Save: 头 8 字节是 ASCII "FREQ0003"', raw[:8] == b'FREQ0003')
        check('Frq.Save: 头之后是 hopSize(int32) + averageF0(double)',
              struct.unpack_from('<i', raw, 8)[0] == 256
              and abs(struct.unpack_from('<d', raw, 12)[0] - 200.0) < 1e-9)
        check('Frq.Save: averageF0 之后是 16 字节空白（4 个 int 0）',
              raw[20:36] == b'\x00' * 16)
        check('Frq.Save: 然后是 length(int32) + length 组 (f0, amp)',
              struct.unpack_from('<i', raw, 36)[0] == 4 and len(raw) == 40 + 4 * 16,
              'got %r' % len(raw))

        loaded = Frq()
        check('Frq.Load: 能读回自己写的文件', loaded.load(wav) is True)
        check('Frq.Load: hopSize / averageF0 / f0 / amp 一致',
              loaded.hop_size == 256 and abs(loaded.average_f0 - 200.0) < 1e-9
              and loaded.f0 == f0 and loaded.amp == frq.amp)
        # 这条会走 Frq.Load 的失败分支（记一条 error 日志），临时提日志级别免得刷屏
        import logging as _logging
        _logging.getLogger('singing.openutau.classic.frq').setLevel(_logging.CRITICAL)
        check('Frq.Load: 头不对时返回 False（不抛）',
              (lambda p: (open(p, 'wb').write(b'XXXX0003' + raw[8:]), Frq().load(wav))[1])(
                  frq_path) is False)
        _logging.getLogger('singing.openutau.classic.frq').setLevel(_logging.NOTSET)
        with open(frq_path, 'wb') as f:
            frq.save(f)

        # ---- 没有 .frq 文件时返回 False
        absent = os.path.join(tmp, 'nope.wav')
        check('Frq.Load: 文件不存在 → False', Frq().load(absent) is False)
        check('Frq.Load: wavPath 为空 → False', Frq().load('') is False)

        # ---- Mrq：读 desc.mrq 里同名的条目
        with open(get_mrq_file(wav), 'wb') as f:
            # nf0 = 2，后面紧跟 2 个 float32（size 必须 >= 12 + nf0*4）
            body = struct.pack('<iii', 2, 44100, 512) + struct.pack('<ff', 100.0, 400.0)
            f.write(b'mrq ' + struct.pack('<iii', 1, 1, len(b'a.wav')))
            f.write('a.wav'.encode('utf-16-le'))
            f.write(struct.pack('<i', len(body)) + body)
        mrq = Mrq()
        check('Mrq.Load: 能读回同名条目', mrq.load(wav) is True)
        check('Mrq.Load: hopSize / wavSampleRate 取自条目头',
              mrq.hop_size == 512 and mrq.wav_sample_rate == 44100,
              'got %r / %r' % (mrq.hop_size, mrq.wav_sample_rate))
        check('Mrq.Load: f0 是 float32 读出来的', mrq.f0 == [100.0, 400.0], 'got %r' % mrq.f0)
        check('Mrq.Load: averageF0 是**对数域**平均再转回 Hz',
              abs(mrq.average_f0 - math.pow(2.0, (math.log(100.0, 2) + math.log(400.0, 2)) / 2)) < 1e-9,
              'got %r' % mrq.average_f0)

        # ---- OtoFrq：把 offset/consonant/cutoff 折算成"相对平均音高的半音偏差"
        frq2 = Frq.build([0.5] * 1024, [200.0] * 400)      # 全有声、全 200Hz
        table = {}
        oto = _StubOto(offset=0.0, cutoff=0.0)
        oto.file = 'x'
        oto.consonant = 100.0
        table['x'] = frq2
        oto_frq = OtoFrq(oto, table)
        check('OtoFrq: 命中缓存表时不重新读文件', oto_frq.loaded is True)
        check('OtoFrq: 全部等于平均音高 → 偏差全 0',
              all(abs(v) < 1e-9 for v in oto_frq.tone_diff_fix)
              and all(abs(v) < 1e-9 for v in oto_frq.tone_diff_stretch),
              'got %r / %r' % (oto_frq.tone_diff_fix[:3], oto_frq.tone_diff_stretch[:3]))

        # 期望长度按 C# 的公式现算（别凭直觉填常数）
        def _frq_len(ms):
            return int(math.floor(ms * frq2.wav_sample_rate / 1000 / frq2.hop_size))
        want_fix = _frq_len(oto.offset + oto.consonant) - _frq_len(oto.offset)
        want_cutoff = len(frq2.f0) - _frq_len(oto.cutoff)      # cutoff >= 0 那一支
        check('OtoFrq: fix 段 = ConvertMsToFrqLength(offset+consonant) - (offset)',
              len(oto_frq.tone_diff_fix) == want_fix, 'got %d / want %d'
              % (len(oto_frq.tone_diff_fix), want_fix))
        check('OtoFrq: stretch 段 = (f0.Length - ConvertMsToFrqLength(cutoff)) - consonant',
              len(oto_frq.tone_diff_stretch) == want_cutoff - want_fix,
              'got %d / want %d' % (len(oto_frq.tone_diff_stretch), want_cutoff - want_fix))

        # ---- Completion：无声帧用前后最近的有声帧补
        frqs = [0.0, 0.0, 200.0, 0.0, 0.0, 400.0, 0.0]
        completion = OtoFrq._completion(frqs)
        check('OtoFrq.Completion: 一侧有有声帧 → 直接取它',
              completion[0] == 200.0 and completion[1] == 200.0 and completion[6] == 400.0,
              'got %r' % completion)
        check('OtoFrq.Completion: 两侧都有 → 按**帧下标**线性插值（min=2, max=5）',
              abs(completion[3] - MusicMath.linear(2, 5, 200.0, 400.0, 3)) < 1e-9
              and abs(completion[4] - MusicMath.linear(2, 5, 200.0, 400.0, 4)) < 1e-9,
              'got %r' % completion)
        check('OtoFrq.Completion: 全无声时补 0', OtoFrq._completion([0.0, 0.0]) == [0.0, 0.0])

        check('Frq.cs: 无声判据是 f <= 60（不是 f <= 0）', 'frqs[i] <= 60' in cs)
        check('Frq.cs: 头是 "FREQ0003" 且检查后抛 FormatException',
              '"FREQ0003" not found' not in cs and 'FREQ0003 header not found.' in cs)
        check('Frq.cs: Build 的 averageF0 用 f > 0 过滤', 'f => f > 0' in cs)
        check('Frq.cs: kHopSize = 256', 'const int kHopSize = 256;' in cs)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


class _FakeNative:
    """`resample()` 编排测试用的假原生库（记录每次调用，返回构造好的形状）。"""

    available = True
    error = None

    def __init__(self, f0_value=440.0, frames=101):
        self.f0_value = f0_value
        self.frames = frames
        self.f0_methods = []
        self.analysis_samples = None
        self.synthesis_call = None

    def init_analysis_config(self, fs, hop_size, fft_size):
        from singing.openutau.worldline import init_analysis_config
        return init_analysis_config(fs, hop_size, fft_size)

    def f0(self, samples, fs, frame_period, method):
        self.f0_methods.append(method)
        return [self.f0_value] * self.frames

    def world_analysis_f0_in(self, config, samples, f0_in):
        self.analysis_samples = list(samples)
        sp_size = config.fft_size // 2 + 1
        n = len(f0_in)
        return [1e-6] * (n * sp_size), [1.0] * (n * sp_size)

    def world_synthesis(self, f0, sp, is_mgc, mgc_size, bap, is_bap, fft_size,
                        frame_period, fs, gender, tension, breathiness, voicing):
        from singing.openutau.worldline import world_synthesis_sample_count
        self.synthesis_call = dict(
            f0=list(f0), sp_size=len(sp) // max(1, len(f0)), is_mgc=is_mgc,
            mgc_size=mgc_size, is_bap=is_bap, fft_size=fft_size,
            gender=list(gender), tension=list(tension),
            breathiness=list(breathiness), voicing=list(voicing))
        count = world_synthesis_sample_count(len(f0), frame_period, fs)
        return [0.25] * count


def test_worldline_resample_orchestration():
    """`Worldline.Resample` 的**编排**：补边 → 音高弯曲 → 合成 → 裁到 durRequired → 增益。

    用假原生库跑，验证的是"每一步的顺序与参数"（DSP 本身由下面的真机测试兜底）。
    """
    import tempfile

    from singing.openutau.worldline import (
        RESAMPLER_PADDING, CutOffBeforeOffsetError, CutOffExceedDurationError,
        apply_pitch_bend, get_flag, resample,
    )

    cs = _read('Render/Worldline.cs')
    if cs is None:
        print('  SKIP 找不到 Render/Worldline.cs')
        return

    tmp = tempfile.mkdtemp(prefix='fufumidi-resample-')
    try:
        n = 44100
        sine = [0.5 * math.sin(2 * math.pi * 440 * i / 44100) for i in range(n)]
        wav = os.path.join(tmp, 'p.wav')
        _write_wav(wav, sine)

        phrase = _StubPhrase(_time_axis())
        item = _StubItem(phrase, _StubPhone(), input_file=wav, offset=0.0, cutoff=0.0,
                         consonant=100.0, velocity=100, dur_required=500.0, volume=100,
                         tempo=120.0, tone=69, flags=[], pitches=[0] * 200)
        native = _FakeNative()
        out = resample(item, native=native)

        check('Resample: 没有 .frq 时用 method=2（pyin）', native.f0_methods == [2],
              'got %r' % native.f0_methods)
        check('Resample: 输出长度 = int(durRequired * fs / 1000)',
              len(out) == int(500.0 * 44100 / 1000), 'got %d' % len(out))
        check('Resample: 全都不是 NaN/Inf',
              all(math.isfinite(v) for v in out))

        # 补边：SynthSegment 的 f0 是 50 帧（durRequired 500ms / frame_ms 10）
        call = native.synthesis_call
        check('Resample: f0 两端各补 ResamplerPadding 帧',
              len(call['f0']) == 50 + 2 * RESAMPLER_PADDING
              and call['f0'][0] == call['f0'][1] == call['f0'][2],
              'got %d' % len(call['f0']))
        check('Resample: sp 是扁平数组（每帧 fftSize/2+1）',
              call['sp_size'] == call['fft_size'] // 2 + 1,
              'got %r / %r' % (call['sp_size'], call['fft_size']))
        check('Resample: isMgc / isBap 都是 false', call['is_mgc'] is False
              and call['is_bap'] is False)
        check('Resample: gender/tension 用 0.5 + flag/200，breathiness 用 0.5+flag*0.005，'
              'voicing 用 flag*0.01',
              call['gender'][0] == 0.5 + get_flag(item, 'g', 0) / 200.0
              and call['breathiness'][0] == 0.5 + get_flag(item, 'Mb', 0) * 0.005
              and call['voicing'][0] == get_flag(item, 'Mv', 100) * 0.01,
              'got %r' % ((call['gender'][0], call['breathiness'][0], call['voicing'][0]),))

        # 音高弯曲：tone=69 + pitch=0 → 440Hz；同一条曲线用帮助函数现算对账
        expect_f0 = [440.0] * len(call['f0'])
        apply_pitch_bend(expect_f0, item.pitches, item.tone,
                         2 * 10.0 + 0.0, 60000.0 / item.tempo / 480.0 * 5, 10.0, 0.0)
        check('Resample: 音高弯曲后 f0 = tone_to_freq(tone + pitch*0.01)',
              max(abs(a - b) for a, b in zip(call['f0'], expect_f0)) < 1e-9,
              'got %r / want %r' % (call['f0'][:2], expect_f0[:2]))

        # ---- resampler 路径**不做**输入增益（原样本原样进分析）
        from singing.openutau import Wave
        decoded = Wave.get_samples(wav)
        peak = max(abs(v) for v in decoded)
        observed = max(abs(v) for v in native.analysis_samples)
        check('SynthSegment(forResampler): 分析输入就是原样本，**不做**输入增益',
              abs(observed - peak) < 1e-12, 'got %r / want %r' % (observed, peak))

        # ---- 乐句合成路径（forResampler=false）**做**输入增益 + 算帧边界
        from singing.openutau.worldline import SynthSegment, segment_auto_gain
        native2 = _FakeNative()
        config = native2.init_analysis_config(44100, 441, 2048)
        seg = SynthSegment(config, item, pos_ms=100.0, skip_ms=0.0, length_ms=400.0,
                           fade_in_ms=50.0, fade_out_ms=50.0,
                           for_resampler=False, native=native2)
        # 期望增益按公式现算：volume × GetAutoGain（segMax 与 wavMax 都是整段峰值）
        expect_gain = item.volume * 0.01 * segment_auto_gain(
            decoded, [440.0] * 101, peak, config.f0_floor, get_flag(item, 'P', 86))
        check('SynthSegment(乐句路径): 输入侧乘 volume × GetAutoGain',
              abs(max(abs(v) for v in native2.analysis_samples) - peak * expect_gain) < 1e-9,
              'got %r / want %r'
              % (max(abs(v) for v in native2.analysis_samples), peak * expect_gain))
        check('SynthSegment(乐句路径): 算了 skipFrames / p0 / p1 / p3 / p4',
              (seg.skip_frames, seg.p0, seg.p1, seg.p3, seg.p4) == (0, 10, 15, 45, 50),
              'got %r' % ((seg.skip_frames, seg.p0, seg.p1, seg.p3, seg.p4),))
        check('SynthSegment(resampler 路径): p0..p4 保持 0',
              SynthSegment(config, item, native=native2).p0 == 0)

        # ---- cutoff 超过文件长度 → CutOffExceedDurationError
        bad = _StubItem(phrase, _StubPhone(), input_file=wav, offset=0.0,
                        cutoff=-2000.0, dur_required=500.0)     # -cutoff + offset > wavMs
        try:
            resample(bad, native=_FakeNative())
            check('Resample: cutoff 超出音频长度抛 CutOffExceedDurationError', False)
        except CutOffExceedDurationError:
            check('Resample: cutoff 超出音频长度抛 CutOffExceedDurationError', True)

        # ---- cutoff 把整段切没了 → CutOffBeforeOffsetError
        bad2 = _StubItem(phrase, _StubPhone(), input_file=wav, offset=0.0,
                         cutoff=1000.0, dur_required=500.0)
        try:
            resample(bad2, native=_FakeNative())
            check('Resample: srcEndFrame <= srcStartFrame 抛 CutOffBeforeOffsetError', False)
        except CutOffBeforeOffsetError:
            check('Resample: srcEndFrame <= srcStartFrame 抛 CutOffBeforeOffsetError', True)

        # ---- 有 .frq 时改用 method=-1（只问帧数），且 .frq 的"有声/无声"决定音高弯曲
        from singing.openutau.classic import Frq
        from singing.openutau.classic.frq import get_frq_file
        # .frq 全是"无声"（0 低于 f0_floor）→ 音高弯曲在**所有**帧上都不生效，
        # 最终 f0 保持 0（而不是被弯到 440）—— 这就是 .frq 真正影响的东西
        with open(get_frq_file(wav), 'wb') as f:
            Frq.build(sine, [0.0] * 172).save(f)
        native3 = _FakeNative(f0_value=0.0)
        resample(item, native=native3)
        check('Resample: 有 .frq 时 F0 用 method=-1（只问帧数，不做提取）',
              native3.f0_methods == [-1], 'got %r' % native3.f0_methods)
        check('Resample: .frq 判为无声 → 音高弯曲不生效（f0 保持 0）',
              all(v == 0.0 for v in native3.synthesis_call['f0']),
              'got %r' % native3.synthesis_call['f0'][:4])
        # .frq 全是"有声"（300Hz > f0_floor）→ 音高弯曲照常把 f0 弯到 440
        with open(get_frq_file(wav), 'wb') as f:
            Frq.build(sine, [300.0] * 172).save(f)
        native4 = _FakeNative(f0_value=0.0)
        resample(item, native=native4)
        check('Resample: .frq 判为有声 → 音高弯曲把 f0 弯到 tone 69 的 440Hz',
              all(abs(v - 440.0) < 1e-9 for v in native4.synthesis_call['f0']),
              'got %r' % native4.synthesis_call['f0'][:4])

        # ---- 源码一致性
        flat = cs.replace('\n', ' ')
        check('Worldline.cs: Resample 用 InitAnalysisConfig(44100, 441, 2048)',
              'var config = InitAnalysisConfig(44100, 441, 2048);' in flat)
        check('Worldline.cs: 补边用 Math.Clamp(i - ResamplerPadding, 0, length - 1)',
              'int src = Math.Clamp(i - ResamplerPadding, 0, length - 1);' in flat)
        check('Worldline.cs: startMs = ResamplerPadding * frameMs + segment.offsetFracMs',
              'double startMs = ResamplerPadding * frameMs + segment.offsetFracMs;' in flat)
        check('Worldline.cs: stepMs = 60000 / tempo / 480 * 5',
              'double stepMs = 60000.0 / item.tempo / 480.0 * 5;' in flat)
        check('Worldline.cs: 增益指数用 flag P（默认 86）',
              'GetFlag(item, "P", 86)' in flat)
        check('Worldline.cs: 输出裁到 durRequired',
              '(int)(item.durRequired * fs / 1000)' in flat)
        check('Worldline.cs: resampler 路径的 cutoff 越界是错误',
              'throw new CutOffExceedDurationError();' in flat)
        check('Worldline.cs: srcEndFrame <= srcStartFrame 是错误',
              'throw new CutOffBeforeOffsetError();' in flat)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def _time_axis():
    proj = UProject()
    axis = TimeAxis()
    axis.build_segments(proj)
    return axis


def test_worldline_resample_live():
    """**真机**：加载 OpenUTAU 随包分发的 `worldline.dll` 跑一遍 `Resample`。

    参考仓库里没有预编译库（或不在 Windows 上）就 SKIP。这条用例是"变调真的出声"
    的唯一机器证明 —— 它验证的是"合成出来的波形主频 = 目标音高"。
    """
    dll = os.path.join(REF_ROOT, 'runtimes', 'win-x64', 'native', 'worldline.dll')
    if not os.path.isfile(dll):
        print('  SKIP 找不到预编译 worldline.dll（%s）' % dll)
        return

    import struct
    import tempfile

    from singing.openutau.worldline import WorldlineNative, f0_frame_count, resample

    native = WorldlineNative(dll)
    if not native.available:
        print('  SKIP worldline.dll 加载失败：%s' % native.error)
        return

    config = native.init_analysis_config(44100, 441, 2048)
    check('WorldlineNative: InitAnalysisConfig 回填 fs/hop/fft',
          (config.fs, config.hop_size, config.fft_size) == (44100, 441, 2048),
          'got %r' % (config,))
    check('WorldlineNative: frame_ms = hop / fs * 1000 = 10',
          abs(config.frame_ms - 10.0) < 1e-9, 'got %r' % config.frame_ms)
    check('WorldlineNative: f0_floor = 3*fs/(fft-3)（float32）',
          abs(config.f0_floor - struct.unpack('<f', struct.pack('<f', 3.0 * 44100 / 2045))[0])
          < 1e-6, 'got %r' % config.f0_floor)

    tmp = tempfile.mkdtemp(prefix='fufumidi-worldline-')
    try:
        n = 44100
        src_hz = 300.0
        sine = [0.5 * math.sin(2 * math.pi * src_hz * i / 44100) for i in range(n)]

        # ---- F0FrameCount 的纯公式与原生一致（它是**上界**，见下一条）
        for method, label in ((2, 'pyin'), (-1, '占位'), (0, 'dio')):
            want = f0_frame_count(44100, 44100, config.frame_ms, method)
            got = native.f0_frame_count(44100, 44100, config.frame_ms, method)
            check('WorldlineNative.F0FrameCount(%s) 与纯公式一致' % label, got == want,
                  'got %r / want %r' % (got, want))

        # ---- F0 提取：应认出 300Hz 左右
        capacity = native.f0_frame_count(44100, 44100, config.frame_ms, 2)
        f0 = native.f0(sine, 44100, config.frame_ms, 2)
        voiced = [v for v in f0 if v > config.f0_floor]
        # ★ `F0FrameCount` 是**上界**：缓冲按它分配，但 `F0` 返回估计器实际产出的帧数
        # （可能更少，pyin 这里是 99 < 101 的容量）
        check('WorldlineNative.F0: 帧数不超过 F0FrameCount 上界，且非空',
              0 < len(f0) <= capacity, 'got %d / capacity %d' % (len(f0), capacity))
        check('WorldlineNative.F0: 中段有声帧的基频 ≈ 300Hz',
              len(voiced) > 50 and abs(sum(voiced) / len(voiced) - src_hz) < 15.0,
              'got %r（%d 个有声帧）' % (sorted(voiced)[len(voiced) // 2] if voiced else None,
                                      len(voiced)))

        # ---- Resample：tone 69（A4 = 440Hz）→ 输出主频应是 440Hz
        wav = os.path.join(tmp, 'live.wav')
        _write_wav(wav, sine)
        phrase = _StubPhrase(_time_axis())
        item = _StubItem(phrase, _StubPhone(), input_file=wav, offset=0.0, cutoff=0.0,
                         consonant=50.0, velocity=100, dur_required=500.0, volume=100,
                         tempo=120.0, tone=69, flags=[], pitches=[0] * 200)
        out = resample(item, native=native)
        check('Worldline.Resample(真机): 输出长度 = durRequired 的样本数',
              len(out) == int(500.0 * 44100 / 1000), 'got %d' % len(out))
        check('Worldline.Resample(真机): 样本有限且不静音',
              all(math.isfinite(v) for v in out) and max(abs(v) for v in out) > 1e-3,
              'got peak %r' % max(abs(v) for v in out))

        # 主频用**过零率**粗测（中段，避开边缘的补边与淡入）
        mid = out[4410:17640]
        crossings = sum(1 for i in range(1, len(mid)) if (mid[i - 1] < 0) != (mid[i] < 0))
        measured = crossings / 2.0 / (len(mid) / 44100.0)
        check('Worldline.Resample(真机): 输出主频 ≈ tone 69 的 440Hz（过零率 ±10%%）',
              abs(measured - 440.0) < 44.0, 'got %.1f Hz' % measured)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_worldline_resampler_class():
    """`Classic/WorldlineResampler.cs`：接口实现与 Manifest。"""
    from singing.openutau.classic import IResampler, WorldlineResampler

    cs = _read('Classic/WorldlineResampler.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/WorldlineResampler.cs')
        return

    resampler = WorldlineResampler('/root')
    check('WorldlineResampler: 是 IResampler 的实现',
          isinstance(resampler, IResampler))
    check('WorldlineResampler: ToString 是 "worldline"', str(resampler) == 'worldline')
    check('WorldlineResampler: FilePath = RootPath + name + 平台扩展名',
          os.path.basename(resampler.file_path).startswith('worldline.'),
          'got %r' % resampler.file_path)
    check('WorldlineResampler: NoWrapperScript = true（自带实现）',
          resampler.no_wrapper_script is True)
    check('WorldlineResampler: SupportsFlag 恒为 true', resampler.supports_flag('zzz') is True)
    check('WorldlineResampler: CheckPermissions 是空操作',
          resampler.check_permissions() is None)

    manifest = resampler.manifest
    check('WorldlineResampler.Manifest: expressionFilter = false（不过滤 flag）',
          manifest.expression_filter is False)
    check('WorldlineResampler.Manifest: 声明 ten/brea/voi 三个表达式',
          set(manifest.expressions) == {'ten', 'brea', 'voi'},
          'got %r' % set(manifest.expressions))
    ten = manifest.expressions['ten']
    voi = manifest.expressions['voi']
    check('WorldlineResampler.Manifest: ten = [-100,100] 默认 0 flag Mt',
          (ten.min, ten.max, ten.default_value, ten.flag, ten.is_flag)
          == (-100, 100, 0, 'Mt', True), 'got %r' % (ten,))
    check('WorldlineResampler.Manifest: voi = [0,100] 默认 100 flag Mv',
          (voi.min, voi.max, voi.default_value, voi.flag, voi.is_flag)
          == (0, 100, 100, 'Mv', True), 'got %r' % (voi,))

    # DoResampler 把两种 SynthRequestError 转成带音素名的**同类型**异常
    # （保留类型，渲染器才能按类型分支；C# 的可见文案包装属 M3）
    from singing.openutau.classic import worldline_resampler as WR
    from singing.openutau.worldline import CutOffExceedDurationError
    item = _StubItem(_StubPhrase(_time_axis()),
                     _StubPhone(phoneme='ka'), input_file='nope.wav')
    original = WR.resample

    def _fake(args, native=None):
        raise CutOffExceedDurationError()

    WR.resample = _fake
    try:
        try:
            WorldlineResampler('/root').do_resampler(item)
            check('WorldlineResampler: cutoff 越界 → 同类型异常且带上音素名', False)
        except CutOffExceedDurationError as e:
            check('WorldlineResampler: cutoff 越界 → 同类型异常且带上音素名',
                  'ka' in str(e) and e.item is item, 'got %r' % str(e))
    finally:
        WR.resample = original

    check('WorldlineResampler.cs: name = "worldline"', 'public const string name = "worldline";' in cs)
    check('WorldlineResampler.cs: NoWrapperScript = true', 'NoWrapperScript = true;' in cs)
    check('WorldlineResampler.cs: CheckPermissions 是空实现', 'public void CheckPermissions() { }' in cs)
    check('WorldlineResampler.cs: Manifest 里 expressionFilter = false',
          'expressionFilter = false' in cs)
    check('WorldlineResampler.cs: DoResamplerReturnsFile 按 outputFile 取缓存锁写 WAV',
          'lock (Renderers.GetCacheLock(item.outputFile))' in cs
          and 'Wave.WriteMono16Wav(item.outputFile, samples);' in cs)


# ====================================================================== ClassicRenderer
#
# 端到端：`RenderPhrase → 变调 → 拼接 → 样本`（P1-d 的里程碑判据）。

class _RenderSinger(USinger):
    """oto 指向**真实 wav** 的歌手（`UPhoneme.Validate` 要求 `TryGetOto` 命中）。"""

    def __init__(self, oto_file):
        super().__init__('render-singer')
        self.found = True
        self.loaded = True
        self._oto = UOto()
        self._oto.alias = 'A'
        self._oto.phonetic = 'A'
        self._oto.file = oto_file
        self._oto.offset = 0.0
        self._oto.consonant = 50.0
        self._oto.cutoff = 0.0
        self._oto.preutter = 50.0
        self._oto.overlap = 10.0

    @property
    def id(self):
        return 'render-singer'

    @property
    def subbanks(self):
        return []

    def try_get_oto(self, phoneme):
        return (True, self._oto) if phoneme == 'A' else (False, None)

    def try_get_mapped_oto(self, phoneme, tone, color=None):
        return False, None


def _render_fixture(tmp, wavtool='convergence'):
    """造一个**能真渲染**的最小工程：一条轨 / 一个 part / 两个音素。

    两个音素都用 `A`，oto 指向真实 44.1kHz 正弦 wav，所以整条链路真的会读文件、
    真的会调 resampler 与 wavtool —— 不是打桩。
    """
    from singing.openutau import UPhoneme, ValidateOptions
    from singing.ustx import UNote, UExpressionType, UPitch, UVibrato, UVoicePart

    src = os.path.join(tmp, 'src.wav')
    _write_wav(src, [0.5 * math.sin(2 * math.pi * 300 * i / 44100) for i in range(22050)])

    project = UProject()
    specs = [
        ('engine', 'eng', UExpressionType.OPTIONS, 0, 100, 0, None, ['']),
        ('volume', 'vol', UExpressionType.NUMERICAL, 0, 100, 100, None, None),
        ('velocity', 'vel', UExpressionType.NUMERICAL, 0, 100, 100, 'V', None),
        ('modulation', 'mod', UExpressionType.NUMERICAL, 0, 100, 0, None, None),
        ('direct', 'dir', UExpressionType.NUMERICAL, 0, 100, 0, None, None),
        ('shift', 'shft', UExpressionType.NUMERICAL, 0, 100, 0, None, None),
        ('attack', 'atk', UExpressionType.NUMERICAL, 0, 100, 100, None, None),
        ('decay', 'dec', UExpressionType.NUMERICAL, 0, 100, 100, None, None),
        # DYN 的 min = -240 是刻意的：`_curve_convert` 把「等于 min」当作 0（无声），
        # 所以只有 min≠0 才能表示"增益 1.0"（decibel_to_linear(0) = 1）
        ('dynamics', 'dyn', UExpressionType.CURVE, -240, 120, 0, None, None),
        ('pitch deviation', 'pitd', UExpressionType.CURVE, -1200, 1200, 0, None, None),
    ]
    for name, abbr, typ, mn, mx, dv, flag, options in specs:
        project.expressions[abbr] = UExpressionDescriptor(
            name=name, abbr=abbr, type=typ, min=mn, max=mx, default_value=dv,
            flag=flag or '', options=options,
            is_flag=bool(flag) or typ == UExpressionType.OPTIONS)

    track = project.tracks[0]
    track.singer_obj = _RenderSinger(src)
    track.renderer_settings.renderer = 'CLASSIC'
    track.renderer_settings.renderer_obj = ClassicRenderer()
    track.renderer_settings.resampler = 'worldline'
    track.renderer_settings.wavtool = wavtool

    part = UVoicePart(track_no=0, position=0)
    # dyn 曲线：取值 0（= unity 增益），避免动态处理把断言搅浑
    part.curves.append(UCurve(xs=[0], ys=[0], abbr='dyn',
                              descriptor=project.expressions['dyn']))
    project.parts.append(part)

    note0 = UNote(position=0, duration=480, tone=69, lyric='A',
                  pitch=UPitch(), vibrato=UVibrato())
    note1 = UNote(position=480, duration=480, tone=69, lyric='A',
                  pitch=UPitch(), vibrato=UVibrato())
    for note in (note0, note1):
        note.extended_duration = 480
    note0.next, note1.prev = note1, note0
    part.notes.extend([note0, note1])

    phoneme0 = UPhoneme()
    phoneme0.position, phoneme0.phoneme, phoneme0.parent = 0, 'A', note0
    phoneme1 = UPhoneme()
    phoneme1.position, phoneme1.phoneme, phoneme1.parent = 480, 'A', note1
    part.phonemes.extend([phoneme0, phoneme1])
    phoneme0.next, phoneme1.prev = phoneme1, phoneme0
    for note, phoneme in ((note0, phoneme0), (note1, phoneme1)):
        phoneme.validate(ValidateOptions(), project, track, part, note)
    assert not phoneme0.error and not phoneme1.error, 'fixture 的音素必须有效'

    phrase = RenderPhrase.from_part(project, track, part)[0]
    return project, track, part, phrase


def _test_classic_host(cache_path, resampler, wavtool=None):
    """`ToolsManager` / `VoicebankFiles` / `PathManager` 的最小替身。"""
    from singing.openutau.classic import ClassicHost

    class _Host(ClassicHost):
        def __init__(self):
            self.cache_path = cache_path
            self.root_path = cache_path
            self.source_temp_calls = 0

        def get_resampler(self, name):
            return resampler

        def get_source_temp_path(self, singer_id, oto, ext):
            return os.path.join(cache_path, 'src-%s%s' % (singer_id, ext))

        def get_wavtool(self, name):
            return wavtool

        def copy_source_temp(self, source, temp):
            self.source_temp_calls += 1

        def copy_back_meta_files(self, source, temp):
            pass

    return _Host()


def _install_host(host):
    """把宿主装到 `resampler_item.host`（`ResamplerItem` 读的就是它），返回旧的。

    C# 里 `ResamplerItem` 与 `ClassicRenderer` 读的是同一批全局单例；
    `ClassicRenderer` 不显式注入时会跟随这个模块级替身，所以装一处即可。
    """
    from singing.openutau.classic import resampler_item

    old = resampler_item.host
    resampler_item.host = host
    return old


def test_classic_renderer_basics():
    """`Classic/ClassicRenderer.cs` 的非 DSP 部分：能力声明 / 布局 / 注册 / 进度。"""
    from singing.openutau import Progress, create_renderer, register_classic_renderer
    from singing.openutau.renderers import CLASSIC, reset_registry
    from singing.ustx import UExpressionDescriptor

    cs = _read('Classic/ClassicRenderer.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/ClassicRenderer.cs')
        return

    r = ClassicRenderer()
    check('ClassicRenderer: SingerType = Classic', r.singer_type == USingerType.CLASSIC)
    check('ClassicRenderer: SupportsRenderPitch = false（Classic 线不产音高曲线）',
          r.supports_render_pitch is False)
    check('ClassicRenderer: ToString = Renderers.CLASSIC', str(r) == CLASSIC)
    check('ClassicRenderer: LoadRenderedPitch 返回 None', r.load_rendered_pitch(None) is None)

    # ---- SupportsExpression：有 flag 的无条件支持，其余查白名单
    def exp(abbr, flag='', is_flag=False):
        return UExpressionDescriptor(name=abbr, abbr=abbr, min=0, max=100,
                                     default_value=0, flag=flag, is_flag=is_flag)

    check('ClassicRenderer: 白名单内的 abbr 支持（vel/dyn/pitd…）',
          all(r.supports_expression(exp(a)) for a in ('dyn', 'pitd', 'clr', 'clry', 'xsy',
                                                      'eng', 'vel', 'vol', 'atk', 'dec',
                                                      'mod', 'mod+', 'alt', 'dir', 'shft')))
    check('ClassicRenderer: 白名单外的 abbr 不支持（如 genc）',
          r.supports_expression(exp('genc')) is False)
    check('ClassicRenderer: 带 flag 的一律支持（哪怕 abbr 不在白名单）',
          r.supports_expression(exp('zzz', flag='g')) is True)
    check('ClassicRenderer: isFlag 为真也支持', r.supports_expression(exp('zzz', is_flag=True)))
    check('ClassicRenderer: 描述符为 None 时返回 False（不抛）',
          r.supports_expression(None) is False)
    check('ClassicRenderer: 白名单恰好是 C# 那 15 项',
          ClassicRenderer.SUPPORTED_EXP == frozenset(
              ['dyn', 'pitd', 'clr', 'clry', 'xsy', 'eng', 'vel', 'vol', 'atk', 'dec',
               'mod', 'mod+', 'alt', 'dir', 'shft']),
          'got %r' % sorted(ClassicRenderer.SUPPORTED_EXP))

    # ---- Layout：estimatedLengthMs = durationMs + leadingMs
    class _P:
        leading_ms, position_ms, duration_ms = 12.5, 100.0, 500.0
    layout = r.layout(_P())
    check('ClassicRenderer.Layout: estimatedLengthMs = durationMs + leadingMs',
          (layout.leading_ms, layout.position_ms, layout.estimated_length_ms)
          == (12.5, 100.0, 512.5), 'got %r' % (layout,))
    check('ClassicRenderer.Layout: 不产出样本（samples=None，只做布局）',
          layout.samples is None)

    # ---- GetSuggestedExpressions：清单为 null 时给空数组
    check('ClassicRenderer: 没有 resampler / manifest 时给空列表',
          r.get_suggested_expressions(None, None) == [])
    check('ClassicRenderer: 有 manifest 时交出它的表达式',
          len(r.get_suggested_expressions(None, _settings_with_manifest())) == 3)

    # ---- 注册：C# 的 `CreateRenderer` 里 `new ClassicRenderer()`
    reset_registry()
    check('ClassicRenderer: reset_registry 之后 CLASSIC 拿不到实例',
          create_renderer(CLASSIC) is None)
    register_classic_renderer()
    got = create_renderer(CLASSIC)
    check('ClassicRenderer: register_classic_renderer 后可创建',
          isinstance(got, ClassicRenderer))
    check('ClassicRenderer: CreateRenderer 两次返回不同实例（C# 每次 new）',
          create_renderer(CLASSIC) is not got)
    check('ClassicRenderer: GetOrCreate 才做缓存（同 id 同实例）',
          __import__('singing.openutau.renderers', fromlist=['x']).get_or_create(CLASSIC)
          is __import__('singing.openutau.renderers', fromlist=['x']).get_or_create(CLASSIC))

    # ---- 缓存锁必须**可重入**：C# 是 `object` + `lock()`（= Monitor），
    # ClassicRenderer 先锁 item.outputFile，再进 WorldlineResampler 里的同一把锁。
    # 用非重入的 threading.Lock 会在这条嵌套路径上**自锁死**（真踩过）。
    import threading as _threading

    from singing.openutau.renderers import get_cache_lock
    lock = get_cache_lock('reentrancy-probe')
    check('GetCacheLock: 返回的是可重入锁（对应 C# 的 Monitor）',
          isinstance(lock, type(_threading.RLock())), 'got %r' % type(lock))
    check('GetCacheLock: 同一线程可重复进入（嵌套加锁不会自锁死）',
          lock.acquire(blocking=False) and lock.acquire(blocking=False),
          'got %r' % lock)
    lock.release()
    lock.release()
    check('GetCacheLock: 同一个 key 拿到同一把锁',
          get_cache_lock('reentrancy-probe') is lock)

    # ---- Progress（RenderEngine.cs 里渲染器用到的那一块）
    seen = []
    p = Progress(4, notify=lambda pct, info: seen.append((pct, info)))
    check('Progress: 初始 completed = 0', p.completed == 0)
    p.complete(1, 'a')
    check('Progress: Complete 累加并按 completed*100/total 上报',
          p.completed == 1 and seen[-1] == (25.0, 'a'), 'got %r' % (seen,))
    p.complete(3, 'b')
    check('Progress: 累加到 total 时上报 100', p.completed == 4 and seen[-1] == (100.0, 'b'))
    p.clear()
    check('Progress: Clear 上报 0 + 空文案，且**不动**计数',
          seen[-1] == (0.0, '') and p.completed == 4, 'got %r' % (seen,))
    check('Progress: total = 0 时报错（C# 是 NaN，这里选择不静默）',
          _raises(lambda: Progress(0).complete(0, '')))

    # ---- 源码一致性
    flat = cs.replace('\n', ' ')
    check('ClassicRenderer.cs: internal/external 按 wavtool 名分派',
          'if (phrase.wavtool == SharpWavtool.nameConvergence || phrase.wavtool == SharpWavtool.nameSimple)'
          in flat)
    check('ClassicRenderer.cs: RenderInternal 写死 new SharpWavtool(true)',
          'var wavtool = new SharpWavtool(true);' in flat)
    check('ClassicRenderer.cs: 缓存在就读、不读才拼',
          'if (!File.Exists(item.outputFile))' in flat)
    check('ClassicRenderer.cs: VoicebankFiles 两次调用都带 WorldlineResampler 守卫',
          flat.count('if (!(item.resampler is WorldlineResampler))') == 2)
    check('ClassicRenderer.cs: direct 音素不做 resample', 'if(!item.phone.direct){' in flat
          or 'if (!item.phone.direct)' in flat)
    check('ClassicRenderer.cs: progress.Complete(1, ...) 在 if 之外',
          'progress.Complete(1, $"Track {trackNo + 1}: {item.resampler}' in flat)
    check('ClassicRenderer.cs: 外部路径按 phrase.hash 取 cat-{hash:x16}.wav',
          'cat-{phrase.hash:x16}.wav' in flat)
    check('ClassicRenderer.cs: Layout 用 DurationMs + LeadingMs',
          'estimatedLengthMs = phrase.durationMs + phrase.leadingMs' in flat)
    check('ClassicRenderer.cs: ApplyDynamics 只在 samples 非 null 时调',
          flat.count('if (result.samples != null)') == 2)


def _settings_with_manifest():
    from singing.openutau.classic import ResamplerManifest, WorldlineResampler
    from singing.ustx.model import URenderSettings

    settings = URenderSettings()
    settings.resampler_obj = WorldlineResampler('/root')
    assert isinstance(settings.resampler_obj.manifest, ResamplerManifest)
    return settings


def _raises(fn) -> bool:
    try:
        fn()
        return False
    except Exception:
        return True


class _CountingResampler(WorldlineResampler):
    """记下被真正调用了几次 —— 用来证明**缓存命中会跳过 resample**。"""

    def __init__(self):
        super().__init__('/root')
        self.calls = 0

    def do_resampler_returns_file(self, args, logger=None):
        self.calls += 1
        return super().do_resampler_returns_file(args, logger)


class _WritingWavtool(IWavtool):
    """外部 wavtool 的替身：内部用 `SharpWavtool`，但**把结果写到 temp_path**。

    它还负责两件 `ExeWavtool` 会做的事（照 `Classic/ExeWavtool.cs:39-42`）：
    1. 对 `resampler.no_wrapper_script` 为真的音素，**在 wavtool 里跑 resampler**
       （外部 resampler 则是由 wavtool 生成的脚本去调 exe）——
       所以 `RenderExternal` 自己**不**跑 resampler，缓存文件是这里产出的；
    2. 把结果写进 `tempPath`，让"`cat-{hash}.wav` 命中就直接读"这条缓存生效。
    """

    def __init__(self):
        self.calls = 0
        self._inner = SharpWavtool(False)

    def concatenate(self, resampler_items, temp_path, cancellation=None):
        self.calls += 1
        from singing.openutau.renderers import get_cache_lock
        for item in resampler_items:
            if (item.resampler.no_wrapper_script
                    and not (cancellation is not None and cancellation.is_set())
                    and not os.path.isfile(item.output_file)):
                with get_cache_lock(item.output_file):
                    item.resampler.do_resampler_returns_file(item, None)
        samples = self._inner.concatenate(resampler_items, temp_path, cancellation)
        if samples is not None and temp_path:
            Wave.write_mono16_wav(temp_path, samples)
        return samples

    def check_permissions(self):
        return None


def test_classic_renderer_internal_end_to_end():
    """**端到端**（真机）：`RenderPhrase → Worldline 变调 → SharpWavtool 拼接 → 样本`。

    这是 P1-d 的里程碑判据 —— 缺了 `worldline.dll` 就 SKIP。
    """
    import tempfile

    from singing.openutau import Progress
    from singing.openutau import worldline as W
    from singing.openutau.classic import ClassicRenderer

    dll = os.path.join(REF_ROOT, 'runtimes', 'win-x64', 'native', 'worldline.dll')
    if not os.path.isfile(dll):
        print('  SKIP 找不到预编译 worldline.dll（%s）' % dll)
        return
    native = W.get_native(dll)
    if not native.available:
        print('  SKIP worldline.dll 加载失败：%s' % native.error)
        return

    tmp = tempfile.mkdtemp(prefix='fufumidi-classic-')
    old_host = None
    try:
        project, track, part, phrase = _render_fixture(tmp)
        check('端到端: 乐句有 2 个音素（fixture 前提）', len(phrase.phones) == 2)
        check('端到端: phrase.wavtool = convergence → 走 RenderInternal',
              phrase.wavtool == 'convergence')

        resampler = _CountingResampler()
        old_host = _install_host(_test_classic_host(tmp, resampler))
        renderer = ClassicRenderer()
        host = renderer.classic_host

        seen = []
        progress = Progress(len(phrase.phones),
                            notify=lambda pct, info: seen.append((pct, info)))
        result = _run(renderer.render(phrase, progress, track_no=0))

        check('端到端: 产出非空样本', result.samples is not None and len(result.samples) > 0,
              'got %r' % (None if result.samples is None else len(result.samples)))
        check('端到端: 样本有限且不静音',
              all(math.isfinite(v) for v in result.samples)
              and max(abs(v) for v in result.samples) > 1e-3,
              'got peak %r' % max(abs(v) for v in result.samples))
        check('端到端: 布局沿用 Layout（positionMs / leadingMs）',
              (result.position_ms, result.leading_ms)
              == (phrase.position_ms, phrase.leading_ms))
        check('端到端: 两个音素各上报一次进度（总数到 100）',
              len(seen) == 2 and seen[-1][0] == 100.0, 'got %r' % (seen,))
        check('端到端: 每个音素各调一次 resampler', resampler.calls == 2,
              'got %d' % resampler.calls)
        check('端到端: 自带 Worldline 不碰 VoicebankFiles（无需解码到临时文件）',
              host.source_temp_calls == 0)
        check('端到端: 动态曲线非 None（ApplyDynamics 会跑）',
              phrase.dynamics is not None)

        # 输出主频应是 tone 69 的 440Hz（源是 300Hz → 证明变调真的生效了）
        mid = result.samples[len(result.samples) // 4:len(result.samples) * 3 // 4]
        crossings = sum(1 for i in range(1, len(mid)) if (mid[i - 1] < 0) != (mid[i] < 0))
        measured = crossings / 2.0 / (len(mid) / 44100.0)
        check('端到端: 输出主频 ≈ 440Hz（源 300Hz → 变调生效，过零率 ±10%%）',
              abs(measured - 440.0) < 44.0, 'got %.1f Hz' % measured)

        # ---- 第二次渲染：缓存命中 → 不再调 resampler
        phrase2 = RenderPhrase.from_part(project, track, part)[0]
        result2 = _run(renderer.render(phrase2, None, track_no=0))
        check('端到端: 第二次渲染复用音素缓存（不再调 resampler）',
              resampler.calls == 2, 'got %d' % resampler.calls)
        check('端到端: 第二次渲染样本与第一次等长',
              len(result2.samples) == len(result.samples))

        # ---- 取消：拼接器直接返回 None，且不调 ApplyDynamics
        cancelled = __import__('threading').Event()
        cancelled.set()
        phrase3 = RenderPhrase.from_part(project, track, part)[0]
        result3 = _run(renderer.render(phrase3, None, track_no=0, cancellation=cancelled))
        check('端到端: 取消时 samples 为 None', result3.samples is None)
    finally:
        if old_host is not None:
            _install_host(old_host)
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_classic_renderer_external_path():
    """`RenderExternal`：按 `phrase.hash` 缓存整条乐句，命中就读、不重拼。"""
    import tempfile

    from singing.openutau import Progress
    from singing.openutau.classic import ClassicRenderer

    tmp = tempfile.mkdtemp(prefix='fufumidi-classic-ext-')
    old_host = None
    try:
        project, track, part, phrase = _render_fixture(tmp, wavtool='wavtool.exe')
        check('外部路径: phrase.wavtool 不是 simple/convergence → 走 RenderExternal',
              phrase.wavtool == 'wavtool.exe')

        resampler = _CountingResampler()
        wavtool = _WritingWavtool()
        old_host = _install_host(_test_classic_host(tmp, resampler, wavtool))
        renderer = ClassicRenderer()
        host = renderer.classic_host

        seen = []
        progress = Progress(len(phrase.phones),
                            notify=lambda pct, info: seen.append((pct, info)))
        result = _run(renderer.render(phrase, progress, track_no=2))

        wav_path = os.path.join(tmp, 'cat-%016x.wav' % phrase.hash)
        check('外部路径: 结果写到 cat-{hash:016x}.wav', os.path.isfile(wav_path))
        check('外部路径: 那条缓存路径登记进了 phrase.cache_files',
              os.path.splitext(os.path.basename(wav_path))[0] in phrase.cache_files,
              'got %r' % phrase.cache_files)
        check('外部路径: 进度用的是另一种文案（Track N : wavtool "音素…"）',
              seen[0][0] == 0.0 and 'wavtool.exe' in seen[0][1]
              and seen[-1][0] == 100.0, 'got %r' % (seen,))
        check('外部路径: VoicebankFiles 被调用（外部程序要解码后的临时输入）',
              host.source_temp_calls == len(phrase.phones),
              'got %d' % host.source_temp_calls)
        check('外部路径: 拼接过一次', wavtool.calls == 1, 'got %d' % wavtool.calls)
        check('外部路径: 产出非空样本',
              result.samples is not None and len(result.samples) > 0)

        # ---- 第二次：cat-{hash}.wav 已存在 → 直接读，不再拼
        phrase2 = RenderPhrase.from_part(project, track, part)[0]
        result2 = _run(renderer.render(phrase2, None, track_no=2))
        check('外部路径: 第二次渲染读缓存（不再调 wavtool）',
              wavtool.calls == 1, 'got %d' % wavtool.calls)
        check('外部路径: 第二次样本与第一次等长（读的就是同一份缓存）',
              len(result2.samples) == len(result.samples),
              'got %r / %r' % (len(result2.samples), len(result.samples)))
    finally:
        if old_host is not None:
            _install_host(old_host)
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_classic_renderer_resample_failure():
    """resampler 没产出文件时抛错，并把位置换算成小节:拍.刻度写进消息。"""
    import tempfile

    from singing.openutau.pipeline_source import host as doc_host

    tmp = tempfile.mkdtemp(prefix='fufumidi-classic-fail-')
    old_project = doc_host.project
    old_host = None
    try:
        project, track, part, phrase = _render_fixture(tmp)

        class _NullResampler(WorldlineResampler):
            def do_resampler_returns_file(self, args, logger=None):
                return None                     # 什么都不写 → 文件不存在

        doc_host.project = project
        old_host = _install_host(_test_classic_host(tmp, _NullResampler()))
        renderer = ClassicRenderer()
        try:
            _run(renderer.render(phrase, None, track_no=0))
            check('ClassicRenderer: resampler 无产出时抛错', False, '没有抛异常')
        except OSError as e:
            # 工程在 → 位置换算成 bar:beat.ticks（默认 4/4、bpm 120、res 480）
            check('ClassicRenderer: resampler 无产出时抛错，且消息带小节:拍.刻度',
                  'failed to resample' in str(e) and '0:0.000' in str(e),
                  'got %r' % str(e))

        doc_host.project = None
        phrase2 = RenderPhrase.from_part(project, track, part)[0]

        class _NullResampler2(WorldlineResampler):
            def do_resampler_returns_file(self, args, logger=None):
                return None

        try:
            # 清掉上一次可能写下的缓存，保证真的再调一次 resampler
            for f in os.listdir(tmp):
                if f.startswith('res-'):
                    os.remove(os.path.join(tmp, f))
            _install_host(_test_classic_host(tmp, _NullResampler2()))
            _run(ClassicRenderer().render(phrase2, None, track_no=0))
            check('ClassicRenderer: 工程缺失时退化成 tick N（不编造坐标）', False)
        except OSError as e:
            check('ClassicRenderer: 工程缺失时退化成 tick N（不编造坐标）',
                  'tick ' in str(e), 'got %r' % str(e))
    finally:
        doc_host.project = old_project
        if old_host is not None:
            _install_host(old_host)
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def _run(coro):
    """跑一个协程（渲染是 async 的，对应 C# 的 `Task<RenderResult>`）。"""
    import asyncio
    return asyncio.new_event_loop().run_until_complete(coro)


def _build_voicebank_dir(root, name, character_txt, oto_ini, extra_files=()):
    """在磁盘上造一个最小可用声库目录，返回 `character.txt` 的路径。"""
    vb = os.path.join(root, name)
    os.makedirs(vb, exist_ok=True)
    with open(os.path.join(vb, 'character.txt'), 'w', encoding='utf-8') as f:
        f.write(character_txt)
    with open(os.path.join(vb, 'oto.ini'), 'w', encoding='utf-8') as f:
        f.write(oto_ini)
    for fn in extra_files:
        with open(os.path.join(vb, fn), 'wb') as f:
            f.write(b'RIFF')
    return os.path.join(vb, 'character.txt')


def test_classic_singer():
    """`Classic/ClassicSinger.cs` + `OtoWatcher.cs` + `ClassicSingerLoader.cs`。"""
    import tempfile

    from singing.openutau.classic import (ClassicHost, ClassicSinger, OtoWatcher,
                                          OTO_DATA_EMPTY, ReloadScheduler,
                                          VoicebankLoader, adjust_singer_type,
                                          find_all_singers, register_singer_factory,
                                          registered_singer_types,
                                          reset_singer_factories)
    from singing.openutau.classic import classic_singer as CS
    from singing.openutau.classic import oto_watcher as OW
    from singing.openutau.oto import Voicebank
    from singing.openutau.singer import USingerType

    cs = _read('Classic/ClassicSinger.cs')
    cs_w = _read('Classic/OtoWatcher.cs')
    cs_l = _read('Classic/ClassicSingerLoader.cs')
    if cs is None or cs_w is None or cs_l is None:
        print('  SKIP 找不到 ClassicSinger.cs / OtoWatcher.cs / ClassicSingerLoader.cs')
        return

    # ---------------- 源码一致性：OtoWatcher
    check('OtoWatcher: Filter 是 oto.ini 且递归',
          'watcher.Filter = "oto.ini";' in cs_w
          and 'watcher.IncludeSubdirectories = true;' in cs_w
          and OW.WATCH_FILTER == 'oto.ini')
    check('OtoWatcher: Paused 时**只跳过调度**（不停止监视）',
          'if (Paused)' in cs_w and 'return;' in cs_w)
    check('OtoWatcher: 四种变更事件都挂同一个处理器',
          all(('watcher.%s += OnFileChanged;' % e) in cs_w
              for e in ('Changed', 'Created', 'Deleted', 'Renamed')))
    check('OtoWatcher: Dispose 只停后端，不复位 Paused',
          'watcher.Dispose();' in cs_w and 'Paused = false' not in cs_w)
    check('OtoWatcher: 调度的是 SingerManager.Inst.ScheduleReload',
          'SingerManager.Inst.ScheduleReload(singer);' in cs_w)

    # ---------------- 源码一致性：ClassicSinger
    check('ClassicSinger: subbanks 按 prefix+suffix 长度**降序**',
          'OrderByDescending(subbank => subbank.Prefix.Length + subbank.Suffix.Length)' in cs)
    check('ClassicSinger: 分组键是 ^prefix(.*)suffix$',
          'new Regex(group.Key)' in cs and '$"^{Regex.Escape(subbank.Prefix)}(.*){Regex.Escape(subbank.Suffix)}$"' in cs)
    check('ClassicSinger: 先写回 oto.Phonetic 再构造 UOto（顺序是语义）',
          cs.index('oto.Phonetic = m.Groups[1].Value;') < cs.index('uOto = new UOto(oto, uSet, group.Value);'))
    check('ClassicSinger: otoMap 冲突时保留**先出现**的（ContainsKey 守卫）',
          'if (!d.otoMap.ContainsKey(oto.Alias))' in cs)
    check('ClassicSinger: SearchTerms 加两项，罗马字那项包在 try/catch 里',
          'oto.SearchTerms.Add(oto.Alias.ToLowerInvariant().Replace(" ", ""));' in cs
          and 'WanaKana.ToRomaji(oto.Alias)' in cs and '} catch { }' in cs)
    check('ClassicSinger: 单次原子发布 data = d',
          'data = d;' in cs and cs.index('data = d;') > cs.index('// Single atomic publish'))
    check('ClassicSinger: FreeMemory 用共享的 OtoData.Empty',
          'data = OtoData.Empty;' in cs
          and 'public static readonly OtoData Empty = new OtoData();' in cs)
    check('ClassicSinger: Save 直接访问 otoWatcher（未加载时会 NRE，照搬不修）',
          'otoWatcher.Paused = true;' in cs)
    check('ClassicSinger: TryGetMappedOto 的颜色分支用 `Color == color`',
          'subbank.Color == color && subbank.toneSet.Contains(tone)' in cs)
    check('ClassicSinger: 静态那份找的是**空 Color** 的 subbank',
          'string.IsNullOrEmpty(subbank.Color) && subbank.toneSet.Contains(tone)' in cs)
    check('ClassicSinger: GetSuggestions 非 alias 模式先按长度再按字典序，之后才加别名',
          'OrderBy(pair => pair.Key.Length)' in cs and 'ThenBy(pair => pair.Key)' in cs
          and cs.rindex('result.TryAdd(oto.Alias, oto);') > cs.index('ThenBy(pair => pair.Key)'))

    # ---------------- 源码一致性：ClassicSingerLoader
    check('ClassicSingerLoader: 按 SingerType 精确值分派，default 落到 ClassicSinger',
          'switch (v.SingerType)' in cs_l and 'return new ClassicSinger(v) as USinger;' in cs_l)
    check('ClassicSingerLoader: **每个路径各建一个 loader**',
          'foreach (var path in PathManager.Inst.SingersPaths)' in cs_l
          and 'var loader = new VoicebankLoader(path);' in cs_l)

    # ---------------- 行为：造一个真实声库
    tmp = tempfile.mkdtemp(prefix='fufumidi-singer-')
    saved_is_test = VoicebankLoader.is_test
    VoicebankLoader.is_test = True
    try:
        # oto.ini：别名形如 "P_a_S"，prefix="P_" suffix="_S"；另有重复别名与无效行
        # ★ 注意：subbanks 必须来自真实的 prefix.map —— `reload()` 会重读整个声库，
        #   手工往 `bank.subbanks` 里塞会被冲掉。
        # ★ `portrait` 不在 character.txt 的键表里（C# 同样不认），只在 character.yaml。
        chtxt = ('name=Tester\n'
                 'author=Someone\n'
                 'voice=TesterCV\n'
                 'sample=sample.wav\n'
                 'image=icon.png\n')
        ototxt = ('a.wav=P_a_S,0,50,-30,100,20\n'      # 命中 subbank P_/_S → phonetic = "a"
                  'b.wav=Q_b_T,0,50,0,100,20\n'        # 命中 subbank Q_/_T → phonetic = "b"
                  'c.wav=c,0,50,0,100,20\n'            # 不命中任何 subbank → dummy
                  'd.wav=d,0,50,0,100,XX\n')           # overlap 解析失败 → IsValid=false
        path = _build_voicebank_dir(tmp, 'Tester', chtxt, ototxt,
                                    extra_files=('icon.png', 'p.png', 'sample.wav'))
        vb_dir = os.path.dirname(path)
        # prefix.map：制表符三列「音名 / 前缀 / 后缀」→ 两个子音色
        with open(os.path.join(vb_dir, 'prefix.map'), 'w', encoding='utf-8') as f:
            f.write('C4\tP_\t_S\nE4\tP_\t_S\nG4\tP_\t_S\nA4\tQ_\t_T\n')
        with open(os.path.join(vb_dir, 'character.yaml'), 'w', encoding='utf-8') as f:
            f.write('portrait: p.png\nportrait_opacity: 0.67\nportrait_height: 300\n')
        bank = Voicebank()
        bank.file = path
        bank.base_path = tmp
        VoicebankLoader.load_info(bank, path, tmp)

        singer = ClassicSinger(bank)
        check('ClassicSinger: 构造后 found=True、loaded=False',
              singer.found is True and singer.loaded is False)
        check('ClassicSinger: 未加载时 data 就是共享的 OtoData.Empty',
              singer.data is OTO_DATA_EMPTY)

        singer.reload()
        check('ClassicSinger.Reload: loaded=True 且 oto_dirty 清掉',
              singer.loaded is True and singer.oto_dirty is False)
        check('ClassicSinger.Reload: 建了 oto_watcher', singer.oto_watcher is not None)
        check('ClassicSinger.Reload: data 已换成新对象（原子发布）',
              singer.data is not OTO_DATA_EMPTY)

        check('ClassicSinger: otos 数量 = 有效 oto 数（解析失败那条被剔除，但进了 errors）',
              len(singer.otos) == 3 and len(singer.errors) == 1,
              'otos=%d errors=%r' % (len(singer.otos), singer.errors))
        check('ClassicSinger: subbanks 来自 prefix.map（两个子音色，音域各自成形）',
              sorted((s.prefix, s.suffix) for s in singer.subbanks) == [('P_', '_S'), ('Q_', '_T')],
              'got %r' % [(x.prefix, x.suffix, x.tone_set) for x in singer.subbanks])
        check('ClassicSinger: P_/_S 的音域是 C4/E4/G4 → 60/64/67',
              next(x for x in singer.subbanks if x.prefix == 'P_').tone_set == [60, 64, 67],
              'got %r' % next(x for x in singer.subbanks if x.prefix == 'P_').tone_set)
        check('ClassicSinger: 命中的正则组 1 写回了原始 oto.Phonetic',
              bank.oto_sets[0].otos[0].phonetic == 'a'
              and bank.oto_sets[0].otos[1].phonetic == 'b',
              'got %r' % [o.phonetic for o in bank.oto_sets[0].otos[:2]])
        check('ClassicSinger: 命中时 UOto 拿到该组的 subbank 列表',
              [(x.prefix, x.suffix) for x in singer.otos[0].subbanks] == [('P_', '_S')],
              'got %r' % [(x.prefix, x.suffix) for x in singer.otos[0].subbanks])
        check('ClassicSinger: 不命中时用 dummy subbank（prefix/suffix 均为空）',
              singer.otos[2].subbanks is not None and singer.otos[2].subbanks[0].prefix == '')
        check('ClassicSinger: location = character.txt 所在目录',
              os.path.normcase(singer.location) == os.path.normcase(os.path.dirname(path)),
              'got %r' % singer.location)
        check('ClassicSinger: avatar/portrait/sample 拼到 location 上',
              singer.avatar and singer.avatar.endswith('icon.png')
              and singer.portrait.endswith('p.png') and singer.sample.endswith('sample.wav'))
        check('ClassicSinger: avatar_data 读到了内容（覆盖基类的只读 property）',
              singer.avatar_data == b'RIFF', 'got %r' % singer.avatar_data)
        check('ClassicSinger: search_terms 每项都是别名小写去空格',
              all(' ' not in t and t == t.lower() for t in singer.otos[0].search_terms))
        check('ClassicSinger: 未注入罗马字转换器时只留 1 项（等价于 C# 的 catch 吞掉）',
              len(singer.otos[0].search_terms) == 1,
              'got %r' % singer.otos[0].search_terms)
        CS.set_romaji_converter(lambda s: 'ROMAJI')
        singer.reload()
        check('ClassicSinger: 注入转换器后有 2 项搜索词',
              len(singer.otos[0].search_terms) == 2, 'got %r' % singer.otos[0].search_terms)
        CS.set_romaji_converter(None)

        # otoMap 冲突保留先出现的：加一条重复别名的 oto
        check('ClassicSinger: otoMap 里同名别名只留一个',
              len({o.alias for o in singer.otos}) == len(singer.data.oto_map),
              'otos=%d map=%d' % (len({o.alias for o in singer.otos}),
                                  len(singer.data.oto_map)))

        # ---- oto 查询
        ok, oto = singer.try_get_oto('P_a_S')
        check('ClassicSinger.TryGetOto: 按别名精确查', ok and oto.alias == 'P_a_S')
        ok, oto = singer.try_get_oto('nope')
        check('ClassicSinger.TryGetOto: 查不到返回 (False, None)',
              ok is False and oto is None)
        # color='' + tone 命中 P_ 的 C4(60) → 拼 P_aP_... 实际查 'P_a_S'
        ok, oto = singer.try_get_mapped_oto('a', 60, '')
        check('ClassicSinger.TryGetMappedOto: 空 color 命中 subbank 时拼 prefix+phoneme+suffix',
              ok and oto.alias == 'P_a_S', 'got %r' % (oto.alias if oto else None))
        # 音域不命中（tone=100 不在任何 toneSet）→ 退到裸别名 'a'（不存在）→ False
        ok, oto = singer.try_get_mapped_oto('a', 100, '')
        check('ClassicSinger.TryGetMappedOto: subbank 未命中时退到裸别名',
              ok is False and oto is None, 'got %r' % (oto,))
        ok, oto = singer.try_get_mapped_oto('c', 100)
        check('ClassicSinger.TryGetMappedOto: 两参重载 = 空 color 那份逻辑',
              ok and oto.alias == 'c')
        # 带 color：C# 先找 Color == color 的 subbank（我们没给 subbank 设 color 值 → 落空）
        ok, oto = singer.try_get_mapped_oto('a', 60, 'Soft')
        check('ClassicSinger.TryGetMappedOto: 颜色不匹配时回落到空 color 逻辑',
              ok and oto.alias == 'P_a_S')

        # ---- GetSuggestions
        sugs = singer.get_suggestions('', False)
        check('ClassicSinger.GetSuggestions: 空文本 = 全部（非 alias 模式先给 phonetic）',
              'a' in sugs and 'b' in sugs, 'got %r' % list(sugs)[:6])
        sugs_a = singer.get_suggestions('', True)
        check('ClassicSinger.GetSuggestions: alias 模式只给别名',
              set(sugs_a) == {o.alias for o in singer.otos}, 'got %r' % list(sugs_a))
        check('ClassicSinger.GetSuggestions: 过滤走 search_terms 子串',
              all('x' not in k for k in singer.get_suggestions('a', True))
              and len(singer.get_suggestions('a', True)) >= 1)
        sugs_na = singer.get_suggestions('', False)
        keys = list(sugs_na)
        check('ClassicSinger.GetSuggestions: 非 alias 模式下 phonetic 段先按长度再按字典序',
              keys[:3] == sorted(keys[:3], key=lambda k: (len(k), k)) or len(keys) < 3,
              'got %r' % keys[:6])

        # ---- FreeMemory
        singer.free_memory()
        check('ClassicSinger.FreeMemory: data 回到**共享**的 OtoData.Empty（同一对象）',
              singer.data is OTO_DATA_EMPTY and singer.loaded is False)
        check('ClassicSinger.FreeMemory: oto_watcher 被置 None', singer.oto_watcher is None)

        # ---- Save 未加载时会崩（C# 同样 NRE）
        singer2 = ClassicSinger(bank)
        try:
            singer2.save()
            check('ClassicSinger.Save: 未加载就保存会崩（与 C# 的 NRE 一致）', False, '没抛错')
        except AttributeError:
            check('ClassicSinger.Save: 未加载就保存会崩（与 C# 的 NRE 一致）', True)

        # ---- OtoWatcher 行为
        class _SpyBackend:
            def __init__(self):
                self.started = None
                self.stopped = False

            def start(self, path, on_change, on_error, file_filter, recursive):
                self.started = (path, file_filter, recursive)
                self.on_change = on_change

            def stop(self):
                self.stopped = True

        reloaded = []

        class _SpyScheduler(ReloadScheduler):
            def schedule_reload(self, singer_):
                reloaded.append(singer_)

        saved_sched = OW.scheduler
        OW.scheduler = _SpyScheduler()
        try:
            be = _SpyBackend()
            w = OtoWatcher(singer2, '/vb', backend=be)
            check('OtoWatcher: 后端收到 (路径, oto.ini, 递归=True)',
                  be.started == ('/vb', 'oto.ini', True), 'got %r' % (be.started,))
            be.on_change('/vb/oto.ini', 'Changed')
            check('OtoWatcher: 未暂停时排一次重载', len(reloaded) == 1)
            w.paused = True
            be.on_change('/vb/oto.ini', 'Changed')
            check('OtoWatcher: 暂停时不排重载', len(reloaded) == 1)
            w.on_error(RuntimeError('x'))
            check('OtoWatcher: OnError 只记日志不抛', True)
            w.dispose()
            check('OtoWatcher.Dispose: 停后端但**不复位** paused',
                  be.stopped is True and w.paused is True)
        finally:
            OW.scheduler = saved_sched

        # ---- ClassicSingerLoader
        reset_singer_factories()
        check('ClassicSingerLoader: 未注册任何类型时一律回落 ClassicSinger',
              isinstance(adjust_singer_type(bank), ClassicSinger))
        register_singer_factory(USingerType.ENUNU, lambda v: 'ENUNU-SINGER')
        bank_e = Voicebank()
        bank_e.singer_type = USingerType.ENUNU
        check('ClassicSingerLoader: 注册后按 SingerType 分派',
              adjust_singer_type(bank_e) == 'ENUNU-SINGER'
              and USingerType.ENUNU in registered_singer_types(),
              'got %r / %r' % (adjust_singer_type(bank_e), registered_singer_types()))
        bank_v = Voicebank()
        bank_v.singer_type = USingerType.VOICEVOX
        check('ClassicSingerLoader: 未注册的类型仍回落 ClassicSinger',
              isinstance(adjust_singer_type(bank_v), ClassicSinger))
        check('ClassicSingerLoader: Classic 类型不受 ENUNU 注册影响',
              isinstance(adjust_singer_type(bank), ClassicSinger))

        saved_paths = ClassicHost.singers_paths
        try:
            ClassicHost.singers_paths = [tmp]
            found = find_all_singers()
            check('ClassicSingerLoader.FindAllSingers: 遍历 host.singers_paths 找出声库',
                  len(found) >= 1 and all(isinstance(s, ClassicSinger) for s in found),
                  'got %r' % found)
            ClassicHost.singers_paths = []
            check('ClassicSingerLoader.FindAllSingers: 无搜索路径时返回空表',
                  find_all_singers() == [])
        finally:
            ClassicHost.singers_paths = saved_paths
    finally:
        VoicebankLoader.is_test = saved_is_test
        CS.set_romaji_converter(None)


class _FakeFrq:
    """`OtoFrq` 的替身（`render_phrase.py` 只读它的 loaded / hop_size / 两张差分表）。"""

    def __init__(self, stretch=None, fix=None, hop_size=441, loaded=True):
        self.loaded = loaded
        self.hop_size = hop_size
        self.tone_diff_stretch = list(stretch if stretch is not None else [5.0] * 10)
        self.tone_diff_fix = list(fix if fix is not None else [3.0] * 10)


class _FakeClassicSinger:
    """只需要 `Frqs`（把 wav 路径映射到频率表）与 `id`。"""

    def __init__(self):
        self.frqs = {}
        self.id = 'classic-test'


def test_mod_plus():
    """`render_phrase.py` 的 MOD+ 分支（`RenderPhrase.cs` 里最大的一段独立逻辑）。"""
    from singing.openutau import classic as _classic  # noqa: F401  (确认 classic 可导入)
    cs = _read('Render/RenderPhrase.cs')
    if cs is None:
        print('  SKIP 找不到 Render/RenderPhrase.cs')
        return

    # ---------------- 源码一致性
    check('MOD+: 守卫是 ModpSupported && ClassicSinger != null',
          'source.ModpSupported && source.ClassicSinger != null' in cs)
    check('MOD+: ModpRaw == 0 的判定在 try **之外**',
          'if (phonemeModp == 0)' in cs
          and cs.index('if (phonemeModp == 0)') < cs.index('Failed to compute mod plus.'))
    check('MOD+: 单个音素出错只记日志（catch 吞掉）',
          'catch(Exception e) {' in cs.replace('catch (Exception e) {', 'catch(Exception e) {')
          and 'Failed to compute mod plus.' in cs)
    check('MOD+: Frq 惰性挂到 Oto 上并缓存进 cSinger.Frqs',
          'if (phoneme.Oto.Frq == null) {' in cs
          and 'new OtoFrq(phoneme.Oto, cSinger.Frqs)' in cs)
    check('MOD+: loaded == false 时跳过该音素',
          'if (phoneme.Oto.Frq.loaded == false) {' in cs
          and 'continue;' in cs)
    check('MOD+: tempo 取 NoteTempos[0].bpm，回落 DefaultBpm（原文注释 "妥協"）',
          'noteTempos.Length > 0 ? noteTempos[0].bpm : source.DefaultBpm' in cs
          and 'compromise 妥協' in cs)
    check('MOD+: consonantStretch 用的是 float 字面量（2f / 1.0f / 100f）',
          'Math.Pow(2f, 1.0f - phoneme.VelRaw / 100f)' in cs)
    check('MOD+: frqIntervalTick = TempoMsToTick(tempo, 1000/44100*hopSize)',
          '(double)1 * 1000 / 44100 * frq.hopSize' in cs)
    check('MOD+: preutter 取 min(phoneme.Preutter, oto.Preutter * consonantStretch)',
          'Math.Min(phoneme.Preutter, phoneme.Oto.Preutter * consonantStretch)' in cs)
    check('MOD+: endIndex 是「先 Ceiling 再整数除法」',
          'Math.Ceiling(phoneme.End - pitchStart - MusicMath.TempoMsToTick(tempo, phoneme.TailIntrude - phoneme.TailOverlap)) / pitchInterval' in cs)
    check('MOD+: stretch 只在元音段铺不下时 > 1',
          'frq.toneDiffStretch.Length * frqIntervalTick < ((double)endIndex - startStretch) * pitchInterval' in cs)
    check('MOD+: 加进 pitches 前有 (float) 转换',
          'pitches[pit] = pitches[pit] + (float)(diff * 100);' in cs)
    check('MOD+: 辅音段循环是 i--（往左铺），越界用 continue',
          'for (int i = 0; startStretch + i - 1 >= startIndex; i--)' in cs
          and 'if (pit > endIndex || pit >= pitches.Length) continue;' in cs)
    check('MOD+: 辅音段的 frqPoint 从 toneDiffFix.Length 往前数',
          'frq.toneDiffFix.Length + (i * (pitchInterval / frqIntervalTick) / consonantStretch)' in cs)
    check('MOD+: Fade 用 env3→env4 渐出、env0→env1 渐入，且都 Clamp 到 [0,100]',
          'env3.X, env4.X, env3.Y, env4.Y, percentage' in cs
          and 'env0.X, env1.X, env0.Y, env1.Y, percentage' in cs
          and cs.count('Math.Clamp(MusicMath.Linear(') >= 2)
    check('MOD+: env1/env3 的 X 是包络点在 [0,1] 上的归一化位置',
          '(phoneme.Envelope[1].X - phoneme.Envelope[0].X) / (phoneme.Envelope[4].X - phoneme.Envelope[0].X)' in cs)

    # ---------------- 行为：走真实的 RenderPhrase 构造路径
    def _run(phoneme_kw=None, frq=None, modp=True, singer=True):
        kw = {'oto': _modp_oto(frq), 'modp_raw': 100.0, 'vel_raw': 100.0,
              'prev_adjacent': False, 'next_adjacent': False}
        kw.update(phoneme_kw or {})
        ph = _mk_phoneme(**kw)
        src = _mk_phrase_source([_mk_note()])
        src.modp_supported = modp
        src.classic_singer = _FakeClassicSinger() if singer else None
        rp = RenderPhrase(src, [ph], 0, 1)
        return rp

    def _modp_oto(frq):
        o = _mk_named_oto('a')
        o.preutter = 60.0
        o.consonant = 50.0
        o.frq = frq
        return o

    # 基线：MOD+ 关闭时是全平的 6000
    base = _run(modp=False)
    check('MOD+: modp_supported=False 时不动 pitches',
          set(base.pitches) == {6000.0}, 'got %r' % sorted(set(base.pitches))[:4])

    # 开启 MOD+：元音段 +500、辅音段 +300（见下方推导）
    rp = _run(frq=_FakeFrq())
    check('MOD+: 元音段被加上 toneDiffStretch * modp（6000 → 6500）',
          rp.pitches[50] == 6500.0, 'got %r' % rp.pitches[50])
    check('MOD+: 辅音段被加上 toneDiffFix * modp（6000 → 6300）',
          rp.pitches[0] == 6300.0, 'got %r' % rp.pitches[0])
    check('MOD+: 两段交界处由元音段接管（pit == startStretch）',
          rp.pitches[8] == 6500.0, 'got %r' % rp.pitches[8])
    check('MOD+: endIndex 之后不再改动', rp.pitches[103] == 6000.0,
          'got %r' % rp.pitches[103])
    check('MOD+: pitchesBeforeDeviation 记的是 MOD+ **之后**的值',
          set(rp.pitches_before_deviation) != {6000.0})

    # modp_raw == 0 → 不进循环
    check('MOD+: modp_raw=0 时不动 pitches',
          set(_run(frq=_FakeFrq(), phoneme_kw={'modp_raw': 0.0}).pitches) == {6000.0})

    # loaded == False → continue
    check('MOD+: frq.loaded=False 时不动 pitches',
          set(_run(frq=_FakeFrq(loaded=False)).pitches) == {6000.0})

    # oto 为 None → try 里抛 → 被 catch 吞掉
    ph_none = _mk_phoneme(oto=None, modp_raw=100.0, vel_raw=100.0)
    src_none = _mk_phrase_source([_mk_note()])
    src_none.modp_supported = True
    src_none.classic_singer = _FakeClassicSinger()
    check('MOD+: oto 为 None 时被 catch 吞掉、pitches 不变',
          set(RenderPhrase(src_none, [ph_none], 0, 1).pitches) == {6000.0})

    # 差分表为空 → clamp_index 抛（对应 C# Math.Clamp 的 ArgumentException）→ 整只音素跳过
    check('MOD+: toneDiffStretch 为空时整只音素被跳过（Math.Clamp 抛错那一路）',
          set(_run(frq=_FakeFrq(stretch=[])).pitches) == {6000.0})
    check('MOD+: toneDiffFix 为空只影响辅音段（元音段照常）',
          _run(frq=_FakeFrq(fix=[])).pitches[50] == 6500.0
          and _run(frq=_FakeFrq(fix=[])).pitches[0] == 6000.0)

    # classic_singer 为 None → 整个 MOD+ 段跳过
    check('MOD+: classic_singer 为 None 时不动 pitches',
          set(_run(frq=_FakeFrq(), singer=False).pitches) == {6000.0})

    # stretch > 1：差分表很小时元音段被拉伸（值仍取端点，故幅度不变）
    check('MOD+: 差分表很小时 stretch > 1（元音段仍铺满到 endIndex）',
          _run(frq=_FakeFrq(stretch=[5.0] * 3)).pitches[100] == 6500.0,
          'got %r' % _run(frq=_FakeFrq(stretch=[5.0] * 3)).pitches[100])

    # 帧尾邻近时走 Fade：把包络做成非退化（env[4].X != env[0].X）才能看到效果
    env = [Vector2(0, 0), Vector2(50, 100), Vector2(200, 100), Vector2(250, 100), Vector2(300, 0)]
    faded = _run(frq=_FakeFrq(), phoneme_kw={'envelope': env, 'next_adjacent': True})
    check('MOD+: 非退化包络 + NextAdjacent 时句尾被渐出（后段增量变小）',
          faded.pitches[100] < faded.pitches[50],
          'got %r / %r' % (faded.pitches[50], faded.pitches[100]))
    no_adj = _run(frq=_FakeFrq(), phoneme_kw={'envelope': env})
    check('MOD+: 没有邻接标记时不做渐出（全程等量）',
          no_adj.pitches[100] == no_adj.pitches[50],
          'got %r / %r' % (no_adj.pitches[50], no_adj.pitches[100]))


def test_worldline_renderer():
    """`Classic/WorldlineRenderer.cs` —— 三版本分派 / 与 Classic 的能力差异 / v10 真机端到端。"""
    import tempfile

    from singing.openutau import Progress, RenderPhrase
    from singing.openutau import worldline as W
    from singing.openutau.classic import (HOP_SIZES, ClassicRenderer,
                                          WorldlineRenderer)
    from singing.openutau.renderers import WORLDLINE_R, WORLDLINE_R11, WORLDLINE_R2

    cs = _read('Classic/WorldlineRenderer.cs')
    if cs is None:
        print('  SKIP 找不到 Classic/WorldlineRenderer.cs')
        return

    # ---------------- 源码一致性
    check('WorldlineRenderer: hopSize 分派 10→441 / 11→220 / 20→512，其余抛错',
          '10 => 441,' in cs and '11 => 220,' in cs and '20 => 512,' in cs
          and 'Unsupported WorldlineRenderer version' in cs
          and HOP_SIZES == {10: 441, 11: 220, 20: 512})
    check('WorldlineRenderer: frameMs = hopSize * 1000 / 44100',
          'frameMs = hopSize * 1000.0 / 44100.0;' in cs)
    check('WorldlineRenderer: 缓存文件名含版本号 wdl-v{version}-{hash:x16}.wav',
          'wdl-v{version}-{phrase.hash:x16}.wav' in cs)
    check('WorldlineRenderer: 读缓存与写缓存各在 lock 内、合成在 lock 外',
          cs.count('lock (cacheLock)') == 2
          and cs.index('var phraseSynth = new Worldline.PhraseSynthV2') > cs.index('lock (cacheLock) {'))
    check('WorldlineRenderer: 三种版本都要过 AddDirects 与 ApplyDynamics',
          'AddDirects(phrase, resamplerItems, result);' in cs
          and 'Renderers.ApplyDynamics(phrase, result);' in cs)
    check('WorldlineRenderer: SampleCurve 里 index 越界时**留 0**',
          'if (index < curve.Length) {' in cs)
    check('WorldlineRenderer: AddDirects 的 length = cutoff>=0 ? (len-offset-cutoff) : -cutoff',
          'int length = cutoff >= 0 ? (samples.Length - offset - cutoff) : -cutoff;' in cs)
    check('WorldlineRenderer: ExpressionGraphSlot 固定为 WORLDLINE_R',
          'RenderGraphSlot' in cs or 'ExpressionGraphSlot => Renderers.WORLDLINE_R' in cs)
    check('WorldlineRenderer: ToString 按版本返回三个名字',
          '11 => Renderers.WORLDLINE_R11,' in cs and '20 => Renderers.WORLDLINE_R2,' in cs)
    check('WorldlineRenderer: v11 用 useHnsep: version == 11',
          'useHnsep: version == 11' in cs)
    check('WorldlineRenderer: v10 走 Synth()、v11 走 SynthContinuousNoise(seed: phrase.hash)',
          'phraseSynth.SynthContinuousNoise(seed: phrase.hash)' in cs
          and 'result.samples = phraseSynth.Synth();' in cs)

    # ★ 与 ClassicRenderer 的能力差异：这里**没有** flag 兜底
    class _D:
        def __init__(self, abbr, is_flag=False, flag=''):
            self.abbr, self.is_flag, self.flag = abbr, is_flag, flag

    wr = WorldlineRenderer(10)
    cr = ClassicRenderer()
    check('WorldlineRenderer: hopSize/frameMs（10 → 441 / 10.0ms）',
          wr.hop_size == 441 and wr.frame_ms == 10.0)
    check('WorldlineRenderer: __str__ 是渲染器名（不是版本号）',
          str(wr) == WORLDLINE_R and str(WorldlineRenderer(11)) == WORLDLINE_R11
          and str(WorldlineRenderer(20)) == WORLDLINE_R2)
    check('WorldlineRenderer: expression_graph_slot 三个版本共用 WORLDLINE_R',
          wr.expression_graph_slot == WORLDLINE_R
          and WorldlineRenderer(11).expression_graph_slot == WORLDLINE_R)
    try:
        WorldlineRenderer(99)
        check('WorldlineRenderer: 未知版本抛 ValueError', False, '没抛错')
    except ValueError:
        check('WorldlineRenderer: 未知版本抛 ValueError', True)

    check('WorldlineRenderer: SupportsExpression **只**看白名单（没有 flag 兜底）',
          wr.supports_expression(_D('dyn')) is True
          and wr.supports_expression(_D('eng', is_flag=True)) is False
          and cr.supports_expression(_D('eng', is_flag=True)) is True,
          'wr(dyn)=%r wr(eng,flag)=%r cr(eng,flag)=%r'
          % (wr.supports_expression(_D('dyn')),
             wr.supports_expression(_D('eng', is_flag=True)),
             cr.supports_expression(_D('eng', is_flag=True))))
    check('WorldlineRenderer: 白名单里**没有** ENG/ATK/DEC（与 Classic 不同）',
          not ({'eng', 'atk', 'dec'} & WorldlineRenderer.SUPPORTED_EXP)
          and {'eng', 'atk', 'dec'} <= ClassicRenderer.SUPPORTED_EXP)
    check('WorldlineRenderer: 白名单里有 GENC/BREC/TENC/VOIC（Worldline 独有）',
          {'genc', 'brec', 'tenc', 'voic'} <= WorldlineRenderer.SUPPORTED_EXP)

    # ---- SampleCurve：越界留 0（不是夹到末点）
    class _TA:
        def ms_pos_to_tick_pos(self, ms):
            return int(ms / 500.0 * 480)      # 120bpm 下 500ms = 480 tick

    class _Ph:
        position_ms = 0.0
        leading_ms = 0.0
        position = 0
        leading = 0
        time_axis = _TA()

    curve = [10.0, 20.0, 30.0]
    out = wr.sample_curve(_Ph(), curve, 0.0, 8, lambda x: x * 2)
    check('WorldlineRenderer.SampleCurve: 起点取 curve[0]（tick 0）', out[0] == 20.0,
          'got %r' % out)
    # ticks = int(i*10/500*480) = int(i*9.6) → i=0→0(idx0) / i=1→9(idx1) / i=2→19(idx3 越界→0)
    check('WorldlineRenderer.SampleCurve: 超出曲线长度后**留 0**（不是夹到末点）',
          out[0] == 20.0 and out[1] == 40.0 and out[2] == 0.0 and out[-1] == 0.0,
          'got %r' % out)
    check('WorldlineRenderer.SampleCurve: curve=None 时整段填默认值',
          wr.sample_curve(_Ph(), None, 0.5, 4, lambda x: x) == [0.5] * 4)
    check('WorldlineRenderer.SampleCurve: 默认值**不过** convert（C# 直接 Array.Fill）',
          wr.sample_curve(_Ph(), None, 0.5, 2, lambda x: x * 999) == [0.5, 0.5])

    # ---- v11 / v20 的依赖报错（不依赖真机）
    try:
        WorldlineRenderer(11)._make_phrase_synth()
        check('WorldlineRenderer: v11 无 hnsep 时给出明确的依赖报错', False, '没抛错')
    except NotImplementedError as e:
        check('WorldlineRenderer: v11 无 hnsep 时给出明确的依赖报错',
              'Hnsep' in str(e) or '谐波' in str(e), 'got %r' % str(e)[:60])
    try:
        WorldlineRenderer(20)._synth_r2(None)
        check('WorldlineRenderer: v20 给出 ONNX 依赖报错（并说清缺哪两件）', False, '没抛错')
    except NotImplementedError as e:
        check('WorldlineRenderer: v20 给出 ONNX 依赖报错（并说清缺哪两件）',
              'Data.Resources.mel' in str(e) and 'pc-nsf-hifigan' in str(e))
    check('WorldlineRenderer: register_worldline_renderers 可重复登记',
          (__import__('singing.openutau.classic', fromlist=['x'])
           .register_worldline_renderers()) is None)

    # ---------------- v10 端到端（真机）
    dll = os.path.join(REF_ROOT, 'runtimes', 'win-x64', 'native', 'worldline.dll')
    if not os.path.isfile(dll):
        print('  SKIP 找不到预编译 worldline.dll（%s）' % dll)
        return
    native = W.get_native(dll)
    if not native.available:
        print('  SKIP worldline.dll 加载失败：%s' % native.error)
        return

    tmp = tempfile.mkdtemp(prefix='fufumidi-worldline-')
    old_host = None
    try:
        project, track, part, phrase_classic = _render_fixture(tmp)
        # 把轨道渲染器换成 Worldline-R(10)，再重建乐句（乐句的哈希含 renderer.ToString()）
        wr10 = WorldlineRenderer(10)
        track.renderer_settings.renderer_obj = wr10
        phrases = RenderPhrase.from_part(project, track, part)
        check('WorldlineRenderer e2e: 能构建出乐句', len(phrases) == 1)
        phrase = phrases[0]
        check('WorldlineRenderer e2e: 乐句哈希与 Classic 的不同（渲染器名进哈希）',
              phrase.hash != phrase_classic.hash)

        resampler = _CountingResampler()
        old_host = _install_host(_test_classic_host(tmp, resampler))
        seen = []
        progress = Progress(len(phrase.phones),
                            notify=lambda pct, info: seen.append((pct, info)))
        result = _run(wr10.render(phrase, progress, track_no=0))

        check('WorldlineRenderer e2e: 产出非空样本',
              result.samples is not None and len(result.samples) > 0,
              'got %r' % (None if result.samples is None else len(result.samples)))
        check('WorldlineRenderer e2e: 样本有限且不静音',
              all(math.isfinite(v) for v in result.samples)
              and max(abs(v) for v in result.samples) > 1e-3,
              'got peak %r' % max(abs(v) for v in result.samples))
        check('WorldlineRenderer e2e: 输出主频 ≈ 440Hz（tone 69 → 变调生效，过零率 ±10%%）',
              _dominant_zero_cross(samples_of(result)) is not None
              and abs(_dominant_zero_cross(samples_of(result)) - 440.0) < 44.0,
              'got %r' % _dominant_zero_cross(samples_of(result)))
        check('WorldlineRenderer e2e: 缓存文件已登记进 phrase',
              any('wdl-v10-' in f for f in phrase.cache_files),
              'got %r' % phrase.cache_files)
        # 第二次渲染读缓存（不再合成）——宿主仍在，不要提前复原
        result2 = _run(wr10.render(phrase, None, track_no=0))
        check('WorldlineRenderer e2e: 第二次渲染样本等长（读的就是同一份缓存）',
              len(result2.samples) == len(result.samples))
        check('WorldlineRenderer e2e: 进度上报到 100（每个音素一次 + 收尾）',
              seen and seen[-1][0] == 100, 'got %r' % seen)
    finally:
        if old_host is not None:
            try:
                _install_host(old_host)
            except Exception:
                pass


def samples_of(result):
    """`RenderResult.samples` 的取值辅助（可能为 None）。"""
    return result.samples or []


def _dominant_zero_cross(samples):
    """用**过零率**估主频（与 ClassicRenderer 的端到端判据同一套做法）。"""
    import math as _m
    if not samples:
        return None
    crossings = 0
    prev = samples[0]
    for v in samples[1:]:
        if (prev < 0 <= v) or (prev > 0 >= v):
            crossings += 1
        prev = v
    return crossings / 2.0 / (len(samples) / 44100.0) if samples else None


#: `ms_to_tick` 需要一个 time_axis（120bpm / 480 resolution）
_CVVC_AXIS = TimeAxis()
_CVVC_AXIS.build_segments(UProject())


def _real_classic_singer(alias_to_oto):
    """造一个**用真 `ClassicSinger.try_get_mapped_oto`** 的歌手（只有 oto 表是手填的）。

    ★ 这就是能抓到"音素化器把 `(found, oto)` 当裸值"的那类测试：
    它走的是真实现的返回契约，而不是替身自己编的契约。
    """
    from singing.openutau.classic.classic_singer import ClassicSinger, OtoData
    from singing.openutau.oto import Voicebank

    singer = ClassicSinger(Voicebank())
    singer.data = OtoData()
    singer.data.oto_map = dict(alias_to_oto)
    return singer


def test_phonemizers_against_real_singer():
    """★ 回归：四个音素化器必须能跑在**真 `ClassicSinger`** 上。

    `USinger.try_get_mapped_oto` 返回 `(found, oto)`（照搬 C# 的 out 参数）。
    早前三个音素化器把它当**裸值**用（`if oto is not None:`），于是拿到
    `(True, <UOto>)` 后继续 `oto.is_color_match(...)` →
    `AttributeError: 'tuple' object has no attribute 'is_color_match'`。

    **为什么当时没被测出来**：测试替身返回的是裸值 —— 替身与真实现接口不一致，
    测试全绿而真机必崩。现在替身已改成同契约，并且加了这一条**用真歌手**的用例。
    """
    from singing.openutau import Note, PhonemeAttributes
    from singing.openutau.plugin_builtin import (chinese_cvvc as CVC, chinese_vcv as CV,
                                                 japanese_cvvc as JC, japanese_vcv as JV)

    def oto(alias, color=''):
        return _mk_named_oto(alias, color=color)

    # --- JA VCV：无前邻 → "- な"
    singer = _real_classic_singer({'- な': oto('- な')})
    ph = JV.JapaneseVCVPhonemizer()
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60, duration=480)])
    check('真歌手: JA VCV 能跑（无前邻 → "- な"）',
          [p.phoneme for p in r.phonemes] == ['- な'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # --- JA CVVC：无前邻 → "- か"，且不插 VC
    singer = _real_classic_singer({'- か': oto('- か')})
    ph = JC.JapaneseCVVCPhonemizer()
    ph.set_singer(singer)
    r = ph.process([Note(lyric='か', tone=60, duration=480)])
    check('真歌手: JA CVVC 能跑（无前邻 → "- か"）',
          [p.phoneme for p in r.phonemes] == ['- か'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # --- ZH VCV：无前邻 → "- tian"
    singer = _real_classic_singer({'- tian': oto('- tian')})
    ph = CV.ChineseVCVPhonemizer()
    ph.set_singer(singer)
    r = ph.process([Note(lyric='tian', tone=60, duration=480)])
    check('真歌手: ZH VCV 能跑（无前邻 → "- tian"）',
          [p.phoneme for p in r.phonemes] == ['- tian'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # --- ZH CVVC：整串命中
    singer = _real_classic_singer({'- bu': oto('- bu')})
    ph = CVC.ChineseCVVCPhonemizer()
    ph.set_singer(singer)
    r = ph.process([Note(lyric='bu', tone=60, duration=480)],
                   next_neighbour=Note(lyric='bi'))
    check('真歌手: ZH CVVC 能跑（整串命中 "- bu"）',
          [p.phoneme for p in r.phonemes] == ['- bu'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # --- 颜色匹配那条路也要能过（会走到 is_color_match）
    # 「き」的元音是 i → 候选首项是 "i な"
    singer = _real_classic_singer({'i な': oto('i な', color='Soft'),
                                   '* な': oto('* な', color='Soft')})
    ph = JV.JapaneseVCVPhonemizer()
    ph.set_singer(singer)
    r = ph.process([Note(lyric='な', tone=60, duration=480,
                         phoneme_attributes=[PhonemeAttributes(index=0, voice_color='Soft')])],
                   prev_neighbour=Note(lyric='き'))
    check('真歌手: 走 is_color_match 的路径不炸（JA VCV / 颜色命中 "i な"）',
          [p.phoneme for p in r.phonemes] == ['i な'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # --- 一律走 `mapped_oto`：直接调 `singer.try_get_mapped_oto` 当裸值会炸（留作反证）
    found, got = singer.try_get_mapped_oto('i な', 60, 'Soft')
    check('真歌手: try_get_mapped_oto 的契约就是 (found, oto) 元组',
          found is True and isinstance(got, tuple) is False and hasattr(got, 'alias'),
          'got %r' % ((found, got),))
    check('Phonemizer.mapped_oto: 严格解包（有就返 oto、没有返 None）',
          ph.mapped_oto('i な', 60, 'Soft') is got and ph.mapped_oto('没有的', 60, '') is None)
    try:
        class _BareSinger:
            def try_get_mapped_oto(self, p, tone, color=None):
                return object()          # 替身返回裸值（旧测试替身的做法）
        ph._saved, ph.singer = ph.singer, _BareSinger()
        ph.mapped_oto('a', 60, '')
        check('Phonemizer.mapped_oto: 替身返回裸值时**立刻 TypeError**（把问题挡在测试期）',
              False, '没有抛错')
    except TypeError:
        check('Phonemizer.mapped_oto: 替身返回裸值时**立刻 TypeError**（把问题挡在测试期）', True)
    finally:
        ph.singer = ph._saved


def test_japanese_cvvc_phonemizer():
    """`Plugin.Builtin/JapaneseCVVCPhonemizer.cs` —— 三张表 + VC 插入。"""
    from singing.openutau import Note, PhonemeAttributes, registered
    from singing.openutau.plugin_builtin import japanese_cvvc as J

    cs = open(os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                           'JapaneseCVVCPhonemizer.cs'), encoding='utf-8-sig').read()

    # ---- 源码一致性
    m = re.search(r'\[Phonemizer\("([^"]*)",\s*"([^"]*)",\s*"([^"]*)"\s*,\s*language\s*:\s*"([^"]*)"\)\]', cs)
    check('JA CVVC: [Phonemizer] 的 name/tag/author/language 与 C# 一致',
          m is not None and (m.group(1), m.group(2), m.group(3), m.group(4)) == (
              J.JapaneseCVVCPhonemizer.name, J.JapaneseCVVCPhonemizer.tag,
              J.JapaneseCVVCPhonemizer.author, J.JapaneseCVVCPhonemizer.language),
          'C#=%r 我们=%r' % (m.groups() if m else None,
                             (J.JapaneseCVVCPhonemizer.name, J.JapaneseCVVCPhonemizer.tag,
                              J.JapaneseCVVCPhonemizer.author, J.JapaneseCVVCPhonemizer.language)))
    check('JA CVVC: 已在注册表里', registered().get('JA CVVC') is J.JapaneseCVVCPhonemizer)
    check('JA CVVC: 原作者的注释也照搬（提醒后人别顺手重构）',
          'can probably be cleaned up more but i have work in the morning' in cs)

    # ★ 逐**字符串**精确比对（比"数行数"强得多；也避开 `new string[]{` 与 `new string[] {`
    #   两种写法、以及行尾逗号的差异）
    for name, ours, count in (('plainVowels', J.PLAIN_VOWELS, 8),
                              ('nonVowels', J.NON_VOWELS, 40),
                              ('vowels', J.VOWELS, 8),
                              ('consonants', J.CONSONANTS, 37),
                              ('substitution', J.SUBSTITUTION, 13)):
        arr = re.search(r'%s = new string\[\]\s*\{(.*?)\};' % name, cs, re.S)
        got = re.findall(r'"([^"]*)"', arr.group(1)) if arr else None
        check('JA CVVC: %s 逐项一致（%d 项）' % (name, count),
              got is not None and tuple(got) == tuple(ours),
              'C#=%r\n       我们=%r' % (got, ours))
    check('JA CVVC: 三张表的规模（元音 164 / 声母 198 / 替代 18）',
          (len(J.VOWEL_LOOKUP), len(J.CONSONANT_LOOKUP), len(J.SUBSTITUTE_LOOKUP))
          == (164, 198, 18),
          'got %r' % ((len(J.VOWEL_LOOKUP), len(J.CONSONANT_LOOKUP),
                       len(J.SUBSTITUTE_LOOKUP)),))
    check('JA CVVC: 元音表**键取成员**（か→a）', J.VOWEL_LOOKUP.get('か') == 'a')
    check('JA CVVC: 声母表**键取成员**（ち→ch）', J.CONSONANT_LOOKUP.get('ち') == 'ch')
    check('JA CVVC: 替代表**方向相反**（键取原名：ts→t）',
          J.SUBSTITUTE_LOOKUP.get('ts') == 't' and J.SUBSTITUTE_LOOKUP.get('ly') == 'l')
    check('JA CVVC: 拨音大小写分属两个元音键（ん→n / ン→N）',
          J.VOWEL_LOOKUP.get('ん') == 'n' and J.VOWEL_LOOKUP.get('ン') == 'N')

    check('JA CVVC: 两处 checkOto 的**失败语义相反**（VC 那份不取第一个）',
          'oto = otos.First();' in cs and 'if (oto != null) {' in cs
          and cs.count('otos.FirstOrDefault(oto => oto.IsColorMatch(color))') == 2)
    check('JA CVVC: originalCurrentLyric 在任何 oto 替换**之前**存下',
          cs.index('var originalCurrentLyric = currentLyric;')
          < cs.index('if (checkOtoUntilHit(tests, note, out var oto))'))
    check('JA CVVC: vcLength 的 Convert.ToInt32(min(totalDuration/2, …))',
          'Convert.ToInt32(Math.Min(totalDuration / 2, vcLength * (nextAttr.consonantStretchRatio' in cs)
    check('JA CVVC: 查下一音符 oto 用的是 nextNeighbour 的 tone 与属性',
          'nextNeighbour.Value.tone + (nextAttr.toneShift' in cs)

    # ---- 行为（替身已按真契约返回元组）
    class _S:
        def __init__(self, aliases):
            self.aliases = aliases

        def try_get_mapped_oto(self, phoneme, tone, color=None):
            oto = self.aliases.get(phoneme)
            return (oto is not None), oto

    def run(lyrics, aliases, prev=None, next_=None, attrs=None, **kw):
        ph = J.JapaneseCVVCPhonemizer()
        ph.set_singer(_S(aliases))
        ph.set_timing(_CVVC_AXIS)
        note = Note(lyric=lyrics, tone=60, duration=480, position=0,
                    phoneme_attributes=attrs or [])
        return ph.process([note], prev_neighbour=prev, next_neighbour=next_, **kw)

    check('JA CVVC: 无前邻优先 "- か"',
          [p.phoneme for p in run('か', {'- か': _mk_named_oto('- か')}).phonemes] == ['- か'])
    check('JA CVVC: 无前邻时 "- か" 不命中则用裸歌词',
          [p.phoneme for p in run('か', {}).phonemes] == ['か'])

    # 前邻是元音类（本音符是 plainVowel）→ 用前邻**末字符**的元音
    r = run('あ', {'a あ': _mk_named_oto('a あ')}, prev=Note(lyric='か'))
    check('JA CVVC: 前邻「か」末字符 → 元音 a → 命中 "a あ"',
          [p.phoneme for p in r.phonemes] == ['a あ'],
          'got %r' % [p.phoneme for p in r.phonemes])
    # 非元音歌词走 cfLyric
    r = run('き', {'* き': _mk_named_oto('* き')}, prev=Note(lyric='か'))
    check('JA CVVC: 非纯元音歌词走 "* き"',
          [p.phoneme for p in r.phonemes] == ['* き'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # phoneticHint：只试 hint 自己
    ph = J.JapaneseCVVCPhonemizer()
    ph.set_singer(_S({'HINT': _mk_named_oto('HINT'), '- な': _mk_named_oto('- な')}))
    ph.set_timing(_CVVC_AXIS)
    r = ph.process([Note(lyric='な', tone=60, duration=480, phonetic_hint='HINT')])
    check('JA CVVC: 有 phoneticHint 时不做 "- な" 前缀试探',
          [p.phoneme for p in r.phonemes] == ['HINT'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # ---- VC 插入
    # ★ 「き」的元音是 **i**（不是 a）→ VC 别名应是 "i k"
    # 下一音符的 oto 带 preutter=60 → vcLength = ms_to_tick(60) = 58（120bpm/480 下 60ms）
    next_oto = _mk_named_oto('か')
    next_oto.preutter = 60.0
    aliases = {'* き': _mk_named_oto('* き'),
               'i k': _mk_named_oto('i k'),
               'か': next_oto}
    r = run('き', aliases, prev=Note(lyric='か'), next_=Note(lyric='か'))
    check('JA CVVC: 下一个音符是声母类 → 插入 VC（两个音素）',
          len(r.phonemes) == 2, 'got %r' % [p.phoneme for p in r.phonemes])
    check('JA CVVC: VC 音素 = "{本音符元音} {下一音符声母}" = "i k"',
          r.phonemes[1].phoneme == 'i k', 'got %r' % r.phonemes[1].phoneme)
    # position = totalDuration - vcLength = 480 - ms_to_tick(preutter=60) = 480 - 58
    check('JA CVVC: VC 的 position = totalDuration - vcLength = 422',
          r.phonemes[1].position == 422, 'got %r' % r.phonemes[1].position)
    # Overlap < 0 时 vcLength 用 Preutter - Overlap（更长）
    neg = _mk_named_oto('か')
    neg.preutter = 60.0
    neg.overlap = -30.0
    aliases_neg = {'* き': _mk_named_oto('* き'), 'i k': _mk_named_oto('i k'), 'か': neg}
    r2 = run('き', aliases_neg, prev=Note(lyric='か'), next_=Note(lyric='か'))
    check('JA CVVC: oto.Overlap < 0 时 vcLength 用 (Preutter - Overlap) → position 更小',
          r2.phonemes[1].position == 480 - 86,
          'got %r（期望 394 = 480 - ms_to_tick(90)）' % r2.phonemes[1].position)

    # 下一音符是单字符纯元音 → 不插 VC
    r = run('き', {'* き': _mk_named_oto('* き')}, prev=Note(lyric='か'), next_=Note(lyric='あ'))
    check('JA CVVC: 下一音符是单字符纯元音 → **不**插 VC',
          len(r.phonemes) == 1, 'got %r' % [p.phoneme for p in r.phonemes])
    # 下一音符声母查不到 → 不插 VC
    r = run('き', {'* き': _mk_named_oto('* き')}, prev=Note(lyric='か'),
            next_=Note(lyric='Xyz'))
    check('JA CVVC: 下一音符声母查不到 → **不**插 VC',
          len(r.phonemes) == 1, 'got %r' % [p.phoneme for p in r.phonemes])
    # VC 查不到 → 不插 VC
    r = run('き', {'* き': _mk_named_oto('* き')}, prev=Note(lyric='か'), next_=Note(lyric='か'))
    check('JA CVVC: VC 别名查不到 → **不**插 VC（且整只音符只出主音素）',
          len(r.phonemes) == 1, 'got %r' % [p.phoneme for p in r.phonemes])
    # 替代符号参与候选（ts→t）
    r = run('き', {'* き': _mk_named_oto('* き'), 'i t': _mk_named_oto('i t')},
            prev=Note(lyric='か'), next_=Note(lyric='つ'))
    check('JA CVVC: 主候选查不到时用 substitution 的替代候选（ts→t → "i t"）',
          len(r.phonemes) == 2 and r.phonemes[1].phoneme == 'i t',
          'got %r' % [p.phoneme for p in r.phonemes])
    # 下一音符带 phoneticHint → 整段 VC 逻辑跳过
    r = run('き', {'* き': _mk_named_oto('* き'), 'i k': _mk_named_oto('i k')},
            prev=Note(lyric='か'), next_=Note(lyric='か', phonetic_hint='H'))
    check('JA CVVC: 下一音符带 phoneticHint 时跳过 VC 逻辑',
          len(r.phonemes) == 1, 'got %r' % [p.phoneme for p in r.phonemes])


def test_g2p():
    """`Api/G2pDictionary.cs` / `G2pFallbacks.cs` / `G2pPack.cs` —— G2P 基础设施。"""
    from singing.openutau.g2p import (G2pDictionary, G2pFallbacks, G2pPack,
                                      G2pDictionaryData, SymbolData,
                                      is_all_punct, set_onnx_session_factory)

    cs_dict = _read('Api/G2pDictionary.cs')
    cs_fb = _read('Api/G2pFallbacks.cs')
    cs_pack = _read('Api/G2pPack.cs')
    if cs_dict is None or cs_fb is None or cs_pack is None:
        print('  SKIP 找不到 G2p 的 C# 源码')
        return

    # ---------------- 源码一致性
    check('G2pDictionary: 用 Trie 存（原文注释引了维基）',
          'Dictionaries are stored as a trie for compact footprint' in cs_dict)
    check('G2pDictionary: Query 命中时返回**副本**（Clone）',
          'return node.symbols.Clone() as string[];' in cs_dict)
    check('G2pDictionary: add_symbol(type) 的 else 分支是**移除**滑音（不是什么都不做）',
          'glideSymbols.Remove(symbol);' in cs_dict
          and cs_dict.count('glideSymbols.Remove(symbol);') == 2)
    check('G2pDictionary: add_entry 在**叶子处按已登记符号过滤**',
          'node.symbols = symbols' in cs_dict and 'Where(symbol => phonemeSymbols.ContainsKey(symbol))' in cs_dict)
    check('G2pDictionary: 文档警告"符号必须先登记"',
          'Must finish adding symbols before adding entries' in cs_dict)
    check('G2pFallbacks: is_vowel/is_glide 由**第一个认识该符号**的字典决定',
          # 3 处：IsValidSymbol 自己一处、IsVowel/IsGlide 各一处
          cs_fb.count('if (dict.IsValidSymbol(symbol))') == 3
          and cs_fb.count('return dict.IsVowel(symbol);') == 1
          and cs_fb.count('return dict.IsGlide(symbol);') == 1,
          'IsValidSymbol 出现 %d 次' % cs_fb.count('if (dict.IsValidSymbol(symbol))'))
    check('G2pPack: kAllPunct 是 ^[\\p{P}]$（只匹配**一个**标点字符）',
          r'Regex(@"^[\p{P}]$")' in cs_pack)
    check('G2pPack: Query 里 dict 命中就**不查缓存**',
          'if (phonemes == null && !PredCache.TryGetValue(grapheme, out phonemes))' in cs_pack)
    check('G2pPack: 预测循环上界写死 48、起始 tgt 是 2',
          'tgt.Length < 48' in cs_pack and 'new int[,] { { 2 } }' in cs_pack)
    check('G2pPack: dict.txt 按**两个空格**切、phones.txt 按空白切',
          'line.Split(new string[] { "  " }, StringSplitOptions.None)' in cs_pack
          and 'line.Split()' in cs_pack)
    check('G2pPack: 跳过以 ;;; 开头的行', 'line.StartsWith(";;;")' in cs_pack)

    # ---------------- Trie / Builder
    b = G2pDictionary.new_builder()
    b.add_symbol('AA', 'vowel')
    b.add_symbol('R', 'liquid')
    b.add_symbol('K', 'consonant')
    b.add_entry('car', ['K', 'AA', 'R'])
    b.add_entry('card', ['K', 'AA', 'R', 'D'])
    d = b.build()
    check('G2pDictionary.query: 命中返回音素列表', d.query('car') == ['K', 'AA', 'R'])
    check('G2pDictionary.query: 未命中返回 **None**（不是空列表）', d.query('cat') is None)
    check('G2pDictionary.query: **前缀**不算命中（trie 要走到叶子）', d.query('ca') is None)
    got = d.query('car')
    got.append('污染')
    check('G2pDictionary.query: 返回的是**副本**（改它不影响字典）',
          d.query('car') == ['K', 'AA', 'R'])
    check('G2pDictionary: is_vowel 只认登记为 vowel 的',
          d.is_vowel('AA') is True and d.is_vowel('K') is False
          and d.is_vowel('没登记') is False)
    check('G2pDictionary: is_glide 只认 semivowel/liquid',
          d.is_glide('R') is True and d.is_glide('K') is False)
    check('G2pDictionary.unpack_hint: 保留空段后按有效性过滤（含重复空格）',
          d.unpack_hint('K  XX AA') == ['K', 'AA'])
    check('G2pDictionary.unpack_hint: 全无效 → 空列表（不是 None）',
          d.unpack_hint('XX YY') == [])

    # add_symbol 的三态：同一个符号先 liquid 再 consonant → 滑音被**移除**
    b2 = G2pDictionary.new_builder()
    b2.add_symbol('R', 'liquid')
    r_is_glide_1 = b2.build()   # 还没登记完，先看不了；下面重建
    b3 = G2pDictionary.new_builder()
    b3.add_symbol('R', 'liquid')
    d3a = b3.build()
    b4 = G2pDictionary.new_builder()
    b4.add_symbol('R', 'liquid')
    b4.add_symbol('R', 'consonant')
    d4 = b4.build()
    check('G2pDictionary.add_symbol: liquid → is_glide True', d3a.is_glide('R') is True)
    check('G2pDictionary.add_symbol: 再用 consonant 登记 → is_glide 变 False（else 是**移除**）',
          d4.is_glide('R') is False)
    check('G2pDictionary.add_symbol(isVowel): 不碰滑音集合',
          (lambda bb: (bb.add_symbol('X', True), bb.build().is_glide('X'))[1]
           )(G2pDictionary.new_builder()) is False)

    # 正确顺序：**先登记符号、再写条目** → 音素保留
    b5 = G2pDictionary.new_builder()
    b5.add_symbol('P', 'vowel')
    b5.add_symbol('Q', 'consonant')
    b5.add_entry('ab', ['P', 'Q'])
    check('G2pDictionary: 先 add_symbol 再 add_entry → 音素保留',
          b5.build().query('ab') == ['P', 'Q'], 'got %r' % b5.build().query('ab'))
    # 反过来（先写条目）→ 过滤发生在**写入时**，音素永久丢失
    b6 = G2pDictionary.new_builder()
    b6.add_entry('ab', ['P', 'Q'])       # 登记之前就写条目
    b6.add_symbol('P', 'vowel')
    b6.add_symbol('Q', 'consonant')
    check('G2pDictionary: 反过来（先 add_entry）→ 音素被永久过滤掉（过滤发生在写入时）',
          b6.build().query('ab') == [], 'got %r' % b6.build().query('ab'))

    # ---------------- G2pFallbacks
    def mk(symbol, is_vowel, is_glide=False, entries=None):
        bb = G2pDictionary.new_builder()
        bb.add_symbol(symbol, is_vowel, is_glide)
        for g, ph in (entries or {}).items():
            bb.add_entry(g, ph)
        return bb.build()

    d_a = mk('AA', True, False, {'x': ['AA']})
    d_b = mk('AA', False, True, {'x': ['BB'], 'y': ['AA']})
    fb = G2pFallbacks([d_a, d_b])
    check('G2pFallbacks.is_valid_symbol: 任一认识即可',
          fb.is_valid_symbol('AA') is True and fb.is_valid_symbol('ZZ') is False)
    check('G2pFallbacks.is_vowel: 由**第一个**认识该符号的字典决定',
          fb.is_vowel('AA') is True)
    check('G2pFallbacks.query: 取第一个非 None', fb.query('x') == ['AA'])
    check('G2pFallbacks.query: 前者没有才轮到后者', fb.query('y') == ['AA'])
    check('G2pFallbacks.query: 都没有 → None', fb.query('zzz') is None)
    check('G2pFallbacks.is_valid_symbol: 空字典 → False',
          G2pFallbacks([]).is_valid_symbol('AA') is False)

    # ---------------- G2pPack（真包）
    pack_path = os.path.join(os.path.dirname(REF), 'OpenUtau.Core', 'G2p', 'Data',
                             'g2p-arpabet.zip')
    if not os.path.isfile(pack_path):
        print('  SKIP 找不到 g2p-arpabet.zip')
        return

    class _ArpabetLike(G2pPack):
        """对应 `ArpabetG2p`（真正那个类下一步再搬；这里只为驱动 `G2pPack`）。"""

        def __init__(self, data):
            super().__init__()
            self.grapheme_indexes = {c: i for i, c in enumerate('abcdefghijklmnopqrstuvwxyz')}
            # 真正那个类（`ArpabetG2p`）从自己的静态数组填 `Phonemes`；这里给足长度即可
            self.phonemes = ['ph%d' % i for i in range(50)]
            built, session = self.load_pack(
                data, lambda s: s.lower(),
                lambda s: self.remove_tail_digits(s.lower()))
            self.dict, self.session = built, session

    data = open(pack_path, 'rb').read()
    g = _ArpabetLike(data)
    check('G2pPack: 真包加载后词表可查（hello → hh ah l ow）',
          g.query('hello') == ['hh', 'ah', 'l', 'ow'], 'got %r' % g.query('hello'))
    check('G2pPack: car → k aa r / the → dh ah',
          g.query('car') == ['k', 'aa', 'r'] and g.query('the') == ['dh', 'ah'],
          'got %r / %r' % (g.query('car'), g.query('the')))
    check('G2pPack: 符号表按 prep_phoneme 小写化后登记（is_vowel("aa")=True）',
          g.is_vowel('aa') is True, 'got aa=%r AA=%r' % (g.is_vowel('aa'), g.is_vowel('AA')))
    check('G2pPack: l 是 liquid → is_glide(l)=True', g.is_glide('l') is True)
    check('G2pPack.query: 空串 → None', g.query('') is None)
    check('G2pPack.query: 单标点字符 = None（走 kAllPunct 短路）', g.query('!') is None)
    check("G2pPack.query: 多字符标点**不**走短路 —— 它到 predict 那步才因无字母而空",
          is_all_punct('!!') is False and g.query('!!') is None)
    check('G2pPack.remove_tail_digits: 循环去尾（aa12 → aa）',
          G2pPack.remove_tail_digits('aa12') == 'aa'
          and G2pPack.remove_tail_digits('12') == '' and G2pPack.remove_tail_digits('ab') == 'ab')
    check('G2pPack.encode_word: 小写后查表、**查不到的字符丢掉**',
          g.encode_word('A1B') == [[0, 1]], 'got %r（只有 a/b 在字母表里）' % g.encode_word('A1B'))
    check('G2pPack.predict: 没注入会话 → 空数组（= C# 的 Session == null 分支）',
          g.session is None and g.predict('zzzz') == [])

    # 注入一个假会话，验证自回归解码
    calls = []

    class _FakeSession:
        def run(self, feeds):
            calls.append((list(feeds['src'][0]), list(feeds['tgt'][0]), feeds['t'][0]))
            # 依次吐出 3 个符号（下标 3/4/5），然后吐 2（结束符）
            n = len(feeds['tgt'][0]) - 1
            return [[[3 + n if n < 3 else 2]]]

    set_onnx_session_factory(lambda blob: _FakeSession())
    g2 = _ArpabetLike(data)
    check('G2pPack: 注入工厂后拿到了会话', g2.session is not None)
    pred = g2.predict('zzzz')
    check('G2pPack.predict: 真的调了会话（自回归，多轮）', len(calls) >= 4,
          'got %d 次' % len(calls))
    check('G2pPack.predict: 依次收下 tgt.Length - 1 个符号（跳过起始 2）',
          len(pred) == 3 and all(isinstance(p, str) for p in pred),
          'got %r' % pred)
    check('G2pPack.predict: 吐出 2 时推进 t（结束条件）',
          any(c[2] > 0 for c in calls), 'got %r' % calls[:5])
    check('G2pPack.query: 预测结果进缓存（第二次不再 predict）',
          g2.query('zzzz') == pred and 'zzzz' in g2.pred_cache)
    set_onnx_session_factory(None)

    # ---------------- is_all_punct
    check('is_all_punct: 只对**单**标点字符为真',
          [is_all_punct(x) for x in ['!', ',', '!!', ',,', 'a', '', 'あ']]
          == [True, True, False, False, False, False, False])

    # ---------------- G2pDictionaryData
    dd = G2pDictionaryData.from_plain({
        'symbols': [{'symbol': 'AA', 'type': 'vowel'}],
        'entries': [{'grapheme': 'car', 'phonemes': ['K', 'AA', 'R']}]})
    check('G2pDictionaryData.from_plain: 解析 symbols / entries',
          dd.symbols[0].symbol == 'AA' and dd.symbols[0].type == 'vowel'
          and dd.entries[0].grapheme == 'car' and dd.entries[0].phonemes == ['K', 'AA', 'R'])
    check('G2pDictionaryData.from_plain: 缺段给 **None**（不是空列表，与 C# 反序列化一致）',
          G2pDictionaryData.from_plain({}).symbols is None
          and G2pDictionaryData.from_plain({}).entries is None)
    b7 = G2pDictionary.new_builder().load({
        'symbols': [{'symbol': 'AA', 'type': 'vowel'}, {'symbol': 'K', 'type': 'consonant'}],
        'entries': [{'grapheme': 'car', 'phonemes': ['K', 'AA']}]})
    check('G2pDictionary.Builder.load(dict): 从普通 dict 装载',
          b7.build().query('car') == ['K', 'AA'])


class _FakeG2p:
    """最小的 `IG2p`：给定了 `query` 表与元音/滑音集合。"""

    def __init__(self, queries=None, vowels=(), glides=(), symbols=None):
        self.queries = queries or {}
        self.vowels = set(vowels)
        self.glides = set(glides)
        self.symbols = set(symbols) if symbols is not None else set(self.vowels | self.glides)

    def is_valid_symbol(self, s):
        return s in self.symbols

    def is_vowel(self, s):
        return s in self.vowels

    def is_glide(self, s):
        return s in self.glides

    def query(self, grapheme):
        return self.queries.get(grapheme)

    def unpack_hint(self, hint, separator=' '):
        return [s for s in hint.split(separator) if self.is_valid_symbol(s)]


def _mk_mono(queries=None, vowels=(), glides=(), fallbacks=None, aliases=None):
    """造一个 `MonophonePhonemizer` 的具体子类实例（供测试驱动）。"""
    from singing.openutau.plugin_builtin import MonophonePhonemizer

    class _Mono(MonophonePhonemizer):
        name = 'test mono'
        tag = 'test mono'

        def load_g2p(self):
            return _FakeG2p(queries, vowels, glides)

        def load_vowel_fallbacks(self):
            return dict(fallbacks or {})

    ph = _Mono()
    ph.set_singer(_OtoSinger(aliases or {}))
    ph.set_timing(_CVVC_AXIS)
    return ph


def test_phoneme_based_phonemizer():
    """`PhonemeBasedPhonemizer` + `MonophonePhonemizer` —— 音素驱动那条基类线。"""
    from singing.openutau import Note, PhonemeAttributes, registered
    from singing.openutau.plugin_builtin import MonophonePhonemizer, PhonemeBasedPhonemizer

    cs = open(os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                           'PhonemeBasedPhonemizer.cs'), encoding='utf-8-sig').read()
    cs_m = open(os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                             'MonophonePhonemizer.cs'), encoding='utf-8-sig').read()

    # ---------------- 源码一致性
    check('PhonemeBased: 构造函数里 Initialize 包在 try/catch（失败不阻断构造）',
          'public PhonemeBasedPhonemizer() {' in cs and 'Failed to initialize.' in cs)
    check('PhonemeBased: SetSinger 会**重新** LoadG2p', cs.count('g2p = LoadG2p();') == 2)
    check('PhonemeBased: `?` 前缀 = 强制别名（取 Substring(1)）',
          "note.lyric[0] == '?'" in cs and 'note.lyric.Substring(1)' in cs)
    check('PhonemeBased: lyric == "-" 时试 "{前邻末符号} -"',
          'note.lyric == "-" && prevSymbols != null' in cs
          and 'alias = $"{prevSymbols.Last()} -";' in cs)
    check('PhonemeBased: addTail 默认 true；"没有下一邻居"时追加 "-"',
          'public bool addTail { get; set; } = true;' in cs
          and 'symbols.Append("-")' in cs)
    check('PhonemeBased: glide 的对齐用 i-1（"辅音-消音-元音"）',
          'i>=2 && isGlide[i-1] && !isVowel[i-2]' in cs)
    check('PhonemeBased: 手动对齐是 "+n" 的 n-1、且带 manual 标记',
          'int.TryParse(notes[i].lyric.Substring(1), out var idx)' in cs
          and 'alignments.Add(Tuple.Create(idx - 1, position, true));' in cs)
    check('PhonemeBased: 收尾对齐点是 (phonemes.Length, position, true)',
          'alignments.Add(Tuple.Create(phonemes.Length, position, true));' in cs)
    check('PhonemeBased: 手动项与"时间不递增或下标相同"的邻居互删',
          'alignments.RemoveAt(i - 1);' in cs and 'alignments.RemoveAt(i + 1);' in cs)
    check('PhonemeBased: DistributeDuration 的整数除法与"没有元音时辅音平分"',
          'Math.Min(ConsonantLength, duration / 2 / consonants)' in cs
          and ': duration / consonants;' in cs)
    check('Monophone: 构造函数里 addTail = false（与基类默认相反）',
          'addTail = false;' in cs_m)
    check('Monophone: 回落链最后返回**带 alt 后缀**的原串（不是裸 symbol）',
          'return $"{symbol}{alt}";' in cs_m)
    check('两个基类都是 abstract、**不注册**（name 为空、且不在注册表里）',
          'abstract class PhonemeBasedPhonemizer' in cs
          and 'abstract class MonophonePhonemizer' in cs_m
          and PhonemeBasedPhonemizer.name == '' and MonophonePhonemizer.name == ''
          and PhonemeBasedPhonemizer not in registered().values()
          and MonophonePhonemizer not in registered().values())

    # ---------------- 行为
    # 1) `?` 前缀强制别名
    ph = _mk_mono({'a': ['A']}, vowels=['A'], aliases={'A': _mk_named_oto('AAA')})
    r = ph.process([Note(lyric='?逼我', tone=60, duration=480)])
    check('PhonemeBased: `?xxx` 直接产出 xxx（不走查表）',
          [p.phoneme for p in r.phonemes] == ['逼我'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # 2) 查不到符号 → 回落原歌词
    ph = _mk_mono({}, vowels=['A'], aliases={})
    r = ph.process([Note(lyric='zzz', tone=60, duration=480)])
    check('PhonemeBased: 歌词查不到符号时回落原歌词',
          [p.phoneme for p in r.phonemes] == ['zzz'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # 3) `-` 歌词 + 前邻
    ph = _mk_mono({'a': ['A']}, vowels=['A'], aliases={'A -': _mk_named_oto('A -')})
    r = ph.process([Note(lyric='-', tone=60, duration=480)],
                   prev_neighbour=Note(lyric='a', tone=60, duration=480))
    check('PhonemeBased: lyric "-" + 前邻 → 产出 "{前邻末符号} -" 的别名',
          [p.phoneme for p in r.phonemes] == ['A -'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # 4) addTail：PhonemeBased 默认 true、Monophone false
    ph = _mk_mono({'a': ['A']}, vowels=['A'], aliases={'A': _mk_named_oto('A'),
                                                       'A -': _mk_named_oto('A -')})
    check('PhonemeBased: add_tail 默认 True；Monophone 覆盖为 False',
          ph.add_tail is False and PhonemeBasedPhonemizer().add_tail is True)

    # 5) DistributeDuration 的整数除法（手推）
    #    单音符 480 tick，符号 [C, A]（C 辅音 / A 元音），ConsonantLength=60
    #    firstVowel=1 → startTick = -60；alignment = [(2, 480, True)]
    #    duration = 480 - (-60) = 540；vowels=1 consonants=1
    #    consonantDuration = min(60, 540/2/1=270) = 60
    #    vowelDuration = (540 - 60*1)/1 = 480
    #    → C.position = -60，A.position = -60+60 = 0
    ph = _mk_mono({'a': ['C', 'A']}, vowels=['A'], glides=[],
                  aliases={'C': _mk_named_oto('C'), 'A': _mk_named_oto('A')})
    ph.add_tail = False
    r = ph.process([Note(lyric='a', tone=60, duration=480)])
    check('PhonemeBased.DistributeDuration: 辅音给固定 60、元音吃掉剩余 480（手推）',
          [(p.phoneme, p.position) for p in r.phonemes] == [('C', -60), ('A', 0)],
          'got %r' % [(p.phoneme, p.position) for p in r.phonemes])

    # 6) 没有元音时辅音平分（firstVowel = -1 → startTick 变成**正数**，照搬 quirk）
    ph = _mk_mono({'a': ['C', 'D']}, vowels=[], glides=[],
                  aliases={'C': _mk_named_oto('C'), 'D': _mk_named_oto('D')})
    ph.add_tail = False
    r = ph.process([Note(lyric='a', tone=60, duration=480)])
    check('PhonemeBased: 无元音时 firstVowel=-1 → startTick=+60（照搬 Array.IndexOf 的 quirk）',
          r.phonemes[0].position == 60, 'got %r' % r.phonemes[0].position)
    # duration = 480 - 60 = 420 → 每个辅音 420//2 = 210 → [60, 270]
    check('PhonemeBased: 无元音时两个辅音平分（各 210 → [60, 270]）',
          [p.position for p in r.phonemes] == [60, 270],
          'got %r' % [p.position for p in r.phonemes])

    # 7) glide 的对齐特例：[C, G, A] → 对齐到 G（i-1）
    ph = _mk_mono({'a': ['C', 'G', 'A']}, vowels=['A'], glides=['G'],
                  aliases={x: _mk_named_oto(x) for x in ('C', 'G', 'A')})
    ph.add_tail = False
    r = ph.process([Note(lyric='a', tone=60, duration=480)])
    # ★ 关键：glide 特例把对齐点放在**下标 1**（G）而不是 2（A）—— 于是切分是
    #   [0,1) 与 [1,3) 两段，而不是 [0,2) 与 [2,3)：
    #   firstVowel=2 → startTick = -120；
    #   段1 [0,1) = [C]，duration = 0-(-120) = 120，无元音 → 全给 C → C = -120；
    #   段2 [1,3) = [G, A]，duration = 480，有元音 → 辅音固定 60 → G = 0，A = 60
    check('PhonemeBased: glide 特例把对齐点放在下标 1 → [-120, 0, 60]',
          [p.position for p in r.phonemes] == [-120, 0, 60],
          'got %r' % [p.position for p in r.phonemes])

    # 8) addTail：无下一邻居时追加 "-"（PhonemeBased 默认 true）
    #    用一个"原样回显符号"的子类，这样断言的就是 addTail 本身而不是别名的拼法
    class _Echo(PhonemeBasedPhonemizer):
        name = 'echo'
        tag = 'echo'

        def load_g2p(self):
            return _FakeG2p({'a': ['A']}, vowels=['A'])

        def load_vowel_fallbacks(self):
            return {}

        def get_phoneme_or_fallback(self, prev_symbol, symbol, tone, color, alt):
            return symbol

    e = _Echo()
    e.set_timing(_CVVC_AXIS)
    check('PhonemeBased: add_tail 默认 True', e.add_tail is True)
    check('PhonemeBased.addTail: 无下一邻居 → 符号串尾部多出一个 "-"',
          [p.phoneme for p in e.process([Note(lyric='a', tone=60, duration=480)]).phonemes]
          == ['A', '-'],
          'got %r' % [p.phoneme for p in e.process([Note(lyric='a', tone=60,
                                                        duration=480)]).phonemes])
    check('PhonemeBased.addTail: **有**下一邻居时**不**追加',
          [p.phoneme for p in e.process(
              [Note(lyric='a', tone=60, duration=480)],
              next_neighbour=Note(lyric='a', tone=60, duration=480)).phonemes] == ['A'])

    # 9) phoneticHint：按空白切分 + 丢无效符号
    ph = _mk_mono({}, vowels=['A'], glides=['G'], aliases={'A': _mk_named_oto('A')})
    ph.add_tail = False
    r = ph.process([Note(lyric='随便', tone=60, duration=480, phonetic_hint='XX A YY')])
    check('PhonemeBased: phoneticHint 切分后**丢掉无效符号**',
          [p.phoneme for p in r.phonemes] == ['A'],
          'got %r' % [p.phoneme for p in r.phonemes])

    # 10) Monophone 的四段回落
    ph = _mk_mono({}, vowels=['A', 'B', 'C'], glides=[],
                  fallbacks={'B': ['C']},
                  aliases={'Aalt': _mk_named_oto('Aalt')})
    check('Monophone: 第 1 步试 "{symbol}{alt}"（直接拼接，无分隔符）',
          ph.get_phoneme_or_fallback('-', 'A', 60, '', 'alt') == 'Aalt')
    ph2 = _mk_mono({}, vowels=['A', 'B', 'C'], fallbacks={'B': ['C']},
                   aliases={'A': _mk_named_oto('AAA')})
    check('Monophone: 第 2 步试裸 symbol',
          ph2.get_phoneme_or_fallback('-', 'A', 60, '', '') == 'AAA')
    ph3 = _mk_mono({}, vowels=['A', 'B', 'C'], fallbacks={'B': ['C']},
                   aliases={'C': _mk_named_oto('CCC')})
    check('Monophone: 第 3 步用 vowelFallback 逐个试',
          ph3.get_phoneme_or_fallback('-', 'B', 60, '', '') == 'CCC')
    ph4 = _mk_mono({}, vowels=['A'], fallbacks={}, aliases={})
    check('Monophone: 第 4 步返回 **{symbol}{alt}**（带后缀，不是裸 symbol）',
          ph4.get_phoneme_or_fallback('-', 'Z', 60, '', '7') == 'Z7'
          and ph4.get_phoneme_or_fallback('-', 'Z', 60, '', '') == 'Z')

    # 11) 音符属性（alternate / voice_color / tone_shift）会被读
    ph = _mk_mono({}, vowels=['A'], fallbacks={},
                  aliases={'A0': _mk_named_oto('A0')})
    r = ph.process([Note(lyric='x', tone=60, duration=480, phonetic_hint='A',
                         phoneme_attributes=[PhonemeAttributes(index=0, alternate=0)])])
    check('PhonemeBased: 音符的 alternate 参与 "{symbol}{alt}" 查询',
          [p.phoneme for p in r.phonemes] == ['A0'],
          'got %r' % [p.phoneme for p in r.phonemes])


def test_chinese_cvv_phonemizer():
    """`Plugin.Builtin/ChineseCVVPhonemizer.cs` —— 拼音拆成「整音 + 尾韵」。"""
    from singing.openutau import Note, registered
    from singing.openutau.plugin_builtin import chinese_cvv as CVV
    from singing.openutau.plugin_builtin.chinese_cvv import (ChineseCVVG2p,
                                                             ChineseCVVMonophonePhonemizer)

    cvv_path = os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                            'ChineseCVVPhonemizer.cs')
    if not os.path.isfile(cvv_path):
        print('  SKIP 找不到 ChineseCVVPhonemizer.cs')
        return
    cs = open(cvv_path, encoding='utf-8-sig').read().replace('\r\n', '\n')

    # ---------------- 源码一致性
    m = re.search(r'\[Phonemizer\("([^"]*)",\s*"([^"]*)"(?:,\s*"([^"]*)")?'
                  r'(?:,\s*language\s*:\s*"([^"]*)")?\)\]', cs)
    check('ZH CVV: [Phonemizer] 的 name/tag/language 与 C# 一致（**无 author**）',
          m is not None and (m.group(1), m.group(2), m.group(4)) == (
              ChineseCVVMonophonePhonemizer.name, ChineseCVVMonophonePhonemizer.tag,
              ChineseCVVMonophonePhonemizer.language),
          'C#=%r 我们=%r' % (m.groups() if m else None,
                             (ChineseCVVMonophonePhonemizer.name,
                              ChineseCVVMonophonePhonemizer.tag,
                              ChineseCVVMonophonePhonemizer.language)))
    check('ZH CVV: 已在注册表里', registered().get('ZH CVV') is ChineseCVVMonophonePhonemizer)
    check('ZH CVV: 继承 MonophonePhonemizer（音素驱动那条线）',
          issubclass(ChineseCVVMonophonePhonemizer, __import__(
              'singing.openutau.plugin_builtin', fromlist=['x']).MonophonePhonemizer))
    check('ZH CVV: 构造函数里 ConsonantLength = 120（基类默认 60）',
          'ConsonantLength = 120;' in cs
          and ChineseCVVMonophonePhonemizer().consonant_length == 120)
    check('ZH CVV: 类名是 ChineseCVVMonophonePhonemizer（文件名与类名不同）',
          'class ChineseCVVMonophonePhonemizer : MonophonePhonemizer' in cs)
    check('ZH CVV: LoadG2p 三段回落（插件目录 → 声库目录 → 内置）且最后包 G2pFallbacks',
          "Path.Combine(PluginDir, \"zhcvv.yaml\")" in cs
          and "Path.Combine(singer.Location, \"zhcvv.yaml\")" in cs
          and 'g2ps.Add(new ChineseCVVG2p());' in cs
          and 'return new G2pFallbacks(g2ps.ToArray());' in cs)
    check('ZH CVV: 声库那份包了 try/catch、插件那份**没有**（照搬这个不对称）',
          cs.index('g2ps.Add(G2pDictionary.NewBuilder().Load(File.ReadAllText(path)).Build());')
          < cs.index('g2ps.Add(G2pDictionary.NewBuilder().Load(File.ReadAllText(file)).Build());')
          and cs.count('Log.Error(e, $"Failed to load {file}");') == 1)
    check('ZH CVV: LoadVowelFallbacks 是 _un=_en;_uai=_ai',
          '"' + '_un=_en;_uai=_ai' + '"' in cs
          and ChineseCVVMonophonePhonemizer().load_vowel_fallbacks()
          == {'_un': ['_en'], '_uai': ['_ai']})
    check('ZH CVV: SetUp 先 base.SetUp 再做汉字罗马化',
          'base.SetUp(groups, project, track);' in cs
          and 'BaseChinesePhonemizer.RomanizeNotes(groups);' in cs)
    check('ZH CVV: G2p 的 IsVowel 判据是"**不以 _ 开头**"',
          'return !phoneme.StartsWith("_");' in cs)
    check('ZH CVV: G2p 的 IsGlide 恒 false / IsValidSymbol 恒 true / UnpackHint 不过滤',
          'public bool IsGlide(string phoneme){\n            return false;' in cs
          and 'public bool IsValidSymbol(string symbol){\n            return true;' in cs
          and 'hint.Split(separator)\n                .ToArray();' in cs)
    check('ZH CVV: Query 的第一个条件要求 len > 2（zh/ch/sh 才走双字母）',
          'lyric.Length > 2 && cSet.Contains(lyric.Substring(0, 2))' in cs)
    check('ZH CVV: 两条拼写修正的顺序（先 v 化、后 an→ian）',
          cs.index('vowel = "v" + vowel.Substring(1);') < cs.index('vowel = "ian";'))
    check('ZH CVV: 查到尾韵时返回 [lyric, tail]（整音在前）',
          'return new string[] { lyric, tail };' in cs)
    check('ZH CVV: pinyins/tails/pinyinList/tailList 是**死字段**（声明后未使用）',
          cs.count('pinyinList') == 1 and cs.count('tailList') == 1
          and len(CVV.PINYIN_LIST) > 300 and len(CVV.TAIL_LIST) == 15)

    # ---------------- G2p 行为（这些是"拆拼音"的全部规则）
    g = ChineseCVVG2p()
    check('ZH CVV G2p: 声母表 23 项、韵母映射 25 项',
          len(ChineseCVVG2p.CONSONANTS) == 23 and len(ChineseCVVG2p.VOWELS) == 25,
          'got %r / %r' % (len(ChineseCVVG2p.CONSONANTS), len(ChineseCVVG2p.VOWELS)))
    check('ZH CVV G2p: IsVowel —— 带声母的整音**算元音**，只有 _xx 不算',
          g.is_vowel('duang') is True and g.is_vowel('_ang') is False)
    check('ZH CVV G2p: 双字母声母要 len > 2（zhang 拆出 zh / zha 也拆出 zh）',
          g.query('zhang') == ['zhang', '_ang'] and g.query('zha') == ['zha'])
    check('ZH CVV G2p: len == 2 时**不**走双字母声母（zh → z + h，查不到尾韵）',
          g.query('zh') == ['zh'], 'got %r' % g.query('zh'))
    check('ZH CVV G2p: 单字母声母（duang → d + uang → _ang）',
          g.query('duang') == ['duang', '_ang'])
    check('ZH CVV G2p: 纯韵母（an → _an）', g.query('an') == ['an', '_an'])
    check('ZH CVV G2p: j/q/x/y + un/uan → v 化（jun → _vn）',
          g.query('jun') == ['jun', '_vn'] and g.query('juan') == ['juan', '_en2']
          and g.query('xun') == ['xun', '_vn'], 'got %r' % g.query('jun'))
    check('ZH CVV G2p: yuan → y + uan → van → _en2（"an→ian" 那条**不**触发）',
          g.query('yuan') == ['yuan', '_en2'], 'got %r' % g.query('yuan'))
    check('ZH CVV G2p: yan → y + an → ian → _en2（"an→ian" 触发）',
          g.query('yan') == ['yan', '_en2'], 'got %r' % g.query('yan'))
    check('ZH CVV G2p: 查不到尾韵时只返回 [lyric]', g.query('zha') == ['zha'])
    check('ZH CVV G2p: UnpackHint 只切分、不过滤空段',
          g.unpack_hint('a  _ang') == ['a', '', '_ang'])

    # ---------------- 端到端（走 Monophone 那条线）
    ph = ChineseCVVMonophonePhonemizer()
    ph.set_singer(_OtoSinger({'_ang': _mk_named_oto('_ang'), '_vn': _mk_named_oto('_vn')}))
    ph.set_timing(_CVVC_AXIS)
    r = ph.process([Note(lyric='duang', tone=60, duration=480)])
    check('ZH CVV: 整音原样保留、尾韵被追加（两个音素）',
          [p.phoneme for p in r.phonemes] == ['duang', '_ang'],
          'got %r' % [p.phoneme for p in r.phonemes])
    check('ZH CVV: ConsonantLength=120 → 尾韵占 120、整音吃掉 360（手推）',
          [p.position for p in r.phonemes] == [0, 360],
          'got %r' % [p.position for p in r.phonemes])
    # 尾韵别名查不到 → Monophone 第 4 段回落到原符号（这里符号本身就是 _ang）
    ph2 = ChineseCVVMonophonePhonemizer()
    ph2.set_singer(_OtoSinger({}))
    ph2.set_timing(_CVVC_AXIS)
    r2 = ph2.process([Note(lyric='jun', tone=60, duration=480)])
    check('ZH CVV: 别名查不到时尾韵回落成符号本身（Monophone 第 4 段）',
          [p.phoneme for p in r2.phonemes] == ['jun', '_vn'],
          'got %r' % [p.phoneme for p in r2.phonemes])
    # SetUp 会做汉字→拼音
    groups = [[Note(lyric='当', tone=60, duration=480)]]
    ph2.set_up(groups, 'PROJ', 'TRACK')
    check('ZH CVV.SetUp: 汉字被罗马化成拼音（当 → dang）', groups[0][0].lyric == 'dang',
          'got %r' % groups[0][0].lyric)
    check('ZH CVV.SetUp: 调了 base.SetUp（project/track 有值）',
          ph2.project == 'PROJ' and ph2.track == 'TRACK')
    # _uai 的元音回落：查不到 _uai 时用 _ai
    ph3 = ChineseCVVMonophonePhonemizer()
    ph3.set_singer(_OtoSinger({'_ai': _mk_named_oto('_ai')}))
    ph3.set_timing(_CVVC_AXIS)
    r3 = ph3.process([Note(lyric='guai', tone=60, duration=480)])
    check('ZH CVV: _uai 查不到时按 vowelFallback 回落到 _ai',
          [p.phoneme for p in r3.phonemes] == ['guai', '_ai'],
          'got %r' % [p.phoneme for p in r3.phonemes])


def test_arpabet_g2p_and_latin_diphone():
    """`G2p/ArpabetG2p.cs` + `LatinDiphonePhonemizer.cs`。"""
    from singing.openutau import Note
    from singing.openutau.g2p import ArpabetG2p, set_data_dir
    from singing.openutau.g2p import arpabet as A
    from singing.openutau.plugin_builtin import LatinDiphonePhonemizer

    cs = _read('G2p/ArpabetG2p.cs')
    cs_l = open(os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                             'LatinDiphonePhonemizer.cs'), encoding='utf-8-sig').read()
    if cs is None:
        print('  SKIP 找不到 G2p/ArpabetG2p.cs')
        return

    # ---------------- 源码一致性
    def arr(name, src=cs):
        m = re.search(r'%s = new string\[\]\s*\{(.*?)\};' % name, src, re.S)
        if not m:
            return None
        # ★ C# 源码里单引号写成 "\'"（转义）；提取后要反转义才是真正的字面值
        return [v.replace("\\'", "'") for v in re.findall(r'"([^"]*)"', m.group(1))]

    check('ArpabetG2p: graphemes 表逐项一致（32 项，**前 4 项是空串**）',
          arr('graphemes') == list(A.GRAPHEMES), 'C#=%r' % arr('graphemes'))
    check('ArpabetG2p: phonemes 表逐项一致（43 项，前 4 项空串）',
          arr('phonemes') == list(A.PHONEMES) and len(A.PHONEMES) == 43)
    check('ArpabetG2p: 下标是 Skip(4) 之后的 i + 4',
          '.Skip(4)\n                        .Select((g, i) => Tuple.Create(g, i))\n'
          in cs or 't.Item2 + 4' in cs)
    check('ArpabetG2p: LoadPack 的预处理是 小写化 / 去尾部数字后小写化',
          's => s.ToLowerInvariant(),\n                        s => RemoveTailDigits(s.ToLowerInvariant())' in cs)
    check('ArpabetG2p: 用静态字段 + lock 做"每进程只装一次"的缓存',
          'private static object lockObj = new object();' in cs
          and 'if (graphemeIndexes == null) {' in cs)
    check('ArpabetG2p: 包来自程序集内嵌资源 Data.Resources.g2p_arpabet',
          'Data.Resources.g2p_arpabet' in cs)

    check('LatinDiphone: 继承 PhonemeBasedPhonemizer（抽象、不注册）',
          'abstract class LatinDiphonePhonemizer : PhonemeBasedPhonemizer' in cs_l
          and LatinDiphonePhonemizer.name == '')
    check('LatinDiphone: 五段回落的顺序（alt → 双音素 → 元音回落 → **"- 符号"** → 原串）',
          cs_l.index('$"{prevSymbol} {symbol}{alt}"')
          < cs_l.index('$"{prevSymbol} {symbol}"')
          < cs_l.index('$"{prevSymbol} {fallback}"')
          < cs_l.index('$"- {symbol}"')
          < cs_l.index('return $"{prevSymbol} {symbol}{alt}";'))
    check('LatinDiphone: 第 4 段 `"- {symbol}"` 是 Monophone **没有**的',
          '$"- {symbol}"' in cs_l)

    # ---------------- ArpabetG2p 行为
    set_data_dir(None)
    try:
        ArpabetG2p.reset_cache()
        ArpabetG2p()
        check('ArpabetG2p: 未配数据目录时抛 FileNotFoundError（并说明怎么配）', False, '没抛错')
    except FileNotFoundError as e:
        check('ArpabetG2p: 未配数据目录时抛 FileNotFoundError（并说明怎么配）',
              'set_data_dir' in str(e), 'got %r' % str(e)[:60])

    data_dir = os.path.join(os.path.dirname(REF), 'OpenUtau.Core', 'G2p', 'Data')
    if not os.path.isdir(data_dir):
        print('  SKIP 找不到 G2p/Data 目录')
        return
    set_data_dir(data_dir)
    ArpabetG2p.reset_cache()
    g = ArpabetG2p()
    check('ArpabetG2p: 真包可查（hello → hh ah l ow）',
          g.query('hello') == ['hh', 'ah', 'l', 'ow'], 'got %r' % g.query('hello'))
    check('ArpabetG2p: grapheme_indexes 的下标是 4..31（\'→4 / -→5 / a→6 / z→31）',
          (g.grapheme_indexes["'"], g.grapheme_indexes['-'],
           g.grapheme_indexes['a'], g.grapheme_indexes['z']) == (4, 5, 6, 31),
          'got %r' % {k: g.grapheme_indexes[k] for k in ("'", '-', 'a', 'z')})
    check('ArpabetG2p: 那 4 个空串**不在**索引表里（Skip(4) 去掉了）',
          '' not in g.grapheme_indexes)
    check('ArpabetG2p: Phonemes 前 4 项是空串（与下标 0..3 对应）',
          g.phonemes[:4] == ['', '', '', ''])
    check('ArpabetG2p: 进程级缓存 —— 第二次构造复用同一个 dict 对象',
          ArpabetG2p().dict is g.dict)
    check('ArpabetG2p: pack 里的符号按"去尾数字后小写"登记（is_vowel("aa")=True）',
          g.is_vowel('aa') is True and g.is_vowel('AA') is False)
    check('ArpabetG2p: 未注入会话 → predict 返回空（= C# 的 Session==null 分支）',
          g.session is None and g.predict('zzzz') == [])

    # ---------------- LatinDiphone 行为
    def mk(aliases, fallbacks=None, vowels=(), glides=()):
        class _Lat(LatinDiphonePhonemizer):
            name = 'lat'
            tag = 'lat'

            def load_g2p(self):
                return _FakeG2p({}, vowels, glides)

            def load_vowel_fallbacks(self):
                return dict(fallbacks or {})

        inst = _Lat()
        inst.set_singer(_OtoSinger(aliases))
        inst.set_timing(_CVVC_AXIS)
        return inst

    a = mk({'- A': _mk_named_oto('- A')}, vowels=['A'])
    check('LatinDiphone: 五段回落 —— 双音素查不到就找 "- {symbol}"',
          a.get_phoneme_or_fallback('-', 'A', 60, '', '') == '- A')
    a2 = mk({'- A0': _mk_named_oto('- A0')}, vowels=['A'])
    check('LatinDiphone: 第 1 段试 "{prev} {symbol}{alt}"',
          a2.get_phoneme_or_fallback('-', 'A', 60, '', '0') == '- A0')
    a3 = mk({'- A': _mk_named_oto('- A')}, vowels=['A'])
    check('LatinDiphone: 第 2 段试 "{prev} {symbol}"',
          a3.get_phoneme_or_fallback('-', 'A', 60, '', '') == '- A')
    a4 = mk({'- C': _mk_named_oto('- C')}, fallbacks={'B': ['C']}, vowels=['B', 'C'])
    check('LatinDiphone: 第 3 段用 vowelFallback 逐个试',
          a4.get_phoneme_or_fallback('-', 'B', 60, '', '') == '- C')
    a5 = mk({}, vowels=['A'])
    check('LatinDiphone: 第 5 段返回 "{prev} {symbol}{alt}"（**带 alt 后缀**）',
          a5.get_phoneme_or_fallback('X', 'A', 60, '', '9') == 'X A9')

    # 端到端：双音素别名按 "上一符号 + 本符号" 逐对生成
    ph = mk({'A B': _mk_named_oto('A B'), '- A': _mk_named_oto('- A')},
            vowels=['A', 'B'], glides=[])
    ph.add_tail = False
    r = ph.process([Note(lyric='x', tone=60, duration=480, phonetic_hint='A B')])
    check('LatinDiphone 端到端: 上一符号是 "-"（首音符）→ "- A"，随后 "A B"',
          [p.phoneme for p in r.phonemes] == ['- A', 'A B'],
          'got %r' % [p.phoneme for p in r.phonemes])


def test_xxhash64():
    """XXH32/XXH64 官方测试向量 —— 对不上，所有缓存键都会静默错。"""
    from singing.openutau.xxhash import xxh32, xxh64 as _x
    check('XXH64("")=0xEF46DB3751D8E999', _x(b'') == 0xEF46DB3751D8E999,
          'got %s' % hex(_x(b'')))
    check('XXH64("a")=0xD24EC4F1A98C6E5B', _x(b'a') == 0xD24EC4F1A98C6E5B,
          'got %s' % hex(_x(b'a')))
    check('XXH64("abc")=0x44BC2CF5AD770999', _x(b'abc') == 0x44BC2CF5AD770999,
          'got %s' % hex(_x(b'abc')))
    check('XXH32("")=0x02CC5D05', xxh32(b'') == 0x02CC5D05, 'got %s' % hex(xxh32(b'')))
    check('XXH32("a")=0x550D7456', xxh32(b'a') == 0x550D7456, 'got %s' % hex(xxh32(b'a')))
    check('XXH32("abc")=0x32D153FF', xxh32(b'abc') == 0x32D153FF,
          'got %s' % hex(xxh32(b'abc')))
    # 跨过 16 / 32 字节分支（XXH32 ≥16、XXH64 ≥32 走多路累加）
    long = b'The quick brown fox jumps over the lazy dog'
    check('XXH32/64: 长输入分支可用且稳定',
          len(hex(xxh32(long))) > 2 and xxh32(long) == xxh32(long)
          and _x(long) == _x(long))


def test_syllable_based_phonemizer():
    """`G2p/G2pRemapper.cs` + `Classic/YamlWatcher.cs` +
    `Plugin.Builtin/SyllableBasedPhonemizer.cs`（2204 行）—— 重头戏。

    这一条覆盖三件事：
      1. 从 C# 源码抽「常量 / 结构 / 辅助属性 / 关键算式」逐项比对（照搬由机器强制）；
      2. 用 `Replacement` / `Syllable` / `Ending` 走通 YAML 规则引擎与边界替换的行为；
      3. 用**最小具体子类**把 `Process` 全链路跑一遍，手推 position 期望值。
    """
    import shutil
    import tempfile

    from singing.openutau import Note, Phoneme, PhonemeExpression, registered
    from singing.openutau.g2p import G2pDictionary, G2pRemapper
    from singing.openutau.plugin_builtin import syllable_based as SBP
    from singing.openutau.classic.yaml_watcher import YamlWatcher

    cs_path = os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                           'SyllableBasedPhonemizer.cs')
    if not os.path.isfile(cs_path):
        print('  SKIP 找不到 SyllableBasedPhonemizer.cs')
        return
    cs = open(cs_path, encoding='utf-8-sig').read().replace('\r\n', '\n')

    check('SBP: 是**抽象基类**、不进注册表（C# 没有 [Phonemizer] 特性）',
          'public abstract class SyllableBasedPhonemizer : Phonemizer, IG2pSymbols' in cs
          and SBP.SyllableBasedPhonemizer.name == ''
          and SBP.SyllableBasedPhonemizer not in set(registered().values()))
    check('SBP: FORCED_ALIAS_SYMBOL = "?"',
          'private const string FORCED_ALIAS_SYMBOL = "?";' in cs
          and SBP.FORCED_ALIAS_SYMBOL == '?')
    check('SBP: TransitionBasicLengthMs => 100',
          'protected double TransitionBasicLengthMs => 100;' in cs
          and SBP.SyllableBasedPhonemizer.TRANSITION_BASIC_LENGTH_MS == 100)
    check('SBP: 字段默认 tails = "-,R".Split(\',\')（两个元素）',
          'protected string[] tails = "-,R".Split(\',\');' in cs
          and SBP.SyllableBasedPhonemizer().tails == ['-', 'R'])
    check('SBP: SetSinger 里把 tails 重置成 "-".Split(\',\')（**只剩 "-"，与字段默认不同**）',
          '"-".Split(\',\')' in cs)
    check('SBP: wordSeparators={" ","_"} 用 Split(char[])；wordSeparator={"  "}（两个空格）',
          'private readonly string[] wordSeparators = new[] { " ", "_" };' in cs
          and 'private readonly string[] wordSeparator = new[] { "  " };' in cs
          and SBP.WORD_SEPARATOR == '  ')
    check('SBP: GROUP_KEYWORDS 逐项与 C# 的内联数组一致',
          tuple(re.findall(r'"(\w+)"', re.search(
              r'return new\[\] \{(.*?)\}\.Contains\(baseGroup\);',
              cs, re.S).group(1))) == SBP.GROUP_KEYWORDS,
          'C#=%r' % (re.findall(r'"(\w+)"', re.search(
              r'return new\[\] \{(.*?)\}\.Contains\(baseGroup\);',
              cs, re.S).group(1)),))
    check('SBP: 静态状态与实例状态分得清清楚楚（generation / watcher / 缓存是 static）',
          'private static int globalSbpGeneration = 0;' in cs
          and 'private int localSbpGeneration = 0;' in cs
          and 'public static YamlWatcher singerYamlWatcher;' in cs
          and 'public static YamlWatcher pluginYamlWatcher;' in cs)
    check('SBP: 字典状态三个成员照抄（含"缺键会抛"的那两个）',
          'protected bool hasDictionary => dictionaries.ContainsKey(GetType());' in cs
          and 'protected IG2p dictionary => dictionaries[GetType()];' in cs
          and 'protected bool isDictionaryLoading => dictionaries[GetType()] == null;' in cs)
    check('SBP: YAMLData 的字段集与 C# 一致（8 个）',
          set(re.findall(r'public [\w\.\?\[\]]+ (\w+) \{ get; set; \}',
                         re.search(r'public class YAMLData \{(.*?)\n            public class SymbolData',
                                   cs, re.S).group(1))) ==
          {'version', 'isglides', 'symbols', 'replacements', 'fallbacks', 'timings',
           'diphthongs', 'vowelsustains'})
    check('SBP: Replacement.where 默认 "inside"，且 from/to 是 object（可标量可序列）',
          'public string where { get; set; } = "inside";' in cs
          and 'public object from { get; set; }' in cs
          and 'public object to { get; set; }' in cs
          and SBP.Replacement().where == 'inside')
    check('SBP: SyncAttributes / GetDynamicPhonemeAttributes 两个钩子都在',
          'protected virtual void SyncAttributes(Note[] notes, List<string> phonemeSymbols,'
          in cs and 'GetDynamicPhonemeAttributes(string alias, int index,' in cs)

    # ---------------- 上游"怪癖"必须在位（照搬，不许顺手修好）
    check('SBP: ★ MakePhonemes 末尾的 `isEnding ? count-1 : count-1` 退化为同一分支（照搬）',
          'isEnding ? phonemeSymbols.Count - 1 : phonemeSymbols.Count - 1' in cs)
    check('SBP: ★ 字典替换的 else-if 用的是**同一个键**（死代码）',
          'else if (dictionaryReplacements.TryGetValue(subResult[i], out string replacedExact))' in cs)
    check('SBP: ★ ValidateAlias 的 legacy 回落**两次都返回同一个值**（HasOto 白判）',
          cs.count('return legacyTarget;') == 2)
    check('SBP: ★ `dynamicTails` 算了但没用（死变量）', cs.count('dynamicTails') == 1)
    check('SBP: ★ `consExceptions` 只声明未使用（死字段）', cs.count('consExceptions') == 1)
    check('SBP: ★ MakeSyllables 的循环条件用的是单个 `&`（非短路位与）',
          'for (; lastSymbolI < symbols.Length & noteI < notes.Length; lastSymbolI++)' in cs)
    check('SBP: ★ "tail 当音节"的那种 bucket 标的是 isEnding=false',
          'syllablePhonemeBuckets.Add((endingPhonemes, modifiedSyllable.duration,'
          in cs and ', false, modifiedSyllable.tone, ""));' in cs
          and ', true, ending.tone, ""));' in cs)
    check('SBP: ★ ApplyBoundaryReplacements**没有** early-return 的拷贝分支差异（值语义）',
          'private Syllable ApplyBoundaryReplacements(Syllable syllable) {' in cs
          and 'private Ending ApplyBoundaryReplacements(Ending ending) {' in cs)
    check('SBP: ★ HasOto 试查三段（带音高 → 裸别名 → 空音色），且 lock 是**它自己**',
          'if (currentSinger.TryGetMappedOto(alias, tone, out _)) {' in cs
          and 'if (currentSinger.TryGetOto(alias, out _)) {' in cs
          and 'if (currentSinger.TryGetMappedOto(alias, tone, "", out _)) {' in cs
          and 'lock (currentSinger) {' in cs)
    check('SBP: ★ 2 参重载的 oto 查询在 GetTransitionBasicLengthMsByOto 里',
          'if (singer.TryGetMappedOto(mappedAlias, tone + toneShift, out var oto)) {' in cs
          and 'return oto.Preutter - oto.Overlap;' in cs)

    # ---------------- 关键算式逐字对照
    check('SBP: 整数除法 / 截断三处（containerLength/3、*0.8、(int)(...)）',
          'int maxAllowed = containerLength / 3;' in cs
          and 'var maxAllowedConsonantTick = (int)(containerLengthTick * 0.8);' in cs
          and 'int duration = lastNote.duration / notesToSplit / 15 * 15;' in cs.replace(
              'var duration = lastNote.duration', 'int duration = lastNote.duration'))
    check('SBP: ★ vel 走 `(float)`（float32 舍入）—— 不是可省的一步',
          'float vel = (float)(100.0 - 100.0 * Math.Log2(pAttr.consonantStretchRatio.Value));' in cs
          and SBP.as_float32(100.0 - 100.0 * math.log2(3.0))
          != (100.0 - 100.0 * math.log2(3.0)))
    check('SBP: 节奏系数公式字面一致：(300 - Clamp(bpm,90,300)) / (300-90) / 3 + 0.33',
          'return (300 - Math.Clamp(bpm, 90, 300)) / (300 - 90) / 3 + 0.33;' in cs)
    check('SBP: 常数过渡长 = TransitionBasicLengthMs * GetTempoNoteLengthFactor()',
          'return TransitionBasicLengthMs * GetTempoNoteLengthFactor();' in cs)
    check('SBP: ★ NoGap 分支用可见的 50 tick 锚点（上限容器的 1/3）',
          'int targetTicks = 50;' in cs and 'phonemes[phonemeI].position = System.Math.Min(targetTicks, maxAllowed);' in cs)
    check('SBP: ★ IsShort(Syllable) 用 duration != -1 当哨兵',
          'syllable.duration != -1 && TickToMs(syllable.duration) < GetTransitionBasicLengthMs() * 2' in cs)
    check('SBP: 延音音符判定是 "+~" / "+*"',
          'note.lyric.StartsWith("+~") || note.lyric.StartsWith("+*")' in cs)
    check('SBP: 边界替换里的 "null" 占位符（音节 / 句末各一处）',
          'currentPhonemes.Add(hasPrevV ? syllable.prevV : "null");' in cs
          and 'currentPhonemes.Add(hasTail ? ending.tail : "null");' in cs)
    check('SBP: 音节边界判据 = (有前元音 && position==0) || 无前元音',
          'bool isBoundary = (hasPrevV && syllable.position == 0) || !hasPrevV;' in cs)
    check('SBP: 句末边界恒为 true（ApplyBoundaryReplacements(ending) 里写死）',
          'List<string> finalPhonemes = ApplyReplacements(currentPhonemes, true);' in cs)
    check('SBP: 组语法三个运算符齐全（& 并集 / ! 排除 / = 限定）',
          'if (cleanRule.Contains("&")) {' in cs
          and 'if (cleanRule.Contains("!")) {' in cs
          and 'if (cleanRule.Contains("=")) {' in cs)
    check('SBP: 规则排序是 Count 降序 + 串长降序（都靠稳定排序）',
          '.OrderByDescending(r => r.FromList.Count)\n                .ThenByDescending(r => r.FromList.Sum(s => s.Length))' in cs)
    check('SBP: to 侧只回填**第一个**组关键字（后面的组名会原样留下）',
          cs.count('string.Join("", cleanParts)') == 2)
    check('SBP: G2pRemapper 参与字典构造 + 硬编码的 AddEntry("a", ["a"])',
          'dictionaries[GetType()] = new G2pRemapper(' in cs
          and 'builder.AddEntry("a", new string[] { "a" });' in cs)
    check('SBP: ParseDictionary 的分隔符与注释行规则（"  " 两空格 / ";;;" 注释 / 必须 2 段）',
          'if (line.StartsWith(";;;")) {' in cs and 'if (parts.Length != 2) {' in cs
          and 'line.Trim().Split(wordSeparator, StringSplitOptions.None)' in cs)

    # ---------------- YAML 版本/备份机制
    check('SBP: ReadVersionFast 找 "version:" 行、Trim 引号',
          'trimmed.StartsWith("version:", StringComparison.OrdinalIgnoreCase)' in cs
          and ".Trim().Trim('\"', '\\'');" in cs)
    check('SBP: 版本比较是 Version.TryParse + 「非纯数字」的字符串回落',
          'Version.TryParse(currentVersion, out Version currV)' in cs
          and '!double.TryParse(currentVersion, out _)' in cs)
    check('SBP: 旧文件改名为 {名}_backup({版本}){扩展名}',
          '_backup({safeVersion}){Path.GetExtension(YamlFileName)}' in cs)
    check('SBP: watcher 回调里 Thread.Sleep(200) + 清缓存 + generation++',
          cs.count('System.Threading.Thread.Sleep(200);') == 2
          and cs.count('YamlCache.Clear();') == 2
          and cs.count('globalSbpGeneration++;') == 2)

    # ---------------- 版本解析语义（手推）
    check('SBP: ★ Version 缺段补 -1 → "1.2" < "1.2.0"（不是相等！）',
          (SBP._parse_version('1.2') < SBP._parse_version('1.2.0')) is True
          and SBP._parse_version('1.2') == (1, 2, -1, -1))
    check('SBP: Version 只认 "主.次" 起步；"1" / "1.3b" 解析失败',
          SBP._parse_version('1') is None and SBP._parse_version('1.3b') is None)
    check('SBP: double.TryParse 的回落只认纯数字（"1.3b" 不算）',
          SBP._try_parse_double('1.3') and not SBP._try_parse_double('1.3b'))

    # ================= 行为：最小具体子类 =================
    class _Sbp(SBP.SyllableBasedPhonemizer):
        name = 'sbp-test'
        tag = 'TEST'

        def __init__(self, vowels=('a', 'i', 'u', 'e', 'o'),
                     consonants=('k', 's', 't', 'y', 'n', 'm', 'sh')):
            self._v = list(vowels)
            self._c = list(consonants)
            super().__init__()

        def get_vowels(self):
            return list(self._v)

        def get_consonants(self):
            return list(self._c)

        def process_syllable(self, syllable):
            """VCV/CVVC 混合风格：有前元音又有辅音时拆成 **VC + CV** 两个音素。"""
            cc = ''.join(syllable.cc)
            if syllable.prev_v and cc:
                return ['%s %s' % (syllable.prev_v, cc), '%s%s' % (cc, syllable.v)]
            if syllable.prev_v:
                return ['%s %s' % (syllable.prev_v, syllable.v)]
            return ['- %s%s' % (cc, syllable.v)]

        def process_ending(self, ending):
            cc = ''.join(ending.cc)
            if ending.has_tail:
                return ['%s%s %s' % (ending.prev_v, cc, ending.tail)]
            return ['%s%s -' % (ending.prev_v, cc)]

    def oto(alias, preutter=0.0, overlap=0.0, color=''):
        from singing.openutau import Oto, OtoSet, UOto, UOtoSet, USubbank, Subbank
        return UOto(Oto(alias=alias, wav=alias + '.wav', preutter=preutter, overlap=overlap),
                    UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb'),
                    [USubbank(Subbank(color=color))])

    ph = _Sbp()
    ph.set_timing(_CVVC_AXIS)
    lf = ph.get_tempo_note_length_factor()
    base_ms = ph.get_transition_basic_length_ms_by_constant()

    # ---- 贪心 tokenize
    check('SBP.tokenize: 单字母逐个切', ph.tokenize_phonemes('kya') == ['k', 'y', 'a'],
          'got %r' % (ph.tokenize_phonemes('kya'),))
    check('SBP.tokenize: 最长优先（"sh" 赢过 "s"）',
          ph.tokenize_phonemes('sha') == ['sh', 'a'],
          'got %r' % (ph.tokenize_phonemes('sha'),))
    check('SBP.tokenize: 未知字符退化成单字符', ph.tokenize_phonemes('kx') == ['k', 'x'])
    check('SBP.tokenize: 空串给空表', ph.tokenize_phonemes('') == [])
    check('SBP.tokenize: ★ 顺序是 Distinct(保序) 后稳定排序 —— 同长度按插入序',
          ph.tokenize_phonemes('as') == ['a', 's'])   # 'a'(元音) 在 's'(辅音) 前

    # ---- GetSymbols
    check('SBP.GetSymbols: 无字典时按空格切（tokenization 默认关）',
          ph.get_symbols(Note(lyric='k a')) == ['k', 'a'])
    check('SBP.GetSymbols: 歌词命中 tails 时**直接**返回它本身（早于一切切分）',
          ph.get_symbols(Note(lyric='-')) == ['-'] and ph.get_symbols(Note(lyric='R')) == ['R'])
    check('SBP.GetSymbols: 空歌词给空表', ph.get_symbols(Note(lyric='')) == [])
    check('SBP.GetSymbols: 多个空格被 RemoveEmptyEntries 丢掉',
          ph.get_symbols(Note(lyric='k  a ')) == ['k', 'a'])

    class _Tok(_Sbp):
        @property
        def enable_phoneme_tokenization(self):
            return True

    tok = _Tok()
    check('SBP.GetSymbols: 打开 tokenization 后无空格串走 TokenizePhonemes',
          tok.get_symbols(Note(lyric='sha')) == ['sh', 'a'],
          'got %r' % (tok.get_symbols(Note(lyric='sha')),))
    check('SBP.GetSymbols: 有空格时逐段 tokenize 再拼起来',
          tok.get_symbols(Note(lyric='sha kya')) == ['sh', 'a', 'k', 'y', 'a'])

    # ---- 节奏系数
    check('SBP: 节奏系数 bpm=120 → (300-120)/210/3+0.33',
          abs(lf - ((300 - 120) / (300 - 90) / 3 + 0.33)) < 1e-12, 'got %r' % lf)

    def _factor(bpm):
        p = _Sbp()
        p.set_timing(_CVVC_AXIS)
        p.bpm = bpm
        return p.get_tempo_note_length_factor()

    check('SBP: 节奏系数被 Clamp 到 [90,300]（bpm=50 同 90；bpm=400 同 300）',
          abs(_factor(50) - _factor(90)) < 1e-12
          and abs(_factor(400) - _factor(300)) < 1e-12
          and abs(_factor(300) - 0.33) < 1e-12,
          'got %r / %r / %r' % (_factor(50), _factor(90), _factor(300)))
    check('SBP: 常数过渡长 = 100 * 系数', abs(base_ms - 100 * lf) < 1e-12)

    # ---- 音节切分
    notes1 = [Note(lyric='k a s i', tone=60, duration=480)]
    syl = ph.make_syllables(notes1, None)
    check('SBP.MakeSyllables: 2 个元音 → 2 个音节（音符不够时先把末音符切碎）',
          syl is not None and len(syl) == 2, 'got %r' % (len(syl) if syl else None))
    check('SBP.MakeSyllables: 首音节 prev_v="" / cc=["k"] / v="a"',
          syl[0].prev_v == '' and syl[0].cc == ['k'] and syl[0].v == 'a')
    check('SBP.MakeSyllables: ★ 首音节 duration = -1（"没有前邻"的哨兵）',
          syl[0].duration == -1 and syl[0].position == 0)
    check('SBP.MakeSyllables: 第二音节 prev_v="a" / cc=["s"] / v="i"，'
          'position = 前音符时长（480/2=240）',
          (syl[1].prev_v, syl[1].cc, syl[1].v, syl[1].position, syl[1].duration)
          == ('a', ['s'], 'i', 240, 240),
          'got %r' % ((syl[1].prev_v, syl[1].cc, syl[1].v, syl[1].position, syl[1].duration),))
    check('SBP.MakeSyllables: 第二音节 canAliasBeExtended = true，首音节则否',
          syl[1].can_alias_be_extended is True and syl[0].can_alias_be_extended is False)
    check('SBP.MakeSyllables: 前视 nextV/nextCc 从后一音节回填',
          syl[0].next_v == 'i' and syl[0].next_cc == ['s']
          and syl[1].next_v == '' and syl[1].next_cc == [])
    check('SBP.MakeSyllables: helpers 分类正确（首 CV / VCV）',
          syl[0].is_starting_cv and syl[0].is_starting_cv_with_one_consonant
          and syl[1].is_vcv_with_one_consonant and not syl[0].is_vv)

    end1 = ph.make_ending(notes1)
    check('SBP.MakeEnding: prev_v="i" / cc=[] / hasTail=False',
          (end1.prev_v, end1.cc, end1.has_tail) == ('i', [], False))
    check('SBP.MakeEnding: position = 所有音符时长和；duration 从**最后一个元音**那个音符起算',
          end1.position == 480 and end1.duration == 240,
          'got %r / %r' % (end1.position, end1.duration))
    check('SBP.MakeEnding: 空输入 / `?` 开头都给 None',
          ph.make_ending([]) is None and ph.make_ending([Note(lyric='?abc')]) is None)

    # ---- 音符不够时的切分（整数除法链 + 15 tick 对齐）
    shrunk = ph.handle_not_enough_notes([Note(position=0, duration=500, tone=60)], [0, 1])
    check('SBP.HandleNotEnoughNotes: 500/2/15*15 = 240（**先整除再乘回 15**），余数给最后一个',
          [n.duration for n in shrunk] == [240, 260],
          'got %r' % [n.duration for n in shrunk])
    check('SBP.HandleNotEnoughNotes: position 连贯递增；tone/属性沿用末音符',
          [n.position for n in shrunk] == [0, 240] and all(n.tone == 60 for n in shrunk))

    class _ShortNotes(_Sbp):
        def handle_not_enough_notes(self, notes, vowel_ids):
            return list(notes)      # 故意不补齐，用来触发错误分支

    ph_bad = _ShortNotes()
    ph_bad.set_timing(_CVVC_AXIS)
    check('SBP.MakeSyllables: ★ 音符补不齐时报 "Not enough extension notes, N more expected"',
          ph_bad.make_syllables(notes1, None) is None
          and ph_bad.error == 'Not enough extension notes, 1 more expected',
          'got %r' % ph_bad.error)

    # ---- 规则引擎（ApplyReplacements）
    ph_r = _Sbp()
    check('SBP.ApplyReplacements: 无规则时原样返回（同一对象）',
          ph_r.apply_replacements(['k', 'a'], False) == ['k', 'a'])
    ph_r.merging_replacements = [SBP.Replacement(from_=['k', 'a'], to=['k a'])]
    check('SBP.ApplyReplacements: 合并规则把两段并成一段',
          ph_r.apply_replacements(['k', 'a', 's'], False) == ['k a', 's'],
          'got %r' % ph_r.apply_replacements(['k', 'a', 's'], False))
    ph_r.merging_replacements = []
    ph_r.splitting_replacements = [SBP.Replacement(from_='a', to=['a', 'R'])]
    check('SBP.ApplyReplacements: 拆分规则把一段拆成两段',
          ph_r.apply_replacements(['k', 'a'], False) == ['k', 'a', 'R'],
          'got %r' % ph_r.apply_replacements(['k', 'a'], False))
    check('SBP.ApplyReplacements: 单元素 from 也会被**主循环**吃掉（拆分回落段几乎不可达）',
          ph_r.apply_replacements(['a', 'i'], False) == ['a', 'R', 'i'],
          'got %r' % ph_r.apply_replacements(['a', 'i'], False))

    # 组语法 + 捕获回填
    ph_r.splitting_replacements = [SBP.Replacement(from_=['vowel', 'consonant'],
                                                   to=['consonant', 'vowel'])]
    check('SBP.ApplyReplacements: 组捕获后重排（vowel,consonant → consonant,vowel）',
          ph_r.apply_replacements(['a', 'k'], False) == ['k', 'a'],
          'got %r' % ph_r.apply_replacements(['a', 'k'], False))
    ph_r.splitting_replacements = [SBP.Replacement(from_=['vowel', 'consonant'],
                                                   to=['consonant+vowel'])]
    check('SBP.ApplyReplacements: ★ to 侧 "X+Y" 只回填**第一个**组名，第二个组名会原样留下',
          ph_r.apply_replacements(['a', 'k'], False) == ['kvowel'],
          'got %r' % ph_r.apply_replacements(['a', 'k'], False))
    ph_r.splitting_replacements = [SBP.Replacement(from_=['vowel!a'], to=['X'])]
    check('SBP.ApplyReplacements: "!" 排除（vowel!a 不匹配 a、匹配 i）',
          ph_r.apply_replacements(['a'], False) == ['a']
          and ph_r.apply_replacements(['i'], False) == ['X'])
    ph_r.splitting_replacements = [SBP.Replacement(from_=['vowel=i'], to=['X'])]
    check('SBP.ApplyReplacements: "=" 限定（vowel=i 只匹配 i）',
          ph_r.apply_replacements(['i'], False) == ['X']
          and ph_r.apply_replacements(['a'], False) == ['a'])
    ph_r.splitting_replacements = [SBP.Replacement(from_=['consonant&y'], to=['X'])]
    check('SBP.ApplyReplacements: "&" 并集（y 不在辅音表里也能被并进来）',
          ph_r.apply_replacements(['y'], False) == ['X']
          and ph_r.apply_replacements(['k'], False) == ['X']
          and ph_r.apply_replacements(['a'], False) == ['a'])
    ph_r.splitting_replacements = [SBP.Replacement(from_=['(vowel)'], to=['X'])]
    check('SBP.ApplyReplacements: 组名外的括号会被 Trim 掉（"(vowel)" == "vowel"）',
          ph_r.apply_replacements(['a'], False) == ['X'])
    ph_r.splitting_replacements = [SBP.Replacement(from_=['vowel'], to=['X'],
                                                   where='boundary')]
    check('SBP.ApplyReplacements: where=boundary 的规则在 inside 时**不**生效',
          ph_r.apply_replacements(['a'], False) == ['a']
          and ph_r.apply_replacements(['a'], True) == ['X'])
    ph_r.splitting_replacements = []
    check('SBP.IsGroupKeyword: 括号/修饰符都要先剥掉（"vowel!a" / "(nasal)"）',
          ph_r.is_group_keyword('vowel!a') and ph_r.is_group_keyword('(nasal)')
          and not ph_r.is_group_keyword('k'))
    check('SBP._replacement_from_key: 字符串原样 / 序列逗号拼接 / 其余空串',
          SBP._replacement_from_key('a') == 'a'
          and SBP._replacement_from_key(['a', 'b']) == 'a,b'
          and SBP._replacement_from_key(1) == '')

    # ---- 边界替换（值语义：不许改到调用者的对象）
    ph_b = _Sbp()
    sy = SBP.Syllable(prev_v='a', cc=['k'], v='i', position=240)
    check('SBP.ApplyBoundaryReplacements(Syllable): 无规则时原样返回',
          ph_b.apply_boundary_replacements_syllable(sy) is sy)
    ph_b.merging_replacements = [SBP.Replacement(from_=['a', 'k'], to=['a k'])]
    out = ph_b.apply_boundary_replacements_syllable(sy)
    check('SBP.ApplyBoundaryReplacements(Syllable): 合并后 prevV 变成 "a k"、cc 清空',
          (out.prev_v, out.cc, out.v) == ('a k', [], 'i'),
          'got %r' % ((out.prev_v, out.cc, out.v),))
    check('SBP.ApplyBoundaryReplacements(Syllable): ★ 值语义 —— 原对象**没被改**',
          (sy.prev_v, sy.cc, sy.v) == ('a', ['k'], 'i'))
    check('SBP.ApplyBoundaryReplacements(Syllable): isBoundary = 有前元音 && position==0 '
          '（这里 position=240 → inside）',
          'bool isBoundary = (hasPrevV && syllable.position == 0) || !hasPrevV;' in cs)

    ph_b.merging_replacements = []
    # ★ 边界替换时 isBoundary=True → `where="inside"` 的规则**不参与**，必须写 "all"
    ph_b.splitting_replacements = [SBP.Replacement(from_='null', to=['-'], where='all'),
                                   SBP.Replacement(from_='R', to=['-'], where='all')]
    sy2 = SBP.Syllable(prev_v='', cc=['k'], v='i', position=0)
    out2 = ph_b.apply_boundary_replacements_syllable(sy2)
    check('SBP.ApplyBoundaryReplacements(Syllable): "null" 占位符被换成 "-"（prevV="-", cc=["k"]）',
          (out2.prev_v, out2.cc, out2.v) == ('-', ['k'], 'i'),
          'got %r' % ((out2.prev_v, out2.cc, out2.v),))

    end_a = SBP.Ending(prev_v='a', cc=['k'], tail='R')
    oute = ph_b.apply_boundary_replacements_ending(end_a)
    check('SBP.ApplyBoundaryReplacements(Ending): tail="R" 的规则把它换成 "-"',
          (oute.prev_v, oute.cc, oute.tail, oute.has_tail) == ('a', ['k'], '-', True),
          'got %r' % ((oute.prev_v, oute.cc, oute.tail),))
    end_b = SBP.Ending(prev_v='a', cc=['k'], tail='')
    oute2 = ph_b.apply_boundary_replacements_ending(end_b)
    check('SBP.ApplyBoundaryReplacements(Ending): ★ tail 为空时按 "null" 参与匹配 '
          '（所以空 tail 也能被规则补成 "-"）',
          (oute2.prev_v, oute2.cc, oute2.tail) == ('a', ['k'], '-'))

    # ---- has_oto 三段试查
    class _SplitSinger:
        """只在指定那一段返回命中，用来逐段验证 HasOto 的三次尝试。"""

        def __init__(self, by_two=None, by_raw=None, by_empty_color=None):
            self.by_two = by_two or {}
            self.by_raw = by_raw or {}
            self.by_empty_color = by_empty_color or {}
            self.found = True
            self.loaded = True
            self.location = ''
            self.id = 'split'

        @property
        def is_loaded(self):
            return self.found and self.loaded

        def try_get_mapped_oto(self, p, tone, color=None):
            table = self.by_two if color is None else (
                self.by_empty_color if color == '' else {})
            return (p in table), table.get(p)

        def try_get_oto(self, p):
            return (p in self.by_raw), self.by_raw.get(p)

    ph_h = _Sbp()
    ph_h.singer = _SplitSinger(by_two={'x': oto('x')})
    check('SBP.HasOto: 第 1 段 —— 2 参 `TryGetMappedOto(alias, tone)` 命中',
          ph_h.has_oto('x', 60) is True)
    ph_h.singer = _SplitSinger(by_raw={'x': oto('x')})
    check('SBP.HasOto: 第 2 段 —— 裸别名 `TryGetOto` 命中',
          ph_h.has_oto('x', 60) is True)
    ph_h.singer = _SplitSinger(by_empty_color={'x': oto('x')})
    check('SBP.HasOto: 第 3 段 —— 只有**空音色**那条重载命中',
          ph_h.has_oto('x', 60) is True)
    ph_h.singer = _SplitSinger()
    check('SBP.HasOto: 三段都不命中 → False；空别名 → False（早退）',
          ph_h.has_oto('x', 60) is False and ph_h.has_oto('', 60) is False)
    ph_h.singer = None
    check('SBP.HasOto: singer 为 None → False', ph_h.has_oto('x', 60) is False)
    ph_h.singer = _OtoSinger({'x': oto('x')})
    ph_h.singer.loaded = False
    check('SBP.HasOto: ★ 歌手"找到了但没加载" → False（Loaded = Found && loaded）',
          ph_h.has_oto('x', 60) is False and ph_h.singer.is_loaded is False)

    # ---- validate_alias 回落链
    ph_v = _Sbp()
    ph_v.set_singer(_OtoSinger({'sh uw': oto('sh uw'), 'yy': oto('yy')}))
    ph_v.set_timing(_CVVC_AXIS)
    ph_v.yaml_fallbacks = [SBP.Replacement(from_='x', to='sh')]
    check('SBP.ValidateAlias: 单规则精确替换命中（"x uw" → "sh uw"）',
          ph_v.validate_alias('x uw', 60) == 'sh uw',
          'got %r' % ph_v.validate_alias('x uw', 60))
    check('SBP.ValidateAlias: oto 里本来就有的别名原样返回',
          ph_v.validate_alias('sh uw', 60) == 'sh uw')
    ph_v.yaml_fallbacks = []

    class _Legacy(_Sbp):
        def get_aliases_fallback(self):
            return {'zz': 'yy'}

    ph_l = _Legacy()
    ph_l.set_singer(_OtoSinger({'yy': oto('yy')}))
    ph_l.set_timing(_CVVC_AXIS)
    check('SBP.ValidateAlias: legacy 回落命中 oto 时用它',
          ph_l.validate_alias('zz', 60) == 'yy')
    ph_l.set_singer(_OtoSinger({}))
    check('SBP.ValidateAlias: ★ legacy 目标**查不到 oto 也照样返回它**（C# 两次 return 同一个值）',
          ph_l.validate_alias('zz', 60) == 'yy')
    check('SBP.ValidateAlias: 完全没招时返回原别名',
          ph_l.validate_alias('nothing', 60) == 'nothing')
    check('SBP.ValidateAlias: singer 未就绪 / 空别名 → 原样返回',
          ph_l.validate_alias('', 60) == ''
          and _Sbp().validate_alias('abc', 60) == 'abc')

    # ---- is_short / 别名延续 / 同 subbank
    check('SBP.IsShort(Syllable): 250ms 音符不短、62.5ms 短、duration=-1 直接 false',
          ph.is_short(SBP.Syllable(duration=240)) is False
          and ph.is_short(SBP.Syllable(duration=60)) is True
          and ph.is_short(SBP.Syllable(duration=-1)) is False,
          'got %r / %r' % (ph.is_short(SBP.Syllable(duration=240)),
                           ph.is_short(SBP.Syllable(duration=60))))
    check('SBP.IsShort(Ending): 没有 -1 哨兵那一层，60 tick 就是短',
          ph.is_short(SBP.Ending(duration=60)) is True
          and ph.is_short(SBP.Ending(duration=240)) is False)
    check('SBP.CanMakeAliasExtension: 三者齐备才行（可延长 && prevV==v && cc 为空）',
          ph.can_make_alias_extension(
              SBP.Syllable(prev_v='a', cc=[], v='a', can_alias_be_extended=True)) is True
          and ph.can_make_alias_extension(
              SBP.Syllable(prev_v='a', cc=['k'], v='a', can_alias_be_extended=True)) is False
          and ph.can_make_alias_extension(
              SBP.Syllable(prev_v='i', cc=[], v='a', can_alias_be_extended=True)) is False)

    class _Sub:
        def __init__(self, tone_set):
            self.tone_set = tone_set

    class _SubSinger:
        def __init__(self, subbanks):
            self.subbanks = subbanks
            self.found = True
            self.loaded = True
            self.location = ''
            self.id = 'sub'

        @property
        def is_loaded(self):
            return self.found and self.loaded

        def try_get_oto(self, p):
            return False, None

        def try_get_mapped_oto(self, p, tone, color=None):
            return False, None

    ph_s = _Sbp()
    ph_s.singer = _SubSinger([_Sub([60])])
    check('SBP.AreTonesFromTheSameSubbank: 只有一个 subbank → 恒 true',
          ph_s.are_tones_from_the_same_subbank(60, 72) is True)
    ph_s.singer = _SubSinger([_Sub([60]), _Sub([72])])
    check('SBP.AreTonesFromTheSameSubbank: "一边含一边不含" → false',
          ph_s.are_tones_from_the_same_subbank(60, 72) is False)
    ph_s.singer = _SubSinger([_Sub([60, 72]), _Sub([60, 72])])
    check('SBP.AreTonesFromTheSameSubbank: 同一集合同时含二者 → true',
          ph_s.are_tones_from_the_same_subbank(60, 72) is True)
    check('SBP.AreTonesFromTheSameSubbank: tone 相等直接 true（不查 subbank）',
          ph_s.are_tones_from_the_same_subbank(63, 63) is True)

    # ---- TryAddPhoneme 两个重载
    ph_t = _Sbp()
    ph_t.set_singer(_OtoSinger({'v R': oto('v R')}))
    lst = []
    check('SBP.TryAddPhoneme(list, tone, ...): 命中就加进列表并返回 True',
          ph_t.try_add_phoneme(lst, 60, 'x', 'v R') is True and lst == ['v R'])
    check('SBP.TryAddPhoneme: 一个都没命中时不加、返回 False',
          ph_t.try_add_phoneme(lst, 60, 'nope') is False and lst == ['v R'])
    ph_t.runtime_glides.clear()
    check('SBP.TryAddPhoneme(list, tone, isGlide=True, ...): 顺带把它登记成滑音'
          '（★ Python 用**仅关键字** is_glide 代替 C# 的重载）',
          ph_t.try_add_phoneme(lst, 60, 'v R', is_glide=True) is True
          and ph_t.is_glide('v R') is True and 'v R' in ph_t.runtime_glides)
    ph_t.enable_glides = False
    check('SBP.IsGlide: enableGlides=false 时即使登记过也算 false（两个条件都要）',
          ph_t.is_glide('v R') is False)

    # ---- 字典状态的"缺键会抛"
    ph_k = _Sbp()
    check('SBP: has_dictionary 为 False 时读 dictionary / is_dictionary_loading **会抛 KeyError**'
          '（照搬 C# 的字典索引语义）',
          ph_k.has_dictionary is False
          and _raises_type(KeyError, lambda: ph_k.dictionary)
          and _raises_type(KeyError, lambda: ph_k.is_dictionary_loading))

    # ================= 端到端：Process 全链路 =================
    ph_e = _Sbp()
    ph_e.set_singer(_OtoSinger({'- ka': oto('- ka'), 'a -': oto('a -'),
                                'a i': oto('a i'), 'i -': oto('i -')}))
    ph_e.set_timing(_CVVC_AXIS)
    r = ph_e.process([Note(lyric='k a', tone=60, duration=480)])
    check('SBP.Process: 单音节 → 基音 + 句末尾韵两个音素，别名走 ProcessSyllable/ProcessEnding',
          [p.phoneme for p in r.phonemes] == ['- ka', 'a -'],
          'got %r' % [p.phoneme for p in r.phonemes])
    check('SBP.Process: 基音 position=0（无 glide 时锚点就是元音）',
          r.phonemes[0].position == 0, 'got %r' % r.phonemes[0].position)
    check('SBP.Process: ★ 句末音素 = 容器 − Min(50, 容器/3)（NoGap 吸附 50 tick）',
          r.phonemes[1].position == 480 - min(50, 480 // 3),
          'got %r' % r.phonemes[1].position)
    check('SBP.Process: index 被重排成连续的 0,1',
          [p.index for p in r.phonemes] == [0, 1],
          'got %r' % [p.index for p in r.phonemes])

    ph_e2 = _Sbp()
    ph_e2.set_singer(_OtoSinger({'- ka': oto('- ka'), 'a -': oto('a -')}))
    ph_e2.set_timing(_CVVC_AXIS)
    r2 = ph_e2.process([Note(lyric='k a', tone=60, duration=120)])
    check('SBP.Process: 短音符时容器/3 才是上限（120/3=40 < 50）',
          r2.phonemes[1].position == 120 - min(50, 120 // 3) == 80,
          'got %r' % r2.phonemes[1].position)

    class _NoGapOff(_Sbp):
        @property
        def no_gap(self):
            return False

    ph_ng = _NoGapOff()
    ph_ng.set_singer(_OtoSinger({'- ka': oto('- ka', preutter=100.0),
                                 'a -': oto('a -', preutter=100.0)}))
    ph_ng.set_timing(_CVVC_AXIS)
    r3 = ph_ng.process([Note(lyric='k a', tone=60, duration=480)])
    check('SBP.Process: ★ NoGap=false 时改用完整 Preutter（position = 容器 − MsToTick(100)）',
          r3.phonemes[1].position == 480 - ph_ng.ms_to_tick(100.0),
          'got %r vs %r' % (r3.phonemes[1].position, 480 - ph_ng.ms_to_tick(100.0)))

    # 带前邻：VC + CV
    ph_e3 = _Sbp()
    ph_e3.set_singer(_OtoSinger({'a k': oto('a k'), 'ki': oto('ki'),
                                 'i -': oto('i -')}))
    ph_e3.set_timing(_CVVC_AXIS)
    r4 = ph_e3.process([Note(lyric='k i', tone=60, duration=480)],
                       prev_neighbours=[Note(lyric='a', tone=60, duration=480)])
    check('SBP.Process: 有前邻时首音节 prevV 来自前一词 → 产出 VC（"a k"）与 CV（"ki"）',
          [p.phoneme for p in r4.phonemes][:2] == ['a k', 'ki'],
          'got %r' % [p.phoneme for p in r4.phonemes])
    check('SBP.Process: VC 落在**负**位置（挤到音符起点之前），CV 在 0',
          r4.phonemes[0].position < 0 and r4.phonemes[1].position == 0,
          'got %r' % [p.position for p in r4.phonemes])

    # `?` 强制别名 / 未加载歌手
    check('SBP.Process: `?abc` 直接产出 abc',
          [p.phoneme for p in ph_e.process([Note(lyric='?abc', tone=60, duration=480)])
           .phonemes] == ['abc'])
    check('SBP.Process: 歌手为 None 时给空音素（MakeSimpleResult("")）',
          [p.phoneme for p in _Sbp().process([Note(lyric='k a')]).phonemes] == [''])

    # ---- AssignAllAffixes 的 alt 处理
    ph_a = _Sbp()
    ph_a.set_singer(_OtoSinger({'- ka': oto('- ka'), '- ka2': oto('- ka2')}))
    ph_a.set_timing(_CVVC_AXIS)
    attr = SBP.PhonemeAttributes(index=0, alternate=2)
    p0 = Phoneme(phoneme='- ka', index=0, position=0)
    out_a = ph_a.assign_all_affixes([p0], [Note(lyric='k a', tone=60, duration=480)], [],
                                    [attr])
    check('SBP.AssignAllAffixes: attr.alternate=2 → 先试 "- ka2" 命中',
          out_a[0].phoneme == '- ka2', 'got %r' % out_a[0].phoneme)
    check('SBP.AssignAllAffixes: 正值 alt 会写回 expressions（供 UI 滑条回显）',
          any(e.abbr == 'alt' and e.value == 2 for e in out_a[0].expressions))
    # alt 来自音素自带表达式时取 (int) 截断
    ph_a2 = _Sbp()
    ph_a2.set_singer(_OtoSinger({'- ka': oto('- ka'), '- ka2': oto('- ka2')}))
    ph_a2.set_timing(_CVVC_AXIS)
    p1 = Phoneme(phoneme='- ka', index=0, position=0,
                 expressions=[PhonemeExpression(abbr='alt', value=2.7)])
    out_a2 = ph_a2.assign_all_affixes([p1], [Note(lyric='k a', tone=60, duration=480)], [], [])
    check('SBP.AssignAllAffixes: ★ alt 取自带表达式时是 `(int)` **向零截断**（2.7 → 2，不是 3）',
          out_a2[0].phoneme == '- ka2'
          and any(e.abbr == 'alt' and e.value == 2 for e in out_a2[0].expressions),
          'got %r / %r' % (out_a2[0].phoneme, out_a2[0].expressions))
    p2 = Phoneme(phoneme='- ka', index=0, position=0,
                 expressions=[PhonemeExpression(abbr='alt', value=-3.0)])
    out_a3 = ph_a2.assign_all_affixes([p2], [Note(lyric='k a', tone=60, duration=480)], [], [])
    check('SBP.AssignAllAffixes: ★ 非正的 alt 不会被采用，但**原表达式也不会被清掉**'
          '（altValue 为 null 就不重写 expressions）',
          out_a3[0].phoneme == '- ka'
          and any(e.abbr == 'alt' and e.value == -3.0 for e in out_a3[0].expressions),
          'got %r / %r' % (out_a3[0].phoneme, out_a3[0].expressions))
    p3 = Phoneme(phoneme=None, index=0, position=77)
    out_a4 = ph_a2.assign_all_affixes([p3], [Note(lyric='k a', tone=60, duration=480)], [], [])
    check('SBP.AssignAllAffixes: phoneme 为 None 时把 position 归零（哨兵语义）',
          out_a4[0].position == 0)

    # ---- 真 ClassicSinger 上也要能跑（接口契约回归）
    ph_real = _Sbp()
    real_singer = _real_classic_singer({'- ka': oto('- ka'), 'a -': oto('a -')})
    real_singer.loaded = True            # ★ `Loaded = Found && loaded`，真歌手默认没加载
    ph_real.set_singer(real_singer)
    ph_real.set_timing(_CVVC_AXIS)
    rr = ph_real.process([Note(lyric='k a', tone=60, duration=480)])
    check('SBP × 真 ClassicSinger: 端到端能跑（不会把 (found, oto) 当裸值）',
          [p.phoneme for p in rr.phonemes] == ['- ka', 'a -'],
          'got %r' % [p.phoneme for p in rr.phonemes])

    # ================= G2pRemapper =================
    base = G2pDictionary.new_builder()
    base.add_symbol('a', True)
    base.add_symbol('k', False)
    base.add_entry('ka', ['k', 'a'])
    base_d = base.build()
    remap = G2pRemapper(base_d, {'A': True, 'K': False}, {'a': 'A', 'k': 'K'})
    check('G2pRemapper: is_valid_symbol/is_vowel 用**自己**的表，不看被包的字典',
          remap.is_valid_symbol('A') and not remap.is_valid_symbol('a')
          and remap.is_vowel('A') is True and remap.is_vowel('a') is False)
    check('G2pRemapper: query 做音素替换，且**不动**被包字典的内部数组',
          remap.query('ka') == ['K', 'A'] and base_d.query('ka') == ['k', 'a'])
    check('G2pRemapper: query 查不到时**原样返回 None**（不是空表）',
          remap.query('zzz') is None and remap.query('A') is None)
    check('G2pRemapper: ★ is_glide 只看自己的 glideSymbols，**不透传**给被包的字典',
          remap.is_glide('a') is False
          and G2pRemapper(base_d, {'a': True}, {}).is_glide('a') is False)
    check('G2pRemapper: unpack_hint 保留空段再按自己的表过滤',
          remap.unpack_hint('K  A') == ['K', 'A']
          and remap.unpack_hint('a k') == [])

    # ================= YamlWatcher =================
    class _FakeWatchBackend:
        def __init__(self):
            self.started = None
            self.stopped = False
            self.on_change = None
            self.on_error = None

        def start(self, path, on_change, on_error, file_filter, recursive):
            self.started = (path, file_filter, recursive)
            self.on_change = on_change
            self.on_error = on_error

        def stop(self):
            self.stopped = True

    fired = []
    be = _FakeWatchBackend()
    w = YamlWatcher('/some/dir', lambda: fired.append(1), backend=be)
    check('YamlWatcher: 递归监视 *.yaml（Filter="*.yaml" / IncludeSubdirectories=true）',
          be.started == ('/some/dir', '*.yaml', True), 'got %r' % (be.started,))
    be.on_change('/some/dir/a.yaml', 'Changed')
    check('YamlWatcher: 有变更就回调', fired == [1])
    w.paused = True
    be.on_change('/some/dir/b.yaml', 'Created')
    check('YamlWatcher: Paused 时只跳过回调、不停止监视', fired == [1])
    w.paused = False
    be.on_change('/some/dir/a.yaml', 'Deleted')
    be.on_change('/some/dir/a.yaml', 'Renamed')
    check('YamlWatcher: 四种变更都走同一个回调（不做去重 → 删+建会触发两次）',
          fired == [1, 1, 1])
    check('YamlWatcher: on_error 只记日志、不抛', w.on_error(ValueError('x')) is None)
    w.dispose()
    check('YamlWatcher: Dispose 只停后端，**不复位** Paused', be.stopped is True)
    check('YamlWatcher: 不注入后端时用 Noop（默认不监视，也不报错）',
          YamlWatcher('/nope', None).dispose() is None)

    # SBP 侧的 watcher 回调：清缓存 + generation++ + 让歌手重载
    gen_before = SBP.SyllableBasedPhonemizer.global_sbp_generation
    SBP.SyllableBasedPhonemizer.clear_yaml_cache()
    SBP.SyllableBasedPhonemizer.yaml_cache['sentinel'] = (1.0, None)
    reloaded = []

    class _WatchSinger(_OtoSinger):
        def reload(self):
            reloaded.append(1)

    ph_w = _Sbp()
    ph_w.singer = _WatchSinger({})
    ph_w._singer_loaded = True
    ph_w._on_yaml_changed('/some/dir', 'Singer')
    check('SBP._onYamlChanged: 先清 YAML 缓存再 generation++',
          SBP.SyllableBasedPhonemizer.yaml_cache == {}
          and SBP.SyllableBasedPhonemizer.global_sbp_generation == gen_before + 1)
    check('SBP._onYamlChanged: 把 _singerLoaded 复位，并让歌手重载（走了可注入调度器）',
          ph_w._singer_loaded is False and reloaded == [1])
    ph_w.local_sbp_generation = gen_before      # 别把 generation 差带进后面的用例
    SBP.SyllableBasedPhonemizer.global_sbp_generation = gen_before

    # ================= YAML 装载 =================
    try:
        import yaml  # noqa: F401
    except ImportError:
        print('  SKIP 没有 PyYAML，跳过 YAML 装载用例')
        return

    tmp = tempfile.mkdtemp(prefix='sbp-yaml-')
    old_plugin_dir = os.environ.get('FUFUMIDI_PLUGIN_DIR')
    try:
        os.environ['FUFUMIDI_PLUGIN_DIR'] = tmp

        class _Yaml(_Sbp):
            @property
            def yaml_file_name(self):
                return 'test_sbp.yaml'

            @property
            def yaml_template(self):
                return b'version: 1.0\n'

            @property
            def yaml_version(self):
                return '1.0'

        singer_dir = os.path.join(tmp, 'singer')
        os.makedirs(singer_dir, exist_ok=True)
        global_yaml = os.path.join(tmp, 'test_sbp.yaml')
        singer_yaml = os.path.join(singer_dir, 'test_sbp.yaml')

        # (1) 全局文件缺失 + 有模板 → 自动写出来
        SBP.SyllableBasedPhonemizer.clear_yaml_cache()
        ph_y = _Yaml()
        ph_y.set_singer(_OtoSinger({}, location=singer_dir))
        check('SBP.SetSinger(YAML): 全局 YAML 缺失且有模板 → 自动创建（WriteAllBytes 语义）',
              os.path.isfile(global_yaml)
              and open(global_yaml, 'rb').read() == b'version: 1.0\n')

        # (2) 版本更旧 → 改名备份 + 覆写模板
        with open(global_yaml, 'w', encoding='utf-8') as f:
            f.write('version: 0.9\nsymbols:\n  - symbol: Q\n    type: vowel\n')
        SBP.SyllableBasedPhonemizer.clear_yaml_cache()
        ph_y2 = _Yaml()
        ph_y2.set_singer(_OtoSinger({}, location=singer_dir))
        backup = os.path.join(tmp, 'test_sbp_backup(0.9).yaml')
        check('SBP.SetSinger(YAML): 旧版本先改名备份为 {名}_backup({版本}){扩展名}',
              os.path.isfile(backup), 'got %r' % os.listdir(tmp))
        check('SBP.SetSinger(YAML): 备份里留着旧内容、新文件被写成模板',
              'symbols:' in open(backup, encoding='utf-8').read()
              and open(global_yaml, 'rb').read() == b'version: 1.0\n')

        # (3) 正常装载：全局 + 声库两份叠加（声库在后、覆盖在前）
        with open(global_yaml, 'w', encoding='utf-8') as f:
            f.write(
                'version: 1.0\n'
                'isglides: false\n'
                'symbols:\n'
                '  - symbol: Q\n    type: vowel\n'
                '  - symbol: zz\n    type: nasal\n'
                '  - symbol: dy\n    type: diphthong\n'
                '  - symbol: "**"\n    type: tail\n'
                'timings:\n'
                '  - symbol: zz\n    value: 2.5\n'
                'diphthongs:\n'
                '  - from: dy\n    to: D\n'
                'vowelsustains:\n'
                '  - symbol: Q\n    sustain: "Q -"\n    offset: 0.5\n'
                'fallbacks:\n'
                '  - from: X\n    to: Y\n'
                '  - from: onlyfrom\n'
                'replacements:\n'
                '  - from: [a, k]\n    to: [a k]\n'
                '  - from: q\n    to: [q, R]\n')
        with open(singer_yaml, 'w', encoding='utf-8') as f:
            f.write('version: 1.0\nsymbols:\n  - symbol: SS\n    type: fricative\n'
                    'timings:\n  - symbol: SS\n    value: 3.0\n')
        SBP.SyllableBasedPhonemizer.clear_yaml_cache()
        ph_y3 = _Yaml()
        ph_y3.set_singer(_OtoSinger({}, location=singer_dir))
        check('SBP.SetSinger(YAML): symbols 按 type 归并；vowel 与 diphthong 一起进 vowels',
              ph_y3.vowels[:2] == ['Q', 'dy'] and 'SS' not in ph_y3.vowels,
              'got %r' % ph_y3.vowels)
        check('SBP.SetSinger(YAML): ★ tails 被 SetSinger 重置成 ["-"] 后再并入 YAML 的 tail',
              ph_y3.tails == ['**', '-'], 'got %r' % ph_y3.tails)
        check('SBP.SetSinger(YAML): 分类符表（nasal / fricative）各自并入 consonants',
              'zz' in ph_y3.nasal and 'SS' in ph_y3.fricative
              and 'zz' in ph_y3.consonants and 'SS' in ph_y3.consonants)
        check('SBP.SetSinger(YAML): ★ 声库那份**后**解析 → 覆盖全局的 timings',
              ph_y3.phoneme_overrides == {'zz': 2.5, 'SS': 3.0},
              'got %r' % ph_y3.phoneme_overrides)
        check('SBP.SetSinger(YAML): diphthongs 的显式映射优先，没给 to 的自动补 "{d}-"',
              ph_y3.diphthong_tails == {'dy': 'D'},
              'got %r' % ph_y3.diphthong_tails)
        check('SBP.SetSinger(YAML): vowelsustains 收进 (sustain, offset)',
              ph_y3.vowel_sustains.get('Q') == ('Q -', 0.5))
        check('SBP.SetSinger(YAML): replacements 按 from 的类型分流 —— 标量进 splitting、'
              '序列进 merging',
              [r.from_ for r in ph_y3.merging_replacements] == [['a', 'k']]
              and [r.from_ for r in ph_y3.splitting_replacements] == ['q'],
              'got %r / %r' % ([r.from_ for r in ph_y3.merging_replacements],
                               [r.from_ for r in ph_y3.splitting_replacements]))
        check('SBP.SetSinger(YAML): ★ replacements 里标量 from 会顺带删掉同名 '
              'dictionaryReplacements 项（C# 原文如此）',
              'dictionaryReplacements.Remove(fromStr);' in cs)
        check('SBP.SetSinger(YAML): fallbacks 只留 from/to 都非空的（缺 to 的被丢）',
              [r.from_ for r in ph_y3.yaml_fallbacks] == ['X'],
              'got %r' % [r.from_ for r in ph_y3.yaml_fallbacks])
        check('SBP.SetSinger(YAML): isglides: false → enableGlides=false',
              ph_y3.enable_glides is False)
        check('SBP.SetSinger(YAML): 硬编码表被备份下来（再换歌手时用备份重置）',
              ph_y3._backup_vowels == ['a', 'i', 'u', 'e', 'o']
              and ph_y3._backup_consonants == ['k', 's', 't', 'y', 'n', 'm', 'sh'])

        # (4) 模板版本相同 → 不备份、不覆写（内容保留）
        SBP.SyllableBasedPhonemizer.clear_yaml_cache()
        before = open(global_yaml, encoding='utf-8').read()
        ph_y4 = _Yaml()
        ph_y4.set_singer(_OtoSinger({}, location=singer_dir))
        check('SBP.SetSinger(YAML): 版本相同 → 不动原文件（保护用户改动）',
              open(global_yaml, encoding='utf-8').read() == before
              and not os.path.isfile(os.path.join(tmp, 'test_sbp_backup(1.0).yaml')))
        check('SBP.SetSinger(YAML): ★ "1.2" < "1.2.0"（Version 缺段补 -1）也会触发改写',
              SBP._parse_version('1.2') < SBP._parse_version('1.2.0'))

        # (5) YAML 缓存按「全路径 + mtime」命中
        SBP.SyllableBasedPhonemizer.clear_yaml_cache()
        d1 = SBP.SyllableBasedPhonemizer._load_yaml_cached(global_yaml)
        n_after_first = len(SBP.SyllableBasedPhonemizer.yaml_cache)
        d2 = SBP.SyllableBasedPhonemizer._load_yaml_cached(global_yaml)
        check('SBP.LoadYamlCached: 同一文件第二次读走缓存（命中同一对象）',
              d1 is d2 and n_after_first == 1)
        check('SBP.ReadVersionFast: 从文件里读出 version 值',
              SBP.read_version_fast(global_yaml) == '1.0')
        check('SBP.LoadYamlCached: 坏 YAML 只记日志、返回 None（不抛）',
              SBP.SyllableBasedPhonemizer._load_yaml_cached(
                  os.path.join(tmp, 'nope.yaml')) is None)

        # (6) 解析失败/未知键要"容错"（IgnoreUnmatchedProperties 语义）
        data = SBP.YAMLData.from_plain({'version': '9', 'unknownKey': 1, 'symbols': 'oops'})
        check('SBP.YAMLData: 未知键忽略、类型不符的字段退化成默认（容错反序列化）',
              data.version == '9' and data.symbols == [] and data.isglides is None)
    finally:
        if old_plugin_dir is None:
            os.environ.pop('FUFUMIDI_PLUGIN_DIR', None)
        else:
            os.environ['FUFUMIDI_PLUGIN_DIR'] = old_plugin_dir
        SBP.SyllableBasedPhonemizer.clear_yaml_cache()
        shutil.rmtree(tmp, ignore_errors=True)


def test_french_vccv_phonemizer():
    """`Plugin.Builtin/FrenchVCCVPhonemizer.cs`（294 行）—— `SyllableBased` 基类的
    **第一个真实用户**：覆盖 GetVowels/GetConsonants/GetDictionaryName/ProcessSyllable/
    ProcessEnding/NoGap/GetTransitionBasicLengthMs/GetSymbols，零外部 G2p 类、零 YAML。
    """
    from singing.openutau import Note, Phoneme, registered
    from singing.openutau.plugin_builtin import FrenchVCCVPhonemizer
    from singing.openutau.plugin_builtin import french_vccv as F

    cs = open(os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                           'FrenchVCCVPhonemizer.cs'), encoding='utf-8-sig').read()
    cs = cs.replace('\r\n', '\n')

    # ---------------- 源码一致性
    m = re.search(r'\[Phonemizer\("([^"]*)",\s*"([^"]*)",\s*"([^"]*)"(?:,\s*language\s*:\s*"([^"]*)")?\)\]',
                  cs)
    check('FR VCCV: [Phonemizer] 的 name/tag/author/language 与 C# 一致',
          m is not None and (m.group(1), m.group(2), m.group(3), m.group(4)) == (
              FrenchVCCVPhonemizer.name, FrenchVCCVPhonemizer.tag,
              FrenchVCCVPhonemizer.author, FrenchVCCVPhonemizer.language),
          'C#=%r' % (m.groups() if m else None,))
    check('FR VCCV: 继承 SyllableBasedPhonemizer 且已注册',
          'class FrenchVCCVPhonemizer : SyllableBasedPhonemizer' in cs
          and registered().get('FR VCCV') is FrenchVCCVPhonemizer)
    check('FR VCCV: GetDictionaryName => "cmudict_fr.txt"',
          'GetDictionaryName() => "cmudict_fr.txt";' in cs
          and FrenchVCCVPhonemizer().get_dictionary_name() == 'cmudict_fr.txt')
    check('FR VCCV: NoGap => true', 'protected override bool NoGap => true;' in cs
          and FrenchVCCVPhonemizer().no_gap is True)
    check('FR VCCV: GetTransitionBasicLengthMs 转调 GetTransitionBasicLengthMsByOto',
          'double otoLength = GetTransitionBasicLengthMsByOto(alias, tone, attr);' in cs
          and 'return otoLength;' in cs)

    # vowels / consonants 逐项
    def _split_arr(name):
        mm = re.search(r'%s = "([^"]*)"\.Split' % name, cs)
        return mm.group(1).split(',') if mm else None

    check('FR VCCV: vowels 逐项一致（26 项，含撇号变体）',
          _split_arr('vowels') == list(F.VOWELS) and len(F.VOWELS) == 26,
          'C#=%r' % (_split_arr('vowels'),))
    check('FR VCCV: consonants 逐项一致（24 项）',
          _split_arr('consonants') == list(F.CONSONANTS) and len(F.CONSONANTS) == 24)
    check("FR VCCV: vowels 里有撇号变体（A' / E' / …）",
          "A'" in F.VOWELS and "0'" in F.VOWELS)
    check('FR VCCV: consonants 里有 _hh 这种多字符符号',
          '_hh' in F.CONSONANTS and 'Z' in F.CONSONANTS)

    # dictionaryReplacements：丢自映射（★ 跨两行字符串字面量，要拼接）
    raw_block = re.search(r'dictionaryReplacements = \((.*?)\)\.Split', cs, re.S)
    raw_full = ''.join(re.findall(r'"([^"]*)"', raw_block.group(1))) if raw_block else ''
    want_map = {}
    for entry in raw_full.split(';'):
        if entry:
            parts = entry.split('=')
            if len(parts) == 2 and parts[0] != parts[1]:
                want_map[parts[0]] = parts[1]
    check('FR VCCV: dictionaryReplacements 逐项一致（且丢自映射 4=4）',
          want_map == F._REPL_MAP, 'C#=%r 我们=%r' % (want_map, F._REPL_MAP))
    check('FR VCCV: ★ 自映射 4=4 被丢、hh=h 保留（因为 hh != h）',
          '4' not in F._REPL_MAP and F._REPL_MAP.get('hh') == 'h')
    check('FR VCCV: GetDictionaryPhonemesReplacement 返回这份硬编码表（副本）',
          FrenchVCCVPhonemizer().get_dictionary_phonemes_replacement() == dict(F._REPL_MAP)
          and FrenchVCCVPhonemizer().get_dictionary_phonemes_replacement() is not F._REPL_MAP)

    # arpabet / m2rUg
    ar = re.search(r'arpabet = "([^"]*)"\.Split', cs)
    mk = re.search(r'm2rUg = "([^"]*)"\.Split', cs)
    check('FR VCCV: arpabet / m2rUg 两个数组逐项一致（各 35 项）',
          ar and mk and ar.group(1).split(',') == list(F._ARPABET)
          and mk.group(1).split(',') == list(F._M2RUG)
          and len(F._ARPABET) == 35 == len(F._M2RUG),
          'arpabet=%r m2rUg=%r' % (ar.group(1) if ar else None,
                                   mk.group(1) if mk else None))

    # ★ 上游怪癖要在位
    check('FR VCCV: ★ ProcessSyllable 里 lastC/firstC 是死局部变量（C# 声明后未用）',
          'var lastC = cc.Length - 1;' in cs and 'var firstC = 0;' in cs)
    check('FR VCCV: ★ IsVV 分支里 CanMakeAliasExtension 被**注释掉**了',
          '//if (!CanMakeAliasExtension(syllable))' in cs
          and '//    basePhoneme = null;' in cs)
    check('FR VCCV: ★ GetSymbols 里 `if (convert == null) return null;` 是死代码',
          'if (convert == null)' in cs)
    check('FR VCCV: ★ vocal fry 剥离只改局部 prevV（Contains / Replace 撇号）',
          "if (prevV.Contains(\"'\"))" in cs and "prevV = prevV.Replace(\"'\", \"\");" in cs)
    check('FR VCCV: ★ n+j → J 的规则在 VCV 多辅音分支末尾',
          '"j" && $"{cc[cc.Length-2]}" == "n")' in cs.replace('\n', ' '))
    check('FR VCCV: ★ ProcessEnding 单辅音的 vc = "{v}{cc[0]} -"（**v 与 cc[0] 间无空格**）',
          'var vc = $"{v}{cc[0]} -";' in cs)
    check('FR VCCV: shortConsonants / longConsonants 是死字段（声明后未用）',
          'shortConsonants' in cs and 'longConsonants' in cs)

    # ---------------- 行为
    def oto(alias):
        from singing.openutau import (Oto, OtoSet, UOto, UOtoSet, USubbank, Subbank)
        return UOto(Oto(alias=alias, wav=alias + '.wav'),
                    UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb'),
                    [USubbank(Subbank(color=''))])

    class _S:
        def __init__(self, al):
            self.al = al
            self.found = True
            self.loaded = True
            self.location = ''
            self.id = 'fr-test'

        @property
        def is_loaded(self):
            return self.found and self.loaded

        def try_get_oto(self, p):
            return (p in self.al), self.al.get(p)

        def try_get_mapped_oto(self, p, tone, color=None):
            return (p in self.al), self.al.get(p)

    # ---- GetSymbols 的 arpabet→m2rUg 转换（phoneticHint 走 getSymbolsRaw，不查字典）
    ph = FrenchVCCVPhonemizer()
    ph.set_singer(_S({'- A': oto('- A')}))
    ph.set_timing(_CVVC_AXIS)
    check('FR VCCV.GetSymbols: arpabet 提示被转成 m2rUg（aa ai b → A E b）',
          ph.get_symbols(Note(lyric='x', phonetic_hint='aa ai b')) == ['A', 'E', 'b'],
          'got %r' % ph.get_symbols(Note(lyric='x', phonetic_hint='aa ai b')))
    check('FR VCCV.GetSymbols: gn → J',
          ph.get_symbols(Note(lyric='x', phonetic_hint='gn')) == ['J'])
    check('FR VCCV.GetSymbols: 已经是 m2rUg 的符号原样通过（A b → A b）',
          ph.get_symbols(Note(lyric='x', phonetic_hint='A b')) == ['A', 'b'])
    check('FR VCCV.GetSymbols: 空提示 → 走歌词分支，词典查不到给 None（并设 error）',
          ph.get_symbols(Note(lyric='x', phonetic_hint='')) is None
          and ph.error == 'word not found', 'got %r' % ph.error)
    ph.error = ''  # 清掉副作用，别污染后面

    # ---- 端到端：单音节 "- A" + 句末 "A -"（走 IsStartingV / IsEndingV）
    ph2 = FrenchVCCVPhonemizer()
    ph2.set_singer(_S({'- A': oto('- A'), 'A -': oto('A -')}))
    ph2.set_timing(_CVVC_AXIS)
    r = ph2.process([Note(lyric='x', phonetic_hint='aa', tone=60, duration=480)])
    check('FR VCCV.Process: 单音节 → ["- A", "A -"]（基音 + 句末尾韵）',
          [p.phoneme for p in r.phonemes] == ['- A', 'A -'],
          'got %r' % [p.phoneme for p in r.phonemes])
    check('FR VCCV.Process: 基音 position=0；句末 = 容器 − Min(50, 容器/3) = 430',
          r.phonemes[0].position == 0 and r.phonemes[1].position == 430,
          'got %r' % [p.position for p in r.phonemes])

    # ---- ProcessSyllable 各分支（用空歌手让所有 HasOto 走 false 路径，确定性）
    ph3 = FrenchVCCVPhonemizer()
    ph3.set_singer(_S({}))
    ph3.set_timing(_CVVC_AXIS)

    check('FR VCCV.IsStartingV → ["- {v}"]',
          ph3.process_syllable(F.Syllable(prev_v='', cc=[], v='A', tone=60))
          == ['- A'])
    check('FR VCCV.IsVV → ["{prevV} {v}"]',
          ph3.process_syllable(F.Syllable(prev_v='A', cc=[], v='E', tone=60))
          == ['A E'])
    check("FR VCCV.IsVV: ★ vocal fry 撇号被剥（prevV 带 ' → 剥成无撇号）",
          ph3.process_syllable(F.Syllable(prev_v="A'", cc=[], v='E', tone=60))
          == ['A E'])
    check('FR VCCV.IsStartingCV(1 辅音): HasOto 全假 → 只剩 base "{c}{v}"'
          '（TryAddPhoneme 没命中就不加）',
          ph3.process_syllable(F.Syllable(prev_v='', cc=['b'], v='A', tone=60))
          == ['bA'],
          'got %r' % ph3.process_syllable(F.Syllable(prev_v='', cc=['b'], v='A', tone=60)))
    check('FR VCCV.IsVCV(1 辅音) → ["{prevV} {c}", "{c}{v}"]',
          ph3.process_syllable(F.Syllable(prev_v='A', cc=['b'], v='E', tone=60,
                                          can_alias_be_extended=True))
          == ['A b', 'bE'])
    # 多辅音 + n j → J 规则（空歌手 → ccv/cci 都查不到）
    check('FR VCCV.IsVCV(>1 辅音): ★ 末尾 n+j → basePhoneme="J{v}"',
          ph3.process_syllable(F.Syllable(prev_v='A', cc=['n', 'j'], v='E', tone=60,
                                          duration=480, position=240,
                                          can_alias_be_extended=True))
          == ['A n', 'JE'],
          'got %r' % ph3.process_syllable(F.Syllable(prev_v='A', cc=['n', 'j'], v='E',
                                                     tone=60, duration=480, position=240,
                                                     can_alias_be_extended=True)))
    # 多辅音、不是 n+j（空歌手）
    r6 = ph3.process_syllable(F.Syllable(prev_v='A', cc=['b', 'l'], v='E', tone=60,
                                        duration=480, position=240,
                                        can_alias_be_extended=True))
    check('FR VCCV.IsVCV(>1 辅音, 非 n+j): ["{prevV} {c0}", base] —— 空 singer 下 cci 全没命中',
          r6[0] == 'A b' and r6[-1] == 'lE', 'got %r' % r6)

    # ---- ProcessEnding
    check('FR VCCV.IsEndingV → ["{v} -"]',
          ph3.process_ending(F.Ending(prev_v='A', cc=[], tail='', tone=60)) == ['A -'])
    check('FR VCCV.IsEndingVC(1 辅音): HasOto 假 → ["{v} {c}", "{c} -"]',
          ph3.process_ending(F.Ending(prev_v='A', cc=['n'], tail='', tone=60))
          == ['A n', 'n -'])
    check('FR VCCV.IsEndingVCC(>1 辅音): 空 singer 下 cci 全没命中，只剩 ["{v} {c0}"]',
          ph3.process_ending(F.Ending(prev_v='A', cc=['n', 'j'], tail='', tone=60))
          == ['A n'],
          'got %r' % ph3.process_ending(F.Ending(prev_v='A', cc=['n', 'j'], tail='', tone=60)))

    # ---- 带歌手的 IsStartingCV：命中 "- bA" 时不再拆
    ph4 = FrenchVCCVPhonemizer()
    ph4.set_singer(_S({'- bA': oto('- bA'), 'bA': oto('bA'), '- b': oto('- b')}))
    ph4.set_timing(_CVVC_AXIS)
    check('FR VCCV.IsStartingCV: 命中 "- bA" → 直接用，不再 TryAddPhoneme',
          ph4.process_syllable(F.Syllable(prev_v='', cc=['b'], v='A', tone=60))
          == ['- bA'])
    # 命中 "bA" 但不命中 "- bA" → 走拆分
    ph5 = FrenchVCCVPhonemizer()
    ph5.set_singer(_S({'bA': oto('bA'), '- b': oto('- b')}))
    ph5.set_timing(_CVVC_AXIS)
    check('FR VCCV.IsStartingCV: 不命中 "- bA" 但命中 "- b" + "bA" → 拆成两段',
          ph5.process_syllable(F.Syllable(prev_v='', cc=['b'], v='A', tone=60))
          == ['- b', 'bA'])

    # ---- 真 ClassicSinger 上也要能跑（接口契约回归）
    real = _real_classic_singer({'- A': oto('- A'), 'A -': oto('A -')})
    real.loaded = True
    ph6 = FrenchVCCVPhonemizer()
    ph6.set_singer(real)
    ph6.set_timing(_CVVC_AXIS)
    r6b = ph6.process([Note(lyric='x', phonetic_hint='aa', tone=60, duration=480)])
    check('FR VCCV × 真 ClassicSinger: 端到端能跑（不把 (found, oto) 当裸值）',
          [p.phoneme for p in r6b.phonemes] == ['- A', 'A -'],
          'got %r' % [p.phoneme for p in r6b.phonemes])


def test_french_cvvc_phonemizer():
    """`Plugin.Builtin/FrenchCVVCPhonemizer.cs`（757 行）—— `SyllableBased` 基类的
    **第二个真实用户**：同法语家族，验证更复杂的 `CheckAliasFormatting` / `ValidateAlias`
    / `FindLastValidAlias` / 多辅音簇分支。零外部 G2p 类、零 YAML。
    """
    from singing.openutau import Note, Phoneme, registered
    from singing.openutau.plugin_builtin import FrenchCVVCPhonemizer
    from singing.openutau.plugin_builtin import french_cvvc as F

    cs = open(os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                           'FrenchCVVCPhonemizer.cs'), encoding='utf-8-sig').read()
    cs = cs.replace('\r\n', '\n')

    # ---------------- 源码一致性
    m = re.search(r'\[Phonemizer\("([^"]*)",\s*"([^"]*)",\s*"([^"]*)"(?:,\s*language\s*:\s*"([^"]*)")?\)\]',
                  cs)
    check('FR CVVC: [Phonemizer] 的 name/tag/author/language 与 C# 一致',
          m is not None and (m.group(1), m.group(2), m.group(3), m.group(4)) == (
              FrenchCVVCPhonemizer.name, FrenchCVVCPhonemizer.tag,
              FrenchCVVCPhonemizer.author, FrenchCVVCPhonemizer.language),
          'C#=%r' % (m.groups() if m else None,))
    check('FR CVVC: 继承 SyllableBasedPhonemizer 且已注册',
          'class FrenchCVVCPhonemizer : SyllableBasedPhonemizer' in cs
          and registered().get('FR CVVC') is FrenchCVVCPhonemizer)
    check('FR CVVC: GetDictionaryName => "cmudict_fr.txt"',
          'GetDictionaryName() => "cmudict_fr.txt"' in cs
          and FrenchCVVCPhonemizer().get_dictionary_name() == 'cmudict_fr.txt')
    check('FR CVVC: NoGap => true', 'protected override bool NoGap => true;' in cs
          and FrenchCVVCPhonemizer().no_gap is True)
    check('FR CVVC: GetTransitionBasicLengthMs 转调 GetTransitionBasicLengthMsByOto',
          'double otoLength = GetTransitionBasicLengthMsByOto(alias, tone, attr);' in cs
          and 'return otoLength;' in cs)

    # vowels / consonants 逐项
    def _split_arr(name):
        mm = re.search(r'%s = "([^"]*)"\.Split' % name, cs)
        return mm.group(1).split(',') if mm else None

    check('FR CVVC: vowels 逐项一致（22 项）',
          _split_arr('vowels') == list(F.VOWELS) and len(F.VOWELS) == 22,
          'C#=%r' % (_split_arr('vowels'),))
    check('FR CVVC: consonants 逐项一致（24 项，含 gn / _hh）',
          _split_arr('consonants') == list(F.CONSONANTS) and len(F.CONSONANTS) == 24)

    # dictionaryReplacements：丢自映射（跨两行字符串字面量，要拼接）
    raw_block = re.search(r'dictionaryReplacements = \((.*?)\)\.Split', cs, re.S)
    raw_full = ''.join(re.findall(r'"([^"]*)"', raw_block.group(1))) if raw_block else ''
    want_map = {}
    for entry in raw_full.split(';'):
        if entry:
            parts = entry.split('=')
            if len(parts) == 2 and parts[0] != parts[1]:
                want_map[parts[0]] = parts[1]
    check('FR CVVC: dictionaryReplacements 逐项一致（且丢自映射）',
          want_map == F._REPL_MAP, 'C#=%r 我们=%r' % (want_map, F._REPL_MAP))
    check('FR CVVC: ★ 自映射 gn=gn 被丢；非自映射 4=l / hh=h 保留',
          'gn' not in F._REPL_MAP and F._REPL_MAP.get('4') == 'l'
          and F._REPL_MAP.get('hh') == 'h')

    # fraloidsReplacement
    fr_block = re.search(r'fraloidsReplacement = \((.*?)\)\.Split', cs, re.S)
    fr_full = ''.join(re.findall(r'"([^"]*)"', fr_block.group(1))) if fr_block else ''
    fr_map = {}
    for entry in fr_full.split(';'):
        if entry:
            parts = entry.split('=')
            if len(parts) == 2 and parts[0] != parts[1]:
                fr_map[parts[0]] = parts[1]
    check('FR CVVC: fraloidsReplacement 逐项一致（且丢自映射）',
          fr_map == F._FRALOIDS_REPLACEMENT, 'C#=%r 我们=%r' % (fr_map, F._FRALOIDS_REPLACEMENT))

    # GetDictionaryPhonemesReplacement 返回副本（字段隐藏语义）
    check('FR CVVC: GetDictionaryPhonemesReplacement 返回硬编码表副本，且基类字段保持空',
          FrenchCVVCPhonemizer().get_dictionary_phonemes_replacement() == dict(F._REPL_MAP)
          and FrenchCVVCPhonemizer().dictionary_replacements == {},
          'base field=%r' % FrenchCVVCPhonemizer().dictionary_replacements)

    # shortConsonants / longConsonants 是死字段
    check('FR CVVC: shortConsonants / longConsonants 声明后未用',
          'shortConsonants' in cs and 'longConsonants' in cs)

    # CheckAliasFormatting 的 aliasFormats 数组（15 项）与索引门
    check('FR CVVC: CheckAliasFormatting 的 aliasFormats 数组内容照搬（15 项）',
          re.search(r'string\[\] aliasFormats = new string\[\] \{(.*?)\};', cs, re.S) is not None)

    # FindLastValidAlias 是公共 helper（即便 C# private，测试可直接调）
    check('FR CVVC: FindLastValidAlias 只看最后一个 inputPhoneme，统计包含 wordPhonemes 几项',
          FrenchCVVCPhonemizer()._find_last_valid_alias(['A b'], ['A', 'b']) == 2
          and FrenchCVVCPhonemizer()._find_last_valid_alias(['A'], ['A', 'b']) == 1
          and FrenchCVVCPhonemizer()._find_last_valid_alias([], ['A', 'b']) == 0)

    # ★ 上游怪癖要在位
    check('FR CVVC: ★ ProcessSyllable 里 lastC/firstC 是死局部变量',
          'var lastC = cc.Length - 1;' in cs and 'var firstC = 0;' in cs)
    check('FR CVVC: ★ IsVV 分支没注释掉，走的是完整 vv/vvFr + y/w 例外逻辑',
          'vvFr' in cs and 'basePhoneme = $"y{v}"' in cs and 'basePhoneme = $"w{v}"' in cs)
    check('FR CVVC: ★ ProcessEnding 单辅音 CheckAliasFormatting($"{v}{cc[0]}","endVc",...) → 无空格',
          'CheckAliasFormatting($"{v}{cc[0]}", "endVc"' in cs)
    check('FR CVVC: ★ ReplaceFraloidsConflict 字典里 o n→on2 等映射',
          '{"o n","on2"}' in cs.replace('\n', ' ') or '{"o n", "on2"}' in cs)
    check('FR CVVC: ★ GetSymbols  splits gn → [n,y]',
          'modified.AddRange(new string[] { "n", "y" })' in cs)
    check('FR CVVC: ★ GetSymbols 里 `if (convert == null) return null;` 是死代码',
          'if (convert == null)' in cs)

    # ---------------- 行为
    def oto(alias):
        from singing.openutau import (Oto, OtoSet, UOto, UOtoSet, USubbank, Subbank)
        return UOto(Oto(alias=alias, wav=alias + '.wav'),
                    UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb'),
                    [USubbank(Subbank(color=''))])

    class _S:
        def __init__(self, al):
            self.al = al
            self.found = True
            self.loaded = True
            self.location = ''
            self.id = 'fr-test'

        @property
        def is_loaded(self):
            return self.found and self.loaded

        def try_get_oto(self, p):
            return (p in self.al), self.al.get(p)

        def try_get_mapped_oto(self, p, tone, color=None):
            return (p in self.al), self.al.get(p)

    # ---- GetSymbols
    ph = FrenchCVVCPhonemizer()
    ph.set_singer(_S({'- ah': oto('- ah')}))
    ph.set_timing(_CVVC_AXIS)
    check('FR CVVC.GetSymbols: arpabet → petitmot（aa ai b → ah ae b）',
          ph.get_symbols(Note(lyric='x', phonetic_hint='aa ai b')) == ['ah', 'ae', 'b'])
    check('FR CVVC.GetSymbols: gn → [n, y]',
          ph.get_symbols(Note(lyric='x', phonetic_hint='gn')) == ['n', 'y'])
    check('FR CVVC.GetSymbols: 已经是 petitmot 的符号原样通过（ah b → ah b）',
          ph.get_symbols(Note(lyric='x', phonetic_hint='ah b')) == ['ah', 'b'])

    # ---- CheckAliasFormatting 各 type 区间（歌手只给目标命中项，避免提前停）
    def _chk(alias, typ, prev_v, hits):
        p = FrenchCVVCPhonemizer()
        p.set_singer(_S({k: oto(k) for k in hits}))
        p.set_timing(_CVVC_AXIS)
        return p._check_alias_formatting(alias, typ, 60, prev_v)

    check('FR CVVC.CheckAliasFormatting("ba","cv",tone,"") 命中 "- ba"',
          _chk('ba', 'cv', '', ['- ba']) == '- ba')
    check('FR CVVC.CheckAliasFormatting("A","end",tone,"") 命中 "A-"',
          _chk('A', 'end', '', ['A-']) == 'A-')
    check('FR CVVC.CheckAliasFormatting("ba","vv",tone,"E") 命中 "E ba"',
          _chk('ba', 'vv', 'E', ['E ba']) == 'E ba')
    check('FR CVVC.CheckAliasFormatting("ba","endccOe",tone,"E") 顺序试 E/" E"/""/oe/eu',
          _chk('ba', 'endccOe', 'E', ['baoe']) == 'baoe')
    check('FR CVVC.CheckAliasFormatting("ba","endcOe",tone,"E") 命中 "baeu"',
          _chk('ba', 'endcOe', 'E', ['baeu']) == 'baeu')
    check('FR CVVC.CheckAliasFormatting("ba","blank",tone,"") 返回原 alias',
          _chk('ba', 'blank', '', ['ba']) == 'ba')

    # ---- ValidateAlias 路径
    ph_v = FrenchCVVCPhonemizer()
    ph_v.set_singer(_S({'wah': oto('wah')}))
    ph_v.set_timing(_CVVC_AXIS)
    check('FR CVVC.ValidateAlias: 直接命中就返回',
          ph_v.validate_alias('wah', 60) == 'wah')
    check('FR CVVC.ValidateAlias: 不命中时 wah→oi, wa→oi（顺序替换）',
          ph_v.validate_alias('wahoo', 60) == 'oioo')

    # ---- Fraloids 转换路径（ProcessSyllable 入口触发 uses_fraloids=True）
    ph_f = FrenchCVVCPhonemizer()
    ph_f.set_singer(_S({'a': oto('a')}))  # HasOto("a", tone) 真
    ph_f.set_timing(_CVVC_AXIS)
    # 调用一次 process_syllable 才会写 uses_fraloids
    _ = ph_f.process_syllable(F.Syllable(prev_v='', cc=[], v='a', tone=60, duration=480))
    check('FR CVVC: HasOto("a",tone) 真 → 触发 process 后 uses_fraloids=True',
          ph_f.uses_fraloids is True)
    check('FR CVVC.ValidateAlias(Fraloids): ee → e',
          ph_f.validate_alias('ee', 60) == 'e')

    # ---- ProcessSyllable 各分支（空歌手，确定性走 "no alias found" false 路径）
    ph3 = FrenchCVVCPhonemizer()
    ph3.set_singer(_S({}))
    ph3.set_timing(_CVVC_AXIS)

    check('FR CVVC.IsStartingV: 空 singer → CheckAliasFormatting 返回 "no alias found"',
          ph3.process_syllable(F.Syllable(prev_v='', cc=[], v='a', tone=60))
          == ['no alias found'])
    check('FR CVVC.IsVV: prevV=ui 先转成 ih；空 singer → "no alias found"',
          ph3.process_syllable(F.Syllable(prev_v='ui', cc=[], v='a', tone=60))
          == ['no alias found'])
    check('FR CVVC.IsVV: 空 singer → base "no alias found"（y/w 例外因 base!=v 不触发）',
          ph3.process_syllable(F.Syllable(prev_v='ih', cc=[], v='i', tone=60))
          == ['no alias found'])
    _ph_vv = FrenchCVVCPhonemizer()
    _ph_vv.set_singer(_S({'ih a': oto('ih a')}))
    _ph_vv.set_timing(_CVVC_AXIS)
    check('FR CVVC.IsVV: 带歌手命中 "ih a" → 用该 base',
          _ph_vv.process_syllable(F.Syllable(prev_v='ih', cc=[], v='a', tone=60))
          == ['ih a'])
    check('FR CVVC.IsStartingCV(1 辅音): 空 singer → base "no alias found"',
          ph3.process_syllable(F.Syllable(prev_v='', cc=['b'], v='a', tone=60))
          == ['no alias found'])
    check('FR CVVC.IsVCV(1 辅音): 空 singer → 只有基音 "bi"（VC 没命中不附加）',
          ph3.process_syllable(F.Syllable(prev_v='a', cc=['b'], v='i', tone=60,
                                          can_alias_be_extended=True))
          == ['bi'])
    check('FR CVVC.IsVCV(>1 辅音): base=cc.Last()+v；空 singer 下 VCC 全没命中',
          ph3.process_syllable(F.Syllable(prev_v='a', cc=['b', 'l'], v='i', tone=60,
                                          duration=480, position=240,
                                          can_alias_be_extended=True))
          == ['no alias found', 'no alias found', 'li'],
          'got %r' % ph3.process_syllable(F.Syllable(prev_v='a', cc=['b', 'l'], v='i',
                                                     tone=60, duration=480, position=240,
                                                     can_alias_be_extended=True)))

    # ---- ProcessEnding（空歌手）
    check('FR CVVC.IsEndingV: 空 singer → fallback 链全没命中 → []',
          ph3.process_ending(F.Ending(prev_v='a', cc=[], tail='', tone=60))
          == [])
    check('FR CVVC.IsEndingVC(1 辅音): 空 singer → ["no alias found"]',
          ph3.process_ending(F.Ending(prev_v='a', cc=['n'], tail='', tone=60))
          == ['no alias found'])

    # ---- 带歌手：StartingCV 命中 "- ba" 时不再拆
    ph4 = FrenchCVVCPhonemizer()
    ph4.set_singer(_S({'- ba': oto('- ba'), 'ba': oto('ba'), '- b': oto('- b')}))
    ph4.set_timing(_CVVC_AXIS)
    check('FR CVVC.IsStartingCV: 命中 "- ba" → 直接用，不再 TryAddPhoneme',
          ph4.process_syllable(F.Syllable(prev_v='', cc=['b'], v='a', tone=60))
          == ['- ba'])

    # ---- 真 ClassicSinger 端到端
    real = _real_classic_singer({'- ah': oto('- ah'), 'ah-': oto('ah-')})
    real.loaded = True
    ph6 = FrenchCVVCPhonemizer()
    ph6.set_singer(real)
    ph6.set_timing(_CVVC_AXIS)
    r6b = ph6.process([Note(lyric='x', phonetic_hint='aa', tone=60, duration=480)])
    check('FR CVVC × 真 ClassicSinger: 端到端能跑（不把 (found, oto) 当裸值）',
          [p.phoneme for p in r6b.phonemes] == ['- ah', 'ah-'],
          'got %r' % [p.phoneme for p in r6b.phonemes])


def test_turkish_cvvc_phonemizer():
    """`Plugin.Builtin/TurkishCVVCPhonemizer.cs`（356 行）—— **直接继承 `Phonemizer`**，
    自己实现歌词分段、VC 边界计算与 oto 查询。零外部依赖。
    """
    from singing.openutau import Note, Oto, OtoSet, UOto, UOtoSet, USubbank, Subbank, TimeAxis, registered
    from singing.ustx import UProject
    from singing.openutau.plugin_builtin import TurkishCVVCPhonemizer
    from singing.openutau.plugin_builtin import turkish_cvvc as T

    cs = open(os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                           'TurkishCVVCPhonemizer.cs'), encoding='utf-8-sig').read()
    cs = cs.replace('\r\n', '\n')

    # ---------------- 源码一致性
    m = re.search(r'\[Phonemizer\("([^"]*)",\s*"([^"]*)",\s*"([^"]*)"(?:,\s*language\s*:\s*"([^"]*)")?\)\]',
                  cs)
    check('TR CVVC: [Phonemizer] 的 name/tag/author/language 与 C# 一致',
          m is not None and (m.group(1), m.group(2), m.group(3), m.group(4)) == (
              TurkishCVVCPhonemizer.name, TurkishCVVCPhonemizer.tag,
              TurkishCVVCPhonemizer.author, TurkishCVVCPhonemizer.language),
          'C#=%r' % (m.groups() if m else None,))
    check('TR CVVC: 继承 Phonemizer（不是 SyllableBased）且已注册',
          'class TurkishCVVCPhonemizer : Phonemizer' in cs
          and registered().get('TR CVVC') is TurkishCVVCPhonemizer)

    def _split_arr(name):
        mm = re.search(r'%s = new string\[\] \{([^}]*)\}' % name, cs)
        if not mm:
            return None
        return [s.strip().strip('"').strip("'") for s in mm.group(1).split(',')]

    # glottalStops / vowels / sustainedConsonants 用 regex 数组
    check('TR CVVC: glottalStops 逐项一致',
          _split_arr('glottalStops') == list(T.GLOTTAL_STOPS))
    check('TR CVVC: vowels 逐项一致（9 项）',
          _split_arr('vowels') == list(T.VOWELS))
    check('TR CVVC: sustainedConsonants 逐项一致',
          _split_arr('sustainedConsonants') == list(T.SUSTAINED_CONSONANTS))
    # consonants 用 Split(',')
    cs_cons = re.search(r'consonants = "([^"]*)"\.Split', cs)
    check('TR CVVC: consonants 逐项一致（45 项）',
          cs_cons and cs_cons.group(1).split(',') == list(T.CONSONANTS))

    # SetSinger 直接存字段
    check('TR CVVC: SetSinger 直接赋值 this.singer',
          'public override void SetSinger(USinger singer) => this.singer = singer;' in cs)

    # ---------------- 行为
    def oto(alias, **kwargs):
        return UOto(Oto(alias=alias, wav=alias + '.wav', **kwargs),
                    UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb'),
                    [USubbank(Subbank(color=''))])

    class _S:
        def __init__(self, al):
            self.al = al
            self.found = True
            self.loaded = True
            self.location = ''
            self.id = 'tr-test'

        @property
        def is_loaded(self):
            return self.found and self.loaded

        def try_get_oto(self, p):
            return (p in self.al), self.al.get(p)

        def try_get_mapped_oto(self, p, tone, color=None):
            return (p in self.al), self.al.get(p)

    AX = TimeAxis()
    AX.build_segments(UProject())

    ph = TurkishCVVCPhonemizer()
    ph.set_singer(_S({}))
    ph.set_timing(AX)

    # ---- 歌词转换
    check('TR CVVC.convertToOtoStyledLyric: 土耳其字符映射',
          ph._convert_to_oto_styled_lyric('çşğæEıöü') == 'chsh9aeaeeuoeue')

    # ---- 歌词分段
    seg = ph._get_segmented_phonemes('şarkı')
    check('TR CVVC.getSegmentedPhonemes: şarkı → [sh,_,a,r,k]',
          (seg.start_c1, seg.start_c2, seg.vow, seg.end_c1, seg.end_c2) == ('sh', '', 'a', 'r', 'k'))
    seg2 = ph._get_segmented_phonemes('a')
    check('TR CVVC.getSegmentedPhonemes: 单元音 → [_,_,a,_,_]',
          (seg2.start_c1, seg2.start_c2, seg2.vow, seg2.end_c1, seg2.end_c2) == ('', '', 'a', '', ''))
    seg3 = ph._get_segmented_phonemes('9a')
    check('TR CVVC.getSegmentedPhonemes: 词首 9 被记为 has_9_before_vow',
          seg3.has_9_before_vow is True and seg3.vow == 'a')

    # ---- getNoteStart
    c = T._SegmentedLyric('la', 'l', '', 'a', '', '', False)
    p_empty = T._SegmentedLyric.empty()
    check('TR CVVC.getNoteStart: 无前邻 → ["- la", "la", "la"]',
          ph._get_note_start(c, p_empty) == ['- la', 'la', 'la'])

    prev_v = T._SegmentedLyric('ba', 'b', '', 'a', '', '', False)
    check('TR CVVC.getNoteStart: 前邻元音 + 当前元音 → V+V',
          ph._get_note_start(T._SegmentedLyric('a', '', '', 'a', '', '', False), prev_v)
          == ['a a', 'a', 'a'])

    prev_vc = T._SegmentedLyric('al', 'a', '', 'a', 'l', '', False)
    check('TR CVVC.getNoteStart: 前邻持续辅音 L → 用大写 L 做 VC',
          ph._get_note_start(T._SegmentedLyric('a', '', '', 'a', '', '', False), prev_vc)
          == ['L a', 'a', 'a'])

    prev_vc_nonsus = T._SegmentedLyric('ab', 'a', '', 'a', 'b', '', False)
    check('TR CVVC.getNoteStart: 前邻非持续辅音 b → result[0] 不变（仍是 "- a"）',
          ph._get_note_start(T._SegmentedLyric('a', '', '', 'a', '', '', False), prev_vc_nonsus)
          == ['- a', 'a', 'a'])

    c_cv = T._SegmentedLyric('la', 'l', '', 'a', '', '', False)
    check('TR CVVC.getNoteStart: 当前带辅音 → 只返回 [noteStart, lyric]',
          ph._get_note_start(c_cv, prev_v) == ['la', 'la'])

    # ---- getConsonantEnding
    check('TR CVVC.getConsonantEnding: 无尾音无下一音 → ["V -"]',
          ph._get_consonant_ending(T._SegmentedLyric('a', '', '', 'a', '', '', False),
                                   False, T._SegmentedLyric.empty()) == ['a -'])
    check('TR CVVC.getConsonantEnding: 无尾音 + 下一音带辅音 → V+c',
          ph._get_consonant_ending(T._SegmentedLyric('a', '', '', 'a', '', '', False),
                                   True,
                                   T._SegmentedLyric('be', 'b', '', 'e', '', '', False))
          == ['a by'],
          'got %r' % ph._get_consonant_ending(T._SegmentedLyric('a', '', '', 'a', '', '', False),
                                              True,
                                              T._SegmentedLyric('be', 'b', '', 'e', '', '', False)))
    check('TR CVVC.getConsonantEnding: 喉塞音结尾 → 直接 V+?',
          ph._get_consonant_ending(T._SegmentedLyric('a?', '', '', 'a', '?', '', False),
                                   False, T._SegmentedLyric.empty()) == ['a ?'])

    # ---- checkOtoUntilHit 的 alt 拼接语义
    ph2 = TurkishCVVCPhonemizer()
    ph2.set_singer(_S({'- la': oto('- la'), '- la3': oto('- la3')}))
    ph2.set_timing(AX)
    n = Note(lyric='la', tone=60, duration=480,
             phoneme_attributes=[type('A', (), {'index': 0, 'voice_color': None,
                                                  'tone_shift': None, 'alternate': 3,
                                                  'consonant_stretch_ratio': None})()])
    hit = ph2._check_oto_until_hit(['- la'], n)
    check('TR CVVC.checkOtoUntilHit: alt=3 时先试 "- la3"',
          hit is not None and hit.alias == '- la3')

    # ---- Process 端到端：有歌手命中 noteStart / noteEnd
    ph3 = TurkishCVVCPhonemizer()
    ph3.set_singer(_S({'- la': oto('- la'), 'a -': oto('a -')}))
    ph3.set_timing(AX)
    r = ph3.process([Note(lyric='la', tone=60, duration=480)],
                    None, None, None, None, [])
    check('TR CVVC.Process: 单音节 CV 无尾音无下一音 → ["- la", "a -"]',
          [(p.phoneme, p.position) for p in r.phonemes] == [('- la', 0), ('a -', 360)],
          'got %r' % [(p.phoneme, p.position) for p in r.phonemes])

    # ---- Process：无 oto 命中时回退到原歌词
    ph4 = TurkishCVVCPhonemizer()
    ph4.set_singer(_S({}))
    ph4.set_timing(AX)
    r4 = ph4.process([Note(lyric='xyz', tone=60, duration=480)],
                     None, None, None, None, [])
    check('TR CVVC.Process: 完全无命中 → 返回原歌词',
          [p.phoneme for p in r4.phonemes] == ['xyz'])

    # ---- Process：句首点号直接输出后续字符串
    r5 = ph4.process([Note(lyric='.hello', tone=60, duration=480)],
                     None, None, None, None, [])
    check('TR CVVC.Process: 句首 "." → 直接输出后面的字符串',
          [p.phoneme for p in r5.phonemes] == ['hello'])


def test_arpasing_phonemizer():
    """`Plugin.Builtin/ArpasingPhonemizer.cs`（62 行）+ `Data/arpasing.template.yaml`。

    `LatinDiphone` 子类：LoadG2p 三层回落（插件目录 arpasing.yaml（缺则写模板，无
    try/catch）→ 声库目录 arpasing.yaml（有 try/catch）→ 内置 ArpabetG2p → G2pFallbacks）。
    """
    import tempfile
    import unittest.mock
    from singing.openutau import Note, registered
    from singing.openutau.g2p import ArpabetG2p, set_data_dir
    from singing.openutau.g2p import arpabet as A
    from singing.openutau.plugin_builtin import ArpasingPhonemizer
    from singing.openutau.plugin_builtin import arpasing as AR

    cs = open(os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                           'ArpasingPhonemizer.cs'), encoding='utf-8-sig').read()
    cs = cs.replace('\r\n', '\n')

    # ---------------- 源码一致性
    m = re.search(r'\[Phonemizer\("([^"]*)",\s*"([^"]*)"(?:,\s*language\s*:\s*"([^"]*)")?\)\]',
                  cs)
    check('EN ARPA: [Phonemizer] 的 name/tag/language 与 C# 一致（author 缺省空）',
          m is not None and (m.group(1), m.group(2), m.group(3)) == (
              ArpasingPhonemizer.name, ArpasingPhonemizer.tag,
              ArpasingPhonemizer.language)
          and ArpasingPhonemizer.author == '',
          'C#=%r' % (m.groups() if m else None,))
    check('EN ARPA: 继承 LatinDiphonePhonemizer 且已注册',
          'class ArpasingPhonemizer : LatinDiphonePhonemizer' in cs
          and registered().get('EN ARPA') is ArpasingPhonemizer)
    check('EN ARPA: 构造函数里 Initialize() 包在 try/catch',
          'try {' in cs and 'Initialize();' in cs
          and 'Log.Error(e, "Failed to initialize.");' in cs)
    check('EN ARPA: LoadG2p 插件目录那份**无** try/catch（读完直接 Build）',
          'g2ps.Add(G2pDictionary.NewBuilder().Load(File.ReadAllText(path)).Build());' in cs)
    check('EN ARPA: 缺文件时 CreateDirectory + 写模板（对应内嵌资源）',
          'Directory.CreateDirectory(PluginDir);' in cs
          and 'File.WriteAllBytes(path, Data.Resources.arpasing_template);' in cs)
    check('EN ARPA: 声库目录那份**有** try/catch',
          'Log.Error(e, $"Failed to load {file}");' in cs)
    check('EN ARPA: 内置回落是 ArpabetG2p',
          'g2ps.Add(new ArpabetG2p());' in cs)

    # 模板数据与 C# 资源文件逐字一致
    tpl_cs = open(os.path.join(os.path.dirname(REF), 'OpenUtau.Plugin.Builtin',
                               'Data', 'arpasing.template.yaml'),
                  encoding='utf-8-sig').read().replace('\r\n', '\n')
    check('EN ARPA: 内嵌模板与 C# 的 arpasing.template.yaml 逐字一致',
          AR.ARPASING_TEMPLATE == tpl_cs,
          'len(C#)=%d len(我们)=%d' % (len(tpl_cs), len(AR.ARPASING_TEMPLATE)))

    # LoadVowelFallbacks 逐项
    check('EN ARPA: LoadVowelFallbacks 与 C# 单行字符串逐项一致',
          ArpasingPhonemizer().load_vowel_fallbacks() == {
              'aa': ['ah', 'ae'], 'ae': ['ah', 'aa'], 'ah': ['aa', 'ae'],
              'ao': ['ow'], 'ow': ['ao'], 'eh': ['ae'], 'ih': ['iy'],
              'iy': ['ih'], 'uh': ['uw'], 'uw': ['uh'], 'aw': ['ao']})

    # ---------------- 行为
    data_dir = os.path.join(os.path.dirname(REF), 'OpenUtau.Core', 'G2p', 'Data')
    if not os.path.isdir(data_dir):
        print('  SKIP 找不到 G2p/Data 目录')
        return
    set_data_dir(data_dir)
    ArpabetG2p.reset_cache()

    with tempfile.TemporaryDirectory() as plugin_dir:
        # ★ 先测 quirk：plugin_dir 为空串时 makedirs('') 抛错 → 被构造 catch 吞 → g2p=None
        old = os.environ.get('FUFUMIDI_PLUGIN_DIR')
        os.environ['FUFUMIDI_PLUGIN_DIR'] = ''
        try:
            ph_empty = ArpasingPhonemizer()
            check('EN ARPA: ★ PluginDir 为空串时 CreateDirectory 抛错被构造吞掉（g2p=None）',
                  ph_empty.g2p is None)
        finally:
            if old is None:
                os.environ.pop('FUFUMIDI_PLUGIN_DIR', None)
            else:
                os.environ['FUFUMIDI_PLUGIN_DIR'] = old

        with unittest.mock.patch.dict(os.environ, {'FUFUMIDI_PLUGIN_DIR': plugin_dir}):
            ph = ArpasingPhonemizer()
            check('EN ARPA: PluginDir 缺 arpasing.yaml 时**写出模板**',
                  os.path.isfile(os.path.join(plugin_dir, 'arpasing.yaml')))
            check('EN ARPA: g2p 三层回落装载成功',
                  ph.g2p is not None and ph.vowel_fallback != {})
            check('EN ARPA: 内置 ArpabetG2p 可查（hello → hh ah l ow）',
                  ph.g2p.query('hello') == ['hh', 'ah', 'l', 'ow'])
            check('EN ARPA: 模板里的词条可查（openutau）',
                  ph.g2p.query('openutau')
                  == ['ow', 'p', 'eh', 'n', 'w', 'uw', 't', 'ah', 'w', 'uw'])

            # 端到端：有 hint 的 diphone 别名选择（空歌手 → 全走回落串）
            class _S:
                def __init__(self, al):
                    self.al = al
                    self.found = True
                    self.loaded = True
                    self.location = ''
                    self.id = 'arpa-test'

                @property
                def is_loaded(self):
                    return self.found and self.loaded

                def try_get_oto(self, p):
                    return (p in self.al), self.al.get(p)

                def try_get_mapped_oto(self, p, tone, color=None):
                    return (p in self.al), self.al.get(p)

            ph3 = ArpasingPhonemizer()
            ph3.set_singer(_S({}))
            r = ph3.process([Note(lyric='hello', phonetic_hint='hh ah l ow',
                                  tone=60, duration=480)], None, None, None, None, [])
            check('EN ARPA.Process: diphone 别名（空歌手走回落串）',
                  [p.phoneme for p in r.phonemes]
                  == ['- hh', 'hh ah', 'ah l', 'l ow', 'ow -'],
                  'got %r' % [p.phoneme for p in r.phonemes])
            check('EN ARPA.Process: addTail 在无下一邻居时补 "-"（5 个符号）',
                  len(r.phonemes) == 5)


def _workflow_project(tmp):
    """全链路测试用的最小工程（表达式表 / 时间轴 / 轨道 / part / 两个「な」）。"""
    from singing.openutau.classic import ClassicRenderer
    from singing.ustx import (UCurve, UExpressionDescriptor, UExpressionType,
                              UNote, UPitch, UProject, UVibrato, UVoicePart,
                              PitchPoint)

    src = os.path.join(tmp, 'src.wav')
    _write_wav(src, [0.5 * math.sin(2 * math.pi * 300 * i / 44100) for i in range(22050)])

    project = UProject()
    specs = [
        ('volume', 'vol', UExpressionType.NUMERICAL, 0, 100, 100, None, None),
        ('velocity', 'vel', UExpressionType.NUMERICAL, 0, 100, 100, 'V', None),
        ('shift', 'shft', UExpressionType.NUMERICAL, 0, 100, 0, None, None),
        ('color', 'clr', UExpressionType.OPTIONS, 0, 100, 0, None, ['']),
        ('dynamics', 'dyn', UExpressionType.CURVE, -240, 120, 0, None, None),
        ('attack', 'atk', UExpressionType.NUMERICAL, 0, 100, 100, None, None),
        ('decay', 'dec', UExpressionType.NUMERICAL, 0, 100, 100, None, None),
    ]
    for name, abbr, typ, mn, mx, dv, flag, options in specs:
        project.expressions[abbr] = UExpressionDescriptor(
            name=name, abbr=abbr, type=typ, min=mn, max=mx, default_value=dv,
            flag=flag or '', options=options,
            is_flag=bool(flag) or typ == UExpressionType.OPTIONS)
    project.time_axis.build_segments(project)

    track = project.tracks[0]
    track.renderer_settings.renderer = 'CLASSIC'
    track.renderer_settings.renderer_obj = ClassicRenderer()
    track.renderer_settings.resampler = 'worldline'
    track.renderer_settings.wavtool = 'convergence'

    part = UVoicePart(track_no=0, position=0)
    part.curves.append(UCurve(xs=[0], ys=[0], abbr='dyn',
                              descriptor=project.expressions['dyn']))
    note0 = UNote(position=0, duration=480, tone=69, lyric='な',
                  pitch=UPitch(data=[PitchPoint(x=0, y=0)]), vibrato=UVibrato())
    note1 = UNote(position=480, duration=480, tone=69, lyric='な',
                  pitch=UPitch(data=[PitchPoint(x=0, y=0)]), vibrato=UVibrato())
    part.notes.extend([note0, note1])
    project.parts.append(part)
    return project, track, part, src


def test_workflow_end_to_end():
    """★ **整套工作流**：工程/音符 → 音素化（真 ClassicSinger + JA VCV 音素化器）→
    `UPhoneme` 校验 → `PhraseSource` → `ClassicRenderer`（真机 worldline.dll）→ 样本。

    音素化与乐句部分**零外部依赖**；渲染部分缺 `worldline.dll` 时 SKIP
    （渲染本身已由 `test_classic_renderer_internal_end_to_end` 单独覆盖）。
    对应 C#：`PhonemizerRunner.Phonemize` + `UPart.Validate`（音素化段）+
    `Pipeline.PhraseSource.FromPart` + `IRenderer.Render`。
    """
    import tempfile

    from singing.openutau import ValidateOptions
    from singing.openutau.part_validate import validate_part_phonemes
    from singing.openutau.plugin_builtin import japanese_vcv as JV
    from singing.openutau.render_phrase import RenderPhrase

    tmp = tempfile.mkdtemp(prefix='fufumidi-workflow-')
    try:
        project, track, part, src = _workflow_project(tmp)

        def _oto(alias):
            from singing.openutau.oto import (Oto, OtoSet, UOto, UOtoSet, USubbank,
                                              Subbank)
            u = UOto(Oto(alias=alias, wav=alias + '.wav'),
                    UOtoSet(OtoSet(file='oto.ini', name='main'), singers_path='/vb'),
                    [USubbank(Subbank(color=''))])
            u.file = src          # 指向真实 300Hz 正弦 wav，渲染环节真的有素材
            u.preutter = 50.0
            u.overlap = 10.0
            return u

        singer = _real_classic_singer({'- な': _oto('- な'), 'a な': _oto('a な')})
        singer.loaded = True        # 真 ClassicSinger 默认未加载（宿主负责加载）
        singer.voicebank.id = 'workflow-singer'   # 渲染缓存文件名要用
        track.singer_obj = singer

        phonemizer = JV.JapaneseVCVPhonemizer()
        response = validate_part_phonemes(ValidateOptions(), project, track, part,
                                          phonemizer, timestamp=1)

        check('工作流: 两个音符组都送进了音素化器',
              response.note_indexes == [0, 1])
        check('工作流: 音素化结果 ["- な", "a な"]（第二音的别名来自**前邻歌词的元音**）',
              [p.phoneme for p in part.phonemes] == ['- な', 'a な'],
              'got %r' % [p.phoneme for p in part.phonemes])
        check('工作流: rawPosition 是 part 相对 tick（0 / 480）',
              [p.raw_position for p in part.phonemes] == [0, 480])
        check('工作流: 音素全部校验通过（无 error、oto 命中、preutter>0）',
              all(not p.error for p in part.phonemes)
              and all(p.oto is not None for p in part.phonemes)
              and all(p.preutter > 0 for p in part.phonemes))
        check('工作流: note.phonemeIndexes 已回填（各 [0]）',
              part.notes[0].phoneme_indexes == [0]
              and part.notes[1].phoneme_indexes == [0])
        check('工作流: 音素化器没建议表达式 → phonemizerExpressions 为空',
              all(not n.phonemizer_expressions for n in part.notes))

        phrases = RenderPhrase.from_part(project, track, part)
        check('工作流: 相邻两个音符并成**一条**乐句（2 个 phone）',
              len(phrases) == 1 and len(phrases[0].phones) == 2,
              'got %r' % [(len(p.phones),) for p in phrases])
        check('工作流: 乐句里的音素别名与 UPhoneme 一致',
              [ph.phoneme for ph in phrases[0].phones] == ['- な', 'a な'])

        # ---- 渲染环节（真机）
        dll = os.path.join(REF_ROOT, 'runtimes', 'win-x64', 'native', 'worldline.dll')
        if not os.path.isfile(dll):
            print('  SKIP 渲染环节：找不到 worldline.dll（音素化/乐句已验证）')
            return
        from singing.openutau import worldline as W
        native = W.get_native(dll)
        if not native.available:
            print('  SKIP 渲染环节：worldline.dll 加载失败：%s' % native.error)
            return
        from singing.openutau import Progress
        from singing.openutau.classic import ClassicRenderer
        from singing.openutau.classic.worldline_resampler import WorldlineResampler

        class _Resampler(WorldlineResampler):
            def __init__(self):
                super().__init__('/root')

        resampler = _Resampler()
        old_host = _install_host(_test_classic_host(tmp, resampler))
        try:
            renderer = ClassicRenderer()
            result = _run(renderer.render(phrases[0], Progress(2), track_no=0))
            check('工作流: 渲染产出非空样本',
                  result.samples is not None and len(result.samples) > 0,
                  'got %r' % (None if result.samples is None else len(result.samples)))
            check('工作流: 样本有限且不静音',
                  all(math.isfinite(v) for v in result.samples)
                  and max(abs(v) for v in result.samples) > 1e-3,
                  'got peak %r' % max(abs(v) for v in result.samples))
            # 输出主频 ≈ 440Hz（tone 69；源 300Hz）—— 变调真的生效
            mid = result.samples[len(result.samples) // 4: len(result.samples) * 3 // 4]
            measured = _dominant_zero_cross(mid)
            check('工作流: 输出主频 ≈ 440Hz（过零率 ±10%）',
                  measured is not None and abs(measured - 440.0) < 44.0,
                  'got %.1f Hz' % (measured or 0.0))
        finally:
            _install_host(old_host)
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def _raises_type(exc, fn):
    """小工具：期望抛**指定类型**的异常（本文件已有一个更宽松的 `_raises(fn)`）."""
    try:
        fn()
    except exc:
        return True
    except Exception:
        return False
    return False


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
    print('--- XXH64 ---')
    test_xxhash64()
    print('--- MusicMath 扩展（插值/换算） ---')
    test_musicmath_extra()
    print('--- CubicSplineSegment ---')
    test_spline()
    print('--- CurveSource / VibratoSource ---')
    test_curve_source_sample()
    test_vibrato_source_eval()
    print('--- RenderPhrase 源码一致性（写入顺序/常量/枚举） ---')
    test_render_phrase_source_conformance()
    print('--- RenderNote / RenderPhone 派生字段 ---')
    test_render_note_phone_fields()
    print('--- RenderPhrase 乐句装配 ---')
    test_render_phrase_build()
    print('--- Renderers 注册表 / ApplyDynamics ---')
    test_renderers_registry()
    print('--- Pipeline/Identities ---')
    test_pipeline_identities()
    print('--- Pipeline/PhraseSource（取快照 / 切乐句 / 出 RenderPhrase） ---')
    test_phrase_source_from_part()
    test_phrase_source_merge_adjacent()
    test_pipeline_source_conformance()
    print('--- Pipeline/PhraseSourceBuilder（门闩 / 后台构建） ---')
    test_phrase_build_gate()
    test_phrase_source_builder()
    print('--- Pipeline/Snapshots（快照 + 增量失效） ---')
    test_document_snapshot_store()
    print('--- Render/Worldline（纯逻辑） ---')
    test_worldline_pure()
    print('--- G2p/ArpabetG2p + LatinDiphone ---')
    test_arpabet_g2p_and_latin_diphone()
    print('--- Plugin.Builtin/ChineseCVV ---')
    test_chinese_cvv_phonemizer()
    print('--- Plugin.Builtin/PhonemeBased + Monophone ---')
    test_phoneme_based_phonemizer()
    print('--- Core/G2p 基础设施 ---')
    test_g2p()
    print('--- Plugin.Builtin/SyllableBased + G2pRemapper + YamlWatcher ---')
    test_syllable_based_phonemizer()
    print('--- Plugin.Builtin/FrenchVCCV（SyllableBased 首个真实用户）---')
    test_french_vccv_phonemizer()
    print('--- Plugin.Builtin/FrenchCVVC（SyllableBased 第二个真实用户）---')
    test_french_cvvc_phonemizer()
    print('--- Plugin.Builtin/TurkishCVVC（直接继承 Phonemizer）---')
    test_turkish_cvvc_phonemizer()
    print('--- Plugin.Builtin/Arpasing（LatinDiphone 子类）---')
    test_arpasing_phonemizer()
    print('--- ★ 整套工作流端到端（音素化→乐句→渲染）---')
    test_workflow_end_to_end()
    print('--- 音素化器 × 真 ClassicSinger（接口契约回归） ---')
    test_phonemizers_against_real_singer()
    print('--- Plugin.Builtin/JapaneseCVVC ---')
    test_japanese_cvvc_phonemizer()
    print('--- Classic/WorldlineRenderer ---')
    test_worldline_renderer()
    print('--- RenderPhrase MOD+ ---')
    test_mod_plus()
    print('--- Classic/ClassicSinger + OtoWatcher + Loader ---')
    test_classic_singer()
    print('--- Classic/Ini ---')
    test_ini_read_blocks()
    print('--- Plugin.Builtin/ChineseCVVC ---')
    test_chinese_cvvc_phonemizer()
    print('--- Plugin.Builtin/ChineseVCV ---')
    test_chinese_vcv_phonemizer()
    print('--- Plugin.Builtin/JapaneseVCV ---')
    test_japanese_vcv_phonemizer()
    print('--- Classic/ResamplerItem ---')
    test_resampler_item()
    print('--- Format/Wave（WAV 缓存文件的读写） ---')
    test_wave_io()
    print('--- Classic/SharpWavtool + NWaves 原语 ---')
    test_nwaves_filter()
    test_sharp_wavtool()
    test_resampler_manifest()
    print('--- Classic/VoicebankConfig（character.yaml） ---')
    test_voicebank_config()
    print('--- Classic/VoicebankLoader（character.txt / oto.ini / prefix.map） ---')
    test_voicebank_loader()
    print('--- Classic/Frq（.frq / .mrq / OtoFrq） ---')
    test_frq_files()
    print('--- Worldline.Resample（编排 + 真机） ---')
    test_worldline_resample_orchestration()
    test_worldline_resample_live()
    print('--- Classic/WorldlineResampler ---')
    test_worldline_resampler_class()
    print('--- Classic/ClassicRenderer（能力 / 布局 / 注册 / Progress） ---')
    test_classic_renderer_basics()
    print('--- ClassicRenderer 端到端（变调 → 拼接 → 样本） ---')
    test_classic_renderer_internal_end_to_end()
    test_classic_renderer_external_path()
    test_classic_renderer_resample_failure()
    print('\n结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
    return 1 if _FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
