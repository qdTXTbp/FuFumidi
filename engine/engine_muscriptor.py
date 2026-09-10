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
import time


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

    # 3.2.6 热修：先做存在性检查，避免 libsndfile 抛「File does not exist or is not a
    # regular file (possibly a pipe?)」这类误导性错误
    if not os.path.isfile(audio_path):
        raise RuntimeError(f"音频文件不存在或不可读：{audio_path}")

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

    # 批量推理仅在 CUDA / MPS 上有意义：CPU 批量吞吐无收益且更吃内存，
    # DirectML 设备不被 muscriptor 支持。非 GPU 设备强制回串行（质量最优）。
    _dev_type = getattr(getattr(model, "_device", None), "type", "") or ""
    if int(params.get("muscriptor_batch") or 0) >= 2 and _dev_type not in ("cuda", "mps"):
        _log(log_cb, f"当前设备为 {_dev_type or 'cpu'}，批量推理仅 GPU 生效，已改回串行（质量最优）")
        params = dict(params)
        params["muscriptor_batch"] = 0

    _log(log_cb, "推理中（多乐器转录）…")
    out_dir = os.path.dirname(os.path.abspath(output_midi))
    os.makedirs(out_dir, exist_ok=True)
    # 3.2.6 热修：muscriptor 直读原始文件只支持 PCM WAV（stdlib wave）与 soundfile
    # 可解码格式，非标准 MP3（重命名容器/损坏头）会抛 libsndfile「File does not exist…」
    # + mpg123「Giving up searching valid MPEG header」晦涩错误。
    # 统一先用 audio_io 预解码为标准 PCM WAV（内置 ffmpeg 按内容解码，支持一切格式），
    # 采样率 16000 与 muscriptor 内部 _SAMPLE_RATE 一致，免去二次重采样。
    import audio_io
    wav_tmp = audio_io.decode_to_wav(audio_path, 16000)
    try:
        # 真实进度上报：muscriptor 的 transcribe() 是事件流，其中夹带 ProgressEvent
        # （completed/total 个 5s 分块）。官方 transcribe_to_midi 内部即「事件流 →
        # events_to_midi_bytes」，这里改为自行组合，只为在事件流中插入进度透传。
        # 通过日志通道发送 ###PROG 前缀行，前端解析后替代「按时间估算」的假进度。
        import json as _json
        try:
            from muscriptor.events import ProgressEvent as _ProgressEvent
        except Exception:
            _ProgressEvent = None

        def _events_with_progress(events):
            if _ProgressEvent is None:
                yield from events
                return
            for ev in events:
                if isinstance(ev, _ProgressEvent):
                    try:
                        if log_cb and getattr(ev, "total", 0):
                            log_cb('###PROG ' + _json.dumps(
                                {"completed": int(ev.completed), "total": int(ev.total)}))
                    except Exception:
                        pass
                yield ev

        # 节拍网格只检测一次（OOM 降级重试时复用，避免重复解码/检测）
        beat_grid = model.detect_beat_grid_for(wav_tmp)

        # muscriptor 0.3+ 的 transcribe_to_midi 返回 MIDI 字节（非写文件）。
        # 批量推理开关：prelude_forcing=False + batch_size>1 可提速 2-4×
        # （长音频 chunk 串行是大瓶颈），代价是 chunk 边界延续音符质量略降。
        # 默认关闭（batch=1 + prelude_forcing=True，边界质量最优）。
        # 实测（RTX 5070 Ti，medium，120s 音频）：batch=1 57s → batch=4 25s → batch=8 23s。
        batch = int(params.get("muscriptor_batch") or 0)
        t0 = time.perf_counter()
        data = None
        while data is None:
            try:
                if batch >= 2:
                    _log(log_cb, f"批量推理：batch_size={batch}（prelude_forcing 关闭，边界质量略降）…")
                    events = model.transcribe(wav_tmp, batch_size=batch, prelude_forcing=False)
                else:
                    events = model.transcribe(wav_tmp)
                data = model.events_to_midi_bytes(_events_with_progress(events), beat_grid=beat_grid)
            except Exception as e:
                # 显存溢出自动降级：batch ≥2 → 减半重试 → 串行兜底，绝不因此转录失败
                oom = "out of memory" in str(e).lower() or "OutOfMemoryError" in type(e).__name__
                if oom and batch >= 2:
                    batch = batch // 2
                    _log(log_cb, f"GPU 显存不足，自动降低批量至 batch_size={batch} 重试…")
                    try:
                        import torch
                        if torch.cuda.is_available():
                            torch.cuda.empty_cache()
                    except Exception:
                        pass
                    continue
                raise
        _log(log_cb, f"[计时] muscriptor 推理（含解码/分块/解码为 MIDI）：{time.perf_counter() - t0:.1f}s")
    finally:
        audio_io.remove_temp(wav_tmp)
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
