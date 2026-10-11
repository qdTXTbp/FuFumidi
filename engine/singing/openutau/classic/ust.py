# -*- coding: utf-8 -*-
"""`.ust` 工程读写 —— **照搬** `OpenUtau.Core/Classic/Ust.cs`（522 行）。

UTAU 的老工程格式：**Shift-JIS 文本**，一个 `[#SETTING]` 段 + 每个音符一个
`[#NNNN]` 块（单个音符块的解析在 `classic/ust_note.py`）。本模块负责**工程级编排**：
编码探测、多文件合并、setting 解析、音符/flags 映射、空拍补 R、速度切分，以及
给插件用的 diff 格式读写。

## ★ 照搬时保留的语义
1. **编码探测**：只扫**前 10 行**里的 `Charset=`（`line.Trim()` 后判断），
   找不到就用 **Shift-JIS**（不是 UTF-8）。
2. ★ `Load(files)` 会把**多个 .ust 合并成一个工程**：第一个当主体、
   `name` 改成 `"Merged Project"`，其余每个的第一个 track / part **追加**进来
   并重编 `trackNo`。混进非 .ust 文件直接抛错。
3. ★ **空拍补 `R`**：音符之间有缝就插一个 `R`（`noteNum=60`）；
   解析时 `lyric` 小写等于 `"r"` 的**不**加进 `part.notes`（但仍参与位置计算）。
4. ★ `Tool2` 决定 `t` flag 的含义：`resampler`/`doppeltler`/`f2resamp`/`moresampler`
   开头 → `tuning = flag.Value`；**其它**（fresamp11-14 / model4 / TIPS / tn_fnds / bkh01）
   → `tuning = flag.Value * 10`。这是 UTAU 各家 resampler 的历史差异。
5. ★ `Flags=` 里出现**工程未定义**的 flag 时**不报错**，记进 `undefined_flags`，
   由调用方汇总提示。
6. ★ **速度修正**：`tempos[0].bpm <= 0 或 > 1000` 时（有人写了 `tempo=500k` 这类值），
   用第一个带 `Tempo=` 的音符去**修** `tempos[0]`；之后的速度变化**追加**为新 `UTempo`。
7. `WriteHeader` 的 `Tempo=` 用的是 **`project.timeAxis.GetBpmAtTick(part.position)`**
   （不是 `tempos[0].bpm`）；`Project=` 那行**只在 `project.saved` 为真时**才写。
8. `SnapPitchPoints`：音符与上一个**不重叠**时，`snapFirst = False`。

## ★ 载体差异
- C# 的 `DocManager.Inst.ExecuteCmd(new ErrorMessageNotification(...))`（UI 通知）
  → 本仓库没有 UI 通道，改为**返回提示串** / 收集到 `undefined_flags`。
- `SingerManager.Inst.GetSinger(path)` 是全局单例 → 走**可注入的查找器**
  `set_singer_finder(fn)`；未设置时 `%VOICE%`/`%DATA%` 之外的路径拿不到歌手，
  此时 `VoiceDir` 仍然写进 .ust（读回来的人自己解析），**不报错**。
- `PathManager.Inst.CachePath` → `resampler_item.host.cache_path`。
- `Formats.DetectProjectFormat` 未照搬（属于 `Format/` 的多格式探测，另立），
  这里用**扩展名 + 内容嗅探**做等价判断。
"""

import io
import os
from typing import Callable, List, Optional

from ...ustx.format import Ustx, add_default_expressions
from ...ustx.model import UProject, UTempo, UTrack, UVoicePart
from .ini import Ini
from .ust_flag import UstFlagParser
from .ust_note import FileFormatError, UstNote, parse_float

SHIFT_JIS = 'shift_jis'

#: 模块级"未定义 flag"收集（对应 C# 的 `static List<string> undefinedFlags`）
_undefined_flags: List[str] = []

