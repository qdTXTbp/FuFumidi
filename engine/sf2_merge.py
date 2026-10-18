
# -*- coding: utf-8 -*-
"""把多个本地 SoundFont 合并成一个「GM 全覆盖 + 音域最宽 + 预设最多」的 SF2（allvoice）。

用途：变谱转出来的总谱要试听，单一通用音色库总有几件乐器不像；这个工具在每个 GM
Program 上从所有候选音色库里挑**音域覆盖最宽**的 preset，合成的包 GM 兼容、覆盖广。

命令行：
    python sf2_merge.py merge --in a.sf2 --in b.sf2 --out allvoice.sf2 [--max-mb 450]
    python sf2_merge.py probe --in allvoice.sf2

实现要点（SF2 二进制结构）：
  * 只读 header（pdta/shdr）做选优；选中的 preset 再按需从源文件里读它的采样字节。
  * 合并时必须重映射：pgen 的 instrument(41) → 新 inst 下标；igen 的 sampleID(53) → 新采样下标；
    shdr 的 start/end/loop 改成新偏移。modulator 不写（fluidsynth 用默认 modulator）。
  * 立体声 link 一律清零（合并包里按 mono 处理，避免跨库指向错采样）。
"""
import argparse
import io
import json
import os
import struct
import sys

SHDR = 46
PHDR = 38
INST = 22


def _chunks(data, pos, end):
    while pos + 8 <= end:
        cid = data[pos:pos + 4]
        sz = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        yield cid, pos + 8, sz
        pos += 8 + sz + (sz & 1)


def _seek_chunks(f, pos, end):
    while pos + 8 <= end:
        f.seek(pos)
        hdr = f.read(8)
        if len(hdr) < 8:
            break
        cid = hdr[:4]
        sz = struct.unpack('<I', hdr[4:8])[0]
        yield cid, pos + 8, sz
        pos += 8 + sz + (sz & 1)


