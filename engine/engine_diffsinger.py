# -*- coding: utf-8 -*-
"""
DiffSinger 歌声合成引擎（ONNX 推理）
================================================================
定位：FuFumidi 的**可选模块**。主进程在「启用 DiffSinger」并完成组件安装
（onnxruntime / pyyaml + 通用 NSF-HiFiGAN 声码器）后才会调用本脚本；
未启用 / 缺依赖时给出明确的分步指引，而不是晦涩的 import 报错。

链路：MIDI 音符（拍）→ 秒 → 歌词查字典成音素 → 音素时长分配 →
      帧级音高曲线（直线 + 颤音）→ acoustic ONNX（mel）→
      vocoder ONNX（波形）→ WAV 落盘。

「调教」语义：音高曲线完全由音符音高 + 用户参数（颤音深度/频率/渐入、
音分偏移）构造，不经 variance 模型改写 —— 用户画什么就是什么，
这正是一台歌声合成工作台应有的可预测性。

用法（CLI）：
    python engine_diffsinger.py deps --check
    python engine_diffsinger.py inspect --voicebank <声库目录>
    python engine_diffsinger.py render --voicebank <声库目录> \
        --notes '[{"startBeat":0,"durBeat":1,"pitch":60,"lyric":"啊"}]' \
        --bpm 120 --out out.wav [--vocoder <onnx 或目录>]

输出协议（与 music2midi.py / engine_utau.py 一致）：
    stdout 仅打印 `###RESULT {json}`；警告/提示走 stderr；
    进度用 `###PROG {json}`（percent 0-100）。
"""

import argparse
import json
import math
import os
import sys
import traceback

VERSION = "0.1.0"

# ---------------- 依赖名（与主进程 DS_PY_DEPS 对齐） ----------------
DEPS = {
    "onnxruntime": "ONNX 推理运行时（pip install onnxruntime）",
    "yaml": "YAML 解析（pip install pyyaml）",
    "numpy": "数值计算（引擎环境自带）",
}


