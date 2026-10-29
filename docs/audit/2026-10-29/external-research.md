# FuFumidi 外部竞品与开源项目调研（2026-10-29）

> 目的：为 FuFumidi 6.2.9 的升级路线提供外部参照。**只读调研**，没有改动任何源码。
> 证据以「官方页面 / GitHub API / 官方榜单 / 本机实测」为准；没能核实的一律标 **待核**，不做推测性断言。

---

## 0. 一页结论

1. **最大的问题不是功能，是许可证。** 这条转录链上精度最高的几个引擎，恰好是法律上最不能用的：
   MuScriptor 权重 **CC BY-NC 4.0**、hFT-Transformer 权重 **CC BY-NC-SA 4.0**（仓库文档写的是 MIT，写错了）、
   YourMT3 **GPL-3.0**、MIROS 仓库 **没有任何 LICENSE**、piano_transcription_inference **没有任何 LICENSE**。
   MIT 的应用外壳 + 这套引擎，**今天可以免费分发，但不能收费、不能上架商店、不能保证将来不被追责**。
2. **精度有公开横评，FuFumidi 的默认引擎在这个榜上是最弱的一档。** AIM 2025 转录竞赛榜（17 队）：
   MIROS 0.5999 > YourMT3-MoE 0.5939 > YourMT3-S 0.5582 > MT3 0.3932 > ByteDance 钢琴 0.1721 > **Basic Pitch 0.0634**。
   Basic Pitch 是 FuFumidi 的默认通用引擎，却是榜上倒数第二。**质量最高的两个（MIROS、YourMT3）正好是许可最差的两个。**
3. **MuScriptor 的「一次交付」流水线值得整体借过来**：量化 MIDI + MusicXML + 总谱 PDF + 分谱 PDF + 六线谱 PDF，
   外加速度地图、fill-gaps、trim-leading-bars、beat-scale。FuFumidi 每一种渲染器都有，
   唯独没有把它们打成一个「给编曲人的交付包」。
4. **制谱的差距在「刻版深度」，不在「视图数量」。** FuFumidi 已有五线谱 / 总谱 / 简谱 / 六线谱 / 贝斯四线谱，
   覆盖面比很多商业软件宽；缺的是连音线、力度记号、演奏法、反复、分谱、condensing、页面布局这些**可编辑的刻版语义**。
5. **MuseScore 4.7.6（2026-10-26）开始提供「PDF / 音频 / YouTube → 乐谱」的云端转换。**
   这是从上方直接压 FuFumidi 的核心卖点（音频→谱）。FuFumidi 的差异化必须落到「离线 + 可编辑 MIDI + 多引擎 + 中文歌」，
   而不是「我们也能转谱」。
6. **钢琴卷帘缺两块**：多轨叠影编辑（Cubase / Studio One / REAPER / FL 都有，FuFumidi 没有），
   以及「生成式工具」（FL 的 Riff Machine / Chord Progression Tool 那一类）。FuFumidi 的宏与逻辑编辑器是很好的底座，
   但现在是「批处理规则」，不是「创作工具」。
7. **包体的大头不在前端。** 前端产物 16.6 MB（Verovio 7.0 + FluidSynth 2.3 + 入口 1.5 + pdf worker 1.3），
   而 resources/ 是 **1,720 MB / 31,626 个文件**（其中 Python 运行时 1,482 MB / 31,591 个文件），MIROS 一个可选包就 **5.36 GB** 且自带运行时。
   三个可选引擎各带一份运行时，是最大的可回收空间。
8. **Electron 33.4.11 已不在官方支持窗口**（最新 45.1.0，按「最新三个大版本」策略 33 已 EOL）。
   这不是「要不要升级框架」的偏好问题，是安全更新与商店签名的前置条件。
9. **Univer 不建议引入。** Apache-2.0、22.8k star、定位是「给 AI agent 的 Office 套件」。它解决的是表格/文档/幻灯片，
   与钢琴卷帘、MIDI、音频没有交集；唯一能想到的落点是「列表编辑器」，而那里 DOM 表格更便宜。

---

## 1. 方法与证据边界

- **核验时间**：2026-10-29。GitHub 元数据（star、license、最后 push、归档状态）全部来自 api.github.com；
  npm 版本来自 registry.npmjs.org/<pkg>/latest；PyPI 版本来自 pypi.org/pypi/<pkg>/json；
  精度数字来自 AIM 2025 转录竞赛官方榜单 ai4musicians.org/transcription/leaderboard。
- **FuFumidi 侧的现状**来自仓库本身：README.md、docs/FOUNDATION.md、docs/backlog.md、docs/known-issues.md、
  docs/VENDOR.md、frontend/src/core/changelog.js、main/models.js、engine/engine_*.py，
  以及我对 resources/、renderer/dist/ 的实地测量。
- **边界**：没有跑任何模型推理，没有做音质主观评测，没有在 DAW 里实机验证导出格式。
  凡是「某软件支持 X」我都尽量给到官方页面；只给到官网首页的，说明我只核实到「该产品存在且在售」。
- **一个必须说清的口径问题**：AIM 榜单是**单一竞赛数据集上的 F-measure**，不能外推成「某引擎在钢琴独奏上更差」。
  Basic Pitch 是钢琴/单音源导向的轻量模型，它在「多乐器混音」这个任务上得分低是合理的；
  但 FuFumidi 把它放在**通用**档的默认位置，这个错配是真实存在的。

---

## 2. 竞争地图（三层）

| 层 | 代表 | 与 FuFumidi 的关系 |
|---|---|---|
| **专业 DAW / 制谱软件** | Cubase 15、Studio One Pro 7、REAPER 7、FL Studio、Dorico 6.2、MuseScore Studio 4.7、Sibelius、Logic | 争夺同一批「编曲/制谱」用户；它们不做离线多引擎转录，但**编辑与刻版深度**是护城河 |
| **AI 转录服务 / 产品** | MuseScore.com 转换、Moises、Klangio、AnthemScore、RipX、Melodyne、LANDR | 直接抢「音频→MIDI/谱」的入口；优势是云端算力与成品化，劣势是隐私/离线/中文歌 |
| **开源模型与库** | MuScriptor、Basic Pitch、YourMT3+、MIROS、Omnizart、Demucs/MSST、Verovio、alphaTab、OpenUtau、DiffSinger | FuFumidi 的供应链；**许可证与维护状态**决定路线的可持续性 |

