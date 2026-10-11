# -*- coding: utf-8 -*-
r"""新管线的主流程入口 —— **保持与旧 `engine_diffsinger.render_phrase` 完全一致的契约**。

调用方（不能破）：
* `singing/adapters/diffsinger.py:139` —— `res.get('wav')` / `res.get('sample_rate')` /
  `res.get('warnings')` / `res.get('duration_ms')`
* `main/diffsinger.js:1048-1051` —— `###RESULT` 的 `ok` / `out` / `duration_ms` /
  `bytes` / `pipeline` …（`cmd_render` 会把除 `wav`/`sample_rate` 外的键原样输出）
* `tests/test_diffsinger_smoke.py`、`tests/test_singing_adapters.py`

## ★ 与旧实现的差异（都是有意的）

| | 旧（自造五段式） | 新（本包） |
|---|---|---|
| 分支 | `if vb.get("stages")` → 五段式 | **只有一条路径**；缺 `dsdur` 直接报错 |
| `durations` | 渲染阶段调 `sr3_dur`（被压短 2.6 倍） | A 层产出 ms → `DurationsMsToFrames` 直接换算 |
| `f0` | `sr3_pit` 输出**覆盖**基线 | **只**来自谱面曲线；渲染器不碰音高模型 |
| 响度 | 推到 −1 dBFS（峰值 89%） | **不归一化**（与上游一致，参考音频峰值 20%） |
| 音素前缀 | `ko/n`（裸名兜底命中字母序） | `zh/n`（`ValidatePhoneme` 加 lang 前缀） |
"""

import json
import math
import os
import struct
import wave
from typing import Dict, List, Optional, Sequence

from . import RenderError
from .g2p import load_ds_g2p
from .phonemizer import process_part
from .renderer import DEFAULT_DEPTH, DEFAULT_STEPS, Phrase, build_pitches, render_phrase as _render
from .session import resolve_providers
from .variance import load_variance
from .voicebank import load_singer

ENGINE_VERSION = '0.3.0'
_P, _F = [], []


def _prog(cb, percent: int, text: str) -> None:
    if cb:
        cb(percent, text)


def _load_payload(raw):
    """把 `--notes` 载荷解析成 `(notes, pitch_curve)`。

    ★ 兼容两种形态（载荷由 `main/diffsinger.js:1049-1052` 写出）：
    * 裸 list —— 一直支持；
    * `{notes, pitchCurve}` 信封 —— 轨有 PIT 曲线时主进程改写的。此前新管线
      不认信封，导致**所有带音高曲线的轨**渲染报「notes 必须是数组」；
      且信封在旧引擎也从未被解开（全引擎没有 pitchCurve 消费方）——
      这里一并补上，曲线交给渲染（对齐 engine_ustx.py:523-537 的 pitd 直传语义）。
    """
    if isinstance(raw, (list, tuple)):
        return [dict(n) for n in raw], []
    if isinstance(raw, (bytes, bytearray)):
        raw = raw.decode('utf-8')
    if isinstance(raw, str) and raw.startswith('@'):
        path = raw[1:].strip().strip('"')
        with open(path, encoding='utf-8') as f:
            raw = f.read()
    try:
        data = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        raise RenderError('notes JSON 解析失败：%s' % e)
    if isinstance(data, dict):
        notes = data.get('notes')
        if not isinstance(notes, list):
            raise RenderError('notes 必须是数组')
        curve = data.get('pitchCurve') or []
        return ([dict(n) for n in notes],
                [dict(p) for p in curve if isinstance(p, dict)])
    if not isinstance(data, list):
        raise RenderError('notes 必须是数组')
    return [dict(n) for n in data], []


def parse_notes(raw) -> List[Dict]:
    """把 `--notes` 的 JSON 解析成音符列表（容忍字符串 / 已解析的 list / 信封）。

    ★ 支持 `@文件路径` 形式 —— `main/diffsinger.js:1008-1012` 用它把音符载荷写进
      临时文件再传路径，**为了绕开 Windows 32K 命令行长度上限**。
    """
    notes, _ = _load_payload(raw)
    return notes


