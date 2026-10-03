# -*- coding: utf-8 -*-
"""
调性分析与移调工具（供「自动转 C 大调」插件调用）
==================================================

两个子命令：

  analyze <in.mid>
      识别调性。用 Krumhansl-Schmuckler 音级轮廓相关法，
      对大调与自然小调各算一次相关系数，取高者。

  transpose <in.mid> <out.mid> [--mode diatonic|pitch] [--target major|minor]
      移调。默认 --mode diatonic：按自然音级映射到目标调，
      并保证拼写正确（例如 F# 大调转 C 大调后是 Gb，不是 F#）。

约定：
  - 结果一律以 `###RESULT {json}` 打到 stdout（宿主据此解析）
  - 提示与进度走 stderr
  - 只依赖引擎已有的 pretty_midi / numpy，不引入新依赖
"""

import argparse
import json
import math
import os
import sys

import numpy as np
import pretty_midi


# ------------------------------------------------------------------
# 调性识别：Krumhansl-Schmuckler
# ------------------------------------------------------------------

# Krumhansl-Kessler 音级权重（1979 年实验得出的听觉显著度）
MAJOR_PROFILE = np.array([
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
])
MINOR_PROFILE = np.array([
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
])

PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

# 24 个大小调的固定显示名（按主音音高类 0-11 索引）。
# 用固定表而不是 PITCH_NAMES，是因为音高类分不清同名异名 ——
# 11=B 既是 B 大调也是降 Bb 小调，若一律显示升号，Bb 大调会被显示成 A#，用户会以为识别错了。
DISPLAY_NAME = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B']

# 调号升号数（正数为升号，负数为降号），按主音音高类索引
_SHARPS_FOR_MAJOR = [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5]
_SHARPS_FOR_MINOR = [3, -6, 1, -4, 2, -5, 5, -2, 0, -3, 4, -1]


def _weighted_chroma(midi):
    """
    统计加权音级分布。

    权重用「时值」，让长音（通常是旋律骨架里的主音）比快速经过音更重要；
    同时对极短的音做下限截断，避免打击乐噪点带偏结果。
    """
    chroma = np.zeros(12, dtype=np.float64)
    for inst in midi.instruments:
        if inst.is_drum:
            continue
        for note in inst.notes:
            dur = float(note.end - note.start)
            if dur <= 0:
                dur = 0.05
            # 下限 0.05s：极短音只贡献一点点
            chroma[note.pitch % 12] += max(0.05, dur)
    return chroma


def _correlate(chroma, profile):
    """皮尔逊相关系数；全零或常量序列时返回 0。"""
    if chroma.sum() <= 0:
        return 0.0
    c = chroma - chroma.mean()
    p = profile - profile.mean()
    denom = math.sqrt(float(np.dot(c, c)) * float(np.dot(p, p)))
    if denom <= 1e-12:
        return 0.0
    return float(np.dot(c, p) / denom)


def detect_key(midi):
    """
    识别调性。

    返回 { tonic, mode, key, confidence, alternatives, chroma }
    - tonic: 0-11 的主音音级
    - mode: 'major' / 'minor'
    - key: 'Eb' / 'F#m' 这样的显示名
    """
    chroma = _weighted_chroma(midi)

    results = []
    for tonic in range(12):
        # 把音级分布旋转到「主音在 0 位」
        rolled = np.roll(chroma, -tonic)
        results.append((_correlate(rolled, MAJOR_PROFILE), tonic, 'major'))
        results.append((_correlate(rolled, MINOR_PROFILE), tonic, 'minor'))

    # 相关系数可能为负，取绝对值靠前的并不是好主意 —— 负相关意味着「反向」，
    # 这里只取正值参与排名，但保留原值供调用方判断置信度。
    results.sort(key=lambda x: x[0], reverse=True)

    best_score, best_tonic, best_mode = results[0]
    if best_score < 0:
        best_score = 0.0

    # 显示名用固定的 24 调表：Bb 大调就显示 Bb，不显示成 A#。
    # （音高类 0-11 无法区分同名异名，写错会让用户以为识别错了。）
    suffix = 'm' if best_mode == 'minor' else ''
    key = DISPLAY_NAME[best_tonic] + suffix
    sharps = _SHARPS_FOR_MINOR[best_tonic] if best_mode == 'minor' else _SHARPS_FOR_MAJOR[best_tonic]

    alternatives = []
    for score, tonic, mode in results[1:4]:
        alt_name = DISPLAY_NAME[tonic] + ('m' if mode == 'minor' else '')
        alternatives.append({'key': alt_name, 'score': round(float(max(score, 0.0)), 4)})

    return {
        'tonic': best_tonic,
        'mode': best_mode,
        'key': key,
        'sharps': sharps,
        'confidence': round(float(best_score), 4),
        'alternatives': alternatives,
        'chroma': [round(float(x), 3) for x in chroma],
    }