FuFumidi 的独特位置：**离线 + 多引擎 + MIDI 编辑 + 制谱 + 可视化 + 歌声合成**在同一程序里。
外部没有任何一个开源项目同时覆盖这四段；商业软件里也没有「离线多引擎转录 + 制谱」的组合。
这个位置是真实的，但它的护城河是**工作流整合**，不是任何单点算法。

---

## 3. 矩阵 A：音频转 MIDI / 多乐器转录

### 3.1 引擎横评

| 引擎 | 仓库 | 代码许可 | 权重许可 | 规模 | 设备 | 输出 | AIM 2025 F | 维护 | FuFumidi 角色 |
|---|---|---|---|---|---|---|---|---|---|
| **MuScriptor** small/medium/large | muscriptor/muscriptor | **MIT** | **CC BY-NC 4.0** | 103M / 307M / 1.4B | CPU / CUDA / MPS | MIDI + MusicXML + 总谱/分谱/TAB PDF | 未参赛 | 活跃（2026-10-20） | 通用档默认 |
| **Basic Pitch** | spotify/basic-pitch | Apache-2.0 | Apache-2.0 | ~17M（ONNX int8） | CPU | MIDI（含 pitch bend） | **0.0634** | 低活跃（2025-11） | 通用档基线 |
| **YourMT3+** | mimbres/YourMT3 | **GPL-3.0** | GPL-3.0 | 361 MB 权重 | CPU / GPU | MIDI | **0.5939 / 0.5582** | 停滞（2024-11） | 可选下载（454 MB） |
| **MIROS** | amt-os/ai4m-miros | **无 LICENSE** | 无 | 5.36 GB 包 | GPU 优先 | MIDI | **0.5999（第 1）** | 一次性（2025-08） | 可选下载 |
| **hFT-Transformer** | sony/hFT-Transformer | **MIT** | **CC BY-NC-SA 4.0** | 5.5M 参数 / 20.5 MB | CPU | MIDI（无踏板） | 未参赛 | 活跃（2026-10-28） | 钢琴档可选 |
| **piano_transcription_inference** | qiuqiangkong/piano_transcription_inference | **无 LICENSE** | Zenodo 记录 | 160 MB | CPU / GPU | MIDI（含踏板） | 同源团队 0.1721 | 低活跃（2025-01） | 钢琴档默认 |
| **TransKun** | Yujia-Yan/TransKun | MIT | MIT | 小 | CPU / GPU | MIDI | 未参赛 | 停滞（2024-11） | 钢琴档可选 |
| **Aria-AMT** | EleutherAI/aria-amt | Apache-2.0 | Apache-2.0 | 小 | CPU / GPU | MIDI | 未参赛 | 活跃（2025-12） | 钢琴档可选 |
| **Omnizart** | Music-and-Culture-Technology-Lab/omnizart | MIT | MIT | 重（TF） | CPU / GPU | 人声/鼓/和弦/拍/乐器 | 未参赛 | 活跃（v0.6.3，2026-05） | 未采用 |
| **Demucs** | facebookresearch/demucs | MIT | MIT | 中 | CPU / GPU | 分轨 | — | **已归档（2024-04）** | 分离默认 |
| **MSST** | ZFTurbo/Music-Source-Separation-Training | MIT | 因模型而异 | 大 | CPU / GPU | 分轨 | — | 活跃（2026-10-15） | 分离可选 |
| **Beat This!** | CPJKU/beat_this | MIT | MIT | 小 | CPU | 拍/小节 | — | 活跃（2026-05） | 自动 BPM |

**这张表最该被记住的一行**：精度第 1（MIROS）和第 2（YourMT3-MoE）都不具备可商用许可；
许可最干净的 MuScriptor 代码是 MIT、权重却不是。**「精度—许可」在这条线上是负相关的。**

### 3.2 AIM 2025 榜单读数

来源：ai4musicians.org/transcription/leaderboard（2026 年页面，17 条目）

| 名次 | 队伍 | 运行时长 | F-measure |
|---|---|---:|---:|
| 1 | MIROS（Osnabrück） | 22.05 ms | **0.5999** |
| 2 | YourMT3-YPTF-MoE-M | 12.60 ms | 0.5939 |
| 3 | YourMT3-YPTF-S | 15.40 ms | 0.5582 |
| 4 | YourMT3-P | 14.99 ms | 0.3948 |
| 5 | MT3（Google） | 20.19 ms | 0.3932 |
| 13 | ByteDance Piano transcription | 9.67 ms | 0.1721 |
| 16 | **Basic Pitch（Spotify）** | 3.91 ms | **0.0634** |
| 17 | Midnight Questor | 30.28 ms | 0.0000 |

读法（三条，都是对 FuFumidi 有用的）：

1. **「通用」和「钢琴专用」是两个物种**：ByteDance 钢琴模型在钢琴上很强（note F1 0.9677 是它自家口径），
   在这个多乐器榜上只有 0.17。FuFumidi 把引擎分成 universal / piano 两档是对的，**但 UI 上不该让用户以为
   「通用 = 更好」**——正确的表述是「按素材选」。
2. **YourMT3 系（含 MIROS）是「多乐器」这一档的事实基线**，两个变体都过 0.55；这是 FuFumidi 可选引擎的价值所在。
3. **运行时长不是瓶颈**（全在 4–30 ms 量级，是榜单口径的每段耗时，不是整曲），
   所以「换更重的模型」在离线场景里没有实时性代价——代价是显存和包体。

### 3.3 MuScriptor 深读（最值得整体借鉴的一个）

- **出处**：Kyutai × Mirelo，ISMIR 2026 论文 arXiv:2607.08168；
  代码 MIT（Copyright (c) 2026 Kyutai x Mirelo）；权重 CC BY-NC 4.0，需在 HF 上点接受协议。
