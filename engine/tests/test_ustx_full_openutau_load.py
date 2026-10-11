# -*- coding: utf-8 -*-
"""全参数加载兼容性测试：用覆盖**全部 ustx 键**的样例验证读取正确。

目标：OpenUTAU 写出的工程文件，我们的加载器必须把**每一个参数**都读对：
  - 工程级：name/comment/output_dir/cache_dir/ustx_version/key/exp_selectors/
    exp_primary/exp_secondary/expression_graphs/default_expression_graphs/
    多 tempo、多拍号
  - 表达式描述符：全部 11 个字段（含 `_custom_default_value` 前导下划线键）
  - 轨道级：singer/phonemizer/renderer_settings（嵌套）/track_name/track_color/
    mute/solo/volume/pan/track_expressions/expression_graph/voice_color_names/
    mix_fx（全部 18 个字段）
  - 音符级：position/duration/tone/lyric/tuning/**音符级音素化器覆写
    （YAML 键是 `phonemizer` —— C# 的 YamlMember 别名，别搞成
    phonemizer_override）**/pitch 全部 5 种 shape/vibrato 全部 8 个字段
    （含 `in`/`out` 关键字键）/phoneme_expressions/phoneme_overrides 全部 7 字段
  - part 级：曲线（绑定 descriptor）、masked 曲线（runs）、wave part 全部 6 字段
  - AfterLoad 语义：未知表达式的曲线剔除、Duration 圆整修正
  - 版本迁移：0.3（acc→attack / ...→+ / bpm→tempos）
  - 容错：未知键忽略、BOM、旧版仓库误写的 `phonemizer_override:` 键兼容

可离线运行：python engine/tests/test_ustx_full_openutau_load.py
"""

import io as _io
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from singing.ustx.format import Ustx, load  # noqa: E402
from singing.ustx.io import dumps, loads  # noqa: E402
from singing.ustx.model import UVoicePart, UWavePart  # noqa: E402

_PASS, _FAIL = [], []


def check(label, cond, detail=''):
    (_PASS if cond else _FAIL).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


# ---------------------------------------------------------------- 样例工程

