# -*- coding: utf-8 -*-
"""
UTAU 式歌声合成引擎（P3 · M1 最小闭环）
================================================================
打通「音源采样 → oto.ini 切分 → 变调变速 → 拼接合成」全链路。
M1 范围：加载音源 + oto.ini，渲染单个音节为 WAV。

用法（CLI）：
    python engine_utau.py render --voicebank <音源目录> --lyric か \
        --note C4 --length 500 --out out.wav [--sample-note G3]

输出协议（与 music2midi.py 一致）：
    stdout 仅打印 `###RESULT {json}`；警告/提示走 stderr。
"""

import argparse
import json
import os
import re
import sys

import numpy as np

VERSION = "0.1.0"
SAMPLE_RATE = 44100

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

    def aliases(self):
        return sorted(self.by_alias)

    def get(self, lyric: str) -> OtoEntry:
        """按歌词（别名）查找原音；不存在时报错并提示可用项。"""
        entry = self.by_alias.get(lyric)
        if entry is None:
            # 兼容文件名直接引用
            for e in self.entries:
                if e.filename == lyric or e.filename == lyric + ".wav":
                    entry = e
                    break
        if entry is None:
            sample = ", ".join(self.aliases()[:20])
            raise KeyError(f"音源中未找到歌词「{lyric}」，可用原音（前 20 个）：{sample}")
        return entry

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
    """线性重采样变调：ratio = f_target/f_src，>1 升调且时长缩短。"""
    x = np.asarray(x, dtype=np.float64)
    n_out = max(1, int(round(len(x) / ratio)))
    if n_out == len(x):
        return x.copy()
    xp = np.arange(len(x))
    idx = np.linspace(0, len(x) - 1, n_out)
    return np.interp(idx, xp, x)


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


def _apply_vibrato(x, sr, vib):
    """相位累积重采样实现颤音：音高按正弦在 ±depth_cent 音分内波动。

    vib: {"depth_cent": 25, "freq_hz": 5.5, "delay_ms": 0}
    """
    depth = float(vib.get("depth_cent", 25))
    freq = float(vib.get("freq_hz", 5.5))
    delay_ms = float(vib.get("delay_ms", 0))
    x = np.asarray(x, dtype=np.float64)
    n = len(x)
    if depth <= 0 or freq <= 0 or n < 128:
        return x.copy()
    t = np.arange(n, dtype=np.float64) / sr
    # 正弦相位：sin>0 时推进速率 <1（源读得慢→音高降低），形成 ±depth 音分的波动
    phase = np.sin(2.0 * np.pi * freq * np.maximum(t - delay_ms / 1000.0, 0.0))
    adv = 2.0 ** (-depth * phase / 1200.0)
    idx = np.cumsum(adv) - 1.0
    j = np.floor(idx).astype(np.int64)
    frac = idx - j
    j = np.clip(j, 0, n - 2)
    return x[j] * (1.0 - frac) + x[j + 1] * frac


def _stretch_vowel(shifted, cons_n, target_n, sr):
    """把变调后的片段调整到目标时长。

    规则（CV 模型）：辅音区（cons_n 之前）不拉伸；元音区在不足时长时
    用零交叉对齐的循环填充，过长时尾部淡出截断。
    """
    n = len(shifted)
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


def render_note(sample, entry, ratio, length_ms, volume=100.0, velocity=100.0,
                attack_ms=5, release_ms=12, vibrato=None, sr=SAMPLE_RATE):
    """渲染单个音节：切分有效区 → 变调 → 子音速度 → 拉伸/循环 → 颤音 → 包络 → 音量。

    参数：
      sample    float32 单声道采样
      entry     oto.ini 原音设定
      ratio     f_target / f_sample
      length_ms 音符目标时长（ms）
      velocity  子音速度 0-200（辅音区时长缩放，100=不变）
      vibrato   {"depth_cent","freq_hz","delay_ms"} 或 None
    """
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
        raise ValueError(f"原音「{entry.alias}」有效区过短（{len(region)} 样本），请检查 oto.ini")

    # 变调（辅音区随整体变调但不拉伸）
    shifted = _pitch_resample(region, ratio)
    cons_n = max(0, int(round(entry.consonant * sr / 1000 / ratio)))
    cons_n = min(cons_n, len(shifted) - 1)

    # 子音速度：辅音区时长 ×(100/velocity)。辅音多为无音高噪声，
    # 直接重采样伸缩即可（不改变元音音高）。
    if velocity != 100.0 and velocity > 0 and cons_n > 1:
        v = max(0.01, velocity / 100.0)
        con_st = _pitch_resample(shifted[:cons_n], v)
        shifted = np.concatenate([con_st, shifted[cons_n:]])
        cons_n = len(con_st)

    target_n = max(1, int(round(length_ms * sr / 1000)))
    out = _stretch_vowel(shifted, cons_n, target_n, sr)

    if vibrato:
        out = _apply_vibrato(out, sr, vibrato)

    out = _envelope(out, sr, attack_ms, release_ms)
    if volume != 100.0:
        out = out * (volume / 100.0)
    return out.astype(np.float32)


