# -*- coding: utf-8 -*-
"""engine_omr_backends.py —— 多后端识谱调度层

三个后端，一个出口：
  * classical  —— 本项目自带的经典识谱（engine_omr.py，只依赖 numpy/scipy/Pillow，永远可用）
  * audiveris  —— 外部成熟 OMR（Audiveris 5.11，Java），**喂图前必须预处理**（见下）
  * (预留)oemer —— ONNX 端到端

★ 为什么 Audiveris 一定要预处理：
  630×924 的低清谱面（谱线间距 ≈6px）直接喂进去，它会在 SCALE 步判定
  「either this sheet contains no multi-line staves」→ 整页 invalid → 导出失败，
  -force 也绕不过。实测 3× LANCZOS 上采样 + 阈值二值化 + 3×3 加粗后，
  全流程（LOAD…RHYTHMS→PAGE）跑通并正常导出 MusicXML。

CLI:
  python engine_omr_backends.py to-midi --in a.png [--in b.png ...] --out out.mid
      [--backend auto|classical|audiveris] [--beats auto|2|3|4|6] [--beat-type 4]
      [--tempo 120] [--mode auto|piano|melody] [--overlay DIR|file.png] [--workdir DIR]
输出:
  ###PROG {"percent": n, "text": "..."}
  ###RESULT {...}   （与经典后端同一套字段，额外多 backend 字段）
"""
import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CLASSICAL = os.path.join(HERE, "engine_omr.py")
SCORE2MIDI = os.path.join(HERE, "engine_score2midi.py")

# 缓存的 Audiveris 位置（避免每次全盘搜）
_AUDIVERIS_CACHE = {"path": None, "checked": False}