- **方法**（论文摘要原文要点）：合成数据预训练 + 真实音乐微调 + **强化学习后训练**；并引入**乐器存在性条件**
  （instrument presence conditioning）来定制转录结果。纯 decoder-only transformer。
- **三档**：small 103M / 14 层 / dim 768；medium 307M / 24 层 / 1024；large 1.4B / 48 层 / 1536。
- **CLI 能力（这才是重点）**：
  - 节拍、拍号、小节线**从音频检测并写进 MIDI**；速度不稳时写 **tempo map** 跟随演奏；fixed-tempo 写平均速度。
  - quantize / grid 4（十六分）/ grid 3（八分三连）/ quantize-strength 0.5（半量化）。
  - fill-gaps 0.25：跨休止把音延到下一个音（记谱软件/吉他谱不写断音）。
  - trim-leading-bars：裁掉首音前的空小节。
  - beat-scale 2 / 0.5：检测速度是实际的一半/两倍时纠正。
  - format sheets：输出 score.mid / score.musicxml / full_score.pdf / 每件乐器一个 PDF /
    **带品乐器再给一个 TAB PDF** / 鼓谱 PDF（依赖本机 MuseScore 4+）。
- **对 FuFumidi 的意义**：上面的每一条 FuFumidi 几乎都有对应零件（自动 BPM、量化、MusicXML 生成、
  PDF/PNG 导出、简谱/TAB 渲染），但**没有把它们组织成「一次点击、一个文件夹、编曲人可以直接发给乐手」的交付物**。
  这是低成本、高感知的差异化。

### 3.4 YourMT3+ / MIROS 深读（能力最强、许可最差）

- **YourMT3+**（arXiv:2407.04822，MLSP 2024）：
  时频域**分层注意力 Transformer** + **MoE**；针对标注不完整提出**多通道解码**；
  提出**同源（intra-stem）与跨源（cross-stem）数据增强**来混合数据集；**可以直接转人声，不需要先分离**。
  论文自己也写了「在流行乐录音上仍暴露当前模型的局限」——和 FuFumidi KI-4 的「僵尸音墙」是同一类问题。
- **MIROS**（amt-os/ai4m-miros）：仓库结构（main.py / train.py / test.py / transcribe.py / model/ / utils/ / logs/）
  与 YourMT3 一致，FuFumidi 的 engine_miros.py 注释也写明「MIROS = YourMT3+ 架构 + MusicFM 编码器」。
  **MusicFM 是 MIT/Apache-2.0 双许可**（minzwon/musicfm），但 MIROS 仓库本身**没有 LICENSE 文件**（GitHub /license 返回 404）。
- **对 FuFumidi 的两条硬结论**：
  1. 把 MIROS 当「冠军模型」宣传，同时把它做成**默认推荐**，法律上是在没有许可的代码上构建产品功能。
     可行路径只有三条：找作者要书面许可 / 改成「用户自行安装、应用不代下载」 / 换掉。
  2. YourMT3 是 GPL-3.0。它以**独立子进程**运行（FuFumidi 的架构天然是「聚合」而非「链接」），
     这在 GPL 解释上是有利事实；但**分发 GPL 代码就要提供对应源码**，包括你们打的补丁。
     这条必须写进 docs/VENDOR.md 的处置。

### 3.5 与 FuFumidi 现状的差距（对着 KI 与 plan 文档看）

| 差距 | 外部做法 | FuFumidi 现状 | 建议 |
|---|---|---|---|
| 长音频「僵尸音墙」（KI-4，408 秒长音） | MuScriptor 上游提供 max_note_hold 上限（默认 15 s）、prelude_forcing；YourMT3/MIROS 用分段 + 重叠合并 | 6.2.2 起**取消分块转录**（接缝重复音/换音色/延音被切断），改整曲一次推理 | 不做「重新分块」，改做**「块边界 tie 只继承模型自己 tie 过的键」**（KI-4 的治本方案）+ 上限兜底 + 段级重转 UI |
| 乐器归属（KI-3 的边界：密集配器分不清是谁在响） | 分轨后再转（stem-wise），或 YourMT3 的 cross-stem augmentation | 有「分离」档，但只做「人声优先」 | 新增**分轨转录 → 按乐器合并**的第二条路径（Demucs/MSST 已在） |
| 速度不是常数（rubato） | tempo map 跟随演奏 | 自动 BPM + 单一速度为主 | 用 Beat This!（已在依赖里）生成 tempo map，写进 MIDI 与 MusicXML |
| 记谱前的整理 | fill-gaps / trim-leading-bars / quantize-strength | 有量化，缺「为记谱服务」的整组 | 在「导出 MusicXML/PDF」前加一个「记谱整理」步骤 |
| 分谱交付 | MuScriptor format sheets；MuseScore 导出分谱 | 只有整份 PDF/PNG | 见 B1 |

---

## 4. 矩阵 B：制谱 / 钢琴卷帘 / 编辑器

### 4.1 横向对比

| 产品/库 | 许可 | 定位 | 刻版深度 | 卷帘/编辑 | 音频→谱 | 视频导出 | 脚本/插件 |
|---|---|---|---|---|---|---|---|
| **FuFumidi 6.2.9** | MIT（应用） | 一体化工作站 | 中（五线谱/总谱/简谱/TAB，缺连音线/力度/演奏法/分谱） | 强（CC 泳道、Key Switch、宏、逻辑编辑器、编排时间线） | **有（多引擎离线）** | 有（WebCodecs H.264，4K） | 插件沙箱 + 宏 |
| **MuseScore Studio 4.7.6** | GPL-3.0 | 制谱 | **很强**（和弦括号、吉他推弦线、capo 变调、连线/力度/分谱/总谱） | 中（4.x 有卷帘） | 4.7.6 起**云端**（PDF/音频/YouTube） | **有（滚动谱面 MP4）** | QML 插件 |
| **Dorico 6.2** | 专有 | 制谱（专业） | **最强**（condensing、cue、演奏法、版式） | 弱 | 无 | 无 | Lua（部分） |
| **REAPER 7** | 专有（$60） | DAW | 中（有记谱视图） | 强 | 无 | 有（视频） | **ReaScript/EEL2/JSFX** |
| **Studio One Pro 7** | 专有 | DAW | 中（Score View） | 强 | 有（云端/本地） | 有 | 有限 |
| **Cubase 15** | 专有 | DAW | 强（Score Editor） | 强（Logical Editor、Chord Pads、VariAudio） | 有（SpectraLayers 生态） | 有 | 有限 |
| **FL Studio** | 专有 | DAW | 弱 | **最强卷帘**（Riff Machine、Chord Progression、snap to scale） | 无 | 有 | 有限 |
| **alphaTab 1.8.4** | MPL-2.0 | 制谱库 | 中（GP3–8 / MusicXML / Capella / alphaTex；TAB/鼓谱/**简谱**/斜线谱） | 无（只读渲染 + 播放） | 无 | 无 | 无 |
| **Verovio 6.3.0** | LGPL-3.0+ | 刻版引擎 | 强（MEI/MusicXML/Humdrum，SVG 输出，元素级 ID） | 无 | 无 | 无 | 无 |
| **OpenUtau** | MIT | 歌声合成编辑器 | 无 | 强（音素/音高曲线/表情） | 无 | 无 | 插件 |
| **Univer** | Apache-2.0 | Office 套件 | 无 | 无 | 无 | 无 | 有 |

