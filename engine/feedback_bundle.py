# -*- coding: utf-8 -*-
"""把一次问题反馈打成一个 zip：issue.md + health-report.md +（脱敏后的）diagnostic.zip。

★ 为什么放在引擎侧（Python）而不是主进程（JS）：
  ① 诊断包本来就是 Python 做的（diag.py），zip 读写两边都在这里，**不用再给 JS 加一个 zip 库**；
  ② **脱敏发生在"进包的路上"** —— 敏感内容不会先落盘再被洗掉；
  ③ 脱敏规则与 health.py 的 redactor 同一个来源（直接 import），不会两处漂移。

用法：
  python feedback_bundle.py --out bundle.zip --md issue.md [--report health.md] [--diag diag.zip]
输出：
  ###RESULT {"ok": true, "out": ..., "entries": [...], "bytes": N, "stripped": [...]}
"""
import argparse
import io
import json
import os
import re
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

#: 令牌形状 —— 与主进程 main/feedback-format.js 的 TOKEN_PATTERNS 保持一致。
#: （两处都要有：JS 管 md 与预览，Python 管诊断包里已经存在的字节。）
TOKEN_PATTERNS = [
    (re.compile(r"hf_[A-Za-z0-9]{16,}"), "<已隐藏>"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{16,}"), "<已隐藏>"),
    (re.compile(r"github_pat_[A-Za-z0-9_]{20,}"), "<已隐藏>"),
    (re.compile(r"sk-[A-Za-z0-9]{16,}"), "<已隐藏>"),
    (re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"), "<已隐藏>"),
    (re.compile(r"\b[A-Fa-f0-9]{32,}\b"), "<已隐藏>"),
    (re.compile(r"\b[A-Za-z0-9]{28,}\b"), "<已隐藏>"),
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._-]{8,}", re.I), r"\1<已隐藏>"),
    (re.compile(r"([?&](?:token|access_token|password|secret)=)[^&\s]+", re.I), r"\1<已隐藏>"),
]

#: settings.json 里这些 key 直接移除（连值都不进包）
SENSITIVE_KEY = re.compile(r"(token|secret|password|passwd|api[_-]?key|credential|cookie|session|email|auth)", re.I)

#: 日志类文本附件只留尾部这么多字节
LOG_KEEP_BYTES = 256 * 1024


def _redactor():
    """优先复用 health.py 的 redactor（主机名/用户名/家目录同源）；拿不到就退回最小实现。"""
    try:
        import health
        return health.make_redactor()
    except Exception:
        def fallback(s, _host=""):
            return s
        return fallback


def sanitize_text(s, redact):
    out = redact(s if isinstance(s, str) else str(s))
    for pat, rep in TOKEN_PATTERNS:
        out = pat.sub(rep, out)
    return out


def _scrub_json_value(v, depth=0):
    if depth > 6 or v is None:
        return v
    if isinstance(v, list):
        return [_scrub_json_value(x, depth + 1) for x in v]
    if isinstance(v, dict):
        return {k: ("<已移除>" if SENSITIVE_KEY.search(str(k)) else _scrub_json_value(val, depth + 1))
                for k, val in v.items()}
    return v


def sanitize_settings_json(text, redact):
    """settings.json：先按键删敏感项，再整体过脱敏（路径/用户名/令牌）。"""
    try:
        obj = json.loads(text)
        text = json.dumps(_scrub_json_value(obj), ensure_ascii=False, indent=1)
    except Exception:
        pass  # 不是合法 JSON 就只做文本脱敏
    return sanitize_text(text, redact)


def sanitize_log(text, redact):
    s = sanitize_text(text, redact)
    if len(s) <= LOG_KEEP_BYTES:
        return s
    return "…（前 %d 字符已截断）\n%s" % (len(s) - LOG_KEEP_BYTES, s[-LOG_KEEP_BYTES:])


def _is_text_name(name):
    n = name.lower()
    return n.endswith((".json", ".txt", ".log", ".md", ".yaml", ".yml", ".ini", ".cfg"))


def _diag_entries(diag_path, redact):
    """读诊断包：文本类逐条脱敏，二进制类**直接丢弃**（反馈包只收能解释问题的文本）。"""
    kept, dropped = [], []
    with zipfile.ZipFile(diag_path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            name = os.path.basename(info.filename)
            if not _is_text_name(name):
                dropped.append(name)
                continue
            raw = z.read(info)
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                try:
                    text = raw.decode("mbcs")      # Windows 日志常见
                except Exception:
                    dropped.append(name)
                    continue
            if name.lower().endswith(".json"):
                text = sanitize_settings_json(text, redact)
            else:
                text = sanitize_log(text, redact)
            kept.append((name, text))
    return kept, dropped


def build(out_path, md_path, report_path=None, diag_path=None):
    redact = _redactor()
    entries, stripped = [], []
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as z:
        with open(md_path, "rb") as fh:
            z.writestr("issue.md", fh.read())
        entries.append("issue.md")
        if report_path and os.path.isfile(report_path):
            with open(report_path, "rb") as fh:
                z.writestr("health-report.md", fh.read())
            entries.append("health-report.md")
        if diag_path and os.path.isfile(diag_path):
            kept, dropped = _diag_entries(diag_path, redact)
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as dz:
                for name, text in kept:
                    dz.writestr(name, text.encode("utf-8"))
            z.writestr("diagnostic.zip", buf.getvalue())
            entries.append("diagnostic.zip")
            stripped = dropped
    return {
        "ok": True,
        "out": out_path,
        "entries": entries,
        "bytes": os.path.getsize(out_path),
        "stripped": stripped,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--md", required=True)
    ap.add_argument("--report", default="")
    ap.add_argument("--diag", default="")
    args = ap.parse_args()
    try:
        res = build(args.out, args.md, args.report or None, args.diag or None)
    except Exception as e:                                    # noqa: BLE001
        print("###RESULT " + json.dumps({"ok": False, "error": str(e)[:300]}, ensure_ascii=False))
        return 1
    print("###RESULT " + json.dumps(res, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
