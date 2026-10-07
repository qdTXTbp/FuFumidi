# -*- coding: utf-8 -*-
"""翻唱工作流 · 扒谱：人声轨 → 带歌词的音符表。

这是把「甩葱歌 / 轻涟 / 下一个远方」三首歌手工跑通的流程固化成代码，
每一步的规则都对应一次实测踩坑（注释里带数字）：

  1. 旋律来自**分离后的人声轨**，pyin 单声部跟踪（混音里直接跟踪会跟到伴奏）。
  2. 八度判定用「所在位置 ±2 秒的参考轮廓中位数」，**不要**用「与上一个音跳进最小」
     —— 后者错一处会顺着乐句级联（轻涟第 3/4/5 行整体被顶高一个八度，逐句偏差 +12 半音）。
  3. 音节边界用 onset 检测钉在实际演唱位置；行窗口要**剪掉间奏**
     （轻涟第 6 行不剪就吞掉 33 秒间奏，59 个音配 10 个音节）。
  4. **每个音节都必须有音符**：窗口太短就放宽、再不行就均分；pyin 提不到音高时
     借邻近音高兜底。实测「哒哒哒哒哒 哒哒哒」8 个字曾只剩 1 个音符、
     「嗐 嗐 没有关系」6 个字只剩 1 个 —— 丢字的听感就是「吐字不清」。
  5. 短跨度**不许拆装饰音**（<0.28 秒或音高差 <2 半音就并成一个音），
     拆了辅音没时间成形；拖腔唱**韵母**（guang→ang）而不是裸 a。
  6. 相邻音符之间小于 90ms 的缝要补上，否则乐句一顿一顿（「词语不连贯」）。
"""
import os
import re

import numpy as np

try:
    import librosa
except Exception:  # noqa: BLE001
    librosa = None

from pypinyin import lazy_pinyin

SR_T = 22050
HOP = 256
MIN_SYL = 0.12          # 每个音节至少占用的时间（秒）
MIN_SPLIT = 0.28        # 跨度内至少这么长才允许拆装饰音
SPLIT_SEMI = 2          # 拆装饰音的最小音高差（半音）

#: 常见英文/拟声词的音节近似（芙宁娜等中文声库没有英文音素表时用拼音近似）
LATIN = {
    'woo': ['wu'], 'wu': ['wu'], 'my': ['mai'], 'party': ['pa', 'ti'], 'time': ['tai', 'mu'],
    'sax': ['sa', 'ke', 'si'], 'solo': ['so', 'lo'], 'yeah': ['ye'], 'oh': ['o'], 'hey': ['hei'],
    'baby': ['bei', 'bi'], 'go': ['gou'], 'love': ['la', 'fu'], 'dream': ['du', 'ri', 'mu'],
    'day': ['dei'], 'night': ['nai', 'to'], 'la': ['la'], 'na': ['na'], 'da': ['da'],
}

_INITIALS = ('zh', 'ch', 'sh', 'b', 'p', 'm', 'f', 'd', 't', 'n', 'l', 'g', 'k', 'h',
             'j', 'q', 'x', 'r', 'z', 'c', 's', 'y', 'w')

_META = re.compile(r'^(作词|作曲|编曲|制作|混音|母带|出品|原唱|吉他|贝斯|鼓|键盘|和声|录音|监制|'
                   r'统筹|策划|曲绘|演唱|特别感谢)[\u4e00-\u9fff]{0,3}\s*[:：]')
_CREDIT = re.compile(r'^[^，。！？、,.!?]{1,8}\s*[:：]')


def parse_lrc(text):
    """LRC 文本 → [(秒, 歌词)]；元信息行（作词/制作人…）自动剔除。"""
    out = []
    for line in (text or '').splitlines():
        m = re.match(r'\[(\d+):(\d+(?:\.\d+)?)\](.*)', line.strip())
        if not m:
            continue
        t = int(m.group(1)) * 60 + float(m.group(2))
        body = m.group(3).strip()
        if not body or _META.match(body) or _CREDIT.match(body):
            continue
        out.append((t, body))
    out.sort(key=lambda x: x[0])
    return out


def read_lyrics_file(path):
    """读歌词：.lrc 直接解析；其它按纯文本行（无时间轴时按等分处理）。"""
    raw = open(path, encoding='utf-8-sig', errors='ignore').read()
    timed = parse_lrc(raw)
    if timed:
        return timed
    lines = [l.strip() for l in raw.splitlines() if l.strip()]
    return [(float(i) * 4.0, l) for i, l in enumerate(lines)]


