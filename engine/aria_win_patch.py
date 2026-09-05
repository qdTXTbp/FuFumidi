# -*- coding: utf-8 -*-
"""Aria-AMT Windows 兼容补丁（幂等、可增量）。

aria-amt 官方仅支持 Linux，在 Windows 上转录有多个失败点：
  1. transcribe.py 硬编码 `assert os.name == "posix"`
  2. 清理阶段引用仅 POSIX 存在的 `resource_tracker.unregister_after_fork`
  3. `os.remove("transcribe.log")` —— POSIX 允许删除已打开文件，Windows 报 WinError 32
  4. watchdog 用 Linux 专属 `/proc/<pid>` 探测存活，Windows 恒判死、立即杀子进程
  5. gpu_manager 用 torch.multiprocessing.Process，Windows spawn 传 model 报 WinError 5
  6. cu128 torchaudio 官方 wheel 在 Windows 无 sox/torchcodec：io.StreamReader / info / load 均不可用

本模块就地修补已安装的 amt 源码：逐条检查、缺失才替换（幂等），
保证无论通过 pip 安装多少次，转录前都会自动恢复到可用状态。
"""
import os

_MARKER = "# fu-windows-patch"

# ============ amt/inference/transcribe.py 的补丁对（old=原始，new=已修补） ============
_TRANSCRIBE_PATCHES = [
    # 1) 移操作系统硬限制
    (
        '    assert os.name == "posix", "UNIX/LINUX is the only supported OS"\n',
        '    # fu-windows-patch: aria-amt posix assert removed (Windows 可用)\n',
    ),
    # 2) 清理阶段保护 POSIX 专属属性
    (
        "        multiprocessing.resource_tracker.unregister_after_fork = True\n",
        "        try:\n"
        "            multiprocessing.resource_tracker.unregister_after_fork = True\n"
        "        except AttributeError:\n"
        "            pass  # fu-windows-patch: resource_tracker.unregister_after_fork is POSIX-only\n",
    ),
    # 3) 删除刚打开并写着的 transcribe.log（POSIX unlink 语义，Windows 报锁）
    (
        '    if os.path.isfile("transcribe.log"):\n'
        '        os.remove("transcribe.log")\n',
        '    if os.path.isfile("transcribe.log"):\n'
        '        try:\n'
        '            os.remove("transcribe.log")\n'
        '        except OSError:\n'
        '            pass  # fu-windows-patch: POSIX allows unlinking open files; Windows does not\n',
    ),
    # 4) watchdog 存活探测跨平台化（/proc 仅 Linux）
    (
        "def watchdog(main_pids: List, child_pids: List):\n"
        "    while True:\n"
        "        if not all(os.path.exists(f\"/proc/{pid}\") for pid in main_pids):\n"
        "            print(\"Watchdog cleaning up children...\")\n"
        "            cleanup_processes(child_pids=child_pids)\n"
        "            print(\"Watchdog exit.\")\n"
        "            return\n"
        "\n"
        "        time.sleep(1)\n",
        "def watchdog(main_pids: List, child_pids: List):\n"
        "    def _alive(pid):\n"
        "        # fu-windows-patch: 跨平台 pid 存活探测\n"
        "        if hasattr(os, 'kill') and os.name == 'posix':\n"
        "            try:\n"
        "                os.kill(pid, 0)\n"
        "                return True\n"
        "            except ProcessLookupError:\n"
        "                return False\n"
        "            except OSError:\n"
        "                return True\n"
        "        try:\n"
        "            import ctypes\n"
        "            _k32 = ctypes.windll.kernel32\n"
        "            _h = _k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION\n"
        "            if not _h:\n"
        "                return False\n"
        "            _k32.CloseHandle(_h)\n"
        "            return True\n"
        "        except Exception:\n"
        "            return True\n"
        "    while True:\n"
        "        if not all(_alive(pid) for pid in main_pids):\n"
        "            print(\"Watchdog cleaning up children...\")\n"
        "            cleanup_processes(child_pids=child_pids)\n"
        "            print(\"Watchdog exit.\")\n"
        "            return\n"
        "\n"
        "        time.sleep(1)\n",
    ),
    # 5) gpu_manager 用普通 multiprocessing.Process（规避 torch.mp spawn 在 Windows 的句柄问题）
    (
        "        _gpu_manager_process = torch_multiprocessing.Process(\n",
        "        _gpu_manager_process = multiprocessing.Process(\n",
    ),
]

