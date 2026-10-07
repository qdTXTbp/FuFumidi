# -*- coding: utf-8 -*-
"""CNB 资产覆盖上传（幂等、可重跑）。用于把 GPU 增强包等大文件镜像到 CNB。

为什么不用 scripts/mirror-to-cnb.mjs：它内部用 execFileSync('curl.exe') 调 CNB API，
而本机同步 spawnSync/execFileSync 一律 EBUSY。这里改用 requests 直连，不派生子进程。

用法:
  python scripts/cnb-upload.py --repo FuFuCloud-mirror/FuFuMIDI --tag gpu-v2 \
      --file "gpu-package-out/fufumidi-gpu-rocm.part1=fufumidi-gpu-rocm.part1" \
      --file "gpu-package-out/fufumidi-gpu-rocm.part2=fufumidi-gpu-rocm.part2"

token 从环境变量 CNB_TOKEN 读取（不写死在源码里）。

CNB API 要点（踩过的坑）：
  - 建 release 时 target_commitish 用仓库默认分支（FuFuCloud-mirror/* 均为 master）；
  - 非 semver 的 tag（如 gpu-v2 / beta）必须 make_latest=false，否则会顶掉正式版锚点；
  - 上传三步：POST /-/releases → POST /-/releases/{id}/asset-upload-url → PUT upload_url → POST verify_url。
"""
import os
import sys
import time
import argparse

import requests

CNB_API = 'https://api.cnb.cool'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--repo', required=True, help='如 FuFuCloud-mirror/FuFuMIDI')
    ap.add_argument('--tag', required=True, help='目标 tag，如 gpu-v2')
    ap.add_argument('--commitish', default='master')
    ap.add_argument('--make-latest', default='false')
    ap.add_argument('--file', action='append', default=[], help='本地路径=资产名，可多次')
    ap.add_argument('--token', default=os.environ.get('CNB_TOKEN', ''))
    a = ap.parse_args()

    if not a.token:
        print('CNB_TOKEN 未提供')
        sys.exit(2)

    make_latest = str(a.make_latest).strip().lower() == 'true'

    h = {'Authorization': 'Bearer ' + a.token, 'Accept': 'application/vnd.cnb.api+json'}
    hj = dict(h)
    hj['Content-Type'] = 'application/json'
    base = '%s/%s/-/releases' % (CNB_API, a.repo)

    # 1) 取 / 建 release
    r = requests.get('%s/tags/%s' % (base, a.tag), headers=h, timeout=60)
    rel = None
    if r.status_code == 200:
        try:
            rel = r.json()
        except Exception:
            rel = None
    if isinstance(rel, dict) and rel.get('id'):
        print('已存在 CNB release %s (id=%s, is_latest=%s)'
              % (a.tag, rel.get('id'), rel.get('is_latest')))
    else:
        payload = {
            'tag_name': a.tag, 'name': a.tag, 'body': '镜像自 GitHub',
            'prerelease': False, 'make_latest': 'true' if make_latest else 'false',
            'target_commitish': a.commitish,
        }
        cr = requests.post(base, headers=hj, json=payload, timeout=60)
        if cr.status_code >= 300:
            print('创建 release 失败: %s %s' % (cr.status_code, cr.text[:300]))
            sys.exit(1)
        rel = cr.json()
        print('新建 CNB release %s (id=%s)' % (a.tag, rel.get('id')))

    rid = rel['id']

    # 2) 逐个覆盖上传
    ok = fail = 0
    for spec in a.file:
        if '=' not in spec:
            print('跳过非法 --file:', spec)
            fail += 1
            continue
        local, name = spec.rsplit('=', 1)
        if not os.path.exists(local):
            print('本地文件不存在:', local)
            fail += 1
            continue
        size = os.path.getsize(local)

        ir = requests.post('%s/%s/asset-upload-url' % (base, rid), headers=hj,
                           json={'asset_name': name, 'size': size, 'overwrite': True}, timeout=60)
        if ir.status_code >= 300:
            print('获取上传URL失败 %s: %s %s' % (name, ir.status_code, ir.text[:200]))
            fail += 1
            continue
        info = ir.json()
        up = info.get('upload_url')
        ver = info.get('verify_url')
        if not up:
            print('无 upload_url: %s' % str(info)[:200])
            fail += 1
            continue

        t0 = time.time()
        try:
            with open(local, 'rb') as f:
                pr = requests.put(up, data=f,
                                  headers={'Content-Type': 'application/octet-stream'},
                                  timeout=3600)
        except Exception as e:
            print('上传异常 %s: %s' % (name, e))
            fail += 1
            continue

        if pr.status_code >= 300:
            print('上传失败 %s: %s %s' % (name, pr.status_code, pr.text[:200]))
            fail += 1
            continue

        if ver:
            vr = requests.post(ver, headers=h, timeout=120)
            print('  verify %s -> %s' % (name, vr.status_code))

        print('上传成功 %s (%.1f MB, %ds) -> %s@%s'
              % (name, size / 1048576.0, time.time() - t0, a.repo, a.tag))
        ok += 1

    print('完成：成功 %d / 失败 %d' % (ok, fail))
    if fail:
        sys.exit(1)


main()
