#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ffmpeg 转码封装（视频 → MP4，供视频导出使用）。

argv[1] 为 JSON 编码的 ffmpeg 参数数组，避免在 JS 里用 `python -c` 拼接代码。
输出统一为一行 `###RESULT {json}`（与主进程逐行解析约定一致）。
"""

import json
import subprocess
import sys

try:
    import imageio_ffmpeg
except Exception as _e:
    print("###RESULT " + json.dumps({"ok": False, "err": "imageio_ffmpeg 不可用: %s" % _e}, ensure_ascii=False))
    sys.exit(1)


def main():
    try:
        ff = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception as e:
        print("###RESULT " + json.dumps({"ok": False, "err": "找不到 ffmpeg: %s" % e}, ensure_ascii=False))
        return 1
    try:
        args = json.loads(sys.argv[1])
        if not isinstance(args, list) or not args:
            raise ValueError("args 必须是非空数组")
    except Exception as e:
        print("###RESULT " + json.dumps({"ok": False, "err": "参数解析失败: %s" % e}, ensure_ascii=False))
        return 1
    r = subprocess.run([ff] + args, capture_output=True)
    print("###RESULT " + json.dumps({
        "ok": r.returncode == 0,
        "err": (r.stderr or b"").decode("utf-8", "replace")[-300:],
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
