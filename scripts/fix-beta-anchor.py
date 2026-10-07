# -*- coding: utf-8 -*-
"""把 GitHub `beta` 锚点 release 的资产覆盖为 v5.0.0-beta.4 的三件套。
一次性的发布锚点修复：删同名旧资产 → 上传新资产 → 校验字节数。"""
import os
import sys
import requests

TOKEN = os.environ['GH_TOKEN']
REPO = 'qdTXTbp/FuFumidi'
TAG = 'beta'
API = 'https://api.github.com/repos/' + REPO
UP = 'https://uploads.github.com/repos/' + REPO + '/releases'
H = {'Authorization': 'Bearer ' + TOKEN, 'Accept': 'application/vnd.github+json',
     'User-Agent': 'FuFumidi-Release-Anchor'}
EXPECT = {
    'FuFumidi.Install.exe': 150681211,
    'FuFumidi.update.exe': 8633069,
    'latest.yml': 366,
}

r = requests.get(API + '/releases/tags/' + TAG, headers=H, timeout=60)
r.raise_for_status()
rel = r.json()
rid = rel['id']
print('release %s id=%s, 现有资产: %s' % (TAG, rid, [(a['name'], a['size']) for a in rel['assets']]))

# 1) 删同名旧资产
for a in rel['assets']:
    if a['name'] in EXPECT:
        d = requests.delete(API + '/releases/assets/' + str(a['id']), headers=H, timeout=60)
        print('删除旧资产 %s -> %s' % (a['name'], d.status_code))

# 2) 上传新资产
fail = 0
for name, want in EXPECT.items():
    local = os.path.join('beta4-mirror', name)
    size = os.path.getsize(local)
    assert size == want, (name, size, want)
    u = requests.post('%s/%d/assets?name=%s' % (UP, rid, name), headers={**H, 'Content-Type': 'application/octet-stream'},
                      data=open(local, 'rb'), timeout=1800)
    if u.status_code >= 300:
        print('上传失败 %s: %s %s' % (name, u.status_code, u.text[:200])); fail += 1; continue
    print('上传成功 %s (%d bytes)' % (name, u.json().get('size')))

# 3) 校验
r2 = requests.get(API + '/releases/tags/' + TAG, headers=H, timeout=60).json()
got = {a['name']: a['size'] for a in r2['assets']}
for name, want in EXPECT.items():
    ok = got.get(name) == want
    print('%s: %s (%s)' % (name, got.get(name), 'OK' if ok else 'MISMATCH'))
    if not ok: fail += 1
sys.exit(1 if fail else 0)
