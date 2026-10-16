# -*- coding: utf-8 -*-
"""`--renderer` 的接线回归（WP4-5 的「最后一跳」）。

背景：往 `RENDERER_OPTIONS` 加 `WORLDLINE-R1.1` **不等于**用户能选到它 ——
应用这条链（`engine_openutau.render_track`）原来把渲染器**硬编码**成 `ClassicRenderer()`，
而 `WorldlineRenderer`（v10 / v11 / v20 全在它里面）**全仓零调用方**。

本文件钉住「引擎入口真的认这个参数」，免得它哪天又被硬编码回去而没人发现。
"""
import json
import os
import struct
import sys
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
for _p in (ENGINE, HERE):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from test_engine_openutau_cli import build_voicebank, run  # noqa: E402

NOTES = [{'startBeat': float(i), 'durBeat': 1.0, 'pitch': 69, 'lyric': 'a69'}
         for i in range(4)]


def _notes_file(root):
    p = os.path.join(root, 'notes.json')
    with open(p, 'w', encoding='utf-8') as f:
        json.dump(NOTES, f)
    return p


def _peak(path):
    with wave.open(path, 'rb') as w:
        raw = w.readframes(w.getnframes())
    xs = [struct.unpack('<h', raw[i:i + 2])[0] / 32768.0 for i in range(0, len(raw), 2)]
    return max((abs(v) for v in xs), default=0.0)


def test_unknown_renderer_is_rejected(tmp_path):
    """写错渲染器名必须**明确报错并列出可选值**，不许悄悄回落到 CLASSIC。"""
    root = str(tmp_path)
    vb = build_voicebank(root)
    res, out, err, _ = run(['render-track', '--voicebank', vb,
                            '--notes', '@' + _notes_file(root),
                            '--out', os.path.join(root, 'x.wav'),
                            '--renderer', 'WORLDLINE-BOGUS'])
    assert not (res and res.get('ok')), res
    msg = str((res or {}).get('error') or '') + out + err
    assert '未知渲染器' in msg, msg[-600:]
    assert 'WORLDLINE-R1.1' in msg, '报错要列出可选值，否则用户不知道该填什么'


def test_classic_is_the_default_and_unchanged(tmp_path):
    """不传 `--renderer` 时行为与以前**完全一致**（CLASSIC），且在结果里回显。"""
    root = str(tmp_path)
    vb = build_voicebank(root)
    res, out, err, _ = run(['render-track', '--voicebank', vb,
                            '--notes', '@' + _notes_file(root),
                            '--out', os.path.join(root, 'c.wav'),
                            '--tpb', '480', '--bpm', '120'])
    assert res and res.get('ok'), (res, (err or '')[-600:])
    assert res.get('renderer') == 'CLASSIC', res
    assert _peak(os.path.join(root, 'c.wav')) > 1e-3, '不该出静音'


def test_worldline_renderer_is_reachable(tmp_path):
    """★ 核心：`--renderer WORLDLINE-R` 必须真的走 `WorldlineRenderer`。

    原生库找不到时（非 Windows 或未随包分发）**允许失败**，但报错必须能看出是
    **Worldline 这一侧**的问题 —— 不能是「未知渲染器」，更不能静默回落成 CLASSIC。
    否则这条接线又会被悄悄改回去而没人发现。
    """
    root = str(tmp_path)
    vb = build_voicebank(root)
    out_wav = os.path.join(root, 'w.wav')
    res, out, err, _ = run(['render-track', '--voicebank', vb,
                            '--notes', '@' + _notes_file(root),
                            '--out', out_wav, '--renderer', 'WORLDLINE-R'])
    if res and res.get('ok'):
        assert res.get('renderer') == 'WORLDLINE-R', res
        assert _peak(out_wav) > 1e-3, '出了静音'
        return
    msg = str((res or {}).get('error') or '') + out + err
    assert 'worldline' in msg.lower(), \
        '失败原因必须指向 Worldline（原生库/依赖），而不是别的：%s' % msg[-500:]
