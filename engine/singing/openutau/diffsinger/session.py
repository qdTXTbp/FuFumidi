# -*- coding: utf-8 -*-
r"""把前端传来的 **notes** 接进 M1–M6 管线，渲染出混音。

## 为什么需要这一层

M1–M6（`singing/openutau/diffsinger/`）的输入是**工程对象**
（`UProject` / `UTrack` / `UVoicePart`），而前端传的是裸 notes 数组
（`{startBeat, durBeat, pitch, lyric, vibrato, ...}`）+ bpm + 声库目录。

本模块负责搭桥，顺序**照上游 `DocManager` 的渲染调用链**：

```
notes + bpm ──build_project──▶ UProject / UTrack / UVoicePart
                                     │
                          phonemize (A 层，填 part.phonemes)
                                     │
                          PhraseSource.from_part          ← M2/M5
                                     │
                          build_phrases() → RenderPhrase  ← M1
                                     │
                          build_render_requests           ← M3（布局 + offset）
                                     │
                          render_requests                 ← M3（排序 + 并发）
                                     │
                          MixPlanner → samples            ← M5
```

★ **不用**任何"替身/phrase 填充物" —— 走的就是真实对象，
  这样 `DiffsingerIRenderer` 的乐句级 wav 缓存（`ds-{hash}.wav`）才真正生效。
  （早先 `tests/test_diffsinger_real_project.py` 里为了先验证时序用了手搭的
   phrase 对象，那只是验证脚手架，不是产品路径。）
"""

import asyncio
import os
from typing import Any, Dict, List, Optional, Sequence, Tuple

#: ★ UProject.resolution 是**固定 480 的只读属性**（`model.py:1249`），
#:   不是字段 —— 不能赋值，也不该由调用方改。
DEFAULT_RESOLUTION = 480


def _clamp(v: float, lo: float, hi: float) -> float:
    return lo if v < lo else (hi if v > hi else v)


def build_project(notes: Sequence[Dict[str, Any]], bpm: float,
                  language: str = 'zh',
                  renderer_name: str = 'DIFFSINGER'):
    """notes（拍）→ `(UProject, UTrack, UVoicePart)`。

    ★ **拍 → tick** 在边界上做一次转换（前端用拍，USTX 用 tick），
      内部一律 tick —— 与上游一致，避免两套时间单位在管线里混用。
    """
    from singing.ustx.model import (UProject, UTrack, UVoicePart, UNote,
                                    URenderSettings, UTempo, UVibrato)

    proj = UProject()
    # ★ 不要写 proj.resolution —— 它是只读属性（恒 480）
    proj.bpm = float(bpm or 120)
    proj.tempos = [UTempo(position=0, bpm=float(bpm or 120))]
    proj.tracks = []
    proj.parts = []

    track = UTrack()
    track.track_no = 0
    rs = URenderSettings()
    rs.renderer = renderer_name
    track.renderer_settings = rs
    # ★ 语言是**轨道级**属性（照搬上游 `USingerTrack.Language`）
    track.language = language or 'zh'
    proj.tracks.append(track)

    part = UVoicePart()
    part.position = 0
    part.track_no = 0
    for n in notes:
        note = UNote()
        note.position = int(round(float(n.get('startBeat', 0)) * DEFAULT_RESOLUTION))
        note.duration = max(1, int(round(float(n.get('durBeat', 1)) * DEFAULT_RESOLUTION)))
        note.tone = int(n.get('pitch', 60))
        note.lyric = str(n.get('lyric') or '')
        # ★ `UNote.vibrato` 是 `Optional[UVibrato]`（对象），**不是** bool/int。
        #   直接塞 int 会在 `VibratoSource.of` 里炸（`'int' has no attribute 'length'`）。
        #   前端给的是 `vibDepth`(0..100) / `vibFreq`(Hz) / `vibFade`(0..100)，
        #   这里映射成 UVibrato 的 depth / period(ms) / in。
        if n.get('vibrato'):
            vib = UVibrato()
            vib.length = note.duration
            vib.depth = _clamp(float(n.get('vibDepth') or 25), 5, 200)
            freq = float(n.get('vibFreq') or 0)
            # period 是**毫秒**，范围 [5,500]（UVibrato 的 setter 会夹紧）
            vib.period = _clamp(1000.0 / freq, 5, 500) if freq > 0 else 175.0
            vib.vib_in = _clamp(float(n.get('vibFade') or 0), 0, 100)
            note.vibrato = vib
        part.notes.append(note)
    part.notes.sort(key=lambda x: x.position)
    proj.parts.append(part)
    return proj, track, part


