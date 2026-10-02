# -*- coding: utf-8 -*-
"""文档快照与**增量失效** —— **照搬** `OpenUtau.Core/Pipeline/Snapshots.cs`（216 行）。

这套东西解决的问题是"改了一个音符，别的地方能不能复用"：
命令（Command）在改动时声明自己的**爆炸半径**（`ImpactSet`），`DocumentSnapshotStore`
按半径丢掉受影响的条目；没被丢掉的（歌手的轨道、没动过的 part）下一条命令继续可用。

三块：
1. `TimeAxisSnapshot` / `SubbankView` / `TrackSnapshot` / `PartSnapshot` /
   `ProjectSnapshot`：**不变副本**。拿快照的人不再读活文档。
2. `DocumentSnapshotStore`：按 `PartId` / `TrackNo` 存这些副本。
3. `Invalidate(ImpactSet)`：唯一的失效入口 —— **混音改动（Mix）不失效任何东西**。

## 与 C# 的载体差异（不是行为差异）
- `SingletonBase<DocumentSnapshotStore>` 的 `Inst` → 模块级单例 `store`
  （Python 没有 `SingletonBase`）。`DocumentSnapshotStore()` 仍可自由新建（测试用）。
- `track.Singer` → `track.singer_obj`（见 `pipeline_source.py` 的说明）。
- `track.Muted` → `track.mute`。
- C# 内部用 `lock (lockObj)`；这里用 `threading.Lock`。
- `TimeAxisSnapshot.Of(axis)` 取 `axis.Timestamp`。我们的 `TimeAxis.build_segments`
  把 `timestamp` 固定写 0（C# 是 `DateTime.Now.ToFileTimeUtc()`）—— 那是**已有**的
  载体差异，快照只负责原样搬运。
"""

import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from .pipeline_identities import DocRevision, ImpactKind, ImpactSet, PartId
from .singer import USingerType


@dataclass
class TimeAxisSnapshot:
    """对应 C# 的 `TimeAxisSnapshot`：某一刻的时间轴副本 + 它出自哪个版本。"""

    axis: Any
    timestamp: int

    def __post_init__(self):
        # C# 的构造函数就 `Axis = axis.Clone()` —— 快照必须与活对象脱钩
        self.axis = self.axis.clone()

    @classmethod
    def of(cls, axis) -> 'TimeAxisSnapshot':
        return cls(axis, axis.timestamp)


@dataclass
class SubbankView:
    """对应 C# 的 `record SubbankView(string Color, string Suffix)`（值语义）。"""

    color: str = ''
    suffix: str = ''


@dataclass
class TrackSnapshot:
    """对应 C# 的 `TrackSnapshot`：一条轨的**稳定**配置（不是逐键的文档状态）。"""

    track_no: int = 0
    renderer_id: Optional[str] = None
    resampler: Optional[str] = None
    wavtool: Optional[str] = None
    singer_id: Optional[str] = None
    singer_type: int = USingerType.CLASSIC
    volume: float = 0
    pan: float = 0
    muted: bool = False
    subbanks: List[SubbankView] = field(default_factory=list)

    @classmethod
    def of(cls, track) -> 'TrackSnapshot':
        """对应 C# 的 `TrackSnapshot.Of(UTrack)`。

        ★ `(singer?.Subbanks ?? Array.Empty<USubbank>())`：歌手为 null、或歌声库的
        `Subbanks` 为 null，都落到空列表 —— 这两个 null 都得兜住。
        """
        singer = track.singer_obj
        subbanks = (singer.subbanks if singer is not None else None) or []
        return cls(
            track_no=track.track_no,
            renderer_id=track.renderer_settings.renderer,
            resampler=track.renderer_settings.resampler,
            wavtool=track.renderer_settings.wavtool,
            singer_id=singer.id if singer is not None else None,
            # `singer?.SingerType ?? USingerType.Classic`
            singer_type=singer.singer_type if singer is not None else USingerType.CLASSIC,
            volume=track.volume,
            pan=track.pan,
            muted=track.mute,
            subbanks=[SubbankView(color=s.color, suffix=s.suffix) for s in subbanks],
        )


