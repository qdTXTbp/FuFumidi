# -*- coding: utf-8 -*-
"""sf3tool（SF3 → SF2 转换）自测。

★ 用合成夹具：soundfile 现场编码一个 Ogg 采样 → 手工拼一个最小 sf3 → 走 convert →
  断言输出的 smpl 是 PCM、循环点转成了绝对索引、压缩位被清掉。
  soundfile/numpy 缺席的环境（如无音频依赖的 CI）自动跳过。
"""
import io
import os
import struct

import pytest

np = pytest.importorskip('numpy')
pytest.importorskip('soundfile')


def _load_tool():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        'sf3tool_module', os.path.join(os.path.dirname(__file__), '..', 'sf3tool.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


sf3 = _load_tool()


def _make_sf3(tmp_path, n_samples=2):
    """合成一个最小 sf3：n_samples 个 Ogg 正弦采样 + 真实结构。"""
    import soundfile as sf

    oggs, lengths = [], []
    for i in range(n_samples):
        t = np.arange(2000 + 400 * i, dtype=np.float64) / 32000.0
        pcm = (0.5 * np.sin(2 * 3.14159 * (440 + 110 * i) * t)).astype(np.float32)
        buf = io.BytesIO()
        sf.write(buf, pcm, 32000, format='OGG', subtype='VORBIS')
        blob = buf.getvalue()
        oggs.append(blob)
        lengths.append(len(blob))

    # smpl = 各 ogg 首尾相接
    smpl = bytearray()
    recs = []
    for i, blob in enumerate(oggs):
        st = len(smpl)
        smpl.extend(blob)
        # 循环点用解码后的帧索引（相对），这里随便给个合法范围
        recs.append([('s%d' % i).encode()[:20], st, st + len(blob), 8, 64, 32000, 60, 0, 0, 1 | 0x10])
    # 终结记录
    recs.append([b'', 0, 0, 0, 0, 0, 0, 0, 0, 0])

    def chunk(cid, body):
        return cid + struct.pack('<I', len(body)) + body + (b'\x00' if len(body) & 1 else b'')

    shdr_body = bytearray()
    for r in recs:
        nm = (r[0] + b'\x00' * 20)[:20]
        shdr_body += nm + struct.pack('<IIIII', r[1], r[2], r[3], r[4], r[5])
        shdr_body += struct.pack('<BbHH', r[6], r[7], r[8], r[9])
    info_body = chunk(b'ifil', struct.pack('<HH', 2, 4)) + chunk(b'INAM', b'Test\x00')
    pdta_body = chunk(b'shdr', bytes(shdr_body))
    riff = (b'sfbk'
            + chunk(b'LIST', b'INFO' + info_body)
            + chunk(b'LIST', b'sdta' + chunk(b'smpl', bytes(smpl)))
            + chunk(b'LIST', b'pdta' + pdta_body))
    src = tmp_path / 'tiny.sf3'
    src.write_bytes(b'RIFF' + struct.pack('<I', len(riff)) + riff)
    return src, recs


def test_probe_reports_compressed_samples(tmp_path):
    src, recs = _make_sf3(tmp_path)
    with io.open(str(src), 'rb') as f:
        data = f.read()
    _, ogg, _, parsed = sf3.parse_sf3(data)
    real = [x for x in parsed if x[0] or x[1] or x[2]]
    assert len(real) == 2
    assert all(x[9] & 0x10 for x in real)


def test_convert_produces_pcm_sf2(tmp_path):
    src, recs = _make_sf3(tmp_path, n_samples=3)
    dst = tmp_path / 'tiny.conv.sf2'
    stats = sf3.convert(str(src), str(dst))
    assert stats['ok'] if 'ok' in stats else True
    assert stats['decoded'] == 3 and stats['failed'] == 0

    data = dst.read_bytes()
    assert data[:4] == b'RIFF' and data[8:12] == b'sfbk'
    _, smpl, _, parsed = sf3.parse_sf3(data)
    real = [x for x in parsed if x[0] or x[1] or x[2]]
    assert len(real) == 3
    for x in real:
        assert not (x[9] & 0x10), '压缩位必须被清掉'
        # PCM 抽出来必须有内容（Ogg 解码不该是静音）
        pcm = np.frombuffer(smpl[x[1] * 2:(x[2] + 1) * 2], dtype='<i2')
        assert len(pcm) > 100
        assert int(np.abs(pcm).max()) > 1000
        # 循环点已转成绝对索引且落在采样范围内
        assert x[1] <= x[3] <= x[2] + 4096   # 解码帧数可能比编码略多（vorbis padding）
        assert x[1] <= x[4] <= x[2] + 4096


def test_parse_rejects_non_sf3(tmp_path):
    bad = tmp_path / 'bad.sf3'
    bad.write_bytes(b'RIFF\x00\x00\x00\x00NOTS' + b'\x00' * 32)
    with pytest.raises(ValueError):
        sf3.parse_sf3(bad.read_bytes())