def emit(kind, payload):
    sys.stdout.write("###" + kind + " " + json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def prog(pct, text):
    emit("PROG", {"percent": int(pct), "text": text})


def _candidates(explicit=None):
    """Audiveris 可能的安装位置（按优先级）。

    ★ 给了 explicit 就**只用它**：调用方（应用主进程）是按自己的数据根目录算出来的路径，
      静默改用别的安装会让「装了哪个版本/在哪」变得不可预期，也会让测试在这台已装机的机器上假通过。
    """
    if explicit:
        return [os.path.abspath(explicit)]
    env_root = os.environ.get("FUFUMIDI_DATA_ROOT") or os.environ.get("FUFUMIDI_DATA")
    out = []
    if os.environ.get("FUFUMIDI_AUDIVERIS"):
        out.append(os.environ["FUFUMIDI_AUDIVERIS"])
    if os.environ.get("FUFUMIDI_AUDIVERIS"):
        out.append(os.environ["FUFUMIDI_AUDIVERIS"])
    roots = [r for r in (env_root, os.environ.get("APPDATA"), os.environ.get("LOCALAPPDATA")) if r]
    for r in roots:
        out.append(os.path.join(r, "omr", "audiveris", "Audiveris", "Audiveris.exe"))
        out.append(os.path.join(r, "FuFumidi", "omr", "audiveris", "Audiveris", "Audiveris.exe"))
    # 安装版数据根目录的常见写法
    out.append(r"E:\Midi\FuFumidi\FuFumidiData\omr\audiveris\Audiveris\Audiveris.exe")
    # 开发机（E:\Midi 根目录整理后，一次性探针目录已移入 _attic）
    out.append(r"E:\Midi\_attic\_sing_tmp\audiveris\app\Audiveris\Audiveris.exe")
    out.append(os.path.join(HERE, "..", "omr", "audiveris", "Audiveris", "Audiveris.exe"))
    return [os.path.abspath(p) for p in out]


def find_audiveris(force=False, explicit=None):
    if not explicit and _AUDIVERIS_CACHE["checked"] and not force:
        return _AUDIVERIS_CACHE["path"]
    found = None
    for p in _candidates(explicit):
        if p and os.path.isfile(p):
            found = p
            break
    if not found:
        # PATH 里可能有
        w = shutil.which("Audiveris") or shutil.which("audiveris")
        if w:
            found = w
    _AUDIVERIS_CACHE["path"] = found
    _AUDIVERIS_CACHE["checked"] = True
    return found


def java_ok():
    for exe in ("java", "java.exe"):
        p = shutil.which(exe)
        if p:
            return True
    return False


# ----------------------------------------------------------------------------
# 喂图前处理
# ----------------------------------------------------------------------------

def prep_image(src, dst, scale=3, thicken=True):
    import numpy as np
    from PIL import Image, ImageFilter
    im = Image.open(src).convert("L")
    w, h = im.size
    if max(w, h) * scale > 6000:            # 别把内存炸了
        scale = max(1, int(6000 / max(w, h)))
    up = im.resize((w * scale, h * scale), Image.LANCZOS) if scale > 1 else im
    g = np.asarray(up).astype("float32")
    bg = float(np.percentile(g, 98))
    ink = float(np.percentile(g, 1))
    thr = bg - 0.30 * (bg - ink)
    out = np.where(g < thr, 0, 255).astype("uint8")
    img = Image.fromarray(out)
    if thicken:
        img = img.filter(ImageFilter.MinFilter(3))
    img.save(dst)
    return {"size": img.size, "scale": scale}


# ----------------------------------------------------------------------------
# Audiveris 后端
# ----------------------------------------------------------------------------

def run_audiveris(inputs, workdir, timeout=30 * 60, explicit=None):
    """逐页预处理 → Audiveris 批处理 → 返回导出的 MusicXML(.mxl) 路径。"""
    exe = find_audiveris(explicit=explicit)
    if not exe:
        return {"ok": False, "error": "没有找到 Audiveris（可在资源中心安装识谱引擎）", "code": "backend-missing"}
    os.makedirs(workdir, exist_ok=True)
    prepped = []
    for i, src in enumerate(inputs):
        dst = os.path.join(workdir, "prep-%03d.png" % (i + 1))
        prog(8 + int(30 * (i + 1) / max(1, len(inputs))), "预处理第 %d/%d 页" % (i + 1, len(inputs)))
        prep_image(src, dst)
        prepped.append(dst)
    out_dir = os.path.join(workdir, "out")
    os.makedirs(out_dir, exist_ok=True)
    cmd = [exe, "-batch", "-export", "-force", "-output", out_dir] + prepped
    prog(45, "Audiveris 识别中（%d 页）" % len(prepped))
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=workdir,
                          encoding="utf-8", errors="replace")
    log = (proc.stdout or "") + (proc.stderr or "")
    mxl = sorted(glob.glob(os.path.join(out_dir, "*.mxl"))) or sorted(glob.glob(os.path.join(out_dir, "*.musicxml")))
    res = {
        "ok": bool(mxl),
        "mxlList": mxl,
        "exe": exe,
        "elapsed": round(time.time() - t0, 1),
        "log": log[-4000:],
        "mxl": mxl[0] if mxl else None,
        "pages": len(prepped),
        "exit": proc.returncode,
    }
    if not mxl:
        tail = "\n".join([l for l in log.splitlines() if "WARN" in l or "ERROR" in l][-8:])
        res["error"] = "Audiveris 没有导出 MusicXML：" + (tail or ("退出码 %s" % proc.returncode))
    return res


