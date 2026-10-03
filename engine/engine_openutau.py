# -*- coding: utf-8 -*-
"""UTAU 渲染引擎（**OpenUTAU 搬运版**）—— 应用侧入口。

`engine_utau.py` 是本项目早期自己写的实现；本脚本把 `engine/singing/` 下那套
**照搬自 OpenUTAU 的核心**（`ClassicSinger` → `RenderPhrase` → `ClassicRenderer`
→ `Worldline` 变调 → `SharpWavtool` 拼接）包成与 `engine_utau.py` **同样的命令行契约**，
于是 `main/utau.js` 只要换一个 `script:` 就能切过来。

## 命令行契约（与 `engine_utau.py render-track` 保持一致，便于主进程无感切换）

    python engine_openutau.py render-track \
        --voicebank <声库目录> \
        --notes @<notes.json> | '<json>' \
        --sample-note C4 \
        --out out.wav \
        [--phonemizer auto|none|<tag>] [--tpb 480] [--bpm 120]

    python engine_openutau.py probe --voicebank <声库目录>     # 只看声库能否加载

stdout 只打印 `###RESULT {json}`；进度 `###PROG {json}`；警告/提示走 stderr
（与 `music2midi.py` / `engine_utau.py` 一致）。

## 这条链路真的能出声吗
`engine/tests/test_openutau_core_matches_source.py` 里的
`test_tools_manager_real_host_end_to_end` 已经证明：**只配好宿主路径、不装任何替身**，
`ClassicRenderer` 能回落出真的 `WorldlineResampler` + `SharpWavtool` 并渲染出
主频正确的样本（源 300Hz → 输出 440Hz）。本脚本就是把那条链路接上真实声库与真实音符。

## ★ 与上游的差别（都记在案，不是"顺手优化"）
1. **多乐句拼接**：C# 交给 `RenderEngine` + `MixPlanner`（那部分属 M3，未搬）。
   这里按 C# `RenderEngine` 里那句 `phraseOffsetMs = layout.positionMs - layout.leadingMs`
   摆位，重叠区取 **max**（而非相加）—— UTAU 的乐句基本首尾相接、不重叠，
   取 max 可以避免叠加导致的削波。**这是本脚本唯一一处自研的算法，已明确标注。**
2. **音素化**：默认 `--phonemizer auto`。auto 的判据是"声库能不能用音素化器"；
   一律失败时回落到 **把歌词当别名直接查 oto**（这与旧引擎的行为一致，
   所以任何 UTAU 声库都能出声）。指定 `none` 就是强制走别名直查。
3. `worldline.dll` 由 `singing.openutau.native_lib` 解析（随引擎包分发 6 个平台）。
"""

import argparse
import json
import math
import os
import re
import sys
import traceback

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

# ★ 必须在 sys.path 调整**之后**导入：包 `singing` 就在本目录下
from singing.openutau.phonemizer import Phoneme, Phonemizer, Result  # noqa: E402

VERSION = 'openutau-port/0.2.0'
SR = 44100


