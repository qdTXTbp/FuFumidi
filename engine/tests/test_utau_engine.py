# -*- coding: utf-8 -*-
"""engine_utau.py 的 M1 验证测试（pytest）。

覆盖：
- oto.ini 解析（含 Shift-JIS 编码）
- 音名→频率换算
- 单音节渲染链路：合成测试音源 → 变调 → 循环拉伸 → 输出 WAV
- 非法歌词的明确报错
"""
import json
import os
import subprocess
import sys

import numpy as np
import pytest

SR = 44100
ENGINE = os.path.join(os.path.dirname(__file__), "..", "engine_utau.py")
PY = sys.executable


# ---------------------------------------------------------------- 合成音源
def _synth_vowel(f0, dur_s, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(dur_s * SR)) / SR
    sig = np.zeros_like(t)
    for h in range(1, 7):
        sig += (1.0 / h ** 1.2) * np.sin(2 * np.pi * f0 * h * t)
    # 起音/释音包络
    env = np.clip(t / 0.03, 0, 1) * np.clip((dur_s - t) / 0.05, 0, 1)
    return (sig * env + 0.01 * rng.standard_normal(len(t))).astype(np.float32)


def _synth_consonant(dur_s, seed=1):
    rng = np.random.default_rng(seed)
    n = int(dur_s * SR)
    t = np.arange(n) / SR
    noise = rng.standard_normal(n)
    env = np.minimum(1.0, t / 0.01) * np.clip((dur_s - t) / 0.015, 0, 1)
    return (noise * env * 0.6).astype(np.float32)


def make_test_voicebank(vb_dir):
    """生成一个 CV 测试音源（录制音高 G3=196Hz），返回 None。

    采样结构：50ms 静音 + 40ms 辅音噪声 + 元音到 460ms 结束。
    oto.ini: offset=50, consonant=90, preutterance=85, overlap=25, blank=10
    """
    import soundfile as sf
    os.makedirs(vb_dir, exist_ok=True)
    vowels = {
        "か": (196.0, 0),
        "き": (196.0, 1),
        "く": (196.0, 2),
        "あ": (196.0, 3),
        "い": (196.0, 4),
    }
    oto_lines = []
    for kana, (f0, seed) in vowels.items():
        lead = np.zeros(int(0.050 * SR), dtype=np.float32)
        con = _synth_consonant(0.040, seed=seed)
        vow = _synth_vowel(f0, 0.370, seed=seed)
        wav = np.concatenate([lead, con, vow])
        sf.write(os.path.join(vb_dir, f"{kana}.wav"), wav, SR, subtype="PCM_16")
        # 别名与文件名相同
        oto_lines.append(f"{kana}.wav={kana},50,90,10,85,25")
    # 追加一行 Shift-JIS 编码的采样验证编码嗅探
    extra = np.zeros(int(0.2 * SR), dtype=np.float32)
    sf.write(os.path.join(vb_dir, "さ.wav"), extra, SR, subtype="PCM_16")
    oto_lines.append("さ.wav=さ,20,60,10,55,20")
    oto_path = os.path.join(vb_dir, "oto.ini")
    with open(oto_path, "wb") as f:
        f.write("\n".join(oto_lines).encode("utf-8"))
    return oto_path


def run_render(vb_dir, *args):
    cmd = [PY, os.path.abspath(ENGINE), "render",
           "--voicebank", vb_dir, *args]
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", cwd=os.path.dirname(ENGINE))
    result = None
    for line in (p.stdout or "").splitlines():
        if line.startswith("###RESULT "):
            result = json.loads(line[len("###RESULT "):])
    return p, result


# ---------------------------------------------------------------- 测试
def test_parse_oto_ini(tmp_path):
    from engine_utau import parse_oto_ini
    oto_path = make_test_voicebank(str(tmp_path / "vb"))
    by_alias, entries = parse_oto_ini(oto_path)
    assert len(entries) == 6
    ka = by_alias["か"]
    assert ka.filename == "か.wav"
    assert (ka.offset, ka.consonant, ka.blank, ka.preutterance, ka.overlap) == \
           (50, 90, 10, 85, 25)


