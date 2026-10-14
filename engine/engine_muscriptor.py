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
            "模型权重虽已下载，但仍需安装该包：在资源中心点「安装 MuScriptor 运行时」即可。\n"
            "★ 不要直接 `pip install muscriptor` —— PyPI 上的 0.3.0 有长音频缺陷："
            "块边界的 tie 逻辑会让模型漏收尾的音符被无限延续，实测 100 分钟录播会产出"
            "4320 秒（全曲 72%）的超长音符。修复版托管在 "
            "github.com/monologue82/Models 的 muscriptor-runtime/（0.3.0+fufumidi.1）。")


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


def _make_pitch_evidence(wav_path, log_cb=None):
    """按**音高**判断「这个音此刻还有没有一个真正的音在响」（★ 2026-10-14 第三版）。

    前两版都被实测否掉了，记在这里免得再走一遍：
      ① 「边界前 0.5 秒整窗静音」（RMS ≤ −60 dBFS）：这段**一秒静音都没有**
         （每 0.5 s 窗 RMS 0.024~0.203，比阈值高 24~200 倍）→ 判据从不触发，
         一个僵尸音都没拦住。
      ② 「该音高的频带能量」：密集配器里**任何时刻都有能量** —— 实测僵尸音
         pitch 29 / 46 的频带能量全程 0.02~0.06（别的乐器与混响漏进来的），
         证据永远说"还在响"，21.9 秒的假长音一个也修不掉。

    真正能分辨的是**音调突出度**（prominence = f0 处的峰 ÷ 同八度邻域的中位数）。
    实测同一段音频（《原神》线上音乐会 2021 的 438~460 s）：
      · pitch 29（F1，43.7 Hz）：起音 6.0 / 5.1 → 一秒后掉到 ~1.0（根本没有这个音）
      · pitch 65（349 Hz）：全程 3~48（确实一直有内容 → 不动它）
    所以判据是"跟**自己起音时**的突出度比"，而不是跟绝对能量比。

    一次 STFT（8192 点 / 50 ms 一跳；8192 是为了低频也有 ~2 Hz 分辨率，F1 才分得出峰）
    算出 128 个音高的突出度与带内能量时间线。查询 fn(pitch, start, upto)：
      · 起音突出度 P0 = [start, start+0.3] 内突出度最大值；P0 < P_MIN → 不给证据
      · 阈值 = max(P_FLOOR, PROM_REL × P0)
      · 从后往前找最后一个「突出度 ≥ 阈值 且 带内能量 ≥ E_FLOOR」的帧 = 真正停止的位置
      · 到 upto 前仍在响（间隔 < 0.3 s）→ 返回 None（不动它）
    保守到底：任何一步不满足都返回 None。**宁可漏切一颗僵尸音，也不误伤真实长音。**
    """
    import numpy as np
    import soundfile as sf

    SR_TARGET = 16000
    N_FFT = 8192           # 0.51 s 窗：F1(43.7 Hz) 也要能分出峰
    HOP_MS = 50
    P_FLOOR = 1.6          # 突出度下限（≈ 没有明显峰）
    PROM_REL = 0.35        # 掉到"起音突出度"的这个比例以下 → 认为这个音停了
    P_MIN = 2.0            # 起音本身就不突出（≈ 没有这个音）→ 不给证据
    E_FLOOR = 0.002        # 带内能量下限（满幅 ≈ 1.0），挡掉极安静处的伪峰
    GRACE = 0.30           # 到边界前 0.3 s 还在响 → 判定"仍在延音"，不动
    ATTACK = 0.30          # 起音参考窗

    # ★ 既接受文件路径，也接受 (PCM, sr)：分段转录时每段已经在内存里，
    #   再落盘读一遍纯属浪费（100 分钟音频 400 MB）。
    if isinstance(wav_path, (tuple, list)) and len(wav_path) == 2:
        x = np.asarray(wav_path[0], dtype="float32")
        sr = int(wav_path[1])
        if getattr(x, "ndim", 1) > 1:
            x = x.mean(axis=1)
    else:
        x, sr = sf.read(wav_path, dtype="float32", always_2d=False)
        if getattr(x, "ndim", 1) > 1:
            x = x.mean(axis=1)
    if sr != SR_TARGET and x.size:
        try:
            import librosa as _lb
            x = _lb.resample(x, orig_sr=int(sr), target_sr=SR_TARGET)
            sr = SR_TARGET
        except Exception:
            pass
    hop = max(1, int(round(HOP_MS / 1000.0 * sr)))
    n_frames = max(0, 1 + (len(x) - N_FFT) // hop) if len(x) >= N_FFT else 0
    if n_frames < 4:
        return None                              # 太短：不给证据（调用方按上游行为处理）

    freqs = np.fft.rfftfreq(N_FFT, 1.0 / sr)
    peak_bins = []
    wide_bins = []
    for p in range(128):
        f0 = 440.0 * (2.0 ** ((p - 69) / 12.0))
        if f0 >= sr * 0.45:
            peak_bins.append(None)
            wide_bins.append(None)
            continue
        # 峰带：f0 ±3%（约 1 个半音的 1/6，够宽容也够尖）
        b0 = int(np.searchsorted(freqs, f0 * 0.97))
        b1 = int(np.searchsorted(freqs, f0 * 1.03))
        b0 = max(0, min(b0, freqs.size - 1))
        b1 = max(b0 + 1, min(b1, freqs.size))
        peak_bins.append((b0, b1))
        # 邻域：f0 的 0.75~1.30 倍，去掉峰带本身；高频带很宽，最多取 33 个点算中位数
        w0 = int(np.searchsorted(freqs, f0 * 0.75))
        w1 = int(np.searchsorted(freqs, f0 * 1.30))
        w0 = max(0, min(w0, freqs.size - 1))
        w1 = max(w0 + 1, min(w1, freqs.size))
        keep = np.arange(w0, w1)
        keep = keep[(keep < b0) | (keep >= b1)]
        if keep.size > 33:
            keep = keep[np.linspace(0, keep.size - 1, 33).astype(int)]
        wide_bins.append(keep)

    prom = np.zeros((128, n_frames), dtype="float16")   # 音调突出度
    band = np.zeros((128, n_frames), dtype="float16")   # 峰带能量（挡伪峰用）
    win = np.hanning(N_FFT).astype("float32")
    norm = N_FFT / 4.0                            # 满幅正弦 → 1.0
    offs = np.arange(N_FFT, dtype=np.int64)[None, :]
    BLK = 2048
    for s in range(0, n_frames, BLK):
        e = min(n_frames, s + BLK)
        starts = (np.arange(s, e, dtype=np.int64) * hop)[:, None]
        seg = x[starts + offs] * win
        mag = np.abs(np.fft.rfft(seg, axis=1)).astype("float32") / norm
        for p in range(128):
            pb = peak_bins[p]
            if pb is None:
                continue
            pk = mag[:, pb[0]:pb[1]].max(axis=1)
            wb = wide_bins[p]
            if wb is None or wb.size == 0:
                continue
            med = np.median(mag[:, wb], axis=1)
            band[p, s:e] = pk
            # ★ 注意：prom 是 float16，`prom[p, s:e].astype("float32")` 是**临时副本**，
            #   往它写 out= 等于什么都没存（第一版就这么写的，prom 全 0 → 证据永远 None）。
            _pr = pk / np.maximum(med, 1e-6)
            np.minimum(_pr, 1000.0, out=_pr)
            prom[p, s:e] = _pr
        del seg, mag

    hop_s = hop / float(sr)

    def fn(pitch, start, upto):
        try:
            p = int(pitch)
        except (TypeError, ValueError):
            return None
        if p < 0 or p > 127:
            return None
        i0 = int(float(start) / hop_s)
        i1 = int(float(upto) / hop_s)
        i0 = max(0, i0)
        i1 = min(n_frames, i1)
        if i1 - i0 < 3:
            return None
        pr = prom[p, i0:i1].astype("float32")
        en = band[p, i0:i1].astype("float32")
        if pr.size < 3:
            return None
        a = max(1, int(round(ATTACK / hop_s)))
        p0 = float(pr[:a].max()) if pr.size else 0.0
        if p0 < P_MIN:
            return None                           # 起音处就没有峰 → 无法判断，不给证据
        thr = max(P_FLOOR, PROM_REL * p0)
        ok = (pr >= thr) & (en >= E_FLOOR)
        idx = np.nonzero(ok)[0]
        if idx.size == 0:
            return None
        last = int(idx[-1])
        t_last = (i0 + last) * hop_s
        if float(upto) - t_last < GRACE:
            return None                           # 到边界还在响 → 不动
        if t_last <= float(start):
            return None
        return t_last

    return fn


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

    gpu_reason = ""
    if device and device != "auto":
        dev = device
    else:
        # 自动选择：优先 CUDA（Blackwell 需 cu128 torch，装好 GPU 增强包后自动生效）；
        # DirectML / MPS 暂不显式传入，交给 muscriptor 默认（保障 CUDA 优先、其余不破坏）
        dev = None
        try:
            from engine_gpu import torch_device as _torch_device
            from engine_gpu import detect as _gpu_detect
            _d = _torch_device()
            _g = _gpu_detect() or {}
            # xpu：Intel 专供包（torch+xpu）。muscriptor 把 device 原样交给 torch，
            # torch.device("xpu") 在 xpu 构建里是合法的。
            if _d in ("cuda", "mps", "xpu"):
                dev = _d
            elif _g.get("cuda") and _g.get("arch_supported") is False:
                # ★ issue #20：显卡在、但算力不在 CUDA 包的支持范围（GTX 10 系及更早）。
                #   这里必须**显式**传 cpu —— 传 None 会让 muscriptor 自己按"有 CUDA"挑回 GPU，
                #   然后在推理中途抛 `no kernel image is available`。
                dev = "cpu"
                gpu_reason = str(_g.get("arch_reason") or "")
            elif _g.get("cuda_usable") is False and _g.get("arch_reason"):
                dev = "cpu"
                gpu_reason = str(_g.get("arch_reason") or "")
        except Exception:
            dev = None
    # ② 提速梯队 1：计算精度。上游 load_model() 本身就收 dtype，是**一等公民特性** ——
    # 不是我们要发明的东西。上游还会把 conditioning 管线留在 fp32
    # （model.condition_provider.float()，注释说明安静段落的 log-mel 在 fp16 下会下溢），
    # 在 LMModel.forward 边界再 cast 回来。
    # 实测（Zen 5 / AVX512-BF16，15 秒素材）：fp32 8.4s → bf16 4.8s，提速 43%，
    # 事件数完全相同（199 起 / 199 止）。
    # ★ 但它改变数值精度、属于**影响质量**的开关 → 默认不传（= 上游默认 fp32），
    #   由用户显式选择，并在界面写明代价。
    _dtype = str(params.get("dtype") or "").strip() or None
    if _dtype:
        _log(log_cb, "计算精度：%s（bf16 更快，但数值精度与 fp32 不同）" % _dtype)
    try:
        model = TranscriptionModel.load_model(load_arg, device=dev, dtype=_dtype)
    except TypeError:
        # 老版本 muscriptor 的 load_model 不认 dtype：退回旧签名，别让整次转录失败
        model = TranscriptionModel.load_model(load_arg, device=dev)
    except Exception:
        model = TranscriptionModel.load_model(load_arg)

    if model._device and model._device.type == "cuda":
        _log(log_cb, "使用 GPU（CUDA）推理")
    elif model._device and model._device.type == "mps":
        _log(log_cb, "使用 GPU（Apple Metal）推理")
    else:
        _log(log_cb, "使用 CPU 推理（较慢）")
        if gpu_reason:
            _log(log_cb, "原因：" + gpu_reason + "；若想用 GPU 请更新显卡驱动或改用支持该算力的版本，"
                              "（本次已自动改用 CPU，转录结果不受影响，只是更慢）")

    _dev_type = getattr(getattr(model, "_device", None), "type", "") or ""

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
    # ★ 音频证据式收尾：让模型不再被迫延续"其实已经没声"的音（见 _make_pitch_evidence）。
    #   ★ 回放（--replay-tokens）也注入：wav 在这一步已经解码出来了（上面 audio_io.decode_to_wav），
    #     而回放台的意义就是"改了解码器逻辑后用 1 分钟复现"，把证据排除在外就复现不到改动。
    #     （2026-10-14 实测通过回放定位到问题：6505 次收尾**全部**是模型自己的 token，
    #      块边界批量收尾 374/195/1362/1587 个音 —— 所以证据必须进回放路径。）
    from dataclasses import replace as _replace      # 分段合并时改事件时间/index 用
    _SUSTAIN_EV = None                               # 分段路径要按段重新注入证据
    if not os.environ.get("FUFUMIDI_NO_EVIDENCE"):
        try:
            import time as _time_ev
            _t_ev = _time_ev.perf_counter()
            from muscriptor.events import set_sustain_evidence as _set_evidence
            _SUSTAIN_EV = _set_evidence
            _ev = _make_pitch_evidence(wav_tmp, log_cb)
            _set_evidence(_ev)
            _log(log_cb, "音频证据式收尾：已启用（按音高能量时间线收尾，不截断真实长音）"
                 "（构建 %.1fs）" % (_time_ev.perf_counter() - _t_ev))
        except Exception as _e:
            _log(log_cb, "音频证据式收尾不可用，按上游行为：%s" % _e)

    # ★ 静音分段（长音频提速）：见 engine/segmenter.py。**默认 off**（用户 2026-10-14 定），
    #   可在界面/CLI 选 auto（时长 ≥5 分钟且预计省 ≥3% 才启用）或 on。
    #   做法：按"完全空白静音"切成若干核心段，逐段推理，事件时间加段偏移后合并成一份 MIDI。
    #   为什么不在回放路径做：token 流是按整段音频落盘的，切片对不上。
    _seg_plan = None
    _seg_pcm = None
    _seg_sr = 0
    _seg_cfg = {}
    _seg_mode = str(params.get("segment_silence") or "off").strip().lower()
    if _seg_mode in ("off", "false", "0", "no", ""):
        _seg_mode = "off"
    for _k, _p in (("threshold", "silence_db"), ("min_silence", "min_silence"),
                   ("max_segment", "max_segment")):
        if params.get(_p) is not None:
            try:
                _seg_cfg[_k] = float(params[_p])
            except (TypeError, ValueError):
                pass
    if _seg_mode != "off" and not params.get("replay_tokens"):
        try:
            import segmenter as _segmod
            import soundfile as _sf
            _t_sg = time.perf_counter()
            _x, _sr = _sf.read(wav_tmp, dtype="float32", always_2d=False)
            if getattr(_x, "ndim", 1) > 1:
                _x = _x.mean(axis=1)
            _plan = _segmod.analyze(_x, _sr, **_seg_cfg)
            _ok, _why = _segmod.auto_enabled(_plan["duration"], _plan["skipped_sec"], _seg_mode)
            if _ok and len(_plan["segments"]) > 1:
                _seg_plan, _seg_pcm, _seg_sr = _plan, _x, _sr
                _log(log_cb, "静音分段：%s —— %d 段，跳过静音 %.1f s（%.1f%%），分析耗时 %.1fs"
                     % (_why, len(_plan["segments"]), _plan["skipped_sec"],
                        100.0 * _plan["skipped_sec"] / max(1e-6, _plan["duration"]),
                        time.perf_counter() - _t_sg))
            else:
                _log(log_cb, "静音分段未启用：%s" % _why)
        except Exception as _e:
            _log(log_cb, "静音分段分析失败，按整段转录：%s" % _e)
    try:
        # 真实进度上报：muscriptor 的 transcribe() 是事件流，其中夹带 ProgressEvent
        # （completed/total 个 5s 分块）。官方 transcribe_to_midi 内部即「事件流 →
        # events_to_midi_bytes」，这里改为自行组合，只为在事件流中插入进度透传。
        # 通过日志通道发送 ###PROG 前缀行，前端解析后替代「按时间估算」的假进度。
        import json as _json
        try:
            from muscriptor.events import (
                ProgressEvent as _ProgressEvent,
                NoteStartEvent as _NoteStartEvent,
                NoteEndEvent as _NoteEndEvent,
                ChunkBoundary as _ChunkBoundary,
            )
        except Exception:
            _ProgressEvent = _NoteStartEvent = _NoteEndEvent = _ChunkBoundary = None

        # ★ 僵尸音符上限（长音频转录的已知失效模式）
        #
        # muscriptor 按 5 秒分块转录，跨块的延音靠「tie 段」维持：块边界只关闭
        # **不在 tie 段里**的音符（events.py 的 OpenNoteTracker）。而 prelude_forcing
        # 打开时，tie 段是从「当前还开着的音符」**强制构造**出来的
        # （transcription_model.py: tie_section_token_ids(tracker.open_keys())）——
        # 于是「不在 tie 段里」几乎恒为空集：一个音只能靠模型在块内显式吐 note-off
        # 才结束。实测 100 分钟交响录播（6032 秒 / 1206 块）：模型从某个内容节点起
        # 开始漏收尾，之后每个音高都被拉成几分钟的长音（最长 4320 秒 = 全曲 72%，
        # 波形图上是一片实线墙）；>30 秒的音符占 12%。
        #
        # 这里在事件流上兜底：任何音持续超过 cap 秒就补一个收尾事件。
        # 离线模拟（两个坏文件 + 4 个正常文件）：cap=15s 把最长音从 4320.8 压到 15.0，
        # 而正常文件（最长 12.3s）**一个音符都不动**；cap=8s 会开始误伤。
        #
        # ★ 关键陷阱：补了收尾之后必须**吞掉**库随后为同一个 index 发的真实
        # NoteEndEvent —— events_to_midi_bytes 里是 open_notes.pop(ev.start_event_index)，
        # 重复收尾会直接 KeyError，把整次转录炸在最后一步。
        try:
            _mh = params.get("max_note_hold")
            _cap = float(_mh) if _mh is not None else None
        except Exception:
            _cap = None
        if _cap is None:
            _cap = 0.0           # ★ 默认不截断：僵尸音符由音频证据式收尾负责（界面开关已移除）
        _cap_stats = {"closed": 0}

        # ★ 逐块计时（#9 长音频尾部异常排查用，**默认关闭**）：
        #   设 FUFUMIDI_CHUNK_TIMING=1 时，每个块边界打一行
        #   `###CHUNKTIME {"i":块号,"seek":秒,"ms":距离上一块的毫秒}`。
        #   为什么挂在 ChunkBoundary 而不是 ProgressEvent：
        #   `_read_token_dump` 回放时**只吐 ChunkBoundary 与 token、不吐进度事件**，
        #   挂进度事件的话回放路上量不到 —— 而回放正是复现这类问题的快路子
        #   （148 分钟音频回放约 20 秒，重跑模型要半小时以上）。
        _chunk_timing = bool(os.environ.get('FUFUMIDI_CHUNK_TIMING'))
        _last_chunk_t = [None]
        _chunk_i = [0]

        def _timing_gen(stream):
            """真正的打点生成器。**只在 _chunk_timing 为真时才被调用**（见 _timing_tee）。"""
            for ev in stream:
                if _ChunkBoundary is not None and isinstance(ev, _ChunkBoundary):
                    _now = time.perf_counter()
                    _prev = _last_chunk_t[0]
                    _last_chunk_t[0] = _now
                    _chunk_i[0] += 1
                    if _prev is not None and log_cb:
                        try:
                            log_cb('###CHUNKTIME ' + _json.dumps({
                                'i': _chunk_i[0],
                                'seek': float(getattr(ev, 'seek_time', 0.0) or 0.0),
                                'ms': round((_now - _prev) * 1000.0, 3),
                            }))
                        except Exception:
                            pass
                yield ev

        def _timing_tee(stream):
            """包在**原始 token 流**上，逐块打点；**默认关闭时原样返回**。

            ★ 为什么必须包在原始流上（踩过一次）：ChunkBoundary **只存在于原始流里** ——
              实时模式被 `model.transcribe()` 内部消费掉，回放模式被 `decode_model_tokens()`
              消费掉，`_events_capped` 收到的已经是解码后的音符事件。
              第一版把打点放在 `_events_capped` 里，结果 `###CHUNKTIME` 一行都没出。

            ★★ 为什么开关必须在**这个普通函数**里分派，而不能写进生成器（踩过第二次，严重）：
              函数里只要有 `yield`，它整个就是生成器函数 —— 于是 `return stream`
              不是「返回 stream」，而是设置 `StopIteration.value`，调用方拿到的是
              **一个立刻耗尽、什么都不产出**的生成器。
              后果：计时关掉时（**默认就是关的**）整次转录产出 **0 个音符**。
              实测同一份回放由 98,288 音符变成 0 才暴露。
              所以打点逻辑另起 `_timing_gen`，开关在本函数分派。
            """
            if not _chunk_timing:
                return stream
            return _timing_gen(stream)

        # ★ `open_notes` 规模诊断（#9 用，默认关闭）：设 FUFUMIDI_OPEN_NOTE_PROBE=1。
        #   为什么量这个：`_expired(now)` 对**每个**带时间的事件都要遍历 open_notes 全部条目，
        #   即 O(K·E)。僵尸音符的失效模式正是「音符不收尾 → K 无界增长」。
        #   若 K 在某个时间点台阶式上涨，就能解释逐块耗时的 10 倍台阶。
        _open_probe = bool(os.environ.get('FUFUMIDI_OPEN_NOTE_PROBE'))
        _open_peak = [0]
        _open_seen = [0]

        def _events_capped(events):
            """进度透传 + 超长音符强制收尾（cap <= 0 时行为与旧版一致）。"""
            open_notes = {}
            force_closed = set()

            def _expired(now):
                out = []
                for idx, st in list(open_notes.items()):
                    if now - st.start_time > _cap:
                        out.append(_NoteEndEvent(end_time=st.start_time + _cap, start_event=st))
                        del open_notes[idx]
                        force_closed.add(idx)
                        _cap_stats["closed"] += 1
                return out

            for ev in events:
                if _cap > 0:
                    t = getattr(ev, "start_time", None)
                    if t is None:
                        t = getattr(ev, "end_time", None)
                    if t is not None:
                        for _end in _expired(t):
                            yield _end          # 先收尾，再吐触发它的事件，保持流有序
                if _ProgressEvent is not None and isinstance(ev, _ProgressEvent):
                    try:
                        if log_cb and getattr(ev, "total", 0):
                            log_cb('###PROG ' + _json.dumps(
                                {"completed": int(ev.completed), "total": int(ev.total)}))
                    except Exception:
                        pass
                    yield ev
                    continue
                if _NoteStartEvent is not None and isinstance(ev, _NoteStartEvent):
                    open_notes[ev.index] = ev
                    if _open_probe:
                        _open_seen[0] += 1
                        if len(open_notes) > _open_peak[0]:
                            _open_peak[0] = len(open_notes)
                        # 每 300 个 NoteStart 采样一次：要的是 K 随时间的**曲线**，
                        # 只看峰值不够 —— 峰值相同、持续时长不同，O(K·E) 的总代价差很远。
                        if _open_seen[0] % 300 == 0:
                            try:
                                log_cb('###OPENNOTES ' + _json.dumps({
                                    'n': _open_seen[0],
                                    'k': len(open_notes),
                                    't': round(float(getattr(ev, 'start_time', 0.0) or 0.0), 1),
                                }))
                            except Exception:
                                pass
                    yield ev
                    continue
                if _NoteEndEvent is not None and isinstance(ev, _NoteEndEvent):
                    idx = ev.start_event_index
                    if idx in force_closed:
                        force_closed.discard(idx)
                        continue        # ★ 丢弃重复收尾，否则下游 pop 会 KeyError
                    open_notes.pop(idx, None)
                    yield ev
                    continue
                yield ev
            # 流末兜底：库保证每个 Start 都有 End，这里只兜住异常情况
            if _cap > 0:
                for idx, st in list(open_notes.items()):
                    yield _NoteEndEvent(end_time=st.start_time + _cap, start_event=st)
                    del open_notes[idx]
                    _cap_stats["closed"] += 1

        def _segmented_events(plan, pcm, sr):
            """逐段推理并合并事件流（★ 静音分段）。

            三条不变量（错了就会丢音/重音，改动前先看这里）：
              1. **偏移精确**：每段事件时间 = 段内时间 + 该段在原始时间轴上的起点
                 （模型时间轴 = 解码时间轴，前面已验证；不是估的）。
              2. **只在核心区留音符**：起音落在 padding 里的音符丢掉（它属于邻段），
                 否则接缝处会出现两份同样的音。
              3. **index 必须重编号**：上游每个转录流的 index 都从 0 开始，直接合并会让
                 events_to_midi_bytes 的 open_notes 字典撞键（它按 index 配对）。
            """
            import soundfile as _sf2
            import tempfile as _tf
            segs = plan["segments"]
            pad = float(params.get("segment_pad") or 1.0)
            chunk_sec = 5.0
            per = [max(1, int((e - s) / chunk_sec + 0.999)) for s, e in segs]
            total_chunks = sum(per)
            done_chunks = 0
            base_index = 0
            tmps = []
            try:
                for si, (cs, ce) in enumerate(segs):
                    a = max(0, int(round((cs - pad) * sr)))
                    b = min(len(pcm), int(round((ce + pad) * sr)))
                    if b - a < sr:                      # 短于 1 秒的段没有意义
                        done_chunks += per[si]
                        continue
                    fd, seg_wav = _tf.mkstemp(prefix="fufumidi-seg-", suffix=".wav")
                    os.close(fd)
                    tmps.append(seg_wav)
                    _sf2.write(seg_wav, pcm[a:b], sr)
                    if _SUSTAIN_EV is not None:      # 每段各自建证据（100 s 音频约 0.3 s）
                        try:
                            _SUSTAIN_EV(_make_pitch_evidence((pcm[a:b], sr), log_cb))
                        except Exception:
                            pass
                    off = a / float(sr)
                    kept = {}
                    dropped = set()
                    for ev in model.transcribe(seg_wav, instruments=constrain, **_gen_kw):
                        if _ProgressEvent is not None and isinstance(ev, _ProgressEvent):
                            yield _ProgressEvent(completed=done_chunks + int(getattr(ev, "completed", 0)),
                                                 total=total_chunks)
                            continue
                        if _NoteStartEvent is not None and isinstance(ev, _NoteStartEvent):
                            t = float(ev.start_time) + off
                            if not (cs - 0.02 <= t < ce - 0.02):   # 落在 padding 里 → 归邻段
                                dropped.add(ev.index)
                                continue
                            new = _replace(ev, start_time=t, index=base_index)
                            base_index += 1
                            kept[ev.index] = new
                            yield new
                            continue
                        if _NoteEndEvent is not None and isinstance(ev, _NoteEndEvent):
                            idx = ev.start_event_index
                            if idx in dropped or idx not in kept:
                                continue
                            t = float(ev.end_time) + off
                            yield _replace(ev, end_time=t, start_event=kept[idx])
                            continue
                        yield ev
                    done_chunks += per[si]
            finally:
                for p_ in tmps:
                    try:
                        os.remove(p_)
                    except OSError:
                        pass

        # 节拍网格只检测一次（OOM 降级重试时复用，避免重复解码/检测）。
        # 权重经资源中心下载到 modelsDir/hub/checkpoints/beat_this-final0.ckpt（TORCH_HOME 指向
        # modelsDir，torch.hub 读到同名缓存即复用，离线可用）；未下载或加载失败时自动跳过，
        # 回退为「无节拍网格」的旧调用，绝不阻断转录。
        beat_grid = None
        # 回放时不用音频：节拍网格直接用落盘的那份（见 _read_token_dump），
        # 省掉整首歌的 Beat This! 检测 —— 100 分钟音频那一步本身就要好几分钟。
        beat_enabled = bool(params.get("beat_grid", False)) and not params.get("replay_tokens")
        if beat_enabled:
            _mdir = os.environ.get("FUFUMIDI_MODELS_DIR", "") or ""
            _ckpt = os.path.join(_mdir, "hub", "checkpoints", "beat_this-final0.ckpt") if _mdir else ""
            if _ckpt and os.path.isfile(_ckpt) and os.path.getsize(_ckpt) > 0:
                try:
                    beat_grid = model.detect_beat_grid_for(wav_tmp)
                    _log(log_cb, "已加载节拍网格（Beat This! 本地权重）")
                except Exception as e:
                    beat_grid = None
                    _log(log_cb, f"节拍网格检测失败，已跳过（不影响转录）：{e}")
            else:
                _log(log_cb, "未找到节拍网格权重，已跳过（可在资源中心下载「节拍网格检测 / Beat This!」以提升时值对齐）")
        else:
            _log(log_cb, "已关闭节拍网格检测")

        # muscriptor 0.3+ 的 transcribe_to_midi 返回 MIDI 字节（非写文件）。
        # 批量推理开关：prelude_forcing=False + batch_size>1 可提速 2-4×（长音频 chunk 串行是
        # 大瓶颈）。**代价不是"边界质量略降"那么轻** —— prelude_forcing 的作用正是把"上一块
        # 未结束的音"按原乐器 teacher-force 进下一块的 tie 段；关掉后模型会自己猜，于是每 5s
        # 一次的分块边界上，延音会被重新判定乐器（muscriptor 自己的文档原话：
        # "instead of letting the model guess (and occasionally re-enter with the wrong
        # instruments)"）。实测《甩葱歌》同一首歌、同一模型：
        #   batch=1（prelude ON）：非鼓轨 5 条、2531 音、相邻分块换组 1 次
        #   batch=4（prelude OFF）：非鼓轨 9 条、1962 音（少 22%）、相邻分块换组 16 次
        # 所以它不是默认项，而是界面上一个写明代价的开关（默认关）。
        # 测速参考（RTX 5070 Ti，medium，120s）：batch=1 57s → batch=4 25s → batch=8 23s。
        # 乐器组：MuScriptor 是多乐器模型，逐音符判定乐器组；不约束时它会在同一首歌里改判
        # （实测：同一条旋律 24s 判成 organ、33s 判成 synth lead、96s 变成 voice），
        # 于是同一段旋律每隔几小节换一次音色。muscriptor 的 transcribe() 支持硬约束
        # （transcription_model.py: "instruments ... is a hard constraint"，内部用
        # forbidden_token_ids 禁止采样其它乐器组）。三种取值：
        #   'voice,piano' —— 作为硬约束（界面「限定乐器组（硬约束）」）。
        #   其它/不传      —— 不限定，模型自由判定（界面默认；也是引擎缺省语义）。
        #
        # 说明：曾经有过 'auto'（转录前用 instrument_probe 预分析几段再锁定）这一档，
        # 实测收益只有"剪掉长尾杂音"（圆号/萨克斯那种为几个音冒出来的轨），而"换音色"的真正
        # 原因是分块边界（prelude_forcing，见上面的批量推理说明），预分析救不了它，
        # 因此界面已去掉这一档。instrument_probe.py 仍保留为**独立分析工具**
        # （python instrument_probe.py 歌曲.flac --json，看模型会把这首歌判成哪些乐器）。
        import instrument_probe
        _mode, _groups = instrument_probe.parse_mode(params.get("muscriptor_instruments"))
        constrain = _groups if _mode == "limit" else None
        if not constrain:
            _log(log_cb, "未限定乐器组：模型自由判定（同一段旋律可能被写成多种音色）")
        if constrain:
            _log(log_cb, "旋律乐器组已锁定：" + " / ".join(constrain) + "（模型不会输出其它乐器）")
        t0 = time.perf_counter()
        data = None
        # ★ CUDA 运行期错误只重试一次 CPU（issue #20 的兜底：算力/驱动问题不该让整次转录失败）
        cuda_fallback_done = False
        # ① 回放台：--dump-tokens 落盘 / --replay-tokens 回放（见本文件上方 _install_token_dump）
        #    回放不跑模型、不用 GPU，只把 token 流重新过一遍解码器 —— 改解码器逻辑时用它验证。
        _dump_to = str(params.get("dump_tokens") or "")
        _replay_from = str(params.get("replay_tokens") or "")
        _dump_fh = None
        if _replay_from:
            if not os.path.isfile(_replay_from):
                raise RuntimeError("找不到 token 流文件：%s" % _replay_from)
            _g_grid = _read_token_dump(_replay_from)[1]
            if _g_grid is not None:
                beat_grid = _g_grid
                _log(log_cb, "回放：沿用落盘时的节拍网格，跳过节拍检测")
            _log(log_cb, "回放 token 流（不跑模型、不用 GPU）：%s" % os.path.basename(_replay_from))
        # ④ 批 B：生成参数（默认一律不传 = 与旧版完全一致的贪婪解码）。
        # 用户调了 temperature / cfg_coef 才自动打开采样 —— 采样关着时这两个值是被忽略的，
        # 界面给了滑块却不生效就是坑。
        _gen_kw = {}
        for _k, _cast in (("temperature", float), ("cfg_coef", float), ("beam_size", int)):
            _v = params.get(_k)
            if _v is not None:
                try:
                    _gen_kw[_k] = _cast(_v)
                except (TypeError, ValueError):
                    pass
        if params.get("prelude_forcing") is not None:
            _gen_kw["prelude_forcing"] = bool(params["prelude_forcing"])
        # beam_size > 1 时不要再开采样：束搜索要求确定性地逐 token 打分，
        # 两者同时给上游会互相打架。
        if _gen_kw.get("beam_size", 1) <= 1 and (
                _gen_kw.get("temperature", 1.0) != 1.0 or _gen_kw.get("cfg_coef", 1.0) != 1.0):
            _gen_kw["use_sampling"] = True
        if _gen_kw:
            _log(log_cb, "生成参数：" + "，".join("%s=%s" % kv for kv in sorted(_gen_kw.items())))
        while data is None:
            try:
                if _replay_from:
                    # 解码器只吃 token 流，回放不需要音频/模型/GPU
                    from muscriptor.events import decode_model_tokens as _decode
                    _stream, _ = _read_token_dump(_replay_from)
                    _stream = _timing_tee(_stream)
                    events = _decode(_stream, model._tokenizer._vocab,
                                     model._instrument_for_program,
                                     frame_rate=model._tokenizer.frame_rate)
                else:
                    if _dump_to and _dump_fh is None:
                        _dump_fh = _install_token_dump(model, _dump_to, beat_grid)
                        _log(log_cb, "token 流落盘：%s（可用 --replay-tokens 复现解码器缺陷）"
                                      % os.path.basename(_dump_to))
                        # ③ 崩溃/取消时不白费：落盘句柄是带缓冲的，进程被中断时
                        # 缓冲区里那几 KB 可能丢。注册 atexit 保证无论如何都刷盘 ——
                        # 于是「跑到第 80 分钟崩了」至少留下一份可 --replay-tokens 的
                        # 部分流（约 1 分钟就能出一份「前 N 块」的 MIDI），
                        # 而不是 148 分钟全部作废。
                        import atexit as _atexit

                        def _flush_dump(_fh=_dump_fh):
                            try:
                                if _fh and not _fh.closed:
                                    _fh.flush()
                                    _fh.close()
                            except Exception:
                                pass

                        _atexit.register(_flush_dump)
                    # 实时路径的逐块计时：同样要包在 `_generate_token_stream`（原始流）上，
                    # 因为它被 `transcribe()` 内部消费，外面拿不到 ChunkBoundary。
                    if _chunk_timing and not getattr(model, '_fufumidi_timing_teed', False):
                        _orig_gts = model._generate_token_stream

                        def _gts_teed(*a, _o=_orig_gts, **kw):
                            return _timing_tee(_o(*a, **kw))

                        model._generate_token_stream = _gts_teed
                        model._fufumidi_timing_teed = True
                    if _seg_plan is not None:
                        events = _segmented_events(_seg_plan, _seg_pcm, _seg_sr)
                    else:
                        events = model.transcribe(wav_tmp, instruments=constrain, **_gen_kw)
                data = model.events_to_midi_bytes(_events_capped(events), beat_grid=beat_grid)
                if _cap > 0:
                    _log(log_cb, "超长音符上限 %.0fs：强制收尾 %d 个音符"
                                  % (_cap, _cap_stats["closed"]))
            except Exception as e:
                # 显存溢出自动降级：batch ≥2 → 减半重试 → 串行兜底，绝不因此转录失败
                oom = "out of memory" in str(e).lower() or "OutOfMemoryError" in type(e).__name__
                # ★ CUDA 运行期错误（no kernel image / 设备断言 / 非法访存…）→ 自动改用 CPU 重跑一次。
                #   实测 issue #20：`CUDA error: no kernel image is available for execution on the device`
                #   以前原样抛给用户、整次转录失败；现在换 CPU 继续，并在日志里说明原因。
                _ck = ""
                try:
                    from engine_gpu import cuda_error_kind as _kind, cuda_error_hint as _hint
                    _ck = _kind(e)
                except Exception:
                    _ck = ""
                if _ck and _ck != "oom" and not cuda_fallback_done and (
                        _dev_type in ("cuda", "mps") or str(dev or "").startswith(("cuda", "mps"))):
                    cuda_fallback_done = True
                    try:
                        _h = _hint(_ck)
                    except Exception:
                        _h = ""
                    _log(log_cb, "GPU 推理失败：%s（%s）" % (_ck, str(e).strip().splitlines()[0][:200]))
                    if _h:
                        _log(log_cb, _h)
                    try:
                        import torch
                        if torch.cuda.is_available():
                            torch.cuda.empty_cache()
                    except Exception:
                        pass
                    model = TranscriptionModel.load_model(load_arg, device="cpu")
                    dev = "cpu"
                    _log(log_cb, "已改用 CPU 重跑本次转录（慢一些，但结果可用）…")
                    continue
                raise
        _log(log_cb, f"[计时] muscriptor 推理（含解码/分块/解码为 MIDI）：{time.perf_counter() - t0:.1f}s")
    finally:
        audio_io.remove_temp(wav_tmp)
    with open(output_midi, "wb") as f:
        f.write(data)

    # 说明：以前这里还会对转录结果做一遍「按音搬移、把主旋律收进一个音色」的事后归并。
    # 实测对用户听感几乎没帮助（可动的范围常常只有几十秒），已改为在**模型之前**用
    # instrument_probe 预分析并锁定乐器组 —— 一次推理就给出正确的组，不再事后搬音符。

    # 音符数统计（pretty_midi）
    n = _count_notes(output_midi)
    _log(log_cb, f"保存 MIDI → {os.path.basename(output_midi)}（{n} 音符）")

    # ★ 质量自检：把时长分布打进日志。
    #
    # 为什么必须打：长音频转录有两种失效模式，光看「最长」和「音符数」都会漏判 ——
    #   ① prelude_forcing 开启时：少数音符变僵尸（最长可达 4320s），但整体分布正常；
    #   ② 关闭后（批量推理）：没有僵尸音了，但**全曲**平均时长从 0.33s 涨到 1.6~1.8s
    #      （>2s 占比 38%），听起来是一糊片。
    # 只报「最长」会把 ② 判成健康（最长才 16s），实测就是这么被骗过一次。
    # 正常参考：中位数 0.2~0.4s、>2s 占比 <5%。
    _st = _duration_stats(output_midi)
    if _st:
        _bad = (_st["median"] > 1.0) or (_st["over2"] > 15.0)
        _log(log_cb, "[自检] 音符 %d，时长中位数 %.2fs，>2s 占 %.1f%%，最长 %.1f s%s"
                      % (_st["count"], _st["median"], _st["over2"], _st["max"],
                         "　← 偏离正常参考（中位数 0.2~0.4s、>2s <5%），建议检查" if _bad else ""))

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


# ============================================================
# ① 回放台：token 流落盘 / 回放（长音频解码器实验的加速器）
# ============================================================
#
# 为什么需要：僵尸音符那类缺陷在**解码器**（OpenNoteTracker），不在模型。
# 但复现它必须先把 100 分钟音频跑一遍模型 —— 实测 1206 个 5 秒块串行约 48 分钟。
# 而解码器吃的是 token 流（一串 int + ChunkBoundary），纯 Python、不需要 torch。
# 所以：真实转录时把 token 流顺手落盘（几 MB），之后改解码器逻辑都用回放验证 ——
# 省掉模型生成，48 分钟 → 约 1 分钟。
#
# 落盘格式 JSONL，每行一个对象：
#   {"g": {...BeatGrid 字段...}}   首行，节拍网格（回放时直接用，省掉检测）
#   {"b": [seek_time, next_seek_time]}   ChunkBoundary
#   {"t": <token 索引>}               模型 token


def _install_token_dump(model, path, beat_grid=None):
    """把 model._generate_token_stream 的输出 tee 到文件。

    做法是在**实例上**包一层，然后照常调用 model.transcribe() —— 不去复制
    transcribe() 内部构造 conditions / seek_times 的那几十行私有逻辑（那种复制
    一旦上游改了就会静默走偏）。
    """
    import json as _json
    fh = open(path, "w", encoding="utf-8")
    # 只落盘标量字段 + beats 数组：asdict() 会把 np.ndarray 原样带出来，json 序列化会炸。
    # beats 必须留 —— notes_to_midi() 在 onset_delay 为 None 时会用 beats 现算，丢了它回放
    # 出来的 MIDI 会和原始那次不一样（拍位偏移）。
    _g = None
    if beat_grid is not None:
        try:
            _b = getattr(beat_grid, "beats", None)
            _g = {
                "bpm": float(beat_grid.bpm),
                "beats_per_bar": beat_grid.beats_per_bar,
                "first_downbeat": float(beat_grid.first_downbeat),
                "onset_delay": beat_grid.onset_delay,
                "beats": (None if _b is None else [float(x) for x in _b]),
            }
        except Exception:
            _g = None
    fh.write(_json.dumps({"g": _g}, ensure_ascii=False) + "\n")
    orig = model._generate_token_stream

    def teed(*a, **kw):
        from muscriptor.events import ChunkBoundary as _CB, ProgressEvent as _PE
        for item in orig(*a, **kw):
            if isinstance(item, _CB):
                # 必须用 json.dumps：最后一个块的 next_seek_time 是 None，
                # %r 会写成 JSON 认不出的 None，读回时整行被当成坏行丢掉 ——
                # 于是末块的 ChunkBoundary 消失，回放结果会比原始多出几个音符
                # （实测 15 秒样例：197 → 198）。
                fh.write(_json.dumps({"b": [item.seek_time, item.next_seek_time]}) + "\n")
            elif isinstance(item, int):
                fh.write('{"t": %d}\n' % item)
            elif isinstance(item, _PE):
                pass                      # 进度事件不落盘（回放时自行补）
            yield item

    model._generate_token_stream = teed
    return fh


def _read_token_dump(path):
    """读回 token 流：返回 (生成器, BeatGrid 或 None)。"""
    import json as _json
    from muscriptor.events import ChunkBoundary as _CB
    with open(path, encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    grid = None
    start = 0
    if lines and lines[0].lstrip().startswith('{"g"'):
        try:
            g = _json.loads(lines[0]).get("g")
            if g:
                from muscriptor.utils.beats import BeatGrid
                _b = g.pop("beats", None)
                if _b is not None:
                    import numpy as _np
                    _b = _np.asarray(_b, dtype=float)
                grid = BeatGrid(beats=_b, **g)
        except Exception:
            grid = None
        start = 1

    def gen():
        for ln in lines[start:]:
            if not ln:
                continue
            try:
                o = _json.loads(ln)
            except Exception:
                continue
            if "b" in o:
                yield _CB(o["b"][0], o["b"][1])
            elif "t" in o:
                yield int(o["t"])

    return gen(), grid


def _duration_stats(midi_path):
    """转录质量自检：音符数 / 时长中位数 / >2s 占比 / 最长时长。

    正常参考（实测 12 首短曲）：中位数 0.2~0.4 s、>2 s 占比 <5%、最长 <15 s。
    """
    try:
        import pretty_midi
        pm = pretty_midi.PrettyMIDI(midi_path)
        durs = sorted(note.end - note.start
                      for inst in pm.instruments for note in inst.notes)
        if not durs:
            return None
        n = len(durs)
        return {
            "count": n,
            "median": durs[n // 2],
            "over2": sum(1 for d in durs if d > 2.0) * 100.0 / n,
            "max": durs[-1],
        }
    except Exception:
        return None


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
