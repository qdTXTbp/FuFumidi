#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""SF3 → SF2 转换器：把 Ogg 压缩采样解成 PCM16，产出一个标准 SF2。

★ 为什么要转换：js-synthesizer 的 libfluidsynth wasm 构建里 fluid_stat /
  fluid_file_test 是桩函数（永远 -1 / true），libsndfile 打不开 MEMFS 虚拟文件，
  sf3 的 Ogg 采样全部解不出来 —— 合成器「装载成功」却永远无声（2026-10-11 实测，
  控制台刷几百行 "is a stub"）。与其改第三方 wasm，不如在装载前把 sf3 解成
  标准 sf2：soundfile（打包 python 自带，libsndfile 含 vorbis）逐采样解码。

字段语义（用 FluidR3Mono_GM.sf3 实证，1036/1037 个采样 OggS 全对齐）：
  * dwStart / dwEnd：该采样的 Ogg 数据在 smpl 块里的**字节区间 [start, end)**；
  * dwStartLoop / dwEndLoop：**解码后采样帧**的相对索引（转 sf2 时要改成
    绝对索引：+ 新的 dwStart —— SF2 的循环点是相对整个采样数据块的绝对索引）；
  * sfSampleType bit 0x10 = 压缩标记，转完要清掉（17 → 1）；
  * shdr 末尾有一个全零的终结记录，原样保留。

命令行（与引擎其他脚本一致的 ###RESULT 协议）：
    python sf3tool.py convert --in <x.sf3> --out <y.sf2>
    python sf3tool.py probe   --in <x.sf3>      # 只看结构与采样数
