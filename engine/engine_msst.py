# -*- coding: utf-8 -*-
"""
MSST 音频分离引擎
==================
基于 pymss（原 MSST 推理库的官方封装）加载 MSST / VR 模型进行音轨分离，
支持 bs_roformer / mel_band_roformer / htdemucs / mdx23c / scnet /
bandit / apollo / vr 等架构。

参数（对齐 MSST-WebUI 语义，无预设体系）：
  chunk_size    分块大小（样本数，建议 44100 整数倍；增大提高分离效果，但增加耗时与显存）
  num_overlap   重叠数 N → step = chunk_size // N（增大提高分离效果，但增加耗时，建议 4）
  batch_size    批次大小（减小可降低显存占用，对效果影响不大）
  normalize     音频归一化（输入/输出统一缩放；部分模型无此功能）
  use_tta       TTA 测试时增强（小幅提升质量，推理时间 ×3）
  stems         输出音轨列表（不同模型可输出的音轨不同；缺省输出全部）
  output_format wav / flac / mp3（默认 wav）

实时输出：progress_cb(percent) 0~100（含 TTA 各 pass 合并）
依赖：pymss==2.0.1
"""

import os
import time


def available():
    """pymss（MSST 分离引擎）是否可用。"""
    try:
        import pymss  # noqa: F401
        return True
    except Exception:
        return False


# 模型文件名/架构推断出的家族 → pymss model_type
_ARCH_TABLE = {
    "mdx23c": "mdx23c",
    "htdemucs": "htdemucs",
    "htdemucsvocals": "htdemucs",
    "htdemucsftbass": "htdemucs",
    "htdemucsftdrums": "htdemucs",
    "drumsep": "htdemucs",
    "scnet": "scnet",
    "apollo": "apollo",
    "bandit": "bandit_v2",
    "melbandroformer": "mel_band_roformer",
    "bsroformer": "bs_roformer",
    "uvr": "vr",
    "vr": "vr",
}


def model_type_for(arch):
    """把架构名（models.js 的 arch 字段）映射为 pymss 支持的 model_type；不支持返回 None。"""
    key = "".join(ch for ch in str(arch or "").lower() if ch.isalnum())
    return _ARCH_TABLE.get(key)


def _log(cb, msg):
    if cb:
        try:
            cb(msg)
        except Exception:
            pass


def _emit(progress_cb, percent):
    if progress_cb:
        try:
            progress_cb(max(0.0, min(100.0, percent)))
        except Exception:
            pass


# ---------------------------------------------------------------------------
# 分块进度捕获：pymss 内部用 tqdm(total=mix.shape[1]) 逐块 update，
# 我们替换 pymss 命名空间里的 tqdm 为捕获类，把进度透传给外部回调。
# TTA 有多个 pass（每个 pass 一条进度条），按 pass 叠加成整体单调进度。
# ---------------------------------------------------------------------------
_PASS_TOTAL = 1           # 由调用方在跑之前设置（use_tta ? 3 : 1）


def _quiet_pymss_logger():
    """压制 pymss 的 INFO 日志：其一避免跨盘符(不同 mount)时其 logger 内部
    os.path.relpath 抛 ValueError；其二避免刷屏。真实进度走 progress_cb。"""
    try:
        import logging
        from pymss.logger import get_separation_logger
        get_separation_logger().setLevel(logging.WARNING)
    except Exception:
        pass


class _CaptureBar:
    _created = 0

    def __init__(self, iterable=None, total=None, desc=None, **kwargs):
        _CaptureBar._created += 1
        self.pass_index = _CaptureBar._created - 1
        self.total = 0.0
        if total is not None:
            self.total = float(total)
        elif iterable is not None:
            try:
                self.total = float(len(iterable))
            except Exception:
                self.total = 0.0
        self.n = 0.0

    def reset(self, total=None, *a, **k):
        if total is not None:
            self.total = float(total)
        self.n = 0.0

    def update(self, n=1):
        self.n += float(n)
        self.refresh()

    def refresh(self, *a, **k):
        pass

    def close(self):
        pass

    def set_postfix(self, *a, **k):
        pass

    @property
    def format_dict(self):
        return {"n": self.n, "total": self.total}

    def __iter__(self):
        return iter(self._iterable if hasattr(self, "_iterable") and self._iterable is not None else [])

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __str__(self):
        return ""

    def __del__(self):
        pass