def write_wav(path: str, samples: Sequence[float], sample_rate: int) -> None:
    """零依赖 WAV 写出（mono int16）。

    ★ **不做响度归一化**（`DiffSingerRenderer.cs:139` 的 `WriteMono16Wav` 写的是
      vocoder 原始输出；`ApplyDynamics` 在**之后**才跑）。我们曾把它推到 −1 dBFS，
      比上游响 4.5 倍。
    """
    directory = os.path.dirname(path)
    if directory:
        os.makedirs(directory, exist_ok=True)
    frames = bytearray()
    for x in samples:
        v = int(max(-1.0, min(1.0, x)) * 32767)
        frames += struct.pack('<h', v)
    n = len(samples)
    header = b'RIFF' + (36 + len(frames)).to_bytes(4, 'little') + b'WAVE'
    header += b'fmt ' + (16).to_bytes(4, 'little')
    header += (1).to_bytes(2, 'little') + (1).to_bytes(2, 'little')
    header += sample_rate.to_bytes(4, 'little')
    header += (sample_rate * 2).to_bytes(4, 'little')
    header += (2).to_bytes(2, 'little') + (16).to_bytes(2, 'little')
    header += b'data' + len(frames).to_bytes(4, 'little')
    with open(path, 'wb') as f:
        f.write(header + bytes(frames))
    return n


def _pad_leading_silence(samples, sr, position_ms, warnings=None):
    """给渲染结果补上「从 0 到本句起点」的静音。

    ★ 为什么必须有：DiffSinger 的渲染器只产出**这一句**的样点，句首在整首歌里的位置
      由 `phrase.position_ms` 决定；上层（OpenUTAU 的合成器）负责把它摆到时间轴上。
      本 CLI 直接写 WAV，就必须自己补 —— 不补的话整条人声整体提前
      （实测《烦恼歌》96BPM：提前 0.82s，恰好等于第一个音素的位置），叠上伴奏全程抢拍。
    """
    try:
        import numpy as _np
        lead = int(round(float(position_ms) / 1000.0 * float(sr)))
        if lead > 0:
            return _np.concatenate([_np.zeros(lead, dtype=_np.asarray(samples).dtype),
                                    _np.asarray(samples)])
    except Exception as e:  # noqa: BLE001 —— 补静音失败不该让整次渲染失败
        if warnings is not None:
            warnings.append('前置静音补齐失败（结果可能整体提前 %sms）：%s' % (position_ms, e))
    return samples


