# -*- coding: utf-8 -*-
"""专用音频标签模型（AudioSet 小模型）—— 方案 B 的乐器组探测器。

模型：sherpa-onnx-zipformer-small-audio-tagging-2024-04-15 的 int8 ONNX
（26MB，AudioSet 527 类，CPU 推理约 0.3s/10s）。它不依赖主转录模型，
比拿 MuScriptor-small 做 3×20s 预分析快一个数量级；只用来选「乐器组」，
不参与 MIDI 生成。

本模块顶层**不导入** torch/onnxruntime，方便纯逻辑测试在轻量环境跑。
"""
import csv
import os
import sys

# AudioSet 标签 → MuScriptor 乐器组。只映射能对上的乐器/人声类；
# 泛化标签（Music / Musical instrument / Orchestra）不做映射，避免每首歌都锁一堆组。
AUDIOSET_TO_GROUPS = {
    # 人声
    "Singing": ["voice"], "Choir": ["voice"], "A capella": ["voice"],
    "Vocal music": ["voice"], "Male singing": ["voice"], "Female singing": ["voice"],
    "Child singing": ["voice"],
    # 键盘
    "Piano": ["acoustic_piano"], "Keyboard (musical)": ["acoustic_piano"],
    "Harpsichord": ["acoustic_piano"], "Electric piano": ["electric_piano"],
    "Organ": ["organ"], "Electronic organ": ["organ"], "Hammond organ": ["organ"],
    # 吉他/贝斯
    "Guitar": ["acoustic_guitar"], "Acoustic guitar": ["acoustic_guitar"],
    "Steel guitar, slide guitar": ["acoustic_guitar"],
    "Plucked string instrument": ["acoustic_guitar"],
    "Electric guitar": ["clean_electric_guitar", "distorted_electric_guitar"],
    "Bass guitar": ["electric_bass"],
    # 弦乐
    "String section": ["string_ensemble"], "Bowed string instrument": ["string_ensemble"],
    "Violin, fiddle": ["violin"], "Cello": ["cello"], "Double bass": ["contrabass"],
    "Harp": ["orchestral_harp"],
    # 管乐
    "Flute": ["flutes"], "Wind instrument, woodwind instrument": ["flutes"],
    "Clarinet": ["clarinet"], "Saxophone": ["soprano_and_alto_sax", "tenor_sax", "baritone_sax"],
    "Brass instrument": ["brass_section"], "French horn": ["french_horn"],
    "Trumpet": ["trumpet"], "Trombone": ["trombone"],
    # 鼓/打击
    "Drum kit": ["drums"], "Drum": ["drums"], "Drum machine": ["drums"],
    "Snare drum": ["drums"], "Bass drum": ["drums"], "Percussion": ["drums"],
    "Cymbal": ["drums"], "Hi-hat": ["drums"], "Tambourine": ["drums"],
    "Tabla": ["drums"], "Timpani": ["timpani"],
    "Mallet percussion": ["chromatic_percussion"], "Marimba, xylophone": ["chromatic_percussion"],
    "Glockenspiel": ["chromatic_percussion"], "Vibraphone": ["chromatic_percussion"],
    # 合成器
    "Synthesizer": ["synth_lead", "synth_pad"], "Sampler": ["synth_pad"],
}

MODEL_DIRS = {
    "audioset": (
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resources", "models", "audio-tagger"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models", "audio-tagger"),
    ),
    "ced": (
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "resources", "models", "audio-tagger-ced"),
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "models", "audio-tagger-ced"),
    ),
}
ENV_DIRS = {"audioset": "FUFUMIDI_AUDIO_TAGGER_DIR", "ced": "FUFUMIDI_CED_TAGGER_DIR"}


def _model_file(d):
    for name in ("model.int8.onnx", "model.onnx"):
        if d and os.path.isfile(os.path.join(d, name)):
            return os.path.join(d, name)
    return ""


