# -*- coding: utf-8 -*-
# 上传（或覆盖）GitHub Release 资产，供发布流程复用。
#
# 用法:
#   python scripts/upload-release-asset.py <token> <repo> <tag> <local_path> <asset_name> \
#          [--prerelease] [--title "FuFumidi v4.4.0-beta.1"] [--body-file notes.md] [--attempts 4]
#
# 行为:
#   1) release 不存在时自动创建（正式版 prerelease=false；内测版加 --prerelease）；
#      已存在且传了 --prerelease，就把它的预发布标记补上。
#   2) 同名资产先删后传（`latest/download/<固定名>` 依赖这个覆盖语义）。
#   3) 上传失败自动重试；每次重试前清掉上一次留下的半成品资产。
#      —— 离线包有数百 MB，弱网下会中途断流；失败时 GitHub 侧会残留一个
#      state=starter 的空资产，不清掉会一直挂在 release 列表里。
import sys
import os
import time
import requests

USAGE = ('usage: upload-release-asset.py <token> <repo> <tag> <local_path> <asset_name> '
         '[--prerelease] [--title T] [--body-file F] [--attempts N]')


def main():
    argv = sys.argv[1:]
    if len(argv) < 5:
        print(USAGE)
        sys.exit(2)
    token, repo, tag, path, name = argv[:5]
    opts = argv[5:]

    prerelease = '--prerelease' in opts
    title = opts[opts.index('--title') + 1] if '--title' in opts else tag
    body_file = opts[opts.index('--body-file') + 1] if '--body-file' in opts else None
    attempts = int(opts[opts.index('--attempts') + 1]) if '--attempts' in opts else 4

    if not os.path.exists(path):
        print('local file not found:', path)
        sys.exit(1)

    h = {"Authorization": "token " + token, "Accept": "application/vnd.github+json"}
    api = "https://api.github.com/repos/%s" % repo

    # 1) 取 release；不存在则创建
    r = requests.get("%s/releases/tags/%s" % (api, tag), headers=h, timeout=60)
    if r.status_code == 404:
        payload = {"tag_name": tag, "name": title, "prerelease": bool(prerelease), "draft": False}
        if body_file and os.path.exists(body_file):
            with open(body_file, encoding='utf-8') as f:
                payload['body'] = f.read()
        cr = requests.post("%s/releases" % api, headers=h, json=payload, timeout=60)
        if cr.status_code not in (200, 201):
            print('create release failed:', cr.status_code, cr.text[:300])
            sys.exit(1)
        rel = cr.json()
        print('created release: %s (id=%s prerelease=%s)' % (tag, rel['id'], rel['prerelease']))
    else:
        r.raise_for_status()
        rel = r.json()
        # 已存在：显式要求预发布时才补标记（正式版转正不该被这个脚本顺手改掉）
        if prerelease and not rel.get('prerelease'):
            pr = requests.patch("%s/releases/%s" % (api, rel['id']), headers=h,
                                json={"prerelease": True}, timeout=60)
            if pr.status_code == 200:
                print('release %s marked as prerelease' % tag)
        print('release id:', rel['id'])
    rid = rel['id']

    def asset_id(nm):
        ar = requests.get("%s/releases/%s/assets" % (api, rid), headers=h, timeout=60)
        ar.raise_for_status()
        for a in ar.json():
            if a['name'] == nm:
                return a['id']
        return None

    def delete_asset(nm):
        aid = asset_id(nm)
        if aid:
            requests.delete("%s/releases/assets/%s" % (api, aid), headers=h, timeout=60)
            print('deleted stale asset:', nm)

    size = os.path.getsize(path)
    for i in range(1, attempts + 1):
        delete_asset(name)
        t0 = time.time()
        try:
            with open(path, 'rb') as f:
                up = requests.post(
                    "https://uploads.github.com/repos/%s/releases/%s/assets?name=%s" % (repo, rid, name),
                    headers=dict(h, **{"Content-Type": "application/octet-stream"}),
                    data=f, timeout=3600)
            dt = time.time() - t0
            if up.status_code == 201:
                mb = size / 1048576.0
                speed = (mb / dt) if dt else 0
                print('uploaded: %s (%.1f MB in %ds, %.2f MB/s)' % (name, mb, dt, speed))
                return
            print('attempt %d/%d -> HTTP %d %s' % (i, attempts, up.status_code, up.text[:200]))
        except Exception as e:
            print('attempt %d/%d -> %s: %s' % (i, attempts, type(e).__name__, e))
        if i < attempts:
            time.sleep(5)
    print('FAILED after %d attempts: %s' % (attempts, name))
    sys.exit(1)


main()
