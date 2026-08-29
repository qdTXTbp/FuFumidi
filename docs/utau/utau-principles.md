# UTAU 引擎原理笔记（P1 交付物）

> 阶段：P1 原理研究 ｜ 目的：为 FuFuMIDI 接入「歌词→人声」合成（UTAU 式）提供原理基线
> 更新：2026-08-29

---

## 1. 合成流水线总览

```
歌词 + 音符(音高/时长)
        │
        ▼
  ┌─────────────────────────────────────────────┐
  │  Phonemizer（音素转换）                       │
  │  把歌词拆成引擎可查的拼接单元（音素序列）       │
  └─────────────────────────────────────────────┘
        │  音素序列（如 VCV 的 -ka / a-ki / ...）
        ▼
  ┌─────────────────────────────────────────────┐
  │  Resampler（重采样引擎）                      │
  │  ① 按 oto.ini 从音源切出对应采样片段          │
  │  ② 变调（pitch）＋ 变速（stretch/loop）       │
  │  ③ 应用 flags / 音量 / 调制                   │
  └─────────────────────────────────────────────┘
        │  每个音素一段独立 WAV
        ▼
  ┌─────────────────────────────────────────────┐
  │  Wavtool（拼接合成器）                        │
  │  交叉淡化相邻片段、加包络(envelope)、          │
  │  颤音(vibrato)、合成多轨道混音                 │
  └─────────────────────────────────────────────┘
        │
        ▼
  歌声 WAV
```

- **UTAU 是"白盒"采样拼接合成器**：它自身不携带任何声音，声音完全来自用户提供的录音采样（音源）。
- 核心数据流：`歌词/音符 → 音素序列 → 逐音素采样切分与变调 → 拼接合成`。
- OpenUtau 的渲染链路完全一致：`Phonemizer → Resampler(worldline) → Wavtool(simple/convergence)`。

---

## 2. 音源（Voicebank / Voice Library）

### 2.1 目录结构

一个 UTAU 音源就是一个文件夹，最小要求如下：

```
voicebank/
├── oto.ini            # 必需：原音设定，逐采样标注时间信息
├── character.txt      # 元信息（name/image/author/web/sample 等）
├── あ.wav             # 采样音频（假名或罗马音文件名）
├── か.wav
├── ...                # 数量取决于音源类型（几十~上千个）
├── *.frq              # 频率分析文件（resampler 用，可由 mkdefo.exe 预生成）
└── prefix.map         # 可选：多音高/多语气音源的别名前缀映射
```

> 编码注意：传统 UTAU 音源为 Shift-JIS；UTAU 0.4.10+ 与 OpenUtau 支持 UTF-8（无 BOM）。中文场景必须显式处理编码，否则文件名/别名会乱码。

### 2.2 音源类型（录制方案）

| 类型 | 全称 | 采样粒度 | 特点 |
|---|---|---|---|
| CV | Consonant-Vowel | 单音节（か=ka） | 最基础、易录制；连读偏生硬 |
| VCV | Vowel-Consonant-Vowel | 元音-辅音-元音（a-ka） | 元音过渡自然，连续音音源主流 |
| CVVC | C-V-V-C | CV 单元 + VC 结尾 | 比 VCV 小，适合多语言 |
| CVVV | C-V-V-V | CV + VV 过渡 | 比 CV 顺滑，录制略复杂 |
| VCCV | V-C-C-V | 英语连续音 | 专为英语设计 |

- **Reclist**：录制清单文件，列出需要录制的全部音节组合。公开 reclist 有日文 VCV/CVVC、中文 CVVC、英文 ARPAsing/VCCV 等。
- 多音高音源：录制多套子库（subbank），通过 `prefix.map` 在演唱时按音域自动选择；也可录制不同语气/声线作为音色库（appends/voice colors）。

### 2.3 录制规范要点（P3 声库工具的设计输入）

- 同一麦克风、同一设置、稳定音量，保证音色一致；
- 建议先用**单音高**起步，之后扩充多音高/多声线；
- 常用"引导 BGM"（guide BGM）让采样保持统一 BPM 和音高；
- 专业录音引导工具：Oremo、Akorin、RecStar（逐行提示录制并按行文本自动命名）。
- 录制完成后用 oto 工具（UTAU 内建、SetParam、vLabeler）标注。

