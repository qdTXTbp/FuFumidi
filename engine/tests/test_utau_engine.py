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
    """未知歌词默认回退到首个原音并给出 warnings；--strict 时直接报错（v0.2.0）。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    out = str(tmp_path / "x.wav")
    p, result = run_render(vb_dir, "--lyric", "不存在", "--note", "C4",
                           "--length", "300", "--out", out)
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert result and result["ok"] is True, result
    assert any("不存在" in w for w in result.get("warnings", [])), result
    assert os.path.isfile(out)

    out2 = str(tmp_path / "y.wav")
    p2, r2 = run_render(vb_dir, "--lyric", "不存在", "--note", "C4",
                        "--length", "300", "--strict", "--out", out2)
    assert p2.returncode != 0
    assert r2 and r2["ok"] is False and "不存在" in r2["error"]
    assert not os.path.exists(out2)


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


# ---------------------------------------------------------------- P0-3 逐音符参数
def _f0_fft(x, sr=SR, lo=80.0, hi=600.0, t0=0.15, t1=0.45):
    """在指定时间窗内取 80-600Hz 的 FFT 峰值作为基频估计（测试音源一次谐波最强）。"""
    seg = np.asarray(x, dtype=np.float64)[int(t0 * sr):int(t1 * sr)]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    band = (freqs >= lo) & (freqs <= hi)
    return float(freqs[band][int(np.argmax(spec[band]))])


def _centroid(x, sr=SR):
    seg = np.asarray(x, dtype=np.float64)[int(0.15 * sr):int(0.45 * sr)]
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    return float((freqs * spec).sum() / max(1e-9, spec.sum()))


def _band_energy(x, lo, hi, sr=SR):
    seg = np.asarray(x, dtype=np.float64)[int(0.15 * sr):int(0.45 * sr)]
    spec = np.abs(np.fft.rfft(seg))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    band = (freqs >= lo) & (freqs <= hi)
    return float(np.sum(spec[band] ** 2))


def test_pitch_cents_shifts_f0(tmp_path):
    """音高偏差按音分折算：+100 音分抬高基频、-100 音分降低，时长不变。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    outs = {}
    for tag, cents in (("base", None), ("up", "100"), ("down", "-100")):
        path = str(tmp_path / f"{tag}.wav")
        args = ["--lyric", "あ", "--note", "C4", "--length", "600", "--sample-note", "G3"]
        if cents is not None:
            args += ["--pitch-cents", cents]
        p, r = run_render(vb_dir, *args, "--out", path)
        assert p.returncode == 0 and r["ok"] is True, (p.stdout, r)
        import soundfile as sf
        outs[tag] = (sf.read(path)[0], r["duration_ms"])
    import soundfile as sf  # noqa: F401
    f_base, f_up, f_down = (_f0_fft(v[0]) for v in outs.values())
    assert f_up == pytest.approx(f_base * 2 ** (100 / 1200), rel=0.03), (f_base, f_up)
    assert f_down == pytest.approx(f_base * 2 ** (-100 / 1200), rel=0.03), (f_base, f_down)
    assert len({v[1] for v in outs.values()}) == 1, outs


