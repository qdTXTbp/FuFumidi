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

#: Audiveris 的硬上限：一张图 > 20,000,000 像素会被直接判 invalid。
#: 实测整页 3 倍放大（32,099,832 px）→ 「Too large image ... Sheet flagged as invalid」→ 导出失败。
# ★ 1600 万而不是 Audiveris 自己的 2000 万：实测 24 行谱表的总谱页在 1900 万像素
#   （×2.3）时抛 OutOfMemoryError: Java heap space（-Xmx8G 与 -swap 都压不住），
#   而同一页降到 ×2.0（约 1430 万）一次就过，且音符数并不更少（235 vs 256）。
#   留 300 万像素的余量给 Audiveris 内部的多份副本。
MAX_PIXELS = 16_000_000
MAX_SIDE = 6000

#: 同尺寸的页共享几何，测过一次行距就够（整本书的排版一致）
_INTERLINE_CACHE = {}

# ----------------------------------------------------------------------------
# M3-2 超分辨率（waifu2x-ncnn-vulkan）—— **用户自行安装**（资源中心）
# ----------------------------------------------------------------------------
#: 为什么是它：Audiveris 官方「改进输入」文档给的正是「神经放大 + 曲线 + 反锐化」这条路。
#: waifu2x-ncnn-vulkan 是单文件 exe（5 MB）+ 3 组模型，39.5 MB 解压后即可用，走 Vulkan
#: （本机 RTX 5070 Ti 实测 1190x1683 页 ×2 只用 3.7 s）。
#: ★ 不用 Real-ESRGAN：它同一份 ncnn 包里 x4plus 权重就 60+ MB，而这里要的是**低清谱**的
#:   2 倍放大，waifu2x 的照片模型实测已足够（见 docs 里的 A/B 表）。
SR_EXE = "waifu2x-ncnn-vulkan.exe"
#: 照片模型（models-upconv_7_photo）：扫描件/拍照件用这一组；anime 组在灰底线稿上会把细谱线
#: 当成「风格」处理，实测同一页音符数明显更少。
SR_MODEL = "models-upconv_7_photo"
#: ★ auto 的门槛：**行距量不出来（= 谱表检测器整页失败）或 < 5px** 才开超分。
#:   为什么不是「< 11px 就开」—— 实测（见 docs/test-reports 第 5 轮 §9 的质量对照，
#:   参照是同一页全分辨率的识别结果，用 (音高,起拍) F1 衡量）：
#:     · 用户的清晰总谱页 1588×2246（interline 6.0，矢量 PDF 渲染的低清页）：
#:       不超分 F1 **1.00**、超分 F1 0.82，而且慢 40 s —— 清晰页超分**有害**。
#:     · 真劣化页（0.35× 重采样，interline 5.75）：F1 0.93 → **1.00**；
#:       0.25×（interline 4.0）：F1 **0.08 → 0.88** —— 低到 LANCZOS 救不回来时超分才值。
#:   所以 auto 只在这条界线上动手，其余一律原样；要更激进用 --sr on。
SR_MIN_INTERLINE = 5.0
#: 源图超过这个像素数就不超分（×4 的中转图会到 6400 万像素，时间不划算）；这种页本来就够大。
SR_MAX_SRC_PIXELS = 16_000_000


def sr_root():
    root = os.environ.get("FUFUMIDI_DATA_ROOT") or os.path.join(os.path.expanduser("~"), "FuFumidiData")
    return os.path.join(root, "omr", "waifu2x")


def find_sr(explicit=None):
    """超分启动器：--sr-exe 参数 > 环境变量 FUFUMIDI_WAFU2X > 数据根下的 waifu2x 目录。"""
    for cand in (explicit, os.environ.get("FUFUMIDI_WAFU2X")):
        if cand and os.path.exists(cand):
            return cand
    p = os.path.join(sr_root(), SR_EXE)
    return p if os.path.exists(p) else None


def run_sr(src, dst, exe=None, scale=2, model=SR_MODEL, gpu=0, timeout=1800):
    """神经放大一张图（waifu2x-ncnn-vulkan）。返回 (ok, 说明)。**失败绝不抛** —— 超分是增强，
    出不来就退回 LANCZOS，整页识别不该因为它挂掉。"""
    exe = exe or find_sr()
    if not exe:
        return False, "没找到超分辨率组件（可在资源中心安装）"
    root = os.path.dirname(exe)
    cmd = [exe, "-i", src, "-o", dst, "-s", str(int(scale)), "-n", "0",
           "-m", os.path.join(root, model), "-g", str(int(gpu)), "-f", "png"]
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=root,
                           encoding="utf-8", errors="replace")
    except Exception as e:                           # noqa: BLE001
        return False, str(e)[:160]
    if not os.path.exists(dst) or os.path.getsize(dst) < 128:
        tail = ((p.stdout or "") + (p.stderr or "")).strip()[-160:]
        return False, tail or ("退出码 %s" % p.returncode)
    return True, ""


def sr_prepare_inputs(inputs, workdir, sr="auto", tag="sr", exe=None):
    """把「低清页」超分成新文件，返回 (新路径列表, 说明列表)。

    sr：off = 不动 | auto = 只在**实测行距 < 11px** 的页上开 | on = 全部页都开。
    任何一步失败都退回原图（并如实回报，界面上能看见）。
    """
    mode = str(sr or "off").lower()
    if mode in ("off", "no", "false", "0", ""):
        return list(inputs), []
    exe = exe or find_sr()
    infos = []
    out_paths = []
    for i, src in enumerate(inputs):
        info = {"page": i + 1, "used": False, "reason": "", "sec": 0.0}
        try:
            sp, nst = measure_interline(src)
        except Exception:                            # noqa: BLE001
            sp, nst = 0.0, 0
        info["interline"] = round(float(sp), 2)
        # ★ sp == 0 表示**一行谱表都没量出来**：这正是最该超分的一档（实测 0.4× 的总谱页
        #   不超分 0 个音符，超分后 253 个）。旧写法要求 sp > 0，把这一档整个漏掉了 ——
        #   端到端 A/B 抓出来的（srInfo 里连一条记录都没有）。
        want = mode in ("on", "true", "1", "yes", "force") or (sp < SR_MIN_INTERLINE)
        if not want:
            info["reason"] = "interline-ok"
        elif not exe:
            info["reason"] = "not-installed"
        else:
            # ★ 这里的 Image 必须显式 import：本模块只在各函数内部按需 import PIL，
            #   模块级没有 Image —— 裸写会被下面的 except 吞掉 NameError，
            #   于是「大图跳过」这道闸门静默失效（实测就是被 tests/test_omr_sr.py 抓到的）。
            try:
                from PIL import Image as _PILImage
                with _PILImage.open(src) as _im:
                    pxx = _im.width * _im.height
            except Exception:                        # noqa: BLE001
                pxx = 0
            if pxx > SR_MAX_SRC_PIXELS:
                info["reason"] = "page-too-large"
            else:
                dst_png = os.path.join(workdir, "%s-%03d-x2.png" % (tag, i + 1))
                t0 = time.time()
                ok, why = run_sr(src, dst_png, exe=exe, scale=2)
                info["sec"] = round(time.time() - t0, 1)
                if ok:
                    out_paths.append(dst_png)
                    info.update({"used": True, "reason": "ok", "scale": 2})
                    infos.append(info)
                    continue
                info["reason"] = ("failed:" + why)[:160]
        out_paths.append(src)
        infos.append(info)
    return out_paths, infos


def measure_interline(src):
    """量「谱线间距」（interline，像素）与谱表数。失败返回 (0, 0)。

    ★ 为什么非要量它：Audiveris 的 ScaleBuilder 要求 interline ≥ 11px，
      低于这个值它会给出「either this sheet contains no staves, or the picture
      resolution is too low (try 300 DPI)」并把整页判 invalid（导出就没有 MusicXML）。
      总谱一行只有 6px 行距（1588px 宽的 PDF 页），所以放大倍数必须由**实测行距**
      推出来，不能写死。实测：第 1、2 页（24 谱表的总谱）在 2 倍 + 3×3 加粗下
      导不出任何东西，去掉加粗立刻出 235 个音符。
    """
    import numpy as np
    from PIL import Image
    import engine_omr as _omr
    im = Image.open(src).convert("L")
    key = im.size
    if key in _INTERLINE_CACHE:
        return _INTERLINE_CACHE[key]
    gray = np.asarray(im).astype("float32")
    try:
        ink, _thr, _frac = _omr.binarize(gray)
        staves = _omr.detect_staves(ink)
    except Exception:                       # noqa: BLE001 —— 量不出来就退回按像素上限
        staves = []
    if staves:
        sp = float(np.median([s["spacing"] for s in staves]))
        out = (sp, len(staves))
    else:
        out = (0.0, 0)
    _INTERLINE_CACHE[key] = out
    return out


def auto_scale(src, target_interline=22.0):
    """由行距与像素上限共同决定放大倍数（可以是非整数）。

    目标行距 22px 略高于 Audiveris 的下限 11px —— 实测 600 DPI 级（行距 20+）
    是它对复杂总谱最稳的区间。上限由两件事卡住：单边 6000px、总像素 19M。
    """
    from PIL import Image
    w, h = Image.open(src).size
    cap = min(MAX_SIDE / float(max(w, h)), (MAX_PIXELS / float(w * h)) ** 0.5)
    sp, _n = measure_interline(src)
    want = (target_interline / sp) if sp > 0 else 1.0
    s = min(want, cap)
    if s < 1.0:
        s = 1.0
    return round(s, 2)


def prep_image(src, dst, scale=None, thicken=False, prep="auto"):
    """喂给 Audiveris 之前把图整理一遍：**摆正 → 放大 → 二值化 → 可选去噪点/加粗**。

    * thicken 默认关：3×3 加粗会把密集总谱的符头/符杠/歌词黏成一片，
      实测第 1 页「加粗 → 导出 0 个 MusicXML；不加粗 → 235 个音符」。
      只有扫描件谱线断裂时才值得开（界面上作为高级参数暴露）。
    * prep（M3-3 共用影像预处理层）：off = 完全不动；auto = **看着像扫描件/照片才上**
      （背景不均 / 噪点多 / 有倾斜，判据见 engine_omr.looks_like_scan）；scan = 强制上。
      这一层做三件事：**去倾斜**（行投影方差最大化，实测 3° 估成 -3.00°）、
      **Sauvola 局部二值化**（实测阴影下墨占比 0.046，而全局阈值把暗半边整片判成墨 1.000）、
      **去噪点**（<6px 的连通块）。
    """
    import numpy as np
    from PIL import Image, ImageFilter
    import engine_omr as _omr
    im = Image.open(src).convert("L")
    skew = 0.0
    if str(prep).lower() != "off":
        im, skew = _omr.deskew(im, min_deg=0.25)
    w, h = im.size
    if scale is None or float(scale) <= 0:
        scale = auto_scale(src)
    scale = float(scale)
    if max(w, h) * scale > MAX_SIDE:
        scale = MAX_SIDE / float(max(w, h))
    if w * h * scale * scale > MAX_PIXELS:
        scale = (MAX_PIXELS / float(w * h)) ** 0.5
    scale = max(1.0, round(scale, 2))
    # 取整后再兜一次底：2.3077 取两位小数会变成 2.31，恰好超出 6000px 上限
    if max(w, h) * scale > MAX_SIDE:
        scale = max(1.0, int(MAX_SIDE / float(max(w, h)) * 100) / 100.0)
    if w * h * scale * scale > MAX_PIXELS:
        scale = max(1.0, int((MAX_PIXELS / float(w * h)) ** 0.5 * 100) / 100.0)
    up = im.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS) if scale > 1.0 else im
    g = np.asarray(up).astype("float32")
    mode = str(prep).lower()
    want_scan, why = (False, "")
    if mode == "scan":
        want_scan, why = True, "forced"
    elif mode != "off":
        want_scan, why = _omr.looks_like_scan(g, skew)
    removed = 0
    if want_scan:
        ink, _thr = _omr.sauvola(g)
        ink, removed = _omr.despeckle(ink, min_px=6)
        out = np.where(ink, 0, 255).astype("uint8")
    else:
        try:
            ink, _thr, _frac = _omr.binarize(g)      # 自适应阈值（比写死 0.30 稳）
            out = np.where(ink, 0, 255).astype("uint8")
        except Exception:                            # noqa: BLE001
            bg = float(np.percentile(g, 98))
            inkv = float(np.percentile(g, 1))
            out = np.where(g < bg - 0.30 * (bg - inkv), 0, 255).astype("uint8")
    img = Image.fromarray(out)
    if thicken:
        img = img.filter(ImageFilter.MinFilter(3))
    img.save(dst)
    return {"size": img.size, "scale": scale, "skew": round(float(skew), 2),
            "prep": "off" if mode == "off" else ("scan" if want_scan else "clean"),
            "prepWhy": why, "despeckled": removed}


