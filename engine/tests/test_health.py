# -*- coding: utf-8 -*-
"""全局体检的回归测试：脱敏、判定、无显卡时不崩。

体检是要**公开贴出去**的东西，所以脱敏错了比不脱敏更糟 ——
用户以为安全了，结果机器名和用户名都在里面。
"""
import json
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

import health  # noqa: E402


def test_redact_removes_home_user_and_host():
    red = health.make_redactor()
    home = os.path.expanduser("~")
    user = os.path.basename(home)
    s = "文件在 " + home + "\\Music\\a.flac ，用户 " + user + " 在跑"
    out = red(s)
    assert home not in out, "家目录没被替换"
    if len(user) >= 3:
        assert user not in out, "用户名没被替换"
    assert "<home>" in out or "<user>" in out


def test_redact_catches_windows_user_paths():
    red = health.make_redactor()
    out = red(r"E:\build\ok\C:\Users\someone\AppData\Local\Temp\x.log 和 /home/another/f.log")
    assert "someone" not in out
    assert "another" not in out
    assert "<user>" in out


def test_verdicts_warn_when_gpu_present_but_no_pack():
    """有 NVIDIA 卡、但没启用加速 —— 这正是用户来反馈时最常见的情况。"""
    rep = {"gpu": {"vendor": "nvidia", "name": "RTX 4070", "available": False},
           "system": {}, "runtime": {"deps": {}}, "models": {}, "recent_errors": []}
    v = health.verdicts(rep)
    warn = [x for x in v if x[0] == "warn" and x[1] == "显卡"]
    assert warn, "应该给出「有卡但没启用加速」的警告"
    assert "CUDA" in warn[0][2], "应告诉 NVIDIA 用户该装 CUDA 包"


def test_verdicts_flag_arch_unsupported():
    rep = {"gpu": {"vendor": "nvidia", "available": True, "backend": "cuda",
                   "arch_supported": False, "arch_reason": "算力 sm_61 太低"},
           "system": {}, "runtime": {"deps": {}}, "models": {}, "recent_errors": []}
    v = health.verdicts(rep)
    assert any("算力" in x[2] for x in v if x[1] == "显卡")


def test_verdicts_flag_failed_compute_check():
    """issue #20 的形态：is_available 为真、但真算就炸。"""
    rep = {"gpu": {"vendor": "amd", "available": True, "backend": "rocm",
                   "name": "RX 7900"},
           "compute_check": {"tested": True, "device": "cuda:0", "ok": False,
                             "error": "no kernel image is available"},
           "system": {}, "runtime": {"deps": {}}, "models": {}, "recent_errors": []}
    v = health.verdicts(rep)
    err = [x for x in v if x[0] == "error" and x[1] == "算力校验"]
    assert err, "算力校验失败必须报 error 级"
    assert "自动改用 CPU" in err[0][2], "要告诉用户功能不受影响"


def test_verdicts_ok_for_healthy_cpu_only_machine():
    rep = {"gpu": {}, "system": {}, "runtime": {"deps": {}}, "models": {"models_dir_set": False},
           "recent_errors": []}
    v = health.verdicts(rep)
    assert any("没有检测到独立显卡" in x[2] for x in v)


def test_collect_returns_dict_verdicts_not_tuples():
    """★ 前端吃的是 JSON：元组会被序列化成数组，界面就只剩图标没有文字。

    这条断言锁的是「verdicts 的每一项必须是 dict」。
    """
    import json
    rep = health.collect()
    assert rep["verdicts"], "体检至少要给出一条结论"
    for v in rep["verdicts"]:
        assert isinstance(v, dict), "verdicts 项必须是 dict，不能是元组"
        assert set(v) >= {"level", "group", "msg"}
    # 整份报告必须能 JSON 往返（前端就是从 JSON 拿的）
    back = json.loads(json.dumps(rep, ensure_ascii=False, default=str))
    assert back["verdicts"][0]["msg"]


def test_render_text_is_plain_and_contains_sections():
    rep = {"time": "2026-01-01 00:00:00", "app_version": "9.9.9",
           "verdicts": [{"level": "ok", "group": "显卡", "msg": "一切正常"}],
           "system": {"os": "Windows", "arch": "AMD64", "cpu": "X", "cpu_count": 8, "disks": {}},
           "gpu": {}, "compute_check": {}, "runtime": {"python": "3.11", "deps": {}},
           "models": {"items": {}}, "recent_errors": []}
    txt = health.render_text(rep, lambda s: s)
    assert "FuFumidi 全局体检报告" in txt
    assert "结论" in txt and "显卡与加速" in txt and "最近错误" in txt
    assert "[OK]" in txt