def test_note_to_hz():
    from engine_utau import note_to_hz
    assert note_to_hz("C4") == pytest.approx(261.6256, rel=1e-3)
    assert note_to_hz("A4") == pytest.approx(440.0, rel=1e-3)
    assert note_to_hz("G3") == pytest.approx(196.0, rel=1e-3)
    assert note_to_hz("Bb3") == pytest.approx(233.0819, rel=1e-3)


def test_render_single_syllable(tmp_path):
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    out = str(tmp_path / "ka_C4.wav")
    p, result = run_render(vb_dir, "--lyric", "か", "--note", "C4",
                           "--length", "500", "--sample-note", "G3",
                           "--out", out)
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert result and result["ok"] is True, result
    assert os.path.isfile(out)

    import soundfile as sf
    data, sr = sf.read(out)
    assert sr == SR
    # 时长精确到目标长度（±8ms 容差）
    assert abs(len(data) / SR * 1000 - 500) < 8
    # 非静音
    rms = float(np.sqrt(np.mean(data.astype(np.float64) ** 2)))
    assert rms > 0.01
    # 无削波（PCM16 范围）
    assert np.max(np.abs(data)) <= 1.0


def test_render_pitch_difference(tmp_path):
    """同一音源升/降调渲染时长应一致，且输出不同。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    o_hi = str(tmp_path / "hi.wav")
    o_lo = str(tmp_path / "lo.wav")
    p1, r1 = run_render(vb_dir, "--lyric", "あ", "--note", "C4",
                        "--length", "400", "--sample-note", "G3", "--out", o_hi)
    p2, r2 = run_render(vb_dir, "--lyric", "あ", "--note", "C3",
                        "--length", "400", "--sample-note", "G3", "--out", o_lo)
    assert p1.returncode == 0 and p2.returncode == 0
    assert r1["duration_ms"] == r2["duration_ms"]
    import soundfile as sf
    a = sf.read(o_hi)[0]
    b = sf.read(o_lo)[0]
    assert len(a) == len(b)
    assert not np.allclose(a, b, atol=1e-4)


def test_render_unknown_lyric(tmp_path):
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    out = str(tmp_path / "x.wav")
    p, result = run_render(vb_dir, "--lyric", "不存在", "--note", "C4",
                           "--length", "300", "--out", out)
    assert p.returncode != 0
    assert result and result["ok"] is False
    assert "不存在" in result["error"]
    assert not os.path.exists(out)


def run_render_track(vb_dir, notes, *args):
    cmd = [PY, os.path.abspath(ENGINE), "render-track",
           "--voicebank", vb_dir, "--notes", json.dumps(notes, ensure_ascii=False), *args]
    p = subprocess.run(cmd, capture_output=True, text=True,
                       encoding="utf-8", cwd=os.path.dirname(ENGINE))
    result = None
    for line in (p.stdout or "").splitlines():
        if line.startswith("###RESULT "):
            result = json.loads(line[len("###RESULT "):])
    return p, result


# ---------------------------------------------------------------- M2 测试
def test_render_track_two_syllables(tmp_path):
    """多音节拼接：总时长 ≈ 各音长之和（扣重叠），非静音、无削波。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    out = str(tmp_path / "track.wav")
    notes = [
        {"lyric": "か", "note": "C4", "length_ms": 300},
        {"lyric": "い", "note": "D4", "length_ms": 300},
    ]
    p, result = run_render_track(vb_dir, notes, "--sample-note", "G3", "--out", out)
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert result and result["ok"] is True, result
    import soundfile as sf
    data, sr = sf.read(out)
    # 时长应大致为 600ms 减一次 preutterance/重叠（约 540ms 上下）
    assert 480 <= len(data) / sr * 1000 <= 620, len(data) / sr * 1000
    assert float(np.max(np.abs(data))) <= 1.0
    assert float(np.sqrt(np.mean(data.astype(np.float64) ** 2))) > 0.01
    assert not np.isnan(data).any()


