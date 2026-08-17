# -*- coding: utf-8 -*-
"""
人声/乐器分离转录引擎（可选增强）
==================================
流程：demucs(hdemucs) 先把混音分离成 4 个声部
      → 人声 vocals / 鼓 drums / 贝斯 bass / 其他乐器 other
      再用 basic-pitch 对每个声部单独转录，
      输出**带独立音轨的 MIDI**（人声一轨、贝斯一轨、其它乐器一轨，鼓可选）。

依赖（可选项，install.bat 会询问是否安装增强包）：
    pip install demucs        # 源分离（需 torch/torchaudio）
本模块检测不到 demucs 时会抛出带安装提示的错误，不影响其它模式。
"""

import glob
import os
import shutil
import tempfile

MODEL_NAME = "htdemucs"
STEM_ORDER = [("vocals", "人声"), ("bass", "贝斯"), ("other", "其它乐器"), ("drums", "鼓组")]

# MIDI 轨道名必须用 ASCII（mido 的文本事件默认 latin-1 编码，中文会写失败）
_TRACK_NAMES = {"vocals": "Vocals", "bass": "Bass", "other": "Other", "drums": "Drums"}


def available():
    """demucs 是否安装。"""
    try:
        import demucs  # noqa: F401
        return True
    except Exception:
        return False


def _neutralize_tqdm():
    """把 tqdm.tqdm 换成惰性直通类，避免在 QThread 工作线程里触发 tqdm 全局 RLock 死锁。

    死锁现场（py-spy 抓到）：工作线程阻塞在 tqdm.std.__new__→acquire，
    tqdm 的 TMonitor 守护线程阻塞在 _monitor.py 同一把锁，
    主线程在 _monitor.py exit→join。替换后 demucs 仍能遍历 futures，
    只是不渲染进度条。只做替换，不做 tqdm 的 __new__（那样仍会碰锁）。
    """
    try:
        import tqdm
    except ImportError:
        return

    class _PassThrough:
        def __init__(self, *a, **k):
            it = a[0] if a else k.get("iterable", None)
            self._it = it if it is not None else []

        def __iter__(self):
            return iter(self._it)

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    tqdm.tqdm = _PassThrough
    try:
        import tqdm.std
        tqdm.std.tqdm = _PassThrough
    except Exception:
        pass


def transcribe_separate(audio_path, output_midi, params=None, log_cb=None,
                        num_threads=None, **kwargs):
    """分离声部并转录为多音轨 MIDI。"""
    params = params or {}
    if not available():
        raise RuntimeError(
            "未检测到 demucs（人声分离引擎）。\n"
            "内置的人声分离引擎未加载，请重新安装 AudioMuse。"
        )

    _neutralize_tqdm()

    from demucs import separate as demucs_separate

    _log(log_cb, f"分离声部（demucs {MODEL_NAME}，首次运行会自动下载模型）…")
    tmp_root = tempfile.mkdtemp(prefix="midi_tool_sep_")
    pre_wav = None
    try:
        src = audio_path
        # 可选智能预处理：降噪/响度平衡作用于混音原音频
        if kwargs.get("denoise") or kwargs.get("normalize"):
            from audio_io import decode_to_wav, remove_temp
            from preprocess import process_wav_file
            _log(log_cb, "智能预处理 · 降噪/响度平衡（作用于混音）…")
            pre_wav = decode_to_wav(audio_path, 44100)
            process_wav_file(pre_wav, 44100,
                             bool(kwargs.get("denoise")),
                             bool(kwargs.get("normalize")), log_cb)
            src = pre_wav
        if kwargs.get("auto_bpm"):
            from preprocess import bpm_of_file
            bpm = bpm_of_file(src, 44100)
            if bpm:
                params["midi_tempo"] = float(bpm)
                _log(log_cb, f"智能预处理 · 检测到 BPM = {bpm}")
        # GPU 加速：检测到 CUDA 时把 demucs 推理放到 GPU（demucs CLI 支持 -d cuda）
        _extra = []
        try:
            from engine_gpu import detect as _gpu_detect
            if _gpu_detect().get("cuda"):
                _extra = ["--device", "cuda"]
        except Exception:
            pass
        demucs_separate.main(["-n", MODEL_NAME, "-o", tmp_root, src] + _extra)

        # 定位分离出的声部文件：tmp_root/<model>/<track_name>/*.wav
        stems = _collect_stems(tmp_root)
        if not stems:
            raise RuntimeError("demucs 分离完成，但没有找到声部文件。")

        # 导出分离后的音频分轨（人声/贝斯/其它/鼓 4 个 WAV）
        stem_exports = []
        if params.get("export_stems"):
            out_base = os.path.splitext(os.path.abspath(output_midi))[0]
            os.makedirs(os.path.dirname(out_base), exist_ok=True)
            for key, label in STEM_ORDER:
                src = stems.get(key)
                if not src:
                    continue
                dst = f"{out_base}.{key}.wav"
                shutil.copyfile(src, dst)
                stem_exports.append(dst)
                _log(log_cb, f"· 导出分轨「{label}」→ {os.path.basename(dst)}")
        try:
            transcribe_separate.last_stem_exports = stem_exports
        except Exception:
            pass

        _log(log_cb, "对每个声部分别转录（basic-pitch）…")
        midi = _assemble_stem_midi(stems, params, log_cb, num_threads=num_threads)
        out_dir = os.path.dirname(os.path.abspath(output_midi))
        os.makedirs(out_dir, exist_ok=True)
        midi.write(output_midi)
        return _count_notes(midi)
    finally:
        if pre_wav:
            try:
                os.remove(pre_wav)
            except Exception:
                pass
        shutil.rmtree(tmp_root, ignore_errors=True)