def render_track(vb, notes, sample_note="C4", sr=SAMPLE_RATE):
    """渲染多音节音轨：按 preutterance 对齐音符起点 + overlap 交叉淡化拼接。

    notes: [{"lyric","note","length_ms","velocity","volume",
             "attack_ms","release_ms","vibrato"}]（后四项可省略）
    返回 float32 单声道数组。
    """
    f_sample = note_to_hz(sample_note)
    pieces = []
    note_start = 0.0
    for nd in notes:
        entry = vb.get(nd["lyric"])
        sample = vb.load_sample(entry)
        ratio = note_to_hz(nd["note"]) / f_sample
        length_ms = float(nd.get("length_ms", 500))
        velocity = float(nd.get("velocity", 100.0))
        x = render_note(
            sample, entry, ratio, length_ms,
            volume=float(nd.get("volume", 100.0)),
            velocity=velocity,
            attack_ms=float(nd.get("attack_ms", 5)),
            release_ms=float(nd.get("release_ms", 12)),
            vibrato=nd.get("vibrato"), sr=sr)
        # preutterance 是音符起点锚点（变调 + 子音速度后缩放）
        pre_idx = int(entry.preutterance * sr / 1000 / ratio
                      * 100.0 / max(velocity, 1.0))
        pieces.append((int(note_start * sr / 1000) - pre_idx, x))
        note_start += length_ms

    # 整体平移，使首音的前置辅音不越界
    shift = -min(p for p, _ in pieces)
    pieces = [(p + shift, x) for p, x in pieces]
    total = max(p + len(x) for p, x in pieces)
    buf = np.zeros(total, dtype=np.float32)
    for p, x in pieces:
        buf[p:p + len(x)] = x

    # overlap 交叉淡化：后音头部（overlap 区）与前音尾部淡出淡入
    for i in range(len(pieces) - 1):
        p1, x1 = pieces[i]
        p2, x2 = pieces[i + 1]
        entry2 = vb.get(notes[i + 1]["lyric"])
        ratio2 = note_to_hz(notes[i + 1]["note"]) / f_sample
        vel2 = float(notes[i + 1].get("velocity", 100.0))
        fade_n = int(entry2.overlap * sr / 1000 / ratio2
                      * 100.0 / max(vel2, 1.0))
        f0 = p2
        f1 = min(p2 + fade_n, p1 + len(x1))
        if f1 - f0 < 2:
            continue
        a0, a1 = f0 - p1, f1 - p1
        b0, b1 = f0 - p2, f1 - p2
        alpha = np.linspace(0.0, 1.0, f1 - f0, dtype=np.float32)
        buf[f0:f1] = (x1[a0:a1] * (1.0 - alpha)
                      + x2[b0:b1] * alpha).astype(np.float32)
    return buf


# ---------------------------------------------------------------- CLI
def _print_result(res):
    print(f"###RESULT {json.dumps(res, ensure_ascii=False)}")


def cmd_render(args):
    try:
        vb = Voicebank(args.voicebank)
        entry = vb.get(args.lyric)
        sample = vb.load_sample(entry)

        f_target = note_to_hz(args.note)
        f_sample = note_to_hz(args.sample_note)
        ratio = f_target / f_sample

        vibrato = None
        if args.vibrato:
            vibrato = json.loads(args.vibrato)

        out = render_note(sample, entry, ratio, args.length,
                          volume=args.volume, velocity=args.velocity,
                          vibrato=vibrato)

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

        buf = render_track(vb, notes, sample_note=args.sample_note)

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
        })
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
    r.add_argument("--out", required=True, help="输出 WAV 路径")
    r.set_defaults(func=cmd_render)

    t = sub.add_parser("render-track", help="渲染多音节音轨为 WAV")
    t.add_argument("--voicebank", required=True, help="音源目录（含 oto.ini）")
    t.add_argument("--notes", required=True,
                   help="音符 JSON 数组（或以 @ 开头的 JSON 文件路径）")
    t.add_argument("--sample-note", default="C4", help="音源录制音高")
    t.add_argument("--out", required=True, help="输出 WAV 路径")
    t.set_defaults(func=cmd_render_track)

    return parser


def main():
    args = build_parser().parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