---

## 3. oto.ini 详解（原音设定）

### 3.1 格式

每行一条采样：

```
文件名.wav=别名, オフセット, 子音部, ブランク, 先行発声, オーバーラップ
文件名.wav=alias, offset, consonant, blank, preutterance, overlap
```

示例（CV）：

```
あ.wav=あ,20,30,40,30,20
```

| 字段 | 含义 | 单位 | 起点 |
|---|---|---|---|
| alias | 别名，歌词里写它就能调用该采样；留空=文件名 | - | - |
| offset（左ブランク） | 有效片段起点；之前的部分静音丢弃 | ms | 文件头 |
| consonant（子音部） | 辅音区长度；之前的部分**不做拉伸/循环** | ms | offset 起 |
| blank（右ブランク） | 有效片段终点；之后的部分丢弃 | ms | 文件尾（正数）/ offset（负数） |
| preutterance（先行発声） | **音符起点**；决定演唱时值对齐，最重要字段 | ms | offset 起 |
| overlap（オーバーラップ） | 与前一个音的交叉淡化量 | ms | offset 起，可为负 |

### 3.2 约束（实现时校验）

- `offset / consonant / preutterance` 只能为正；
- `overlap` 可以为负；
- `blank` 正数 = 从文件末尾往回算；负数 = `-1 × offset 起算时间`；
- **blank 与 consonant 之间必须 ≥1ms**，否则引擎崩溃；
- 通用规则：preutterance 落在辅音末尾、元音之前；overlap ≤ preutterance/2 附近，否则包络异常。

### 3.3 关键原理：CV 模型

- **辅音区（fixed region）**：offset→consonant，随音符变调但**不拉伸**（长音靠循环/重复）。
- **元音区（vowel region）**：consonant→blank，音符拉长时在此**拉伸或循环**。
- VCV 依赖 overlap 做**元音交叉淡化**：上一个音的元音尾与 VCV 采样前缀元音重叠混音，形成平滑过渡；overlap 应落在稳定的前缀元音内。
- 制音质技巧：consonant 与 cutoff 尽量放在波形"波谷"（零交叉附近），循环时无跳跃。

---

## 4. Resampler（重采样引擎 / 变调变速）

### 4.1 命令行协议（与 UTAU/OpenUtau 兼容实现必须遵守）

```
resampler.exe <input> <output> <pitch> <velocity> [<flags> [<offset> <length> [<fixed> [<endblank> [<volume> [<modulation> [<pitchbend>...]]]]]]]
```

| 参数 | 说明 | 示例 |
|---|---|---|
| input / output | 原音采样路径 / 合成结果路径 | か.wav → 1_か_C4.wav |
| pitch | 音高，音名+八度（如 C4、G#4），与钢琴卷帘一致 | C4 |
| velocity | 子音速度 0~200，100=不变；越大辅音区时间越短 | 100 |
| flags | 调声标志（见 §6） | g-3Y90 |
| offset | 左ブランク（ms） | 5.0 |
| length | 需要的音长（ms，含拉伸） | 550 |
| fixed | 子音部（ms），不参与拉伸 | 115.0 |
| endblank | 右ブランク（ms） | 247.0 |
| volume | 音量（%） | 100 |
| modulation | 保留原音音高起伏比例 0~100；0=完全压平 | 0 |
| pitchbend | 音高曲线 `!<tempo> <串>`，每 2 字符 1 点，12bit 有符号 cent | !120 AA#88... |

### 4.2 音长（length）的计算规则（UTAU 实测行为）

```
length = 音符长度
       + 本音先行発声（食い込み補正前）
       - 后音先行発声（食い込み補正后）
       + 后音オーバーラップ（食い込み補正后）
       + 50
（结果 < fixed 时取 fixed；再按 50ms 四舍五入，24 舍 25 入）
```

### 4.3 变调变速实现思路（自研参考）