class SingerAdapter:
    """把 DS 声库对象适配成上游 `USinger` 的接口。

    ## 为什么需要

    `PhraseSource` / `part_validate` / `phoneme` / `render_phrase` 这一串
    （M1–M6 与经典路径共用的编排）会读 `USinger` 接口上的若干字段：

    | 字段 | 读取方 | DS 侧语义 |
    |---|---|---|
    | `subbanks` | `_subbank_suffix`（`pipeline_source.py:472`） | DS 无子库概念 → `[]` |
    | `has_found` | `part_validate.py` / `phoneme.py` | 声库已找到 → `True` |
    | `is_loaded` | 同上 | 已加载 → `True` |
    | `try_get_oto` | `phoneme.py:152` | DS 无 oto → `(False, None)` |
    | `frqs` | `render_phrase.py` | DS 不走频率表 → `{}` |
    | `id` | `render_phrase.py` | 用目录作 id |

    而 `DsSinger` 只有 `dir/dur/acoustic/vocoder/phoneme_tokens/language_ids/hashes`。

    ★ 用**代理**而不是给 `DsSinger` 打补丁：那只改一个实例，
      换声库/换入口就又断了；代理把"上游接口"这件事集中在一处。
    """

    #: 上游 `USinger` 接口里 DS 侧恒定的几个值
    has_found = True
    is_loaded = True
    subbanks: List[Any] = []

    def __init__(self, inner):
        object.__setattr__(self, '_inner', inner)
        object.__setattr__(self, 'subbanks', [])
        object.__setattr__(self, 'frqs', {})

    # ---- 上游 USinger 接口

    @property
    def id(self) -> str:
        return str(getattr(self._inner, 'dir', '') or '')

    def try_get_oto(self, phoneme: str):
        """DS 声库没有 oto.ini —— 与 C# 基类默认一样返回 `(False, None)`。"""
        return False, None

    def try_get_mapped_oto(self, phoneme: str, tone: int, color: Optional[str] = None):
        return False, None

    def ensure_loaded(self) -> None:
        return None

    def free_memory(self) -> None:
        return None

    def get_suggestions(self, lyric: str):
        return []

    # ---- 其余一律代理到 DS 声库（dir/dur/acoustic/vocoder/phoneme_tokens/...）

    def __getattr__(self, name):
        return getattr(object.__getattribute__(self, '_inner'), name)

    def __setattr__(self, name, value):
        setattr(object.__getattribute__(self, '_inner'), name, value)

    def __repr__(self):
        return 'SingerAdapter(%r)' % getattr(self._inner, 'dir', '')


def _link_notes(part, project, track) -> None:
    """铺好音符链 + Extends + 逐音符校验。

    ★ 照搬 `validate_part_phonemes` 的步骤 1a/1b/1c（`part_validate.py:152-172`）。
      这三步是 `PhraseSource` 的**前置条件**，不是可选项 —— 漏掉的话
      `RenderPhrase.__init__` 里 `at(u_notes[-1]).next` 会拿到 -1
      （`IndexError: note index out of range: -1`）。
    """
    from singing.openutau import ValidateOptions
    from singing.openutau.part_validate import note_validate

    # 1a. 链（UPart.cs 115-123）
    last = None
    for note in part.notes:
        note.prev = last
        note.next = None
        if last is not None:
            last.next = note
        last = note
    # 1b. Extends / ExtendedDuration（UPart.cs 125-133）
    for note in part.notes:
        note.extended_duration = note.duration
        if (note.prev is not None and note.prev.end == note.position
                and str(note.lyric or '').startswith('+')):
            note.extends = note.prev.extends if note.prev.extends is not None else note.prev
            note.extends.extended_duration = note.end - note.extends.position
        else:
            note.extends = None
    # 1c. 逐音符校验（UPart.cs 134-136）
    options = ValidateOptions()
    for note in part.notes:
        note_validate(note, options, project, track, part)


