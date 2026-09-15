# -*- coding: utf-8 -*-
"""
UTAU 式歌声合成引擎
================================================================
链路：音源采样 → oto.ini 切分 → 辅音区伸缩 → 保共振峰变调 → 频谱整形 →
      气声/性别 → 时长拉伸 → 音高曲线/颤音 → 包络 → 输出。

v0.2.0 专业化要点（对齐 UTAU resampler 的既有约定）：
  1. 变调改为 TD-PSOLA（基音同步叠加）：音高改变而共振峰不动，
     大跨度音程不再"花栗鼠/恶魔"；`N` flag 或检测不到基音时回退线性重采样。
  2. 辅音区（固定范围）不做变调，改用 OLA 时域伸缩（保持频谱），
     子音速度 velocity 与 `a` flag 都作用在这里。
  3. flags 真正生效：g B b t a Y H h C D E c P F L N（语义见 FLAG_SPECS）。
     未支持的 flag 不静默忽略，会在结果 warnings 里列出。
  4. 颤音支持渐入（fade_ms）并只作用于元音区；拼接用等功率交叉淡化；去直流。
  5. 未知歌词默认回退到首个原音并在 warnings 里提示；--strict 则直接报错。

用法（CLI）：
    python engine_utau.py render --voicebank <音源目录> --lyric か \
        --note C4 --length 500 --out out.wav [--sample-note G3] [--flags "g-10B60"]
    python engine_utau.py flags          # 列出支持的 flags（供 UI 展示）

输出协议（与 music2midi.py 一致）：
    stdout 仅打印 `###RESULT {json}`；警告/提示走 stderr。
"""

import argparse
import json
import os
import re
import sys
import traceback

import numpy as np

VERSION = "0.2.0"
SAMPLE_RATE = 44100


# ---------------------------------------------------------------- flags
# 语义对齐 UTAU 默认 resampler（见 utau.wikidot.com/flags 与社区 flags 一览）。
# key 为 flag 字母，大小写敏感（H/h、B/b、C/c 含义不同）。
FLAG_SPECS = {
    "g": {"def": 0, "min": -100, "max": 100, "desc": "共振峰/性别：正数更粗更男，负数更细更女"},
    "B": {"def": 50, "min": 0, "max": 100, "desc": "气声（合成前，受其它滤波影响）"},
    "b": {"def": 0, "min": 0, "max": 100, "desc": "气声（合成后，不受共振峰滤波影响）"},
    "t": {"def": 0, "min": -100, "max": 100, "desc": "音高微调，单位 10 音分"},
    "a": {"def": 100, "min": 1, "max": 400, "desc": "辅音区伸缩：<100 拉伸，>100 压缩"},
    "Y": {"def": 100, "min": 0, "max": 100, "desc": "辅音气声比例：越小辅音气声越强（咬字更清晰）"},
    "H": {"def": 0, "min": 0, "max": 99, "desc": "低通：强调低频、削高频（抑制高音金属噪）"},
    "h": {"def": 0, "min": 0, "max": 99, "desc": "H 的变体：强调高频（不动气声成分）"},
    "C": {"def": 0, "min": 0, "max": 100, "desc": "低通：100 时 0kHz=100%、11kHz=50%、22kHz=0%"},
    "c": {"def": 50, "min": 0, "max": 100, "desc": "C 的共振峰前版本"},
    "D": {"def": 0, "min": 0, "max": 100, "desc": "削中频：100 时 0kHz=100%、11kHz=0%、22kHz=100%"},
    "E": {"def": 0, "min": 0, "max": 100, "desc": "削低高频：100 时 0kHz=100%、7.1kHz=0%、11kHz=100%、22kHz=0%"},
    "P": {"def": 86, "min": 0, "max": 100, "desc": "压限器：100 = 不动，越小越均衡音量起伏"},
    "F": {"def": None, "min": 0, "max": 40, "desc": "共振峰滤波强度（截止 = 采样基频 × F），显式给出才启用"},
    "L": {"def": None, "min": 0, "max": 100, "desc": "共振峰滤波固定频率（截止 = 170Hz × L），优先于 F"},
    "N": {"def": None, "min": None, "max": None, "desc": "关闭共振峰处理：变调回退线性重采样、不做性别倾斜"},
}
# 已知但不支持的 flag（给出明确提示，不静默吞掉）
FLAG_UNSUPPORTED = {
    "W": "机器人音", "x": "按录制音高调整明亮度", "G": "强制生成 .frq",
    "R": "倒放采样", "S": "线程数", "i": "固定区长度", "v": "辅音速度（请用 velocity）",
    "K": "压低气声", "A": "共振峰滤波强度（fresamp）", "O": "明亮度", "T": "音分制 t（请用 t）",
}
_FLAG_RE = re.compile(r"([A-Za-z])([+-]?\d+(?:\.\d+)?)?")


def parse_flags(text):
    """解析 flags 字符串（如 "g-3B50Y90"）→ ({letter: value}, {letter: raw}, [不支持项])。

    - 无参数 flag（N/W/G/R…）value 为 None；
    - 越界值按 FLAG_SPECS 夹紧；
    - 重复给出同一 flag 时后者生效（与 UTAU 一致）。
    """
    values, given, unsupported = {}, [], []
    for m in _FLAG_RE.finditer(text or ""):
        letter, num = m.group(1), m.group(2)
        if letter not in FLAG_SPECS:
            if letter in FLAG_UNSUPPORTED:
                unsupported.append(letter)
            continue
        given.append(letter)
        if num is None:
            values[letter] = None
            continue
        v = float(num)
        spec = FLAG_SPECS[letter]
        if spec["min"] is not None:
            v = max(spec["min"], min(spec["max"], v))
        values[letter] = v
    return values, given, sorted(set(unsupported))


# ---------------------------------------------------------------- oto.ini
def _decode_text(data: bytes) -> str:
    """oto.ini 等文本按 UTF-8(BOM) / Shift-JIS / UTF-8 依次尝试解码。"""
    for enc in ("utf-8-sig", "shift_jis", "utf-8"):
        try:
            return data.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace")


class OtoEntry:
    """oto.ini 单条原音设定（单位均为 ms，offset 相对文件头，其余相对 offset）。"""

    __slots__ = ("filename", "alias", "offset", "consonant", "blank",
                 "preutterance", "overlap")

    def __init__(self, filename, alias, offset, consonant, blank,
                 preutterance, overlap):
        self.filename = filename
        self.alias = alias or filename
        self.offset = offset
        self.consonant = consonant
        self.blank = blank
        self.preutterance = preutterance
        self.overlap = overlap


def parse_oto_ini(path: str):
    """解析 oto.ini，返回 (alias->OtoEntry, 顺序列表)。

    编码自动识别；跳过空行；别名缺失时回退为文件名。
    """
    with open(path, "rb") as f:
        text = _decode_text(f.read())

    entries = []
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            continue
        # 形如: か.wav=か,20,30,40,30,20
        if "=" not in line:
            continue
        head, params = line.split("=", 1)
        filename = head.strip()
        parts = [p.strip() for p in params.split(",")]
        if len(parts) < 5:
            continue
        alias = parts[0]
        try:
            nums = [float(p) if p not in ("", "None") else 0.0 for p in parts[1:6]]
        except ValueError:
            continue
        offset, consonant, blank, preutterance, overlap = nums[:5]
        entries.append(OtoEntry(filename, alias, offset, consonant,
                                blank, preutterance, overlap))

    by_alias = {}
    for e in entries:
        by_alias.setdefault(e.alias, e)
    return by_alias, entries


