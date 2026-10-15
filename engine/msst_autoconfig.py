# -*- coding: utf-8 -*-
"""从权重本身推出分离配置（.yaml）—— 让「仓库里没带配置」的模型也能用。

为什么需要
    模型清单里 79 个模型有 21 个在 engine/msst_configs/index.json 里没有对应配置，上游镜像
    仓库里也没放（逐个查过目录，只有 .ckpt.partNN）。它们不是坏模型，只是缺一份结构描述。

两条路
    ① **从权重推结构**（mel_band_roformer / bs_roformer）：dim / depth / heads / dim_head /
       num_bands / num_stems / linear_transformer_depth / mask_estimator_depth 都能从键集合与
       张量形状读出来 → 套同族模板 → 写配置。
    ② **同族候选配置逐个试**（htdemucs / mdx23c / apollo）：这些架构的结构量不容易从权重反推，
       就拿我们已有的同族 .yaml 逐个**真装一次**，哪个装上且能前向就跑哪个。

★ 为什么验收必须真装 + 跑前向
    pymss 用 model.load_state_dict(state_dict, assign=True)，assign 会跳过形状校验（键集合仍校验）。
    所以"装上了"不等于"能用" —— 这里一律构造 + 载入 + 跑一小段前向，全过才写缓存；
    跑不过就不写、返回 None，让上层照旧明确报错，绝不假装能用。
    实测教训：dim_head 不能拿 dim // heads 推（MSST 里 inner_dim 常 ≠ dim：
    dim 384 / heads 8 / dim_head 64 → inner 512），写错会让 rotary_embed.freqs 对不上（期望 32、
    给成 24），pymss 直接 size mismatch。
"""

import os
import re

#: 架构名（models.js 的 arch 字段）→ 家族
_ARCH_TO_FAMILY = {
    'melbandroformer': 'mel_band_roformer',
    'bsroformer': 'bs_roformer',
    'htdemucs': 'htdemucs',
    'htdemucsvocals': 'htdemucs',
    'htdemucsftbass': 'htdemucs',
    'htdemucsftdrums': 'htdemucs',
    'htdemucsftother': 'htdemucs',
    'drumsep': 'htdemucs',
    'mdx23c': 'mdx23c',
    'apollo': 'apollo',
}

#: 家族 → pymss 的 model_type
_MODEL_TYPE = {
    'mel_band_roformer': 'mel_band_roformer',
    'bs_roformer': 'bs_roformer',
    'htdemucs': 'htdemucs',
    'mdx23c': 'mdx23c',
    'apollo': 'apollo',
}

#: 能从权重推结构的家族
_DERIVE = ('mel_band_roformer', 'bs_roformer')

#: 每个可推结构家族的首选模板（只提供"结构量之外"的字段）
_TEMPLATES = {
    'mel_band_roformer': ['config_melbandroformer_inst.yaml', 'config_vocals_mel_band_roformer.yaml'],
    'bs_roformer': ['config_bsrofoL.yaml', 'model_bs_roformer_ep_317_sdr_12.9755.yaml'],
}

#: 不能推结构时，逐个试同族的现成配置
_CANDIDATES = {
    'htdemucs': ['config_musdb18_htdemucs.yaml', 'config_htdemucs_6stems.yaml', 'config_vocals_htdemucs.yaml'],
    'mdx23c': ['config_musdb18_mdx23c.yaml', 'config_vocals_mdx23c.yaml',
               'aufr33-jarredou_DrumSep_model_mdx23c_ep_141_sdr_10.8059.yaml'],
    'apollo': ['config_apollo.yaml'],
}

#: 上层（main/separate-common.js 的 archSelfConfigurable）认可的自配置架构集合，保持同一份
SELF_CONFIGURABLE_FAMILIES = tuple(_MODEL_TYPE.keys())


def family_for_arch(arch):
    key = ''.join(ch for ch in str(arch or '').lower() if ch.isalnum())
    return _ARCH_TO_FAMILY.get(key)


def _log(cb, msg):
    if cb:
        try:
            cb(msg)
        except Exception:
            pass


def _load_state_dict(model_path):
    import torch
    try:
        obj = torch.load(model_path, map_location='cpu', weights_only=False)
    except TypeError:
        obj = torch.load(model_path, map_location='cpu')
    if isinstance(obj, dict) and 'state_dict' in obj and isinstance(obj['state_dict'], dict):
        obj = obj['state_dict']
    if not isinstance(obj, dict):
        raise RuntimeError('权重格式无法识别（不是 state_dict）')
    return obj


