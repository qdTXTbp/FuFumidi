# -*- coding: utf-8 -*-
"""`.ustx` ⇄ 应用工程数据 互转 CLI（OpenUtau 工程文件兼容）。

两个方向：

  import   读 `.ustx` → 写「交换 JSON」（project.json 形态，**拍**单位）
  export   读交换 JSON（含 audioFiles 运行时附件）→ 写 `.ustx` + 拷贝伴奏

交换 JSON 与前端 `frontend/src/core/song_project.js` 的 project.json **同一形态**
（format=fufumidi-song），并用三个可选字段承载 ustx 的时间轴信息：

  tempoMap: [{beat, bpm}]        多点变速（首点强制 beat=0）
  sigMap:   [{beat, num, den}]   多点拍号（首点强制 beat=0）
  keySf:    -7..7                调号（对应 UProject.key）

★ 单位换算（三处都是照搬上游得出的硬事实，改之前先对源码）：
  * ustx resolution 固定 480 tick/拍（UProject.resolution）→ beat = tick / 480，
    与 tempo 无关（tick 是乐谱时间，拍是乐谱时间的另一种记法）。
  * `UTimeSignature.bar_position` 是**小节号**，不是 tick！
    见 `singing/openutau/timeaxis.py` build_segments：
    `pos_tick = last.tick_pos + last.ticks_per_bar * (sig.bar_position - last.bar_position)`。
    所以拍号换算必须沿段推进，不能直接 ×480。
  * `UPitch` 点的 y 单位是**半音**（`render_phrase.py` L272 `point.y * 100` 转音分）；
    应用侧 pitchCurve 用音分 → y = cents / 100。

★ 有意不转（import 计入 warnings，export 静默从默认值起）：
  音素级数据（phoneme_expressions / phoneme_overrides / phonemizer_override）、
  part 级曲线与掩码曲线、轨道 mix_fx / voice_color / pan、ExpressionGraphs。
  前端模型（SingTrack/SingNote）暂无对应物 —— 等编辑器侧补齐再扩交换面。

用法（stdout 只打 `###RESULT {json}`，警告走 stderr，与 engine_openutau.py 约定一致）：

  python engine_ustx.py import --in a.ustx --out interchange.json
  python engine_ustx.py export --project @req.json --out a.ustx
      # req.json = {"project": <交换JSON>, "audioFiles": [{asset, srcPath, fileName}]}
      # `@file` 约定：参数值从文件读（整轨 JSON 会撞 Windows 32K 命令行上限）
"""

import argparse
import json
import os
import shutil
import sys
import traceback

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

VERSION = 'ustx-convert/0.1.0'

#: ustx resolution：固定 480（UProject.resolution，不写盘）
RES = 480
#: 拍号分母合法集合（与前端 song_project.js 的 SIG_DENS 一致）
SIG_DENS = (1, 2, 4, 8, 16, 32)
#: 会导出到 part.curves 的表达式（渲染侧吃的）；pit/pitd 走 UPitch，vol/pan 只影响播放
CURVE_ABBRS = ('dyn', 'bre', 'gen', 'clr', 'cvk')


