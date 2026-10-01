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

「范围渲染」：只渲染音符序列中的一段（试听 / 局部返工）。为避免切片接缝处
音质劣化，默认在选区前后各多取 context-sec 秒的相邻音符作为上下文一起推理，
再把波形精确裁回选区 —— 选区外的音符只贡献上下文，不进输出。

「GPU 加速」：复用主进程的 GPU 增强包体系（main/gpu.js 安装的 site-packages
经 PYTHONPATH 注入）。通过 engine_gpu.onnx_provider() 自动选择
CUDAExecutionProvider / DmlExecutionProvider / CPUExecutionProvider；
未装增强包时主进程会置 FUFUMIDI_DISABLE_GPU=1，本脚本随即退回 CPU。

「调教」语义：音高曲线完全由音符音高 + 用户参数（颤音深度/频率/渐入、
音分偏移）构造，不经 variance 模型改写 —— 用户画什么就是什么，
这正是一台歌声合成工作台应有的可预测性。

用法（CLI）：
    python engine_diffsinger.py deps --check
    python engine_diffsinger.py inspect --voicebank <声库目录>
    python engine_diffsinger.py render --voicebank <声库目录> \
        --notes '[{"startBeat":0,"durBeat":1,"pitch":60,"lyric":"啊"}]' \
        --bpm 120 --out out.wav [--vocoder <onnx 或目录>] \
        [--start-beat 4 --end-beat 8] [--context-sec 0.5] \
        [--device auto|cpu|cuda|dml]

    # --notes 也可写成 @<json 文件路径>（整曲音符量大时推荐，规避 Windows 命令行上限）：
    python engine_diffsinger.py render --voicebank <声库目录> \
        --notes @notes.json --bpm 120 --out out.wav

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

VERSION = "0.2.0"

# ---------------- GPU / 推理后端 ----------------
# 与 engine_gpu.py 的 onnx_provider() 对齐；engine_gpu 不可用时退回本地探测。
_PROVIDER_ALIASES = {
    "cuda": "CUDAExecutionProvider",
    "dml": "DmlExecutionProvider",
    "directml": "DmlExecutionProvider",
    "cpu": "CPUExecutionProvider",
}
# 每个 provider 的尝试顺序（TensorRT 只在显式要求 CUDA 时挂上，避免首次运行编译耗时）
_PROVIDER_FALLBACK = {
    "CUDAExecutionProvider": ["CUDAExecutionProvider", "CPUExecutionProvider"],
    "DmlExecutionProvider": ["DmlExecutionProvider", "CPUExecutionProvider"],
    "CPUExecutionProvider": ["CPUExecutionProvider"],
}
# 对 CPU 友好的会话选项：GPU 下也可用，线程数交给 ORT 自适应
_CPU_BF16_NOTE = ""


def resolve_providers(device):
    """返回 (providers, 说明)。device: auto/cpu/cuda/dml。"""
    import onnxruntime as ort
    avail = list(ort.get_available_providers())

    want = None
    if device and device != "auto":
        want = _PROVIDER_ALIASES.get(str(device).lower())
        if want is None:
            return None, "未知的 --device 取值：%s（可用 auto / cpu / cuda / dml）" % device
    else:
        # auto：先问 engine_gpu（它已处理 FUFUMIDI_DISABLE_GPU 与厂商识别）
        try:
            sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
            from engine_gpu import onnx_provider  # type: ignore
            want = onnx_provider()
        except Exception:
            want = None
        if not want or want not in avail:
            # engine_gpu 不可用或推断的 provider 实际不可用 → 按优先级自选
            for cand in ("CUDAExecutionProvider", "DmlExecutionProvider", "CPUExecutionProvider"):
                if cand in avail:
                    want = cand
                    break
    if want not in avail:
        note = "请求的 %s 在当前 onnxruntime 中不可用（可用：%s），已改用 CPU" % (want, ", ".join(avail))
        want = "CPUExecutionProvider"
        return _PROVIDER_FALLBACK[want], note
    return _PROVIDER_FALLBACK.get(want, [want, "CPUExecutionProvider"]), ""


