# -*- coding: utf-8 -*-
r"""真实曲线回写 —— **照搬** `OpenUtau.Core/Render/RealCurveUpdater.cs`（214 行）。

「真实曲线」= 渲染器**实际算出来的**包络/音高曲线（与用户在编辑器里手画的 `UCurve` 不同）。
本模块把渲染结果**回写**到 part 的 `UCurve.real_xs/real_ys` 上，供编辑器画真实波形。

## ★ 照搬时保留的语义
1. ★ **开头会插一个哨兵点** `(xs[0], -1)` —— `xs` 比 `ys` 里的曲线点多一个，
   值 `-1` 是"占位、不是真实值"的标记。这样即使渲染器只给一个点，
   `startTick`/`endTick` 也有定义（否则 `xs.Length > 0` 的校验会失败）。
2. ★ **坐标换算**：`tick = phrase_position - part_position + (int)tick` ——
   把"乐句内相对 tick"搬成"part 内绝对 tick"（渲染器报的是相对值）。
   值则 `int(value * 1000.0)`：C# 的 `(int)` 是**向零截断**，Python `int()` 同样是
   向零截断（不是 floor，负值才显差别）—— 照搬 `int()` 而不是 `math.floor`。
3. `count = min(len(ticks), len(values))`：两个数组长度不一致时**截到较短的那个**。
4. ★ `trim_to_coverage` 用**双指针**走一遍 `real_xs`（上游保证它有序），
   **只在真的发现过期点时才新建列表** —— 干净的情况零分配。照搬这个"懒分配"。
5. `merge_ranges` 先按 start 排序再合并；★ 合并条件是 `sorted[i].start <= last.end`
   （**相邻也算重叠**），end 取 `max`。
6. `apply` 要 `part in project.parts` 且 `phrase_hash` 在当前乐句哈希集合里 ——
   **过期乐句的更新被丢弃**（乐句已删/已改时的保护）。
7. `insert_range` 的 `BinarySearch` 未命中时用 `~insertIndex`（插入点），
   ★ **命中时继续向右跳过所有 `<= xs[0]` 的点** —— 保证同 x 的点按插入序追加而不是覆盖。

## ★ 载体差异
- C# `readonly struct RealCurveUpdate` → frozen dataclass。
- `IReadOnlySet<ulong>` → `set`。
- `BinarySearch` 用本仓库 `UCurve._search`（已复刻 C# 的两段返回语义）。
- `List<(int,int)>` 区间对 → `List[tuple]`。
"""

from dataclasses import dataclass, field
from typing import List, Optional, Sequence

from ..ustx.model import UCurve, UProject, UVoicePart


@dataclass(frozen=True)
class RealCurveUpdate:
    """对应 `readonly struct RealCurveUpdate`：一条待回写的真实曲线。"""

    abbr: str
    phrase_hash: int
    start_tick: int
    end_tick: int
    xs: List[int] = field(default_factory=list)
    ys: List[int] = field(default_factory=list)

    @property
    def is_valid(self) -> bool:
        """对应 `IsValid`：abbr 非空、end ≥ start、xy 等长且非空。"""
        return (bool(self.abbr) and self.end_tick >= self.start_tick
                and len(self.xs) == len(self.ys) and len(self.xs) > 0)


