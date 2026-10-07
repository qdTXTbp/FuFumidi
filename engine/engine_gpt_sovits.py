# -*- coding: utf-8 -*-
"""GPT-SoVITS 音色通道 —— 念白（say）与「逐句参考重合成」的歌声（sing）。

    python engine_gpt_sovits.py deps   [--json]
    python engine_gpt_sovits.py voices
    python engine_gpt_sovits.py say  --voice gsv_nene --text "喂喂，测试" --out a.wav
    python engine_gpt_sovits.py sing --voice gsv_nene --lines @lines.json \\
        --vocals 原唱人声.wav --outdir out --dry-out out/dry.wav

## 为什么是「逐句参考重合成」（路线 A）

本地 GPT-SoVITS 是纯 TTS：SoVITS 的推理没有 F0 入口，旋律只能由参考音频的 mel 带出来。
于是要让它「唱指定旋律」，最省事又稳的办法是：

    原唱的第 N 句（已分离人声）→ 当参考音 → 用目标音色重合成这一句 → 对齐/校正 → 填回时间轴

参考音本身就带着这一句的旋律、节奏、咬字，所以**不需要**额外做音素级对齐；
音色来自声库权重，旋律来自原唱 —— 这就是「复用下载的音色 + 省事」的那条路。

## 对齐（gsv_align）

* 时长：整段相位声码器拉伸到原句长度（不拉伸就会越唱越偏，串行累积）
* 音高：有 pyworld 就用 WORLD 把 F0 换成原唱这一句的 F0（音色/谱包络不动）；没有就跳过并如实上报
* 电平：逐句配平到原句 RMS（限幅 ±8dB）—— 不配平会「一句响一句轻」

## 输入 lines.json

    [{"index":0,"start":3.39,"end":7.60,"text":"厌倦了一天一天 复制的生活"}]

start/end 是**秒**（相对原曲）。text 为空时用「啦」按音符数补（哼哼模式）。

★ 复用：每句旁边写一份 lines.meta.json（文本 + 参考段 + 音色 + 参数 的签名）。
  签名一致就跳过推理 —— 中途断了再跑不用从头来。
"""

import argparse
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import gsv_env                                                  # noqa: E402


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


def log(msg):
    sys.stderr.write('[gsv] ' + str(msg) + chr(10))
    sys.stderr.flush()


# ---------------------------------------------------------------- 音色/模型

def resolve_voice(arg: str) -> str:
    """音色参数：绝对目录，或 voices 根下的 id。"""
    if not arg:
        raise RuntimeError('缺少 --voice（音色 id 或目录）')
    if os.path.isdir(arg):
        return os.path.abspath(arg)
    cand = os.path.join(gsv_env.voices_root(), arg)
    if os.path.isdir(cand):
        return cand
    raise RuntimeError('找不到音色 %s（在资源中心下载，或给一个目录）' % arg)


_TTS = {'obj': None, 'key': None}


def load_tts(voice_dir: str, device: str = 'auto', version: str = '', is_half=None, root: str = ''):
    """装配运行时并载入权重（**同一进程内只载一次**，逐句复用）。"""
    rt = gsv_env.bootstrap(root)
    cfg = gsv_env.build_config(rt, voice_dir, device=device, version=version, is_half=is_half)
    key = json.dumps(cfg, sort_keys=True)
    if _TTS['obj'] is not None and _TTS['key'] == key:
        return _TTS['obj'], cfg
    io_note = gsv_env.patch_audio_io()      # ★ 不补这一刀，参考音一读就失败（见 gsv_env）
    log('音频解码：%s' % io_note)
    from GPT_SoVITS.TTS_infer_pack.TTS import TTS, TTS_Config
    t0 = time.time()
    tts = TTS(TTS_Config(cfg))
    c = cfg['custom']
    log('模型载入 %.1fs（%s / %s / half=%s）' % (time.time() - t0, c['version'], c['device'], c['is_half']))
    _TTS['obj'], _TTS['key'] = tts, key
    return tts, cfg


