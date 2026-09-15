# -*- coding: utf-8 -*-
"""把 guest 内 127.0.0.1:9222（Electron 的 CDP 端点）中继到 0.0.0.0:9223。

为什么需要它：Chromium 的 --remote-debugging-port 只监听 127.0.0.1，
连 --remote-debugging-address=0.0.0.0 也会被忽略；而 VirtualBox NAT 的端口转发
只能打到 guest 的 10.0.2.15，连不上 127.0.0.1。于是先在 guest 里中继一层，
宿主机再通过 natpf（宿主 9322 → guest 9223）用 Playwright 驱动界面。

用法（guest 内）：
    <应用目录>\resources\python\python.exe guest-cdp-relay.py
"""
import socket
import threading

LISTEN = ("0.0.0.0", 9223)
TARGET = ("127.0.0.1", 9222)


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


def main():
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(LISTEN)
    srv.listen(32)
    print("relay %s -> %s" % (LISTEN, TARGET), flush=True)
    while True:
        client, _ = srv.accept()
        try:
            upstream = socket.create_connection(TARGET, timeout=5)
        except OSError:
            client.close()
            continue
        threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
        threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


if __name__ == "__main__":
    main()