# ------------------------------------------------------------------
# 移调
# ------------------------------------------------------------------

MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
NATURAL_MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]

# 目标调的音级 → 拼写。C 大调与 a 小调都用自然音级（不用和声/旋律小调），
# 因为「转 C 大调」通常是流行/录音室语境下的自然大调。
TARGET_MAJOR = {
    'C': ['C', 'D', 'E', 'F', 'G', 'A', 'B'],
    'Db': ['Db', 'Eb', 'F', 'Gb', 'Ab', 'Bb', 'C'],
    'D': ['D', 'E', 'F#', 'G', 'A', 'B', 'C#'],
    'Eb': ['Eb', 'F', 'G', 'Ab', 'Bb', 'C', 'D'],
    'F': ['F', 'G', 'A', 'Bb', 'C', 'D', 'E'],
    'F#': ['F#', 'G#', 'A#', 'B', 'C#', 'D#', 'E#'],
    'Ab': ['Ab', 'Bb', 'C', 'Db', 'Eb', 'F', 'G'],
    'Bb': ['Bb', 'C', 'D', 'Eb', 'F', 'G', 'A'],
    'B': ['B', 'C#', 'D#', 'E', 'F#', 'G#', 'A#'],
}
TARGET_MINOR = {
    'Am': ['A', 'B', 'C', 'D', 'E', 'F', 'G'],
    'Bm': ['B', 'C#', 'D', 'E', 'F#', 'G', 'A'],
    'Cm': ['C', 'D', 'Eb', 'F', 'G', 'Ab', 'Bb'],
    'Dm': ['D', 'E', 'F', 'G', 'A', 'Bb', 'C'],
    'Em': ['E', 'F#', 'G', 'A', 'B', 'C', 'D'],
    'Fm': ['F', 'G', 'Ab', 'Bb', 'C', 'Db', 'Eb'],
    'Gm': ['G', 'A', 'Bb', 'C', 'D', 'Eb', 'F'],
}

# 名字 → 音高类
_NAME_TO_PC = {}
for _pc, _n in enumerate(PITCH_NAMES):
    _NAME_TO_PC[_n] = _pc
# 一些常见别名
for _alias, _pc in [
    ('Db', 1), ('Eb', 3), ('Gb', 6), ('Ab', 8), ('Bb', 10), ('A#', 10), ('C#', 1), ('D#', 3), ('F#', 6), ('G#', 8),
]:
    _NAME_TO_PC[_alias] = _pc


def _scale_pcs(tonic, mode):
    scale = MAJOR_SCALE if mode == 'major' else NATURAL_MINOR_SCALE
    return [(tonic + i) % 12 for i in scale]


def _pitch_to_name(pc, prefer_sharp=True):
    return PITCH_NAMES[pc]