def synth(tts, text: str, ref_path: str, prompt_text: str, lang: str = 'zh',
          speed: float = 1.0, seed: int = 42, aux_refs=None):
    """跑一次推理 → (float32 波形, 采样率)。"""
    import numpy as np
    inputs = {
        'text': text,
        'text_lang': lang,
        'ref_audio_path': ref_path,
        'prompt_text': prompt_text,
        'prompt_lang': lang,
        'text_split_method': 'cut5',
        'batch_size': 1,
        'media_type': 'wav',
        'streaming_mode': False,
        'return_fragment': False,
        'speed_factor': float(speed),
        'seed': int(seed),
        'parallel_infer': True,
        'repetition_penalty': 1.35,
    }
    if aux_refs:
        inputs['aux_ref_audio_paths'] = list(aux_refs)
    out, sr = None, 32000
    for sr_i, chunk in tts.run(inputs):
        sr = int(sr_i)
        arr = np.asarray(chunk, dtype=np.float32).reshape(-1)
        out = arr if out is None else np.concatenate([out, arr])
    if out is None or out.size == 0:
        raise RuntimeError('GPT-SoVITS 没有产出音频（文本=%r）' % text[:40])
    return out, sr


# ---------------------------------------------------------------- say

def cmd_say(a):
    import gsv_align as A
    voice = resolve_voice(a.voice)
    tts, cfg = load_tts(voice, a.device, a.version, root=a.gsv_root)
    ref = gsv_env.find_ref_audio(voice, a.ref)
    if not ref:
        raise RuntimeError('音色目录里没有参考音（ref.wav），请用 --ref 指定一段 3~10 秒的人声')
    prompt = a.prompt or a.text
    y, sr = synth(tts, a.text, ref, prompt, a.lang, a.speed, a.seed)
    if a.out:
        A.save_mono(a.out, y, sr)
    emit_result({'ok': True, 'out': a.out, 'seconds': round(len(y) / float(sr), 2),
                 'sample_rate': sr, 'voice': os.path.basename(voice),
                 'device': cfg['custom']['device'], 'version': cfg['custom']['version']})
    return 0


# ---------------------------------------------------------------- sing

#: ★ GPT-SoVITS 对参考音有**硬性**要求：3~10 秒。超了直接抛
#:   「参考音频在3~10秒范围外，请更换！」（实测踩过）—— 所以参考音窗口要单独算，
#:   不能拿「这一句的演唱跨度」当窗口（短句会 <3s，长句会 >10s）。
#: ★ 取 3.3 / 9.5 而不是 3.0 / 10.0：它内部要把参考音**重采样**再判长度，
#:   卡在边界上的 3.000 秒会被判成「3 秒以外」（实测 ref_010 = 3.000s 被拒、10.000s 侥幸通过）。
MIN_REF_SEC = 3.3
MAX_REF_SEC = 9.5


def _line_ref(vocals, sr, start: float, end: float, pad: float = 0.20, prev_end: float = 0.0):
    """切出这一句当**参考音**（保证 3~10 秒；先往后借气口，再往前借上一句尾巴）。

    ★ 参考音窗口 ≠ 目标时长：目标时长是这一句真正的演唱跨度（start~end），
      由调用方另外切一份精确对齐用的目标段。
    """
    import numpy as np
    dur = len(vocals) / float(sr)
    a = max(0.0, start - pad)
    # ★ 不许吃进上一句（上一句的尾巴当参考会把它的咬字带进来）；
    #   注意 prev_end 为 0（第一句 / 调用方没给）时**不能**用它把窗口往前拽
    #   —— 早先那版写成 start - (start - prev_end) * 0.35，第一句会被拽到 13 秒处（实测）。
    if prev_end > 0:
        a = max(a, min(start, prev_end + 0.05))
    b = min(dur, end + pad)
    if b - a < MIN_REF_SEC:                       # 太短：往后借（间奏/气口），不够再往前
        need = MIN_REF_SEC - (b - a)
        add = min(need, max(0.0, dur - b))
        b += add
        need -= add
        if need > 0:
            take = min(need, a)
            a -= take
            need -= take
        if need > 0:
            b = min(dur, b + need)
    if b - a > MAX_REF_SEC:                       # 太长：从这一句开头起截 10 秒
        b = a + MAX_REF_SEC
    return np.asarray(vocals[int(a * sr):int(b * sr)], dtype=np.float32), a, b


