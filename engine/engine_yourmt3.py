# -*- coding: utf-8 -*-
"""YourMT3+（YPTF+Single）通用转录可选引擎
==========================================
权重/运行时由资源中心下载，不随安装包分发。
运行时目录：<FUFUMIDI_MODELS_DIR>/yourmt3/
  site/                     Python 依赖（torch/torchaudio 用 App 自带）
  amt/src/                  YourMT3 pre-release 源码
  amt/logs/2024/<exp>/checkpoints/model.ckpt
约定版本：ptf_all_cross_rebal5_mirst_xk2_edr005_attend_c_full_plus_b100

运行时相关的公共能力（路径、torchaudio 补丁、wandb 桩、设备、线程、暂停闸门、
临时文件、音符计数）统一走 transcribe_runtime.py；本文件只留 YourMT3 自己的
模型加载与 MIDI 装配。
"""
import os
import time

import transcribe_runtime as TR

_RUNTIME = "yourmt3"
_EXP = "ptf_all_cross_rebal5_mirst_xk2_edr005_attend_c_full_plus_b100"
_CKPT_REL = os.path.join("amt", "logs", "2024", _EXP, "checkpoints", "model.ckpt")


def find_runtime():
    """运行时目录（资源中心解包后）。"""
    return TR.find_runtime(_RUNTIME)


def available():
    # ★ 6.1.5 起：权重路径兜底 —— 资源包布局或引擎 config 的 save_dir 可能写成
    #   logs/ 而不是 amt/logs/，这里两种都认（见 _ensure_checkpoint_paths）。
    #   只用"目录在不在"会骗人：半截解包同样目录齐全，所以补一个体积下界。
    rt = find_runtime()
    if not rt:
        return False
    for rel in ("site", os.path.join("amt", "src")):
        if not os.path.exists(os.path.join(rt, rel)):
            return False
    ckpt = TR.first_existing(rt, [_CKPT_REL,
                                  os.path.join("logs", "2024", _EXP, "checkpoints", "model.ckpt")])
    if not ckpt:
        return False
    try:
        return os.path.getsize(ckpt) > 100 * 1024 * 1024   # 361 MB 权重，半截不算装好
    except OSError:
        return False


def _install_paths(rt):
    TR.prepare_paths(rt, extra_dirs=[os.path.join("amt", "src")])
    TR.stub_wandb()


def _ensure_checkpoint_paths(rt):
    """把两种期望路径都补齐（硬链接优先，跨盘失败再拷贝）。

    上游 config 的 save_dir 可能写成 `logs` 或 `amt/logs`；只要真实 checkpoint 在
    rt 下，就让它两条路都读得到，避免 `No checkpoint found`。
    """
    found = TR.glob_first(rt, os.path.join("**", "checkpoints", "model.ckpt"))
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


def _load_model(rt, precision=None):
    _ensure_checkpoint_paths(rt)
    import torch
    device, prec = TR.select_device(precision)
    _install_paths(rt)
    TR.patch_torchaudio_soundfile()
    from model_helper import load_model_checkpoint
    args = [_EXP + "@model.ckpt", "-p", "2024", "-enc", "perceiver-tf",
            "-ac", "spec", "-hop", "300", "-atc", "1", "-pr", prec]
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
        raise RuntimeError(TR.runtime_missing_message(_RUNTIME))
    threads = TR.limit_threads(num_threads)
    TR.install_pause(log_cb)
    _install_paths(rt)
    import torch
    import soundfile as sf
    import audio_io
    from utils.audio import slice_padded_array
    from utils.note2event import mix_notes
    from utils.event2note import merge_zipped_note_events_and_ties_to_notes
    from utils.utils import write_model_output_as_midi
    device, _prec = TR.select_device(params.get("precision"))
    if log_cb:
        log_cb("YourMT3+（YPTF+Single）：独立运行时，%s 推理%s"
               % ("GPU" if device == "cuda" else "CPU", "，线程 %d" % threads if threads else ""))
    t_all = time.perf_counter()
    tmp = None
    try:
        model = _load_model(rt, params.get("precision"))
        tmp = audio_io.decode_to_wav(audio_path, 16000)
        data, sr = sf.read(tmp, dtype="float32", always_2d=True)
        audio = torch.from_numpy(data.T).mean(0, keepdim=True)
        audio = _resample(audio, sr, model.audio_cfg["sample_rate"])
        segs = slice_padded_array(audio, model.audio_cfg["input_frames"], model.audio_cfg["input_frames"])
        segs = torch.from_numpy(segs.astype("float32")).to(device).unsqueeze(1)
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
        write_model_output_as_midi(mixed, outdir + os.sep, base, model.midi_output_inverse_vocab)
        produced = os.path.join(outdir, "model_output", base + ".mid")
        if os.path.exists(produced):
            os.replace(produced, output_midi)
        if log_cb:
            log_cb("YourMT3+：推理 %.1fs，%d 个音符" % (time.perf_counter() - t_inf, len(mixed)))
        n = TR.count_notes(output_midi) or len(mixed)
        if n == 0:
            raise RuntimeError(
                "YourMT3+ 未输出任何音符（音频近乎静音 / 只有噪声 / 权重不匹配）。"
                "可换 MuScriptor 或 Basic Pitch 再试。")
        return n
    finally:
        if tmp:
            TR.cleanup(tmp)
        TR.release_gpu()
        TR.log_timing(log_cb, "YourMT3+ 总计", t_all)


def _resample(audio, sr, target_sr):
    import torchaudio
    if int(sr) == int(target_sr):
        return audio
    return torchaudio.functional.resample(audio, int(sr), int(target_sr))
