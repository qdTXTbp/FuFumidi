# -*- coding: utf-8 -*-
# 上传（或覆盖）GitHub Release 资产，供发布流程复用。
#
# 用法:
#   python scripts/upload-release-asset.py <token> <repo> <tag> <local_path> <asset_name> \
#          [--prerelease] [--title "FuFumidi v4.4.0-beta.1"] [--body-file notes.md] \
#          [--attempts 4] [--race 3] [--min-speed 2] [--stall-seconds 45]
#
# 行为:
#   1) release 不存在时自动创建（正式版 prerelease=false；内测版加 --prerelease）；
#      已存在且传了 --prerelease，就把它的预发布标记补上。
#   2) 同名资产先删后传（releases/latest/download/<固定名> 依赖这个覆盖语义）。
#   3) 上传失败自动重试；每次重试前清掉上一次留下的半成品资产。
#      —— 离线包有数百 MB，弱网下会中途断流；失败时 GitHub 侧会残留一个
#      state=starter 的空资产，不清掉会一直挂在 release 列表里。
#   4) ★ 多流 + 慢流重掷（--race / --min-speed）—— 见 .github/CODING_GUIDELINES.md 11.7
#
#      实测（2026-10-11，同一台机器、同一条线路、同一个 143.8 MB 文件）：
#        第 1 次 25 秒（5.75 MB/s）   第 2 次 18 分钟（0.13 MB/s）   →  44 倍方差
#        608 MB 完整包：单流 0.47 MB/s 且持续劣化到 0.075 MB/s（剩余 424 MB 要 94 分钟），
#                       第一次整份传完后失败、第二次从头再来。
#        3 条流并行：合计 1.17 MB/s（每条约 0.39 MB/s）。
#      结论：瓶颈不是带宽（单流峰值实测 5.75 MB/s），而是**单条 TCP 流的路由质量**。
#      所以真正的杠杆是**换一条路由重掷**，其次才是并行多吃带宽。
#
#      ghfast.top / gh-proxy 这类是**下载**加速器，不代理上传；GitHub 的 release asset
#      接口也不支持 multipart / Range（没有断点续传）。所以「分片多线程」不存在，
#      能做的只有「多开整份」与「慢了就换」。
#
#        --race N       N 条流并行（默认 1）。第一条 201 胜出，其余立即中断。
#                       胜出后按资产名清掉重复项，保证同名资产只剩一条 ——
#                       releases/latest/download/<固定名> 依赖这个唯一性。
#                       代价：N 倍上行流量。
#        --min-speed X  每条流挂看门狗：已发 >= 8 MB 后计速，窗口内低于 X MB/s 就掐掉。
#                       **掐掉后会立刻补一条新流**（换路由重掷），不是只减不补。
#                       0 = 关闭（默认）。
#
#      建议口径：
#        大资产（>= 50 MB）：--race 2 --min-speed 2。既并行又重掷，
#                            命中快路由就 2 分钟传完；一直命不中就退化成并行兜底。
#        小资产（< 50 MB）：默认单流即可。
#      注意：--min-speed 要明显低于「单流峰值」（本机实测 5.75 MB/s），
#      否则 N 条流分同一条上行时会被一起判慢。开到 2 是安全的。
import sys
import os
import time
import threading
import requests

USAGE = ('usage: upload-release-asset.py <token> <repo> <tag> <local_path> <asset_name> '
         '[--prerelease] [--title T] [--body-file F] [--attempts N] '
         '[--race N] [--min-speed MBps] [--stall-seconds S] [--rolls N] '
         '[--no-proxy | --proxy URL]')

MB = 1048576.0
WARMUP_BYTES = 8 * MB          # 看门狗热身：这段时间内的低速不算数（TCP 慢启动）

# ★ 代理是这套脚本最大的隐形变量：
#   Windows 上 requests 会通过 urllib.request.getproxies() **读注册表里的 WinINET 设置**，
#   即使没有任何 HTTP_PROXY 环境变量，也会自动把上传导到系统代理上。
#   实测（2026-10-11，本机系统代理 127.0.0.1:10810）：
#     直连（--no-proxy）      0.40 MB/s  —— 稳定但慢，是国际链路的硬地板
#     走系统代理（默认）      2.59 MB/s  —— 快路径，但会随时间剧烈波动
#     同一代理历史上的实测    0.075 ~ 4.87 MB/s（差 65 倍；浏览器走同一代理拿到 4.87）
#   所以：**必须把生效的代理打出来**，否则"为什么这次这么慢"永远查不到。
PROXIES = {}                   # {} = 用系统/环境默认；{'http': None, 'https': None} = 强制直连