def emit_result(obj):
    sys.stdout.write('###RESULT ' + json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def warn(msg):
    sys.stderr.write('[engine_ustx] ' + str(msg) + '\n')
    sys.stderr.flush()


def _clamp(v, lo, hi):
    return lo if v < lo else (hi if v > hi else v)


def _num(d, *keys, **kw):
    default = kw.get('default')
    for k in keys:
        v = d.get(k)
        if isinstance(v, (int, float)) and not isinstance(v, bool):
            return float(v)
    return default


def tick_to_beat(tick):
    return float(tick) / RES


def beat_to_tick(beat):
    return int(round(float(beat) * RES))


def _sig_dedup(points):
    """按 beat 排序 + 同拍去重（后写的赢）—— 与前端 serializeSigMap 一致。"""
    points.sort(key=lambda p: p['beat'])
    out = []
    for p in points:
        if out and out[-1]['beat'] == p['beat']:
            out[-1] = p
        else:
            out.append(p)
    return out


# ================================================================ import

def import_ustx(in_path):
    """`.ustx` → (交换 JSON, resolved{asset: 本机绝对路径}, warnings)。

    resolved 里的绝对路径**不进 JSON** —— 由主进程单独回传给前端回填
    `audio.path`（运行时字段，序列化时被白名单剥掉，与 .fufumidi 的约束一致）。
    """
    from singing.ustx import format as ustx_format
    from singing.ustx.model import UVoicePart, UWavePart

    project = ustx_format.load(in_path)
    warnings = []
    base_dir = os.path.dirname(os.path.abspath(in_path))

    parts = list(project.parts or [])
    if not parts:
        parts = list(project.voice_parts or []) + list(project.wave_parts or [])

    # ---- 时间轴：多点变速 / 拍号（拍号沿小节段换算成拍，公式同 timeaxis.py）
    tempo_map = []
    for t in project.tempos:
        bpm = _clamp(float(t.bpm or 120.0), 20.0, 400.0)
        beat = max(0.0, tick_to_beat(int(t.position or 0)))
        tempo_map.append({'beat': round(beat, 3), 'bpm': round(bpm, 2)})
    if not any(p['beat'] == 0 for p in tempo_map):
        tempo_map.insert(0, {'beat': 0.0, 'bpm': 120.0})
    tempo_map = _sig_dedup(tempo_map)

    sig_points = []
    prev_bar = prev_tick = 0
    prev_tpb = None
    for s in sorted(project.time_signatures, key=lambda s: int(s.bar_position or 0)):
        bpb = int(s.beat_per_bar or 4)
        bu = int(s.beat_unit or 4)
        if prev_tpb is None:
            tick = 0                       # 第一段必在第 0 小节
        else:
            tick = prev_tick + prev_tpb * (int(s.bar_position or 0) - prev_bar)
        sig_points.append({'beat': round(tick_to_beat(tick), 3),
                           'num': _clamp(bpb, 1, 32),
                           'den': bu if bu in SIG_DENS else 4})
        prev_bar, prev_tick = int(s.bar_position or 0), tick
        prev_tpb = RES * 4 * bpb // max(1, bu)
    sig_map = _sig_dedup(sig_points) if sig_points else [{'beat': 0.0, 'num': 4, 'den': 4}]

    # ---- 轨道
    tracks = []
    resolved = {}
    assets = {}
    note_seq = [0]
    curve_dropped = [0]
    phoneme_dropped = [0]
    merged_parts = [0]
    audio_seq = [0]

    def new_note_id():
        note_seq[0] += 1
        return 'n%d' % note_seq[0]

    for idx, ut in enumerate(project.tracks):
        renderer = (ut.renderer_settings.renderer if ut.renderer_settings else '') or ''
        is_ds = 'diffsinger' in renderer.lower()

        # ---- 声部轨：同一 UTrack 的多个 voice part 合并进一条轨
        vparts = [p for p in parts if isinstance(p, UVoicePart) and p.track_no == idx]
        notes = []
        pitch_curve = []
        track_curves = {}   # abbr -> {'abbr', 'points': [...]}（多 part 合并后按 beat 排序）
        for part in vparts:
            if len(vparts) > 1:
                merged_parts[0] += 1
            # ---- UCurve 导入（此前整条丢弃 → 用户画的 PIT/DYN 曲线全丢）：
            #   pitd（音分，±1200）→ 应用侧 pitchCurve；dyn/genc/brec → 应用侧 curves
            part_curves = list(part.curves or []) + list(part.masked_curves or [])
            base_beat = tick_to_beat(int(part.position or 0))
            for part_curve in part_curves:
                abbr = str(getattr(part_curve, 'abbr', '') or '')
                xs = list(getattr(part_curve, 'xs', None) or [])
                ys = list(getattr(part_curve, 'ys', None) or [])
                if not xs or len(xs) != len(ys):
                    curve_dropped[0] += 1
                    continue
                if abbr == 'pitd':
                    for x, y in zip(xs, ys):
                        pitch_curve.append({'beat': round(base_beat + tick_to_beat(int(x)), 3),
                                            'cents': round(float(y), 2)})
                elif abbr in ('dyn', 'genc', 'brec'):
                    target = {'dyn': 'DYN', 'genc': 'GEN', 'brec': 'BRE'}[abbr]
                    pts = []
                    for x, y in zip(xs, ys):
                        v = float(y)
                        if abbr == 'dyn':
                            v = _clamp((v + 240.0) / 2.4, 0.0, 100.0)   # ustx 0.1dB → 应用 0..100
                        pts.append({'beat': round(base_beat + tick_to_beat(int(x)), 3),
                                    'value': round(v, 2)})
                    bucket = track_curves.setdefault(target, {'abbr': target, 'points': []})
                    bucket['points'].extend(pts)
                else:
                    curve_dropped[0] += 1
            for n in (part.notes or []):
                phoneme_dropped[0] += len(n.phoneme_expressions or []) + len(n.phoneme_overrides or [])
                start_beat = max(0.0, tick_to_beat(int(part.position or 0) + int(n.position or 0)))
                dur_beat = max(0.125, tick_to_beat(int(n.duration or 0)))
                note = {
                    'id': new_note_id(),
                    'startBeat': round(start_beat, 3),
                    'durBeat': round(dur_beat, 3),
                    'pitch': _clamp(int(n.tone or 0), 0, 127),
                    'lyric': str(n.lyric or ''),
                }
                # ---- 颤音 8 参 → 应用侧 4 参（period 是 ms → 频率 = 1000/period）
                vib = n.vibrato
                if vib is not None and float(vib.length or 0) > 0:
                    period = float(vib.period or 175.0)
                    note['vibrato'] = True
                    note['vibDepth'] = _clamp(round(float(vib.depth or 25.0), 2), 0, 100)
                    note['vibFreq'] = _clamp(round(1000.0 / period, 2) if period > 0 else 5.5, 0, 12)
                    vi = _clamp(float(vib.vib_in or 0), 0, 100)
                    vo = _clamp(float(vib.vib_out or 0), 0, 100)
                    note['vibIn'] = round(vi, 1)
                    note['vibOut'] = round(vo, 1)
                    note['vibFade'] = round(max(vi, vo), 1)     # 旧字段，兼容保留
                    note['vibShift'] = _clamp(round(float(vib.shift or 0.0), 1), -100, 100)
                    note['vibDrift'] = _clamp(round(float(vib.drift or 0.0), 1), -100, 100)
                    note['vibVolLink'] = _clamp(round(float(vib.vol_link or 0.0), 1), -100, 100)
                else:
                    note['vibrato'] = False
                    note['vibDepth'] = 35
                    note['vibFreq'] = 5.5
                    note['vibFade'] = 0
                # ---- 音高：UPitch（半音，相对音符起点的 tick 偏移）→ 音分曲线
                pts = [(int(pt.x or 0), float(pt.y or 0.0))
                       for pt in ((n.pitch.data if n.pitch is not None else None) or [])]
                if pts and all(x == 0 for x, _ in pts):
                    # 只有 x=0 的点 → 就是「整音符音分偏移」，用 pitchOffset 更贴前端语义
                    note['pitchOffset'] = _clamp(round(pts[0][1] * 100.0, 1), -100, 100)
                elif pts:
                    for x, y in pts:
                        pitch_curve.append({'beat': round(start_beat + tick_to_beat(x), 3),
                                            'cents': round(y * 100.0, 2)})
                notes.append(note)
        pitch_curve.sort(key=lambda p: p['beat'])
        for c in track_curves.values():
            c['points'].sort(key=lambda p: p['beat'])

        if vparts:
            tracks.append({
                'id': 'tr%d' % (len(tracks) + 1),
                'name': str(ut.track_name or ('Track %d' % (idx + 1))),
                'kind': 'voice',
                'engine': 'diffsinger' if is_ds else 'utau',
                'singer': '',
                'singerName': str(ut.singer or ''),
                'language': str(ut.language or 'zh') or 'zh',
                'notes': notes,
                'pitchCurve': pitch_curve,
                'curves': [track_curves[k] for k in sorted(track_curves)],
                # 片段起点（拍，升序）：对齐 OpenUtau/传统 DAW 的「轨承载多片段」模型。
                # 每个 UVoicePart 的 position 就是这里的一项；导出按区间把 notes 切回片段。
                'partStarts': sorted(round(tick_to_beat(int(p.position or 0)), 3) for p in vparts),
                'muted': bool(ut.mute),
                'gainDb': _clamp(round(float(ut.volume or 0.0), 2), -60, 24),
            })

        # ---- 音频轨：每个 wave part 一条轨（应用侧一条轨只挂一个音频片段）
        for part in [p for p in parts if isinstance(p, UWavePart) and p.track_no == idx]:
            audio_seq[0] += 1
            rel = str(part.relative_path or '')
            file_name = os.path.basename(rel.replace('\\', '/')) if rel else 'audio.wav'
            asset = 'aw%d' % audio_seq[0]
            abs_path = os.path.normpath(os.path.join(base_dir, rel)) if rel else ''
            if abs_path and os.path.isfile(abs_path):
                resolved[asset] = abs_path
            tracks.append({
                'id': 'tr%d' % (len(tracks) + 1),
                'name': str(part.name or file_name),
                'kind': 'audio',
                'engine': 'utau',
                'singer': '',
                'language': 'zh',
                'notes': [],
                'pitchCurve': [],
                'muted': bool(ut.mute),
                'gainDb': _clamp(round(float(ut.volume or 0.0), 2), -60, 24),
                'audio': {
                    'asset': asset,
                    'fileName': file_name[:255],
                    'durationMs': max(0.0, float(part.file_duration_ms or 0.0)),
                    'skip': max(0, int(part.skip or 0)),
                    'trim': max(0, int(part.trim or 0)),
                    'fadeIn': max(0, int(part.fadein or 0)),
                    'fadeOut': max(0, int(part.fadeout or 0)),
                    'gainDb': 0,
                    'muted': False,
                },
            })
            assets[asset] = {'name': file_name[:255]}

    if curve_dropped[0]:
        warnings.append('%d 条表达式曲线未转（编辑器暂不支持曲线导入）' % curve_dropped[0])
    if phoneme_dropped[0]:
        warnings.append('%d 处音素级参数未转（音素覆写/表达式）' % phoneme_dropped[0])
    if merged_parts[0]:
        warnings.append('同一轨道的 %d 个声部片段已按位置合并' % merged_parts[0])
    if not tracks:
        raise ValueError('工程里没有可识别的轨道数据')

    data = {
        'format': 'fufumidi-song',
        'version': 1,
        'app': 'FuFumidi',
        'createdAt': '',
        'updatedAt': '',
        'meta': {'title': str(project.name or ''), 'comment': str(project.comment or ''), 'artist': ''},
        'bpm': tempo_map[0]['bpm'],
        'tempoMap': tempo_map,
        'sigMap': sig_map,
        'keySf': _clamp(int(project.key or 0), -7, 7),
        'device': 'auto',
        'sampleNote': 'a',
        'activeTrackId': tracks[0]['id'],
        'tracks': tracks,
        'assets': assets,
    }
    return data, resolved, warnings


# ================================================================ export

def _sig_points_to_bars(sig_map):
    """交换 JSON 的 sigMap（beat）→ UTimeSignature 列表（bar_position 是**小节号**）。

    反向换算同样沿段推进：bar = prev_bar + round((tick - prev_tick) / prev_tpb)。
    """
    from singing.ustx.model import UTimeSignature

    points = [p for p in (sig_map or [])
              if isinstance(p, dict)
              and isinstance(_num(p, 'beat', default=None), float)
              and _num(p, 'beat', default=-1) >= 0]
    if not points:
        return [UTimeSignature(bar_position=0, beat_per_bar=4, beat_unit=4)]
    points.sort(key=lambda p: p['beat'])
    if points[0]['beat'] != 0:
        points.insert(0, {'beat': 0, 'num': points[0].get('num') or 4, 'den': points[0].get('den') or 4})
    out = []
    prev_bar = prev_tick = 0
    prev_tpb = None
    for p in points:
        bpb = _clamp(int(_num(p, 'num', default=4)), 1, 32)
        bu = int(_num(p, 'den', default=4))
        if bu not in SIG_DENS:
            bu = 4
        tick = beat_to_tick(p['beat'])
        if prev_tpb is None:
            bar = 0
        else:
            bar = prev_bar + int(round((tick - prev_tick) / prev_tpb))
        out.append(UTimeSignature(bar_position=bar, beat_per_bar=bpb, beat_unit=bu))
        prev_bar, prev_tick, prev_tpb = bar, tick, RES * 4 * bpb // max(1, bu)
    return out


def export_ustx(payload, out_path):
    """交换 JSON → `.ustx`（+ 把伴奏拷到 `<名字>_assets/` 旁目录）。

    payload = {"project": <交换JSON>, "audioFiles": [{asset, srcPath, fileName}]}
    返回 warnings 列表。
    """
    from singing.ustx import format as ustx_format
    from singing.ustx.model import (UCurve, UNote, UPitch, PitchPoint, URenderSettings,
                                    UTempo, UTrack, UVibrato, UVoicePart, UWavePart,
                                    UExpressionType)

    data = payload.get('project') or {}
    audio_files = payload.get('audioFiles') or []
    warnings = []
    if data.get('format') != 'fufumidi-song':
        raise ValueError('工程数据不是 fufumidi-song 形态')

    project = ustx_format.create()          # 带全套默认表达式（导出的曲线/描述符要用）
    meta = data.get('meta') or {}
    project.name = str(meta.get('title') or 'Imported')
    project.comment = str(meta.get('comment') or '')
    project.key = _clamp(int(_num(data, 'keySf', default=0) or 0), -7, 7)

    # ---- 时间轴
    tempos = []
    for p in (data.get('tempoMap') or []):
        beat = _num(p, 'beat', default=-1)
        bpm = _num(p, 'bpm', default=None)
        if beat is None or beat < 0 or bpm is None:
            continue
        tempos.append(UTempo(position=beat_to_tick(beat), bpm=_clamp(float(bpm), 20.0, 400.0)))
    if not any(int(t.position) == 0 for t in tempos):
        tempos.insert(0, UTempo(position=0, bpm=_clamp(float(_num(data, 'bpm', default=120) or 120), 20.0, 400.0)))
    project.tempos = tempos
    project.time_signatures = _sig_points_to_bars(data.get('sigMap'))
    project.build_time_axis()

    # ---- 轨道
    # audioFiles 由主进程组装：[{id(=asset), srcPath, fileName}]（与 project:save 同一形态）
    audio_by_asset = {}
    for a in audio_files:
        if isinstance(a, dict) and a.get('id'):
            audio_by_asset[str(a['id'])] = a

    def singer_display(t):
        # ustx 记的是**声库名**；应用侧 singer 是本机目录 —— 取登记过的显示名，否则目录名
        name = str(t.get('singerName') or '').strip()
        if name:
            return name
        return os.path.basename(str(t.get('singer') or '').replace('\\', '/').rstrip('/')) or ''

    tracks = []
    parts = []
    for ti, t in enumerate(data.get('tracks') or []):
        if not isinstance(t, dict):
            continue
        kind = t.get('kind')
        track_color = 'Blue'
        if kind == 'voice':
            ut = UTrack(
                singer=singer_display(t),
                track_name=str(t.get('name') or ('Track %d' % (ti + 1))),
                renderer_settings=URenderSettings(
                    renderer='DIFFSINGER' if t.get('engine') == 'diffsinger' else 'usynth'),
                mute=bool(t.get('muted')),
                volume=_clamp(float(_num(t, 'gainDb', default=0) or 0), -60, 24),
                language=str(t.get('language') or ''),
            )
            # ---- 片段模型（对齐 OpenUtau/传统 DAW：轨承载多片段）。
            # partStarts = 各片段起点（拍，升序）；缺省 [0]（单段，与旧工程兼容）。
            # 音符/曲线都是**轨级绝对拍**，按区间 [s_i, s_{i+1}) 切回片段，
            # 片段内坐标 = 绝对拍 − 段起点。
            raw_starts = []
            for s in (t.get('partStarts') or []):
                if isinstance(s, (int, float)) and not isinstance(s, bool) and float(s) >= 0:
                    raw_starts.append(max(0.0, float(s)))
            seg_starts = sorted(set(round(s, 3) for s in raw_starts)) or [0.0]
            pitch_curve = t.get('pitchCurve') or []
            track_curves = [c for c in (t.get('curves') or [])
                            if isinstance(c, dict) and c.get('abbr') in ('DYN', 'GEN', 'BRE')]
            for si, seg_start in enumerate(seg_starts):
                seg_end = seg_starts[si + 1] if si + 1 < len(seg_starts) else float('inf')
                part = UVoicePart(track_no=len(tracks), position=beat_to_tick(seg_start),
                                  name=str(t.get('name') or 'Part 1') + ('' if len(seg_starts) == 1 else ' %d' % (si + 1)))
                part.notes = []
                part_curves = {}   # ustx abbr -> [(tick, value)]
                for n in (t.get('notes') or []):
                    if not isinstance(n, dict):
                        continue
                    start_beat = float(_num(n, 'startBeat', default=0) or 0)
                    if not (seg_start <= start_beat < seg_end):
                        continue
                    pos = beat_to_tick(start_beat - seg_start)
                    dur = max(RES // 8, beat_to_tick(_num(n, 'durBeat', default=1)))
                    note = UNote(position=pos, duration=dur,
                                 tone=_clamp(int(_num(n, 'pitch', default=60) or 60), 0, 127),
                                 lyric=str(n.get('lyric') or 'a'))
                    # ---- 颤音：应用侧全参 → UVibrato（length=100：应用侧颤音吃满整音符）。
                    #      vibIn/vibOut 是新字段，旧工程只有 vibFade → in=out 兜底；
                    #      in/out 互约束（out ≤ 100 − in）由 UVibrato 的 setter 天然处理。
                    if n.get('vibrato'):
                        freq = float(_num(n, 'vibFreq', default=5.5) or 5.5)
                        fade = _clamp(float(_num(n, 'vibFade', default=0) or 0), 0, 100)
                        vi = _clamp(float(_num(n, 'vibIn', default=fade) if n.get('vibIn') is not None else fade), 0, 100)
                        vo = _clamp(float(_num(n, 'vibOut', default=fade) if n.get('vibOut') is not None else fade), 0, 100)
                        note.vibrato = UVibrato(
                            length=100,
                            period=_clamp(1000.0 / freq if freq > 0 else 175.0, 5, 500),
                            depth=_clamp(float(_num(n, 'vibDepth', default=35) or 35), 5, 200),
                            vib_in=vi, vib_out=vo,
                            shift=_clamp(float(_num(n, 'vibShift', default=0) or 0), -100, 100),
                            drift=_clamp(float(_num(n, 'vibDrift', default=0) or 0), -100, 100),
                            vol_link=_clamp(float(_num(n, 'vibVolLink', default=0) or 0), -100, 100))
                    # ---- 音高：pitchCurve（音分，绝对拍）切片到音符 + pitchOffset 兜底
                    pts = []
                    if n.get('pitchOffset'):
                        pts.append(PitchPoint(x=0, y=float(n['pitchOffset']) / 100.0))
                    end_beat = start_beat + float(_num(n, 'durBeat', default=1) or 1)
                    curve_pts = [p for p in pitch_curve
                                 if isinstance(p, dict) and start_beat <= float(_num(p, 'beat', default=-1)) < end_beat]
                    if curve_pts:
                        # 曲线优先（x 相对音符起点的 tick 偏移，y 半音）
                        pts = [PitchPoint(x=max(0, beat_to_tick(float(p['beat']) - start_beat)),
                                          y=float(_num(p, 'cents', default=0) or 0) / 100.0)
                               for p in curve_pts]
                    if pts:
                        pts.sort(key=lambda p: p.x)
                        note.pitch = UPitch(data=pts)
                    part.notes.append(note)
                # ---- 轨级 curves → 每段的 part.curves（xs 相对段起点 tick；
                #      dyn 0..100 → -240..0 0.1dB；genc/brec 直传）
                for c in track_curves:
                    abbr = str(c.get('abbr') or '')
                    ustx_abbr = {'DYN': 'dyn', 'GEN': 'genc', 'BRE': 'brec'}[abbr]
                    desc = project.expressions.get(ustx_abbr)
                    if desc is None or desc.type != UExpressionType.CURVE:
                        continue
                    pts = []
                    for p in (c.get('points') or []):
                        if not isinstance(p, dict):
                            continue
                        b = float(_num(p, 'beat', default=-1) or -1)
                        if not (seg_start <= b < seg_end):
                            continue
                        v = float(_num(p, 'value', default=0) or 0)
                        if abbr == 'DYN':
                            v = round(v * 2.4) - 240
                        pts.append((beat_to_tick(b - seg_start), int(round(v))))
                    if not pts:
                        continue
                    pts.sort()
                    part_curves[ustx_abbr] = pts
                for ustx_abbr, pts in part_curves.items():
                    desc = project.expressions.get(ustx_abbr)
                    part.curves.append(UCurve(xs=[p[0] for p in pts], ys=[p[1] for p in pts],
                                              abbr=ustx_abbr, descriptor=desc))
                # ---- 轨级 pitchCurve → 段内 pitd 曲线（音分直传；上游 PIT 泳道同款语义）
                pitd_desc = project.expressions.get('pitd')
                pitd_pts = []
                if pitd_desc is not None:
                    for p in pitch_curve:
                        if not isinstance(p, dict):
                            continue
                        b = float(_num(p, 'beat', default=-1) or -1)
                        if not (seg_start <= b < seg_end):
                            continue
                        pitd_pts.append((beat_to_tick(b - seg_start), int(round(float(_num(p, 'cents', default=0) or 0)))))
                if pitd_desc is not None and pitd_pts:
                    pitd_pts.sort()
                    part.curves.append(UCurve(xs=[p[0] for p in pitd_pts], ys=[p[1] for p in pitd_pts],
                                              abbr='pitd', descriptor=pitd_desc))
                end_tick = max((n.position + n.duration for n in part.notes), default=0)
                part.duration = end_tick
                tracks.append(ut)
                parts.append(part)
        elif kind == 'audio':
            ut = UTrack(
                singer='',
                track_name=str(t.get('name') or ('Audio %d' % (ti + 1))),
                renderer_settings=URenderSettings(renderer='usynth'),
                mute=bool(t.get('muted')),
                volume=_clamp(float(_num(t, 'gainDb', default=0) or 0), -60, 24),
            )
            audio = t.get('audio') or {}
            file_name = os.path.basename(str(audio.get('fileName') or 'audio.wav'))
            part = UWavePart(track_no=len(tracks), position=0,
                             name=str(t.get('name') or file_name),
                             relative_path='',          # 拷完伴奏后回填
                             file_duration_ms=max(0.0, float(_num(audio, 'durationMs', default=0) or 0)),
                             skip=max(0, int(_num(audio, 'skip', default=0) or 0)),
                             trim=max(0, int(_num(audio, 'trim', default=0) or 0)),
                             fadein=max(0, int(_num(audio, 'fadeIn', default=0) or 0)),
                             fadeout=max(0, int(_num(audio, 'fadeOut', default=0) or 0)))
            tracks.append(ut)
            parts.append(part)
            src = audio_by_asset.get(str(audio.get('asset') or '')) or {}
            src_path = str(src.get('srcPath') or '')
            if src_path and os.path.isfile(src_path):
                parts[-1]._pending_src = src_path        # runtime 标记，见下
                parts[-1]._pending_name = file_name
            else:
                warnings.append('伴奏「%s」源文件读不到，未随 .ustx 导出' % file_name)
        else:
            continue

    # ---- 伴奏拷贝：<ustx 名>_assets/<fileName>，relative_path 用正斜杠（跨平台约定）
    out_dir = os.path.dirname(os.path.abspath(out_path))
    base = os.path.splitext(os.path.basename(out_path))[0]
    asset_dir = os.path.join(out_dir, base + '_assets')
    rel_dir = base + '_assets'
    for p in parts:
        src = getattr(p, '_pending_src', None)
        if not src:
            continue
        try:
            os.makedirs(asset_dir, exist_ok=True)
            dest = os.path.join(asset_dir, p._pending_name)
            shutil.copy2(src, dest)
            p.relative_path = rel_dir + '/' + p._pending_name
        except Exception as e:                                      # noqa: BLE001
            warnings.append('伴奏「%s」复制失败：%s' % (p._pending_name, e))
        finally:
            del p._pending_src
            del p._pending_name

    project.tracks = tracks
    project.parts = parts
    ustx_format.save(out_path, project)
    return warnings


# ================================================================ CLI

def _read_arg_value(v):
    """`@file` 约定：参数值从文件读（避免 Windows 32K 命令行上限）。"""
    if v and v.startswith('@'):
        with open(v[1:], 'r', encoding='utf-8') as f:
            return f.read()
    return v


def main():
    parser = argparse.ArgumentParser(prog='engine_ustx.py',
                                     description='OpenUtau .ustx ⇄ FuFumidi 工程互转')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_imp = sub.add_parser('import', help='读 .ustx → 写交换 JSON')
    p_imp.add_argument('--in', dest='src', required=True, help='.ustx 路径')
    p_imp.add_argument('--out', dest='out', required=True, help='交换 JSON 输出路径')

    p_exp = sub.add_parser('export', help='读交换 JSON → 写 .ustx')
    p_exp.add_argument('--project', dest='project', required=True,
                       help='交换 JSON（支持 @file）')
    p_exp.add_argument('--out', dest='out', required=True, help='.ustx 输出路径')

    args = parser.parse_args()
    try:
        if args.cmd == 'import':
            data, resolved, warnings = import_ustx(args.src)
            out_path = args.out
            with open(out_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False)
            emit_result({'ok': True, 'jsonPath': out_path, 'resolved': resolved,
                         'warnings': warnings, 'version': VERSION})
        else:
            payload = json.loads(_read_arg_value(args.project))
            warnings = export_ustx(payload, args.out)
            emit_result({'ok': True, 'outPath': args.out, 'warnings': warnings,
                         'version': VERSION})
    except Exception as e:                                          # noqa: BLE001
        warn(traceback.format_exc())
        emit_result({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})


if __name__ == '__main__':
    main()
