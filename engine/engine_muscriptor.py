# -*- coding: utf-8 -*-
"""
MuScriptor 通用多乐器转录引擎（Mirelo × Kyutai）
================================================
- 多乐器 / 人声 / 混合音轨 → MIDI（MT3 tokenization，decoder-only transformer）
- 规格：small(≈100M) / medium(≈300M, 默认) / large(≈1.3B)
- 权重默认不在 Release 中，需到资源中心按规格下载（HF 官方 / hf-mirror）

★★ 2026-11-07：本文件**整体回退到最初接入 MuScriptor 的形态**。
   用户报障「效果还是不行」，决定不再在模型外面叠任何补丁层，一律按官方用法：

       model = TranscriptionModel.load_model(size 或本地 .safetensors 路径)
       midi  = model.transcribe_to_midi(audio)      # 默认参数

   官方 Quickstart（huggingface.co/MuScriptor/muscriptor-medium）就是这两行：
   输入交给 libsndfile 直读、内部重采样 16k 单声道、5 秒块、prelude_forcing 默认开、
   贪心解码、默认做 best-effort 节拍网格检测并把音符起点贴到网格上。

   历史教训：3.1.2 起把这一行换成「事件流 + 自定义生成参数 + 音频预处理 + 乐器组探测 +
   证据式收尾 + 跨块缝合」，之后 6.2 / 6.4 反复回退/再引入，质量一直不稳。凡模型外的
   改写都会改变模型听到的东西或写出的 MIDI，**这类层一律不再有**。

   本文件只保留三类与质量无关的东西：
     1) 本地权重解析（资源中心下载到 FUFUMIDI_MODELS_DIR，离线可用）
     2) 暂停闸门（只延迟事件流出，不改事件）
     3) GPU 失败/显存不足 → 换 CPU 重跑一次（同一行调用，参数不变）

★★ 2026-11-08：对照官方提交 302343e8 与第三方包装 music-to-midi 后补两件事，
   **都不是模型外的补丁层**，只是把官方 API 用完整：
   a) 官方 `transcribe()` 的事件流每 5 秒块交织一个 ProgressEvent，
      而 `events_to_midi_bytes()` 会把它 `continue` 掉 —— 必须在流上拦截转成
      ###PROG，否则任务中心永远停在「推理中」。
   b) 官方 `prelude_forcing=True`（跨块续音按原乐器，fix issue #3）与
      `instruments=[...]`（硬掩其它乐器/鼓 token，第三方 CLI 的 --instrument）
      是跨块音色/鼓组稳定的唯一官方杠杆。旧 wheel 不认这些 kwargs（6.4.5 曾因此
      整次 TypeError），所以先用 inspect.signature 探测能力，再显式传，失败静默退回
      零 kwargs —— 绝不改事件、不改音频、不改 MIDI 字节。
"""
import inspect
import json
import os
import time

import pause_gate as _pause_gate_mod

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
    """包缺失时的明确指引：区分「缺 Python 包」与「缺模型权重」。

    ★ 把底层 ImportError 原文 + 解释器/PYTHONPATH 一起报出来 —— 只写「import muscriptor
      失败」时无法区分「没装包」「torch 没挂上」「PYTHONPATH 指向了不匹配的 GPU 包」。
    """
    try:
        import muscriptor  # noqa: F401
        return True
    except Exception as _e:
        import traceback as _tb
        _detail = "%s: %s" % (type(_e).__name__, _e)
        try:
            _detail += "\n" + "".join(_tb.format_exc().splitlines(True)[-4:])
        except Exception:
            pass
        try:
            import sys as _sys
            _detail += "\n解释器：%s\nPYTHONPATH：%s" % (
                _sys.executable, os.environ.get("PYTHONPATH", "(未设置)"))
        except Exception:
            pass
        raise RuntimeError(
            "未安装 muscriptor Python 运行时包（应用环境的 Python 里 `import muscriptor` 失败）。"
            "模型权重虽已下载，但仍需安装该包：在资源中心点「安装 MuScriptor 运行时」即可。\n"
            "★ 不要直接 `pip install muscriptor` —— PyPI 上的 0.3.0 有长音频缺陷："
            "块边界的 tie 逻辑会让模型漏收尾的音符被无限延续，实测 100 分钟录播会产出"
            "4320 秒（全曲 72%）的超长音符。修复版托管在 "
            "github.com/monologue82/Models 的 muscriptor-runtime/（0.3.0+fufumidi.1）。\n"
            "—— 底层错误 ——\n" + _detail)


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


