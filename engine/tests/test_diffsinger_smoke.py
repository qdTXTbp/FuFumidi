# -*- coding: utf-8 -*-
"""DiffSinger 引擎端到端冒烟测试：构造假声库 + 假 ONNX 模型，跑通 render 管线。"""
import json
import os
import struct
import subprocess
import sys
import tempfile

import numpy as np
import pytest

onnx = pytest.importorskip("onnx")
helper = pytest.importorskip("onnx.helper")
numpy_helper = pytest.importorskip("onnx.numpy_helper")
TensorProto = onnx.TensorProto

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


# ---------------------------------------------------------------- v2 五段式夹具
# 这些假模型严格复刻真实 DiffSinger v2 的输入契约，重点是**帧数传播**：
#   linguistic(tokens,word_div,word_dur / tokens,ph_dur) → encoder_out[1,T,256]
#   dur(encoder_out,x_masks,ph_midi) → ph_dur_pred[1,T]  ← 全链路帧数基准
#   pitch/variance(…, ph_dur, …) 内部用自己的 sum(ph_dur) 推帧
# 真实声库里 pitch/variance 会因为「传入帧数与模型自算帧数不符」而在 Sub/Add
# 广播失败 —— 这里用 ReduceSum(ph_dur) 复刻该行为，以保证回归测试能捕获它。
def _onnx_save(path, nodes, inputs, outputs, inits=None, opset=13):
    graph = helper.make_graph(nodes, "g", inputs, outputs, initializer=inits or [])
    model = helper.make_model(graph, opset_imports=[helper.make_opsetid("", opset)])
    model.ir_version = 8
    onnx.save(model, path)


def make_v2_linguistic(path, kind):
    """kind='dur' → (tokens,word_div,word_dur)；其它 → (tokens,ph_dur)。输出 256 维编码。"""
    tok = helper.make_tensor_value_info("tokens", TensorProto.INT64, [1, "n_tokens"])
    enc = helper.make_tensor_value_info("encoder_out", TensorProto.FLOAT, [1, "n_tokens", 256])
    mask = helper.make_tensor_value_info("x_masks", TensorProto.BOOL, [1, "n_tokens"])
    nodes = []
    if kind == "dur":
        wd = helper.make_tensor_value_info("word_div", TensorProto.INT64, [1, "n_words"])
        wdur = helper.make_tensor_value_info("word_dur", TensorProto.INT64, [1, "n_words"])
        inputs = [tok, wd, wdur]
    else:
        ph = helper.make_tensor_value_info("ph_dur", TensorProto.INT64, [1, "n_tokens"])
        inputs = [tok, ph]
    # encoder_out = Expand(0.1, [1, len(tokens), 256])
    c1 = helper.make_node("Constant", [], ["c1"], value=helper.make_tensor("v", TensorProto.INT64, [1], [1]))
    c256 = helper.make_node("Constant", [], ["c256"], value=helper.make_tensor("v256", TensorProto.INT64, [1], [256]))
    shp = helper.make_node("Shape", ["tokens"], ["toks"])
    t = helper.make_node("Gather", ["toks", "c1"], ["tlen"], axis=0)
    shape = helper.make_node("Concat", ["c1", "tlen", "c256"], ["eshape"], axis=0)
    val = helper.make_node("Constant", [], ["v1"], value=helper.make_tensor("vv", TensorProto.FLOAT, [1], [0.1]))
    nodes += [c1, c256, shp, t, shape, val]
    nodes.append(helper.make_node("Expand", ["v1", "eshape"], ["encoder_out"]))
    # x_masks = tokens >= 0 （全 True），shape [1,n_tokens]
    zero = helper.make_node("Constant", [], ["zero"], value=helper.make_tensor("z", TensorProto.INT64, [1], [0]))
    ge = helper.make_node("GreaterOrEqual", ["tokens", "zero"], ["x_masks"])
    nodes += [zero, ge]
    _onnx_save(path, nodes, inputs, [enc, mask])