三处需要点名的判断：

- **MuseScore 4.7 的两件事对 FuFumidi 是直接压力**：滚动谱面 MP4 导出（FuFumidi 的视频导出只渲染可视化，不渲染谱面），
  以及 4.7.6 的「PDF/音频/YouTube → 乐谱」云端转换（FuFumidi 的核心卖点被从上方覆盖）。
- **alphaTab 的格式覆盖面被低估了**：Guitar Pro 3–8、MusicXML、**Capella**、alphaTex；输出五线谱、TAB、鼓谱、
  **简谱（jiǎnpǔ）**、斜线谱；内置 SF2/SF3 合成器与播放光标；可**对齐真实音频/视频**。
  FuFumidi 已经有简谱与 TAB，但没有 GP/Capella 导入，也没有「谱面跟随音频」。
- **Verovio 6.3.0 就是 npm 上的最新版**（registry.npmjs.org/verovio/latest = 6.3.0），FuFumidi 没有落后。
  它的价值不在「渲染得好看」，而在**每个元素都有稳定 ID**——这是做「点谱面定位播放头」的正确接口（FuFumidi 已在用）。

### 4.2 可借鉴的具体功能 / 交互（带落点）

| # | 借什么 | 来源 | 为什么值得 | 落点 | 成本 |
|---|---|---|---|---|---|
| **B1** | **一次点击的「交付包」**：量化 MIDI + MusicXML + 总谱 PDF + 每声部分谱 PDF + TAB PDF + 简谱图 | MuScriptor format sheets；MuseScore 导出分谱 | 编曲人真正要的是「能发给乐手的一组文件」，不是「一个 PDF」 | ViewScore.vue + core/musicxml_out.js（已支持多 part）+ 现有 PDF/SVG 管线 + adm-zip | 中 |
| **B2** | **速度地图（tempo map）跟随演奏**，并在卷帘顶部画出可编辑的速度轨 | MuScriptor tempo map；REAPER/Studio One tempo map | rubato 素材现在会被量化成「错的小节线」 | core/midi.js 的 tempo 事件 + ViewEdit.vue 已有 tempoLane；用 Beat This! 生成 | 中 |
| **B3** | **记谱整理组**：fill-gaps、trim-leading-bars、量化强度、三连音网格 | MuScriptor CLI | 转出来的 MIDI 直接导谱会满页断音与空小节 | core/musicxml_out.js 前置 + 导出对话框 | 低 |
| **B4** | **多轨叠影编辑**：当前轨实色，其他轨半透明只读 | Cubase / Studio One / REAPER / FL | 配器时看不见别的声部就一定会撞音 | components/EditorCanvas.vue 加一层只读绘制；命中测试仍只对当前轨 | 低 |
| **B5** | **和弦轨作为「唯一真相源」**，伴奏从它再生成（改一个和弦，全轨跟着变） | Studio One Chord Track；Cubase Chord Pads；FL Chord Progression；MuseScore realize chord symbols | FuFumidi 已有和弦分析与「智能伴奏」，但两者是**一次性生成**，不是持续关系 | core/analysis.js + core/arrange.js；把伴奏轨标成「派生轨」 | 中 |
| **B6** | **音符生成器菜单**（riff / 琶音 / 和弦进行 / 随机化 / 限制音域 / 齐奏） | FL 的 Tools 菜单（Riff Machine、Chord Progression Tool） | 现在是「批处理规则」，不是「创作工具」；同一套引擎可以两用 | core/macro.js；把「逻辑编辑器」扩成「生成器」 | 中 |
| **B7** | **微交互四件套**：双击选中整个和弦、R 复制到下一拍、Q/W 时值减半/加倍、Shift+Space 从选中音符起播 | MuseScore 4.7 发布说明 | 单条成本极低、每天被用几百次 | ViewEdit.vue 键盘处理 + EditorCanvas 选择逻辑 | 低 |
| **B8** | **滚动谱面 MP4 导出**（谱面 + 音频 + 播放光标） | MuseScore 4.7 | 现有 WebCodecs 管线已经很强，缺的只是「把 SVG 谱面逐帧画进 canvas」 | ViewScore.vue 渲染 + ViewConvert.vue 编码器 | 中 |
| **B9** | **GP / Capella 导入 + 斜线谱、鼓谱输出** | alphaTab 1.8.4 | 吉他/流行用户的主力格式；FuFumidi 现在只能 MusicXML | 新 core/gp.js 解析（或引 alphaTab 只做导入） | 中高 |
| **B10** | **Write / Engrave / Play 三模式 + 「乐章（flow）」** | Dorico | 把「写音符」和「排版面」分成两个界面，减少 90% 的误操作 | 现有 ViewEdit 与 ViewScore 之间加「排版」态 | 中 |
| **B11** | **AI 多候选（retake）**：一次生成 3 版，挑一版 | Synthesizer V 的 AI Retake 思路 | 歌声合成的不确定性用「多给几个」解决，比调参有效 | engine_openutau.py / DiffSinger 用不同 seed 批量渲染 | 低 |
| **B12** | **参考曲匹配母带**（谱包络 + 动态 + 响度对齐） | Matchering（**GPL-3.0，只借概念不借代码**） | FuFumidi 已有 LUFS + 限幅，缺「像某首歌那样响/那样亮」 | core/export_audio.js（已有 LUFS/limiter）+ 新匹配器 | 中 |