# ---------------------------------------------------------------- 音源
class Voicebank:
    """音源：oto.ini + 采样 WAV。采样惰性加载并按需缓存。"""

    def __init__(self, vb_dir: str):
        self.vb_dir = vb_dir
        oto_path = os.path.join(vb_dir, "oto.ini")
        if not os.path.isfile(oto_path):
            raise FileNotFoundError(f"音源缺少 oto.ini：{oto_path}")
        self.by_alias, self.entries = parse_oto_ini(oto_path)
        if not self.entries:
            raise ValueError(f"oto.ini 未解析到任何原音：{oto_path}")
        self._cache = {}
        self.fallbacks = []      # [(歌词, 实际使用的别名)]，供结果 warnings 提示

    def aliases(self):
        return sorted(self.by_alias)

    def get(self, lyric: str, strict: bool = False) -> OtoEntry:
        """按歌词（别名）查找原音。

        strict=False（默认）：找不到时回退到第一个原音并记入 self.fallbacks，
        避免自动切分声库（别名是 001/002 之类）导致整轨渲染失败；
        strict=True：直接报错，便于在 UI 上定位歌词/别名不匹配。
        """
        entry = self.by_alias.get(lyric)
        if entry is None:
            # 兼容文件名直接引用
            for e in self.entries:
                if e.filename == lyric or e.filename == lyric + ".wav":
                    entry = e
                    break
        if entry is None:
            sample = ", ".join(self.aliases()[:20])
            if strict or not self.by_alias:
                raise KeyError(f"音源中未找到歌词「{lyric}」，可用原音（前 20 个）：{sample}")
            fallback = next(iter(self.by_alias.values()))
            self.fallbacks.append((lyric, fallback.alias))
            return fallback
        return entry

    def take_fallbacks(self):
        """取出并清空回退记录（每个音符/整轨渲染结束后生成 warnings）。"""
        out, self.fallbacks = self.fallbacks, []
        return out

    def load_sample(self, entry: OtoEntry):
        """加载采样为 float32 单声道（44100Hz），带缓存。"""
        if entry.filename in self._cache:
            return self._cache[entry.filename]
        import soundfile as sf
        wav_path = os.path.join(self.vb_dir, entry.filename)
        if not os.path.isfile(wav_path):
            raise FileNotFoundError(f"音源采样缺失：{wav_path}")
        data, sr = sf.read(wav_path, dtype="float32", always_2d=True)
        if data.shape[1] > 1:
            data = data.mean(axis=1)
        else:
            data = data[:, 0]
        if sr != SAMPLE_RATE:
            data = _pitch_resample(data, sr / SAMPLE_RATE)
        self._cache[entry.filename] = np.asarray(data, dtype=np.float32)
        return self._cache[entry.filename]


# ---------------------------------------------------------------- DSP
def note_to_hz(note: str) -> float:
    """音名转频率，支持 C4 / G#4 / Bb3 等（C4=60=261.63Hz）。"""
    n = note.strip().replace("♯", "#").replace("♭", "b")
    n = n[0].upper() + n[1:]  # 仅大写字母，保留降号小写（b）
    m = re.match(r"^([A-G][#b]?)(-?\d+)$", n)
    if not m:
        raise ValueError(f"无法解析音名：{note}")
    name, octave = m.groups()
    table = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
    if name.endswith("b"):
        name = table[(table.index(name[0]) - 1) % 12]
    midi = (int(octave) + 1) * 12 + table.index(name)
    return 440.0 * (2.0 ** ((midi - 69) / 12.0))


def _pitch_resample(x, ratio):
    """线性重采样变调：ratio = f_target/f_src，>1 升调且时长缩短。

    仅在无法做基音同步处理时使用（清音、`N` flag、片段过短）。
    整体变速会把共振峰一起搬走，所以这是保底方案而非默认方案。
    """
    x = np.asarray(x, dtype=np.float64)
    n_out = max(1, int(round(len(x) / ratio)))
    if n_out == len(x):
        return x.copy()
    xp = np.arange(len(x))
    idx = np.linspace(0, len(x) - 1, n_out)
    return np.interp(idx, xp, x)


# ------------------------------------------------------- 基音检测（ACF）
_F0_CACHE = {}


def _frame_f0(x, sr, fmin=60.0, fmax=1200.0, frame_ms=40.0, hop_ms=10.0,
              thr=0.32, hint=None):
    """逐帧自相关基音检测，返回 (f0 中位数 Hz, 有声帧占比)。

    用 FFT 计算自相关（O(n log n)），抛物线插值细化峰位；
    hint（采样录制音高）已知时把搜索范围收紧到 ±1.6 倍，避免八度误判。
    同一段采样（同原音、同切分）在整轨里会反复出现，按内容指纹做进程内缓存。
    """
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    key = None
    if n:
        key = (sr, n, round(float(np.abs(x).sum()), 4), round(float(hint or 0), 2))
        hit = _F0_CACHE.get(key)
        if hit is not None:
            return hit
    result = _frame_f0_uncached(x, sr, fmin, fmax, frame_ms, hop_ms, thr, hint)
    if key is not None and len(_F0_CACHE) < 4096:
        _F0_CACHE[key] = result
    return result


