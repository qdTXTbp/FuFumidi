# -*- coding: utf-8 -*-
"""
MuScriptor 通用多乐器转录引擎（Kyutai + Mirelo）
================================================
- 多乐器 / 人声 / 混合音轨 → MIDI（MT3 tokenization，decoder-only transformer）
- 规格：small(103M) / medium(307M, 默认) / large(1.4B)
- 权重默认不在 Release 中，需到资源中心按规格下载（HF 官方 / hf-mirror）
- GPU：Windows 需 CUDA 12.8（cu128）支持 RTX 50 系 Blackwell
"""
import os


def _find_local_model(size):
    """从本地模型目录查找已下载的 MuScriptor 权重（资源中心下载后合并得到）。

    优先使用 FUFUMIDI_MODELS_DIR/muscriptor/{size}/model.safetensors（离线可用），
    找不到再回退 HuggingFace Hub 下载。
    """
    models_dir = os.environ.get("FUFUMIDI_MODELS_DIR", "") or ""
    if not models_dir:
        return None
    base = os.path.join(models_dir, "muscriptor", size.lower())
    for name in ("model.safetensors", "pytorch_model.bin"):
        p = os.path.join(base, name)
        if os.path.exists(p) and os.path.getsize(p) > 0:
            return p
    return None


def available():
    """muscriptor 包是否安装。"""
    try:
        import muscriptor  # noqa: F401
        return True
    except Exception:
        return False


def available_local_sizes():
    """本地已就绪的 MuScriptor 规格列表（有完整权重才算就绪）。"""
    models_dir = os.environ.get("FUFUMIDI_MODELS_DIR", "") or ""
    if not models_dir:
        return []
    base = os.path.join(models_dir, "muscriptor")
    out = []
    for s in ("small", "medium", "large"):
        p = os.path.join(base, s, "model.safetensors")
        if os.path.exists(p) and os.path.getsize(p) > 0:
            out.append(s)
    return out


def transcribe_muscriptor(audio_path, output_midi, params=None, log_cb=None,
                          num_threads=None, **kwargs):
    from muscriptor import TranscriptionModel

    params = params or {}
    size = str(params.get("model_size") or "medium").lower()
    device = str(params.get("device") or "auto")
    tempo = float(params.get("midi_tempo") or 120.0)

    # 优先本地权重（离线），缺失才回退 HF Hub
    local = _find_local_model(size)
    if local:
        _log(log_cb, f"加载 MuScriptor-{size}（本地权重）…")
        load_arg = local
    else:
        ready = available_local_sizes()
        if size not in ready and ready:
            # 已就绪某些规格但本规格缺失：明确指引到资源中心下载，避免 HF 下载失败抛晦涩错误
            raise RuntimeError(
                f"未找到 MuScriptor-{size} 本地权重，请到【资源中心 → MuScriptor】"
                f"下载 {size} 规格后再试（当前已就绪：{' / '.join(ready)}）。")
        _log(log_cb, f"加载 MuScriptor-{size}（HuggingFace，需授权）…")
        load_arg = size

    if device and device != "auto":
        try:
            model = TranscriptionModel.load_model(load_arg, device=device)
        except Exception:
            model = TranscriptionModel.load_model(load_arg)
    else:
        model = TranscriptionModel.load_model(load_arg)

    if model._device and model._device.type == "cuda":
        _log(log_cb, "使用 GPU（CUDA）推理")
    else:
        _log(log_cb, "使用 CPU 推理（较慢）")

    _log(log_cb, "推理中（多乐器转录）…")
    out_dir = os.path.dirname(os.path.abspath(output_midi))
    os.makedirs(out_dir, exist_ok=True)
    # muscriptor 0.3+ 的 transcribe_to_midi 返回 MIDI 字节（非写文件）
    data = model.transcribe_to_midi(audio_path)
    with open(output_midi, "wb") as f:
        f.write(data)

    # 音符数统计（pretty_midi）
    n = _count_notes(output_midi)
    _log(log_cb, f"保存 MIDI → {os.path.basename(output_midi)}（{n} 音符）")
    return n


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