def read_headers(path):
    """只读 SF2 的结构头（pdta / INFO），**不读 smpl 数据本体** —— 大音色库也吃得下。"""
    f = open(path, 'rb')
    try:
        head = f.read(12)
        if head[:4] != b'RIFF' or head[8:12] != b'sfbk':
            raise ValueError('不是 SF2 文件：' + path)
        riff_end = 8 + struct.unpack('<I', head[4:8])[0]
        info, pdta, smpl_off, smpl_sz = [], {}, 0, 0
        for cid, off, sz in _seek_chunks(f, 12, riff_end):
            if cid != b'LIST':
                continue
            f.seek(off)
            kind = f.read(4)
            if kind == b'INFO':
                for c2, o2, s2 in _seek_chunks(f, off + 4, off + sz):
                    f.seek(o2)
                    info.append((c2, f.read(s2)))
            elif kind == b'sdta':
                for c2, o2, s2 in _seek_chunks(f, off + 4, off + sz):
                    if c2 == b'smpl':
                        smpl_off, smpl_sz = o2, s2
            elif kind == b'pdta':
                for c2, o2, s2 in _seek_chunks(f, off + 4, off + sz):
                    f.seek(o2)
                    pdta[c2] = f.read(s2)
        size = os.path.getsize(path)
    finally:
        f.close()
    shdr = pdta.get(b'shdr')
    recs = []
    for i in range(len(shdr) // SHDR):
        o = i * SHDR
        nm = shdr[o:o + 20].split(b'\x00')[0].decode('latin1', 'replace')
        st, en, sl, el, rate = struct.unpack('<IIIII', shdr[o + 20:o + 40])
        pit, corr = struct.unpack('<Bb', shdr[o + 40:o + 42])
        link, typ = struct.unpack('<HH', shdr[o + 42:o + 46])
        recs.append([nm, st, en, sl, el, rate, pit, corr, link, typ])
    if recs and not (recs[-1][0] or recs[-1][1] or recs[-1][2]):
        recs.pop()
    phdr = []
    raw = pdta.get(b'phdr', b'')
    for i in range(len(raw) // PHDR):
        o = i * PHDR
        nm = raw[o:o + 20].split(b'\x00')[0].decode('latin1', 'replace')
        pre, bank, bag = struct.unpack('<HHH', raw[o + 20:o + 26])
        phdr.append([nm, pre, bank, bag])
    if phdr and not phdr[-1][0] and phdr[-1][3] >= len(pdta.get(b'pbag', b'')) // 4 - 1:
        phdr.pop()
    pbag = [struct.unpack('<HH', pdta[b'pbag'][i:i + 4]) for i in range(0, len(pdta.get(b'pbag', b'')) // 4 * 4, 4)]
    pgen = [struct.unpack('<HH', pdta[b'pgen'][i:i + 4]) for i in range(0, len(pdta.get(b'pgen', b'')) // 4 * 4, 4)]
    inst = []
    raw = pdta.get(b'inst', b'')
    for i in range(len(raw) // INST):
        o = i * INST
        nm = raw[o:o + 20].split(b'\x00')[0].decode('latin1', 'replace')
        bag = struct.unpack('<H', raw[o + 20:o + 22])[0]
        inst.append([nm, bag])
    if inst and not inst[-1][0] and inst[-1][1] >= len(pdta.get(b'ibag', b'')) // 4 - 1:
        inst.pop()
    # ibag 与 pbag 一样是 4 字节记录 (wGenNdx, wModNdx)——按 2 字节读会把索引值读错，
    # 进而把「发生器数」估算成百万级（实测 MuseScore_General 因此几乎所有 preset 被预算守卫拒掉）
    ibag = [struct.unpack('<HH', pdta[b'ibag'][i:i + 4])
            for i in range(0, len(pdta.get(b'ibag', b'')) // 4 * 4, 4)]
    # ibag 终止记录的 gen 索引 = 终止 igen 记录的下标 = len(igen)//4 - 1（不是 len(igen)//4）
    if ibag and ibag[-1][0] >= len(pdta.get(b'igen', b'')) // 4 - 1:
        ibag.pop()
    igen = [struct.unpack('<HH', pdta[b'igen'][i:i + 4]) for i in range(0, len(pdta.get(b'igen', b'')) // 4 * 4, 4)]
    # 调制器（pmod / imod）：10 字节记录，末尾一条全零终止记录。合并时必须**原样搬过去**，
    # 否则 ToH 这类 XG 库的力度→滤波/泛音等调制全部丢失（"真实自然"直接打折扣）。
    # 记录里只有来源/目标标识（不是采样/乐器下标），所以按 zone 切片逐条复制即可。
    MOD = 10

    def _mods(name):
        raw = pdta.get(name, b'')
        recs = [raw[i:i + MOD] for i in range(0, len(raw) // MOD * MOD, MOD)]
        if recs and recs[-1] == b'\x00' * MOD:
            recs.pop()                                  # 终止记录：写盘时自己补
        return recs

    pmod = _mods(b'pmod')
    imod = _mods(b'imod')
    return {'path': path, 'size': size, 'info': info, 'smpl_off': smpl_off,
            'smpl_sz': smpl_sz, 'shdr': recs, 'phdr': phdr, 'pbag': pbag, 'pgen': pgen,
            'inst': inst, 'ibag': ibag, 'igen': igen, 'pmod': pmod, 'imod': imod}


def _zone_gens(recs, bags, start, end):
    return recs[bags[start][0]:bags[end][0]] if start < end else []


def preset_zones(h, pi):
    """preset 第 pi 个 → [(gens, inst_idx)]"""
    ph = h['phdr']
    start = ph[pi][3]
    end = ph[pi + 1][3] if pi + 1 < len(ph) else len(h['pbag']) - 1
    out = []
    for z in range(start, end):
        gens = _zone_gens(h['pgen'], h['pbag'], z, z + 1)
        inst_idx = None
        for op, amt in gens:
            if op == 41:
                inst_idx = amt
        out.append((gens, inst_idx))
    return out


def inst_zone_range(h, ii):
    """instrument 第 ii 个 → (zone 起点, 终点)。ibag 的终止记录在 read_headers 里已摘掉，
    所以最后一个 instrument 的终点就是 len(ibag)。"""
    zi = h['inst'][ii][1]
    ze = h['inst'][ii + 1][1] if ii + 1 < len(h['inst']) else len(h['ibag'])
    return zi, min(ze, len(h['ibag']))


def inst_zone_gen_range(h, z):
    """instrument 第 z 个 zone 的 igen 区间 [a, b)。最后一个 zone 的终点 = 终止 igen 下标。"""
    a = h['ibag'][z][0]
    b = h['ibag'][z + 1][0] if z + 1 < len(h['ibag']) else len(h['igen']) - 1
    return a, b


def inst_zone_mod_range(h, z):
    """instrument 第 z 个 zone 的 imod 区间 [a, b)。终止记录已摘，最后一个到 imod 末尾。"""
    a = h['ibag'][z][1]
    b = h['ibag'][z + 1][1] if z + 1 < len(h['ibag']) else len(h.get('imod') or [])
    return a, b


def coverage(h, pi):
    """preset 的音域覆盖宽度（所有 zone keyRange 的并集近似 = 各 zone 宽度和的上限）。"""
    lo, hi, nz = 127, 0, 0
    for gens, ii in preset_zones(h, pi):
        if ii is None or ii >= len(h['inst']):
            continue
        nz += 1
        zi, ze = inst_zone_range(h, ii)
        for z in range(zi, ze):
            a, b = inst_zone_gen_range(h, z)
            for op, amt in h['igen'][a:b]:
                if op == 43:
                    k0, k1 = amt & 0xFF, (amt >> 8) & 0xFF
                    lo, hi = min(lo, k0), max(hi, k1)
    if nz == 0:
        return 0                                    # 没有乐器 zone = 坏/空预设，不能算"覆盖最宽"
    if lo > hi:
        return 128                                  # 有 zone 但没写 keyRange：按默认全音域算
    return hi - lo + 1


def merge(files, out_path, max_mb=450, base=None):
    heads = []
    for p in files:
        try:
            h = read_headers(p)
            h['presets'] = preset_zones
            heads.append(h)
            print('  read %-40s presets=%-4d samples=%-5d' % (os.path.basename(p), len(h['phdr']), len(h['shdr'])))
        except Exception as e:                       # noqa: BLE001
            print('  skip %-40s %s' % (os.path.basename(p), e))
    # ★ 2026-10-18b：**基底库**（--base）。用户指定 ToH 为基底后：
    #   · 基底库的**全部预设**优先原样收进来（含 XG/GS 扩展 bank —— 音色数量最大化）；
    #   · 其它库只用来填「基底没有的 (bank,program) 槽位」，按音域/采样层次/体积排序补；
    #   · 基底优先所以预算先给基底，剩余才给补充，不会再出现"选了一堆奇怪音色"。
    base_si = None
    if base:
        want = os.path.normcase(os.path.abspath(base))
        for i, h in enumerate(heads):
            if os.path.normcase(os.path.abspath(h['path'])) == want:
                base_si = i
                break
        if base_si is None:
            raise ValueError('--base 不在 --in 列表里：' + base)
    # 选优：每个 (bank, program) 排候选（音域覆盖最宽优先、体积小的优先），
    # 再在总预算内贪心 —— 预算不够时退而取次优（宁可音域窄一点，也不要缺整个音色）。
    def preset_bytes(h, pi):
        seen, total = set(), 0
        for gens, ii in preset_zones(h, pi):
            if ii is None or ii >= len(h['inst']):
                continue
            zi, ze = inst_zone_range(h, ii)
            for z in range(zi, ze):
                a, b = inst_zone_gen_range(h, z)
            for op, amt in h['igen'][a:b]:
                    if op == 53 and amt < len(h['shdr']) and amt not in seen:
                        seen.add(amt)
                        nm, st, en = h['shdr'][amt][:3]
                        total += max(1, en - st + 1) * 2
        return total

    def preset_samples(h, pi):
        seen = set()
        for gens, ii in preset_zones(h, pi):
            if ii is None or ii >= len(h['inst']):
                continue
            zi, ze = inst_zone_range(h, ii)
            for z in range(zi, ze):
                a, b = inst_zone_gen_range(h, z)
            for op, amt in h['igen'][a:b]:
                    if op == 53 and amt < len(h['shdr']):
                        seen.add(amt)
        return len(seen)

    def preset_gens(h, pi):
        n = 0
        for gens, ii in preset_zones(h, pi):
            if ii is None or ii >= len(h['inst']):
                continue
            zi, ze = inst_zone_range(h, ii)
            for z in range(zi, ze):
                a, b = inst_zone_gen_range(h, z)
                n += max(1, b - a)
        return n

    best = {}
    for si, h in enumerate(heads):
        for pi, ph in enumerate(h['phdr']):
            key = (ph[2], ph[1])                    # (bank, program)
            try:
                cov = coverage(h, pi)
                nby = preset_bytes(h, pi)
                gens = preset_gens(h, pi)
            except Exception:                       # noqa: BLE001
                continue
            if cov <= 0 or gens <= 0:               # 空预设（只有 global zone）：不要
                continue
            best.setdefault(key, []).append({'si': si, 'pi': pi, 'key': key, 'cov': cov,
                                              'bytes': nby, 'gens': gens,
                                              'ns': preset_samples(h, pi)})
    # ★ SF2 的 ibag/igen 下标是 u16（单个库最多 65535 个发生器）：bank/program 用 0..127，
    #   鼓组用 bank128；其它 bank 的预设也收（音色数量最大化），但同样受发生器/体积上限约束。
    if base_si is None:
        for key in list(best):
            if not ((key[0] == 0 and 0 <= key[1] <= 127) or (key[0] == 128 and key[1] == 0)):
                del best[key]
    else:
        for key in list(best):
            if not ((0 <= key[0] <= 128) and (0 <= key[1] <= 127)):
                del best[key]
    # 排序：音域覆盖宽 > 采样层次多（多力度/多音区 = 音色更真实）> 发生器少 > 体积小。
    # 预算/额度不够时循环会退到下一个候选，所以排序不会导致"整件乐器缺失"。
    for key in best:
        best[key].sort(key=lambda c: (-c['cov'], -c['ns'], c['gens'], c['bytes']))
    print('  candidates: %d presets across %d sources → %d (bank,program) slots' % (
        sum(len(h['phdr']) for h in heads), len(heads), len(best)))

    # ---- 选择顺序（groups：每个槽位一组候选，按顺序贪心）----
    groups = []
    base_n = 0
    if base_si is None:
        groups = [best[key] for key in sorted(best, key=lambda k: (k[0], k[1]))]
    else:
        h = heads[base_si]
        base_gm, base_other, used_keys = [], [], set()
        for pi in range(len(h['phdr'])):
            key = (h['phdr'][pi][2], h['phdr'][pi][1])
            try:
                cov = coverage(h, pi)
                nby = preset_bytes(h, pi)
                gens = preset_gens(h, pi)
                ns = preset_samples(h, pi)
            except Exception:                       # noqa: BLE001
                continue
            if cov <= 0 or gens <= 0:               # 空预设（只有 global zone）不要
                continue
            c = {'si': base_si, 'pi': pi, 'key': key, 'cov': cov, 'bytes': nby,
                 'gens': gens, 'ns': ns}
            is_gm = (key[0] == 0 and 0 <= key[1] <= 127) or (key[0] == 128 and key[1] == 0)
            (base_gm if is_gm else base_other).append(c)
            used_keys.add(key)
        base_gm.sort(key=lambda c: (c['key'][0], c['key'][1]))
        base_other.sort(key=lambda c: (c['key'][0], c['key'][1]))
        groups = [[c] for c in base_gm + base_other]
        base_n = len(groups)
        # 空闲槽位：其它库按质量排序补充（受发生器 u16 / 体积预算约束）
        free = [k for k in best if k not in used_keys]
        free.sort(key=lambda k: (-best[k][0]['cov'], -best[k][0]['ns'],
                                 best[k][0]['gens'], best[k][0]['bytes']))
        groups += [best[k] for k in free]
        print('  base: %s —— %d 个预设優先（GM %d + 扩展 bank %d），空闲槽位 %d 组候选' % (
            os.path.basename(h['path']), base_n, len(base_gm), len(base_other), len(free)))

    cap = max_mb * 1024 * 1024
    out_smpl = bytearray()
    new_shdr, new_inst, new_ibag, new_igen = [], [], [], []
    new_phdr, new_pbag, new_pgen = [], [], []
    new_pmod, new_imod = [], []                     # 调制器记录（10B/条，原样搬）
    inst_map = {}                                    # (si, local inst) → new inst idx
    smpl_map = {}                                    # (si, local sample) → new sample idx
    handles = {}

    def src_read(si, off, n):
        if si not in handles:
            handles[si] = open(heads[si]['path'], 'rb')
        f = handles[si]
        f.seek(heads[si]['smpl_off'] + off)
        return f.read(n)

    def add_sample(si, sidx):
        key = (si, sidx)
        if key in smpl_map:
            return smpl_map[key]
        h = heads[si]
        nm, st, en, sl, el, rate, pit, corr, link, typ = h['shdr'][sidx]
        n = max(1, en - st + 1)
        if len(out_smpl) + n * 2 > cap:
            return None
        base = len(out_smpl) // 2
        out_smpl.extend(src_read(si, st * 2, n * 2))
        nidx = len(new_shdr)
        new_shdr.append([nm, base, base + n - 1,
                         base + max(0, sl - st), base + clamp(el - st, 0, n - 1),
                         rate, pit, corr, 0, typ & ~0x10 & ~0x02])
        smpl_map[key] = nidx
        return nidx

    def add_inst(si, ii):
        key = (si, ii)
        if key in inst_map:
            return inst_map[key]
        h = heads[si]
        nidx = len(new_inst)
        new_inst.append([h['inst'][ii][0], len(new_ibag)])
        inst_map[key] = nidx
        iz, end = inst_zone_range(h, ii)
        for z in range(iz, end):
            # 每个 zone 的调制器区间 = ibag 的 mod 下标区间；最后一条 zone 到 imod 末尾
            m0, m1 = inst_zone_mod_range(h, z)
            a, b = inst_zone_gen_range(h, z)
            new_ibag.append([len(new_igen), len(new_imod)])
            new_imod.extend(h.get('imod', [])[m0:m1])
            for op, amt in h['igen'][a:b]:
                if op == 53:
                    nsi = add_sample(si, amt)
                    if nsi is None:
                        continue
                    amt = nsi
                new_igen.append([op, amt])
        return nidx

    preset_gens_est = preset_gens

    used = 0
    skipped = 0
    for group in groups:
        key = group[0].get('key')
        picked = None
        for c in group:
            # SF2 的 ibag/igen 下标是 u16：发生器总数不能超过 65535，否则写不出去
            if len(new_igen) + preset_gens_est(heads[c['si']], c['pi']) > 58000:
                continue
            if len(out_smpl) + c['bytes'] <= cap:
                picked = c
                break
        if picked is None:
            skipped += 1
            print('  budget: skip bank%d program%d' % key)
            continue
        si, pi = picked['si'], picked['pi']
        h = heads[si]
        before = len(out_smpl)
        bag_start = len(new_pbag)
        ok = True
        zone0 = int(h['phdr'][pi][3])
        for zi, (gens, ii) in enumerate(preset_zones(h, pi)):
            if ii is None:
                # 预设级 global zone（MuseScore_General 每个 preset 开头都有一条，
                # 只有 16/48 之类的整体参数、没有 instrument(-41)）：合并时不必复现，跳过
                continue
            nii = add_inst(si, ii)
            z = zone0 + zi
            m0 = h['pbag'][z][1]
            m1 = h['pbag'][z + 1][1] if z + 1 < len(h['pbag']) else len(h.get('pmod') or [])
            new_pbag.append([len(new_pgen), len(new_pmod)])
            new_pmod.extend(h.get('pmod', [])[m0:m1])
            for op, amt in gens:
                if op == 41:
                    amt = nii
                new_pgen.append([op, amt])
        if not ok or len(new_pbag) == bag_start:
            continue
        new_phdr.append([h['phdr'][pi][0], key[1], key[0], bag_start])
        used += 1

    def pack_name(nm):
        b = nm.encode('latin1', 'replace')[:20]
        return b + b'\x00' * (20 - len(b))

    def ch(cid, body):
        return cid + struct.pack('<I', len(body)) + body + (b'\x00' if len(body) & 1 else b'')

    phdr_b = b''.join(pack_name(r[0]) + struct.pack('<HHHIII', r[1], r[2], r[3], 0, 0, 0) for r in new_phdr)
    phdr_b += pack_name('') + struct.pack('<HHHIII', 0, 0, len(new_pbag), 0, 0, 0)
    pbag_b = b''.join(struct.pack('<HH', g, m) for g, m in new_pbag) + struct.pack('<HH', len(new_pgen), len(new_pmod))
    pgen_b = b''.join(struct.pack('<HH', op, amt) for op, amt in new_pgen) + struct.pack('<HH', 0, 0)
    inst_b = b''.join(pack_name(r[0]) + struct.pack('<H', r[1]) for r in new_inst)
    inst_b += pack_name('') + struct.pack('<H', len(new_ibag))
    ibag_b = b''.join(struct.pack('<HH', g, m) for g, m in new_ibag) + struct.pack('<HH', len(new_igen), len(new_imod))
    igen_b = b''.join(struct.pack('<HH', op, amt) for op, amt in new_igen) + struct.pack('<HH', 0, 0)
    shdr_b = bytearray()
    for r in new_shdr + [['', 0, 0, 0, 0, 0, 0, 0, 0, 0]]:
        shdr_b += pack_name(r[0]) + struct.pack('<IIIII', r[1], r[2], r[3], r[4], r[5])
        shdr_b += struct.pack('<BbHH', r[6], r[7], r[8], r[9])
    info = heads[0]['info'] if heads else []
    info_body = b''.join(ch(c2, b) for c2, b in info if c2 not in (b'INAM', b'ISFT'))
    info_body += ch(b'INAM', b'FuFumidi allvoice GM\n\x00')
    info_body += ch(b'ISFT', b'FuFumidi sf2_merge\n\x00')
    # pdta 子块顺序是格式契约，pmod/imod 不能省，且它们的位置与直觉不同：
    #   phdr, pbag, **pmod**, pgen, inst, ibag, **imod**, igen, shdr
    # FluidSynth 的 process_pdta() 就是按这个顺序逐个 pdtahelper 校验的 ——
    # 缺 pmod 或把 pmod 放到 pgen 之后就报 "Expected PDTA sub-chunk 'pmod' found invalid id
    # instead" 并整包拒载（实测：205MB 的包 loadSFont 直接失败）。
    # 空调制器 = 一条全零终止记录。
    mod_term = b'\x00' * 10
    pdta_body = (ch(b'phdr', phdr_b) + ch(b'pbag', pbag_b)
                 + ch(b'pmod', b''.join(new_pmod) + mod_term)
                 + ch(b'pgen', pgen_b)
                 + ch(b'inst', inst_b) + ch(b'ibag', ibag_b)
                 + ch(b'imod', b''.join(new_imod) + mod_term)
                 + ch(b'igen', igen_b)
                 + ch(b'shdr', bytes(shdr_b)))
    riff = (b'sfbk' + ch(b'LIST', b'INFO' + ch(b'INAM', b'')[:0] + b'')[:0])  # placeholder
    riff = (b'sfbk' + ch(b'LIST', b'INFO' + info_body)
            + ch(b'LIST', b'sdta' + ch(b'smpl', bytes(out_smpl)))
            + ch(b'LIST', b'pdta' + pdta_body))
    with open(out_path, 'wb') as f:
        f.write(b'RIFF' + struct.pack('<I', len(riff)) + riff)
    print('  wrote %s  %.1f MB  presets=%d  samples=%d  调制器=%d  (bank,program)=%d' % (
        out_path, (len(riff) + 8) / 1048576.0, len(new_phdr), len(new_shdr),
        len(new_pmod) + len(new_imod), used))
    return {'ok': True, 'out': out_path, 'size': len(riff) + 8,
            'presets': len(new_phdr), 'samples': len(new_shdr), 'slots': used,
            'basePresets': base_n, 'modulators': len(new_pmod) + len(new_imod),
            'skipped': skipped}


def clamp(v, a, b):
    return a if v < a else (b if v > b else v)


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['merge', 'probe'])
    ap.add_argument('--in', dest='inputs', action='append', default=[])
    ap.add_argument('--out', default='')
    ap.add_argument('--max-mb', type=float, default=450)
    ap.add_argument('--base', default='', help='基底库路径（该库的全部预设优先收进来）')
    args = ap.parse_args(argv)

    def emit(o):
        sys.stdout.write('###RESULT ' + json.dumps(o, ensure_ascii=False) + '\n')
        sys.stdout.flush()

    try:
        if args.cmd == 'probe':
            h = read_headers(args.inputs[0])
            emit({'ok': True, 'path': args.inputs[0], 'size': h['size'],
                  'presets': len(h['phdr']), 'samples': len(h['shdr'])})
        else:
            res = merge(args.inputs, args.out, args.max_mb, base=args.base or None)
            emit(res)
    except Exception as e:                            # noqa: BLE001
        import traceback
        traceback.print_exc()
        emit({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)})
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