def _collect_stems(tmp_root):
    """从 demucs 输出目录收集 4 个声部 WAV 文件。"""
    stems = {}
    for f in glob.glob(os.path.join(tmp_root, "**", "*.wav"), recursive=True):
        stem = os.path.splitext(os.path.basename(f))[0].lower()  # vocals/drums/bass/other
        if stem in {s for s, _ in STEM_ORDER}:
            stems[stem] = f
    return stems


def _stem_predict_kwargs(key, onset, frame, min_len):
    """按声部定制转录参数（参考“分离后逐轨转写”思路，各声部用最适合的频段/阈值）。

    - 人声：强旋律增强 + 收紧人声频段 80–1000Hz，起音略灵敏
    - 贝斯：低频频段 30–400Hz、不启用旋律增强、音符放宽到 200ms（贝斯多为长音）
    - 其它：保持用户参数，不限制频段
    """
    kw = dict(onset_threshold=onset, frame_threshold=frame,
              minimum_note_length=min_len, melodia_trick=False)
    if key == "vocals":
        kw.update(melodia_trick=True,
                  minimum_frequency=80.0, maximum_frequency=1000.0,
                  onset_threshold=min(onset, 0.45))
    elif key == "bass":
        kw.update(minimum_frequency=30.0, maximum_frequency=400.0,
                  minimum_note_length=max(min_len, 200.0))
    return kw


def _assemble_stem_midi(stems, params, log_cb=None, num_threads=None):
    """把各声部 WAV 转录后合并为一个多音轨 PrettyMIDI（可独立测试）。"""
    import pretty_midi
    from basic_pitch.inference import predict

    from audio_io import decode_to_wav, remove_temp
    from engine_perf import make_basic_model

    onset = float(params.get("onset_threshold", 0.5))
    frame = float(params.get("frame_threshold", 0.3))
    min_len = float(params.get("minimum_note_length", 128))
    include_drums = bool(params.get("include_drums", False))
    tempo = float(params.get("midi_tempo", 120.0))

    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo)
    total = 0
    temp_wavs = []

    for key, label in STEM_ORDER:
        stem = stems.get(key)
        if not stem:
            continue
        if key == "drums" and not include_drums:
            _log(log_cb, f"· 鼓组：跳过（未勾选输出鼓轨）")
            continue
        _log(log_cb, f"· 转录「{label}」…")
        try:
            wav = decode_to_wav(stem, 22050)
            temp_wavs.append(wav)
            _model_output, midi_data, notes = predict(
                wav, make_basic_model(num_threads),
                **_stem_predict_kwargs(key, onset, frame, min_len),
            )
        except Exception as e:
            _log(log_cb, f"· 「{label}」转录失败：{e}")
            continue

        if key == "drums":
            # 鼓声部没有音高，转成 GM 打击乐节奏轨
            _add_drum_track(pm, notes)
            total += len(notes)
            continue

        for inst in midi_data.instruments:
            inst.name = f"{_TRACK_NAMES.get(key, key)} · {inst.name}".strip(" ·")
            pm.instruments.append(inst)
            total += len(inst.notes)

    for w in temp_wavs:
        remove_temp(w)
    if not pm.instruments:
        # 保证至少有一条音轨，避免空文件
        empty = pretty_midi.Instrument(program=0)
        empty.name = "empty"
        pm.instruments.append(empty)

    # 整体后处理：合并同音高碎片 / 力度归一化
    try:
        from midi_post import apply_post
        apply_post(pm, params, log_cb=log_cb)
    except Exception:
        pass
    return pm


def _add_drum_track(pm, note_events):
    """把 basic-pitch 对鼓声部输出的音符事件映射到 GM 打击乐音轨。"""
    import pretty_midi
    drum = pretty_midi.Instrument(program=0, is_drum=True, name="Drums")
    # 常用 GM 鼓音色：低音鼓36 军鼓38 踩镲42 强音镲49 叮叮镲51
    KITS = [36, 38, 42, 49, 51]
    for i, (start, end, _pitch, amp, _bends) in enumerate(note_events):
        note = pretty_midi.Note(
            velocity=int(max(20, min(127, round(amp * 127)))),
            start=start, end=end,
            pitch=KITS[i % len(KITS)],
        )
        drum.notes.append(note)
    if drum.notes:
        pm.instruments.append(drum)


def _count_notes(midi):
    return sum(len(inst.notes) for inst in midi.instruments)


def _log(cb, msg):
    if cb:
        try:
            cb(msg)
        except Exception:
            pass
