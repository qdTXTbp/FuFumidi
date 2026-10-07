# -*- coding: utf-8 -*-
"""常驻引擎 serve 协议测试（subprocess 真实交互，离线可跑）。

★ 钉死的协议语义：
  1. 请求 `{id, argv}` → 响应 `###RESULT {..., "id"}`（id 一一对应）
  2. 单个请求失败**不退出**（坏 argv 返回 ok=false 后继续服务下一个）
  3. `{"cmd":"exit"}` 干净退出
  4. 进度行带 id（用 deps 没有进度，inspect 声库会走部分路径——不强断言进度，
     只断言 RESULT）

用 `deps` 子命令做探针（离线轻量：只检查依赖不加载模型）。

可离线运行：python engine/tests/test_engine_serve.py
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
PASS = 0


def check(cond, msg):
    global PASS
    if not cond:
        raise AssertionError(msg)
    PASS += 1
    print('  ok -', msg)


def read_result(proc, timeout_s=60):
    """读 stdout 直到拿到一条 ###RESULT 行（跳过日志）。"""
    import time
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        line = proc.stdout.readline()
        if not line:
            return None                                    # 进程死了
        t = line.strip()
        if t.startswith('###RESULT '):
            return json.loads(t[len('###RESULT '):])
        # 其它行（日志/PROG）忽略
    return {'ok': False, 'error': 'timeout waiting for RESULT'}


def main():
    py = sys.executable
    for script in ('engine_diffsinger.py', 'engine_openutau.py'):
        serve_probe(py, script)
    print('\nALL PASS (%d checks)' % PASS)


def serve_probe(py, script):
    print('[%s]' % script)
    proc = subprocess.Popen(
        [py, os.path.join(ENGINE, script), 'serve'],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL, text=True, encoding='utf-8', cwd=ENGINE)

    try:
        # ---- 请求 1：deps（正常路径）
        proc.stdin.write(json.dumps({'id': 1, 'argv': ['deps']}, ensure_ascii=False) + '\n')
        proc.stdin.flush()
        r1 = read_result(proc)
        check(r1 is not None and r1.get('id') == 1, '请求 1 的 RESULT 带正确 id')
        check(isinstance(r1, dict) and 'ok' in r1, '结果与一次性模式同形（有 ok 字段）')

        # ---- 请求 2：坏 argv（argparse 失败 → SystemExit → 转为 ok=false）
        proc.stdin.write(json.dumps({'id': 2, 'argv': [' NoSuchCommand ']}) + '\n')
        proc.stdin.flush()
        r2 = read_result(proc)
        check(r2 is not None and r2.get('id') == 2 and r2.get('ok') is False,
              '坏请求返回 ok=false 且不炸进程')

        # ---- 请求 3：坏请求之后进程还活着（常驻的意义所在）
        proc.stdin.write(json.dumps({'id': 3, 'argv': ['deps']}) + '\n')
        proc.stdin.flush()
        r3 = read_result(proc)
        check(r3 is not None and r3.get('id') == 3, '坏请求后进程继续服务')

        # ---- 退出
        proc.stdin.write('{"cmd": "exit"}\n')
        proc.stdin.flush()
        try:
            rc = proc.wait(timeout=10)
            check(rc == 0, 'exit 命令干净退出（rc=0）')
        except subprocess.TimeoutExpired:
            proc.kill()
            check(False, 'exit 后 10s 未退出')
    finally:
        if proc.poll() is None:
            proc.kill()


if __name__ == '__main__':
    main()
