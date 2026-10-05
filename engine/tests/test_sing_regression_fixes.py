# -*- coding: utf-8 -*-
"""调教链路的回归测试（2026-10-06 修的五个 bug，一个都别再回来）。

对应实测现场：对 `烦恼歌.mid` 做调教时依次撞上 ——
  1. UTAU 回落引擎不认拍系音符、也不认 `--bpm`（`KeyError: note` / argparse 报错）；
  2. 没有 character.txt 的声库（HowHow_CV）在 OpenUTAU 引擎下整库不可用；
  3. oto.ini 空别名回退成 `a.wav` → 界面把整轨歌词判成"不在别名表里"；
  4. 中文声库 + 汉字歌词 → DS 引擎音素化产出 0（g2p 只认拼音）；
  5. `render` 不认 `--language`，多语声库永远按 zh 走。
"""
import os
import subprocess
import sys
import wave

import numpy as np
import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PY = sys.executable


# ---------------------------------------------------------------- 1. 拍系音符

def test_normalize_track_notes_accepts_beat_schema():
    from engine_utau import normalize_track_notes, midi_to_note_name
    assert midi_to_note_name(60) == 'C4'
    assert midi_to_note_name(69) == 'A4'
    notes, warns = normalize_track_notes([
        {'lyric': 'bu', 'pitch': 60, 'startBeat': 0, 'durBeat': 1,
         'vibrato': True, 'vibDepth': 30, 'vibFreq': 6.0, 'vibFade': 100},
        {'lyric': 'ai', 'pitch': 62, 'startBeat': 1, 'durBeat': 0.5, 'vibrato': False},
    ], 120.0)
    assert notes[0]['note'] == 'C4' and notes[1]['note'] == 'D4'
    assert abs(notes[0]['length_ms'] - 500.0) < 1e-6      # 1 拍 @120bpm
    assert abs(notes[1]['length_ms'] - 250.0) < 1e-6      # 0.5 拍
    assert notes[0]['vibrato'] == {'depth_cent': 30.0, 'freq_hz': 6.0, 'fade_ms': 100.0}
    assert notes[1]['vibrato'] is None
    assert warns and 'startBeat' in warns[0]               # 位置被忽略要说清楚


def test_normalize_track_notes_keeps_native_schema():
    from engine_utau import normalize_track_notes
    notes, warns = normalize_track_notes([{'lyric': 'a', 'note': 'C4', 'length_ms': 300}])
    assert notes[0]['note'] == 'C4' and notes[0]['length_ms'] == 300 and not warns


def test_legacy_render_track_cli_accepts_bpm_and_beat_notes(tmp_path):
    """回落引擎（legacy）必须能吃下前端真实载荷：拍系 + --bpm。"""
    from test_singing_adapters import make_voicebank
    vb = make_voicebank(str(tmp_path / 'vb'))
    notes = tmp_path / 'notes.json'
    notes.write_text('[{"lyric": "a", "pitch": 60, "startBeat": 0, "durBeat": 1}]',
                     encoding='utf-8')
    out = tmp_path / 'out.wav'
    r = subprocess.run([PY, os.path.join(ENGINE, 'engine_utau.py'), 'render-track',
                        '--voicebank', vb, '--notes', '@' + str(notes),
                        '--sample-note', 'C4', '--bpm', '96', '--out', str(out)],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    assert r.returncode == 0, r.stdout + r.stderr
    assert '"ok": true' in r.stdout, r.stdout
    assert out.is_file() and out.stat().st_size > 1000


# ---------------------------------------------------------------- 2. 空别名

def test_oto_empty_alias_falls_back_to_bare_filename(tmp_path):
    from engine_utau import parse_oto_ini
    wav = tmp_path / 'a.wav'
    with wave.open(str(wav), 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(44100)
        w.writeframes(np.zeros(4410, dtype=np.int16).tobytes())
    (tmp_path / 'oto.ini').write_text('a.wav=,0,50,100,20,10\n', encoding='utf-8')
    by_alias, entries = parse_oto_ini(str(tmp_path / 'oto.ini'))
    assert entries and entries[0].alias == 'a', entries[0].alias
    assert 'a' in by_alias and 'a.wav' not in by_alias


# ---------------------------------------------------------------- 3. 无 character.txt

def test_openutau_loader_accepts_bank_without_character_txt(tmp_path):
    """没有 character.txt 的声库不该整库不可用（HowHow_CV 就是这种）。"""
    from test_singing_adapters import make_voicebank
    from singing.openutau.classic import VoicebankLoader
    from singing.openutau.oto import Voicebank
    vb_dir = make_voicebank(str(tmp_path / 'vb'))
    char = os.path.join(vb_dir, 'character.txt')
    if os.path.isfile(char):
        os.remove(char)
    bank = Voicebank()
    bank.base_path = vb_dir
    bank.file = char                      # 文件不存在：loader 必须兜住
    VoicebankLoader.load_info(bank, char, vb_dir)
    VoicebankLoader.load_subbanks(bank)
    VoicebankLoader.load_oto_sets(bank, vb_dir)
    assert bank.oto_sets, 'oto 表为空 —— 又回到 AttributeError 那条老路'
    assert bank.id, 'id 为空会让 resampler_item 在 singer.id.encode() 处崩'
    assert bank.text_file_encoding, '编码必须兜底成具体值，不能是 None'


# ---------------------------------------------------------------- 4. 汉字 → 拼音

def test_ds_get_symbols_romanizes_hanzi():
    """DS 中文词典的 grapheme 是拼音，汉字必须先转拼音。"""
    from singing.openutau.g2p.dictionary import G2pDictionary
    from diffsinger.g2p import get_symbols
    b = G2pDictionary.new_builder()
    # ★ 先登记符号再写条目：`add_entry` 在**写入时**就按已登记符号过滤（照搬 C# 的语义）
    for py in ('bu', 'ai', 'de'):
        b.add_symbol('zh/' + py, True)
    b.add_symbol('SP', True)
    b.add_symbol('AP', True)
    for py in ('bu', 'ai', 'de'):
        b.add_entry(py, ['zh/' + py])
    g2p = b.build()
    tokens = {'zh/bu': 1, 'zh/ai': 2, 'zh/de': 3, 'SP': 4, 'AP': 5}
    syms, rejected = get_symbols(g2p, tokens, '不', None, 'zh')
    assert syms == ['zh/bu'], (syms, rejected)
    syms2, _ = get_symbols(g2p, tokens, '爱', None, 'zh')
    assert syms2 == ['zh/ai'], syms2
    # 拼音歌词照旧直接命中
    syms3, _ = get_symbols(g2p, tokens, 'de', None, 'zh')
    assert syms3 == ['zh/de'], syms3


# ---------------------------------------------------------------- 5. --language

def test_diffsinger_render_cli_accepts_language_depth_steps():
    r = subprocess.run([PY, os.path.join(ENGINE, 'engine_diffsinger.py'), 'render', '--help'],
                       capture_output=True, text=True, encoding='utf-8', errors='replace')
    assert r.returncode == 0
    for flag in ('--language', '--depth', '--steps'):
        assert flag in r.stdout, flag


if __name__ == '__main__':
    sys.exit(pytest.main([__file__, '-q']))