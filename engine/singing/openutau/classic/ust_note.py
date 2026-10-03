# -*- coding: utf-8 -*-
"""`.ust` 单个音符块的读写 —— **照搬** `OpenUtau.Core/Classic/UstNote.cs`（394 行）。

`.ust` 是 UTAU 的老工程格式：Shift-JIS 文本，`[#[setting]]` 段 + 每个音符一个
`[#NNNN]` 块（`Length=` / `Lyric=` / `NoteNum=` / `PBS=` / `PBW=` / `PBY=` / `PBM=` …）。
本类只管**一个音符块**的解析与写回；整工程的编排见 `Ust.cs`（`classic/ust.py`）。

## ★ 照搬时保留的语义（这个解析器很容易被"简化"掉）
1. ★ **`ParseFloat("")` 返回 True、值 0** —— 空串是**合法**的数值。
   所以 `Length=`（空）不会报错，而是长度 0。别改成"空串即错"。
2. ★ **UST 2.0 与 < 2.0 的两套时值语义**（上游注释画了那张表）：
   ```
   UST < 2.0 : length        | length
               note1         | R
   UST = 2.0  : length1      | length2
               dur1          | dur2
               note1         | note2
               delta2
   ```
   判定：`delta`/`duration`/`length` **三者齐全** → 2.0 语义
   （`position = lastNotePos + delta`、`duration = duration`）；
   **只有 `length`** → < 2.0 语义（`position = lastNoteEnd`、`duration = length`）。
   两者都不全 → **保留构造函数里已有的 position/duration**（不覆盖）。
3. `Lyric` 的前导 **`?`** 被剥掉（UTAU 用 `?` 前缀表示"这是别名不是歌词"）。
4. `Envelope=` 解析失败的值按 **`-1`**（不是 0）填；不足 7 段直接**返回不改**。
   `decay = 100 - (int)v3`。★ 上游把 p4/p5/v5 赋了值却没用（死代码），照搬。
5. ★ `ParsePitchBend` 的三个分支互斥且顺序不能换：
   - 只有 `w` 对得上点数 → **只改 X**（x 累加）
   - 只有 `y` 对得上 → **只改 Y**
   - 都不匹配 → 先把 `y` 用 0 补齐到 `w` 的长度，再**删掉除首点外的所有点**重建
   ★ 最后只有 `points.Count > 1` 才写回 `this.pitch`（单点弯音会被丢弃）。
6. `PBM` 的形状字母：`r`→`o`、`s`→`l`、`j`→`i`、其余→`io`。
   ★ `PBM` 长度 = **点数**（含首点），而 `PBW`/`PBY` 长度 = **点数 - 1**。
7. `Write` **总是**写一行 `PreUtterance=`（**空值**），位置在 `NoteNum` 之后。
8. `WritePitch` 只在 **点数 ≥ 2** 时才写；`WriteVibrato` 只在 `length > 0` 时才写。
9. `VBR=` 的字段顺序：`length,period,depth,in,out,shift,drift`。

## ★ 载体差异
- C# 的构造重载 `UstNote(project, track, part, note)` → 改成类方法 `from_note(...)`。
- `IniLine` 在本仓库没有 `ToString()`，异常消息里用 `ini_line.line` 代替（信息等价）。
- 写文件用 `io.open(..., encoding='shift_jis')`；Shift-JIS 的 `errors` 用 `replace`，
  避免一个坏字节让整份 .ust 读不出来（**这是本仓库的放宽，上游会抛**）。

## ★ 读 VBR 时会看到"数值被改了"——不是本文件的 bug
`UVibrato.__setattr__` **照搬了 C# 属性 setter 的范围钳制**（见 `ustx/model.py` 的 `_CLAMP`）：
`length`/`in`/`out` 是 `0..100` 的**百分比**（UTAU 的 VBR 首字段就是百分比，不是毫秒），
`period` 是 `5..500`，`depth` 是 `5..200`。
所以 `VBR=180,...` 解析后 `length` 会变成 `100` —— 这与上游一致，别当 bug 修。
另外 `in`/`out` 之间还有 `out = min(out, 100 - in)` 的相互约束（C# setter 原话）。
"""

from dataclasses import dataclass, field
from typing import Any, List, Optional, Tuple

from ...ustx.format import Ustx

#: 上游 `const string format = "<param>=<value>"`（只在异常消息里用）
_FORMAT = '<param>=<value>'

#: 上游 `static readonly Encoding ShiftJIS`
SHIFT_JIS = 'shift_jis'