#: 可注入的歌手查找器（对应 `SingerManager.Inst.GetSinger`）
_singer_finder: Optional[Callable[[str], object]] = None


def set_singer_finder(fn: Optional[Callable[[str], object]]) -> None:
    """注入歌手查找器（主程序/测试用）。传 None 恢复"查不到"的行为。"""
    global _singer_finder
    _singer_finder = fn


def undefined_flags() -> List[str]:
    """返回并**清空**本次收集到的未定义 flag（照搬 C# 的静态列表语义）。"""
    global _undefined_flags
    out = list(_undefined_flags)
    _undefined_flags = []
    return out


# ---------------------------------------------------------------- 编码


def detect_encoding(file: str) -> str:
    """对应 `DetectEncoding(file)`：只看**前 10 行**有没有 `Charset=`，否则 Shift-JIS。

    ★ 上游用 Shift-JIS 打开去读前 10 行（`StreamReader(file, ShiftJIS)`），
      所以这一步即使文件是 UTF-8 也可能读出乱码 —— 但只用来找 ASCII 的 `Charset=`，
      实际不影响。Python 侧直接按 shift_jis + replace 读，同样只取那一行。
    """
    with io.open(file, 'r', encoding=SHIFT_JIS, errors='replace') as f:
        for _ in range(10):
            line = f.readline()
            if not line:
                break
            line = line.strip()
            if line.startswith('Charset='):
                return line.replace('Charset=', '')
    return SHIFT_JIS


def _read_lines(file: str, encoding: str) -> List[str]:
    with io.open(file, 'r', encoding=encoding, errors='replace', newline=None) as f:
        return f.read().splitlines()


def _looks_like_ust(lines: List[str]) -> bool:
    """`Formats.DetectProjectFormat` 的等价判断（扩展名 + 内容嗅探）。"""
    for line in lines[:40]:
        s = line.strip()
        if s.startswith('[#') and not s.startswith('[#SETTING]'):
            return True
        if s.lower().startswith('voicebank='):
            return True
    return False


# ---------------------------------------------------------------- 载入


def load(files) -> UProject:
    """对应 `Load(string[] files)`：载入并**合并**一个或多个 .ust。"""
    global _undefined_flags
    files = list(files or [])
    if not files:
        raise FileFormatError('没有要载入的 .ust 文件')

    all_lines = {}
    for f in files:
        enc = detect_encoding(f)
        lines = _read_lines(f, enc)
        if not _looks_like_ust(lines):
            raise FileFormatError('Multiple files must be all Ust files: %s' % f)
        all_lines[f] = lines

    _undefined_flags = []
    projects = [_load_lines(all_lines[f], f) for f in files]

    project = projects[0]
    project.name = 'Merged Project'
    for p in projects[1:]:
        if not p.tracks or not p.parts:
            continue
        track = p.tracks[0]
        part = p.parts[0]
        track.track_no = len(project.tracks)
        part.track_no = track.track_no
        project.tracks.append(track)
        project.parts.append(part)
    return project


def load_file(file: str) -> UProject:
    """载入单个 .ust（`load([file])` 的便捷形式）。"""
    return load([file])


def _load_lines(lines: List[str], file: str) -> UProject:
    """对应 `Load(StreamReader reader, string file)` 的主体。"""
    project = UProject()
    project.file_path = file
    project.saved = False
    add_default_expressions(project)

    project.tracks.clear()
    track = UTrack.for_project(project)  # 对应 C# 的 UTrack(UProject) 重载
    track.track_no = 0
    project.tracks.append(track)

    part = UVoicePart(track_no=0, position=0,
                      name=os.path.splitext(os.path.basename(file))[0])
    project.parts.append(part)

    blocks = Ini.read_blocks(lines, file, r'\[#\w+\]')
    _parse_part(project, part, blocks)

    last = part.notes[-1] if part.notes else None
    # ★ 上游原式 `part.Duration = part.notes.LastOrDefault()?.End ?? 0 + project.resolution;`
    #   —— `??` 的优先级使 `0 + resolution` 整体兜底，照搬这个形状
    part.duration = (last.end if last is not None else 0) + project.resolution \
        if last is not None else (0 + project.resolution)
    return project


