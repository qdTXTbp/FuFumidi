# -*- coding: utf-8 -*-
"""导出 FuFumidi 诊断包：设置、版本、依赖状态、最近日志打包为 zip。"""
import argparse, json, os, platform, subprocess, sys, tempfile, zipfile, glob, datetime

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("-o", "--out", required=True)
    args = ap.parse_args()

    data = {
        "time": datetime.datetime.now().isoformat(),
        "os": platform.platform(),
        "python": sys.version,
        "app_version": os.environ.get("FUFUMIDI_APP_VERSION", ""),
        "deps": {},
    }
    try:
        from deps import check
        import io, contextlib
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            check()
        data["deps"] = json.loads(buf.getvalue().split("###RESULT ")[-1])
    except Exception as e:
        data["deps_error"] = str(e)

    tmp = tempfile.mkdtemp(prefix="fufumidi_diag_")
    try:
        with zipfile.ZipFile(args.out, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("diagnostic.json", json.dumps(data, ensure_ascii=False, indent=2))
            # 设置文件
            for p in [os.environ.get("FUFUMIDI_SETTINGS_PATH", "")]:
                if p and os.path.isfile(p):
                    z.write(p, "settings.json")
            # 最近日志（临时目录 fufumidi 下 *.log / *.txt）
            base = os.path.join(tempfile.gettempdir(), "fufumidi")
            for f in glob.glob(os.path.join(base, "*.log")) + glob.glob(os.path.join(base, "*.txt")):
                try:
                    z.write(f, os.path.basename(f))
                except Exception:
                    pass
        print("###RESULT " + json.dumps({"ok": True, "out": args.out}, ensure_ascii=False))
        return 0
    finally:
        try:
            import shutil; shutil.rmtree(tmp)
        except Exception:
            pass

if __name__ == "__main__":
    sys.exit(main())
