# -*- coding: utf-8 -*-
"""MIROS（AMT Challenge 2025 冠军）通用转录可选引擎
====================================================
MIROS = YourMT3+ 架构 + MusicFM 编码器。权重/运行时由资源中心下载，不随安装包分发。
目录：<FUFUMIDI_MODELS_DIR>/miros/
  site/      Python 依赖
  repo/      MIROS 源码 + logs/.../last.ckpt + model/musicfm/data/pretrained_msd.pt
"""
import os
import sys


def _models_dir():
    return os.environ.get("FUFUMIDI_MODELS_DIR", "") or ""


def find_runtime():
    root = os.environ.get("FUFUMIDI_MIROS_RUNTIME", "") or ""
    if root and os.path.isdir(root):
        return root
    md = _models_dir()
    if not md:
        return None
    p = os.path.join(md, "miros")
    return p if os.path.isdir(p) else None


def available():
    rt = find_runtime()
    if not rt:
        return False
    needed = [
        os.path.join("site", "transformers", "__init__.py"),
        os.path.join("repo", "transcribe.py"),
        os.path.join("repo", "logs", "Multi_longer_seq_length_frozen_enc_silu", "le2bzt53", "checkpoints", "last.ckpt"),
        os.path.join("repo", "model", "musicfm", "data", "pretrained_msd.pt"),
    ]
    return all(os.path.exists(os.path.join(rt, p)) for p in needed)


def transcribe_miros(audio_path, output_midi, params=None, log_cb=None, num_threads=None):
    rt = find_runtime()
    if not rt:
        raise RuntimeError("未找到 MIROS 运行时。请到「资源中心 → 转录模型」下载 MIROS。")
    repo = os.path.join(rt, "repo")
    site = os.path.join(rt, "site")
    for p in (site, repo):
        if p not in sys.path:
            sys.path.insert(0, p)
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ["WANDB_MODE"] = "disabled"
    cwd = os.getcwd()
    os.chdir(repo)
    try:
        import torch
        import torchaudio
        import soundfile as sf
        if not getattr(torchaudio, "_fu_miros_sf", False):
            def _sf_load(path=None, uri=None, **kw):
                p = path or uri
                data, sr = sf.read(p, dtype="float32", always_2d=True)
                return torch.from_numpy(data.T), sr
            torchaudio.load = _sf_load
            torchaudio._fu_miros_sf = True
        import transcribe as miros_transcribe
        if log_cb:
            log_cb("MIROS：加载 MusicFM + MIROS checkpoint（首次较慢）")
        out = miros_transcribe.transcribe(audio_path, output_midi)
        try:
            import mido
            m = mido.MidiFile(output_midi)
            n = sum(1 for tr in m.tracks for msg in tr if msg.type == "note_on" and msg.velocity > 0)
        except Exception:
            n = 0
        if log_cb:
            log_cb("MIROS：输出 %d 个音符 → %s" % (n, os.path.basename(output_midi)))
        return n
    finally:
        os.chdir(cwd)
