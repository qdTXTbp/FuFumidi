# -*- coding: utf-8 -*-
"""外部进程执行器 —— **照搬** `OpenUtau.Core/Util/ProcessRunner.cs`（95 行）。

UTAU 线的"变调 / 拼接"默认走**外部可执行文件**（用户自备的 `resample.exe`、
`wavtool.exe`、`moresampler.exe`…）。这个类负责把它们跑起来、收走 stdout/stderr，
并且**永不因非零退出码抛错**（把输出与退出码拼成文本返回，由调用方判断）。

## 照搬时保留的语义（别"整理"掉）
1. ★ **非零退出码不抛异常** —— 只把 `Exit code N` 追加到输出末尾。
   真正的失败判定在调用方（`ExeResampler` 是"看输出文件在不在"）。
2. exe 不存在时**抛 `FileNotFoundException`**（这是唯一的硬错误）。Python 对应 `FileNotFoundError`。
3. 超时**会杀掉整棵进程树**（C# 的 `Kill(entireProcessTree: true)`），
   并追加 `"Killed due to timeout."`；随后仍会 `WaitForExit()` 收尾。
4. `timeoutMs <= 0` 表示**无限等**。
5. 环境变量里**强制写入** `LANG=ja_JP.utf8`（老 UTAU 工具按日文 locale 输出）。
6. stderr 的行**也**会进返回文本（C# 两个 handler 都 `output.AppendLine`），
   只是同时按 error 级别记日志；stdout 仅在 `DebugSwitch` 打开时记 information。

## ★ 载体差异
- C# 里 stdout/stderr 用 `OutputDataReceived`/`ErrorDataReceived` 异步事件回调；
  Python 用**两个读线程**。跨流之间的行序本就是不确定的，两边一致地不确定。
- 解码：C# 不设 `StandardOutputEncoding`，走的是**控制台默认代码页**（Windows 上是
  OEM 页，如日文 cp932 / 中文 cp936）。Python 侧先试 UTF-8、失败退回本机 locale
  编码，都用 `errors='replace'` —— 这里只影响**日志文本**，不影响任何渲染结果。
- `ProcessStartInfo(file, args)` 把参数当**单个字符串**交给系统解析。Python 在
  Windows 上同样把整串交给 `CreateProcess`（保持一致）；POSIX 上必须自己切词，
  用 `shlex.split`，并在 docstring 里点明这个差异。
"""

import os
import shlex
import subprocess
import sys
import threading
from typing import List, Optional

#: 对应 `public static bool DebugSwitch { get; set; }`
DebugSwitch = False


def _decode(raw: bytes) -> str:
    """按「先 UTF-8、再本机 locale」解码一行（见模块 docstring 的载体差异）。"""
    for enc in ('utf-8', None):
        try:
            if enc is None:
                import locale
                enc = locale.getpreferredencoding(False) or 'utf-8'
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode('utf-8', 'replace')


def _build_cmd(file: str, args: str):
    """构造 Popen 的 argv。

    ★ Windows 上必须返回**字符串**（而不是单项列表）：`subprocess` 对列表会走
    `list2cmdline` 重新加引号，把已经带引号的 exe 路径再包一层，CreateProcess
    拿到 `"\\"C:\\path\\python.exe\\" -c ..."` 这种畸形命令行 → `WinError 5 拒绝访问`。
    直接给字符串时，它会被**原样**交给 CreateProcess —— 这正是 .NET
    `ProcessStartInfo(file, args)` 的行为。

    POSIX 上没有等价物，只能自己切词（`shlex.split`）。
    """
    if sys.platform.startswith('win'):
        return ('"%s" %s' % (file, args)) if args else ('"%s"' % file)
    return [file] + (shlex.split(args) if args else [])


def _kill_tree(proc: subprocess.Popen) -> None:
    """对应 `Kill(entireProcessTree: true)`。"""
    try:
        if sys.platform.startswith('win'):
            subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            import signal
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:                                # noqa: BLE001
                proc.kill()
    except Exception:                                        # noqa: BLE001
        try:
            proc.kill()
        except Exception:                                    # noqa: BLE001
            pass


def run(file: str, args: str, logger, work_dir: Optional[str] = None,
        timeout_ms: int = 60000) -> str:
    """对应 `ProcessRunner.Run(...)`：跑一个外部进程，返回**输出文本**。

    ★ 非零退出码**不抛异常**；只有 exe 不存在才抛 `FileNotFoundError`。
    """
    if not os.path.isfile(file):
        raise FileNotFoundError('Executable %s not found.' % file)

    env = dict(os.environ)
    env['LANG'] = 'ja_JP.utf8'

    proc = subprocess.Popen(
        _build_cmd(file, args),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        cwd=work_dir, env=env,
        # 新进程组：超时时能连同子进程一起收掉（对应 Kill(entireProcessTree)）
        start_new_session=not sys.platform.startswith('win'),
    )

    lines: List[str] = []
    lock = threading.Lock()

    def _reader(stream, is_err: bool) -> None:
        try:
            for raw in iter(stream.readline, b''):
                text = _decode(raw).rstrip('\r\n')
                if is_err:
                    try:
                        logger.error('ProcessRunner >>> %s' % text)
                    except Exception:                        # noqa: BLE001
                        pass
                elif DebugSwitch:
                    try:
                        logger.info('ProcessRunner >>> %s' % text)
                    except Exception:                        # noqa: BLE001
                        pass
                with lock:
                    lines.append(text)
        except Exception:                                    # noqa: BLE001
            pass
        finally:
            try:
                stream.close()
            except Exception:                                # noqa: BLE001
                pass

    t_out = threading.Thread(target=_reader, args=(proc.stdout, False), daemon=True)
    t_err = threading.Thread(target=_reader, args=(proc.stderr, True), daemon=True)
    t_out.start()
    t_err.start()

    exited = True
    try:
        if timeout_ms and timeout_ms > 0:
            proc.wait(timeout=timeout_ms / 1000.0)
        else:
            proc.wait()
    except subprocess.TimeoutExpired:
        exited = False
        try:
            logger.warning('ProcessRunner >>> Timeout, killing...')
        except Exception:                                    # noqa: BLE001
            pass
        _kill_tree(proc)
        try:
            proc.wait(timeout=10)
        except Exception:                                    # noqa: BLE001
            pass
        try:
            logger.warning('ProcessRunner >>> Killed.')
        except Exception:                                    # noqa: BLE001
            pass

    # C# 里两个 async 读线程必须在读 output 之前 flush 完（各等 5 秒）
    t_out.join(timeout=5)
    t_err.join(timeout=5)
    try:
        proc.stdout.close()
    except Exception:                                        # noqa: BLE001
        pass
    try:
        proc.stderr.close()
    except Exception:                                        # noqa: BLE001
        pass

    with lock:
        text = ''.join(line + '\n' for line in lines)
        if not exited:
            text += 'Killed due to timeout.'
        else:
            text += 'Exit code %d' % (proc.returncode if proc.returncode is not None else -1)
        return text