def make_v2_dur(path):
    """dur: encoder_out + x_masks + ph_midi → ph_dur_pred[1,n_tokens]（帧数，固定 8 帧/音素）"""
    enc = helper.make_tensor_value_info("encoder_out", TensorProto.FLOAT, [1, "n_tokens", 256])
    mask = helper.make_tensor_value_info("x_masks", TensorProto.BOOL, [1, "n_tokens"])
    midi = helper.make_tensor_value_info("ph_midi", TensorProto.INT64, [1, "n_tokens"])
    out = helper.make_tensor_value_info("ph_dur_pred", TensorProto.FLOAT, [1, "n_tokens"])
    # ph_dur_pred = Expand(8.0, shape(ph_midi))
    val = helper.make_node("Constant", [], ["v8"], value=helper.make_tensor("v", TensorProto.FLOAT, [1], [8.0]))
    shp = helper.make_node("Shape", ["ph_midi"], ["mshape"])
    nodes = [val, shp, helper.make_node("Expand", ["v8", "mshape"], ["ph_dur_pred"])]
    _onnx_save(path, nodes, [enc, mask, midi], [out])


def make_v2_pitch(path):
    """pitch: 用 ReduceSum(ph_dur) 自算帧数并 Expand 出 pitch_pred，复刻真实广播约束。"""
    enc = helper.make_tensor_value_info("encoder_out", TensorProto.FLOAT, [1, "n_tokens", 256])
    ph = helper.make_tensor_value_info("ph_dur", TensorProto.INT64, [1, "n_tokens"])
    midi = helper.make_tensor_value_info("note_midi", TensorProto.FLOAT, [1, "n_notes"])
    rest = helper.make_tensor_value_info("note_rest", TensorProto.BOOL, [1, "n_notes"])
    ndur = helper.make_tensor_value_info("note_dur", TensorProto.INT64, [1, "n_notes"])
    pitch = helper.make_tensor_value_info("pitch", TensorProto.FLOAT, [1, "n_frames"])
    expr = helper.make_tensor_value_info("expr", TensorProto.FLOAT, [1, "n_frames"])
    retake = helper.make_tensor_value_info("retake", TensorProto.BOOL, [1, "n_frames"])
    steps = helper.make_tensor_value_info("steps", TensorProto.INT64, [])
    out = helper.make_tensor_value_info("pitch_pred", TensorProto.FLOAT, [1, "n_frames"])
    # total = ReduceSum(ph_dur) → 用它对 pitch 做校验式广播（Add 0）：与真实模型同样的约束
    c1 = helper.make_node("Constant", [], ["c1"], value=helper.make_tensor("v", TensorProto.INT64, [1], [1]))
    ax = helper.make_node("Constant", [], ["ax"], value=helper.make_tensor("a", TensorProto.INT64, [1], [1]))
    rs = helper.make_node("ReduceSum", ["ph_dur", "ax"], ["total"], keepdims=0)
    shape = helper.make_node("Concat", ["c1", "total"], ["fshape"], axis=0)
    val = helper.make_node("Constant", [], ["v220"], value=helper.make_tensor("v", TensorProto.FLOAT, [1], [220.0]))
    exp = helper.make_node("Expand", ["v220", "fshape"], ["base"])
    # pitch_pred = base + pitch  → pitch 长度必须 == total，否则广播失败（正是我们要测的）
    add = helper.make_node("Add", ["base", "pitch"], ["pitch_pred"])
    _onnx_save(path, [c1, ax, rs, shape, val, exp, add],
               [enc, ph, midi, rest, ndur, pitch, expr, retake, steps], [out])