def pinyin_final(syl):
    """拼音音节 → 韵母（guang→ang、sheng→eng）。拖腔唱韵母比唱裸 a 自然。"""
    s = (syl or '').lower()
    for ini in sorted(_INITIALS, key=len, reverse=True):
        if s.startswith(ini) and len(s) > len(ini):
            return s[len(ini):]
    return s


def syllables_zh(text):
    """一行歌词 → 音节列表：汉字走 pypinyin，拉丁词按读音拆，纯英文标记跳过。"""
    body = re.sub(r'[（(][^）)]*[）)]',
                  lambda m: '' if re.search(r'[A-Za-z]{3,}', m.group(0)) and not re.search(r'[\u4e00-\u9fff]', m.group(0)) else m.group(0),
                  text)
    out = []
    for tok in re.findall(r'[\u4e00-\u9fff]+|[A-Za-z]+', body):
        if re.match(r'[\u4e00-\u9fff]', tok):
            out.extend(lazy_pinyin(tok))
        else:
            low = tok.lower()
            if low in LATIN:
                out.extend(LATIN[low])
            else:
                parts, i = [], 0
                while i < len(low):
                    m = re.match(r'([bcdfghjklmnpqrstvwxyz]?[aeiou]+)', low[i:])
                    if m:
                        parts.append(m.group(1)); i += len(m.group(1))
                    else:
                        i += 1
                out.extend(parts if len(parts) >= 2 else [low])
    return [s for s in out if s]


def continuation_lyric(syl, allowed=None):
    """拖腔时后面那些音唱什么：优先韵母，其次主元音。"""
    fin = pinyin_final(syl)
    if allowed is None or fin in allowed:
        return fin
    for v in ('ang', 'eng', 'ing', 'ong', 'an', 'en', 'in', 'un', 'ai', 'ei', 'ao', 'ou',
              'a', 'o', 'e', 'i', 'u'):
        if v in allowed and v in fin:
            return v
    return 'a'


def load_allowed(dict_path):
    """声库词典里合法的音节集合（拖腔韵母与兜底都要查它）。"""
    try:
        s = set()
        for line in open(dict_path, encoding='utf-8'):
            p = line.split()
            if p:
                s.add(p[0])
        return s or None
    except OSError:
        return None


def _f0_track(mono, sr):
    """带通 + pyin + 参考轮廓。返回 (midi, voiced, ref)。"""
    S = np.abs(librosa.stft(mono, n_fft=2048, hop_length=HOP))
    freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
    yf = librosa.istft(S * ((freqs >= 150) & (freqs <= 4000)).astype('float32')[:, None],
                       hop_length=HOP, length=len(mono))
    f0, voiced, _ = librosa.pyin(yf, fmin=140, fmax=900, sr=sr, frame_length=2048,
                                 hop_length=HOP, fill_na=np.nan, center=True)
    midi = 69 + 12 * np.log2(f0 / 440.0)
    hop_s = HOP / sr
    ref = np.full_like(midi, np.nan)
    idx = np.where(~np.isnan(midi))[0]
    if len(idx):
        w2 = int(2.0 / hop_s)
        for i in idx:
            lo, hi = max(0, i - w2), min(len(midi), i + w2)
            seg = midi[lo:hi]
            seg = seg[~np.isnan(seg)]
            if len(seg):
                ref[i] = np.median(seg)
    return midi, voiced, ref, yf, hop_s


