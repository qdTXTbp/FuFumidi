# -*- coding: utf-8 -*-
# 上传（或覆盖）GitHub Release 资产，供发布流程复用。
# 用法: python scripts/upload-release-asset.py <token> <repo> <tag> <local_path> <asset_name>
import sys
import requests

token, repo, tag, path, name = sys.argv[1:6]
h = {"Authorization": "token " + token, "Accept": "application/vnd.github+json"}

# 1) 取 release id
api = "https://api.github.com/repos/%s/releases/tags/%s" % (repo, tag)
r = requests.get(api, headers=h, timeout=60, verify=False)
r.raise_for_status()
rid = r.json()["id"]
print("release id:", rid)

# 2) 若同名资产已存在，先删除（同名覆盖需要）
assets_url = "https://api.github.com/repos/%s/releases/%s/assets" % (repo, rid)
r = requests.get(assets_url, headers=h, timeout=60, verify=False)
r.raise_for_status()
for a in r.json():
    if a["name"] == name:
        print("deleting old asset:", name, a["id"])
        dr = requests.delete("https://api.github.com/repos/%s/releases/assets/%s" % (repo, a["id"]), headers=h, timeout=60, verify=False)
        print("delete status:", dr.status_code)

# 3) 上传
url = "https://uploads.github.com/repos/%s/releases/%s/assets?name=%s" % (repo, rid, name)
with open(path, "rb") as f:
    up = requests.post(url, headers=dict(h, **{"Content-Type": "application/octet-stream"}), data=f, timeout=900, verify=False)
print("upload status:", up.status_code)
if up.status_code != 201:
    print(up.text[:500])
    sys.exit(1)
print("uploaded:", name)