def _parse_part(project, part, blocks) -> None:
    """对应 `ParsePart`：先吃 `[#SETTING]`，再按块顺序解析音符。"""
    last_note_pos, last_note_end = 0, 0
    settings = next((b for b in blocks if b.header == '[#SETTING]'), None)
    if settings is not None:
        _parse_setting(project, settings.lines)

    # ★ 速度修正开关（tempo=500k 这类坏值）
    should_fix_tempo = project.tempos[0].bpm <= 0 or project.tempos[0].bpm > 1000

    for block in blocks:
        header = block.header
        if header in ('[#VERSION]', '[#SETTING]', '[#TRACKEND]'):
            continue
        try:
            num = header[2:-1]
            note_index = int(num) if num.lstrip('-').isdigit() else None
            if note_index is None:
                raise FileFormatError('Unexpected header\n%s' % header)
            note = project.create_note()
            note_tempo = _parse_note(project, note, last_note_pos, last_note_end, block.lines)
            last_note_pos = note.position
            last_note_end = note.end
            if note.lyric.lower() != 'r':
                part.notes.append(note)
            if note_tempo is not None:
                if should_fix_tempo:
                    project.tempos[0].bpm = note_tempo
                    should_fix_tempo = False
                else:
                    project.tempos.append(UTempo(note.position, note_tempo))
        except FileFormatError:
            raise
        except Exception as e:                                   # noqa: BLE001
            raise FileFormatError('Failed to parse block\n%s' % header) from e

    _snap_pitch_points(part)


def _snap_pitch_points(part) -> None:
    """对应 `SnapPitchPoints`：与上一个音符**不重叠**时 `snapFirst = False`。"""
    last_note = None
    for note in part.notes:
        if last_note is None or note.position > last_note.end:
            note.pitch.snap_first = False
        last_note = note


def _parse_setting(project, lines) -> None:
    """对应 `ParseSetting`：Tempo / ProjectName / VoiceDir / Tool2 / Flags。"""
    global _undefined_flags
    for ini_line in lines:
        line = getattr(ini_line, 'line', ini_line)
        parts = line.split('=', 1)
        if len(parts) != 2:
            raise FileFormatError('Line does not match format <param>=<value>.\n%s' % line)
        param = parts[0].strip()
        if param == 'Tempo':
            ok, v = parse_float(parts[1])
            if ok:
                project.tempos[0].bpm = v
        elif param == 'ProjectName':
            project.name = parts[1].strip()
        elif param == 'VoiceDir':
            singer_path = parts[1].strip()
            singer = _find_singer(singer_path)
            if singer is not None:
                project.tracks[0].singer_obj = singer
        elif param == 'Tool2':
            _set_tool2(parts[1].strip())
        elif param == 'Flags':
            parser = UstFlagParser()
            track = project.tracks[0]
            for flag in parser.parse(parts[1].strip()):
                desc = next((d for d in project.expressions.values() if d.flag == flag.key), None)
                if desc is None:
                    _undefined_flags.append(flag.key)
                else:
                    d = desc.clone()
                    d.custom_default_value = flag.value
                    track.track_expressions.append(d)


#: 对应 C# 的 `static string tool2`（决定 `t` flag 的换算，见 `_set_flags`）
_tool2 = ''


def _set_tool2(value: str) -> None:
    global _tool2
    _tool2 = value


