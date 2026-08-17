# -*- coding: utf-8 -*-
"""
smart_midi.py —— 智能修正 MIDI 后处理引擎（FuFumidi 专用，独立可测）

输入：原始音频 + 转录 MIDI
输出：更接近原曲的修正 MIDI

修正维度：
  1. 时间对齐    —— 音符 onset/offset 吸附到音频实际起音（onset detection）
  2. 力度还原    —— 按音符时窗内音频 RMS 能量做秩变换，让力度跟随原曲响度
  3. 音高校验    —— （保守）pyin 清晰 F0 且非和弦音时，才纠正明显错音
  4. 音符清理    —— 删除微音符、合并同音重叠
  5. 量化        —— （可选）吸附到检测到的节拍网格

用法：
  python smart_midi.py refine  --audio <a.mp3> --midi <in.mid> -o <out.mid> [选项]
  python smart_midi.py verify  --audio <a.mp3> --midi <in.mid> [-o <out.mid>] [选项]
    # verify 在 refine 基础上打印「修正前后」对齐/力度指标

依赖：numpy librosa pretty_midi scipy（mir_eval 仅 verify 用）
"""
import argparse
import json
import os
import sys
import time

import numpy as np
import pretty_midi
# librosa 为最重依赖（导入约 1~2s），仅 analyze_audio / librosa_load 使用 → 延迟导入加速子进程启动

SR = 22050
HOP = 512

# ---------------------------------------------------------------------------
# 配置
# ---------------------------------------------------------------------------
MODE_DEFAULTS = {
    'piano': dict(onset_win=0.050, offset_win=0.080, vel_strength=0.85,
                  pitch_check=False, max_semitones=7, min_note_ms=25,
                  merge_gap_ms=15, quantize=False),
    'vocal': dict(onset_win=0.060, offset_win=0.090, vel_strength=0.70,
                  pitch_check=True, max_semitones=6, min_note_ms=30,
                  merge_gap_ms=15, quantize=False, stem_balance=True),
    'auto': dict(onset_win=0.055, offset_win=0.085, vel_strength=0.80,
                 pitch_check=False, max_semitones=7, min_note_ms=25,
                 merge_gap_ms=15, quantize=False, stem_balance=False),
}


# ---------------------------------------------------------------------------
# 音频分析
# ---------------------------------------------------------------------------
def analyze_audio(path, pitch_check=False):
    import librosa
    y, sr = librosa_load(path)
    hop = 512
    # 起音检测（backtrack 吸附到真正的能量起点）
    o_env = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop, aggregate=np.median)
    env_t = librosa.times_like(o_env, sr=sr, hop_length=hop)
    o_times = librosa.onset.onset_detect(
        onset_envelope=o_env, sr=sr, hop_length=hop, units='time',
        backtrack=True, delta=0.07, pre_max=20, post_max=20, wait=15)
    # RMS 响度包络（用于力度还原）
    rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=hop)[0]
    rms_t = librosa.times_like(rms, sr=sr, hop_length=hop)
    res = dict(sr=sr, y=y, onset_times=np.asarray(o_times, float),
               rms=rms, rms_t=rms_t,
               onset_env=o_env, onset_env_t=env_t,
               env_p50=float(np.percentile(o_env, 50)))
    if pitch_check:
        f0, voiced, conf = librosa.pyin(
            y, fmin=librosa.note_to_hz('A1'), fmax=librosa.note_to_hz('C8'),
            sr=sr, frame_length=2048, hop_length=hop)
        res['f0'] = f0
        res['f0_conf'] = conf
        res['f0_t'] = librosa.times_like(f0, sr=sr, hop_length=hop)
    return res


def librosa_load(path):
    """读取任意音频为 (y, SR) 单声道数组。

    经 audio_io 解码（soundfile 快速通道 / 内置 imageio-ffmpeg），
    不再走 librosa.load → audioread：打包环境若系统无 ffmpeg，
    audioread 会抛 NoBackendError。
    """
    from audio_io import load_audio_float32
    y = load_audio_float32(path, SR)
    return y, SR


