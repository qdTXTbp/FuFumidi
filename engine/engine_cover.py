# -*- coding: utf-8 -*-
"""翻唱工作流（一键）：一首歌 → 分离 → 扒谱 → 合成 → 混音 → 成品。

    python engine_cover.py all <歌曲> --outdir <输出目录> --voicebank <声库目录> [选项]

分工：
  cover_notes.py  人声轨 → 带歌词的音符表（pyin + onset + 音节规则）
  cover_mix.py    干声 + 伴奏 → 成品（原曲能量比配平 + 吐字 EQ + 后期链）
  本文件          串起来 + 进度协议（###PROG）+ 结果协议（###RESULT）

子命令（便于分步调试 / 前端分步显示）：
  analyze  只做「分离 + 扒谱」，产出 vocals/instrumental/notes.json
  render   只做「音符 → 干声」（长曲自动分段，规避引擎在超多音符时的一次性渲染问题）
  mix      只做「干声 + 伴奏 → 成品」
  all      全流程

歌词来源（--lyrics）：
  auto（默认）→ 同目录同名 .lrc → 音频内嵌 LRC 标签（FLAC/ID3）→ 都没有则哼哼模式（每个音符唱 "la"）
  也可以 --lyrics 指定一个 .lrc/.txt 文件
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


def _lrc_from_flac(path):
    """FLAC Vorbis comment 里的 LYRICS/UNSYNCEDLYRICS 标签。"""
    try:
        with open(path, 'rb') as f:
            if f.read(4) != b'fLaC':
                return ''
            while True:
                head = f.read(4)
                if len(head) < 4:
                    return ''
                last, btype = head[0] & 0x80, head[0] & 0x7f
                size = int.from_bytes(head[1:4], 'big')
                body = f.read(size)
                if btype == 4:
                    vlen = int.from_bytes(body[0:4], 'little')
                    q = 4 + vlen
                    count = int.from_bytes(body[q:q + 4], 'little')
                    q += 4
                    for _ in range(count):
                        ln = int.from_bytes(body[q:q + 4], 'little')
                        q += 4
                        kv = body[q:q + ln].decode('utf-8', 'ignore')
                        q += ln
                        k, _, v = kv.partition('=')
                        if k.upper() in ('LYRICS', 'UNSYNCEDLYRICS', 'LYRIC'):
                            return v
                if last:
                    return ''
    except OSError:
        return ''


def _lrc_from_id3(path):
    """MP3 的 USLT 帧。"""
    try:
        from mutagen.id3 import ID3
        tags = ID3(path)
        for k in tags:
            if k.startswith('USLT'):
                return str(tags[k].text)
    except Exception:
        pass
    return ''


def find_lyrics(audio, explicit):
    from cover_notes import parse_lrc, read_lyrics_file
    if explicit and explicit != 'auto':
        return read_lyrics_file(explicit), os.path.basename(explicit)
    base = os.path.splitext(audio)[0]
    for cand in (base + '.lrc', base + '.LRC'):
        if os.path.isfile(cand):
            return read_lyrics_file(cand), os.path.basename(cand)
    raw = _lrc_from_flac(audio) or _lrc_from_id3(audio)
    if raw:
        timed = parse_lrc(raw)
        if timed:
            return timed, '音频内嵌歌词'
        lines = [l.strip() for l in raw.splitlines() if l.strip()]
        if lines:
            return [(float(i) * 4.0, l) for i, l in enumerate(lines)], '音频内嵌歌词（无时间轴）'
    return [], ''


def default_sep_model():
    """默认分离模型：Models 里的 inst/vox duality v2（配置在 msst_configs）。"""
    root = os.environ.get('FUFUMIDI_MODELS_DIR') or ''
    name = 'melband_roformer_instvox_duality_v2'
    model = os.path.join(root, 'vocal', name, name + '.ckpt')
    cfg = os.path.join(_HERE, 'msst_configs', 'config_melbandroformer_instvoc_duality.yaml')
    if os.path.isfile(model) and os.path.isfile(cfg):
        return model, cfg, 'Mel-Band Roformer'
    return '', '', ''


def do_separate(audio, outdir, model='', config='', arch='', use_tta=False, batch_size=1, log=print):
    import engine_msst
    sep_dir = os.path.join(outdir, 'sep')
    os.makedirs(sep_dir, exist_ok=True)
    if not model:
        model, config, arch = default_sep_model()
    if not model:
        raise RuntimeError('找不到分离模型（可显式传 --sep-model/--sep-config/--sep-arch）')
    params = {'model_path': model, 'config_path': config or None, 'arch': arch,
              'output_format': 'wav', 'normalize': True, 'use_tta': bool(use_tta),
              'batch_size': int(batch_size or 1)}
    t0 = time.time()
    outputs = engine_msst.separate(audio, sep_dir, params,
                                   log_cb=lambda m: log('  ' + str(m)),
                                   progress_cb=lambda p: emit_prog(2 + float(p) * 0.13, '分离'))
    log('分离完成 %.1fs：%s' % (time.time() - t0, ', '.join(os.path.basename(o) for o in outputs)))
    voc = next((o for o in outputs if 'vocal' in os.path.basename(o).lower()), '')
    inst = next((o for o in outputs if 'vocal' not in os.path.basename(o).lower()), '')
    return voc, inst


def do_notes(vocal_wav, outdir, lyrics, lang='zh', bpm=0.0, inst_wav='', log=print):
    import numpy as np
    import cover_notes as CN
    if not bpm:
        try:
            import librosa
            import soundfile as sf
            y, sr = sf.read(inst_wav or vocal_wav, always_2d=True)
            m = y.mean(axis=1).astype('float32')
            if sr != 22050:
                m = librosa.resample(m, orig_sr=sr, target_sr=22050)
            tempo, _ = librosa.beat.beat_track(y=m, sr=22050, hop_length=512)
            bpm = float(np.atleast_1d(tempo)[0]) or 120.0
        except Exception:
            bpm = 120.0
    dict_path = ''
    vb = os.environ.get('FUFUMIDI_COVER_VOICEBANK') or ''
    if vb:
        for cand in ('dictionary-zh.txt', os.path.join('dsdur', 'dictionary-zh.txt')):
            p = os.path.join(vb, cand)
            if os.path.isfile(p):
                dict_path = p
                break
    if not lyrics:
        notes, _ = CN.extract_notes(vocal_wav, [(0.0, 'la')], bpm, lang=lang, dict_path=dict_path, log=log)
        notes = [dict(n, lyric='la') for n in notes]
        log('没有歌词 → 哼哼模式（%d 个音符唱 "la"）' % len(notes))
    else:
        notes, _ = CN.extract_notes(vocal_wav, lyrics, bpm, lang=lang, dict_path=dict_path, log=log)
    path = os.path.join(outdir, 'notes.json')
    json.dump(notes, open(path, 'w', encoding='utf-8'), ensure_ascii=False)
    log('音符表：%d 个音符 → %s（BPM %.2f）' % (len(notes), os.path.basename(path), bpm))
    return notes, path, float(bpm)


def do_render(notes_path, outdir, voicebank, bpm, steps=32, device='cuda', chunk=140, log=print):
    notes = json.load(open(notes_path, encoding='utf-8'))
    if not notes:
        raise RuntimeError('音符表为空')
    rdir = os.path.join(outdir, 'render')
    os.makedirs(rdir, exist_ok=True)
    groups = [notes[i:i + chunk] for i in range(0, len(notes), chunk)]
    outs = []
    log('渲染：%d 个音符分 %d 段（每段 <= %d）—— 引擎在音符极多时一次性渲染会卡住，分段可绕开'
        % (len(notes), len(groups), chunk))
    for i, g in enumerate(groups):
        part = os.path.join(rdir, 'chunk%d.json' % i)
        wav = os.path.join(rdir, 'chunk%d.wav' % i)
        json.dump(g, open(part, 'w', encoding='utf-8'), ensure_ascii=False)
        cmd = [sys.executable, os.path.join(_HERE, 'engine_diffsinger.py'), 'sing-render',
               '--voicebank', voicebank, '--notes', '@' + part, '--bpm', str(bpm),
               '--language', 'zh', '--steps', str(steps), '--depth', '1.0',
               '--device', device, '--out', wav]
        t0 = time.time()
        p = subprocess.run(cmd, cwd=_HERE, capture_output=True, text=True,
                           encoding='utf-8', errors='ignore')
        if p.returncode != 0 or not os.path.isfile(wav):
            tail = (p.stderr or p.stdout or '')[-400:]
            raise RuntimeError('第 %d 段渲染失败：%s' % (i, tail))
        log('  段 %d/%d 完成 %.1fs' % (i + 1, len(groups), time.time() - t0))
        emit_prog(20 + 65.0 * (i + 1) / len(groups), '渲染', {'part': i + 1, 'parts': len(groups)})
        outs.append(wav)
    return outs


def sung_regions(notes, bpm, gap=3.0):
    beat = 60.0 / bpm
    spans = sorted((n['startBeat'] * beat, (n['startBeat'] + n['durBeat']) * beat) for n in notes)
    regions, cur = [], None
    for a, b in spans:
        if cur and a - cur[1] <= gap:
            cur[1] = max(cur[1], b)
        else:
            if cur:
                regions.append(tuple(cur))
            cur = [a, b]
    if cur:
        regions.append(tuple(cur))
    return regions


def write_readme(outdir, name, info):
    p = os.path.join(outdir, '说明.md')
    rows = [
        ('原曲', info.get('source', '')),
        ('时长', '%s 秒' % info.get('seconds', '')),
        ('BPM', info.get('bpm', '')),
        ('歌词来源', info.get('lyrics_from') or '（无，哼哼模式）'),
        ('声库', info.get('voicebank', '')),
        ('音符数', info.get('notes', '')),
        ('原曲 人声/伴奏 能量比', info.get('orig_vocal_over_inst', '')),
        ('成品配平', '%s dB（其中清晰度 %s dB）' % (info.get('level_match_db', ''), info.get('clarity_boost_db', ''))),
        ('辅音区 2.5-6k 占比', '合成 %s / 原唱 %s' % (info.get('share_syn', ''), info.get('share_orig', ''))),
    ]
    txt = ['# %s · 翻唱工作流产出' % name, '', '| 项 | 值 |', '| --- | --- |']
    txt += ['| %s | %s |' % r for r in rows]
    txt += ['', '## 文件', '',
            '- %s.wav —— 成品（合成人声 + 分离伴奏）' % name,
            '- %s_干声.wav —— 合成人声（未混伴奏）' % name,
            '- sep/ —— 分离出的人声轨与伴奏轨',
            '- notes.json —— 音符表（startBeat/durBeat/pitch/lyric）',
            '- render/ —— 分段渲染的中间产物', '',
            '> 由 FuFumidi 翻唱工作流自动生成。']
    open(p, 'w', encoding='utf-8').write(chr(10).join(txt))
    return p


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    for nm in ('analyze', 'render', 'mix', 'all'):
        s = sub.add_parser(nm)
        s.add_argument('audio', nargs='?' if nm != 'all' else None)
        s.add_argument('--outdir', required=True)
        s.add_argument('--voicebank', default='')
        s.add_argument('--name', default='')
        s.add_argument('--lyrics', default='auto')
        s.add_argument('--lang', default='zh')
        s.add_argument('--bpm', type=float, default=0.0)
        s.add_argument('--steps', type=int, default=32)
        s.add_argument('--device', default='cuda')
        s.add_argument('--chunk', type=int, default=140)
        s.add_argument('--sep-model', default='')
        s.add_argument('--sep-config', default='')
        s.add_argument('--sep-arch', default='')
        s.add_argument('--tta', action='store_true')
        s.add_argument('--clarity-db', type=float, default=2.0)
    a = ap.parse_args()
    outdir = os.path.abspath(a.outdir)
    os.makedirs(outdir, exist_ok=True)
    name = a.name or os.path.splitext(os.path.basename(a.audio or 'cover'))[0]
    info = {'source': os.path.basename(a.audio or ''), 'voicebank': os.path.basename(a.voicebank or '')}
    t_all = time.time()
    if a.voicebank:
        os.environ['FUFUMIDI_COVER_VOICEBANK'] = a.voicebank
    try:
        sep_dir = os.path.join(outdir, 'sep')
        voc = os.path.join(sep_dir, 'src_Vocals.wav')
        inst = os.path.join(sep_dir, 'src_Instrumental.wav')
        if a.cmd in ('analyze', 'all') and not (os.path.isfile(voc) and os.path.isfile(inst)):
            src = a.audio
            if not src:
                emit_result({'ok': False, 'error': '缺少输入音频'})
                return 1
            import shutil
            work = os.path.join(outdir, 'src' + (os.path.splitext(src)[1] or '.wav'))
            if os.path.abspath(src) != os.path.abspath(work):
                shutil.copyfile(src, work)
            voc, inst = do_separate(work, outdir, a.sep_model, a.sep_config, a.sep_arch, a.tta)
        if a.cmd in ('analyze', 'all'):
            lyrics, src_label = find_lyrics(a.audio or os.path.join(outdir, 'src'), a.lyrics)
            info['lyrics_from'] = src_label
            emit_prog(16, '扒谱')
            notes, notes_path, bpm = do_notes(voc, outdir, lyrics, lang=a.lang, bpm=a.bpm, inst_wav=inst)
            info.update({'notes': len(notes), 'bpm': round(bpm, 2)})
            if a.cmd == 'analyze':
                emit_result({'ok': True, 'stage': 'analyze', 'notes': notes_path,
                             'vocals': voc, 'instrumental': inst, 'note_count': len(notes), 'info': info})
                return 0
        else:
            notes_path = os.path.join(outdir, 'notes.json')
            notes = json.load(open(notes_path, encoding='utf-8'))
            bpm = a.bpm or 117.0
        if a.cmd in ('render', 'all'):
            if not a.voicebank:
                emit_result({'ok': False, 'error': '缺少声库目录（--voicebank）'})
                return 1
            emit_prog(20, '渲染')
            drys = do_render(notes_path, outdir, a.voicebank, bpm, a.steps, a.device, a.chunk)
            if a.cmd == 'render':
                emit_result({'ok': True, 'stage': 'render', 'dry': drys})
                return 0
        else:
            rdir = os.path.join(outdir, 'render')
            drys = sorted(os.path.join(rdir, f) for f in os.listdir(rdir)
                          if f.startswith('chunk') and f.endswith('.wav'))
        emit_prog(88, '混音')
        out_wav = os.path.join(outdir, name + '.wav')
        import cover_mix as CM
        stats = CM.mix_song(drys, inst, voc, out_wav, sung_regions(notes, bpm),
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
        emit_prog(100, '完成')
        emit_result({'ok': True, 'stage': 'all', 'out': out_wav, 'dry': stats['dry'], 'readme': readme,
                     'notes': len(notes), 'elapsed_s': round(time.time() - t_all, 1), 'info': info})
        return 0
    except Exception as e:
        emit_result({'ok': False, 'error': str(e)})
        return 1


if __name__ == '__main__':
    sys.exit(main())
