# -*- coding: utf-8 -*-
"""多音色库合并工具（engine/sf2_merge.py）的格式契约。

教训（2026-10，实测）：合并出的 SF2 在 Python 侧结构"看起来对"，但 FluidSynth 拒载，
报 "Expected PDTA sub-chunk 'pmod' found invalid id instead" —— 原因是 pdta 子块顺序
不是直觉顺序，而且 pmod / imod 不能省：

    phdr, pbag, pmod, pgen, inst, ibag, imod, igen, shdr

FluidSynth 的 process_pdta() 就是按这个顺序逐个 pdtahelper 校验的。这个顺序一旦再被
"整理"，整个 200MB 音色包会整包报废，所以必须用测试钉死。
"""
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import sf2_merge as M

PDTA_ORDER = [b'phdr', b'pbag', b'pmod', b'pgen', b'inst', b'ibag', b'imod', b'igen', b'shdr']


def _name(s):
    b = s.encode('latin1')[:20]
    return b + b'\x00' * (20 - len(b))


def _ch(cid, body):
    return cid + struct.pack('<I', len(body)) + body + (b'\x00' if len(body) & 1 else b'')


def _write_sf2(path, presets, frames=32):
    """写一个最小合法 SF2：每个 preset → 1 个 instrument zone → 1 个采样。"""
    n = len(presets)
    # pdta：phdr / pbag / pmod / pgen / inst / ibag / imod / igen / shdr
    phdr = b''
    for i, (nm, bank, prog) in enumerate(presets):
        phdr += _name(nm) + struct.pack('<HHHIII', prog, bank, i, 0, 0, 0)
    phdr += _name('') + struct.pack('<HHHIII', 0, 0, n, 0, 0, 0)

    pbag = b''.join(struct.pack('<HH', i, 0) for i in range(n)) + struct.pack('<HH', n, 0)
    pgen = b''.join(struct.pack('<HH', 41, i) for i in range(n)) + struct.pack('<HH', 0, 0)

    inst = b''
    for i in range(n):
        inst += _name('inst%d' % i) + struct.pack('<H', i)
    inst += _name('') + struct.pack('<H', n)

    # 每个 instrument zone 两个发生器（keyRange + sampleID），ibag 记发生器起点
    igen = b''
    ibag_entries = []
    for i in range(n):
        ibag_entries.append(len(igen) // 4)
        igen += struct.pack('<HH', 43, 0x7F00)       # keyRange 0..127
        igen += struct.pack('<HH', 53, i)            # sampleID
    ibag_entries.append(len(igen) // 4)
    igen += struct.pack('<HH', 0, 0)                  # 终止记录
    ibag = b''.join(struct.pack('<HH', g, 0) for g in ibag_entries)

    smpl = b''.join(struct.pack('<h', 1000 if (i % 2) else -1000) for i in range(frames)) * n
    shdr = b''
    for i in range(n):
        st = i * frames
        shdr += _name('smp%d' % i) + struct.pack('<IIIII', st, st + frames - 1, st, st + frames - 1, 44100)
        shdr += struct.pack('<BbHH', 60, 0, 0, 1)
    shdr += _name('') + struct.pack('<IIIII', 0, 0, 0, 0, 0) + struct.pack('<BbHH', 0, 0, 0, 0)

    mod_term = struct.pack('<HHhHH', 0, 0, 0, 0, 0)
    pdta = (_ch(b'phdr', phdr) + _ch(b'pbag', pbag) + _ch(b'pmod', mod_term)
            + _ch(b'pgen', pgen) + _ch(b'inst', inst) + _ch(b'ibag', ibag)
            + _ch(b'imod', mod_term) + _ch(b'igen', igen) + _ch(b'shdr', shdr))
    info = b''.join(_ch(cid, body) for cid, body in
                    [(b'ifil', struct.pack('<HH', 2, 4)), (b'INAM', b'unit test\x00'), (b'ISFT', b'sf2_merge test\x00')])
    riff = (b'sfbk' + _ch(b'LIST', b'INFO' + info)
            + _ch(b'LIST', b'sdta' + _ch(b'smpl', smpl))
            + _ch(b'LIST', b'pdta' + pdta))
    with open(path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', len(riff)) + riff)


def _pdta_order(path):
    order = []
    with open(path, 'rb') as f:
        head = f.read(12)
        pos, end = 12, 8 + struct.unpack('<I', head[4:8])[0]
        while pos + 8 <= end:
            f.seek(pos)
            h = f.read(8)
            cid, sz = h[:4], struct.unpack('<I', h[4:8])[0]
            if cid == b'LIST':
                f.seek(pos + 8)
                if f.read(4) == b'pdta':
                    q, pend = pos + 12, pos + 8 + sz
                    while q + 8 <= pend:
                        f.seek(q)
                        h2 = f.read(8)
                        order.append((h2[:4], struct.unpack('<I', h2[4:8])[0]))
                        q += 8 + struct.unpack('<I', h2[4:8])[0] + (struct.unpack('<I', h2[4:8])[0] & 1)
            pos += 8 + sz + (sz & 1)
    return order


def test_read_headers_roundtrip_of_written_fixture():
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, 'a.sf2')
        _write_sf2(p, [('Piano A', 0, 0), ('Drum Kit', 128, 0)])
        h = M.read_headers(p)
        assert [x[0] for x in h['phdr']] == ['Piano A', 'Drum Kit']
        assert len(h['shdr']) == 2
        # ibag 是 4 字节记录 (genNdx, modNdx)，按 2 字节读会得到百万级发生器数
        assert h['ibag'][0] == (0, 0)
        assert all(m == 0 for _g, m in h['ibag'])


def test_merge_writes_pdta_in_fluidsynth_order():
    with tempfile.TemporaryDirectory() as d:
        src = os.path.join(d, 'a.sf2')
        out = os.path.join(d, 'out.sf2')
        _write_sf2(src, [('Piano A', 0, 0)])
        r = M.merge([src], out, 450)
        assert r['ok'] and r['presets'] == 1
        order = _pdta_order(out)
        assert [cid for cid, _sz in order] == PDTA_ORDER
        sizes = dict(order)
        # 空调制器 chunk 必须存在（FluidSynth 缺 pmod/imod 会整包拒载）
        assert sizes[b'pmod'] == 10 and sizes[b'imod'] == 10


def test_merge_output_is_loadable_and_keeps_gm_slots():
    with tempfile.TemporaryDirectory() as d:
        a = os.path.join(d, 'a.sf2')
        b = os.path.join(d, 'b.sf2')
        out = os.path.join(d, 'out.sf2')
        _write_sf2(a, [('Piano A', 0, 0), ('Strings A', 0, 48)])
        _write_sf2(b, [('Piano B', 0, 0), ('Drum Kit', 128, 0)])
        r = M.merge([a, b], out, 450)
        assert r['ok'] and r['presets'] == 3
        h = M.read_headers(out)
        slots = sorted((ph[2], ph[1]) for ph in h['phdr'])
        assert slots == [(0, 0), (0, 48), (128, 0)]
        # 采样边界必须落在 smpl 数据内
        assert max(s[2] for s in h['shdr']) <= h['smpl_sz'] // 2
        # 每个 preset 都至少有一个带 sampleID 的 zone
        for pi in range(len(h['phdr'])):
            assert any(ii is not None and ii < len(h['inst']) for _g, ii in M.preset_zones(h, pi))
