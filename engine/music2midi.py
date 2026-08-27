#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
音乐转 MIDI 工具 v2.0
======================
任意歌曲 / 人声 / 乐器 → MIDI 转录工具
- 通用识别：任意歌曲、人声、多乐器（basic-pitch）
- 钢琴专用：纯钢琴高精度 + 踏板（piano-transcription）
- 人声分离：demucs 分声部转录（可选增强）
- 原生支持所有音频/视频格式；内置 MIDI 播放器；参数预设

三种用法:
    1) 图形界面 (推荐):    python music2midi.py
    2) 单文件转换:         python music2midi.py convert 歌曲.mp3 [options]
    3) 批量转换:           python music2midi.py batch [-i input] [-o output]

跨平台说明:
    主程序文件名为 ASCII（music2midi.py），配合 ASCII 编码的 .bat 启动器，
    在任何语言版本的 Windows / macOS / Linux 上都不会出现乱码。
"""

import argparse
import json
import os
import sys
import warnings

VERSION = "2.2.0"

def _patch_tqdm_compat():
    """兼容新版 tqdm 缺少 set_lock/get_lock 导致 huggingface_hub 导入失败的问题。"""
    try:
        from tqdm.auto import tqdm as _tqdm_cls
        import threading
        if not hasattr(_tqdm_cls, "set_lock"):
            _tqdm_cls.set_lock = lambda lock: None
        if not hasattr(_tqdm_cls, "get_lock"):
            _tqdm_cls.get_lock = lambda: threading.RLock()
    except Exception:
        pass

_patch_tqdm_compat()



def _setup_utf8_console():
    """跨平台防乱码：让控制台输出统一使用 UTF-8。

    - 把 Python 的 stdout/stderr 重配置为 UTF-8（含重定向到文件/管道时）
    - Windows 下同时把控制台代码页切到 UTF-8（65001），使中文能正确显示
    """
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    if os.name == "nt":
        try:
            import ctypes
            ctypes.windll.kernel32.SetConsoleOutputCP(65001)
            ctypes.windll.kernel32.SetConsoleCP(65001)
        except Exception:
            pass


# 屏蔽第三方噪音警告
warnings.filterwarnings("ignore")
try:
    import logging
    logging.getLogger().setLevel(logging.ERROR)
except Exception:
    pass

_setup_utf8_console()


def _get_base_dir():
    if getattr(sys, "frozen", False):  # PyInstaller 冻结环境
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))


BASE_DIR = _get_base_dir()
DEFAULT_INPUT_DIR = os.path.join(BASE_DIR, "input")
DEFAULT_OUTPUT_DIR = os.path.join(BASE_DIR, "output")


def dependencies_ok(mode=None):
    """检查指定模式（默认任意一种）的核心依赖是否可用。"""
    from engine import engine_available, MODES
    if mode:
        return engine_available(mode)
    return any(engine_available(m) for m in MODES)


def print_deps_help(mode=None):
    from engine import MODES
    print("=" * 60)
    print("  检测到缺少必要的 Python 依赖，无法进行转录。")
    print("")
    print("  请先双击运行本目录下的  install.bat 一键安装")
    print("  或手动执行:  pip install -r requirements.txt")
    if mode:
        print(f"")
        print(f"  当前模式「{MODES.get(mode, ('', ''))[0]}」还需要：")
        if mode == "separate":
            print("     pip install demucs")
        else:
            print("     （install.bat 已包含）")
    print("=" * 60)


# ---------------------------------------------------------------------------
# 命令行转换
# ---------------------------------------------------------------------------
def _resolve_params(args, mode):
    """把命令行参数 / 预设合并成该模式的参数字典。"""
    import presets
    from engine import DEFAULTS

    p = dict(DEFAULTS.get(mode, {}))
    if args.preset:
        presets_all, _ = presets.load_presets()
        pr = presets_all.get(args.preset)
        if pr:
            p.update(pr.get("params", {}))
            if pr.get("mode"):
                mode = pr["mode"]
        else:
            print(f"[警告] 找不到预设「{args.preset}」，使用默认参数")

    if mode == "universal":
        if args.onset_threshold is not None: p["onset_threshold"] = args.onset_threshold
        if args.frame_threshold is not None: p["frame_threshold"] = args.frame_threshold
        if args.min_note_length is not None: p["minimum_note_length"] = args.min_note_length
        if args.minimum_frequency is not None: p["minimum_frequency"] = args.minimum_frequency or None
        if args.maximum_frequency is not None: p["maximum_frequency"] = args.maximum_frequency or None
        if args.no_melodia: p["melodia_trick"] = False
        if args.tempo is not None: p["midi_tempo"] = args.tempo
    elif mode == "piano":
        if args.onset_threshold is not None: p["onset_threshold"] = args.onset_threshold
        if args.frame_threshold is not None: p["frame_threshold"] = args.frame_threshold
        if args.min_note_ms is not None: p["min_note_ms"] = args.min_note_ms
        if args.merge_gap_ms is not None: p["merge_gap_ms"] = args.merge_gap_ms
        if args.no_pedal: p["include_pedal"] = False
    elif mode == "separate":
        if args.onset_threshold is not None: p["onset_threshold"] = args.onset_threshold
        if args.frame_threshold is not None: p["frame_threshold"] = args.frame_threshold
        if args.min_note_length is not None: p["minimum_note_length"] = args.min_note_length
        if args.with_drums: p["include_drums"] = True
        if args.export_stems: p["export_stems"] = True
        if args.stem_format: p["stem_format"] = args.stem_format
        if args.tempo is not None: p["midi_tempo"] = args.tempo
    # 智能预处理 / 后处理开关（各模式通用，Electron 端传入）
    if getattr(args, "denoise", False): p["denoise"] = True
    if getattr(args, "normalize", False): p["normalize"] = True
    if getattr(args, "auto_bpm", False): p["auto_bpm"] = True
    if getattr(args, "no_merge", False): p["merge_overlap"] = False
    if getattr(args, "no_velnorm", False): p["normalize_vel"] = False
    # 子模型选择：universal → basic / muscriptor；piano → piano_pt / aria / transkun
    if getattr(args, "model", None): p["model"] = args.model
    if getattr(args, "model_size", None): p["model_size"] = args.model_size
    return p, mode


def cmd_convert(args):
    from engine import transcribe

    src = os.path.abspath(args.input)
    if not os.path.isfile(src):
        print(f"[错误] 找不到文件: {src}")
        return 1

    params, mode = _resolve_params(args, args.engine_mode)
    out = args.output
    if not out:
        out = os.path.splitext(src)[0] + ".mid"
    out = os.path.abspath(out)

    print(f"[1/2] 正在转录（{mode}）: {os.path.basename(src)}")
    try:
        out_dir = os.path.dirname(out)
        if out_dir:
            os.makedirs(out_dir, exist_ok=True)

        def log(msg):
            print(f"      {msg}")

        note_count = transcribe(src, out, mode=mode, params=params, log_cb=log,
                                perf_mode=args.perf)
        stems = []
        if mode == "separate" and params.get("export_stems"):
            try:
                import engine_separate
                stems = list(getattr(engine_separate, "last_stem_exports", []) or [])
            except Exception:
                pass
    except Exception as e:
        print(f"[错误] 转录失败: {e}")
        return 1

    print(f"[2/2] 完成！识别出 {note_count} 个音符")
    print(f"      输出: {out}")
    res = {'ok': True, 'note_count': note_count, 'out': out}
    if stems:
        res['stems'] = stems
        for s in stems:
            print(f"      分轨: {s}")
    print(f"###RESULT {json.dumps(res, ensure_ascii=False)}")
    return 0


def _collect_audio_files(input_dir):
    from audio_io import AUDIO_EXTENSIONS
    found = []
    for root, _dirs, names in os.walk(input_dir):
        for name in sorted(names):
            if os.path.splitext(name)[1].lower() in AUDIO_EXTENSIONS:
                found.append(os.path.join(root, name))
    return sorted(found)


def cmd_batch(args):
    from engine import transcribe

    input_dir = os.path.abspath(args.input_dir)
    output_dir = os.path.abspath(args.output_dir)
    os.makedirs(input_dir, exist_ok=True)
    os.makedirs(output_dir, exist_ok=True)

    files = _collect_audio_files(input_dir)
    if not files:
        print(f"[提示] 在 {input_dir} 中没有找到音频文件。")
        print("       请把 WAV / MP3 / FLAC / 视频等文件放进去后再运行一次。")
        return 1

    params, mode = _resolve_params(args, args.engine_mode)
    print(f"共找到 {len(files)} 个音频文件，开始转换（模式: {mode}）...")
    print("=" * 60)

    ok = 0
    for i, f in enumerate(files, 1):
        rel = os.path.relpath(f, input_dir)
        out_mid = os.path.join(output_dir, os.path.splitext(rel)[0] + ".mid")
        os.makedirs(os.path.dirname(out_mid), exist_ok=True)
        try:
            note_count = transcribe(f, out_mid, mode=mode, params=params,
                                    perf_mode=args.perf)
            ok += 1
            print(f"[{i}/{len(files)}] OK   {rel}  →  {note_count} 音符")
        except Exception as e:
            print(f"[{i}/{len(files)}] 失败 {rel}  →  {e}")

    print("=" * 60)
    print(f"转换完成: 成功 {ok} / {len(files)}")
    print(f"输出目录: {output_dir}")
    return 0 if ok == len(files) else 1


def cmd_probe():
    """环境诊断：输出一行 JSON（Electron 端解析）。"""
    from engine import MODES, engine_available
    out = {"ok": True, "app": "FuFumidi 转录引擎", "version": VERSION,
           "python": sys.version.split()[0], "engines": {}, "libs": {}}
    for m in MODES:
        try:
            out["engines"][m] = {"available": bool(engine_available(m))}
        except Exception as e:
            out["engines"][m] = {"available": False, "error": str(e)}
    for lib in ("numpy", "librosa", "soundfile", "pretty_midi", "scipy",
                "onnxruntime", "torch", "basic_pitch", "demucs"):
        try:
            mod = __import__(lib)
            out["libs"][lib] = getattr(mod, "__version__", "ok")
        except Exception:
            out["libs"][lib] = None
    # GPU 加速检测（CUDA / MPS / DirectML / ONNX GPU）
    try:
        from engine_gpu import detect as gpu_detect
        out["gpu"] = gpu_detect()
    except Exception as e:
        out["gpu"] = {"available": False, "error": str(e)}
    # 性能档位自动评估（UI 据此推荐/解锁/锁定性能选项）
    try:
        from engine_perf import detect_recommended
        out["perf"] = detect_recommended()
    except Exception as e:
        out["perf"] = {"recommended": "quality", "max_tier": "quality", "error": str(e)}
    print(json.dumps(out, ensure_ascii=False, indent=2))
    return 0


# ---------------------------------------------------------------------------
# 图形界面
# ---------------------------------------------------------------------------
def run_gui():
    from engine import transcribe, engine_available, MODES
    import gui

    # 至少需要一种引擎
    ok_modes = [m for m in MODES if engine_available(m)]
    if not ok_modes:
        from PySide6.QtWidgets import QApplication, QMessageBox
        app = QApplication([])
        QMessageBox.critical(None, "缺少依赖",
            "检测到缺少必要的转录引擎（basic-pitch / piano-transcription）。\n\n"
            "请先双击运行 install.bat 一键安装。")
        return 1
    return gui.run_gui(transcribe, DEFAULT_OUTPUT_DIR, VERSION)


# ---------------------------------------------------------------------------
# 参数
# ---------------------------------------------------------------------------
def build_parser():
    from engine import MODES
    parser = argparse.ArgumentParser(
        prog="music2midi",
        description="任意歌曲/人声/乐器 → MIDI 转录工具（通用识别 / 钢琴专用 / 人声分离）",
        epilog="示例:\n"
               "  python music2midi.py                          # 打开图形界面\n"
               "  python music2midi.py convert 歌曲.mp3         # 单文件转换\n"
               "  python music2midi.py convert 歌曲.mp3 --mode piano\n"
               "  python music2midi.py batch                    # 批量转换 input/ 文件夹",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("mode", nargs="?", choices=["convert", "batch", "probe", "gui", "worker"],
                        default="gui", help="运行模式（默认 gui）")
    parser.add_argument("input", nargs="?", help="[convert] 输入音频文件")
    parser.add_argument("-o", "--output", help="[convert] 输出 MIDI 路径（默认与输入同名同目录）")
    parser.add_argument("-i", "--input-dir", default=DEFAULT_INPUT_DIR,
                        help="[batch] 输入文件夹（默认 input/）")
    parser.add_argument("--output-dir", default=DEFAULT_OUTPUT_DIR,
                        help="[batch] 输出文件夹（默认 output/）")

    parser.add_argument("--mode", "--engine", dest="engine_mode", default="universal",
                        choices=list(MODES.keys()),
                        help="转录模式: universal=通用(默认) / piano=钢琴 / separate=人声分离")
    parser.add_argument("--preset", default=None, help="载入参数预设（名称见界面或 presets.json）")
    parser.add_argument("--perf", default="quality",
                        choices=["quality", "balanced", "fast"],
                        help="性能模式: quality=最高质量(默认,全部核心) / "
                             "balanced=均衡 / fast=高性能(低配省内存)")
    parser.add_argument("--model", default=None,
                        help="子模型: universal→basic/muscriptor；piano→piano_pt/aria/transkun")
    parser.add_argument("--model-size", default=None,
                        help="MuScriptor 规格: small / medium / large")

    g = parser.add_argument_group("转录参数（通用/钢琴/分离共用）")
    g.add_argument("--onset-threshold", type=float, default=None,
                   help="起音阈值 0~1，越小越灵敏")
    g.add_argument("--frame-threshold", type=float, default=None,
                   help="音符判定阈值 0~1，越大越干净")
    g.add_argument("--denoise", action="store_true", help="智能预处理·谱减法降噪")
    g.add_argument("--normalize", action="store_true", help="智能预处理·响度平衡")
    g.add_argument("--auto-bpm", action="store_true", help="自动检测 BPM 作为导出速度")
    g.add_argument("--no-merge", action="store_true", help="关闭重叠音符合并")
    g.add_argument("--no-velnorm", action="store_true", help="关闭力度归一化")

    g = parser.add_argument_group("通用/分离（basic-pitch）参数")
    g.add_argument("--min-note-length", type=float, default=None,
                   help="最短音符时长(ms)（默认 128）")
    g.add_argument("--min-freq", "--minimum-frequency", dest="minimum_frequency",
                   type=float, default=None, help="最低音高(Hz)，0=不限")
    g.add_argument("--max-freq", "--maximum-frequency", dest="maximum_frequency",
                   type=float, default=None, help="最高音高(Hz)，0=不限")
    g.add_argument("--no-melodia", action="store_true", help="关闭旋律增强")
    g.add_argument("--tempo", type=int, default=None, help="MIDI 速度 BPM（默认 120）")
    g.add_argument("--with-drums", action="store_true",
                   help="[separate] 同时输出鼓组节奏轨")
    g.add_argument("--stem-format", type=str, default=None, help="分轨导出格式 wav/flac/m4a")
    g.add_argument("--export-stems", action="store_true",
                   help="[separate] 导出分离后的音频分轨 WAV（vocals/bass/other/drums）")

    g = parser.add_argument_group("钢琴（piano-transcription）参数")
    g.add_argument("--min-note-ms", type=int, default=None, help="最小音符时长(ms)")
    g.add_argument("--merge-gap-ms", type=int, default=None, help="同音高音符合并间隔(ms)")
    g.add_argument("--no-pedal", action="store_true", help="不输出踏板事件")

    parser.add_argument("--version", action="version", version=f"音乐转MIDI工具 {VERSION}")
    return parser


def cmd_worker():
    """常驻 worker：从 stdin 读 JSON 请求，逐条执行 convert，保持模型/会话常驻。"""
    import argparse as _ap
    import contextlib
    import io
    import json as _json
    import sys as _sys

    _patch_tqdm_compat()
    for line in _sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = _json.loads(line)
            job = req.get('_id')
            ns = _ap.Namespace(
                input=req.get('audio'),
                output=req.get('out'),
                engine_mode=req.get('mode', 'universal'),
                perf=req.get('perf', 'quality'),
                preset=req.get('preset'),
                onset_threshold=req.get('onset_threshold'),
                frame_threshold=req.get('frame_threshold'),
                min_note_length=req.get('min_note_length'),
                min_note_ms=req.get('min_note_ms'),
                merge_gap_ms=req.get('merge_gap_ms'),
                denoise=bool(req.get('denoise')),
                normalize=bool(req.get('normalize')),
                auto_bpm=bool(req.get('auto_bpm')),
                no_merge=bool(req.get('no_merge')),
                no_velnorm=bool(req.get('no_velnorm')),
                with_drums=bool(req.get('with_drums')),
                stem_format=req.get('stem_format'),
                export_stems=bool(req.get('export_stems')),
                no_pedal=bool(req.get('no_pedal')),
                minimum_frequency=req.get('min_freq'),
                maximum_frequency=req.get('max_freq'),
                no_melodia=bool(req.get('no_melodia')),
                tempo=req.get('tempo'),
                model=req.get('model'),
                model_size=req.get('model_size'),
            )
            buf = io.StringIO()
            code = 1
            res = None
            try:
                with contextlib.redirect_stdout(buf):
                    code = cmd_convert(ns)
            except Exception as e:
                buf.write('\n[worker] convert error: ' + str(e))
            out = buf.getvalue()
            for l in out.splitlines():
                if l.startswith('###RESULT '):
                    try:
                        res = _json.loads(l[len('###RESULT '):])
                    except Exception:
                        res = None
                    break
            if res is None:
                res = {'ok': code == 0, 'error': out[-600:]}
            if job is not None:
                res['_id'] = job
            _sys.stdout.write('###RESULT ' + _json.dumps(res, ensure_ascii=False) + '\n')
            _sys.stdout.flush()
        except Exception as e:
            _sys.stdout.write('###RESULT ' + _json.dumps({'_id': None, 'ok': False, 'error': str(e)}) + '\n')
            _sys.stdout.flush()
    return 0


def main():
    args = build_parser().parse_args()

    if args.mode == "gui":
        return run_gui()

    if args.mode == "probe":
        return cmd_probe()

    if args.mode == "worker":
        return cmd_worker()

    if args.mode == "convert" and not args.input:
        print("[错误] convert 模式需要指定音频文件，例如:")
        print("       python music2midi.py convert 歌曲.mp3")
        return 1

    # 检查指定模式所需依赖
    if not dependencies_ok(args.engine_mode):
        print_deps_help(args.engine_mode)
        return 1

    if args.mode == "convert":
        return cmd_convert(args)
    if args.mode == "batch":
        return cmd_batch(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