def render_phrase(cfg: Dict, on_progress=None,
                  axis=None, project=None) -> Dict:
    """渲染入口。`cfg` 的键与旧实现一致（见模块 docstring）。"""
    voicebank = cfg.get('voicebank')
    if not voicebank or not os.path.isdir(voicebank):
        raise RenderError('声库目录不存在：%r' % voicebank)
    notes, pitch_curve = _load_payload(cfg.get('notes'))
    if not notes:
        raise RenderError('没有音符可渲染')
    device = cfg.get('device') or 'auto'
    providers = resolve_providers(device)
    dev_label = providers[0] if providers else 'CPUExecutionProvider'
    warnings: List[str] = []

    _prog(on_progress, 5, '加载声库配置…')
    # ★ 以前这里写的是 `cfg.get('vocoder') and None or None`（恒为 None）：覆盖参数从来没生效，
    #   却每次都报一条「暂不支持」—— 实际上通用声码器是**能用**的，没有 dsvocoder 的声库正需要它。
    _voc = cfg.get('vocoder') or None
    singer = load_singer(voicebank, _voc)
    if _voc:
        _name = os.path.basename(str(_voc).rstrip('\\/'))
        try:
            _used = os.path.abspath(os.path.dirname(str(_voc))) == os.path.abspath(singer.vocoder.root)
        except Exception:
            _used = False
        warnings.append(('声码器：使用外部通用声码器（%s）' % _name) if _used
                        else ('声码器：使用声库自带（已忽略外部 %s）' % _name))
    # ★ 语言来自轨道（cfg.language），不再硬编码 'zh'：
    #   多语声库（如 花火 带 zh/ja/ko/en 四本词典）用日文/韩文歌词时必须能切换。
    lang = str(cfg.get('language') or 'zh')
    g2p, dict_name = load_ds_g2p(singer.dur.root, lang, warnings)

    # ---- 谱面 → TimeAxis
    _prog(on_progress, 12, '构建时间轴…')
    if axis is None or project is None:
        axis, project = _make_axis(cfg, notes)
    part = project.parts[0]

    # ---- A 层：音素化（含 dsdur 时长模型）
    _prog(on_progress, 25, '音素化…')
    # ★ 传**真正的 UNote 对象**（`process_part` 要读 `.position` / `.duration` / `.tone` / `.lyric`），
    #   不是 CLI 给的 dict。
    grouped = _group_notes(part.notes)
    phones = process_part(singer, grouped, axis, g2p, lang, providers, warnings)
    if not phones:
        raise RenderError('音素化没有产出任何音素（歌词是否为空？）')

    # ---- 组 Phrase
    _prog(on_progress, 40, '构建音高曲线…')
    acoustic = singer.acoustic
    phrase = Phrase(
        axis=axis, part_position=part.position,
        position=phones[0].position, leading=0,
        position_ms=axis.tick_pos_to_ms_pos(phones[0].position),
        # ★ phones[-1].end_ms 已经是**毫秒**，不能再喂给 ms_between_tick_pos(按 tick 解释) ——
        #   那样算出来的时长会偏大（实测 243.9s 的歌唱出 316.8s 的"时长"）。
        duration_ms=float(phones[-1].end_ms) - axis.tick_pos_to_ms_pos(phones[0].position),
        phones=phones,
        need_energy=acoustic.use_energy_embed,
        need_breathiness=acoustic.use_breathiness_embed,
        need_voicing=acoustic.use_voicing_embed,
        need_tension=acoustic.use_tension_embed,
    )
    phrase.pitches = build_pitches(part.notes, axis, part.position,
                                   phrase.position, phrase.leading,
                                   pitd_curve=_track_pitd_curve(project, pitch_curve))
    # 用户曲线（.ustx 的 SHFC/GENC/BREC/VOIC/TENC/VELC）；本 CLI 暂不带曲线 → 全默认
    n = max(64, len(phrase.pitches))
    phrase.tone_shift = [0.0] * n
    phrase.gender = [0.0] * n
    phrase.breathiness = [0.0] * n
    phrase.voicing = [100.0] * n          # ★ VOIC 的中性是 100（见 variance_delta）
    phrase.tension = [0.0] * n
    phrase.energy = [0.0] * n

    # ---- B 层：渲染
    _prog(on_progress, 55, '渲染…')
    variance_cfg = load_variance(voicebank)
    # ★ 本函数已把 0..55 用掉，渲染阶段映射到 55..100 —— 否则进度条会从 55 掉回 5
    samples, sr = _render(singer, phrase, providers,
                         depth=float(cfg.get('depth') or DEFAULT_DEPTH),
                         steps=int(cfg.get('steps') or DEFAULT_STEPS),
                         variance_cfg=variance_cfg, on_progress=on_progress,
                         progress_range=(55, 100))

    # ★★ 渲染出来的只是**这一句**的样点，它在整首歌里的位置由 phrase.position_ms 决定 ——
    #   前面的留白必须自己补（见 _pad_leading_silence）。
    samples = _pad_leading_silence(samples, sr, phrase.position_ms, warnings)

    out = cfg.get('out')
    if out:
        write_wav(out, samples, sr)

    _prog(on_progress, 100, '完成')
    return {
        'ok': True,
        'out': out,
        'duration_ms': int(len(samples) / sr * 1000),
        'warnings': warnings[:40],
        'engine_version': ENGINE_VERSION,
        'phoneme_count': len(phones),
        'sample_rate': sr,
        'device': {'provider': dev_label, 'requested': device},
        'pipeline': 'upstream',
        'range': None,
        'wav': samples,
    }