- 元音区：通过**重采样（resampling）或循环拼接**改变音高/时长；辅音区只变速不拉伸。
- 简单方案（NUTAU 采用，无 STFT）：**重采样 + 循环**组合，避免 STFT/ISTFT 的算力与伪影问题；变调时用零交叉对齐使循环无跳跃。
- 高质量方案：相位声码器（phase vocoder）/ WORLD（如 OpenUtau 内置 worldline，DIO 提基频 + 频谱建模重建）。
- `modulation` 控制"原音音高起伏"保留程度——压低时更像稳定的乐音，保留时更有"人味"。

### 4.4 .frq 频率文件

- resampler 变调前需要原音的音高分析结果，默认读 `.frq` 文件（与采样同名）。
- `mkdefo.exe` 可预生成；flags 里 `G` 强制重新生成、`T` 导出文本频率表、`N` 关闭 formant filter。
- 实现时注意：frq 是"音高/音量随时间变化"的紧凑格式，可缓存避免每次重算。

### 4.5 常见 resampler（可插拔生态）

| Resampler | 说明 |
|---|---|
| resampler.exe | UTAU 默认，通用 |
| fresamp14 | 质量口碑好，需 F0 flag，帧尺寸可调 |
| tn_fnds / bkh01 | 循环拼接型，长音靠循环 |
| doppeltler | 高速 |
| EFB-GT / EFB-PB | 循环型 |
| moresampler | 独有 flag 体系，音质上限高 |
| worldline | OpenUtau 内置，WORLD 算法，跨平台 |

---

## 5. Wavtool（拼接合成器）

- 职责：把 resampler 输出的**每音素一段 WAV** 拼接成完整歌声，处理：
  - **交叉淡化**（overlap 区域与前音混合，避免爆音/咔哒声）；
  - **包络（envelope）**：起音/衰减/释音曲线（p1..p4 参数）；
  - **颤音（vibrato）**：音高周期性波动；
  - 音量、时长对齐（STP 等）；
  - 多音轨混音、渲染到最终 WAV。
- OpenUtau 内置 `simple` 与 `convergence` 两个 wavtool；社区亦有大量外部 wavtool（wavtool2.exe 等）。

---

## 6. Flags 与调声参数

### 6.1 通用 flags（多数 resampler 支持）

| Flag | 默认 | 范围 | 作用 |
|---|---|---|---|
| g | 0 | -100~+100 | 性别/formant 偏移；+ 低沉成熟，- 清亮幼态 |
| B | 50 | 0~100 | 气声（breathiness），预合成阶段 |
| t | 0 | -9~+9 | 音高微调，每单位 10 音分 |
| Y | 100 | 0~100 | 元音区气声比例 |
| H | 0 | 0~99 | 低通滤波（压高频，缓解金属感） |
| h | 0 | 0~99 | 辅音气声部分的低通 |
| F | 3 | 0~ | formant 滤波强度 |
| L | - | 0~ | F 的固定频率（170Hz×值） |
| N | - | 无 | 关闭 formant filter |
| P | 86 | 0~100 | 峰值压缩（音量更稳） |
| W | - | 无 | 机器人音效 |

### 6.2 默认 resampler 扩展 flags

| Flag | 默认 | 范围 | 作用 |
|---|---|---|---|
| b | 0 | 0~100 | 合成后加气声（不受 F 影响） |
| C / D / E | 0 | 0~100 | 高/中/低频段切除滤波 |
| c | 50 | 0~100 | formant 滤波前的 C 值 |
| a | 100 | 0~ | 辅音区拉伸/压缩 |
| x | 0 | -100~100 | 按原音高低改变亮度 |

> 不同 resampler 的 flag 集不同（doppeltler/f2resamp/TIPS/fresamp/world 各有专属 flag）。**Flag 区分大小写**。

### 6.3 OpenUtau Expressions（参数化对应物）

| 名称 | 缩写 | 对应 | 范围/默认 |
|---|---|---|---|
| Velocity | VEL | 子音速度 | 0~200 / 100 |
| Volume | VOL | 音量 | 0~200 / 100 |
| Attack / Decay | ATK/DEC | 包络起音/衰减 | - |
| Voice color | CLR | 音色子库选择 | - |
| Gender | GEN | g flag | -100~100 |
| Breath | BRE | B flag | 0~100 |
| Lowpass | LPF | H flag | 0~100 |
| Modulation | MOD | 调制 | 0~100 |
| Tone shift | SHFT | 音高别名选择 | -36~36 |