# ----------------------------------------------------------------------------
# Audiveris 后端
# ----------------------------------------------------------------------------

# ----------------------------------------------------------------------------
# OCR 语言（Tesseract traineddata）
# ----------------------------------------------------------------------------
# ★ 为什么必须自己管：Audiveris 5.5 起**不再预装任何 OCR 语言**（官方文档写得很明确），
#   而没有语言时 **TEXTS 步会被整段跳过** —— 速度记号、乐器名、和弦名一个都读不到。
#   实测：装语言前日志是「*** No installed OCR languages ***」，谱面文字全丢；
#   把它指到我们的 tessdata 目录后变成「Installed OCR languages: eng」并跑起 TEXTS 步。
#   目录由应用侧下载（资源中心 · 识谱引擎 · OCR 语言包），引擎只负责声明位置。
LANGS_ORDER = ("eng", "chi_sim", "jpn", "chi_tra")


def tessdata_dir():
    root = os.environ.get("FUFUMIDI_DATA_ROOT") or os.environ.get("FUFUMIDI_DATA")
    if not root:
        return ""
    return os.path.join(root, "omr", "tessdata")


def installed_ocr_langs():
    """已安装的 OCR 语言代码（按 LANGS_ORDER 排前面，其余按字母序）。"""
    d = tessdata_dir()
    if not d or not os.path.isdir(d):
        return []
    out = []
    try:
        for f in os.listdir(d):
            if not f.lower().endswith(".traineddata"):
                continue
            p = os.path.join(d, f)
            try:
                # ★ 5 MB 门槛把 tessdata_fast 挡在外面：它是纯 LSTM 权重（2~4 MB），
                #   Audiveris 用 legacy 模式初始化 Tesseract，实测装 fast 版会报
                #   「Could not initialize TessBaseAPI languages: eng in legacy mode」，
                #   识别结果与完全不装一模一样。完整版 eng 约 23 MB。
                if os.path.getsize(p) < 5 * 1024 * 1024:
                    continue
            except OSError:
                continue
            out.append(f[: -len(".traineddata")])
    except OSError:
        return []
    out = sorted(set(out))
    head = [c for c in LANGS_ORDER if c in out]
    return head + [c for c in out if c not in head]


def ocr_subprocess_env():
    """→ (env|None, langs)。有语言时给 Audiveris 指定 TESSDATA_PREFIX。"""
    langs = installed_ocr_langs()
    d = tessdata_dir()
    if not langs or not d:
        return None, []
    env = os.environ.copy()
    env["TESSDATA_PREFIX"] = d
    return env, langs


#: 失败原因归类（界面按 code 翻译成「下一步怎么做」）。
FAIL_MARKS = (
    ("oom", ("OutOfMemoryError", "Java heap space", "GC overhead")),
    ("timeout", ("Timeout", "TimeoutException", "did not terminate")),
    ("lowres", ("too low", "interline value", "no multi-line staves", "Too large image")),
    ("no-staves", ("contains no staves", "no staves")),
    ("beam-guess", ("No reliable beam height",)),
    ("export", ("Error in export", "Error processing stub")),
)


def classify_failure(reasons):
    """把 _page_reason() 抓到的原文归类 → 可翻译的 code（拿不准就 unknown）。"""
    blob = " ".join(reasons or [])
    for code, marks in FAIL_MARKS:
        for m in marks:
            if m.lower() in blob.lower():
                return code
    return "unknown"


def _page_reason(log, stem):
    """从 Audiveris 日志里挑出与某一页有关的告警（给「第 N 页失败」一个真实理由）。"""
    out = []
    for l in log.splitlines():
        if stem not in l:
            continue
        s = l.strip()
        for mark in ("invalid", "Too large image", "Timeout", "Error processing", "Error in export",
                     "no staves", "resolution is too low", "StepException"):
            if mark.lower() in s.lower():
                out.append(s[:300])
                break
    if not out:
        for l in log.splitlines():
            if "Error in export" in l or "flagged as invalid" in l:
                out.append(l.strip()[:300])
                break
    return out[:3]


#: 分带识别（M2-1）参数：一带最多几行谱表、每带目标放大倍数
BAND_MAX_STAVES = 12
BAND_TARGET_SCALE = 3.0


def prep_arg(v):
    """--prep 取值归一：off | auto | scan（也吃 on/true/1 当 scan、no/false/0 当 off）。"""
    s = str(v if v is not None else "auto").strip().lower()
    if s in ("off", "no", "false", "0", "none", ""):
        return "off"
    if s in ("on", "true", "1", "yes", "scan", "force"):
        return "scan"
    return "auto"


def plan_page_bands(src, workdir, page_no, max_staves=BAND_MAX_STAVES,
                    target_scale=BAND_TARGET_SCALE, prep="auto"):
    """把一页切成「系统 → 带」两级，写出每带的裁切图。返回 [dict(sys, band, stem, png, scale)]。

    **为什么切**：一页 29 行谱表在 ×2.11（1600 万像素）时 Audiveris 抛
    OutOfMemoryError；往下退放大倍数会撞它的分辨率下限（实测 ×1.58 直接 "Sheet ignored"）
    —— 两条路都堵死。切开之后每带只有几行谱表，对象数少一个量级，还能顺便放大到 ×3。

    **怎么切**（判据全部实测过，与 Audiveris 自己的 GRID 输出逐项吻合）：

    * **系统交界**：相邻两行谱表之间的空白带里，**没有任何一列**的墨迹覆盖率 ≥ 0.9
      —— 也就是「没有一条贯穿的竖线」。第 2 页组内空白 129.5px 比系统交界的 94.5px
      还大，纯行距阈值必切错（见 docs/known-issues.md KI-7）。
    * **组交界**：只有 2~3 列贯穿竖线（乐器组自己的括号）。**带只在组交界切**，
      这样不会把大谱表（钢琴/竖琴的括号，实测 24~28 列）劈成两半 ——
      劈开的话左右手会各自变成一个 part，跨页就对不上了。

    返回的 sys 从 0 开始，同一 sys 的多带是**同时刻**的（合并时 parts 相加），
    不同 sys 是先后接续的（合并时按时间串起来）。
    """
    import math
    import numpy as np
    from PIL import Image
    import engine_omr as EO
    img = Image.open(src).convert("L")
    W, H = img.size
    gray = np.asarray(img).astype("float32")
    ink, _thr, _frac = EO.binarize(gray)
    staves = EO.detect_staves(ink)
    if len(staves) < 2:
        return []
    # 1) 每个交界处数「贯穿竖线」的列数
    cols = []
    for i in range(len(staves) - 1):
        a, b = staves[i], staves[i + 1]
        y0, y1 = int(a["bottom"]) + 1, int(b["top"]) - 1
        x0, x1 = int(min(a["x0"], b["x0"])), int(max(a["x1"], b["x1"]))
        if y1 <= y0 or x1 <= x0:
            cols.append(0)
            continue
        col = ink[y0:y1 + 1, x0:x1 + 1]
        cov = col.sum(axis=0) / float(col.shape[0])
        cols.append(int((cov >= 0.9).sum()))
    # 2) 系统 = 0 列的交界
    systems, start = [], 0
    for i, c in enumerate(cols):
        if c == 0:
            systems.append((start, i + 1))
            start = i + 1
    systems.append((start, len(staves)))
    # 3) 系统内再按组交界切带（尽量靠近 max_staves）
    out, si = [], 0
    for (s0, s1) in systems:
        cuts = [k for k in range(s0, s1 - 1) if cols[k] <= 3]
        cur, bi = s0, 0
        while cur < s1:
            limit = min(s1, cur + max_staves)
            cand = [k for k in cuts if cur <= k < limit - 1]
            nxt = (max(cand) + 1) if cand else limit
            b0, b1 = cur, nxt
            top = float(staves[b0]["top"])
            bot = float(staves[b1 - 1]["bottom"])
            sp = float(staves[b0].get("spacing") or 8.0)
            above = top - float(staves[b0 - 1]["bottom"]) if b0 > 0 else 1e9
            below = float(staves[b1]["top"]) - bot if b1 < len(staves) else 1e9
            y0 = max(0, int(round(top - min(max(10.0, 2.5 * sp), 0.45 * above))))
            y1 = min(H, int(round(bot + min(max(10.0, 2.5 * sp), 0.45 * below))))
            if y1 - y0 < 8:
                cur = nxt
                continue
            s = min(target_scale, (MAX_SIDE - 1) / float(W),
                    math.sqrt(MAX_PIXELS / float(max(1, W * (y1 - y0)))))
            s = max(1.0, round(min(4.0, s), 2))
            stem = "prep-%03d-s%db%d" % (page_no, si + 1, bi + 1)
            tmp = os.path.join(workdir, stem + "-crop.png")
            dst = os.path.join(workdir, stem + ".png")
            img.crop((0, y0, W, y1)).save(tmp)
            try:
                info = prep_image(tmp, dst, scale=s, prep=prep)
            except Exception:                          # noqa: BLE001
                cur = nxt
                continue
            out.append({"sys": si, "band": bi, "stem": stem, "png": dst,
                        "scale": info.get("scale", s), "staves": b1 - b0,
                        "y": [y0, y1]})
            cur = nxt
            bi += 1
        si += 1
    return out



# ----------------------------------------------------------------------------
# 速度记号（谱面 OCR）—— 2026-10-18
# ----------------------------------------------------------------------------
# Audiveris 不导出 <sound tempo>/<metronome>（实测 5.5.2：钢琴谱与 25 行总谱都没导出），
# 它自己的 TEXTS 步也常常读不到「附点四分 = 60」这种紧贴音符图元的小记号。于是变谱只能落回
# 默认 120 BPM —— 实测整首曲子因此快 33%（用户：「转谱出来的速度不对」「和原音频差距巨大」）。
# 这一层自己找：第 1 页第一行谱表**上方**那条带（速度记号就印在那儿）→ 用 **Audiveris 自带**
# 的 Tesseract OCR 那一小块 → 解析「= 60」和附点（附点四分 = 60 即四分音符 90）。
# 为什么要从 Audiveris 里抽 tesseract：它已经装着变谱增强引擎，而 Tesseract 5.5 的 CLI 就在
# 它的 app/tesseract-*-windows-x86_64.jar 与 app/leptonica-*-windows-x86_64.jar 里（bytedeco 打包：
# tesseract.exe + libtesseract55.dll + libleptonica-6.dll + mingw 运行库）。这样安装包不必多带
# 一份 OCR 运行库（约 12 MB），也不新增强制依赖；抽一次缓存在数据根下。

_TESS_CACHE = {"exe": None, "checked": False}


