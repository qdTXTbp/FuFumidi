# -*- coding: utf-8 -*-
"""6.5.0 分轨 MIDI 合并：一轨一角色、固定 program、清除轨内音色切换。

调用方（main/stem-workflow.js）传入：
  [{"role":"vocals","midi":"...","name":"人声","program":52,"channel":0,"noteCount":1234}]
输出：
  merged.mid（Format 1）
  manifest.json
"""
from __future__ import annotations

import json
import os

import mido

from stem_roles import ROLE_DEFAULTS, classify_role, role_default


def _has_notes(track) -> bool:
    return any(m.type == "note_on" and getattr(m, "velocity", 0) > 0 for m in track)


def sanitize_program_changes(track):
    """删除除首条外的所有 program_change；保留首条位置。"""
    seen = False
    out = []
    for msg in track:
        if msg.type == "program_change":
            if seen:
                continue
            seen = True
        out.append(msg)
    track.clear()
    track.extend(out)


def _copy_note_events(src, dst, channel, drum=False):
    for msg in src:
        if msg.type in ("program_change", "track_name", "end_of_track", "set_tempo", "time_signature"):
            continue
        if msg.type in ("note_on", "note_off", "control_change", "pitchwheel",
                        "aftertouch", "polytouch"):
            try:
                msg = msg.copy(channel=channel)
            except Exception:
                pass
        dst.append(msg)


def _first_meta(mid):
    """从源文件取 tempo / 拍号（取第一条）。"""
    tempo = None
    sig = None
    for tr in mid.tracks:
        for msg in tr:
            if tempo is None and msg.type == "set_tempo":
                tempo = msg
            if sig is None and msg.type == "time_signature":
                sig = msg
            if tempo and sig:
                return tempo, sig
    return tempo, sig


def merge_stem_midis(stems, out_path, manifest_path=None):
    """stems: [{'role','midi','name'?, 'program'?, 'channel'?}]"""
    if not stems:
        raise ValueError("没有可合并的分轨 MIDI")
    merged = mido.MidiFile(type=1, ticks_per_beat=480)
    merged.charset = 'utf-8'
    meta = mido.MidiTrack()
    merged.tracks.append(meta)

    used_channels = set()
    manifest = []
    first_mid = None
    for i, spec in enumerate(stems):
        path = str(spec.get("midi") or "")
        if not path or not os.path.isfile(path):
            manifest.append({**spec, "error": "missing_midi"})
            continue
        mid = mido.MidiFile(path)
        if first_mid is None:
            first_mid = mid
            merged.ticks_per_beat = mid.ticks_per_beat or 480
        role = spec.get("role") or classify_role(spec.get("name") or os.path.basename(path))
        default = role_default(role)
        program = int(spec.get("program", default["program"]))
        channel = spec.get("channel", default["channel"])
        channel = int(channel)
        if default.get("drum"):
            channel = 9
        elif channel in used_channels or channel == 9:
            channel = next((c for c in range(16) if c != 9 and c not in used_channels), 0)
        used_channels.add(channel)

        tr = mido.MidiTrack()
        tr.append(mido.MetaMessage("track_name", name=str(spec.get("name") or default["label"]), time=0))
        tr.append(mido.Message("program_change", program=program, channel=channel, time=0))
        # 合并源文件所有有音符的轨，避免漏掉分轨里拆出的子通道
        notes = 0
        for src_tr in mid.tracks:
            if not _has_notes(src_tr):
                continue
            before = len(tr)
            _copy_note_events(src_tr, tr, channel, default.get("drum", False))
            notes += sum(1 for m in tr[before:] if m.type == "note_on" and getattr(m, "velocity", 0) > 0)
        sanitize_program_changes(tr)
        tr.append(mido.MetaMessage("end_of_track", time=0))
        merged.tracks.append(tr)
        manifest.append({
            "role": role,
            "name": str(spec.get("name") or default["label"]),
            "midi": path,
            "program": program,
            "channel": channel,
            "notes": notes,
        })

    # 复制第一条 tempo / 拍号到 meta
    if first_mid:
        tempo, sig = _first_meta(first_mid)
        if tempo:
            meta.append(tempo.copy(time=0))
        if sig:
            meta.append(sig.copy(time=0))
    meta.append(mido.MetaMessage("end_of_track", time=0))
    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or ".", exist_ok=True)
    merged.save(out_path)
    if manifest_path:
        with open(manifest_path, "w", encoding="utf-8") as f:
            json.dump({"out": out_path, "tracks": manifest}, f, ensure_ascii=False, indent=2)
    return {"ok": True, "out": out_path, "tracks": manifest}


def export_grouped_midi(midi_path, out_dir, max_channels=16):
    """>16 轨时按通道组拆成多个 .mid；每份内部重新分配通道。"""
    mid = mido.MidiFile(midi_path)
    groups = []
    current = mido.MidiFile(type=1, ticks_per_beat=mid.ticks_per_beat)
    meta = mido.MidiTrack()
    current.tracks.append(meta)
    used = set()
    for tr in mid.tracks[1:]:
        if not _has_notes(tr):
            continue
        free = [c for c in range(16) if c != 9 and c not in used]
        if not free or len(used) >= max_channels:
            groups.append(current)
            current = mido.MidiFile(type=1, ticks_per_beat=mid.ticks_per_beat)
            meta = mido.MidiTrack()
            current.tracks.append(meta)
            used = set()
            free = [c for c in range(16) if c != 9 and c not in used]
        nt = mido.MidiTrack()
        # 重新分配一个通道
        ch = free[0]
        used.add(ch)
        for msg in tr:
            if msg.type == "program_change":
                msg = msg.copy(channel=ch)
            elif hasattr(msg, "channel"):
                try:
                    msg = msg.copy(channel=ch)
                except Exception:
                    pass
            nt.append(msg)
        current.tracks.append(nt)
    groups.append(current)
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for i, g in enumerate(groups, 1):
        p = os.path.join(out_dir, f"part{i}.mid")
        g.save(p)
        files.append(p)
    return {"ok": True, "files": files}


def main(argv=None):
    import argparse
    ap = argparse.ArgumentParser(description='merge stem MIDI files')
    ap.add_argument('--out', required=True)
    ap.add_argument('--manifest-in', required=True, help='JSON array: [{role,midi,name,program,channel}]')
    ap.add_argument('--manifest-out', default='')
    a = ap.parse_args(argv)
    with open(a.manifest_in, 'r', encoding='utf-8') as f:
        stems = json.load(f)
    res = merge_stem_midis(stems, a.out, a.manifest_out or None)
    print(json.dumps(res, ensure_ascii=False))


if __name__ == '__main__':
    main()
