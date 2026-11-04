#!/usr/bin/env python3
"""无窗口 cover 引擎 smoke：合成 1s WAV，走 analyze（显式 vocals/instrumental，跳过分离模型）。

验证 engine_cover.py 能启动、读音频、返回 ###RESULT；不跑 RVC 转换/混音。
"""
import json
import os
import subprocess
import sys
import tempfile

import imageio_ffmpeg

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
PY = os.path.join(ROOT, "resources", "python", "python.exe")
ENGINE = os.path.join(ROOT, "engine", "engine_cover.py")


def main():
    d = tempfile.mkdtemp(prefix="fufumidi-cover-smoke-")
    wav = os.path.join(d, "a.wav")
    out = os.path.join(d, "out")
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    r1 = subprocess.run([ff, "-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                         "-i", "sine=frequency=440:duration=1", "-ar", "44100", "-ac", "1", wav],
                        capture_output=True)
    r2 = subprocess.run([PY, ENGINE, "analyze", wav, "--outdir", out, "--no-separate",
                         "--vocals", wav, "--instrumental", wav],
                        capture_output=True, cwd=os.path.join(ROOT, "engine"))
    text = (r2.stdout or b"").decode("utf-8", "replace") + (r2.stderr or b"").decode("utf-8", "replace")
    result = None
    for line in text.splitlines():
        if line.startswith("###RESULT "):
            try:
                result = json.loads(line[len("###RESULT "):])
            except Exception:
                pass
    ok = r1.returncode == 0 and r2.returncode == 0 and bool(result and result.get("ok"))
    print(json.dumps({"ok": ok, "status": r2.returncode, "result": result,
                      "tail": text[-400:] if not ok else ""}))
    raise SystemExit(0 if ok else 1)


if __name__ == "__main__":
    main()