def _install_progress(progress_cb):
    P = max(1, _PASS_TOTAL)

    def _push(self):
        frac = (self.pass_index + self.n / max(1.0, self.total)) / P
        _emit(progress_cb, frac * 100.0)

    _CaptureBar.refresh = _push
    _CaptureBar.close = _push

    # 替换 pymss 命名空间内已绑定的 tqdm 引用（demix / separator）
    import pymss.utils as _pu
    import pymss.separator as _ps
    _old_utils = getattr(_pu, "tqdm", None)
    _old_sep = getattr(_ps, "tqdm", None)
    _pu.tqdm = _CaptureBar
    _ps.tqdm = _CaptureBar
    # 兼容 tqdm.auto / tqdm.std（pymss 模型内部可能有别的调用点）
    try:
        import tqdm as _mtq
        import tqdm.auto as _ata
        _old_auto = getattr(_ata, "tqdm", _old_utils)
        _old_tq = _mtq.tqdm
        _ata.tqdm = _CaptureBar
        _mtq.tqdm = _CaptureBar
    except Exception:
        _old_auto = None
        _old_tq = None

    return lambda: _restore_tqdm(_pu, _ps, _old_utils, _old_sep, _old_auto, _old_tq)


def _restore_tqdm(_pu, _ps, _old_utils, _old_sep, _old_auto, _old_tq):
    try:
        if _old_utils is not None:
            _pu.tqdm = _old_utils
        if _old_sep is not None:
            _ps.tqdm = _old_sep
        if _old_auto is not None:
            import tqdm.auto as _ata
            _ata.tqdm = _old_auto
        if _old_tq is not None:
            import tqdm as _mtq
            _mtq.tqdm = _old_tq
    except Exception:
        pass


