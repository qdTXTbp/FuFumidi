# 翻唱工作流（分离 → 扒谱 → 合成 → 混音）

> 一句话：**一首歌进去，一个成品出来。** 人声分离复用「音频处理」那套模型，
> 扒谱把原唱变成「音符 + 歌词」，合成有两条音色通道，最后混成成品。
>
> 引擎只有一份实现：`engine/engine_cover.py`（CLI 与界面走同一条路）。
> 界面：导航「翻唱」（`frontend/src/views/ViewCover.vue` + `main/cover.js`）。

## 链路

```
源音频 ─┬─ 分离（music2midi.py separate，与「音频处理」面板同一个入口）→ vocals / instrumental
        │
        ├─ 扒谱（engine/cover_notes.py：pyin + onset + 音节规则 + LRC 歌词）→ notes.json
        │
        ├─ 合成（二选一）
        │    ① DiffSinger 声库：notes → 逐句渲染（engine_diffsinger.py sing-render）
        │    ② GPT-SoVITS 音色：逐句拿原唱那一句当参考重合成（engine_gpt_sovits.py sing）
        │
        └─ 混音（engine/cover_mix.py：配平 + 吐字 EQ + 压缩 + 混响）→ <名称>.wav
```

两条合成通道的产出**同构**：一条整长干声轨（时间轴与原曲对齐）。所以混音、分离复用、
断点续跑对这些能力两条通道完全共用。

## 从界面怎么用

1. 导航「翻唱」→ ① 选歌（flac/wav/mp3/m4a…）；
2. ② 选音色：**DiffSinger 声库**（调教 → 声库 里装的）或 **GPT-SoVITS 音色**
   （资源中心下载的社区微调音色）；
3. ③ 输出目录 / 名称 / 设备 / 清晰度 ④ 开始翻唱。

命令行等价物：

```bash
# DiffSinger 声库
python engine_cover.py all 歌曲.flac --outdir 输出目录 --voicebank <声库目录> --device auto

# GPT-SoVITS 音色（逐句参考重合成）
python engine_cover.py all 歌曲.flac --outdir 输出目录 --gsv-voice gsv_nene \
    --gsv-root <GPT-SoVITS 目录> --gsv-python <装好 torch 的 python> --device auto
```

## 断点续跑（默认开）

每一步的产物旁边写一份 `*.meta.json` 签名（输入文件大小 + mtime + 参数）：

| 步骤 | 产物 | 复用的条件 |
|---|---|---|
| 分离 | `sep/src_Vocals.wav`、`src_Instrumental.wav` | 文件在（`--vocals/--instrumental` 可外部指定） |
| 扒谱 | `notes.json` + `notes.meta.json` | 人声轨、歌词、语言、BPM、声库名都没变 |
| 渲染 | `render/chunkN.wav` + `chunkN.meta.json` | 声库 onnx 指纹、BPM、步数、该段音符都没变 |
| 合成（GSV） | `gsv/line_NNN.wav` + `gsv/lines.meta.json` | 文本、参考段、音色、对齐开关、种子都没变 |

`--no-resume`（界面上的「不复用上次的中间结果」）强制全部重算。
`state.json` 记录每一步的进度，重跑时先打印上次停在哪。

## GPT-SoVITS 通道：为什么是「逐句参考重合成」

本地 vendored 的 GPT-SoVITS 是**纯 TTS**：`SoVITS.infer(ssl, y, text, …)` **没有 F0 入口**，
旋律只能由**参考音频的 mel** 带出来。所以让它「唱指定旋律」最省事又稳的办法是：

    原唱第 N 句（已分离人声）→ 当参考音 → 用目标音色重合成 → 对齐/校正 → 填回时间轴

音色来自声库权重，旋律/节奏/咬字来自原唱本身 —— 这就是「复用下载的音色 + 省事」的那条路。
参考音窗口**必须落在 3~10 秒**（GPT-SoVITS 的硬性检查），而目标时长是这一句真正的演唱跨度，
两者**分开算**（`engine_gpt_sovits.py::_line_ref` 与 `tgt`）。

### 对齐与客观量（`engine/gsv_align.py`）

* **时长**：整段相位声码器拉伸到目标跨度（不拉伸会越唱越偏，串行累积）；上限 1.6×。
* **音高**：有 pyworld 就用 WORLD 把输出的 F0 换成原唱这一句的 F0（sp/ap 不动，音色保留）；
  单帧偏移限幅 ±7 半音、只替换双方都有声的帧。**没有 pyworld 就跳过并如实上报**，不假装做过。
  （本机 GPT-SoVITS 环境需 `pip install pyworld`。）