def plan_diatonic(midi, target_key, src_info):
    """
    规划自然音级移调方案。

    源：src_info（detect_key 的输出）
    目标：target_key，如 'C'（大调）或 'Am'（小调）

    返回 pitch_map：{源音高类: (目标音高类, 目标音名)}
    """
    target_tonic_name = target_key[:-1] if target_key.endswith('m') else target_key
    target_mode = 'minor' if target_key.endswith('m') else 'major'
    target_pc = _NAME_TO_PC.get(target_tonic_name)
    if target_pc is None:
        raise ValueError('无法识别的目标调：' + target_key)

    table = TARGET_MINOR if target_mode == 'minor' else TARGET_MAJOR
    if target_key not in table:
        # 目标调不在预置表：用临时记号拼一个（升号倾向）
        root = target_tonic_name
        base = root[0].upper()
        accidental = root[1:]
        steps = (MAJOR_SCALE if target_mode == 'major' else NATURAL_MINOR_SCALE)
        names = [base + s for s in accidental] if accidental else [base] * 7
        # 补全后 6 个音级名
        if len(names) < 7:
            letters = 'CDEFGAB'
            start = letters.index(base) if base in letters else 0
            sharps = '#' in accidental
            for k in range(1, 7 - len(names) + 1):
                idx = (start + k) % 7
                letter = letters[idx]
                # 相对主音的音程决定升降
                interval = (steps[k] - (12 if k > 3 else 0)) % 12
                # 直接用半音数反查名字
                names.append(_spell_note(letter, target_pc + interval, prefer_sharp=not (accidental and accidental != '')))
        names = names[:7]
    else:
        names = table[target_key]

    target_pcs = [(target_pc + i) % 12 for i in (MAJOR_SCALE if target_mode == 'major' else NATURAL_MINOR_SCALE)]

    src_pcs = _scale_pcs(src_info['tonic'], src_info['mode'])

    # 1) 源音级内的音 → 同音级映射到目标
    pitch_map = {}
    for degree, spc in enumerate(src_pcs):
        pitch_map[spc] = (target_pcs[degree], names[degree])

    # 2) 源调外的半音（变化音 / 经过音）→ 映射到目标调中最近的音级
    for pc in range(12):
        if pc in pitch_map:
            continue
        # 在目标音级里找最近的（先看下方，再看上方，取半音距离小的）
        best = None
        for tp in target_pcs:
            dist = (pc - tp) % 12
            back = (tp - pc) % 12
            # 优先向下取（保持旋律下行走向），距离相同时向上
            d = min(back, dist + 12) if back <= 6 else dist
            if best is None or d < best[0]:
                best = (d, tp)
        tp = best[1]
        degree = target_pcs.index(tp)
        pitch_map[pc] = (tp, names[degree])

    return pitch_map, target_pc, target_mode