stdout 只打 ###PROG / ###RESULT；诊断走 stderr。
"""
import argparse
import io
import json
import struct
import sys

SAMPLE_HDR = 46          # shdr 记录长度（20 名称 + 5×u32 + u8 + i8 + u16 + u16）
COMPRESSED_BIT = 0x10    # sf3 的压缩标记位


def _iter_chunks(data, pos, end):
    while pos + 8 <= end:
        cid = data[pos:pos + 4]
        sz = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        yield cid, pos + 8, sz
        pos += 8 + sz + (sz & 1)


def _find_list(data, root_off, root_sz, want):
    """在 LIST 块里找子块，返回 [(cid, body_off, size)]。"""
    out = []
    for cid, off, sz in _iter_chunks(data, root_off + 4, root_off + root_sz):
        out.append((cid, off, sz))
    return out


def parse_sf3(data):
    """解析 RIFF/sfbk → (info_chunks, smpl_bytes, pdta_chunks, shdr_records)。
    shdr_records: [(name, start, end, start_loop, end_loop, rate, pitch, corr, link, type)]"""
    if data[:4] != b'RIFF' or data[8:12] != b'sfbk':
        raise ValueError('不是 SF2/SF3 文件（缺少 RIFF/sfbk 头）')
    info_chunks, smpl, pdta_chunks, shdr = [], None, [], None
    pos, end = 12, len(data) - 8
    for cid, off, sz in _iter_chunks(data, 12, len(data)):
        if cid == b'LIST':
            lst = data[off:off + 4]
            if lst == b'INFO':
                for c2, o2, s2 in _iter_chunks(data, off + 4, off + sz):
                    info_chunks.append((c2, data[o2:o2 + s2]))
            elif lst == b'sdta':
                for c2, o2, s2 in _iter_chunks(data, off + 4, off + sz):
                    if c2 == b'smpl':
                        smpl = data[o2:o2 + s2]
                    else:  # 罕见的额外数据块原样保留
                        info_chunks.append((c2, data[o2:o2 + s2]))
            elif lst == b'pdta':
                for c2, o2, s2 in _iter_chunks(data, off + 4, off + sz):
                    if c2 == b'shdr':
                        shdr = data[o2:o2 + s2]
                    else:
                        pdta_chunks.append((c2, data[o2:o2 + s2]))
    if smpl is None:
        raise ValueError('缺少 sdta/smpl 采样数据块')
    if shdr is None:
        raise ValueError('缺少 pdta/shdr 采样头块')
    recs = []
    count = len(shdr) // SAMPLE_HDR
    for i in range(count):
        o = i * SAMPLE_HDR
        name = shdr[o:o + 20].split(b'\x00')[0].decode('latin1', 'replace')
        st, en, sl, el, rate = struct.unpack('<IIIII', shdr[o + 20:o + 40])
        pit, corr = struct.unpack('<Bb', shdr[o + 40:o + 42])
        link, typ = struct.unpack('<HH', shdr[o + 42:o + 46])
        recs.append([name, st, en, sl, el, rate, pit, corr, link, typ])
    return info_chunks, smpl, pdta_chunks, recs


def convert(src, dst, on_progress=None):
    """SF3 → SF2。返回结果 dict（成功/统计/告警）。"""
    import soundfile as sf
    import numpy as np

    with io.open(src, 'rb') as f:
        data = f.read()
    info_chunks, ogg, pdta_chunks, recs = parse_sf3(data)

    real = [r for r in recs if r[0] or r[1] or r[2]]   # 末尾全零终结记录除外
    compressed = sum(1 for r in real if r[9] & COMPRESSED_BIT)
    stats = {'samples': len(real), 'compressed': compressed,
             'decoded': 0, 'failed': 0, 'warnings': []}

    new_smpl = bytearray()
    new_recs = []
    total = len(real)
    for i, r in enumerate(real):
        name, st, en, sl, el, rate, pit, corr, link, typ = r
        new_start = len(new_smpl) // 2                   # 采样帧索引（16-bit mono）
        pcm = None
        if typ & COMPRESSED_BIT:
            blob = ogg[st:en]
            try:
                pcm, sr = sf.read(io.BytesIO(blob), dtype='int16', always_2d=False)
                if pcm.ndim != 1:
                    pcm = pcm[:, 0]                       # SF2 采样恒为 mono
                if sr != rate:
                    stats['warnings'].append(
                        '采样 %s 解码率 %d 与声明 %d 不一致，按解码率写入' % (name, sr, rate))
                    rate = sr
                stats['decoded'] += 1
            except Exception as e:                      # noqa: BLE001 —— 单个采样坏了不拖垮整体
                stats['failed'] += 1
                stats['warnings'].append('采样 %s 解码失败（保留为静音）：%s' % (name, e))
                pcm = np.zeros(0, dtype=np.int16)
        else:                                             # 已经是 PCM（混合文件）
            pcm = np.frombuffer(ogg[st:en], dtype='<i2').copy()
            stats['decoded'] += 1
        new_smpl.extend(pcm.astype('<i2').tobytes())
        new_end = len(new_smpl) // 2 - 1                  # SF2 的 dwEnd 是「最后一帧」索引
        new_recs.append([name, new_start, new_end,
                         new_start + sl, new_start + el,
                         rate, pit, corr, link, typ & (~COMPRESSED_BIT) & 0xFFFF])
        if on_progress and (i % 32 == 0 or i == total - 1):
            on_progress({'pct': int(i * 100 / max(1, total - 1))})

    # ---- 重新装配 RIFF ----
    def chunk(cid, body):
        return cid + struct.pack('<I', len(body)) + body + (b'\x00' if len(body) & 1 else b'')

    def list_chunk(lid, body):
        return chunk(b'LIST', lid + body)

    info_body = b''.join(chunk(c, b) for c, b in info_chunks)
    smpl_body = chunk(b'smpl', bytes(new_smpl))   # sdta 里是完整的 smpl 子块（带 id+size 头）
    shdr_body = bytearray()
    for r in new_recs + [['', 0, 0, 0, 0, 0, 0, 0, 0, 0]]:
        nm = r[0].encode('latin1', 'replace')[:20]
        nm = nm + b'\x00' * (20 - len(nm))
        shdr_body += nm + struct.pack('<IIIII', r[1], r[2], r[3], r[4], r[5])
        shdr_body += struct.pack('<BbHH', r[6], r[7], r[8], r[9])
    pdta_body = b''.join(chunk(c, b) for c, b in pdta_chunks) + chunk(b'shdr', bytes(shdr_body))
    riff = b'sfbk' + list_chunk(b'INFO', info_body) + list_chunk(b'sdta', smpl_body) \
        + list_chunk(b'pdta', pdta_body)
    with io.open(dst, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', len(riff)) + riff)
    stats['out_size'] = len(riff) + 8
    return stats


def main(argv=None):
    ap = argparse.ArgumentParser(prog='sf3tool.py')
    sub = ap.add_subparsers(dest='cmd', required=True)
    p_conv = sub.add_parser('convert', help='SF3 → SF2（解 Ogg 采样为 PCM16）')
    p_conv.add_argument('--in', dest='src', required=True)
    p_conv.add_argument('--out', dest='dst', required=True)
    p_probe = sub.add_parser('probe', help='只看结构与采样数，不写文件')
    p_probe.add_argument('--in', dest='src', required=True)
    args = ap.parse_args(argv)

    def emit(obj):
        sys.stdout.write('###RESULT ' + json.dumps(obj, ensure_ascii=False) + '\n')
        sys.stdout.flush()

    try:
        if args.cmd == 'probe':
            with io.open(args.src, 'rb') as f:
                data = f.read()
            _, ogg, _, recs = parse_sf3(data)
            real = [r for r in recs if r[0] or r[1] or r[2]]
            emit({'ok': True, 'samples': len(real),
                  'compressed': sum(1 for r in real if r[9] & COMPRESSED_BIT),
                  'size': len(data)})
        else:
            def prog(p):
                sys.stdout.write('###PROG ' + json.dumps(p) + '\n')
                sys.stdout.flush()
            stats = convert(args.src, args.dst, on_progress=prog)
            stats['ok'] = True
            emit(stats)
    except Exception as e:                                 # noqa: BLE001
        emit({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