def _tesseract_cli():
    """从安装好的 Audiveris 里抽出 tesseract CLI（含依赖 dll）到数据根缓存目录。

    返回 exe 路径；不可用返回 ""（调用方据此跳过速度识别，不报错）。
    """
    if _TESS_CACHE["checked"]:
        return _TESS_CACHE["exe"] or ""
    _TESS_CACHE["checked"] = True
    exe = find_audiveris()
    if not exe:
        return ""
    app = os.path.join(os.path.dirname(exe), "app")
    if not os.path.isdir(app):
        app = os.path.join(os.path.dirname(os.path.dirname(exe)), "app")
    if not os.path.isdir(app):
        return ""
    jars = []
    try:
        for f in os.listdir(app):
            fl = f.lower()
            if fl.endswith(".jar") and "windows" in fl and (fl.startswith("tesseract-") or fl.startswith("leptonica-")):
                jars.append(os.path.join(app, f))
    except OSError:
        return ""
    if not jars:
        return ""
    root = os.environ.get("FUFUMIDI_DATA_ROOT") or os.environ.get("FUFUMIDI_DATA") or ""
    if not root:
        return ""
    dst = os.path.join(root, "omr", "tesseract-cli")
    marker = os.path.join(dst, "tesseract.exe")
    if os.path.isfile(marker):
        _TESS_CACHE["exe"] = marker
        return marker
    try:
        import zipfile
        os.makedirs(dst, exist_ok=True)
        for jp in jars:
            with zipfile.ZipFile(jp) as z:
                for n in z.namelist():
                    low = n.lower()
                    if not (low.endswith(".dll") or low.endswith(".exe")):
                        continue
                    base = os.path.basename(n)
                    # JNI 层不要（CLI 只需要 C 运行库）：jni*.dll 是给 Java 用的胶水
                    if base.lower().startswith("jni"):
                        continue
                    with z.open(n) as sf, open(os.path.join(dst, base), "wb") as fh:
                        fh.write(sf.read())
    except Exception:                                  # noqa: BLE001
        return ""
    if not os.path.isfile(marker):
        return ""
    _TESS_CACHE["exe"] = marker
    return marker


def _run_tesseract(png, psm=6):
    """对一张小图跑 Tesseract（只用 eng：速度记号就是数字 + 等号）。返回识别文本。"""
    exe = _tesseract_cli()
    if not exe or not png or not os.path.isfile(png):
        return ""
    env = dict(os.environ)
    td = tessdata_dir()
    if td and os.path.isdir(td):
        env["TESSDATA_PREFIX"] = td
    out = ""
    try:
        proc = subprocess.run([exe, png, "stdout", "--psm", str(psm), "-l", "eng"],
                              capture_output=True, text=True, timeout=90,
                              cwd=os.path.dirname(exe), env=env,
                              encoding="utf-8", errors="replace")
        out = (proc.stdout or "").strip()
    except Exception:                                  # noqa: BLE001
        out = ""
    return out


def _tempo_from_ocr_text(text):
    """OCR 文本 → {perMinute, dotted, raw}；认不出返回 None。

    形态实测：谱面「附点四分 = 60」被读成 J.=60 / | J.= 60 / q.=60 / = 60 这几种。
    """
    import re
    if not text:
        return None
    flat = " ".join(str(text).split())
    m = re.search(r"=\s*(\d{1,3})", flat)
    dotted = bool(re.search(r"[.\u00b7\u2022]\s*=", flat))
    if not m:
        # 没有等号：整块带子里只有一个 2~3 位数，也认（速度记号那条带子本来就只有它）
        nums = re.findall(r"(?<![0-9])(\d{2,3})(?![0-9])", flat)
        if len(nums) != 1:
            return None
        n = int(nums[0])
        if not (30 <= n <= 300):
            return None
        return {"perMinute": n, "dotted": dotted, "raw": flat}
    n = int(m.group(1))
    if not (30 <= n <= 300):
        return None
    return {"perMinute": n, "dotted": dotted, "raw": flat}


def read_tempo_mark_from_raster(page_png, workdir=None):
    """从第 1 页栅格图里读速度记号（左上角「附点四分 = 60」那一块）。

    ① 找第一行谱表的 y：整行几乎全是黑的长横线（标题/文字的长横远短于谱线）；
    ② 取它上方一条带（x 8%~46%、y 谱线上方约 7.5% 页高）；
    ③ Tesseract OCR（psm 6/7/11 各跑一次，取第一个能解析出数字的）。
    返回 {found, bpm, perMinute, dotted, raw, source}；没把握 → found=False（界面提示手填）。
    """
    out = {"found": False, "bpm": None, "perMinute": None, "dotted": False,
           "raw": [], "source": "raster"}
    if not page_png or not os.path.isfile(page_png):
        return out
    try:
        import numpy as np
        from PIL import Image
        im = Image.open(page_png).convert("L")
        arr = np.asarray(im, dtype=np.uint8)
    except Exception:                                  # noqa: BLE001
        return out
    h, w = arr.shape[:2]
    dark = (arr < 128)
    # ① 第一行谱表：找「最长连续黑段 >= 45% 页宽」的最小 y
    top_staff = None
    for y in range(0, h):
        row = dark[y]
        if row.sum() < w * 0.25:
            continue
        idx = np.flatnonzero(row)
        if idx.size == 0:
            continue
        best = cur = 1
        prev = idx[0]
        for v in idx[1:]:
            if v == prev + 1:
                cur += 1
            else:
                cur = 1
            if cur > best:
                best = cur
            prev = v
        if best >= w * 0.45:
            top_staff = y
            break
    if top_staff is None or top_staff < h * 0.03:
        return out
    # 带子取**第一行谱表上方 6% 页高**、横向 10%~34%：速度记号就印在这里（标题与作曲家在更上面）。
    # 太宽的带子会把标题文字也带进来，Tesseract 反而读不出那个小记号（实测 psm 6/7 全空）。
    y0 = max(0, int(top_staff - h * 0.060))
    y1 = max(0, int(top_staff - int(h * 0.004)))
    x0 = int(w * 0.10)
    x1 = int(w * 0.34)
    if y1 - y0 < 10 or x1 - x0 < 60:
        return out
    crop = arr[y0:y1, x0:x1]
    tmpdir = os.path.join(workdir or os.path.dirname(page_png), "tempo")
    try:
        os.makedirs(tmpdir, exist_ok=True)
        # 二值化 + 四周留白：速度记号很小，直接喂原图 Tesseract 常常整块读空
        import numpy as _np
        binimg = (_np.where(crop < 160, 0, 255)).astype(_np.uint8)
        pad = 24
        padded = _np.full((binimg.shape[0] + pad * 2, binimg.shape[1] + pad * 2), 255, dtype=_np.uint8)
        padded[pad:pad + binimg.shape[0], pad:pad + binimg.shape[1]] = binimg
        big = Image.fromarray(padded).resize(
            (padded.shape[1] * 4, padded.shape[0] * 4), Image.LANCZOS)
        png = os.path.join(tmpdir, "tempo-band.png")
        big.save(png)
    except Exception:                                  # noqa: BLE001
        return out
    for psm in (6, 7, 12):
        txt = _run_tesseract(png, psm)
        if not txt:
            continue
        out["raw"].append("[psm%d] %s" % (psm, " ".join(txt.split())[:60]))
        got = _tempo_from_ocr_text(txt)
        if not got:
            continue
        out["found"] = True
        out["perMinute"] = got["perMinute"]
        out["dotted"] = got["dotted"]
        # 附点四分 = 60 → 四分音符 90；无附点按四分音符记（MIDI 的 set_tempo 永远是四分音符）
        out["bpm"] = int(round(got["perMinute"] * (1.5 if got["dotted"] else 1.0)))
        out["raw"].append("perMinute=%d dotted=%s bpm=%d" % (got["perMinute"], got["dotted"], out["bpm"]))
        break
    return out

def run_audiveris(inputs, workdir, timeout=30 * 60, explicit=None, scale=None, thicken=False,
                   prep="auto", sr="off", sr_exe=None):
    """逐页预处理 → Audiveris 批处理 → 按输入名逐页配对导出的 MusicXML。

    ★ 配对是必须的：Audiveris 一个输入出一份 .mxl（prep-001.mxl）。旧实现只 list 了
      目录里的 *.mxl，于是「6 页只出了 4 份」这种情况会被静默吞掉 ——
      用户拿到的是缺了三分之一音乐的 MIDI，界面上却什么提示都没有（实测第 1、2 页
      就是这么消失的：密总谱 + 3×3 加粗 → Sheet flagged as invalid）。
    """
    exe = find_audiveris(explicit=explicit)
    if not exe:
        return {"ok": False, "error": "没有找到 Audiveris（可在资源中心安装识谱引擎）", "code": "backend-missing"}
    os.makedirs(workdir, exist_ok=True)
    # ★ M3-2：低清页先超分成新文件，再走原来的放大/二值化 —— prep_image 会自己量新图的
    #   行距，所以「超分 ×2 + 剩余倍数交给 LANCZOS」不需要额外改这里的倍数推导。
    paths, sr_infos = sr_prepare_inputs(inputs, workdir, sr, tag="sr", exe=sr_exe)
    n_sr = sum(1 for x in sr_infos if x.get("used"))
    if n_sr:
        prog(6, "超分辨率预处理（%d 页）" % n_sr)
    prepped = []
    scales = []
    prep_infos = []
    for i, src in enumerate(paths):
        dst = os.path.join(workdir, "prep-%03d.png" % (i + 1))
        prog(8 + int(30 * (i + 1) / max(1, len(inputs))), "预处理第 %d/%d 页" % (i + 1, len(inputs)))
        try:
            info = prep_image(src, dst, scale=scale, thicken=thicken, prep=prep)
        except Exception as e:                       # noqa: BLE001
            info = {"scale": 0, "error": str(e)}
        prepped.append(dst)
        scales.append(info.get("scale", 0))
        prep_infos.append({"page": i + 1, "prep": info.get("prep"),
                           "skew": info.get("skew"), "prepWhy": info.get("prepWhy"),
                           "despeckled": info.get("despeckled")})
    out_dir = os.path.join(workdir, "out")
    os.makedirs(out_dir, exist_ok=True)

    def _collect():
        out = {}
        for m in (sorted(glob.glob(os.path.join(out_dir, "*.mxl"))) or
                  sorted(glob.glob(os.path.join(out_dir, "*.musicxml")))):
            out[os.path.splitext(os.path.basename(m))[0]] = m
        return out

    ocr_env, ocr_langs = ocr_subprocess_env()

    def _run(paths):
        # -swap：每页处理完就把图像换出内存。密集总谱（24 行谱表、1900 万像素）实测会
        #   抛 OutOfMemoryError: Java heap space（-Xmx8G 也没用），换出是官方给的省内存手段。
        cmd = [exe, "-batch", "-export", "-force", "-swap", "-output", out_dir]
        if ocr_langs:
            # 只声明**已装**的语言：装太多会拖慢识别并增加误识别（官方提示）
            cmd += ["-constant", "org.audiveris.omr.text.Language.defaultSpecification=" + "+".join(ocr_langs[:3])]
        cmd += paths
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=workdir,
                                  encoding="utf-8", errors="replace", env=ocr_env)
            return (proc.stdout or "") + (proc.stderr or ""), proc.returncode
        except subprocess.TimeoutExpired as e:
            head = (e.stdout or "") if isinstance(e.stdout, str) else ""
            return head + "\nTimeout", -1

    prog(45, "Audiveris 识别中（%d 页）" % len(prepped))
    t0 = time.time()
    log, code = _run(prepped)
    found = _collect()
    pages = []
    for i, _p in enumerate(prepped):
        stem = "prep-%03d" % (i + 1)
        m = found.get(stem)
        pages.append({
            "page": i + 1,
            "ok": bool(m),
            "mxl": m,
            "scale": scales[i],
            "reasons": [] if m else _page_reason(log, stem),
        })

    # ★ 失败页降档重试：实测 24 谱表的总谱在原尺寸 ×2.3（约 1900 万像素）时
    #   Audiveris 抛 java.lang.OutOfMemoryError: Java heap space（-Xmx8G 也一样），
    #   而同图 ×2.0 能出 235 个音符。整页重跑只要几十秒，所以对失败页自动降一档再试一次，
    #   失败原因（内存 / 判无效 / 超时）都会如实回报给界面。
    for rnd in range(3):
        retry = [p for p in pages if not p["ok"] and (p.get("scale") or 0) > 1.05]
        if not retry:
            break
        if rnd and not any(classify_failure(p.get("reasons") or []) == "oom" for p in retry):
            break                                    # 只有内存不足才值得再退一档
        prog(58, "失败页降档重试（%d 页 · 第 %d 档）" % (len(retry), rnd + 1))
        retry_paths = []
        for p in retry:
            n = p["page"]
            ns = max(1.0, round(float(scales[n - 1] or 2.0) * 0.75, 2))
            dst = os.path.join(workdir, "prep-%03d-r.png" % n)
            try:
                prep_image(paths[n - 1], dst, scale=ns, thicken=thicken, prep=prep)
            except Exception:                        # noqa: BLE001
                continue
            scales[n - 1] = ns
            p["retryScale"] = ns
            p["failedScale"] = p.get("failedScale") or p.get("scale")
            retry_paths.append((n, dst))
        if not retry_paths:
            break
        log2, _code2 = _run([d for _n, d in retry_paths])
        found2 = _collect()
        for n, dst in retry_paths:
            stem = os.path.splitext(os.path.basename(dst))[0]
            m = found2.get(stem)
            if m:
                pg = pages[n - 1]
                pg["ok"] = True
                pg["mxl"] = m
                pg["scale"] = scales[n - 1]
                pg["reasons"] = []
        log = log + "\n---- retry %d ----\n" % (rnd + 1) + log2
    # ★ 还是失败的页 → **按系统/乐器组切带重跑**（M2-1）。实测第 2 页（29 行谱表）
    #   在 ×2.11 抛 OutOfMemoryError，往下退又撞分辨率下限（×1.58 直接 "Sheet ignored"），
    #   两条路都堵死；切开之后每带对象数少一个量级，还能放大到 ×3（interline 31px）。
    band_failed = [p for p in pages if not p["ok"]]
    if band_failed:
        prog(62, "分带重跑（%d 页）" % len(band_failed))
        items = []
        for p in band_failed:
            n = p["page"]
            try:
                bands = plan_page_bands(paths[n - 1], workdir, n, prep=prep)
            except Exception as e:                       # noqa: BLE001
                bands = []
                p["bandError"] = str(e)[:160]
            for b in bands:
                b["page"] = n
                items.append(b)
        if items:
            log3, _c3 = _run([it["png"] for it in items])
            found3 = _collect()
            log = log + "\n---- bands ----\n" + log3
            by_page = {}
            for it in items:
                it["mxl"] = found3.get(it["stem"])
                if it["mxl"]:
                    by_page.setdefault(it["page"], {}).setdefault(it["sys"], []).append(it)
            for p in band_failed:
                sysmap = by_page.get(p["page"]) or {}
                if not sysmap:
                    continue
                p["ok"] = True
                p["banded"] = True
                p["systems"] = [{"system": s, "mxl": [x["mxl"] for x in sysmap[s]],
                                 "bands": len(sysmap[s]),
                                 "scales": [x["scale"] for x in sysmap[s]]}
                                for s in sorted(sysmap)]
                p["scale"] = max([x["scale"] for v in sysmap.values() for x in v] or [0])
                p["bandStaves"] = sum(x["staves"] for v in sysmap.values() for x in v)
                p["reasons"] = []
    metro = read_metronome_from_omr(out_dir, 1)
    # .omr 里没有速度记号 → 再从**第 1 页栅格图**上 OCR 一次（速度记号本来就印在谱面上）。
    # 只在没拿到 metronome 时才做：OCR 比读 .omr 慢（抽 tesseract + 3 次识别 ≈ 1~2 秒）。
    tempo_mark = {}
    if not (metro or {}).get("bpm"):
        try:
            tempo_mark = read_tempo_mark_from_raster(prepped[0] if prepped else "", workdir)
        except Exception as _e:                      # noqa: BLE001
            tempo_mark = {"found": False, "error": str(_e)[:120]}
    res = {
        "metronome": metro,
        "tempoMark": tempo_mark,
        "ok": any(p["ok"] for p in pages),
        "pages": pages,
        "mxlList": [p["mxl"] for p in pages if p["ok"]],
        "exe": exe,
        "elapsed": round(time.time() - t0, 1),
        "log": log[-6000:],
        "mxl": next((p["mxl"] for p in pages if p["ok"]), None),
        "pageCount": len(prepped),
        "ocrLangs": ocr_langs,
        "prepInfo": prep_infos,
        "srInfo": sr_infos,
        "exit": code,
    }
    if not res["ok"]:
        tail = "\n".join([l for l in log.splitlines() if "WARN" in l or "ERROR" in l][-8:])
        res["error"] = "Audiveris 没有导出 MusicXML：" + (tail or ("退出码 %s" % code))
    return res


