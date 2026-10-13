# -*- coding: utf-8 -*-
"""
Aria-AMT 钢琴转录引擎（EleutherAI）
====================================
- Whisper 风格 seq2seq 钢琴转录（Apache-2.0）
- 权重从资源中心下载（HF 官方 / hf-mirror）
- GPU：自动使用 cuda，Blackwell（RTX 50 系）需 cu128 torch
"""
import os
import subprocess
import sys


def available():
    """aria-amt 相关包是否安装。"""
    for mod in ("amt", "ariaamt", "aria_amt"):
        try:
            __import__(mod)
            return True
        except Exception:
            continue
    # 也允许通过 CLI（python -m amt）使用
    try:
        import ariautils  # noqa: F401
        return True
    except Exception:
        return False


def _resolve_model_dir():
    """从 FUFUMIDI_MODELS_DIR/aria_amt 定位权重目录。"""
    d = os.environ.get("FUFUMIDI_MODELS_DIR")
    if d:
        p = os.path.join(d, "aria_amt")
        if os.path.isdir(p):
            return p
    return None


def transcribe_aria(audio_path, output_midi, params=None, log_cb=None,
                    num_threads=None, **kwargs):
    params = params or {}
    # ★ issue #20：不再默认硬写 "cuda"。显卡算力不在 CUDA 包支持范围内时，
    #   engine_gpu 已把 device 判成 cpu（torch_device()），这里跟着走；
    #   aria-amt 只认 cuda / cpu 两种。
    device = str(params.get("device") or "").strip()
    if not device:
        try:
            from engine_gpu import torch_device as _torch_device
            device = _torch_device()
        except Exception:
            device = "cpu"
    # xpu（Intel）与 cuda 一样是真正的加速设备，只有其它情况才降回 cpu。
    if not (device.startswith("cuda") or device.startswith("xpu")):
        device = "cpu"
    variant = str(params.get("variant") or "medium-double")
    model_dir = _resolve_model_dir()
    if model_dir:
        os.environ.setdefault("ARIA_MODEL_DIR", model_dir)

    # aria-amt 官方仅支持 Linux（源码硬编码 assert os.name == "posix"）；
    # Windows 上转录前自动应用幂等补丁，使其可用
    if os.name == "nt":
        try:
            import aria_win_patch
            if aria_win_patch.apply():
                _log(log_cb, "已应用 Aria-AMT Windows 兼容补丁")
        except Exception:
            pass

    ckpt = _find_checkpoint(model_dir, variant)
    if not ckpt:
        raise RuntimeError("未找到 Aria-AMT 模型权重（*.safetensors），请先在资源中心下载 Aria-AMT 模型")
    # ★ WP2-3：CLI 的两个位置参数是 (model_name, checkpoint_path)，**配对使用**。
    #   不匹配时 aria 不会报错，只会静默用错结构 —— 所以这里必须出声。
    if variant.strip().lower() not in os.path.basename(ckpt).lower():
        _log(log_cb, "⚠ 权重文件名里找不到 %s，但模型配置用的就是它。"
                     "若目录里放的是别的变体，请改名或只保留一个 .safetensors"
                     % variant)

    _log(log_cb, "Aria-AMT 推理中（钢琴转录，%s）…" % variant)
    out_dir = os.path.dirname(os.path.abspath(output_midi))
    os.makedirs(out_dir, exist_ok=True)

    # 3.2.6 健壮性加固：aria-amt 内部音频加载器（torchaudio/soundfile 系）对非标准
    # MP3（重命名容器/损坏头）会抛晦涩错误。与 muscriptor 引擎同款修复：统一先经
    # 内置 ffmpeg 预解码为标准 PCM WAV（16000 = Whisper 系模型原生采样率）再喂模型。
    from audio_io import decode_to_wav, remove_temp
    wav = decode_to_wav(audio_path, 16000)
    try:
        cli = _aria_cli()
        cmd = cli + ["transcribe", variant, ckpt,
                     "-load_path", wav,
                     "-save_dir", out_dir,
                     "-bs", "1"]
        # -compile（inductor）在 Windows + cu128 上会崩（causal_mask storage weakref），
        # 且 aria-amt 的多进程 spawn 依赖真实 .py 入口，Windows 下直接用 run.py
        if device.startswith("cuda") and os.name != "nt":
            cmd.append("-compile")
        _log(log_cb, "运行 " + "aria-amt transcribe …")
        before = set(os.listdir(out_dir))
        # 设备为本机 GPU 不可用时，用环境变量强制子进程看不见显卡 ——
        # aria-amt 的 CLI 没有设备开关，这是唯一可靠的「只用 CPU」手段。
        env = None
        if not device.startswith("cuda"):
            env = dict(os.environ)
            env["CUDA_VISIBLE_DEVICES"] = ""
            env["FUFUMIDI_FORCE_CPU"] = "1"
            try:
                from engine_gpu import detect as _gpu_detect
                _reason = (_gpu_detect() or {}).get("arch_reason")
            except Exception:
                _reason = None
            _log(log_cb, "Aria-AMT 将使用 CPU 推理（较慢）" + ("；原因：" + _reason if _reason else ""))
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200, env=env)
        # 诊断：无论成败，把 stdout/stderr 尾部透出（原 capture 吞掉，rc==0 且无产物时无从定位）
        tail = (r.stdout or "")[-400:].strip()
        err_tail = (r.stderr or "")[-400:].strip()
        if r.returncode != 0:
            _out = (r.stderr or r.stdout or "").strip()
            # ★ issue #20：算力不匹配的兜底说明（自检没拦住时至少让用户知道下一步怎么做）
            try:
                from engine_gpu import cuda_error_kind as _kind, cuda_error_hint as _hint
                _k = _kind(_out)
                if _k and _k != "oom":
                    _out += "\n" + _hint(_k)
            except Exception:
                pass
            raise RuntimeError(_out[-600:])

        mid = _pick_new_midi(out_dir, before)
        if not mid:
            raise RuntimeError(
                "aria-amt 未生成 MIDI 文件"
                + ("\n[stdout] " + tail if tail else "")
                + ("\n[stderr] " + err_tail if err_tail else "")
                + "\n请确认 Aria-AMT 运行时已安装（资源中心 → 运行时 → Aria）且模型权重已下载。"
            )
        src = os.path.join(out_dir, mid)
        if os.path.abspath(src) != os.path.abspath(output_midi):
            os.replace(src, output_midi)
    finally:
        remove_temp(wav)

    n = _count_notes(output_midi)
    _log(log_cb, f"保存 MIDI → {os.path.basename(output_midi)}（{n} 音符）")
    return n