### 4.3 Univer 的评估（结论：不引入）

- 事实：Apache-2.0，22,781 star，自述 "The Office Harness for AI Agents — Spreadsheets, Docs, Slides, Canvas, Relational Tables"。
- 它能做的是表格/文档/幻灯片/画布/关系表；**没有 MIDI、没有音频、没有卷帘**。
- 唯一可能的落点是「列表编辑器」（FuFumidi 现在用表格，实测 4,869 行没问题）与「歌词表」。
  为这两个场景引入一套 Office 内核，换来的代价是：第二个 UI 框架、第二套主题/快捷键/i18n、以及显著的包体。
- **建议**：不引入；如果将来要做「工程仪表盘/统计报表」，优先用现有 DOM + 图表，或导出 CSV 给用户自己的表格软件。

---

## 5. 矩阵 C：歌声合成

| 产品/库 | 许可 | 形态 | 关键能力 | 可借 |
|---|---|---|---|---|
| FuFumidi（现状） | MIT | 内置 | OpenUtau 移植（UTAU 拼接 + worldline）、DiffSinger ONNX、RVC 变声、GPT-SoVITS | — |
| **OpenUtau** | MIT | 桌面编辑器 | UTAU 兼容、resampler 插件、音素化（日/中/英/韩）、表情/音高曲线、.ustx | FuFumidi 已移植；可跟上游的 resampler 生态 |
| **DiffSinger** | Apache-2.0 | 训练/推理框架 | 声学 + 方差模型、ONNX 声库 | 已用；可补 variance（呼吸/张力） |
| **Synthesizer V** | 专有 | 插件/独立 | AI 声库、AI Retake、vocal mode、跨语言、实时渲染 | **多候选 retake**、vocal mode 的「一键换唱法」 |
| **Vocaloid** | 专有 | 编辑器/插件 | 声库生态、DAW 集成 | 声库市场的运营方式 |
| **ACE-Step** | Apache-2.0 | 生成模型 | 文本→歌曲 | 与本项目无关（视频配乐用） |
| **RVC / so-vits-svc** | MIT / AGPL-3.0 | 变声 | 音色克隆 | 已用 RVC（权重 CC-BY-NC） |

差异点：SynthV 的护城河是「**声库品质 + 一键好听**」，不是编辑器功能。
FuFumidi 的路线（OpenUtau 兼容 + DiffSinger + RVC）在「可编辑性/自由度」上更强，在「开箱好听」上更弱。
**最便宜的补强是 B11（多候选）+ 一组按曲风预设的颤音/滑音/气声参数**，不是再换一个模型。

---

## 6. 矩阵 D：音频分离 / 母带 / 资源管理

### 6.1 分离

| 方案 | 许可 | 状态 | 备注 |
|---|---|---|---|
| Demucs (htdemucs) | MIT | **上游已归档（2024-04）** | FuFumidi 默认；能跑但没有安全/质量更新 |
| MSST（BS-RoFormer / Mel-Band RoFormer / MDX23C / SCNet / Bandit / Apollo） | MIT | 活跃 | FuFumidi 已接，且有 msst_autoconfig.py 从权重推结构（这是很硬的工程） |
| UVR / VR 家族 | 因模型而异 | 活跃 | 已有 |

可借的点不在模型，而在**「选哪个模型」的产品化**：MSST 有 79 个模型，用户不可能自己选。
FuFumidi 已经有「音频标签模型 → 乐器组建议」，把同一套思路扩成**「素材 → 推荐分离模型 + 推荐转录引擎」**，
比再加十个模型更有用。

### 6.2 母带

| 能力 | FuFumidi | 商业参照 | 差距 |
|---|---|---|---|
| 响度归一（LUFS） | **有**（−14 / −16 / −23，EBU R128） | Ozone / LANDR | 无 |
| 限幅 | **有**（−1 dBFS） | Ozone | 缺 true-peak 表与过采样 |
| 参考曲匹配 | 无 | Ozone Master Assistant、Matchering | 有 |
| 多段动态 / 去齿音 / 立体声增强 | 无（backlog B3 已记） | Ozone / Studio One | 有 |
| 分轨母带 | 无 | Studio One / Cubase | 有 |

结论：**母带不是当前瓶颈**，只补两件：true-peak 表（用户能看见自己有没有削波）+ 参考曲匹配（B12）。
其余留给「音效链」路线，不要为了对标 Ozone 去做多段动态。

### 6.3 资源管理（模型/音色/声库）

外部参照：Muse Hub（MuseSounds）、Native Instruments Native Access、Arturia Software Center、Steam 的内容库。
它们共同的产品模型是：**包（package）= 清单 + 许可 + 校验 + 可迁移 + 可离线导出**。

FuFumidi 已有：多源测速/分段/续传/看门狗/完整性校验（main/fast-download.js）、数据根迁移与找回、
安装后结构验收、删除时清理分片。缺三件：

1. **包级许可证展示**：现在 frontend/src/core/licenses.js 只覆盖音色库；模型（尤其 NC/GPL 的）没有出现在「关于→许可」里。
2. **离线包导出/导入**：给不能联网的机器（学校机房、录音棚）用；把已下载的包导出成一个文件，另一台机器导入。
3. **磁盘账本**：每个包「占用 / 上次使用 / 可回收」；现在只有总占用。MIROS 一个包 5.36 GB，用户需要知道删了能省多少。

---

## 7. Electron / Vue 音频应用架构

### 7.1 进程与 IPC