#: homr（AI 识谱）—— **用户自行安装**（资源中心），装在数据根下的独立 venv 里。
#: ★ 为什么必须独立 venv：homr 0.7 要求 numpy>=2.4，而应用自带的运行时是 numpy 1.26
#:   （librosa / onnxruntime / basic_pitch 都按它固定）—— 装进同一个环境会把引擎拆了。
HOMR_VERSION = "0.7.0"
HOMR_CHECKPOINT_BASE = "https://github.com/liebharc/homr/releases/download/onnx_checkpoints/"
#: CPU 推理要的三个权重包（解包后落在 venv 的 site-packages/homr 里）。名字与 homr 0.7.0
#: 源码里的 constants 一一对应（segmentation/config.py、transformer/configs.py）。
HOMR_WEIGHTS = [
    ("segnet_308-3296ccd40960f90ca6ab9c035cca945675d30a0f.zip", "segmentation"),
    ("encoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.zip", "transformer"),
    ("decoder_pytorch_model_396-f6feedb42ff90087d898b0941a55d040fa6b2903.zip", "transformer"),
]


def homr_root():
    root = os.environ.get("FUFUMIDI_DATA_ROOT") or os.path.join(os.path.expanduser("~"), "FuFumidiData")
    return os.path.join(root, "omr", "homr")


def find_homr(explicit=None):
    """homr 启动器：--homr 参数 > 环境变量 FUFUMIDI_HOMR > 数据根下的 venv。

    找不到就返回 None（界面引导去资源中心装）——**绝不自动 pip install**：
    homr 是 AGPL-3.0 且权重含非商用训练数据（PrIMuS），安装必须是用户显式点的动作。
    """
    for cand in (explicit, os.environ.get("FUFUMIDI_HOMR")):
        if cand and os.path.exists(cand):
            return cand
    exe = os.path.join(homr_root(), "venv", "Scripts", "homr.exe")
    if os.path.exists(exe):
        return exe
    py = os.path.join(homr_root(), "venv", "Scripts", "python.exe")
    if os.path.exists(py):
        return py                      # 兜底：python -m homr.main
    return None


def read_metronome_from_omr(out_dir, page_no=1):
    """从 Audiveris 的 .omr 书文件里读**速度记号**（它不导出 <sound tempo>，但 OCR 结果留在这里）。

    实测（2026-10-15）：sheet#1.xml 里有 `<sentence role="Metronome">` 一句 —— 那就是谱面左上
    那个「♩. = 60」方框；同页的其它句子角色是 PartName / Lyrics / CreatorComposer / UnknownRole。

    ★ 数字不可信就**不采用**：这份总谱的记号被 OCR 读成 "=12"（真值 60）。所以只接受
      20~320 的合理值；句子在、数字不可信时返回 "unreadable"，界面据此提示「请手填速度」——
      猜错的话整首曲子的速度都是错的，比不填更糟。
    """
    import re
    import zipfile
    if not out_dir or not os.path.isdir(out_dir):
        return None
    cands = sorted(glob.glob(os.path.join(out_dir, "prep-%03d*.omr" % page_no)))
    if not cands:
        cands = sorted(glob.glob(os.path.join(out_dir, "*.omr")))
    if not cands:
        return None
    try:
        with zipfile.ZipFile(cands[0]) as z:
            sheets = [n for n in z.namelist() if re.search(r"sheet.*\.xml$", n)]
            if not sheets:
                return None
            xml = z.read(sheets[0]).decode("utf-8", "replace")
    except Exception:                                  # noqa: BLE001
        return None
    out = {"found": False, "bpm": None, "raw": [], "source": "omr", "box": None}
    # 实测结构：<metronome role="Metronome" ...><bounds x= y= w= h=/></metronome>，
    # 紧跟一个兄弟节点 <word value="=12">（同一个包围盒）—— 那就是谱面上的速度记号。
    for m in re.finditer(r'<metronome\b[^>]*>(.*?)</metronome>', xml, re.S):
        out["found"] = True
        bb = re.search(r'<bounds\s+x="(-?\d+)"\s+y="(-?\d+)"\s+w="(\d+)"\s+h="(\d+)"', m.group(1) or "")
        if bb and not out["box"]:
            out["box"] = [int(bb.group(1)), int(bb.group(2)), int(bb.group(3)), int(bb.group(4))]
        tail = xml[m.end():m.end() + 1500]
        out["raw"] += re.findall(r'<word\s+value="([^"]*)"', tail)[:2]
    if not out["found"] and 'role="Metronome"' in xml:
        out["found"] = True
    for w in out["raw"]:
        t = str(w).replace(" ", "")
        # 记号形态：`= 60` / `=60` / `q.=60`，也可能只剩数字
        mm = re.search(r"=\s*(\d{1,3})", t) or re.fullmatch(r"(\d{1,3})", t)
        if not mm:
            continue
        n = int(mm.group(1))
        if 20 <= n <= 320:
            out["bpm"] = n
            break
    if not out["bpm"] and out["found"]:
        out["unreadable"] = True
    return out


def _homr_reasons(out, code):
    """把 homr 的输出尾巴整理成失败原因（界面按 classify_failure 归类，认不出算 unknown）。"""
    lines = [l.strip() for l in (out or "").splitlines() if l.strip()]
    tail = [l for l in lines if ("Error" in l or "error" in l or "Traceback" in l
                                 or "could not" in l.lower())][-4:]
    if not tail:
        tail = lines[-3:]
    if code not in (0, None):
        tail.append("退出码 %s" % code)
    return tail


def run_homr(inputs, workdir, timeout=30 * 60, explicit=None):
    """用 homr 跑一遍（**每页一次调用**，一页失败不影响其它页）。

    homr 把结果写成「输入图旁边」的同名 .musicxml，所以先把图拷进工作目录：
    ① 不污染用户的原目录；② 结果名可预测 —— 上层按页配对的逻辑（mxl_to_parsed → merge_pages）
    原样复用，两个栅格引擎在后处理上完全同路。
    """
    exe = find_homr(explicit)
    if not exe:
        return {"ok": False, "code": "backend-missing",
                "error": "没有找到 homr（可在资源中心「AI 识谱」里安装）"}
    os.makedirs(workdir, exist_ok=True)
    pages, log, t0 = [], "", time.time()
    for i, src in enumerate(inputs):
        prog(45 + int(15 * (i + 1) / max(1, len(inputs))),
             "homr 识别 %d/%d" % (i + 1, len(inputs)))
        ext = os.path.splitext(src)[1].lower() or ".png"
        stem = "homr-%03d" % (i + 1)
        dst = os.path.join(workdir, stem + ext)
        try:
            shutil.copyfile(src, dst)
        except Exception as e:                       # noqa: BLE001
            pages.append({"page": i + 1, "ok": False, "scale": 1.0, "reasons": [str(e)[:200]]})
            continue
        cmd = [exe, dst] if not os.path.basename(exe).lower().startswith("python") \
            else [exe, "-m", "homr.main", dst]
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                                  cwd=workdir, encoding="utf-8", errors="replace")
            out, code = (proc.stdout or "") + (proc.stderr or ""), proc.returncode
        except subprocess.TimeoutExpired as e:
            out = ((e.stdout or "") if isinstance(e.stdout, str) else "") + "\nTimeout"
            code = -1
        except Exception as e:                       # noqa: BLE001
            out, code = str(e), -1
        log += "\n---- %s ----\n%s" % (stem, out[-2000:])
        m = None
        for cand in (os.path.join(workdir, stem + ".musicxml"),
                     os.path.join(workdir, stem + ".xml"),
                     os.path.join(workdir, stem + ".mxl")):
            if os.path.exists(cand):
                m = cand
                break
        pages.append({"page": i + 1, "ok": bool(m), "mxl": m, "scale": 1.0,
                      "reasons": [] if m else _homr_reasons(out, code)})
    return {"ok": any(p["ok"] for p in pages), "pages": pages, "exe": exe,
            "elapsed": round(time.time() - t0, 1), "log": log[-6000:],
            "mxlList": [p["mxl"] for p in pages if p["ok"]],
            "mxl": next((p["mxl"] for p in pages if p["ok"]), None),
            "pageCount": len(inputs), "ocrLangs": []}


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
    # ★ 按轨名回填 GM 音色（见 engine_omr.apply_gm_programs）——Audiveris 的导出不带音色
    try:
        from engine_omr import apply_gm_programs
        apply_gm_programs(out_mid)
    except Exception as _e:
        print("  [音色] 回填跳过：" + str(_e)[:120])
    return {"ok": True, "pages": per_page}


