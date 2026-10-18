"""音频时长探测：不把整个文件读进内存（1.4GB 的 flac 解码进渲染进程会卡死界面）。

用法：python audio_probe.py <file> [<file>...]
输出：###RESULT {"ok": true, "seconds": 1234.5}（多文件时为 {"ok":true,"items":[...]}）
"""
import json
import re
import subprocess
import sys

DUR = re.compile(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)")


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return "ffmpeg"


def probe(path):
    try:
        r = subprocess.run([ffmpeg_exe(), "-hide_banner", "-i", path], capture_output=True,
                           text=True, errors="ignore", timeout=120)
        m = DUR.search(r.stderr or "")
        if not m:
            return {"ok": False, "error": (r.stderr or "")[-200:]}
        sec = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
        return {"ok": True, "seconds": sec}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}


def main():
    files = sys.argv[1:]
    if not files:
        print("###RESULT " + json.dumps({"ok": False, "error": "缺少文件参数"}))
        return
    if len(files) == 1:
        print("###RESULT " + json.dumps(probe(files[0]), ensure_ascii=False))
        return
    print("###RESULT " + json.dumps({"ok": True, "items": [dict(probe(f), file=f) for f in files]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
