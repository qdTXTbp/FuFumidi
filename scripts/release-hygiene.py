# -*- coding: utf-8 -*-
"""Release 治理：统一命名 + 清理过期预发行版（用户 2026-10-12 要求）。

  · 统一名称格式：程序版本一律 `FuFumidi v{x.y.z}`
  · 删除过期预发行版，但**保留三个资产通道**（beta / gpu-v2 / soundfonts-v1）——
    删了它们会断掉更新链路与几 GB 的加速包 / SoundFont 下载。

默认 **dry-run**（只读，不需要 token，用的是公开 API）：
    python scripts/release-hygiene.py
真执行（需要 token，权限 repo）：
    python scripts/release-hygiene.py --apply --token ghp_xxx

token 也可以走环境变量 GH_TOKEN / GITHUB_TOKEN。
"""
import argparse
import json
import os
import re
import sys
import urllib.request

REPO = 'qdTXTbp/FuFumidi'
API = 'https://api.github.com/repos/%s' % REPO

# ★ 绝不能删的三个非程序通道
ASSET_CHANNELS = {'beta', 'gpu-v2', 'soundfonts-v1'}

# 非程序 release 的 tag 特征（tag 本身不是版本号）
VERSION_TAG = re.compile(r'^v?\d+\.\d+\.\d+')


def req(url, token=None, method='GET', payload=None):
    data = json.dumps(payload).encode('utf-8') if payload is not None else None
    r = urllib.request.Request(url, data=data, method=method)
    r.add_header('Accept', 'application/vnd.github+json')
    r.add_header('User-Agent', 'fufumidi-release-hygiene')
    if token:
        r.add_header('Authorization', 'token ' + token)
    if data:
        r.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(r, timeout=30) as resp:
        body = resp.read().decode('utf-8')
    return json.loads(body) if body.strip() else {}


def want_title(tag):
    """该 release 应有的名称。版本 tag -> 'FuFumidi vX.Y.Z'（去掉可能的 v 前缀重复）。"""
    m = re.match(r'^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.\-]+)?)$', str(tag))
    return ('FuFumidi v' + m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='真执行（默认只打印计划）')
    ap.add_argument('--token', default=os.environ.get('GH_TOKEN') or os.environ.get('GITHUB_TOKEN') or '')
    ap.add_argument('--keep-tags', action='store_true',
                    help='删 release 时保留 git tag（默认只删 release，tag 一律保留更安全）')
    args = ap.parse_args()

    if args.apply and not args.token:
        print('[错误] --apply 需要 token（--token 或 GH_TOKEN / GITHUB_TOKEN）')
        return 2

    rels = []
    for page in range(1, 11):
        batch = req('%s/releases?per_page=100&page=%d' % (API, page), args.token)
        if not batch:
            break
        rels += batch
    print('共 %d 个 release' % len(rels))

    # ---- G3 命名统一 ----
    renames = []
    for r in rels:
        if r['tag_name'] in ASSET_CHANNELS:
            continue
        expect = want_title(r['tag_name'])
        if not expect:
            continue
        if (r.get('name') or '') != expect:
            renames.append((r['id'], r['tag_name'], r.get('name'), expect))
    print()
    print('--- G3 需要改名的 release：%d 个 ---' % len(renames))
    for _id, tag, cur, expect in renames:
        print('  %-16s %-42s -> %s' % (tag, (cur or '(空)')[:40], expect))

    # ---- G4 清理过期预发行版 ----
    stale = [r for r in rels if r.get('prerelease') and r['tag_name'] not in ASSET_CHANNELS]
    kept = [r for r in rels if r.get('prerelease') and r['tag_name'] in ASSET_CHANNELS]
    print()
    print('--- G4 过期预发行版：%d 个（将删除）---' % len(stale))
    for r in stale:
        print('  %-20s %-34s %s' % (r['tag_name'], (r.get('name') or '')[:32],
                                    (r.get('published_at') or '')[:10]))
    print('--- 保留的资产通道：%d 个（绝不能删）---' % len(kept))
    for r in kept:
        print('  %-20s %s' % (r['tag_name'], r.get('name') or ''))

    if not args.apply:
        print()
        print('以上是 dry-run。加 --apply --token <PAT> 才会真正执行。')
        return 0

    # ---- 执行 ----
    ok = fail = 0
    for rid, tag, cur, expect in renames:
        try:
            req('%s/releases/%d' % (API, rid), args.token, 'PATCH', {'name': expect})
            print('[改名] %s -> %s' % (tag, expect))
            ok += 1
        except Exception as e:
            print('[改名失败] %s : %s' % (tag, e))
            fail += 1
    for r in stale:
        try:
            req('%s/releases/%d' % (API, r['id']), args.token, 'DELETE')
            print('[删除] %s（tag 保留）' % r['tag_name'])
            ok += 1
        except Exception as e:
            print('[删除失败] %s : %s' % (r['tag_name'], e))
            fail += 1
    print()
    print('完成：成功 %d，失败 %d' % (ok, fail))
    return 1 if fail else 0


if __name__ == '__main__':
    sys.exit(main())