# ----------------------------------------------------------------------------
# 按「谱」合并（Audiveris 路径用这一条，不再走逐页 MIDI 拼接）
# ----------------------------------------------------------------------------

#: Audiveris 只会给出 Voice / Piano 这类通用名 —— 全谱 15 个声部都叫 Voice，
#: 按名字分组就会把整部总谱塌成 1~2 轨（实测 1430 个音符只剩 "Voice" 和 "Piano" 两条轨）。
GENERIC_PART_NAMES = {"", "voice", "piano", "part", "music", "vocal", "unknown", "instrument"}


def _generic_name(name):
    return (name or "").strip().lower() in GENERIC_PART_NAMES


def _safe_midi_name(name, idx):
    """MIDI 的 track_name 走 latin-1 编码（mido 默认），中文名会直接抛 UnicodeEncodeError。

    实测：轨名叫「声部 1」时写文件崩在 meta.encode → encode_string。
    所以文件里一律写 ASCII 的 Part N（DAW 里最保险），中文名放到 label 里给界面用。
    """
    s = str(name or "")
    if not all(32 <= ord(ch) < 127 for ch in s):
        # 含中文等非 ASCII 字符 → 整个名字不可用（剥掉之后往往只剩个「1」这种残渣）
        return "Part %d" % (idx + 1)
    s = s.strip()
    if not s or _generic_name(s):
        return "Part %d" % (idx + 1)
    return s[:48]


def postprocess_parts(parts, quantize=0, min_ms=0.0, dedupe=True, tpb=480, bpm=120.0):
    """识谱后处理：量化到网格 + 去重 + 丢过短音符。

    ★ 为什么要它：OMR 的符头中心定位有 ±10~30 tick 的抖动，直接进钢琴卷帘会看到
      「音符斜着排」；量化到 1/16 或 1/8 之后节奏网格才对得齐。
      去重针对同一个符头被识别两次（同轨同起点同音高在 MIDI 里本来就无法区分）。
    """
    stats = {"notes": 0, "kept": 0, "quantized": 0, "dup": 0, "short": 0}
    min_ticks = 0
    if min_ms and bpm:
        min_ticks = int(round(float(min_ms) / 60000.0 * float(bpm) * tpb))
    out = []
    for p in parts:
        notes = []
        seen = set()
        for n in p["notes"]:
            s, e, m = int(n["start"]), int(n["end"]), int(n["midi"])
            stats["notes"] += 1
            if quantize:
                s2 = int(round(s / float(quantize))) * quantize
                e2 = int(round(e / float(quantize))) * quantize
                if e2 <= s2:
                    e2 = s2 + quantize
                if (s2, e2) != (s, e):
                    stats["quantized"] += 1
                s, e = s2, e2
            if e <= s:
                e = s + max(1, int(quantize) or 1)
            if min_ticks and (e - s) < min_ticks:
                stats["short"] += 1
                continue
            if dedupe:
                key = (s, m)
                if key in seen:
                    stats["dup"] += 1
                    continue
                seen.add(key)
            notes.append({"start": s, "end": e, "midi": m, "vel": int(n.get("vel") or 80)})
        notes.sort(key=lambda x: (x["start"], x["midi"]))
        out.append({"name": p.get("name") or "", "notes": notes, "staves": p.get("staves", 1)})
    stats["kept"] = sum(len(p["notes"]) for p in out)
    return out, stats


#: 一小节长度（以**半拍**为单位）→ 拍号。复合拍（3 的倍数个八分）用 6/8 这类写法：
#: 现代总谱里一小节 3 个四分音符绝大多数是 6/8 而不是 3/4（这份实测谱面就是 6/8、♩.=60）。
_METERS = {
    3: (3, 8),      # 1.5 个四分
    4: (2, 4),      # 2
    5: (5, 8),      # 2.5
    6: (6, 8),      # 3   ← 实测这份 6 页总谱每一页的众数都是它
    7: (7, 8),      # 3.5
    8: (4, 4),      # 4
    9: (9, 8),      # 4.5
    10: (5, 4),     # 5
    12: (6, 4),     # 6
    16: (4, 2),     # 8
}


def infer_meter(pages, tpb, min_share=0.2):
    """从所有声部的小节长度推拍号 —— **Audiveris 不导出 <time>**，解析器只能落回 4/4。

    做法：把所有 part 的所有小节长度取众数（谱面自己写死了拍号，绝大多数小节会同长），
    占比 ≥ min_share 才采用；否则返回 None（混合拍号 / 识别太碎，宁可只用 4/4 并如实回报）。
    返回 dict(beats, beatType, ticks, share, raw)；ticks 是推定的一小节 tick 数。
    """
    from collections import Counter
    cnt = Counter()
    total = 0
    for pg in pages:
        for part in (pg.get("parsed") or {}).get("parts") or []:
            for L in part.get("measureLens") or []:
                L = int(L)
                if L <= 0 or L > 24 * tpb:            # 明显是识别碎片，不参与统计
                    continue
                cnt[L] += 1
                total += 1
    if not total:
        return None
    raw, n = cnt.most_common(1)[0]
    share = n / float(total)
    second = cnt.most_common(2)[1][1] if len(cnt) > 1 else 0
    # 判据是「众数明显赢」而不是「众数占多数」：实测这份 6 页总谱的小节长度分布很散
    # （1440 只占 43%，还有 720/960/1920/2280… 都是识别碎片或过满的小节），
    # 但 1440 是第二名的 3.2 倍 —— 谱面自己写死的拍号就是这个规律。
    if share < min_share or (second and n < 1.5 * second):
        return None
    # ★ 2026-10-18：**漏认小节线会把两小节并成一小节**（实测那份 6 页总谱：真正的 3/8 小节是 720，
    #   但 1440 才是众数 —— 一半的小节线没认出来）。如果众数长度的**真因数**（缩小 2/3/4 倍）
    #   也占到了实打实的比例，那它才是真正的拍长；否则 3/8 的谱会被当成 6/8，
    #   后面按统一网格重排时整条时间轴被拉长一倍（用户："和原音频差距巨大"）。
    best_len = raw
    for div in (4, 3, 2):
        if raw % div:
            continue
        cand = raw // div
        cshare = cnt.get(cand, 0) / float(total)
        if cshare >= 0.12 and int(round(cand * 2.0 / tpb)) in _METERS:
            best_len = cand
            share = max(share, cshare)
            break
    raw = best_len
    half = int(round(raw * 2.0 / tpb))                # 半拍为单位，避免浮点
    if half not in _METERS:
        return None
    beats, bt = _METERS[half]
    return {"beats": beats, "beatType": bt, "ticks": int(round(beats * tpb * 4.0 / bt)),
            "share": round(share, 3), "raw": raw}


def _regrid_page(parts, bar_ticks):
    """把一页里每个声部摆到**统一网格**上：小节 k 的起点 = 前 k 个小节各自取整后的累计长度。

    ★ 2026-10-18 改（旧写法是 k × bar_ticks）：旧写法的前提是「每个小节都正好 bar_ticks 长」。
      实测那份 6 页总谱里小节线经常被漏认（两个 3/8 小节并成一个 1440 的小节），小节长度分布
      是 720/1440/960 混着的 —— 用固定 bar_ticks 重建会把时间轴整体拉伸，音符全落到错的小节里
      （用户："和原音频差距巨大"）。现在按**每个小节自己的长度取整到基拍（bar_ticks）的整数倍**
      再累加：一个 1440 的小节 = 2 个基拍、720 = 1 个 —— 局部节奏不再被拉平，声部之间仍然同步
      （同一页各声部的小节序列本来就该对得上）。
    返回 (移动的音符数, 整页的网格长度 tick)。
    """
    moved = 0
    grid_end = 0
    for part in parts:
        lens = [int(x) for x in (part.get("measureLens") or [])]
        grid = [0]
        for L in lens:
            if bar_ticks:
                units = max(1, int(round(float(L) / bar_ticks))) if L > 0 else 1
            else:
                units = 1
            grid.append(grid[-1] + units * bar_ticks)
        for n in part.get("notes") or []:
            if "m" not in n:
                continue
            mi = int(n["m"])
            if 0 <= mi < len(grid):
                base = grid[mi]
            else:
                base = grid[-1] + (mi - len(grid) + 1) * bar_ticks
            ns = base + int(n.get("off") or 0)
            dur = max(1, int(n["end"]) - int(n["start"]))
            if ns != int(n["start"]):
                moved += 1
            n["start"] = ns
            n["end"] = ns + dur
            grid_end = max(grid_end, ns + dur)
        grid_end = max(grid_end, grid[-1])
    return moved, grid_end


def _page_checks(page_no, parts, bar_ticks, tpb, system=None):
    """逐页体检（M2-4）：小节数 / 小节长度是否齐 / 声部数 / 可疑音符。

    目的不是多给几个数字，而是让「第 3 页少 2 小节」这类**结构错误一眼看得见** ——
    错几个音是小事，丢小节是大事（后面整页都跟着错位）。界面按 code 翻成"下一步怎么做"。
    """
    notes = []
    lens = []
    for p in parts:
        notes.extend(p.get("notes") or [])
        if p.get("measureLens"):
            lens.append(len(p["measureLens"]))
    bars = max(lens) if lens else 0
    issues = []
    if not notes:
        issues.append({"code": "empty-page"})
    if lens and len(set(lens)) > 1:
        # 同一页里各声部见到的小节数不一样：多半是某一行的小节线没认出来
        issues.append({"code": "bar-count-mismatch", "min": min(lens), "max": max(lens)})
    neg = [n for n in notes if int(n.get("end", 0)) <= int(n.get("start", 0))]
    if neg:
        issues.append({"code": "neg-duration", "n": len(neg)})
    if bar_ticks:
        long_hold = [n for n in notes
                     if int(n.get("end", 0)) - int(n.get("start", 0)) > bar_ticks * 8]
        if long_hold:
            issues.append({"code": "long-hold", "n": len(long_hold)})
    dup = 0
    seen = set()
    for i, p in enumerate(parts):
        for n in p.get("notes") or []:
            k = (i, int(n.get("start", 0)), int(n.get("midi", 0)))
            if k in seen:
                dup += 1
            else:
                seen.add(k)
    if dup:
        issues.append({"code": "same-pitch-dup", "n": dup})
    out = {"page": page_no, "parts": len(parts), "notes": len(notes), "bars": bars,
           "issues": issues}
    if system is not None:
        out["system"] = system
    return out


def _slot_pos(slots, sid):
    """槽位在全局表里的位置（插入会挪下标，所以每次现查）。"""
    for k, s in enumerate(slots):
        if s["id"] == sid:
            return k
    return -1


def _new_slot(slots, by_id, counter, after_id):
    """新建槽位，插在 after_id 后面（None = 插在最前）。"""
    pos = _slot_pos(slots, after_id) + 1 if after_id is not None else 0
    slot = {"id": counter[0], "inst": None, "raw": "", "qual": "", "staves": 1, "tracks": {}}
    counter[0] += 1
    slots.insert(pos, slot)
    by_id[slot["id"]] = slot
    return slot