# 模拟 OpenUTAU 实际写出的 ustx（0.6 版键集；音符级覆写用 `phonemizer:` 别名键）
FULL_USTX = """\
name: Compat Test
comment: 覆盖全部参数
output_dir: Out
cache_dir: Cache
ustx_version: "0.6"
expressions:
  dyn:
    name: dynamics (curve)
    abbr: dyn
    type: Curve
    min: -240
    max: 120
    default_value: 0
  clr:
    name: voice color
    abbr: clr
    type: Options
    min: 0
    max: 2
    default_value: 0
    is_flag: false
    options:
    - main
    - whisper
    - airy
  gen:
    name: gender
    abbr: gen
    type: Numerical
    min: -100
    max: 100
    default_value: 0
    _custom_default_value: 20
    is_flag: true
    flag: g
  vel:
    name: velocity
    abbr: vel
    type: Numerical
    min: 0
    max: 200
    default_value: 100
  skpt:
    name: skip test
    abbr: skpt
    type: Numerical
    min: 0
    max: 100
    default_value: 5
    skip_output_if_default: true
exp_selectors: [dyn, pitd, clr, eng, vel, vol, atk, dec, gen, bre]
exp_primary: 0
exp_secondary: 1
expression_graphs:
- id: my_graph
  nodes: []
default_expression_graphs:
  VNEUTRON: my_graph
key: 3
time_signatures:
- bar_position: 0
  beat_per_bar: 4
  beat_unit: 4
- bar_position: 8
  beat_per_bar: 3
  beat_unit: 4
tempos:
- position: 0
  bpm: 120
- position: 1920
  bpm: 90.5
tracks:
- singer: singer1
  phonemizer: OPENUTAU.DEFAULTPHONEMIZER
  renderer_settings:
    renderer: VNEUTRON
    resampler: ""
    wavtool: ""
  track_name: Vocal 1
  track_color: Blue
  mute: false
  solo: true
  volume: -3.5
  pan: 0.25
  track_expressions:
  - name: gender
    abbr: gen
    type: Numerical
    min: -100
    max: 100
    default_value: -10
  expression_graph: my_graph
  voice_color_names:
  - main
  - whisper
  mix_fx:
    enabled: true
    eq_enabled: false
    comp_enabled: true
    reverb_enabled: true
    eq_preset: flat
    comp_preset: punchy
    reverb_preset: hall
    eq_low_db: -2.5
    eq_mid_freq: 2500
    eq_mid_db: 2
    eq_high_db: 1
    comp_threshold_db: -20
    comp_ratio: 3
    comp_makeup_db: 4
    reverb_size: 0.5
    reverb_damp: 0.6
    reverb_wet: 0.8
    reverb_pre_delay_ms: 12
- singer: ""
  phonemizer: ""
  track_name: Inst
voice_parts:
- name: Part A
  comment: 主歌
  track_no: 0
  position: 480
  duration: 0
  notes:
  - position: 0
    duration: 240
    tone: 60
    lyric: "a"
    phonemizer: OPENUTAU.DEFAULTPHONEMIZER
    pitch:
      data:
      - x: -40
        y: 0
        shape: io
      - x: 0
        y: 5
        shape: l
      - x: 40
        y: 0
        shape: i
      - x: 80
        y: 3
        shape: o
      - x: 120
        y: -2
        shape: sp
      snap_first: false
    vibrato:
      length: 50
      period: 200
      depth: 60
      in: 20
      out: 30
      shift: 10
      drift: -5
      vol_link: -20
    tuning: 35
    phoneme_expressions:
    - index: 0
      abbr: vel
      value: 120
    - index: 1
      abbr: clr
      value: 1
    phoneme_overrides:
    - index: 0
      phoneme: "a2"
      offset: -20
      preutter_delta: 1.5
      overlap_delta: -0.5
      attack_time_delta: 10
      release_time_delta: -5
  - position: 240
    duration: 480
    tone: 62
    lyric: "[C4] ka"
    phoneme_expressions:
    - index: 0
      abbr: gen
      value: 42
  curves:
  - xs: [0, 480, 960]
    ys: [0, 60, 0]
    abbr: dyn
  - xs: [0, 240]
    ys: [10, -10]
    abbr: pitd
  - xs: [0, 5]
    ys: [1, 2]
    abbr: nonexistent_exp
  masked_curves:
  - abbr: rpit
    runs:
    - x: 0
      ys: [3000, 3005, 3010]
wave_parts:
- name: bgm.wav
  comment: 伴奏
  track_no: 1
  position: 0
  relative_path: bgm.wav
  file_duration_ms: 12345.5
  skip: 100
  trim: 50
  fadein: 20
  fadeout: 30
"""


def load_full():
    """落盘（带 BOM，模拟 OpenUTAU 的 UTF-8 写出）并走完整 load 链。"""
    with tempfile.NamedTemporaryFile('w', suffix='.ustx', delete=False,
                                     encoding='utf-8-sig', newline='') as f:
        f.write(FULL_USTX)
        path = f.name
    try:
        return load(path)
    finally:
        os.unlink(path)