def emit_result(obj):
    sys.stdout.write("###RESULT " + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_progress(percent, text=""):
    sys.stdout.write("###PROG " + json.dumps({"percent": int(percent), "text": text}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def warn(msg):
    sys.stderr.write("[diffsinger] " + str(msg) + "\n")
    sys.stderr.flush()


# ================================================================
# deps：依赖检测（--check）
# ================================================================
def cmd_deps(args):
    import importlib.util
    installed, missing = [], []
    for mod, _desc in DEPS.items():
        if importlib.util.find_spec(mod) is not None:
            installed.append(mod)
        else:
            missing.append(mod)
    emit_result({
        "ok": not missing,
        "installed": installed,
        "missing": missing,
        "engine_version": VERSION,
    })


# ================================================================
# 声库解析：dsconfig.yaml + 词典
# ================================================================
def read_yaml(path):
    import yaml
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


def load_voicebank(vb_dir):
    """解析声库：返回统一的 dict。抛 ValueError 时带用户可读信息。"""
    cfg_path = None
    for root, _dirs, files in os.walk(vb_dir):
        if "dsconfig.yaml" in files:
            cfg_path = os.path.join(root, "dsconfig.yaml")
            break
        # 深度限制（声库根最多两层子目录）
        if root.count(os.sep) - vb_dir.count(os.sep) >= 2:
            break
    if not cfg_path:
        raise ValueError("声库里没有 dsconfig.yaml（请确认是 DiffSinger / OpenUTAU 声库）")
    base = os.path.dirname(cfg_path)
    cfg = read_yaml(cfg_path) or {}

    def _model_path(spec):
        """字段可能是 'acoustic/model.onnx' 或 {model: ...} 或 None"""
        if not spec:
            return None
        if isinstance(spec, str):
            p = spec
        elif isinstance(spec, dict):
            p = spec.get("model") or spec.get("path") or spec.get("ckpt")
        else:
            return None
        if not p:
            return None
        p = str(p)
        # 相对路径：相对 dsconfig 所在目录；兼容写整个声库内相对路径
        cands = [os.path.join(base, p), os.path.join(vb_dir, p)]
        for c in cands:
            if os.path.exists(c):
                return c
        # 按文件名兜底搜索
        name = os.path.basename(p)
        for root, _d, fs in os.walk(vb_dir):
            if name in fs:
                return os.path.join(root, name)
        return None

    phonemes = []
    linguist = cfg.get("linguist") or {}
    if isinstance(linguist, dict):
        raw = linguist.get("phonemes") or cfg.get("phonemes") or []
    else:
        raw = cfg.get("phonemes") or []
    if isinstance(raw, list):
        phonemes = [str(p) for p in raw]
    elif isinstance(raw, dict):
        phonemes = [str(k) for k in raw.keys()]

    return {
        "dir": vb_dir,
        "base": base,
        "cfg": cfg,
        "name": str(cfg.get("name") or os.path.basename(vb_dir.rstrip("/\\"))),
        "version": str(cfg.get("version") or ""),
        "languages": cfg.get("languages") or [],
        "phonemes": phonemes,
        "acoustic": _model_path(cfg.get("acoustic")),
        "variance": _model_path(cfg.get("variance")),
        "vocoder": _model_path(cfg.get("vocoder")),
        "sample_rate": int(cfg.get("sample_rate") or cfg.get("sampling_rate") or 44100),
        "hop_size": int(cfg.get("hop_size") or cfg.get("frame_size") or 512),
    }


def load_dictionaries(vb):
    """收集声库内所有词典（*.dsdict / dsdict*.yaml / 词典 .txt）→ {word: [phonemes]}"""
    table = {}
    cands = []
    for root, _d, files in os.walk(vb["dir"]):
        for n in files:
            ln = n.lower()
            if ln.endswith(".dsdict") or ln.endswith(".txt") and ("dict" in ln or "dictionary" in ln):
                cands.append(os.path.join(root, n))
            elif ln.endswith((".yaml", ".yml")) and ("dict" in ln):
                cands.append(os.path.join(root, n))
        if root.count(os.sep) - vb["dir"].count(os.sep) >= 2:
            break
    for p in cands:
        try:
            if p.lower().endswith(".txt"):
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        parts = line.rstrip("\n").split("\t")
                        if len(parts) >= 2 and parts[0] and parts[1]:
                            table[parts[0]] = parts[1].split()
            else:
                data = read_yaml(p)
                _absorb_dsdict(data, table)
        except Exception as e:  # noqa: BLE001
            warn("词典 %s 解析失败：%s" % (os.path.basename(p), e))
    return table


def _absorb_dsdict(data, table):
    """dsdict.yaml 有两种形态：{lang: {word: phonemes}} 或 {lang: [{word, phoneme}]}"""
    if not isinstance(data, dict):
        return
    for _lang, seg in data.items():
        if isinstance(seg, dict):
            for k, v in seg.items():
                if isinstance(v, str):
                    table[str(k)] = v.split()
                elif isinstance(v, list):
                    table[str(k)] = [str(x) for x in v]
        elif isinstance(seg, list):
            for it in seg:
                if isinstance(it, dict):
                    w = it.get("word")
                    ph = it.get("phoneme") or it.get("phonemes")
                    if w and ph:
                        table[str(w)] = str(ph).split()


# ================================================================
# inspect：声库信息
# ================================================================
def cmd_inspect(args):
    try:
        vb = load_voicebank(args.voicebank)
    except ValueError as e:
        emit_result({"ok": False, "error": str(e)})
        return
    except Exception as e:  # noqa: BLE001
        emit_result({"ok": False, "error": "声库解析失败：" + str(e)})
        return
    dicts = load_dictionaries(vb)
    emit_result({
        "ok": True,
        "name": vb["name"],
        "version": vb["version"],
        "languages": vb["languages"],
        "phonemeCount": len(vb["phonemes"]),
        "phonemes": vb["phonemes"][:120],
        "hasAcoustic": bool(vb["acoustic"]),
        "hasVariance": bool(vb["variance"]),
        "vocoder": vb["vocoder"] or "",
        "builtinVocoder": bool(vb["vocoder"]),
        "dictionaryWords": len(dicts),
        "sampleRate": vb["sample_rate"],
        "engineVersion": VERSION,
    })


# ================================================================
# render：渲染主链路
# ================================================================

# 音高名 → 半音号（解析 --sample-note 用）
NOTE_NAMES = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def midi_to_hz(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def parse_note_name(name):
    """'C4' → 60；'A3' → 57。非法返回 None。"""
    try:
        s = str(name).strip()
        key = s[0].upper()
        rest = s[1:]
        acc = 0
        while rest and rest[0] in "#b":
            acc += 1 if rest[0] == "#" else -1
            rest = rest[1:]
        octave = int(rest)
        return 12 * (octave + 1) + NOTE_NAMES[key] + acc
    except Exception:  # noqa: BLE001
        return None


def lyrics_to_phonemes(notes, vb, dicts, phoneme_set):
    """每个音符的歌词 → 音素序列（list[str]）。返回 (per_note_phonemes, warnings)"""
    warnings_out = []
    per = []
    for n in notes:
        lyric = str(n.get("lyric") or "").strip()
        ph = None
        if lyric:
            # ① 词典整词命中
            if lyric in dicts:
                ph = list(dicts[lyric])
            # ② 歌词本身就是音素（拼音/罗马字单音素或多音素空格串）
            elif lyric in phoneme_set:
                ph = [lyric]
            elif " " in lyric and all(p in phoneme_set for p in lyric.split()):
                ph = lyric.split()
            else:
                # ③ 逐字符查词典（整词未命中但可能是多字歌词，取首字发音）
                for ch in lyric:
                    if ch in dicts:
                        ph = list(dicts[ch])
                        break
        if not ph:
            # 兜底：AP（气声起音），比无声更接近「啊」的演唱听感
            ph = ["AP"]
            if lyric:
                warnings_out.append("歌词「%s」不在声库词典/音素表中，已用 AP（气声）代替" % lyric)
            else:
                warnings_out.append("音符缺少歌词，已用 AP（气声）代替")
        per.append([p for p in ph if p])
    return per, warnings_out


VOWELS = set("aeiouAEIOU")


def split_ph_duration(phonemes, dur_sec):
    """音素时长分配：多音素时首个（辅音）占 1/4，其余均分 3/4；单音素占满。"""
    if not phonemes:
        return []
    if len(phonemes) == 1:
        return [dur_sec]
    # 首音素视作声母/辅音；AP/SP 特殊：AP 占 0.12s 固定起音，其余给主音素
    if phonemes[0] == "AP" and len(phonemes) == 2:
        ap = min(0.12, dur_sec * 0.25)
        return [ap, dur_sec - ap]
    head = dur_sec * 0.25
    rest = (dur_sec - head) / (len(phonemes) - 1)
    return [head] + [rest] * (len(phonemes) - 1)


def build_pitch_curve(frames, notes, hop_sec):
    """帧级音高（Hz）：音符区间直线 + 颤音（正弦，渐入）；间隙沿用前值。"""
    curve = [0.0] * frames
    events = []  # (t0, t1, hz, vibrato 参数)
    for n in notes:
        try:
            pitch = int(n.get("pitch", 60))
        except (TypeError, ValueError):
            pitch = 60
        hz = midi_to_hz(pitch + float(n.get("pitchOffset") or 0) / 100.0)
        events.append({
            "t0": float(n.get("startSec", 0.0)),
            "t1": float(n.get("startSec", 0.0)) + float(n.get("durSec", 0.25)),
            "hz": hz,
            "vib": bool(n.get("vibrato")),
            "depth": float(n.get("vibDepth", 25)),
            "freq": float(n.get("vibFreq", 5.5)),
            "fade": float(n.get("vibFade", 0)) / 1000.0,
        })
    last_hz = 220.0
    for i in range(frames):
        t = i * hop_sec
        hz = None
        for ev in events:
            if ev["t0"] <= t < ev["t1"]:
                hz = ev["hz"]
                if ev["vib"] and ev["depth"] > 0 and ev["freq"] > 0:
                    # 颤音：正弦 cents 摆动，fade 秒内线性渐入
                    age = t - ev["t0"]
                    k = 1.0 if ev["fade"] <= 0 else min(1.0, age / ev["fade"])
                    cents = ev["depth"] * k * math.sin(2 * math.pi * ev["freq"] * age)
                    hz *= 2.0 ** (cents / 1200.0)
                break
        if hz is None:
            hz = last_hz  # 间隙（SP/AP）沿用前一音高，避免 NSF 谐波激励跳变
        curve[i] = hz
        last_hz = hz
    return curve


def match_onnx_inputs(session):
    """按名字聚类模型输入（跨声库兼容）：返回 {类别: 输入名}"""
    mapping = {}
    for inp in session.get_inputs():
        name = inp.name.lower()
        if "phoneme" in name or name in ("ph", "phones", "tokens"):
            mapping.setdefault("phonemes", inp.name)
        elif "mid" in name:
            mapping.setdefault("mids", inp.name)
        elif "dur" in name:
            mapping.setdefault("dur", inp.name)
        elif "pitch" in name or name in ("f0",):
            mapping.setdefault("pitch", inp.name)
        elif "energy" in name or name.startswith("etils"):
            mapping.setdefault("energy", inp.name)
        elif "breath" in name:
            mapping.setdefault("breathiness", inp.name)
        elif "voiced" in name:
            mapping.setdefault("voiced", inp.name)
        elif "mel" in name:
            mapping.setdefault("mel", inp.name)
        else:
            mapping.setdefault("other", inp.name)
    return mapping


def run_acoustic(sess, phoneme_ids, ph_dur, ph_mids, pitch, mel_bins_hint, warnings_out):
    """acoustic ONNX：→ mel。按输入签名自适应拼 feed。"""
    import numpy as np
    mapping = match_onnx_inputs(sess)
    feed = {}
    if "phonemes" in mapping:
        feed[mapping["phonemes"]] = np.asarray([phoneme_ids], dtype=np.int64)
    if "dur" in mapping:
        feed[mapping["dur"]] = np.asarray([ph_dur], dtype=np.float32)
    if "mids" in mapping:
        feed[mapping["mids"]] = np.asarray([ph_mids], dtype=np.float32)
    if "pitch" in mapping:
        feed[mapping["pitch"]] = np.asarray([pitch], dtype=np.float32)
    frames = len(pitch)
    for cat in ("energy",):
        if cat in mapping:
            feed[mapping[cat]] = np.ones((1, frames), dtype=np.float32)
    for cat in ("breathiness",):
        if cat in mapping:
            feed[mapping[cat]] = np.zeros((1, frames), dtype=np.float32)
    for cat in ("voiced",):
        if cat in mapping:
            feed[mapping[cat]] = np.ones((1, frames), dtype=np.float32)
    outs = sess.run(None, feed)
    mel = outs[0]
    mel = np.asarray(mel, dtype=np.float32)
    # 归一化到 [1, n_mels, T] / [1, T, n_mels] 两种布局的统一：短边当 mel 维
    if mel.ndim == 3:
        if mel.shape[1] < mel.shape[2]:
            mel = mel  # [B, n_mels, T]
        else:
            mel = mel.transpose(0, 2, 1)  # [B, T, n_mels] → [B, n_mels, T]
    elif mel.ndim == 2:
        if mel.shape[0] < mel.shape[1]:
            mel = mel[None, :, :]
        else:
            mel = mel.T[None, :, :]
    else:
        raise ValueError("acoustic 输出维度异常：" + str(mel.shape))
    if mel_bins_hint and mel.shape[1] and abs(mel.shape[1] - mel_bins_hint) > 16:
        warnings_out.append("acoustic mel bins（%d）与声码器预期（%d）不一致，输出可能异常" % (mel.shape[1], mel_bins_hint))
    return mel


def run_vocoder(sess, mel, pitch, warnings_out):
    """vocoder ONNX（NSF-HiFiGAN 家族）：mel [+ f0] → 波形。返回 float32 mono。"""
    import numpy as np
    mapping = match_onnx_inputs(sess)
    frames = mel.shape[2]
    feed = {}
    if "mel" in mapping:
        feed[mapping["mel"]] = mel
    else:
        # 第一个输入当 mel
        feed[sess.get_inputs()[0].name] = mel
    if "pitch" in mapping:
        f0 = np.asarray(pitch, dtype=np.float32)
        if f0.ndim == 1:
            f0 = f0[None, :]
        feed[mapping["pitch"]] = f0
    outs = sess.run(None, feed)
    wav = np.asarray(outs[0], dtype=np.float32).squeeze()
    if wav.ndim != 1:
        wav = wav.reshape(-1)
    return wav


def write_wav(path, samples, sample_rate):
    """零依赖 WAV 写出：float32 [-1,1] → int16 PCM。"""
    import numpy as np
    x = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = (x * 32767.0).astype("<i2")
    data = pcm.tobytes()
    header = b"RIFF"
    header += (36 + len(data)).to_bytes(4, "little")
    header += b"WAVE"
    header += b"fmt "
    header += (16).to_bytes(4, "little")
    header += (1).to_bytes(2, "little")          # PCM
    header += (1).to_bytes(2, "little")          # mono
    header += sample_rate.to_bytes(4, "little")
    header += (sample_rate * 2).to_bytes(4, "little")  # byte rate
    header += (2).to_bytes(2, "little")          # block align
    header += (16).to_bytes(2, "little")         # bits
    header += b"data"
    header += len(data).to_bytes(4, "little")
    with open(path, "wb") as f:
        f.write(header)
        f.write(data)


def cmd_render(args):
    warnings_out = []
    try:
        import numpy as np  # noqa: F401  提前失败给清晰报错
    except ImportError:
        emit_result({"ok": False, "error": "缺少 numpy：引擎环境异常，请用「一键修复」检查 Python 环境"})
        return
    try:
        import onnxruntime as ort
    except ImportError:
        emit_result({"ok": False, "error": "缺少 onnxruntime：请先启用 DiffSinger 模块并安装组件（模块与声库 → 安装组件）"})
        return

    # ---- 1) 声库 ----
    try:
        vb = load_voicebank(args.voicebank)
    except ValueError as e:
        emit_result({"ok": False, "error": str(e)})
        return
    if not vb["acoustic"]:
        emit_result({"ok": False, "error": "声库里没有 acoustic 模型（dsconfig.yaml 的 acoustic 字段为空或文件缺失）"})
        return

    # ---- 2) 声码器：声库自带 > --vocoder 参数（通用组件位）----
    vocoder_path = vb["vocoder"]
    if not vocoder_path and args.vocoder:
        vp = str(args.vocoder)
        if os.path.isdir(vp):
            for n in sorted(os.listdir(vp)):
                if n.lower().endswith(".onnx"):
                    vocoder_path = os.path.join(vp, n)
                    break
        elif os.path.isfile(vp):
            vocoder_path = vp
    if not vocoder_path:
        emit_result({"ok": False, "error": "没有可用声码器：声库未自带且通用声码器未安装（模块与声库 → 安装组件）"})
        return

    # ---- 3) 音符（拍 → 秒）----
    try:
        notes = json.loads(args.notes)
    except Exception as e:  # noqa: BLE001
        emit_result({"ok": False, "error": "notes JSON 解析失败：" + str(e)})
        return
    if not isinstance(notes, list) or not notes:
        emit_result({"ok": False, "error": "没有音符可渲染"})
        return
    bpm = max(20.0, min(400.0, float(args.bpm or 120)))
    spb = 60.0 / bpm
    norm = []
    for n in notes:
        try:
            sb = float(n.get("startBeat", 0.0))
            db = float(n.get("durBeat", 1.0))
            pitch = int(n.get("pitch", 60))
        except (TypeError, ValueError):
            continue
        norm.append({
            "startSec": max(0.0, sb * spb),
            "durSec": max(0.05, db * spb),
            "pitch": max(0, min(127, pitch)),
            "lyric": str(n.get("lyric") or ""),
            "vibrato": bool(n.get("vibrato")),
            "vibDepth": float(n.get("vibDepth", 25)),
            "vibFreq": float(n.get("vibFreq", 5.5)),
            "vibFade": float(n.get("vibFade", 0)),
            "pitchOffset": float(n.get("pitchOffset") or 0),
        })
    if not norm:
        emit_result({"ok": False, "error": "没有有效音符"})
        return
    norm.sort(key=lambda x: x["startSec"])
    total_sec = max(n["startSec"] + n["durSec"] for n in norm) + 0.35

    emit_progress(8, "解析音素…")
    # ---- 4) 歌词 → 音素 ----
    phoneme_set = set(vb["phonemes"]) or {"AP", "SP"}
    dicts = load_dictionaries(vb)
    if not dicts:
        warnings_out.append("声库里没有词典（*.dsdict），只能使用音素级歌词")
    per_note, w2 = lyrics_to_phonemes(norm, vb, dicts, phoneme_set)
    warnings_out.extend(w2[:30])

    # ---- 5) 音素时间轴：音符间插 SP，音素内分配时长 ----
    SP_GAP = 0.06
    ph_seq, ph_dur = [], []
    prev_end = None
    for note, phs in zip(norm, per_note):
        if prev_end is not None and note["startSec"] - prev_end > SP_GAP + 1e-6:
            ph_seq.append("SP")
            ph_dur.append(note["startSec"] - prev_end)
        for p, d in zip(phs, split_ph_duration(phs, note["durSec"])):
            ph_seq.append(p)
            ph_dur.append(max(0.02, d))
        prev_end = note["startSec"] + note["durSec"]
    if not ph_seq:
        emit_result({"ok": False, "error": "音素序列为空"})
        return

    # 音素 → id（声库 phonemes 表；不在表里的用 AP 的 id 兜底并告警）
    ph_list = list(vb["phonemes"]) if vb["phonemes"] else sorted(phoneme_set)
    ph_index = {p: i for i, p in enumerate(ph_list)}
    ap_id = ph_index.get("AP", 0)
    phoneme_ids = []
    for p in ph_seq:
        if p in ph_index:
            phoneme_ids.append(ph_index[p])
        else:
            phoneme_ids.append(ap_id)
            if len(warnings_out) < 40:
                warnings_out.append("音素 %s 不在声库音素表中，已用 AP 代替" % p)

    # 累积时间轴
    starts = []
    acc = 0.0
    for d in ph_dur:
        starts.append(acc)
        acc += d
    ph_mids = [starts[i] + ph_dur[i] / 2.0 for i in range(len(ph_dur))]

    # ---- 6) 帧级音高 ----
    sr = vb["sample_rate"]
    hop = vb["hop_size"]
    hop_sec = hop / float(sr)
    frames = int(math.ceil(total_sec / hop_sec)) + 1
    pitch = build_pitch_curve(frames, norm, hop_sec)

    emit_progress(25, "加载 acoustic 模型…")
    so = ort.SessionOptions()
    so.log_severity_level = 3
    try:
        acoustic_sess = ort.InferenceSession(vb["acoustic"], sess_options=so, providers=["CPUExecutionProvider"])
    except Exception as e:  # noqa: BLE001
        emit_result({"ok": False, "error": "acoustic 模型加载失败：" + str(e)})
        return

    emit_progress(45, "acoustic 推理…")
    try:
        mel_bins_hint = 0
        # 从声码器输入形状推测 mel bins（NSF-HiFiGAN: mel [1, bins, T]）
        try:
            v_sess = ort.InferenceSession(vocoder_path, sess_options=so, providers=["CPUExecutionProvider"])
            for inp in v_sess.get_inputs():
                if "mel" in inp.name.lower() and len(inp.shape) >= 2:
                    dim = inp.shape[1]
                    if isinstance(dim, int) and dim > 0:
                        mel_bins_hint = dim
                        break
        except Exception:  # noqa: BLE001
            v_sess = None
        mel = run_acoustic(acoustic_sess, phoneme_ids, ph_dur, ph_mids, pitch, mel_bins_hint, warnings_out)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "onnxruntime" in msg and "shape" in msg.lower():
            msg += "（该声库的模型输入布局可能不受当前版本支持，请反馈声库名称）"
        emit_result({"ok": False, "error": "acoustic 推理失败：" + msg})
        return

    emit_progress(70, "声码器合成波形…")
    try:
        if v_sess is None:
            v_sess = ort.InferenceSession(vocoder_path, sess_options=so, providers=["CPUExecutionProvider"])
        # 帧数对齐：mel 帧数为准重采样 pitch（线性插值）
        import numpy as np
        mel_frames = mel.shape[2]
        if len(pitch) != mel_frames:
            xp = np.linspace(0.0, 1.0, num=len(pitch), endpoint=True)
            x = np.linspace(0.0, 1.0, num=mel_frames, endpoint=True)
            pitch = np.interp(x, xp, pitch).tolist()
        wav = run_vocoder(v_sess, mel, pitch, warnings_out)
    except Exception as e:  # noqa: BLE001
        emit_result({"ok": False, "error": "声码器合成失败：" + str(e)})
        return

    # ---- 7) 落盘 ----
    emit_progress(92, "写出 WAV…")
    try:
        out = os.path.abspath(args.out)
        os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
        # 尾部裁掉 0.3s 静音、头部去直流
        tail = int(sr * 0.30)
        if len(wav) > tail * 2:
            wav = wav[: len(wav) - tail]
        write_wav(out, wav, sr)
    except Exception as e:  # noqa: BLE001
        emit_result({"ok": False, "error": "WAV 写出失败：" + str(e)})
        return

    emit_progress(100, "完成")
    emit_result({
        "ok": True,
        "out": out,
        "duration_ms": int(len(wav) / sr * 1000),
        "warnings": warnings_out[:40],
        "engine_version": VERSION,
        "phoneme_count": len(ph_seq),
        "sample_rate": sr,
    })


# ================================================================
# CLI
# ================================================================
def main():
    parser = argparse.ArgumentParser(
        prog="engine_diffsinger.py",
        description="DiffSinger 歌声合成引擎（ONNX 推理，FuFumidi 可选模块）",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="cmd", required=True)

    d = sub.add_parser("deps", help="依赖检测")
    d.add_argument("--check", action="store_true", help="检测 onnxruntime / pyyaml / numpy")
    d.set_defaults(func=cmd_deps)

    i = sub.add_parser("inspect", help="查看声库信息")
    i.add_argument("--voicebank", required=True, help="声库目录（含 dsconfig.yaml）")
    i.set_defaults(func=cmd_inspect)

    r = sub.add_parser("render", help="渲染音符序列为 WAV")
    r.add_argument("--voicebank", required=True, help="声库目录（含 dsconfig.yaml）")
    r.add_argument("--notes", required=True, help='音符 JSON：[{"startBeat":0,"durBeat":1,"pitch":60,"lyric":"啊"}]')
    r.add_argument("--bpm", type=float, default=120.0, help="速度（BPM，拍→秒换算）")
    r.add_argument("--vocoder", default=None, help="声码器 onnx 或目录（声库未自带时使用）")
    r.add_argument("--out", required=True, help="输出 WAV 路径")
    r.set_defaults(func=cmd_render)

    args = parser.parse_args()
    try:
        args.func(args)
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        emit_result({"ok": False, "error": "引擎异常：" + traceback.format_exc(limit=3)})


if __name__ == "__main__":
    main()