def _assign_page(infos, slots, by_id, counter):
    """把一页的声部表对到全局槽位表上，返回 [槽位 id]（必要时新建槽位）。

    身份 = **(乐器, 声部编号)**，不是页内序号 —— 三条都是实测逼出来的：

    * Audiveris 按**系统**出 part，一页三个系统就把整张声部表**重复三遍**
      （第 4 页 23 个 part、第 5 页 23 个 = 两/三个系统的和）。所以
      **同一个槽位在一页里被用多次是正常的** —— 第一版禁止页内重复使用，
      后果是第二个系统整片新建槽位、轨数从 21 涨到 43（实测）。
    * 编号必须参与身份：那页有两支号（1,2 / 3,4）、两把小提琴（I / II），
      只按乐器名分不开；换系统回到长笛时也要能认出来（编号对上就回位）。
    * OCR 读成 Voice 的（每个系统里都可能出现）不参与定身份，
      在相邻两个锚点之间**按顺序填空槽** —— 「第 2 页前两个声部是 Voice」
      正好落回第 1 页的 Flute / Oboe 槽。
    """
    n = len(infos)
    assign = [None] * n
    page_used = set()
    last_id = None
    for i, (inst, qual) in enumerate(infos):
        if not inst:
            continue
        cands = [s for s in slots if s["inst"] == inst]
        if not cands:
            slot = _new_slot(slots, by_id, counter, last_id)
        else:
            lp = _slot_pos(slots, last_id) if last_id is not None else -1
            slot = min(cands, key=lambda s: (
                (s.get("qual") or "") != qual,               # ① 编号对上的优先
                s["id"] in page_used,                        # ② 这一页还没用过的优先
                _slot_pos(slots, s["id"]) < lp,              # ③ 不往回退的优先
                abs(_slot_pos(slots, s["id"]) - lp),         # ④ 离上一个声部近的优先
            ))
        assign[i] = slot["id"]
        page_used.add(slot["id"])
        last_id = slot["id"]
    # 认不出名字的：在前后两个锚点之间按顺序填空槽
    i = 0
    while i < n:
        if assign[i] is not None:
            i += 1
            continue
        j = i
        while j < n and assign[j] is None:
            j += 1
        before = assign[i - 1] if i > 0 else None
        after = assign[j] if j < n else None
        lo = _slot_pos(slots, before) if before is not None else -1
        hi = _slot_pos(slots, after) if after is not None else len(slots)
        free = [s["id"] for s in slots[lo + 1:hi] if s["id"] not in page_used]
        for k in range(i, j):
            if k - i < len(free):
                assign[k] = free[k - i]
            else:
                prev = assign[k - 1] if k > 0 else before
                assign[k] = _new_slot(slots, by_id, counter, prev)["id"]
            page_used.add(assign[k])
        i = j
    return assign


def merge_pages(pages, out_mid, opts=None):
    """把逐页解析出来的谱按时序拼成一份，写成一个 MIDI 文件（每声部一轨）。

    * 声部身份（M2-2）= **乐器名优先、页内顺序兜底**。旧规则是「页内第几个 part」，
      它只在「每页露出来的谱表完全一样」时成立；实测这份总谱两点都不成立 ——
      MuseScore 会隐藏空谱表（每页露出的乐器不同），Audiveris 又按**系统**出 part
      （一页两个系统就有两套 P1..Pn）。页码一对不上，同一个长笛就被拆进三四条轨，
      轨名只剩「声部 10」。现在：认得出乐器名的当锚点做保序对齐（LCS），
      认不出的（OCR 读成 Voice）按前后顺序填空槽。
    * 页长 = 该页最后一个音的结束点。谱面没写速度/拍号时用 opts 的覆盖值。
    """
    import engine_score2midi as S2M
    import score_instruments as SI
    opts = opts or {}
    tpb = int(opts.get("tpb") or 480)
    tracks = []                     # 每声部若干轨（大谱表按行拆）
    slots = []                      # 全局声部（= 乐器），顺序即总谱顺序
    by_id = {}                      # 槽位 id → 槽位（插入会挪下标，只能按 id 找）
    next_id = [0]
    track_slot = []                 # 轨下标 → 它属于哪个槽位
    per_page_beats = []
    notes_per_page = []
    checks = []                     # 逐页体检（M2-4）
    conflicts = []
    # ---- 拍号推断 + 统一小节网格（M1-2）----
    # Audiveris 不导出 <time>；更要命的是它不知道拍号时**按每小节认出来的内容**定长，
    # 于是同一页里不同声部的小节长度都不一样（实测这份总谱里 3 个四分的、4 个四分的都有）。
    # 不统一就会「各走各的拍」：音符单看都对，合起来声部之间对不齐。
    meter = None
    if not opts.get("times"):
        meter = infer_meter(pages, tpb)
    user_times = opts.get("times") or []
    if user_times:
        _t0 = user_times[0]
        bar_ticks = int(round(float(_t0.get("beats") or 4) * tpb * 4.0 / float(_t0.get("beatType") or 4)))
    elif meter:
        bar_ticks = int(meter["ticks"])
    else:
        bar_ticks = 0
    regridded = 0
    offset = 0
    for pg in pages:
        parsed = pg.get("parsed") or {}
        parts = parsed.get("parts") or []
        page_grid_end = 0
        if bar_ticks:
            _mv, page_grid_end = _regrid_page(parts, bar_ticks)
            regridded += _mv
        infos = []
        for part in parts:
            raw = part.get("name") or ""
            m = SI.match(raw) if raw else None
            infos.append((m["name"] if m else None, SI.part_number(raw) if m else ""))
        plan = _assign_page(infos, slots, by_id, next_id)
        # 页长 = 这一页**有多少小节**（不是最后一个音落在哪）：末小节可能是空的，
        # 按最后一个音推进会让下一页整体前移、和上一页叠在一起。
        # 小节数取 measureLens 的长度（解析器每个小节都记，空的也记），没有就退回音符的 m。
        n_bars = 0
        for part in parts:
            n_bars = max(n_bars, len(part.get("measureLens") or []))
            for n in part.get("notes") or []:
                if "m" in n:
                    n_bars = max(n_bars, int(n["m"]) + 1)
        # 页长仍按「小节数 × 基拍」——这是**页与页之间**的衔接量，用网格累计（可能因某声部多认了
        # 几小节而偏大）会把整份谱越拼越长。页内小节长度不等的问题由上面的重排解决。
        page_end = offset + (n_bars * bar_ticks if (bar_ticks and n_bars) else 0)
        n_page = 0
        for idx, part in enumerate(parts):
            slot = by_id[plan[idx]]
            raw = part.get("name") or ""
            m = SI.match(raw) if raw else None
            if m:
                if not slot["inst"]:
                    slot["inst"] = m["name"]
                    slot["raw"] = raw
                    slot["qual"] = SI.part_number(raw)
                elif slot["inst"] != m["name"]:
                    # 同一槽位被两页认成不同乐器 —— 记下来，别静默改身份
                    conflicts.append("%s|%s" % (slot["inst"], m["name"]))
            elif raw and not slot["raw"]:
                slot["raw"] = raw
            nst = int(part.get("staves") or 1)
            slot["staves"] = max(int(slot.get("staves") or 1), nst)
            for n in part.get("notes") or []:
                # 大谱表（钢琴 / 竖琴）左右手在 MusicXML 里是同一个 <part> 的两行，
                # 只按声部会并成一条轨 —— 再按谱表行号分一次。
                st = int(n.get("staff") or 1) if nst > 1 else 1
                if st < 1 or st > nst:
                    st = 1
                ti = slot["tracks"].get(st)
                if ti is None:
                    ti = len(tracks)
                    slot["tracks"][st] = ti
                    tracks.append({"name": "", "notes": [], "staves": nst})
                    track_slot.append(slot)
                tr = tracks[ti]
                s = int(n["start"]) + offset
                e = int(n["end"]) + offset
                tr["notes"].append({"start": s, "end": e, "midi": int(n["midi"]),
                                    "vel": int(n.get("vel") or 80)})
                page_end = max(page_end, e)
                n_page += 1
        per_page_beats.append(round((page_end - offset) / float(tpb), 3))
        notes_per_page.append(n_page)
        checks.append(_page_checks(pg.get("page"), parts, bar_ticks, tpb, pg.get("system")))
        offset = page_end

    # ---- 乐器识别 + 移调（M2-3）----
    # Audiveris 装了 OCR 语言包后能读出乐器名（含 OCR 误识，如 Ham=Horn、Double Bum=Double Bass）。
    # 认出来的用途有两个：① 轨名给人看；② 移调乐器换成**实际音高** ——
    # 实测那份总谱 25 个声部里 8 个是移调乐器（Horn in F / Trumpet in Bb / Clarinet in Bb），
    # 不解移调的话三分之一的音是错的（Horn 差纯五度）。
    sounding = bool(opts.get("sounding", True))
    labels = []
    transposed = 0
    for i, tr in enumerate(tracks):
        # 轨名/乐器身份来自**槽位**（跨页合并后的那个声部），不是这一页的原始 part
        raw = (track_slot[i].get("raw") if i < len(track_slot) else "") or ""
        m = SI.match(raw) if raw else None
        if m:
            tr["name"] = SI.ascii_name(raw, "Part %d" % (i + 1))
            labels.append(SI.display_name(raw))
            tr["instrument"] = m["name"]
            tr["transpose"] = int(m["transpose"])
            if sounding and m["transpose"]:
                for n in tr["notes"]:
                    n["midi"] = max(0, min(127, int(n["midi"]) + int(m["transpose"])))
                transposed += 1
        else:
            tr["name"] = _safe_midi_name(raw, i)
            labels.append(("声部 %d" % (i + 1)) if _generic_name(raw) else str(raw)[:48])
            tr["instrument"] = ""
            tr["transpose"] = 0

    bpm = float(opts.get("bpm") or 0) or 120.0
    parts, stats = postprocess_parts(tracks, quantize=int(opts.get("quantize") or 0),
                                     min_ms=float(opts.get("min_ms") or 0),
                                     dedupe=bool(opts.get("dedupe", True)), tpb=tpb, bpm=bpm)
    parsed_out = {
        "parts": parts,
        "tpb": tpb,
        "tempos": opts.get("tempos") or [{"tick": 0, "bpm": bpm}],
        "times": (user_times or ([{"tick": 0, "beats": meter["beats"], "beatType": meter["beatType"]}]
                                 if meter else [{"tick": 0, "beats": 4, "beatType": 4}])),
        "keys": opts.get("keys") or [{"tick": 0, "fifths": 0}],
    }
    if out_mid:
        S2M.write_midi(parsed_out, out_mid)
    try:
        from engine_omr import apply_gm_programs
        apply_gm_programs(out_mid)
    except Exception as _e:
        print("  [音色] 回填跳过：" + str(_e)[:120])
    trk = []
    for i, p in enumerate(parts):
        ns = p["notes"]
        src = tracks[i] if i < len(tracks) else {}
        trk.append({"name": p["name"], "label": labels[i] if i < len(labels) else p["name"],
                    "instrument": src.get("instrument", ""), "transpose": src.get("transpose", 0),
                    "notes": len(ns),
                    "range": ([min(n["midi"] for n in ns), max(n["midi"] for n in ns)] if ns else None)})
    total = sum(t["notes"] for t in trk)
    last = 0
    for p in parts:
        for n in p["notes"]:
            last = max(last, n["end"])
    return {
        "ok": total > 0,
        "out": out_mid,
        "pageBeats": per_page_beats,
        "notesPerPage": notes_per_page,
        "pageChecks": checks,
        "tracks": trk,
        "sounding": sounding,
        "transposedTracks": transposed,
        "noteCount": total,
        "notes": total,
        "durationMs": S2M._ticks_to_ms(parsed_out, last),
        "stats": stats,
        "slotCount": len(slots),
        "keyConflicts": conflicts[:8],
        "meterInferred": bool(meter),          # 只有「从谱面推出来的」才算推断值（用户填的不算）
        "meterShare": (meter or {}).get("share"),
        "meterRaw": (meter or {}).get("raw"),
        "timeSig": "%d/%d" % ((user_times[0]["beats"], user_times[0]["beatType"]) if user_times
                              else ((meter["beats"], meter["beatType"]) if meter else (4, 4))),
        "regridded": regridded,
        "parsed": parsed_out,
    }