def test_full_load():
    print('-- 全参数加载 --')
    p = load_full()

    # ---- 工程级
    check('工程名/注释/输出目录', (p.name, p.comment, p.output_dir, p.cache_dir)
          == ('Compat Test', '覆盖全部参数', 'Out', 'Cache'))
    check('key', p.key == 3, p.key)
    check('exp_selectors', p.exp_selectors == list(Ustx.ALL_DEFAULT_SELECTORS)
          if hasattr(Ustx, 'ALL_DEFAULT_SELECTORS') else
          p.exp_selectors == ['dyn', 'pitd', 'clr', 'eng', 'vel', 'vol', 'atk',
                              'dec', 'gen', 'bre'], p.exp_selectors)
    check('exp_primary/secondary', (p.exp_primary, p.exp_secondary) == (0, 1))
    check('expression_graphs 透传保留', p.expression_graphs == [{'id': 'my_graph', 'nodes': []}],
          p.expression_graphs)
    check('default_expression_graphs',
          p.default_expression_graphs == {'VNEUTRON': 'my_graph'},
          p.default_expression_graphs)
    check('多 tempo', [(t.position, t.bpm) for t in p.tempos] == [(0, 120), (1920, 90.5)],
          p.tempos)
    check('多拍号', [(t.bar_position, t.beat_per_bar, t.beat_unit)
                     for t in p.time_signatures] == [(0, 4, 4), (8, 3, 4)],
          p.time_signatures)
    check('加载后版本号盖为当前版本', p.ustx_version == '0.10', p.ustx_version)

    # ---- 表达式描述符（全部字段）
    gen = p.expressions.get('gen')
    check('gen._custom_default_value 读取（前导下划线键）',
          gen is not None and gen._custom_default_value == 20,
          gen._custom_default_value if gen else None)
    check('gen.custom_default_value 计算', gen.custom_default_value == 20)
    check('gen.is_flag/flag', (gen.is_flag, gen.flag) == (True, 'g'))
    skpt = p.expressions.get('skpt')
    check('skip_output_if_default 读取',
          skpt is not None and skpt.skip_output_if_default is True)
    clr = p.expressions.get('clr')
    check('clr options 列表', clr.options == ['main', 'whisper', 'airy'], clr.options)
    check('clr type=Options', clr.type == 'Options')

    # ---- 轨道级
    t0 = p.tracks[0]
    check('singer/phonemizer', (t0.singer, t0.phonemizer)
          == ('singer1', 'OPENUTAU.DEFAULTPHONEMIZER'))
    rs = t0.renderer_settings
    check('renderer_settings 嵌套', (rs.renderer, rs.resampler, rs.wavtool)
          == ('VNEUTRON', '', ''), (rs.renderer, rs.resampler, rs.wavtool))
    check('track_name/color/solo', (t0.track_name, t0.track_color, t0.solo, t0.mute)
          == ('Vocal 1', 'Blue', True, False))
    check('volume/pan', (t0.volume, t0.pan) == (-3.5, 0.25))
    check('expression_graph', t0.expression_graph == 'my_graph')
    check('voice_color_names', t0.voice_color_names == ['main', 'whisper'])
    check('track_expressions（轨道级覆盖）',
          len(t0.track_expressions) == 1
          and t0.track_expressions[0].default_value == -10
          and t0.track_expressions[0].abbr == 'gen')
    fx = t0.mix_fx
    check('mix_fx 全部 18 字段',
          fx is not None and [
              fx.enabled, fx.eq_enabled, fx.comp_enabled, fx.reverb_enabled,
              fx.eq_preset, fx.comp_preset, fx.reverb_preset,
              fx.eq_low_db, fx.eq_mid_freq, fx.eq_mid_db, fx.eq_high_db,
              fx.comp_threshold_db, fx.comp_ratio, fx.comp_makeup_db,
              fx.reverb_size, fx.reverb_damp, fx.reverb_wet,
              fx.reverb_pre_delay_ms,
          ] == [True, False, True, True,
                'flat', 'punchy', 'hall',
                -2.5, 2500, 2, 1,
                -20, 3, 4,
                0.5, 0.6, 0.8, 12],
          fx)
    t1 = p.tracks[1]
    check('第二轨 mix_fx 缺省为 None', t1.mix_fx is None)
    check('★ 轨道不再多写 language 键（上游无此字段）',
          'language' not in dumps(p).split('notes:')[0] or
          'language:' not in dumps(p), '')

    # ---- 音符级
    part = p.parts[0]
    check('parts 合并：voice+wave', isinstance(part, UVoicePart)
          and isinstance(p.parts[1], UWavePart), [type(x).__name__ for x in p.parts])
    check('part name/comment/position', (part.name, part.comment, part.position)
          == ('Part A', '主歌', 480))
    n0 = part.notes[0]
    check('★ 音符级 phonemizer 覆写（别名键 phonemizer:）',
          n0.phonemizer_override == 'OPENUTAU.DEFAULTPHONEMIZER',
          n0.phonemizer_override)
    check('note tuning/adjusted_tone', n0.tuning == 35
          and abs(n0.adjusted_tone - 60.35) < 1e-9, n0.adjusted_tone)
    shapes = [pt.shape for pt in n0.pitch.data]
    check('pitch 5 种 shape 全读', shapes == ['io', 'l', 'i', 'o', 'sp'], shapes)
    check('pitch snap_first=false', n0.pitch.snap_first is False)
    v = n0.vibrato
    check('vibrato 全部 8 字段（in/out 关键字键）',
          (v.length, v.period, v.depth, v.vib_in, v.vib_out,
           v.shift, v.drift, v.vol_link)
          == (50, 200, 60, 20, 30, 10, -5, -20), v)
    exps = {(e.index, e.abbr): e.value for e in n0.phoneme_expressions}
    check('phoneme_expressions 读值', exps.get((0, 'vel')) == 120
          and exps.get((1, 'clr')) == 1, exps)
    check('★ 表达式 descriptor 已绑定（AfterLoad）',
          all(e.descriptor is not None for e in n0.phoneme_expressions),
          [(e.abbr, e.descriptor) for e in n0.phoneme_expressions])
    check('vel 夹紧后读取正确', n0.phoneme_expressions[0].value == 120)
    o = n0.phoneme_overrides[0]
    check('phoneme_override 全部 7 字段',
          (o.index, o.phoneme, o.offset, o.preutter_delta, o.overlap_delta,
           o.attack_time_delta, o.release_time_delta)
          == (0, 'a2', -20, 1.5, -0.5, 10, -5), o)
    n1 = part.notes[1]
    check('phonetic hint 歌词原样保留（清洗只发生在音素化时）',
          n1.lyric == '[C4] ka', n1.lyric)
    check('gen 表达式轨道级默认 -10 可达（try_get_exp_descriptor 顺序）',
          p.tracks[0].try_get_exp_descriptor(p, 'gen').default_value == -10)
    check('gen 表达式值读取（音轨覆盖值 42）',
          any(e.value == 42 for e in n1.phoneme_expressions),
          [(e.abbr, e.value) for e in n1.phoneme_expressions])

    # ---- 曲线 / masked 曲线
    abbrs = [c.abbr for c in part.curves]
    check('★ 未知表达式的曲线被剔除（AfterLoad）', 'nonexistent_exp' not in abbrs, abbrs)
    dyn = next(c for c in part.curves if c.abbr == 'dyn')
    check('曲线 xs/ys 读取', (dyn.xs, dyn.ys) == ([0, 480, 960], [0, 60, 0]))
    check('★ 曲线 descriptor 已绑定（min=-240）',
          dyn.descriptor is not None and dyn.descriptor.min == -240,
          dyn.descriptor)
    mc = part.masked_curves[0]
    check('masked curve runs 读取',
          mc.abbr == 'rpit' and len(mc.runs) == 1
          and mc.runs[0].x == 0 and mc.runs[0].ys == [3000, 3005, 3010],
          (mc.abbr, mc.runs))
    ok, val = mc.try_sample(2.5)
    check('masked curve 采样', ok and abs(val - 3002.5) < 1e-6, (ok, val))

    # ---- Duration 圆整修正（AfterLoad）
    # part.position=480，末音符 end=720 → 绝对 1200 → 圆整到 (bar2,beat2)=1440
    # → min_dur = 960 → duration = max(0, 960)
    check('★ part Duration 圆整修正', part.duration == 960, part.duration)

    # ---- wave part
    wp = p.parts[1]
    check('wave part 全部 6 字段',
          (wp.name, wp.track_no, wp.position, wp.relative_path,
           wp.file_duration_ms, wp.skip, wp.trim, wp.fadein, wp.fadeout)
          == ('bgm.wav', 1, 0, 'bgm.wav', 12345.5, 100, 50, 20, 30), wp)


