# -*- coding: utf-8 -*-
import argparse, hashlib, json, os, sys, urllib.request
PREFIXES = [
    "https://raw.githubusercontent.com/monologue82/Models/main/",
    "https://cnb.cool/FuFuCloud-mirror/Models/-/git/raw/main/",
]
def fetch(url, dest):
    req = urllib.request.Request(url, headers={"User-Agent": "FuFumidi"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b: break
            f.write(b)
def get_json():
    last = None
    for p in PREFIXES:
        try:
            req = urllib.request.Request(p + "manifest.json", headers={"User-Agent": "FuFumidi"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
    raise RuntimeError("manifest: %s" % last)
def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--id", required=True); ap.add_argument("--root", required=True)
    a = ap.parse_args()
    if a.id in ("muscriptor_small", "muscriptor_medium", "muscriptor_large"):
        tag, key = "muscriptor", a.id.split("_", 1)[1]
    else:
        parts = a.id.split(":")
        if len(parts) != 3 or parts[0] != "msst": raise SystemExit("bad id")
        tag, key = parts[1], parts[2]
    man = get_json(); meta = (man.get(tag) or {}).get(key)
    if not meta:
        for k, v in (man.get(tag) or {}).items():
            if os.path.splitext(str(v.get("model", "")))[0].lower().replace("-", "_") == key.lower().replace("-", "_"): meta = v; key = k; break
    if not meta: raise SystemExit("manifest entry not found: %s/%s" % (tag, key))
    model = meta.get("model") or "model.safetensors"; n = int(meta.get("parts") or 0)
    if not n: raise SystemExit("parts missing")
    dest = os.path.join(a.root, "models", tag, key); os.makedirs(dest, exist_ok=True)
    final = os.path.join(dest, model)
    tmpdir = os.path.join(dest, ".parts"); os.makedirs(tmpdir, exist_ok=True)
    total = 0
    for i in range(1, n + 1):
        name = "%s.part%02d" % (model, i); out = os.path.join(tmpdir, name)
        if os.path.exists(out) and os.path.getsize(out) > 0: total += os.path.getsize(out); continue
        last = None
        for pre in PREFIXES:
            try:
                fetch(pre + "%s/%s/%s" % (tag, key, name), out); last = None; break
            except Exception as e: last = e
        if last: raise RuntimeError("part %d: %s" % (i, last))
        total += os.path.getsize(out)
    with open(final, "wb") as w:
        for i in range(1, n + 1):
            with open(os.path.join(tmpdir, "%s.part%02d" % (model, i)), "rb") as r:
                while True:
                    b = r.read(1 << 20)
                    if not b: break
                    w.write(b)
    want_size = int(meta.get("size") or 0)
    if want_size and total != want_size: raise RuntimeError("size mismatch")
    h = hashlib.sha256()
    with open(final, "rb") as r:
        for b in iter(lambda: r.read(1 << 20), b""): h.update(b)
    want = (meta.get("sha256") or "").lower()
    if want and h.hexdigest() != want:
        try: os.remove(final)
        except OSError: pass
        raise RuntimeError("sha256 mismatch")
    for f in os.listdir(tmpdir):
        try: os.remove(os.path.join(tmpdir, f))
        except OSError: pass
    print(json.dumps({"ok": True, "id": a.id, "path": dest, "size": os.path.getsize(final)}))
if __name__ == "__main__":
    try: main()
    except Exception as e: print(json.dumps({"ok": False, "error": str(e)}))