def make_v2_variance(path):
    """variance: 同样用 ReduceSum(ph_dur) 推帧；三路输出以 pitch 校验广播。"""
    enc = helper.make_tensor_value_info("encoder_out", TensorProto.FLOAT, [1, "n_tokens", 256])
    ph = helper.make_tensor_value_info("ph_dur", TensorProto.INT64, [1, "n_tokens"])
    pitch = helper.make_tensor_value_info("pitch", TensorProto.FLOAT, [1, "n_frames"])
    bre = helper.make_tensor_value_info("breathiness", TensorProto.FLOAT, [1, "n_frames"])
    voi = helper.make_tensor_value_info("voicing", TensorProto.FLOAT, [1, "n_frames"])
    ten = helper.make_tensor_value_info("tension", TensorProto.FLOAT, [1, "n_frames"])
    retake = helper.make_tensor_value_info("retake", TensorProto.BOOL, [1, "n_frames", 3])
    steps = helper.make_tensor_value_info("steps", TensorProto.INT64, [])
    ob = helper.make_tensor_value_info("breathiness_pred", TensorProto.FLOAT, [1, "n_frames"])
    ov = helper.make_tensor_value_info("voicing_pred", TensorProto.FLOAT, [1, "n_frames"])
    ot = helper.make_tensor_value_info("tension_pred", TensorProto.FLOAT, [1, "n_frames"])
    c1 = helper.make_node("Constant", [], ["c1"], value=helper.make_tensor("v", TensorProto.INT64, [1], [1]))
    ax = helper.make_node("Constant", [], ["ax"], value=helper.make_tensor("a", TensorProto.INT64, [1], [1]))
    rs = helper.make_node("ReduceSum", ["ph_dur", "ax"], ["total"], keepdims=0)
    shape = helper.make_node("Concat", ["c1", "total"], ["fshape"], axis=0)
    z = helper.make_node("Constant", [], ["z"], value=helper.make_tensor("zv", TensorProto.FLOAT, [1], [0.0]))
    o = helper.make_node("Constant", [], ["o"], value=helper.make_tensor("ov", TensorProto.FLOAT, [1], [1.0]))
    ez = helper.make_node("Expand", ["z", "fshape"], ["base0"])
    eo = helper.make_node("Expand", ["o", "fshape"], ["base1"])
    # 每路都 + pitch，长度不符即广播失败
    ab = helper.make_node("Add", ["base0", "pitch"], ["breathiness_pred"])
    av = helper.make_node("Add", ["base1", "pitch"], ["voicing_pred"])
    at = helper.make_node("Add", ["base1", "pitch"], ["tension_pred"])
    _onnx_save(path, [c1, ax, rs, shape, z, o, ez, eo, ab, av, at],
               [enc, ph, pitch, bre, voi, ten, retake, steps], [ob, ov, ot])


def make_acoustic_v2_onnx(path):
    """v2 acoustic：tokens/durations/f0/breathiness/voicing/tension/gender/velocity/depth/steps
    → mel[1, n_frames, 128]（T-last，与真实 v2 声库一致）。

    内部用 ReduceSum(durations) 推帧，mel 长度即该值 —— 因此调用方若把 durations
    与 f0 帧数弄错，就会像真实模型一样在广播处失败。
    """
    tok = helper.make_tensor_value_info("tokens", TensorProto.INT64, [1, "n_tokens"])
    dur = helper.make_tensor_value_info("durations", TensorProto.INT64, [1, "n_tokens"])
    f0 = helper.make_tensor_value_info("f0", TensorProto.FLOAT, [1, "n_frames"])
    bre = helper.make_tensor_value_info("breathiness", TensorProto.FLOAT, [1, "n_frames"])
    voi = helper.make_tensor_value_info("voicing", TensorProto.FLOAT, [1, "n_frames"])
    ten = helper.make_tensor_value_info("tension", TensorProto.FLOAT, [1, "n_frames"])
    gen = helper.make_tensor_value_info("gender", TensorProto.FLOAT, [1, "n_frames"])
    vel = helper.make_tensor_value_info("velocity", TensorProto.FLOAT, [1, "n_frames"])
    dep = helper.make_tensor_value_info("depth", TensorProto.FLOAT, [])
    stp = helper.make_tensor_value_info("steps", TensorProto.INT64, [])
    mel = helper.make_tensor_value_info("mel", TensorProto.FLOAT, [1, "n_frames", MEL_BINS])
    c1 = helper.make_node("Constant", [], ["c1"], value=helper.make_tensor("v", TensorProto.INT64, [1], [1]))
    c128 = helper.make_node("Constant", [], ["c128"], value=helper.make_tensor("v128", TensorProto.INT64, [1], [MEL_BINS]))
    ax = helper.make_node("Constant", [], ["ax"], value=helper.make_tensor("a", TensorProto.INT64, [1], [1]))
    rs = helper.make_node("ReduceSum", ["durations", "ax"], ["total"], keepdims=0)
    shape = helper.make_node("Concat", ["c1", "total", "c128"], ["mshape"], axis=0)
    val = helper.make_node("Constant", [], ["neg5"], value=helper.make_tensor("n5", TensorProto.FLOAT, [1], [-5.0]))
    exp = helper.make_node("Expand", ["neg5", "mshape"], ["mel_raw"])
    # mel = mel_raw + f0[..., None]  —— f0 长度必须 == total，否则广播失败
    # 用 Unsqueeze(axes=[-1])（opset 13 语义）把 [1, T] → [1, T, 1]
    axm1 = helper.make_node("Constant", [], ["axm1"], value=helper.make_tensor("am", TensorProto.INT64, [1], [-1]))
    unsq = helper.make_node("Unsqueeze", ["f0", "axm1"], ["f0c"])
    add = helper.make_node("Add", ["mel_raw", "f0c"], ["mel"])
    _onnx_save(path, [c1, c128, ax, rs, shape, val, exp, axm1, unsq, add],
               [tok, dur, f0, bre, voi, ten, gen, vel, dep, stp], [mel])