def phonemize(part, singer, project, track=None, language: str = 'zh',
              renderer=None) -> int:
    """A 层音素化：填 `part.phonemes`（**canonical 形状**），返回音素数。

    ## 为什么不能直接把 A 层输出塞进 `part.phonemes`

    `PhraseSource.from_part`（`pipeline_source.py:529`）要求音素有 `.error`
    和 `.parent`（后者用来回填 `note_index`）。而 A 层
    （`diffsinger.phonemizer.process_part`）返回的 `UPhoneme` **没有这两个字段**
    —— 直接塞进去会 `AttributeError: 'UPhoneme' object has no attribute 'error'`。

    ## 做法：分句 → 收集 → 适配成 `singing.openutau.phoneme.UPhoneme`

    * **分句**复用 `MlPhonemizer.set_up`（判据是 tick **精确相等**，即"连排"），
      保证与前端/上游的分句口径一致；
      ★ 注意 `set_up` 会 flush **最后一句**，漏掉会丢尾句。
    * **时长不重算** —— A 层已经由 dsdur 算好 `position`/`duration`，
      只补 `error` 与 `parent`。走经典路径重算时长对 DS 是错的。
    * `parent` 的找回：A 层把所属音符的结束 tick 记在 `_note_end_tick`
      （`diffsinger/phonemizer.py:307`），据此反查。
    """
    from diffsinger import g2p as G, phonemizer as P
    from diffsinger.session import resolve_providers
    from singing.openutau.timeaxis import TimeAxis
    from singing.openutau.phoneme import UPhoneme
    from singing.openutau.diffsinger.ml_phonemizer import MLNote, MlPhonemizer

    # ---- ⓪ 音符预处理：**必须**先跑，否则 `PhraseSource` 会炸
    #   `PhraseSource._of` 读 `NoteSource.prev/next/extends`（`pipeline_source.py:275`），
    #   而这三个字段由 `validate_part_phonemes` 的步骤 1a/1b/1c 铺好
    #   （`part_validate.py:152-172`）。漏掉的话 `RenderPhrase.__init__` 里
    #   `at(u_notes[-1]).next` 会拿到 -1 → `IndexError: note index out of range: -1`。
    #   这里复用 canonical 的同样三步，不另写一套。
    from singing.openutau import ValidateOptions
    from singing.openutau.part_validate import note_validate

    _link_notes(part, project, track)

    axis = TimeAxis()
    axis.build_segments(project)
    g2p, _name = G.load_ds_g2p(singer.dur.root, language, [])
    providers = resolve_providers('cpu')

    # ---- ① 按音符建组（没有 Extends 链，故 1:1）
    groups = [[MLNote(position=n.position, duration=n.duration,
                      tone=n.tone, lyric=n.lyric or '')] for n in part.notes]
    if not groups:
        part.phonemes = []
        return 0

    collected: List[Any] = []
    failures: List[str] = []

    def _process_part(phrase):
        """逐句跑 A 层，按句收集（异常不中断整首，交给 MlPhonemizer 记）。"""
        unotes = []
        for g in phrase:
            u = type('U', (), {})()
            u.position = g[0].position
            u.duration = g[0].duration
            u.tone = g[0].tone
            u.lyric = g[0].lyric
            unotes.append(u)
        got = P.process_part(singer, [[u] for u in unotes], axis, g2p,
                             language, providers, failures)
        collected.extend(got)

    ml = MlPhonemizer(romanize_impl=None)
    ml.process_part = _process_part
    ml.set_up(groups)

    # ---- ② 适配成 canonical UPhoneme（补 error / parent）
    #   `_note_end_tick` 是所属音符的结束 tick —— 用它反查 parent。
    by_end: Dict[int, Any] = {}
    for n in part.notes:
        by_end.setdefault(n.position + n.duration, n)

    out: List[Any] = []
    for src in collected:
        ph = UPhoneme()
        ph.position = int(src.position)
        ph.phoneme = str(getattr(src, 'phoneme', '') or '')
        ph.duration = int(getattr(src, 'duration', 0) or 0)
        ph.position_ms = float(getattr(src, 'position_ms', 0.0) or 0.0)
        ph.end_ms = float(getattr(src, 'end_ms', 0.0) or 0.0)
        # ★ 这两个字段是 from_part 需要的，A 层不产出
        ph.error = False
        ph.parent = by_end.get(int(getattr(src, '_note_end_tick', 0) or 0))
        out.append(ph)
    part.phonemes = out
    return len(out)