class RealCurveUpdater:
    """对应 `static class RealCurveUpdater`。"""

    @staticmethod
    def load_phrase_updates(part: UVoicePart, phrase) -> List[RealCurveUpdate]:
        """对应 `LoadPhraseUpdates`：渲染器不支持真实曲线时返回**空数组**。"""
        if not phrase.renderer.supports_real_curve:
            return []
        return RealCurveUpdater.build_updates(part, phrase,
                                              phrase.renderer.load_rendered_real_curves(phrase))

    @staticmethod
    def build_updates(part, phrase, results) -> List[RealCurveUpdate]:
        """对应内部 `BuildUpdates(part, phrase, results)`。"""
        return RealCurveUpdater.build_updates_core(
            part.position, phrase.position, phrase.hash, results)

    @staticmethod
    def build_updates_core(part_position: int, phrase_position: int, phrase_hash: int,
                           results) -> List[RealCurveUpdate]:
        """对应内部 `BuildUpdates(partPosition, phrasePosition, phraseHash, results)`。"""
        updates: List[RealCurveUpdate] = []
        for result in results or []:
            if not result.abbr or result.ticks is None or result.values is None:
                continue
            count = min(len(result.ticks), len(result.values))
            if count == 0:
                continue
            ticks = [phrase_position - part_position + int(t)
                     for t in result.ticks[:count]]
            # ★ C# 的 `(int)(value * 1000.0)` 是向零截断，Python `int()` 同义
            values = [int(v * 1000.0) for v in result.values[:count]]
            start_tick = min(ticks)
            end_tick = max(ticks)
            # ★ 哨兵点 (xs[0], -1)：让"只有一个点"时 start/end 也有定义
            xs = [ticks[0]] + ticks
            ys = [-1] + values
            updates.append(RealCurveUpdate(result.abbr, phrase_hash,
                                           start_tick, end_tick, xs, ys))
        return updates

    @staticmethod
    def apply(project, part, updates) -> bool:
        """对应 `Apply(project, part, updates)`：用当前乐句哈希集合做闸门。"""
        if not updates or part not in (project.parts or []):
            return False
        phrase_hashes = set(p.hash for p in part.render_phrases)
        return RealCurveUpdater.apply_with_hashes(project, part, updates, phrase_hashes)

    @staticmethod
    def apply_with_hashes(project, part, updates, phrase_hashes) -> bool:
        """对应内部 `Apply(project, part, updates, phraseHashes)`。"""
        changed = False
        for update in updates:
            if not update.is_valid or update.phrase_hash not in phrase_hashes:
                continue
            changed = RealCurveUpdater._apply_update(project, part, update) or changed
        return changed

    @staticmethod
    def trim_to_coverage(project, part, ranges) -> bool:
        """对应 `TrimToCoverage`：删掉不在 `ranges` 并集内的 `realXs/realYs` 点。

        清掉"乐句缩小/移动/拆分/删除"后残留的幽灵曲线。上游注释：
        realXs 有序 → 单趟双指针即可判定；**只在发现过期点时才新建列表**。
        """
        if part not in (project.parts or []) or not ranges:
            return False
        merged = RealCurveUpdater.merge_ranges(ranges)
        changed = False
        for curve in part.curves:
            if RealCurveUpdater._trim_curve(curve, merged):
                changed = True
        return changed

    @staticmethod
    def _trim_curve(curve: UCurve, merged) -> bool:
        """对应 `TrimCurve`：★ 懒分配 —— 没发现过期点就一个列表都不新建。"""
        xs, ys = curve.real_xs, curve.real_ys
        if not xs:
            return False
        new_xs = None
        new_ys = None
        ri = 0
        for i, x in enumerate(xs):
            while ri < len(merged) and merged[ri][1] < x:
                ri += 1
            keep = ri < len(merged) and x >= merged[ri][0]
            if keep:
                if new_xs is not None:
                    new_xs.append(x)
                    new_ys.append(ys[i])
            elif new_xs is None:
                # ★ 第一个过期点：此时才建列表，并把之前保住的点补进去
                new_xs = list(xs[:i])
                new_ys = list(ys[:i])
        if new_xs is None:
            return False
        curve.real_xs = new_xs
        curve.real_ys = new_ys
        return True

    @staticmethod
    def merge_ranges(ranges) -> List[tuple]:
        """对应 `MergeRanges`：按 start 排序后合并（★ **相邻**区间也合并）。"""
        sorted_ranges = sorted(ranges, key=lambda r: r[0])
        merged = [tuple(sorted_ranges[0])]
        for r in sorted_ranges[1:]:
            last = merged[-1]
            if r[0] <= last[1]:
                merged[-1] = (last[0], max(last[1], r[1]))
            else:
                merged.append(tuple(r))
        return merged

    @staticmethod
    def _apply_update(project, part, update: RealCurveUpdate) -> bool:
        """对应 `ApplyUpdate`：找到（或新建）对应 abbr 的曲线，删旧区间再插新点。"""
        curve = next((c for c in part.curves if c.abbr == update.abbr), None)
        if curve is None:
            track = project.tracks[part.track_no]
            descriptor = track.try_get_exp_descriptor(project, update.abbr)
            if descriptor is None:
                return False
            curve = UCurve(abbr=update.abbr, descriptor=descriptor)
            part.curves.append(curve)
        RealCurveUpdater.remove_range(curve.real_xs, curve.real_ys,
                                      update.start_tick, update.end_tick)
        RealCurveUpdater.insert_range(curve.real_xs, curve.real_ys, update.xs, update.ys)
        return True

    @staticmethod
    def remove_range(xs: List[int], ys: List[int], start_tick: int, end_tick: int) -> None:
        """对应 `RemoveRange`：删掉闭区间 `[startTick, endTick]` 内的点（倒序遍历）。"""
        for i in range(len(xs) - 1, -1, -1):
            if start_tick <= xs[i] <= end_tick:
                del xs[i]
                del ys[i]

    @staticmethod
    def insert_range(target_xs: List[int], target_ys: List[int],
                     xs: Sequence[int], ys: Sequence[int]) -> None:
        """对应 `InsertRange`：按序插入；★ 命中同 x 时**向右跳过**而不是覆盖。"""
        if not xs:
            return
        found, index = UCurve._search(target_xs, xs[0])
        if found:
            # ★ 上游：命中后继续右移，跳过所有 `<= xs[0]` 的点（同 x 追加而非替换）
            while index < len(target_xs) and target_xs[index] <= xs[0]:
                index += 1
        target_xs[index:index] = list(xs)
        target_ys[index:index] = list(ys)
