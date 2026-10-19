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

import pause_gate as _pause_gate_mod

# 队列批量转录的模型复用：worker 进程常驻时，同一模型/设备/精度只加载一次。
# 只对 CUDA 启用（CPU 上多 worker 各留一份 1.17GB 模型容易爆内存）；
# 低显存模式强制不缓存（优先保证不 OOM）。
_MODEL_CACHE = {}


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

    ★ 2026-10-14：把**底层 ImportError 原文 + 解释器/PYTHONPATH** 一起报出来 ——
      之前只写「import muscriptor 失败」，真的遇到时无法区分「没装包」「torch 没挂上」
      「PYTHONPATH 指向了不匹配的 GPU 包」，只能靠猜。
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
            import sys as _sys, os as _os
            _detail += "\n解释器：%s\nPYTHONPATH：%s" % (_sys.executable, _os.environ.get("PYTHONPATH", "(未设置)"))
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


def _pause_gate(stream, pause_file, log_cb=None):
    """MuScriptor 的暂停闸门：每吐出一项（5 秒 token 块）之前先过闸门。

    闸门本体在 pause_gate 模块（三类引擎共用，那里有一张"暂停点在哪"的表）。
    为什么挂在 `_generate_token_stream` 上：它是**惰性**生成器，每个 5 秒块的推理是在下游
    "要下一项"时才发生的 —— 所以卡在这里 = 卡在块与块之间，模型状态全在内存里，
    继续时**从原处接着跑**（不重跑、不丢已算的部分）。
    """
    return _pause_gate_mod.gate_stream(stream, _pause_gate_mod.PauseGate(pause_file, log_cb))


def _install_pause_wrapper(model):
    """把闸门包在 model._generate_token_stream 上（只包一次，不叠加）。

    ★ 包装器**不许**捕获 log_cb：worker 常驻、model 是缓存的，包装器只装一次，
    而 log_cb 每次都不同 —— 捕获它会让第二个文件起的暂停日志打到第一个文件的回调上。
    所以包装器只调 _pause_gate_mod.wait()，闸门由每次转录开头的 install(log_cb) 重绑。
    """
    if getattr(model, '_fufumidi_pause_wrapped', False):
        return
    _orig = getattr(model, '_generate_token_stream', None)
    if _orig is None:
        # 不走 token 流的模型（测试替身 / 别的引擎）没有这个钩子 —— 直接跳过，
        # 别让"暂停"这个可选功能把正常转录路径搞崩（实测踩过：8 个用例因此 AttributeError）
        return

    def _gated(*a, **kw):
        return _pause_gate_mod.gate_stream(_orig(*a, **kw))

    model._generate_token_stream = _gated
    model._fufumidi_pause_wrapped = True


# ★ 证据的"这颗音在音频里根本不存在"哨兵。
#   为什么不用负数：负数是个**合法但坏**的返回值，坏证据必须一律无效
#   （test_muscriptor_sustain_evidence.test_bad_evidence_never_cuts 钉着这条）。
#   所以哨兵是一个**独立对象**，由 set_sustain_evidence(fn, drop) 按身份注入。
EVIDENCE_DROP = object()