def find_model_dir(kind="audioset"):
    env = os.environ.get(ENV_DIRS.get(kind, "FUFUMIDI_AUDIO_TAGGER_DIR"))
    if env and os.path.isdir(env):
        return env
    for c in MODEL_DIRS.get(kind, ()):
        c = os.path.abspath(c)
        if _model_file(c):
            return c
    return ""


def labels_path(model_dir=None, kind="audioset"):
    d = model_dir or find_model_dir(kind)
    return os.path.join(d, "class_labels_indices.csv") if d else ""


def load_labels(path=None):
    p = path or labels_path()
    out = {}
    if not p or not os.path.isfile(p):
        return out
    with open(p, encoding="utf-8", newline="") as f:
        for row in csv.reader(f):
            if len(row) >= 3 and row[0].isdigit():
                out[int(row[0])] = row[2].strip().strip('"')
    return out


def groups_from_scores(scores, min_score=0.10, max_groups=10, always_keep=("drums",)):
    """把 标签→概率 映射成有序乐器组（纯函数，可单测）。"""
    agg = {}
    for label, score in (scores or {}).items():
        try:
            sc = float(score)
        except (TypeError, ValueError):
            continue
        for g in AUDIOSET_TO_GROUPS.get(label, ()):
            if sc > agg.get(g, 0.0):
                agg[g] = sc
    keep = [g for g, sc in sorted(agg.items(), key=lambda kv: (-kv[1], kv[0])) if sc >= min_score]
    if any(agg.get(g, 0.0) >= min_score for g in always_keep):
        for g in always_keep:
            if g in agg and g not in keep and agg[g] >= min_score:
                keep.append(g)
    if not keep:
        return [], agg
    return keep[:max_groups], agg


def _read_audio(path, target_sr=16000):
    import soundfile as sf
    y, sr = sf.read(path, dtype="float32", always_2d=False)
    if getattr(y, "ndim", 1) > 1:
        y = y.mean(axis=1)
    if sr != target_sr:
        import librosa
        y = librosa.resample(y, orig_sr=sr, target_sr=target_sr)
        sr = target_sr
    return y, sr


def _fbank(y, sr=16000):
    import torch
    import torchaudio.compliance.kaldi as kaldi
    w = torch.from_numpy(y).float().unsqueeze(0)
    return kaldi.fbank(w, num_mel_bins=80, frame_length=25, frame_shift=10,
                       dither=0.0, snip_edges=False, low_freq=20.0, high_freq=-400.0,
                       remove_dc_offset=True, preemphasis_coefficient=0.97,
                       window_type="povey", round_to_power_of_two=True)


def _ced_feats(y, sr=16000):
    """CED-Small 的预处理：与 CED 官方 onnx 推理脚本对齐。

    16 kHz / 512 点 FFT / 160 hop / 64 mel / fmin=0 / fmax=8000，不做中心填充；
    线性 mel 后转 dB，并做 max-120dB 截断。输出 [1, 64, T]。
    不要换成 kaldi fbank：CED 官方导出用的是 torchaudio 的 MelSpectrogram，
    两者窗函数/归一化不同，onnx 输出会变成全 1e-6 的噪声。
    """
    import numpy as np
    import torch
    import torchaudio.transforms as aud
    wav = torch.from_numpy(np.asarray(y, dtype=np.float32))
    if sr != 16000:
        import torchaudio
        wav = torchaudio.functional.resample(wav, sr, 16000)
    front_end = torch.nn.Sequential(
        aud.MelSpectrogram(f_min=0, sample_rate=16000, win_length=512,
                           center=False, n_fft=512, f_max=8000,
                           hop_length=160, n_mels=64),
        aud.AmplitudeToDB(top_db=120),
    )
    mel = front_end(wav).unsqueeze(0).numpy().astype(np.float32)
    return mel