def _load_model(size, device, log_cb):
    """按官方 Quickstart 加载模型：规格名（HF）或本地权重路径。"""
    from muscriptor import TranscriptionModel

    local = _find_local_model(size)
    if local:
        _ensure_config(local, size)
        _log(log_cb, "加载 MuScriptor-%s（本地权重）…" % size)
        load_arg = local
    else:
        ready = available_local_sizes()
        if size not in ready and ready:
            raise RuntimeError(
                "未找到 MuScriptor-%s 本地权重，请到【资源中心 → MuScriptor】下载 %s 规格后再试"
                "（当前已就绪：%s）。" % (size, size, " / ".join(ready)))
        _log(log_cb, "加载 MuScriptor-%s（HuggingFace，需授权）…" % size)
        load_arg = size

    if device:
        try:
            return TranscriptionModel.load_model(load_arg, device=device)
        except TypeError:
            # 老版本 muscriptor 的 load_model 不认 device：退回默认签名
            pass
    return TranscriptionModel.load_model(load_arg)


# 本次转录有没有拿到官方节拍网格。engine.py 用它决定「要不要再用自己的测速兜底」：
# 拿到网格 → MIDI 里已有速度与网格，不能再整曲重缩放；没拿到 → 退回 _apply_auto_bpm。
LAST_BEAT_GRID = {"used": False, "reason": ""}


def _grid_checkpoint_available():
    """Beat This! 权重是否已在本地（torch.hub 缓存目录，应用把 TORCH_HOME 指向模型目录）。

    ★ 必须先查文件再调用：上游 load_checkpoint 在本地找不到时会去 JKU 云盘下载，
      国内基本连不上，实测卡在 TCP 超时上好几分钟（60 秒素材跑成 4 分钟还没出结果）。
      权重不在就**立刻跳过**网格，别拿用户的时间去赌一个连不上的域名。
    """
    try:
        import torch.hub as _hub
        p = os.path.join(_hub.get_dir(), "checkpoints", "beat_this-final0.ckpt")
        return os.path.isfile(p) and os.path.getsize(p) > 1000000
    except Exception:  # noqa: BLE001
        return False


def _detect_grid(model, wav, log_cb):
    """官方 best-effort 节拍网格。

    上游只捕获它自己的 BeatDetectionError；权重缺失 / 下载失败时抛的是
    ValueError('Could not load the checkpoint … final0')，会直接炸掉整次转录。
    这里先查本地权重，再放宽异常范围：网格只是锦上添花，没有它也必须能转出 MIDI。
    """
    if not _grid_checkpoint_available():
        LAST_BEAT_GRID["used"] = False
        LAST_BEAT_GRID["reason"] = "节拍网格权重未安装"
        _log(log_cb, "节拍网格检测跳过（未安装 Beat This! 权重）—— 按上游占位速度写 MIDI；"
                     "资源中心装「节拍网格检测」后会按官方默认自动启用")
        return None
    try:
        grid = model.detect_beat_grid_for(wav, "best-effort")
        LAST_BEAT_GRID["used"] = grid is not None
        LAST_BEAT_GRID["reason"] = ""
        return grid
    except Exception as e:  # noqa: BLE001
        LAST_BEAT_GRID["used"] = False
        LAST_BEAT_GRID["reason"] = str(e).strip().splitlines()[0][:160]
        _log(log_cb, "节拍网格检测跳过（%s）—— 按上游占位速度写 MIDI"
             % LAST_BEAT_GRID["reason"])
        return None