# ============ amt/data.py 的补丁对 ============
# 统一的音频读取替代：cu128 torchaudio 在 Windows 无 sox/torchcodec
_LOAD_HELPER = (
    "import torchaudio\n"
    "import numpy as _np\n"
    "\n"
    "def _load_audio(path, frame_offset=0, num_frames=-1):\n"
    "    \"\"\"fu-windows-patch: 替代 torchaudio.load（cu128 torchaudio 在 Windows 缺 sox/torchcodec）。\"\"\"\n"
    "    import soundfile as _sf\n"
    "    with _sf.SoundFile(path) as _f:\n"
    "        _sr = _f.samplerate\n"
    "        _n = _f.frames - frame_offset if (num_frames is None or num_frames < 0) else num_frames\n"
    "        if frame_offset:\n"
    "            _f.seek(frame_offset)\n"
    "        _arr = _f.read(frames=_n, dtype='float32', always_2d=False)\n"
    "    _w = torch.from_numpy(_arr)\n"
    "    if _w.dim() == 1:\n"
    "        _w = _w.unsqueeze(0)  # (1, samples)\n"
    "    else:\n"
    "        _w = _w.t()  # (channels, samples)\n"
    "    return _w, _sr\n"
)

# StreamReader 流式 else 块原始形态（旧）
_OLD_STREAM_ELSE = (
    "    else:\n"
    "        # Yield segments in order\n"
    "        stream.add_basic_audio_stream(\n"
    "            frames_per_chunk=stride_samples,\n"
    "            stream_index=0,\n"
    "            sample_rate=sample_rate,\n"
    "        )\n"
    "\n"
    "        buffer = torch.tensor([], dtype=torch.float32)\n"
    "        total_samples = start_sample\n"
    "        for stride_seg in stream.stream():\n"
    "            seg_chunk = stride_seg[0].mean(1)\n"
    "\n"
    "            if end_sample and total_samples + seg_chunk.shape[0] > end_sample:\n"
    "                samples_to_use = end_sample - total_samples\n"
    "                seg_chunk = seg_chunk[:samples_to_use]\n"
    "\n"
    "            total_samples += seg_chunk.shape[0]\n"
    "\n"
    "            # Pad seg_chunk if required\n"
    "            if seg_chunk.shape[0] < stride_samples:\n"
    "                seg_chunk = F.pad(\n"
    "                    seg_chunk,\n"
    "                    (0, stride_samples - seg_chunk.shape[0]),\n"
    "                    mode=\"constant\",\n"
    "                    value=0.0,\n"
    "                )\n"
    "\n"
    "            if buffer.shape[0] < chunk_samples:\n"
    "                buffer = torch.cat((buffer, seg_chunk), dim=0)\n"
    "            else:\n"
    "                buffer = torch.cat((buffer[stride_samples:], seg_chunk), dim=0)\n"
    "\n"
    "            if buffer.shape[0] == chunk_samples:\n"
    "                yield buffer\n"
    "\n"
    "            if end_sample and total_samples >= end_sample:\n"
    "                break\n"
    "\n"
    "        if pad_last and buffer.shape[0] > stride_samples:\n"
    "            yield torch.nn.functional.pad(\n"
    "                buffer[stride_samples:],\n"
    "                (0, chunk_samples - len(buffer[stride_samples:])),\n"
    "            )\n"
)