def make_v2_voicebank(root, tmp):
    """搭出 dsdur/dspitch/dsvariance 三段目录 + 主 acoustic + 声码器。"""
    os.makedirs(root, exist_ok=True)
    # 主目录配置：音素表带语言前缀（真实 v2 声库风格）
    with open(os.path.join(root, "dsconfig.yaml"), "w", encoding="utf-8") as f:
        f.write("name: V2VB\nversion: 1.0\n"
                "phonemes: [AP, SP, zh/a, zh/i, zh/n, zh/o, zh/x, zh/iang, zh/w]\n"
                "acoustic: acoustic_v2.onnx\nsample_rate: %d\nhop_size: %d\n"
                "num_mel_bins: %d\n" % (SR, HOP, MEL_BINS))
    make_acoustic_v2_onnx(os.path.join(root, "acoustic_v2.onnx"))
    with open(os.path.join(root, "zh.dsdict"), "w", encoding="utf-8") as f:
        f.write("zh:\n  a: zh/a\n  ni: zh/n zh/i\n  wo: zh/w zh/o\n  chang: zh/ch zh/ang\n")
    # 三段子模型
    for sub, kind, builder in (("dsdur", "dur", make_v2_dur),
                               ("dspitch", "plain", make_v2_pitch),
                               ("dsvariance", "plain", make_v2_variance)):
        d = os.path.join(root, sub)
        os.makedirs(d, exist_ok=True)
        make_v2_linguistic(os.path.join(d, "ling.onnx"), kind)
        builder(os.path.join(d, "model.onnx"))
        key = {"dsdur": "dur", "dspitch": "pitch", "dsvariance": "variance"}[sub]
        with open(os.path.join(d, "dsconfig.yaml"), "w", encoding="utf-8") as f:
            f.write("linguistic: ling.onnx\n%s: model.onnx\n" % key)
    # 自带声码器（dsvocoder/），避免测试因缺声码器失败
    dv = os.path.join(root, "dsvocoder")
    os.makedirs(dv, exist_ok=True)
    make_vocoder_onnx(os.path.join(dv, "voc.onnx"))
    return root


