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

import pause_gate

_ENGINE = None
_ENGINE_SEGMENT = None   # 当前推理器使用的 segment_samples（换片段长度要重建）
_DEVICE = "cpu"   # 引擎实际运行的设备（规范化后：cuda / cpu）
_QUIET = True

# 各性能档的一次前向最大分段数（CUDA）；CPU 路径再减半以省内存
_PERF_BATCH = {"fast": 8, "balanced": 16, "quality": 32}


def _batch_cap(perf_mode, device, memory_mode=None):
    """按性能档 + 设备类型决定批量前向上限，防止低配 / 小显存机器 OOM。

    memory_mode（用户设置）：
      low   = 低显存模式：再减半，尽量不触发驱动「共享内存」静默溢出（溢出会慢 5–10×）
      allow = 允许驱动借用系统内存（不额外降批，可能变慢）
      auto / None = 保持原性能档行为
    """
    cap = _PERF_BATCH.get(perf_mode or "quality", 32)
    if device != "cuda":
        cap = max(1, cap // 2)   # CPU 更保守
    if memory_mode == "low":
        cap = max(1, cap // 2)
    return cap


# 暂停响应的目标：单批耗时超过它就把后面的批减半；远低于它就把批翻倍（上限仍是性能档）。
# 为什么需要：批越大越快，但暂停只能落在**批次之间** —— 一批 32 段（=160 秒音频）在慢机器上
# 要跑几十秒，用户点「暂停」后要等半分钟才停就不叫暂停了；而一上来就用 1 段，慢机器又要多花
# 几倍时间。所以开启暂停时**先小批起跑再按实测耗时收敛**（实测：RTX 5070 Ti Laptop 上
# 0.70 s/段(批1) → 0.46(批2) → 0.35(批4) → 0.37(批8)，批 4 就已经接近饱和）。
_PAUSE_BUDGET_S = 6.0
_PAUSE_START_SEG = 4


# 钢琴模型的「最短音符」护栏（★ 2026-10-15 实测）。
# 10ms 对这个模型等于**把过滤器关掉**：起音阈值 0 + 最短 10ms 时，30 秒样例出 8037 个音符 / 15.8 秒
# （3 分钟样例实测 47967 个音符 / 517 秒）；同一段音频抬到 30ms 就是 414 个 / 3.2 秒，
# 与内置默认 60ms（71 个 / 3.2 秒）同一量级。阈值本身不是主因（frame 0.01 / 0.05 / 0.10 都差不多）。
# 30ms 远低于默认 60ms，不挡任何正常用法，只挡"碎音海"。
_MIN_NOTE_MS_FLOOR = 30


def _sane_min_note_ms(value, log_cb=None, default=60):
    """把钢琴模型的「最短音符」抬到有意义的量级；被抬升时**说明原因**（不静默改用户的值）。"""
    try:
        ms = int(value)
    except (TypeError, ValueError):
        ms = int(default)          # 没传 / 传了非数字 → 用默认，不算"被抬升"
    if ms >= _MIN_NOTE_MS_FLOOR:
        return ms
    if log_cb:
        try:
            log_cb('[钢琴] 最短音符 %dms 太短：钢琴模型下会留下大量碎音'
                   '（实测 30 秒样例 71→8037 个音符、3.2→15.8 秒），已按 %dms 处理'
                   % (ms, _MIN_NOTE_MS_FLOOR))
        except Exception:
            pass
    return _MIN_NOTE_MS_FLOOR


def _resolve_gate(gate):
    """gate=None 表示"用当前这次转录的闸门"（包装器只装一次，闸门每次转录重绑，见 pause_gate）。"""
    if gate is not None:
        return gate
    try:
        import pause_gate
        return pause_gate.current()
    except Exception:
        return None


def _chunked_forward(forward_fn, model, x, cap, gate=None, budget_s=None, clock=None):
    """按 cap 分批前向，**批次之间**过暂停闸门（见 pause_gate 模块）。

    为什么要自己写这个循环：`piano_transcription_inference.pytorch_utils.forward` 就是
    「逐批 append → 最后按 axis=0 拼接」，而暂停点只能放在批次之间，所以把这十几行搬过来。
    语义与被替换掉的实现完全一致（同序、同样拼接），结果逐元素相等 ——
    tests/test_engine_pt_pause.py 用假 forward 钉住了这一点。

    budget_s：单批耗时目标（秒）。超过它 → 后面的批减半（慢机器，保暂停响应）；
    远低于它 → 批翻倍直到 cap（快机器，把速度还回来）。None = 不按耗时调整。

    没有闸门（命令行 / 旧主进程）时行为与原来完全一样：一批 cap 段。
    """
    if clock is None:
        import time as _time
        clock = _time.perf_counter
    n = len(x)
    if not n:
        return forward_fn(model, x, 1)
    gate = _resolve_gate(gate)
    paused_by_gate = gate is not None and gate.active
    cap = max(1, min(int(cap) if cap else n, n))
    # ★ 暂停开启时：① 保证"至少切两刀"（片段数 ≤ 上限的文件本来只有一批，闸门只在开跑前过一下
    #   = 中途根本停不下来）；② 先小批起跑，再按实测耗时收敛到性能档上限（见 _PAUSE_BUDGET_S）。
    size = max(1, min(cap, n // 2, _PAUSE_START_SEG)) if paused_by_gate else cap
    if paused_by_gate:
        gate.wait()                  # 开跑前也过闸门：刚点了暂停就别再开新的一批
    outs = []
    pointer = 0
    while pointer < n:
        if paused_by_gate:
            gate.wait()
        chunk = x[pointer:pointer + size]
        t0 = clock()
        outs.append(forward_fn(model, chunk, len(chunk)))
        pointer += len(chunk)
        if budget_s:
            dt = clock() - t0
            if dt > budget_s and len(chunk) > 1:
                size = max(1, len(chunk) // 2)          # 慢机器：缩短一批，保证暂停响应
            elif dt < budget_s / 2 and size < cap:
                size = min(cap, size * 2)               # 快机器：放大回性能档上限
    if len(outs) == 1:
        return outs[0]
    import numpy as _np
    merged = {}
    for key in outs[0]:
        merged[key] = _np.concatenate([o[key] for o in outs], axis=0)
    return merged


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


def _engine_init(onset_threshold=0.3, frame_threshold=0.1, num_threads=None, perf_mode="quality",
                 segment_sec=0, memory_mode=None):
    """初始化转录器(惰性, 只初始化一次)。

    设备自动选择：CUDA → CPU（见 engine_gpu）。piano_transcription_inference
    内部只用 `'cuda' in str(device)` 判定是否上 GPU，DirectML/MPS 传进去会
    静默跑 CPU 却误标 GPU，因此这里把设备规范化成 'cuda' / 'cpu' 两种；
    初始化失败时回退 CPU，保证转录不中断。
    """
    global _ENGINE, _DEVICE, _ENGINE_SEGMENT
    # 识别片段长度（秒）→ PianoTranscription(segment_samples=秒*16000)。
    # 模型缓存的键必须包含片段长度：换长度要重建推理器，否则界面调了不生效。
    try:
        import segment_options as _so
        _want_samples = _so.piano_segment_samples(segment_sec)
    except Exception:
        _want_samples = None
    if _ENGINE is not None and _want_samples and _want_samples != _ENGINE_SEGMENT:
        _release_pt_engine()
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
                # 诊断：确认我们这层补丁真的生效了（没生效就会退回库自带 batch=1 的慢循环，
                # 实测慢 5~10 倍，而且**没有暂停点** —— 这行日志是区分两者的唯一线索）
                pause_gate.log_line('[钢琴] 分批前向：共 %d 段，性能档上限 %d 段' % (len(x), cap))
                # 上限按性能档；批次之间过暂停闸门（见 pause_gate），慢机器按实测耗时自适应缩小批
                return _chunked_forward(_orig_forward, model, x, max(1, min(cap, len(x))),
                                        budget_s=_PAUSE_BUDGET_S)
            return _batched_forward

        _cap = _batch_cap(perf_mode, _device, memory_mode)
        _inf.forward = _make_patch(_cap)

        try:
            _kw = {}
            if _want_samples:
                _kw["segment_samples"] = int(_want_samples)
            with _redirect_stdout():
                _ENGINE = PianoTranscription(device=_device,
                                             checkpoint_path=_find_bundled_model(), **_kw)
        except Exception:
            # 设备初始化失败（DirectML/MPS 兼容性等）→ 回退 CPU
            if _device != "cpu":
                _device = "cpu"
                _cap = _batch_cap(perf_mode, _device, memory_mode)
                _inf.forward = _make_patch(_cap)
            _kw = {}
            if _want_samples:
                _kw["segment_samples"] = int(_want_samples)
            with _redirect_stdout():
                _ENGINE = PianoTranscription(device="cpu",
                                             checkpoint_path=_find_bundled_model(), **_kw)
        _DEVICE = _device
        _ENGINE_SEGMENT = _want_samples

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

    # ★ 转录中途暂停 / 继续（用户 2026-10-14 要求，见 pause_gate 模块）：
    #   钢琴链路只有一次 engine.transcribe() 调用，但**分批前向的循环是我们自己写的**
    #   （见 _chunked_forward），批次之间就是断点。
    import pause_gate as _pause_gate
    _pause_gate.install(log_cb)

    # ★ 碎音护栏：钢琴模型下 10ms 的「最短音符」= 关掉过滤器（见 _sane_min_note_ms 的实测数据）
    min_note_ms = _sane_min_note_ms(min_note_ms, log_cb)

    _log(log_cb, "解码音频 → 16000Hz …")
    # 1. 加载音频到引擎所需的 16kHz 单声道（任意格式）
    audio = load_audio_float32(audio_path, 16000)

    # ★ 转录前音频链（2026-10-15 方案 A/B）：高通 → 降噪 → 电平统一。
    #   （旧路径同一段代码里跑的是前 0.3 秒估噪的谱减法；现在换成安静帧估噪 + 谱底，
    #     并且恒定把电平归一到 −20 dBFS —— 实测电平差 6 dB 会让音符数从 69 变 249。）
    try:
        import audio_chain as _ac
        _ac.process_array_inplace(audio, 16000, kwargs, log_cb,
                                  strong_runner=_ac.make_strong_runner(log_cb))
    except Exception as _e:
        _log(log_cb, "[预处理] 音频链失败，按原始音频继续：%s" % _e)

    # 2. 初始化引擎（设备已规范化：DirectML/MPS 一律 CPU，见 _engine_init）
    from engine_gpu import detect as _gpu_detect
    _gpu = _gpu_detect()
    engine = _engine_init(onset_threshold=onset_threshold,
                          frame_threshold=frame_threshold,
                          num_threads=num_threads,
                          perf_mode=kwargs.get("perf_mode", "quality"),
                          segment_sec=kwargs.get("segment_sec"),
                          memory_mode=kwargs.get("memory_mode"))
    _dev = _DEVICE
    _log(log_cb, f"加载钢琴模型（{'GPU · ' + (_gpu.get('name') or _dev) if _dev == 'cuda' else 'CPU 多核'}）…")

    # 3. 转录(不写文件, 拿原始音符事件)
    _log(log_cb, "推理识别中（钢琴专用模型）…")
    import torch
    with _redirect_stdout():
        # inference_mode + autocast 会让钢琴模型漏掉大量音符，改用普通推理
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

    # 6. 转录完成：卸载模型（_ENGINE 为模块级全局缓存，需显式置空才能释放 GPU 显存）
    _release_pt_engine()

    return len(notes)


def _release_pt_engine():
    """释放钢琴转录引擎（全局缓存 _ENGINE）与显存。"""
    global _ENGINE, _ENGINE_SEGMENT
    try:
        _ENGINE = None
        _ENGINE_SEGMENT = None
        import gc
        gc.collect()
        try:
            import torch
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass
    except Exception:
        pass


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
