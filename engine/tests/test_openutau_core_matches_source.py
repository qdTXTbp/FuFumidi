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
import unicodedata
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

REF = os.environ.get('OPENUTAU_REF') or r'D:/FuFuMIDI/_ref/OpenUtau/OpenUtau.Core'

from singing.openutau import (  # noqa: E402
    NAME_IN_OCTAVE, CubicSplineSegment, CurveSource, IRenderer, MusicMath, NoteSource, Oto,
    OtoSet, PhonemeSource, PhraseLayout, PhraseSource, Phonemizer, Preferences, RenderNote,
    RenderPhone, RenderPhrase, RenderPitchResult, RenderResult, Subbank, TimeAxis,
    UOto, UOtoSet, USinger, USingerType, USubbank, VibratoSource,
)
from singing.openutau.renderer import SINGER_TYPE_FROM_NAME, SINGER_TYPE_NAMES  # noqa: E402
from singing.ustx import (  # noqa: E402
    PitchPoint, PitchPointShape, UExpressionDescriptor, UProject, UTrack, Vector2,
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
            return self.aliases.get(phoneme)

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

    def __init__(self, aliases):
        self.aliases = aliases

    def try_get_mapped_oto(self, phoneme, tone, color=None):
        return self.aliases.get(phoneme)


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
    print('--- Plugin.Builtin/ChineseVCV ---')
    test_chinese_vcv_phonemizer()
    print('--- Plugin.Builtin/JapaneseVCV ---')
    test_japanese_vcv_phonemizer()
    print('--- Classic/ResamplerItem ---')
    test_resampler_item()
    print('\n结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
    return 1 if _FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
