# -*- coding: utf-8 -*-
"""
钢琴专用转录引擎（高精度）
==========================
基于 ByteDance piano-transcription-inference —— 正是 GiantMIDI-Piano 数据集的
转录引擎，对纯钢琴的起音识别专门优化，可输出音符 + 踏板。

性能优化（继承自原工具）：
  1. torch 使用全部 CPU 核
  2. 前向推理改为批量处理段（实测 CPU 利用率从 <3% 提升到满载）
"""

import contextlib
import io
import os

_ENGINE = None
_DEVICE = "cpu"   # 引擎实际运行的设备（规范化后：cuda / cpu）
_QUIET = True

# 各性能档的一次前向最大分段数（CUDA）；CPU 路径再减半以省内存
_PERF_BATCH = {"fast": 8, "balanced": 16, "quality": 32}


def _batch_cap(perf_mode, device):
    """按性能档 + 设备类型决定批量前向上限，防止低配 / 小显存机器 OOM。"""
    cap = _PERF_BATCH.get(perf_mode or "quality", 32)
    if device != "cuda":
        cap = max(1, cap // 2)   # CPU 更保守
    return cap


def _set_quiet(quiet):
    global _QUIET
    _QUIET = quiet


def available():
    try:
        import piano_transcription_inference  # noqa: F401
        import torch  # noqa: F401
        return True
    except Exception:
        return False


def _find_bundled_model():
    """优先使用内置模型文件(免下载)。

    查找顺序：
      1. FUFUMIDI_MODELS_DIR 环境变量（Electron 主进程注入：打包后指向
         resources/models，开发模式指向 <app>/models）下的
         piano_transcription/note_F1=0.9677_pedal_F1=0.9186.pth；
      2. PyInstaller 打包后 exe 旁的模型文件（兼容旧方案）；
    找不到则返回 None，走库默认位置（首次运行联网下载）。
    """
    import sys
    candidates = []
    models_dir = os.environ.get("FUFUMIDI_MODELS_DIR", "")
    if models_dir:
        candidates.append(os.path.join(models_dir, "piano_transcription",
                                       "note_F1=0.9677_pedal_F1=0.9186.pth"))
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            candidates.append(os.path.join(meipass, "note_F1=0.9677_pedal_F1=0.9186.pth"))
        candidates.append(os.path.join(os.path.dirname(sys.executable),
                                       "note_F1=0.9677_pedal_F1=0.9186.pth"))
    for c in candidates:
        if os.path.isfile(c) and os.path.getsize(c) > 1.6e8:
            return c
    return None


def _engine_init(onset_threshold=0.3, frame_threshold=0.1, num_threads=None, perf_mode="quality"):
    """初始化转录器(惰性, 只初始化一次)。

    设备自动选择：CUDA → CPU（见 engine_gpu）。piano_transcription_inference
    内部只用 `'cuda' in str(device)` 判定是否上 GPU，DirectML/MPS 传进去会
    静默跑 CPU 却误标 GPU，因此这里把设备规范化成 'cuda' / 'cpu' 两种；
    初始化失败时回退 CPU，保证转录不中断。
    """
    global _ENGINE, _DEVICE
    if _ENGINE is None:
        import torch
        torch.set_num_threads(num_threads or os.cpu_count())

        from engine_gpu import torch_device
        _device = torch_device()
        if _device not in ("cuda", "cpu"):
            _device = "cpu"   # DirectML / MPS → CPU（该库不真正支持）

        from piano_transcription_inference import PianoTranscription

        # 批量前向补丁: 把逐段(batch=1)推理改成一次性大批量, 充分利用多核/GPU；
        # 上限按性能档自适应（fast/balanced/quality），低配 / 小显存机器更保守。
        import piano_transcription_inference.inference as _inf
        from piano_transcription_inference.pytorch_utils import forward as _orig_forward

        def _make_patch(cap):
            def _batched_forward(model, x, batch_size):
                return _orig_forward(model, x, max(1, min(cap, len(x))))
            return _batched_forward

        _cap = _batch_cap(perf_mode, _device)
        _inf.forward = _make_patch(_cap)

        try:
            with _redirect_stdout():
                _ENGINE = PianoTranscription(device=_device,
                                             checkpoint_path=_find_bundled_model())
        except Exception:
            # 设备初始化失败（DirectML/MPS 兼容性等）→ 回退 CPU
            if _device != "cpu":
                _device = "cpu"
                _cap = _batch_cap(perf_mode, _device)
                _inf.forward = _make_patch(_cap)
            with _redirect_stdout():
                _ENGINE = PianoTranscription(device="cpu",
                                             checkpoint_path=_find_bundled_model())
        _DEVICE = _device

    # 应用阈值参数
    _ENGINE.onset_threshold = onset_threshold
    _ENGINE.frame_threshold = frame_threshold
    return _ENGINE


def _redirect_stdout():
    """静音引擎的打印输出。"""
    if _QUIET:
        return contextlib.redirect_stdout(io.StringIO())
    return contextlib.nullcontext()


def transcribe_pt(audio_path, output_midi, onset_threshold=0.3, frame_threshold=0.1,
                  min_note_ms=60, merge_gap_ms=30, include_pedal=True,
                  num_threads=None, log_cb=None, **kwargs):
    """把音频转录为 MIDI(先取原始事件, 后处理后再写文件)。

    返回:
        音符数量(后处理后的)
    """
    from audio_io import load_audio_float32

    _log(log_cb, "解码音频 → 16000Hz …")
    # 1. 加载音频到引擎所需的 16kHz 单声道（任意格式）
    audio = load_audio_float32(audio_path, 16000)

    # 可选智能预处理：降噪 / 响度平衡
    if kwargs.get("denoise") or kwargs.get("normalize"):
        from preprocess import denoise as _dn, normalize_loudness as _nl
        if kwargs.get("denoise"):
            _log(log_cb, "智能预处理 · 降噪 …")
            audio = _dn(audio, 16000)
        if kwargs.get("normalize"):
            _log(log_cb, "智能预处理 · 响度平衡 …")
            audio = _nl(audio)

    # 2. 初始化引擎（设备已规范化：DirectML/MPS 一律 CPU，见 _engine_init）
    from engine_gpu import detect as _gpu_detect
    _gpu = _gpu_detect()
    engine = _engine_init(onset_threshold=onset_threshold,
                          frame_threshold=frame_threshold,
                          num_threads=num_threads,
                          perf_mode=kwargs.get("perf_mode", "quality"))
    _dev = _DEVICE
    _log(log_cb, f"加载钢琴模型（{'GPU · ' + (_gpu.get('name') or _dev) if _dev == 'cuda' else 'CPU 多核'}）…")

    # 3. 转录(不写文件, 拿原始音符事件)
    _log(log_cb, "推理识别中（钢琴专用模型）…")
    import torch
    with _redirect_stdout():
        if _dev == "cuda":
            # GPU 推理：关闭梯度 + 混合精度，显著提速、省显存；失败则普通推理
            try:
                with torch.inference_mode():
                    with torch.autocast(device_type="cuda"):
                        result = engine.transcribe(audio, None)
            except Exception:
                result = engine.transcribe(audio, None)
        else:
            with torch.inference_mode():
                result = engine.transcribe(audio, None)

    # 4. 后处理: 合并同音高近邻短音符 + 过滤过短音符
    notes = clean_notes(result['est_note_events'], min_note_ms, merge_gap_ms)
    pedals = result['est_pedal_events'] if include_pedal else []

    # 5. 写 MIDI
    from piano_transcription_inference.utilities import write_events_to_midi
    _log(log_cb, f"保存 MIDI → {os.path.basename(output_midi)}")
    with _redirect_stdout():
        write_events_to_midi(start_time=0, note_events=notes,
                             pedal_events=pedals, midi_path=output_midi)

    return len(notes)


def clean_notes(notes, min_note_ms=60, merge_gap_ms=30):
    """音符后处理: 让输出更接近人手演奏。

    1. 合并: 同音高、后一音符起音与前一首符结束间隔小于 merge_gap_ms 的，
       合并成一个延音音符(保留前者的起音时间与力度)。
    2. 过滤: 合并后仍短于 min_note_ms 的音符直接删除(避免琐碎短音)。
    """
    if not notes:
        return []
    from collections import defaultdict

    min_dur = max(0, min_note_ms) / 1000.0
    merge_gap = max(0, merge_gap_ms) / 1000.0

    groups = defaultdict(list)
    for n in notes:
        groups[n['midi_note']].append(n)

    cleaned = []
    for _pitch, lst in groups.items():
        lst.sort(key=lambda n: n['onset_time'])
        merged = []
        for n in lst:
            if merged:
                last = merged[-1]
                gap = n['onset_time'] - last['offset_time']
                if gap < merge_gap:
                    last['offset_time'] = max(last['offset_time'], n['offset_time'])
                    continue
            merged.append(dict(n))
        for n in merged:
            if n['offset_time'] - n['onset_time'] >= min_dur:
                cleaned.append(n)

    cleaned.sort(key=lambda n: n['onset_time'])
    return cleaned


def _log(cb, msg):
    if cb:
        try:
            cb(msg)
        except Exception:
            pass