---

## 7. 工程文件（UST，简述）

- `.ust` 是 UTAU 工程文件（文本格式），记录 BPM、音轨、每个音符的**音高/长度/歌词/音量/颤音/flags/pitchbend**。
- OpenUtau 用 `.ustx`（JSON 结构）。
- 与 MIDI 的映射关系：UTAU 音符 = 起止时间 + 音高 + 歌词(音素)，本质上与钢琴卷帘同构——**这正是 FuFuMIDI 现有点击编辑器的天然对接点**。

---

## 8. 对 FuFuMIDI 接入的启示（为 M1~M5 预留）

1. **音高换算**：UTAU 用 `C4` 这类音名，FuFuMIDI 是 MIDI 音符号；实现 `note number ↔ (音名, 八度)` 换算（C4=60）。
2. **音长换算**：按 §4.2 规则由音符时长 + 相邻音的 oto 参数计算 `length`，不要简单用音符时长。
3. **切分与变调分离**：辅音区不拉伸（变调仅变频），元音区拉伸/循环；自研首选"重采样 + 零交叉对齐循环"，避免 STFT 伪影。
4. **oto.ini 生成（M3）**：可从"自动检测起止点 + 波形可视化微调"入手；先做 CV，再扩展 VCV（VCV 的 overlap 需落在稳定前缀元音内）。
5. **编码与兼容**：读写 oto.ini/character.txt 需兼容 Shift-JIS 与 UTF-8；导出格式遵循社区规范以便互用。
6. **性能**：frq 分析结果可缓存；渲染可按音素并行（OpenUtau 即按音符并行渲染再交给 wavtool）。
7. **缓存复用**：相同"采样+音高+flags"的 resampler 结果可缓存（UTAU 的 cache 目录思路）。

---

## 9. 术语表（Glossary）

| 术语 | 说明 |
|---|---|
| 音源 / Voicebank / Voice Library | 一组真人录音采样 + oto.ini 等配置的文件夹 |
| 采样 / Sample | 一个音节或音素的录音 wav |
| Reclist | 录制清单，列出要录制的全部音节 |
| oto / otoing | oto.ini 的标注行为；'oto' 指标注数据 |
| 原音设定 | oto.ini 的中文惯称 |
| 左ブランク / Offset | 有效片段起点 |
| 子音部 / Consonant | 辅音区（不拉伸部分） |
| 右ブランク / Cutoff / Blank | 有效片段终点 |
| 先行発声 / Preutterance | 音符对齐起点 |
| オーバーラップ / Overlap | 与前音交叉淡化量 |
| STP / 食い込み補正 | 相邻音符时值的补偿对齐计算 |
| Resampler | 变调变速引擎 |
| Wavtool | 拼接合成器 |
| Flag | 调声标志（大小写敏感） |
| Velocity | 子音速度参数 |
| Modulation | 原音音高起伏保留比例 |
| Pitchbend | 音高曲线 |
| Envelope | 包络（起音/衰减/释音） |
| Vibrato | 颤音 |
| Phonemizer | 歌词→音素序列转换器 |
| CV / VCV / CVVC / VCCV | 音源录制方案类型 |
| Subbank / prefix.map | 多音高/多语气子库及别名映射 |
| .frq | 音高频率分析文件 |
| character.txt | 音源元信息 |
| guide BGM | 录制引导节拍/音高底垫 |
| OpenUtau | 开源跨平台重制版（MIT） |

---

## 参考来源

- UTAU 官方：http://utau2008.xrea.jp/
- OpenUtau Wiki（ResamplerとWavtool / Voicebank development / Expressions）：https://github.com/openutau/OpenUtau/wiki
- UTAU Wiki（Flags / Oto Theory by Cdra）：http://utau.wikidot.com/
- oto.ini 書式：https://utaudb.sakura.ne.jp/knowledge.php?id=21
- resampler.exe 参数详解：https://shinta0806be.ldblog.jp/archives/8298940.html
- NUTAU（numpy 实现参考，Unlicense）：https://github.com/zhaochenhong42/nutau
- Yin's oto 教程：https://yinsototutorial.weebly.com/
- UTAU Voicebank 入门：http://ryuune.drayo.eu/utau.php
