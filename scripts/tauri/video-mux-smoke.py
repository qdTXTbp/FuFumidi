#!/usr/bin/env python3
"""无窗口视频封装 smoke：生成 1s 合成 H.264 + WAV，再按 video_export_end 的 ffmpeg 参数封装 MP4。

验证的是「裸 H.264 stream copy + AAC + -t 精确时长 + faststart」这条封装链；
不是 WebCodecs 编码本身。需要 resources/python 的 imageio_ffmpeg。
"""
import json
import os
import subprocess
import tempfile

import imageio_ffmpeg


def main():
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    d = tempfile.mkdtemp(prefix="fufumidi-video-smoke-")
    h264 = os.path.join(d, "t.h264")
    wav = os.path.join(d, "a.wav")
    out = os.path.join(d, "out.mp4")

    def run(args):
        r = subprocess.run([ff] + args, capture_output=True)
        return r.returncode, (r.stderr or b"").decode("utf-8", "replace")[-300:]

    errors = []
    c1, e1 = run(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                  "-i", "testsrc=size=160x90:rate=24:duration=1",
                  "-c:v", "libx264", "-pix_fmt", "yuv420p", "-f", "h264", h264])
    errors.append(e1)
    c2, e2 = run(["-y", "-hide_banner", "-loglevel", "error", "-f", "lavfi",
                  "-i", "sine=frequency=440:duration=1", "-c:a", "pcm_s16le", wav])
    errors.append(e2)
    args = ["-y", "-hide_banner", "-loglevel", "error",
            "-r", "24", "-f", "h264", "-framerate", "24", "-i", h264,
            "-i", wav, "-map", "0:v:0", "-map", "1:a:0",
            "-c:v", "copy", "-pix_fmt", "yuv420p", "-c:a", "aac",
            "-t", "1.000000", "-movflags", "+faststart", out]
    c3, e3 = run(args)
    errors.append(e3)
    print(json.dumps({
        "ok": c1 == 0 and c2 == 0 and c3 == 0 and os.path.exists(out) and os.path.getsize(out) > 0,
        "bytes": os.path.getsize(out) if os.path.exists(out) else 0,
        "ffmpeg": ff,
        "errors": errors,
    }, ensure_ascii=False))
    raise SystemExit(0 if c1 == 0 and c2 == 0 and c3 == 0 else 1)


if __name__ == "__main__":
    main()