def _parse_note(project, note, last_note_pos: int, last_note_end: int, lines):
    """对应 `ParseNote`：解一个 `[#NNNN]` 块到 `UNote`，返回该块携带的 `Tempo`（或 None）。"""
    ust_note = UstNote(lyric=note.lyric, position=note.position,
                       duration=note.duration, note_num=note.tone, pitch=note.pitch)
    note_tempo = ust_note.parse(last_note_pos, last_note_end, lines)

    # ★ 以 "!" 开头 → 包成 "[...]"（那是 UTAU 的"别名"记号）
    if ust_note.lyric.startswith('!'):
        note.lyric = '[%s]' % ust_note.lyric[1:]
    else:
        note.lyric = ust_note.lyric
    note.position = ust_note.position
    note.duration = ust_note.duration
    note.tone = ust_note.note_num
    if ust_note.velocity is not None:
        _set_expression(project, note, Ustx.VEL, ust_note.velocity)
    if ust_note.intensity is not None:
        _set_expression(project, note, Ustx.VOL, ust_note.intensity)
    if ust_note.modulation is not None:
        _set_expression(project, note, Ustx.MOD, ust_note.modulation)
    if ust_note.flags is not None:
        _set_flags(project, note, ust_note.flags)
    if ust_note.pitch is not None:
        note.pitch = ust_note.pitch
    if ust_note.vibrato is not None:
        note.vibrato = ust_note.vibrato
    return note_tempo


def _set_flags(project, note, flags: str) -> None:
    """对应 `SetFlags`：把 .ust 的 flag 串映射成表达式。

    ★ `t` flag 走 `tool2` 分支且**处理完就 return**（后面的 flag 全丢）——
      这是上游行为（`t` 必须是最后一个），照搬。
    """
    parser = UstFlagParser()
    for flag in parser.parse(flags):
        if flag.key == 't':
            low = _tool2.lower()
            if low.startswith(('resampler', 'doppeltler', 'f2resamp', 'moresampler')):
                note.tuning = flag.value
            else:
                # fresamp11-14 / model4 / TIPS / tn_fnds / bkh01
                note.tuning = flag.value * 10
            return
        abbr = _find_abbr_from_flag_key(project.expressions, flag.key)
        if not abbr:
            _undefined_flags.append(flag.key)
        else:
            _set_expression(project, note, abbr, flag.value)


def _find_abbr_from_flag_key(expressions, flag_key: str) -> str:
    """对应 `FindAbbrFromFlagKey`：找声明了这个 flag 的表达式缩写。"""
    for d in expressions.values():
        if d.flag == flag_key:
            return d.abbr
    return ''


def _set_expression(project, note, abbr: str, value) -> None:
    """对应 `SetExpression`：值**等于自定义默认值时跳过**（不写冗余表达式）。"""
    track = project.tracks[0]
    descriptor = track.try_get_exp_descriptor(project, abbr)
    if descriptor is not None and descriptor.custom_default_value != value:
        note.set_expression(project, track, abbr, [value])


def _find_singer(singer_path: str):
    """`SingerManager.Inst.GetSinger(path)` 的替身：走注入的查找器。"""
    return _singer_finder(singer_path) if _singer_finder else None


# ---------------------------------------------------------------- 导出


def save_part(project, part, file_path: str, encoding: str = SHIFT_JIS) -> None:
    """对应 `SavePart(project, part, filePath)`：导出一个 part 成 .ust 文本。"""
    track = project.tracks[part.track_no]
    ust_notes = _notes_to_ust_notes(project, track, part, part.notes)
    with io.open(file_path, 'w', encoding=encoding, errors='replace', newline='') as f:
        _write_header(project, part, f)
        for i, ust_note in enumerate(ust_notes):
            f.write('[#%04d]\n' % i)
            ust_note.write(f)
        _write_footer(f)


