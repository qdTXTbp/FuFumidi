# -*- coding: utf-8 -*-
"""SF2 子集工具：把一个过大的 SoundFont 裁成"能被本应用真正加载"的大小。

背景（为什么要这个工具）
------------------------
FuFumidi 的合成器是 js-synthesizer + libfluidsynth 的 **wasm** 构建，堆上限被
emscripten 写死成 2 GiB（vendor 的 glue 里 getHeapMax() 返回 2147483648）。
Salamander Grand Piano 的 SF2 是 1.18 GB；载入时还要在 wasm 里再放一份 MEMFS 副本
+ FluidSynth 解码后的采样，必然爆堆 —— 所以它在应用里**结构上不可用**，
不是"上限设小了"。

做法：保留全部 30 个采样键（覆盖 88 键音域），但**按力度层抽样**，并把被丢掉的
力度区间合并给相邻的保留层，保证 1..127 每个力度都还有声音（不会出现某段力度没声）。
保留的采样仍是原始 48 kHz / 16 bit，音色数据一个字节没动。

用法:
  python scripts/sf2-subset.py in.sf2 out.sf2 --keep 0,2,4,6,8,10,12,14
  python scripts/sf2-subset.py in.sf2 out.sf2 --keep-even 8

输出汇报：保留/丢弃的层、采样数、输出体积。
"""
import argparse
import mmap
import struct

def _chunk(cid, payload):
    pad = b'\x00' if (len(payload) & 1) else b''
    return cid + struct.pack('<I', len(payload)) + bytes(payload) + pad


def _list_chunk(kind, subs):
    return _chunk(b'LIST', kind + b''.join(subs))


GEN_KEYRANGE = 43
GEN_VELRANGE = 44
GEN_SAMPLEID = 53
GEN_END = 0


def read_chunks(buf, off, end):
    out = []
    while off + 8 <= end:
        cid = buf[off:off + 4]
        size = struct.unpack_from('<I', buf, off + 4)[0]
        out.append((cid, off + 8, size))
        off += 8 + size + (size & 1)
    return out


def find_chunk(chunks, name):
    for cid, off, size in chunks:
        if cid == name:
            return off, size
    return None, None


def load_sf2(path):
    f = open(path, 'rb')
    mm = mmap.mmap(f.fileno(), 0, access=mmap.ACCESS_READ)
    if mm[0:4] != b'RIFF' or mm[8:12] != b'sfbk':
        raise SystemExit('not an SF2 (missing RIFF/sfbk)')
    riff_size = struct.unpack_from('<I', mm, 4)[0]
    top = read_chunks(mm, 12, 8 + riff_size)
    info_chunk = sdta = pdta = None
    for cid, off, size in top:
        if cid == b'LIST':
            kind = mm[off:off + 4]
            sub = read_chunks(mm, off + 4, off + size)
            if kind == b'INFO':
                info_chunk = (off, size)
            elif kind == b'sdta':
                sdta = sub
            elif kind == b'pdta':
                pdta = sub
    if not sdta or not pdta:
        raise SystemExit('missing sdta/pdta')
    return f, mm, info_chunk, sdta, pdta


