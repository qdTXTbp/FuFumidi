# -*- coding: utf-8 -*-
"""转录「暂停 / 继续」的公共闸门（★ 2026-10-14 用户要求：正在转录的那一首也要能暂停，继续后接着跑）。

**为什么用文件而不是 IPC**：转录跑在**常驻 Python worker** 里（music2midi.py worker，
stdin 是请求通道，正忙时读不到新指令），文件是唯一既能跨进程、又不用改协议的开关。
主进程把路径经 FUFUMIDI_PAUSE_FILE 传给 worker；前端写 / 删这个文件。

**三类引擎的暂停点在哪**（都在「块与块之间」，停下时模型状态全在内存里，继续时**从原处接着跑**）：

  引擎                  断点                                                  粒度
  MuScriptor            惰性 token 流生成器，每 5 秒块 yield 一次              5 秒音频
  basic-pitch           basic_pitch.inference.get_audio_input() 每窗 yield 一次  约 1.6 秒音频
  piano-transcription   我们自己的分批前向循环，批次之间                        一批（慢机器自适应缩小）

Aria-AMT / Transkun 是外部工具、一次调用跑完整首，仍是「这一首跑完再停」。

**为什么包装器只装一次、日志却每次重绑**：worker 常驻、模型是缓存的，包装器只能装一次；
如果把 log_cb 捕获进包装器，第二个文件起的暂停日志就会打到第一个文件的回调上
（实测踩过：闭包里拿到的是上一次的 log_cb）。所以包装器只读 current()，
由每次转录开头的 install(log_cb) 重绑。
"""

import os
import sys
import time

PAUSE_LOG = '[暂停] 引擎已停住，点「继续」接着跑'
RESUME_LOG = '[继续] 引擎继续推理…'


def pause_file_from_env():
    """暂停标记文件路径（没配置就返回 None = 这一路不做任何暂停包装）。"""
    return os.environ.get('FUFUMIDI_PAUSE_FILE') or None


class PauseGate:
    """「标记文件存在就原地等」的闸门。暂停 / 继续各只打一行日志，别每 0.2 秒刷屏。"""

    def __init__(self, pause_file=None, log_cb=None, stdout=None):
        self.pause_file = pause_file or None
        self.log_cb = log_cb
        self._paused = False
        # 构造时的 stdout（外面那层）——见 emit 的说明
        self._stdout = stdout if stdout is not None else sys.stdout

    @property
    def active(self):
        return bool(self.pause_file)

    def wait(self):
        """存在标记文件就阻塞，直到文件被删掉才返回；不需要暂停时是零成本直通。"""
        f = self.pause_file
        if not f:
            return
        while os.path.exists(f):
            if not self._paused:
                self._paused = True
                self.emit(PAUSE_LOG)
            time.sleep(0.2)
        if self._paused:
            self._paused = False
            self.emit(RESUME_LOG)

    def emit(self, line):
        """叫 log_cb 打一行 —— 并且**绕过 stdout 静音**。

        ★ 实测踩过：钢琴引擎会用 `contextlib.redirect_stdout(io.StringIO())` 静音上游
        模型自己的打印（"Segment x / y"），而 log_cb 就是 `print`。于是闸门在静音区间里
        打的「引擎已停住」被吞掉 —— 引擎**确实停住了**（实测停 100 秒），但用户看不到任何
        引擎侧回执，排查时只能看到"按了暂停没反应"。所以这里临时把 stdout 换回构造时那层，
        让 log_cb 的话照常进 worker 的 ###LOG 分流 / 命令行输出。
        """
        if not self.log_cb:
            return
        saved = sys.stdout
        restore = self._stdout is not None and saved is not self._stdout
        try:
            if restore:
                sys.stdout = self._stdout
            self.log_cb(line)
            try:
                sys.stdout.flush()
            except Exception:
                pass
        except Exception:
            pass                      # 日志失败不许影响转录
        finally:
            if restore:
                try:
                    sys.stdout = saved
                except Exception:
                    pass


_CURRENT = None


def install(log_cb=None):
    """每次转录开始时调用一次：把闸门重绑到**本次**的日志回调，并返回它。

    没配 FUFUMIDI_PAUSE_FILE（命令行直接调引擎、或旧主进程）时打一行提示 ——
    否则"按了暂停没反应"会变成一个查不出原因的哑故障（实测踩过：引擎端闸门没激活，
    表现是"暂停键点了没反应，这首还是跑完了"）。
    """
    global _CURRENT
    _CURRENT = PauseGate(pause_file_from_env(), log_cb, sys.stdout)
    if not _CURRENT.active and log_cb:
        try:
            log_cb('［暂停］本次未启用中途暂停（未设置 FUFUMIDI_PAUSE_FILE）')
        except Exception:
            pass
    return _CURRENT


def current():
    """当前这次转录的闸门（包装器只读它，不自己捕获 log_cb）。"""
    return _CURRENT


def wait():
    """在任意循环里插一句就能过闸门（包装器用它）。"""
    g = _CURRENT
    if g is not None:
        g.wait()


def log_line(line):
    """用**本次转录**的日志回调打一行。

    包装器（model._generate_token_stream / get_audio_input / 钢琴的 forward）只装一次、
    拿不到当次的 log_cb，所以诊断信息统一走这里 —— 否则日志会打到上一次的窗口上。
    """
    g = _CURRENT
    if g is not None:
        g.emit(line)


def gate_stream(stream, gate=None):
    """包一个可迭代对象：每产出一项之前过闸门（MuScriptor 的 token 流用）。

    stream 是**惰性**的，所以「卡在等下一项」就等于卡在块与块之间。
    """
    if gate is None:
        gate = _CURRENT
    if gate is None or not gate.active:
        for item in stream:
            yield item
        return
    for item in stream:
        gate.wait()
        yield item