def parse_float(s: str) -> Tuple[bool, float]:
    """对应 `static bool ParseFloat(string s, out float value)` → `(ok, value)`。

    ★ **空串返回 (True, 0.0)** —— 上游 `string.IsNullOrEmpty(s)` 直接给 0 并返回 true。
    """
    if not s:
        return True, 0.0
    try:
        return True, float(s.strip())
    except ValueError:
        return False, 0.0


class FileFormatError(Exception):
    """对应 C# 的 `System.IO.FileFormatException`。"""


@dataclass
class UstNote:
    """对应 `UstNote`（C# 是 internal class，这里保持字段同名）。"""

    lyric: str = ''
    position: int = 0
    duration: int = 0
    note_num: int = 0
    tempo: Optional[float] = None
    velocity: Optional[int] = None
    intensity: Optional[int] = None
    modulation: Optional[int] = None
    decay: Optional[int] = None
    flags: Optional[str] = None
    filename: Optional[str] = None
    alias: Optional[str] = None
    pitch: Any = None
    vibrato: Any = None

    # ---------------------------------------------------------------- 从 UNote 构造

    @classmethod
    def from_note(cls, project, track, part, note) -> 'UstNote':
        """对应 `UstNote(UProject, UTrack, UVoicePart, UNote)`：UNote → .ust 音符。

        ★ 音素相关字段（velocity/intensity/modulation/flags/filename/alias）只有在
          **这个音符恰好有一个音素**时才填（`part.phonemes.FirstOrDefault(p => p.Parent == note)`）。
          没有音素就只写 Length/Lyric/NoteNum/弯音/颤音 —— 这正是 .ust 的最小形态。
        """
        from ...ustx.model import UPitch, UVibrato

        u = cls(lyric=note.lyric, position=note.position,
                duration=note.duration, note_num=note.tone)

        phoneme = next((p for p in part.phonemes if p.parent is note), None)
        if phoneme is not None:
            u.velocity = int(phoneme.get_expression(project, track, Ustx.VEL)[0])
            u.intensity = int(phoneme.get_expression(project, track, Ustx.VOL)[0])
            u.modulation = int(phoneme.get_expression(project, track, Ustx.MOD)[0])
            u.flags = _flags_to_string(phoneme.get_resampler_flags(project, track))
            oto = getattr(phoneme, 'oto', None)
            if oto is not None and getattr(oto, 'file', None):
                import os
                singer_loc = getattr(getattr(track, 'singer_obj', None), 'location', '') or ''
                u.filename = _relpath(singer_loc, oto.file)
                u.alias = oto.alias

        u.pitch = note.pitch.clone() if note.pitch is not None else UPitch()
        u.vibrato = note.vibrato.clone() if note.vibrato is not None else UVibrato()
        return u

    def clone(self) -> 'UstNote':
        """对应 `Clone()`（`pitch`/`vibrato` 为 null 时保持 null —— C# 用 `?.Clone()`）。"""
        return UstNote(
            lyric=self.lyric, position=self.position, duration=self.duration,
            note_num=self.note_num, tempo=self.tempo, velocity=self.velocity,
            intensity=self.intensity, modulation=self.modulation, decay=self.decay,
            flags=self.flags, filename=self.filename, alias=self.alias,
            pitch=self.pitch.clone() if self.pitch is not None else None,
            vibrato=self.vibrato.clone() if self.vibrato is not None else None)

    # ---------------------------------------------------------------- 写

    def write(self, writer, for_plugin: bool = False) -> None:
        """对应 `Write(StreamWriter, bool forPlugin = false)`。"""
        writer.write('Length=%d\n' % self.duration)
        writer.write('Lyric=%s\n' % self.lyric)
        writer.write('NoteNum=%d\n' % self.note_num)
        writer.write('PreUtterance=\n')              # ★ 总是写，且是空值
        if self.tempo is not None:
            writer.write('Tempo=%s\n' % _num(self.tempo))
        if self.velocity is not None:
            writer.write('Velocity=%d\n' % self.velocity)
        if self.intensity is not None:
            writer.write('Intensity=%d\n' % self.intensity)
        if self.modulation is not None:
            writer.write('Modulation=%d\n' % self.modulation)
        if self.flags:
            writer.write('Flags=%s\n' % self.flags)
        if for_plugin:
            if self.filename:
                writer.write('@filename=%s\n' % self.filename)
            if self.alias:
                writer.write('@alias=%s\n' % self.alias)
        self._write_pitch(writer)
        self._write_vibrato(writer)

    def _write_pitch(self, writer) -> None:
        """对应 `WritePitch`：PBS/PBW/PBY/PBM（**点数 ≥ 2** 才写）。"""
        if self.pitch is None:
            return
        points = self.pitch.data
        if len(points) < 2:
            return
        writer.write('PBS=%s;%s\n' % (_num(points[0].x), _num(points[0].y)))
        shape_to_char = {'o': 'r', 'l': 's', 'i': 'j', 'io': ''}
        # ★ PBM 是**每个点一个**（含首点），PBW/PBY 是从第 2 个点起的增量
        pbm = [shape_to_char.get(p.shape, '') for p in points]
        pbw, pby = [], []
        for i in range(1, len(points)):
            pbw.append(_num(points[i].x - points[i - 1].x))
            pby.append(_num(points[i].y))
        writer.write('PBW=%s\n' % ','.join(pbw))
        writer.write('PBY=%s\n' % ','.join(pby))
        writer.write('PBM=%s\n' % ','.join(pbm))

    def _write_vibrato(self, writer) -> None:
        """对应 `WriteVibrato`（`length > 0` 才写），字段序 length,period,depth,in,out,shift,drift。"""
        v = self.vibrato
        if v is None or not (v.length or 0) > 0:
            return
        writer.write('VBR=%s,%s,%s,%s,%s,%s,%s\n' % (
            _num(v.length), _num(v.period), _num(v.depth),
            _num(v.vib_in), _num(v.vib_out), _num(v.shift), _num(v.drift)))

    # ---------------------------------------------------------------- 解析

    def parse(self, last_note_pos: int, last_note_end: int, ini_lines) -> Optional[float]:
        """对应 `Parse(...)` → `noteTempo`（没有 `Tempo=` 行就是 `None`）。"""
        pbs = pbw = pby = pbm = None
        delta = duration = length = None

        for ini_line in ini_lines:
            line = getattr(ini_line, 'line', ini_line)
            parts = line.split('=', 1)
            if len(parts) != 2:
                raise FileFormatError('Line does not match format %s.\n%s' % (_FORMAT, line))
            param = parts[0].strip()
            error = False
            is_float, float_value = parse_float(parts[1])

            if param == 'Length':
                error = error or not is_float
                length = int(float_value)
            elif param == 'Delta':
                error = error or not is_float
                delta = int(float_value)
            elif param == 'Duration':
                error = error or not is_float
                duration = int(float_value)
            elif param == 'Lyric':
                self._parse_lyric(parts[1])
            elif param == 'NoteNum':
                error = error or not is_float
                self.note_num = int(float_value)
            elif param == 'Velocity':
                error = error or not is_float
                self.velocity = int(float_value)
            elif param == 'Intensity':
                error = error or not is_float
                self.intensity = int(float_value)
            elif param == 'Modulation':
                error = error or not is_float
                self.modulation = int(float_value)
            elif param == 'VoiceOverlap':
                error = error or not is_float
                # ★ 上游这行被注释掉了（`note.phonemes[0].overlap = floatValue`）
            elif param == 'PreUtterance':
                error = error or not is_float
                # ★ 同上，被注释掉了
            elif param == 'Envelope':
                self._parse_envelope(parts[1], line)
            elif param == 'VBR':
                self._parse_vibrato(parts[1], line)
            elif param == 'PBS':
                pbs = parts[1]
            elif param == 'PBW':
                pbw = parts[1]
            elif param == 'PBY':
                pby = parts[1]
            elif param == 'PBM':
                pbm = parts[1]
            elif param == 'Tempo':
                if is_float:
                    self.tempo = float_value
            elif param == 'Flags':
                self.flags = parts[1]
            # default: 未知参数**静默忽略**（照搬）
            if error:
                raise FileFormatError('Invalid %s\n$%s' % (param, line))

        # ★ 时值：UST 2.0 vs < 2.0（见模块 docstring 第 2 条）
        if delta is not None and duration is not None and length is not None:
            self.position = last_note_pos + delta
            self.duration = duration
        elif length is not None:
            self.position = last_note_end
            self.duration = length
        # 两者都不全 → 保留构造时的 position/duration（不覆盖）

        self._parse_pitch_bend(pbs, pbw, pby, pbm)
        return self.tempo

    def _parse_lyric(self, ust: str) -> None:
        """对应 `ParseLyric`：剥掉前导 `?`（UTAU 用它表示"这是别名"）。"""
        if ust.startswith('?'):
            ust = ust[1:]
        self.lyric = ust

    def _parse_envelope(self, ust: str, ust_line: str) -> None:
        """对应 `ParseEnvelope`：解析失败按 **-1** 填；不足 7 段直接返回。"""
        # p1,p2,p3,v1,v2,v3,v4,%,p4,p5,v5
        parts = []
        for s in ust.split(','):
            ok, v = parse_float(s)
            parts.append(v if ok else -1.0)
        if len(parts) < 7:
            return
        v3 = parts[5]
        if len(parts) == 11:
            _p4, _p5, _v5 = parts[8], parts[9], parts[10]   # ★ 上游赋了值却没用
        self.decay = 100 - int(v3)

    def _parse_pitch_bend(self, pbs, pbw, pby, pbm) -> None:
        """对应 `ParsePitchBend`：PBS 定位起点，PBW/PBY 增量，PBM 形状。"""
        from ...ustx.model import PitchPoint, PitchPointShape, UPitch

        pitch = self.pitch.clone() if self.pitch is not None else UPitch()
        points = pitch.data

        # ---- PBS（分号或逗号分隔）
        if pbs and pbs.strip():
            parts = pbs.split(';') if ';' in pbs else pbs.split(',')
            ok_x, pbs_x = parse_float(parts[0]) if len(parts) >= 1 else (False, 0.0)
            ok_y, pbs_y = parse_float(parts[1]) if len(parts) >= 2 else (False, 0.0)
            pbs_x = pbs_x if ok_x else 0.0
            pbs_y = pbs_y if ok_y else 0.0
            if points:
                points[0] = PitchPoint(x=int(pbs_x), y=int(pbs_y))
            else:
                points.append(PitchPoint(x=int(pbs_x), y=int(pbs_y)))
        if not points:
            return

        x = points[0].x
        w: List[float] = []
        y: List[float] = []
        if pbw and pbw.strip():
            for s in pbw.split(','):
                ok, v = parse_float(s)
                w.append(v if ok else 0.0)
        if pby and pby.strip():
            for s in pby.split(','):
                ok, v = parse_float(s)
                y.append(v if ok else 0.0)

        if w or y:
            if len(points) > 1 and len(points) - 1 == len(w) and not y:
                for i in range(len(w)):                    # 只改 X
                    x += w[i]
                    points[i + 1].x = int(x)
            elif len(points) > 1 and not w and len(points) - 1 == len(y):
                for i in range(len(y)):                    # 只改 Y
                    points[i + 1].y = int(y[i])
            else:
                while len(y) < len(w):
                    y.append(0.0)
                for i in range(len(points) - 1, 0, -1):     # 只留首点，再重建
                    points.pop(i)
                for i in range(len(w)):
                    x += w[i]
                    points.append(PitchPoint(x=int(x), y=int(y[i])))

        # ---- PBM（形状字母）
        if pbm and pbm.strip():
            char_to_shape = {'r': PitchPointShape.O, 's': PitchPointShape.L,
                             'j': PitchPointShape.I}
            for i, m in enumerate(pbm.split(',')):
                if i >= len(points):
                    break
                points[i].shape = char_to_shape.get(m, PitchPointShape.IO)

        # ★ 只在多于一个点时才写回（单点弯音会被丢掉）
        if len(points) > 1:
            self.pitch = pitch

    def _parse_vibrato(self, ust: str, ust_line: str) -> None:
        """对应 `ParseVibrato`：按位置取 7 个字段，解析失败按 0。"""
        from ...ustx.model import UVibrato

        args = []
        for s in ust.split(','):
            ok, v = parse_float(s)
            args.append(v if ok else 0.0)
        v = UVibrato()
        if len(args) >= 1:
            v.length = args[0]
        if len(args) >= 2:
            v.period = args[1]
        if len(args) >= 3:
            v.depth = args[2]
        if len(args) >= 4:
            v.vib_in = args[3]
        if len(args) >= 5:
            v.vib_out = args[4]
        if len(args) >= 6:
            v.shift = args[5]
        if len(args) >= 7:
            v.drift = args[6]
        self.vibrato = v


def _flags_to_string(flags) -> str:
    """对应 `FlagsToString(Tuple<string,int?,string>[])`：key + 有值才接数值。"""
    out = []
    for item in flags or []:
        key = item[0]
        value = item[1] if len(item) > 1 else None
        out.append(key)
        if value is not None:
            out.append(str(int(value)))
    return ''.join(out)


def _num(v) -> str:
    """按 C# 的默认 `ToString()` 输出浮点（整数不带 `.0`）。"""
    if isinstance(v, int):
        return str(v)
    f = float(v)
    return str(int(f)) if f == int(f) else repr(f)


def _relpath(base: str, target: str) -> str:
    """对应 `Path.GetRelativePath`（跨盘符时 .NET 返回原路径）。"""
    import os
    try:
        return os.path.relpath(target, base or '.')
    except ValueError:
        return target