# -*- coding: utf-8 -*-
"""反馈打包器的单测：**隐私是主要断言对象**。

重点不是"能打个包"，而是：
  · 诊断包里的令牌/邮箱/用户名/家目录在**进包的路上**就被洗掉（不是先落盘再洗）；
  · 二进制附件根本不进反馈包；
  · 整个最终 zip 里再也搜不到原始敏感串。
"""
import io
import json
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import feedback_bundle as FB  # noqa: E402

SECRET = 'hf_abcdefghijklmnopqrstuvwx'
HEX = '0123456789abcdef0123456789abcdef'


def _fake_redactor():
    """确定性的 redactor：替掉测试里用的假主机名/用户名（真 redactor 用本机真名，跑 CI 不好断言）。"""
    def redact(s):
        return str(s).replace('TESTHOST', '<host>').replace('testuser', '<user>')
    return redact


def _diag_zip(path, entries):
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name, content in entries.items():
            z.writestr(name, content)
    return path


def _all_text(zip_path):
    out = []
    with zipfile.ZipFile(zip_path) as z:
        for n in z.namelist():
            out.append(z.read(n))
    return b'\n'.join(out)


def test_bundle_keeps_md_and_report_byte_identical(tmp_path, monkeypatch):
    monkeypatch.setattr(FB, '_redactor', _fake_redactor)
    md = tmp_path / 'issue.md'
    md.write_text('# 症状\n点不动\n', encoding='utf-8')
    rp = tmp_path / 'health-report.md'
    rp.write_text('系统：Windows 11\n', encoding='utf-8')
    out = tmp_path / 'bundle.zip'
    res = FB.build(str(out), str(md), str(rp))
    assert res['ok'] and res['entries'] == ['issue.md', 'health-report.md']
    with zipfile.ZipFile(out) as z:
        # 逐字节比较：Windows 上 write_text 会把 \n 写成 \r\n，打包器应当原样搬运
        assert z.read('issue.md') == md.read_bytes()
        assert z.read('health-report.md') == rp.read_bytes()


def test_diagnostic_is_sanitized_in_flight(tmp_path, monkeypatch):
    monkeypatch.setattr(FB, '_redactor', _fake_redactor)
    diag = _diag_zip(str(tmp_path / 'diag.zip'), {
        'settings.json': json.dumps({
            'theme': 'dark',
            'hfToken': SECRET,
            'account': {'email': 'me@example.com', 'nickname': 'n'},
            'libraryPath': 'C:\\Users\\testuser\\Music',
        }),
        'run.log': 'host=TESTHOST user=testuser path=C:\\Users\\testuser\\a.mid token=' + SECRET + ' hex=' + HEX,
        'dump.bin': b'\x00\x01\x02binary',
    })
    md = tmp_path / 'issue.md'
    md.write_text('# x\n', encoding='utf-8')
    out = tmp_path / 'bundle.zip'
    res = FB.build(str(out), str(md), None, diag)

    assert res['stripped'] == ['dump.bin'], res['stripped']
    with zipfile.ZipFile(out) as z:
        inner = zipfile.ZipFile(io.BytesIO(z.read('diagnostic.zip')))
        names = inner.namelist()
        assert 'dump.bin' not in names, names
        settings = inner.read('settings.json').decode('utf-8')
        log = inner.read('run.log').decode('utf-8')
    assert '<已移除>' in settings and 'dark' in settings, settings
    assert SECRET not in settings and 'me@example.com' not in settings, settings
    assert '<user>' in log and '<host>' in log, log
    assert SECRET not in log and HEX not in log, log
    # 最终 zip 里（含嵌套的诊断包）任何位置都不该再有原始敏感串
    blob = _all_text(str(out))
    for bad in (SECRET.encode(), HEX.encode(), b'me@example.com', b'TESTHOST', b'C:\\Users\\testuser'):
        assert bad not in blob, bad


def test_long_log_is_truncated(tmp_path, monkeypatch):
    monkeypatch.setattr(FB, '_redactor', _fake_redactor)
    big = '\n'.join('line %d ok' % i for i in range(40000)) + '\nTAIL'
    diag = _diag_zip(str(tmp_path / 'diag.zip'), {'big.log': big})
    md = tmp_path / 'issue.md'
    md.write_text('# x\n', encoding='utf-8')
    out = tmp_path / 'bundle.zip'
    FB.build(str(out), str(md), None, diag)
    with zipfile.ZipFile(out) as z:
        inner = zipfile.ZipFile(io.BytesIO(z.read('diagnostic.zip')))
        txt = inner.read('big.log').decode('utf-8')
    assert len(txt) < FB.LOG_KEEP_BYTES + 200, len(txt)
    assert txt.endswith('TAIL')
    assert '截断' in txt


def test_real_redactor_is_usable():
    """真 redactor（health.make_redactor）必须存在且能跑 —— 上面几个用假 redactor 是为了确定性。"""
    redact = FB._redactor()
    assert callable(redact)
    assert isinstance(redact('abc'), str)