def _progress_stream(events, log_cb):
    """把官方 ProgressEvent 透传成任务中心进度（**事件本身原样往下传**）。

    官方 transcribe() 在开头 yield 一个 (completed=0, total=N)，之后每完成一个
    5 秒块 yield 一个；events_to_midi_bytes 会 `continue` 掉它们。主进程
    main/engine.js 认 `###PROG {"completed":n,"total":m}`（见 :159），
    所以这里只加日志，不碰事件顺序、不做缓冲 —— 流式语义与暂停闸门都保持。
    """
    last = -1
    for ev in events:
        done = getattr(ev, "completed", None)
        total = getattr(ev, "total", None)
        if (isinstance(done, int) and isinstance(total, int)
                and total > 0 and done != last):
            last = done
            _log(log_cb, "###PROG " + json.dumps({"completed": done, "total": total}))
            if done:
                _log(log_cb, "[推理] 已转录 %d/%d 个 5 秒片段" % (done, total))
        yield ev


def _valid_instruments(groups):
    """用官方词表过滤名字，避免上游 ValueError 把整次转录炸掉。"""
    try:
        from muscriptor.tokenizer.mt3 import MT3_FULL_PLUS_GROUP_NAMES as valid
        return [g for g in groups if g in valid]
    except Exception:  # noqa: BLE001
        return groups      # 词表拿不到就交给上游自己校验


def _transcribe_kwargs(model, wav, params, log_cb):
    """只在「本机 muscriptor 支持」时显式传官方参数；旧 wheel 一律零 kwargs。

    两项都是**官方 API**，不是模型外的补丁层（不改音频、不改事件、不改 MIDI 字节）：
      · prelude_forcing=True —— 官方默认：把上一块没结束的音按原乐器续进下一块。
        管的是「续音」，管不了「新起音被判成别的乐器」。
      · instruments=[...]   —— 官方硬约束：整曲掩掉列表外的 program/drum token。
        第三方包装 CLI 的 --instrument 就是它。2026-10-18 A/B（medium，30s 双音色）
        实测「整曲锁定」把音色切换 5 → 0、F1 0.4914 → 0.7692，峰值显存不变，
        代价约 +1s 预分析（GPU）。因此 **默认 probe**：先用同一模型在 3 段
        20 秒代表窗上短推理，取并集锁定（drums 探测到就必留，见 instrument_probe）。

    取值：'probe'(默认) / 'none'、'off'、'free' / 逗号分隔的官方组名 / 组名列表。
    预分析失败、或旧 wheel 不认 instruments，都静默退回「官方自动识别」并留日志，
    绝不让预分析拖垮整次转录。
    """
    try:
        names = set(inspect.signature(model.transcribe).parameters)
    except Exception:  # noqa: BLE001
        return {}
    kw = {}
    if "prelude_forcing" in names:
        kw["prelude_forcing"] = True
    else:
        # ★ 旧 wheel 没有 teacher forcing：块边界会用错误乐器重新起音、鼓点断续
        #   （官方 issue #3）。内置 Python 运行时受 ignoreFolderPath 保护、
        #   不随应用更新升级，装得早的用户极易命中这一条，必须说清楚。
        _log(log_cb, "[模型] 当前 MuScriptor 运行时过旧（缺 prelude_forcing）：跨块"
             "音色与鼓点可能不稳定；建议重装完整安装包或更新内置运行时")

    raw = (params or {}).get("muscriptor_instruments")
    mode, groups = "probe", []
    try:
        import instrument_probe as _ip
        mode, groups = _ip.parse_mode(raw if raw is not None else "probe")
    except Exception:  # noqa: BLE001
        # 探测模块不可用时仍支持手动组名
        if isinstance(raw, str) and raw.strip() and raw.strip().lower() not in ("none", "off", "free", "-", "probe"):
            mode, groups = "limit", [x.strip() for x in raw.split(",") if x.strip()]

    if mode in ("probe", "probe_segments", "segments"):
        if "instruments" not in names:
            _log(log_cb, "[模型] 当前 muscriptor 不支持 instruments，无法自动锁定乐器组")
        else:
            try:
                import instrument_probe as _ip
                _log(log_cb, "[预分析] 扫描整曲代表片段，锁定乐器组（音色稳定）…")
                r = _ip.probe(model, wav, log=lambda s: _log(log_cb, s))
                groups = list(r.get("groups") or [])
                if groups:
                    _log(log_cb, "[预分析] 整曲锁定：%s" % ", ".join(groups))
                else:
                    _log(log_cb, "[预分析] 没探到可用乐器组（%s），按官方自动识别"
                         % (r.get("reason") or "unknown"))
            except Exception as e:  # noqa: BLE001
                _log(log_cb, "[预分析] 失败（%s），按官方自动识别" % str(e)[:120])
                groups = []

    if groups and "instruments" in names:
        ok = _valid_instruments(groups)
        if ok:
            kw["instruments"] = ok
            _log(log_cb, "[模型] 限定乐器组（官方硬约束）：%s" % ", ".join(ok))
            if len(ok) != len(groups):
                _log(log_cb, "[模型] 忽略无效乐器名：%s"
                     % ", ".join(g for g in groups if g not in ok))
        else:
            _log(log_cb, "[模型] 乐器组名字全部无效，已按官方自动识别")
    elif groups:
        _log(log_cb, "[模型] 当前 muscriptor 不支持 instruments，忽略限定乐器组")
    return kw