* **电平**：逐句配平到原句 RMS（限幅 ±8 dB）—— 不配平会「一句响一句轻」。
* **客观量**：`f0_corr`（旋律像不像原唱）、`mfcc_dist_ref` / `mfcc_dist_voice`（像原唱 / 像目标音色）。
  `f0_corr ≥ 0.6` 认为路线 A 成立；`< 0.3` 说明参考音没能带出旋律，该换路线 B（专门的 SVC）。

## GPT-SoVITS 的四个坑（都已在代码里解决，别再踩）

1. **`TTS_Config` 的入参必须包在 `"custom"` 里**。它的实现是
   `configs_.update(你传的字典)`，然后取 `configs_.get("custom", configs_["v2"])` ——
   顶层没有 `custom` 就直接落到 **v2 默认段**，你传的权重路径**全部被丢掉**
   （日志里表现为一片 "fall back to default …"）。见 `gsv_env.build_config`。
2. **默认权重路径是相对 CWD 的** → 必须 chdir 到仓库根，并传绝对路径。
3. **参考音必须 3~10 秒**，超了直接抛「参考音频在3~10秒范围外，请更换！」。
4. **torch 2.11 的 torchaudio 走 torchcodec**，需要 FFmpeg **共享库**；没有就抛
   「Failed to create AudioDecoder … Could not load libtorchcodec」。
   `gsv_env.patch_audio_io()` 把 `torchaudio.load` 换成 soundfile 实现（不碰 FFmpeg）。

另外：`USERNAME` 环境变量缺失时 GPT-SoVITS 的 `getpass.getuser()` 会去 import `pwd`
（Windows 上没有）→ `gsv_env.bootstrap` 会补上。

## 运行时与音色从哪来

* **运行时**（代码 + 预训练基础模型）：`FUFUMIDI_GSV_ROOT` /
  `<数据根>/gpt-sovits/runtime.json` 的 `{"root": "...", "python": "..."}` /
  `<数据根>/gpt-sovits/runtime/`（资源中心装的那种）。解析见 `gsv_env.find_runtime`。
* **解释器**：GPT-SoVITS 必须跑在**装好 torch 的那套环境**里；`FUFUMIDI_GSV_PYTHON` 指过去
  （应用自带的 python 没有 torch/transformers）。界面上的「解释器」输入框就是它。
* **音色**：`<模型目录>/gpt-sovits/voices/<id>/`（`gpt.ckpt` + `sovits.pth` + `ref.wav`），
  目录与 `main/gpt-sovits.js` 的 `voicesRoot` 是同一个东西；文件名不写死，
  `gsv_env.find_weights` 按后缀归类（`芙宁娜-e10.ckpt` 这种命名也认）。

## 性能与守卫（实测）

* **ONNX 会话缓存**（`diffsinger/session.py`）：建会话要重新解析计算图 + 分配权重
  （acoustic 200MB+，一次 3~8 秒）。缓存后同一模型只解析一次；缓存键含**文件大小 + mtime**，
  换声库自动失效。这是「整首一次渲染」能跑通的前提（以前要切成 ≤140 音符的小段绕开）。
* **声库加载缓存**（`diffsinger/voicebank.py`）：同一进程内 `load_singer` / `model_hash` 只算一次。
* **分离/渲染的 GPU 守卫**：GPU 被别的进程占满时**降级 CPU 并如实上报设备**
  （GPU 上静默退出是实测踩过的坑；分离的 TTA + batch>1 在长歌上会撑爆显存）。
* **DP 不一致**：混音链的峰值 EQ 必须按 `a0` 归一化，否则 `filtfilt` 会在静音段爆到 1e7。

## 相关文件

| 文件 | 作用 |
|---|---|
| `engine/engine_cover.py` | 编排 + 进度/结果协议 + 断点续跑 |
| `engine/cover_notes.py` | 扒谱（pyin + onset + 音节规则 + LRC） |
| `engine/cover_mix.py` | 混音（配平 + 吐字 EQ + 压缩 + 混响） |
| `engine/engine_gpt_sovits.py` | GPT-SoVITS 通道（`say` 念白 / `sing` 逐句参考重合成） |
| `engine/gsv_env.py` | 运行时定位、`TTS_Config` 装配、四个坑的修补 |
| `engine/gsv_align.py` | 时长拉伸 + WORLD F0 校正 + 客观量 |
| `main/cover.js` | 主进程 IPC（选文件/目录、起任务、进度、取消、打开文件夹） |
| `frontend/src/views/ViewCover.vue` | 界面 |
| `docs/DOWNLOADS.md` | 所有下载走 `main/fast-download.js` 的规范（音色下载同样适用） |
