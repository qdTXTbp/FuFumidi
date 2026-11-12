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


class _UpstreamShapeError(RuntimeError):
    """上游 transcribe.py 的符号/流程与预期不符 —— 回落到整调接口（无细粒度进度）。"""


def _emit_prog(log_cb, completed=None, total=None, percent=None, label=None):
    """打一条进度协议行。

    实现已收敛到 `transcribe_runtime.emit_progress`（各引擎共用一个出口）：
      · `###PROG {"completed":n,"total":m}` —— 分块引擎的分块进度
      · `###PROG {"percent":p,"label":"…"}` —— 阶段百分比（加载模型 / 整理音符 等）
    必须**单独一行**且以 ###PROG 开头（worker 的日志转发会加缩进，对端会 trim）。
    """
    return TR.emit_progress(log_cb, completed=completed, total=total,
                            percent=percent, label=label)


def _pause_wait():
    """过一个暂停闸门（没有装就不做事）。

    ★ MIROS 上游的推理循环里没有任何 wait 点，所以此前「暂停」对它是无效的
      —— 点了暂停照样跑完整首。拆开驱动后每批过闸门，暂停才真正生效。
    """
    try:
        import pause_gate
        g = pause_gate.current()
        if g is not None and getattr(g, "active", False):
            g.wait()
    except Exception:
        pass


