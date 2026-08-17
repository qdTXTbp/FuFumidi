# -*- coding: utf-8 -*-
"""
把内置 basic-pitch ONNX 动态量化为 int8，输出到模型目录（FUFUMIDI_MODELS_DIR）。
量化后：模型体积约减半，CPU 推理更快（配合 engine_perf 自动优先加载）。
用法（在 engine 目录或任意目录，需能 import engine_perf）：
    python scripts/quantize-basic-pitch.py [--out 输出路径]
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE_DIR = os.path.join(os.path.dirname(HERE), "engine")
if ENGINE_DIR not in sys.path:
    sys.path.insert(0, ENGINE_DIR)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    from engine_perf import _resolve_basic_pitch_model
    from onnxruntime.quantization import quantize_dynamic, QuantType

    src = _resolve_basic_pitch_model()
    models_dir = os.environ.get("FUFUMIDI_MODELS_DIR") or os.path.dirname(src)
    out = args.out or os.path.join(models_dir, "basic_pitch_quant.onnx")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    print(f"[quantize] 源模型: {src}")
    print(f"[quantize] 输出:   {out}")
    quantize_dynamic(src, out, weight_type=QuantType.QInt8)
    src_size = os.path.getsize(src)
    out_size = os.path.getsize(out)
    print(f"[quantize] 完成：{src_size/1e6:.1f} MB -> {out_size/1e6:.1f} MB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