def analyze(sd):
    """从 state_dict 推结构量（只支持 roformer 两族）；推不出来返回 None。"""
    keys = [str(k) for k in sd.keys()]

    def shape(k):
        return tuple(getattr(sd[k], 'shape', ()))

    family = None
    if any(k.startswith('mask_estimators.') for k in keys) and any(k.startswith('band_split.') for k in keys):
        family = 'mel_band_roformer'
    elif any(k.startswith('layers.') for k in keys) and any(k.endswith('to_qkv.weight') for k in keys):
        family = 'bs_roformer'
    if family is None:
        return None

    dim = heads = inner = None
    for k in keys:
        if dim is None and k.endswith('.norm.gamma'):
            dim = int(shape(k)[0])
        if heads is None and k.endswith('.to_gates.weight'):
            heads = int(shape(k)[0])
        if inner is None and k.endswith('to_qkv.weight'):
            s = shape(k)
            if len(s) == 2:
                inner = int(s[0]) // 3          # to_qkv = (3 * heads * dim_head, dim)
                if dim is None:
                    dim = int(s[1])
    if heads is None:
        heads = 8
    if not dim:
        return None
    dim_head = max(1, inner // heads) if inner else max(1, dim // heads)

    depths = set()
    for k in keys:
        p = k.split('.')
        if len(p) > 1 and p[0] == 'layers' and p[1].isdigit():
            depths.add(int(p[1]))
    depth = (max(depths) + 1) if depths else None

    # linear_transformer_depth = 每个 depth 里**第 3 个及以后**的 Transformer 数量。
    # 键长这样：layers.<depth>.<which>.layers.<inner>.*，其中 which 0/1 = 时间/频率变换器，
    # which ≥ 2 才是线性变换器（实测那份 mel-band 去噪模型只有 0/1 → 0）。
    # ★ 曾经错把 <inner> 当 which 数，得出 1 —— 那份配置照样"验证通过"（pymss 忽略了该字段），
    #   说明单靠验证通过不能反推推导正确，推导本身也得按结构写对。
    linear_depth = 0
    for k in keys:
        p = k.split('.')
        if len(p) > 2 and p[0] == 'layers' and p[1].isdigit() and p[2].isdigit():
            w = int(p[2])
            if w >= 2:
                linear_depth = max(linear_depth, w - 1)

    bands, stems, mid_depth = set(), set(), set()
    for k in keys:
        if not k.startswith('mask_estimators.'):
            continue
        p = k.split('.')
        if len(p) > 2:
            stems.add(p[1])
        if len(p) > 4 and p[2] == 'to_freqs' and p[3].isdigit():
            bands.add(int(p[3]))
            if len(p) > 6 and p[4].isdigit() and p[5].isdigit():
                mid_depth.add(int(p[5]))
    num_bands = len(bands) or None
    if not depth or not num_bands:
        return None
    return {
        'family': family, 'dim': dim, 'depth': depth, 'heads': heads, 'dim_head': dim_head,
        'num_bands': num_bands, 'num_stems': len(stems) or 1,
        'linear_transformer_depth': linear_depth,
        'mask_estimator_depth': (max(mid_depth) // 2) if mid_depth else 2,
    }


def _cache_path(model_path):
    """生成的 .yaml 落哪：优先缓存目录（安装目录/数据目录是只读区，别往里写）。"""
    root = os.environ.get('FUFUMIDI_CACHE_DIR') or ''
    if root:
        try:
            d = os.path.join(root, 'msst_autocfg')
            os.makedirs(d, exist_ok=True)
            return os.path.join(d, os.path.basename(model_path) + '.yaml')
        except Exception:
            pass
    return model_path + '.yaml'


def _norm_cfg(name):
    return re.sub(r'[^a-z0-9]+', '', str(name).lower().replace('.yaml', '').replace('.yml', ''))


def _template_path(name):
    """模板从**数据根的配置缓存**取 —— 用户 2026-10-15 的决定：配置文件不内置到工具里，
    改成模型下载时从上游拉下来（main/models.js → <数据根>/models/_configs/）。
    应用目录里那份只作旧安装的兜底（新装包里不再带 yaml）。

    ★ 还要**模糊匹配**：下面 _TEMPLATES/_CANDIDATES 里写的是我们当年的候选名
    （config_melbandroformer_inst.yaml、config_bsrofoL.yaml…），而上游叫
    config_musdb18_mel_band_roformer_all_stems.yaml 这类名字 —— 精确找不到时按规范化名字
    （去掉 config_/下划线/大小写）取包含关系最接近的那个，否则「一个都套不上」。
    """
    dirs = []
    root = os.environ.get('FUFUMIDI_DATA_ROOT') or ''
    if root:
        dirs.append(os.path.join(root, 'models', '_configs'))
    dirs.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'msst_configs'))
    for d in dirs:
        p = os.path.join(d, name)
        if os.path.isfile(p):
            return p
    want = _norm_cfg(name)
    for d in dirs:
        try:
            files = sorted(os.listdir(d))
        except Exception:
            continue
        for f in files:
            if not f.endswith(('.yaml', '.yml')):
                continue
            n = _norm_cfg(f)
            if n == want or (want and (want in n or n in want)):
                return os.path.join(d, f)
    return os.path.join(dirs[-1], name)


