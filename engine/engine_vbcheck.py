#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""声库体检：装进来的 UTAU / DiffSinger 声库到底能不能用，一眼看清。

为什么要有它：实测「烦恼歌」时踩到的坑（HowHow_CV 没有 character.txt 直接整库不可用、
ChenZhe_Voice 的 oto.ini 用空别名导致界面误报 713 条歌词不合法）全都是**渲染失败之后**
才发现的。这些事实在装库/选库时就能算出来，不该让用户等一次几十秒的渲染。

协议与其它引擎一致：stdout 一行 `###RESULT {json}`。

用法：python engine_vbcheck.py --voicebank "<声库目录>" [--engine utau|diffsinger] [--lyrics a b c]
"""
import argparse
import json
import os
import struct
import sys


def _result(obj, code=0):
    sys.stdout.write('###RESULT ' + json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()
    return code


def _read_text(path):
    """按 BOM / UTF-8 / cp932 顺序严格试解 —— 与引擎侧的兜底策略一致。"""
    with open(path, "rb") as f:
        data = f.read()
    for enc in ("utf-8-sig", "utf-8", "cp932"):
        try:
            return data.decode(enc), enc
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("utf-8", errors="replace"), "utf-8(replace)"


def check_utau(vb, lyrics):
    checks = []
    stats = {}

    def add(cid, level, text, fix=""):
        checks.append({"id": cid, "level": level, "text": text, "fix": fix})

    if not os.path.isdir(vb):
        add("dir", "error", "声库目录不存在：%s" % vb, "重新安装/导入这个声库")
        return checks, stats
    oto = os.path.join(vb, "oto.ini")
    char_txt = os.path.join(vb, "character.txt")
    char_yaml = os.path.join(vb, "character.yaml")

    if not os.path.isfile(oto):
        add("oto", "error", "缺少 oto.ini —— 引擎无法定位任何采样", "UTAU 声库必须有 oto.ini；重新解压声库压缩包")
        return checks, stats
    text, enc = _read_text(oto)
    stats["oto_encoding"] = enc
    lines = [l.strip() for l in text.splitlines() if l.strip() and "=" in l]
    stats["oto_lines"] = len(lines)
    if len(lines) == 0:
        add("oto_parse", "error", "oto.ini 一行都没解析出来（编码或格式不对）",
            "确认是不是 Shift-JIS/UTF-8 文本；首行可写 `#Charset: utf-8` 声明编码")
    else:
        add("oto_parse", "ok", "oto.ini 解析出 %d 行原音设定（编码 %s）" % (len(lines), enc))

    entries = []
    bad_params = 0
    for line in lines:
        head, _, params = line.partition("=")
        parts = [p.strip() for p in params.split(",")]
        if len(parts) < 5:
            bad_params += 1
            continue
        alias = parts[0] or os.path.splitext(os.path.basename(head))[0]
        entries.append((head.strip(), alias))
    stats["oto_entries"] = len(entries)
    stats["oto_bad_lines"] = bad_params
    if bad_params:
        add("oto_fields", "warn", "有 %d 行的参数不足 5 个（会被忽略）" % bad_params, "用 SetParam / 原声设定工具重新导出 oto.ini")

    aliases = sorted({a.lower() for _, a in entries})
    stats["alias_count"] = len(aliases)
    empty_alias = sum(1 for h, a in entries if a and a.lower() == os.path.splitext(os.path.basename(h))[0].lower())
    stats["filename_alias_count"] = empty_alias
    add("aliases", "ok", "可用别名 %d 个（其中 %d 个来自文件名兜底）" % (len(aliases), empty_alias))

    missing = sorted({h for h, _ in entries if h and not os.path.isfile(os.path.join(vb, h))})
    stats["missing_wav"] = len(missing)
    if missing:
        add("wav", "error", "有 %d 个 oto 条目指向不存在的 wav（例：%s）" %
            (len(missing), ", ".join(missing[:3])), "声库解压不完整，重新安装")
    else:
        add("wav", "ok", "oto 里引用的采样文件都存在")

    if os.path.isfile(char_txt):
        add("character", "ok", "有 character.txt（显示名/作者等信息齐全）")
    elif os.path.isfile(char_yaml):
        add("character", "ok", "有 character.yaml")
    else:
        add("character", "warn", "没有 character.txt / character.yaml（不影响出声，显示名用目录名）",
            "可选：放一个 character.txt 写上 name= 与 image= 更规整")

    if lyrics:
        aset = set(aliases)
        miss = sorted({str(s).lower() for s in lyrics if str(s).lower() not in aset})
        stats["lyrics_checked"] = len(lyrics)
        stats["lyrics_missing"] = len(miss)
        if miss:
            add("lyrics", "warn", "当前歌词里有 %d 个不在别名表（例：%s）" % (len(miss), ", ".join(miss[:6])),
                "中文声库要先「汉字→拼音」；确属缺音就换个发音或换声库")
        else:
            add("lyrics", "ok", "当前歌词 %d 个全部命中别名表" % len(lyrics))
    return checks, stats


def check_diffsinger(vb, lyrics):
    checks = []
    stats = {}

    def add(cid, level, text, fix=""):
        checks.append({"id": cid, "level": level, "text": text, "fix": fix})

    if not os.path.isdir(vb):
        add("dir", "error", "声库目录不存在：%s" % vb, "重新安装这个声库")
        return checks, stats
    need = ["dsconfig.yaml", "dsdur", "dsvocoder"]
    for name in need:
        p = os.path.join(vb, name)
        if not os.path.exists(p):
            add(name, "error", "缺少 %s" % name, "DiffSinger 声库必须带 dsconfig.yaml + dsdur/ + dsvocoder/")
    if all(os.path.exists(os.path.join(vb, n)) for n in need):
        add("layout", "ok", "目录结构完整（dsconfig.yaml / dsdur / dsvocoder）")
    dicts = sorted(f for f in os.listdir(vb) if f.startswith("dictionary-") and f.endswith(".txt"))
    stats["dictionaries"] = dicts
    if dicts:
        add("dict", "ok", "自带词典：%s" % ", ".join(dicts))
    else:
        add("dict", "warn", "根目录没有 dictionary-*.txt（多语声库通常在 dsdur/ 里另有一份）")
    for sub in ("dsdur", "dspitch", "dsvariance"):
        p = os.path.join(vb, sub)
        if os.path.isdir(p):
            has_dsdict = any(f.startswith("dsdict") for f in os.listdir(p))
            stats["%s_dsdict" % sub] = has_dsdict
            if not has_dsdict:
                add(sub, "warn", "%s 里没有 dsdict*.yaml（该层可能要用 txt 降级词典）" % sub)
    ons = [f for f in os.listdir(vb) if f.endswith(".onnx")]
    stats["onnx"] = ons
    return checks, stats


def main():
    ap = argparse.ArgumentParser(description="声库体检")
    ap.add_argument("--voicebank", required=True)
    ap.add_argument("--engine", default="utau", choices=["utau", "diffsinger"])
    ap.add_argument("--lyrics", nargs="*", default=[], help="可选：拿当前歌词检查别名覆盖")
    args = ap.parse_args()
    try:
        fn = check_diffsinger if args.engine == "diffsinger" else check_utau
        checks, stats = fn(args.voicebank, args.lyrics)
    except Exception as e:  # noqa: BLE001
        return _result({"ok": False, "error": "%s: %s" % (type(e).__name__, e)}, 1)
    bad = [c for c in checks if c["level"] == "error"]
    warn = [c for c in checks if c["level"] == "warn"]
    return _result({"ok": True, "engine": args.engine, "voicebank": args.voicebank,
                    "name": os.path.basename(os.path.normpath(args.voicebank)),
                    "errors": len(bad), "warnings": len(warn),
                    "checks": checks, "stats": stats})


if __name__ == '__main__':
    sys.exit(main())