def _group_notes(unotes: Sequence) -> List[List]:
    """按「是否连排」把音符切成句、每个字一组（`process_part` 要的是 `Note[][]`）。

    ★ 上游 `MachineLearningPhonemizer.Romanize` 之后按"是否连排"切句，
      一个字对应 `Note[]`（可能是多个音符的连排）。本 CLI 逐音给出音符，
      所以**一个字 = 一个音符**；连排的分组逻辑 `process_word` 里的
      `nonExtensionNotes` 已经处理（它按 `+~` / `+*` 前缀过滤延音）。
    """
    return [[n] for n in unotes]


def _track_pitd_curve(project, pitch_curve):
    """轨级音高曲线（应用侧 PIT 泳道：音分@绝对拍）→ pitd `UCurve`。

    ★ 坐标系：`_make_axis` 的 part.position=0，UNote.position 就是工程绝对 tick，
      所以 `beat × ticks_per_beat` 直接可用（同 engine_ustx.py:523-537 的
      「pitchCurve → 段内 pitd 曲线、音分直传」语义；pitd 的 default=0 → 区间外为 0）。
    """
    if not pitch_curve:
        return None
    from singing.ustx.model import UCurve
    ticks_per_beat = float(project.resolution) * 4.0 / float(project.beat_unit or 4)
    pts = []
    for p in pitch_curve:
        if not isinstance(p, dict):
            continue
        try:
            beat = float(p.get('beat'))
        except (TypeError, ValueError):
            continue
        try:
            cents = float(p.get('cents') or 0)
        except (TypeError, ValueError):
            cents = 0.0
        pts.append((int(round(max(0.0, beat) * ticks_per_beat)), int(round(cents))))
    if not pts:
        return None
    pts.sort()
    return UCurve(xs=[x for x, _ in pts], ys=[y for _, y in pts],
                  abbr='pitd', descriptor=project.expressions.get('pitd'))


def _make_axis(cfg: Dict, notes: Sequence[Dict]):
    """造一个最小的 UProject + TimeAxis（CLI 没有工程上下文时用）。"""
    from singing.ustx.format import add_default_expressions
    from singing.ustx.model import UNote, UProject, UTrack, UVoicePart, UTempo

    p = UProject()
    p.name = 'render'
    p.bpm = float(cfg.get('bpm') or 120)
    # ---- 多点变速：cfg['tempos'] = [{beat, bpm}]（拍单位，应用侧 store.tempoMap 同构）。
    #      拍→tick 与 tempo 无关（见下），多点只影响 tick→ms（TimeAxis 分段换算）。
    tempos_in = cfg.get('tempos') or []
    tempos = []
    for t in tempos_in:
        if not isinstance(t, dict):
            continue
        try:
            beat = float(t.get('beat'))
            tbpm = float(t.get('bpm'))
        except (TypeError, ValueError):
            continue
        if beat < 0 or not (20.0 <= tbpm <= 400.0):
            continue
        tempos.append(UTempo(position=int(round(beat * p.resolution)), bpm=tbpm))
    if tempos:
        if not any(t.position == 0 for t in tempos):
            tempos.insert(0, UTempo(position=0, bpm=p.bpm))
        p.tempos = tempos
    else:
        # ★ 单点也必须显式写 tempos：`p.bpm` 是 ustx v0.6 的废弃字段，
        #   TimeAxis.build_segments 只认 tempos —— 旧实现漏了这一步，
        #   非 120bpm 渲染的 tick→ms 换算全部按默认 120 错位。
        p.tempos = [UTempo(position=0, bpm=p.bpm)]
    p.file_path = os.path.join(os.environ.get('TEMP', '.'), '_diffsinger_cli.ustx')
    add_default_expressions(p)
    tr = UTrack.for_project(p)  # 对应 C# 的 UTrack(UProject) 重载
    tr.track_no = 0
    p.tracks.append(tr)
    part = UVoicePart(track_no=0, position=0, name='render')
    p.parts.append(part)
    # ★ CLI 的音符用**拍**（startBeat / durBeat），而 UProject 用 **tick**。
    #   换算与 bpm **无关**：ticks_per_beat = resolution * 4 / beat_unit
    #   （resolution 固定 480、beat_unit 4 → 每拍 480 tick）。
    #   ★ 我第一版写成 `480 * 60 / bpm`（把毫秒混进来了），在 120bpm 下差 2 倍。
    ticks_per_beat = float(p.resolution) * 4.0 / float(p.beat_unit or 4)
    for n in notes:
        if n.get('startBeat') is not None or n.get('durBeat') is not None:
            pos = int(round(float(n.get('startBeat') or 0) * ticks_per_beat))
            dur = int(round(float(n.get('durBeat', 1.0)) * ticks_per_beat))
        else:
            pos = int(n.get('position') or 0)
            dur = int(n.get('duration') or int(ticks_per_beat))
        part.notes.append(UNote(
            position=max(0, pos), duration=max(1, dur),
            tone=int(n.get('tone') if n.get('tone') is not None
                     else (n.get('pitch') or 60)),
            lyric=str(n.get('lyric') or ''),
        ))
    part.notes.sort(key=lambda x: x.position)
    part.notes[-1].next = None
    part.duration = max(x.position + x.duration for x in part.notes)
    from singing.openutau.timeaxis import TimeAxis
    axis = TimeAxis()
    axis.build_segments(p)
    return axis, p