def _make_pitch_evidence(wav_path, log_cb=None, stats=None):
    """按**音高**判断「这个音此刻还有没有一个真正的音在响」（★ 2026-10-14 第四版）。

    三代判据都被实测修正过，全记在这里，免得再走一遍：
      ① 「边界前 0.5 秒整窗静音」（RMS ≤ −60 dBFS）：这段**一秒静音都没有**
         （每 0.5 s 窗 RMS 0.024~0.203，比阈值高 24~200 倍）→ 判据从不触发，
         一个僵尸音都没拦住。
      ② 「该音高的频带能量」：密集配器里**任何时刻都有能量** —— 实测僵尸音
         pitch 29 / 46 的频带能量全程 0.02~0.06（别的乐器与混响漏进来的），
         证据永远说"还在响"，21.9 秒的假长音一个也修不掉。
      ③ 「最后一个有声帧 + 跟自己起音比」：能修掉"音高停了模型却不收尾"的音，
         但星铁LIVE 实测（26:20 那段）暴露两个洞：
         · 只看"最后一帧有声"会被**单个鼓点**骗到 —— D1（pitch 26）每 0.5 s 只有
           0~3 帧有声（起音突出度只有 0.88），却把一颗 24.65 秒的音一路"接"到底；
         · 阈值取「起音突出度 × 0.35」，起音若是尖峰（合成音里实测能到 550），
           后面正常的延音（突出度 ~9）永远不达标 → 反而会**误切真实长音**。

    第四版三条判据，全部是绝对量（不再跟起音比）：
      · **有声**：该音高的峰高于同八度邻域中位数（突出度 ≥ P_FLOOR）且带内能量 ≥ E_FLOOR；
      · **持续存在**：0.5 秒窗里至少一半帧"有声"（鼓点、零星泛音接不上）；
      · **头部必须有支撑**：音符开头 1 秒里，要么有起音峰，要么一半以上帧有声，
        要么带内能量已达本音符后段的 25%（这一条专门挡"被配器盖住的真实弱音"）。
        头部就没有支撑 = 音频在这颗音**自称开始的地方**根本没有它 →
        返回 EVIDENCE_DROP（把它删掉），而不是留一颗"前 20 秒空白"的假长音。
        **删只对 ≥ DROP_MIN_DUR（5 秒）的音生效**：短音的收尾点本来是模型逐音给的，
        更可信，而"删一颗 2 秒音"的收益很小、风险却一样大。

    查询 fn(pitch, start, upto) 的返回值：
      · None       → 没证据 / 到 upto 还在持续 → 不动它
      · t（≥start）→ 真正的收尾时刻
      · EVIDENCE_DROP → 这颗音在音频里根本不存在，删掉（对象身份比较，不是数值）

    一次 STFT（8192 点 / 50 ms 一跳；8192 是为了低频也有 ~2 Hz 分辨率，F1 才分得出峰）
    算出 128 个音高的突出度与带内能量时间线。
    保守到底：任何一步不满足都返回 None。**宁可漏切一颗僵尸音，也不误伤真实长音。**
    """
    import numpy as np
    import soundfile as sf

    SR_TARGET = 16000
    N_FFT = 8192           # 0.51 s 窗：F1(43.7 Hz) 也要能分出峰
    HOP_MS = 50
    P_FLOOR = 1.6          # 突出度下限（≈ 没有明显峰）
    E_FLOOR = 0.002        # 带内能量下限（满幅 ≈ 1.0），挡掉极安静处的伪峰
    GRACE = 0.30           # 到边界前 0.3 s 还在响 → 判定"仍在延音"，不动
    P_MIN = 2.0            # 起音突出度到这个数 = "有起音峰"
    ATTACK = 0.30          # 起音参考窗
    DUTY_WIN = 0.50        # "持续存在"的观察窗（秒）
    DUTY_MIN = 0.50        # 窗内至少一半帧有声，才算这个音高在"持续"
    HEAD_WIN = 1.00        # 头部支撑的观察窗（给"被盖住的弱起音"整整一秒机会）
    HEAD_MIN = 0.50        # 头部窗里至少一半帧有声
    HEAD_BAND_REL = 0.25   # 或：头部带内能量 ≥ 本音符自己后段的这个比例
    DROP_MIN_DUR = 5.0     # ★ 只有"本来就这么长"的音才允许被删；短音宁可只砍尾巴

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
    # 收尾修正 / 删除 的计数（调用方可传一个字典进来跨段累加，最后写进日志）
    if stats is None:
        stats = {"cut": 0, "drop": 0}

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
        # ① 有声：这个音高此刻突出（不是别的乐器/混响漏进来的能量）
        ok = (pr >= P_FLOOR) & (en >= E_FLOOR)
        # ② 头部支撑：开头一秒里到底有没有这颗音存在的痕迹
        a = max(1, int(round(ATTACK / hop_s)))
        p0 = float(pr[:a].max())
        hw = min(pr.size, max(2, int(round(HEAD_WIN / hop_s))))
        head_duty = float(ok[:hw].mean())
        ref = float(np.percentile(en, 90))
        head_level = float(np.median(en[:hw]))
        head_ok = (p0 >= P_MIN or head_duty >= HEAD_MIN
                   or (ref > 0.0 and head_level >= HEAD_BAND_REL * ref))
        # ★ 头部没有支撑 = 这颗音在它自称开始的地方根本不存在 → 删掉。
        #   但只有**长**音符才删：收益随长度增长，风险不随。实测星铁LIVE 全片，
        #   不加这道门会删 57 颗，其中 51 颗是 2~4 秒的短音（散在全片各处，很可能是
        #   真实音符、只是起音被配器盖住）；加门之后只剩 6 颗，全部落在 26:20 那段
        #   真正坏掉的区间（含被拉成 24.65 秒的 D1）。短音落到下面的"持续存在"
        #   逻辑，最多只砍尾巴。
        if not head_ok and (float(upto) - float(start)) >= DROP_MIN_DUR:
            stats["drop"] += 1
            return EVIDENCE_DROP
        # ③ 持续存在：0.5 秒窗里至少一半帧有声 —— 单个鼓点接不上
        w = max(2, int(round(DUTY_WIN / hop_s)))
        if ok.size >= w:
            csum = np.concatenate(([0], np.cumsum(ok.astype("int32"))))
            duty = (csum[w:] - csum[:-w]).astype("float32") / float(w)
            idx = np.nonzero(duty >= DUTY_MIN)[0]
            if idx.size:
                t_last = (i0 + int(idx[-1]) + w - 1) * hop_s
                if float(upto) - t_last < GRACE:
                    return None                # 到边界都还在持续 → 不动它
                if t_last <= float(start):
                    return None
                stats["cut"] += 1
                return t_last
        return None

    fn.stats = stats
    return fn


#: 分块时长（秒）—— 与 muscriptor 的 _SEGMENT_DURATION 一致，「跨块延音缝合」以这些时刻为边界。
CHUNK_SEC = 5.0