def extract_notes(vocal_wav, lyrics, bpm, lang='zh', pitch_min=45, pitch_max=88,
                  dict_path=None, log=None):
    """人声轨 + 歌词 → 音符表（[{startBeat, durBeat, pitch, lyric, ...}]）。

    lyrics: [(秒, 文本)]，来自 LRC 或用户粘贴。
    """
    if librosa is None:
        raise RuntimeError('缺少 librosa，无法扒谱')
    import soundfile as sf

    allowed = load_allowed(dict_path) if dict_path else None
    y, sr = sf.read(vocal_wav, always_2d=True)
    mono = y.mean(axis=1).astype('float32')
    if sr != SR_T:
        mono = librosa.resample(mono, orig_sr=sr, target_sr=SR_T)
        sr = SR_T
    midi, voiced, ref, yf, hop_s = _f0_track(mono, sr)

    # 人声活动区（剪间奏用）
    rms = librosa.feature.rms(y=mono, frame_length=1024, hop_length=HOP)[0]
    thr = max(float(np.percentile(rms, 75)) * 0.06, float(np.max(rms)) * 0.02)
    active = rms > thr

    # 音符分段
    raw, cur = [], None
    for i, (m, v) in enumerate(zip(midi, voiced)):
        if not v or np.isnan(m):
            if cur:
                raw.append(cur); cur = None
            continue
        if cur is None:
            cur = {'s': i, 'e': i, 'p': [m]}
        elif abs(np.median(cur['p'][-6:] if len(cur['p']) >= 6 else cur['p']) - m) <= 0.6:
            cur['e'] = i; cur['p'].append(m)
        else:
            raw.append(cur); cur = {'s': i, 'e': i, 'p': [m]}
    if cur:
        raw.append(cur)
    seg_notes = []
    for n in raw:
        if (n['e'] - n['s'] + 1) * hop_s < 0.06:
            continue
        base = float(np.median(n['p']))
        r = ref[n['s']:(n['e'] + 1)]
        r = r[~np.isnan(r)]
        anchor = float(np.median(r)) if len(r) else base
        pitch = min([base + 12 * k for k in (-1, 0, 1)], key=lambda c: abs(c - anchor)) if len(r) else base
        seg_notes.append({'t0': n['s'] * hop_s, 't1': (n['e'] + 1) * hop_s, 'pitch': int(round(pitch))})
    merged = []
    for n in seg_notes:
        if merged and n['pitch'] == merged[-1]['pitch'] and n['t0'] - merged[-1]['t1'] < 0.09:
            merged[-1]['t1'] = n['t1']
        else:
            merged.append(dict(n))
    seg_notes = merged

    def pitch_at(t, tol=0.12):
        for n in seg_notes:
            if n['t0'] - 0.02 <= t < n['t1']:
                return n['pitch']
        best, bd = None, tol
        for n in seg_notes:
            d = min(abs(n['t0'] - t), abs(n['t1'] - t))
            if d < bd:
                best, bd = n['pitch'], d
        return best

    def segments(s0, s1):
        edges = sorted({s0, s1} | {n['t0'] for n in seg_notes if s0 + 0.02 < n['t0'] < s1 - 0.02})
        segs = []
        for x, z in zip(edges, edges[1:]):
            if z - x < 0.02:
                continue
            p = pitch_at((x + z) / 2)
            if p is None:
                continue
            if segs and segs[-1][2] == p:
                segs[-1][1] = z
            else:
                segs.append([x, z, p])
        return segs

    onsets = librosa.onset.onset_detect(y=yf, sr=sr, hop_length=HOP, units='time',
                                        backtrack=True, delta=0.035, wait=3)
    beat = 60.0 / float(bpm)
    grid = beat / 16.0
    min_dur = beat / 8.0
    out_notes, prev_pitch, report = [], None, []

    for k, (t0, text) in enumerate(lyrics):
        t_next = lyrics[k + 1][0] if k + 1 < len(lyrics) else t0 + 12.0
        win_end = min(t_next, t0 + 14.0)
        ia, ib = int(t0 / hop_s), int(win_end / hop_s)
        seg_active = active[ia:ib]
        if not seg_active.any():
            report.append({'t': round(t0, 1), 'text': text[:24], 'notes': 0, 'syllables': 0, 'why': '无人声'})
            continue
        win_end = min(win_end, (ia + int(np.where(seg_active)[0][-1])) * hop_s + 0.30)
        syls = syllables_zh(text) if lang == 'zh' else [c for c in text if not c.isspace()]
        if not syls:
            report.append({'t': round(t0, 1), 'text': text[:24], 'notes': 0, 'syllables': 0, 'why': '无音节'})
            continue
        dur = win_end - t0
        if dur < len(syls) * MIN_SYL:
            relaxed = min(t_next, t0 + max(dur, len(syls) * MIN_SYL + 0.25), t0 + 14.0)
            if relaxed > win_end:
                win_end = relaxed
                dur = win_end - t0
        if dur < len(syls) * MIN_SYL:                        # 还是不够 → 均分，保证每字有位
            step = max(0.08, dur / max(1, len(syls)))
            ons = [t0 + i * step for i in range(len(syls))]
        else:
            ons = [o for o in onsets if t0 - 0.10 <= o < win_end]
            ons = [o for i, o in enumerate(ons) if i == 0 or o - ons[i - 1] >= 0.16]
            if not ons:
                ons = [t0]
            if ons[0] > t0 + 0.45:
                ons.insert(0, t0)
        gaps = [ons[i + 1] - ons[i] for i in range(len(ons) - 1)]
        while len(ons) > len(syls) and gaps:
            i = int(np.argmin(gaps)); del ons[i + 1]
            gaps = [ons[j + 1] - ons[j] for j in range(len(ons) - 1)]
        while len(ons) < len(syls):
            nxt = (ons[-1] + MIN_SYL) if not gaps else None
            if gaps:
                i = int(np.argmax(gaps)); ons.insert(i + 1, (ons[i] + ons[i + 1]) / 2)
            elif nxt is not None and nxt < win_end:
                ons.append(nxt)
            else:
                break
            gaps = [ons[j + 1] - ons[j] for j in range(len(ons) - 1)]
        spans = [(max(t0, ons[j]), ons[j + 1] if j + 1 < len(ons) else win_end) for j in range(len(ons))]
        if len(spans) < len(syls):                            # 兜底：把最后一段继续均分
            a0 = spans[-1][0] if spans else t0
            step = max(0.08, (win_end - a0) / max(1, len(syls) - len(spans) + 1))
            spans = spans[:-1] + [(a0 + i * step, min(win_end, a0 + (i + 1) * step))
                                  for i in range(len(syls) - len(spans) + 1)]
        seg_pitches = [n['pitch'] for n in seg_notes if n['t1'] >= t0 - 0.3 and n['t0'] <= win_end + 0.3]
        line_pitch = int(np.median(seg_pitches)) if seg_pitches else (prev_pitch or 63)
        made = 0
        for j, (s0, s1) in enumerate(spans):
            if j >= len(syls):
                break
            if s1 - s0 < 0.10:
                s0 = max(t0, s1 - 0.10)
            syl = syls[j]
            segs = segments(s0, s1)
            if segs and (s1 - s0) >= MIN_SPLIT:
                keep = [segs[0]]
                for x, z, p in segs[1:]:
                    if (z - x) >= MIN_SPLIT and abs(p - keep[-1][2]) >= SPLIT_SEMI:
                        keep.append([x, z, p])
                    else:
                        keep[-1][1] = z
                segs = keep
            elif segs:
                best = max(segs, key=lambda s: s[1] - s[0])
                segs = [[s0, s1, best[2]]]
            else:
                p = pitch_at((s0 + s1) / 2) or pitch_at(s0) or prev_pitch or line_pitch
                segs = [[s0, s1, p]]
            for q, (x, z, p) in enumerate(segs):
                if p is None or not (pitch_min <= p <= pitch_max):
                    continue
                st = max(s0, x) if q == 0 else x
                du = max(min_dur, z - st)
                st = round(round(st / grid) * grid, 4)
                du = max(min_dur, round(round(du / grid) * grid, 4))
                out_notes.append({
                    'startBeat': round(st / beat, 4), 'durBeat': round(du / beat, 4), 'pitch': int(p),
                    'lyric': syl if q == 0 else continuation_lyric(syl, allowed),
                    'vibrato': du >= 0.45, 'vibDepth': 0.15, 'vibFreq': 5.4, 'vibFade': 0.28, 'pitchOffset': 0,
                })
                made += 1
                prev_pitch = int(p)
        report.append({'t': round(t0, 1), 'text': text[:24], 'notes': made,
                       'syllables': len(syls), 'why': '' if made >= len(syls) else '音符少于音节'})

    out_notes.sort(key=lambda n: n['startBeat'])
    # 连贯性：补齐 <90ms 的缝
    for a, b in zip(out_notes, out_notes[1:]):
        gap = b['startBeat'] - (a['startBeat'] + a['durBeat'])
        if 0 < gap * beat < 0.09:
            a['durBeat'] = round(b['startBeat'] - a['startBeat'], 4)
    if log:
        short = [r for r in report if r['syllables'] and r['notes'] < r['syllables']]
        log('扒谱：%d 行 → %d 个音符（演唱 %.1fs）；缺字的行 %d' % (
            len(lyrics), len(out_notes), sum(n['durBeat'] for n in out_notes) * beat, len(short)))
    return out_notes, report
