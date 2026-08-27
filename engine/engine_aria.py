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
    model_dir = _resolve_model_dir()
    if model_dir:
        os.environ.setdefault("ARIA_MODEL_DIR", model_dir)

    _log(log_cb, "Aria-AMT 推理中（钢琴转录）…")
    out_dir = os.path.dirname(os.path.abspath(output_midi))
    os.makedirs(out_dir, exist_ok=True)

    # 优先 CLI：python -m amt transcribe <audio> <midi>
    try:
        _run_cli([sys.executable, "-m", "amt", "transcribe",
                  audio_path, output_midi, "--device", device], log_cb)
    except Exception as e1:
        # 回退：amt API
        try:
            from amt import transcribe as _api
            _api(audio_path, output_midi, device=device)
        except Exception as e2:
            raise RuntimeError(f"Aria-AMT 推理失败：{e1} / {e2}")

    n = _count_notes(output_midi)
    _log(log_cb, f"保存 MIDI → {os.path.basename(output_midi)}（{n} 音符）")
    return n


def _run_cli(cmd, log_cb):
    _log(log_cb, "运行 " + " ".join(cmd[-4:]))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
    if r.returncode != 0:
        raise RuntimeError((r.stderr or r.stdout or "").strip()[-500:])


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