class Tagger:
    def __init__(self, model_dir=None, kind="audioset"):
        self.kind = "ced" if kind == "ced" else "audioset"
        self.model_dir = model_dir or find_model_dir(self.kind)
        self.labels = load_labels(os.path.join(self.model_dir, "class_labels_indices.csv"))
        self._sess = None
        self._input_names = []

    def available(self):
        try:
            import onnxruntime  # noqa: F401
            return bool(self.model_dir and self.labels and _model_file(self.model_dir))
        except Exception:
            return False

    def _session(self):
        if self._sess is None:
            import onnxruntime as ort
            opts = ort.SessionOptions()
            try:
                opts.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
                opts.inter_op_num_threads = 1
            except Exception:
                pass
            self._sess = ort.InferenceSession(
                _model_file(self.model_dir),
                sess_options=opts, providers=["CPUExecutionProvider"])
            self._input_names = [x.name for x in self._sess.get_inputs()]
        return self._sess

    def _feeds(self, seg, sr):
        import numpy as np
        sess = self._session()
        if self.kind == "ced":
            x = _ced_feats(seg, sr)
            return {self._input_names[0]: x}
        fb = _fbank(seg, sr)
        x = fb.numpy()[None, :, :].astype("float32")
        return {"x": x, "x_lens": np.array([x.shape[1]], dtype="int64")}

    def tag_windows(self, y, sr=16000, window_sec=10.0, hop_sec=5.0):
        """逐 10s 窗口推理，返回 {label: max_prob}。"""
        sess = self._session()
        win = int(window_sec * sr)
        hop = int(hop_sec * sr)
        scores = {}
        if len(y) <= win:
            starts = [0]
        else:
            starts = list(range(0, max(1, len(y) - win + 1), max(1, hop)))
            if starts[-1] + win < len(y):
                starts.append(len(y) - win)
        for st in starts:
            seg = y[st:st + win]
            if len(seg) < sr // 2:
                continue
            out = sess.run(None, self._feeds(seg, sr))[0][0]
            for idx, prob in enumerate(out.tolist()):
                label = self.labels.get(idx)
                if label and prob > scores.get(label, 0.0):
                    scores[label] = float(prob)
        return scores

    def probe_groups(self, wav_path, min_score=0.10, max_groups=10, max_windows=None, window_sec=10.0):
        """返回 (groups, score_map, reason)。

        window_sec 是单个模型窗口（强制 <=10s）；max_windows=None 表示
        扫描整首的所有 10s 窗口，否则均匀抽 N 个窗口。调用方把
        「探测总长度」换算成窗口数（60s -> 6 个 10s 窗口）。
        """
        try:
            y, sr = _read_audio(wav_path)
            win_sec = max(1.0, min(10.0, float(window_sec)))
            if max_windows:
                win = int(win_sec * sr)
                n = max(1, int(max_windows))
                if len(y) > win:
                    starts = [int(round(i * (len(y) - win) / max(1, n - 1))) for i in range(n)] if n > 1 else [0]
                    parts = [y[max(0, st):st + win] for st in starts]
                    scores = {}
                    for part in parts:
                        sc = self.tag_windows(part, sr, window_sec=win_sec)
                        for k, v in sc.items():
                            if v > scores.get(k, 0.0):
                                scores[k] = v
                else:
                    scores = self.tag_windows(y, sr, window_sec=win_sec)
            else:
                scores = self.tag_windows(y, sr, window_sec=win_sec)
            groups, agg = groups_from_scores(scores, min_score=min_score, max_groups=max_groups)
            return groups, agg, "ok"
        except Exception as e:  # noqa: BLE001
            return [], {}, (self.kind + "-tagger: " + str(e)[:180])

_DEFAULT = {}


def default_tagger(kind="audioset"):
    k = "ced" if kind == "ced" else "audioset"
    if k not in _DEFAULT:
        _DEFAULT[k] = Tagger(kind=k)
    return _DEFAULT[k]


def get_tagger(kind="audioset"):
    return default_tagger(kind)


def available(kind="audioset"):
    try:
        return default_tagger(kind).available()
    except Exception:
        return False
