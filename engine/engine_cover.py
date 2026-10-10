# -*- coding: utf-8 -*-
"""翻唱工作流（一键）：一首歌 → 分离 → 变声 → 混音 → 成品。

    python engine_cover.py all <歌曲> --outdir <输出目录> --svc-model <模型 id> [选项]

分工：
  engine_svc.py   变声（导入的 SVC 模型把原唱人声换成目标音色）
  cover_mix.py    干声 + 伴奏 → 成品（原曲能量比配平 + 吐字 EQ + 后期链）
  本文件          串起来 + 进度协议（###PROG）+ 结果协议（###RESULT）

★ 扒谱与歌词环节已整段删除：SVC 是「把原唱的人声换成另一个音色」，旋律、节奏、咬字
  本来就来自原唱，不需要知道歌词也不需要音符表（cover_notes.py 仍在，调教/扒谱自己用）。
★ 旧的 GPT-SoVITS 逐句参考重合成与「DiffSinger 声库接 RVC」两条通道已删除。

子命令（便于分步调试 / 前端分步显示）：
  analyze  只做分离，产出 vocals/instrumental
  convert  只做「原唱人声 → 目标音色干声」
  mix      只做「干声 + 伴奏 → 成品」
  all      全流程
"""
import argparse
import json
import os
import subprocess
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)


def emit_prog(percent, stage='', extra=None):
    d = {'percent': round(float(percent), 1)}
    if stage:
        d['stage'] = stage
    if extra:
        d.update(extra)
    sys.stdout.write('###PROG ' + json.dumps(d, ensure_ascii=False) + chr(10))
    sys.stdout.flush()


def emit_result(obj):
    sys.stdout.write('###RESULT ' + json.dumps(obj, ensure_ascii=False) + chr(10))
    sys.stdout.flush()


def _sig(obj):
    """把任何 JSON 可序列化的东西压成一个短指纹（用于「这步的结果还能用吗」）。"""
    import hashlib
    raw = json.dumps(obj, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode('utf-8')).hexdigest()[:16]


def _file_sig(path):
    """文件的 (名字, 大小, mtime_ns) —— 拿不到就 None（当作「不知道」，签名会变）。"""
    try:
        st = os.stat(path)
        return [os.path.basename(path), int(st.st_size), int(st.st_mtime_ns)]
    except OSError:
        return None


def _model_sig(model_dir):
    """模型指纹：模型目录下所有权重/index 的 (相对路径, 大小, mtime)。

    ★ 换模型 / 重下权重都必须让变声缓存失效，否则会拿旧音色的结果。
    """
    if not model_dir or not os.path.isdir(model_dir):
        return None
    items = []
    for root, _dirs, files in os.walk(model_dir):
        for f in sorted(files):
            if f.lower().endswith(('.pth', '.pt', '.index', '.ckpt', '.onnx')):
                fp = os.path.join(root, f)
                items.append(_file_sig(fp) + [os.path.relpath(fp, model_dir)])
    items.sort()
    return _sig(items)


def _read_meta(path):
    """读旁边那份 `.meta.json`；坏了就当作没有（宁可重算，不许用错结果）。"""
    try:
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_meta(path, obj):
    try:
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(obj, f, ensure_ascii=False, indent=1)
    except OSError:
        pass


def load_state(outdir):
    return _read_meta(os.path.join(outdir, 'state.json'))


def save_state(outdir, obj):
    obj = dict(obj)
    obj['updated'] = time.strftime('%Y-%m-%d %H:%M:%S')
    _write_meta(os.path.join(outdir, 'state.json'), obj)


def default_sep_model():
    """默认分离模型：Models 里的 inst/vox duality v2（配置在 msst_configs）。"""
    root = os.environ.get('FUFUMIDI_MODELS_DIR') or ''
    name = 'melband_roformer_instvox_duality_v2'
    model = os.path.join(root, 'vocal', name, name + '.ckpt')
    cfg = os.path.join(_HERE, 'msst_configs', 'config_melbandroformer_instvoc_duality.yaml')
    if os.path.isfile(model) and os.path.isfile(cfg):
        return model, cfg, 'Mel-Band Roformer'
    return '', '', ''