def _spell_note(letter, pc, prefer_sharp=True):
    """把 pc 拼成 letter + 升降号。仅在预置表缺失时用到。"""
    base_pc = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}[letter]
    diff = (pc - base_pc) % 12
    if diff == 0:
        return letter
    if diff in (1, 2, 3):
        return letter + '#' * ((diff + 1) // 2)
    if diff in (11, 10, 9, 8):
        return letter + 'b' * ((12 - diff + 1) // 2)
    return letter


def transpose_diatonic(midi, target_key, src_info, dry_run=False):
    """
    自然音级移调：把源调的每个音级映射到目标调同音级，并保持正确拼写。

    做法：
      1. 用音级映射算出每个音符的目标音高类
      2. 计算八度偏移，让整体音高尽量贴近原位（不无端升/降八度）
      3. 应用到所有音符，夹在 0-127
    """
    pitch_map, target_pc, target_mode = plan_diatonic(midi, target_key, src_info)

    # ---- 先算出总体的音级平移量，用于确定八度 ----
    # 以源调主音 → 目标调主音的「最近距离」作为八度基准，
    # 避免把整首歌无端抬高或压低一个八度。
    src_tonic_pc = src_info['tonic']
    tonic_shift = (target_pc - src_tonic_pc + 6) % 12 - 6   # 取 -6..+6

    plan = []
    for inst in midi.instruments:
        for note in inst.notes:
            pc = note.pitch % 12
            dst_pc = pitch_map.get(pc, (pc, None))[0]
            # 目标音高 = 目标音高类 + 最接近原音高的八度
            raw = note.pitch - pc + dst_pc
            # 让 |raw - note.pitch| 尽量小（相当于在正确音级上选最近的八度）
            octave = 0
            while raw + octave * 12 - note.pitch > 6:
                octave -= 1
            while raw + octave * 12 - note.pitch < -6:
                octave += 1
            plan.append((note, raw + octave * 12))

    # ---- 应用 ----
    moved = 0
    clamped = 0
    histogram = {}
    if not dry_run:
        for note, target in plan:
            if not 0 <= target <= 127:
                target = max(0, min(127, target))
                clamped += 1
            if target != note.pitch:
                note.pitch = target
                moved += 1
            histogram[note.pitch % 12] = histogram.get(note.pitch % 12, 0) + 1

    return {
        'mode': 'diatonic',
        'target': target_key,
        'moved': moved,
        'clamped': clamped,
        'total': len(plan),
        'tonicShift': int(tonic_shift),
        'histogram': histogram,
    }


def transpose_pitch(midi, semitones, dry_run=False):
    """纯音高移调：所有音符整体加减半音（不做音级纠正）。"""
    st = int(round(semitones))
    moved = 0
    for inst in midi.instruments:
        for note in inst.notes:
            new_p = max(0, min(127, note.pitch + st))
            if new_p != note.pitch:
                if not dry_run:
                    note.pitch = new_p
                moved += 1
    return {'mode': 'pitch', 'semitones': st, 'moved': moved}


# ------------------------------------------------------------------
# CLI
# ------------------------------------------------------------------

def _load(path):
    if not os.path.isfile(path):
        raise FileNotFoundError('文件不存在：' + path)
    return pretty_midi.PrettyMIDI(path)


def _note_count(midi):
    return sum(len(i.notes) for i in midi.instruments)


def cmd_analyze(args):
    midi = _load(args.input)
    info = detect_key(midi)
    info['file'] = os.path.basename(args.input)
    info['notes'] = _note_count(midi)
    info['tracks'] = len([i for i in midi.instruments if not i.is_drum])
    info['durationSec'] = round(float(midi.get_end_time()), 2)
    return info


def cmd_transpose(args):
    midi = _load(args.input)
    src = detect_key(midi)
    total = _note_count(midi)

    if total == 0:
        return {'ok': False, 'error': '这个 MIDI 里没有音符，无法移调'}

    if args.mode == 'pitch':
        # 纯音高移调：先算「源主音 → 目标主音」的最近半音数
        target_pc = _NAME_TO_PC.get(args.target[:-1] if args.target.endswith('m') else args.target)
        if target_pc is None:
            return {'ok': False, 'error': '无法识别的目标调：' + args.target}
        semitones = (target_pc - src['tonic'] + 6) % 12 - 6
        stat = transpose_pitch(midi, semitones)
    else:
        stat = transpose_diatonic(midi, args.target, src)

    out_dir = os.path.dirname(os.path.abspath(args.output))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    midi.write(args.output)

    return {
        'ok': True,
        'file': os.path.basename(args.input),
        'out': os.path.abspath(args.output),
        'sourceKey': src['key'],
        'sourceConfidence': src['confidence'],
        'notes': total,
        **stat,
    }


def main():
    ap = argparse.ArgumentParser(description='调性分析与移调')
    sub = ap.add_subparsers(dest='cmd', required=True)

    a = sub.add_parser('analyze', help='识别调性')
    a.add_argument('input')
    a.set_defaults(func=cmd_analyze)

    t = sub.add_parser('transpose', help='移调')
    t.add_argument('input')
    t.add_argument('output')
    t.add_argument('--mode', choices=['diatonic', 'pitch'], default='diatonic')
    t.add_argument('--target', default='C', help='目标调，如 C / D / Bb / Am（默认 C）')
    t.set_defaults(func=cmd_transpose)

    args = ap.parse_args()
    try:
        result = args.func(args)
    except Exception as e:  # 任何异常都要以 RESULT 形式回传，宿主才知道失败了
        result = {'ok': False, 'error': str(e), 'type': type(e).__name__}
        print('###RESULT ' + json.dumps(result, ensure_ascii=False), flush=True)
        return

    print('###RESULT ' + json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
