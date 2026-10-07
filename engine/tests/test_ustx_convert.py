# -*- coding: utf-8 -*-
"""`.ustx` ⇄ 交换 JSON 互转测试（engine_ustx.py，OpenUtau 工程兼容）。

测的是「**语义往返一致**」，重点盯三处单位换算（改错任何一处都是静默坏数据）：
  1. tick ⇄ 拍：beat = tick / 480（resolution 固定，与 tempo 无关）
  2. 拍号：ustx 的 bar_position 是**小节号**（不是 tick）——往返后每个
     sigMap 点换算回小节号必须对得上
  3. 音高点：ustx y 是**半音**，应用侧 pitchCurve 是音分 → ×100

可离线运行：python engine/tests/test_ustx_convert.py
"""

import json
import os
import sys
import tempfile

import os as _os

HERE = _os.path.dirname(_os.path.abspath(__file__))
ENGINE = _os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

from singing.ustx import format as ustx_format          # noqa: E402
from singing.ustx.model import (                        # noqa: E402
    PitchPoint, UNote, UPitch, UTempo, UTimeSignature,
    UVibrato, UVoicePart, UWavePart,
)
import engine_ustx                                      # noqa: E402

PASS = 0


def check(cond, msg):
    global PASS
    if not cond:
        raise AssertionError(msg)
    PASS += 1
    print('  ok -', msg)


def build_fixture_ustx(path):
    """手造一个最小但全覆盖的 .ustx：
    * 两点变速（0 拍 120 / 8 拍 90）、两段拍号（第 0 小节 4/4、第 2 小节 3/4）
    * 一条声部轨：3 个音符（颤音 8 参 / pitch 多点 / pitchOffset 单点）
    * 一条伴奏轨：wave part 指向旁目录的音频文件
    """
    project = ustx_format.create()
    project.name = '互转测试曲'
    project.comment = 'fixture'
    project.key = 2
    project.tempos = [UTempo(position=0, bpm=120), UTempo(position=8 * 480, bpm=90)]
    project.time_signatures = [UTimeSignature(bar_position=0, beat_per_bar=4, beat_unit=4),
                               UTimeSignature(bar_position=2, beat_per_bar=3, beat_unit=4)]
    project.build_time_axis()

    track = project.tracks[0]
    track.singer = '测试声库'
    track.track_name = '主旋律'
    track.language = 'zh'
    part = UVoicePart(track_no=0, position=2 * 480, name='Part 1')  # part 带偏移
    # 音符 1：颤音（period=200ms → 5Hz；depth=40 音分；in=20/out=10；shift/drift/volLink 非默认值）
    n1 = UNote(position=0, duration=480, tone=60, lyric='あ')
    n1.vibrato = UVibrato(length=100, period=200, depth=40, vib_in=20, vib_out=10,
                          shift=25, drift=-30, vol_link=10)
    # 音符 2：pitch 多点（x=0 → y=0.5 半音；x=240 → y=-1 半音）
    n2 = UNote(position=480, duration=480, tone=62, lyric='か')
    n2.pitch = UPitch(data=[PitchPoint(x=0, y=0.5), PitchPoint(x=240, y=-1.0)])
    # 音符 3：单点 x=0 → 语义上是 pitchOffset（-0.25 半音 = -25 音分）
    n3 = UNote(position=960, duration=480, tone=64, lyric='ら')
    n3.pitch = UPitch(data=[PitchPoint(x=0, y=-0.25)])
    part.notes.extend([n1, n2, n3])
    # 曲线：dyn（0.1dB → 应用 0..100）/ pitd（音分 → pitchCurve）/ genc（直传 GEN）
    from singing.ustx.model import UCurve
    part.curves.append(UCurve(xs=[0, 5, 10], ys=[0, -120, -240], abbr='dyn',
                              descriptor=project.expressions.get('dyn')))
    part.curves.append(UCurve(xs=[0, 240], ys=[-100, 200], abbr='pitd',
                              descriptor=project.expressions.get('pitd')))
    part.curves.append(UCurve(xs=[0], ys=[30], abbr='genc',
                              descriptor=project.expressions.get('genc')))
    # 音素覆写（应被丢并计数）
    from singing.ustx.model import UPhonemeOverride
    n2.phoneme_overrides.append(UPhonemeOverride(index=0, phoneme='a'))
    project.parts.append(part)

    # 伴奏轨 + wave part
    audio_track = project.tracks[0]
    project.tracks.append(type(track)(track_name='伴奏'))
    wave = UWavePart(track_no=1, position=0, name='伴奏',
                     relative_path='assets/drums.wav', file_duration_ms=12345,
                     skip=100, trim=50, fadein=10, fadeout=20)
    project.parts.append(wave)

    # 造真实存在的音频文件（resolved 只收存在的文件）
    os.makedirs(os.path.join(os.path.dirname(path), 'assets'), exist_ok=True)
    with open(os.path.join(os.path.dirname(path), 'assets', 'drums.wav'), 'wb') as f:
        f.write(b'RIFF....WAVE')

    ustx_format.save(path, project)
    return project