def _run_upstream_with_progress(mt, audio_path, output_midi, log_cb):
    """按上游 transcribe() 的同一顺序自己驱动，在阶段边界与每个推理批次打进度。

    为什么不再直接调 `mt.transcribe(audio_path, output_midi)`：
    它是一次性黑盒（加载 → 解码 → 切段 → 整批推理 → detokenize → 写盘），
    全程零回调 —— 任务中心的进度一直停在起始值（转录页 3%），结束时直接跳 100
    （用户 2026-11-12 反馈）。这里复刻它的编排（固定版本的离线 repo，不存在版本漂移），
    只额外做三件事：阶段进度、逐批进度、逐批暂停检查。任何一步与上游结构不符
    都抛 `_UpstreamShapeError`，由调用方回落到原整调接口（功能不受影响）。

    返回写出的 MIDI 路径。`mt` 是上游 transcribe 模块。
    """
    need = ("load_model_checkpoint", "slice_padded_array", "mix_notes",
            "merge_zipped_note_events_and_ties_to_notes", "write_model_output_as_midi")
    missing = [n for n in need if not hasattr(mt, n)]
    if missing:
        raise _UpstreamShapeError("缺少符号 " + ", ".join(missing))

    import torch
    import torchaudio

    output_dir = os.path.dirname(output_midi)
    output_base = os.path.splitext(os.path.basename(output_midi))[0]
    if output_dir:
        os.makedirs(output_dir, exist_ok=True)
    else:
        output_dir = "."

    # 上游 transcribe() 里写死的模型配置（musicfm_multidec）
    args = ["le2bzt53@last.ckpt", "-p", "Multi_longer_seq_length_frozen_enc_silu",
            "-if", "87381", "-el", "1024", "-enc", "musicfm", "-dpe", "rope",
            "-sqr", "1", "-tk", "mc13_full_plus_1024", "-dec", "multi-dec",
            "-st", "ddp", "-wb", "disabled", "-twe", "False", "-w", output_dir]

    # —— ① 加载模型（权重 + MusicFM；这一步没有可细分的进度，但文案要明确）——
    _emit_prog(log_cb, percent=3, label="加载模型")
    if log_cb:
        log_cb("[模型] 正在加载 MIROS checkpoint + MusicFM 编码器…")
    model = mt.load_model_checkpoint(args)
    _emit_prog(log_cb, percent=14, label="解码音频")

    # —— ② 解码 + 切段 ——
    audio, sr = torchaudio.load(uri=audio_path)
    audio = torch.mean(audio, dim=0).unsqueeze(0)
    audio = torchaudio.functional.resample(audio, sr, model.audio_cfg["sample_rate"])
    frames = int(model.audio_cfg["input_frames"])
    model_sr = int(model.audio_cfg["sample_rate"])
    audio_segments = mt.slice_padded_array(audio, frames, frames)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    audio_segments = torch.from_numpy(audio_segments.astype("float32")).to(device).unsqueeze(1)
    n_items = int(audio_segments.shape[0])
    seg_sec = frames / float(model_sr)
    if log_cb:
        log_cb("[预处理] 音频切分：%d 段 × %.1fs（覆盖 %.1fs），设备 %s"
               % (n_items, seg_sec, n_items * seg_sec, device.type))
    _emit_prog(log_cb, completed=0, total=n_items, label="推理中")

    # —— ③ 逐批推理（bsz=8 与上游一致）：每批打进度 + 过暂停闸门 ——
    bsz = 8
    pred_token_arr = []
    t_infer = time.perf_counter()
    with torch.cuda.amp.autocast(dtype=torch.bfloat16, enabled=torch.cuda.is_available()):
        for i in range(0, n_items, bsz):
            x = audio_segments[i:i + bsz]
            preds = model.inference(x, None).detach().cpu().numpy()
            pred_token_arr.append(preds)
            done = min(i + bsz, n_items)
            # 同时给 completed/total（分块语义）与 percent（**总进度**，20→90）：
            # 消费端 percent 优先，多段/单段都能得到正确的总体百分比。
            _emit_prog(log_cb, completed=done, total=n_items,
                       percent=20 + 70.0 * done / max(1, n_items), label="推理中")
            # 日志每 ~10% 一行，避免长歌曲把运行日志刷满
            if log_cb and (done == n_items or done * 10 // n_items != (done - len(preds)) * 10 // n_items):
                log_cb("[推理] 已转录 %d/%d 段" % (done, n_items))
            _pause_wait()
    if log_cb:
        log_cb("[计时] 推理 %d 段耗时 %.1fs" % (n_items, time.perf_counter() - t_infer))
    _emit_prog(log_cb, percent=90, label="整理音符")

    # —— ④ detokenize / 合并（按解码通道推进 90→98%）——
    num_channels = int(model.task_manager.num_decoding_channels)
    start_secs_file = [frames * i / float(model_sr) for i in range(n_items)]
    pred_notes_in_file = []
    from collections import Counter
    n_err_cnt = Counter()
    for ch in range(num_channels):
        pred_token_arr_ch = [arr[:, ch, :] for arr in pred_token_arr]
        zipped, _list_events, ne_err_cnt = model.task_manager.detokenize_list_batches(
            pred_token_arr_ch, start_secs_file, return_events=True)
        pred_notes_ch, n_err_cnt_ch = mt.merge_zipped_note_events_and_ties_to_notes(zipped)
        pred_notes_in_file.append(pred_notes_ch)
        n_err_cnt += n_err_cnt_ch
        _pause_wait()
        _emit_prog(log_cb, percent=90 + 8.0 * (ch + 1) / max(1, num_channels), label="整理音符")
    pred_notes = mt.mix_notes(pred_notes_in_file)

    # —— ⑤ 写 MIDI ——
    _emit_prog(log_cb, percent=99, label="写入 MIDI")
    midi_file = mt.write_model_output_as_midi(
        pred_notes, output_dir, output_base, model.midi_output_inverse_vocab)
    _emit_prog(log_cb, percent=100, label="完成")
    return midi_file



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


def _transcribe_miros_inner(audio_path, output_midi, params=None, log_cb=None, num_threads=None):
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
    # ★ 2026-10-31（GitHub PR #37）：MIROS 自带的 site/torch 是 CPU 版，
    #   以前 prepare_paths 把它插在 sys.path[0]，正好盖住 PYTHONPATH 里 GPU 增强包
    #   的 cu128 torch —— 有显卡也报 GPU available: False，整首走 CPU。
    #   现在默认让增强包优先；要排障对照可设 FUFUMIDI_RUNTIME_BUNDLED_TORCH=1。
    bundled_torch = bool(os.environ.get("FUFUMIDI_RUNTIME_BUNDLED_TORCH"))
    TR.prepare_paths(rt, extra_dirs=[repo], keep_env_packages=not bundled_torch)
    # ★ 2026-11-12：MIROS 的 site 若是另一种 CPython 构建（实测 cp312 vs 运行时 3.11），
    #   prepare_paths 会拒绝挂载 —— 这里必须立刻给明确报错，不能带着半套依赖继续跑，
    #   否则后面会以「scipy 坏了 / numpy 找不到」的形式炸在毫无关系的地方。
    _skip = TR.last_site_skip()
    if _skip and os.path.normcase(_skip.get("site", "")) == os.path.normcase(site):
        raise RuntimeError(
            "MIROS 运行时是按 Python %s 构建的，当前引擎是 Python %s，无法加载。"
            "请到「资源中心 → 转录模型」重新下载匹配当前运行时的版本，或改用 MuScriptor / 其他模型。"
            % (_skip.get("abi"), _skip.get("python")))
    info = TR.torch_info()
    if log_cb:
        # 把真正加载的 torch / 设备 / 目录写进日志：慢的时候一眼能看出走的是 CPU 还是 GPU
        log_cb(TR.describe_torch(info, _RUNTIME))
        for msg in (TR.cpu_fallback_hint(_RUNTIME, info),
                    TR.torch_compat_warning(_RUNTIME, site)):
            if msg:
                log_cb(msg)
    # HF 端点与 wandb 由上游 import 链读取；离线包不该去连 HF
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")
    os.environ["WANDB_MODE"] = "disabled"

    # ★ 2026-11-12：MIROS 的 MusicFM 编码器首次构建时要向 HuggingFace 拉
    #   `facebook/wav2vec2-conformer-rope-large-960h-ft` 的 config.json（约 2KB，
    #   运行时包不带它）。缓存命中时下面这句是纯本地操作；拉不到时
    #   huggingface_hub 会抛出难以理解的错误（实测两种：`LocalEntryNotFoundError`
    #   和 `expected string or bytes-like object, got 'NoneType'` —— 后者是它的
    #   内部代码拿 None 去做正则）。这里先主动拉一次，把失败翻译成人话。
    _MUSICFM_W2V_REPO = "facebook/wav2vec2-conformer-rope-large-960h-ft"
    try:
        from transformers import Wav2Vec2ConformerConfig as _W2VConf
        _W2VConf.from_pretrained(_MUSICFM_W2V_REPO)
    except Exception as e:  # noqa: BLE001
        raise RuntimeError(
            "MIROS 首次运行需要联网获取 MusicFM 编码器配置（%s/config.json，约 2KB，"
            "已按 hf-mirror.com 镜像重试）。当前网络不可达：%s。"
            "配置只需成功下载一次，之后可离线使用；也可以改用 MuScriptor / Basic Pitch 转录。"
            % (_MUSICFM_W2V_REPO, str(e)[:200]))

    if log_cb:
        log_cb("MIROS：加载 MusicFM + MIROS checkpoint（首次较慢，%s）"
               % ("线程 %d" % threads if threads else "CPU"))
    t_all = time.perf_counter()
    cwd = os.getcwd()
    os.chdir(repo)                      # 上游用相对路径读 config，必须切过去
    try:
        import transcribe as miros_transcribe
        try:
            try:
                # 拆开驱动：阶段进度 + 逐批进度 + 逐批暂停闸门（见 _run_upstream_with_progress）
                _run_upstream_with_progress(miros_transcribe, audio_path, output_midi, log_cb)
            except _UpstreamShapeError as e:
                # 上游结构不符（版本差异）→ 回落整调：功能不受影响，只是没有细粒度进度
                if log_cb:
                    log_cb("[警告] 上游 transcribe 接口与预期不符（%s），回落到整调接口"
                           "（本次没有细粒度进度）" % e)
                miros_transcribe.transcribe(audio_path, output_midi)
        except RuntimeError as e:
            # ★ 整首歌的中间激活随歌长增长（pre_decoder 对全长序列做逐层变换），
            #   长歌曲 + 系统内存紧张（浏览器 / 游戏同时开着）时容易 OOM：
            #   `DefaultCPUAllocator: not enough memory`。把它翻译成人话。
            if "not enough memory" in str(e) or "DefaultCPUAllocator" in str(e):
                raise RuntimeError(
                    "MIROS 内存不足：整首歌的中间激活随歌长增长，CPU 推理长歌曲很吃内存。"
                    "请关闭占内存的程序（游戏 / 浏览器）后重试；整首歌建议改用 MuScriptor —— "
                    "它更快、内存占用小得多。") from e
            raise
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


def transcribe_miros(audio_path, output_midi, params=None, log_cb=None, num_threads=None):
    """对外入口：跑完把本次插进 sys.path 的运行时目录清掉。

    常驻引擎复用同一个进程；MIROS 的 site 里带着另一套 numpy/torch，
    留在 sys.path 会污染后续 MuScriptor 任务（症状是「scipy 坏了」）。
    """
    try:
        return _transcribe_miros_inner(audio_path, output_midi, params=params,
                                       log_cb=log_cb, num_threads=num_threads)
    finally:
        TR.restore_paths()