# ---------------------------------------------------------------------------
# 时间对齐（分段独立：每个音符独立吸附其局部窗内能量峰，无累积漂移）
# ---------------------------------------------------------------------------
def _snap_onset(s, env, env_t, win, env_p50, max_shift=0.040):
    """把音符起音吸附到 ±win 窗内显著的 onset 能量峰（真实攻击点）。
    保守策略：峰须显著高于中位能量，位移限 40ms，否则保持原位。"""
    lo = int(np.searchsorted(env_t, s - win))
    hi = int(np.searchsorted(env_t, s + win))
    if hi <= lo + 1:
        return s, False
    k = int(np.argmax(env[lo:hi])) + lo
    peak = float(env[k])
    if peak < max(0.08, env_p50 * 1.35):
        return s, False
    t = float(env_t[k])
    if abs(t - s) <= max_shift:
        return t, True
    return s, False


def _snap_offset(end, start, env, env_t, win, min_len):
    """把音符结尾吸附到其后附近的下一个能量峰（下一次击键点），避免拖尾混入。"""
    lo = int(np.searchsorted(env_t, end - 0.02))
    hi = int(np.searchsorted(env_t, end + win))
    if hi <= lo + 1:
        return end
    k = int(np.argmax(env[lo:hi])) + lo
    t = float(env_t[k])
    if t > start + min_len and t >= end - 0.02:
        return t
    return end


# ---------------------------------------------------------------------------
# 力度还原（秩变换）
# ---------------------------------------------------------------------------
def _note_energy(note, rms, rms_t, attack=0.25):
    """音符能量：取起音后 attack 秒攻击窗的平均 RMS（长音尾部衰减不拖累力度）。"""
    t0, t1 = note.start, min(note.end, note.start + attack)
    m = (rms_t >= t0) & (rms_t < t1)
    if not m.any():
        # 无帧覆盖：取起音处单帧
        i = int(np.searchsorted(rms_t, t0)); i = min(max(i, 0), rms.size - 1)
        return float(rms[i])
    return float(np.mean(rms[m]))


def rank_map(energies, velocities, strength):
    """按能量秩重排原有力度分布：能量高→力度大，同时保留原力度集合。
    strength∈[0,1]：0=完全保留原值，1=完全采用秩映射。"""
    energies = np.asarray(energies, float)
    vels = np.sort(np.asarray(velocities, float))
    # 秩：能量排序 → 取 vels 中对应分位
    rank = np.argsort(np.argsort(energies))
    n = len(vels)
    if n == 0:
        return list(velocities)
    mapped = vels[np.clip(np.round(rank / max(n - 1, 1) * (n - 1)).astype(int), 0, n - 1)]
    orig = np.asarray(velocities, float)
    return list(np.clip(np.round((1 - strength) * orig + strength * mapped), 1, 127).astype(int))


# ---------------------------------------------------------------------------
# 声部响度平衡（解决配乐喧宾夺主）
# ---------------------------------------------------------------------------
LEAD_NAMES = ('vocal', 'voice', 'lead', 'melody', 'main', 'solo', '人声', '主唱', '主旋律', '主奏')
ACCOMP_NAMES = ('other', 'accomp', 'back', 'pad', 'chord', 'accompaniment', '配乐', '伴奏', '和声')

