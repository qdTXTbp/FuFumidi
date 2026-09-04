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
    if device.startswith("cuda"):
        cmd.append("-compile")
    _log(log_cb, "运行 " + os.path.basename(cli[0]) + " transcribe …")
    before = set(os.listdir(out_dir))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "").strip()[-500:])

    mid = _pick_new_midi(out_dir, before)
    if not mid:
        raise RuntimeError("aria-amt 未生成 MIDI 文件")
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
    """aria-amt 可执行入口：pip 安装后生成于 python 的 Scripts 目录。"""
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
