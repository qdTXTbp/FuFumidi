# -*- coding: utf-8 -*-
"""验证 `engine_openutau.py` 能真的渲染出声（应用侧可用性门禁）。

造一个**真实的 UTAU 声库目录**（character.txt + oto.ini + 300Hz 正弦 wav），
用子进程按应用真实的调用方式跑一遍，然后检查输出 WAV：
  · 有样本、不静音
  · 主频 ≈ 440Hz（源 300Hz、tone 69）→ 证明**变调真的生效**
  · 时长与音符数吻合
"""

import hashlib
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import wave

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
SCRIPT = os.path.join(ENGINE, 'engine_openutau.py')
SR = 44100

_PASS, _FAIL = [], []


def check(label, cond, detail=''):
    (_PASS if cond else _FAIL).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + str(detail)) if (detail and not cond) else ''))


def write_wav(path, samples, sr=SR):
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(b''.join(struct.pack('<h', max(-32768, min(32767, int(v * 32767))))
                                    for v in samples))


def read_wav(path):
    with wave.open(path, 'rb') as w:
        n = w.getnframes()
        raw = w.readframes(n)
    return [struct.unpack('<h', raw[i:i + 2])[0] / 32768.0 for i in range(0, len(raw), 2)]


def dominant_hz(samples, sr=SR):
    """主频估计（**自相关法**）。

    ★ 不用过零率：UTAU 的音素有很强的起音/衰减包络，过零率会把包络形状算进频率里
    （实测同一段音频过零率给 310Hz、自相关给 441Hz，而真值就是 440Hz）。
    自相关对直流偏置与包络都不敏感。
    """
    if len(samples) < 4000:
        return None
    mean = sum(samples) / float(len(samples))
    seg = [v - mean for v in samples[len(samples) // 4: len(samples) * 3 // 4]]
    lo, hi = int(sr // 600.0), int(sr // 80.0)     # 80Hz ~ 600Hz
    best_score, best_lag = 0.0, 0
    for lag in range(lo, hi):
        s = 0.0
        for i in range(0, len(seg) - lag, 7):
            s += seg[i] * seg[i + lag]
        if s > best_score:
            best_score, best_lag = s, lag
    return (sr / float(best_lag)) if best_lag else None


def build_voicebank(root):
    vb = os.path.join(root, 'TestVB')
    os.makedirs(os.path.join(vb, 'wav'), exist_ok=True)
    with open(os.path.join(vb, 'character.txt'), 'w', encoding='utf-8') as f:
        f.write('name=TestVB\nauthor=FuFumidi\n')
    # 300Hz 正弦，按 1 个八度切片
    base = [0.5 * math.sin(2 * math.pi * 300 * i / SR) for i in range(int(SR * 0.5))]
    for tone in range(48, 73):
        write_wav(os.path.join(vb, 'wav', 'a%d.wav' % tone), base)
    # oto.ini 的行格式：<wav>=<alias>,<offset>,<consonant>,<cutoff>,<preutter>,<overlap>
    # ★ 别名**自带音高**（`a69`）——OpenUTAU 的 `TryGetMappedOto` 是「精确别名 / subbank 映射」，
    #   不会自动把音高拼到别名后面（那是 UTAU 音源文件的命名约定，不是 oto 表的解析规则）。
    lines = ['[oto.ini]']
    for tone in range(48, 73):
        lines.append('wav/a%d.wav=a%d,0,0,0,0,0' % (tone, tone))
    with open(os.path.join(vb, 'oto.ini'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')
    return vb


def run(args):
    p = subprocess.run([sys.executable, SCRIPT] + args, capture_output=True, text=True)
    out = None
    for line in p.stdout.splitlines():
        if line.startswith('###RESULT '):
            out = json.loads(line[len('###RESULT '):])
    return out, p.stdout, p.stderr, p.returncode


def main():
    root = tempfile.mkdtemp(prefix='fufumidi-ou-')
    try:
        vb = build_voicebank(root)
        print('--- probe：只加载声库 ---')
        res, out, err, code = run(['probe', '--voicebank', vb])
        check('probe 返回 ok', bool(res and res.get('ok')), res or err)
        if res and res.get('ok'):
            check('probe: 读到 25 个 oto 条目', res.get('oto_count') == 25, res)
            check('probe: 歌手名取自 character.txt', res.get('name') == 'TestVB', res)

        print('--- render-track：按应用真实方式渲染 ---')
        notes = [
            {'startBeat': 0.0, 'durBeat': 1.0, 'pitch': 69, 'lyric': 'a69'},
            {'startBeat': 1.0, 'durBeat': 1.0, 'pitch': 69, 'lyric': 'a69'},
            {'startBeat': 2.0, 'durBeat': 1.0, 'pitch': 69, 'lyric': 'a69'},
            {'startBeat': 3.0, 'durBeat': 1.0, 'pitch': 69, 'lyric': 'a69'},
        ]
        notes_json = os.path.join(root, 'notes.json')
        with open(notes_json, 'w', encoding='utf-8') as f:
            json.dump(notes, f)
        wav_out = os.path.join(root, 'out.wav')
        res2, out2, err2, code2 = run([
            'render-track', '--voicebank', vb, '--notes', '@' + notes_json,
            '--sample-note', 'C4', '--out', wav_out, '--tpb', '480', '--bpm', '120'])

        if not (res2 and res2.get('ok')):
            detail = ('%s\n--- stderr ---\n%s' % (res2, (err2 or '')[-1500:]))
            check('render-track 返回 ok', False, detail)
            print('\n结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
            return 1
        check('render-track 返回 ok', True)
        check('输出 WAV 已落盘', os.path.isfile(wav_out), wav_out)
        check('音符数 / 乐句数被回报', res2.get('note_count') == 4 and res2.get('phrase_count', 0) >= 1,
              res2)

        samples = read_wav(wav_out)
        peak = max((abs(v) for v in samples), default=0.0)
        check('输出非空样本', len(samples) > 0, len(samples))
        check('输出不静音', peak > 0.01, 'peak=%.4f' % peak)
        dur_s = len(samples) / float(SR)
        check('时长与 4 拍@120BPM 吻合（2.0s 附近，允许包络尾巴）',
              1.5 <= dur_s <= 4.5, '%.2fs' % dur_s)

        hz = dominant_hz(samples)
        check('★ 主频 ≈ 440Hz（源 300Hz → 变调真生效，±10%）',
              hz is not None and abs(hz - 440.0) < 44.0, '%.1f Hz' % (hz or 0.0))

        print('--- 进度事件 ---')
        check('stdout 有 ###PROG 进度事件', '###PROG' in out2)
        check('stdout 只有 ###RESULT/###PROG 两种前缀（主进程靠这个解析）',
              all(l.startswith('###RESULT') or l.startswith('###PROG') or not l.strip()
                  for l in out2.splitlines()), out2[:300])

        print('--- 音素化器缺失时的回退（老声库没有音素化器是很常见的）---')
        res3, out3, err3, _ = run([
            'render-track', '--voicebank', vb, '--notes', '@' + notes_json,
            '--out', os.path.join(root, 'out2.wav'), '--phonemizer', 'none'])
        check('phonemizer=none（别名直查）也能出声', bool(res3 and res3.get('ok')), res3 or err3[-400:])
        if res3 and res3.get('ok'):
            s2 = read_wav(os.path.join(root, 'out2.wav'))
            check('别名直查路径的输出同样不静音',
                  max((abs(v) for v in s2), default=0.0) > 0.01)

        print('--- 应用真实载荷形态（UtauRender.renderPayload 的字段）---')
        app_notes = [
            {'lyric': 'a69', 'note': 'C4' if False else 'A4', 'length_ms': 500},
            {'lyric': 'a69', 'note': 'A4', 'length_ms': 500, 'velocity': 90, 'volume': 100},
            {'lyric': 'a69', 'note': 'A4', 'length_ms': 500, 'pitch_cents': 0},
        ]
        app_json = os.path.join(root, 'app_notes.json')
        with open(app_json, 'w', encoding='utf-8') as f:
            json.dump(app_notes, f)
        app_out = os.path.join(root, 'app.wav')
        res5, out5, err5, _ = run([
            'render-track', '--voicebank', vb, '--notes', '@' + app_json,
            '--out', app_out, '--bpm', '120'])
        check('应用载荷（note 音名 + length_ms + 无起点顺序累加）能渲染',
              bool(res5 and res5.get('ok')), res5 or err5[-600:])
        if res5 and res5.get('ok'):
            s5 = read_wav(app_out)
            # A4 = 69 → 440Hz；3 个音符各 500ms → 约 1.5s
            check('应用载荷输出的时长 ≈ 1.5s（0.5s × 3）',
                  1.0 <= len(s5) / float(SR) <= 2.6, '%.2fs' % (len(s5) / float(SR)))
            hz5 = dominant_hz(s5)
            check('应用载荷输出主频 ≈ 440Hz（A4）',
                  hz5 is not None and abs(hz5 - 440.0) < 44.0, '%.1f Hz' % (hz5 or 0.0))

        print('--- 错误路径：歌词查不到别名 ---')
        bad = [{'startBeat': 0.0, 'durBeat': 1.0, 'pitch': 69, 'lyric': '不存在的别名'}]
        bad_json = os.path.join(root, 'bad.json')
        with open(bad_json, 'w', encoding='utf-8') as f:
            json.dump(bad, f)
        res4, out4, err4, _ = run([
            'render-track', '--voicebank', vb, '--notes', '@' + bad_json,
            '--out', os.path.join(root, 'out3.wav')])
        check('歌词未命中时不静默成功（要么 ok=false，要么带明确 warning）',
              (not (res4 and res4.get('ok'))) or bool(res4.get('warnings')),
              res4)
    finally:
        shutil.rmtree(root, ignore_errors=True)

    print()
    print('结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
    for f in _FAIL:
        print('  FAILED:', f)
    return 1 if _FAIL else 0


if __name__ == '__main__':
    sys.exit(main())