| 现状 | 外部更优做法 | 收益 |
|---|---|---|
| Python 用 child_process.spawn，stdout 传 JSON，###PROG 传进度 | Electron **utilityProcess**（Node 环境、独立进程、自带 MessagePort） | 不阻塞主进程事件循环；二进制（PCM/AudioData）直接走 port，不用 base64；崩溃只死一个 utility |
| 引擎 → 渲染 的产物走文件 | MessageChannelMain + ArrayBuffer transfer | 大音频/大 MIDI 少一次落盘与一次序列化 |
| 长任务（转录/导出） | powerSaveBlocker.start('prevent-app-suspension') + webContents.setBackgroundThrottling(false) | 防止息屏/切后台把渲染或音频掐掉（视频导出尤其需要） |
| 音频时钟 | AudioWorklet（已有 fu-seq-clock.js） | 已是最优解，保持 |

### 7.2 渲染与编码

- **视频导出已经是标杆水平**：WebCodecs VideoEncoder + 硬件 H.264 + 裸流 stream copy 封装 + 分片写盘，
  实测 4K 39.6 fps、1080P 83.2 fps（changelog.js 5.0.1 条）。这条路比 Reaper/MuseScore 的「实时录制」更好，别退回去。
- 可继续的两步：
  1. **AAC 用 AudioEncoder** 生成，去掉 ffmpeg 里的音频转码环节（现在视频流是 copy、音频还在编）。
  2. **字幕/章节**：MP4 的 mov_text 或 sidecar .srt；现在歌词字幕是烧进画面的，加一条「软字幕」选项成本很低。
- **谱面渲染**：Verovio 是 wasm + 同步刻版，长谱（1900 行谱表）会卡主线程。
  可借 MuseScore 4.7 的「分页/分系统」思路：只刻可视范围内的 system，滚动时增量刻版。

### 7.3 包体与运行时（最大的一块）

实测（2026-10-29，本机仓库）：

| 部分 | 体积 | 文件数 |
|---|---:|---:|
| resources/ 合计 | **1,720 MB** | 31,626 |
| resources/python | **1,482 MB** | **31,591** |
| resources/models | 212 MB | 9 |
| renderer/dist | 16.6 MB | — |
| └ Verovio wasm | 6.97 MB | 1 |
| └ libfluidsynth | 2.26 MB | 1 |
| └ 入口 chunk | 1.51 MB | 1 |
| └ pdf.js worker | 1.31 MB | 1 |
| └ CJK 字体 woff2 | 0.74 MB | 1 |

可选引擎包（main/models.js）：MIROS **5.36 GB**（6 分卷，「含独立 Python 运行时」）、YourMT3 **454 MB**、
hFT **20.5 MB**（只权重）、钢琴 CRNN **160 MB**。

**建议（按收益排序）**：

1. **共享运行时**：三个可选引擎各带一份 site/，意味着三份 torch/numpy。改成「一个共享运行时 + 每引擎一个薄 overlay」，
   预计每个引擎省 300 MB–2 GB。
2. **基础包去 torch**：CPU 可跑的四条路（basic-pitch ONNX、piano CRNN、hFT、CED/AudioSet 标签）都不需要 torch；
   把 torch 移出基础运行时，基础安装可望从 1.7 GB 降到 ~600 MB 量级（**待实测**）。
3. **换 Python 发行版**：python-build-standalone 之类的最小发行版 + 只装用到的包，文件数能从 3.1 万降到 1 万以内。
   文件数直接影响 NSIS 安装时长、Defender 扫描与卸载残留（backlog C5 的孤儿进程/残留文件就是这类问题）。
4. **预编译 .pyc、删 test/、删 pip/setuptools 缓存**。
5. **安装器分档**：Base（124 MB，已有） / Standard（+ 钢琴 + Demucs） / Full（全部）。
6. **前端**：入口 1.51 MB 仍是单块，可按「编辑 / 乐谱 / 转换 / 调教」拆 manualChunks；
   dist 里还有 1 个 .map（js-synthesizer.worklet.min.js.map），打包时应排除。

### 7.4 版本与安全

| 组件 | FuFumidi | 最新（2026-10-29） | 结论 |
|---|---|---|---|
| Electron | **33.4.11** | **45.1.0** | 12 个大版本落后；33 已出支持窗口 |
| Vite | 6.0.7 | 8.3.5 | 2 个大版本 |
| Vue | 3.5.13 | 3.5.44 | 同 minor |
| TypeScript | 7.0.2 | — | 已是新大版本 |
| Node（构建） | 20+ | — | 可随 Electron 升级一起抬 |

Electron 升级的实际阻碍不是 API（FuFumidi 用的是 contextIsolation + preload + IPC，属于标准姿势），
而是**原生依赖**：sql.js（wasm，无碍）、webwallgl（需要确认是否有原生扩展）、adm-zip（纯 JS）。
建议先在 CI 上跑一条「Electron 40 / 45 双版本冒烟」分支，再决定落点。

---

## 8. 许可证矩阵与处置

### 8.1 分级

| 级别 | 许可 | 本仓库中的例子 | 能不能随包分发 | 能不能商用 |
|---|---|---|---|---|
| A 宽松 | MIT / Apache-2.0 / BSD / ISC / Unlicense | 应用本体、MuScriptor 代码、Basic Pitch、TransKun、Aria、Omnizart、MSST、Beat This!、OpenUtau、DiffSinger、alphaTab（MPL-2.0，文件级） | 可以 | 可以 |
| B 署名 | CC BY 3.0 / 4.0 | GeneralUser GS、Salamander、FluidR3 | 可以，须署名 | 可以 |
| C 非商用 | **CC BY-NC 4.0** | **MuScriptor 权重**、RVC 社区权重 | 可以（非商用） | **不可以** |
| C' 非商用+相同方式共享 | **CC BY-NC-SA 4.0** | **hFT-Transformer 权重**、DiffSinger 通用声码器、MAESTRO 数据集 | 可以（非商用、署名、SA） | **不可以** |
| D 传染 | GPL-3.0 / AGPL-3.0 | **YourMT3**（GPL）、**Spotify Pedalboard**（GPL）、Matchering（GPL）、**Audiveris**（AGPL）、Essentia.js（AGPL）、aubio（GPL） | 可以，但须提供源码/源码 offer | 可以，但衍生作品必须 GPL |
| E 无许可 | 无 LICENSE 文件 | **MIROS**、**piano_transcription_inference** | **默认不可以**（保留所有权利） | 不可以 |