def test_roundtrip_keys():
    print('-- 往返键名 --')
    p = loads(FULL_USTX)
    text = dumps(p)
    check('写出用 phonemizer: 键', 'phonemizer: OPENUTAU.DEFAULTPHONEMIZER' in text)
    check('写出不再有 phonemizer_override:', 'phonemizer_override' not in text)
    check('写出不再有 language: 键', 'language:' not in text)
    check('写出保留 vibrato in/out 键',
          'in: 20' in text and 'out: 30' in text)
    check('写出保留 _custom_default_value 键', '_custom_default_value: 20' in text)
    check('写出保留 ustx_version 字符串',
          "ustx_version: '0.6'" in text or 'ustx_version: "0.6"' in text,
          text[:80])
    p2 = loads(text)
    check('往返后音符 phonemizer 覆写不丢',
          p2.parts[0].notes[0].phonemizer_override == 'OPENUTAU.DEFAULTPHONEMIZER')
    check('往返后曲线集一致',
          [c.abbr for c in p2.parts[0].curves] == [c.abbr for c in p.parts[0].curves])


def test_legacy_and_tolerance():
    print('-- 容错与旧键兼容 --')
    # 旧版仓库误写的 phonemizer_override: 键 + 未来版本的未知键 + BOM
    legacy = FULL_USTX.replace('phonemizer: OPENUTAU.DEFAULTPHONEMIZER\n    pitch:',
                               'phonemizer_override: OLD.WRITER\n    pitch:',
                               1)
    legacy = 'unknown_future_key: whatever\n' + legacy
    p = loads(legacy)
    check('旧键 phonemizer_override 兜底读取',
          p.parts[0].notes[0].phonemizer_override == 'OLD.WRITER',
          p.parts[0].notes[0].phonemizer_override)
    check('未知键忽略不报错', p.name == 'Compat Test')

    # 无 BOM / CRLF
    with tempfile.NamedTemporaryFile('w', suffix='.ustx', delete=False,
                                     encoding='utf-8', newline='\r\n') as f:
        f.write(FULL_USTX)
        path = f.name
    try:
        from singing.ustx.io import load_ustx
        p2 = load_ustx(path)
        check('CRLF/无 BOM 文件正常加载', p2.parts[0].notes[0].lyric == 'a')
    finally:
        os.unlink(path)