def _frame_f0_uncached(x, sr, fmin=60.0, fmax=1200.0, frame_ms=40.0, hop_ms=10.0,
                       thr=0.32, hint=None):
    n = len(x)
    fl = int(sr * frame_ms / 1000)
    hop = max(1, int(sr * hop_ms / 1000))
    if n < fl:
        fl = n
        hop = max(1, n // 4)
    if fl < 32:
        return 0.0, 0.0
    lo_f, hi_f = fmin, fmax
    if hint and hint > 0:
        lo_f = max(fmin, hint / 1.6)
        hi_f = min(fmax, hint * 1.6)
    lo_lag = max(2, int(sr / hi_f))
    hi_lag = min(fl - 2, int(sr / lo_f))
    if hi_lag <= lo_lag + 1:
        return 0.0, 0.0
    win = np.hanning(fl)
    starts = list(range(0, max(1, n - fl + 1), hop))
    f0s = []
    for s in starts:
        seg = x[s:s + fl] * win
        if float(np.max(np.abs(seg))) < 1e-6:
            continue
        spec = np.fft.rfft(seg, 2 * fl)
        acf = np.fft.irfft(spec * np.conj(spec))[:fl]
        if acf[0] <= 1e-12:
            continue
        acf = acf / acf[0]
        band = acf[lo_lag:hi_lag]
        k = int(np.argmax(band))
        if band[k] < thr:
            continue
        # 抛物线插值：用峰两侧的样本细化 lag
        if 0 < k < len(band) - 1:
            a, b, c = float(band[k - 1]), float(band[k]), float(band[k + 1])
            den = a - 2.0 * b + c
            delta = 0.5 * (a - c) / den if abs(den) > 1e-12 else 0.0
        else:
            delta = 0.0
        lag = lo_lag + k + delta
        if lag > 1:
            f0s.append(sr / lag)
    if not f0s:
        return 0.0, 0.0
    return float(np.median(f0s)), len(f0s) / max(1, len(starts))


def _psola_shift(x, sr, ratio, f0):
    """TD-PSOLA 变调：音高 ×ratio、时长不变、共振峰保持。

    做法（基音同步叠加的标准形式）：
      1. 在源采样上按源周期 T 取长度为 2T 的 Hanning 帧（帧内容不动）；
      2. 输出帧间距改为 T/ratio → 叠加后周期变成 T/ratio，音高即为目标音高；
      3. 输出帧数与间距按「时长不变」反推（升调时源帧被复用、降调时被跳过）。
    关键点是帧内容不做重采样 —— 所以帧内的频谱包络（共振峰）保持不动，
    这正是与线性重采样（会把共振峰一起搬走）的本质区别。
    """
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    if abs(ratio - 1.0) < 1e-4:
        return x.copy()
    if n < 256 or f0 <= 0:
        return _pitch_resample(x, ratio)
    period = sr / f0
    win_len = int(round(period * 2))
    if win_len < 16 or win_len * 2 >= n:
        return _pitch_resample(x, ratio)
    win = np.hanning(win_len)
    half = win_len // 2
    pad = win_len
    xp = np.concatenate([np.zeros(pad, dtype=np.float64), x, np.zeros(pad, dtype=np.float64)])
    first = pad + half
    last = pad + n - half
    span = last - first
    if span < period * 2:
        return _pitch_resample(x, ratio)
    n_in = int(round(span / period)) + 1
    marks_in = first + period * np.arange(n_in)
    out_period = period / ratio
    n_out = int(round(span / out_period)) + 1
    marks_out = first + out_period * np.arange(n_out)
    total = int(pad * 2 + n + win_len)
    acc = np.zeros(total, dtype=np.float64)
    wsum = np.zeros(total, dtype=np.float64)
    # 索引全部预先向量化算好（逐样本 round 在整轨里是热点）
    k = np.arange(n_out, dtype=np.float64)
    src_idx = np.rint(k * out_period / period).astype(np.int64)
    np.clip(src_idx, 0, n_in - 1, out=src_idx)
    i0_all = np.rint(marks_in[src_idx]).astype(np.int64) - half
    o0_all = np.rint(marks_out).astype(np.int64) - half
    xp_len = len(xp)
    for j in range(n_out):
        i0 = int(i0_all[j])
        o0 = int(o0_all[j])
        if i0 < 0 or i0 + win_len > xp_len:
            continue
        a0, a1 = 0, win_len
        if o0 < 0:
            a0 = -o0
            o0 = 0
        if o0 + (win_len - a0) > total:
            a1 = a0 + max(0, total - o0)
        if a1 - a0 < 8:
            continue
        acc[o0:o0 + (a1 - a0)] += xp[i0 + a0:i0 + a1] * win[a0:a1]
        wsum[o0:o0 + (a1 - a0)] += win[a0:a1]
    wsum_max = float(np.max(wsum)) if wsum.size else 0.0
    if wsum_max <= 1e-9:
        return _pitch_resample(x, ratio)
    # 只对窗和足够大的位置做归一化，避免边缘被除成噪声
    good = wsum > (0.15 * wsum_max)
    out = np.zeros_like(acc)
    out[good] = acc[good] / wsum[good]
    out[~good] = acc[~good]
    y = out[pad:pad + n]
    if len(y) < n:
        y = np.concatenate([y, np.zeros(n - len(y), dtype=np.float64)])
    return y[:n]


def _ola_stretch(x, sr, factor, win_ms=30.0):
    """时域 OLA 伸缩（保持频谱/音高）：factor>1 变长。

    用于辅音区（固定范围）——辅音是噪声/瞬态，没有音高概念，
    所以按 50% 交叠的 Hanning 帧叠加即可改变时长而不改变音色
    （老实现直接重采样会把辅音整体变速，音色随之变形）。
    """
    x = np.asarray(x, dtype=np.float64)
    if abs(factor - 1.0) < 1e-3 or len(x) < 128:
        return x.copy()
    win_len = int(sr * win_ms / 1000)
    win_len = max(64, min(win_len, len(x)))
    hop_in = win_len // 2
    hop_out = max(1, int(round(hop_in * factor)))
    win = np.hanning(win_len)
    n_out = max(1, int(round(len(x) * factor))) + win_len
    acc = np.zeros(n_out, dtype=np.float64)
    wsum = np.zeros(n_out, dtype=np.float64)
    i = 0
    o = 0
    while i + win_len <= len(x) and o + win_len <= n_out:
        acc[o:o + win_len] += x[i:i + win_len] * win
        wsum[o:o + win_len] += win
        i += hop_in
        o += hop_out
    # 尾部残余（不足一帧）直接补上，保证辅音收尾不被吃掉
    if i < len(x):
        tail = x[i:]
        end = min(n_out, o + len(tail))
        if end > o:
            seg = tail[:end - o]
            acc[o:end] += seg
            wsum[o:end] += 1.0
    wsum_max = float(np.max(wsum)) if wsum.size else 0.0
    if wsum_max <= 1e-9:
        return _pitch_resample(x, 1.0 / factor)
    good = wsum > (0.05 * wsum_max)
    out = acc.copy()
    out[good] = acc[good] / wsum[good]
    n_keep = max(1, int(round(len(x) * factor)))
    return out[:n_keep]


def _spectral_gain(x, sr, curve, amount=1.0):
    """按 (频率, 线性增益) 折线做频域幅度整形（在增益域线性插值）。

    curve 例：[(0, 1.0), (11000, 0.5), (22050, 0.0)] 即 UTAU C flag 的定义。
    amount 为 0 时等于不改动，用于把「完全生效」与「原样」按参数量混合。
    """
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    if amount <= 0.0 or n < 64:
        return x
    amount = min(1.0, float(amount))
    f = np.fft.rfftfreq(n, 1.0 / sr)
    fx = np.array([p[0] for p in curve], dtype=np.float64)
    gx = np.array([max(1e-6, p[1]) for p in curve], dtype=np.float64)
    g = np.interp(f, fx, gx)
    g = np.clip(g, 1e-3, 10.0)
    g = g ** amount
    spec = np.fft.rfft(x)
    return np.fft.irfft(spec * g, n=n)


def _dc_remove(x):
    """去直流：拼接/滤波后残留的直流偏置会在音符边界产生咔哒声。"""
    x = np.asarray(x, dtype=np.float64)
    if len(x) == 0:
        return x
    return x - float(np.mean(x))


def _soft_limit(x, ceiling=0.99, knee_ratio=0.7):
    """软限幅（软膝 + tanh 过渡）：膝点以下完全透明，以上平滑压到上限。

    只用 tanh 处理超过膝点的少量样本，比全段 tanh 快数倍，
    听感上也不会像硬限幅那样产生刺耳失真。
    """
    x = np.asarray(x, dtype=np.float64)
    if len(x) == 0:
        return x
    peak = float(np.max(np.abs(x)))
    if peak <= ceiling:
        return x
    knee = knee_ratio * ceiling
    over = np.abs(x) > knee
    if not np.any(over):
        return x
    y = x.copy()
    span = max(ceiling - knee, 1e-9)
    a = np.abs(x[over])
    y[over] = np.sign(x[over]) * (knee + span * np.tanh((a - knee) / span))
    return y


def _equal_power_crossfade(a, b):
    """等功率交叉淡化：a→b 的线性增益过渡在功率上恒定（-3dB 交点）。

    线性淡化在拼接处会掉约 3dB（听感上是个小凹坑），等功率淡化没有这个问题。
    """
    m = len(a)
    if m <= 0:
        return np.zeros(0, dtype=np.float64)
    t = np.linspace(0.0, 1.0, m, dtype=np.float64)
    fade_out = np.cos(t * np.pi / 2.0)
    fade_in = np.sin(t * np.pi / 2.0)
    return a * fade_out + b * fade_in


def _first_zero_crossing(x, start=0):
    for i in range(start, len(x) - 1):
        if x[i] * x[i + 1] < 0:
            return i + 1
    return start


def _last_zero_crossing(x):
    for i in range(len(x) - 2, 0, -1):
        if x[i] * x[i + 1] < 0:
            return i
    return len(x) - 1


def _fade_tail(x, sr, ms=8):
    """尾部淡出防爆音。"""
    n = min(len(x), int(sr * ms / 1000))
    if n <= 0:
        return x
    out = x.copy()
    ramp = np.linspace(1.0, 0.0, n)
    out[-n:] *= ramp
    return out


def _envelope(x, sr, attack_ms=5, release_ms=12):
    """整体起音/释音包络，消除首尾爆音。"""
    out = x.copy()
    a = min(len(out), int(sr * attack_ms / 1000))
    if a > 0:
        out[:a] *= np.linspace(0.0, 1.0, a)
    r = min(len(out), int(sr * release_ms / 1000))
    if r > 0:
        out[-r:] *= np.linspace(1.0, 0.0, r)
    return out


def _apply_vibrato(x, sr, vib, region_start=0):
    """相位累积重采样实现颤音：音高按正弦在 ±depth_cent 音分内波动。

    vib: {"depth_cent": 25, "freq_hz": 5.5, "delay_ms": 0, "fade_ms": 0}
      - delay_ms 之前不抖（长音前的稳定段）；
      - fade_ms 内深度从 0 渐入到 depth（专业调声里颤音是"起来"的，不是瞬间出现）；
      - region_start 之前的样本不抖（通常是辅音区，辅音抖动会听成"卡痰"）。
    """
    depth = float(vib.get("depth_cent", 25) or 0)
    freq = float(vib.get("freq_hz", 5.5) or 0)
    delay_ms = float(vib.get("delay_ms", 0) or 0)
    fade_ms = float(vib.get("fade_ms", 0) or 0)
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    if depth <= 0 or freq <= 0 or n < 128:
        return x.copy()
    t = np.arange(n, dtype=np.float64) / sr
    rel = t - delay_ms / 1000.0
    env = np.clip(rel / max(fade_ms / 1000.0, 1e-6), 0.0, 1.0) if fade_ms > 0 else (rel > 0).astype(np.float64)
    if region_start > 0:
        env[:max(0, int(region_start))] = 0.0
    # 正弦相位：sin>0 时推进速率 <1（源读得慢→音高降低），形成 ±depth 音分的波动
    phase = np.sin(2.0 * np.pi * freq * np.maximum(rel, 0.0))
    adv = 2.0 ** (-depth * env * phase / 1200.0)
    idx = np.clip(np.cumsum(adv) - 1.0, 0.0, float(n - 1))
    j = np.floor(idx).astype(np.int64)
    frac = idx - j
    j2 = np.minimum(j + 1, n - 1)
    return x[j] * (1.0 - frac) + x[j2] * frac


def _apply_cents(ratio, cents):
    """把音分偏移折算进频率比（±100 音分 = 半音）"""
    try:
        c = float(cents or 0.0)
    except (TypeError, ValueError):
        c = 0.0
    if abs(c) < 1e-6:
        return ratio
    return ratio * (2.0 ** (c / 1200.0))


def _apply_pitch_curve(x, sr, points):
    """逐音符手绘音高曲线：把 [{pos(0-1), cents}] 重采样为逐样本音分偏移后变速播放。

    与 _apply_vibrato 同一套相位累积做法，只是偏移量来自曲线而非正弦。
    """
    n = len(x)
    if not points or n < 128:
        return x
    pts = sorted([p for p in points if isinstance(p, dict)], key=lambda p: float(p.get("pos", 0)))
    if len(pts) < 2:
        return x
    pos = np.clip(np.array([float(p.get("pos", 0)) for p in pts], dtype=np.float64), 0.0, 1.0)
    cents = np.clip(np.array([float(p.get("cents", 0)) for p in pts], dtype=np.float64), -2400.0, 2400.0)
    t = np.linspace(0.0, 1.0, n)
    cents_t = np.interp(t, pos, cents)
    # 读取步进：cents 为正 → 读得更快 → 音高升高（步进 2.0 = 快一倍 = 升八度）
    adv = 2.0 ** (cents_t / 1200.0)
    # 索引夹在 [0, n-1]：末样本不能被折成 n-2，否则全零曲线与"不加曲线"不再等价
    idx = np.clip(np.cumsum(adv) - 1.0, 0.0, float(n - 1))
    j = np.floor(idx).astype(np.int64)
    frac = idx - j
    j2 = np.minimum(j + 1, n - 1)
    # 全程保持 float64：内部提前降到 float32 会让"等价路径"出现 1ULP 差异
    return x[j] * (1.0 - frac) + x[j2] * frac


def _limit_peak(x, ceiling=0.99):
    """峰值保护：频谱倾斜/混入噪声这类叠加式处理后限制峰值，避免写 PCM16 时削波。

    只针对数字上限，不按源峰值压制——否则提亮这类操作会让整体响度莫名变小。
    """
    p = float(np.max(np.abs(x))) if len(x) else 0.0
    if p > ceiling > 0:
        x = x * (ceiling / p)
    return x


def _apply_gender(x, sr, v):
    """性别参数（近似共振峰移位）：对频谱做以 1kHz 为枢轴的倾斜。

    v: 0-100，50 = 不变；>50 提亮（更"女声"），<50 变暗（更"男声"）。
    纯 numpy 频域实现，避免引入额外依赖；倾斜后按 RMS 对齐，防止响度突变。
    """
    try:
        k = (float(v) - 50.0) / 50.0
    except (TypeError, ValueError):
        return x
    n = len(x)
    if abs(k) < 0.02 or n < 256:
        return x
    spec = np.fft.rfft(np.asarray(x, dtype=np.float64))
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    # 倾斜量限幅 ±6dB：不限幅时 0/100 两端会把低频抬到削波、把高频削没
    tilt_db = np.clip(k * 6.0 * np.log2(np.maximum(freqs, 20.0) / 1000.0), -6.0, 6.0)
    out = np.fft.irfft(spec * (10.0 ** (tilt_db / 20.0)), n=n)
    rms_src = float(np.sqrt(np.mean(np.asarray(x, dtype=np.float64) ** 2))) or 1e-9
    rms_out = float(np.sqrt(np.mean(out ** 2))) or 1e-9
    return _limit_peak(out * (rms_src / rms_out))


def _apply_breath(x, sr, v):
    """气声：混入 1.5k-7kHz 带通噪声，噪声包络跟随原音（与音节同步）。

    v: 0-100（0 = 关闭）。噪声用固定种子，保证同一工程重复渲染结果一致。
    """
    try:
        amt = float(v) / 100.0
    except (TypeError, ValueError):
        return x
    n = len(x)
    if amt <= 0.005 or n < 256:
        return x
    rng = np.random.RandomState(20240501)
    freqs = np.fft.rfftfreq(n, 1.0 / sr)
    ramp = (np.clip((freqs - 1200.0) / 600.0, 0.0, 1.0)
            * np.clip((8000.0 - freqs) / 1000.0, 0.0, 1.0))
    noise = np.fft.irfft(np.fft.rfft(rng.standard_normal(n)) * ramp, n=n)
    # 包络跟随：粗网格整流 + 一阶平滑 + 线性插值回全长（避免 O(n·win) 卷积）
    hop = max(1, int(sr * 0.005))
    idx = np.arange(0, n, hop)
    coarse = np.abs(np.asarray(x, dtype=np.float64)[idx])
    sm = np.empty_like(coarse)
    acc = 0.0
    for i in range(len(coarse)):
        acc = 0.4 * acc + 0.6 * coarse[i]
        sm[i] = acc
    env = np.interp(np.arange(n), idx, sm)
    peak = float(np.max(env)) or 1e-9
    return _limit_peak(np.asarray(x, dtype=np.float64) + noise * (env / peak) * amt * 0.35)


def _stretch_vowel(shifted, cons_n, target_n, sr):
    """把变调后的片段调整到目标时长。

    规则（CV 模型）：辅音区（cons_n 之前）不拉伸；元音区在不足时长时
    用零交叉对齐的循环填充，过长时尾部淡出截断。
    """
    n = len(shifted)
    if n <= 0:
        return np.zeros(max(1, target_n), dtype=np.float32)
    if target_n <= n:
        return _fade_tail(shifted[:target_n], sr)

    # 元音区起点对齐到最近的零交叉，保证辅音→元音衔接无咔哒
    loop_start = _first_zero_crossing(shifted, start=max(cons_n - 64, 0))
    loop_end = _last_zero_crossing(shifted)
    if loop_end - loop_start < 256:
        loop_start, loop_end = 0, n

    head = shifted[:loop_start]
    loop = shifted[loop_start:loop_end]

    need = target_n - len(head)
    reps = int(np.ceil(need / max(1, len(loop))))
    out = np.concatenate([head] + [loop] * reps)
    return _fade_tail(out[:target_n], sr)


# ------------------------------------------------------- flags → DSP
def _flag_filter_curve(flag, value):
    """H/h/C/c/D/E 的频率增益曲线（点与 UTAU 文档一致）。"""
    nyq = SAMPLE_RATE / 2.0
    if flag in ("C", "c"):
        # 100 时：0kHz=100%、11kHz=50%、22kHz=0%
        return [(0.0, 1.0), (11000.0, 0.5), (nyq, 0.0)]
    if flag == "D":
        # 100 时：0kHz=100%、11kHz=0%、22kHz=100%
        return [(0.0, 1.0), (11000.0, 0.0), (nyq, 1.0)]
    if flag == "E":
        # 100 时：0kHz=100%、7.1kHz=0%、11kHz=100%、22kHz=0%
        return [(0.0, 1.0), (7100.0, 0.0), (11000.0, 1.0), (nyq, 0.0)]
    if flag == "H":
        # 强调低频、削高频：最深 -12dB
        deepest = 10.0 ** (-12.0 * (value / 99.0) / 20.0)
        return [(0.0, 1.0), (250.0, 1.0), (nyq, deepest)]
    if flag == "h":
        # 强调高频、削低频：最深 -12dB
        deepest = 10.0 ** (-12.0 * (value / 99.0) / 20.0)
        return [(0.0, deepest), (350.0, 1.0), (nyq, 1.0)]
    return [(0.0, 1.0)]


def _apply_flag_filters(x, sr, flags):
    """H/h/C/c/D/E 组合滤波：逐条把曲线乘进频谱（等价于串联）。"""
    out = np.asarray(x, dtype=np.float64)
    for flag in ("c", "C", "D", "E", "H", "h"):
        if flag not in flags or flags[flag] is None:
            continue
        v = float(flags[flag])
        amount = (v / 100.0) if flag in ("C", "c", "D", "E") else (v / 99.0)
        if amount <= 0.0:
            continue
        out = _spectral_gain(out, sr, _flag_filter_curve(flag, v), amount)
    return out


def _apply_formant_filter(x, sr, flags, base_hz):
    """F/L：共振峰滤波器（截止 = 采样基频×F 或 170Hz×L）。

    只在显式给出 F/L 时启用——本引擎默认不做这道滤波，
    否则照搬 resampler 的 F3 默认值会把整体音色压闷。
    """
    if "L" in flags and flags["L"] is not None:
        fc = 170.0 * float(flags["L"])
    elif "F" in flags and flags["F"] is not None:
        fc = max(40.0, base_hz) * float(flags["F"])
    else:
        return x
    if fc < 40.0:
        return x
    n = len(x)
    if n < 64:
        return x
    f = np.fft.rfftfreq(n, 1.0 / sr)
    # 一阶高通形状：f/√(f²+fc²) 的补（截止以下逐渐被削弱）
    hp = f / np.sqrt(f ** 2 + fc ** 2)
    spec = np.fft.rfft(np.asarray(x, dtype=np.float64))
    return np.fft.irfft(spec * hp, n=n)


def _apply_peak_compressor(x, target_peak, p):
    """P flag 压限器：P=100 不动；P 越小越把峰值向 target_peak 收拢。

    按文档「100 时无变化、越小音量起伏越均衡」实现为
    增益 = (target/peak)^((100-P)/100)，RMS 不动，只动峰值。
    """
    if p is None or p >= 100.0:
        return x
    x = np.asarray(x, dtype=np.float64)
    peak = float(np.max(np.abs(x))) if len(x) else 0.0
    if peak <= 1e-9 or target_peak <= 0:
        return x
    k = max(0.0, min(1.0, (100.0 - float(p)) / 100.0))
    return x * ((target_peak / peak) ** k)


def render_note(sample, entry, ratio, length_ms, volume=100.0, velocity=100.0,
                attack_ms=5, release_ms=12, vibrato=None, sr=SAMPLE_RATE,
                pitch_cents=0.0, gender=50.0, breath=0.0, pitch_curve=None,
                flags=None, f0_hint=None, f0_used=None):
    """渲染单个音节。

    管线顺序（v0.2.0）：
      切片(offset/blank) → 辅音/元音切分 → 辅音区 OLA 伸缩(velocity × a) →
      元音区 PSOLA 变调（N/无基音 → 线性重采样）→ 时长拉伸 → 音高曲线 → 颤音(元音区) →
      c/C/D/E/H/h 滤波 → g/F/L 共振峰与性别 → B/b 气声（Y 调辅音比例）→
      P 压限 → 整体包络 → 音量

    参数：
      sample    float32 单声道采样
      entry     oto.ini 原音设定
      ratio     f_target / f_sample
      length_ms 音符目标时长（ms）
      velocity  子音速度 0-200（辅音区时长缩放，100=不变）
      vibrato   {"depth_cent","freq_hz","delay_ms","fade_ms"} 或 None
      pitch_cents 音高偏差（音分，±100 = 半音），叠加在 ratio 上
      gender    性别/明亮度 0-100（50=不变），近似共振峰移位
      breath    气声 0-100（0=关闭）
      pitch_curve 手绘音高曲线 [{"pos":0-1,"cents":音分}]，作用于拼接后的整音节
      flags     UTAU flags 字典（parse_flags 的产物），None = 不用 flags
      f0_hint   采样录制音高（Hz），用于收紧基音检测范围
      f0_used   可选 list，回填实际使用的基音（Hz）便于自检/调试
    """
    flags = flags or {}
    no_formant = "N" in flags
    # t flag：音高微调，单位 10 音分
    if flags.get("t"):
        pitch_cents = float(pitch_cents or 0.0) + float(flags["t"]) * 10.0
    # g flag：共振峰/性别（+ 更男 → 本引擎的 gender 参数更暗）
    if flags.get("g"):
        gender = 50.0 - float(flags["g"]) / 2.0
    # B/b flag：气声（B 合成前、b 合成后）；文档默认 B=50 = 原样
    # UI 的「气声」参数等价于 b（合成后叠加）
    pre_breath = 0.0
    post_breath = float(breath or 0.0)
    if "B" in flags and flags["B"] is not None:
        pre_breath += float(flags["B"]) - 50.0
    if "b" in flags and flags["b"] is not None:
        post_breath += float(flags["b"])
    if "Y" in flags and flags["Y"] is not None and float(flags["Y"]) < 100.0:
        # Y 越小 → 辅音段气声越强（咬字更清晰）
        post_breath *= 1.0 + (100.0 - float(flags["Y"])) / 100.0

    ratio = _apply_cents(ratio, pitch_cents)
    off_s = int(entry.offset * sr / 1000)
    # 右边界：blank>0 从文件尾回退；blank<0 从 offset 起算；0/缺失视为文件尾
    if entry.blank > 0:
        cutoff_s = len(sample) - int(entry.blank * sr / 1000)
    elif entry.blank < 0:
        cutoff_s = off_s + int(-entry.blank * sr / 1000)
    else:
        cutoff_s = len(sample)
    off_s = max(0, min(off_s, len(sample) - 1))
    cutoff_s = max(off_s + 1, min(cutoff_s, len(sample)))

    region = sample[off_s:cutoff_s]
    if len(region) < 64:
        # 自动标注/生成声库可能出现有效区过短；回退使用整段采样，避免渲染直接失败
        region = sample[:]
    if len(region) < 64:
        raise ValueError(f"原音「{entry.alias}」有效区过短（{len(region)} 样本），请检查 oto.ini")
    region = np.asarray(region, dtype=np.float64)

    # ---- 辅音 / 元音切分（未变调前的样本坐标系）
    cons_in = max(0, min(int(round(entry.consonant * sr / 1000)), len(region) - 1))
    consonant = region[:cons_in]
    vowel = region[cons_in:]

    # ---- 辅音区：OLA 时域伸缩（velocity + a flag），不变调、不改变音色
    cons_scale = 100.0 / max(velocity, 1.0)
    if flags.get("a"):
        a = float(flags["a"])
        if a > 0:
            cons_scale *= 100.0 / a
    if consonant.size and abs(cons_scale - 1.0) > 1e-3:
        consonant = _ola_stretch(consonant, sr, cons_scale)
    cons_n = len(consonant)

    # ---- 元音区：TD-PSOLA 变调（保共振峰）；N flag / 无基音 → 线性重采样
    if vowel.size:
        if no_formant:
            vowel = _pitch_resample(vowel, ratio)
        else:
            f0_v, voiced = _frame_f0(vowel, sr, hint=f0_hint)
            if f0_used is not None:
                f0_used.append(round(float(f0_v), 2))
            if f0_v > 0 and voiced >= 0.2:
                vowel = _psola_shift(vowel, sr, ratio, f0_v)
            else:
                vowel = _pitch_resample(vowel, ratio)
    shifted = np.concatenate([consonant, vowel]) if cons_n else vowel
    if shifted.size < 64:
        shifted = _pitch_resample(region, ratio)

    target_n = max(1, int(round(length_ms * sr / 1000)))
    out = _stretch_vowel(shifted, cons_n, target_n, sr)

    # ---- 后续叠加：音高曲线 → 颤音（元音区）→ 滤波 → 共振峰 → 气声 → 压限 → 包络
    curved = _apply_pitch_curve(out, sr, pitch_curve)
    if vibrato:
        out = _apply_vibrato(curved, sr, vibrato, region_start=cons_n)
    else:
        out = curved

    if pre_breath > 0.5:
        out = _apply_breath(out, sr, pre_breath)
    out = _apply_flag_filters(out, sr, flags)
    if not no_formant:
        out = _apply_gender(out, sr, gender)
        out = _apply_formant_filter(out, sr, flags, base_hz=f0_hint or 0.0)
    out = _dc_remove(out)
    if post_breath > 0.5:
        out = _apply_breath(out, sr, post_breath)
    out = _apply_peak_compressor(out, 0.9, flags.get("P") if "P" in flags else None)

    out = _envelope(out, sr, attack_ms, release_ms)
    if volume != 100.0:
        out = out * (volume / 100.0)
    return _soft_limit(out).astype(np.float32)


def _cons_scale(velocity, flags):
    """辅音区时长缩放系数（velocity 与 a flag 共同决定；render_note / render_track 共用）。"""
    s = 100.0 / max(float(velocity or 100.0), 1.0)
    a = (flags or {}).get("a")
    if a:
        try:
            av = float(a)
            if av > 0:
                s *= 100.0 / av
        except (TypeError, ValueError):
            pass
    return s


def render_track(vb, notes, sample_note="C4", sr=SAMPLE_RATE, strict=False):
    """渲染多音节音轨：按 preutterance 对齐音符起点 + overlap 等功率交叉淡化拼接。

    notes: [{"lyric","note","length_ms","velocity","volume","attack_ms","release_ms",
             "vibrato","pitch_cents","gender","breath","pitch_curve","flags"}]（后几项可省略）
    返回 (float32 单声道数组, warnings 列表)。

    时间轴约定（v0.2.0）：变调不再改变时长（PSOLA 保时长），
    所以 preutterance / overlap 只需按辅音伸缩（velocity × a）折算，不再除以音高比。
    """
    f_sample = note_to_hz(sample_note)
    pieces = []
    warnings = []
    note_start = 0.0
    for nd in notes:
        lyric = nd["lyric"]
        entry = vb.get(lyric, strict=strict)
        sample = vb.load_sample(entry)
        flags, _, unsupported = parse_flags(nd.get("flags") or "")
        for u in unsupported:
            msg = f"flag「{u}」（{FLAG_UNSUPPORTED.get(u, '')}）暂不支持，已忽略"
            if msg not in warnings:
                warnings.append(msg)
        # 音高偏差参与变调比（时长不变，故只影响音高）
        ratio = _apply_cents(note_to_hz(nd["note"]) / f_sample, nd.get("pitch_cents"))
        length_ms = float(nd.get("length_ms", 500))
        velocity = float(nd.get("velocity", 100.0))
        try:
            x = render_note(
                sample, entry, ratio, length_ms,
                volume=float(nd.get("volume", 100.0)),
                velocity=velocity,
                attack_ms=float(nd.get("attack_ms", 5)),
                release_ms=float(nd.get("release_ms", 12)),
                vibrato=nd.get("vibrato"), sr=sr,
                gender=nd.get("gender", 50.0),
                breath=nd.get("breath", 0.0),
                pitch_curve=nd.get("pitch_curve"),
                flags=flags, f0_hint=f_sample)
        except Exception as e:
            # 单个原音渲染失败时用静音兜底，避免整轨因广播/空数组崩溃
            warnings.append(f"原音「{lyric}」渲染失败（{type(e).__name__}: {e}），该音符已置为静音")
            x = np.zeros(max(1, int(length_ms * sr / 1000)), dtype=np.float32)
        # preutterance 是音符起点锚点：只受辅音伸缩影响（变调不改时长）
        pre_idx = int(entry.preutterance * sr / 1000 * _cons_scale(velocity, flags))
        pieces.append((int(round(note_start * sr / 1000)) - pre_idx, x))
        note_start += length_ms

    # 整体平移，使首音的前置辅音不越界
    shift = -min(p for p, _ in pieces)
    pieces = [(p + shift, x) for p, x in pieces]
    total = max(p + len(x) for p, x in pieces)
    buf = np.zeros(total, dtype=np.float32)
    for p, x in pieces:
        buf[p:p + len(x)] = x

    # overlap 交叉淡化（等功率，避免拼接处掉 ~3dB）
    for i in range(len(pieces) - 1):
        p1, x1 = pieces[i]
        p2, x2 = pieces[i + 1]
        nd2 = notes[i + 1]
        entry2 = vb.get(nd2["lyric"], strict=strict)
        flags2, _, _ = parse_flags(nd2.get("flags") or "")
        vel2 = float(nd2.get("velocity", 100.0))
        fade_n = int(entry2.overlap * sr / 1000 * _cons_scale(vel2, flags2))
        # 防止 preutterance 过大导致 p2 早于 p1，产生负索引/空切片
        f0 = max(p2, p1)
        f1 = min(p2 + fade_n, p1 + len(x1), p2 + len(x2))
        if f1 - f0 < 2:
            continue
        a0, a1 = f0 - p1, f1 - p1
        b0, b1 = f0 - p2, f1 - p2
        buf[f0:f1] = _equal_power_crossfade(
            np.asarray(x1[a0:a1], dtype=np.float64),
            np.asarray(x2[b0:b1], dtype=np.float64)).astype(np.float32)
    # 歌词回退提示统一在最后收集（音符循环 + 交叉淡化阶段都可能触发）
    for lyric, used in vb.take_fallbacks():
        msg = f"歌词「{lyric}」在原音中不存在，已回退到「{used}」（可用「发音」按钮替换）"
        if msg not in warnings:
            warnings.append(msg)
    return _soft_limit(_dc_remove(buf)).astype(np.float32), warnings


def _frame_env(data, sr, frame_ms=10):
    """短时 RMS 包络。返回 (env, hop)。env[i] 为第 i 帧均方根。"""
    hop = max(1, int(sr * frame_ms / 1000))
    n = len(data)
    frames = max(1, n // hop)
    env = np.zeros(frames)
    x = np.asarray(data, dtype=np.float64)
    for i in range(frames):
        seg = x[i * hop:(i + 1) * hop]
        env[i] = np.sqrt(np.mean(seg ** 2)) if len(seg) else 0.0
    return env, hop


def split_syllables(data, sr, min_silence_ms=120, min_syllable_ms=80,
                    silence_db=-40):
    """按静音间隙把一段音频切成音节段（CV 式逐音节录音适用）。

    返回 [(start_ms, end_ms), ...]（升序、不重叠、按帧对齐）。
    - 能量低于峰值 `silence_db` dB 视为静音；
    - 静音间隔 < min_silence_ms 的前后音节自动合并；
    - 短于 min_syllable_ms 的片段丢弃。
    连续无静音的音频会得到整段一个区域（留给前端手动微调）。
    """
    env, hop = _frame_env(data, sr, frame_ms=10)
    frame_ms = 10.0
    ref = max(float(np.max(env)), 1e-9)
    db = 20.0 * np.log10(np.maximum(env, ref * 1e-6) / ref)
    db = np.clip(db, -200.0, 0.0)
    voice = db > silence_db

    # 连续有声区段
    regions = []
    in_run = False
    for i, v in enumerate(voice):
        if v and not in_run:
            start = i
            in_run = True
        elif not v and in_run:
            regions.append((start, i))
            in_run = False
    if in_run:
        regions.append((start, len(voice)))

    min_sil_f = max(1, int(min_silence_ms / frame_ms))
    min_syl_f = max(1, int(min_syllable_ms / frame_ms))
    merged = []
    for r in regions:
        if merged and (r[0] - merged[-1][1]) < min_sil_f:
            merged[-1] = (merged[-1][0], r[1])
        else:
            merged.append(r)
    merged = [r for r in merged if (r[1] - r[0]) >= min_syl_f]
    return [(r[0] * frame_ms, r[1] * frame_ms) for r in merged]


def auto_oto_params(sample, sr):
    """CV 音源单采样自动标注（启发式）。

    返回 dict: offset/consonant/blank/preutterance/overlap（ms，单位与 oto.ini 一致）。
    判定思路：
      - 有声起止：短时能量（音量法，同 SetParam auto-CV）
      - 辅音→元音边界：过零率 ZCR——噪声/辅音 ZCR 高，元音 ZCR 低，
        元音起点 = ZCR 首次持续 < 阈值的位置（对「元音比辅音响」也稳健）
    """
    x = np.asarray(sample, dtype=np.float64)
    frame_ms = 5.0
    hop = int(sr * frame_ms / 1000)
    n = len(x)
    frames = max(1, n // hop)
    total_ms = n / sr * 1000.0

    env = np.zeros(frames)
    zcr = np.zeros(frames)
    for i in range(frames):
        seg = x[i * hop:(i + 1) * hop]
        env[i] = np.sqrt(np.mean(seg ** 2)) if len(seg) else 0.0
        if len(seg) > 1:
            zcr[i] = np.count_nonzero(np.diff(np.signbit(seg)))

    def _defaults():
        return {"offset": 0.0, "consonant": 50.0, "blank": 20.0,
                "preutterance": 50.0, "overlap": 20.0}

    if float(np.max(env)) <= 1e-12:
        return _defaults()

    floor = float(np.percentile(env, 10)) + 1e-12
    thr = max(floor * 3.0, float(np.max(env)) * 0.02)

    start = next((i for i in range(frames) if env[i] >= thr), 0)
    end = next((i for i in range(frames - 1, -1, -1) if env[i] >= thr), start)
    if end <= start:
        return _defaults()

    # 元音起点：起始后 ZCR 首次连续 3 帧（15ms）低于阈值 = 周期性稳定开始
    vowel_thr = 40.0  # 每 5ms 帧过零数（噪声≈110，元音≈2-20）
    run = 0
    vowel_start = None
    for i in range(start, frames):
        if zcr[i] < vowel_thr:
            run += 1
            if vowel_start is None and run >= 3:
                vowel_start = i - run + 1
        else:
            run = 0
    if vowel_start is None:
        vowel_start = min(start + 8, frames - 1)

    offset_ms = max(0.0, start * frame_ms - 10.0)          # 前置静音留 10ms 余量
    consonant = max(5.0, (vowel_start - start) * frame_ms)  # 相对 offset 的辅音长
    preutterance = consonant                                # 元音起点 = 辅音末
    overlap = min(30.0, preutterance * 0.3)
    end_ms = (end + 1) * frame_ms
    blank = max(5.0, total_ms - end_ms)                     # 尾部静音（文件尾起算）
    return {"offset": round(offset_ms, 1), "consonant": round(consonant, 1),
            "blank": round(blank, 1), "preutterance": round(preutterance, 1),
            "overlap": round(overlap, 1)}


# ---------------------------------------------------------------- CLI
def _print_result(res):
    print(f"###RESULT {json.dumps(res, ensure_ascii=False)}")


def cmd_render(args):
    try:
        vb = Voicebank(args.voicebank)
        entry = vb.get(args.lyric, strict=args.strict)
        sample = vb.load_sample(entry)

        f_target = note_to_hz(args.note)
        f_sample = note_to_hz(args.sample_note)
        ratio = f_target / f_sample

        vibrato = None
        if args.vibrato:
            vibrato = json.loads(args.vibrato)

        flags, flags_given, unsupported = parse_flags(args.flags or "")
        warnings = [f"flag「{u}」（{FLAG_UNSUPPORTED.get(u, '')}）暂不支持，已忽略" for u in unsupported]
        for lyric, used in vb.take_fallbacks():
            warnings.append(f"歌词「{lyric}」在原音中不存在，已回退到「{used}」（可用「发音」按钮替换）")

        f0_used = []
        out = render_note(sample, entry, ratio, args.length,
                          volume=args.volume, velocity=args.velocity,
                          vibrato=vibrato,
                          pitch_cents=args.pitch_cents,
                          gender=args.gender, breath=args.breath,
                          pitch_curve=(json.loads(args.pitch_curve) if args.pitch_curve else None),
                          flags=flags, f0_hint=f_sample, f0_used=f0_used)

        # 写 WAV
        import soundfile as sf
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        sf.write(args.out, out, SAMPLE_RATE, subtype="PCM_16")

        dur_ms = round(len(out) / SAMPLE_RATE * 1000)
        peak = float(np.max(np.abs(out))) if len(out) else 0.0
        rms = float(np.sqrt(np.mean(out.astype(np.float64) ** 2))) if len(out) else 0.0
        _print_result({
            "ok": True,
            "out": os.path.abspath(args.out),
            "lyric": args.lyric,
            "note": args.note,
            "duration_ms": dur_ms,
            "peak": round(peak, 6),
            "rms": round(rms, 6),
            "engine_version": VERSION,
            "flags": flags_given,
            "f0_hz": f0_used[-1] if f0_used else None,
            "warnings": warnings,
        })
    except Exception as e:
        _print_result({"ok": False, "error": f"{type(e).__name__}: {e}"})
        sys.exit(1)


def cmd_render_track(args):
    try:
        vb = Voicebank(args.voicebank)
        raw = args.notes
        if raw.startswith("@"):
            with open(raw[1:], "r", encoding="utf-8") as f:
                notes = json.load(f)
        else:
            notes = json.loads(raw)
        if not isinstance(notes, list) or not notes:
            raise ValueError("音符列表为空或格式错误（应为 JSON 数组）")

        buf, warnings = render_track(vb, notes, sample_note=args.sample_note,
                                     strict=args.strict)

        import soundfile as sf
        os.makedirs(os.path.dirname(os.path.abspath(args.out)) or ".", exist_ok=True)
        sf.write(args.out, buf, SAMPLE_RATE, subtype="PCM_16")
        _print_result({
            "ok": True,
            "out": os.path.abspath(args.out),
            "notes": len(notes),
            "duration_ms": round(len(buf) / SAMPLE_RATE * 1000),
            "peak": round(float(np.max(np.abs(buf))), 6),
            "rms": round(float(np.sqrt(np.mean(buf.astype(np.float64) ** 2))), 6),
            "engine_version": VERSION,
            "warnings": warnings,
        })
    except Exception as e:
        _print_result({"ok": False, "error": f"{type(e).__name__}: {e}\n{traceback.format_exc()}"})
        sys.exit(1)


def cmd_flags(args):
    """列出引擎支持的 flags（含默认值/范围/说明）与已知不支持项，供 UI 展示。"""
    supported = [
        {"flag": k, "default": v["def"], "min": v["min"], "max": v["max"], "desc": v["desc"]}
        for k, v in FLAG_SPECS.items()
    ]
    unsupported = [{"flag": k, "desc": v} for k, v in FLAG_UNSUPPORTED.items()]
    _print_result({
        "ok": True,
        "engine_version": VERSION,
        "supported": supported,
        "unsupported": unsupported,
        "example": "g-10B60t5",
    })


def cmd_aliases(args):
    """列出音源可用别名（可按关键字过滤）：供前端做发音 / 别名替换（P1-4）。"""
    try:
        vb = Voicebank(args.voicebank)
        items = vb.aliases()
        total = len(items)
        q = (args.query or "").strip()
        if q:
            items = [a for a in items if q in a]
        limit = max(1, int(args.limit or 300))
        _print_result({
            "ok": True,
            "count": len(items),
            "total": total,
            "aliases": items[:limit],
            "truncated": len(items) > limit,
        })
    except Exception as e:
        _print_result({"ok": False, "error": f"{type(e).__name__}: {e}"})
        sys.exit(1)


def cmd_segment(args):
    """上传音频 → 静音切分音节段（CV 式录音）。"""
    try:
        from audio_io import load_audio_float32
        data = load_audio_float32(args.input, args.sr)
        segs = split_syllables(data, args.sr,
                               min_silence_ms=args.min_silence,
                               min_syllable_ms=args.min_syllable,
                               silence_db=args.silence_db)
        files = []
        if args.out_dir:
            import soundfile as sf
            os.makedirs(args.out_dir, exist_ok=True)
            for i, (s_ms, e_ms) in enumerate(segs):
                s_i = int(s_ms * args.sr / 1000)
                e_i = int(e_ms * args.sr / 1000)
                path = os.path.join(args.out_dir, f"{i + 1:03d}.wav")
                sf.write(path, data[s_i:e_i], args.sr, subtype="PCM_16")
                files.append(path)
        _print_result({
            "ok": True,
            "input": os.path.abspath(args.input),
            "count": len(segs),
            "segments": [{"start_ms": round(s, 1), "end_ms": round(e, 1)}
                         for s, e in segs],
            "files": files,
        })
    except Exception as e:
        _print_result({"ok": False, "error": f"{type(e).__name__}: {e}"})
        sys.exit(1)


def cmd_auto_oto(args):
    """对采样目录自动生成 oto.ini（CV 启发式标注）。"""
    try:
        import soundfile as sf
        if not os.path.isdir(args.voicebank):
            raise FileNotFoundError(f"音源目录不存在：{args.voicebank}")
        files = sorted(f for f in os.listdir(args.voicebank)
                       if f.lower().endswith(".wav") and not f.startswith("."))
        if not files:
            raise ValueError("目录内没有可标注的 .wav 文件")

        entries = []
        for f in files:
            data, sr = sf.read(os.path.join(args.voicebank, f), dtype="float32")
            if data.ndim > 1:
                data = data.mean(axis=1)
            p = auto_oto_params(np.asarray(data, dtype=np.float32), sr)
            alias = os.path.splitext(f)[0]
            entries.append({"filename": f, "alias": alias, **p})

        lines = [f"{e['filename']}={e['alias']},{e['offset']},{e['consonant']},"
                 f"{e['blank']},{e['preutterance']},{e['overlap']}"
                 for e in entries]
        encoding = "shift_jis" if args.encoding == "shift-jis" else "utf-8"
        out = ""
        if args.out:
            with open(args.out, "w", encoding=encoding, newline="\n") as fh:
                fh.write("\n".join(lines) + "\n")
            out = os.path.abspath(args.out)
        _print_result({"ok": True, "count": len(entries), "out": out,
                       "encoding": encoding, "entries": entries})
    except Exception as e:
        _print_result({"ok": False, "error": f"{type(e).__name__}: {e}"})
        sys.exit(1)


def build_parser():
    parser = argparse.ArgumentParser(
        prog="engine_utau.py",
        description="UTAU 式歌声合成引擎（M2：多音节 + 基础调声）",
        formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--version", action="version", version=f"engine_utau {VERSION}")
    sub = parser.add_subparsers(dest="mode", required=True)

    r = sub.add_parser("render", help="渲染单个音节为 WAV")
    r.add_argument("--voicebank", required=True, help="音源目录（含 oto.ini）")
    r.add_argument("--lyric", required=True, help="歌词/原音别名，如 か")
    r.add_argument("--note", default="C4", help="目标音高，如 C4 / G4")
    r.add_argument("--length", type=int, default=500, help="音符时长(ms)")
    r.add_argument("--sample-note", default="C4", help="音源录制音高")
    r.add_argument("--velocity", type=float, default=100.0, help="子音速度 0-200")
    r.add_argument("--volume", type=float, default=100.0, help="音量(%)")
    r.add_argument("--vibrato", default=None, help="颤音 JSON，如 {\"depth_cent\":25,\"freq_hz\":5.5}")
    r.add_argument("--pitch-cents", type=float, default=0.0, help="音高偏差（音分，±100 = 半音）")
    r.add_argument("--gender", type=float, default=50.0, help="性别/明亮度 0-100（50=不变）")
    r.add_argument("--breath", type=float, default=0.0, help="气声 0-100（0=关闭）")
    r.add_argument("--pitch-curve", default=None,
                   help='手绘音高曲线 JSON，如 [{"pos":0,"cents":0},{"pos":1,"cents":200}]')
    r.add_argument("--flags", default=None,
                   help='UTAU flags，如 "g-10B60t5"（支持 g B b t a Y H h C c D E P F L N）')
    r.add_argument("--strict", action="store_true",
                   help="歌词不在原音表中时直接报错（默认回退到首个原音并在 warnings 提示）")
    r.add_argument("--out", required=True, help="输出 WAV 路径")
    r.set_defaults(func=cmd_render)

    t = sub.add_parser("render-track", help="渲染多音节音轨为 WAV")
    t.add_argument("--voicebank", required=True, help="音源目录（含 oto.ini）")
    t.add_argument("--notes", required=True,
                   help="音符 JSON 数组（或以 @ 开头的 JSON 文件路径）")
    t.add_argument("--sample-note", default="C4", help="音源录制音高")
    t.add_argument("--strict", action="store_true",
                   help="歌词不在原音表中时直接报错（默认回退到首个原音并在 warnings 提示）")
    t.add_argument("--out", required=True, help="输出 WAV 路径")
    t.set_defaults(func=cmd_render_track)

    f = sub.add_parser("flags", help="列出支持的 flags（含默认值/范围/说明）")
    f.set_defaults(func=cmd_flags)

    a = sub.add_parser("aliases", help="列出音源可用别名（可按关键字过滤）")
    a.add_argument("--voicebank", required=True, help="音源目录（含 oto.ini）")
    a.add_argument("--query", default=None, help="关键字过滤（子串匹配）")
    a.add_argument("--limit", type=int, default=300, help="最多返回条数")
    a.set_defaults(func=cmd_aliases)

    s = sub.add_parser("segment", help="按静音间隙切分音频为音节段（CV 式）")
    s.add_argument("--input", required=True, help="音频文件（任意格式）")
    s.add_argument("--sr", type=int, default=44100, help="目标采样率")
    s.add_argument("--min-silence", type=int, default=120,
                   help="最小静音间隔(ms)，小于则前后音节合并")
    s.add_argument("--min-syllable", type=int, default=80,
                   help="最小音节时长(ms)，短于则丢弃")
    s.add_argument("--silence-db", type=float, default=-40,
                   help="静音阈值(dB，相对峰值)")
    s.add_argument("--out-dir", default=None, help="切分片段写出目录（可省略）")
    s.set_defaults(func=cmd_segment)

    o = sub.add_parser("auto-oto", help="对采样目录自动生成 oto.ini（CV 启发式）")
    o.add_argument("--voicebank", required=True, help="音源目录（含 wav 采样）")
    o.add_argument("--out", default=None, help="输出 oto.ini 路径（默认不写盘）")
    o.add_argument("--encoding", default="utf-8", choices=["utf-8", "shift-jis"])
    o.set_defaults(func=cmd_auto_oto)

    return parser


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
