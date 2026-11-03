# 03 · Python 引擎与 ML 边界（Rust 重写专项调研）

- 仓库：`E:\Midi\FuFumidi-Source`，分支 `feat/audio-tagger-auto-probe`，HEAD `99cbe75a`（2026-11-01），package.json 版本 **6.4.2**
- 调研方式：**只读**静态审计 + 本机 lstat/du/行数实测。未修改仓库任何文件，未安装依赖，未启动 GUI/安装版；度量脚本写在仓库外 `E:\Midi\_attic\tmp-engine\`。
- 标注约定：**实测**＝本次命令输出或仓库内可复现测量；**推断**＝由此前实测/公开资料推出的判断；**待实测**＝必须跑起来才能定论。

---

## 0. 结论速览

1. **Python 引擎的可移植性远比"全是 torch"要好**：25,345 行顶层 .py 中，**约 40% 是与 torch 无关的纯算法/格式/流式 IO**（UTAU 渲染 1,586 行、SF2 合并 521 行、SF3→SF2 199 行、MusicXML→MIDI 606 行、MIDI 编辑 297+113 行、OMR 经典算法 1,563 行、ustx 互转 643 行），这些是 A 类（Rust 原生重写）的第一批。
2. **真正的模型推理里已经有一半是 ONNX**：basic-pitch（`basic_pitch/saved_models/icassp_2022/nmp.onnx`，230,444 B）、audio-tagger（27.0 MB int8 onnx）、hnsep（ONNX）、RVC 的 rmvpe（ONNX）、DiffSinger **四个模型全是 ONNX**（`engine/diffsinger/voicebank.py:227/335`）。B 类可以用 `ort` 直接跑，不需要 torch。
3. **但 torch 系是 8 个模型 + 5 条完整链路**（piano_pt / aria / transkun / hft / muscriptor / yourmt3 / miros / MSST / RVC），它们是 `resources/python` 里 torch 383 MiB 的唯一理由。**在 torch 系迁移完成前，Python 运行时删不掉**；现实形态是"双轨 sidecar"。
4. **首任务固定开销是本任务最大的可量化收益**：Python 全栈 import **13.47 s**（torch 6.89 s / scipy 5.26 s，实测见 `docs/audit/2026-10-29/backend-perf.md:58`），`music2midi.py probe` **6.46 s**、`deps.py check` **4.70 s**（同文档 :60-61）。纯 Rust 的 A 类任务（MIDI/SF2/MusicXML/UTAU）在 sidecar 常驻后是 **毫秒级**（推断，待实测）。
5. **"Python 运行时 1.48 GB"需要修正**：1,484 MiB 是 **6.2.9 审计口径**（`scripts/prune-python-bundle.cjs:7` 也沿用 1.48 GB 说法）；**当前 6.4.2 分支的构建产物实测只有 1,101.4 MiB**（prune 已接入构建，`scripts/bundle-python.js:168`），本机安装版则是 **1,695.8 MiB**（未 prune 的 6.2.x 包）。三者差异见 §1.2。

---

## 1. 口径、基线与复现

### 1.1 三份"Python 运行时体积"实测（口径必须分开）

| # | 对象 | 文件数 | 体积 | .pyc | .lib | torch | 说明 / 证据 |
|---|---|---:|---:|---:|---:|---:|---|
| A | 6.2.9 审计快照 | 31,629 | **1,484 MiB** | 251.9 MiB | 44.1 MiB | 463 MiB | 只读审计文档：`docs/audit/2026-10-29/backend-perf.md:53`、`:85-107`；**未 prune** |
| B | 当前分支构建 `release/win-unpacked/resources/python` | 15,207 | **1,101.4 MiB** | 24.1 MiB | 0 | 382.9 MiB | **实测**：`node _attic/tmp-engine/sz.cjs`（lstat 递归）；site-packages 1,059.8 MiB |
| C | 本机安装版 `E:\Midi\FuFumidi\resources\python` | 56,097 | **1,695.8 MiB** | 340.7 MiB | 44.1 MiB | 502.0 MiB | **实测**：`node _attic/tmp-engine/sz2.cjs`；torch `2.14.1+cpu`（`torch/version.py`） |

> 结论：**"1.48 GB"是 A 口径**。当前源码树构建出来的是 B（1,101 MiB）——说明 `scripts/prune-python-bundle.cjs`（删 .pyc/.pdb/.lib/.a/tests/include，见该文件 :36-44）已接进 `scripts/bundle-python.js:168`，审计 §2.2 那 296 MiB 已被回收。**瘦身路线一律以 B 为基线**，C 只用于说明"存量用户装的是更胖的版本"。

### 1.2 其它本任务用到的基线数字

| 指标 | 值 | 类型 | 证据 |
|---|---:|---|---|
| Python 全栈 import（1,846 模块） | **13.47 s** | 实测（审计） | backend-perf.md:58 |
| └ torch / scipy | 6.89 s / 5.26 s | 实测 | 同 :59 |
| `music2midi.py probe` | **6.46 s** | 实测 | 同 :60 |
| `deps.py check`（DEEP_PROBE 真 import torch） | **4.70 s** | 实测 | 同 :61 |
| librosa 首次 resample（拉 numba+llvmlite+resampy） | **2.24 s** | 实测 | 同 :90、§2.2 注 |
| 10 分钟音频 decode_to_wav(22050) | 1.00 s / 25.2 MiB | 实测 | 同 :64 |
| 同文件 float32 / float64 常驻 | 50 / **101 MiB** | 实测 | 同 :65 |
| engine/tests pytest 用例 | **617** 个 test 函数 / 107 文件 | 实测（`grep -rho "def test_" engine/tests | wc -l`） | 与审计"611"同量级 |
| worker 空闲回收 | 120 s | 实测（代码） | `main/engine.js:20` |
| worker 池槽位 | 1–4（GPU 自动 −1） | 实测（代码） | `main/engine.js:228-233` |

### 1.3 复现命令（全部只读）

```bash
# 体积（lstat 口径，脚本在仓库外）
node E:/Midi/_attic/tmp-engine/sz.cjs      # 构建产物 python + models
node E:/Midi/_attic/tmp-engine/sz2.cjs     # 安装版 python
node E:/Midi/_attic/tmp-engine/all.cjs     # site-packages 全量条目
# 行数 / 依赖 / 格式
cd E:/Midi/FuFumidi-Source && for f in engine/*.py; do printf "%s\t%s\n" "$f" "$(wc -l < $f)"; done | sort -k2 -rn
grep -rln "import torch" engine/*.py | wc -l
grep -rln "import onnxruntime\|from onnxruntime" engine --include=*.py | grep -v tests
```

---

## 2. 引擎能力清单（按用户功能分组）

### 2.0 总体结构（实测行数）

| 层 | 规模 | 说明 |
|---|---:|---|
| `engine/*.py` | **71 文件 / 25,345 行** | 顶层模块（本表主体） |
| `engine/singing/`（含 `openutau/`） | 129 文件 / **29,652 行** | UTAU/OpenUtau 移植（含 11 MB native 库、g2p 模型） |
| `engine/diffsinger/` | 13 文件 / 4,191 行 | DiffSinger 真实实现（CLI 门面是 engine_diffsinger.py） |
| `engine/rvc/`（含 vendor） | 11 文件 / 3,950 行 | RVC 推理（照搬上游，MIT） |
| `engine/tests/` | 107 文件 / 28,495 行 / 617 用例 | 引擎行为唯一护栏，**CI 不跑**（审计 §15） |
| 入口 | `engine/music2midi.py`（712 行） | 子命令：`convert / batch / probe / gui / worker / separate`（`music2midi.py:436`） |

**协议事实（后续 §6 复用）**：一次性进程与 worker 共用 `###RESULT / ###PROG / ###LOG` 三段式（`music2midi.py:271/353/619-638`，`main/engine.js:77-82`）；常驻会话另有 `{id, argv}` 请求 → 带 id 的 `###RESULT`（`engine/engine_server.py:79-123`，`main/engine.js:313-425`）。

### 2.1 转录 · 通用（多乐器 / 人声 / 混合）

| 子模型 | 入口文件（行数） | 依赖 | 模型文件与格式 | 运行后端 | 首任务固定开销 | 证据 |
|---|---|---|---|---|---|---|
| Basic Pitch（默认兜底） | `engine_basic.py` 264 | basic_pitch, librosa, soundfile, pretty_midi, **onnxruntime**（经 basic_pitch） | `nmp.onnx` 230,444 B（site-packages）+ 随包 `basic_pitch_quant.onnx` 264 KB（int8） | onnxruntime（CPU/DirectML/CUDA） | 全栈 import 13.47 s（worker 常驻后归零）；模型加载 <1 s（推断） | `engine_basic.py:1-9`；`main/models.js:437`；requirements-bundle.txt:26-30 |
| MuScriptor small/medium/large | `engine_muscriptor.py` **1,755** | torch, **muscriptor 包**, librosa, pretty_midi, mido；可选 beat_this(ckpt)/audio-tagger(onnx) | `.safetensors`（103M/307M/1.4B，约 400 MB/1.2 GB/5.2 GB）；beat_this `.ckpt` 81 MB | torch（CUDA cu128 / CPU） | 全栈 import 13.47 s；**CPU 每首重付模型加载 2–3 s**（代码注释+审计 §6.4） | `engine_muscriptor.py:1-7`；`main/models.js:126-170` |
| YourMT3+ | `engine_yourmt3.py` 165 | torch, torchaudio, soundfile；自带 `site/` 运行时 | `.ckpt`（YPTF+Single，约 361 MB；整包 453,848,674 B） | torch | 待实测（含独立 site 运行时首次导入） | `engine_yourmt3.py:1-13`；`main/models.js:106-122` |
| MIROS（AMT 2025 冠军） | `engine_miros.py` 136 | torch（自带 site 含 transformers/lightning）、MusicFM | `.ckpt`（`checkpoints/last.ckpt`）+ `pretrained_msd.pt` 1.2 GB；整包 5,364,504,192 B | torch | 待实测（5 GB 级加载） | `engine_miros.py:1-18`；`main/models.js:79-104` |
| Aria-AMT（钢琴，见 2.2） | — | — | — | — | — | — |

### 2.2 转录 · 钢琴（含踏板）

| 子模型 | 入口（行数） | 依赖 | 模型 | 后端 | 首任务固定开销 | 证据 |
|---|---|---|---|---|---|---|
| piano-transcription（ByteDance） | `engine_pt.py` 398 | torch, numpy；`piano_transcription_inference` 包 | `note_F1=0.9677_pedal_F1=0.9186.pth` **171,966,578 B**（随包） | torch | 全栈 import 13.47 s；模型加载 待实测 | `main/models.js:43-55`；`resources/models/` 实测 |
| Aria-AMT | `engine_aria.py` 241 + `aria_win_patch.py` 281 + `aria_run.py` 45 | torch, safetensors, **amt/ariautils（GitHub 装）**, 需 Windows 补丁 | `.safetensors`（`piano-medium-double-1.0.safetensors` ~426 MB） | torch | 待实测 | `engine_aria.py:1-6`；`main/models.js:219-238` |
| Transkun | `engine_transkun.py` 102 | `transkun==2.0.1`（**pip 包自带权重**）+ torch | 包内权重（`site-packages/transkun` **54.0 MiB**） | torch | 待实测 | requirements-bundle.txt:66；`main/models.js` 无下载项 |
| hFT-Transformer（Sony） | `engine_hft.py` 167 + `hft_model.py` 380 + `hft_amt.py` 408（vendored MIT） | torch, torchaudio | `checkpoint.zip` → `model_016_003.pkl`（20,540,269 B，**.pkl**，torch pickle） | torch（5.5M 参数，CPU 可跑） | 待实测 | `docs/VENDOR.md:106-112`；`main/models.js:57-77` |

> 钢琴四子模型统一入口在 `engine/engine.py:33-38,140-162`（`PIANO_MODELS` + `piano_model_available`）。

### 2.3 转录 · 乐器组 / 鼓 / 音频标签探测

| 能力 | 入口（行数） | 依赖 | 模型/格式 | 后端 | 首任务固定开销 | 证据 |
|---|---|---|---|---|---|---|
| 乐器组自动探测（AudioSet） | `audio_tagger.py` **299** | onnxruntime, librosa, torch, torchaudio | `model.int8.onnx` **27,038,066 B**（AudioSet 527 类）+ `class_labels_indices.csv` | onnxruntime（CPU，**0.3 s / 10 s 音频**） | 会话级 1 次 session 初始化 | `audio_tagger.py:1-9`；`docs/VENDOR.md:19-20` |
| CED-Small 标签模型 | 同上（`audio_tagger.py:52-75`） | 同上 | `audio-tagger-ced/model.int8.onnx` **22,626,947 B** | onnxruntime | 同上 | `resources/models/` 实测 |
| 乐器组硬约束探测（分段） | `instrument_probe.py` 256 + `segment_probe.py` 71 | muscriptor, numpy, soundfile | 复用 muscriptor 权重 | torch | 待实测 | 文件头注释 |
| 鼓/分轨由 MSST 与 muscriptor 承担（无独立鼓模型） | — | — | — | — | — | `engine.py:15-19` MODES 仅 3 种 |

### 2.4 转录 · 多轨（6.5.0 分轨工作流）

| 能力 | 入口（行数） | 依赖 | 模型 | 后端 | 状态 |
|---|---|---|---|---|---|
| 分轨→逐 stem 转录→合并 | `engine/stem_merge.py` 177 + `engine/stem_roles.py` 123（纯逻辑，无 IO） | mido/pretty_midi（合并写入） | 无独立模型（组合 MSST + 2.1/2.2 的模型） | 复用上表 | **引擎侧已落地、主进程调用方尚未出现**：`main/` 下无 `stem-workflow.js`、全仓 grep `stem_merge` 0 命中（实测） |

### 2.5 分轨（音频处理）

| 能力 | 入口（行数） | 依赖 | 模型/格式 | 后端 | 首任务固定开销 | 证据 |
|---|---|---|---|---|---|---|
| MSST 音轨分离（4/6 stems） | `engine_msst.py` **527** + `msst_autoconfig.py` 416 + `msst_configs/index.json`（29 条内置架构映射） | **pymss==2.0.1**, torch, numpy, soundfile, omegaconf/ml_collections/einops/beartype | `.ckpt`（BS-Roformer/Mel-Band/HTDemucs…）+ `.yaml` 配置；运行期目录 21 GB 中 `vocal 3.7G / single 2.6G / multi 56M / vr 260M` | torch（CUDA/CPU） | 待实测（模型按需下载） | `engine_msst.py:1-10`；requirements-bundle.txt:38-43；`main/models.js:266-290` |
| 分离后的混音/导出 | `engine_cover.py`（`analyze`）、`separate-common` 侧 | soundfile/pydub | wav/flac/mp3 | — | — | `music2midi.py:322-366`（`separate` 子命令） |

### 2.6 翻唱（RVC 变声 + 混音）

| 能力 | 入口（行数） | 依赖 | 模型/格式 | 后端 | 首任务固定开销 | 证据 |
|---|---|---|---|---|---|---|
| RVC 变声 | `engine_rvc.py` 232 + `rvc/`（3,950 行 vendor，MIT） | torch, soundfile, faiss/检索 | `.pth`（模型）+ `.index`；rmvpe 音高模型为 **ONNX**（`rvc/vendor/rvc/infer/rmvpe.py` import onnxruntime） | torch + onnxruntime | 待实测 | `engine_rvc.py:1-14` |
| 一键翻唱（分离→变声→混音） | `engine_cover.py` **469** | soundfile, torch, subprocess | 复用 MSST + RVC | 复用 | 待实测 | `engine_cover.py:1-8` |
| 混音/后期 | `cover_mix.py` 154 | librosa, numpy, scipy, soundfile | — | numpy/scipy | 待实测 | 文件头 3 条实测规则 |
| 扒谱（人声→带词音符） | `cover_notes.py` 349 | librosa, numpy, pypinyin, soundfile | — | numpy/scipy | 待实测 | 文件头 |

### 2.7 OMR 乐谱识别（"变谱"）

| 后端 | 入口（行数） | 依赖 | 模型/格式 | 后端 | 首任务固定开销 | 证据 |
|---|---|---|---|---|---|---|
| classical（自带经典算法，永远可用） | `engine_omr.py` **1,563** | numpy, scipy, **Pillow**, mido | 无模型（纯图像处理） | numpy/scipy | 待实测 | `engine_omr.py:1-18` |
| audiveris（主力） | `engine_omr_backends.py` **2,374** | subprocess + **Java**；主进程侧 `main/omr.js` 620 行管安装 | **外部 exe**：`Audiveris.exe`（MSI 5.11.0）+ Tesseract `tessdata` 语言包 | 外部 Java 进程 | 待实测（JVM 启动 + 每页 LOAD…RHYTHMS） | `main/omr.js:19-36,434`；`engine_omr_backends.py:1-14` |
| SMuFL/PDF 预处理 | 同上 | Pillow | PNG/PDF 页 | — | — | `main/omr.js:349`（低清需 ≥11 px 行距） |
| smt（Sheet Music Transformer，预留） | 同上 | 自备模型/脚本 | 待定 | — | 待实测 | `engine_omr_backends.py:4-7` |

### 2.8 歌声合成

| 能力 | 入口（行数） | 依赖 | 模型/格式 | 后端 | 首任务固定开销 | 证据 |
|---|---|---|---|---|---|---|
| UTAU 渲染（自研实现，legacy） | `engine_utau.py` **1,586** | **仅 numpy + soundfile**（纯 DSP：TD-PSOLA/OLA/颤音/包络） | 声库采样 + `oto.ini`（无神经网络） | numpy（CPU） | 待实测；常驻会话可省 ~数秒（`engine_server.py:13` 称 0.5 s + torch 2–5 s，本链路不 import torch） | `engine_utau.py:1-22`；`main/settings.js:59-61` 保留 legacy 开关 |
| OpenUTAU 搬运版渲染（默认推荐） | `engine_openutau.py` **1,150** + `singing/` 29,652 行 | numpy + **native `worldline`**（ctypes 载入 `worldline.dll` 371,200 B / .so / .dylib）+ 可选 onnx（mel.onnx 85,404 B、hnsep onnx） | 声库 + `mel.onnx`（Worldline v20 编码器）+ `hnsep_240512.oudep`（zip→onnx 54.9 MB） | numpy + **C++ native** + onnxruntime | 待实测 | `docs/VENDOR.md:21-22,79-96`；`engine/singing/openutau/native/README.md:1-40` |
| DiffSinger 歌声合成 | `engine_diffsinger.py` 602（门面）+ `diffsinger/` 4,191 行 | **onnxruntime**, PyYAML, numpy | **4 个 ONNX**：`linguistic.onnx`、`dur.onnx`、`acoustic model.onnx`、`vocoder/model.onnx` + `dsconfig.yaml` | onnxruntime（CPU/CUDA） | 待实测 | `engine_diffsinger.py:8-14`；`diffsinger/voicebank.py:227,335`；`diffsinger/phonemizer.py:4` |
| 汉字→拼音（中文歌声） | `engine_pinyin.py` 105 | pypinyin | — | 纯算法 | — | `engine_pinyin.py:1-6` |

### 2.9 音频处理（EQ / 混音 / 导出 / 插件）

| 能力 | 入口（行数） | 依赖 | 模型 | 后端 | 首任务固定开销 | 证据 |
|---|---|---|---|---|---|---|
| 转录前音频链（高通→降噪→电平统一） | `audio_chain.py` **376** | librosa, scipy, soundfile, numpy | — | numpy/scipy | librosa resample 首次 2.24 s（实测） | `audio_chain.py:1-20`；审计 :90 |
| 旧版预处理 | `preprocess.py` 117 | librosa/scipy/soundfile | — | numpy/scipy | 同上 | 文件头 |
| 解码层（任意格式→WAV/数组） | `audio_io.py` **187** | soundfile + **imageio_ffmpeg**（静态 ffmpeg，84 MiB） | — | libsndfile / ffmpeg 子进程 | 每次任务 1.00 s / 10 min（实测） | `audio_io.py:1-9,64-74`；审计 :64 |
| 时长探测 | `audio_probe.py` 47 | imageio_ffmpeg | — | ffmpeg | — | 文件头 |
| ffmpeg 转码封装 | `ffmpeg_wrap.py` 42 | imageio_ffmpeg | — | ffmpeg 子进程 | — | 文件头 |
| VST3 离线渲染（Phase A） | `plugin_render.py` 205 | **可选 pedalboard**（JUCE，`need('pedalboard')` 运行期按需装；**未随包**） | 用户 VST3 | C++ 宿主 | 待实测 | `plugin_render.py:5-9,46-47` |
| 智能修正 MIDI（时间/力度/音高） | `smart_midi.py` **459** | librosa, numpy, scipy, pretty_midi | — | numpy/scipy | 待实测 | 文件头 |
| 音色稳定后处理 | `timbre_stabilize.py` 98 | 纯逻辑 | — | — | — | — |
| 响度/电平 | `cover_mix.py` 154、`align_sofa.py` 252 | scipy/numpy/soundfile | — | numpy | 待实测 | 文件头 |
| MIDI 播放（系统合成器） | `midi_player.py` 129 | winmm MCI | — | 系统 API | — | `midi_player.py:1-9` |

### 2.10 格式转换

| 能力 | 入口（行数） | 依赖 | 格式 | 后端 | 首任务固定开销 | 证据 |
|---|---|---|---|---|---|---|
| SF2 合并（GM 全覆盖选优） | `sf2_merge.py` **521** | **纯 stdlib**（二进制 SF2 解析：pdta/shdr/pgen/igen/sampleID） | `.sf2` | 纯 Python | Python 启动 ~0.5 s（推断） | `sf2_merge.py:1-20` |
| SF3→SF2（Ogg→PCM16） | `sf3tool.py` 198 | numpy, soundfile | `.sf3 → .sf2` | libsndfile | 同上 | `sf3tool.py:1-18` |
| MusicXML/MXL→MIDI | `engine_score2midi.py` **606** | **仅 mido + 标准库**（不引 music21） | `.musicxml/.mxl → .mid` | 纯 Python | 同上 | `engine_score2midi.py:1-20` |
| MIDI 微调编辑（量化/移调/力度/时值/人声化） | `midi_edit.py` 297 + `midi_post.py` 113 | pretty_midi | `.mid` | 纯 Python | 同上 | 文件头 |
| `.ustx` ⇄ 工程 JSON | `engine_ustx.py` **643** | 标准库 + 可选音频附件 | `.ustx / JSON`（480 tick/拍） | 纯 Python | 同上 | `engine_ustx.py:1-20` |
| GM 音色回填 | `midi_programs.py` 179 | mido | `.mid` | 纯 Python | — | 文件头 |
| DAWproject 校验 | `validate_dawproject.py` 47 | 标准库 | `.dawproject` | 纯 Python | — | 文件头 |
| 分轨 MIDI 合并 | `stem_merge.py` 177 | mido/pretty_midi | `.mid` | 纯 Python | — | 文件头 |

### 2.11 模型管理 / 探测 / 健康 / 依赖

| 能力 | 入口（行数） | 依赖 | 说明 | 证据 |
|---|---|---|---|---|
| 模型注册表与下载 | `main/models.js` **1,620** | `main/fast-download.js`（720） | 12 个静态条目 + MSST 动态清单（29 条内置映射）；单文件最大 miros 5,364,504,192 B | `main/models.js:42-265` |
| GPU 探测/设备选择 | `engine_gpu.py` **657** | torch, onnxruntime, onnx, subprocess | CUDA→ROCm→DirectML→CPU；懒加载 | `engine_gpu.py:1-20` |
| 性能档位 | `engine_perf.py` 241 | torch, onnxruntime, basic_pitch | 线程数/会话线程控制 + `detect_recommended` | `engine_perf.py:1-16` |
| onnxruntime 自愈 | `ort_compat.py` 243 | onnxruntime, subprocess | GPU 包 EP 加载失败时回落应用自带 CPU ort | 文件头 |
| 依赖自检/补装 | `deps.py` **328** | subprocess + pip（清华/阿里镜像） | `DEEP_PROBE` 真 import torch → **4.70 s** | 文件头；审计 :61 |
| 环境体检/诊断包 | `health.py` 443、`diag.py` 51、`feedback_bundle.py` 170 | onnxruntime, torch, zipfile | 脱敏报告 | 文件头 |
| 声库体检 | `engine_vbcheck.py` 213 | yaml | UTAU/DiffSinger 声库可用性 | 文件头 |
| 参数预设 | `presets.py` 408 + `presets_cli.py` 161 | 标准库 JSON | 三处参数表之一（审计 §5.4 漂移源） | 文件头 |

---

## 3. 可移植矩阵

分级：**A**＝Rust 原生重写（纯算法/格式/音频 DSP/MIDI/乐谱）；**B**＝模型已是或可导出 ONNX，用 `ort` 跑；**C**＝必须留 Python（torch 动态图/训练/复杂第三方包）；**D**＝外部二进制（Java/ffmpeg/native dll），需换 Rust 方案或保留 sidecar。

### 3.1 总表

| 能力 | 级 | 迁移收益（启动/体积/内存/吞吐） | 主要风险 | 证据锚点 |
|---|---|---|---|---|
| SF2 合并 / SF3→SF2 | **A** | 体积：可去掉 pydub/soundfile 依赖链；启动：0.5 s→~0；吞吐：几百 MB 文件解析快数倍（推断） | 二进制边界（SF2 gen 重映射）易错；需 fixture 对拍 | `sf2_merge.py:14-20` |
| MusicXML/MXL→MIDI | **A** | 启动 0.5 s→0；体积（无音乐依赖）；纯 CPU 解析，吞吐 ±（推断） | divisions/chord/backup/tie 语义；需拿 6.2 版输出做 golden | `engine_score2midi.py:15-30` |
| MIDI 编辑/后处理/合并/量化 | **A**（仓库已有 `rust-core` 先例） | 已有 `quantize-batch/transpose-batch/midi-stats/hash-batch` 571 行实现可扩 | 事件序不变量（running status） | `rust-core/src/main.rs:360-424` |
| `.ustx` ⇄ 工程 JSON | **A** | 启动归零；纯字符串/JSON 处理 | tick/拍换算与多点 tempo 语义（上游硬约定） | `engine_ustx.py:14-20` |
| UTAU 渲染（`engine_utau.py`） | **A** | **最有价值的一条**：1,586 行纯 numpy DSP → Rust；启动 0 开销；实时性提升（推断，待实测） | TD-PSOLA/共振峰/颤音数值一致性；听感验收不可自动化 | `engine_utau.py:1-22` |
| OpenUTAU 渲染（`engine_openutau.py`+`singing/`） | **A/D 混合** | 29,652 行里大部分是纯 DSP/格式；可逐段搬 | 依赖 `worldline.dll`（C++，MIT）+ 上游 OpenUtau 语义基线 2026-09-27；搬运量最大 | `docs/VENDOR.md:21-22` |
| 音频解码/重采样/降噪链 | **A** | 去掉 librosa/numba/llvmlite(**115+7 MiB**) + resampy；首次 resample 2.24 s→0；内存 float64→f32 省一半 | 全格式覆盖（m4a/视频）仍需 ffmpeg；降噪数值需对拍 | 审计 :90、:285-290 |
| Basic Pitch（ONNX） | **B（已 ONNX）** | 可删 basic_pitch 2.1+librosa 依赖链（**~127 MiB**）；会话常驻省 import 13.47 s | 前/后处理（melodia trick、note 聚合）在 Python 包内，需重写；精度需对拍 | `nmp.onnx` 230,444 B |
| audio-tagger / CED（ONNX） | **B** | 同上；0.3 s/10 s CPU 已足够，Rust 无额外收益 | 前后处理（mel 窗、标签后处理）需重写 | `audio_tagger.py:1-9` |
| DiffSinger（4×ONNX） | **B** | 去掉 Python 门面 + yaml 解析；体积小（模型在用户声库里） | dsdur 音素化/G2P（pypinyin、OpenUtau g2p）仍需移植；`dsconfig.yaml` 结构解析 | `diffsinger/voicebank.py:227,335` |
| hnsep（Worldline v11，ONNX） | **B** | 与 UTAU 渲染同批 | STFT 复数掩码前后处理需重写 | `main/models.js:239-263`；`docs/VENDOR.md:21` |
| RVC 的 rmvpe（ONNX）+ 变声主体（torch） | **B + C** | rmvpe 可先搬；主体留 Python | hubert/检索（faiss）/变声解码链路 | `rvc/vendor/rvc/infer/rmvpe.py` |
| piano-transcription（.pth torch） | **C** | 体收益：需重写 CRNN 前向 + 踏板后处理 | torch→ONNX 导出可行性**待实测**（自定义 STFT/后处理） | `engine_pt.py` |
| Aria-AMT（safetensors，Whisper 式 seq2seq） | **C** | 大（426 MB 权重）；导出需处理 `amt` 自定义解码 | 自定义 tokenizer/解码循环，ONNX 动态轴 | `engine_aria.py` |
| Transkun（pip 包自带权重） | **C** | 54 MiB + torch 依赖 | Neural Semi-CRF 解码，第三方包不可导出 | requirements-bundle.txt:66 |
| hFT-Transformer（.pkl torch） | **C** | 22 MB 权重，CPU 可跑 | .pkl 是 torch pickle（非 safetensors），加载器要自写；模型代码已 vendored（可转） | `docs/VENDOR.md:106-112` |
| MuScriptor（103M/307M/1.4B，safetensors） | **C** | 最大体积收益之一，但 1.4B 权重 5.2 GB | decoder-only transformer + MT3 tokenizer + 采样/beam；Rust 推理工程量极大 | `engine_muscriptor.py:1-7` |
| YourMT3+ / MIROS（.ckpt） | **C** | 各自附带整套 `site/` Python 运行时（MIROS 5.36 GB） | ckpt 含训练态结构 + MusicFM 编码器；几乎等于重训 | `main/models.js:79-122` |
| MSST 分离（pymss + .ckpt/.yaml） | **C** | 21 GB 模型资产；分离是长任务，Rust 吞吐收益明显（推断） | 29 种架构（bs_roformer/mel_band/htdemucs/mdx23c/scnet…）逐个实现不现实 | `engine_msst.py:1-10` |
| RVC 训练/微调、GPT-SoVITS 类训练 | **C（不搬）** | — | 训练栈是 PyTorch 生态独占 | 仓库外（`_attic\gsv*`） |
| OMR · Audiveris | **D** | 无 Rust 等价 OMR；替换＝自研（=重写 2,374 行+Java 生态） | Java 启动 + tessdata；精度是现有唯一可用来源 | `main/omr.js:19-36` |
| OMR · classical | **A**（但精度不足） | 1,563 行 numpy/scipy/PIL 可搬 | 精度差距是量级（Audiveris 2062 音符 vs 经典算法），搬它不解决问题 | `engine_omr_backends.py:6` |
| ffmpeg（解码/转码/缩略图） | **D（保留 sidecar）** | 用裸 ffmpeg.exe 替代 imageio_ffmpeg 包装：**省的是进程不是字节** | 分发许可（LGPL/GPL 构建）、Windows 路径 | `audio_io.py:64-74` |
| Audiveris 之外的 Java（无） | — | — | — | — |

### 3.2 分阶段推荐（按"单位工程量收益"排序）

| 阶段 | 内容 | 预估收益 | 风险 |
|---|---|---|---|
| R1 | SF2/SF3 + MusicXML/MXL + MIDI 编辑/后处理/合并 + `.ustx` 互转 | 5 个模块、约 1,900 行纯算法迁走；Python 调用点减少约 12 处 | 低（可 golden 对拍） |
| R2 | UTAU/OpenUTAU 渲染（先自研 `engine_utau.py` 链路，再 openutau） | 最大的一块纯 DSP；渲染实时性提升 | 中（听感验收） |
| R3 | 音频链（解码→重采样→降噪→EQ）、basic-pitch + audio-tagger（ONNX） | 可删 llvmlite/numba/resampy/librosa/basic_pitch ≈ **127 MiB**，首次 resample 2.24 s 归零 | 中（数值对拍） |
| R4 | DiffSinger + hnsep（ONNX） | 歌声合成链去 Python 门面 | 中（G2P） |
| R5+ | torch 系（8 模型 + MSST + RVC） | 只有全做完才能删 torch（383 MiB） | **高/长周期**，见 §7 |

---

## 4. Python 运行时瘦身路线

### 4.1 当前构成（基线 B = 1,101.4 MiB / site-packages 1,059.8 MiB，实测 lstat）

| 包 | MiB | 引擎是否导入（静态 grep + 审计动态阻断） | 归属批次 |
|---|---:|---|---|
| torch | **382.9** | 是（piano/aria/transkun/hft/muscriptor/yourmt3/miros/msst/rvc/cover） | P3（最后） |
| llvmlite | 115.1 | 是，但**只在 librosa 首次 resample**（2.24 s） | P1 |
| imageio_ffmpeg | 83.6 | 是（`audio_io.py:70` 取静态 ffmpeg） | P1'（换裸 ffmpeg，不省字节） |
| scipy (+libs) | 66.7 + 19.3 | 是（audio_chain/smart_midi/OMR/librosa） | P1 |
| av.libs + av | 64.1 + 3.2 | 是（basic_pitch 导入即拉 PyAV） | P1 |
| transkun | 54.0 | 是（钢琴子模型之一） | P3 |
| transformers | 49.7 | **是，但只挂在 RVC**：`rvc/vendor/rvc/infer/hubert.py:7` `from transformers import ... HubertModel`（审计 §2.1 判为"未导入"是**错的**，它只 grep 了顶层 engine_*.py） | **P2′**（需先把 HuBERT 换 ONNX） |
| onnxruntime | 41.7 | 是（basic_pitch/audio_tagger/diffsinger/hnsep/rvc-rmvpe） | P2 |
| numpy (+libs) | 14.1 + 20.2 | 是（全链路） | 保留 |
| PIL + fontTools | 14.0 + 11.2 | 是（OMR） | P1 |
| hf_xet | 8.9 | 否（HF 下载加速，仅 aria/muscriptor 下载期） | P0 候选（需确认 HF xet 不参与） |
| tokenizers | 7.3 | 是（transformers 的导入期依赖） | P2′（随 transformers） |
| numba | 6.9 | 是（librosa） | P1 |
| pretty_midi | 6.0 | 是（MIDI 写入） | P1 |
| onnx | 5.9 | 是（engine_gpu/ort_compat） | P2 |
| pip | 5.4 | 是（CPU 回退用内置 pip 装 wheels，`main.js:652`） | 保留/视 R2 决策 |
| ncls | 5.4 | 是（pretty_midi 依赖） | P1 |
| beartype | 5.2 | 是（pymss 依赖） | P3 |
| pypinyin / resampy / muscriptor / basic_pitch / pymss / safetensors | 3.3 / 3.2 / 2.6 / 2.1 / 1.0 / 0.8 | 是（歌声/重采样/模型/分离） | 分属 P1/P2/P3 |

> **与 2026-10-29 审计的两处差异（重要）**：
> 1. 当前构建**已无 sympy/pandas/sklearn/matplotlib 实体目录**（只剩 dist-info + mpl_toolkits/contourpy/kiwisolver/cycler/pyparsing ≈ 2.9 MiB），审计 §2.2 的"165 MiB 未导入包"已基本回收。
> 2. 审计 §2.1 把 **transformers 判为"未导入"是错的**：它被 RVC 的 HuBERT 依赖（`rvc/vendor/rvc/infer/hubert.py:7`），审计只 grep 了顶层 `engine/*.py`。因此 **49.7 MiB 的 transformers 不能按"未导入包"直接删**，要先做 RVC 的 HuBERT→ONNX（或换 fairseq 版加载器，`rvc/adapter.py:71` 注释提到该选项）。

### 4.2 分批删除计划（前置条件 / 收益 / 回滚）

| 批次 | 删除包（MiB） | 合计 | 前置条件（必须先做到） | 回滚方式 |
|---|---|---:|---|---|
| **P0** 无 Rust 依赖 | matplotlib 残留（mpl_toolkits/contourpy/kiwisolver/cycler/pyparsing）~2.9 + （可选）hf_xet 8.9 | **≈ 2.9（保守）/ 11.8（含 hf_xet）** | 确认 `hf_xet` 不参与 aria/muscriptor 的下载（下载走 `main/fast-download.js`，不走 huggingface_hub）；`deps.py` REQUIRED/DEEP_PROBE 与两份 GPU requirements 同步 | 改回 `requirements-bundle.txt` 重跑 `scripts/bundle-python.js` |
| **P2′** RVC HuBERT 换 ONNX 后 | transformers 49.7 + tokenizers 7.3 + huggingface_hub 2.4 + hf_xet 8.9 | **≈ 68.3** | RVC 变声的 HuBERT 特征提取已由 ONNX 版替代并对拍（`rvc/vendor/rvc/infer/hubert.py:7`）；GPU 包 `requirements-gpu-*.txt:6,14` 的 transformers 同步移除 | 同上 |
| **P1** A 类（MIDI/乐谱/SF2/USTX/UTAU/音频链）迁走后 | llvmlite 115.1 + numba 6.9 + resampy 3.2 + soxr 0.4 + audioread 0.1 + librosa 1.1 + scipy 86.0 + pretty_midi 6.0 + ncls 5.4 + mido 0.3 + PIL 14.0 + fontTools 11.2 + pypinyin 3.3 + _soundfile_data 2.3 + basic_pitch 2.1 + av 3.2 + av.libs 64.1 | **≈ 324.7** | ① basic-pitch 已在 Rust ort 跑通且精度对拍；② audio_chain/smart_midi/preprocess/cover_mix/align_sofa 的 DSP 已 Rust 化；③ OMR classical 已 Rust 化；④ UTAU/DiffSinger 的声库解析已 Rust 化；⑤ **Python 侧剩余 torch 模型仍需要音频解码** → 由 Rust sidecar 提供 `decode` 服务（新增契约） | 保留旧 `resources/python` 目录快照（构建产物整目录 git 外备份），回滚＝换回旧目录 |
| **P2** B 类（ONNX 推理点）迁走后 | onnxruntime 41.7 + onnx 5.9 + flatbuffers 0.1 | **≈ 47.7** | diffSinger/hnsep/audio_tagger/rmvpe 全部改走 Rust `ort`，且 A 类已完成（否则 basic-pitch 还在用 ort） | 同上 |
| **P3** C 类（torch 全链）迁走后 | torch 382.9 + torchgen 2.2 + torchaudio 1.2 + functorch 0.1 + transkun 54.0 + muscriptor 2.6 + pymss 1.0 + beartype 5.2 + omegaconf/einops/ml_collections ~2.0 + amt/ariautils ~0.4 + safetensors 0.8 | **≈ 452.4** | **8 个模型 + MSST 29 架构 + RVC 全部在 Rust 侧达到可接受精度/速度**（见 §7：不承诺） | 保留 Python 运行时 + torch 到 P3 完成后再整体下线；期间双轨 |

### 4.3 目标体积推演（基于 B 基线 1,101.4 MiB）

| 里程碑 | 删除合计 | 剩余 python | 说明 |
|---|---:|---:|---|
| 现状（6.4.2 构建） | — | **1,101.4 MiB** | 实测 |
| P0 | −2.9 | **≈ 1,098** | 只改残留 dist-info/纯依赖死文件，半天 |
| P0+P1 | −327.6 | **≈ 774** | A 类全部迁走（不含 imageio_ffmpeg 的 83.6 → 换裸 ffmpeg 仍占 ~80） |
| +P2′（RVC HuBERT ONNX） | −395.9 | **≈ 706** | 去掉 transformers 依赖链 |
| +P2（B 类 ONNX 点迁走） | −443.6 | **≈ 658** | onnxruntime 也走 Rust |
| 全迁（P3 后） | −896.0 | **≈ 205** → 再去掉 numpy/pip/杂项 ≈ **0** | 此时 Python 运行时整体删除，与 Electron 解耦 |

> 注意：**只要 torch 系不迁，Python 运行时下限固定在 ~650 MiB 量级**（含 onnx 侧清空）。这就是"双轨"的真实成本——它比"1.48 GB → 0"的宣传口径要诚实得多：**A+B 全做完仍有 ~650 MiB**，因为 torch 系 8 个模型 + MSST + RVC 主体都还在 Python 里。

### 4.4 引用审计方法（每批删除前必做）

1. **静态**：`grep -rn "import X\|from X" engine --include=*.py`（排除 tests）→ 0 命中才允许进候选。
2. **动态阻断**（沿用审计 `bench/block.py` 思路）：`sys.meta_path` 首位插 finder 对候选包抛 ImportError，然后导入 39 个 `engine_*` 模块 + 跑 6 条端到端链路（basic / muscriptor / piano / separate / OMR / 翻唱 / DiffSinger）——任一失败即回滚该包。
3. **门禁**：把"删包"与这 7 条冒烟绑进同一条 CI；`scripts/bundle-python.js` 末尾的 `deps.py check` 已是天然自检点（`:176`）。
4. **回滚**：`resources/python` 整目录在构建前快照（不属源码，可 git 外保留）；回滚＝还原目录 + 还原 `requirements-bundle.txt` 一行。

---

## 5. Rust 技术选型

### 5.1 推理运行时（三条路的边界）

| 方案 | 适用 | 优势 | 边界/代价 | 证据（crates.io，2026-11 查） |
|---|---|---|---|---|
| **`ort`**（onnxruntime 绑定） | B 类全部（basic-pitch / audio-tagger / DiffSinger / hnsep / rmvpe） | 与现有 Python 侧 ort **同一引擎**（1.31.0），数值一致性最容易保证；EP（CUDA/TensorRT/DirectML）与现有 GPU 包对齐 | 最新是 **2.0.0-rc.0**（预发布，API 可能再动）→ 建议钉 1.x 稳定线；捆绑 onnxruntime.dll（每个 EP 一份，体积 +40 MiB 量级） | `index.crates.io/3/o/ort` 实测：30 个版本，latest=2.0.0-rc.0 |
| **`candle`** | 需要纯 Rust、无 C++ 依赖的模型（UTF 前向/小模型） | 纯 Rust、HuggingFace 维护、活跃 | 要手写模型结构（muscriptor 1.4B / aria seq2seq 均不现实）；算子覆盖与 ort 有差距 | crates.io：candle-core **0.11.1**，11,102,730 下载，更新 2026-10-31 |
| **`tch`**（libtorch） | 过渡期跑 .pth/.ckpt | 能直接读 torch 权重，迁移阻力最小 | **要带 libtorch（数百 MiB～2 GB）**，与"减体积"目标直接冲突；只应作为 P3 前的验证工具 | 推断（libtorch 分发体积事实） |
| 自研（纯 Rust） | A 类 DSP/格式 | 无运行时依赖、体积最小 | 只有 A 类适合 | — |

### 5.2 能力 ↔ crate 对应表

| 需求 | 推荐 | 成熟度 | 证据 / 备注 |
|---|---|---|---|
| ONNX 推理 | `ort`（+ `ort-sys`） | 高（但 2.0 RC） | 见 5.1 |
| 音频解码（wav/flac/mp3/aac/ogg） | **`symphonia`** | 高 | crates.io：**0.6.1**，20,089,607 下载，更新 2026-08-13 |
| 容器（m4a/mp4/mkv/视频） | symphonia 的 isomp4/mkv 支持有限 → **保留 ffmpeg sidecar** | 中 | 推断（symphonia 对 isomp4 支持为可选/实验特性，需实测） |
| 重采样 | **`rubato`** | 高 | **5.0.1**，14,657,628 下载，2026-10-01 |
| 写/读 MIDI（SMF） | **`midly`** | 高但停更 | **0.5.3**，560,024 下载，最后更新 **2023-01-01**（稳定但无新特性；仓库已有手写 SMF 解析先例 `rust-core/src/main.rs:44-140`） |
| MusicXML / MXL | **自写解析器**（不依赖 crate） | — | `musicxml` crate：**1.1.2**，仅 21,970 下载，更新 2024-11-05 → 采用度低；而 `engine_score2midi.py`（606 行纯 stdlib）证明自写可行 |
| SF2 解析/合并 | **自写**（`sf2_merge.py` 521 行算法可直接翻） | — | 无成熟 crate；`oxisynth` **0.1.0**、36,688 下载、2025-05-25（是合成器不是 SF2 编辑库，版本停在 0.1） |
| SF3（Ogg/Vorbis 采样） | `lewton`/symphonia vorbis 解 Ogg + 自写 SF2 组装 | 中 | 推断 |
| SF2 实时合成（播放） | 现有 `js-synthesizer`/libfluidsynth wasm 保留；Rust 侧可用 `fluidsynth` 绑定或 `oxisynth` | **低** | `oxisynth` 0.1.0（见上）；`rusty-soundfont` 在 crates.io **404**（实测） |
| 音频 DSP（滤波/STFT/重采样/响度） | `realfft`/`rustfft` + `ebur128` + 自写 | 高 | 推断（rustfft 为事实标准） |
| 降噪（谱减/RNNoise） | 自写谱减（`audio_chain.py` 算法可翻）或 `nnnoiseless` | 中 | 推断 |
| PDF 页面渲染（OMR 输入） | `pdfium-render`（需 pdfium 动态库）或 `mupdf` 绑定 | 中 | 推断；**引入 C++ 二进制**（约 10 MB 级），与"减体积"部分抵消；crates.io 元数据本次抓取失败（**待核**） |
| 图像处理（OMR 预处理/符头检测） | `image` + 自写匹配滤波 | 高 | 推断；`engine_omr.py` 算法以 spacing 为单位，纯像素运算 |
| 中文拼音（UTAU 歌词） | `pinyin` crate | 高 | 推断（需与 pypinyin 输出对拍：无声调拼音） |
| JSON / 序列化 | `serde_json` | 高 | 仓库已有先例 |
| CLI / IPC | 标准库 stdin/stdout 行协议（**与现有 `###RESULT` 契约一致**） | — | 见 §6 |
| napi 原生模块（可选） | `napi-rs` | 高 | 推断；但见 §6.1 风险（panic=abort） |

### 5.3 明确"不成熟/不建议押注"的项

| 项 | 判断 | 证据 |
|---|---|---|
| `musicxml` crate | 不建议作为唯一解析器（采用度低、解析覆盖未知） | 21,970 下载 / 2024-11 停更 |
| `oxisynth` / 任何 Rust SF2 合成 | 不建议替换现有 fluidsynth wasm | 0.1.0 / 36,688 下载 |
| `rusty-soundfont` | 不存在（crates.io 404） | 实测 |
| `ort` 2.0 | 已到 RC，仍属预发布；生产建议 1.x | sparse index 实测 |
| 任何 Rust OMR 端到端库 | 无；`engine_omr.py` 自研精度不足（Audiveris 2062 音符是量级差异） | `engine_omr_backends.py:6` |
| Rust 侧 torch 权重加载（.pth/.ckpt） | 需自写 pickle-unpickler 或转 safetensors/ONNX，短期不现实 | `hft` 权重是 .pkl（`docs/VENDOR.md:112`） |

---

## 6. 进程 / 协议设计

### 6.1 三种集成形态对比

| 形态 | 与现有契约的兼容 | 启动/延迟 | 崩溃影响 | 体积 | 结论 |
|---|---|---|---|---|---|
| **sidecar 可执行 + stdin/stdout JSON 行**（推荐） | **完全兼容**：现有 `main/engine.js` 的 `spawnEngine` / worker 池 / `###PROG` / `###RESULT` / `###LOG` 一字不改；取消＝kill child（`main/engine.js:435-461`）；暂停＝flag 文件（`engine/pause_gate.py`、`main/engine.js:102`） | 进程启动 ~10 ms（Rust）vs Python 0.5 s+import 13.47 s | 只死子进程，主进程能降级 | 单个 exe（`rust-core` 现例 351 KB） | **首选** |
| napi 原生模块（进程内） | 需重写 `main/engine.js` 的进程模型；取消需自带线程取消 | 无进程启动成本；但长 CPU 任务必须走 libuv 线程池 | **Rust panic 会带崩 Electron 主进程**（`src-tauri/Cargo.toml` 用 `panic="abort"`，napi 侧必须 `catch_unwind`+`panic="unwind"`） | 一个 .node（包含 ort 时数十 MB） | 只适合毫秒级热路径（MIDI 解析/统计/量化），不适合模型 |
| 本地 HTTP/gRPC | 需新增端口、鉴权、生命周期；与 248 通道的 IPC 契约并存两套 | 首次连接 + 服务管理 | 服务崩溃可重启 | 与 sidecar 相近 | 过度设计；仅当未来要多窗口/多进程共享引擎时再考虑 |

### 6.2 与现有 worker 池 / 暂停 / 取消 / 进度契约的兼容方式

| 契约 | 现状实现 | Rust 侧对齐方式 |
|---|---|---|
| 请求分发 | worker 池 1–4 槽，stdin 一行一个 JSON（`main/engine.js:249-281`） | sidecar 同样按行读 JSON，`_id` 原样回填 `###RESULT` |
| 进度 | `###PROG {"completed":n,"total":m}`（engine.js:159-164 解析） | 复用同字段；Rust 侧按 audio 时长/模型 chunk 计算 |
| 日志 | `###LOG {"_id":..,"line":".."}`（`music2midi.py:619-638`） | 同格式；主进程的中文前缀过滤规则（`engine.js:165`）要同步扩 |
| 取消 | `cancelJob` → `child.kill()`（`engine.js:456`） | 与 sidecar 进程模型天然一致；**不要**设计成"软取消"（Python 侧已证明只 reject Promise 停不下来） |
| 暂停/继续 | 暂停 flag 文件（`pause_gate.py:1-10`；`engine.js:92-112` 计时扣除） | sidecar 每 chunk 检查同一 flag 文件；不引入新协议 |
| 超时/看门狗 | 总超时 + 无进展看门狗（`engine.js:97-112`） | 保留；Rust 侧无需额外心跳（有 `###PROG` 即有活动） |
| 内存闸 | 提交前 + 运行中 700 MB 闸（`engine.js:206-279`） | 保留在 Electron 侧（与语言无关） |

### 6.3 双跑降级策略（必须做，否则一次 Rust 回归就是线上事故）

1. **开关**：设置项 `engineBackend = auto | rust | python`（默认 auto）。auto 的规则：A 类任务走 Rust，B/C 类走 Python。
2. **降级触发**：Rust sidecar 启动失败 / 非 0 退出 / 超时无 `###PROG` / 输出非 JSON → 该请求**当次**回退 Python 一次性路径，并记一条 `engine:log` + 计数（沿用现有"会话崩溃不重试、调用方回退"的先例，`main/engine.js:305-312`）。
3. **对拍**：A 类每个迁移点先跑 `python引擎 vs rust` 的 golden diff（输出 MIDI 事件的 tick/velocity 完全一致；SF2 输出的 preset/采样表逐字段一致）。CI 里保留 7 条端到端冒烟（审计 §20 #6 已列出这 7 条）。
4. **灰度**：`engineBackend` 默认 rust 只对"已对拍通过"的模块，其余保持 python；不做全局切换。

### 6.4 建议落地顺序（与 §3.2 对齐）

| 步 | 内容 | 对 Electron 的改动 |
|---|---|---|
| 1 | 扩 `rust-core`（现有 7 个命令）加 `sf2-merge / sf3-to-sf2 / musicxml-to-midi / midi-edit / ustx-convert` | 只加 `rust:invoke` 的 cmd（`main/rust.js:81`），零协议改动 |
| 2 | 新 sidecar `fufumidi-engine`（长期运行，worker 协议）承载 UTAU 渲染 + 音频链 | `main/engine.js` 增一个 `spawnEngine` 目标（`script` 换成 binary path） |
| 3 | A 类迁完后删 P1 包 | `scripts/bundle-python.js` 依赖清单 + CI 冒烟 |
| 4 | B 类（ort）迁 `basic-pitch/audio-tagger/DiffSinger` | sidecar 内新增模型管理（模型路径走 `FUFUMIDI_MODELS_DIR`） |
| 5 | torch 系（可选，长周期） | 不承诺（§7） |

---

## 7. 不能承诺的清单

| # | 不能承诺的事 | 原因 | 现有证据 |
|---|---|---|---|
| 1 | **"2 小时内完成全部 torch 模型移植"** | 8 个模型 + MSST 29 架构 + RVC，且其中 3 个（aria/transkun/muscriptor）依赖上游训练框架的自定义解码 | `engine_aria.py` 需 Windows 补丁（`aria_win_patch.py:1-8`）；transkun 是 pip 包 |
| 2 | 用 Rust 替换 Audiveris 并保持同等识谱精度 | 无等价开源 Rust OMR；自研 classical 精度差一个量级 | `engine_omr_backends.py:6`（2062 音符 vs 量级差异） |
| 3 | 完全删除 ffmpeg（支持 m4a/视频） | symphonia 容器覆盖不足；现有"任意格式"承诺由 ffmpeg 保证 | `audio_io.py:1-9` |
| 4 | 删除 Python 运行时（在 torch 系迁完前） | torch 383 MiB + transkun 54 + transformers 50（GPU 包才需要）是硬依赖 | §4.1 表 |
| 5 | 迁移后"启动快 X 秒"的精确数字 | Electron 冷启动未测；本任务只测得 Python 侧 13.47 s 可省 | 待实测（§8） |
| 6 | 迁 UTAU/OpenUTAU 后"听感一致" | 需要人工听测；数值对拍只覆盖波形误差，不覆盖听感 | `engine_utau.py:1-22` 的 TD-PSOLA 语义 |
| 7 | MSST 29 种架构全部 Rust 化 | 每种架构的 STFT/掩码/拼接语义不同 | `engine_msst.py:1-10` |
| 8 | MIROS/YourMT3 迁 Rust | 各带独立 `site/` Python 运行时与训练态 ckpt | `main/models.js:79-122` |
| 9 | 用 Rust 训练/微调（RVC/GPT-SoVITS） | 训练栈是 PyTorch 生态独占 | 仓库外 |
| 10 | `ort` 2.0 稳定 API 承诺 | 目前是 RC（0.x→2.0.0-rc.0） | crates.io 实测 |
| 11 | 双轨下"内存一定下降" | 双轨＝Python 进程仍驻留（worker 120 s 回收，`engine.js:20`）；峰值可能不降反升 | 待实测（§8 #3） |

---

## 8. 待实测清单（按优先级）

| # | 待测项 | 方法 | 判据 |
|---|---|---|---|
| 1 | 各模型"首次可出结果"耗时（piano_pt/aria/transkun/hft/muscriptor/yourmt3/miros/MSST/RVC/OMR/UTAU） | 内置 python 跑对应 CLI，冷页缓存各 3 次取中位；记 `###PROG` 首条到达时刻 | 建立一张"模型加载基线表"，作为 Rust 迁后对比锚 |
| 2 | Audiveris 单页耗时与 JVM 启动成本 | 同一份 PNG 走 `engine_omr_backends.py to-midi`，wall time 分解 | 决定是否需要常驻 Java 进程 |
| 3 | 双轨（Rust sidecar + Python worker 并存）RSS 峰值 | Process Explorer / `Get-Process` 采样 | 峰值 ≤ 现状（否则双轨需限制并发） |
| 4 | UTAU 渲染搬到 Rust 后的实时性收益 | 同一 ustx 渲染 3 分钟音频，wall time 对比 | ≥ 2× 才算值得 |
| 5 | basic-pitch 从 ORT-Python 到 ORT-Rust 的数值一致性 | 同一音频输出 MIDI，逐音符 tick/velocity 差异 | 零差异或差异可解释 |
| 6 | 删除 P0 包后 7 条端到端链路 | 阻断 + 冒烟（审计 §20 #6 脚本思路） | 7/7 全绿才允许进构建 |
| 7 | .pth→ONNX 导出可行性（piano_pt / hft / muscriptor） | `torch.onnx.export` + 动态轴；对比输出 | 是否出现不支持算子（STFT/自定义后处理） |
| 8 | symphonia 对 m4a/mp4 的实际支持 | 用 3 个真实 m4a/mp4 测解码 | 支持则可去掉 ffmpeg 的部分用途 |
| 9 | `ort` 1.x 与现有 onnxruntime 1.31.0 的算子/EP 对齐 | 用同一 model.onnx 在两处跑并比输出 | 差异 < 1e-4 |

---

## 9. 附：本次实测命令与证据索引

| 证据 | 位置 |
|---|---|
| 引擎行数/文件数 | `for f in engine/*.py; do wc -l; done` → 71 文件 / 25,345 行 |
| 子包行数 | `find engine/{singing,diffsinger,rvc,tests} -name '*.py' -exec cat {} + | wc -l` |
| 当前构建 python 体积 | `node E:/Midi/_attic/tmp-engine/sz.cjs` → 15,207 文件 / 1,101.4 MiB |
| 安装版 python 体积 | `node E:/Midi/_attic/tmp-engine/sz2.cjs` → 56,097 文件 / 1,695.8 MiB |
| site-packages 全量 | `node E:/Midi/_attic/tmp-engine/all.cjs` |
| 模型格式直方图 | `find FuFumidiData/models -type f \(-name '*.ckpt' -o ...\) -printf` → ckpt 11,036 MB / safetensors 7,202 MB / pt 1,256 MB / pth 502 MB / pkl 21 MB / onnx 57 MB |
| 随包模型 | `du -sh resources/models` → 211.7 MiB / 9 文件（piano .pth 171,966,578 B、audio-tagger 27,038,066 B、ced 22,626,947 B、basic_pitch_quant 264 KB） |
| crate 元数据 | crates.io API / sparse index（midly 0.5.3、symphonia 0.6.1、rubato 5.0.1、candle-core 0.11.1、oxisynth 0.1.0、musicxml 1.1.2、ort 2.0.0-rc.0、rusty-soundfont 404） |
| 审计基线 | `docs/audit/2026-10-29/backend-perf.md` §1（:49-69）、§2（:72-135）、§5（:211-262）、§6.3（:279-290）、§20（:704-720） |
| 现有 Rust 能力 | `rust-core/src/main.rs`（571 行，7 命令）、`main/rust.js`（87 行，2 通道）、`src-tauri/src/engine.rs`（655 行，Python spawn 移植） |