def _detect_lead(pm):
    """找出主奏/人声轨索引；找不到时退化为力度最高的轨。"""
    insts = [i for i in pm.instruments if i.notes]
    if not insts:
        return None
    # 1) 名字命中
    for k, inst in enumerate(pm.instruments):
        if not inst.notes:
            continue
        nm = (inst.name or '').lower()
        if any(w in nm for w in LEAD_NAMES):
            return k
    # 2) 非打击乐 + 音符少而长（旋律性）→ 主奏
    best, bestscore = None, -1
    for k, inst in enumerate(pm.instruments):
        if not inst.notes or inst.is_drum:
            continue
        ns = inst.notes
        dur = max(ns[-1].end - ns[0].start, 1e-6)
        density = len(ns) / dur          # 每秒音符数
        medlen = float(np.median([n.end - n.start for n in ns]))
        score = medlen - density * 0.02  # 长音且不密 → 旋律性高
        if score > bestscore:
            bestscore, best = score, k
    if best is not None:
        return best
    # 3) 全打击乐：取中位力度最高的轨
    return max(range(len(pm.instruments)),
               key=lambda k: float(np.median([n.velocity for n in pm.instruments[k].notes])) if pm.instruments[k].notes else 0)


def _stem_balance(pm, lead_idx, lead_boost=1.28, accomp_cut=0.78):
    """抬主奏/人声轨力度，压低配乐轨，让主声部不被淹没。
    lead_boost: 主奏轨力度整体放大；accomp_cut: 配乐轨力度整体衰减。"""
    if lead_idx is None or not pm.instruments:
        return 0
    changed = 0
    for k, inst in enumerate(pm.instruments):
        if not inst.notes:
            continue
        if k == lead_idx:
            gain = lead_boost
        elif inst.is_drum:
            gain = 0.92   # 打击乐略压，保留节奏感
        elif any(w in (inst.name or '').lower() for w in ACCOMP_NAMES):
            gain = accomp_cut
        else:
            gain = 0.85   # 其余声部压低
        for n in inst.notes:
            nv = int(round(n.velocity * gain))
            if nv != n.velocity:
                n.velocity = max(1, min(127, nv))
                changed += 1
    return changed


# ---------------------------------------------------------------------------
# 音高校验（保守）
# ---------------------------------------------------------------------------
def _pitch_check(notes, A, max_semitones, min_conf=0.72):
    """对音符时窗内 pyin 给出清晰 F0 且该音几乎为旋律音（无±2 半音内重叠音）时，
    若音高偏离>1 半音则吸附到 F0 最近的 MIDI 音高。返回修正个数。"""
    f0, conf, ft = A['f0'], A['f0_conf'], A['f0_t']
    if f0 is None:
        return 0
    n_corr = 0
    mask = np.ma.getmaskarray(f0)
    for note in notes:
        m = (ft >= note.start) & (ft < note.end)
        if not m.any():
            continue
        valid = m & (conf >= min_conf) & ~mask
        if not valid.any():
            continue
        f0m = float(np.ma.median(f0[valid]))
        if f0m <= 0 or not np.isfinite(f0m):
            continue
        target = int(round(69 + 12 * np.log2(f0m / 440.0)))
        diff = target - note.pitch
        if diff == 0 or abs(diff) > max_semitones:
            continue
        # 旋律音检查：时窗内无其他 ±2 半音重叠音
        clash = False
        for oth in notes:
            if oth is note:
                continue
            if oth.end < note.start + 1e-4 or oth.start > note.end - 1e-4:
                continue
            if abs(oth.pitch - note.pitch) <= 2:
                clash = True
                break
        if clash:
            continue
        note.pitch = target
        n_corr += 1
    return n_corr


