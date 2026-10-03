# -*- coding: utf-8 -*-
r"""DiffSinger 歌声合成引擎 —— **CLI 门面**。

★ 真正的实现在 `diffsinger/` 包里（与上游 OpenUtau 逐项对齐的版本）。
  本文件只负责：CLI 参数解析、`###RESULT` / `###PROG` 输出、以及**兼容重导出**。

## 链路

```
MIDI 音符（拍）→ tick → A 层音素化（dsdur 的 linguistic+dur）→ UPhoneme(positionMs/durationMs)
→ PaddedSegments（首尾各 8 帧 SP）→ DurationsMsToFrames → f0（谱面音分曲线 → Hz）
→ acoustic ONNX（mel）→ vocoder ONNX（波形）→ WAV
```

## 为什么曾经要重写整条管线

旧实现（已删除，见 git 历史 / `/tmp/engine_diffsinger_full.bak`）照着 `dsconfig.yaml`
的**目录结构**推断出一条「五段式管线」（时长→音高→方差→acoustic→声码器），
并用 `if vb.get("stages")` 自动走它。但**上游 `OpenUtau.Core/DiffSinger/` 里没有这条管线**
—— `grep -rn "sr3|v2"` 零命中：

| 目录 | 上游实际用途 | 参与渲染？ |
|---|---|---|
| `dsdur/` | **音素化器**里的时长模型，产出带 `positionMs`/`durationMs` 的 `UPhoneme` | ✅ 强制，但在**音素化阶段** |
| `dsvariance/` | 方差预测（breathiness/voicing/tension/energy） | ✅ 条件（`use*Embed`） |
| `dspitch/` | 音高预测 | ❌ **完全不参与**，只服务编辑器的「渲染音高曲线」 |
| `InvokeDiffsinger` | **只有一条** acoustic 路径 | — |

于是本该走 legacy 路径的声库被强塞进 v2：时长被 `sr3_dur` 压短 2.6 倍、
音高被 `sr3_pit` 覆盖成 MIDI 号、mel 出不来谐波 → **杂音**。
在错误管线里修 6 个 bug 都不会对。

## 契约（不能破）

* `render_phrase(cfg, on_progress)` —— `singing/adapters/diffsinger.py:139` 在用
* CLI 的 `###RESULT` / `###PROG` —— `main/diffsinger.js:1040-1051` 在解析
* 失败时也是**退出码 0 + `ok:false`**（保持旧语义，别改成 `sys.exit(1)`）

## 用法（CLI）

```bash
python engine_diffsinger.py deps --check
python engine_diffsinger.py inspect  --voicebank <声库目录>
python engine_diffsinger.py render   --voicebank <声库目录> \
    --notes '[{"startBeat":0,"durBeat":1,"pitch":60,"lyric":"啊"}]' \
    --bpm 120 --out out.wav [--device auto|cpu|cuda|dml]
# 音符量大时用 @文件（规避 Windows 命令行上限）
python engine_diffsinger.py render --voicebank <声库目录> \
    --notes @notes.json --bpm 120 --out out.wav
# 编辑功能：跑 dspitch 并把预测音高写回 PITD（不产出音频）
python engine_diffsinger.py pitch-edit --voicebank <声库目录> --notes @notes.json
```
"""

import argparse
import json
import os
import asyncio
import sys
import traceback

# ============================================================
# 转发层 —— 真正的实现在 diffsinger/ 包里
# ============================================================
from diffsinger import RenderError                                # noqa: E402
from diffsinger.pipeline import (                                # noqa: E402
    ENGINE_VERSION,
    _pitch_edit_entry,
    render_phrase,
)
from diffsinger.session import resolve_providers                  # noqa: E402
from diffsinger.voicebank import load_singer                     # noqa: E402

VERSION = ENGINE_VERSION


def load_voicebank(vb_dir, cache=None):
    """兼容 shim：旧的 `load_voicebank(vb_dir) -> dict` → 新的 `load_singer(vb_dir)`。

    ★ 返回类型变了（`DsSinger` 对象，不再是 dict）—— 字段名 `dur` / `acoustic` /
      `vocoder` / `phoneme_tokens` / `language_ids` 与旧的 `vb` dict 不同。
      仅 `cmd_inspect` 使用；新代码请直接用 `diffsinger.voicebank.load_singer`。
    """
    return load_singer(vb_dir)