def test_gender_tilts_brightness(tmp_path):
    """性别参数改变频谱重心（>50 更亮、<50 更暗），且 50 = 默认不变。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    res = {}
    for tag, g in (("base", None), ("bright", "100"), ("dark", "0"), ("mid", "50")):
        path = str(tmp_path / f"g_{tag}.wav")
        args = ["--lyric", "あ", "--note", "C4", "--length", "600", "--sample-note", "G3"]
        if g is not None:
            args += ["--gender", g]
        p, r = run_render(vb_dir, *args, "--out", path)
        assert p.returncode == 0 and r["ok"] is True, (p.stdout, r)
        import soundfile as sf
        res[tag] = sf.read(path)[0]
    assert _centroid(res["bright"]) > _centroid(res["base"]) * 1.02
    assert _centroid(res["dark"]) < _centroid(res["base"]) * 0.98
    assert np.allclose(res["mid"], res["base"], atol=1e-6)
    # 峰值不超过数字上限（叠加式处理需做峰值保护）
    assert max(float(np.max(np.abs(x))) for x in res.values()) <= 1.0


def test_breath_adds_noise_band(tmp_path):
    """气声在元音段混入 2k-7k 噪声带，且不改变音高；同一输入结果可复现。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    o1 = str(tmp_path / "dry.wav")
    o2 = str(tmp_path / "breath.wav")
    o3 = str(tmp_path / "breath2.wav")
    base_args = ["--lyric", "あ", "--note", "C4", "--length", "600", "--sample-note", "G3"]
    p1, r1 = run_render(vb_dir, *base_args, "--out", o1)
    p2, r2 = run_render(vb_dir, *base_args, "--breath", "80", "--out", o2)
    p3, r3 = run_render(vb_dir, *base_args, "--breath", "80", "--out", o3)
    assert all(p.returncode == 0 for p in (p1, p2, p3))
    assert all(r["ok"] for r in (r1, r2, r3))
    import soundfile as sf
    a, b, c = sf.read(o1)[0], sf.read(o2)[0], sf.read(o3)[0]
    assert _band_energy(b, 2000, 7000) > _band_energy(a, 2000, 7000) * 1.5
    assert abs(_f0_fft(b) - _f0_fft(a)) < 5.0
    assert np.array_equal(b, c), "气声噪声应可复现（固定随机种子）"
    assert float(np.max(np.abs(b))) <= 1.0


def test_pitch_curve_raises_f0(tmp_path):
    """手绘音高曲线：全零曲线与不加曲线等价；上扬曲线让后半段基频升高。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    base_args = ["--lyric", "あ", "--note", "C4", "--length", "800", "--sample-note", "G3"]
    outs = {}
    cases = {
        "none": None,
        "zero": json.dumps([{"pos": 0, "cents": 0}, {"pos": 1, "cents": 0}]),
        "up": json.dumps([{"pos": 0, "cents": 0}, {"pos": 0.45, "cents": 0}, {"pos": 1, "cents": 1200}]),
    }
    for tag, curve in cases.items():
        path = str(tmp_path / f"c_{tag}.wav")
        args = list(base_args)
        if curve is not None:
            args += ["--pitch-curve", curve]
        p, r = run_render(vb_dir, *args, "--out", path)
        assert p.returncode == 0 and r["ok"] is True, (p.stdout, r)
        import soundfile as sf
        outs[tag] = (sf.read(path)[0], r["duration_ms"])
    assert outs["none"][1] == outs["up"][1] == outs["zero"][1]
    assert np.allclose(outs["zero"][0], outs["none"][0], atol=1e-6), "全零曲线应等同于不加曲线"
    # 前段（曲线接近 0）基频基本一致；后段（曲线升到 +1200 附近）明显更高
    assert abs(_f0_fft(outs["up"][0], t0=0.1, t1=0.2) - _f0_fft(outs["none"][0], t0=0.1, t1=0.2)) < 8
    f_up = _f0_fft(outs["up"][0], t0=0.62, t1=0.78)
    f_flat = _f0_fft(outs["none"][0], t0=0.62, t1=0.78)
    assert f_up > f_flat * 1.15, (f_flat, f_up)


def test_render_track_passes_note_params(tmp_path):
    """render-track 逐音符透传 pitch_cents / gender / breath：能渲染且输出不同。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    o1 = str(tmp_path / "t1.wav")
    o2 = str(tmp_path / "t2.wav")
    plain = [{"lyric": "か", "note": "C4", "length_ms": 300},
             {"lyric": "あ", "note": "D4", "length_ms": 300}]
    tuned = [dict(plain[0], pitch_cents=100.0, gender=90.0, breath=60.0), plain[1]]
    p1, r1 = run_render_track(vb_dir, plain, "--sample-note", "G3", "--out", o1)
    p2, r2 = run_render_track(vb_dir, tuned, "--sample-note", "G3", "--out", o2)
    assert p1.returncode == 0 and p2.returncode == 0, (p1.stdout, p2.stdout)
    assert r1["ok"] and r2["ok"]
    import soundfile as sf
    a, b = sf.read(o1)[0], sf.read(o2)[0]
    n = min(len(a), len(b))
    assert abs(len(a) - len(b)) / len(a) < 0.01
    assert not np.allclose(a[:n], b[:n], atol=1e-4)


