# -*- coding: utf-8 -*-
# 创建新仓 + release + 上传 GPU 加速包分卷
import os, time
import requests

TOKEN = os.environ["GH_REAL"]
OWNER = "monologue82"
REPO = "FuFumidi-GPU-Packages"
TAG = "v1.0.0"
H = {"Authorization": "token " + TOKEN, "Accept": "application/vnd.github+json"}
API = "https://api.github.com"

# 1) 创建仓库（若不存在）
r = requests.get(API + "/repos/%s/%s" % (OWNER, REPO), headers=H, timeout=60, verify=False)
if r.status_code == 404:
    payload = {
        "name": REPO,
        "description": "FuFumidi GPU 增强包（CUDA cu128 / RTX 50 系 Blackwell）预打包分卷",
        "private": False,
        "auto_init": True,
    }
    rr = requests.post(API + "/user/repos", headers=H, json=payload, timeout=60, verify=False)
    print("create repo:", rr.status_code, (rr.json().get("html_url") if rr.status_code in (200, 201) else rr.text[:200]))
    rr.raise_for_status()
else:
    print("repo exists:", r.status_code)

# 2) 创建 release（若不存在）
rr = requests.get(API + "/repos/%s/%s/releases/tags/%s" % (OWNER, REPO, TAG), headers=H, timeout=60, verify=False)
if rr.status_code == 404:
    payload = {"tag_name": TAG, "name": "FuFumidi GPU 加速包 v1.0.0",
               "body": "fufumidi-gpu-cuda（torch 2.9.1+cu128 + onnxruntime-gpu 1.20.2 + torchaudio 2.9.1+cu128）\n"
                       "适配 RTX 50 系（Blackwell，需 CUDA 12.8 / 驱动 R570+）。\n"
                       "使用：资源中心 → GPU → 本地导入 ZIP，多选两个分卷；或应用内在线下载。",
               "draft": False, "prerelease": False}
    rr = requests.post(API + "/repos/%s/%s/releases" % (OWNER, REPO), headers=H, json=payload, timeout=60, verify=False)
    print("create release:", rr.status_code)
    rr.raise_for_status()
rid = rr.json()["id"]
print("release id:", rid)

# 3) 上传两个分卷
ASSETS = [
    (r"D:/FuFuMIDI/gpu-package-out/fufumidi-gpu-cuda.zip.001", "fufumidi-gpu-cuda.zip.001"),
    (r"D:/FuFuMIDI/gpu-package-out/fufumidi-gpu-cuda.zip.002", "fufumidi-gpu-cuda.zip.002"),
]
def get_json(url, tries=6):
    for i in range(tries):
        try:
            return requests.get(url, headers=H, timeout=60, verify=False).json()
        except Exception as e:
            time.sleep(10 * (i + 1))
    return []
for local, name in ASSETS:
    if not os.path.exists(local):
        print("SKIP missing:", name); continue
    for a in get_json(API + "/repos/%s/%s/releases/%s/assets" % (OWNER, REPO, rid)):
        if a["name"] == name:
            requests.delete(API + "/repos/%s/%s/releases/assets/%s" % (OWNER, REPO, a["id"]), headers=H, timeout=60, verify=False)
            print("delete old", name)
    url = "https://uploads.github.com/repos/%s/%s/releases/%s/assets?name=%s" % (OWNER, REPO, rid, name)
    sz = os.path.getsize(local)
    for attempt in range(1, 8):
        try:
            print("uploading %s (%.1f MB) attempt %d ..." % (name, sz / 1048576, attempt), flush=True)
            with open(local, "rb") as f:
                up = requests.post(url, headers=dict(H, **{"Content-Type": "application/octet-stream"}), data=f, timeout=3600, verify=False)
            if up.status_code == 201:
                print("  OK", name); break
            print("  status", up.status_code, up.text[:150])
        except Exception as e:
            print("  ERR", str(e)[:120])
        time.sleep(15 * attempt)
print("DONE")