def main():
    tmp = tempfile.mkdtemp(prefix="ds_smoke_")
    vb = os.path.join(tmp, "FakeVB")
    os.makedirs(vb, exist_ok=True)
    make_acoustic_onnx(os.path.join(vb, "acoustic.onnx"))
    make_vocoder_onnx(os.path.join(tmp, "vocoder.onnx"))
    with open(os.path.join(vb, "dsconfig.yaml"), "w", encoding="utf-8") as f:
        f.write("name: FakeVB\nversion: 1.0\nphonemes: [AP, SP, zh/a, zh/i, zh/n, zh/o]\nacoustic: acoustic.onnx\nsample_rate: %d\nhop_size: %d\n" % (SR, HOP))
    # 词典:拼音键 → 语言前缀音素（真实 DiffSinger v2 声库的格式）
    with open(os.path.join(vb, "zh.dsdict"), "w", encoding="utf-8") as f:
        f.write("zh:\n  a: zh/a\n  ni: zh/n zh/i\n  hao: zh/h zh/ao\n")

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
        {"startBeat": 1.5, "durBeat": 0.5, "pitch": 64, "lyric": "zh/i"},
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
    warns_all = res.get("warnings", [])
    assert any("不在声库音素表中" in w for w in warns_all), "未知歌词应产生音素回退 warning: %s" % warns_all
    print("PASS render: dur=%dms phonemes=%d warnings=%d" % (res["duration_ms"], res["phoneme_count"], len(warns_all)))

    # 4) render 缺声码器时应报明确错误
    r, res = run(["render", "--voicebank", vb, "--notes", json.dumps(notes[:1], ensure_ascii=False), "--bpm", "120", "--out", os.path.join(tmp, "out2.wav")])
    assert res and not res["ok"] and "声码器" in res["error"], "缺声码器应报错: %s" % (res,)
    print("PASS render-without-vocoder error:", res["error"])

    # 5) 范围渲染：只渲染第 1~2 拍（第 2 个音符），带 0.5s 上下文
    #    音符 @120bpm：0~0.5s, 0.5~0.75s, 0.75~1.0s, 1.25~1.75s
    out_rng = os.path.join(tmp, "range.wav")
    r, res = run(["render", "--voicebank", vb, "--notes", json.dumps(notes, ensure_ascii=False),
                  "--bpm", "120", "--vocoder", os.path.join(tmp, "vocoder.onnx"),
                  "--start-beat", "1", "--end-beat", "2",
                  "--context-sec", "0.5", "--out", out_rng])
    assert res and res["ok"], "范围渲染失败: %s\nstderr=%s" % (res, (r.stderr or "")[-500:])
    rng = res.get("range")
    assert rng, "范围渲染应返回 range 元信息: %s" % res
    assert abs(rng["startSec"] - 0.5) < 1e-6, "选区起点应为 0.5s: %s" % rng
    assert abs(rng["endSec"] - 1.0) < 1e-6, "选区终点应为 1.0s: %s" % rng
    assert rng["originSec"] < rng["startSec"], "应有前置上下文: %s" % rng
    assert rng["selectedNoteCount"] == 2, "选区命中 2 个音符: %s" % rng
    assert rng["renderNoteCount"] >= rng["selectedNoteCount"], "渲染音符应含上下文: %s" % rng
    assert rng["renderNoteCount"] < rng["totalNoteCount"] + 1, "不应把全部音符都渲染: %s" % rng
    rng_ms = (os.path.getsize(out_rng) - 44) / 2 / SR * 1000
    # 选区 0.5s + 尾部余量 0.08s ≈ 0.58s；关键断言：明显短于全曲
    assert 400 < rng_ms < 900, "选区时长异常: %d ms" % rng_ms
    full_ms = dur_ms
    assert rng_ms < full_ms * 0.6, "选区应明显短于全曲（%d vs %d）" % (rng_ms, full_ms)
    print("PASS range render: sel=%.2f~%.2fs origin=%.2fs notes=%d/%d dur=%dms (full=%dms)" % (
        rng["startSec"], rng["endSec"], rng["originSec"],
        rng["renderNoteCount"], rng["totalNoteCount"], rng_ms, full_ms))

    # 6) --context-sec 0：关闭上下文，只渲染 1~2 拍内的 2 个音符
    out_noctx = os.path.join(tmp, "range_noctx.wav")
    r, res = run(["render", "--voicebank", vb, "--notes", json.dumps(notes, ensure_ascii=False),
                  "--bpm", "120", "--vocoder", os.path.join(tmp, "vocoder.onnx"),
                  "--start-beat", "1", "--end-beat", "2",
                  "--context-sec", "0", "--out", out_noctx])
    assert res and res["ok"], "无上下文范围渲染失败: %s" % res
    assert res["range"]["renderNoteCount"] == 2, "context-sec=0 时不应引入额外上下文: %s" % res["range"]
    print("PASS range render (no context): notes=%d" % res["range"]["renderNoteCount"])

    # 7) 空选区：第 3~3.5 拍之间没有音符（1.5~1.75s 落在 1.25~1.75s 音符内，改用一个真空档）
    r, res = run(["render", "--voicebank", vb, "--notes", json.dumps(notes, ensure_ascii=False),
                  "--bpm", "120", "--vocoder", os.path.join(tmp, "vocoder.onnx"),
                  "--start-beat", "10", "--end-beat", "12", "--out", os.path.join(tmp, "none.wav")])
    assert res and not res["ok"] and "选区" in res["error"], "空选区应报错: %s" % (res,)
    print("PASS empty-range error:", res["error"])

    # 8) 反向选区（终点 <= 起点）应报错
    r, res = run(["render", "--voicebank", vb, "--notes", json.dumps(notes, ensure_ascii=False),
                  "--bpm", "120", "--vocoder", os.path.join(tmp, "vocoder.onnx"),
                  "--start-beat", "2", "--end-beat", "1", "--out", os.path.join(tmp, "bad.wav")])
    assert res and not res["ok"] and "选区无效" in res["error"], "反向选区应报错: %s" % (res,)
    print("PASS invalid-range error:", res["error"])

    # 9) deps --check 应报出 GPU provider 信息
    r, res = run(["deps", "--check", "--device", "cpu"])
    assert res and res["ok"] and res.get("gpu"), "deps 应返回 gpu 段: %s" % (res,)
    assert res["gpu"]["active"] == "CPUExecutionProvider", "--device cpu 应固定 CPU: %s" % res["gpu"]
    print("PASS deps --device cpu: active=%s avail=%s" % (res["gpu"]["active"], res["gpu"]["providers"]))

    # 10) --device 非法值应报明确错误（render 路径）
    r, res = run(["render", "--voicebank", vb, "--notes", json.dumps(notes[:1], ensure_ascii=False),
                  "--bpm", "120", "--vocoder", os.path.join(tmp, "vocoder.onnx"),
                  "--device", "vulkan", "--out", os.path.join(tmp, "bad_dev.wav")])
    assert res and not res["ok"] and "device" in res["error"], "非法 device 应报错: %s" % (res,)
    print("PASS invalid-device error:", res["error"])

    # 11) v2 五段式链路：构造带 dsdur/dspitch/dsvariance 的声库，验证全链路走通
    #     这是「帧数必须以 sum(ph_dur) 对齐」这一关键修复的回归测试。
    v2 = os.path.join(tmp, "V2VB")
    make_v2_voicebank(v2, tmp)
    v2_notes = [
        {"startBeat": 0, "durBeat": 1, "pitch": 60, "lyric": "wo"},
        {"startBeat": 1, "durBeat": 1, "pitch": 62, "lyric": "ni"},
        {"startBeat": 2, "durBeat": 1, "pitch": 64, "lyric": "a"},
    ]
    out_v2 = os.path.join(tmp, "out_v2.wav")
    r, res = run(["render", "--voicebank", v2, "--notes", json.dumps(v2_notes, ensure_ascii=False),
                  "--bpm", "120", "--device", "cpu", "--out", out_v2])
    assert res and res["ok"], "v2 五段式渲染失败: %s\nstderr=%s" % (res, (r.stderr or "")[-600:])
    assert res.get("pipeline") == "v2", "应走 v2 链路，实际: %s\nwarnings=%s" % (
        res.get("pipeline"), res.get("warnings"))
    assert os.path.exists(out_v2), "v2 wav 不存在"
    # 五段式各阶段不应出现广播/输入不匹配类失败
    bad = [w for w in (res.get("warnings") or [])
           if ("不匹配" in w) or ("Broadcast" in w) or ("broadcast" in w)]
    assert not bad, "v2 链路不应有阶段失败警告: %s" % bad
    print("PASS v2 pipeline: pipeline=%s dur=%dms warnings=%d" % (
        res.get("pipeline"), res["duration_ms"], len(res.get("warnings") or [])))

    # 12) v2 + 范围渲染组合
    out_v2r = os.path.join(tmp, "out_v2_range.wav")
    r, res = run(["render", "--voicebank", v2, "--notes", json.dumps(v2_notes, ensure_ascii=False),
                  "--bpm", "120", "--device", "cpu",
                  "--start-beat", "0", "--end-beat", "2", "--context-sec", "0.3",
                  "--out", out_v2r])
    assert res and res["ok"], "v2 范围渲染失败: %s" % res
    assert res.get("pipeline") == "v2" and res.get("range"), "v2 范围渲染应带 range 元信息: %s" % res
    print("PASS v2 + range: sel=%.2f~%.2fs pipeline=%s" % (
        res["range"]["startSec"], res["range"]["endSec"], res.get("pipeline")))

    # 13) inspect 应报告完整链路（pipeline.full）—— 阶段 key 曾是 dur/variance 误写
    r, res = run(["inspect", "--voicebank", v2])
    assert res and res["ok"], "v2 inspect 失败: %s" % res
    assert res.get("pipeline", {}).get("full") is True, \
        "v2 声库应识别为完整链路: %s" % res.get("pipeline")
    print("PASS v2 inspect: pipeline.full=%s stages=%s" % (
        res["pipeline"]["full"], sorted(res["pipeline"]["stages"].keys())))

    print("\nALL SMOKE TESTS PASSED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