def test_aliases_command(tmp_path):
    """aliases CLI：列出声库全部别名，并支持关键字过滤（P1-4 发音替换用）。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)

    def run_alias(*args):
        cmd = [PY, os.path.abspath(ENGINE), "aliases", "--voicebank", vb_dir, *args]
        p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                           cwd=os.path.dirname(ENGINE))
        result = None
        for line in (p.stdout or "").splitlines():
            if line.startswith("###RESULT "):
                result = json.loads(line[len("###RESULT "):])
        return p, result

    p1, r1 = run_alias()
    assert p1.returncode == 0 and r1["ok"] is True, (p1.stdout, r1)
    assert r1["total"] == 6 and r1["count"] == 6
    assert "か" in r1["aliases"] and "あ" in r1["aliases"]

    p2, r2 = run_alias("--query", "か")
    assert p2.returncode == 0 and r2["count"] == 1 and r2["aliases"] == ["か"]

    p3, r3 = run_alias("--limit", "2")
    assert r3["ok"] is True and len(r3["aliases"]) == 2 and r3["truncated"] is True


# ---------------------------------------------------------------- M3 测试
def _synth_utterance(sr=44100):
    """3 个音节（各 40ms 辅音 + 160ms 元音），间隔 150ms 静音。"""
    parts = []
    for seed in (0, 1, 2):
        con = _synth_consonant(0.04, seed=seed)
        vow = _synth_vowel(196.0, 0.16, seed=seed)
        parts.append(np.concatenate([con, vow]))
        if seed < 2:
            parts.append(np.zeros(int(0.15 * sr), dtype=np.float32))
    return np.concatenate(parts)


def test_split_syllables_three():
    from engine_utau import split_syllables
    sig = _synth_utterance()
    segs = split_syllables(sig, 44100, min_silence_ms=120,
                           min_syllable_ms=80, silence_db=-40)
    assert len(segs) == 3, segs
    starts = [s for s, _ in segs]
    ends = [e for _, e in segs]
    # 期望边界：0 / 350 / 700 ms 与 200 / 550 / 900 ms（±40ms 容差）
    for expect, got in zip([0, 350, 700], starts):
        assert abs(expect - got) <= 40, (expect, got)
    for expect, got in zip([200, 550, 900], ends):
        assert abs(expect - got) <= 40, (expect, got)


def test_split_syllables_merge_short_silence():
    """静音间隔小于阈值时应合并成一个音节。"""
    from engine_utau import split_syllables
    sig = _synth_utterance()
    segs = split_syllables(sig, 44100, min_silence_ms=300,
                           min_syllable_ms=80, silence_db=-40)
    assert len(segs) == 1, segs


def test_auto_oto_params_cv():
    from engine_utau import auto_oto_params
    con = _synth_consonant(0.040, seed=0)
    vow = _synth_vowel(196.0, 0.370, seed=0)
    lead = np.zeros(int(0.050 * 44100), dtype=np.float32)
    wav = np.concatenate([lead, con, vow])
    p = auto_oto_params(wav, 44100)
    assert 30 <= p["offset"] <= 55, p          # 前置静音(50ms)附近
    assert 5 <= p["consonant"] <= 90, p
    assert p["preutterance"] == p["consonant"]
    assert 5 <= p["blank"] <= 40, p            # 尾部静音(约10ms)附近
    assert p["overlap"] == min(30.0, p["preutterance"] * 0.3)


def test_segment_command(tmp_path):
    """segment CLI：切分并写出片段。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    import soundfile as sf
    inp = str(tmp_path / "utter.wav")
    sf.write(inp, _synth_utterance(), 44100, subtype="PCM_16")
    out_dir = str(tmp_path / "segs")
    p = subprocess.run([PY, os.path.abspath(ENGINE), "segment",
                        "--input", inp, "--out-dir", out_dir],
                       capture_output=True, text=True, encoding="utf-8",
                       cwd=os.path.dirname(ENGINE))
    result = None
    for line in (p.stdout or "").splitlines():
        if line.startswith("###RESULT "):
            result = json.loads(line[len("###RESULT "):])
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert result and result["ok"] is True, result
    assert result["count"] == 3
    assert len(result["files"]) == 3
    assert all(os.path.isfile(f) for f in result["files"])


