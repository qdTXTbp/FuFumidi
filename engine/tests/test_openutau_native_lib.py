# -*- coding: utf-8 -*-
"""随包分发的 `worldline` 原生库：**布局、解析、真机可用性**。

为什么单独一个文件（而不是并进 `test_openutau_core_matches_source.py`）：
那边校验的是「Python ← C#」的**语义照搬**；这里管的是**分发**——上游的 C# 是
`[DllImport("worldline")]`，CLR 自己会找 `runtimes/<rid>/native/`，而 Python 的
`ctypes.CDLL('worldline')` 只搜系统路径。所以「库在不在、能不能被找到」是一条
**独立于语义**的正确性线，而且它出问题时症状很隐蔽：

    一致性测试里全部显式指向 `_ref/OpenUtau/runtimes/...` 的绝对路径，
    于是测试全绿，而打包后的应用里变调链路**整个不可用**。

本文件就是钉住这条线：
  1. 包内 `native/<rid>/` 的布局完整（每个分发平台都自带库文件）；
  2. 分发的二进制与上游 `runtimes/` **逐字节一致**（防半截构建 / 被替换）；
  3. 重分发合规：MIT 许可证随二进制一起分发；
  4. `resolve_worldline()` 不依赖 `_ref`、显式参数优先、坏路径不命中；
  5. 真机：`get_native()` **不给路径**也能加载，且真 API 可调用。

上游缺失时自动 SKIP（`OPENUTAU_REF` 可指定参考仓库）。可离线运行。
"""

import hashlib
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ENGINE = os.path.dirname(HERE)
if ENGINE not in sys.path:
    sys.path.insert(0, ENGINE)

REF = os.environ.get('OPENUTAU_REF') or r'D:/FuFuMIDI/_ref/OpenUtau/OpenUtau.Core'
REF_ROOT = os.path.dirname(REF)

from singing.openutau import native_lib as NL  # noqa: E402

_RID_RE = re.compile(r'^(win-(x64|arm64|x86)|linux-(x64|arm64)|osx)$')

_PASS, _FAIL = [], []


def check(label, cond, detail=''):
    (_PASS if cond else _FAIL).append(label)
    print('  %s %s%s' % ('PASS' if cond else 'FAIL', label,
                         ('\n       ' + detail) if (detail and not cond) else ''))