def _family_templates(family):
    """同族模板候选：先给写死的名字，再把**缓存里同族的**全排上。

    ★ 为什么需要：我们的候选名与上游名不一致，实测 BS-Roformer 那两个固定名字
    （config_bsrofoL.yaml / model_bs_roformer_ep_317…）在上游一个都没有 → 直接返回 None。
    同族的其它配置只要结构量由权重推导覆盖，前向校验过了就能用。
    """
    out = list(_TEMPLATES.get(family, [])) + list(_CANDIDATES.get(family, []))
    key = str(family).replace('_', '').lower()
    root = os.environ.get('FUFUMIDI_DATA_ROOT') or ''
    dirs = ([os.path.join(root, 'models', '_configs')] if root else []) + [
        os.path.join(os.path.dirname(os.path.abspath(__file__)), 'msst_configs')]
    for d in dirs:
        try:
            files = sorted(os.listdir(d))
        except Exception:
            continue
        for f in files:
            if f.endswith(('.yaml', '.yml')) and key in _norm_cfg(f) and f not in out:
                out.append(f)
    return out


def build_config(info, template_name, family=None):
    """按 info 覆盖模板的结构量，返回 (config_dict, yaml_text)。

    family 由调用方传进来（它来自 --arch / 模型目录，比从权重猜更可靠）：
    实测 BS-Roformer_LargeV1 的权重里同时有 band_split.*，analyze 会把它认成 mel_band_roformer，
    而加载器用的是 bs_roformer —— 两边不一致时该以**加载器那一侧**为准。
    """
    import yaml
    yaml.SafeLoader.add_constructor('tag:yaml.org,2002:python/tuple',
                                    lambda l, n: tuple(l.construct_sequence(n)))
    with open(_template_path(template_name), encoding='utf-8') as f:
        cfg = yaml.safe_load(f)
    m = cfg.setdefault('model', {})
    m['dim'] = info['dim']
    m['depth'] = info['depth']
    m['heads'] = info['heads']
    m['dim_head'] = info['dim_head']
    # ★ num_bands / sample_rate 只有 **mel-band** 系认；bs_roformer 的加载器见到这两个键
    #   直接抛 unexpected RoFormer config keys（实测，同一个模型用旧内置配置能跑就是这个差别）。
    fam = str(family or info.get('family') or '')
    if fam == 'bs_roformer':
        for k in ('num_bands', 'sample_rate', 'sage_attention'):
            m.pop(k, None)
    else:
        m['num_bands'] = info['num_bands']
        m.setdefault('sample_rate', 44100)
    m['num_stems'] = info['num_stems']
    m['linear_transformer_depth'] = info['linear_transformer_depth']
    m['mask_estimator_depth'] = info['mask_estimator_depth']
    m.setdefault('dim_freqs_in', (cfg.get('audio', {}) or {}).get('n_fft', 2048) // 2 + 1)
    t = cfg.setdefault('training', {})
    if info['num_stems'] <= 1:
        # 1 输出 = 模型直接给「干净的那一路」；另一路由 pymss 用 mix - clean 推出来
        t['instruments'] = ['noise', 'clean']
        t['target_instrument'] = 'clean'
    else:
        cur = list(t.get('instruments') or [])
        if len(cur) != info['num_stems']:
            cur = ['stem%d' % i for i in range(info['num_stems'])]
        t['instruments'] = cur
        t['target_instrument'] = None
    return cfg, yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False)