def proxy_kw():
    """只在显式指定 --no-proxy / --proxy 时才覆盖 requests 的默认代理解析。"""
    return {'proxies': PROXIES} if PROXIES else {}


def describe_proxies():
    if not PROXIES:
        try:
            got = requests.utils.getproxies()
        except Exception:
            got = {}
        return ('系统默认 %s' % got) if got else '系统默认（无代理）'
    if PROXIES.get('https', 'x') is None:
        return '已禁用（--no-proxy，直连）'
    return '显式指定 %s' % PROXIES


class _Abort(Exception):
    """主动掐断一条流（别人赢了 / 自己太慢）。"""


class ProgressReader:
    """把本地文件按块喂给 requests，并统计已发送字节。

    requests 的 data 传文件对象时会流式读取，这里包一层即可：
      - 别人胜出（done）或自己被判太慢（abort）时抛 _Abort，
        读取中断 → 连接随之断开，不会把整份白传完。
      - sink['sent'] 只统计本流，供看门狗按流计速。
    """

    def __init__(self, path, size, abort_evt, done_evt, sink):
        self._f = open(path, 'rb')
        self._size = size
        self._abort = abort_evt
        self._done = done_evt
        self._sink = sink

    def read(self, n=-1):
        if self._abort.is_set() or self._done.is_set():
            raise _Abort()
        b = self._f.read(n)
        self._sink['sent'] += len(b)
        return b

    def __len__(self):
        return self._size

    def close(self):
        try:
            self._f.close()
        except Exception:
            pass


def list_assets(api, rid, h):
    ar = requests.get('%s/releases/%s/assets' % (api, rid), headers=h, timeout=60, **proxy_kw())
    ar.raise_for_status()
    return ar.json()


def delete_asset(api, h, aid, name=None):
    requests.delete('%s/releases/assets/%s' % (api, aid), headers=h, timeout=60, **proxy_kw())
    if name:
        print('deleted stale asset:', name)


def delete_by_name(api, rid, h, name):
    for a in list_assets(api, rid, h):
        if a['name'] == name:
            delete_asset(api, h, a['id'], name)