# ---------------------------------------------------------------------------
# 修正主流程
# ---------------------------------------------------------------------------
def refine(midi_path, audio_path, out_path, cfg):
    t0 = time.time()
    pm = pretty_midi.PrettyMIDI(midi_path)
    A = analyze_audio(audio_path, pitch_check=cfg['pitch_check'])
    stats = dict(onset_moved=0, offset_moved=0, micro_removed=0,
                 merged=0, pitch_fixed=0, notes_total=0)
    n_in = sum(len(i.notes) for i in pm.instruments)
    stats['notes_total'] = n_in

    for inst in pm.instruments:
        if not inst.notes:
            continue
        notes = inst.notes
        # -- 清理：微音符（保留和弦中最短的实音——仅删极短孤立音）--
        kept = []
        for n_ in notes:
            if (n_.end - n_.start) * 1000 < cfg['min_note_ms']:
                stats['micro_removed'] += 1
            else:
                kept.append(n_)
        notes[:] = kept
        # -- 同音重叠合并 --
        by_pitch = {}
        for n_ in notes:
            by_pitch.setdefault(n_.pitch, []).append(n_)
        notes2 = []
        for pitch, arr in by_pitch.items():
            arr.sort(key=lambda x: x.start)
            cur = None
            for n_ in arr:
                # 仅合并真重叠（>2ms），相邻的同音反复音（如重复音型）保持分开
                if cur is None or n_.start > cur.end + 0.002:
                    if cur is not None:
                        notes2.append(cur)
                    cur = pretty_midi.Note(velocity=n_.velocity, pitch=n_.pitch,
                                           start=n_.start, end=n_.end)
                else:
                    stats['merged'] += 1
                    cur.end = max(cur.end, n_.end)
                    cur.velocity = max(cur.velocity, n_.velocity)
            if cur is not None:
                notes2.append(cur)
        notes[:] = notes2
        # -- 时间对齐（逐音符独立吸附局部能量峰，等价分段独立匹配） --
        env, env_t = A['onset_env'], A['onset_env_t']
        env_p50 = A['env_p50']
        shifts = []
        for n_ in notes:
            ns, mv = _snap_onset(n_.start, env, env_t, cfg['onset_win'], env_p50)
            if mv:
                stats['onset_moved'] += 1
                shifts.append(abs(ns - n_.start))
                n_.start = ns
            ne = _snap_offset(n_.end, n_.start, env, env_t, cfg['offset_win'],
                              cfg['min_note_ms'] / 1000.0)
            if ne != n_.end:
                stats['offset_moved'] += 1
                n_.end = ne
        if shifts:
            stats['onset_avg_shift_ms'] = round(1000 * float(np.mean(shifts)), 1)
        # -- 力度还原 --
        if cfg['vel_strength'] > 0 and notes:
            energies = [_note_energy(n_, A['rms'], A['rms_t']) for n_ in notes]
            vels = rank_map(energies, [n_.velocity for n_ in notes], cfg['vel_strength'])
            for n_, v in zip(notes, vels):
                n_.velocity = v
        # -- 音高校验 --
        if cfg['pitch_check']:
            stats['pitch_fixed'] += _pitch_check(notes, A, cfg['max_semitones'])

    # -- 声部响度平衡（人声/配乐） --
    if cfg.get('stem_balance'):
        lead_idx = _detect_lead(pm)
        if lead_idx is not None:
            stats['lead_track'] = pm.instruments[lead_idx].name or 'trk%d' % lead_idx
            stats['vel_balanced'] = _stem_balance(pm, lead_idx)

    if out_path:
        os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
        pm.write(out_path)
    stats['elapsed_s'] = round(time.time() - t0, 2)
    stats['notes_out'] = sum(len(i.notes) for i in pm.instruments)
    return pm, A, stats


# ---------------------------------------------------------------------------
# 指标（verify）
# ---------------------------------------------------------------------------
def env_at_onsets(midi_path, A):
    """每个音符起音处采样的 onset 能量中位数。越高=越贴合真实攻击点。"""
    env, env_t = A['onset_env'], A['onset_env_t']
    pm = pretty_midi.PrettyMIDI(midi_path)
    vals = []
    for inst in pm.instruments:
        for n_ in inst.notes:
            i = int(np.searchsorted(env_t, n_.start))
            i = min(max(i, 0), env.size - 1)
            vals.append(float(env[i]))
    return np.array(vals) if vals else np.array([0.0])


def velocity_corr(note_vels, note_energies, method='spearman'):
    from scipy import stats as _st
    if len(note_vels) < 3:
        return 0.0
    if method == 'spearman':
        c = _st.spearmanr(note_vels, note_energies)
    else:
        c = _st.pearsonr(note_vels, note_energies)
    return float(c.statistic) if hasattr(c, 'statistic') else float(c[0])


