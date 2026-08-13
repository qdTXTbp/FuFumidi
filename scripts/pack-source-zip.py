#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
FuFumidi 源码包打包脚本
======================
用 zipfile 生成**真 zip**（GNU tar -a 只产出 ustar tar，Explorer 无法解压）。

收录：
  - 顶层文档：AGENTS.md / CHANGELOG.md / UPDATE.md / .gitignore / .github/
  - app/ 源码（排除构建产物：node_modules / dist / python / __pycache__ / *.pyc）

用法：
  python scripts/pack-source-zip.py [输出路径]
  默认输出到 <Fu>/release/FuFumidi-Source-<version>.zip
"""
import json
import os
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP = os.path.join(ROOT, "app")
PKG = os.path.join(APP, "package.json")

def load_version():
    with open(PKG, "r", encoding="utf-8") as f:
        return json.load(f)["version"]

def excluded(name, path):
    """返回 True 表示该目录/文件不入包。"""
    if path == APP:
        return False
    base = os.path.basename(path)
    if name in ("__pycache__", ".pytest_cache", ".coverage"):
        return True
    if name.endswith(".pyc"):
        return True
    if path in (os.path.join(APP, "node_modules"), os.path.join(APP, "dist"),
                os.path.join(APP, "python")):
        return True
    # 打包素材中的历史产物（1.0.0 审计剔除项）
    if name in ("_backup_prev", "_old_icon"):
        return True
    return False

def main():
    version = load_version()
    out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "release",
                             f"FuFumidi-Source-{version}.zip")
    os.makedirs(os.path.dirname(out), exist_ok=True)

    top = [os.path.join(ROOT, p) for p in
           ("AGENTS.md", "CHANGELOG.md", "UPDATE.md", ".gitignore", ".github")]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for p in top:
            if os.path.isfile(p):
                zf.write(p, os.path.join("FuFumidi-Source", os.path.basename(p)))
            elif os.path.isdir(p):
                for root, dirs, files in os.walk(p):
                    dirs[:] = [d for d in dirs if not excluded(d, os.path.join(root, d))]
                    for f in files:
                        fp = os.path.join(root, f)
                        if excluded(f, fp):
                            continue
                        arc = os.path.join("FuFumidi-Source", os.path.relpath(fp, ROOT))
                        zf.write(fp, arc)
        # app/
        for root, dirs, files in os.walk(APP):
            dirs[:] = [d for d in dirs if not excluded(d, os.path.join(root, d))]
            for f in files:
                fp = os.path.join(root, f)
                if excluded(f, fp):
                    continue
                arc = os.path.join("FuFumidi-Source", os.path.relpath(fp, ROOT))
                zf.write(fp, arc)
    size = os.path.getsize(out)
    print(f"OK {out}  ({size/1048576:.1f} MB)")

if __name__ == "__main__":
    main()