def make_session(model_path, providers):
    """按 provider 列表创建会话；CUDA 失败时自动退回 CPU 并返回 (session, warning)。"""
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.log_severity_level = 3
    if providers and providers[0] != "CPUExecutionProvider":
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    try:
        return ort.InferenceSession(model_path, sess_options=so, providers=providers), ""
    except Exception as e:  # noqa: BLE001
        if providers and providers[0] == "CPUExecutionProvider":
            raise
        w = "GPU 后端（%s）加载失败，已退回 CPU：%s" % (providers[0], str(e)[:160])
        sess = ort.InferenceSession(model_path, sess_options=so, providers=["CPUExecutionProvider"])
        return sess, w

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

    # GPU 能力：不依赖 engine_gpu 也必须能报出 provider 列表
    gpu = {
        "device": "cpu",
        "providers": [],
        "active": None,
        "onnxruntime": "",
        "disabled": os.environ.get("FUFUMIDI_DISABLE_GPU") == "1",
        "note": "",
    }
    if "onnxruntime" in installed:
        try:
            import onnxruntime as ort
            gpu["onnxruntime"] = getattr(ort, "__version__", "")
            gpu["providers"] = list(ort.get_available_providers())
            prov, note = resolve_providers(getattr(args, "device", "auto") or "auto")
            if prov:
                gpu["active"] = prov[0]
                gpu["device"] = {"CUDAExecutionProvider": "cuda", "DmlExecutionProvider": "dml"}.get(prov[0], "cpu")
            gpu["note"] = note or ""
        except Exception as e:  # noqa: BLE001
            gpu["note"] = "onnxruntime 探测失败：" + str(e)[:160]

    emit_result({
        "ok": not missing,
        "installed": installed,
        "missing": missing,
        "engine_version": VERSION,
        "gpu": gpu,
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

    # ---- 音素表：两种形态 ----
    # ① 旧式：dsconfig 里直接列音素（list 或 {name: id}）
    # ② DiffSinger v2：phonemes 指向 phonemes.json（{name: id}），名字带语言前缀 "zh/a"
    phoneme_ids = {}          # name -> id（有 json 时用真实 id）
    phonemes = []
    if isinstance(raw, str):
        p = _model_path({"model": raw}) or _find_by_name(vb_dir, raw)
        if p and p.lower().endswith(".json"):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    phoneme_ids = {str(k): int(v) for k, v in data.items()}
                elif isinstance(data, list):
                    phoneme_ids = {str(k): i for i, k in enumerate(data)}
                phonemes = list(phoneme_ids.keys())
            except Exception as e:  # noqa: BLE001
                warn("phonemes.json 解析失败：%s" % e)
    elif isinstance(raw, list):
        phonemes = [str(p) for p in raw]
    elif isinstance(raw, dict):
        phonemes = [str(k) for k in raw.keys()]
        try:
            phoneme_ids = {str(k): int(v) for k, v in raw.items()}
        except (TypeError, ValueError):
            phoneme_ids = {}

    # 语言表：languages 指向 languages.json（{lang: id}）
    languages = {}
    lraw = cfg.get("languages")
    if isinstance(lraw, str):
        lp = _find_by_name(vb_dir, lraw)
        if lp:
            try:
                with open(lp, "r", encoding="utf-8") as f:
                    d = json.load(f)
                if isinstance(d, dict):
                    languages = {str(k): int(v) for k, v in d.items()}
            except Exception as e:  # noqa: BLE001
                warn("languages.json 解析失败：%s" % e)
    elif isinstance(lraw, dict):
        languages = {str(k): int(v) for k, v in lraw.items()}
    elif isinstance(lraw, list):
        languages = {str(k): i + 1 for i, k in enumerate(lraw)}

    # 语言前缀（"zh/a" → "zh"）：用于歌词按语言优先匹配
    lang_prefixes = sorted({p.split("/")[0] for p in phonemes if "/" in p})
    multi_lang = len(lang_prefixes) > 1

    # mel 规格健全性校验（参考 OpenUTAU 对 dsconfig 的校验）：
    # 这些字段必须与声码器匹配，错值不会立刻报错，但会解出噪音/全静音，早发现早提醒。
    _nmb = int(cfg.get("num_mel_bins") or 128)
    if _nmb < 1 or _nmb > 512:
        warn("声学模型 num_mel_bins=%d 异常（应在 1..512），声码器解码很可能出错" % _nmb)
    _mb = str(cfg.get("mel_base") or "10")
    if _mb not in ("10", "e"):
        warn("mel_base=%s 异常（应为 10 或 e）" % _mb)
    _ms = str(cfg.get("mel_scale") or "slaney")
    if _ms not in ("slaney", "htk"):
        warn("mel_scale=%s 异常（应为 slaney 或 htk）" % _ms)

    return {
        "dir": vb_dir,
        "base": base,
        "cfg": cfg,
        "name": str(cfg.get("name") or _character_name(base) or os.path.basename(vb_dir.rstrip("/\\"))),
        "version": str(cfg.get("version") or ""),
        "character": _character_info(base),
        "languages": languages,
        "langPrefixes": lang_prefixes,
        "multiLang": multi_lang,
        "phonemes": phonemes,
        "phonemeIds": phoneme_ids,
        "phonemeSet": set(phonemes),
        "acoustic": _model_path(cfg.get("acoustic")),
        "variance": _model_path(cfg.get("variance")),
        "vocoder": _model_path(cfg.get("vocoder")),
        "speakers": cfg.get("speakers") or [],
        "sample_rate": int(cfg.get("sample_rate") or cfg.get("sampling_rate") or 44100),
        "hop_size": int(cfg.get("hop_size") or cfg.get("frame_size") or 512),
        "num_mel_bins": int(cfg.get("num_mel_bins") or 128),
        "mel_fmin": float(cfg.get("mel_fmin") or 40),
        "mel_fmax": float(cfg.get("mel_fmax") or 16000),
        "mel_base": str(cfg.get("mel_base") or "10"),
        "mel_scale": str(cfg.get("mel_scale") or "slaney"),
        # v2 五段式子模型目录（OpenUTAU 约定：声库根下的 dsdur / dspitch / dsvariance / dsvocoder）
        "stages": _load_stages(base, cfg),
    }


def _find_by_name(root, name):
    """在声库树里按文件名查找（限定深度，避免误命中）"""
    if not name:
        return None
    name = str(name)
    for cand in (os.path.join(root, name), os.path.join(os.path.dirname(root), name)):
        if os.path.exists(cand):
            return cand
    target = os.path.basename(name)
    for r, _d, files in os.walk(root):
        if target in files:
            return os.path.join(r, target)
        if r.count(os.sep) - root.count(os.sep) >= 2:
            break
    return None


def _character_name(base):
    """OpenUTAU character.txt 的 name= 字段"""
    p = os.path.join(base, "character.txt")
    if not os.path.exists(p):
        return ""
    try:
        with open(p, "r", encoding="utf-8") as f:
            for line in f:
                if line.strip().lower().startswith("name="):
                    return line.split("=", 1)[1].strip()
    except Exception:  # noqa: BLE001
        pass
    return ""


def _character_info(base):
    """character.txt / character.yaml → 展示信息（作者、版本、头像）"""
    info = {"author": "", "version": "", "voice": "", "web": "", "portrait": "", "defaultPhonemizer": ""}
    txt = os.path.join(base, "character.txt")
    if os.path.exists(txt):
        try:
            with open(txt, "r", encoding="utf-8") as f:
                for line in f:
                    if "=" in line:
                        k, v = line.split("=", 1)
                        k, v = k.strip().lower(), v.strip()
                        if k == "author":
                            info["author"] = v
                        elif k == "version":
                            info["version"] = v
                        elif k == "voice":
                            info["voice"] = v
                        elif k == "web":
                            info["web"] = v
                        elif k == "image":
                            info["portrait"] = v
        except Exception:  # noqa: BLE001
            pass
    yml = os.path.join(base, "character.yaml")
    if os.path.exists(yml):
        try:
            d = read_yaml(yml) or {}
            if isinstance(d, dict):
                if d.get("portrait"):
                    info["portrait"] = info["portrait"] or str(d["portrait"])
                if d.get("default_phonemizer"):
                    info["defaultPhonemizer"] = str(d["default_phonemizer"])
        except Exception:  # noqa: BLE001
            pass
    return info


# 五段式子模型：目录名 → (友好名, 负责阶段)
_STAGE_DIRS = [
    ("dsdur", "duration", "时长预测（音素→时长）"),
    ("dspitch", "pitch", "音高预测（音素→F0）"),
    ("dsvariance", "variance", "方差预测（气声/发声度）"),
    ("dsvocoder", "vocoder", "声码器（mel→波形）"),
]


def _load_stages(base, cfg):
    """解析 DiffSinger v2 声库的子模型目录，返回 {stage: {...}}。

    每个子目录有自己的 dsconfig.yaml，声明该阶段的 onnx 与词典。
    经典 DiffSinger 声库（只有 acoustic + vocoder）返回 {}，走简化链路。
    """
    stages = {}
    for dirname, stage, desc in _STAGE_DIRS:
        d = os.path.join(base, dirname)
        if not os.path.isdir(d):
            continue
        scfg_path = os.path.join(d, "dsconfig.yaml")
        scfg = {}
        if os.path.exists(scfg_path):
            try:
                scfg = read_yaml(scfg_path) or {}
            except Exception as e:  # noqa: BLE001
                warn("子模型 %s 配置解析失败：%s" % (dirname, e))
        entry = {"dir": d, "desc": desc, "config": scfg, "models": {}, "phonemes": {}, "phonemesOrder": []}

        # 该阶段的 onnx：配置里显式声明的 + 目录内扫到的
        declared = {}
        for key in ("linguistic", "dur", "pitch", "variance", "vocoder", "acoustic", "energy", "breathiness", "voicing", "tension"):
            v = _model_path_in(d, scfg.get(key), base)
            if v:
                declared[key] = v
        if not declared:
            for n in sorted(os.listdir(d)):
                if n.lower().endswith(".onnx"):
                    low = n.lower()
                    if "linguistic" in low:
                        declared.setdefault("linguistic", os.path.join(d, n))
                    elif ".dur." in low or low.startswith("dur"):
                        declared.setdefault("dur", os.path.join(d, n))
                    elif "pitch" in low:
                        declared.setdefault("pitch", os.path.join(d, n))
                    elif "variance" in low or ".var" in low:
                        declared.setdefault("variance", os.path.join(d, n))
                    elif "hifigan" in low or "vocoder" in low:
                        declared.setdefault("vocoder", os.path.join(d, n))
                    else:
                        declared.setdefault("model", os.path.join(d, n))
        entry["models"] = declared

        # 该阶段的 phonemes.json（有自己的音素表与 id）
        pj = _find_by_name(d, scfg.get("phonemes") or "")
        if pj and pj.lower().endswith(".json"):
            try:
                with open(pj, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict):
                    entry["phonemes"] = {str(k): int(v) for k, v in data.items()}
                elif isinstance(data, list):
                    entry["phonemes"] = {str(k): i for i, k in enumerate(data)}
                entry["phonemesOrder"] = list(entry["phonemes"].keys())
            except Exception as e:  # noqa: BLE001
                warn("子模型 %s 音素表解析失败：%s" % (dirname, e))

        # 该阶段的词典：**惰性加载**（v2 声库每个子目录都带 13MB 词典，
        # 在这里 eager 解析会拖慢 inspect/渲染启动，真正需要时再读）
        entry["dictionaries"] = {}
        stages[stage] = entry
    return stages


def _model_path_in(stage_dir, spec, vb_root=None):
    """子模型配置里的模型路径解析（相对子目录，也允许相对声库根）"""
    if not spec:
        return None
    if isinstance(spec, dict):
        spec = spec.get("model") or spec.get("path") or spec.get("ckpt")
    if not spec:
        return None
    spec = str(spec)
    cands = [os.path.join(stage_dir, spec)]
    if vb_root:
        cands.append(os.path.join(vb_root, spec))
    for c in cands:
        if os.path.exists(c):
            return c
    name = os.path.basename(spec)
    try:
        for n in os.listdir(stage_dir):
            if n == name:
                return os.path.join(stage_dir, n)
    except Exception:  # noqa: BLE001
        pass
    return None


def load_dictionaries(vb, cache=None):
    """收集声库内所有词典 → {word: [phonemes]}（按语言前缀归一）

    v2 声库在 dsdur/dspitch/dsvariance 下各带一份相同词典，这里只取第一份
    非空的即可（内容一致，重复加载纯属浪费）。cache 用于一次渲染内复用。
    """
    if cache is not None and cache.get("table") is not None:
        return cache["table"]
    table = {}
    # 顶层词典（经典声库，以及 v2 的主词典）
    table.update(_load_dictionaries_in(vb["base"]))
    # 子模型目录的词典（仅当顶层没有时作为补充）
    if not table:
        for st in (vb.get("stages") or {}).values():
            sub = st.get("dictionaries") or {}
            if sub:
                table.update(sub)
                break
    if cache is not None:
        cache["table"] = table
    return table


def _load_dictionaries_in(d):
    """从一个目录加载词典。

    支持两类：
      ① DiffSinger v2 的 dictionary-<lang>.txt（word<TAB>phoneme1 phoneme2）
      ② OpenUTAU 经典 *.dsdict / dsdict-*.yaml（yaml，{lang: {word: phonemes}}）

    v2 的音素名**不带**语言前缀，而 phonemes.json 里带（"zh/a"），
    因此这里把语言前缀补回去，确保查表结果能对上 tokens。

    性能：v2 声库每个子目录都带一份 13MB 的 dsdict-en.yaml，用 yaml 解析
    会卡死（且与 dictionary-en.txt 内容重复）。因此同一目录里**只要有
    dictionary-*.txt，就跳过体积超限的 yaml 词典**。
    """
    table = {}
    try:
        names = sorted(os.listdir(d))
    except Exception:  # noqa: BLE001
        return table
    has_txt_dict = any(n.lower().startswith("dictionary-") and n.lower().endswith(".txt") for n in names)
    YAML_MAX = 4 * 1024 * 1024   # 超过 4MB 的 yaml 词典跳过（.txt 版本已覆盖）
    for n in names:
        p = os.path.join(d, n)
        if not os.path.isfile(p):
            continue
        ln = n.lower()
        try:
            if ln.startswith("dictionary-") and ln.endswith(".txt"):
                lang = n[len("dictionary-"):-len(".txt")]
                with open(p, "r", encoding="utf-8") as f:
                    for line in f:
                        line = line.rstrip("\n")
                        if not line or line.startswith("#"):
                            continue
                        parts = line.split("\t")
                        if len(parts) >= 2 and parts[0] and parts[1]:
                            table[parts[0]] = _prefix_phonemes(parts[1].split(), lang)
            elif ln.endswith(".dsdict") or (ln.endswith((".yaml", ".yml")) and "dict" in ln):
                if has_txt_dict and os.path.getsize(p) > YAML_MAX:
                    warn("跳过冗余大词典 %s（%.1fMB，已有 dictionary-*.txt 覆盖）" % (n, os.path.getsize(p) / 1048576.0))
                    continue
                if os.path.getsize(p) > YAML_MAX and not has_txt_dict:
                    warn("词典 %s 过大（%.1fMB），已跳过以避免解析卡死" % (n, os.path.getsize(p) / 1048576.0))
                    continue
                data = read_yaml(p)
                _absorb_dsdict(data, table)
        except Exception as e:  # noqa: BLE001
            warn("词典 %s 解析失败：%s" % (n, e))
    return table


def _prefix_phonemes(phs, lang):
    """给无前缀音素补语言前缀（AP / SP / br / vf 等特殊音素保持原样）"""
    out = []
    for p in phs:
        if "/" in p or p in SPECIAL_PHONEMES:
            out.append(p)
        else:
            out.append(lang + "/" + p)
    return out


SPECIAL_PHONEMES = {"AP", "SP", "br", "vf", "sil", "pau"}


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
    stages = vb.get("stages") or {}
    emit_result({
        "ok": True,
        "name": vb["name"],
        "version": vb["version"],
        "character": vb.get("character") or {},
        "languages": vb["languages"],
        "langPrefixes": vb.get("langPrefixes") or [],
        "multiLang": bool(vb.get("multiLang")),
        "phonemeCount": len(vb["phonemes"]),
        "phonemes": vb["phonemes"][:120],
        "hasAcoustic": bool(vb["acoustic"]),
        "hasVariance": bool(vb["variance"]),
        "vocoder": vb["vocoder"] or "",
        "builtinVocoder": bool(vb["vocoder"]),
        "dictionaryWords": len(dicts),
        "sampleRate": vb["sample_rate"],
        "hopSize": vb["hop_size"],
        "numMelBins": vb.get("num_mel_bins"),
        # v2 五段式子模型清单（前端用来展示「完整链路 / 简化链路」）
        # 注：阶段 key 用的是 duration/pitch/variance（见 _STAGE_DIRS），不是模型类别名。
        "pipeline": {
            "full": bool(stages.get("duration") and stages.get("variance")),
            "stages": {
                k: {
                    "desc": (v.get("desc") or ""),
                    "models": {mk: os.path.basename(mp) for mk, mp in (v.get("models") or {}).items()},
                    "phonemes": len(v.get("phonemes") or {}),
                }
                for k, v in stages.items()
            },
        },
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
                # ③ 汉字 → 拼音（DiffSinger v2 的中文词典以拼音为键，
                #    OpenUTAU 由 DiffSingerChinesePhonemizer 完成这一步）
                py = hanzi_to_pinyin(lyric, dicts)
                if py:
                    ph = py
                else:
                    # ④ 逐字符查词典（整词未命中但可能是多字歌词，取首字发音）
                    for ch in lyric:
                        if ch in dicts:
                            ph = list(dicts[ch])
                            break
                        py1 = hanzi_to_pinyin(ch, dicts)
                        if py1:
                            ph = py1
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


# 拼音声母/韵母与 DiffSinger 音素名的差异（整体认读、ü 的写法等）
_PINYIN_FIX = {
    "v": "v", "ü": "v", "yu": "v", "ve": "ve",
    "iu": "iu", "ui": "ui",
}
_PINYIN_CACHE = {}


def _pypinyin_module():
    """惰性加载 pypinyin（未安装时返回 None，功能降级但不崩）"""
    if "m" in _PINYIN_CACHE:
        return _PINYIN_CACHE["m"]
    try:
        import pypinyin  # noqa: F401
        _PINYIN_CACHE["m"] = pypinyin
    except Exception:  # noqa: BLE001
        _PINYIN_CACHE["m"] = None
    return _PINYIN_CACHE["m"]


def hanzi_to_pinyin(text, dicts=None):
    """汉字 → 音素序列。

    用 pypinyin 逐字转无声调拼音，再查声库词典拿到音素。
    返回 list[音素] 或 None（无汉字 / 无拼音库 / 查不到）。
    """
    if not text:
        return None
    chars = [c for c in text if "\u4e00" <= c <= "\u9fff"]
    if not chars:
        return None
    if dicts is None:
        dicts = {}
    pp = _pypinyin_module()
    if pp is None:
        return None
    out = []
    for c in chars:
        try:
            py = pp.pinyin(c, style=pp.Style.NORMAL, errors="ignore")
        except Exception:  # noqa: BLE001
            return None
        if not py or not py[0]:
            continue
        syl = str(py[0][0]).lower()
        syl = _PINYIN_FIX.get(syl, syl)
        # 词典命中（优先整音节，再退回声母+韵母拆解）
        if syl in dicts:
            out.extend(dicts[syl])
            continue
        # 拆声母韵母（如 "zhang" → "zh" + "ang"）
        got = None
        split = _split_pinyin(syl)
        if split:
            a, b = split
            pa = dicts.get(a)
            pb = dicts.get(b) if b else None
            if pa and (pb or not b):
                got = list(pa) + (list(pb) if pb else [])
        if got:
            out.extend(got)
        else:
            # 最后兜底：把拼音原样当音素（部分声库确实直接吃拼音）
            out.append(syl)
    return out or None


_PINYIN_INITIALS = [
    "zh", "ch", "sh", "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h",
    "j", "q", "x", "r", "z", "c", "s", "y", "w",
]


def _split_pinyin(syl):
    """'zhang' → ('zh','ang')；'a' → ('a', None)；失败返回 None"""
    for ini in _PINYIN_INITIALS:
        if syl.startswith(ini) and len(syl) > len(ini):
            return ini, syl[len(ini):]
    if syl and syl[0] in "aeiou":
        return syl, None
    return None


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


def _curve_cents_at(curve_pts, t):
    """在按 beat 升序的 [(sec, cents)] 控制点上做线性插值，取 t 秒处的音分偏移。
    区间之外偏移为 0 —— 这是「偏移曲线」语义：只影响用户实际画过的区段，
    未画区域不附加偏移（与 OpenUTAU 表达式曲线的默认零值一致）。"""
    if not curve_pts:
        return 0.0
    if t < curve_pts[0][0] or t > curve_pts[-1][0]:
        return 0.0
    if t == curve_pts[0][0]:
        return curve_pts[0][1]
    if t == curve_pts[-1][0]:
        return curve_pts[-1][1]
    lo, hi = 0, len(curve_pts) - 1
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if curve_pts[mid][0] <= t:
            lo = mid
        else:
            hi = mid
    t0, c0 = curve_pts[lo]
    t1, c1 = curve_pts[hi]
    if t1 <= t0:
        return c1
    k = (t - t0) / (t1 - t0)
    return c0 + (c1 - c0) * k


def build_pitch_curve(frames, notes, hop_sec, curve_pts=None):
    """帧级音高（Hz）：音符区间直线 + 颤音（正弦，渐入）+ 可选自由音高曲线（音分偏移）；间隙沿用前值。"""
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
        if curve_pts:
            # 自由音高曲线最后叠加（最细粒度控制，参考 OpenUTAU 的 pitch 工具车道）
            hz *= 2.0 ** (_curve_cents_at(curve_pts, t) / 1200.0)
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
    # 布局归一化到 [B, n_mels, T]。
    # 优先用声码器声明的 mel bins 判定（可靠）；声码器不可用或没声明时，
    # 才退回「短边当 mel 维」的启发式 —— 该启发式在**很短的选区**上会判反
    # （T < n_mels 时把 [1,128,T] 误判成 [1,T,128]），所以只作兜底。
    if mel.ndim == 3:
        if mel_bins_hint:
            if mel.shape[2] == mel_bins_hint and mel.shape[1] != mel_bins_hint:
                mel = mel.transpose(0, 2, 1)  # [B, T, n_mels] → [B, n_mels, T]
            elif mel.shape[1] != mel_bins_hint and mel.shape[2] != mel_bins_hint:
                warnings_out.append("acoustic 输出的 mel 维（%d/%d）与声码器预期（%d）都不符，布局可能判错"
                                    % (mel.shape[1], mel.shape[2], mel_bins_hint))
        elif mel.shape[1] > mel.shape[2]:
            mel = mel.transpose(0, 2, 1)  # 无参考时：短边当 mel 维（[B, T, n_mels] → [B, n_mels, T]）
    elif mel.ndim == 2:
        if mel_bins_hint:
            if mel.shape[0] == mel_bins_hint:
                mel = mel[None, :, :]
            elif mel.shape[1] == mel_bins_hint:
                mel = mel.T[None, :, :]
            else:
                mel = mel[None, :, :]
        elif mel.shape[0] < mel.shape[1]:
            mel = mel[None, :, :]
        else:
            mel = mel.T[None, :, :]
    else:
        raise ValueError("acoustic 输出维度异常：" + str(mel.shape))
    if mel_bins_hint and mel.shape[1] and abs(mel.shape[1] - mel_bins_hint) > 16:
        warnings_out.append("acoustic mel bins（%d）与声码器预期（%d）不一致，输出可能异常" % (mel.shape[1], mel_bins_hint))
    return mel


def run_vocoder(sess, mel, pitch, warnings_out):
    """vocoder ONNX（NSF-HiFiGAN 家族）：mel [+ f0] → 波形。返回 float32 mono。

    声码器的 mel 布局有两种：
      - 经典 NSF-HiFiGAN：`[1, n_mels, T]`（mel 维在 index 1）
      - 部分社区模型（如 kouon_mini）：`[1, T, n_mels]`（mel 维在 index 2）
    这里按模型声明的输入形状自适应转置，避免硬编码。
    """
    import numpy as np
    mapping = match_onnx_inputs(sess)
    mel_in = None
    if "mel" in mapping:
        mel_in = _find_input(sess, mapping["mel"])
    else:
        mel_in = sess.get_inputs()[0]
    mel = np.asarray(mel, dtype=np.float32)
    if mel.ndim == 2:
        mel = mel[None, :, :]
    # 归一化到 [1, n_mels, T]（内部统一约定）
    hint = 0
    for inp in sess.get_inputs():
        if "mel" in inp.name.lower() and len(inp.shape) == 3:
            for d in inp.shape[1:]:
                if isinstance(d, int) and d > 16:
                    hint = d
                    break
            break
    if mel.shape[1] != hint and mel.shape[2] == hint:
        mel = mel.transpose(0, 2, 1)
    elif hint and mel.shape[1] != hint and mel.shape[2] != hint:
        warnings_out.append("mel 维度（%d/%d）与声码器预期（%d）不符，布局可能判错"
                            % (mel.shape[1], mel.shape[2], hint))
    frames = mel.shape[2]
    # 按声明形状决定是否要转回 T-last：
    # 声明形如 [1, 'n_frames', 128] → 最后一维是固定 mel bins（int）且中间维是变量名 → T-last
    # 声明形如 [1, 128, 'n_frames'] → 中间维是固定 mel bins → mels-first（默认）
    want_tlast = False
    if mel_in is not None and len(mel_in.shape) == 3:
        d1, d2 = mel_in.shape[1], mel_in.shape[2]
        fixed_last = isinstance(d2, int) and d2 > 16
        var_mid = not isinstance(d1, int)
        if fixed_last and var_mid:
            want_tlast = True
    feed_mel = mel.transpose(0, 2, 1) if want_tlast else mel
    feed = {}
    if "mel" in mapping:
        feed[mapping["mel"]] = feed_mel
    else:
        feed[sess.get_inputs()[0].name] = feed_mel
    if "pitch" in mapping:
        f0 = np.asarray(pitch, dtype=np.float32)
        if f0.ndim == 1:
            f0 = f0[None, :]
        if f0.shape[1] != frames:
            f0 = _resample_1d(f0.reshape(-1), frames)[None, :].astype(np.float32)
        feed[mapping["pitch"]] = f0
    outs = sess.run(None, feed)
    wav = np.asarray(outs[0], dtype=np.float32).squeeze()
    if wav.ndim != 1:
        wav = wav.reshape(-1)
    return wav


def _find_input(sess, name):
    for inp in sess.get_inputs():
        if inp.name == name:
            return inp
    return None


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


def select_render_range(notes, start_sec, end_sec, context_sec):
    """从音符序列里挑出「选区 + 前后文」参与推理的音符。

    返回 (render_notes, cut_start, cut_end, info)：
      - render_notes：实际送进推理链的音符（时间轴**整体平移到 0**，因为引擎不做绝对定位）
      - cut_start / cut_end：推理完成后，波形上要保留的区间（秒，相对 render_notes 的新时间轴）
      - info：给前端展示的范围元信息

    约定：选区起点取 `>= start_sec` 的第一个音符起点，选区终点取 `<= end_sec` 的最后一个音符尾。
    没有任何音符落在选区内时返回 (None, ...)，由调用方报错。
    """
    if not notes:
        return None, 0.0, 0.0, {}

    notes = sorted(notes, key=lambda n: n["startSec"])
    if start_sec is None:
        start_sec = notes[0]["startSec"]
    if end_sec is None:
        end_sec = max(n["startSec"] + n["durSec"] for n in notes)
    if end_sec <= start_sec:
        return None, 0.0, 0.0, {}

    # 选区命中的音符：凡与 [start_sec, end_sec) 有交集的音符都算
    hit = [n for n in notes if n["startSec"] < end_sec and (n["startSec"] + n["durSec"]) > start_sec]
    if not hit:
        return None, 0.0, 0.0, {}

    # 对齐到音符边界：选区实际覆盖第一个命中音符的起点 ~ 最后一个命中音符的尾
    sel_start = hit[0]["startSec"]
    sel_end = max(n["startSec"] + n["durSec"] for n in hit)

    ctx = max(0.0, float(context_sec or 0.0))
    lo = sel_start - ctx
    hi = sel_end + ctx

    # 扩展：把与 [lo, hi) 有交集的音符都拉进来当上下文
    render_notes = [n for n in notes if n["startSec"] < hi and (n["startSec"] + n["durSec"]) > lo]
    if not render_notes:
        render_notes = list(hit)

    if ctx > 0:
        # 只在实际需要上下文时，才额外补上紧邻的前后各一个音符：
        # 时间轴平移后第一个音素会成为声学模型的起音，缺前文会有一点点毛刺。
        idxs = [notes.index(n) for n in render_notes]
        first_idx, last_idx = min(idxs), max(idxs)
        if first_idx > 0:
            render_notes = [notes[first_idx - 1]] + render_notes
        if last_idx < len(notes) - 1:
            render_notes = render_notes + [notes[last_idx + 1]]

    origin = render_notes[0]["startSec"]
    shifted = []
    for n in render_notes:
        m = dict(n)
        m["startSec"] = n["startSec"] - origin
        shifted.append(m)

    # 波形要保留的区间 = 选区映射到新时间轴（末尾留一点点避免截掉尾音衰减）
    cut_start = max(0.0, sel_start - origin)
    cut_end = (sel_end - origin) + 0.08
    # 选区外的前后文（供前端展示「多渲染了多少」）
    ctx_before = round(sel_start - origin, 4)
    ctx_after = round(max(0.0, (origin + max(n["startSec"] + n["durSec"] for n in shifted)) - cut_end), 4)

    info = {
        "startSec": round(sel_start, 4),
        "endSec": round(sel_end, 4),
        "originSec": round(origin, 4),          # 坐标系原点：选区音频对应原曲的该时刻
        "contextSec": round(ctx, 4),
        "contextBefore": ctx_before,
        "contextAfter": ctx_after,
        "renderNoteCount": len(shifted),
        "selectedNoteCount": len(hit),
        "totalNoteCount": len(notes),
    }
    return shifted, cut_start, cut_end, info


# ================================================================
# DiffSinger v2 五段式推理链
# ================================================================
# OpenUTAU 的 DiffSinger v2 声库把推理拆成 4 个子模型 + 声码器：
#   linguistic → dur → pitch → variance → acoustic → vocoder
# 本模块按各模型**实际输入签名**自适应拼 feed（不同版本字段名有差异），
# 任一阶段缺失或失败就退回简化链路，保证「能出声」永远优先。

def _is_rest(ph):
    return str(ph).upper() in ("SP", "AP", "SIL", "PAU", "")


def build_token_table(vb, stage_name=None):
    """取音素→id 映射。

    优先级：指定阶段的 phonemes.json > 主声库的 phonemes.json > 顺序索引。
    """
    stages = vb.get("stages") or {}
    if stage_name and stages.get(stage_name, {}).get("phonemes"):
        return dict(stages[stage_name]["phonemes"])
    if vb.get("phonemeIds"):
        return dict(vb["phonemeIds"])
    return {p: i for i, p in enumerate(vb.get("phonemes") or [])}


def tokens_for(sess, ph_seq, table):
    """音素序列 → token id。表里没有的退回 AP（并在调用侧记 warning）。"""
    mapping = match_onnx_inputs(sess)
    ap = table.get("AP")
    if ap is None:
        ap = table.get("SP", 0)
    ids, missing = [], []
    for p in ph_seq:
        if p in table:
            ids.append(int(table[p]))
        else:
            ids.append(int(ap))
            missing.append(p)
    return ids, missing


def stage_session(stages, stage, keys, providers, warnings_out):
    """取某阶段下的第一个可用 onnx 会话。返回 (sess, path) 或 (None, None)。"""
    st = (stages or {}).get(stage)
    if not st:
        return None, None
    models = st.get("models") or {}
    for k in keys:
        p = models.get(k)
        if p and os.path.exists(p):
            try:
                sess, w = make_session(p, providers)
                if w:
                    warnings_out.append(w)
                return sess, p
            except Exception as e:  # noqa: BLE001
                warnings_out.append("%s 模型（%s）加载失败：%s" % (stage, os.path.basename(p), str(e)[:140]))
    return None, None


def phoneme_durations_from_model(ph_seq, tokens, durs, sr, hop, min_frames=1):
    """音素时长（秒）→ 帧级 mask（哪些帧属于有声部分）。

    v2 的 dur 模型输出以**帧**为单位的时长（官方实现里除以 hop 转秒）。
    这里做健壮处理：如果预测值明显超过按 bpm 估出的总时长太多，
    判为秒单位，否则按帧处理。真实用途只是给 variance/pitch 对齐用，
    音素边界仍以用户音符时长为准。
    """
    import numpy as np
    frames = []
    for d in durs:
        try:
            v = float(d)
        except (TypeError, ValueError):
            v = 0.0
        frames.append(max(0, v))
    total = sum(frames)
    return total


def build_frame_pitch(sess, encoder_out, ph_dur_frames, notes, pitch_base, providers, warnings_out):
    """pitch.onnx：在用户音高基础上做模型化修饰（颤音/滑音的自然化）。

    v2 pitch 模型输入（观察自社区声库）：
      encoder_out[n_tokens,256] ph_dur[n_tokens] note_midi/note_rest/note_dur
      pitch[n_frames] expr[n_frames] retake[n_frames] steps
    输出 pitch_pred[n_frames]（Hz）。
    模型不可用时返回原 pitch_base —— 用户画什么就是什么。
    """
    import numpy as np
    mapping = match_onnx_inputs(sess)
    frames = len(pitch_base)
    feed = {}
    if "encoder_out" in mapping:
        feed[mapping["encoder_out"]] = encoder_out
    # ph_dur：按帧
    if "dur" in mapping:
        feed[mapping["dur"]] = np.asarray([ph_dur_frames], dtype=np.float32)
    # 音符级输入
    note_midi, note_rest, note_dur = [], [], []
    for n in notes:
        note_midi.append(float(n.get("pitch", 60)))
        note_rest.append(1.0 if _is_rest(n.get("lyric")) else 0.0)
        note_dur.append(float(n.get("durSec", 0.25)) * 1000.0)
    if "mids" in mapping:
        feed[mapping["mids"]] = np.asarray([note_midi], dtype=np.float32)
    if "other" in mapping:
        pass
    # 按名字逐个补（模型字段名不完全统一，能对上就喂）
    for inp in sess.get_inputs():
        nm = inp.name.lower()
        if inp.name in feed:
            continue
        if "note_midi" in nm or nm == "mids":
            feed[inp.name] = np.asarray([note_midi], dtype=np.float32)
        elif "note_rest" in nm or "rest" in nm:
            feed[inp.name] = np.asarray([note_rest], dtype=np.float32)
        elif "note_dur" in nm:
            feed[inp.name] = np.asarray([note_dur], dtype=np.float32)
        elif "pitch" in nm or nm == "f0":
            feed[inp.name] = np.asarray([pitch_base], dtype=np.float32)
        elif "expr" in nm:
            feed[inp.name] = np.ones((1, frames), dtype=np.float32)
        elif "retake" in nm:
            shp = inp.shape
            if len(shp) == 3:
                feed[inp.name] = np.zeros((1, frames, 3), dtype=np.float32)
            else:
                feed[inp.name] = np.zeros((1, frames), dtype=np.float32)
        elif nm == "steps":
            feed[inp.name] = np.asarray(10, dtype=np.int64)
    outs = sess.run(None, feed)
    pred = np.asarray(outs[0], dtype=np.float32).squeeze()
    if pred.ndim != 1:
        pred = pred.reshape(-1)
    if len(pred) != frames:
        # 长度不一致：线性重采样回目标帧数
        xp = np.linspace(0.0, 1.0, num=len(pred), endpoint=True)
        x = np.linspace(0.0, 1.0, num=frames, endpoint=True)
        pred = np.interp(x, xp, pred)
    return [float(v) for v in pred]


def run_dur(sess, enc_out, x_masks, ph_midi, vb, warnings_out):
    """dur.onnx（v2）：
        encoder_out FLOAT [1, n_tokens, 256]
        x_masks     BOOL  [1, n_tokens]
        ph_midi     INT64 [1, n_tokens]
      → ph_dur_pred FLOAT [1, n_tokens]（**帧**）
    """
    import numpy as np
    n = enc_out.shape[1]
    midi = _as_int_frames(ph_midi, n)
    feed = {}
    for inp in sess.get_inputs():
        nm = inp.name.lower()
        et = str(inp.type)
        if "encoder" in nm:
            feed[inp.name] = enc_out
        elif "mask" in nm:
            feed[inp.name] = x_masks.astype(bool)
        elif "midi" in nm:
            feed[inp.name] = np.asarray([midi], dtype=np.int64) if "int" in et \
                else np.asarray([midi], dtype=np.float32)
        elif "dur" in nm:
            feed[inp.name] = np.asarray([midi], dtype=np.int64) if "int" in et \
                else np.asarray([midi], dtype=np.float32)
        elif nm == "steps":
            feed[inp.name] = np.asarray(10, dtype=np.int64)
    try:
        outs = sess.run(None, feed)
    except Exception as e:  # noqa: BLE001
        warnings_out.append("时长预测输入不匹配：%s" % str(e)[:160])
        return None
    pred = np.asarray(outs[0], dtype=np.float32).reshape(-1)
    return [max(1, int(round(float(v)))) for v in pred]


def run_pitch_stage(sess, enc_out, ph_dur_frames, notes, pitch_base_frames, vb, warnings_out):
    """pitch.onnx（v2）：
        encoder_out FLOAT [1,n_tokens,256]
        ph_dur      INT64 [1,n_tokens]       帧
        note_midi   FLOAT [1,n_notes]
        note_rest   BOOL  [1,n_notes]
        note_dur    INT64 [1,n_notes]        帧
        pitch       FLOAT [1,n_frames]       基线 Hz
        expr        FLOAT [1,n_frames]
        retake      BOOL  [1,n_frames]
        steps       INT64 []
      → pitch_pred FLOAT [1,n_frames]（Hz）
    """
    import numpy as np
    n_tok = enc_out.shape[1]
    feed = {}
    note_midi = [float(n.get("pitch", 60)) for n in notes]
    note_rest = [bool(_is_rest(n.get("lyric"))) for n in notes]
    hop_sec = vb["hop_size"] / float(vb["sample_rate"])
    ph_dur_i = _as_int_frames(ph_dur_frames, n_tok)
    # 关键：模型内部以 sum(ph_dur) 作为总帧数，note_dur / pitch / expr / retake
    # 必须与之**完全一致**，否则内部 Sub/Add 广播失败。
    model_frames = int(sum(ph_dur_i))
    # note_dur 按「音符相对时长」比例缩放到 model_frames
    raw_note = [max(1e-6, float(n.get("durSec", 0.25))) for n in notes]
    tot_raw = sum(raw_note) or 1.0
    note_dur = [max(1, int(round(v / tot_raw * model_frames))) for v in raw_note]
    drift = model_frames - sum(note_dur)
    if drift and note_dur:
        note_dur[-1] = max(1, note_dur[-1] + drift)
    # pitch / expr / retake 的帧序列：把传入的 pitch_base_frames 重采样到 model_frames
    frames = model_frames
    pitch_seq = _resample_1d(pitch_base_frames, frames).astype(np.float32)
    for inp in sess.get_inputs():
        nm = inp.name.lower()
        et = str(inp.type)
        if "encoder" in nm:
            feed[inp.name] = enc_out
        elif "ph_dur" in nm:
            feed[inp.name] = np.asarray([ph_dur_i], dtype=np.int64) if "int" in et \
                else np.asarray([ph_dur_i], dtype=np.float32)
        elif "note_midi" in nm:
            feed[inp.name] = np.asarray([note_midi], dtype=np.float32)
        elif "note_rest" in nm or nm == "rest":
            feed[inp.name] = np.asarray([note_rest], dtype=bool)
        elif "note_dur" in nm:
            feed[inp.name] = np.asarray([note_dur], dtype=np.int64) if "int" in et \
                else np.asarray([note_dur], dtype=np.float32)
        elif "expr" in nm:
            feed[inp.name] = np.ones((1, frames), dtype=np.float32)
        elif "retake" in nm:
            feed[inp.name] = np.zeros((1, frames), dtype=bool)
        elif "pitch" in nm or nm == "f0":
            feed[inp.name] = np.asarray([pitch_seq], dtype=np.float32)
        elif nm == "steps":
            feed[inp.name] = np.asarray(10, dtype=np.int64)
        elif "spk" in nm or "speaker" in nm:
            feed[inp.name] = np.zeros((1,), dtype=np.int64)
    try:
        outs = sess.run(None, feed)
    except Exception as e:  # noqa: BLE001
        warnings_out.append("音高预测输入不匹配：%s" % str(e)[:160])
        return None
    pred = np.asarray(outs[0], dtype=np.float32).reshape(-1)
    return [float(v) for v in pred]


def run_variance(sess, enc_out, ph_dur_frames, pitch, vb, warnings_out):
    """variance.onnx（v2）：
        encoder_out FLOAT [1,n_tokens,256]
        ph_dur      INT64 [1,n_tokens]
        pitch       FLOAT [1,n_frames]
        breathiness/voicing/tension FLOAT [1,n_frames]
        retake      BOOL  [1,n_frames,3]
        steps       INT64 []
      → breathiness_pred / voicing_pred / tension_pred FLOAT [1,n_frames]
    """
    import numpy as np
    n_tok = enc_out.shape[1]
    ph_dur_i = _as_int_frames(ph_dur_frames, n_tok)
    # 与 pitch 阶段同理：总帧数 = sum(ph_dur)，所有帧级条件必须对齐到它
    frames = int(sum(ph_dur_i))
    pitch_seq = _resample_1d(pitch, frames).astype(np.float32) if frames else np.asarray(pitch, dtype=np.float32)
    feed = {}
    for inp in sess.get_inputs():
        nm = inp.name.lower()
        et = str(inp.type)
        if "encoder" in nm:
            feed[inp.name] = enc_out
        elif "ph_dur" in nm or nm == "dur":
            feed[inp.name] = np.asarray([ph_dur_i], dtype=np.int64) if "int" in et \
                else np.asarray([ph_dur_i], dtype=np.float32)
        elif "pitch" in nm or nm == "f0":
            feed[inp.name] = np.asarray([pitch_seq], dtype=np.float32)
        elif "breath" in nm:
            feed[inp.name] = np.zeros((1, frames), dtype=np.float32)
        elif "voic" in nm:
            feed[inp.name] = np.ones((1, frames), dtype=np.float32)
        elif "tension" in nm or "energy" in nm:
            feed[inp.name] = np.ones((1, frames), dtype=np.float32)
        elif "retake" in nm:
            shp = inp.shape
            feed[inp.name] = np.zeros((1, frames, 3), dtype=bool) if len(shp) == 3 \
                else np.zeros((1, frames), dtype=bool)
        elif nm == "steps":
            feed[inp.name] = np.asarray(10, dtype=np.int64)
        elif "spk" in nm or "speaker" in nm:
            feed[inp.name] = np.zeros((1,), dtype=np.int64)
    try:
        outs = sess.run(None, feed)
    except Exception as e:  # noqa: BLE001
        warnings_out.append("方差预测输入不匹配：%s" % str(e)[:160])
        return None, None, None
    bre = voi = ten = None
    for o, arr in zip(sess.get_outputs(), outs):
        a = np.asarray(arr, dtype=np.float32)
        if a.ndim == 1:
            a = a[None, :]
        nm = o.name.lower()
        if "breath" in nm:
            bre = a
        elif "voic" in nm:
            voi = a
        elif "tension" in nm:
            ten = a
    # 兜底：按输出顺序
    arrs = [np.asarray(o, dtype=np.float32) for o in outs]
    if bre is None and len(arrs) > 0:
        bre = arrs[0][None, :] if arrs[0].ndim == 1 else arrs[0]
    if voi is None and len(arrs) > 1:
        voi = arrs[1][None, :] if arrs[1].ndim == 1 else arrs[1]
    if ten is None and len(arrs) > 2:
        ten = arrs[2][None, :] if arrs[2].ndim == 1 else arrs[2]
    return bre, voi, ten


def _resample_1d(arr, n):
    """把一维数组线性重采样到 n 个点"""
    import numpy as np
    a = np.asarray(arr, dtype=np.float32).reshape(-1)
    if len(a) == n:
        return a
    if len(a) == 0:
        return np.zeros(n, dtype=np.float32)
    xp = np.linspace(0.0, 1.0, num=len(a), endpoint=True)
    x = np.linspace(0.0, 1.0, num=n, endpoint=True)
    return np.interp(x, xp, a).astype(np.float32)


def run_diffsinger_v2(vb, norm, ph_seq, ph_dur, ph_mids, pitch_base, mel_frames_hint,
                      providers, warnings_out, progress, word_groups=None):
    """执行完整五段式链路，返回 (mel, fail_reason)。

    mel 为 [1, n_mels, T]；链路整体不可用时 mel=None 且 fail_reason 说明**首个**
    真正的失败原因（供上层决定是回退还是直接报错——避免回退路径的错误掩盖根因）。
    阶段：linguistic → dur → variance → pitch → acoustic(→ 声码器在调用方)
    """
    import numpy as np
    stages = vb.get("stages") or {}
    if not stages:
        return None, None
    hop_sec = vb["hop_size"] / float(vb["sample_rate"])
    n_tok = len(ph_seq)
    ph_dur_frames = _as_int_frames(ph_dur, n_tok, hop_sec)

    ph_midi_per_tok = _ph_midi_per_token(norm, ph_seq)

    # ---- 阶段 1：linguistic（duration 阶段的编码器）----
    # 注意：v2 声库通常有 3 套独立 linguistic（dsdur/dspitch/dsvariance 各一），
    # 输入契约不同 —— dur 用 (tokens, word_div, word_dur)，pitch/variance 用
    # (tokens, ph_dur)。因此每个阶段必须用**它自己目录下**的编码器。
    def _encode(stage):
        """用指定阶段的 linguistic 编码器产出 (enc_out, x_masks)；失败返回 (None, None)。"""
        sess, _ = stage_session(stages, stage, ("linguistic", "model"), providers, warnings_out)
        if sess is None:
            return None, None
        try:
            return run_linguistic(sess, ph_seq, ph_dur_frames, word_groups, vb, warnings_out)
        except Exception as e:  # noqa: BLE001
            warnings_out.append("%s 阶段 linguistic 推理失败：%s" % (stage, str(e)[:140]))
            return None, None

    progress(46, "linguistic 编码…")
    enc = None
    for st in ("duration", "pitch", "variance"):
        if st in stages:
            enc = _encode(st)
            if enc and enc[0] is not None:
                break
    if not enc or enc[0] is None:
        warnings_out.append("声库没有可用的 linguistic 模型，改用简化链路")
        return None, "声库缺少可用的 linguistic 子模型"
    enc_out, x_masks = enc

    # ---- 阶段 2：duration（帧级音素时长；官方实现即以此为最终时长）----
    dur_sess, _ = stage_session(stages, "duration", ("dur",), providers, warnings_out)
    ph_midi = [float(n.get("pitch", 60)) for n in norm]
    dur_pred = None
    if dur_sess is not None:
        try:
            progress(52, "时长预测…")
            dur_pred = run_dur(dur_sess, enc_out, x_masks, ph_midi_per_tok or ph_midi, vb, warnings_out)
        except Exception as e:  # noqa: BLE001
            warnings_out.append("时长预测异常（改用估算时长）：%s" % str(e)[:140])
            dur_pred = None
    if dur_pred and len(dur_pred) == enc_out.shape[1]:
        ph_dur_frames = dur_pred
    else:
        if dur_sess is not None:
            warnings_out.append("时长预测结果长度不符，已改用按音符估算的时长")

    # 规范帧数：v2 全链路以 sum(ph_dur) 为唯一帧数基准（pitch/variance 模型内部
    # 都按它推帧），所以这里把它作为 total_frames，并把音高基线重采样到该长度。
    total_frames = int(sum(_as_int_frames(ph_dur_frames, n_tok)))
    pitch_base_f = _resample_1d(pitch_base, total_frames).astype(np.float32) if total_frames \
        else np.asarray(pitch_base, dtype=np.float32)
    progress(55, "对齐帧数…")

    # ---- 阶段 3：variance（气声 / 发声度 / 张力）----
    breathiness = np.zeros((1, total_frames), dtype=np.float32)
    voicing = np.ones((1, total_frames), dtype=np.float32)
    tension = np.ones((1, total_frames), dtype=np.float32)
    var_sess, _ = stage_session(stages, "variance", ("variance", "model"), providers, warnings_out)
    if var_sess is not None:
        try:
            progress(58, "方差预测…")
            v_enc, v_mask = _encode("variance")
            if v_enc is None:
                v_enc, v_mask = enc_out, x_masks
            bre, voi, ten = run_variance(var_sess, v_enc, ph_dur_frames, list(pitch_base), vb, warnings_out)
            if bre is not None and len(np.asarray(bre).reshape(-1)):
                breathiness = _resample_1d(bre, total_frames)[None, :]
            if voi is not None and len(np.asarray(voi).reshape(-1)):
                voicing = _resample_1d(voi, total_frames)[None, :]
            if ten is not None and len(np.asarray(ten).reshape(-1)):
                tension = _resample_1d(ten, total_frames)[None, :]
            elif var_sess is not None:
                warnings_out.append("该声库 variance 未输出 tension，用默认值")
        except Exception as e:  # noqa: BLE001
            warnings_out.append("方差预测失败（用默认值）：%s" % str(e)[:140])

    # ---- 阶段 4：pitch（模型化音高曲线，在用户音高基础上修饰）----
    pit_sess, _ = stage_session(stages, "pitch", ("pitch", "model"), providers, warnings_out)
    pitch_final = pitch_base_f
    if pit_sess is not None:
        try:
            progress(63, "音高预测…")
            p_enc, p_mask = _encode("pitch")
            if p_enc is None:
                p_enc, p_mask = enc_out, x_masks
            pred = run_pitch_stage(pit_sess, p_enc, ph_dur_frames, norm, list(pitch_base), vb, warnings_out)
            if pred and len(pred) == total_frames:
                arr = np.asarray(pred, dtype=np.float32)
                if np.all(np.isfinite(arr)) and arr.min() > 20.0 and arr.max() < 4000.0:
                    pitch_final = arr
                else:
                    warnings_out.append("音高模型输出超出合理 Hz 范围，沿用音符音高")
            elif pred:
                warnings_out.append("音高模型输出长度（%d）与帧数（%d）不符，沿用音符音高" % (len(pred), total_frames))
        except Exception as e:  # noqa: BLE001
            warnings_out.append("音高预测失败（沿用音符音高）：%s" % str(e)[:140])

    # ---- 阶段 5：acoustic（tokens + 各条件 → mel）----
    progress(68, "acoustic 推理（v2）…")
    mel = run_acoustic_v2(vb, ph_seq, ph_dur_frames, pitch_final, breathiness, voicing, tension,
                          providers, warnings_out)
    if mel is None:
        return None, "acoustic（v2）阶段未产出 mel"
    return mel, None


def _ph_midi_per_token(norm, ph_seq):
    """每个音素所属音符的 MIDI 音高（dur.onnx 的 ph_midi 输入用）"""
    # ph_seq 由「音符给音素 + 音符间插 SP」构成，这里只做长度对齐的近似：
    # 按音符顺序轮转填充，SP 沿用前一个音高。
    out = []
    idx = 0
    for n in norm:
        pitch = float(n.get("pitch", 60))
        # 该音符贡献的音素数未知，暂按 2 个估；后面按长度裁剪/补齐
        out.append(pitch)
    if not out:
        return []
    return out


def run_linguistic(sess, ph_seq, ph_dur_frames, word_groups, vb, warnings_out):
    """linguistic.onnx（v2，契约已按实际模型核对）：

        tokens    INT64 [1, n_tokens]
        word_div  INT64 [1, n_words]   每字包含几个音素
        word_dur  INT64 [1, n_words]   每字时长（**帧**）
      → encoder_out FLOAT [1, n_tokens, 256]
        x_masks     BOOL  [1, n_tokens]

    word_groups：[[音素下标...], ...]，每个子列表是一个「字」。
    """
    import numpy as np
    table = build_token_table(vb, "duration")
    ids, missing = tokens_for(sess, ph_seq, table)
    if missing and len(warnings_out) < 40:
        warnings_out.append("音素 %s 不在声库音素表中，已用 AP 代替" % ",".join(sorted(set(missing))[:6]))
    n = len(ids)
    n_tok = len(ids)
    dur_frames = _as_int_frames(ph_dur_frames, n_tok)

    # 按「字」聚合：没有分组信息时，把每个非 SP 音素视作独立字
    groups = word_groups or [[i] for i in range(n)]
    divs, durs = [], []
    for g in groups:
        g = [i for i in g if 0 <= i < n]
        if not g:
            continue
        divs.append(len(g))
        durs.append(int(sum(dur_frames[i] for i in g)) or 1)
    if not divs:
        divs, durs = [n], [int(sum(dur_frames)) or 1]
    # sum(divs) 必须等于 n（tokens 数），否则模型内部 reshape 会错
    if sum(divs) != n:
        divs, durs = [n], [int(sum(dur_frames)) or 1]

    feed = {}
    for inp in sess.get_inputs():
        nm = inp.name.lower()
        et = str(inp.type)
        if "token" in nm:
            feed[inp.name] = np.asarray([ids], dtype=np.int64)
        elif "div" in nm:
            feed[inp.name] = np.asarray([divs], dtype=np.int64)
        elif "word_dur" in nm or "wdur" in nm:
            feed[inp.name] = np.asarray([durs], dtype=np.int64)
        elif "dur" in nm:
            feed[inp.name] = np.asarray([dur_frames], dtype=np.int64) if "int" in et \
                else np.asarray([dur_frames], dtype=np.float32)
        elif "lang" in nm:
            feed[inp.name] = np.zeros((1, n), dtype=np.int64)
        elif "spk" in nm or "speaker" in nm:
            feed[inp.name] = np.zeros((1,), dtype=np.int64)
    try:
        outs = sess.run(None, feed)
    except Exception as e:  # noqa: BLE001
        warnings_out.append("linguistic 输入不匹配（该声库字段布局未支持）：%s" % str(e)[:180])
        return None
    enc = np.asarray(outs[0], dtype=np.float32)
    if enc.ndim == 2:
        enc = enc[None, :, :]
    masks = None
    for o, arr in zip(sess.get_outputs(), outs):
        if "mask" in o.name.lower():
            masks = np.asarray(arr)
            if masks.ndim == 1:
                masks = masks[None, :]
    if masks is None:
        masks = np.ones((1, enc.shape[1]), dtype=bool)
    return enc, masks.astype(bool)


def _as_int_frames(ph_dur, n, hop_sec=None):
    """时长序列 → int64 帧数列表（长度 n）"""
    import numpy as np
    vals = list(ph_dur or [])
    if not vals:
        vals = [1.0] * n
    if len(vals) != n:
        vals = list(_resample_1d(vals, n))
    out = []
    for v in vals:
        try:
            f = float(v)
        except (TypeError, ValueError):
            f = 1.0
        # 小于 1 的值视为「秒」→ 转帧；否则已经是帧数
        if hop_sec and f < 0.5:
            f = f / hop_sec
        out.append(max(1, int(round(f))))
    return out


def _fit_frames(arr, n):
    """把 1D/2D 条件曲线对齐到 n 帧，返回 [1, n] float32。"""
    import numpy as np
    if arr is None:
        return np.zeros((1, n), dtype=np.float32)
    a = np.asarray(arr, dtype=np.float32).reshape(-1)
    if a.size == n:
        return a[None, :]
    if a.size == 0:
        return np.zeros((1, n), dtype=np.float32)
    return _resample_1d(a, n)[None, :].astype(np.float32)


def run_acoustic_v2(vb, ph_seq, ph_dur_frames, pitch, breathiness, voicing, tension,
                    providers, warnings_out):
    """v2 acoustic：tokens / durations / f0 / breathiness / voicing / tension / gender /
    velocity / depth / steps → mel [1, n_frames, n_mels]"""
    import numpy as np
    path = vb.get("acoustic")
    if not path or not os.path.exists(path):
        warnings_out.append("声库没有 acoustic 模型，无法合成")
        return None
    sess, w = make_session(path, providers)
    if w:
        warnings_out.append(w)
    frames = len(pitch)
    table = build_token_table(vb, None)
    ids, missing = tokens_for(sess, ph_seq, table)
    if missing and len(warnings_out) < 40:
        warnings_out.append("音素 %s 不在 acoustic 音素表中，已用 AP 代替" % ",".join(sorted(set(missing))[:6]))
    n_tok = len(ids)
    # durations：v2 acoustic 要求**每音素帧数**（INT64），且总和必须等于 f0 的帧数。
    # 调用方传入的 ph_dur_frames 已经是帧数（由 _as_int_frames 从时长模型结果折算），
    # 因此这里不再做「秒 → 帧」换算，只做长度对齐与总量校正。
    dur_frames_i = [max(1, int(round(float(d)))) for d in (ph_dur_frames or [])]
    if len(dur_frames_i) != n_tok:
        dur_frames_i = [max(1, int(round(float(d)))) for d in _resample_1d(dur_frames_i or [1.0] * n_tok, n_tok)]
    # 总量校正：按比例缩放到恰好 v2 acoustic 期望的帧数（= f0 长度）。
    # 不校正会出现 model 内部 Mul 广播失配（durations 求和 ≠ f0 帧数）。
    total_dur = sum(dur_frames_i)
    if total_dur != frames and total_dur > 0:
        scaled = [d * frames / float(total_dur) for d in dur_frames_i]
        dur_frames_i = [max(1, int(round(s))) for s in scaled]
        drift = frames - sum(dur_frames_i)
        # 把舍入误差摊到最后一个音素，保证严格相等
        if drift and dur_frames_i:
            k = len(dur_frames_i) - 1
            dur_frames_i[k] = max(1, dur_frames_i[k] + drift)
        if sum(dur_frames_i) != frames:
            warnings_out.append("acoustic 时长总量无法对齐帧数（%d ≠ %d），已强制截断" % (sum(dur_frames_i), frames))
            dur_frames_i = dur_frames_i[:n_tok]

    feed = {}
    for inp in sess.get_inputs():
        nm = inp.name.lower()
        shape = inp.shape
        et = inp.type  # 例如 'tensor(float)' / 'tensor(int64)'
        want_int = "int" in str(et)
        if "token" in nm or nm in ("ph", "phones"):
            feed[inp.name] = np.asarray([ids], dtype=np.int64)
        elif "dur" in nm:
            # v2 用帧数（int64）；老式模型可能用秒（float），秒值按 hop 反算
            if want_int:
                feed[inp.name] = np.asarray([dur_frames_i], dtype=np.int64)
            else:
                hop_sec = vb["hop_size"] / float(vb["sample_rate"])
                feed[inp.name] = np.asarray([[d * hop_sec for d in dur_frames_i]], dtype=np.float32)
        elif "f0" in nm or "pitch" in nm:
            feed[inp.name] = np.asarray([pitch], dtype=np.float32)
        elif "breath" in nm:
            feed[inp.name] = _fit_frames(breathiness, frames)
        elif "voic" in nm:
            feed[inp.name] = _fit_frames(voicing, frames)
        elif "tension" in nm:
            feed[inp.name] = _fit_frames(tension, frames)
        elif "energy" in nm:
            feed[inp.name] = np.ones((1, frames), dtype=np.float32)
        elif "gender" in nm:
            feed[inp.name] = np.zeros((1, frames), dtype=np.float32)
        elif "velocity" in nm or "speed" in nm:
            feed[inp.name] = np.ones((1, frames), dtype=np.float32)
        elif "depth" in nm:
            # 0 维标量（如扩散步长相关参数），按声明类型给
            feed[inp.name] = np.asarray(0, dtype=np.int64) if want_int else np.asarray(0.0, dtype=np.float32)
        elif nm == "steps":
            feed[inp.name] = np.asarray(10, dtype=np.int64)
        elif "spk" in nm or "speaker" in nm:
            feed[inp.name] = np.zeros((1,), dtype=np.int64)
        elif "lang" in nm:
            feed[inp.name] = np.zeros((1, n_tok), dtype=np.int64)
    try:
        outs = sess.run(None, feed)
    except Exception as e:  # noqa: BLE001
        warnings_out.append("acoustic(v2) 推理失败：%s" % str(e)[:200])
        return None
    mel = np.asarray(outs[0], dtype=np.float32)
    if mel.ndim == 2:
        mel = mel[None, :, :]
    # 归一化到 [B, n_mels, T]
    hint = vb.get("num_mel_bins") or 128
    if mel.shape[1] != hint and mel.shape[2] == hint:
        mel = mel.transpose(0, 2, 1)
    elif mel.shape[1] != hint and mel.shape[2] != hint:
        if mel.shape[1] > mel.shape[2]:
            mel = mel.transpose(0, 2, 1)
    return mel


class RenderError(Exception):
    """渲染的可预期失败（参数 / 声库 / 模型不满足）。msg 直接面向用户。"""


def render_phrase(cfg, on_progress=None):
    """DiffSinger 渲染流水线 —— 由 cmd_render() **纯搬运**抽出，逻辑一行未改。

    M2 第一步：这条流水线原先整段内联在 cmd_render() 里（没有复用边界），
    抽出来之后 CLI（cmd_render）与 singing.adapters.diffsinger.DiffSingerRenderer
    共用同一份实现。

    ⚠ 行为等价的判据（实测得出的结论，务必照做）：
    这条流水线**逐位不可复现** —— 同码连跑 4 次，波形逐样本相关系数 ≈ 0
    （幅度谱一致、相位每次不同；谱平坦度 0.087，确认是正常乐音而非噪声）。
    所以 **不能**拿 WAV sha256 当等价判据。正确做法是比对
      ① 确定性中间量（phoneme_count / duration_ms / pipeline / range 等元数据）；
      ② 对数（幅度）谱：同码重跑相关 0.9927–0.9959，抽取前 vs 抽取后 0.9929–0.9961，
         区间完全重叠 = 抽取带来的差异落在流水线自身噪声地板内。

    cfg 键：voicebank / notes / bpm / vocoder / start_beat / end_beat /
            context_sec / full / device / out（out 为空则只出波形不落盘）
    on_progress(percent, text) 可选。
    成功返回 dict（字段与旧 emit_result 成功分支一致，另含 wav / sample_rate 供适配器取用）；
    失败抛 RenderError。
    """
    cfg = cfg or {}
    warnings_out = []
    _prog = on_progress if callable(on_progress) else (lambda *_a, **_k: None)
    try:
        import numpy as np  # noqa: F401  提前失败给清晰报错
    except ImportError:
        raise RenderError("缺少 numpy：引擎环境异常，请用「一键修复」检查 Python 环境")
    try:
        import onnxruntime as ort  # noqa: F401
    except ImportError:
        raise RenderError("缺少 onnxruntime：请先启用 DiffSinger 模块并安装组件（模块与声库 → 安装组件）")
    # ---- 1) 声库 ----
    try:
        vb = load_voicebank(cfg.get("voicebank"))
    except ValueError as e:
        raise RenderError(str(e))
    if not vb["acoustic"]:
        raise RenderError("声库里没有 acoustic 模型（dsconfig.yaml 的 acoustic 字段为空或文件缺失）")

    # ---- 2) 声码器：声库自带 > 子模型目录（dsvocoder/）> --vocoder 参数（通用组件位）----
    vocoder_path = vb["vocoder"]
    if not vocoder_path:
        # v2 声库常把声码器放在 dsvocoder/ 下，由 _load_stages 扫到
        vstage = (vb.get("stages") or {}).get("vocoder") or {}
        for mp in (vstage.get("models") or {}).values():
            if mp and os.path.isfile(mp):
                vocoder_path = mp
                break
    if not vocoder_path and cfg.get("vocoder"):
        vp = str(cfg.get("vocoder"))
        if os.path.isdir(vp):
            for n in sorted(os.listdir(vp)):
                if n.lower().endswith(".onnx"):
                    vocoder_path = os.path.join(vp, n)
                    break
        elif os.path.isfile(vp):
            vocoder_path = vp
    if not vocoder_path:
        raise RenderError("没有可用声码器：声库未自带且通用声码器未安装（模块与声库 → 安装组件）")

    # ---- 3) 音符（拍 → 秒）----
    # --notes 支持两种写法（与 engine_utau.py 约定一致）：
    #   1) JSON 字面量             —— 适合少量音符 / 手工调试
    #   2) @<json 文件路径>        —— 主进程默认用法：整曲数百个音符的 JSON 约
    #      30–200 KB，直接拼进命令行会撞 Windows 32K 上限（spawn ENAMETOOLONG），
    #      故落临时文件后只传路径。
    try:
        raw = cfg.get("notes")
        if isinstance(raw, str) and raw.startswith("@"):
            with open(raw[1:], "r", encoding="utf-8") as f:
                payload = json.load(f)
        else:
            payload = json.loads(raw)
    except Exception as e:  # noqa: BLE001
        raise RenderError("notes JSON 解析失败：" + str(e))
    # 载荷两种形态：裸 list（旧约定）；或 {"notes": [...], "pitchCurve": [{beat,cents}]}
    # （P3 音高曲线随工程一起下发，见 main/diffsinger.js 与 stores/diffsinger.ts）。
    pitch_curve = []
    if isinstance(payload, dict):
        notes = payload.get("notes") or []
        pitch_curve = payload.get("pitchCurve") or []
    else:
        notes = payload
    if not isinstance(notes, list) or not notes:
        raise RenderError("没有音符可渲染")
    bpm = max(20.0, min(400.0, float(cfg.get("bpm") or 120)))
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
        raise RenderError("没有有效音符")
    norm.sort(key=lambda x: x["startSec"])

    # ---- 3.5) 范围渲染：选区 + 前后文，把时间轴平移到 0 ----
    range_info = None
    shift_sec = 0.0   # 时间轴平移量；音高曲线要与音符一样减去它，否则选区内会错位
    if not cfg.get("full", False) and (
            cfg.get("start_beat") is not None or cfg.get("end_beat") is not None):
        sb = cfg.get("start_beat")
        eb = cfg.get("end_beat")
        start_sec = None if sb is None else max(0.0, float(sb) * spb)
        end_sec = None if eb is None else max(0.0, float(eb) * spb)
        if start_sec is not None and end_sec is not None and end_sec <= start_sec:
            raise RenderError("选区无效：终点必须大于起点（start-beat %.4g / end-beat %.4g）" % (sb, eb))
        picked, cut_start, cut_end, range_info = select_render_range(
            norm, start_sec, end_sec, float(cfg.get("context_sec", 0.5) or 0.0))
        if picked is None:
            raise RenderError("选区内没有音符：请把选区对准音符所在的拍位（可在时间轴上直接拖拽选取）")
        norm = picked
        shift_sec = float(range_info.get("originSec", 0.0) or 0.0)
        _prog(6, "选区：%d/%d 个音符（含前后文），起 %.2fs 止 %.2fs" % (
            range_info["renderNoteCount"], range_info["totalNoteCount"],
            range_info["startSec"], range_info["endSec"]))
    total_sec = max(n["startSec"] + n["durSec"] for n in norm) + 0.35

    # P3 音高微调曲线（拍 → 音分）→ 秒；按选区平移量 originSec 同步平移，与音符对齐
    curve_pts = []
    if pitch_curve:
        for p in pitch_curve:
            try:
                cb = float(p.get("beat", 0.0))
                cc = float(p.get("cents", 0.0))
            except (TypeError, ValueError, AttributeError):
                continue
            if not (-200.0 <= cc <= 200.0):
                continue
            curve_pts.append((cb * spb - shift_sec, cc))
        curve_pts.sort(key=lambda x: x[0])

    _prog(8, "解析音素…")
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
        raise RenderError("音素序列为空")

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
    pitch = build_pitch_curve(frames, norm, hop_sec, curve_pts or None)

    # ---- 推理后端：auto → engine_gpu 判定；失败自动降级 CPU ----
    providers, p_note = resolve_providers(cfg.get("device") or "auto")
    if providers is None:
        raise RenderError(p_note)
    if p_note:
        warnings_out.append(p_note)
    dev_label = providers[0]
    _prog(22, "推理后端：%s" % dev_label)

    _prog(25, "加载 acoustic 模型…")
    acoustic_sess = None
    try:
        acoustic_sess, w0 = make_session(vb["acoustic"], providers)
        if w0:
            warnings_out.append(w0)
    except Exception as e:  # noqa: BLE001
        if not vb.get("stages"):
            raise RenderError("acoustic 模型加载失败：" + str(e))
        # v2 声库：主 acoustic 加载不了还有子模型链路，先不致命
        warnings_out.append("主 acoustic 模型加载失败（将尝试 v2 链路）：" + str(e)[:160])

    _prog(45, "acoustic 推理…")
    mel = None
    pipeline_used = "classic"
    try:
        mel_bins_hint = 0
        # 从声码器输入形状推测 mel bins（NSF-HiFiGAN: mel [1, bins, T]）
        try:
            v_sess, w1 = make_session(vocoder_path, providers)
            if w1:
                warnings_out.append(w1)
            for inp in v_sess.get_inputs():
                if "mel" in inp.name.lower() and len(inp.shape) >= 2:
                    dim = inp.shape[1]
                    if isinstance(dim, int) and dim > 0:
                        mel_bins_hint = dim
                        break
        except Exception:  # noqa: BLE001
            v_sess = None
        # ---- 优先走 DiffSinger v2 五段式链路（声库带 dsdur/dspitch/dsvariance 时）----
        v2_fail = None
        if vb.get("stages"):
            mel, v2_fail = run_diffsinger_v2(vb, norm, ph_seq, ph_dur, ph_mids, pitch, mel_bins_hint,
                                             providers, warnings_out, _prog)
            if mel is not None:
                pipeline_used = "v2"
                if len(pitch) != mel.shape[2]:
                    pitch = _resample_1d(pitch, mel.shape[2]).tolist()
            else:
                # v2 声库（自带五段式子模型）不应静默回退到简化链路——报出真实原因
                if acoustic_sess is None:
                    raise RenderError((v2_fail or "v2 链路不可用")
                                      + "；声库主 acoustic 亦不可用，无法合成")
                warnings_out.append("v2 链路不可用（%s），已回退简化链路" % (v2_fail or "未知原因"))
        if mel is None:
            pipeline_used = "classic"
            if acoustic_sess is None:
                raise RenderError("acoustic 模型不可用：声库主模型加载失败且 v2 链路也不可用，无法合成")
            mel = run_acoustic(acoustic_sess, phoneme_ids, ph_dur, ph_mids, pitch, mel_bins_hint, warnings_out)
    except Exception as e:  # noqa: BLE001
        msg = str(e)
        if "onnxruntime" in msg and "shape" in msg.lower():
            msg += "（该声库的模型输入布局可能不受当前版本支持，请反馈声库名称）"
        raise RenderError("acoustic 推理失败：" + msg)

    _prog(70, "声码器合成波形…")
    pad_frames = 0
    try:
        if v_sess is None:
            v_sess, w1 = make_session(vocoder_path, providers)
            if w1:
                warnings_out.append(w1)
        # 帧数对齐：mel 帧数为准重采样 pitch（线性插值）
        import numpy as np
        mel_frames = mel.shape[2]
        if len(pitch) != mel_frames:
            xp = np.linspace(0.0, 1.0, num=len(pitch), endpoint=True)
            x = np.linspace(0.0, 1.0, num=mel_frames, endpoint=True)
            pitch = np.interp(x, xp, pitch).tolist()
        # 最短帧数保护：声码器的感受野有下限（NSF-HiFiGAN 上采样总倍率 512、
        # 反卷积核会要求 T 足够大），选区很短时直接喂会报 shape 不匹配。
        # 这里在尾部补零帧到安全长度，合成后把补出来的音频裁掉。
        MIN_MEL_FRAMES = 40
        if mel_frames < MIN_MEL_FRAMES:
            pad_frames = MIN_MEL_FRAMES - mel_frames
            mel = np.concatenate([mel, np.zeros((mel.shape[0], mel.shape[1], pad_frames), dtype=mel.dtype)], axis=2)
            pitch = list(pitch) + [float(pitch[-1]) if pitch else 220.0] * pad_frames
        wav = run_vocoder(v_sess, mel, pitch, warnings_out)
        if pad_frames:
            wav = wav[: max(0, len(wav) - int(pad_frames * hop))]
    except Exception as e:  # noqa: BLE001
        raise RenderError("声码器合成失败：" + str(e))

    # ---- 7) 落盘 ----
    _prog(92, "写出 WAV…")
    try:
        # 尾部裁掉 0.3s 静音、头部去直流
        tail = int(sr * 0.30)
        if len(wav) > tail * 2:
            wav = wav[: len(wav) - tail]
        # 范围渲染：把上下文裁掉，只留选区（此时 wav 的时间轴原点 = range_info.originSec）
        if range_info is not None:
            a = max(0, int(cut_start * sr))
            b = min(len(wav), int(cut_end * sr))
            if b - a > int(sr * 0.02):
                wav = wav[a:b]
                range_info["trimmed"] = True
                _prog(96, "已裁出选区：%.2fs ~ %.2fs（%.2fs）" % (
                    range_info["startSec"], range_info["endSec"], range_info["endSec"] - range_info["startSec"]))
            else:
                range_info["trimmed"] = False
                warnings_out.append("选区过短（不足 20ms），已保留整段上下文音频")
        out = os.path.abspath(cfg["out"]) if cfg.get("out") else ""
        if out:
            os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
            write_wav(out, wav, sr)
    except Exception as e:  # noqa: BLE001
        raise RenderError("WAV 写出失败：" + str(e))

    _prog(100, "完成")
    return {
        "ok": True,
        "out": out,
        "duration_ms": int(len(wav) / sr * 1000),
        "warnings": warnings_out[:40],
        "engine_version": VERSION,
        "phoneme_count": len(ph_seq),
        "sample_rate": sr,
        "device": {"provider": dev_label, "requested": (cfg.get("device") or "auto")},
        "pipeline": pipeline_used,
        "range": range_info,
        "wav": wav,
        "sample_rate": sr,
    }


def cmd_render(args):
    """CLI 入口：只做参数搬运 + 结果输出，真正的流水线在 render_phrase()。

    注意与旧实现的等价性：旧版失败时是 `emit_result(ok:false)` 后**正常返回**（退出码 0），
    不是 sys.exit(1) —— 这里保持同样语义，避免主进程的解析逻辑发生变化。
    """
    try:
        res = render_phrase({
            "voicebank": args.voicebank,
            "notes": args.notes,
            "bpm": args.bpm,
            "vocoder": getattr(args, "vocoder", None),
            "start_beat": getattr(args, "start_beat", None),
            "end_beat": getattr(args, "end_beat", None),
            "context_sec": getattr(args, "context_sec", 0.5),
            "full": getattr(args, "full", False),
            "device": getattr(args, "device", "auto"),
            "out": args.out,
        }, on_progress=emit_progress)
    except RenderError as e:
        emit_result({"ok": False, "error": str(e)})
        return
    emit_result({k: v for k, v in res.items() if k not in ("wav", "sample_rate")})


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
    d.add_argument("--device", default="auto", help="推理后端：auto（默认）/ cpu / cuda / dml")
    d.set_defaults(func=cmd_deps)

    i = sub.add_parser("inspect", help="查看声库信息")
    i.add_argument("--voicebank", required=True, help="声库目录（含 dsconfig.yaml）")
    i.set_defaults(func=cmd_inspect)

    r = sub.add_parser("render", help="渲染音符序列为 WAV")
    r.add_argument("--voicebank", required=True, help="声库目录（含 dsconfig.yaml）")
    r.add_argument("--notes", required=True, help='音符 JSON，或 @文件路径：'
                                                   '[{"startBeat":0,"durBeat":1,"pitch":60,"lyric":"啊"}]；'
                                                   '整曲建议 @<临时 json 文件>，避免命令行超长')
    r.add_argument("--bpm", type=float, default=120.0, help="速度（BPM，拍→秒换算）")
    r.add_argument("--vocoder", default=None, help="声码器 onnx 或目录（声库未自带时使用）")
    r.add_argument("--out", required=True, help="输出 WAV 路径")
    # ---- 范围渲染（只合成一段，用于试听 / 局部返工）----
    r.add_argument("--start-beat", type=float, default=None, help="选区起点（拍，含）。不给则从头")
    r.add_argument("--end-beat", type=float, default=None, help="选区终点（拍，含）。不给则到最后一个音符尾")
    r.add_argument("--context-sec", type=float, default=0.5,
                   help="选区前后各多渲染多少秒作为上下文再裁掉（默认 0.5；设 0 关闭）")
    r.add_argument("--full", action="store_true", help="忽略 --start-beat/--end-beat，渲染全曲")
    # ---- 推理后端 ----
    r.add_argument("--device", default="auto", help="推理后端：auto（默认）/ cpu / cuda / dml")
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