def main():
    tmp = tempfile.mkdtemp(prefix='ustx_convert_')
    ustx_path = os.path.join(tmp, 'fixture.ustx')
    build_fixture_ustx(ustx_path)

    # ---------------- import：.ustx → 交换 JSON
    data, resolved, warnings = engine_ustx.import_ustx(ustx_path)
    print('[import]')
    check(data['format'] == 'fufumidi-song', '交换 JSON 是 fufumidi-song 形态')
    check(data['meta']['title'] == '互转测试曲', '工程名进 meta.title')
    check(data['keySf'] == 2, '调号往返')
    check(data['bpm'] == 120 and data['tempoMap'][0]['beat'] == 0, '变速首点 beat=0')
    check({'beat': 8, 'bpm': 90} in data['tempoMap'], '第二变速点 8 拍处 90')

    # 拍号：第 0 小节 4/4 在 beat 0；第 2 小节 3/4 = 0 + (4/4 每小节 4 拍)×2 = beat 8
    check(data['sigMap'][0] == {'beat': 0, 'num': 4, 'den': 4}, '拍号首段 4/4 @ beat 0')
    check(data['sigMap'][1] == {'beat': 8, 'num': 3, 'den': 4}, '3/4 从第 2 小节 = beat 8')

    # 音频轨：wave part → 独立音频轨 + resolved（存在的文件才收）
    audio_tracks = [t for t in data['tracks'] if t['kind'] == 'audio']
    check(len(audio_tracks) == 1, 'wave part 变成一条音频轨')
    at = audio_tracks[0]
    check(at['audio']['fileName'] == 'drums.wav', '音频文件名保留')
    check(at['audio']['skip'] == 100 and at['audio']['fadeOut'] == 20, 'skip/fadeout 保留')
    aid = at['audio']['asset']
    check(aid in resolved and resolved[aid].replace('\\', '/').endswith('assets/drums.wav'),
          'resolved 指向源文件（不进 JSON）')
    check('path' not in at['audio'] or not at['audio'].get('path'), '交换 JSON 不含绝对路径')

    # 声部轨：part 偏移 +2 拍
    voice = [t for t in data['tracks'] if t['kind'] == 'voice'][0]
    check(voice['singerName'] == '测试声库' and voice['language'] == 'zh', '声库名/语言进轨道')
    check(abs(voice['notes'][0]['startBeat'] - 2.0) < 1e-6, '音符起点含 part 偏移（2 拍）')
    n1, n2, n3 = voice['notes']
    check(n1['vibrato'] is True and abs(n1['vibFreq'] - 5.0) < 1e-6
          and abs(n1['vibDepth'] - 40.0) < 1e-6 and n1['vibFade'] == 20, '颤音 8→4 参（period→Hz、fade 取 max）')
    check(n1.get('vibIn') == 20 and n1.get('vibOut') == 10, 'in/out 分离进交换 JSON')
    check(n1.get('vibShift') == 25 and n1.get('vibDrift') == -30 and n1.get('vibVolLink') == 10,
          'shift/drift/volLink 进交换 JSON（不再丢弃）')
    check(any(abs(p['beat'] - 3.0) < 1e-6 and abs(p['cents'] - 50.0) < 1e-6 for p in voice['pitchCurve']),
          'pitch 多点进轨道音分曲线（0.5 半音 = 50 音分 @ beat 3）')
    check(abs(n3.get('pitchOffset', 0) + 25.0) < 1e-6, '单点 x=0 识别为 pitchOffset（-0.25 半音 = -25 音分）')
    check(n2.get('pitchOffset') is None, '多点音符不产生 pitchOffset')
    # ---- UCurve 导入：pitd → pitchCurve；dyn/genc → track.curves（不再整条丢弃）
    check(any(abs(p['beat'] - 2.0) < 1e-6 and abs(p['cents'] + 100.0) < 1e-6 for p in voice['pitchCurve']),
          'pitd 曲线进轨道音分曲线（-100 音分 @ beat 2）')
    check(any(abs(p['beat'] - 2.5) < 1e-6 and abs(p['cents'] - 200.0) < 1e-6 for p in voice['pitchCurve']),
          'pitd 第二点（+200 音分 @ beat 2.5，x=240 tick）')
    vcurves = {c['abbr']: c for c in (voice.get('curves') or [])}
    check('DYN' in vcurves and 'GEN' in vcurves, 'dyn/genc 曲线进轨道 curves')
    dyn_pts = vcurves.get('DYN', {}).get('points', [])
    check(len(dyn_pts) == 3 and abs(dyn_pts[0]['value'] - 100.0) < 1e-6
          and abs(dyn_pts[1]['value'] - 50.0) < 1e-6 and abs(dyn_pts[2]['value']) < 1e-6,
          'dyn 值域转换（0/-120/-240 0.1dB → 100/50/0）')
    gen_pts = vcurves.get('GEN', {}).get('points', [])
    check(len(gen_pts) == 1 and abs(gen_pts[0]['value'] - 30.0) < 1e-6, 'genc 直传 GEN')
    joined = ' '.join(warnings)
    check('音素' in joined, '音素级参数仍进 warnings')
    check('曲线' not in joined, '支持的曲线（pitd/dyn/genc）不再报有损')

    # ---------------- export：交换 JSON → .ustx → load 回读
    print('[export]')
    out_path = os.path.join(tmp, 'roundtrip.ustx')
    # 音频轨的 asset 要能对上 audioFiles（模拟主进程组装请求，id = asset）
    payload = {
        'project': data,
        'audioFiles': [{'id': aid, 'srcPath': resolved[aid], 'fileName': 'drums.wav'}],
    }
    warnings2 = engine_ustx.export_ustx(payload, out_path)
    back = ustx_format.load(out_path)

    check(abs(back.tempos[0].bpm - 120) < 1e-6, '变速首点 120')
    check(len(back.tempos) == 2 and abs(back.tempos[1].bpm - 90) < 1e-6, '第二变速点 90')
    # 拍号往返：bar_position 回到「小节号」语义
    sigs = sorted(back.time_signatures, key=lambda s: s.bar_position)
    check(sigs[0].bar_position == 0 and sigs[0].beat_per_bar == 4, '第 0 小节 4/4')
    check(sigs[1].beat_per_bar == 3 and sigs[1].bar_position == 2, '3/4 回到第 2 小节（beat 8 反推）')

    bpart = [p for p in back.parts if isinstance(p, UVoicePart)][0]
    bn = bpart.notes
    check(len(back.parts) == 2, '片段数 = 1 voice + 1 wave')
    # partStarts=[2.0]（import 的段起点）→ part.position=2 拍、音符相对段起点
    check(bpart.position == 2 * 480, 'part.position = 段起点（2 拍 × 480）')
    check(len(bn) == 3, '3 个音符往返')
    check(bn[0].position == 0 and bn[0].duration == 480 and bn[0].tone == 60, '音符 1 相对段起点/时长/音高')
    check(bn[0].lyric == 'あ', '歌词保留')
    check(bn[0].vibrato is not None and abs(bn[0].vibrato.period - 200) < 1e-6
          and abs(bn[0].vibrato.depth - 40) < 1e-6, '颤音往返（5Hz → 200ms；depth 40）')
    check(abs(bn[0].vibrato.shift - 25) < 1e-6 and abs(bn[0].vibrato.drift + 30) < 1e-6
          and abs(bn[0].vibrato.vol_link - 10) < 1e-6, 'shift/drift/volLink 完整往返')
    check(abs(bn[0].vibrato.vib_in - 20) < 1e-6 and abs(bn[0].vibrato.vib_out - 10) < 1e-6,
          'in/out 分离往返')
    # 音高多点：beat 3 → x=0，y=0.5 半音
    pts = bn[1].pitch.data
    check(len(pts) == 2 and abs(pts[1].y + 1.0) < 1e-6 and pts[1].x == 240, 'pitchCurve 切片回 UPitch（半音单位）')
    check(abs(bn[2].pitch.data[0].y + 0.25) < 1e-6, 'pitchOffset 回 UPitch 单点')
    # ---- curves 导出：轨级 curves/pitchCurve → 段内 part.curves（dyn 换算 / pitd 音分）
    bc = {c.abbr: c for c in bpart.curves}
    check('dyn' in bc and 'pitd' in bc and 'genc' in bc, 'dyn/pitd/genc 曲线导出进 part.curves')
    check(list(zip(bc['dyn'].xs, bc['dyn'].ys)) == [(0, 0), (5, -120), (10, -240)],
          'dyn 值域换算往返（100/50/0 → 0/-120/-240 0.1dB）')
    check(list(zip(bc['pitd'].xs, bc['pitd'].ys))[:2] == [(0, -100), (240, 200)],
          'pitd 音分直传（段内 tick 相对；后缀点来自 UPitch 切片，同属 pitchCurve）')
    check(list(zip(bc['genc'].xs, bc['genc'].ys)) == [(0, 30)], 'genc 直传')

    # ---- 多片段导出：partStarts 改成 [0, 3.5] → notes 按区间切两段
    data['tracks'][0]['partStarts'] = [0, 3.5]
    out2 = os.path.join(tmp, 'multi.ustx')
    engine_ustx.export_ustx(payload, out2)
    back2 = ustx_format.load(out2)
    vparts2 = sorted((p for p in back2.parts if isinstance(p, UVoicePart)), key=lambda p: p.position)
    check(len(vparts2) == 2 and vparts2[0].position == 0 and vparts2[1].position == round(3.5 * 480),
          'partStarts 两段 → 两个 UVoicePart（0 / 3.5 拍）')
    check(len(vparts2[0].notes) == 2 and len(vparts2[1].notes) == 1,
          '音符按区间归段（beat 2,3 → 段 1；beat 4 → 段 2）')
    check(vparts2[1].notes[0].position == 0.5 * 480, '段 2 音符相对段起点（beat 4 − 3.5 = 0.5 拍）')
    data['tracks'][0]['partStarts'] = [2.0]      # 恢复，别影响后面用例

    bwave = [p for p in back.parts if isinstance(p, UWavePart)][0]
    expected_rel = 'roundtrip_assets/drums.wav'
    check(bwave.relative_path == expected_rel, '伴奏拷到旁目录并写相对路径')
    check(os.path.isfile(os.path.join(tmp, expected_rel)), '伴奏文件真的复制过去了')
    check(abs(bwave.file_duration_ms - 12345) < 1e-6 and bwave.skip == 100, 'wave part 元数据往返')

    check(isinstance(json.dumps(data), str), '交换 JSON 可序列化')
    print('\nALL PASS (%d checks)' % PASS)


if __name__ == '__main__':
    main()