def test_auto_oto_command(tmp_path):
    """auto-oto CLI：生成 oto.ini（UTF-8 与 Shift-JIS）。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    out = str(tmp_path / "oto.ini")
    p = subprocess.run([PY, os.path.abspath(ENGINE), "auto-oto",
                        "--voicebank", vb_dir, "--out", out,
                        "--encoding", "utf-8"],
                       capture_output=True, text=True, encoding="utf-8",
                       cwd=os.path.dirname(ENGINE))
    result = None
    for line in (p.stdout or "").splitlines():
        if line.startswith("###RESULT "):
            result = json.loads(line[len("###RESULT "):])
    assert p.returncode == 0, (p.stdout, p.stderr)
    assert result and result["ok"] is True, result
    assert result["count"] == 6
    assert os.path.isfile(out)
    with open(out, "r", encoding="utf-8") as fh:
        text = fh.read()
    assert "か.wav=か" in text
    assert len(text.splitlines()) == 6


# ---------------------------------------------------------------- v0.2.0 专业化
def _spec_centroid(x, sr=SR):
    """整段频谱重心（不依赖固定时间窗，适合变速后的片段）。"""
    seg = np.asarray(x, dtype=np.float64)
    if len(seg) < 64:
        return 0.0
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    return float((freqs * spec).sum() / max(1e-9, spec.sum()))


def _envelope_peak(x, lo=300.0, hi=3500.0, sr=SR, t0=0.10, t1=0.45):
    """频谱包络（平滑掉谐波结构）的峰值频率 —— 用来衡量共振峰位置。"""
    seg = np.asarray(x, dtype=np.float64)[int(t0 * sr):int(t1 * sr)]
    if len(seg) < 64:
        seg = np.asarray(x, dtype=np.float64)
    spec = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    freqs = np.fft.rfftfreq(len(seg), 1.0 / sr)
    df = freqs[1] - freqs[0]
    w = max(3, int(300.0 / max(df, 1e-9)))
    env = np.convolve(spec, np.ones(w) / w, mode="same")
    band = (freqs >= lo) & (freqs <= hi)
    return float(freqs[band][int(np.argmax(env[band]))])


def make_formant_voicebank(vb_dir, f0=196.0, formant=800.0):
    """带明确共振峰（默认 800Hz）的谐波音源：验证变调是否保住共振峰。"""
    import soundfile as sf
    os.makedirs(vb_dir, exist_ok=True)
    dur = 0.45
    t = np.arange(int(dur * SR)) / SR
    sig = np.zeros_like(t)
    for h in range(1, int(SR / 2 / 0.9 / f0)):
        f = f0 * h
        amp = np.exp(-0.5 * ((f - formant) / 380.0) ** 2) + 0.02 / h
        sig += amp * np.sin(2 * np.pi * f * t)
    env = np.clip(t / 0.02, 0, 1) * np.clip((dur - t) / 0.03, 0, 1)
    sf.write(os.path.join(vb_dir, "あ.wav"), (sig * env * 0.4).astype(np.float32), SR,
             subtype="PCM_16")
    with open(os.path.join(vb_dir, "oto.ini"), "wb") as fh:
        fh.write("あ.wav=あ,0,5,10,5,3\n".encode("utf-8"))
    return vb_dir


def test_parse_flags():
    """flags 解析：连写、正负号、夹紧、无参 flag、未知字母。"""
    from engine_utau import parse_flags
    values, given, unsupported = parse_flags("g-3B50Y90")
    assert values == {"g": -3.0, "B": 50.0, "Y": 90.0}, values
    assert given == ["g", "B", "Y"] and unsupported == []

    v2, _, _ = parse_flags("g999")
    assert v2["g"] == 100.0, v2          # 越界夹紧
    v3, g3, _ = parse_flags("N")
    assert v3 == {"N": None} and g3 == ["N"]
    _, _, un = parse_flags("g5WQ9")
    assert un == ["W"], un               # 未知字母被忽略，已知不支持项被记录
    v4, _, _ = parse_flags("")
    assert v4 == {}


def test_psola_duration_and_unit():
    """PSOLA/O LA 单元行为：变调不改变时长；OLA 伸缩保持频谱重心。"""
    from engine_utau import _ola_stretch, _pitch_resample, _psola_shift
    vow = _synth_vowel(196.0, 0.5, seed=7)
    for ratio in (1.5, 0.7):
        y = _psola_shift(vow, SR, ratio, 196.0)
        assert len(y) == len(vow), (ratio, len(y), len(vow))
        assert not np.isnan(y).any()

    noise = _synth_consonant(0.12, seed=3)
    base_c = _spec_centroid(noise)
    st = _ola_stretch(noise, SR, 2.0)
    rs = _pitch_resample(noise, 0.5)
    assert abs(len(st) - 2 * len(noise)) / (2 * len(noise)) < 0.05, len(st)
    assert abs(_spec_centroid(st) - base_c) / base_c < 0.15, "OLA 不应改变频谱重心"
    assert abs(_spec_centroid(rs) - base_c) / base_c > 0.30, "线性变速会把频谱整体搬走"


def test_psola_keeps_formant(tmp_path):
    """核心质量断言：变调 +7 半音时，PSOLA 保住共振峰，线性重采样把共振峰搬走。"""
    vb_dir = make_formant_voicebank(str(tmp_path / "vb"))
    args = ["--lyric", "あ", "--length", "600", "--sample-note", "G3"]
    outs = {}
    for tag, note, extra in (("base", "G3", []),
                             ("psola", "D4", []),
                             ("linear", "D4", ["--flags", "N"])):
        path = str(tmp_path / f"f_{tag}.wav")
        p, r = run_render(vb_dir, *args, "--note", note, *extra, "--out", path)
        assert p.returncode == 0 and r["ok"] is True, (p.stdout, r)
        import soundfile as sf
        outs[tag] = sf.read(path)[0]

    f_base = _f0_fft(outs["base"], lo=120, hi=400)
    f_ps = _f0_fft(outs["psola"], lo=150, hi=600)
    f_ln = _f0_fft(outs["linear"], lo=150, hi=600)
    assert f_ps == pytest.approx(f_base * 2 ** (7 / 12), rel=0.04), (f_base, f_ps)
    assert f_ln == pytest.approx(f_ps, rel=0.04), (f_ps, f_ln)

    pk_base = _envelope_peak(outs["base"])
    pk_ps = _envelope_peak(outs["psola"])
    pk_ln = _envelope_peak(outs["linear"])
    assert abs(pk_base - 800) < 150, pk_base
    assert abs(pk_ps - 800) < 180, f"PSOLA 应保住共振峰：{pk_ps}"
    assert pk_ln > 950, f"线性重采样应把共振峰搬高：{pk_ln}"


def test_flags_pitch_and_gender(tmp_path):
    """t flag 按 10 音分/单位移调；g flag 调整共振峰（正=更暗、负=更亮）。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    args = ["--lyric", "あ", "--note", "C4", "--length", "600", "--sample-note", "G3"]
    outs = {}
    for tag, extra in (("base", []), ("t10", ["--flags", "t10"]),
                       ("g40", ["--flags", "g40"]), ("gm40", ["--flags", "g-40"])):
        path = str(tmp_path / f"fl_{tag}.wav")
        p, r = run_render(vb_dir, *args, *extra, "--out", path)
        assert p.returncode == 0 and r["ok"] is True, (p.stdout, r)
        assert r["engine_version"] == "0.2.0"
        import soundfile as sf
        outs[tag] = sf.read(path)[0]

    assert _f0_fft(outs["t10"]) == pytest.approx(_f0_fft(outs["base"]) * 2 ** (100 / 1200), rel=0.03)
    assert _centroid(outs["g40"]) < _centroid(outs["base"]) * 0.98
    assert _centroid(outs["gm40"]) > _centroid(outs["base"]) * 1.02