def load_rendered_pitd(voicebank, notes, bpm=120.0, device='cpu', pitch_steps=None):
    """**编辑功能**：跑 `dspitch` 并把预测音高写回 PITD。

    ★ **不参与渲染** —— 上游 `InvokeDiffsinger` 全程不碰音高模型。这是给声乐者
      "唱一版"、把预测音高写回 PITD 供微调用的（`NoteBatchEdits.cs:540-566`）。
    返回 `{"ok":True, "points":[[x_tick, y_pitd], ...], ...}`；
    `y` 是**音分差**，`voiced == False` 的帧（head/tail SP、音素间隙）已跳过。
    """
    return _pitch_edit_entry(voicebank, notes, bpm, device, pitch_steps)


# ============================================================
# 输出协议（main/diffsinger.js 依赖这两行前缀）
# ============================================================

#: 依赖名（与主进程 DS_PY_DEPS 对齐）
DEPS = {
    "onnxruntime": "ONNX 推理运行时（pip install onnxruntime）",
    "yaml": "YAML 解析（pip install pyyaml）",
    "numpy": "数值计算（引擎环境自带）",
    # ★ 上游 `BaseChinesePhonemizer.Romanize` 用它把汉字转拼音；缺了会**静默失效**
    #   （hanzi_to_pinyin 返回 None → romanize 原样返回，不报错），
    #   而 DiffSinger 声库的词典是「拼音→音素」，没有这一步就完全没法唱中文。
    "pypinyin": "汉字转拼音（中文音素化必需）",
}


