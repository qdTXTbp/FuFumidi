# -*- coding: utf-8 -*-
"""把 guest 内的 CDP 端点接到宿主机 —— 两种模式。

chromium 的 --remote-debugging-port 只监听 127.0.0.1（连
--remote-debugging-address=0.0.0.0 也被忽略），所以宿主机没法直连。
VirtualBox NAT 的端口转发在 7.2.16 上时灵时不灵，因此默认走反向隧道：
guest 主动往宿主机建连，宿主机侧由 cdp-tunnel-host.cjs 配对给 CDP 脚本。

用法（guest 内，由 guest-run.ps1 起，用应用自带的 python）：
    python guest-cdp-relay.py                          # 本地中继：0.0.0.0:9223 -> 127.0.0.1:9222
    python guest-cdp-relay.py --tunnel <host> <控制端口> <隧道端口>
                                                       # 反向隧道（宿主机按需开洞）
"""
import socket
import sys
import threading
import time

CDP_HOST = "127.0.0.1"
CDP_PORT = 9222
LISTEN = ("0.0.0.0", 9223)


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        for s in (src, dst):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            try:
                s.close()
            except OSError:
                pass


def serve_local():
    """本地中继：guest 内任意进程都能通过 0.0.0.0:9223 访问 CDP。"""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(32)
    print("relay %s -> %s:%d" % (LISTEN, CDP_HOST, CDP_PORT), flush=True)
    while True:
        client, _ = srv.accept()
        try:
            upstream = socket.create_connection((CDP_HOST, CDP_PORT), timeout=5)
        except OSError:
            client.close()
            continue
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


def serve_tunnel(host, ctrl_port, tunnel_port):
    """反向隧道（按需开洞）。

    空闲的隧道连接会被系统/NAT 静默回收（实测预建 16 条一分钟内全变 TimeWait），
    所以不做连接池：宿主机在控制连接上发一个 'O'，guest 收到才新开一条。
    """
    ctrl = None
    while True:
        try:
            ctrl = socket.create_connection((host, ctrl_port), timeout=10)
            print("tunnel: 控制连接已建立 %s:%d" % (host, ctrl_port), flush=True)
            ctrl.settimeout(5)
            beat = time.time()
            while True:
                # 心跳：空闲连接会被 NAT/系统静默回收（实测数十秒级）
                if time.time() - beat >= 3:
                    try:
                        ctrl.sendall(b".")
                    except OSError:
                        break
                    beat = time.time()
                try:
                    b = ctrl.recv(1)
                except socket.timeout:
                    continue
                if not b:
                    break
                if b != b"O":
                    continue          # 宿主机的心跳/其它字符
                try:
                    tun = socket.create_connection((host, tunnel_port), timeout=10)
                except OSError as e:
                    print("tunnel: 开洞失败 %s" % e, flush=True)
                    continue
                threading.Thread(target=_tunnel_one, args=(tun,), daemon=True).start()
        except OSError as e:
            print("tunnel: 控制连接异常 %s，2 秒后重连" % e, flush=True)
        try:
            if ctrl:
                ctrl.close()
        except OSError:
            pass
        time.sleep(2)


def _tunnel_one(tun):
    try:
        head = tun.recv(65536)
        if not head:
            tun.close()
            return
        upstream = socket.create_connection((CDP_HOST, CDP_PORT), timeout=5)
        upstream.sendall(head)
    except OSError:
        try:
            tun.close()
        except OSError:
            pass
        return
    threading.Thread(target=pipe, args=(tun, upstream), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, tun), daemon=True).start()


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--tunnel":
        host = sys.argv[2] if len(sys.argv) > 2 else "10.0.2.2"
        ctrl_port = int(sys.argv[3]) if len(sys.argv) > 3 else 9226
        tunnel_port = int(sys.argv[4]) if len(sys.argv) > 4 else 9225
        serve_tunnel(host, ctrl_port, tunnel_port)
    else:
        serve_local()


if __name__ == "__main__":
    main()
