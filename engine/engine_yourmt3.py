# -*- coding: utf-8 -*-
"""YourMT3+（YPTF+Single）通用转录可选引擎
==========================================
权重/运行时由资源中心下载，不随安装包分发。
运行时目录：<FUFUMIDI_MODELS_DIR>/yourmt3/
  site/                     Python 依赖（torch/torchaudio 用 App 自带）
  amt/src/                  YourMT3 pre-release 源码
  amt/logs/2024/<exp>/checkpoints/model.ckpt
约定版本：ptf_all_cross_rebal5_mirst_xk2_edr005_attend_c_full_plus_b100
"""
import os
import sys
import time
import types

_RUNTIME_REL = "yourmt3"
_EXP = "ptf_all_cross_rebal5_mirst_xk2_edr005_attend_c_full_plus_b100"
_CKPT_REL = os.path.join("amt", "logs", "2024", _EXP, "checkpoints", "model.ckpt")


def _models_dir():
    return os.environ.get("FUFUMIDI_MODELS_DIR", "") or ""


def find_runtime():
    root = os.environ.get("FUFUMIDI_YOURMT3_RUNTIME", "") or ""
    if root and os.path.isdir(root):
        return root
    md = _models_dir()
    if not md:
        return None
    p = os.path.join(md, _RUNTIME_REL)
    return p if os.path.isdir(p) else None


def available():
    rt = find_runtime()
    if not rt:
        return False
    for rel in ("site", os.path.join("amt", "src"), _CKPT_REL):
        if not os.path.exists(os.path.join(rt, rel)):
            return False
    return True


def _install_paths(rt):
    for p in (os.path.join(rt, "site"), os.path.join(rt, "amt", "src"), rt):
        if p not in sys.path:
            sys.path.insert(0, p)
    # YourMT3 只在训练日志使用 wandb.Table；推理用轻量桩，避免被 wandb 依赖拖住
    if "wandb" not in sys.modules:
        w = types.ModuleType("wandb")

        class _Table:
            def __init__(self, *a, **k):
                pass

        w.Table = _Table
        sys.modules["wandb"] = w


def _ensure_checkpoint_paths(rt):
    """资源包布局/引擎 config 的 save_dir 可能写成 logs 或 amt/logs；
    只要实际 checkpoint 在 rt 下，就把两种期望路径都补齐，避免 No checkpoint found。"""
    found = None
    for root, _dirs, files in os.walk(rt):
        if "model.ckpt" in files:
            found = os.path.join(root, "model.ckpt")
            break
    if not found:
        return
    for rel in (_CKPT_REL, os.path.join("logs", "2024", _EXP, "checkpoints", "model.ckpt")):
        dst = os.path.join(rt, rel)
        if os.path.exists(dst):
            continue
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            try:
                os.link(found, dst)
            except Exception:
                import shutil
                shutil.copy2(found, dst)
        except Exception:
            pass


def _load_model(rt):
    _ensure_checkpoint_paths(rt)
    import torch
    import torchaudio
    import soundfile as sf
    _install_paths(rt)
    # torchaudio 2.9+ 的 load 需要 torchcodec；统一改用 soundfile
    if not getattr(torchaudio, "_fu_sf_load", False):
        _orig = torchaudio.load

        def _sf_load(path=None, uri=None, **kw):
            p = path or uri
            data, sr = sf.read(p, dtype="float32", always_2d=True)
            return torch.from_numpy(data.T), sr

        torchaudio.load = _sf_load
        torchaudio._fu_sf_load = True
    from model_helper import load_model_checkpoint
    prec = "16" if torch.cuda.is_available() else "32"
    args = [_EXP + "@model.ckpt", "-p", "2024", "-enc", "perceiver-tf",
            "-ac", "spec", "-hop", "300", "-atc", "1", "-pr", prec]
    device = "cuda" if torch.cuda.is_available() else "cpu"
    cwd = os.getcwd()
    os.chdir(rt)
    try:
        return load_model_checkpoint(args=args, device=device)
    finally:
        os.chdir(cwd)


def transcribe_yourmt3(audio_path, output_midi, params=None, log_cb=None, num_threads=None):
    params = params or {}
    rt = find_runtime()
    if not rt:
        raise RuntimeError("未找到 YourMT3 运行时。请到「资源中心 → 转录模型」下载 YourMT3+。")
    _install_paths(rt)
    import torch
    import soundfile as sf
    import audio_io
    from utils.audio import slice_padded_array
    from utils.note2event import mix_notes
    from utils.event2note import merge_zipped_note_events_and_ties_to_notes
    from utils.utils import write_model_output_as_midi
    if log_cb:
        log_cb("YourMT3+（YPTF+Single）：独立运行时，CPU/GPU 均可")
    try:
        torch.set_num_threads(max(1, min(8, int(num_threads or os.cpu_count() or 4))))
    except Exception:
        pass
    model = _load_model(rt)
    t0 = time.perf_counter()
    tmp = None
    try:
        tmp = audio_io.decode_to_wav(audio_path, 16000)
        data, sr = sf.read(tmp, dtype="float32", always_2d=True)
        audio = torch.from_numpy(data.T).mean(0, keepdim=True)
        audio = torchaudio_resample(audio, sr, model.audio_cfg["sample_rate"])
        segs = slice_padded_array(audio, model.audio_cfg["input_frames"], model.audio_cfg["input_frames"])
        segs = torch.from_numpy(segs.astype("float32")).to(
            "cuda" if torch.cuda.is_available() else "cpu").unsqueeze(1)
        if log_cb:
            log_cb("YourMT3+：%d 个片段，开始推理" % segs.shape[0])
        t_inf = time.perf_counter()
        pred, _ = model.inference_file(bsz=1, audio_segments=segs)
        n_items = segs.shape[0]
        starts = [model.audio_cfg["input_frames"] * i / model.audio_cfg["sample_rate"]
                  for i in range(n_items)]
        pred_notes = []
        for ch in range(model.task_manager.num_decoding_channels):
            arr_ch = [x[:, ch, :] for x in pred]
            zipped, _events, _err = model.task_manager.detokenize_list_batches(
                arr_ch, starts, return_events=True)
            notes, _ec = merge_zipped_note_events_and_ties_to_notes(zipped)
            pred_notes.append(notes)
        mixed = mix_notes(pred_notes)
        outdir = os.path.dirname(os.path.abspath(output_midi)) or "."
        base = os.path.splitext(os.path.basename(output_midi))[0]
        tmp_mid = os.path.join(outdir, base + ".yourmt3.mid")
        write_model_output_as_midi(mixed, outdir + os.sep, base, model.midi_output_inverse_vocab)
        produced = os.path.join(outdir, "model_output", base + ".mid")
        if os.path.exists(produced):
            os.replace(produced, output_midi)
        elif os.path.exists(tmp_mid):
            os.replace(tmp_mid, output_midi)
        if log_cb:
            log_cb("YourMT3+：推理 %.1fs，%d 个音符" % (time.perf_counter() - t_inf, len(mixed)))
        return len(mixed)
    finally:
        if tmp:
            try:
                audio_io.remove_temp(tmp)
            except Exception:
                pass


def torchaudio_resample(audio, sr, target_sr):
    import torchaudio
    if int(sr) == int(target_sr):
        return audio
    return torchaudio.functional.resample(audio, int(sr), int(target_sr))