# 等价的滑动窗口切片版本（Windows 可用，已验证）
_NEW_SLICE_ELSE = (
    "    else:\n"
    "        # fu-windows-patch: Windows 的 torchaudio 官方 wheel 未启用 io.StreamReader，\n"
    "        # 改用一次性加载 + 滑动窗口切片，语义等价\n"
    "        _wav, _orig_sr = _load_audio(audio_path)\n"
    "        _wav = _wav.mean(0)\n"
    "        _wav = torchaudio.functional.resample(\n"
    "            _wav, orig_freq=_orig_sr, new_freq=sample_rate\n"
    "        )\n"
    "        _seg_start = start_sample if segment is not None else 0\n"
    "        _seg_end = end_sample if segment is not None else _wav.shape[0]\n"
    "        _seg_end = min(_seg_end, _wav.shape[0])\n"
    "        _idx = _seg_start\n"
    "        _emitted = False\n"
    "        while _idx + chunk_samples <= _seg_end:\n"
    "            yield _wav[_idx:_idx + chunk_samples]\n"
    "            _idx += stride_samples\n"
    "            _emitted = True\n"
    "        if pad_last and (_seg_end - _idx) > 0:\n"
    "            yield torch.nn.functional.pad(\n"
    "                _wav[_idx:_seg_end],\n"
    "                (0, chunk_samples - (_seg_end - _idx)),\n"
    "                mode=\"constant\",\n"
    "                value=0.0,\n"
    "            )\n"
    "        elif pad_last and not _emitted and (_seg_end - _seg_start) > 0:\n"
    "            yield torch.nn.functional.pad(\n"
    "                _wav[_seg_start:_seg_end],\n"
    "                (0, chunk_samples - (_seg_end - _seg_start)),\n"
    "                mode=\"constant\",\n"
    "                value=0.0,\n"
    "            )\n"
)

_DATA_PATCHES = [
    # A) 注入 _load_audio 辅助（紧随 import torchaudio）
    ("import torchaudio\n", _LOAD_HELPER),
    # B) _get_single_wav_segment 带 offset 加载
    ("        wav, _ = torchaudio.load(\n", "        wav, _ = _load_audio(\n"),
    # C) _get_single_wav_segment 整段加载
    ("        wav, _ = torchaudio.load(audio_path)\n", "        wav, _ = _load_audio(audio_path)\n"),
    # D) StreamReader 创建（无条件行）置 None — 此处避免破坏后续 else 块
    (
        "    stream = torchaudio.io.StreamReader(audio_path)\n",
        "    stream = None  # fu-windows-patch: torchaudio.io.StreamReader unavailable on Windows\n",
    ),
    # E) stream.seek 保护（仅 segment 分支，正式单文件流程不走）
    (
        "        stream.seek(start_time_s)\n",
        "        pass  # fu-windows-patch: no StreamReader\n",
    ),
    # F) torchaudio.info 改用 soundfile（cu128 无 sox）
    (
        "    wav_info = torchaudio.info(audio_path)\n",
        "    # fu-windows-patch: cu128 torchaudio 在 Windows 上无 sox（info 缺失），改用 soundfile\n"
        "    import soundfile as _sf\n"
        "    _sfi = _sf.info(audio_path)\n"
        "    wav_info = type('WavInfo', (), {'num_frames': int(_sfi.frames), 'sample_rate': int(_sfi.samplerate)})()\n",
    ),
    # G) StreamReader 流式 else 块 → 滑动窗口切片
    (_OLD_STREAM_ELSE, _NEW_SLICE_ELSE),
]


def _transcribe_path():
    try:
        from amt.inference import transcribe
        return os.path.abspath(transcribe.__file__)
    except Exception:
        return None


def _data_path():
    try:
        import amt.data
        return os.path.abspath(amt.data.__file__)
    except Exception:
        return None


def _apply_file(path, patches):
    if not path or not os.path.isfile(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
    except Exception:
        return False
    # 文件已含补丁标记（可能是不完整/历史版本）→ 整体跳过，绝不重复包裹
    if _MARKER in src:
        return False
    changed = False
    for old, new in patches:
        if old in src:
            src = src.replace(old, new, 1)
            changed = True
    if not changed:
        return False
    try:
        with open(path, "w", encoding="utf-8") as f:
            f.write(src)
    except Exception:
        return False
    return True


def apply():
    """对已安装的 amt 源码应用全部补丁；返回是否发生改动。"""
    if os.name != "nt":
        return False
    t = _transcribe_path()
    d = _data_path()
    changed = _apply_file(t, _TRANSCRIBE_PATCHES)
    d_changed = _apply_file(d, _DATA_PATCHES)
    return changed or d_changed


if __name__ == "__main__":
    print("aria_win_patch applied:", apply())