def mxl_to_parsed(mxl):
    """直接把 Audiveris 导出的 MusicXML 解析成内部结构（不再绕一次 MIDI 往返）。

    ★ 旧实现是「每页 mxl → 每页 MIDI → 再按轨名拼 MIDI」，中间那一步会把
      Audiveris 的通用声部名（全是 Voice / Piano）当成身份 —— 结果整部总谱塌成
      1~2 轨，还顺手丢了每页的拍号/调号上下文。改成在「谱」这一层合并。
    """
    import engine_score2midi as S2M
    try:
        text, _how = S2M.read_score_bytes(mxl)
        parsed = S2M.parse_musicxml(text)
    except Exception as e:                     # noqa: BLE001
        return {"ok": False, "error": str(e)[:300]}
    n = sum(len(p["notes"]) for p in parsed["parts"])
    if n == 0:
        return {"ok": False, "error": "这一页没有解析出任何音符"}
    return {"ok": True, "parsed": parsed, "noteCount": n}


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

# ---------------------------------------------------------------- 按页缓存（M2-4）
#: 「一键重试该页」靠它：整批跑完把**每页的解析结果**落在 workdir/pages/ 下，
#: 重试时只重跑那一页，其余页从缓存读回来再整份重新合并 —— 用户不必为了一页等整批。
#: 为什么不直接把上次的 MIDI 拼起来：合并层（小节网格推导 / 拍号推断 / 跨页声部对齐）
#: 必须看到**全部页**才能给出正确结果，所以重试的正确做法是「换掉一页、整份重算」。
PAGE_CACHE_DIR = "pages"


def _page_cache_name(page, system=None):
    return "p%03d%s.json" % (int(page or 0), "" if system is None else "-s%d" % int(system))


def cache_pages(workdir, pages):
    """把每页解析结果写进 workdir/pages/。失败不致命（只是下次不能单页重试）。"""
    try:
        d = os.path.join(workdir, PAGE_CACHE_DIR)
        os.makedirs(d, exist_ok=True)
        for pp in pages:
            name = _page_cache_name(pp.get("page"), pp.get("system"))
            with open(os.path.join(d, name), "w", encoding="utf-8") as fh:
                json.dump({"page": pp.get("page"), "system": pp.get("system"),
                           "parsed": pp.get("parsed"), "scale": pp.get("scale")}, fh, ensure_ascii=False)
    except Exception:                                # noqa: BLE001
        pass


def load_cached_pages(workdir, skip_page):
    """读回**除 skip_page 之外**的全部页（重试用）；没有缓存就返回 []。"""
    d = os.path.join(workdir, PAGE_CACHE_DIR)
    if not os.path.isdir(d):
        return []
    out = []
    for name in sorted(os.listdir(d)):
        if not name.endswith(".json"):
            continue
        try:
            with open(os.path.join(d, name), encoding="utf-8") as fh:
                pp = json.load(fh)
        except Exception:                            # noqa: BLE001
            continue
        if not pp.get("parsed"):
            continue
        if int(pp.get("page") or 0) == int(skip_page):
            continue
        out.append(pp)
    return out


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

def _track_notes(tr):
    """一轨的 note_on/note_off → 绝对 tick 的 (start, end, note, velocity)。"""
    t = 0
    on = {}
    notes = []
    for m in tr:
        t += m.time
        if m.type == "note_on" and m.velocity > 0:
            on.setdefault(m.note, []).append((t, m.velocity))
        elif m.type == "note_off" or (m.type == "note_on" and m.velocity == 0):
            lst = on.get(m.note)
            if lst:
                s, v = lst.pop(0)
                notes.append((s, t, m.note, v))
    for n, lst in on.items():
        for s, v in lst:
            notes.append((s, t, n, v))
    return notes


def postprocess_midi_file(path, quantize=0, min_ms=0.0, dedupe=True):
    """对**已经写好的 MIDI 文件**做量化/去重/短音过滤（就地改写）。

    Audiveris 路径在合并时就做了后处理；经典后端是自己写 MIDI 的，
    参数要真的生效只能在这一层补一刀 —— 否则界面上那两个参数就是摆设。
    """
    import mido
    mid = mido.MidiFile(path)
    tpb = int(mid.ticks_per_beat or 480)
    bpm = 120.0
    for tr in mid.tracks:
        for m in tr:
            if m.type == "set_tempo":
                bpm = 60000000.0 / float(m.tempo or 500000)
                break
        else:
            continue
        break
    min_ticks = int(round(min_ms / 60000.0 * bpm * tpb)) if min_ms else 0
    stats = {"notes": 0, "kept": 0, "quantized": 0, "dup": 0, "short": 0}
    for tr in mid.tracks:
        notes = _track_notes(tr)
        if not notes:
            continue
        stats["notes"] += len(notes)
        others = []
        t = 0
        for m in tr:
            t += m.time
            if m.type in ("note_on", "note_off"):
                continue
            others.append((t, m.copy(time=0)))
        keep = []
        seen = set()
        for (s, e, n, v) in notes:
            if quantize:
                s2 = int(round(s / float(quantize))) * quantize
                e2 = int(round(e / float(quantize))) * quantize
                if e2 <= s2:
                    e2 = s2 + quantize
                if (s2, e2) != (s, e):
                    stats["quantized"] += 1
                s, e = s2, e2
            if min_ticks and (e - s) < min_ticks:
                stats["short"] += 1
                continue
            if dedupe:
                k = (s, n)
                if k in seen:
                    stats["dup"] += 1
                    continue
                seen.add(k)
            keep.append((s, e, n, v))
        events = list(others)
        for (s, e, n, v) in keep:
            events.append((s, mido.Message("note_on", note=n, velocity=max(1, min(127, int(v))), time=0)))
            events.append((max(e, s + 1), mido.Message("note_off", note=n, velocity=0, time=0)))
        priority = {"track_name": 0, "set_tempo": 0, "time_signature": 0, "key_signature": 0,
                    "end_of_track": 3, "note_off": 1, "note_on": 2}
        events.sort(key=lambda x: (x[0], priority.get(x[1].type, 0)))
        tr.clear()
        pos = 0
        for tick, msg in events:
            msg.time = max(0, tick - pos)
            pos = tick
            tr.append(msg)
        stats["kept"] += len(keep)
    mid.save(path)
    return stats


def _scale_arg(v):
    """--upscale：auto / 1 / 2 / 3 / 4 → None 表示按实测行距自动决定。"""
    s = str(v if v is not None else "auto").strip().lower()
    if s in ("", "auto", "0", "none"):
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if f > 0 else None


def _bool_arg(v, default=False):
    s = str(v if v is not None else "").strip().lower()
    if s in ("on", "1", "true", "yes"):
        return True
    if s in ("off", "0", "false", "no"):
        return False
    return default


def _quantize_ticks(v, tpb=480):
    """--quantize：off | 1/4 | 1/8 | 1/16 | 1/32（也可以用绝对 tick 数）。"""
    s = str(v if v is not None else "off").strip().lower()
    if s in ("", "off", "none", "0"):
        return 0
    try:
        if "/" in s:
            num, den = s.split("/", 1)
            whole = tpb * 4.0                       # 全音符 = 4 拍
            return max(1, int(round(whole * float(num) / float(den))))
        return max(0, int(round(float(s))))
    except Exception:                              # noqa: BLE001
        return 0