def cmd_sing(a):
    import numpy as np
    import gsv_align as A
    voice = resolve_voice(a.voice)
    with open(a.lines[1:] if a.lines.startswith('@') else a.lines, encoding='utf-8') as f:
        lines = json.load(f)
    if not lines:
        raise RuntimeError('lines.json 是空的')
    vocals, vsr = A.load_mono(a.vocals)
    outdir = os.path.abspath(a.outdir)
    os.makedirs(outdir, exist_ok=True)
    meta_path = os.path.join(outdir, 'lines.meta.json')
    try:
        with open(meta_path, encoding='utf-8') as f:
            meta = json.load(f) or {}
    except (OSError, ValueError):
        meta = {}
    tts, cfg = load_tts(voice, a.device, a.version, root=a.gsv_root)
    vref = gsv_env.find_ref_audio(voice, '')
    vref_y, vref_sr = (A.load_mono(vref) if (vref and a.metrics) else (np.zeros(0, dtype=np.float32), 0))
    vocal_sig = [os.path.basename(a.vocals), int(os.path.getsize(a.vocals))]
    bed = np.zeros(int(len(vocals) / float(vsr) * 44100) + 44100, dtype=np.float32)
    report, reused, gates = [], 0, []
    t_all = time.time()
    for i, ln in enumerate(lines):
        idx = int(ln.get('index', i))
        start, end = float(ln.get('start', 0.0)), float(ln.get('end', 0.0))
        text = (ln.get('text') or '').strip()
        nsyl = int(ln.get('syllables') or 0)
        if not text:
            text = '啦' * max(1, nsyl or 4)
        seg, ra, rb = _line_ref(vocals, vsr, start, end,
                                prev_end=float(lines[i - 1].get('end', 0.0)) if i else 0.0)
        if seg.size < vsr // 4:
            log('第 %d 句太短（%.2f~%.2f）→ 跳过' % (idx, start, end))
            continue
        # ★ 精确对齐/配平/度量的目标段 = 这一句**真正的演唱跨度**（不是 3~10 秒的参考窗口）
        tgt = np.asarray(vocals[int(start * vsr):int(end * vsr)], dtype=np.float32)
        if tgt.size < vsr // 4:
            tgt = seg
        wav_out = os.path.join(outdir, 'line_%03d.wav' % idx)
        ref_path = os.path.join(outdir, 'ref_%03d.wav' % idx)
        sig = json.dumps({'v': vocal_sig, 'voice': os.path.basename(voice), 'text': text,
                          'a': round(ra, 3), 'b': round(rb, 3), 'st': round(end - start, 3),
                          'align': bool(a.align), 'speed': a.speed, 'version': cfg['custom']['version'],
                          'seed': int(a.seed) + idx}, ensure_ascii=False, sort_keys=True)
        rec = meta.get(str(idx)) or {}
        was_reused = bool(a.reuse and rec.get('sig') == sig and os.path.isfile(wav_out))
        if was_reused:
            reused += 1
            y_out, sr_out = A.load_mono(wav_out)
        else:
            A.save_mono(ref_path, seg, vsr)
            t0 = time.time()
            y_out, sr_out = synth(tts, text, ref_path, text, a.lang, a.speed, int(a.seed) + idx)
            t_syn = time.time() - t0
            y_out, ratio, _dur = A.fit_duration(y_out, sr_out, end - start)
            # ★ 校正**前**的旋律相关：用来证明 WORLD 校正到底有没有帮忙（不是信仰）
            shape_before = A.f0_shape_corr(y_out, sr_out, tgt, vsr)
            info = {'ok': False, 'reason': '未做 F0 校正'}
            if a.align:
                y_out, info = A.correct_f0(y_out, sr_out, tgt, vsr)
            y_out, db = A.match_level(y_out, tgt)
            y_out = A.fade_edges(y_out, sr_out)
            A.save_mono(wav_out, y_out, sr_out)
            rec = {'sig': sig, 'synth_s': round(t_syn, 1), 'stretch': round(ratio, 3),
                   'level_db': round(db, 2), 'f0': info, 'f0_shape_before': round(shape_before, 3)}
            meta[str(idx)] = rec
            with open(meta_path, 'w', encoding='utf-8') as f:
                json.dump(meta, f, ensure_ascii=False, indent=1)
        # 放进整长干声轨（重采样到 44100 与混音链一致）
        y44 = A.resample(y_out, sr_out, 44100)
        pos = int(start * 44100)
        if pos + len(y44) > len(bed):
            bed = np.concatenate([bed, np.zeros(pos + len(y44) - len(bed) + 4410, dtype=np.float32)])
        bed[pos:pos + len(y44)] += y44
        m = {
            'index': idx, 'start': round(start, 3), 'end': round(end, 3), 'text': text,
            'out': wav_out, 'reused': was_reused,
            'seconds': round(len(y_out) / float(sr_out), 3),
            'stretch': rec.get('stretch'), 'level_db': rec.get('level_db'),
            'f0': rec.get('f0'), 'f0_shape_before': rec.get('f0_shape_before'),
        }
        if a.metrics:
            try:
                mm = A.metrics(y_out, sr_out, tgt, vsr, vref_y, vref_sr)
                m.update(mm)
                gates.append(mm['gate'])
            except Exception as e:                              # noqa: BLE001
                m['metrics_error'] = str(e)[:120]
        report.append(m)
        emit_prog(5 + 90.0 * (i + 1) / len(lines), '合成', {'part': idx, 'parts': len(lines)})
        log('句 %d/%d %.2fs~%.2fs 完成%s f0=%s/%s' % (
            i + 1, len(lines), start, end, '（复用）' if m['reused'] else '',
            (m.get('f0_corr') if a.metrics else '-'),
            (m.get('f0_shape') if a.metrics else '-')))
        #    ↑ 前一个是逐帧相关、后一个是时间归一化后的（判据用后者，见 gsv_align.norm_curve）
    dry = a.dry_out or os.path.join(outdir, 'dry.wav')
    A.save_mono(dry, bed, 44100)
    warns = []
    if gates:
        bad = sum(1 for g in gates if g == 'B')
        if bad * 2 > len(gates):
            warns.append('%d/%d 句的 F0 相关 < 0.3：参考音没能带出旋律，建议走路线 B（专门 SVC）'
                         % (bad, len(gates)))
    emit_prog(100, '完成')
    emit_result({'ok': True, 'dry': dry, 'lines': report, 'count': len(report),
                 'reused': reused, 'warnings': warns, 'elapsed_s': round(time.time() - t_all, 1),
                 'device': cfg['custom']['device'], 'version': cfg['custom']['version'],
                 'voice': os.path.basename(voice)})
    return 0