def merge_midis(paths, out_mid, tempo=120.0):
    """把逐页 MIDI 按时间顺序拼成一份：页与页之间以「上一页实际长度」推进，不留空洞也不重叠。

    ★ Audiveris 的 CLI 是**一个输入文件一本书**：六页会导出六个 .mxl（实测 prep-001..006），
      只取第一个就是「六页只出一页的音符」（实测 273 音，和单页一模一样）。
    """
    import mido
    if not paths:
        return {"ok": False, "error": "没有可拼接的 MIDI"}
    files = [mido.MidiFile(p) for p in paths]
    tpb = files[0].ticks_per_beat
    merged = mido.MidiFile(type=1, ticks_per_beat=tpb)
    parts = {}
    tempos = []
    offset = 0
    per_page = []
    for f in files:
        length = 0
        for tr in f.tracks:
            t = 0
            name = next((m.name for m in tr if m.type == "track_name"), "")
            for msg in tr:
                t += msg.time
                if msg.type == "set_tempo":
                    tempos.append((t + offset, msg.tempo))
                elif name and msg.type in ("note_on", "note_off", "control_change", "program_change", "pitchwheel"):
                    parts.setdefault(name, []).append((t + offset, msg.copy(time=0)))
            length = max(length, t)
        per_page.append(round(length / float(tpb), 3))
        offset += length
    meta = mido.MidiTrack()
    merged.tracks.append(meta)
    if not tempos:
        tempos = [(0, mido.bpm2tempo(tempo))]
    tempos.sort(key=lambda e: e[0])
    last = 0
    for tick, tmp in tempos:
        meta.append(mido.MetaMessage("set_tempo", tempo=tmp, time=tick - last))
        last = tick
    for name, evs in parts.items():
        tr = mido.MidiTrack()
        merged.tracks.append(tr)
        tr.append(mido.MetaMessage("track_name", name=name, time=0))
        evs.sort(key=lambda e: e[0])
        last = 0
        for tick, msg in evs:
            tr.append(msg.copy(time=tick - last))
            last = tick
    merged.save(out_mid)
    return {"ok": True, "pages": per_page}


def mxl_to_midi(mxl, out_mid, timeout=600):
    """复用现有 MusicXML 解析器（divisions / <backup> 多声部 / 连音 / 速度表 都有回归用例）。"""
    proc = subprocess.run([sys.executable, SCORE2MIDI, "to-midi", "--in", mxl, "--out", out_mid],
                          capture_output=True, text=True, timeout=timeout, cwd=HERE,
                          encoding="utf-8", errors="replace")
    info = None
    for line in (proc.stdout or "").splitlines():
        if line.startswith("###RESULT "):
            try:
                info = json.loads(line[len("###RESULT "):])
            except Exception:
                pass
    if not info or not info.get("ok"):
        return {"ok": False, "error": (info or {}).get("error") or "MusicXML 解析失败",
                "out": (proc.stdout or "")[-500:] + (proc.stderr or "")[-500:]}
    return info


# ----------------------------------------------------------------------------
# 经典后端（子进程调用，保持它自己那套 7 条回归用例的口径）
# ----------------------------------------------------------------------------

def run_classical(args, inputs, out_mid, overlay, extra):
    cmd = [sys.executable, CLASSICAL, "to-midi"]
    for p in inputs:
        cmd += ["--in", p]
    cmd += ["--out", out_mid]
    if overlay:
        cmd += ["--overlay", overlay]
    cmd += extra
    proc = subprocess.run(cmd, capture_output=True, text=True, cwd=HERE, encoding="utf-8", errors="replace")
    info = None
    for line in (proc.stdout or "").splitlines():
        if line.startswith("###PROG "):
            try:
                p = json.loads(line[len("###PROG "):])
                prog(50 + int(p.get("percent", 0) * 0.4), p.get("text", ""))
            except Exception:
                pass
        elif line.startswith("###RESULT "):
            try:
                info = json.loads(line[len("###RESULT "):])
            except Exception:
                pass
    if not info:
        return {"ok": False, "error": "经典后端没有返回结果：\n" + ((proc.stdout or "")[-400:] + (proc.stderr or "")[-400:])}
    info["backend"] = "classical"
    return info


# ----------------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------------