def test_v03_migration():
    print('-- v0.3 迁移 --')
    old = """\
name: Old
comment: ""
output_dir: Vocal
cache_dir: UCache
ustx_version: "0.3"
bpm: 95.5
beat_per_bar: 3
beat_unit: 4
expressions:
  acc:
    name: accent
    abbr: acc
    type: Numerical
    min: 0
    max: 200
    default_value: 100
  vel:
    name: velocity
    abbr: vel
    type: Numerical
    min: 0
    max: 200
    default_value: 100
exp_selectors: [dyn, pitd, clr, eng, vel, vol, atk, dec, gen, bre]
exp_primary: 0
exp_secondary: 1
key: 0
time_signatures:
- bar_position: 0
  beat_per_bar: 3
  beat_unit: 4
tempos:
- position: 0
  bpm: 95.5
tracks:
- singer: ""
  phonemizer: ""
  track_name: Track1
voice_parts:
- name: Part
  comment: ""
  track_no: 0
  position: 0
  duration: 1920
  notes:
  - position: 0
    duration: 240
    tone: 60
    lyric: "...la"
    phoneme_expressions:
    - index: 0
      abbr: acc
      value: 80
"""
    with tempfile.NamedTemporaryFile('w', suffix='.ustx', delete=False,
                                     encoding='utf-8', newline='') as f:
        f.write(old)
        path = f.name
    try:
        p = load(path)
    finally:
        os.unlink(path)
    check('acc → attack 描述符迁移', 'acc' not in p.expressions
          and 'atk' in p.expressions and p.expressions['atk'].name == 'attack',
          sorted(p.expressions))
    check('音符表达式 acc → atk 迁移',
          p.parts[0].notes[0].phoneme_expressions[0].abbr == 'atk',
          [(e.abbr, e.value) for e in p.parts[0].notes[0].phoneme_expressions])
    check('歌词 ... → + 迁移', p.parts[0].notes[0].lyric == '+la',
          p.parts[0].notes[0].lyric)
    check('v0.3 bpm → tempos 迁移', p.tempos[0].bpm == 95.5, p.tempos)
    check('v0.3 beatPerBar → time_signatures 迁移',
          p.time_signatures[0].beat_per_bar == 3)
    check('v0.3 文件加载后版本号盖为 0.10', p.ustx_version == '0.10')


def test_newer_version_rejected():
    print('-- 未来版本拒绝 --')
    newer = FULL_USTX.replace('ustx_version: "0.6"', 'ustx_version: "99.0"')
    try:
        p = loads(newer)
        with tempfile.NamedTemporaryFile('w', suffix='.ustx', delete=False,
                                         encoding='utf-8', newline='') as f:
            f.write(newer)
            path = f.name
        try:
            load(path)
            check('未来版本被拒绝', False, '未抛 FileFormatError')
        except Exception as e:
            check('未来版本被拒绝', '更新' in str(e), e)
        finally:
            os.unlink(path)
    except Exception as e:
        check('未来版本被拒绝', False, e)


def main():
    test_full_load()
    test_roundtrip_keys()
    test_legacy_and_tolerance()
    test_v03_migration()
    test_newer_version_rejected()
    print('\n结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
    return 1 if _FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
