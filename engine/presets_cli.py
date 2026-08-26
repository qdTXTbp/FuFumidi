#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
预设 CLI：把 presets.py 的操作封装为命令行子命令（供 Electron 主进程调用）。
================================================================================
替代原先在 main.js 里用 `python -c` 拼接 Python 代码的做法——消除字符串注入面，
参数全部通过 argv 传入，输出统一为一行 ###RESULT JSON（与主进程逐行解析约定一致）。

用法:
    python presets_cli.py list
    python presets_cli.py save <name> <mode> <params-json>
    python presets_cli.py delete <name>
    python presets_cli.py last-used <name>
    python presets_cli.py reorder <name> <delta>
    python presets_cli.py reorder-to <name> <index>
    python presets_cli.py restore
"""

import argparse
import json
import sys


def _emit(obj):
    print("###RESULT " + json.dumps(obj, ensure_ascii=False), flush=True)
    return 0


def _fail(e):
    return _emit({"ok": False, "error": str(e)[-400:]})


def cmd_list():
    try:
        import presets
        p, last = presets.load_presets()
        return _emit({"ok": True, "presets": p, "last_used": last,
                      "builtins": list(presets._builtin_presets().keys())})
    except Exception as e:
        return _fail(e)


def cmd_save(name, mode, params):
    try:
        import presets
        ok = presets.save_preset(name, mode, params)
        if ok:
            presets.save_last_used(name)
        return _emit({"ok": True, "saved": bool(ok)})
    except Exception as e:
        return _fail(e)


def cmd_delete(name):
    try:
        import presets
        ok = presets.delete_preset(name)
        return _emit({"ok": True, "deleted": bool(ok)})
    except Exception as e:
        return _fail(e)


def cmd_last_used(name):
    try:
        import presets
        presets.save_last_used(name)
        return _emit({"ok": True})
    except Exception as e:
        return _fail(e)


def cmd_reorder(name, delta):
    try:
        import presets
        order = presets.reorder_preset(name, delta)
        return _emit({"ok": True, "order": order})
    except Exception as e:
        return _fail(e)


def cmd_reorder_to(name, index):
    try:
        import presets
        order = presets.reorder_preset_to(name, index)
        return _emit({"ok": True, "order": order})
    except Exception as e:
        return _fail(e)


def cmd_restore():
    try:
        import presets
        ok = presets.restore_all_builtins()
        return _emit({"ok": True, "restored": bool(ok)})
    except Exception as e:
        return _fail(e)


def _parse_params(raw):
    """解析 params-json 字符串；失败返回 None。"""
    if not raw:
        return {}
    try:
        v = json.loads(raw)
        return v if isinstance(v, dict) else {}
    except Exception:
        return None


def main(argv=None):
    ap = argparse.ArgumentParser(prog="presets_cli", description="参数预设命令行接口")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("list", help="列出全部预设与上次使用")

    p = sub.add_parser("save", help="保存/覆盖预设")
    p.add_argument("name")
    p.add_argument("mode")
    p.add_argument("params", nargs="?", default="{}")

    p = sub.add_parser("delete", help="删除预设")
    p.add_argument("name")

    p = sub.add_parser("last-used", help="记录上次使用的预设")
    p.add_argument("name")

    p = sub.add_parser("reorder", help="上移/下移预设")
    p.add_argument("name")
    p.add_argument("delta", type=int)

    p = sub.add_parser("reorder-to", help="把预设移到指定下标")
    p.add_argument("name")
    p.add_argument("index", type=int)

    sub.add_parser("restore", help="恢复全部内置预设")

    args = ap.parse_args(argv)

    if args.cmd == "list":
        return cmd_list()
    if args.cmd == "save":
        params = _parse_params(args.params)
        if params is None:
            return _emit({"ok": False, "error": "params 不是合法 JSON 对象"})
        return cmd_save(args.name, args.mode, params)
    if args.cmd == "delete":
        return cmd_delete(args.name)
    if args.cmd == "last-used":
        return cmd_last_used(args.name)
    if args.cmd == "reorder":
        return cmd_reorder(args.name, args.delta)
    if args.cmd == "reorder-to":
        return cmd_reorder_to(args.name, args.index)
    if args.cmd == "restore":
        return cmd_restore()
    ap.print_help()
    return 1


if __name__ == "__main__":
    sys.exit(main())