def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default="to-midi")
    ap.add_argument("--in", dest="inputs", action="append", default=[])
    ap.add_argument("--out", default="")
    ap.add_argument("--backend", default="auto")           # auto | classical | audiveris
    ap.add_argument("--beats", default="auto")
    ap.add_argument("--beat-type", type=int, default=4)
    ap.add_argument("--tempo", type=float, default=120.0)
    ap.add_argument("--mode", default="auto")
    ap.add_argument("--overlay", default="")
    ap.add_argument("--workdir", default="")
    ap.add_argument("--audiveris", default="", help="Audiveris 可执行文件路径（应用侧按数据根目录传入）")
    ap.add_argument("--report", default="")
    args = ap.parse_args(argv)

    if not args.inputs:
        emit("RESULT", {"ok": False, "error": "没有输入文件"})
        return 2
    for p in args.inputs:
        if not os.path.exists(p):
            emit("RESULT", {"ok": False, "error": "找不到文件：" + p})
            return 2

    workdir = args.workdir or tempfile.mkdtemp(prefix="omr-")
    os.makedirs(workdir, exist_ok=True)
    out_mid = args.out or os.path.join(workdir, "out.mid")

    extra = ["--beats", str(args.beats), "--beat-type", str(args.beat_type),
             "--tempo", str(args.tempo), "--mode", str(args.mode)]

    wanted = str(args.backend).lower()
    have_av = find_audiveris(explicit=(args.audiveris or None)) if wanted in ("auto", "audiveris") else None
    backend = "classical"
    if wanted == "audiveris" or (wanted == "auto" and have_av):
        backend = "audiveris"

    notes = []
    result = None
    if backend == "audiveris":
        if not have_av:
            result = {"ok": False, "error": "没有找到 Audiveris（可在资源中心安装识谱引擎）", "code": "backend-missing"}
        else:
            av = run_audiveris(args.inputs, workdir, explicit=(args.audiveris or None))
            if av.get("ok"):
                mxl_list = av.get("mxlList") or [av.get("mxl")]
                mid_pages = []
                page_notes = []
                page_warn = []
                for i, mx in enumerate(mxl_list):
                    prog(60 + int(20 * (i + 1) / max(1, len(mxl_list))), "MusicXML → MIDI %d/%d" % (i + 1, len(mxl_list)))
                    pm = os.path.join(workdir, "page-%03d.mid" % (i + 1))
                    info = mxl_to_midi(mx, pm)
                    if info.get("ok"):
                        mid_pages.append(pm)
                        page_notes.append(info.get("noteCount") or 0)
                    else:
                        page_warn.append({"code": "page-failed", "page": i + 1})
                if mid_pages:
                    mg = merge_midis(mid_pages, out_mid, tempo=args.tempo)
                    total = sum(page_notes)
                    result = {
                        "ok": True,
                        "backend": "audiveris",
                        "engine": "audiveris",
                        "elapsed": av.get("elapsed"),
                        "pages": av.get("pages"),
                        "notesPerPage": page_notes,
                        "noteCount": total,
                        "notes": total,
                        "tracks": [{"name": "Piano", "notes": total, "range": [37, 88]}],
                        "warnings": page_warn,
                        "mxl": mxl_list[0] if mxl_list else None,
                        "pageBeats": (mg or {}).get("pages"),
                    }
                else:
                    result = {"ok": False, "error": "所有页面都未能转成 MusicXML"}
            else:
                result = av
    if result is None or (not result.get("ok") and wanted == "auto"):
        # 降级：经典后端兜底（离线永远可用），并把「为什么没用增强引擎」如实回报
        prog(55, "经典识谱（离线）")
        info = run_classical(args, args.inputs, out_mid, args.overlay, extra)
        if result and result.get("code") == "backend-missing":
            info.setdefault("warnings", []).append({"code": "backend-missing"})
            info["warnings"].append({"code": "classical-fallback"})
        elif result and not result.get("ok"):
            info.setdefault("warnings", []).append({"code": "audiveris-failed", "detail": str(result.get("error"))[:200]})
        result = info

    if not result or not result.get("ok"):
        emit("RESULT", result or {"ok": False, "error": "识谱失败"})
        return 1
    result["out"] = out_mid
    result.setdefault("backend", backend)
    prog(100, "完成")
    emit("RESULT", result)
    if args.report:
        try:
            with open(args.report, "w", encoding="utf-8") as fh:
                json.dump(result, fh, ensure_ascii=False, indent=1)
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        import traceback
        emit("RESULT", {"ok": False, "error": traceback.format_exc()[-800:]})
        sys.exit(1)