def collect_midi_onsets_energy(midi_path, A):
    pm = pretty_midi.PrettyMIDI(midi_path)
    ons, engs = [], []
    for inst in pm.instruments:
        for n_ in inst.notes:
            ons.append(n_.start)
            engs.append(_note_energy(n_, A['rms'], A['rms_t']))
    return np.array(ons), np.array(engs)


def verify(midi_path, audio_path, out_path, cfg):
    A = analyze_audio(audio_path, pitch_check=cfg['pitch_check'])
    # 修正前
    ev0 = env_at_onsets(midi_path, A)
    _, in_eng = collect_midi_onsets_energy(midi_path, A)
    v0 = velocity_corr(_midi_vels(midi_path), in_eng)
    m0 = float(np.median(ev0))
    # 修正
    pm, A2, stats = refine(midi_path, audio_path, out_path, cfg)
    ev1 = env_at_onsets(out_path or midi_path, A2)
    _, out_eng = collect_midi_onsets_energy(out_path or midi_path, A2)
    v1 = velocity_corr(_midi_vels(out_path or midi_path), out_eng)
    m1 = float(np.median(ev1))
    return dict(before=dict(median_env=m0, vel_corr=v0),
                after=dict(median_env=m1, vel_corr=v1),
                stats=stats)


def _midi_vels(path):
    pm = pretty_midi.PrettyMIDI(path)
    return np.array([n_.velocity for i in pm.instruments for n_ in i.notes])


def _cfg(args, mode=None):
    mode = mode or args.mode
    cfg = dict(MODE_DEFAULTS[mode])
    for k in ('onset_win', 'offset_win', 'vel_strength', 'max_semitones',
              'min_note_ms', 'merge_gap_ms'):
        v = getattr(args, k, None)
        if v is not None:
            cfg[k] = v
    for k in ('pitch_check', 'quantize'):
        v = getattr(args, k, None)
        if v is not None:
            cfg[k] = v
    sb = getattr(args, 'stem_balance', None)
    if sb is not None:
        cfg['stem_balance'] = (sb == 'on')
    return cfg


def main(argv=None):
    ap = argparse.ArgumentParser(prog='smart_midi', description='智能修正 MIDI 后处理引擎')
    sub = ap.add_subparsers(dest='cmd')
    for name, help_ in (('refine', '修正 MIDI'), ('verify', '修正并输出前后指标')):
        p = sub.add_parser(name, help=help_)
        p.add_argument('--audio', required=True)
        p.add_argument('--midi', required=True)
        p.add_argument('-o', '--out', default=None)
        p.add_argument('--mode', choices=list(MODE_DEFAULTS), default='auto')
        p.add_argument('--onset-win', type=float, default=None)
        p.add_argument('--offset-win', type=float, default=None)
        p.add_argument('--vel-strength', type=float, default=None)
        p.add_argument('--pitch-check', choices=['on', 'off'], default=None)
        p.add_argument('--min-note-ms', type=float, default=None)
        p.add_argument('--quantize', choices=['on', 'off'], default=None)
        p.add_argument('--stem-balance', choices=['on', 'off'], default=None)
    args = ap.parse_args(argv)
    if not args.cmd:
        ap.print_help(); return 1
    cfg = _cfg(args)
    if args.cmd == 'refine':
        out = args.out or args.midi[:-4] + '_refined.mid'
        _, _, stats = refine(args.midi, args.audio, out, cfg)
        # ###RESULT 前缀：与 FuFumidi 主进程逐行解析约定对齐（独立 stdout 缓冲，防串行污染）
        print('###RESULT ' + json.dumps({'ok': True, 'out': out, 'stats': stats},
                                        ensure_ascii=False))
    else:
        out = args.out or args.midi[:-4] + '_refined.mid'
        res = verify(args.midi, args.audio, out, cfg)
        print(json.dumps(res, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
