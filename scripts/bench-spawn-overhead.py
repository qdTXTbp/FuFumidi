# -*- coding: utf-8 -*-
"""P3 基准：外部 resampler 每音符起一次子进程 —— 固定开销有多大？

为什么量这个：`classic_renderer` 的 `_render_external` 是**每个音素一个 ResamplerItem**，
`_run_parallel(resample_one, items, NumRenderThreads)`；而 `ExeResampler` 走的是
`subprocess.run(...)` —— 也就是 UTAU 生态那个老瓶颈：**逐音符起外部进程**。
内置的 `WorldlineResampler` 则是 ctypes 调原生库、**进程内**，没有这一笔。

这里只量**进程创建这一段的下限**（跑 `cmd /c exit`，不含 resampler 自己的计算），
因为这是外部路径无论如何都要付的钱。

用法：python scripts/bench-spawn-overhead.py
"""
import os
import statistics
import subprocess
import sys
import time


def timeit(fn, n=40):
    ts = []
    for _ in range(n):
        t0 = time.perf_counter()
        fn()
        ts.append((time.perf_counter() - t0) * 1000)
    ts.sort()
    return statistics.median(ts), ts[0]


def main():
    print('Python:', sys.version.split()[0], '| 平台:', sys.platform)
    print('CPU 逻辑核数:', os.cpu_count())
    print()
    med, best = timeit(lambda: subprocess.run(['cmd', '/c', 'exit'], capture_output=True))
    print('空 cmd 进程创建     中位 %6.2f ms   最快 %6.2f ms' % (med, best))
    exe = os.path.join(os.environ.get('SystemRoot', r'C:\Windows'), 'System32', 'cmd.exe')
    med2, best2 = timeit(lambda: subprocess.run([exe, '/c', 'exit'], capture_output=True))
    print('cmd.exe 直接启动    中位 %6.2f ms   最快 %6.2f ms' % (med2, best2))
    print()
    print('换算（按中位 %.2f ms/音符，仅进程创建这一段）：' % med)
    for notes in (300, 1000, 3000):
        print('  %5d 音符   单线程 %6.2f 秒   '
              '8 线程理想并行 %5.2f 秒' % (notes, med * notes / 1000, med * notes / 1000 / 8))
    print()
    print('对照：内置 WorldlineResampler 是进程内 ctypes 调用，这一笔开销为 0。')
    return 0


if __name__ == '__main__':
    sys.exit(main())