@dataclass
class PartSnapshot:
    """对应 C# 的 `PartSnapshot`：一个 part 在某一版文档上的快照。

    `source` 为 None 表示"这个 part 还没有可用的音素"（`PhraseSource.FromPart`
    返回了 null），不是"没建过快照"。
    """

    part_id: Optional[PartId] = None
    track_no: int = 0
    revision: Optional[DocRevision] = None
    source: Any = None
    generation: int = 0


@dataclass
class ProjectSnapshot:
    """对应 C# 的 `ProjectSnapshot`：一次读全（时间轴 + 所有轨 + 所有已快照的 part）。"""

    revision: Optional[DocRevision] = None
    time_axis: Optional[TimeAxisSnapshot] = None
    tracks: List[TrackSnapshot] = field(default_factory=list)
    parts: Dict[PartId, PartSnapshot] = field(default_factory=dict)


class DocumentSnapshotStore:
    """对应 C# 的 `DocumentSnapshotStore`（内部加锁，可跨线程校验）。"""

    def __init__(self):
        self._lock = threading.Lock()
        self._revision = DocRevision(0)
        self._parts: Dict[PartId, PartSnapshot] = {}
        self._tracks: Dict[int, TrackSnapshot] = {}

    # ------------------------------------------------------------------ 写入

    @property
    def revision(self) -> DocRevision:
        with self._lock:
            return self._revision

    def set_revision(self, new_revision: DocRevision) -> None:
        with self._lock:
            self._revision = new_revision

    def set_track(self, track) -> None:
        with self._lock:
            self._tracks[track.track_no] = TrackSnapshot.of(track)

    def set_part(self, part, source) -> None:
        with self._lock:
            # `source?.Generation ?? 0`
            self._parts[part.id] = PartSnapshot(
                part_id=part.id,
                track_no=part.track_no,
                revision=self._revision,
                source=source,
                generation=source.generation if source is not None else 0,
            )

    def remove_part(self, part_id: PartId) -> None:
        with self._lock:
            self._parts.pop(part_id, None)

    # ------------------------------------------------------------------ 失效

    def invalidate(self, impact: ImpactSet) -> None:
        """丢掉一条命令的爆炸半径内的条目。

        ★ 两处容易搬错的：
        1. `None` **和** `Mix` 都是**什么都不做** —— 混音改动与快照无关（音轨的
           音量/声像不参与乐句构建），别"顺手"清一遍。
        2. `Curves` 与 `Part` **同一处理**：曲线变了也要重取这个 part 的乐句快照。
        """
        with self._lock:
            kind = impact.kind
            if kind == ImpactKind.NONE or kind == ImpactKind.MIX:
                return
            if kind == ImpactKind.PART or kind == ImpactKind.CURVES:
                if impact.part is not None:
                    self._parts.pop(impact.part.id, None)
                return
            if kind == ImpactKind.TRACK:
                if impact.track is not None:
                    track_no = impact.track.track_no
                    self._tracks.pop(track_no, None)
                    for part_id in [pid for pid, snap in self._parts.items()
                                    if snap.track_no == track_no]:
                        self._parts.pop(part_id, None)
                return
            if kind == ImpactKind.PROJECT:
                self._parts.clear()

    # ------------------------------------------------------------------ 读取

    def try_get_part(self, part_id: PartId):
        """对应 C# 的 `TryGetPart(id, out snapshot)` → 返回 `(found, snapshot)`。"""
        with self._lock:
            snapshot = self._parts.get(part_id)
            return (snapshot is not None, snapshot)

    def try_get_track(self, track_no: int):
        """对应 C# 的 `TryGetTrack(trackNo, out snapshot)` → 返回 `(found, snapshot)`。"""
        with self._lock:
            snapshot = self._tracks.get(track_no)
            return (snapshot is not None, snapshot)

    def snapshot(self, project) -> ProjectSnapshot:
        with self._lock:
            return ProjectSnapshot(
                revision=self._revision,
                time_axis=TimeAxisSnapshot.of(project.time_axis),
                tracks=sorted(self._tracks.values(), key=lambda t: t.track_no),
                parts=dict(self._parts),
            )

    def forget_all(self) -> None:
        with self._lock:
            self._parts.clear()
            self._tracks.clear()


#: 对应 C# 的 `DocumentSnapshotStore.Inst`（`SingletonBase` 单例）。
store = DocumentSnapshotStore()