def _stitch_chunk_boundaries(midi_bytes, chunk_sec=CHUNK_SEC, tol=0.14):
    """把 5 秒分块边界两侧的延音**缝回一个长音**（★ 2026-10-18b）。

    为什么要有它（这次是真的换掉 prelude_forcing 的实现方式）：
      · 上游的 tie 段机制 = 块边界把「上一块还没结束的音」**强制**声明为延续。
        模型只要漏一次收尾，这颗音就被迫一直延续 —— 一个音慢慢滚成整片音墙。
        实测这首 154s 的歌：7115 个音符、时长中位数 20ms、最长 82.9s；同一次
        音频关掉强制 tie 后是 788 个音符、中位数 0.54s、最长 12s。
      · 但直接关掉 tie，模型每 5s 会自己重新猜哪些音在延续：延音可能在边界被
        切断、甚至换乐器（muscriptor 文档原话：re-enter with the wrong instruments）。

    所以改成「解码关掉强制 tie（不可能再产生僵尸音）+ 解码后按证据缝合」：
      同一条轨（同乐器）、同一音高，一个音恰在边界前结束、另一个恰在边界后开始，
      说明它们本来就是同一颗持续音 → 缝成一个长音。跨乐器不缝（那会改音色）。
    这样延音连续性和「无僵尸长音」不再互斥。

    返回 (new_bytes, stats)，stats = {"merged": 接合处数, "longest": 缝合后最长音秒数}。
    """
    import io as _io
    try:
        import mido
    except Exception:
        return midi_bytes, {"merged": 0, "longest": 0.0}

    try:
        mid = mido.MidiFile(file=_io.BytesIO(bytes(midi_bytes)))
    except Exception:
        return midi_bytes, {"merged": 0, "longest": 0.0}
    tpb = int(mid.ticks_per_beat or 480) or 480

    # ---- 速度表：tick → 秒 ----
    marks = []
    for tr in mid.tracks:
        t = 0
        for msg in tr:
            t += msg.time
            if msg.type == "set_tempo":
                marks.append((t, int(msg.tempo)))
    marks.sort()
    if not marks:
        marks = [(0, 500000)]

    def tick2sec(tick):
        sec = 0.0
        last = 0
        tempo = marks[0][1]
        for at, tm in marks:
            if at >= tick:
                break
            sec += (at - last) / float(tpb) * (tempo / 1e6)
            last = at
            tempo = tm
        sec += (tick - last) / float(tpb) * (tempo / 1e6)
        return sec

    merged_total = 0
    longest = 0.0
    out_tracks = []
    for tr in mid.tracks:
        # 绝对 tick + 稳定的原始顺序（同一时刻的事件排序不能乱，programchange 必须先于音符）
        events = []
        t = 0
        for seq, msg in enumerate(tr):
            t += int(msg.time)
            events.append((t, seq, msg))

        # ---- 配对音符 ----
        open_notes = {}
        notes = []
        for idx, (tick, seq, msg) in enumerate(events):
            if msg.type == "note_on" and msg.velocity > 0:
                open_notes.setdefault((msg.channel, msg.note), []).append(idx)
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                stack = open_notes.get((msg.channel, msg.note))
                if stack:
                    on_idx = stack.pop(0)
                    notes.append({"on": on_idx, "off": idx, "start": events[on_idx][0],
                                  "end": tick, "pitch": int(msg.note), "ch": int(msg.channel)})
        if not notes:
            out_tracks.append(tr)
            continue

        # ---- 同轨同音高 → 按起点索引；边界两侧配对 ----
        by_key = {}
        for n in notes:
            by_key.setdefault((n["ch"], n["pitch"]), []).append(n)
        for lst in by_key.values():
            lst.sort(key=lambda n: n["start"])
        dropped = set()
        merges = 0
        for A in notes:
            if id(A) in dropped:
                continue
            while True:
                end_tick = A["end"]
                end_sec = tick2sec(end_tick)
                start_sec = tick2sec(A["start"])
                if end_sec - start_sec > 600.0:      # 防御：异常文件别在这里死循环
                    break
                b = round(end_sec / chunk_sec) * chunk_sec
                if b <= 0 or abs(end_sec - b) > tol:  # 不在任何一个块边界上 → 不用缝
                    break
                best, best_d = None, 1e9
                for B in by_key.get((A["ch"], A["pitch"]), []):
                    if B is A or id(B) in dropped:
                        continue
                    if B["start"] <= A["start"]:
                        continue
                    bs = tick2sec(B["start"])
                    be = tick2sec(B["end"])
                    if be <= bs:
                        continue
                    if bs < end_sec - tol or abs(bs - b) > tol:
                        continue
                    d = abs(bs - b)
                    if d < best_d:
                        best, best_d = B, d
                if best is None:
                    break
                dropped.add(id(best))
                A["end"] = best["end"]
                merges += 1
        merged_total += merges
        if not merges:
            out_tracks.append(tr)
            continue

        # ---- 重建这条轨：延音尾巴延长到接上来的那颗音的收尾；被并掉的音整对删除 ----
        skip = set()
        stretch = {}
        for n in notes:
            if id(n) in dropped:
                skip.add(n["on"])
                skip.add(n["off"])
        # 只有「接合链的最后一颗」需要改收尾：按 start 顺序重建时，靠 end 的并合反复覆盖即可 ——
        # 这里直接遍历 notes：被并掉的音的 off 跳过；保留音的 off tick 用其当前 end。
        for n in notes:
            if id(n) in dropped:
                continue
            if n["off"] not in skip and events[n["off"]][0] != n["end"]:
                stretch[n["off"]] = n["end"]

        rebuilt = []
        for idx, (tick, seq, msg) in enumerate(events):
            if idx in skip:
                continue
            nt = stretch.get(idx, tick)
            rebuilt.append((nt, seq, msg))
        rebuilt.sort(key=lambda e: (e[0], e[1]))
        new_tr = mido.MidiTrack()
        prev = 0
        for tick, seq, msg in rebuilt:
            delta = max(0, tick - prev)
            prev = tick
            try:
                new_tr.append(msg.copy(time=delta))
            except Exception:
                new_tr.append(msg)
        out_tracks.append(new_tr)

    if not merged_total:
        return midi_bytes, {"merged": 0, "longest": 0.0}

    out = mido.MidiFile(type=mid.type, ticks_per_beat=tpb)
    for tr in out_tracks:
        out.tracks.append(tr)
    buf = _io.BytesIO()
    out.save(file=buf)
    for tr in out.tracks:
        t = 0
        last_on = {}
        for msg in tr:
            t += msg.time
            if msg.type == "note_on" and msg.velocity > 0:
                last_on[msg.note] = t
            elif msg.type == "note_off" or (msg.type == "note_on" and msg.velocity == 0):
                if msg.note in last_on:
                    longest = max(longest, tick2sec(t) - tick2sec(last_on.pop(msg.note)))
    return buf.getvalue(), {"merged": merged_total, "longest": round(longest, 2)}