def emit_result(obj):
    sys.stdout.write('###RESULT ' + json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def emit_progress(percent, text=''):
    sys.stdout.write('###PROG ' + json.dumps({'percent': int(percent), 'text': text},
                                            ensure_ascii=False) + '\n')
    sys.stdout.flush()


def warn(msg):
    sys.stderr.write('[engine_openutau] ' + str(msg) + '\n')
    sys.stderr.flush()


# ---------------------------------------------------------------- 宿主（PathManager / ToolsManager / VoicebankFiles 的替身）

def setup_host(cache_dir, root_dir=None):
    """把 `ClassicHost` 的路径字段填好（对应 C# `PathManager.Inst` 的表达式属性）。

    不填的话 `ToolsManager.SearchResamplers` 会走进上游"扫描失败即清空整张表"的分支
    （见 `tools_manager.py` 的 docstring），后面连内置的 `worldline` 都取不到。

    """
    from singing.openutau.classic import resampler_item
    host = resampler_item.host
    host.root_path = root_dir or _HERE
    host.data_path = cache_dir
    host.cache_path = cache_dir
    try:
        os.makedirs(cache_dir, exist_ok=True)
    except OSError as e:
        warn('创建缓存目录失败：%s' % e)
    return host


def setup_phonemizers():
    """把**已导入**的音素化器登记进 `PhonemizerFactory` 并排好序。

    ★ C# 靠 `AppDomain` 扫描已加载的程序集自动发现；Python 没有运行时反射扫模块，
      所以改成**显式导入** `plugin_builtin`（它 import 全部内置音素化器，
      `@register` 装饰器在此过程中填 `_REGISTRY`），再逐个喂给 `PhonemizerFactory.get()`
      建工厂条目，最后 `build_list()` 按 tag 排序。
      —— 载体不同，行为等价：宿主能按 tag / 类型全名两种方式找到音素化器。
    """
    try:
        from singing.openutau import plugin_builtin            # noqa: F401  仅为触发注册
        from singing.openutau.api import PhonemizerFactory
        from singing.openutau.phonemizer import registered
        for cls in registered().values():
            PhonemizerFactory.get(cls)
        PhonemizerFactory.build_list()
        return len(PhonemizerFactory.get_all())
    except Exception as e:                                    # noqa: BLE001
        warn('音素化器注册表构建失败（不影响按 tag 的既有路径）：%s' % e)
        return 0


def setup_g2p():
    """装上 G2p 的 ONNX 会话工厂（**进程级**，所以每个子命令都调）。

    `g2p/pack.py` 的 `predict` 需要它才能对**未登录词**做神经网络预测；
    **不装也能跑**（`session is None` → 退化成纯词典查找），只是多音字消歧会弱。

    ★ 为什么不放在 `setup_host` 里：那个函数只在 `render-track` 路径上被调用
      （`cmd_probe` 不走它），而会话工厂是**全局**的 —— 装在 `main()` 里
      才能让 `probe` 也具备（将来做"声库/音素化能力自检"时会用到）。

    ★ 失败只 warn 不抛：引擎的其余部分与 onnxruntime 无关，不该因为它整个挂掉。
    """
    try:
        from singing.openutau.g2p import models as g2p_models
        if g2p_models.install_onnx_session_factory():
            warn('G2p 神经网络已启用（onnxruntime 会话工厂就绪）')
        else:
            warn('未启用 G2p 神经网络（缺 onnxruntime），未登录词将退化为纯词典查找')
        return True
    except Exception as e:                               # noqa: BLE001
        warn('G2p 神经网络初始化失败（不影响其余功能）：%s' % e)
        return False


# ---------------------------------------------------------------- 声库 → 歌手

def load_singer(vb_dir):
    """从目录加载 UTAU 声库并返回 `ClassicSinger`。

    优先走**照搬的** `VoicebankLoader`（有 `character.txt` 时它会连 character.yaml /
    subbank / prefix.map 一起读）；没有 `character.txt` 的裸 oto.ini 声库也支持
    （只装 oto，元信息留空）—— 旧引擎本来就能渲染这种声库，不能因为换引擎就退化成不能出声。
    """
    from singing.openutau.classic import VoicebankLoader, adjust_singer_type
    from singing.openutau.oto import Voicebank

    vb_dir = os.path.abspath(vb_dir)
    if not os.path.isdir(vb_dir):
        raise ValueError('声库目录不存在：%s' % vb_dir)

    char_txt = os.path.join(vb_dir, 'character.txt')
    bank = Voicebank()
    bank.base_path = vb_dir
    if os.path.isfile(char_txt):
        bank.file = char_txt
        VoicebankLoader.load_info(bank, char_txt, vb_dir)
        VoicebankLoader.load_subbanks(bank)
        VoicebankLoader.load_oto_sets(bank, vb_dir)
    else:
        bank.file = ''
        VoicebankLoader.load_oto_sets(bank, vb_dir)
    singer = adjust_singer_type(bank)
    if singer is None:
        raise ValueError('声库无法识别歌手类型：%s' % vb_dir)
    # ClassicSinger 默认未加载（上游把加载交给宿主），这里补上这一下
    if not getattr(singer, 'loaded', False):
        singer.found = True
        singer.reload()
    if not getattr(singer, 'loaded', False):
        raise ValueError('声库加载失败（oto 表为空？）：%s' % vb_dir)
    return singer


# ---------------------------------------------------------------- 工程

#: UTAU 渲染必需的表达式表（对齐 `engine_utau.py` 与 OpenUTAU 的 `Ustx.AddDefaultExpressions`）
_EXPRESSION_SPECS = (
    # name, abbr, type, min, max, default, flag, options
    ('volume', 'vol', 'NUMERICAL', 0, 100, 100, None, None),
    ('velocity', 'vel', 'NUMERICAL', 0, 100, 100, 'V', None),
    ('shift', 'shft', 'NUMERICAL', 0, 100, 0, None, None),
    ('color', 'clr', 'OPTIONS', 0, 100, 0, None, ['']),
    ('dynamics', 'dyn', 'CURVE', -240, 120, 0, None, None),
    ('attack', 'atk', 'NUMERICAL', 0, 100, 100, None, None),
    ('decay', 'dec', 'NUMERICAL', 0, 100, 100, None, None),
)


def build_project(bpm=120.0):
    """造一个带标准表达式表与时间轴的空工程（对应 C# `Ustx.Create()` 去掉版本相关部分）。"""
    from singing.ustx import UExpressionDescriptor, UExpressionType, UProject

    project = UProject()
    for name, abbr, typ, mn, mx, dv, flag, options in _EXPRESSION_SPECS:
        t = getattr(UExpressionType, typ)
        project.expressions[abbr] = UExpressionDescriptor(
            name=name, abbr=abbr, type=t, min=mn, max=mx, default_value=dv,
            flag=flag or '', options=options,
            is_flag=bool(flag) or t == UExpressionType.OPTIONS)
    if bpm:
        try:
            project.tempos[0].bpm = float(bpm)
        except Exception:                                   # noqa: BLE001
            pass
    project.time_axis.build_segments(project)
    return project


def _num(d, *keys, default=0.0):
    for k in keys:
        if k in d and d[k] is not None:
            try:
                return float(d[k])
            except (TypeError, ValueError):
                continue
    return default


#: 音名 → 音级（`C4` → 60）
_NAME_TO_PC = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def note_name_to_midi(name, default=60):
    """`"C4"` → 60，`"A#3"` → 58。解析不了就给 `default`（不抛，与旧引擎一致）。"""
    s = str(name or '').strip()
    m = re.match(r'^([A-Ga-g])([#b]*)(-?\d+)$', s)
    if not m:
        return default
    pc = _NAME_TO_PC[m.group(1).upper()]
    for ch in m.group(2):
        pc += 1 if ch == '#' else -1
    return 12 * (int(m.group(3)) + 1) + pc


def build_part(project, track, notes, tpb=480):
    """把应用侧的音符 JSON 变成一个 `UVoicePart`。

    **同时吃两套字段名**，以便和旧引擎 / 一致性测试互通：

    | 语义 | 应用侧（`UtauRender.renderPayload`） | 测试/通用侧 |
    |---|---|---|
    | 音高 | `note: "C4"`（音名），或 `pitch` / `tone`（MIDI 数字） | 同左 |
    | 时长 | `length_ms`（毫秒，**无起点** → 顺序累加） | `durBeat` / `dur`（拍） |
    | 起点 | 无（累加）/ `start`（毫秒）/ `startBeat`（拍） | 同左 |
    | 音高曲线 | `pitch_curve: [{pos: 0..1, cents}]` | `pitchData: [{x,y}]` |
    | 音高偏差 | `pitch_cents`（音分） | 同左 |
    | 颤音 | `vibrato: {depth_cent, freq_hz, delay_ms, fade_ms}` | `vibrato` + `vibDepth`… |

    ★ UTAU 的 `flags`（`g`/`B`/`b`/`p`…）是**旧引擎自己的旋钮**，OpenUTAU 走的是
      表达式体系；这里**不解析** flags（照搬渲染链路，不做语义映射），需要时走音素化器
      或音高曲线表达。
    """
    from singing.ustx import (PitchPoint, UCurve, UNote, UPitch, UVibrato, UVoicePart)

    axis = project.time_axis
    part = UVoicePart(track_no=0, position=0)
    dyn_desc = project.expressions.get('dyn')
    if dyn_desc is not None:
        part.curves.append(UCurve(xs=[0], ys=[0], abbr='dyn', descriptor=dyn_desc))

    out = []
    cursor_ms = 0.0
    for n in notes or []:
        if not isinstance(n, dict):
            continue

        # ---- 音高
        if n.get('note'):
            tone = note_name_to_midi(n.get('note'))
        else:
            tone = int(_num(n, 'pitch', 'tone', default=60.0))

        # ---- 时长 / 起点（ms 为准，其次拍）
        dur_ms = _num(n, 'length_ms', 'lengthMs', 'durationMs', default=-1.0)
        if dur_ms > 0:
            duration = int(round(axis.ms_pos_to_tick_pos(dur_ms)))
        else:
            duration = int(round(_num(n, 'durBeat', 'dur', 'duration', default=1.0) * tpb))
        if duration <= 0:
            continue

        if 'start' in n or 'startMs' in n:
            pos_ms = _num(n, 'start', 'startMs', default=cursor_ms)
        elif 'startBeat' in n:
            pos_ms = _num(n, 'startBeat', default=0.0) * (60000.0 / max(1.0, project.tempos[0].bpm))
        else:
            pos_ms = cursor_ms
        position = int(round(axis.ms_pos_to_tick_pos(pos_ms)))
        cursor_ms = axis.tick_pos_to_ms_pos(position + duration)

        # ---- 音高曲线：两种来源合并（cents 偏移 + 曲线点）
        pts = []
        raw = n.get('pitchData')
        if not isinstance(raw, list):
            raw = n.get('pitchPoints') if isinstance(n.get('pitchPoints'), list) else []
        for p in raw or []:
            if isinstance(p, dict):
                pts.append((int(_num(p, 'x', default=0.0)), int(_num(p, 'y', default=0.0))))
            elif isinstance(p, (list, tuple)) and len(p) >= 2:
                pts.append((int(p[0]), int(p[1])))
        if not pts:
            for i, p in enumerate(n.get('pitch_curve') or []):
                if isinstance(p, dict):
                    pos = int(round(_num(p, 'pos', default=0.0) * duration))
                    pts.append((pos, int(_num(p, 'cents', default=0.0))))
        cents = _num(n, 'pitch_cents', 'pitchCents', default=0.0)
        if cents and pts:
            pts = [(x, y + int(round(cents))) for x, y in pts]
        elif cents:
            pts = [(0, int(round(cents)))]
        if not pts:
            pts = [(0, 0)]
        pts.sort()

        # ---- 颤音
        try:
            vib = UVibrato(length=0, length_in=0, length_out=0, shift=0.0, drift=0.0)
            v = n.get('vibrato')
            if isinstance(v, dict) and (_num(v, 'depth_cent', 'depthCent', default=0.0) or 0):
                vib = UVibrato(length=1, length_in=0, length_out=0,
                               shift=_num(v, 'depth_cent', 'depthCent', default=40.0),
                               drift=_num(v, 'freq_hz', 'freqHz', default=5.5) * 0.0)
            elif n.get('vibrato'):
                vib = UVibrato(length=1, length_in=0, length_out=0,
                               shift=_num(n, 'vibDepth', 'vibShift', default=40.0), drift=0.0)
        except Exception:                                   # noqa: BLE001
            vib = UVibrato()

        out.append(UNote(position=position, duration=duration, tone=tone,
                         lyric=str(n.get('lyric') or ''),
                         pitch=UPitch(data=[PitchPoint(x=x, y=y) for x, y in pts]),
                         vibrato=vib))
    part.notes.extend(out)
    return part


# ---------------------------------------------------------------- 音素化

def pick_phonemizer(singer, name):
    """按名字/自动挑一个音素化器；挑不到或明确要 `none` 就返回 `None`（走别名直查）。"""
    if name == 'none':
        return None
    if name and name != 'auto':
        # ★ 先按**类型全名**找：上游 `default_phonemizer` 存的是
        #   `PhonemizerFactory.type.FullName`（见 `PhonemizerTypeValues`），
        #   真实 .ustx 里就是这种值 —— 只按 tag 查会查不到。
        from singing.openutau.api import PhonemizerFactory
        _fac = PhonemizerFactory.get_by_type_name(name)
        if _fac is not None:
            return _fac.create()
        from singing.openutau.phonemizer import registered
        cls = registered().get(name)
        if cls is None:
            # 也接受小写 tag（如 'ja vcv'）
            for k, v in registered().items():
                if k.lower() == name.lower():
                    cls = v
                    break
        if cls is None:
            raise ValueError('没有这个音素化器：%s' % name)
        return cls()
    # auto：优先声库声明的 default_phonemizer，其次按歌手类型猜
    candidates = []
    try:
        dp = singer.default_phonemizer
        if dp:
            candidates.append(str(dp))
    except Exception:                                       # noqa: BLE001
        pass
    from singing.openutau.phonemizer import registered
    reg = registered()
    stype = ''
    try:
        stype = str(singer.singer_type)
    except Exception:                                       # noqa: BLE001
        pass
    if stype in ('CV', 'VCV'):
        candidates += ['JA VCV', 'ZH VCV', 'ZH CVVC']
    elif stype in ('CVC', 'CVVC'):
        candidates += ['ZH CVVC', 'JA CVVC', 'JA VCV', 'ZH VCV']
    from singing.openutau.api import PhonemizerFactory
    for c in candidates:
        # ★ 候选可能是 tag（'ZH CVVC'），也可能是类型全名（声库 default_phonemizer）
        _fac = PhonemizerFactory.get_by_type_name(c)
        if _fac is not None:
            return _fac.create()
        cls = reg.get(c)
        if cls is not None:
            return cls()
    return None


class _AliasDirectPhonemizer(Phonemizer):
    """「歌词即别名」的音素化器：一个音符 → 一个音素，音素名就是歌词。

    UTAU 声库最常见的用法就是 `oto.ini` 里的别名直接等于歌词，所以**即使一个语言
    音素化器都没有，本引擎也能出声**（与旧 `engine_utau.py` 的行为一致）。
    走 `validate_part_phonemes` 这条已验证的编排，prev/next 链与索引回填都交给它。
    """

    name = 'Alias (direct)'
    tag = 'ALIAS'
    language = ''

    def set_singer(self, singer) -> None:
        self.singer = singer

    def process(self, notes, prev=None, next_=None, prev_neighbour=None,
                next_neighbour=None, prevs=None) -> 'Result':
        return Result(phonemes=[Phoneme(index=0, phoneme=str(n.lyric or '')) for n in notes])


def run_phonemizer(project, track, part, singer, name):
    """对 part 跑音素化（`UPart` 的音素化段，对应 `part_validate.validate_part_phonemes`）。

    音素化器不可用时**回落到别名直查**而不是报错 —— 否则老声库会直接不能出声。
    """
    warns = []
    if name == 'none':
        ph = _AliasDirectPhonemizer()
    else:
        ph = pick_phonemizer(singer, name)
        if ph is None:
            ph = _AliasDirectPhonemizer()
            warns.append('没有可用的语言音素化器，按别名直查 oto（歌词需与 oto.ini 别名逐字一致）')
    try:
        ph.set_singer(singer)
        from singing.openutau import ValidateOptions
        from singing.openutau.part_validate import validate_part_phonemes
        validate_part_phonemes(ValidateOptions(), project, track, part, ph, timestamp=1)
        tag = getattr(ph, 'tag', '') or '?'
        return tag, len(part.phonemes), warns
    except Exception as e:                                  # noqa: BLE001
        warn('音素化失败，回落到别名直查：%s' % e)
        return 'none', 0, warns + ['音素化失败（%s）' % str(e)[:160]]


# ---------------------------------------------------------------- 渲染

def _assemble(results, phrases):
    """把各乐句的样本按时间轴摆成一条单声道轨。

    ★ **本脚本唯一一处自研算法**（上游是 `RenderEngine` + `MixPlanner`，属 M3 未搬）：
    摆位照搬 C# 的 `phraseOffsetMs = layout.positionMs - layout.leadingMs`；
    重叠区取 **max** 而不是相加 —— UTAU 乐句基本首尾相接，取 max 可避免叠加削波。
    """
    total = 0
    spans = []
    for phrase, res in zip(phrases, results):
        samples = getattr(res, 'samples', None)
        if not samples:
            continue
        offset_ms = phrase.position_ms - (getattr(res, 'leading_ms', 0.0) or 0.0)
        start = int(round(offset_ms / 1000.0 * SR))
        if start < 0:
            start = 0
        spans.append((start, samples))
        total = max(total, start + len(samples))
    buf = [0.0] * max(0, total)
    for start, samples in spans:
        for i, v in enumerate(samples):
            j = start + i
            if j >= len(buf):
                break
            if v > buf[j]:
                buf[j] = v
    return buf


def render_track(vb_dir, notes, out_path, sample_note='C4', phonemizer='auto',
                 tpb=480, bpm=120.0, cache_dir=None):
    """渲染整条音轨到 `out_path`（WAV）。返回结果 dict。"""
    import asyncio

    from singing.openutau import Progress
    from singing.openutau.classic import ClassicRenderer
    from singing.openutau.render_phrase import RenderPhrase
    from singing.openutau.wave import Wave

    cache_dir = cache_dir or os.path.join(os.path.dirname(os.path.abspath(out_path)), '_ou_cache')
    setup_host(cache_dir, _HERE)

    emit_progress(2, '加载声库…')
    singer = load_singer(vb_dir)

    project = build_project(bpm)
    track = project.tracks[0]
    track.renderer_settings.renderer = 'CLASSIC'
    track.renderer_settings.renderer_obj = ClassicRenderer()
    track.renderer_settings.resampler = 'worldline'
    track.renderer_settings.wavtool = 'convergence'
    track.singer_obj = singer

    part = build_part(project, track, notes, tpb)
    if not part.notes:
        raise ValueError('没有可渲染的音符')
    project.parts.append(part)

    emit_progress(8, '音素化…')
    ph_tag, ph_count, warns = run_phonemizer(project, track, part, singer, phonemizer)
    if not ph_count:
        raise ValueError('音素化后没有任何音素（歌词是否为空？）')

    emit_progress(12, '构建乐句…')
    phrases = RenderPhrase.from_part(project, track, part)
    if not phrases:
        raise ValueError('没有可渲染的乐句（音素化后为空）')

    renderer = ClassicRenderer()
    results = []
    for i, phrase in enumerate(phrases):
        done = int((i / len(phrases)) * 84)
        emit_progress(12 + done, '渲染乐句 %d/%d' % (i + 1, len(phrases)))
        prog = Progress(len(phrase.phones))

        async def _go(p=phrase, pr=prog):
            return await renderer.render(p, pr, track_no=0)

        res = asyncio.new_event_loop().run_until_complete(_go())
        if res is None or not getattr(res, 'samples', None):
            warns.append('乐句 %d 没有产出样本（oto 未命中？）' % (i + 1))
            continue
        results.append(res)

    if not results:
        raise ValueError('全部乐句都没有产出样本；请检查声库 oto.ini 与歌词是否匹配')

    emit_progress(97, '拼接…')
    track_samples = _assemble(results, phrases)

    parent = os.path.dirname(os.path.abspath(out_path))
    if parent:
        os.makedirs(parent, exist_ok=True)
    Wave.write_mono16_wav(out_path, track_samples)

    dur_ms = int(round(len(track_samples) / SR * 1000))
    emit_progress(100, '完成')
    # 音素没命中但仍出了声 → 明确提示（这类问题以前最难查）
    if 'none' in ph_tag and len(warns) == 0:
        warns.append('按别名直查 oto：歌词需与 oto.ini 的别名逐字一致')
    return {
        'ok': True,
        'out': os.path.abspath(out_path),
        'duration_ms': dur_ms,
        'warnings': warns[:40],
        'engine_version': VERSION,
        'voicebank': os.path.abspath(vb_dir),
        'note_count': len(part.notes),
        'phrase_count': len(results),
        'phonemizer': ph_tag,
        'sample_rate': SR,
    }


# ---------------------------------------------------------------- CLI

def _load_notes(raw):
    """`--notes` 支持 `@文件`（主进程默认，走临时文件避开 Windows 32K 命令行上限）或 JSON 字面量。"""
    if not raw:
        return []
    if raw.startswith('@'):
        with open(raw[1:], 'r', encoding='utf-8') as f:
            data = json.load(f)
    else:
        data = json.loads(raw)
    if isinstance(data, dict):
        data = data.get('notes') or []
    return data if isinstance(data, list) else []


def cmd_render_track(args):
    try:
        notes = _load_notes(args.notes)
        if not notes:
            return {'ok': False, 'error': '没有音符'}
        res = render_track(args.voicebank, notes, args.out,
                           sample_note=args.sample_note or 'C4',
                           phonemizer=args.phonemizer or 'auto',
                           tpb=args.tpb, bpm=args.bpm)
        return res
    except Exception as e:                                  # noqa: BLE001
        warn(traceback.format_exc())
        return {'ok': False, 'error': str(e)}


def cmd_probe(args):
    try:
        singer = load_singer(args.voicebank)
        return {
            'ok': True,
            'engine_version': VERSION,
            'name': getattr(singer, 'name', ''),
            'singer_type': str(getattr(singer, 'singer_type', '')),
            'oto_count': len(getattr(singer, 'otos', []) or []),
            'subbank_count': len(getattr(singer, 'subbanks', []) or []),
        }
    except Exception as e:                                  # noqa: BLE001
        return {'ok': False, 'error': str(e)}


def main():
    parser = argparse.ArgumentParser(
        prog='engine_openutau.py',
        description='UTAU 渲染引擎（OpenUTAU 搬运版）')
    sub = parser.add_subparsers(dest='cmd', required=True)

    t = sub.add_parser('render-track', help='渲染多音节音轨为 WAV')
    t.add_argument('--voicebank', required=True, help='声库目录（含 oto.ini）')
    t.add_argument('--notes', required=True, help='音符 JSON，或 @文件路径')
    t.add_argument('--sample-note', default='C4')
    t.add_argument('--out', required=True, help='输出 WAV 路径')
    t.add_argument('--phonemizer', default='auto',
                   help='auto | none | <音素化器 tag，如 "JA VCV"')
    t.add_argument('--tpb', type=float, default=480, help='每拍 tick 数（默认 480）')
    t.add_argument('--bpm', type=float, default=120.0)
    t.set_defaults(func=cmd_render_track)

    p = sub.add_parser('probe', help='检查声库能否加载')
    p.add_argument('--voicebank', required=True)
    p.set_defaults(func=cmd_probe)

    args = parser.parse_args()
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:                                       # noqa: BLE001
        pass
    # ★ 进程级初始化：G2p 的 ONNX 会话工厂对**每个**子命令都要装
    #   （不装也能跑，只是未登录词退化为纯词典）。放在 args.func 之前。
    setup_g2p()
    _n = setup_phonemizers()
    warn('已登记音素化器 %d 个' % _n)
    emit_result(args.func(args))
    return 0


if __name__ == '__main__':
    sys.exit(main())
