# -*- coding: utf-8 -*-
"""MIROS（AMT Challenge 2025 冠军）通用转录可选引擎
====================================================
MIROS = YourMT3+ 架构 + MusicFM 编码器。权重/运行时由资源中心下载，不随安装包分发。
目录：<FUFUMIDI_MODELS_DIR>/miros/
  site/      Python 依赖（含 transformers / lightning / MusicFM 所需）
  repo/      MIROS 源码 + logs/<exp>/<run>/checkpoints/last.ckpt
           + model/musicfm/data/pretrained_msd.pt

★ 2026-10-21 完善（此前只有 79 行薄封装）：
  1. `available()` 不再把训练批次目录名 `le2bzt53` 写死 —— 换一批训练
     「下载完了还说没装」，而这种不一致**不报错**，最难查；改成 glob 发现。
  2. 补 num_threads / 暂停闸门 / 显存归还（以前三个可选引擎里只有 YourMT3+ 有限线程）。
  3. `os.chdir(repo)` 改成 try/finally 保证还原（中途抛异常会把进程 cwd 留在 repo 里，
     后续队列的临时文件全落错地方）。
  4. 输出 0 音符时明确报错，不再静默产出空 MIDI（同 engine.py 的 0 音符保护）。
  5. 运行时公共能力统一走 transcribe_runtime.py。

推理入口仍是上游 repo 里的 `transcribe.transcribe(audio, midi)` ——
**不改上游逻辑**，只把外围（路径/线程/暂停/清理/校验）补齐。
"""
import os
import time

import transcribe_runtime as TR

_RUNTIME = "miros"


def find_runtime():
    """运行时目录（资源中心解包后）。"""
    return TR.find_runtime(_RUNTIME)


def find_checkpoint(rt=None):
    """定位 MIROS 微调权重（训练批次目录名会变，用 glob 发现）。

    布局是 `repo/logs/<exp>/<run>/checkpoints/last.ckpt`，但 <exp>/<run> 两层
    名字每次训练都不一样 —— 所以用 `**` 跨层匹配，**不写死任何一批的名字**
    （MIROS 接入第一版就写死过 `le2bzt53`，换批训练后「下载完了还说没装」）。
    """
    rt = rt or find_runtime()
    if not rt:
        return None
    return TR.glob_first(rt, os.path.join("**", "checkpoints", "last.ckpt"))


def find_musicfm(rt=None):
    """定位 MusicFM 预训练权重（`model/musicfm/data/pretrained_msd.pt`）。"""
    rt = rt or find_runtime()
    if not rt:
        return None
    return TR.glob_first(rt, os.path.join("**", "musicfm", "data", "*.pt"))


def available():
    """运行时就绪判据：目录 + 依赖 + 源码 + 两份权重，逐个用相对路径验。"""
    rt = find_runtime()
    if not rt:
        return False
    for rel in (os.path.join("site", "transformers", "__init__.py"),
                os.path.join("repo", "transcribe.py")):
        if not os.path.exists(os.path.join(rt, rel)):
            return False
    ckpt = find_checkpoint(rt)
    if not ckpt:
        return False
    try:
        if os.path.getsize(ckpt) < 100 * 1024 * 1024:   # 半截权重不算装好
            return False
    except OSError:
        return False
    return find_musicfm(rt) is not None


def transcribe_miros(audio_path, output_midi, params=None, log_cb=None, num_threads=None):
    rt = find_runtime()
    if not rt:
        raise RuntimeError(TR.runtime_missing_message(_RUNTIME))
    if not available():
        raise RuntimeError(
            "MIROS 运行时不完整（缺依赖 / 源码 / 权重）。请到「资源中心 → 转录模型」重新下载 MIROS。")
    threads = TR.limit_threads(num_threads)
    TR.install_pause(log_cb)
    TR.patch_torchaudio_soundfile()
    TR.stub_wandb()

    repo = os.path.join(rt, "repo")
    site = os.path.join(rt, "site")
    TR.prepare_paths(rt, extra_dirs=[repo])
    # HF 端点与 wandb 由上游 import 链读取；离线包不该去连 HF
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ["WANDB_MODE"] = "disabled"

    if log_cb:
        log_cb("MIROS：加载 MusicFM + MIROS checkpoint（首次较慢，%s）"
               % ("线程 %d" % threads if threads else "CPU"))
    t_all = time.perf_counter()
    cwd = os.getcwd()
    os.chdir(repo)                      # 上游用相对路径读 config，必须切过去
    try:
        import transcribe as miros_transcribe
        miros_transcribe.transcribe(audio_path, output_midi)
    finally:
        os.chdir(cwd)                   # ★ 一定要还原：否则后续队列的临时文件全落错地方
        TR.release_gpu()
        TR.log_timing(log_cb, "MIROS 总计", t_all)

    n = TR.count_notes(output_midi)
    if n == 0:
        raise RuntimeError(
            "MIROS 未输出任何音符（音频近乎静音 / 只有噪声 / 权重与素材不匹配）。"
            "可换 MuScriptor 或 Basic Pitch 再试。")
    if log_cb:
        log_cb("MIROS：输出 %d 个音符 → %s" % (n, os.path.basename(output_midi)))
    return n


import time  # noqa: E402  （放在文件末尾只为让上面的 import 分组保持可读）