def transcribe_muscriptor(audio_path, output_midi, params=None, log_cb=None,
                          num_threads=None, **kwargs):
    """官方用法：一次 load_model + 一次 transcribe，参数一律用上游默认值。

    与 `TranscriptionModel.transcribe_to_midi()` 完全等价 —— 唯一的区别是事件流过了
    暂停闸门（只延迟、不改事件），所以界面上「暂停 / 继续」在块与块之间仍然生效。
    """
    _pause_gate_mod.install(log_cb)   # 本次转录的暂停闸门（见 pause_gate 模块）
    _require_package()                # 包缺失先给明确报错，再导入
    from muscriptor import TranscriptionModel

    if not os.path.isfile(audio_path):
        raise RuntimeError("音频文件不存在或不可读：%s" % audio_path)

    params = params or {}
    size = str(params.get("model_size") or "medium").lower()
    device = str(params.get("device") or "auto").strip()
    if device in ("", "auto"):
        device = None

    model = _load_model(size, device, log_cb)
    _dev = getattr(getattr(model, "_device", None), "type", "") or "?"
    _log(log_cb, "设备：%s" % ("GPU（%s）" % _dev if _dev != "cpu" else "CPU（较慢）"))

    # 官方能直读的文件一律原样交给 libsndfile（保持原采样率/声道，由官方重采样）；
    # 只有官方读不了的容器才由内置解码转一份保形状的 WAV。正常文件这里零改动。
    import audio_io
    wav, is_temp = audio_io.prepare_for_muscriptor(audio_path)
    _log(log_cb, "音频输入：%s"
         % ("原始文件直读（重采样交给官方）" if not is_temp
            else "ffmpeg 转码（保留原始采样率/声道数，重采样交给官方）"))

    t0 = time.perf_counter()
    data = None
    cpu_retry_done = False
    while data is None:
        try:
            _log(log_cb, "推理中（多乐器转录）…")
            # ★★ 官方调用，逐字对齐 Quickstart：
            #   detect_tempo="best-effort" → 节拍网格（把音符起点贴到网格上）
            #   transcribe() 只带「官方默认/官方选项」，不带任何自定义生成参数
            beat_grid = _detect_grid(model, wav, log_cb)
            kw = _transcribe_kwargs(model, wav, params, log_cb)
            raw_events = _pause_gate_mod.gate_stream(model.transcribe(wav, **kw))
            events = _progress_stream(raw_events, log_cb)
            data = model.events_to_midi_bytes(events, beat_grid=beat_grid)
            if _midi_note_count_bytes(data) == 0:
                raise RuntimeError(
                    "识别结果为 0 音符（模型未输出事件；音频可能近乎静音）。未写入空 MIDI。")
        except Exception as e:  # noqa: BLE001
            oom = "out of memory" in str(e).lower() or "OutOfMemoryError" in type(e).__name__
            kind = ""
            try:
                from engine_gpu import cuda_error_kind as _kind
                kind = _kind(e)
            except Exception:  # noqa: BLE001
                kind = ""
            # GPU 跑不动（显存不足 / 算力不在 CUDA 包支持范围）→ 换 CPU 重跑同一行调用
            if (oom or kind) and not cpu_retry_done and _dev != "cpu":
                cpu_retry_done = True
                try:
                    import torch
                    if torch.cuda.is_available():
                        torch.cuda.empty_cache()
                except Exception:  # noqa: BLE001
                    pass
                _log(log_cb, "GPU 推理失败：%s（%s）—— 已改用 CPU 重跑本次转录"
                     % (kind or "oom", str(e).strip().splitlines()[0][:200]))
                model = _load_model(size, "cpu", log_cb)
                _dev = "cpu"
                continue
            raise
    if is_temp:
        try:
            audio_io.remove_temp(wav)
        except Exception:  # noqa: BLE001
            pass

    os.makedirs(os.path.dirname(os.path.abspath(output_midi)), exist_ok=True)
    with open(output_midi, "wb") as f:
        f.write(data)

    n = _count_notes(output_midi)
    _log(log_cb, "保存 MIDI → %s（%d 音符）" % (os.path.basename(output_midi), n))
    _log(log_cb, "[计时] muscriptor 推理：%.1fs" % (time.perf_counter() - t0))
    st = _duration_stats(output_midi)
    if st:
        _log(log_cb, "[自检] 音符 %d，时长中位数 %.2fs，>2s 占 %.1f%%，最长 %.1f s"
             % (st["count"], st["median"], st["over2"], st["max"]))
    try:
        del model
    except Exception:  # noqa: BLE001
        pass
    return n


