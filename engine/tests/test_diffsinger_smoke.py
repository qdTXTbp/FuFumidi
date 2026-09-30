# -*- coding: utf-8 -*-
"""DiffSinger 引擎端到端冒烟测试：构造假声库 + 假 ONNX 模型，跑通 render 管线。"""
import json
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np
import onnx
from onnx import TensorProto, helper, numpy_helper

PY = sys.executable
_TESTS_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.join(_TESTS_DIR, "..", "engine_diffsinger.py")

MEL_BINS = 128
HOP = 512
SR = 44100


def make_acoustic_onnx(path):
    """输入 phonemes[1,T] ph_mids[1,T] ph_dur[1,T] pitch[1,T'] → 输出 mel[1,128,T']"""
    ph = helper.make_tensor_value_info("phonemes", TensorProto.INT64, [1, "T"])
    mids = helper.make_tensor_value_info("ph_mids", TensorProto.FLOAT, [1, "T"])
    dur = helper.make_tensor_value_info("ph_dur", TensorProto.FLOAT, [1, "T"])
    pitch = helper.make_tensor_value_info("pitch", TensorProto.FLOAT, [1, "T2"])
    mel = helper.make_tensor_value_info("mel", TensorProto.FLOAT, [1, MEL_BINS, "T2"])
    # shape = concat([1,128], gather(shape(pitch), [1], axis=0))
    c1 = helper.make_node("Constant", [], ["c1"], value=helper.make_tensor("v", TensorProto.INT64, [2], [1, MEL_BINS]))
    shp = helper.make_node("Shape", ["pitch"], ["pshape"])
    gidx = helper.make_node("Constant", [], ["gidx"], value=helper.make_tensor("gi", TensorProto.INT64, [1], [1]))
    p1 = helper.make_node("Gather", ["pshape", "gidx"], ["p1"], axis=0)
    shape = helper.make_node("Concat", ["c1", "p1"], ["shape"], axis=0)
    val = helper.make_node("Constant", [], ["neg5"], value=helper.make_tensor("v2", TensorProto.FLOAT, [1], [-5.0]))
    expand = helper.make_node("Expand", ["neg5", "shape"], ["mel"])
    graph = helper.make_graph(
        [c1, shp, gidx, p1, shape, val, expand], "acoustic",
        [ph, mids, dur, pitch], [mel])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 10)])
    model.ir_version = 8
    onnx.save(model, path)


def make_vocoder_onnx(path):
    """输入 mel[1,128,T] f0[1,T] → 输出 wave[1, T*HOP]"""
    mel = helper.make_tensor_value_info("mel", TensorProto.FLOAT, [1, MEL_BINS, "T"])
    f0 = helper.make_tensor_value_info("f0", TensorProto.FLOAT, [1, "T"])
    wave = helper.make_tensor_value_info("wave", TensorProto.FLOAT, [1, "samples"])
    shp = helper.make_node("Shape", ["mel"], ["mshape"])
    gidx = helper.make_node("Constant", [], ["gidx"], value=helper.make_tensor("gi", TensorProto.INT64, [1], [2]))
    t = helper.make_node("Gather", ["mshape", "gidx"], ["t"], axis=0)
    hopc = helper.make_node("Constant", [], ["hop"], value=helper.make_tensor("h", TensorProto.INT64, [1], [HOP]))
    samples = helper.make_node("Mul", ["t", "hop"], ["samples"])
    one = helper.make_node("Constant", [], ["one"], value=helper.make_tensor("o", TensorProto.INT64, [1], [1]))
    shape = helper.make_node("Concat", ["one", "samples"], ["wshape"], axis=0)
    val = helper.make_node("Constant", [], ["amp"], value=helper.make_tensor("a", TensorProto.FLOAT, [1], [0.05]))
    expand = helper.make_node("Expand", ["amp", "wshape"], ["wave"])
    graph = helper.make_graph(
        [shp, gidx, t, hopc, samples, one, shape, val, expand], "vocoder",
        [mel, f0], [wave])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", 10)])
    model.ir_version = 8
    onnx.save(model, path)