def cuda_free_gb():
    """(可用?, 说明)：GPU 被别的进程占满时，不要让分离/变声死在那儿（实测会静默退出）。"""
    try:
        import torch
        if not torch.cuda.is_available():
            return False, 'CUDA 不可用'
        free, _total = torch.cuda.mem_get_info()
        gb = free / (1024 ** 3)
        if gb < 3.0:
            return False, '空闲显存仅 %.1fGB' % gb
        return True, '空闲显存 %.1fGB' % gb
    except Exception as e:            # noqa: BLE001
        return False, str(e)[:60]


def do_separate(audio, outdir, model='', config='', arch='', use_tta=False, batch_size=1,
                log=print, device='auto'):
    """分离：**走与「音频处理」面板同一个引擎入口**（music2midi.py separate），不另写一套。

    · 参数由调用方（主进程 main/separate-common.js）传入；只有 CLI 单跑才用默认模型兜底。
    · GPU 失败 → 自动换 CPU 重跑（必须新进程 + CUDA_VISIBLE_DEVICES='' 才真生效）。
    """
    sep_dir = os.path.join(outdir, 'sep')
    os.makedirs(sep_dir, exist_ok=True)
    if not model:
        model, config, arch = default_sep_model()
        if model:
            log('未指定分离模型 → 用默认 duality 模型')
    if not model:
        raise RuntimeError('找不到分离模型（可显式传 --sep-model/--sep-config/--sep-arch）')

    ok_gpu, why = cuda_free_gb()
    if device == 'auto':
        device = 'cuda' if ok_gpu else 'cpu'
        log('分离设备：%s（%s）' % (device, why))
    elif device == 'cuda' and not ok_gpu:
        log('指定 GPU 但%s → 改用 CPU' % why)
        device = 'cpu'

    args = [sys.executable, os.path.join(_HERE, 'music2midi.py'), 'separate', audio,
            '--output', sep_dir, '--model', model, '--arch', arch or '',
            '--format', 'wav', '--normalize', '--batch-size', str(int(batch_size or 1))]
    if config:
        args += ['--config', config]
    if use_tta:
        args.append('--tta')

    def _run(dev):
        env = dict(os.environ)
        if dev == 'cpu':
            env['CUDA_VISIBLE_DEVICES'] = ''
        env.setdefault('PYTHONUNBUFFERED', '1')
        p = subprocess.Popen(args, cwd=_HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             text=True, encoding='utf-8', errors='ignore', env=env)
        out_lines = []
        for line in p.stdout:
            out_lines.append(line.rstrip())
            if line.startswith('###PROG'):
                try:
                    v = json.loads(line[7:])
                    emit_prog(2 + float(v.get('percent') or 0) * 0.16, '分离')
                except Exception:     # noqa: BLE001
                    pass
            elif log and line.strip():
                log('  ' + line.rstrip()[:160])
        p.wait()
        return p.returncode, out_lines

    t0 = time.time()
    code, lines_out = _run(device)
    if code != 0 and device != 'cpu':
        log('分离在 GPU 上失败（退出码 %s）→ 回退 CPU 重跑' % code)
        emit_prog(2, '分离（CPU 回退）')
        code, lines_out = _run('cpu')
        device = 'cpu'
    if code != 0:
        raise RuntimeError('分离失败（退出码 %s）：%s' % (code, (lines_out[-1] if lines_out else '')[:200]))
    base = os.path.splitext(os.path.basename(audio))[0]
    voc = os.path.join(sep_dir, base + '_Vocals.wav')
    inst = os.path.join(sep_dir, base + '_Instrumental.wav')
    if not (os.path.isfile(voc) and os.path.isfile(inst)):
        cand = [os.path.join(sep_dir, f) for f in os.listdir(sep_dir)]
        voc = next((c for c in cand if 'vocal' in os.path.basename(c).lower()), voc)
        inst = next((c for c in cand if 'vocal' not in os.path.basename(c).lower()), inst)
    log('分离完成 %.1fs（%s）' % (time.time() - t0, device))
    return voc, inst, device