def _pitch_edit_entry(voicebank: str, notes, bpm: float, device: str,
                      pitch_steps=None, tempo_map=None) -> Dict:
    """`pitch-edit` 的实现（编辑功能，**不参与渲染**）。

    流程：A 层音素化 → `dspitch` 预测 → 按 `NoteBatchEdits.cs:540-566` 写回 PITD。
    ★ 写回的是**音分差**且**只下调**；`voiced == False` 的帧（head/tail SP、
      音素间隙）跳过。
    """
    from .g2p import load_ds_g2p
    from .phonemizer import process_part
    from .pitch_edit import load_pitch, load_rendered_pitch, pitch_result_to_pitd
    from .renderer import build_pitches
    from .session import resolve_providers
    from .voicebank import load_singer

    if isinstance(notes, str) and notes.startswith('@'):
        with open(notes[1:].strip().strip('"'), encoding='utf-8') as f:
            notes = f.read()
    raw_notes = parse_notes(notes)
    providers = resolve_providers(device)
    singer = load_singer(voicebank)
    warnings: List[str] = []
    g2p, _ = load_ds_g2p(singer.dur.root, 'zh', warnings)

    cfg = load_pitch(voicebank)
    if cfg is None:
        raise RenderError('该声库没有 dspitch/（无音高预测器）—— '
                          '这是编辑功能，渲染本身不需要它')

    axis, project = _make_axis({'bpm': bpm, 'tempos': tempo_map}, raw_notes)
    part = project.parts[0]
    phones = process_part(singer, _group_notes(part.notes), axis, g2p, 'zh',
                          providers, warnings)
    phrase = Phrase(
        axis=axis, part_position=part.position, position=phones[0].position, leading=0,
        position_ms=axis.tick_pos_to_ms_pos(phones[0].position),
        # ★ phones[-1].end_ms 已经是**毫秒**，不能再喂给 ms_between_tick_pos(按 tick 解释) ——
        #   那样算出来的时长会偏大（实测 243.9s 的歌唱出 316.8s 的"时长"）。
        duration_ms=float(phones[-1].end_ms) - axis.tick_pos_to_ms_pos(phones[0].position),
        phones=phones)
    phrase.pitches = build_pitches(part.notes, axis, part.position,
                                   phrase.position, phrase.leading)
    phrase.tone_shift = [0.0] * max(64, len(phrase.pitches))

    result = load_rendered_pitch(singer, cfg, phrase, part.notes,
                                 singer.phoneme_tokens, g2p, providers,
                                 pitch_steps=pitch_steps)
    pitd = pitch_result_to_pitd(result, phrase, part.position, list(phrase.pitches))
    return {
        'ok': True,
        'points': [[int(x), int(y)] for x, y in pitd],
        'point_count': len(pitd),
        'frames': len(result.tones),
        'voiced_frames': sum(1 for v in result.voiced if v) if result.voiced else None,
        'warnings': warnings[:40],
        'engine_version': ENGINE_VERSION,
        'pipeline': 'upstream-pitch',
    }
