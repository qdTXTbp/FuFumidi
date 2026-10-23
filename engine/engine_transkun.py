# -*- coding: utf-8 -*-
"""
Transkun 钢琴转录引擎（Yujia-Yan, Neural Semi-CRF）
====================================================
- Transformer + Neural Semi-CRF，表现力转录（velocity / pedal / 微时值），MIT
- pip install transkun 已包含权重（CLI：transkun <audio> <midi>）
- GPU：--device cuda；Blackwell（RTX 50 系）需 cu128 torch
"""
import os
import shutil
import subprocess
import sys


def available():
    """transkun 是否可用（pip 包或源码）。"""
    try:
        import transkun  # noqa: F401
        return True
    except Exception:
        pass
    try:
        import transkun.transcribe  # noqa: F401
        return True
    except Exception:
        pass
    return shutil.which("transkun") is not None


def transcribe_transkun(audio_path, output_midi, params=None, log_cb=None,
                        num_threads=None, **kwargs):
    params = params or {}
    # 设备解析：优先显式传入；auto → engine_gpu 探测（无 CUDA 增强包时回退 CPU，
    # 避免 CPU 版 torch 收到 --device cuda 直接崩溃）
    device = str(params.get("device") or "")
    if not device or device == "auto":
        try:
            from engine_gpu import torch_device as _td
            _d = _td()
            # transkun CLI 认 cuda / xpu / cpu（DirectML 的 privateuseone 设备名它不认）。
            # xpu 是 Intel 专供包（torch+xpu）；transkun 内部走 torch，所以能吃。
            device = _d if _d in ("cuda", "xpu") else "cpu"
        except Exception:
            device = "cpu"
    weight = str(params.get("weight") or "").strip()

    out_dir = os.path.dirname(os.path.abspath(output_midi))
    os.makedirs(out_dir, exist_ok=True)

    _log(log_cb, "Transkun 推理中（钢琴转录）…")
    # 3.2.6 健壮性加固：transkun 内部音频加载器（torchaudio 系）对非标准 MP3
    # （重命名容器/损坏头）会抛晦涩错误。与 muscriptor 引擎同款修复：统一先经
    # 内置 ffmpeg 预解码为标准 PCM WAV（16000 = 模型原生采样率）再喂 CLI。
    from audio_io import decode_to_wav, remove_temp
    wav = decode_to_wav(audio_path, 16000)
    try:
        cmd = []
        if shutil.which("transkun"):
            cmd = ["transkun"]
        else:
            cmd = [sys.executable, "-m", "transkun.transcribe"]
        cmd += [wav, output_midi, "--device", device]
        if weight:
            cmd += ["--weight", weight]
        # ★ 识别片段长度：**默认不开启**（用户 2026-10-23）。不传时 Transkun 用
        #   模型配置自带的片段长度；只有用户显式调了滑条才传 --segmentSize。
        try:
            import segment_options as _so
            cmd += _so.transkun_segment_args(params.get("segment_sec"))
        except Exception:
            pass
        _run(cmd, log_cb)
    finally:
        remove_temp(wav)

    n = _count_notes(output_midi)
    _log(log_cb, f"保存 MIDI → {os.path.basename(output_midi)}（{n} 音符）")
    return n


def _run(cmd, log_cb):
    _log(log_cb, "运行 " + " ".join(cmd[-4:]))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "").strip()[-500:])


def _count_notes(midi_path):
    try:
        import pretty_midi
        pm = pretty_midi.PrettyMIDI(midi_path)
        return sum(len(inst.notes) for inst in pm.instruments)
    except Exception:
        return 0


def _log(cb, msg):
    if cb:
        try:
            cb(msg)
        except Exception:
            pass