def run(cmd_args):
    r = subprocess.run([PY, ENGINE] + cmd_args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    result = None
    for line in (r.stdout or "").splitlines():
        if line.startswith("###RESULT "):
            result = json.loads(line[len("###RESULT "):])
    return r, result


def main():
    tmp = tempfile.mkdtemp(prefix="ds_smoke_")
    vb = os.path.join(tmp, "FakeVB")
    os.makedirs(vb, exist_ok=True)
    make_acoustic_onnx(os.path.join(vb, "acoustic.onnx"))
    make_vocoder_onnx(os.path.join(tmp, "vocoder.onnx"))
    with open(os.path.join(vb, "dsconfig.yaml"), "w", encoding="utf-8") as f:
        f.write("name: FakeVB\nversion: 1.0\nphonemes: [AP, SP, a, i, n, o]\nacoustic: acoustic.onnx\nsample_rate: %d\nhop_size: %d\n" % (SR, HOP))
    # 词典:啊→a, 你→n i
    with open(os.path.join(vb, "zh.dsdict"), "w", encoding="utf-8") as f:
        f.write("zh:\n  啊: a\n  你: n i\n  好: h ao\n")

    ok = True

    # 1) deps --check
    r, res = run(["deps", "--check"])
    assert res and res["ok"], "deps --check 失败: %s" % (res,)
    print("PASS deps --check:", res["installed"])

    # 2) inspect
    r, res = run(["inspect", "--voicebank", vb])
    assert res and res["ok"], "inspect 失败: %s" % (res,)
    assert res["hasAcoustic"] and res["phonemeCount"] == 6 and res["dictionaryWords"] >= 2, res
    print("PASS inspect:", res["name"], "phonemes=%d" % res["phonemeCount"], "dictWords=%d" % res["dictionaryWords"])

    # 3) render(词典词 + 音素词 + 未知词混合)
    notes = [
        {"startBeat": 0, "durBeat": 1, "pitch": 60, "lyric": "啊"},
        {"startBeat": 1, "durBeat": 0.5, "pitch": 62, "lyric": "你", "vibrato": True, "vibDepth": 30, "vibFreq": 6.0},
        {"startBeat": 1.5, "durBeat": 0.5, "pitch": 64, "lyric": "i"},
        {"startBeat": 2.5, "durBeat": 1, "pitch": 65, "lyric": "未知词X"},
    ]
    out_wav = os.path.join(tmp, "out.wav")
    r, res = run(["render", "--voicebank", vb, "--notes", json.dumps(notes, ensure_ascii=False), "--bpm", "120", "--vocoder", os.path.join(tmp, "vocoder.onnx"), "--out", out_wav])
    assert res and res["ok"], "render 失败: %s\nstderr=%s" % (res, (r.stderr or "")[-500:])
    assert os.path.exists(out_wav), "wav 不存在"
    with open(out_wav, "rb") as f:
        head = f.read(44)
    assert head[:4] == b"RIFF" and head[8:12] == b"WAVE", "wav 头错误"
    ch, sr_hz, bits = struct.unpack("<H", head[22:24])[0], struct.unpack("<I", head[24:28])[0], struct.unpack("<H", head[34:36])[0]
    assert ch == 1 and sr_hz == SR and bits == 16, "wav 参数错误 ch=%d sr=%d bits=%d" % (ch, sr_hz, bits)
    size = os.path.getsize(out_wav) - 44
    dur_ms = size / 2 / SR * 1000
    # 4 拍 @120bpm = 2s,加 0.35s 尾,减 0.3s 裁剪 ≈ 2.05s 上下
    assert 1500 < dur_ms < 3500, "时长异常: %d ms" % dur_ms
    warned = any("未知词X" in w for w in res.get("warnings", []))
    assert warned, "未知歌词应产生 warning: %s" % res.get("warnings")
    print("PASS render: dur=%dms phonemes=%d warnings=%d" % (res["duration_ms"], res["phoneme_count"], len(res.get("warnings", []))))

    # 4) render 缺声码器时应报明确错误
    r, res = run(["render", "--voicebank", vb, "--notes", json.dumps(notes[:1], ensure_ascii=False), "--bpm", "120", "--out", os.path.join(tmp, "out2.wav")])
    assert res and not res["ok"] and "声码器" in res["error"], "缺声码器应报错: %s" % (res,)
    print("PASS render-without-vocoder error:", res["error"])

    print("\nALL SMOKE TESTS PASSED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