def _midi_note_count_bytes(data):
    """MIDI 字节里的 note-on 数量（0 音符保护用，不落盘）。

    返回：正常 = 音数；空/None = 0；解析不了 = -1（调用方只在 == 0 时拦截）。
    """
    if not data:
        return 0
    try:
        import io
        import mido
        mf = mido.MidiFile(file=io.BytesIO(data))
        n = 0
        for track in mf.tracks:
            for msg in track:
                if msg.type == "note_on" and getattr(msg, "velocity", 0) > 0:
                    n += 1
        return n
    except Exception:  # noqa: BLE001
        return -1   # 解析不了：调用方只在 == 0 时拦截


def _duration_stats(midi_path):
    """音符时长分布自检（正常 0.2~0.4s；>2s 占比过高说明有僵尸长音）。"""
    try:
        import pretty_midi
        import statistics
        pm = pretty_midi.PrettyMIDI(midi_path)
        d = [n.end - n.start for inst in pm.instruments for n in inst.notes]
        if not d:
            return None
        return {
            "count": len(d),
            "median": statistics.median(d),
            "over2": 100.0 * sum(1 for x in d if x > 2.0) / len(d),
            "max": max(d),
        }
    except Exception:  # noqa: BLE001
        return None


def _count_notes(midi_path):
    try:
        import pretty_midi
        pm = pretty_midi.PrettyMIDI(midi_path)
        return sum(len(inst.notes) for inst in pm.instruments)
    except Exception:  # noqa: BLE001
        return 0


def _log(cb, msg):
    if cb:
        try:
            cb(msg)
        except Exception:  # noqa: BLE001
            pass
