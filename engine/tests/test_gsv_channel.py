# -*- coding: utf-8 -*-
"""GPT-SoVITS 音色通道 —— 运行时定位、权重识别、配置装配、逐句区间切分。

钉住的全是**实测踩过的坑**：

1. `TTS_Config` 的入参必须包在 `custom` 里，否则你传的权重路径全被丢掉
   （它会退回 v2 默认段，日志一片 "fall back to default …"）。
2. 默认权重路径是**相对 CWD** 的 → 必须给绝对路径（并在 bootstrap 里 chdir）。
3. 社区音色的权重文件名不统一（`gpt.ckpt` / `芙宁娜-e10.ckpt`）→ 按后缀归类，不写死。
4. 音色根目录在 **模型目录** 下（`models/gpt-sovits/voices/`），不是数据根下。
"""
import json
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import gsv_env                                              # noqa: E402


def _runtime(tmp_path):
    """造一个**假运行时**（只看目录结构，不碰 torch）。"""
    root = tmp_path / 'gsv'
    (root / 'GPT_SoVITS' / 'TTS_infer_pack').mkdir(parents=True)
    (root / 'GPT_SoVITS' / 'TTS_infer_pack' / 'TTS.py').write_text('#', encoding='utf-8')
    base = root / 'GPT_SoVITS' / 'pretrained_models'
    (base / 'chinese-roberta-wwm-ext-large').mkdir(parents=True)
    (base / 'chinese-hubert-base').mkdir(parents=True)
    return str(root)


def _voice(tmp_path, name='gsv_x', gpt='gpt.ckpt', sovits='sovits.pth', ref='ref.wav'):
    d = tmp_path / 'voices' / name
    d.mkdir(parents=True)
    (d / gpt).write_bytes(b'x' * 1024)
    (d / sovits).write_bytes(b'y' * 2048)
    if ref:
        (d / ref).write_bytes(b'z' * 512)
    return str(d)


# ---------------------------------------------------------------- 运行时定位

def test_find_runtime_by_env_and_json(tmp_path, monkeypatch):
    root = _runtime(tmp_path)
    monkeypatch.delenv('FUFUMIDI_GSV_ROOT', raising=False)
    monkeypatch.setenv('FUFUMIDI_DATA_DIR', str(tmp_path / 'data'))
    assert gsv_env.find_runtime() == ''
    monkeypatch.setenv('FUFUMIDI_GSV_ROOT', root)
    assert gsv_env.find_runtime() == os.path.abspath(root)
    # runtime.json 也能找到（资源中心/用户手写）
    monkeypatch.delenv('FUFUMIDI_GSV_ROOT', raising=False)
    (tmp_path / 'data' / 'gpt-sovits').mkdir(parents=True)
    (tmp_path / 'data' / 'gpt-sovits' / 'runtime.json').write_text(
        json.dumps({'root': root}), encoding='utf-8')
    assert gsv_env.find_runtime() == os.path.abspath(root)


def test_bootstrap_fixes_pythonpath_and_chdir(tmp_path, monkeypatch):
    root = _runtime(tmp_path)
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv('USERNAME', raising=False)
    gsv_env.bootstrap(root)
    assert os.path.abspath(os.getcwd()) == os.path.abspath(root)
    assert os.path.join(root, 'GPT_SoVITS') in sys.path
    assert os.environ.get('USERNAME'), '必须补 USERNAME（否则 getpass 会去 import pwd）'


def test_voices_root_follows_models_dir(tmp_path, monkeypatch):
    """音色根 = <模型目录>/gpt-sovits/voices（与 main/gpt-sovits.js 的落点一致）。"""
    models = tmp_path / 'models'
    (models / 'gpt-sovits' / 'voices' / 'gsv_a').mkdir(parents=True)
    monkeypatch.setenv('FUFUMIDI_MODELS_DIR', str(models))
    assert gsv_env.voices_root() == str(models / 'gpt-sovits' / 'voices')


# ---------------------------------------------------------------- 音色目录

def test_find_weights_handles_community_names(tmp_path):
    d = _voice(tmp_path, gpt='芙宁娜-e10.ckpt', sovits='芙宁娜_e25_s1625.pth')
    gpt, sovits = gsv_env.find_weights(d)
    assert gpt.endswith('芙宁娜-e10.ckpt') and sovits.endswith('芙宁娜_e25_s1625.pth')


