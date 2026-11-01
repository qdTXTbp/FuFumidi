# -*- coding: utf-8 -*-
"""6.5.0 智能分轨转录：角色、固定音色、轨道预算（纯逻辑，无 IO）。

角色默认值只在这里维护；main/stem-workflow.js 与 engine/stem_merge.py 都读这一份。
"""
from __future__ import annotations

ROLE_ORDER = ["vocals", "drums", "bass", "piano", "guitar", "other"]

ROLE_DEFAULTS = {
    "vocals": {"label": "人声", "program": 52, "channel": 0, "drum": False},
    "drums": {"label": "鼓", "program": 0, "channel": 9, "drum": True},
    "bass": {"label": "贝斯", "program": 33, "channel": 1, "drum": False},
    "piano": {"label": "钢琴", "program": 0, "channel": 2, "drum": False},
    "guitar": {"label": "吉他", "program": 24, "channel": 3, "drum": False},
    "other": {"label": "其他", "program": 48, "channel": 4, "drum": False},
}

_ROLE_WORDS = (
    ("vocals", ("vocal", "voice", "sing", "choir", "人声", "唱")),
    ("drums", ("drum", "percussion", "kick", "snare", "鼓")),
    ("bass", ("bass", "贝斯", "低音")),
    ("piano", ("piano", "keys", "keyboard", "钢琴")),
    ("guitar", ("guitar", "吉他")),
)


def classify_role(name: str) -> str:
    """轨名/文件名 → 六个角色之一；认不出归 other。"""
    s = str(name or "").lower()
    for role, words in _ROLE_WORDS:
        if any(w in s for w in words):
            return role
    return "other"


def role_default(role: str) -> dict:
    return dict(ROLE_DEFAULTS.get(role, ROLE_DEFAULTS["other"]))


def channel_for(role: str, used: set | None = None) -> int:
    """角色首选通道；被占用时轮转，鼓始终 9。"""
    used = used if used is not None else set()
    pref = int(role_default(role)["channel"])
    if pref == 9:
        return 9
    if pref not in used:
        return pref
    for ch in range(16):
        if ch != 9 and ch not in used:
            return ch
    return 0


def _score(c: dict) -> float:
    n = max(1, int(c.get("noteCount") or c.get("note_count") or 0))
    conf = c.get("confidence")
    conf = 0.75 if conf is None else max(0.0, min(1.0, float(conf)))
    weight = 1.25 if c.get("role") in ("vocals", "drums", "bass") else 1.0
    return (n ** 0.5) * conf * weight


def resolve_target(target, n_candidates: int) -> int:
    """auto = 6..12；数字夹到 1..n；all = n。"""
    all_c = max(0, int(n_candidates or 0))
    if target in (None, "", "auto"):
        return min(12, max(6, all_c))
    if target == "all":
        return all_c
    try:
        v = int(target)
    except (TypeError, ValueError):
        return min(12, max(6, all_c))
    return max(1, min(v, all_c)) if all_c else 0


def select_tracks(candidates, target="auto"):
    """按轨道预算返回 [{candidate, action, mergedInto}]。

    - 每个核心角色最多保留 1 条；
    - 剩余按 score 排序；
    - target 不足时低分轨合并到同角色（没有同角色则 other）；
    - target 大于候选数时全部保留（拆分子轨由 merge 层负责）。
    """
    items = [dict(c) for c in (candidates or [])]
    for c in items:
        c["role"] = c.get("role") or classify_role(c.get("name") or c.get("stem") or "")
    if not items:
        return []
    n = len(items)
    want = resolve_target(target, n)
    if want >= n:
        return [{**c, "action": "keep"} for c in items]

    by_role = {}
    for c in items:
        by_role.setdefault(c["role"], []).append(c)
    keep = []
    rest = []
    core_roles = ["drums", "vocals", "bass", "piano", "guitar"]
    for role in core_roles:
        group = sorted(by_role.get(role, []), key=_score, reverse=True)
        if group:
            keep.append(group[0])
            rest.extend(group[1:])
    keep.sort(key=_score, reverse=True)
    rest.sort(key=_score, reverse=True)
    if want <= len(keep):
        keep = keep[:want]
    else:
        keep.extend(rest[: max(0, want - len(keep))])
    kept = {id(x) for x in keep}
    out = []
    for c in items:
        if id(c) in kept or any(c is k for k in keep):
            out.append({**c, "action": "keep"})
        else:
            # 合并到同角色已保留轨；没有就 other
            same = next((k for k in keep if k["role"] == c["role"]), None)
            into = same or next((k for k in keep if k["role"] == "other"), None)
            out.append({**c, "action": "merge" if into else "drop",
                        "mergedInto": into.get("id") if into else None})
    return out