async def render_notes(notes: Sequence[Dict[str, Any]], voicebank: str,
                       bpm: float = 120, language: str = 'zh',
                       depth: float = 1.0, steps: int = 20,
                       cache_dir: Optional[str] = None,
                       playing: bool = False, playback_start_ms: float = 0.0,
                       focus_tick: int = -1,
                       device: str = 'auto') -> Dict[str, Any]:
    """**主入口**：notes → 混音 samples。

    ★ 返回 `{ok, samples, duration_ms, phrases, cached, ...}`，
      与 `MixPlanner.get_result()` 的形状对齐，前端不用做二次搬运。
    """
    from diffsinger import voicebank as VB
    from singing.openutau.diffsinger.diffsinger_renderer import DiffsingerIRenderer
    from singing.openutau.diffsinger.render_engine import (
        MixPlanner, build_render_requests, render_requests,
    )
    from singing.openutau.pipeline_source import PhraseSource

    if not notes:
        return {'ok': False, 'error': '没有音符'}
    if not voicebank or not os.path.isdir(voicebank):
        return {'ok': False, 'error': '声库目录无效：%s' % voicebank}

    proj, track, part = build_project(notes, bpm, language)
    singer = VB.load_singer(voicebank)
    if singer is None:
        return {'ok': False, 'error': '声库加载失败'}
    # ★ 适配成上游 `USinger` 接口（补 `subbanks` / `has_found` / `try_get_oto` …）
    singer = SingerAdapter(singer)
    track.singer_obj = singer

    renderer = DiffsingerIRenderer(cache_dir=cache_dir)
    track.renderer_settings.renderer_obj = renderer
    renderer.depth = depth
    renderer.steps = steps

    # A 层
    try:
        n_ph = phonemize(part, singer, proj, track=track, language=language)
    except Exception as e:  # noqa: BLE001
        return {'ok': False, 'error': '音素化失败：%s' % e}
    if not n_ph:
        return {'ok': False, 'error': '没有可渲染的音素（歌词/语言是否匹配声库？）'}

    # ★ 真实的 PhraseSource（不是替身）→ 乐句级缓存才生效
    src = PhraseSource.from_part(proj, track, part, generation=0)
    if src is None:
        return {'ok': False, 'error': '无法生成乐句快照'}
    phrases = src.build_phrases()
    if not phrases:
        return {'ok': False, 'error': '没有可渲染的乐句'}
    # 把 phrases 挂到 part 上，供 `build_render_requests` 的 get_phrases 取用
    # ★ 不往 part 上挂 `phrases` —— `UVoicePart` 没有这个字段（只有 `render_phrases`）。
    #   通过 `get_phrases` 回调把快照交给渲染请求，避免改模型。
    _by_part = {id(part): phrases}
    reqs = build_render_requests([part], get_phrases=lambda p: _by_part[id(p)])
    results = await render_requests(
        reqs, playing=playing, playback_start_ms=playback_start_ms,
        focus_part=part if focus_tick >= 0 else None,
        focus_tick=focus_tick if focus_tick >= 0 else -1,
    )

    planner = MixPlanner()
    cached = 0
    for o in results:
        planner.register_pcm(o['part'], o['hash'], o['offset_ms'],
                             o['estimated_length_ms'], 1.0, o['samples'])
    mix = planner.get_result()
    samples = mix['samples']
    return {
        'ok': True,
        'samples': samples,
        # ★ 采样率取自 **MixPlanner**（`render_engine.py:144`，默认 SAMPLE_RATE）；
        #   `DiffsingerIRenderer` 上**没有** `sample_rate` 属性。
        'duration_ms': len(samples) / float(planner.sample_rate) * 1000.0,
        'phrases': len(phrases),
        'rendered': len(results),
        'cached': cached,
        'sample_rate': planner.sample_rate,
        'language': language,
        'device': device,
    }


def render_notes_sync(**kw) -> Dict[str, Any]:
    """同步包装（CLI 用）。"""
    return asyncio.run(render_notes(**kw))