### 8.2 本仓库里已经存在的具体风险（逐条）

1. **hFT-Transformer 的许可写错了。** docs/VENDOR.md 与 changelog.js 都写「MIT」，但上游把**代码**（MIT，LICENSE-CODE）
   与**权重**（LICENSE-CHECKPOINTS.md：**CC BY-NC-SA 4.0**）分开授权，且明确「checkpoints 由 MAESTRO v3 训练，
   MAESTRO 也是 CC BY-NC-SA 4.0」。当前应用**代下载并镜像分发**了这份权重（main/models.js:68），
   等于在分发 NC 素材。修法：改文案 + 在下载处展示许可 + 决定是否保留。
2. **MuScriptor 权重是 CC BY-NC 4.0，且被镜像到自己仓库分发**（main/models.js:123-125 注释明说「无需 HuggingFace 授权」）。
   CC BY-NC 允许非商业再分发，但要求**署名 + 许可文本 + 许可链接**；目前 licenses.js 里没有这一条。
   只要 FuFumidi 有一天收费（哪怕只是「赞助版」），这就是违约。
3. **MIROS 仓库没有 LICENSE。** amt-os/ai4m-miros（5 star，2025-08 一次性提交）。没有许可 = 没有授权。
   目前的做法（应用内代下载 5.36 GB 运行时）是这条链上风险最高的一处。
4. **piano_transcription_inference 仓库没有 LICENSE**，只有 README.md / setup.py / 包目录。
   权重在 Zenodo（记录 4034264）。这条是「默认引擎」，风险面比可选引擎更大。
5. **YourMT3 是 GPL-3.0。** 子进程调用 + 只通过 MIDI/JSON 交互，法律上更接近「聚合」；
   但分发其代码就要给源码。请把「上游源码地址 + 本地补丁」写进 docs/VENDOR.md。
6. **Spotify Pedalboard 是 GPL-3.0**，而 6.0.4 把它做成了 VST3 离线宿主（Python 进程内 import）。
   这是**同进程链接**，比子进程更强地触发 GPL。建议：要么去掉，要么明确「可选组件、用户自装、独立进程」，
   并在 UI 里显示 GPL 与源码地址。
7. **Audiveris 是 AGPL-3.0**（按需下载）。本地使用不触发网络条款，但分发要提供源码；不要打进「完整安装包」。
8. **Verovio 是 LGPL-3.0-or-later**。以 wasm 形式动态加载，属于「可替换组件」；
   合规做法是保留未混淆的 JS、标注版本（VENDOR.md 已做）、附 LGPL 文本与源码链接。
9. **alphaTab 是 MPL-2.0**（若引入）：文件级 copyleft，改它的文件要开源那些文件，链接不受影响——可以安全使用。

### 8.3 一页处置清单

| 优先级 | 动作 |
|---|---|
| P0 | 在「关于 → 许可」里补齐**每个模型**的：名称 / 版本 / 许可 / 来源 URL / 是否可商用；数据源从 main/models.js 生成，和 licenses.js 合并 |
| P0 | 修 hFT 的「MIT」表述；下载页展示 CC BY-NC-SA 4.0 与 MAESTRO 署名 |
| P0 | MuScriptor 下载页与关于页补 CC BY-NC 4.0 全文/链接/署名（Kyutai × Mirelo） |
| P0 | 决定产品是否商用：若商用，MIROS 与 piano_pt 必须先解决许可（换 GPL 兼容方案 / 用户自装 / 拿授权） |
| P1 | Pedalboard 从「进程内 import」改为「独立可选组件」，或移除 |
| P1 | docs/VENDOR.md 增加「许可分级」列，CI 里加一条「新增模型必须填 license 字段」的检查 |
| P2 | 为 GPL/AGPL 组件准备源码 offer（下载页 + 关于页），避免被投诉时才补 |

---

## 9. 建议优先级

排序依据：**风险 × 用户感知 ÷ 成本**。P0 = 不做会出事；P1 = 做了明显更强；P2 = 锦上添花。

### P0（0–6 周）

| # | 事项 | 为什么现在做 | 成本 | 风险 |
|---|---|---|---|---|
| P0-1 | 许可证台账与 UI 披露（模型级） | 商业化/上架的前置；也是「被投诉时能自证」的唯一办法 | 2–3 人日 | 低 |
| P0-2 | hFT / MuScriptor 文案与署名修正 | 现在写错了，属于「明知故犯」的证据链 | 0.5 人日 | 低 |
| P0-3 | MIROS / piano_pt 的许可决策（保留但「用户自装」 / 替换 / 拿授权） | 无许可代码是最大单点风险 | 决策 1 天 + 落地 3–5 天 | 中（可能失去精度第一） |
| P0-4 | Electron 33 → 受支持版本 | 安全更新与商店签名；越晚越难 | 3–5 人日 + 冒烟 | 中（原生依赖） |
| P0-5 | 打包排除 *.map、拆入口 chunk | 1 分钟成本，立刻少一档体积 | 0.5 人日 | 低 |

### P1（1–3 个月）

| # | 事项 | 依据 | 成本 |
|---|---|---|---|
| P1-1 | **B1 交付包**（MIDI + MusicXML + 总谱/分谱/TAB PDF 一次导出） | MuScriptor format sheets 是竞品里最实用的一个功能 | 5–8 人日 |
| P1-2 | **B2 tempo map + B3 记谱整理组** | 直接改善「转出来能不能用」 | 5 人日 |
| P1-3 | **B4 多轨叠影编辑** | 与所有主流 DAW 的差距里最容易被用户指出的一条 | 3 人日 |
| P1-4 | **共享 Python 运行时 + 基础包去 torch** | 1.7 GB / 3.1 万文件是安装与支持的长期负担 | 8–12 人日 |
| P1-5 | **分轨转录（stem-wise）第二条路径** | 治 KI-3/KI-4 的「乐器归属」根本问题 | 8 人日 |
| P1-6 | **B8 滚动谱面 MP4** | MuseScore 4.7 已做，FuFumidi 的视频管线更强，缺的只是谱面逐帧 | 5 人日 |
| P1-7 | 资源中心「离线包导出/导入 + 磁盘账本」 | 学校/录音棚场景的刚需 | 4 人日 |

