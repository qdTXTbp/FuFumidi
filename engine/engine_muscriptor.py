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


def _require_package():
    """包缺失时的明确指引：区分「缺 Python 包」与「缺模型权重」。"""
    try:
        import muscriptor  # noqa: F401
        return True
    except Exception:
        raise RuntimeError(
            "未安装 muscriptor Python 运行时包（应用环境的 Python 里 `import muscriptor` 失败）。"
            "模型权重虽已下载，但仍需安装该包：请在应用使用的 Python 中执行 "
            "`python -m pip install muscriptor`（PyPI 0.3.0，含 torch/einops/safetensors 等依赖），"
            "或在资源中心安装 MuScriptor 运行时。")


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


# muscriptor 的 _resolve_config 依赖权重旁的 config.json 确定模型架构；
# 本地路径（muscriptor/small/model.safetensors）既没有 config.json，
# 路径分隔符也不是 muscriptor-<size>，文件名也没有 8 位哈希标签，
# 会一路回退到默认 large（dim=1536/48层）→ 与 small/medium 权重 state_dict 尺寸不匹配。
# 这里在权重旁补齐 config.json，让 muscriptor 从权重目录读到正确架构。
_MUSCRIPTOR_CONFIGS = {
    "small": {"dim": 768, "num_heads": 12, "num_layers": 14, "card": 1393},
    "medium": {"dim": 1024, "num_heads": 16, "num_layers": 24, "card": 1395},
    "large": {"dim": 1536, "num_heads": 24, "num_layers": 48, "card": 1395},
}


def _ensure_config(weights_path, size):
    """权重旁缺 config.json 时按规格补齐（muscriptor _resolve_config 第一步即读它）。"""
    cfg = _MUSCRIPTOR_CONFIGS.get(str(size or "").lower())
    if not cfg:
        return
    config_path = os.path.join(os.path.dirname(os.path.abspath(weights_path)), "config.json")
    if os.path.exists(config_path):
        return
    try:
        import json as _json
        with open(config_path, "w", encoding="utf-8") as f:
            _json.dump(cfg, f)
    except Exception:
        pass  # 写失败不阻断转录（muscriptor 会走其他回退，代价是可能架构不匹配）


def transcribe_muscriptor(audio_path, output_midi, params=None, log_cb=None,
                          num_threads=None, **kwargs):
    _require_package()  # 包缺失先给明确报错，再导入
    from muscriptor import TranscriptionModel

    params = params or {}
    size = str(params.get("model_size") or "medium").lower()
    device = str(params.get("device") or "auto")
    tempo = float(params.get("midi_tempo") or 120.0)

    # 优先本地权重（离线），缺失才回退 HF Hub
    local = _find_local_model(size)
    if local:
        _ensure_config(local, size)  # 补 config.json，避免 muscriptor 按默认 large 架构加载导致尺寸不匹配
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
        dev = device
    else:
        # 自动选择：优先 CUDA（Blackwell 需 cu128 torch，装好 GPU 增强包后自动生效）；
        # DirectML / MPS 暂不显式传入，交给 muscriptor 默认（保障 CUDA 优先、其余不破坏）
        dev = None
        try:
            from engine_gpu import torch_device as _torch_device
            _d = _torch_device()
            if _d in ("cuda", "mps"):
                dev = _d
        except Exception:
            dev = None
    try:
        model = TranscriptionModel.load_model(load_arg, device=dev)
    except Exception:
        model = TranscriptionModel.load_model(load_arg)

    if model._device and model._device.type == "cuda":
        _log(log_cb, "使用 GPU（CUDA）推理")
    elif model._device and model._device.type == "mps":
        _log(log_cb, "使用 GPU（Apple Metal）推理")
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

    # 转录完成：卸载模型并释放显存（torch 缓存分配器不会自动归还 VRAM）
    try:
        del model
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