def _notes_to_ust_notes(project, track, part, notes) -> List[UstNote]:
    """对应 `NotesToUstNotes`：补 R 空拍 + **把速度变化插进音符序列**。

    ★ 速度插桩的两条分支（上游注释原文）：
      · 速度点落在音符**开头**或该音符不是 R → 直接挂在这张音符上（`ustNote.tempo`）
      · 否则（R 音符中间）→ **把 R 切成两半**，中间插一张带 tempo 的新音符
    """
    ust_notes: List[UstNote] = []
    position = 0
    for note in notes:
        if note.position < position:
            continue
        if note.position > position:
            ust_notes.append(UstNote(position=position, duration=note.position - position,
                                     lyric='R', note_num=60))
        ust_notes.append(UstNote.from_note(project, track, part, note))
        position = note.end

    tempo_index = 1
    for i in range(len(ust_notes)):
        ust_note = ust_notes[i]
        if tempo_index >= len(project.tempos):
            break
        pos = ust_note.position + part.position
        end = ust_note.position + ust_note.duration + part.position
        tempo = project.tempos[tempo_index]
        if pos <= tempo.position < end:
            if pos == tempo.position or ust_note.lyric.lower() != 'r':
                ust_note.tempo = tempo.bpm
                tempo_index += 1
            else:
                ust_note.duration = tempo.position - pos
                inserted = ust_note.clone()
                inserted.position = tempo.position - part.position
                inserted.duration = end - tempo.position
                inserted.tempo = tempo.bpm
                ust_notes.insert(i + 1, inserted)
                tempo_index += 1
    return ust_notes


def _write_header(project, part, w) -> None:
    """对应 `WriteHeader`。"""
    w.write('[#SETTING]\n')
    w.write('Tempo=%s\n' % _cs_num(project.time_axis.get_bpm_at_tick(part.position)))
    w.write('Tracks=1\n')
    if project.saved and project.file_path:
        w.write('Project=%s\n' % project.file_path.replace('.ustx', '.ust'))
    singer = getattr(project.tracks[part.track_no], 'singer_obj', None)
    if singer is not None and getattr(singer, 'id', None):
        w.write('VoiceDir=%s\n' % getattr(singer, 'location', ''))
    from . import resampler_item
    w.write('CacheDir=%s\n' % (getattr(resampler_item.host, 'cache_path', '') or ''))
    w.write('Mode2=True\n')


def _write_footer(w) -> None:
    """对应 `WriteFooter`。"""
    w.write('[#TRACKEND]\n')


# ---------------------------------------------------------------- 插件 diff


def write_plugin(project, part, first, last, file_path, encoding: str = SHIFT_JIS):
    """对应 `WritePlugin(...)` → 序列音符列表。

    输出带 `[#PREV]` / `[#NEXT]` 段的 diff 文本，供第三方插件回填。
    """
    prev = first.prev
    if prev is None:
        if first.position > 0:
            prev = _rest_before(first.position)
    elif first.position > prev.end:
        prev = _rest_after(prev.end, first.position)

    nxt = last.next
    if nxt is not None and nxt.position > last.end:
        nxt = _rest_after(last.end, nxt.position)

    sequence = []
    track = project.tracks[part.track_no]
    with io.open(file_path, 'w', encoding=encoding, errors='replace', newline='') as f:
        _write_header(project, part, f)
        position = 0
        if prev is not None:
            f.write('[#PREV]\n')
            UstNote.from_note(project, track, part, prev).write(f, for_plugin=True)
            position = prev.end
        note = first
        while note is not last.next:
            if note.position < position:
                note = note.next
                continue
            if note.position > position:
                f.write('[#%04d]\n' % len(sequence))
                spacer = _rest_after(position, note.position - position)
                sequence.append(spacer)
                UstNote.from_note(project, track, part, spacer).write(f, for_plugin=True)
            f.write('[#%04d]\n' % len(sequence))
            UstNote.from_note(project, track, part, note).write(f, for_plugin=True)
            position = note.end
            sequence.append(note)
            note = note.next
        if nxt is not None:
            f.write('[#NEXT]\n')
            UstNote.from_note(project, track, part, nxt).write(f, for_plugin=True)
    return sequence