# ---------------------------------------------------------------- deps / voices

def cmd_deps(a):
    info = gsv_env.probe(a.gsv_root)
    if a.json:
        emit_result(dict(info, ok=info.get('ok', False)))
        return 0
    emit_result(info)
    return 0


def cmd_voices(a):
    emit_result({'ok': True, 'root': gsv_env.voices_root(), 'voices': gsv_env.list_voices()})
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(description='GPT-SoVITS 音色通道（念白 + 逐句参考重合成）')
    sub = ap.add_subparsers(dest='cmd', required=True)

    d = sub.add_parser('deps', help='就绪检查（运行时/基础模型/torch/音色）')
    d.add_argument('--json', action='store_true')
    d.add_argument('--gsv-root', default='')
    d.set_defaults(func=cmd_deps)

    v = sub.add_parser('voices', help='列出本地音色')
    v.set_defaults(func=cmd_voices)

    s = sub.add_parser('say', help='念白/短句配音')
    s.add_argument('--voice', required=True)
    s.add_argument('--text', required=True)
    s.add_argument('--prompt', default='', help='参考音对应的文本（默认同 --text）')
    s.add_argument('--ref', default='', help='参考音（默认用音色目录里的 ref.wav）')
    s.add_argument('--lang', default='zh')
    s.add_argument('--speed', type=float, default=1.0)
    s.add_argument('--seed', type=int, default=42)
    s.add_argument('--device', default='auto')
    s.add_argument('--version', default='', help='v1/v2/v3/v4…（默认按音色探测）')
    s.add_argument('--gsv-root', default='')
    s.add_argument('--out', default='')
    s.set_defaults(func=cmd_say)

    g = sub.add_parser('sing', help='逐句参考重合成 → 整长干声轨')
    g.add_argument('--voice', required=True)
    g.add_argument('--lines', required=True, help='@lines.json（[{index,start,end,text}]，秒）')
    g.add_argument('--vocals', required=True, help='原唱人声轨（分离结果）')
    g.add_argument('--outdir', required=True)
    g.add_argument('--dry-out', default='', help='整长干声输出（默认 <outdir>/dry.wav）')
    g.add_argument('--lang', default='zh')
    g.add_argument('--speed', type=float, default=1.0)
    g.add_argument('--seed', type=int, default=42)
    g.add_argument('--device', default='auto')
    g.add_argument('--version', default='')
    g.add_argument('--gsv-root', default='')
    g.add_argument('--no-align', dest='align', action='store_false', help='不做 WORLD F0 校正')
    g.add_argument('--no-metrics', dest='metrics', action='store_false', help='不算客观量（省时间）')
    g.add_argument('--no-reuse', dest='reuse', action='store_false', help='不复用已合成的句子')
    g.set_defaults(func=cmd_sing, align=True, metrics=True, reuse=True)

    a = ap.parse_args(argv)
    try:
        return a.func(a) or 0
    except Exception as e:                                     # noqa: BLE001
        import traceback
        emit_result({'ok': False, 'error': str(e),
                     'trace': traceback.format_exc(limit=4)[-1200:]})
        return 1


if __name__ == '__main__':
    sys.exit(main())