def test_flags_breath_and_unsupported_warning(tmp_path):
    """B flag 增加气声；不支持的 flag 不静默忽略，而是进 warnings。"""
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    args = ["--lyric", "あ", "--note", "C4", "--length", "600", "--sample-note", "G3"]
    p1, r1 = run_render(vb_dir, *args, "--out", str(tmp_path / "b0.wav"))
    p2, r2 = run_render(vb_dir, *args, "--flags", "B90W", "--out", str(tmp_path / "b90.wav"))
    assert p1.returncode == 0 and p2.returncode == 0 and r1["ok"] and r2["ok"]
    import soundfile as sf
    dry = sf.read(str(tmp_path / "b0.wav"))[0]
    wet = sf.read(str(tmp_path / "b90.wav"))[0]
    assert _band_energy(wet, 2000, 7000) > _band_energy(dry, 2000, 7000) * 1.5
    assert any("W" in w for w in r2["warnings"]), r2["warnings"]
    assert r2["flags"] == ["B"], r2["flags"]      # W 不属于受支持集合


def test_flags_command(tmp_path):
    """flags CLI：列出受支持与已知不支持项（供 UI 展示说明）。"""
    p = subprocess.run([PY, os.path.abspath(ENGINE), "flags"],
                       capture_output=True, text=True, encoding="utf-8",
                       cwd=os.path.dirname(ENGINE))
    result = None
    for line in (p.stdout or "").splitlines():
        if line.startswith("###RESULT "):
            result = json.loads(line[len("###RESULT "):])
    assert p.returncode == 0 and result and result["ok"] is True, (p.stdout, p.stderr)
    flags = {f["flag"] for f in result["supported"]}
    assert {"g", "B", "b", "t", "a", "Y", "H", "C", "P", "N"} <= flags, flags
    assert any(f["flag"] == "W" for f in result["unsupported"])
    assert result["engine_version"] == "0.2.0"