def parse(mm, sdta, pdta):
    smpl_off, smpl_size = find_chunk(sdta, b'smpl')
    shdr_off, shdr_size = find_chunk(pdta, b'shdr')
    phdr_off, phdr_size = find_chunk(pdta, b'phdr')
    pbag_off, pbag_size = find_chunk(pdta, b'pbag')
    pmod_off, pmod_size = find_chunk(pdta, b'pmod')
    pgen_off, pgen_size = find_chunk(pdta, b'pgen')
    inst_off, inst_size = find_chunk(pdta, b'inst')
    ibag_off, ibag_size = find_chunk(pdta, b'ibag')
    imod_off, imod_size = find_chunk(pdta, b'imod')
    igen_off, igen_size = find_chunk(pdta, b'igen')

    nsamp = shdr_size // 46 - 1
    samples = []
    for i in range(nsamp):
        o = shdr_off + i * 46
        name = mm[o:o + 20].split(b'\x00')[0].decode('latin1', 'replace')
        st, en, sl, el, rate = struct.unpack_from('<IIIII', mm, o + 20)
        orig = mm[o + 40]
        corr = struct.unpack_from('<b', mm, o + 41)[0]
        link, typ = struct.unpack_from('<HH', mm, o + 42)
        samples.append(dict(name=name, st=st, en=en, sl=sl, el=el, rate=rate,
                            orig=orig, corr=corr, link=link, typ=typ))

    ninst = inst_size // 22 - 1
    insts = []
    for i in range(ninst):
        o = inst_off + i * 22
        nm = mm[o:o + 20].split(b'\x00')[0].decode('latin1', 'replace')
        bag = struct.unpack_from('<H', mm, o + 20)[0]
        insts.append(dict(name=nm, bag=bag))

    nbag = ibag_size // 4 - 1
    bags = [struct.unpack_from('<H', mm, ibag_off + i * 4)[0] for i in range(nbag + 1)]
    ngens = igen_size // 4
    gens = [struct.unpack_from('<HH', mm, igen_off + i * 4) for i in range(ngens)]
    mods = [mm[imod_off + i * 10: imod_off + i * 10 + 10] for i in range(imod_size // 10)]

    raw_chunks = {}
    for nm, off, size in ((b'phdr', phdr_off, phdr_size), (b'pbag', pbag_off, pbag_size),
                          (b'pmod', pmod_off, pmod_size), (b'pgen', pgen_off, pgen_size),
                          (b'imod', imod_off, imod_size)):
        raw_chunks[nm] = mm[off:off + size]

    return dict(smpl_off=smpl_off, smpl_size=smpl_size, samples=samples, insts=insts,
                bags=bags, gens=gens, mods=mods, raw_chunks=raw_chunks, nbag=nbag)


def zones_of(meta, inst_idx):
    start = meta['insts'][inst_idx]['bag']
    end = (meta['insts'][inst_idx + 1]['bag']
           if inst_idx + 1 < len(meta['insts']) else meta['nbag'])
    out = []
    for b in range(start, end):
        g0, g1 = meta['bags'][b], meta['bags'][b + 1]
        z = {'gens': meta['gens'][g0:g1], 'bag': b}
        for op, val in z['gens']:
            if op == GEN_KEYRANGE:
                z['key'] = (val & 0xFF, val >> 8)
            elif op == GEN_VELRANGE:
                z['vel'] = (val & 0xFF, val >> 8)
            elif op == GEN_SAMPLEID:
                z['sample'] = val
        out.append(z)
    return out


def build_subset(mm, meta, keep, out_path):
    all_zones = []
    for i in range(len(meta['insts'])):
        all_zones.extend(zones_of(meta, i))
    total = len(all_zones)
    keys = sorted({z['key'] for z in all_zones if 'key' in z})
    per_key = total // max(1, len(keys))
    pair = 2 if per_key % 16 == 0 else 1
    nlayers = per_key // pair
    print('zones=%d keys=%d per_key=%d layers=%d channels=%d' % (total, len(keys), per_key, nlayers, pair))

    keep = sorted(set(int(x) for x in keep if 0 <= int(x) < nlayers))
    if not keep:
        raise SystemExit('keep list is empty')
    print('keep layers:', keep)

    groups = {}
    for idx, z in enumerate(all_zones):
        gkey = (z.get('key', (0, 127)), idx % pair)
        groups.setdefault(gkey, []).append((idx % per_key) // pair)

    vel_final = {}
    for gkey, layers in groups.items():
        bands = {}
        for l in layers:
            idx = None
            for i, z in enumerate(all_zones):
                if (z.get('key', (0, 127)), i % pair) == gkey and (i % per_key) // pair == l:
                    idx = i
                    break
            bands[l] = all_zones[idx].get('vel', (0, 127))
        for l in layers:
            if l in keep:
                vel_final[(gkey[0], gkey[1], l)] = bands[l]
                continue
            best = min(keep, key=lambda k: (abs(k - l), k))
            cur = vel_final.get((gkey[0], gkey[1], best), bands[best])
            lo, hi = bands[l]
            vel_final[(gkey[0], gkey[1], best)] = (min(cur[0], lo), max(cur[1], hi))

    kept_zones = []
    old2new = {}
    kept_samples = []
    for idx, z in enumerate(all_zones):
        gkey = (z.get('key', (0, 127)), idx % pair)
        layer = (idx % per_key) // pair
        if layer not in keep:
            continue
        sid = z['sample']
        if sid not in old2new:
            old2new[sid] = len(kept_samples)
            kept_samples.append(sid)
        vr = vel_final[(gkey[0], gkey[1], layer)]
        newgens = []
        for op, val in z['gens']:
            if op == GEN_VELRANGE:
                newgens.append((op, (vr[0] & 0xFF) | ((vr[1] & 0xFF) << 8)))
            elif op == GEN_SAMPLEID:
                newgens.append((op, old2new[sid]))
            elif op == GEN_END:
                continue
            else:
                newgens.append((op, val))
        kept_zones.append({'gens': newgens, 'sample': old2new[sid], 'key': z.get('key'), 'layer': layer, 'vel': vr})
    print('kept zones=%d samples=%d' % (len(kept_zones), len(kept_samples)))

    pcm = bytearray()
    new_shdr = []
    src = meta['samples']
    # ★ shdr 的 start/end 是**相对 smpl 数据块**的字节偏移，不是文件偏移。
    #   直接拿它当文件偏移去读，会把 RIFF 头当成第一个采样（曾经的 bug）。
    base_off = meta['smpl_off']
    for newid, sid in enumerate(kept_samples):
        s = src[sid]
        # ★★ shdr 的 start/end/loop 都是 **16 bit 字** 的偏移（不是字节）：
        #    原始文件里 shdr 的最大 end=633,195,534 字 × 2 = 1,266,391,068 ≈ smpl 块大小。
        #    早先按字节读，等于只取了半个采样，还把 RIFF 头当成第一个采样。
        span = mm[base_off + s['st'] * 2:base_off + s['en'] * 2]
        base_w = len(pcm) // 2          # 以「字」为单位的起点
        pcm += span
        if len(pcm) & 1:
            pcm += b'\x00'
        end_w = len(pcm) // 2
        n_words = end_w - base_w
        rel_sl = max(0, min(n_words, s['sl'] - s['st']))
        rel_el = max(0, min(n_words, s['el'] - s['st']))
        if rel_el <= rel_sl:
            rel_el = n_words
        rec = struct.pack('<20sIIIII', s['name'].encode('latin1')[:19], base_w, end_w,
                          base_w + rel_sl, base_w + rel_el, s['rate'])
        rec += struct.pack('<BbHH', s['orig'], s['corr'], s['link'], s['typ'])
        assert len(rec) == 46
        new_shdr.append(rec)

    igen_out = bytearray()
    ibag_out = bytearray()
    gcount = 0
    for z in kept_zones:
        # ★ ibag 记录是 4 字节：wInstGenNdx + wInstModNdx（音素级调制器下标）。
        #   早先只写了 2 字节，整块 pdta 会错位，FluidSynth 直接拒载。
        ibag_out += struct.pack('<HH', gcount, 0)
        for op, val in z['gens']:
            igen_out += struct.pack('<HH', op, val)
            gcount += 1
    ibag_out += struct.pack('<HH', gcount, 0)
    igen_out += struct.pack('<HH', 0, 0)
    print('igen=%d ibag=%d' % (gcount + 1, len(kept_zones) + 1))

    # ★ inst 记录 22 字节：achInstName[20] + wInstBagNdx（调制器下标在 ibag 里，不在 inst）。
    inst_out = bytearray()
    cursor = 0
    for ins in meta['insts']:
        inst_out += struct.pack('<20sH', ins['name'].encode('latin1')[:19], cursor)
        cursor += len(kept_zones)
    inst_out += struct.pack('<20sH', b'EOI', len(kept_zones))

    chunk = _chunk
    list_chunk = _list_chunk

    # ★ meta['info'] 记的是 LIST 的**载荷**（开头就是 'INFO' 这个 fourcc），
    #   所以这里要剥掉那 4 字节再交给 list_chunk —— 否则会套成 LIST INFO INFO ...（多 4 字节，整包非法）。
    info_off, info_size = meta['info']
    info_payload = mm[info_off:info_off + info_size]
    if info_payload[:4] == b'INFO':
        info_payload = info_payload[4:]
    info = _rebuild_info(info_payload)
    eos = struct.pack('<20sIIIII', b'EOS', 0, 0, 0, 0, 0) + struct.pack('<BbHH', 0, 0, 0, 0)
    pdta = list_chunk(b'pdta', [
        chunk(b'phdr', meta['raw_chunks'][b'phdr']),
        chunk(b'pbag', meta['raw_chunks'][b'pbag']),
        chunk(b'pmod', meta['raw_chunks'][b'pmod']),
        chunk(b'pgen', meta['raw_chunks'][b'pgen']),
        chunk(b'inst', inst_out),
        chunk(b'ibag', ibag_out),
        chunk(b'imod', meta['raw_chunks'][b'imod']),
        chunk(b'igen', igen_out),
        chunk(b'shdr', b''.join(new_shdr) + eos),
    ])
    sdta = list_chunk(b'sdta', [chunk(b'smpl', pcm)])

    body = info + sdta + pdta
    with open(out_path, 'wb') as f:
        f.write(b'RIFF')
        f.write(struct.pack('<I', len(body) + 4))
        f.write(b'sfbk')
        f.write(body)
    stats = dict(zones=len(kept_zones), samples=len(kept_samples), pcm=len(pcm), file=len(body) + 12)
    verify_output(out_path)
    return stats


def verify_output(path):
    """写出后自检：记录步长、下标边界、采样偏移是否落在 smpl 块内。
    这三类错误 FluidSynth 只会回一个空的错误串，必须先在这里拦住。"""
    b = open(path, 'rb').read()
    rl = struct.unpack_from('<I', b, 4)[0]
    def ch(off, end):
        out = []
        while off + 8 <= end:
            cid = b[off:off + 4].decode('latin1'); sz = struct.unpack_from('<I', b, off + 4)[0]
            out.append((cid, off + 8, sz)); off += 8 + sz + (sz & 1)
        return out
    d = {}
    for c, o, s in ch(12, 8 + rl):
        if c == 'LIST':
            for c2, o2, s2 in ch(o + 4, o + s):
                d[c2] = (o2, s2)
    for nm, stride in (('phdr', 38), ('pbag', 4), ('pmod', 10), ('pgen', 4),
                       ('inst', 22), ('ibag', 4), ('imod', 10), ('igen', 4), ('shdr', 46)):
        if nm not in d:
            raise SystemExit('SELFCHECK: missing chunk ' + nm)
        if d[nm][1] % stride:
            raise SystemExit('SELFCHECK: %s size %d not a multiple of %d' % (nm, d[nm][1], stride))
    smpl_off, smpl_size = d['smpl']
    words = smpl_size // 2
    shdr_off, shdr_size = d['shdr']
    n = shdr_size // 46 - 1
    ibag_off, ibag_size = d['ibag']
    igen_off, igen_size = d['igen']
    nb = ibag_size // 4 - 1
    ng = igen_size // 4 - 1
    bags = [struct.unpack_from('<HH', b, ibag_off + i * 4) for i in range(nb + 1)]
    if bags[0][0] != 0 or bags[-1][0] != ng:
        raise SystemExit('SELFCHECK: ibag terminal %d != igen count %d (first %d)' % (bags[-1][0], ng, bags[0][0]))
    if any(bags[i + 1][0] < bags[i][0] for i in range(len(bags) - 1)):
        raise SystemExit('SELFCHECK: ibag not monotonic')
    ids = [struct.unpack_from('<H', b, igen_off + i * 4 + 2)[0]
           for i in range(igen_size // 4)
           if struct.unpack_from('<H', b, igen_off + i * 4)[0] == GEN_SAMPLEID]
    if ids and max(ids) >= n:
        raise SystemExit('SELFCHECK: sampleID %d out of range (%d samples)' % (max(ids), n))
    prev_end = 0
    for i in range(n):
        o = shdr_off + i * 46
        st, en, sl, el, rate = struct.unpack_from('<IIIII', b, o + 20)
        if not (0 <= st < en <= words):
            raise SystemExit('SELFCHECK: sample %d range %d..%d outside smpl words %d' % (i, st, en, words))
        if st != prev_end:
            raise SystemExit('SELFCHECK: sample %d starts at %d, expected %d (gap/overlap)' % (i, st, prev_end))
        if not (st <= sl <= el <= en):
            raise SystemExit('SELFCHECK: sample %d loop %d..%d outside %d..%d' % (i, sl, el, st, en))
        if rate < 8000 or rate > 192000:
            raise SystemExit('SELFCHECK: sample %d rate %d' % (i, rate))
        prev_end = en
    print('SELFCHECK ok: samples=%d words=%d chunks=%d' % (n, words, len(d)))


def _info_subs(payload):
    off = 0
    out = []
    while off + 8 <= len(payload):
        cid = payload[off:off + 4]
        sz = struct.unpack_from('<I', payload, off + 4)[0]
        out.append((cid, payload[off + 8:off + 8 + sz]))
        off += 8 + sz + (sz & 1)
    return out


def _rebuild_info(payload):
    subs = [_chunk(cid, body) for cid, body in _info_subs(payload)]
    return _list_chunk(b'INFO', subs)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--keep', default='')
    ap.add_argument('--keep-even', type=int, default=0)
    a = ap.parse_args()
    f, mm, info_chunk, sdta, pdta = load_sf2(a.src)
    meta = parse(mm, sdta, pdta)
    meta['info'] = info_chunk
    if a.keep_even:
        n = max(1, min(16, a.keep_even))
        keep = [0] if n == 1 else sorted({int(round(i * 15 / (n - 1))) for i in range(n)})
    else:
        keep = [int(x) for x in a.keep.split(',') if x.strip() != '']
    if not keep:
        raise SystemExit('give --keep or --keep-even')
    st = build_subset(mm, meta, keep, a.dst)
    print('WROTE %s zones=%d samples=%d pcm=%.1fMB file=%.1fMB'
          % (a.dst, st['zones'], st['samples'], st['pcm'] / 1048576, st['file'] / 1048576))


if __name__ == '__main__':
    main()