def separate(audio_path, out_dir, params=None, log_cb=None, progress_cb=None):
    """对单个音频文件做 MSST 分离，把所选音轨写入 out_dir，返回输出文件路径列表。

    参数来自前端；模型文件、配置路径、架构由主进程解析后经 params 传入：
      params["model_path"]   模型 .ckpt 绝对路径
      params["config_path"]  对应 .yaml 配置绝对路径（vr 可缺省）
      params["arch"]         架构名（用于推导 model_type）
      params["output_dir"]   输出目录（等同 out_dir）
    """
    from pymss.separator import MSSeparator
    from pymss.audio_io import load_audio, save_audio

    params = params or {}
    if not available():
        raise RuntimeError(
            "未检测到 pymss（MSST 分离引擎）。\n内置的音频分离引擎未加载，请重新安装 AudioMuse。"
        )
    _quiet_pymss_logger()

    model_path = params.get("model_path") or ""
    config_path = params.get("config_path") or None
    arch = params.get("arch") or ""
    model_type = model_type_for(arch)
    if not model_type:
        raise RuntimeError(
            f"该模型的架构「{arch or '未知'}」暂不支持。\n"
            "已支持的架构：BS-Roformer / Mel-Band Roformer / HTDemucs / MDX23C / "
            "SCNet / Bandit / Apollo / UVR。请更换模型后重试。"
        )
    if not model_path or not os.path.isfile(model_path):
        raise RuntimeError("未找到模型文件，请先在模型管理中下载所选模型。")
    if model_type != "vr" and (not config_path or not os.path.isfile(config_path)):
        raise RuntimeError("未找到该模型的配置文件（.\\.yaml），暂不支持此模型。")

    output_format = str(params.get("output_format") or "wav").lower().lstrip(".")
    if output_format not in ("wav", "flac", "mp3"):
        output_format = "wav"

    os.makedirs(out_dir, exist_ok=True)

    # ---- 推理参数（对齐 MSST-WebUI）----
    sr = 44100
    chunk_size = int(params.get("chunk_size") or 0)
    if chunk_size <= 0:
        chunk_size = 926100  # 21s，BS-Roformer 常见默认
    num_overlap = int(params.get("num_overlap") or 4)
    if num_overlap < 1:
        num_overlap = 1
    step = max(1, int(chunk_size // num_overlap))
    overlap_size = chunk_size - step          # pymss 用 overlap_size；等价于 MSST 的 step=C//N
    batch_size = max(1, int(params.get("batch_size") or 2))
    normalize = bool(params.get("normalize"))
    use_tta = bool(params.get("use_tta"))
    selected = params.get("stems") or None
    if isinstance(selected, str):
        selected = [s for s in selected.split(",") if s.strip()]

    global _PASS_TOTAL, _CaptureBar
    _PASS_TOTAL = 3 if use_tta else 1
    _CaptureBar._created = 0

    restore = None
    start = time.time()
    try:
        _log(log_cb, f"加载 MSST 模型（{arch} / {os.path.basename(model_path)}）…")
        separator = MSSeparator(
            model_type=model_type,
            model_path=model_path,
            config_path=config_path,
            device="auto",
            device_ids=[0],
            output_format=output_format,
            use_tta=use_tta,
            store_dirs=out_dir,
            inference_params={
                "batch_size": batch_size,
                "overlap_size": overlap_size,
                "chunk_size": chunk_size,
                "normalize": None if model_type == "vr" else normalize,
            },
        )
        _log(log_cb, "模型加载完成，开始分离…")

        instruments = list(separator.config.training.instruments)
        _log(log_cb, "可输出音轨：" + " / ".join(instruments))

        # 校验/过滤前端勾选的音轨：只保留本模型实际存在的音轨，避免非法键报错
        if selected:
            valid_low = {str(i).lower(): i for i in instruments}
            filtered = [valid_low[s.lower()] for s in selected if str(s).lower() in valid_low]
            if filtered != selected:
                dropped = [s for s in selected if str(s).lower() not in valid_low]
                _log(log_cb, "· 忽略无效音轨：" + " / ".join(dropped))
            selected = list(dict.fromkeys(filtered)) or None

        # 安装分块进度捕获
        restore = _install_progress(progress_cb)

        mix, sr = load_audio(os.path.abspath(audio_path), sr=sr, mono=False)
        if mix.ndim == 2 and mix.shape[0] > 2:
            mix = np_mean_channels(mix)

        # 若前端传了 stems，仅分离并保留这些音轨
        results = separator.separate(mix, pbar=True, stems=selected)

        base = os.path.splitext(os.path.basename(audio_path))[0]
        outputs = []
        audio_params = {
            "wav_bit_depth": "FLOAT",
            "flac_bit_depth": "PCM_24",
            "mp3_bit_rate": "320k",
            "m4a_bit_rate": "192k",
            "m4a_aac_at_quality": 2,
        }
        for stem, audio in results.items():
            save_dir = os.path.join(out_dir, f"{base}_{stem}.{output_format}")
            save_audio(save_dir, audio, sr, output_format, audio_params)
            outputs.append(save_dir)
            _log(log_cb, f"· 已输出音轨「{stem}」→ {os.path.basename(save_dir)}")

        _log(log_cb, f"分离完成，共 {len(outputs)} 个音轨，耗时 {time.time() - start:.1f}s")
        return outputs
    finally:
        if restore:
            try:
                restore()
            except Exception:
                pass
        try:
            import gc
            import torch
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception:
            pass


def np_mean_channels(mix):
    import numpy as np
    mono = np.mean(mix, axis=0)
    return np.stack([mono, mono], axis=0)