def parse_plugin(project, part, first, last, sequence, diff_file,
                 encoding: str = SHIFT_JIS):
    """对应 `ParsePlugin(...)` → `(to_remove, to_add)`。

    diff 里的 `[#INSERT]` / `[#DELETE]` / 普通块分别对应插入 / 删除 / 替换；
    返回值里会滤掉"时长为 0"的与"新增的 R（原本没有对应空拍）"。
    """
    lines = _read_lines(diff_file, encoding)
    blocks = Ini.read_blocks(lines, diff_file, r'\[#\w+\]')
    to_remove, to_add = [], []
    index = 0
    track = project.tracks[part.track_no]
    for block in blocks:
        header = block.header
        if header in ('[#VERSION]', '[#SETTING]', '[#TRACKEND]', '[#PREV]', '[#NEXT]'):
            continue
        if header == '[#INSERT]':
            if index <= len(sequence):
                new_note = project.create_note()
                _parse_note(project, new_note, 0, 0, block.lines)
                new_note.after_load(project, track, part)
                sequence.insert(index, new_note)
                to_add.append(new_note)
                index += 1
        elif header == '[#DELETE]':
            if index < len(sequence):
                to_remove.append(sequence[index])
                sequence.pop(index)
        else:
            if index < len(sequence):
                to_remove.append(sequence[index])
                new_note = sequence[index].clone()
                _parse_note(project, new_note, 0, 0, block.lines)
                new_note.after_load(project, track, part)
                sequence[index] = new_note
                to_add.append(new_note)
                index += 1

    # 重新按序铺位置
    position = first.position
    for note in sequence:
        note.position = position
        position += note.duration

    rests = set(n.position for n in part.notes if n.lyric.lower() == 'r')
    to_add = [n for n in to_add if n.duration > 0
              and (n.lyric.lower() != 'r' or n.position in rests)]
    to_remove = [n for n in to_remove if n in part.notes]
    return to_remove, to_add


def write_for_set_param(project, file_path, otos, encoding: str = SHIFT_JIS) -> None:
    """对应 `WriteForSetParam`：导出一份"只含别名与长度"的最小 .ust（给采样器用）。"""
    with io.open(file_path, 'w', encoding=encoding, errors='replace', newline='') as f:
        f.write('[#SETTING]\n')
        f.write('Tempo=120\n')
        f.write('Tracks=1\n')
        if project.saved and project.file_path:
            f.write('Project=%s\n' % project.file_path.replace('.ustx', '.ust'))
        if otos:
            f.write('VoiceDir=%s\n' % os.path.dirname(otos[0].file))
        from . import resampler_item
        f.write('CacheDir=%s\n' % (getattr(resampler_item.host, 'cache_path', '') or ''))
        f.write('Mode2=True\n')
        for i, oto in enumerate(otos or []):
            f.write('[#%04d]\n' % i)
            f.write('Length=480\n')
            f.write('Lyric=%s\n' % oto.alias)
            f.write('NoteNum=60\n')


# ---------------------------------------------------------------- 小工具


def _rest_before(duration: int):
    """造一张"从 0 开始、长度 duration"的 R 音符（对应上游那三处 `UNote.Create()`）。"""
    from ...ustx.model import UNote
    n = UNote.create()
    n.duration = duration
    n.lyric = 'R'
    n.tone = 60
    return n


def _rest_after(start: int, duration: int):
    """造一张"从 start 开始、长度 duration"的 R 音符。"""
    from ...ustx.model import UNote
    n = UNote.create()
    n.position = start
    n.duration = duration
    n.lyric = 'R'
    n.tone = 60
    return n


def _cs_num(v) -> str:
    """按 C# 默认 `ToString()` 输出（整数不带 `.0`）。"""
    f = float(v)
    return str(int(f)) if f == int(f) else repr(f)