def _meta_override(args, parsed):
    """速度 / 拍号 / 调号：**谱面自带的优先**；用户在界面上显式填了才覆盖。

    ★ 以前 --beats/--tempo 在 Audiveris 路径上完全没人读（只用于经典后端），
      所以界面上那三个控件是「做了但没作用」。现在它们是真读的，且默认 auto。
    """
    tpb = int(parsed.get("tpb") or 480)
    bpm = float((parsed.get("tempos") or [{"bpm": 120}])[0].get("bpm") or 120)
    tv = str(getattr(args, "tempo", "auto")).strip().lower()
    if tv not in ("", "auto", "0", "none"):
        try:
            bpm = float(tv)
        except ValueError:
            pass
    times = list(parsed.get("times") or [{"tick": 0, "beats": 4, "beatType": 4}])
    bv = str(getattr(args, "beats", "auto")).strip().lower()
    if bv not in ("", "auto", "0", "none"):
        try:
            beats = max(1, min(16, int(float(bv))))
            beat_type = int(getattr(args, "beat_type", 4) or 4)
            if beat_type not in (2, 4, 8, 16):
                beat_type = 4
            times = [{"tick": 0, "beats": beats, "beatType": beat_type}]
        except ValueError:
            pass
    elif not parsed.get("timesFromScore"):
        # ★ auto + 谱面本来就没写 <time>：**不要**把解析器的默认 4/4 当成"谱面自带的"传下去，
        #   否则 merge_pages 会以为是用户指定的拍号，推断根本没机会跑（实测就是这么白跑一轮的）。
        #   留空 → 由 infer_meter 从各声部的小节长度推，推不出来才回落 4/4。
        times = []
    return {
        "tpb": tpb,
        "bpm": bpm,
        "tempos": [{"tick": 0, "bpm": bpm}],
        "times": times,
        "keys": list(parsed.get("keys") or [{"tick": 0, "fifths": 0}]),
        "quantize": _quantize_ticks(getattr(args, "quantize", "off"), tpb),
        "min_ms": float(getattr(args, "min_note_ms", 0) or 0),
        "dedupe": _bool_arg(getattr(args, "dedupe", "on"), True),
        # 移调乐器：True = 写实际音高（默认，DAW 里才是对的音），False = 按谱面记谱音高
        "sounding": _bool_arg(getattr(args, "sounding", "on"), True),
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("cmd", nargs="?", default="to-midi")
    ap.add_argument("--in", dest="inputs", action="append", default=[])
    ap.add_argument("--out", default="")
    ap.add_argument("--backend", default="auto")           # auto | classical | audiveris | homr
    ap.add_argument("--beats", default="auto")
    ap.add_argument("--beat-type", type=int, default=4)
    # ★ 不能用 type=float：auto 是合法取值，argparse 的 float() 会在解析阶段直接退出（退出码 2），
    #   表现为「引擎没有返回结果（退出码 2）」—— 实测就是这么被端到端探针抓到的。
    ap.add_argument("--tempo", default="auto", help="速度 BPM：auto（用谱面自带的）或数字覆盖")
    ap.add_argument("--mode", default="auto")
    ap.add_argument("--overlay", default="")
    ap.add_argument("--workdir", default="")
    ap.add_argument("--audiveris", default="", help="Audiveris 可执行文件路径（应用侧按数据根目录传入）")
    ap.add_argument("--homr", default="", help="homr 可执行文件路径（应用侧按数据根目录下的 venv 传入）")
    ap.add_argument("--retry-page", default="",
                    help="只重跑第 N 页（1 起），其余页从 --workdir 的按页缓存读回后再整份合并")
    ap.add_argument("--report", default="")
    ap.add_argument("--upscale", default="auto",
                    help="预处理放大倍数：auto（按实测谱线间距推）| 1 | 2 | 3 | 4")
    ap.add_argument("--thicken", default="off",
                    help="二值化后 3×3 加粗：on | off（默认 off —— 加粗会让密集总谱整页判 invalid）")
    ap.add_argument("--sr", default="auto",
                    help="超分辨率预处理（M3-2）：off | auto（只在实测行距 <11px 的页上开）| on")
    ap.add_argument("--sr-exe", default="", help="waifu2x-ncnn-vulkan 路径（应用侧按数据根目录传入）")
    ap.add_argument("--prep", default="auto",
                    help="共用影像预处理层（M3-3）：off | auto（像扫描件/照片才上）| scan（强制）")
    ap.add_argument("--quantize", default="off", help="量化网格：off | 1/4 | 1/8 | 1/16 | 1/32")
    ap.add_argument("--min-note-ms", type=float, default=0.0, help="丢掉短于该时长的音符（毫秒，0=不过滤）")
    ap.add_argument("--dedupe", default="on", help="同一个符头被识别两次时去重：on | off")
    ap.add_argument("--sounding", default="on",
                    help="移调乐器写实际音高（on，默认）还是按谱面记谱音高（off）")
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

    # ★ 经典后端的 --tempo 是 float()，而新参数允许 "auto" —— 这里换回数字再传过去
    try:
        cl_tempo = float(args.tempo)
    except (TypeError, ValueError):
        cl_tempo = 120.0
    extra = ["--beats", str(args.beats), "--beat-type", str(args.beat_type),
             "--tempo", str(cl_tempo), "--mode", str(args.mode),
             "--prep", prep_arg(args.prep)]

    wanted = str(args.backend).lower()
    have_av = find_audiveris(explicit=(args.audiveris or None)) if wanted in ("auto", "audiveris") else None
    have_homr = find_homr(explicit=(args.homr or None)) if wanted in ("auto", "homr") else None
    # auto：Audiveris 优先（印刷谱 / 矢量 PDF 更强），它没装才用 homr（扫描件 / 拍照更强）。
    # 两个都装着的用户可以在界面上显式选 homr —— 实测它更适合照片与低清扫描件。
    backend = "classical"
    if wanted == "homr" or (wanted == "auto" and not have_av and have_homr):
        backend = "homr"
    elif wanted == "audiveris" or (wanted == "auto" and have_av):
        backend = "audiveris"

    # ★ 「一键重试该页」（M2-4）：只把**那一页**喂给后端，其余页从上次的缓存读回来，
    #   再走同一条合并流水线 —— 合并看到的是完整页集，所以拍号/小节网格/跨页声部都不会变。
    retry_page = 0
    try:
        retry_page = int(str(getattr(args, "retry_page", "") or "0").strip() or 0)
    except Exception:                                # noqa: BLE001
        retry_page = 0
    feed_inputs = args.inputs
    cached_pages = []
    total_pages = len(args.inputs)
    if retry_page:
        if not (1 <= retry_page <= len(args.inputs)):
            emit("RESULT", {"ok": False, "code": "bad-page",
                            "error": "要重试的页号超出范围：%d（共 %d 页）" % (retry_page, len(args.inputs))})
            return 2
        cached_pages = load_cached_pages(workdir, retry_page)
        if not cached_pages:
            emit("RESULT", {"ok": False, "code": "no-cache",
                            "error": "找不到上次的识别结果，无法只重试这一页。请整批重跑一次。"})
            return 1
        feed_inputs = [args.inputs[retry_page - 1]]
        prog(8, "只重跑第 %d 页（其余 %d 页用上次的结果）" % (retry_page, len(cached_pages)))

    notes = []
    result = None
    if backend in ("audiveris", "homr"):
        if backend == "audiveris" and not have_av:
            result = {"ok": False, "error": "没有找到 Audiveris（可在资源中心安装识谱引擎）", "code": "backend-missing"}
        elif backend == "homr" and not have_homr:
            result = {"ok": False, "error": "没有找到 homr（可在资源中心「AI 识谱」里安装）", "code": "backend-missing"}
        else:
            # 两个栅格引擎在后处理上完全同路：都是「每页一份 MusicXML → mxl_to_parsed → merge_pages」
            if backend == "audiveris":
                raster = run_audiveris(feed_inputs, workdir, explicit=(args.audiveris or None),
                                       scale=_scale_arg(args.upscale), thicken=_bool_arg(args.thicken, False),
                                       prep=prep_arg(args.prep), sr=str(args.sr or "off").lower(),
                                       sr_exe=(args.sr_exe or None))
            else:
                # homr 不接这两层：它的网络在**原始扫描件**上训练、自带归一化与缩放，
                # 再超分/二值化一遍等于双重处理（实测会掉音符）。
                raster = run_homr(feed_inputs, workdir, explicit=(args.homr or None))
            page_list = raster.get("pages") or []
            parsed_pages = []
            warnings = []
            for i, pg in enumerate(page_list):
                if not pg.get("ok"):
                    reasons = pg.get("reasons") or []
                    warnings.append({"code": "page-failed", "page": pg.get("page"),
                                     "fail": classify_failure(reasons), "reasons": reasons})
                    continue
                prog(60 + int(20 * (i + 1) / max(1, len(page_list))),
                     "解析 MusicXML %d/%d" % (i + 1, len(page_list)))
                if pg.get("banded"):
                    # 分带页：一个「系统」= 一个时间块；同一系统里多带是同时刻的，parts 相加
                    for s in pg.get("systems") or []:
                        parts = []
                        for m in s["mxl"]:
                            info = mxl_to_parsed(m)
                            if info.get("ok"):
                                parts.extend(info["parsed"]["parts"])
                        if not parts:
                            continue
                        parsed_pages.append({"page": pg.get("page"), "system": s["system"],
                                             "parsed": {"parts": parts, "tpb": 480},
                                             "scale": pg.get("scale"), "mxl": s["mxl"][0]})
                    continue
                info = mxl_to_parsed(pg["mxl"])
                if not info.get("ok"):
                    warnings.append({"code": "page-unreadable", "page": pg.get("page"),
                                     "detail": str(info.get("error"))[:200]})
                    continue
                parsed_pages.append({"page": pg.get("page"), "parsed": info["parsed"],
                                     "scale": pg.get("scale"), "mxl": pg.get("mxl")})
            if retry_page:
                # 单页重跑时后端把它当第 1 页 → 页号改回真实页号，再与缓存页拼成完整页集
                for pp in parsed_pages:
                    pp["page"] = retry_page
                cache_pages(workdir, parsed_pages)
                parsed_pages = sorted(cached_pages + parsed_pages,
                                      key=lambda x: (int(x.get("page") or 0), int(x.get("system") or 0)))
                total_pages = max(total_pages, max(int(p.get("page") or 0) for p in parsed_pages))
            else:
                cache_pages(workdir, parsed_pages)
            if parsed_pages:
                # 速度记号只认第 1 页（重试别的页时那次跑出来的 metronome 与全曲无关，必须丢掉）
                ov = _meta_override(args, parsed_pages[0]["parsed"])
                # ★ 速度：Audiveris 不导出 <sound tempo>，但它的 OCR 把谱面左上那个速度记号
                #   留在了 .omr 里（role="Metronome"）。读准了就用（用户没显式填时），
                #   读不准就如实标出来让界面提示手填 —— 见 read_metronome_from_omr 的注释。
                metro = {} if retry_page else (raster.get("metronome") or {})
                tmark = {} if retry_page else (raster.get("tempoMark") or {})
                bpm_source = "default"
                if str(getattr(args, "tempo", "auto")).strip().lower() not in ("", "auto", "0", "none"):
                    bpm_source = "user"
                elif metro.get("bpm"):
                    ov["bpm"] = float(metro["bpm"])
                    ov["tempos"] = [{"tick": 0, "bpm": float(metro["bpm"])}]
                    bpm_source = "metronome"
                elif tmark.get("bpm"):
                    # 谱面左上那个速度记号 OCR 出来的（附点四分 = 60 → 四分音符 90）
                    ov["bpm"] = float(tmark["bpm"])
                    ov["tempos"] = [{"tick": 0, "bpm": float(tmark["bpm"])}]
                    bpm_source = "tempo-mark"
                elif metro.get("found") and metro.get("unreadable"):
                    bpm_source = "metronome-unreadable"
                mg = merge_pages(parsed_pages, out_mid, ov)
                pages_ok = len({pp.get("page") for pp in parsed_pages})
                if pages_ok < total_pages:
                    warnings.append({"code": "page-partial", "ok": pages_ok,
                                     "total": total_pages})
                # 没装 OCR 语言包 → Audiveris 的 TEXTS 步整段跳过：乐器名/速度记号/和弦名全丢，
                # 声部只能叫「声部 N」。这不是失败，但用户该知道装了能得到什么。
                if backend == "audiveris" and not (raster.get("ocrLangs") or []):
                    warnings.append({"code": "no-ocr-lang"})
                result = {
                    "ok": True,
                    "backend": backend,
                    "engine": backend,
                    "elapsed": raster.get("elapsed"),
                    "pages": len({pp.get("page") for pp in parsed_pages}),
                    "systems": len(parsed_pages),
                    "pageTotal": total_pages,
                    "notesPerPage": mg["notesPerPage"],
                    "pageChecks": mg.get("pageChecks") or [],
                    "noteCount": mg["noteCount"],
                    "notes": mg["noteCount"],
                    "tracks": mg["tracks"],
                    "timeSig": mg.get("timeSig"),
                    "meterInferred": mg.get("meterInferred"),
                    "meterShare": mg.get("meterShare"),
                    "regridded": mg.get("regridded"),
                    "sounding": mg.get("sounding"),                 # 界面「移调校正 N 个声部」
                    "transposedTracks": mg.get("transposedTracks"),
                    "keyConflicts": mg.get("keyConflicts") or [],
                    "warnings": warnings,
                    "mxl": raster.get("mxl"),
                    "pageBeats": mg["pageBeats"],
                    "durationMs": mg["durationMs"],
                    "stats": mg["stats"],
                    "scales": [p.get("scale") for p in parsed_pages],
                    "ocrLangs": raster.get("ocrLangs") or [],
                    "bpm": ov["bpm"],
                    "bpmSource": bpm_source,
                    "metronomeRaw": (metro.get("raw") or [])[:4],
                    "tempoMarkRaw": (tmark.get("raw") or [])[:4],
                    "tempoMarkDotted": bool(tmark.get("dotted")),
                    # 拍号以**合并结果**为准（可能来自推断）；ov["times"] 在 auto 且谱面没写时是空的
                    "timeSig": mg.get("timeSig") or "4/4",
                    "quantize": str(args.quantize),
                    "thicken": _bool_arg(args.thicken, False),
                    "prep": prep_arg(args.prep),
                    "prepInfo": raster.get("prepInfo") or [],
                    "sr": str(args.sr or "off").lower(),
                    "srInfo": raster.get("srInfo") or [],
                    # ★ M2-4「一键重试该页」：界面要拿 workdir 回来重试，并知道这次是不是重试
                    "workdir": workdir,
                    "retryPage": retry_page or None,
                }
            else:
                result = {"ok": False, "backend": backend,
                          "error": ("Audiveris" if backend == "audiveris" else "homr") + " 一页都没能解析出音符",
                          "warnings": warnings, "pages": len(page_list)}
                result.update({k: raster.get(k) for k in ("elapsed", "log") if raster.get(k)})
    if retry_page and (result is None or not result.get("ok")):
        # 单页重试只对栅格增强后端成立（它才有逐页解析结果可缓存）。
        # 经典后端不返回逐页解析数据，硬跑一遍等于整批重来 —— 如实说清楚，不要假装成功。
        emit("RESULT", {"ok": False, "code": "retry-needs-raster",
                        "error": "「重试该页」只支持 Audiveris / homr 引擎；内置识谱请整批重跑。",
                        "backend": backend})
        return 1
    if result is None or (not result.get("ok") and wanted == "auto"):
        # 降级：经典后端兜底（离线永远可用），并把「为什么没用增强引擎」如实回报
        prog(55, "经典识谱（离线）")
        cl_inputs = args.inputs
        cl_sr = []
        try:
            cl_inputs, cl_sr = sr_prepare_inputs(args.inputs, workdir, str(args.sr or "off").lower(),
                                                 tag="sr-cl", exe=(args.sr_exe or None))
            if any(x.get("used") for x in cl_sr):
                prog(56, "超分辨率预处理（经典识谱）")
        except Exception:                            # noqa: BLE001
            cl_inputs, cl_sr = args.inputs, []
        info = run_classical(args, cl_inputs, out_mid, args.overlay, extra)
        if cl_sr:
            info["sr"] = str(args.sr or "off").lower()
            info["srInfo"] = cl_sr
        # 后处理参数在经典后端也要真的生效（它自己写 MIDI，量化只能在这一层补）
        if info.get("ok"):
            try:
                info["stats"] = postprocess_midi_file(out_mid, _quantize_ticks(args.quantize),
                                                      float(args.min_note_ms or 0),
                                                      _bool_arg(args.dedupe, True))
            except Exception as e:                 # noqa: BLE001
                info.setdefault("warnings", []).append({"code": "postprocess-failed",
                                                        "detail": str(e)[:200]})
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