### P2（3–6 个月）

| # | 事项 | 依据 |
|---|---|---|
| P2-1 | B5 和弦轨 / B6 生成器菜单 | Studio One / FL 的创作流 |
| P2-2 | B9 GP / Capella 导入 | alphaTab 的格式覆盖；吉他用户入口 |
| P2-3 | B10 Write/Engrave/Play 三模式 | Dorico 的界面分区 |
| P2-4 | B11 歌声多候选 | SynthV 的 AI Retake |
| P2-5 | B12 参考曲匹配母带 + true-peak 表 | Ozone / Matchering 的概念 |
| P2-6 | 谱面增量刻版（可视区 system） | 长谱性能 |

### 不建议做（明确写下来，避免下次再讨论）

- **引入 Univer**：解决不了任何音频/MIDI 问题，增加一套框架与包体。
- **为了「更像 DAW」去补多段动态/卷积混响/总线压缩**：backlog B3 已经判断过，收益低、调参地狱。
- **抄 Matchering / Essentia.js / aubio 的代码**：GPL/AGPL，抄了就把整个应用拖进 copyleft。
- **重写 Tauri**：docs/FOUNDATION.md 已冻结该路线，外部也没有证据表明 Tauri 在音频场景更优。
- **把「分块转录」简单加回来**：6.2.2 的实测（接缝重复音、换音色、延音被切断）是真问题，
  正确方向是「块边界 tie 语义」，不是「再切一次」。

---

## 10. 待核清单（我没能核实、但会影响决策的）

1. MuScriptor 在**中文流行歌**上的实际表现（论文与演示以西方流行为主）。建议用自家 10 首素材做 A/B，
   指标用 scripts/eval-quality.mjs 的口径（note/onset F1）。
2. MIROS 权重是否包含**训练数据许可**限制（仓库无 LICENSE，但权重可能另有条款）。
3. piano_transcription_inference 的 Zenodo 记录许可字段（我只核实到仓库无 LICENSE）。
4. alphaTab 1.8 是否覆盖 **Guitar Pro 8** 之外的新格式（官网写 GP3–8；新小版本未逐一验证）。
5. MuseScore.com 的「音频→谱」是否**只在云端**、是否对免费账户限量（影响它的威胁程度）。
6. Studio One Pro 7 / Cubase 15 的**分轨分离与和弦轨**在 2026 版的具体边界（本次只核实到产品在售与版本号）。
7. Electron 45 下 webwallgl / sql.js 的兼容性（需要一次真实构建验证）。

---

## 11. 链接总表

**转录**
- MuScriptor：https://github.com/muscriptor/muscriptor · 论文 https://arxiv.org/abs/2607.08168
- Basic Pitch：https://github.com/spotify/basic-pitch
- YourMT3：https://github.com/mimbres/YourMT3 · 论文 https://arxiv.org/abs/2407.04822
- MIROS：https://github.com/amt-os/ai4m-miros
- hFT-Transformer：https://github.com/sony/hFT-Transformer
- piano_transcription_inference：https://github.com/qiuqiangkong/piano_transcription_inference
- TransKun：https://github.com/Yujia-Yan/TransKun
- Aria-AMT：https://github.com/EleutherAI/aria-amt
- Omnizart：https://github.com/Music-and-Culture-Technology-Lab/omnizart
- AIM 2025 榜单：https://ai4musicians.org/transcription/leaderboard

**分离 / 节拍**
- Demucs：https://github.com/facebookresearch/demucs（已归档）
- MSST：https://github.com/ZFTurbo/Music-Source-Separation-Training
- Beat This!：https://github.com/CPJKU/beat_this
- MusicFM：https://github.com/minzwon/musicfm

**制谱 / 编辑**
- MuseScore Studio：https://github.com/musescore/MuseScore · 4.7 发布说明 https://musescore.org/en/4.7
- Dorico：https://www.steinberg.net/dorico/
- Cubase：https://www.steinberg.net/cubase/
- REAPER：https://www.reaper.fm/
- FL Studio 卷帘手册：https://www.image-line.com/fl-studio-learning/fl-studio-online-manual/html/pianoroll.htm
- Verovio：https://github.com/rism-digital/verovio
- alphaTab：https://github.com/coderline/alphatab · https://www.alphatab.net/
- OpenUtau：https://github.com/stakira/OpenUtau
- DiffSinger：https://github.com/openvpi/DiffSinger
- Univer：https://github.com/dream-num/univer · https://univer.ai/

**架构参考**
- openDAW（AGPL-3.0，只看不抄）：https://github.com/andremichelle/openDAW
- Stemroller（Unlicense/MIT，Electron + Demucs 的完整范例）：https://github.com/stemrollerapp/stemroller
- AudioMass（MIT，Web Audio 编辑器）：https://github.com/pkalogiros/AudioMass
- Elementary Audio（MIT，离线 DSP 渲染）：https://github.com/elemaudio/elementary
- Pedalboard（**GPL-3.0**）：https://github.com/spotify/pedalboard
- Matchering（**GPL-3.0**）：https://github.com/sergree/matchering

---

## 12. 附：本次核验到的版本号（2026-10-29）

| 包 | 最新 | 许可 |
|---|---|---|
| electron | 45.1.0 | MIT |
| vite | 8.3.5 | MIT |
| vue | 3.5.44 | MIT |
| verovio | 6.3.0 | LGPL-3.0-or-later |
| @coderline/alphatab | 1.8.4 | MPL-2.0 |
| vexflow | 5.0.0 | MIT |
| opensheetmusicdisplay | 2.2.1 | BSD-3-Clause |
| tone | 15.1.22 | MIT |
| @elemaudio/core | 4.0.1 | MIT |
| wavesurfer.js | 8.0.3 | BSD-3-Clause |
| muscriptor (PyPI) | 0.4.0 | 代码 MIT / 权重 CC BY-NC 4.0 |
| omnizart (PyPI) | 0.6.3 | MIT |
