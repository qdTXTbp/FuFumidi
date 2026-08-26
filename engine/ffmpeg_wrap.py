#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ffmpeg 转码封装（视频 → MP4，供视频导出使用）。

argv[1] 为 JSON 编码的 ffmpeg 参数数组，避免在 JS 里用 `python -c` 拼接代码。
"""

import json
import subprocess
import sys

import imageio_ffmpeg


def main():
    ff = imageio_ffmpeg.get_ffmpeg_exe()
    try:
        args = json.loads(sys.argv[1])
        if not isinstance(args, list) or not args:
            raise ValueError("args 必须是非空数组")
    except Exception as e:
        print(json.dumps({"ok": False, "err": "参数解析失败: %s" % e}, ensure_ascii=False))
        return 1
    r = subprocess.run([ff] + args, capture_output=True)
    print(json.dumps({
        "ok": r.returncode == 0,
        "err": (r.stderr or b"").decode("utf-8", "replace")[-300:],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
