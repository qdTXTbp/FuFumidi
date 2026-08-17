# -*- coding: utf-8 -*-
"""
原生 Windows MIDI 播放器
========================
基于 winmm 的 MCI（Media Control Interface）播放 MIDI 文件，
使用系统自带的 **Microsoft GS Wavetable Synth** 发声 ——
无需任何第三方依赖，双击即可出声，支持 播放/暂停/停止/跳转/进度查询。

仅适用于 Windows（本工具目标平台即 Windows 10/11）。
"""

import ctypes
import os

ALIAS = "midi_tool_player"


class MidiPlayer:
    """一个简单的 MIDI 播放器（同一时刻只播放一个文件）。"""

    def __init__(self):
        self._mci = None
        self._available = False
        self._opened = False
        self._path = None
        self._length_ms = 0
        self._errbuf = ctypes.create_unicode_buffer(1024)
        try:
            if os.name == "nt":
                self._mci = ctypes.windll.winmm.mciSendStringW
                self._available = True
        except Exception:
            self._mci = None
            self._available = False

    # ---------- 状态 ----------
    @property
    def available(self):
        return self._available

    @property
    def is_open(self):
        return self._opened

    @property
    def path(self):
        return self._path

    def error_message(self):
        return "当前系统不支持 MCI（仅 Windows 可用）"

    # ---------- 底层 ----------
    def _send(self, cmd, silent=False):
        if not self._available:
            raise RuntimeError(self.error_message())
        rc = self._mci(cmd, self._errbuf, len(self._errbuf), 0)
        if rc != 0 and not silent:
            raise RuntimeError(f"MCI 错误 [{rc}] {self._errbuf.value}：{cmd[:60]}")
        return rc

    def _query_int(self, cmd):
        if not self._opened:
            return 0
        try:
            buf = ctypes.create_unicode_buffer(256)
            rc = self._mci(cmd, buf, len(buf), 0)
            if rc == 0 and buf.value:
                return int(buf.value.strip() or 0)
        except Exception:
            pass
        return 0

    # ---------- 播放控制 ----------
    def open(self, path):
        """打开 MIDI 文件（自动关闭之前打开的）。成功返回 True。"""
        self.close()
        path = os.path.abspath(path)
        if not os.path.isfile(path):
            raise RuntimeError(f"文件不存在：{path}")
        cmd = f'open "{path}" type sequencer alias {ALIAS}'
        self._send(cmd)
        # 统一用毫秒作为时间单位
        self._send(f"set {ALIAS} time format milliseconds", silent=True)
        self._opened = True
        self._path = path
        self._length_ms = self._query_int(f"status {ALIAS} length")
        self.seek(0)
        return True

    def play(self):
        if self._opened:
            self._send(f"play {ALIAS}")

    def pause(self):
        if self._opened:
            self._send(f"pause {ALIAS}", silent=True)

    def resume(self):
        self.play()

    def stop(self):
        """停止并回到开头。"""
        if self._opened:
            self._send(f"stop {ALIAS}", silent=True)
            self.seek(0)

    def seek(self, ms):
        if self._opened:
            self._send(f"seek {ALIAS} to {int(max(0, ms))}", silent=True)

    def position_ms(self):
        """当前播放位置（毫秒）。"""
        return self._query_int(f"status {ALIAS} position")

    def length_ms(self):
        return self._length_ms

    def close(self):
        if self._opened:
            self._send(f"close {ALIAS}", silent=True)
            self._opened = False
            self._path = None
            self._length_ms = 0

    def __del__(self):
        try:
            self.close()
        except Exception:
            pass
