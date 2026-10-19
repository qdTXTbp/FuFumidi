# -*- coding: utf-8 -*-
"""音色稳定后处理：减少多乐器模型在分块边界「同一段旋律换音色」的听感突变。

MuScriptor 逐 5 秒块判定乐器，短块/边界处可能把一段旋律判成另一种乐器，于是同一旋律
每隔几小节换一次音色。已有的跨块延音缝合只处理「同音高延音」，管不到「换乐器」。
这里做一个**保守**的后处理：

1. 找出「短命乐器轨」：音符数很少、且时间跨度很短（默认 < 4s / < max(3, 总数 5%) 个音）；
2. 对其中每个音符，在 ±neighbor_sec 内、音高 ±pitch_tol 半音内找邻轨音符；
3. 只有当附近有足够证据（默认 ≥2 个邻音属于同一条非短命轨）才把该音移过去；
4. 移空了的短命轨删除。

只动「明显孤立的少数派」，不动主旋律/主伴奏轨，避免把正常的多乐器编曲抹平。
返回统计，便于日志/测试。
"""
import os
import tempfile


def _track_stats(inst):
    n = len(inst.notes)
    if not n:
        return n, 0.0
    starts = [float(x.start) for x in inst.notes]
    ends = [float(x.end) for x in inst.notes]
    return n, max(ends) - min(starts)


def stabilize_midi_bytes(midi_bytes, max_minor_notes=None, max_span_sec=4.0,
                         neighbor_sec=1.2, pitch_tol=7, min_support=2):
    """原地把短命孤立乐器轨的音符并入邻近主导轨，返回 (新字节, 统计)。"""
    import pretty_midi

    fd, src = tempfile.mkstemp(prefix="fufumidi-timbre-", suffix=".mid")
    os.close(fd)
    fd2, dst = tempfile.mkstemp(prefix="fufumidi-timbre-out-", suffix=".mid")
    os.close(fd2)
    try:
        with open(src, "wb") as f:
            f.write(midi_bytes)
        pm = pretty_midi.PrettyMIDI(src)
        before_tracks = len(pm.instruments)
        total = sum(len(i.notes) for i in pm.instruments)
        if total <= 0:
            return midi_bytes, {"moved": 0, "removed_tracks": 0,
                                "before_tracks": before_tracks, "after_tracks": before_tracks}
        if max_minor_notes is None:
            max_minor_notes = max(3, int(total * 0.05))
        stats = []
        for inst in pm.instruments:
            n, span = _track_stats(inst)
            stats.append({"inst": inst, "n": n, "span": span,
                          "minor": (not inst.is_drum) and n > 0 and n <= max_minor_notes and span <= max_span_sec})
        moved = 0
        for st in stats:
            if not st["minor"] or not st["inst"].notes:
                continue
            src_inst = st["inst"]
            for note in list(src_inst.notes):
                best = None
                best_score = 0
                for other in pm.instruments:
                    if other is src_inst or other.is_drum:
                        continue
                    if not other.notes:
                        continue
                    score = 0
                    for on in other.notes:
                        if abs(float(on.pitch) - float(note.pitch)) > pitch_tol:
                            continue
                        mid = (float(note.start) + float(note.end)) / 2.0
                        if abs(float(on.start) - mid) <= neighbor_sec:
                            score += 1
                    if score > best_score:
                        best_score = score
                        best = other
                if best is not None and best_score >= min_support:
                    best.notes.append(note)
                    src_inst.notes.remove(note)
                    moved += 1
        removed = 0
        for st in stats:
            inst = st["inst"]
            if inst in pm.instruments and not inst.notes:
                pm.instruments.remove(inst)
                removed += 1
        # 写回字节
        pm.write(dst)
        with open(dst, "rb") as f:
            out = f.read()
        return out, {"moved": moved, "removed_tracks": removed,
                     "before_tracks": before_tracks, "after_tracks": len(pm.instruments)}
    finally:
        for p in (src, dst):
            try:
                os.remove(p)
            except OSError:
                pass