def upload_racy(repo, rid, name, path, h, size, race, min_speed, stall_seconds,
                rolls=6, verbose=True):
    """race 条流并行上传，慢流掐掉后立刻补新流（换路由重掷），先成功者胜出。

    返回胜出的资产对象；全部流耗尽仍失败则返回 None。
    """
    api = 'https://api.github.com/repos/%s' % repo
    url = 'https://uploads.github.com/repos/%s/releases/%s/assets?name=%s' % (repo, rid, name)
    done = threading.Event()
    winner = {}
    lock = threading.Lock()
    slots = []                      # 每个 slot 一个线程；slot 内逐次重掷
    killed = {'watchdog': 0, 'failed': 0, 'won': 0}

    def one_roll(idx, gen):
        """开一条流并等它结束。返回 True 表示本流胜出。"""
        sink = {'sent': 0}
        abort_evt = threading.Event()
        rec = {'idx': idx, 'gen': gen, 'sink': sink, 'abort': abort_evt,
               't0': time.time(), 'last_t': time.time(), 'last_sent': 0, 'alive': True}
        with lock:
            slots[idx]['cur'] = rec
        reader = ProgressReader(path, size, abort_evt, done, sink)
        try:
            r = requests.post(url, headers=dict(h, **{'Content-Type': 'application/octet-stream'}),
                              data=reader, timeout=(30, 5400), **proxy_kw())
            if r.status_code == 201:
                with lock:
                    if not winner:
                        winner.update(r.json())
                        winner['_slot'] = idx
                        done.set()
                        killed['won'] = 1
                    else:
                        winner.setdefault('_dupes', []).append(r.json()['id'])
                if verbose:
                    print('  slot#%d roll#%d WON: asset id=%s' % (idx, gen, r.json().get('id')))
                return True
            if verbose:
                print('  slot#%d roll#%d HTTP %s %s' % (idx, gen, r.status_code, r.text[:150]))
            with lock:
                killed['failed'] += 1
        except _Abort:
            with lock:
                killed['watchdog'] += 1
            if verbose and not done.is_set():
                print('  slot#%d roll#%d 被看门狗掐掉 (已发 %.1f MB, 均速 %.2f MB/s) -> 重掷'
                      % (idx, gen, sink['sent'] / MB,
                         sink['sent'] / MB / max(0.001, time.time() - rec['t0'])))
        except Exception as e:
            with lock:
                killed['failed'] += 1
            if verbose:
                print('  slot#%d roll#%d %s: %s' % (idx, gen, type(e).__name__, str(e)[:150]))
        finally:
            rec['alive'] = False
            reader.close()
        return False

    def slot_worker(idx):
        for gen in range(1, rolls + 1):
            if done.is_set():
                break
            if one_roll(idx, gen):
                break
        with lock:
            slots[idx]['finished'] = True

    for i in range(race):
        slots.append({'idx': i, 'cur': None, 'finished': False})
    threads = [threading.Thread(target=slot_worker, args=(i,), daemon=True) for i in range(race)]
    for t in threads:
        t.start()

    # 看门狗：掐掉「已传够热身量、窗口内明显偏慢」的流；slot 线程会自动补一条新的
    if min_speed > 0:
        while not done.is_set() and not all(s['finished'] for s in slots):
            time.sleep(2)
            now = time.time()
            with lock:
                for s in slots:
                    rec = s['cur']
                    if not rec or not rec['alive'] or rec['abort'].is_set():
                        continue
                    dt = now - rec['last_t']
                    if dt < stall_seconds:
                        continue
                    sent = rec['sink']['sent']
                    speed = (sent - rec['last_sent']) / MB / dt
                    rec['last_t'], rec['last_sent'] = now, sent
                    if sent >= WARMUP_BYTES and speed < min_speed:
                        print('  watchdog: slot#%d 太慢 (%.2f MB/s < %.2f MB/s)，掐掉重掷'
                              % (rec['idx'], speed, min_speed))
                        rec['abort'].set()

    for t in threads:
        t.join()

    print('  统计：胜出 %d，看门狗掐掉 %d，失败 %d' % (killed['won'], killed['watchdog'], killed['failed']))
    if not winner:
        return None

    for aid in winner.pop('_dupes', []):
        delete_asset(api, h, aid)
    for a in list_assets(api, rid, h):
        if a['name'] == name and a['id'] != winner['id']:
            delete_asset(api, h, a['id'], a['name'])
    return winner


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
    race = int(opts[opts.index('--race') + 1]) if '--race' in opts else 1
    min_speed = float(opts[opts.index('--min-speed') + 1]) if '--min-speed' in opts else 0.0
    stall_seconds = float(opts[opts.index('--stall-seconds') + 1]) if '--stall-seconds' in opts else 45.0
    rolls = int(opts[opts.index('--rolls') + 1]) if '--rolls' in opts else 6
    race = max(1, min(8, race))

    global PROXIES
    if '--no-proxy' in opts:
        PROXIES = {'http': None, 'https': None}
    elif '--proxy' in opts:
        u = opts[opts.index('--proxy') + 1]
        PROXIES = {'http': u, 'https': u}
    print('proxy: %s' % describe_proxies())

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

    size = os.path.getsize(path)
    print('uploading %s (%.1f MB) race=%d min-speed=%.2f MB/s rolls=%d'
          % (name, size / MB, race, min_speed, rolls))

    for i in range(1, attempts + 1):
        delete_by_name(api, rid, h, name)
        t0 = time.time()
        w = upload_racy(repo, rid, name, path, h, size, race, min_speed, stall_seconds, rolls)
        dt = max(0.001, time.time() - t0)
        if w:
            print('uploaded: %s (%.1f MB in %ds, %.2f MB/s) [race=%d]'
                  % (name, size / MB, dt, size / MB / dt, race))
            return
        print('attempt %d/%d -> 全部流失败' % (i, attempts))
        if i < attempts:
            time.sleep(5)
    print('FAILED after %d attempts: %s' % (attempts, name))
    sys.exit(1)


main()