def test_render_track_crossfade_no_silence_gap(tmp_path):
    """相邻音之间不应出现静音空洞（preutterance 前置辅音应衔接上）。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    out = str(tmp_path / "track2.wav")
    notes = [
        {"lyric": "か", "note": "C4", "length_ms": 200},
        {"lyric": "あ", "note": "C4", "length_ms": 200},
        {"lyric": "か", "note": "C4", "length_ms": 200},
    ]
    p, result = run_render_track(vb_dir, notes, "--sample-note", "G3", "--out", out)
    assert p.returncode == 0 and result["ok"] is True
    import soundfile as sf
    data, _ = sf.read(out)
    # 按 20ms 滑窗统计能量，静音窗口占比应很小
    win = 20 * 44100 // 1000
    n_wins = len(data) // win
    energies = [np.mean(data[i * win:(i + 1) * win] ** 2) for i in range(n_wins)]
    silent = sum(1 for e in energies if e < 1e-5)
    assert silent / n_wins < 0.1, f"静音窗口占比过高: {silent}/{n_wins}"


def test_velocity_changes_articulation(tmp_path):
    """子音速度改变辅音区时长，输出应不同。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    o1 = str(tmp_path / "v50.wav")
    o2 = str(tmp_path / "v200.wav")
    p1, r1 = run_render(vb_dir, "--lyric", "か", "--note", "C4",
                        "--length", "400", "--sample-note", "G3",
                        "--velocity", "50", "--out", o1)
    p2, r2 = run_render(vb_dir, "--lyric", "か", "--note", "C4",
                        "--length", "400", "--sample-note", "G3",
                        "--velocity", "200", "--out", o2)
    assert p1.returncode == 0 and p2.returncode == 0
    assert r1["duration_ms"] == r2["duration_ms"]
    import soundfile as sf
    a = sf.read(o1)[0]
    b = sf.read(o2)[0]
    assert len(a) == len(b)
    assert not np.allclose(a, b, atol=1e-3)


def test_vibrato_modulates_pitch(tmp_path):
    """颤音改变音高波形：有/无颤音输出不同，时长基本不变。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    o1 = str(tmp_path / "flat.wav")
    o2 = str(tmp_path / "vib.wav")
    p1, r1 = run_render(vb_dir, "--lyric", "あ", "--note", "C4",
                        "--length", "800", "--sample-note", "G3", "--out", o1)
    vib = '{"depth_cent": 50, "freq_hz": 5.5}'
    p2, r2 = run_render(vb_dir, "--lyric", "あ", "--note", "C4",
                        "--length", "800", "--sample-note", "G3",
                        "--vibrato", vib, "--out", o2)
    assert p1.returncode == 0 and p2.returncode == 0
    assert abs(r1["duration_ms"] - r2["duration_ms"]) <= 10
    import soundfile as sf
    a = sf.read(o1)[0]
    b = sf.read(o2)[0]
    assert not np.allclose(a, b, atol=1e-3)


def test_envelope_attack_starts_at_zero(tmp_path):
    """包络起音从 0 开始：attack_ms 足够长时开头应接近静音。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    from engine_utau import Voicebank, render_note, note_to_hz
    vb = Voicebank(vb_dir)
    entry = vb.get("あ")
    x = render_note(vb.load_sample(entry), entry,
                    note_to_hz("C4") / note_to_hz("G3"), 400, attack_ms=30)
    attack_n = int(30 * 44100 / 1000)
    assert abs(float(x[0])) < 1e-6
    assert float(np.max(np.abs(x[:attack_n]))) < float(np.max(np.abs(x)))


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
