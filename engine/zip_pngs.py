#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把指定目录下的 PNG 打包成 ZIP（供乐谱导出使用，argv 传参，避免 -c 拼接）。"""

import glob
import os
import sys
import zipfile


def main():
    out = sys.argv[1]
    d = sys.argv[2]
    z = zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED)
    for f in glob.glob(os.path.join(d, "*.png")):
        z.write(f, os.path.basename(f))
    z.close()
    print("###RESULT " + str({"ok": True, "out": out}))


if __name__ == "__main__":
    main()