def resolve_svc_model(model_id):
    """模型 id → (模型目录, 清单)。

    两种落点（见 main/svc.js）：
      · <模型目录>/svc/<id>/model.json  —— zip / 逐个文件导入（文件在应用目录里）
      · <模型目录>/svc/index.json       —— 文件夹导入（**引用式**，dir 指向用户自己的目录）
    """
    root = os.environ.get('FUFUMIDI_MODELS_DIR') or ''
    base = os.path.join(root, 'svc')
    d = os.path.join(base, str(model_id))
    mf = os.path.join(d, 'model.json')
    if os.path.isfile(mf):
        try:
            with open(mf, encoding='utf-8') as f:
                return d, json.load(f)
        except (OSError, ValueError):
            pass
    idx = _read_meta(os.path.join(base, 'index.json'))
    m = (idx.get('models') or {}).get(model_id)
    if m and m.get('dir'):
        return m['dir'], m
    raise RuntimeError('找不到翻唱模型「%s」（已导入的模型在 %s）' % (model_id, base))


def do_svc(voc, outdir, model_id, device='auto', log=print, resume=True, params=None):
    """原唱人声 → 目标音色干声（engine_svc.py convert）。

    ★ 变声是整首最慢的一步（长歌几十分钟），所以同样写 `*.meta.json` 签名：
      模型指纹 + 人声轨 + 全部参数都没变就直接用上次的干声。
    """
    p = params or {}
    model_dir, manifest = resolve_svc_model(model_id)
    sdir = os.path.join(outdir, 'svc')
    os.makedirs(sdir, exist_ok=True)
    dry = os.path.join(sdir, 'dry.wav')
    meta = os.path.join(sdir, 'dry.meta.json')
    sig = _sig({'model': _model_sig(model_dir), 'voc': _file_sig(voc), 'params': p})
    if resume and os.path.isfile(dry) and _read_meta(meta).get('sig') == sig:
        log('变声：复用已有干声（模型与人声轨、参数都没变）')
        emit_prog(60, '变声', {'reused': True})
        return dry, {'reused': True, 'model': manifest.get('name') or model_id}
    cmd = [sys.executable, os.path.join(_HERE, 'engine_svc.py'), 'convert', voc,
           '--model', model_dir, '--out', dry,
           '--transpose', str(int(p.get('transpose') or 0)),
           '--f0-method', str(p.get('f0_method') or 'rmvpe'),
           '--index-rate', str(float(p.get('index_rate') if p.get('index_rate') is not None else 0.3)),
           '--rms-mix-rate', str(float(p.get('rms_mix_rate') if p.get('rms_mix_rate') is not None else 0.25)),
           '--protect', str(float(p.get('protect') if p.get('protect') is not None else 0.33)),
           '--chunk-sec', str(float(p.get('chunk_sec') or 60)),
           '--device', device]
    if p.get('auto_predict_f0'):
        cmd.append('--auto-predict-f0')
    log('变声：%s（%s）' % (manifest.get('name') or model_id, manifest.get('engine') or 'rvc'))
    res = {}
    tail = []
    proc = subprocess.Popen(cmd, cwd=_HERE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, encoding='utf-8', errors='ignore')
    for line in proc.stdout:
        if line.startswith('###PROG'):
            try:
                v = json.loads(line[7:])
                emit_prog(20 + float(v.get('percent') or 0) * 0.65, '变声',
                          {'part': v.get('parts') and (v.get('part') or 1), 'parts': v.get('parts')})
            except Exception:         # noqa: BLE001
                pass
        elif line.startswith('###RESULT'):
            try:
                res = json.loads(line[9:])
            except Exception:         # noqa: BLE001
                pass
        elif line.strip():
            tail.append(line.rstrip()[:200])
            log('  ' + line.rstrip()[:200])
    proc.wait()
    if not (res.get('ok') and os.path.isfile(dry)):
        why = str(res.get('error') or ('进程退出码 %s' % proc.returncode))
        if tail:
            why += '｜' + tail[-1]
        raise RuntimeError('变声失败：%s' % why[:400])
    _write_meta(meta, {'sig': sig, 'model': model_id, 'params': p, 'wav': _file_sig(dry)})
    for w in res.get('warnings') or []:
        log('  ⚠ ' + str(w))
    return dry, res


