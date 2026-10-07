# -*- coding: utf-8 -*-
"""应用侧 per-note 参数 → 音素级表达式（vel / vol / genc / brec）。

★ 为什么必须在**音素化之后**调用：表达式按音素下标匹配
  （`UPhoneme.get_expression` 的 `exp.index == phoneme.index`），
  音素化之前不知道每个音符会产出几个音素。

上游对应物：`NoteBatchEdits.cs` 的 SetPhonemeExpression（UI 阶段逐音素设置，
可每音素不同值）；应用侧只有音符级一个值 → 挂到该音符**所有音素**各一条。
没传的字段不挂（走描述符默认值，不假装生效）。

值域（与曲线通路同一约定，见 engine_openutau.build_part 的注释）：
  velocity / volume  0..100 直传（vel/vol 描述符同值域）
  gender            -100..100 直传（genc 同值域）
  breath            0..100 直传 brec 正半轴（负半轴 UI 暂未暴露）
"""

_DEF = ('velocity', 'volume', 'gender', 'breath')


def apply_note_expressions(project, track, part) -> int:
    """把 `UNote._app_note`（build_part/build_project 挂的原始 JSON）里的
    per-note 参数写成音素级表达式。返回挂载条数（诊断用）。"""
    from .format import Ustx

    abbrs = (Ustx.VEL, Ustx.VOL, Ustx.GENC, Ustx.BREC)
    count = 0
    for ph in (part.phonemes or []):
        note = ph.parent.extends or ph.parent
        src = getattr(note, '_app_note', None)
        if not isinstance(src, dict):
            continue
        for abbr, key in zip(abbrs, _DEF):
            v = src.get(key)
            if not isinstance(v, (int, float)) or isinstance(v, bool):
                continue
            ph.set_expression(project, track, abbr, float(v))
            count += 1
    return count