def test_equal_power_crossfade():
    """等功率交叉淡化：两条淡化曲线的平方和恒为 1（不会像线性淡化那样掉 3dB）。"""
    from engine_utau import _equal_power_crossfade
    n = 512
    on = np.ones(n)
    z = np.zeros(n)
    fade_out = _equal_power_crossfade(on, z)     # 纯 a→b 的淡出侧
    fade_in = _equal_power_crossfade(z, on)      # 淡入侧
    assert np.allclose(fade_out ** 2 + fade_in ** 2, 1.0, atol=1e-9)
    assert float(fade_out[0]) == pytest.approx(1.0, abs=1e-9)
    assert float(fade_out[-1]) == pytest.approx(0.0, abs=1e-9)


def test_render_track_returns_warnings(tmp_path):
    """render_track 返回 (buf, warnings)：回退歌词会被记录下来。"""
    from engine_utau import Voicebank, render_track
    vb_dir = str(tmp_path / "vb")
    make_test_voicebank(vb_dir)
    vb = Voicebank(vb_dir)
    buf, warnings = render_track(vb, [{"lyric": "か", "note": "C4", "length_ms": 200},
                                      {"lyric": "未知", "note": "C4", "length_ms": 200}],
                                 sample_note="G3")
    assert len(buf) > 0 and float(np.max(np.abs(buf))) > 0.01
    assert any("未知" in w for w in warnings), warnings


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
