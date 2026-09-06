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
    device = str(params.get("device") or "cuda")
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

    ckpt = _find_checkpoint(model_dir)
    if not ckpt:
        raise RuntimeError("未找到 Aria-AMT 模型权重（*.safetensors），请先在资源中心下载 Aria-AMT 模型")

    _log(log_cb, "Aria-AMT 推理中（钢琴转录，%s）…" % variant)
    out_dir = os.path.dirname(os.path.abspath(output_midi))
    os.makedirs(out_dir, exist_ok=True)

    cli = _aria_cli()
    cmd = cli + ["transcribe", variant, ckpt,
                 "-load_path", audio_path,
                 "-save_dir", out_dir,
                 "-bs", "1"]
    # -compile（inductor）在 Windows + cu128 上会崩（causal_mask storage weakref），
    # 且 aria-amt 的多进程 spawn 依赖真实 .py 入口，Windows 下直接用 run.py
    if device.startswith("cuda") and os.name != "nt":
        cmd.append("-compile")
    _log(log_cb, "运行 " + "aria-amt transcribe …")
    before = set(os.listdir(out_dir))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    # 诊断：无论成败，把 stdout/stderr 尾部透出（原 capture 吞掉，rc==0 且无产物时无从定位）
    tail = (r.stdout or "")[-400:].strip()
    err_tail = (r.stderr or "")[-400:].strip()
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "").strip()[-500:])

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

    n = _count_notes(output_midi)
    _log(log_cb, f"保存 MIDI → {os.path.basename(output_midi)}（{n} 音符）")
    return n


def _find_checkpoint(model_dir):
    """在 aria_amt 模型目录里定位权重（*.safetensors）。"""
    if not model_dir or not os.path.isdir(model_dir):
        return None
    for root, _, files in os.walk(model_dir):
        for f in files:
            if f.endswith(".safetensors") and not f.startswith("."):
                return os.path.join(root, f)
    return None


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