def transcribe_muscriptor(audio_path, output_midi, params=None, log_cb=None,
                          num_threads=None, **kwargs):
    _pause_gate_mod.install(log_cb)   # 本次转录的暂停闸门（见 pause_gate 模块）
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
    # 队列里连续多首时复用模型：30 秒素材实测模型加载占每首固定开销的 2–3 秒，
    # 批量队列里这部分会被重复支付。缓存 key = (权重路径, device, dtype)。
    _cache_ok = False
    try:
        import torch as _torch
        _cache_ok = bool(_torch.cuda.is_available()) and str(params.get("memory_mode") or "") != "low"
    except Exception:
        _cache_ok = False
    _ckey = (str(load_arg), str(dev), str(_dtype or ""))
    model = None
    if _cache_ok and _MODEL_CACHE.get("key") == _ckey and _MODEL_CACHE.get("model") is not None:
        model = _MODEL_CACHE["model"]
        _log(log_cb, "复用已加载模型（同一队列后续曲目跳过模型加载）")
    if model is None:
        _t_load = time.perf_counter()
        try:
            model = TranscriptionModel.load_model(load_arg, device=dev, dtype=_dtype)
        except TypeError:
            # 老版本 muscriptor 的 load_model 不认 dtype：退回旧签名，别让整次转录失败
            model = TranscriptionModel.load_model(load_arg, device=dev)
        except Exception:
            model = TranscriptionModel.load_model(load_arg)
        if _cache_ok:
            _MODEL_CACHE.clear()
            _MODEL_CACHE["key"] = _ckey
            _MODEL_CACHE["model"] = model
        try:
            _log(log_cb, "模型加载耗时 %.2fs%s" % (time.perf_counter() - _t_load, "（已缓存供后续曲目复用）" if _cache_ok else ""))
        except Exception:
            pass

    # ★ 识别片段长度：MuScriptor 的块长写死在 muscriptor.transcription_model._SEGMENT_DURATION（5s）。
    #   界面调了值就在这里改模块常量（同一进程只跑一次转录；模型 token 布局不随块长变）。
    import segment_options as _seg_opt
    _chunk_sec = _seg_opt.muscriptor_segment_sec(params.get("segment_sec"))
    if str(params.get("memory_mode") or "") == "low":
        # MuScriptor 本身是 batch=1 串行；低显存模式下把静音分段临时关掉，
        # 避免「分段 + 每段各自建证据」在低显存机器上叠内存（速度收益本来也不大）
        if str(params.get("segment_silence") or "off") != "off":
            _log(log_cb, "低显存模式：本次关闭静音分段（降低峰值内存）")
        params = dict(params)
        params["segment_silence"] = "off"
    if params.get("segment_sec"):
        try:
            import muscriptor.transcription_model as _tm
            _tm._SEGMENT_DURATION = float(_chunk_sec)
            _log(log_cb, "识别片段长度：%.1fs（MuScriptor 默认 5s）" % float(_chunk_sec))
        except Exception as _e:  # noqa: BLE001
            _log(log_cb, "识别片段长度设置失败，按默认 5s：%s" % _e)
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
    # ★ 转录前音频链（2026-10-15 方案 A/B）：高通 → 降噪 → 电平统一。
    #   ★★ 必须放在下面「建证据」之前：证据函数读的就是这个 wav，
    #      两者必须是同一份音频，否则证据判据会按没降噪的音频去裁降噪后的音符。
    try:
        import audio_chain as _ac
        _ac.process_wav_inplace(wav_tmp, 16000, params, log_cb,
                                strong_runner=_ac.make_strong_runner(log_cb))
    except Exception as _e:
        _log(log_cb, "[预处理] 音频链失败，按原始音频继续：%s" % _e)
    # ★ 音频证据式收尾：让模型不再被迫延续"其实已经没声"的音（见 _make_pitch_evidence）。
    #   ★ 回放（--replay-tokens）也注入：wav 在这一步已经解码出来了（上面 audio_io.decode_to_wav），
    #     而回放台的意义就是"改了解码器逻辑后用 1 分钟复现"，把证据排除在外就复现不到改动。
    #     （2026-10-14 实测通过回放定位到问题：6505 次收尾**全部**是模型自己的 token，
    #      块边界批量收尾 374/195/1362/1587 个音 —— 所以证据必须进回放路径。）
    from dataclasses import replace as _replace      # 分段合并时改事件时间/index 用
    _SUSTAIN_EV = None                               # 分段路径要按段重新注入证据
    _ev_stats = {"cut": 0, "drop": 0}                # 证据判定的累计计数（各段共用）
    if not os.environ.get("FUFUMIDI_NO_EVIDENCE"):
        try:
            import time as _time_ev
            _t_ev = _time_ev.perf_counter()
            from muscriptor.events import set_sustain_evidence as _set_evidence

            def _install_evidence(_fn, _set=_set_evidence):
                """注入证据函数 + "删掉这颗音"哨兵（哨兵按对象身份比较，见 events 补丁）。"""
                _set(_fn, EVIDENCE_DROP)

            _SUSTAIN_EV = _install_evidence
            _ev = _make_pitch_evidence(wav_tmp, log_cb, _ev_stats)
            _install_evidence(_ev)
            _log(log_cb, "音频证据式收尾：已启用（按音高能量时间线收尾，不截断真实长音）"
                 "（构建 %.1fs）" % (_time_ev.perf_counter() - _t_ev))
        except Exception as _e:
            _log(log_cb, "音频证据式收尾不可用，按上游行为：%s" % _e)

    # ★ 静音分段（长音频提速）：见 engine/segmenter.py。**默认 off**（用户 2026-10-14 定），
    #   可在界面/CLI 选 auto（时长 ≥5 分钟且预计省 ≥3% 才启用）或 on。
    #   做法：按"完全空白静音"切成若干核心段，逐段推理，事件时间加段偏移后合并成一份 MIDI。
    #   为什么不在回放路径做：token 流是按整段音频落盘的，切片对不上。
    _seg_plan = None
    _per_seg_constraints = None
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
        _zero_len_stats = {"n": 0}      # ★ 被吞掉的"零长度收尾对"（证据式删除走这条）

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
            """进度透传 + 超长音符强制收尾 + ★ 证据式删除（cap <= 0 时不做 cap）。

            ★ 删除是怎么做到的（第四版新增）：音频证据判定「这颗音在音频里根本不存在」
              时，给的是**零长度**事件对（收尾时刻 = 起音时刻）。而下游
              `events_to_midi_bytes` 只在收到 end 时才 `notes.append(...)` ——
              所以**只吞掉收尾**即可：不配对的 start 会自然消失。
              这样既真的删掉了音符，又不必在这里缓冲/重排事件流
              （"正常短音逐个原样透传、不重排"是 test_muscriptor_note_cap 钉住的硬不变量）。
            """
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
                    st = open_notes.pop(idx, None)
                    if (st is not None
                            and abs(float(getattr(ev, "end_time", 0.0))
                                    - float(st.start_time)) <= 1e-9):
                        # ★ 零长度收尾对 → 只吞掉 end，不配对的 start 自然消失。
                        #   两个来源都该丢：① 音频证据判定"这颗音不存在"（主线）；
                        #   ② 模型在**同一帧**内开又关的退化音（100 fps 下一帧 10 ms，
                        #   零长度说明它连一帧都没占到；以前会被 validate_notes 撑成
                        #   0.01 s 的杂音，鼓组那条路本来也是直接丢）。
                        #   只认**恰好等于起音时刻**的收尾，end<start 的畸形事件保持旧行为。
                        _zero_len_stats["n"] += 1
                        continue
                    yield ev
                    continue
                yield ev
            # 流末兜底：库保证每个 Start 都有 End，这里只兜住异常情况
            if _cap > 0:
                for idx, st in list(open_notes.items()):
                    yield _NoteEndEvent(end_time=st.start_time + _cap, start_event=st)
                    del open_notes[idx]
                    _cap_stats["closed"] += 1

        def _segmented_events(plan, pcm, sr, constrain_override="__unset__", per_seg_constraints=None):
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
            chunk_sec = _chunk_sec
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
                            _SUSTAIN_EV(_make_pitch_evidence((pcm[a:b], sr), log_cb, _ev_stats))
                        except Exception:
                            pass
                    off = a / float(sr)
                    kept = {}
                    dropped = set()
                    if constrain_override != "__unset__":
                        _seg_instruments = constrain_override
                    elif per_seg_constraints is not None and si < len(per_seg_constraints):
                        _pg = per_seg_constraints[si] or []
                        _seg_instruments = _pg if _pg else None
                    else:
                        _seg_instruments = constrain
                    for ev in model.transcribe(seg_wav, instruments=_seg_instruments, **_gen_kw):
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
        # ★ 2026-10-18b：prelude_forcing **不再传给模型**（见 _gen_kw 处的说明），改成解码后缝合；
        #   下面这段批量推理说明保留作历史依据。
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
        if _mode == "probe":
            # 「音色稳定」预设：先探测主乐器组，再作为硬约束（减少长尾乐器与跨块改判）。
            # ★ 探测器**优先用小模型**，不再复用主模型：大模型（large，1.4B）本身很慢，
            #   拿它做 3×20s 预分析实测要数分钟（RTX 5070 Ti 笔记本上甚至逼近 10 分钟），
            #   主转录还没开始用户就以为卡死；小模型探测约几秒，且探测结果只用于选组。
            _probe_model = model
            _probe_label = "主模型"
            _probe_tmp = False
            # ★ 方案 B：优先用**专用音频标签模型**（AudioSet zipformer-small，26MB ONNX，
            #   CPU 0.3s/10s），不再拿 MuScriptor-small 做 3×20s 预分析。
            #   它只输出乐器组，不参与 MIDI 生成；置信度不足时宁可不锁定，也不硬塞。
            _tagger = None
            try:
                import audio_tagger as _audio_tagger
                if _audio_tagger.available():
                    _tagger = _audio_tagger.default_tagger()
                    _probe_label = "音频标签模型（AudioSet）"
                    _log(log_cb, "自动探测使用专用音频标签模型（AudioSet zipformer-small，CPU；不占主模型）")
            except Exception as _e:  # noqa: BLE001
                _tagger = None
                _log(log_cb, "音频标签模型不可用，退回 MuScriptor 探测器：%s" % str(_e)[:120])

            def _load_fallback_probe():
                """标签模型置信度不足时的兜底探测器：独立 small（失败再用主模型）。"""
                try:
                    _p = _find_local_model("small")
                    if size != "small" and _p:
                        try:
                            return TranscriptionModel.load_model(_p, device=dev, dtype=_dtype), True
                        except TypeError:
                            return TranscriptionModel.load_model(_p, device=dev), True
                        except Exception:
                            return TranscriptionModel.load_model(_p), True
                except Exception:
                    pass
                return model, False

            # 探测器选择（auto）：没有标签模型时，large 主模型用 small 探测器；
            # medium/small 直接用主模型。环境变量 FUFUMIDI_PROBE_MODEL 可强制覆盖。
            _probe_pref = os.environ.get("FUFUMIDI_PROBE_MODEL", "auto").strip().lower()
            _use_small_probe = (_tagger is None and (_probe_pref == "small"
                               or (_probe_pref != "main" and size == "large")
                               or (_probe_pref != "main" and bool(params.get("probe_segments")))))
            if _use_small_probe and size != "small":
                try:
                    _small_path = _find_local_model("small")
                    if _small_path:
                        _t_probe_load = time.perf_counter()
                        try:
                            _probe_model = TranscriptionModel.load_model(_small_path, device=dev, dtype=_dtype)
                        except TypeError:
                            _probe_model = TranscriptionModel.load_model(_small_path, device=dev)
                        except Exception:
                            _probe_model = TranscriptionModel.load_model(_small_path)
                        _probe_tmp = True
                        _probe_label = "small（独立探测器）"
                        _log(log_cb, "自动探测使用独立小模型（small，不消耗主模型推理；加载 %.2fs）"
                             % (time.perf_counter() - _t_probe_load))
                except Exception as _e:  # noqa: BLE001
                    _probe_model = model
                    _probe_label = "主模型（small 加载失败：%s）" % str(_e)[:80]
                    _log(log_cb, "小模型探测器不可用，退回主模型探测：%s" % _e)
            try:
                _t_probe = time.perf_counter()
                if params.get("probe_segments"):
                    # ★ 分段探测（实验，方案 B）：固定 30/60s 一段，每段用探测器短推理
                    #    （默认独立 small）得到该段主乐器组，再按段硬约束；全局保留出现 ≥2 段的组，
                    #    并与相邻段并集，避免某段漏检把后面才进场的乐器整组关掉。
                    import segment_probe as _segprobe
                    import soundfile as _sfp
                    import tempfile as _tfp
                    import shutil as _shp
                    _x, _sr = _sfp.read(wav_tmp, dtype="float32", always_2d=False)
                    if getattr(_x, "ndim", 1) > 1:
                        _x = _x.mean(axis=1)
                    _dur = len(_x) / float(_sr) if _sr else 0.0
                    _segs = _segprobe.fixed_segments(_dur, params.get("probe_segment_sec") or 60)
                    _tmpdir = _tfp.mkdtemp(prefix="fuprobe-seg-")
                    _per_groups = []
                    try:
                        for _si, (_a, _b) in enumerate(_segs):
                            _sp = os.path.join(_tmpdir, "seg%02d.wav" % _si)
                            _sfp.write(_sp, _x[int(_a * _sr):int(_b * _sr)], _sr)
                            if _tagger is not None:
                                _pg, _psc, _prs = _tagger.probe_groups(_sp, min_score=0.05,
                                                                       max_windows=5)
                            else:
                                _pr = instrument_probe.probe(
                                    _probe_model, _sp, log=log_cb, count=1,
                                    win=min(20.0, max(5.0, _b - _a)))
                                _pg = _pr.get("groups") or []
                                _prs = _pr.get("reason", "")
                            _per_groups.append(_pg)
                            _log(log_cb, "分段探测 %d/%d（%.0f–%.0fs）：%s%s"
                                 % (_si + 1, len(_segs), _a, _b,
                                    " / ".join(_pg) if _pg else "（置信度不足/未检出）",
                                    "" if _pg else ("（%s）" % _prs if _prs else "")))
                    finally:
                        try:
                            _shp.rmtree(_tmpdir, ignore_errors=True)
                        except Exception:
                            pass
                    _allowed, _keep = _segprobe.build_constraints(_per_groups, max_groups=12)
                    if any(_allowed):
                        _per_seg_constraints = _allowed
                        _seg_plan = {"duration": _dur, "segments": _segs, "skipped_sec": 0.0}
                        _seg_pcm, _seg_sr = _x, _sr
                        constrain = None
                        _log(log_cb, "分段探测完成（探测器=%s，%.1fs）：%d 段；稳定组=%s"
                             % (_probe_label, time.perf_counter() - _t_probe,
                                len(_segs), " / ".join(_keep) if _keep else "无"))
                    elif _tagger is not None:
                        # 分段标签置信度都不足：退回整曲 small 探测，至少别让音色稳定变成空操作
                        _log(log_cb, "分段标签模型置信度不足，尝试 MuScriptor-small 整曲兜底探测…")
                        _fb_model, _fb_tmp = _load_fallback_probe()
                        try:
                            _fpr = instrument_probe.probe(_fb_model, wav_tmp, log=log_cb)
                            _fgroups = _fpr.get("groups") or []
                            if _fgroups:
                                constrain = _fgroups
                                _log(log_cb, "整曲兜底锁定乐器组（MuScriptor-small）：" + " / ".join(_fgroups))
                        finally:
                            if _fb_tmp:
                                try:
                                    del _fb_model
                                    import gc as _gc_fb
                                    _gc_fb.collect()
                                    import torch as _torch_fb
                                    if _torch_fb.cuda.is_available():
                                        _torch_fb.cuda.empty_cache()
                                except Exception:
                                    pass
                    else:
                        _log(log_cb, "分段探测未得到任何乐器组（探测器=%s，%.1fs），本次不限制"
                             % (_probe_label, time.perf_counter() - _t_probe))
                else:
                    if _tagger is not None:
                        _groups, _gsc, _prs = _tagger.probe_groups(wav_tmp, min_score=0.05,
                                                                   max_windows=3)
                    else:
                        _pr = instrument_probe.probe(_probe_model, wav_tmp, log=log_cb)
                        _groups = _pr.get("groups") or []
                        _prs = _pr.get("reason", "ok")
                    _probe_secs = time.perf_counter() - _t_probe
                    if not _groups and _tagger is not None:
                        _log(log_cb, "音频标签模型置信度不足（%s），尝试 MuScriptor-small 兜底探测…" % (_prs or "低置信度"))
                        _fb_model, _fb_tmp = _load_fallback_probe()
                        try:
                            _fpr = instrument_probe.probe(_fb_model, wav_tmp, log=log_cb)
                            _groups = _fpr.get("groups") or []
                            _prs = _fpr.get("reason", "ok")
                            if _groups:
                                _probe_label = "MuScriptor-small 兜底"
                        finally:
                            if _fb_tmp:
                                try:
                                    del _fb_model
                                    import gc as _gc_fb
                                    _gc_fb.collect()
                                    import torch as _torch_fb
                                    if _torch_fb.cuda.is_available():
                                        _torch_fb.cuda.empty_cache()
                                except Exception:
                                    pass
                        _probe_secs = time.perf_counter() - _t_probe
                    if _groups:
                        constrain = _groups
                        _log(log_cb, "预分析锁定乐器组（音色稳定，探测器=%s，%.1fs）：" % (_probe_label, _probe_secs)
                             + " / ".join(_groups) + "（%s）" % _prs)
                    else:
                        _log(log_cb, "预分析未得到足够可信的乐器组（探测器=%s，%.1fs，%s），本次不限制"
                             % (_probe_label, _probe_secs, _prs or "低置信度"))
            except Exception as _e:  # noqa: BLE001
                _log(log_cb, "预分析失败，本次不限制：%s" % _e)
            finally:
                if _probe_tmp:
                    try:
                        del _probe_model
                        import gc as _gc_probe
                        _gc_probe.collect()
                        import torch as _torch_probe
                        if _torch_probe.cuda.is_available():
                            _torch_probe.cuda.empty_cache()
                    except Exception:
                        pass
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
        # ★ 2026-10-18b：「跨块延音前置」不再交给模型做 teacher-forcing —— 那个机制就是
        #   僵尸长音的产地（模型漏收尾 → 被迫延续一整片音墙）。改成本地实现：
        #   解码时 prelude_forcing=False（块边界必然收尾，物理上不可能再有僵尸音），
        #   解码完成后用 _stitch_chunk_boundaries() 按「同轨同音高 + 边界两侧恰好在
        #   一起」的证据把真实延音缝回一个长音（连续性不丢，也不靠模型猜乐器）。
        #   想复现旧行为的调试路径：FUFUMIDI_LEGACY_PRELUDE=1（保留给回放对照）。
        _legacy_prelude = bool(os.environ.get("FUFUMIDI_LEGACY_PRELUDE"))
        _want_continuity = (
            bool(params["prelude_forcing"]) if params.get("prelude_forcing") is not None else True
        )
        _stitch = False
        if _legacy_prelude:
            if params.get("prelude_forcing") is not None:
                _gen_kw["prelude_forcing"] = bool(params["prelude_forcing"])
        else:
            _gen_kw["prelude_forcing"] = False
            _stitch = _want_continuity
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
                    # ★ 暂停闸门（用户 2026-10-14 要求）：同样包在原始 token 流上 ——
                    #   它是惰性的，所以"卡住"就等于卡在 5 秒块与块之间，继续时从原处接着跑。
                    _install_pause_wrapper(model)
                    if _seg_plan is not None:
                        events = _segmented_events(_seg_plan, _seg_pcm, _seg_sr,
                                                   per_seg_constraints=_per_seg_constraints)
                    else:
                        events = model.transcribe(wav_tmp, instruments=constrain, **_gen_kw)
                data = model.events_to_midi_bytes(_events_capped(events), beat_grid=beat_grid)
                # ★ 0 音符保护：空 MIDI 不是成功结果。
                #   以前这里会把只有 tempo 的 33B 文件直接写盘/入库（用户看到"转录成功但 MIDI 是空的"）。
                #   先在内存里数音符：为 0 且用了乐器组约束时，**取消约束重试一次**（有时是探测组
                #   与这首歌不匹配）；仍为 0 就明确报错，不再静默产出空文件。
                _n_before = _midi_note_count_bytes(data)
                if _n_before == 0 and constrain is not None:
                    _log(log_cb, "识别结果为 0 音符，先取消乐器组约束重试一次（原限制：%s）"
                         % (" / ".join(constrain) if constrain else "无"))
                    try:
                        if _seg_plan is not None:
                            _retry_events = _segmented_events(_seg_plan, _seg_pcm, _seg_sr, constrain_override=None,
                                                              per_seg_constraints=None)
                        else:
                            _retry_events = model.transcribe(wav_tmp, instruments=None, **_gen_kw)
                        _retry_data = model.events_to_midi_bytes(_events_capped(_retry_events), beat_grid=beat_grid)
                        _n_retry = _midi_note_count_bytes(_retry_data)
                        if _n_retry > 0:
                            data = _retry_data
                            _n_before = _n_retry
                            _log(log_cb, "取消乐器组约束后重试成功：%d 音符" % _n_retry)
                        else:
                            _log(log_cb, "取消乐器组约束后重试仍为 0 音符")
                    except Exception as _re:  # noqa: BLE001
                        _log(log_cb, "取消约束重试失败：%s" % _re)
                if _n_before == 0:
                    try:
                        import soundfile as _sf_chk
                        _dur_chk = float(_sf_chk.info(wav_tmp).duration)
                    except Exception:
                        _dur_chk = 0.0
                    raise RuntimeError(
                        "识别结果为 0 音符（音频 %.1fs，模型 %s，乐器组限制=%s）。"
                        "常见原因：音频近乎静音/只有噪声、乐器组限制与素材不匹配、或模型未输出事件。"
                        "已取消乐器组约束重试仍为空，未写入空 MIDI。"
                        % (_dur_chk, size, " / ".join(constrain) if constrain else "无"))
                if _stitch and data:
                    try:
                        _stitched, _st_stats = _stitch_chunk_boundaries(data, chunk_sec=_chunk_sec)
                        if _st_stats.get("merged"):
                            data = _stitched
                        _log(log_cb, "跨块延音缝合：接合 %d 处（边界两侧同轨同音高），缝合后最长音 %.1fs"
                             % (int(_st_stats.get("merged") or 0), float(_st_stats.get("longest") or 0.0)))
                    except Exception as _e:                 # noqa: BLE001
                        _log(log_cb, "跨块延音缝合跳过（按原样输出）：%s" % _e)
                # 音色稳定后处理（默认关；MuScriptor 预设默认开）：短命孤立乐器轨并入邻近主导轨
                if params.get("timbre_stabilize") and data:
                    try:
                        import timbre_stabilize as _ts
                        data2, _ts_stats = _ts.stabilize_midi_bytes(data)
                        if _ts_stats.get("moved"):
                            data = data2
                        _log(log_cb, "音色稳定：并入 %d 个短命轨音符，删除 %d 条孤立轨（轨 %d → %d）"
                             % (int(_ts_stats.get("moved") or 0), int(_ts_stats.get("removed_tracks") or 0),
                                int(_ts_stats.get("before_tracks") or 0), int(_ts_stats.get("after_tracks") or 0)))
                    except Exception as _e:                 # noqa: BLE001
                        _log(log_cb, "音色稳定后处理跳过（按原样输出）：%s" % _e)
                if _cap > 0:
                    _log(log_cb, "超长音符上限 %.0fs：强制收尾 %d 个音符"
                                  % (_cap, _cap_stats["closed"]))
                if _ev_stats["cut"] or _ev_stats["drop"]:
                    _log(log_cb, "音频证据式收尾：修正 %d 颗长音符的收尾，删除 %d 颗"
                                  "「音频里根本不存在」的音符"
                                  % (_ev_stats["cut"], _ev_stats["drop"]))
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


def _midi_note_count_bytes(data):
    """从内存里的 MIDI 字节数音符（note_on velocity>0）；解析失败返回 -1。

    只用于「0 音符保护」：检查引擎是否在**写盘前**就已经没有音符事件，避免把
    一个只有 tempo 的空 MIDI 当成成功结果返回给界面。
    """
    if not data:
        return 0
    try:
        import io as _io
        import mido as _mido
        mf = _mido.MidiFile(file=_io.BytesIO(data))
        n = 0
        for track in mf.tracks:
            for msg in track:
                if msg.type == "note_on" and getattr(msg, "velocity", 0):
                    n += 1
        return n
    except Exception:
        return -1


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