def write_readme(outdir, name, info):
    p = os.path.join(outdir, '说明.md')
    rows = [
        ('原曲', info.get('source', '')),
        ('时长', '%s 秒' % info.get('seconds', '')),
        ('音色（模型）', info.get('singer', '')),
        ('引擎', info.get('engine', '')),
        ('变调', '%s 半音' % info.get('transpose', 0)),
        ('f0 算法', info.get('f0_method', '')),
        ('index 检索', info.get('index_rate', '')),
        ('原曲 人声/伴奏 能量比', info.get('orig_vocal_over_inst', '')),
        ('成品配平', '%s dB（其中清晰度 %s dB）' % (info.get('level_match_db', ''), info.get('clarity_boost_db', ''))),
        ('辅音区 2.5-6k 占比', '变声后 %s / 原唱 %s' % (info.get('share_syn', ''), info.get('share_orig', ''))),
    ]
    txt = ['# %s · 翻唱工作流产出' % name, '', '| 项 | 值 |', '| --- | --- |']
    txt += ['| %s | %s |' % r for r in rows]
    txt += ['', '## 文件', '',
            '- %s.wav —— 成品（变声人声 + 分离伴奏）' % name,
            '- %s_干声.wav —— 变声后的人声（未混伴奏）' % name,
            '- sep/ —— 分离出的人声轨与伴奏轨',
            '- svc/ —— 变声的中间产物', '',
            '> 由 FuFumidi 翻唱工作流自动生成。',
            '> 模型为社区开源权重（CC-BY-NC-4.0）：禁止商用，须署名训练者。']
    open(p, 'w', encoding='utf-8').write(chr(10).join(txt))
    return p


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    for nm in ('analyze', 'convert', 'mix', 'all'):
        s = sub.add_parser(nm)
        s.add_argument('audio', nargs='?' if nm != 'all' else None)
        s.add_argument('--outdir', required=True)
        s.add_argument('--svc-model', default='', help='导入的翻唱模型 id（见 <模型目录>/svc）')
        s.add_argument('--name', default='')
        s.add_argument('--device', default='cuda')
        s.add_argument('--sep-model', default='')
        s.add_argument('--sep-config', default='')
        s.add_argument('--sep-arch', default='')
        s.add_argument('--tta', action='store_true')
        s.add_argument('--clarity-db', type=float, default=2.0)
        s.add_argument('--vocals', default='', help='已分离好的人声轨（给了就跳过分离）')
        s.add_argument('--instrumental', default='', help='已分离好的伴奏轨（给了就跳过分离）')
        s.add_argument('--no-resume', dest='resume', action='store_false',
                       help='不复用上次的中间结果（分离 / 变声全部重算）')
        s.set_defaults(resume=True)
        # ---- SVC 参数（界面「常用 + 高级」直接映射过来，界面不自己实现 DSP）
        s.add_argument('--transpose', type=int, default=0)
        s.add_argument('--f0-method', default='rmvpe')
        s.add_argument('--index-rate', type=float, default=0.3)
        s.add_argument('--rms-mix-rate', type=float, default=0.25)
        s.add_argument('--protect', type=float, default=0.33)
        s.add_argument('--chunk-sec', type=float, default=60)
        s.add_argument('--auto-predict-f0', dest='auto_predict_f0', action='store_true')
        s.set_defaults(auto_predict_f0=False)
    a = ap.parse_args()
    outdir = os.path.abspath(a.outdir)
    os.makedirs(outdir, exist_ok=True)
    name = a.name or os.path.splitext(os.path.basename(a.audio or 'cover'))[0]
    info = {'source': os.path.basename(a.audio or '')}
    t_all = time.time()
    log_ = print
    try:
        sep_dir = os.path.join(outdir, 'sep')
        voc = os.path.join(sep_dir, 'src_Vocals.wav')
        inst = os.path.join(sep_dir, 'src_Instrumental.wav')
        prev_state = load_state(outdir) if a.resume else {}
        if prev_state.get('stage'):
            log_('输出目录里已有上次的状态：stage=%s（--no-resume 可全部重算）' % prev_state['stage'])
        # ① 直接复用调用方给的分离结果（音频处理面板刚导出的音轨 / 之前跑过的结果）
        if a.vocals and a.instrumental and os.path.isfile(a.vocals) and os.path.isfile(a.instrumental):
            voc, inst = a.vocals, a.instrumental
            info['separate'] = '复用已有分离结果（跳过分离）'
            log_('复用已有分离结果，跳过分离')
        elif a.cmd in ('analyze', 'all') and not (os.path.isfile(voc) and os.path.isfile(inst)):
            src = a.audio
            if not src:
                emit_result({'ok': False, 'error': '缺少输入音频'})
                return 1
            import shutil
            work = os.path.join(outdir, 'src' + (os.path.splitext(src)[1] or '.wav'))
            if os.path.abspath(src) != os.path.abspath(work):
                shutil.copyfile(src, work)
            voc, inst, used_dev = do_separate(work, outdir, a.sep_model, a.sep_config, a.sep_arch,
                                              a.tta, device=a.device)
            info['separate'] = '已分离（%s）' % used_dev
        elif os.path.isfile(voc) and os.path.isfile(inst):
            info['separate'] = '复用本次输出目录里已有的分离结果'
        if a.cmd == 'analyze':
            emit_result({'ok': True, 'stage': 'analyze', 'vocals': voc, 'instrumental': inst, 'info': info})
            return 0

        params = {'transpose': a.transpose, 'f0_method': a.f0_method, 'index_rate': a.index_rate,
                  'rms_mix_rate': a.rms_mix_rate,
                  'protect': a.protect, 'chunk_sec': a.chunk_sec, 'auto_predict_f0': a.auto_predict_f0}
        if a.cmd in ('convert', 'all'):
            if not a.svc_model:
                emit_result({'ok': False, 'error': '缺少翻唱模型（--svc-model）：先在模型管理里导入一个'})
                return 1
            emit_prog(20, '变声')
            dry, sres = do_svc(voc, outdir, a.svc_model, device=a.device, log=log_,
                               resume=a.resume, params=params)
            _model_dir, manifest = resolve_svc_model(a.svc_model)
            info.update({'singer': manifest.get('name') or a.svc_model,
                         'engine': manifest.get('engine') or 'rvc',
                         'transpose': a.transpose, 'f0_method': a.f0_method,
                         'index_rate': a.index_rate, 'svc_reused': bool(sres.get('reused'))})
            save_state(outdir, {'stage': 'convert', 'dry': dry, 'info': info})
            if a.cmd == 'convert':
                emit_result({'ok': True, 'stage': 'convert', 'dry': dry, 'info': info})
                return 0
        else:
            dry = os.path.join(outdir, 'svc', 'dry.wav')
            if not os.path.isfile(dry):
                emit_result({'ok': False, 'error': '没有变声结果：先跑 convert（或 all）'})
                return 1

        emit_prog(88, '混音')
        out_wav = os.path.join(outdir, name + '.wav')
        import soundfile as sf
        import cover_mix as CM
        seconds = float(sf.info(dry).duration or 0)
        # ★ 整轨变声：整条干声都是「演唱区」（没有音符表，不能按句开窗）——
        #   混音里的句间静音闸因此等效关闭，配平按整轨能量算。
        stats = CM.mix_song([dry], inst, voc, out_wav, [(0.0, seconds)],
                            vocal_boost_db=a.clarity_db)
        try:
            so, ss = CM.band_shares(voc), CM.band_shares(stats['dry'])
            info['share_orig'] = '%.3f/%.3f/%.3f' % tuple(so)
            info['share_syn'] = '%.3f/%.3f/%.3f' % tuple(ss)
        except Exception:
            pass
        info.update({'seconds': stats['seconds'], 'orig_vocal_over_inst': stats['orig_vocal_over_inst'],
                     'level_match_db': stats['level_match_db'], 'clarity_boost_db': stats['clarity_boost_db']})
        readme = write_readme(outdir, name, info)
        save_state(outdir, {'stage': 'done', 'info': info, 'out': out_wav,
                            'dry': stats['dry'], 'readme': readme})
        emit_prog(100, '完成')
        emit_result({'ok': True, 'stage': 'all', 'out': out_wav, 'dry': stats['dry'], 'readme': readme,
                     'elapsed_s': round(time.time() - t_all, 1), 'info': info})
        return 0
    except Exception as e:
        emit_result({'ok': False, 'error': str(e)})
        return 1


if __name__ == '__main__':
    sys.exit(main())
