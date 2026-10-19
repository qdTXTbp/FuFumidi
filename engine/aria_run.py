# -*- coding: utf-8 -*-
"""Aria-AMT 启动包装：把「识别片段长度」注入 amt.inference.transcribe 的模块常量。

aria-amt 的 CLI 没有片段长度参数，训练/推理片段写死在
amt/inference/transcribe.py：LEN_MS = 30000、STRIDE_FACTOR = 3、CHUNK_LEN_MS = LEN_MS // STRIDE_FACTOR。
这里在启动真正的 run.py 之前按环境变量改这两个常量；不设置时完全等同原启动方式。

用法：python aria_run.py <amt/run.py 路径> [run.py 的原始参数...]
Windows 上必须保持 multiprocessing spawn 的「真实 .py 主模块」语义，所以本文件是进程入口。
"""
import os
import runpy
import sys


def _inject_segment_env():
    raw = os.environ.get("FUFUMIDI_ARIA_SEGMENT_MS")
    if not raw:
        return None
    try:
        ms = int(round(float(raw)))
    except (TypeError, ValueError):
        return None
    if ms <= 0:
        return None
    try:
        import amt.inference.transcribe as tr
        tr.LEN_MS = ms
        tr.CHUNK_LEN_MS = max(1, int(ms) // max(1, int(getattr(tr, "STRIDE_FACTOR", 3))))
        return ms
    except Exception:
        return None


def main():
    if len(sys.argv) < 2:
        raise SystemExit("aria_run.py: 缺少 amt/run.py 路径")
    target = sys.argv[1]
    _inject_segment_env()
    sys.argv = [target] + sys.argv[2:]
    runpy.run_path(target, run_name="__main__")


if __name__ == "__main__":
    main()
