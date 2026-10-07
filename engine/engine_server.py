# -*- coding: utf-8 -*-
"""常驻引擎的 stdin/stdout JSON 行协议（供主进程 EngineSession 驱动）。

## 为什么要有 serve 模式

一次性 spawn 每次都要：启动 Python（0.5s）+ `import torch`（2-5s）+ 加载声库
（有模块级缓存的声库/模型驻留内存）。反复调参时这些**固定开销占大头**。
serve 模式把进程留驻，只跑增量请求。

## 协议

请求（stdin，每行一个 JSON）：
    {"id": 7, "argv": ["render", "--voicebank", "...", "--notes", "@file", ...]}
退出：
    {"cmd": "exit"}

输出（stdout）：
    ###PROG {"id": 7, "pct": 30, ...}     进度（带请求 id）
    ###RESULT {"id": 7, "ok": true, ...}  结果（与一次性模式同形，多一个 id）
    其它行 = 普通日志，原样透传

★ id 织入由这里负责：子命令内部的 `emit_progress` / `emit_result` 不知道自己
  跑在常驻会话里 —— serve_loop 用一个「带 id 的 stdout 过滤器」把 id 织进它们
  的输出，**子命令零改动**（复用现有 argparse 分发，不复制任何业务逻辑）。
"""

import json
import sys

_UNSET = object()


class _IdWeavingWriter:
    """stdout 过滤器：###PROG/###RESULT 织入请求 id，普通日志原样透传。"""

    def __init__(self, rid, real):
        self._rid = rid
        self._real = real
        self._result = _UNSET

    def write(self, s):
        try:
            for line in s.splitlines():
                t = line.strip()
                if not t:
                    continue
                if t.startswith('###RESULT '):
                    try:
                        payload = json.loads(t[len('###RESULT '):])
                        payload['id'] = self._rid
                        self._result = payload
                    except Exception:                       # noqa: BLE001
                        self._result = {'ok': False, 'error': 'bad result line: ' + t[:200]}
                    continue
                if t.startswith('###PROG '):
                    try:
                        p = json.loads(t[len('###PROG '):])
                        p['id'] = self._rid
                        self._real.write('###PROG ' + json.dumps(p, ensure_ascii=False) + '\n')
                    except Exception:                       # noqa: BLE001
                        pass
                    continue
                self._real.write(t + '\n')
            try:
                self._real.flush()
            except Exception:                               # noqa: BLE001
                pass
        except Exception:                                   # noqa: BLE001
            pass  # 过滤器绝不把异常漏回子命令（那会炸掉常驻进程）
        return len(s)

    def flush(self):
        try:
            self._real.flush()
        except Exception:                                   # noqa: BLE001
            pass


def serve_loop(module):
    """stdin JSON 行循环：每个请求跑一次 `module.main(argv)`。

    单个请求失败**不退出**（把错误作为该请求的 RESULT 返回）——
    常驻进程死于单个坏请求就失去意义了。只有 stdin 关闭 / exit 命令才结束。
    """
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except Exception:                                   # noqa: BLE001
            continue
        if not isinstance(req, dict):
            continue
        if req.get('cmd') == 'exit':
            break
        rid = req.get('id')
        argv = req.get('argv') or []
        if not isinstance(argv, list):
            argv = []

        writer = _IdWeavingWriter(rid, sys.__stdout__)
        old_stdout = sys.stdout
        sys.stdout = writer
        try:
            module.main(list(argv))
        except SystemExit as e:                             # argparse 出错会 SystemExit
            writer._result = {'ok': False, 'error': 'argparse: %s' % e}
        except Exception as e:                              # noqa: BLE001
            writer._result = {'ok': False, 'error': str(e)}
        finally:
            sys.stdout = old_stdout

        result = writer._result
        if result is _UNSET:
            result = {'ok': False, 'error': '子命令没有产出结果'}
        result = dict(result)
        result['id'] = rid
        try:
            sys.__stdout__.write('###RESULT ' + json.dumps(result, ensure_ascii=False) + '\n')
            sys.__stdout__.flush()
        except Exception:                                   # noqa: BLE001
            pass  # 主进程可能已杀掉管道 —— 外层 close 处理会清场