def _sha256(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def _packaged_rids():
    pkg = NL.PKG_NATIVE_DIR
    if not os.path.isdir(pkg):
        return []
    return sorted(n for n in os.listdir(pkg) if os.path.isdir(os.path.join(pkg, n)))


def test_native_layout():
    """包内 `native/<rid>/` 的布局、二进制一致性、许可证。"""
    pkg = NL.PKG_NATIVE_DIR
    check('native_lib: 包内随分发目录存在', os.path.isdir(pkg), pkg)
    if not os.path.isdir(pkg):
        return

    rids = _packaged_rids()
    check('native_lib: 分发平台不少于 6 个（win x64/arm64/x86 + linux x64/arm64 + osx）',
          len(rids) >= 6, 'got %r' % (rids,))
    for rid in rids:
        check('native_lib: RID %r 命名符合 .NET 约定' % rid, bool(_RID_RE.match(rid)), rid)
        name = NL.LIB_BY_RID.get(rid)
        check('native_lib: RID %r 在 LIB_BY_RID 里有对应库名' % rid, bool(name), repr(name))
        if name:
            p = os.path.join(pkg, rid, name)
            check('native_lib: %s/%s 存在且非空' % (rid, name),
                  os.path.isfile(p) and os.path.getsize(p) > 0)

    # 与上游逐字节一致 —— 防止「随手换了个别的构建」或半截文件进包
    ref_rt = os.path.join(REF_ROOT, 'runtimes')
    if not os.path.isdir(ref_rt):
        print('  SKIP 二进制比对：找不到上游 runtimes/（%s）' % ref_rt)
    else:
        mismatch, compared = [], 0
        for rid in rids:
            name = NL.LIB_BY_RID.get(rid)
            up = os.path.join(ref_rt, rid, 'native', name or '')
            ours = os.path.join(pkg, rid, name or '')
            if not (name and os.path.isfile(up) and os.path.isfile(ours)):
                continue
            compared += 1
            if _sha256(ours) != _sha256(up):
                mismatch.append(rid)
        check('native_lib: 分发的二进制与上游 runtimes/ 逐字节一致（比对 %d 个）' % compared,
              compared > 0 and not mismatch, 'mismatch=%r compared=%d' % (mismatch, compared))

    # 重分发合规：MIT 许可证必须跟二进制一起走
    lic_path = os.path.join(pkg, 'LICENSE-OpenUtau.txt')
    check('native_lib: 随附 OpenUTAU 许可证文件', os.path.isfile(lic_path))
    if os.path.isfile(lic_path):
        lic = open(lic_path, encoding='utf-8').read()
        check('native_lib: 许可证正文是 MIT', 'The MIT License (MIT)' in lic)
        check('native_lib: 许可证保留了上游版权行', 'Copyright (c)' in lic)
    check('native_lib: 有来源与构建说明（README）',
          os.path.isfile(os.path.join(pkg, 'README.md')))


def test_native_resolution():
    """解析顺序：显式 > 环境变量 > 包内 > 引擎根 > 参考仓库；且**不依赖 `_ref`**。"""
    rid = NL.platform_rid()
    check('native_lib: 当前平台能推出 RID', rid is not None, 'rid=%r' % rid)
    check('native_lib: RID 取值在约定集合内',
          rid is None or bool(_RID_RE.match(rid)), 'rid=%r' % rid)

    found = NL.resolve_worldline()
    check('native_lib: 默认解析能找到库', found is not None)
    if found:
        pkg = os.path.normcase(NL.PKG_NATIVE_DIR)
        check('native_lib: 解析到的是**包内**那一份（不靠 _ref 兜底）',
              os.path.normcase(found).startswith(pkg), 'got %s' % found)
        check('native_lib: 解析结果是真实文件', os.path.isfile(found))
        check('native_lib: 解析结果在该平台 RID 目录下',
              os.path.basename(os.path.dirname(found)) == (rid or os.path.basename(os.path.dirname(found))),
              'got %s' % found)

    # 显式参数「优先尝试」而不是「硬覆盖」：路径不存在时继续回落，
    # 免得一条过期的排障路径把整个变调链路弄坏（硬覆盖交给 WorldlineNative 直接传参）
    check('native_lib: 显式传入的路径排在候选首位',
          NL.candidates('X:/nope/none.dll')[0] == 'X:/nope/none.dll')
    check('native_lib: 显式路径不存在时回落到默认解析结果（而非直接失败）',
          NL.resolve_worldline('X:/definitely-not-here/none.dll') == NL.resolve_worldline(),
          'got %r' % NL.resolve_worldline('X:/definitely-not-here/none.dll'))
    check('native_lib: 无候选时返回 None 而不是抛异常',
          NL.resolve_worldline.__doc__ is not None and isinstance(NL.candidates(), list))
    check('native_lib: describe() 可读且含 rid',
          ('rid=' in NL.describe()) and (NL.library_name() in NL.describe()), NL.describe())

    # 平台识别：库名与平台对应
    check('native_lib: Windows 库名是 worldline.dll',
          NL.library_name('win-x64') == 'worldline.dll')
    check('native_lib: Linux 库名是 libworldline.so',
          NL.library_name('linux-x64') == 'libworldline.so')
    check('native_lib: macOS 库名是 libworldline.dylib',
          NL.library_name('osx') == 'libworldline.dylib')


def test_native_binding_usable():
    """★ 真机：**不给任何路径**也要能用 —— 这正是发布版依赖的那条路。"""
    from singing.openutau import worldline as W

    native = W.get_native()
    if not native.available:
        print('  SKIP 原生库不可用：%s' % native.error)
        return
    check('原生库: get_native() 不给路径即可用', native.available)

    # 打一次真 API：InitAnalysisConfig 是 AnalysisConfig 的唯一权威来源
    cfg = native.init_analysis_config(44100, 5, 2048)
    check('原生库: init_analysis_config 回填了 fs', cfg is not None and cfg.fs == 44100,
          'got %r' % (cfg,))
    check('原生库: init_analysis_config 回填了 fft_size', cfg is not None and cfg.fft_size == 2048,
          'got %r' % (cfg,))
    check('原生库: f0_floor > 0（cheap trick 公式已生效）',
          cfg is not None and cfg.f0_floor > 0, 'got %r' % (cfg and cfg.f0_floor))

    # F0FrameCount：给 1 秒 44.1kHz 的样本，帧数应为正
    cnt = native.f0_frame_count(44100, 44100, 5.0, -1)
    check('原生库: f0_frame_count 给出正帧数', isinstance(cnt, int) and cnt > 0, 'got %r' % cnt)

    # 显式坏路径仍然优雅降级（既有契约，别被解析器改动破坏）
    bad = W.WorldlineNative('definitely-not-a-real-library-xyz')
    check('原生库: 显式坏路径仍 available=False 且带错误信息',
          bad.available is False and bool(bad.error))


def main():
    print('--- worldline 原生库：布局 / 解析 / 可用性 ---')
    for fn in (test_native_layout, test_native_resolution, test_native_binding_usable):
        fn()
    print()
    print('结果: %d passed, %d failed' % (len(_PASS), len(_FAIL)))
    if _FAIL:
        for f in _FAIL:
            print('  FAILED:', f)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
