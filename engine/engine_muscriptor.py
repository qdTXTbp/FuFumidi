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
            )
        except Exception:
            _ProgressEvent = _NoteStartEvent = _NoteEndEvent = None

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
            _cap = float(params.get("max_note_hold"))
        except Exception:
            _cap = None
        if _cap is None:
            _cap = 15.0          # 默认开：正常文件的时长上限是 12.3s，留有余量
        _cap_stats = {"closed": 0}

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