def test_find_weights_missing_raises(tmp_path):
    d = _voice(tmp_path, ref=None)
    os.remove(os.path.join(d, 'sovits.pth'))
    with pytest.raises(RuntimeError):
        gsv_env.find_weights(d)


def test_find_ref_audio_prefers_ref_wav(tmp_path):
    d = _voice(tmp_path)
    (tmp_path / 'voices' / 'gsv_x' / 'aaa.wav').write_bytes(b'0' * 10)
    assert os.path.basename(gsv_env.find_ref_audio(d)) == 'ref.wav'


def test_detect_version_from_config_json(tmp_path):
    d = _voice(tmp_path)
    (tmp_path / 'voices' / 'gsv_x' / 'config.json').write_text(
        json.dumps({'version': 'v4'}), encoding='utf-8')
    assert gsv_env.detect_version(d) == 'v4'
    os.remove(os.path.join(d, 'config.json'))
    assert gsv_env.detect_version(d) == 'v2', '探测不到时退回 v2（社区包绝大多数）'


# ---------------------------------------------------------------- 配置装配

def test_build_config_wraps_in_custom_and_uses_absolute_paths(tmp_path):
    root = _runtime(tmp_path)
    d = _voice(tmp_path)
    cfg = gsv_env.build_config(root, d, device='cpu', version='v2')
    assert set(cfg) == {'custom'}, '★ 必须包在 custom 里（否则 TTS_Config 直接忽略全部入参）'
    c = cfg['custom']
    assert c['device'] == 'cpu' and c['is_half'] is False and c['version'] == 'v2'
    for key in ('t2s_weights_path', 'vits_weights_path'):
        assert os.path.isabs(c[key]) and os.path.isfile(c[key]), key
    for key in ('bert_base_path', 'cnhuhbert_base_path'):
        assert os.path.isabs(c[key]) and os.path.isdir(c[key]), key


def test_build_config_rejects_missing_base_models(tmp_path):
    root = _runtime(tmp_path)
    import shutil
    shutil.rmtree(os.path.join(root, 'GPT_SoVITS', 'pretrained_models', 'chinese-hubert-base'))
    d = _voice(tmp_path)
    with pytest.raises(RuntimeError) as e:
        gsv_env.build_config(root, d, device='cpu')
    assert 'HuBERT' in str(e.value)


def test_build_config_rejects_unknown_version(tmp_path):
    root = _runtime(tmp_path)
    d = _voice(tmp_path)
    with pytest.raises(RuntimeError):
        gsv_env.build_config(root, d, device='cpu', version='v9')


# ---------------------------------------------------------------- 逐句区间

def _notes(pairs):
    """[(startBeat, durBeat)] → 音符表（lyric 用不到）。"""
    return [{'startBeat': a, 'durBeat': b, 'pitch': 60, 'lyric': '啊'} for a, b in pairs]


def test_gsv_lines_splits_by_lyric_lines():
    from engine_cover import gsv_lines
    # 120 BPM → 1 拍 = 0.5s
    notes = _notes([(0, 1), (1, 1), (2, 1), (8, 1), (9, 1)])
    lyrics = [(0.0, '第一行'), (4.0, '第二行')]
    lines = gsv_lines(notes, lyrics, 120.0)
    assert [round(l['start'], 2) for l in lines] == [0.0, 4.0]
    assert [round(l['end'], 2) for l in lines] == [1.5, 5.0]
    assert [l['text'] for l in lines] == ['第一行', '第二行']
    # 结束时间不许越过下一行起点
    assert lines[0]['end'] <= lines[1]['start']


def test_gsv_lines_humming_mode_groups_by_gap():
    from engine_cover import gsv_lines
    notes = _notes([(0, 1), (1, 1), (8, 1)])          # 120BPM：0~1.0s 两句，4.0s 起
    lines = gsv_lines(notes, [], 120.0)
    assert len(lines) == 2, lines
    assert lines[0]['syllables'] == 2 and lines[0]['text'] == ''
    assert round(lines[1]['start'], 2) == 4.0


def test_gsv_lines_skips_lines_without_notes():
    from engine_cover import gsv_lines
    notes = _notes([(0, 1)])
    lines = gsv_lines(notes, [(0.0, '有声'), (30.0, '纯伴奏段')], 120.0)
    assert len(lines) == 1 and lines[0]['text'] == '有声'


# ---------------------------------------------------------------- 对齐