def _verify(model_path, cfg_path, model_type, log_cb=None):
    """真装一次 + 跑一小段前向；全过返回 True。"""
    import shutil
    import tempfile
    import numpy as np
    from pymss.separator import MSSeparator
    sr = 44100
    scratch = tempfile.mkdtemp(prefix='fufumidi-autocfg-check-')
    try:
        sep = MSSeparator(
            model_type=model_type, model_path=model_path, config_path=cfg_path,
            device='cpu', device_ids=[0], output_format='wav', use_tta=False,
            store_dirs=scratch,
            inference_params={'batch_size': 1, 'overlap_size': 0, 'chunk_size': sr, 'normalize': None},
        )
        out = sep.separate(np.zeros((2, sr), dtype='float32'), pbar=False, stems=None)
        for v in (out or {}).values():
            arr = np.asarray(v)
            if arr.size and np.isfinite(arr).all():
                return True
        return False
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def ensure_config(model_path, arch=None, log_cb=None):
    """确保 model_path 有一份**经过校验**的配置；成功返回 yaml 路径，失败返回 None。"""
    if not model_path or not os.path.isfile(model_path):
        return None
    cache = _cache_path(model_path)
    if os.path.isfile(cache):
        return cache

    family = family_for_arch(arch)
    sd = None
    if family in _DERIVE or not family:
        try:
            sd = _load_state_dict(model_path)
        except Exception as e:
            _log(log_cb, '· 读权重失败：%s' % e)
            if not family:
                return None
        if not family:
            family = (analyze(sd) or {}).get('family') if sd is not None else None
    model_type = _MODEL_TYPE.get(family)
    if not model_type:
        return None

    import tempfile
    # ① 能推结构：推出来再套模板
    if family in _DERIVE:
        info = analyze(sd) if sd is not None else None
        if not info:
            _log(log_cb, '· 权重结构推不出来，按同族模板试')
        else:
            _log(log_cb, '· 从权重推出结构：dim=%s depth=%s heads=%s dim_head=%s num_bands=%s num_stems=%s'
                 % (info['dim'], info['depth'], info['heads'], info['dim_head'], info['num_bands'], info['num_stems']))
        # ★ 家族按「模型名/目录」推出来的可能与权重实际结构不一致：实测 BS-Roformer_LargeV1
        #   的权重里带 mask_estimators.*（mel 系的结构），按 bs_roformer 装配会报 state_dict
        #   不匹配。两个候选都试，**以「前向校验通过」为准**，别赌标签。
        fams = [family]
        wfam = (info or {}).get('family')
        if wfam and wfam != family and wfam in _DERIVE:
            _log(log_cb, '· 权重看更像 %s，两个家族都试一遍' % wfam)
            fams.append(wfam)
        for fam in fams:
            mtype = _MODEL_TYPE.get(fam)
            if not mtype:
                continue
            for tpl in _family_templates(fam):
                if not os.path.isfile(_template_path(tpl)):
                    continue
                try:
                    _cfg, text = build_config(info, tpl, fam)
                except Exception as e:
                    _log(log_cb, '· 套模板 %s 失败：%s' % (tpl, str(e)[:120]))
                    continue
                if _try_accept(text, model_path, mtype, cache, '%s(%s)' % (tpl, fam), log_cb):
                    return cache
        return None

    # ② 推不了结构：拿同族现成配置逐个真装
    for tpl in _family_templates(family):
        src = _template_path(tpl)
        if not os.path.isfile(src):
            continue
        try:
            with open(src, encoding='utf-8') as f:
                text = f.read()
        except Exception:
            continue
        if _try_accept(text, model_path, model_type, cache, tpl, log_cb):
            return cache
    return None


def _try_accept(text, model_path, model_type, cache, tag, log_cb):
    """写临时 yaml → 校验 → 通过就写正式缓存。"""
    import tempfile
    fd, tmp = tempfile.mkstemp(suffix='.yaml', prefix='fufumidi-auto-')
    os.close(fd)
    try:
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(text)
        if not _verify(model_path, tmp, model_type, log_cb):
            _log(log_cb, '· %s：前向校验没过' % tag)
            return False
        with open(cache, 'w', encoding='utf-8') as f:
            f.write(text)
        _log(log_cb, '· %s 通过前向校验 → 已缓存自动配置' % tag)
        return True
    except Exception as e:
        _log(log_cb, '· %s：%s' % (tag, str(e).strip().replace(chr(10), ' ')[:180]))
        return False
    finally:
        try:
            os.remove(tmp)
        except Exception:
            pass


if __name__ == '__main__':
    import sys
    p = sys.argv[1]
    a = sys.argv[2] if len(sys.argv) > 2 else None
    r = ensure_config(p, a, log_cb=lambda m: print(m, flush=True))
    print('RESULT', r)