def emit_result(obj):
    sys.stdout.write("###RESULT " + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def emit_progress(percent, text=""):
    sys.stdout.write("###PROG " + json.dumps(
        {"percent": int(percent), "text": text}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def warn(msg):
    sys.stderr.write("[diffsinger] " + str(msg) + "\n")
    sys.stderr.flush()


# ================================================================
# deps：依赖检测（--check）
# ================================================================

def cmd_deps(args):
    from importlib.util import find_spec

    out = {"ok": True, "installed": [], "missing": [], "engine_version": VERSION}
    for mod, desc in DEPS.items():
        try:
            found = find_spec(mod) is not None
        except (ImportError, ValueError):
            found = False
        (out["installed"] if found else out["missing"]).append(mod)
        if not found:
            warn("缺少 %s：%s" % (mod, desc))

    gpu = {"device": "cpu", "providers": [], "active": None, "onnxruntime": "",
           "disabled": False, "note": ""}
    try:
        import onnxruntime as ort
        gpu["onnxruntime"] = getattr(ort, "__version__", "")
        gpu["providers"] = list(ort.get_available_providers())
        providers = resolve_providers(getattr(args, "device", "auto"))
        gpu["active"] = providers[0] if providers else "CPUExecutionProvider"
        gpu["device"] = "cuda" if "CUDA" in (gpu["active"] or "") else "cpu"
    except Exception as e:  # noqa: BLE001
        gpu["note"] = "GPU 探测失败：" + str(e)[:160]
    out["gpu"] = gpu
    emit_result(out)
    return 0


# ================================================================
# inspect：查看声库信息
# ================================================================

def cmd_inspect(args):
    """声库信息。

    ★ 用新的 `load_singer`（缺 `dsdur` 即报错 —— 对齐上游 `SetSinger` 的强契约）。
      JS 侧只读 `ok` / `error`，其余字段是给人和 UI 看的。
    """
    try:
        singer = load_singer(args.voicebank)
    except RenderError as e:
        emit_result({"ok": False, "error": str(e)})
        return 0
    except Exception as e:  # noqa: BLE001
        emit_result({"ok": False, "error": "声库解析失败：" + str(e)})
        return 0

    from diffsinger.g2p import load_ds_g2p
    from diffsinger.pitch_edit import load_pitch
    from diffsinger.variance import load_variance

    # ---- ★ 字段名与形状必须与前端 `DiffsingerVoicebankInfo`（types/ipc.ts:436）对齐。
    #   `ViewDiffSinger.vue:306-310` 直接渲染 name / phonemeCount / dictionaryWords /
    #   builtinVocoder —— 少一个就出现「词典 undefined 词」或错误的声码器提示。
    base = os.path.normpath(args.voicebank)
    character = _read_character_txt(base)
    name = character.get('name') or os.path.basename(base)
    version = character.get('version', '')

    warn_list: list = []
    g2p, dict_name = load_ds_g2p(singer.dur.root, 'zh', warn_list)
    dictionary_words = _count_g2p_entries(os.path.join(singer.dur.root, dict_name))

    phonemes = sorted(singer.phoneme_tokens)
    prefixes = sorted({p.split('/')[0] for p in phonemes if '/' in p})
    # ★ `builtinVocoder`：声库自带 `dsvocoder/vocoder.yaml` 才算自带
    #   （对齐 `DiffSingerSinger.getVocoder()` :200-211 的优先级）
    builtin_vocoder = os.path.isfile(
        os.path.join(base, 'dsvocoder', 'vocoder.yaml'))
    emit_result({
        "ok": True,
        "name": name,
        "version": version,
        "character": character,
        # 前端类型声明是 `string[]`；这里给**音素里出现过的语言前缀**（更有信息量）
        "languages": prefixes,
        "langPrefixes": prefixes,
        "multiLang": len(prefixes) > 1,
        "phonemeCount": len(phonemes),
        "phonemes": phonemes,
        "hasAcoustic": os.path.isfile(singer.model("acoustic")),
        "hasDur": os.path.isfile(singer.model("dur")),
        "hasVariance": load_variance(args.voicebank) is not None,
        "hasPitchPredictor": load_pitch(args.voicebank) is not None,
        # `vocoder` 是**声码器 onnx 的文件名**（旧版为空串表示"用通用组件位"）
        "vocoder": os.path.basename(singer.model("vocoder")),
        "builtinVocoder": builtin_vocoder,
        "dictionaryFile": dict_name,
        "dictionaryWords": dictionary_words,
        "sampleRate": singer.sample_rate,
        "hopSize": singer.hop_size,
        "melBins": singer.acoustic.num_mel_bins,
        "engineVersion": VERSION,
        "engine_version": VERSION,
        "warnings": warn_list,
        "pipeline": "upstream",
    })
    return 0


def _read_character_txt(bank_dir: str) -> dict:
    """读 `character.txt` 的 `key=value`（`name` / `version` / `author` / `voice` …）。

    ★ 上游也读这个文件（`DiffSingerSinger.DisplayName`），显示名优先用它而不是目录名。
    """
    path = os.path.join(bank_dir, 'character.txt')
    out = {}
    if not os.path.isfile(path):
        return out
    try:
        with open(path, encoding='utf-8-sig') as f:
            for line in f:
                line = line.strip()
                if '=' in line:
                    k, v = line.split('=', 1)
                    out[k.strip()] = v.strip()
    except OSError:
        pass
    return out


def _count_g2p_entries(path: str) -> int:
    """统计 `dsdict-*.yaml` 的 `entries` 条数（= 真正被加载的词条数）。

    ★ 上游的 `G2pDictionary.Builder.Load` 读的就是这个 `entries` 列表，
      所以条数要按**实际加载的那份**算，不能拿 `dictionary-en.txt`（14MB）的行数充数。
    """
    if not path or not os.path.isfile(path):
        return 0
    try:
        import yaml
        with open(path, encoding='utf-8') as f:
            data = yaml.safe_load(f) or {}
        return len(data.get('entries') or [])
    except Exception:  # noqa: BLE001
        return 0


# ================================================================
# render：渲染音符序列为 WAV
# ================================================================

def cmd_render(args):
    """CLI 入口：只做参数搬运 + 结果输出，真正的流水线在 `diffsinger.pipeline`。

    注意与旧实现的等价性：失败时是 `emit_result(ok:false)` 后**正常返回**（退出码 0），
    不是 `sys.exit(1)` —— 保持同样语义，避免主进程的解析逻辑发生变化。
    """
    try:
        res = render_phrase({
            "voicebank": args.voicebank,
            "notes": args.notes,
            "bpm": args.bpm,
            "vocoder": getattr(args, "vocoder", None),
            "start_beat": getattr(args, "start_beat", None),
            "end_beat": getattr(args, "end_beat", None),
            "context_sec": getattr(args, "context_sec", 0.5),
            "full": getattr(args, "full", False),
            "device": args.device,
            "out": args.out,
        }, on_progress=emit_progress)
        emit_result({k: v for k, v in res.items() if k != "wav"})
    except Exception as e:  # noqa: BLE001
        emit_result({"ok": False, "error": str(e)})
    return 0


# ================================================================
# sing-render：**走 M1–M6 管线**渲染（乐句级缓存生效）
# ================================================================

def cmd_sing_render(args):
    """notes → **M1–M6 管线** → 混音。与 `render` 的区别：

    * `render`     走 `diffsinger.pipeline`（旧 ENGINE 管线，**无**乐句缓存）
    * `sing-render` 走 `PhraseSource → RenderPhrase → DiffsingerIRenderer`
      —— **乐句级 `ds-{hash}.wav` 缓存** + `render_priority` 排序 + MixPlanner 混音

    `--cache-dir` 是关键：给了才会命中缓存，实时预览才有意义。
    `--notes` 的约定与 `render` 一致（JSON 串或 `@文件`）。
    """
    try:
        from singing.openutau.diffsinger.session import render_notes
        notes = _parse_notes_arg(args.notes)
        r = asyncio.run(render_notes(
            notes,
            args.voicebank or '',
            bpm=float(args.bpm or 120),
            language=args.language or 'zh',
            depth=float(args.depth if args.depth is not None else 1.0),
            steps=int(args.steps if args.steps is not None else 20),
            cache_dir=args.cache_dir or None,
            playing=bool(args.playing),
            playback_start_ms=float(args.playhead_ms or 0.0),
            focus_tick=int(args.focus_tick if args.focus_tick is not None else -1),
            device=args.device or 'auto',
        ))
        if not r.get('ok'):
            emit_result({'ok': False, 'error': r.get('error')})
            return 1
        samples = r['samples']
        wrote = None
        if args.out:
            from diffsinger.pipeline import write_wav
            write_wav(args.out, [float(x) for x in samples], int(r['sample_rate']))
            wrote = args.out
        emit_result({
            'ok': True, 'out': wrote,
            'duration_ms': r['duration_ms'], 'sample_rate': r['sample_rate'],
            'phrases': r['phrases'], 'rendered': r['rendered'],
            'samples_count': int(len(samples)),
            # 写出了文件就不回传字节（大数组过 IPC 很贵）
            'bytes': None if wrote else _b64(samples),
        })
    except Exception as e:  # noqa: BLE001
        emit_result({'ok': False, 'error': str(e)})
    return 0


def _parse_notes_arg(raw):
    """与 `render` 同一套约定：`@文件路径` 或 JSON 串。"""
    import json
    txt = raw
    if raw and raw.startswith('@'):
        with open(raw[1:], 'r', encoding='utf-8') as f:
            txt = f.read()
    return json.loads(txt) if txt else []


def _b64(samples):
    import base64
    import struct as _s
    import numpy as _np
    a = _np.clip(_np.asarray(samples, dtype=_np.float32), -1.0, 1.0)
    pcm = (_np.round(a * 32767.0)).astype('<i2').tobytes()
    return base64.b64encode(pcm).decode('ascii')


# ================================================================
# suggest：歌词输入建议（仿 SV2 的「输入即候选」）
# ================================================================

def cmd_suggest(args):
    """给一条歌词输入返回候选。

    ★ `language` 是**轨道级**设置（照搬新版上游 `USingerTrack.Language`），
      **不从歌词自动判断** —— 与 OpenUtau 一致。
    """
    try:
        from diffsinger.suggest import suggest_lyric
        tokens = {}
        if args.voicebank and os.path.isdir(args.voicebank):
            from diffsinger.voicebank import load_singer
            tokens = load_singer(args.voicebank).phoneme_tokens
        items = suggest_lyric(args.text or '', args.language or 'zh',
                              tokens, args.limit)
        emit_result({'ok': True, 'text': args.text or '',
                     'language': args.language or 'zh',
                     'items': [x.as_dict() for x in items]})
    except Exception as e:  # noqa: BLE001
        emit_result({'ok': False, 'error': str(e)})
    return 0


# ================================================================
# pitch-edit：编辑功能（dspitch → PITD 写回），不产出音频
# ================================================================

def cmd_pitch_edit(args):
    try:
        emit_result(load_rendered_pitd(args.voicebank, args.notes, args.bpm,
                                      args.device, args.pitch_steps))
    except Exception as e:  # noqa: BLE001
        emit_result({"ok": False, "error": str(e)})
    return 0


# ================================================================
# main
# ================================================================

def main():
    parser = argparse.ArgumentParser(
        description="DiffSinger 歌声合成引擎（与上游 OpenUtau 对齐）")
    sub = parser.add_subparsers(dest="cmd")

    d = sub.add_parser("deps", help="依赖检测")
    d.add_argument("--check", action="store_true", help="仅检测")
    d.add_argument("--device", default="auto")
    d.set_defaults(func=cmd_deps)

    i = sub.add_parser("inspect", help="查看声库信息")
    i.add_argument("--voicebank", required=True, help="声库目录（含 dsdur/）")
    i.set_defaults(func=cmd_inspect)

    r = sub.add_parser("render", help="渲染音符序列为 WAV")
    r.add_argument("--voicebank", required=True,
                   help="声库目录（含 dsdur/ 与 dsvocoder/）")
    r.add_argument("--notes", required=True,
                   help='音符 JSON，或 @文件路径：[{"startBeat":0,"durBeat":1,'
                        '"pitch":60,"lyric":"啊"}]；整曲建议 @<临时 json 文件>，'
                        '避免命令行超长')
    r.add_argument("--bpm", type=float, default=120.0, help="速度（BPM，拍→秒换算）")
    r.add_argument("--vocoder", default=None,
                   help="声码器 onnx 或目录（声库未自带时使用）")
    r.add_argument("--out", default="", help="输出 WAV 路径")
    r.add_argument("--start-beat", type=float, default=None, help="选区起点（拍，含）")
    r.add_argument("--end-beat", type=float, default=None, help="选区终点（拍，含）")
    r.add_argument("--context-sec", type=float, default=0.5,
                   help="选区前后各多渲染多少秒作为上下文再裁掉（默认 0.5；设 0 关闭）")
    r.add_argument("--full", action="store_true", help="渲染全曲（忽略选区）")
    r.add_argument("--device", default="auto",
                   help="推理后端：auto / cpu / cuda / dml")
    r.set_defaults(func=cmd_render)

    pe = sub.add_parser("pitch-edit",
                        help="跑 dspitch 并把预测音高写回 PITD（编辑功能，不产出音频）")
    pe.add_argument("--voicebank", required=True, help="声库目录（需含 dspitch/）")
    pe.add_argument("--notes", required=True,
                    help='音符 JSON，或 @文件路径：'
                         '[{"startBeat":0,"durBeat":1,"pitch":60,"lyric":"啊"}]')
    pe.add_argument("--bpm", type=float, default=120.0, help="速度（BPM，拍→秒换算）")
    pe.add_argument("--device", default="auto",
                    help="推理后端：auto / cpu / cuda / dml")
    pe.add_argument("--pitch-steps", type=int, default=None,
                    help="音高采样步数（默认 10，对齐 Preferences.DiffSingerStepsPitch）")
    pe.set_defaults(func=cmd_pitch_edit)

    # suggest：歌词候选（语言由轨道决定）
    sg = sub.add_parser('suggest', help='歌词输入建议（候选列表）')
    sg.add_argument('text', nargs='?', default='', help='已输入的歌词/音节')
    sg.add_argument('--language', default='zh',
                    help='★ 轨道级语言：zh / ja / ko / en（不从歌词自动判断）')
    sg.add_argument('--voicebank', default=None,
                    help='声库目录（用于判定哪些候选是合法音素）')
    sg.add_argument('--limit', type=int, default=12, help='最多返回几条')
    sg.set_defaults(func=cmd_suggest)

    # sing-render：走 M1–M6 管线（乐句级缓存）
    sr = sub.add_parser('sing-render', help='走 M1–M6 管线渲染（乐句缓存生效）')
    sr.add_argument('--voicebank', required=True, help='声库目录')
    sr.add_argument('--notes', required=True,
                    help='音符 JSON，或 @文件路径（约定同 render）')
    sr.add_argument('--bpm', type=float, default=120.0, help='速度')
    sr.add_argument('--language', default='zh',
                    help='★ 轨道级语言：zh/ja/ko/en（不从歌词自动判断）')
    sr.add_argument('--depth', type=float, default=1.0, help='采样深度（进缓存名）')
    sr.add_argument('--steps', type=int, default=20, help='采样步数（进缓存名）')
    sr.add_argument('--device', default='auto', help='auto/cpu/cuda/dml')
    sr.add_argument('--out', default='', help='输出 wav 路径')
    sr.add_argument('--cache-dir', default=None, help='乐句 wav 缓存目录（给了才命中缓存）')
    sr.add_argument('--playing', action='store_true', help='按播放头优先级排序')
    sr.add_argument('--playhead-ms', type=float, default=0.0, help='播放头位置（ms）')
    sr.add_argument('--focus-tick', type=int, default=-1, help='编辑焦点 tick（按焦点排序）')
    sr.set_defaults(func=cmd_sing_render)

    args = parser.parse_args()
    if not getattr(args, "func", None):
        parser.print_help()
        return 0
    try:
        return args.func(args) or 0
    except Exception:  # noqa: BLE001
        emit_result({"ok": False,
                     "error": "引擎异常：" + traceback.format_exc(limit=3)})
        return 0


if __name__ == "__main__":
    sys.exit(main())