def test_fit_duration_and_level(tmp_path):
    np = pytest.importorskip('numpy')
    A = pytest.importorskip('gsv_align')
    sr = 22050
    t = np.arange(int(sr * 1.0)) / sr
    y = (0.3 * np.sin(2 * np.pi * 220 * t)).astype('float32')
    y2, ratio, dur = A.fit_duration(y, sr, 1.5)
    assert 1.4 < dur < 1.6, dur
    assert 1.4 < ratio < 1.6
    # 电平配平：把 -6dB 的信号拉到参考的 RMS
    quiet = y * 0.5
    out, db = A.match_level(quiet, y)
    assert 5.5 < db < 6.5, db
    assert abs(A.rms(out) - A.rms(y)) < 1e-4
    # 限幅：最多 ±8dB（-80dB 的信号不会被硬拉到参考电平）
    out2, db2 = A.match_level(y * 1e-4, y)
    assert abs(db2 - 8.0) < 0.01


def test_f0_corr_detects_different_melodies():
    np = pytest.importorskip('numpy')
    A = pytest.importorskip('gsv_align')
    n = 400
    up = np.linspace(200, 400, n).astype('float32')
    same = up.copy()
    down = np.linspace(400, 200, n).astype('float32')
    assert A.f0_corr(up, same) > 0.99
    assert A.f0_corr(up, down) < -0.9
    assert A.f0_corr(np.full(n, np.nan, dtype='float32'), up) == -1.0

# ---------------------------------------------------------------- 参考音窗口（3~10 秒）

def _vocals(seconds=30.0, sr=22050):
    np = pytest.importorskip('numpy')
    t = np.arange(int(sr * seconds)) / sr
    return (0.2 * np.sin(2 * np.pi * 220 * t)).astype('float32'), sr


def test_line_ref_meets_3_to_10_second_rule():
    """★ GPT-SoVITS 硬性要求参考音 3~10 秒，超了直接抛「参考音频在3~10秒范围外」。"""
    from engine_gpt_sovits import _line_ref, MIN_REF_SEC, MAX_REF_SEC
    v, sr = _vocals(60.0)
    # 短句（1.2 秒）→ 借到 >= 3 秒
    seg, a, b = _line_ref(v, sr, 10.0, 11.2)
    assert MIN_REF_SEC - 1e-6 <= b - a <= MAX_REF_SEC + 1e-6, (a, b)
    # 长句（20 秒）→ 截到 <= 10 秒，且**从句首开始**（保住这一句的开头）
    seg2, a2, b2 = _line_ref(v, sr, 20.0, 40.0)
    assert b2 - a2 <= MAX_REF_SEC + 1e-6
    assert abs(a2 - 19.8) < 0.05, a2
    # 贴着音频开头/结尾也不许越界
    seg3, a3, b3 = _line_ref(v, sr, 0.0, 0.5)
    assert a3 >= 0.0 and b3 <= len(v) / sr + 1e-6
    assert seg3.size > 0


def test_line_ref_does_not_swallow_previous_line():
    """前一句的尾巴只借一点点（默认 20ms pad + 不够 3 秒时才往前借）。"""
    from engine_gpt_sovits import _line_ref
    v, sr = _vocals(30.0)
    _seg, a, _b = _line_ref(v, sr, 10.0, 14.0, prev_end=9.0)
    assert a >= 9.8 - 1e-6, a          # 4 秒的句子够长了，不该往前吃到 9 秒那儿


def test_f0_shape_corr_is_stretch_invariant():
    """时间归一化后的旋律相关：同一段旋律**快慢不同**也必须判为高度相关。"""
    np = pytest.importorskip('numpy')
    A = pytest.importorskip('gsv_align')
    n = 300
    base = np.linspace(200.0, 400.0, n)
    up = np.concatenate([base, base[::-1]])
    fast = np.interp(np.linspace(0, len(up) - 1, len(up) // 2), np.arange(len(up)), up)
    assert A.f0_corr(up, fast) < 0.9, '逐帧相关必然被快慢拖低（这就是要归一化的原因）'
    assert A.f0_corr(A.norm_curve(up), A.norm_curve(fast)) > 0.99
    asc, desc = base, base[::-1]          # 上行 vs 下行：归一化后必须判成负相关
    assert A.f0_corr(A.norm_curve(asc), A.norm_curve(desc)) < -0.9
    # 全静音（没有有声帧）→ None（调用方按无效处理，不许当成 0 相关）
    assert A.norm_curve(np.full(n, np.nan)) is None