def _find_checkpoint(model_dir, variant=None):
    """在 aria_amt 模型目录里定位权重（*.safetensors）。

    ★ WP2-3：**优先按 variant 匹配**，不是"目录里第一个 .safetensors"。

    aria-amt 的 CLI 是 `transcribe <model_name> <checkpoint_path>` —— 两个位置参数
    **配对**：`model_name` 决定读 `site-packages/config/models/{name}.json` 里的网络结构，
    权重由第二个参数给。拿 A 的结构去加载 B 的权重**不会报错**，只会静默跑错模型。
    包内自带三个配置（`medium-double` / `medium-single` / `medium-triple`），
    资源中心目前只镜像 `piano-medium-double-1.0`，所以这个坑一直没露出来；
    但只要目录里出现第二个 `.safetensors` 就会踩。
    """
    if not model_dir or not os.path.isdir(model_dir):
        return None
    found = []
    for root, _, files in os.walk(model_dir):
        for f in files:
            if f.endswith(".safetensors") and not f.startswith("."):
                found.append(os.path.join(root, f))
    if not found:
        return None
    found.sort()             # 顺序稳定：同一目录两次跑必须选到同一个文件
    if variant:
        want = variant.strip().lower()
        hit = [p for p in found if want in os.path.basename(p).lower()]
        if hit:
            return hit[0]
    return found[0]


def _aria_cli():
    """aria-amt 入口命令列表。

    Windows：必须用 `python amt/run.py` 作为进程入口 —— aria-amt 内部用 multiprocessing
    spawn 启动子进程，spawn 需要「真实 .py 文件」作主模块才能重建；console-script(exe)
    或 `python -m amt.run` 的主模块是 runpy 包装，spawn 无法重建、子进程静默崩溃。
    先优先 run.py，回退到 Scripts 下的 console script。
    """
    try:
        import amt
        rp = os.path.join(os.path.dirname(os.path.abspath(amt.__file__)), "run.py")
        if os.path.isfile(rp):
            return [sys.executable, rp]
    except Exception:
        pass
    scripts = os.path.join(os.path.dirname(sys.executable), "Scripts", "aria-amt")
    for cand in ([scripts + ".exe"] if os.name == "nt" else []) + [scripts]:
        if os.path.isfile(cand):
            return [cand]
    raise RuntimeError("未找到 aria-amt 命令（请先在资源中心安装 Aria-AMT 运行时）")


def _pick_new_midi(out_dir, before):
    after = set(os.listdir(out_dir))
    mid = [f for f in after - before if f.lower().endswith(".mid")]
    if mid:
        return max(mid, key=lambda f: os.path.getmtime(os.path.join(out_dir, f)))
    cands = [f for f in after if f.lower().endswith(".mid")]
    if cands:
        return max(cands, key=lambda f: os.path.getmtime(os.path.join(out_dir, f)))
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
