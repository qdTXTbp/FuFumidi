# FuFumidi · MIDI 制作 / 调教 / 编辑 / 转谱 / 混音 工作流审计

- 审计对象：E:/Midi/FuFumidi-Source（Windows Electron + Vue 3 + Python 引擎）
- 审计方式：**只读**源码走查 + 跨文件交叉引用验证；未运行应用、未修改任何源码
- 审计范围：ViewArrange / ViewEdit / ViewScore / ViewScoreConvert / ViewTranscribe / ViewCover / ViewSing（+ ViewConvert / ViewLyrics 作为上下游）、EditorCanvas、PianoRoll、core/*、engine/*
- 报告日期：2026-10-29
- 分级：**P0** = 专业工作流阻断级（用起来会放弃）；**P1** = 与专业工具差一个量级、影响效率与可信度；**P2** = 打磨项 / 结构债

---

## 0. 结论摘要

这个产品的**数据层与引擎层**已经到专业工具的 60~70%：MIDI 事件级保真（bend / 触后 / 歌词 / marker / 拍号 / SMPTE）、SF2 播放链路、CC 与弯音模型、多后端 OMR（Audiveris / homr / 自研）、十余个转录模型、LUFS + dither + BWF 的导出链、DAWproject 互操作，这些在同类国产工具里不常见。

但**交互层与时间线层**只到「能改」，没到「能做活」。按 DAW 的标准，缺的不是功能条目，是四条主干：

| # | 主干 | 一句话 | 证据 |
|---|---|---|---|
| 1 | **听不见** | 卷帘里点音符不出声；内置音色下画了 CC / 弯音也听不到 | 见 F-01、F-06 |
| 2 | **改不动** | 多选拖动只动一个音；拖动不吸附；卷帘没有标尺，不能点位置 | 见 F-02、P1-A1、P1-A2 |
| 3 | **留不住** | 任何一次音符编辑都会重置走带位置与循环区间；逻辑编辑器与宏的撤销失效 | 见 F-03、F-04 |
| 4 | **出不去** | 编排页的片段不参与播放；乐谱页只读；前端 MusicXML 解析丢连音线/变速/变拍 | 见 F-05、F-07、P1-I2 |

五条最值得先相信的判断：

1. **投入产出最高的三件事**是多选拖动、拖动吸附、音符试听。合起来约 1~2 周，直接决定「这软件能不能用来做活」的定性判断。
2. **第二高杠杆**是把 player.load 从「每次编辑」改成增量重排（或至少在播放/暂停时保留走带与循环）。2~5 天的活，决定「循环里改一个音」这个最高频动作是否可用。
3. **编排时间线必须变成播放的真源**（clip → 事件流），否则编排页永远是示意图；现在它连「静音一条轨」都不会影响声音。
4. **制谱不必追 Dorico**。乐谱页的正确定位是「校对视图」：把 OMR / 转谱结果 → 卷帘校对这条链做顺（底图、逐音对照、批量修正），比把五线谱编辑器做全更值。
5. **调教已接近 OpenUTAU 水平**，真正的缺口是两条数据模型问题：音高曲线归属（整轨，不随音符移动）与音素时长不可编辑。这两条决定它能否替代 SynthV 的日常调教。

---

## 1. 审计范围与方法

### 1.1 走查清单

| 文件 | 行数 | 角色 |
|---|---:|---|
| frontend/src/views/ViewEdit.vue | 3594 | 钢琴卷帘工作台（菜单 / 检查器 / 多车道 / 状态栏） |
| frontend/src/views/ViewSing.vue | 3642 | 调教（UTAU / DiffSinger 双引擎统一编辑器） |
| frontend/src/views/ViewTranscribe.vue | 2897 | 音频 → MIDI（模型矩阵 / 队列 / 智能修正） |
| frontend/src/views/ViewConvert.vue | 1277 | 渲染导出 / 视频导出 / 分轨 |
| frontend/src/views/ViewScore.vue | 1132 | 五线谱 / 总谱 / 简谱 / TAB（Verovio 刻版） |
| frontend/src/views/ViewScoreConvert.vue | 1108 | 变谱（图片 / PDF / MusicXML → MIDI） |
| frontend/src/views/ViewArrange.vue | 595 | 编排时间线（clip / marker / region） |
| frontend/src/views/ViewLyrics.vue | 504 | 歌词（LRC / 卡拉 OK） |
| frontend/src/views/ViewCover.vue | 406 | 翻唱（分离 → RVC → 混音） |
| frontend/src/components/EditorCanvas.vue | 2017 | 卷帘 / 五线谱共用画布（选择、绘制、撤销、CC 泳道） |
| frontend/src/components/pianoroll/PianoRoll.vue | 1638 | 调教页卷帘（通用适配器，OpenUTAU 式） |
| frontend/src/components/editor/*.vue | 639 | 菜单条 / 命令面板 / 参数工具面板 / 录音面板 |
| frontend/src/core/midi.js | 345 | SMF 解析 / 编码（事件级保真） |
| frontend/src/core/midi-tools.js | 343 | 19 个参数化 MIDI 工具 |
| frontend/src/core/arrange.js | 367 | 编排纯逻辑（clip 模型 / 渲染计划） |
| frontend/src/core/score.js · musicxml.js · musicxml_out.js | 255 / 65 / 379 | 简谱 / TAB / ABC、MusicXML 读写 |
| frontend/src/core/player.js · synth.js | 399 / 1111 | lookahead 调度、SF2 / 内置合成 |
| engine/engine_omr.py · engine_omr_backends.py | 71 KB / 116 KB | 自研 OMR + Audiveris / homr 后端 |
| engine/engine_muscriptor.py · engine_score2midi.py | 94 KB / 26 KB | MuScriptor 转录、MusicXML → MIDI |
| engine/smart_midi.py · midi_post.py · music2midi.py | 459 / 113 / 712 | 智能修正（对齐 / 力度 / 音高）、后处理、CLI |

### 1.2 判据

以 Cubase 13、Studio One 6、FL Studio 21、REAPER 7、MuseScore 4、Dorico 5、Vocaloid 6、Synthesizer V 2、OpenUTAU、Verovio、Basic Pitch、hFT-Transformer、MuScriptor 的**公开行为**为参照。带 ★ 的条目是常识性判断、未在本次联网核对具体版本行为（见 §8）。

### 1.3 局限（请连同结论一起读）

- **未运行应用**，全部结论来自源码与注释。个别行为涉及浏览器事件顺序（F-08、P1-B4），已给出推断依据但未实测；建议按 §9 的复现清单点一遍确认。
- 未审计打包 / 部署 / 更新链路，未做性能实测，只有从代码结构推出的量级判断。
- 网络只用于核对 4 个上游项目名与许可证（§8），没有逐条核对竞品当前版本的功能细节。

---

## 2. 能力基线矩阵

评级：**A** = 达到专业工具同级；**B** = 能用但有明显短板；**C** = 只有雏形；**D** = 缺失。

| 能力 | 评级 | 现状一句话 | 关键证据 |
|---|---|---|---|
| MIDI 解析 / 编码保真 | A- | 事件级保真：bend / 触后 / 歌词 / marker / cue / 拍号 / 调号 / SMPTE division / format 1 | core/midi.js:45-79、123-229 |
| 卷帘绘制与裁剪 | A- | 二分裁剪、按需重绘、主题色缓存、高刷限流 | EditorCanvas.vue:744-791、1923-1935 |
| 卷帘手势 | C | 单音拖动、边缘拉伸、框选、Alt 改力度；缺多选拖动、拖动吸附、标尺 | EditorCanvas.vue:1244-1411 |
| 试听（audition） | **D** | 卷帘内完全没有音符试听 | EditorCanvas.vue:1244-1319（onDown 无发声） |
| CC / 弯音编辑 | B- | 两条 CC 泳道 + PB 哨兵值，手绘 / 直线 / 曲线 | EditorCanvas.vue:46、873-980；ViewEdit.vue:152-163 |
| CC / 弯音回放 | C+ | 引擎支持，但内置合成器路径直接丢弃 | core/synth.js:793-795 |
| 量化 | C+ | 网格量化无强度（工具栏）、智能量化有 Groove；强度语义错位 | EditorCanvas.vue:364-374；ViewEdit.vue:1380-1409 |
| 力度工具 | B- | 19 个参数工具（含力度压缩 / 人性化 / 曲线绘制） | core/midi-tools.js:110-163；ViewEdit.vue:776-860 |
| 撤销 / 重做 | C | 整轨 JSON 快照 × 80，无标签，两处时机错 | EditorCanvas.vue:244-337、1817-1820；ViewEdit.vue:1456 |
| 时间线 / 标尺 | **D** | 卷帘无标尺、无点击定位、无循环区间拖拽 | ViewEdit.vue:2784-2794、2832-2847 |
| 编排（clip 时间线） | C- | 有 clip / marker / region，但不参与播放；无框选、无复制粘贴 | ViewArrange.vue:343-399；core/arrange.js:314-319 |
| 轨道管理 | **D** | 不能新建 / 删除 / 改名 / 重排轨道 | 仅 ViewEdit.vue:1363-1365 硬编码 push 3 轨 |
| 拍号编辑 | **D** | sigMap 只读，只能随导入带进来 | ViewEdit.vue:1941、1980、2263 |
| 五线谱编辑 | C- | 卷帘内可点选 / 拖动 / 画笔插音符；无连音线 / 连拍 / 休止 / 声部 | EditorCanvas.vue:456-620、1071-1225 |
| 五线谱刻版（读） | B+ | Verovio 真刻版：总谱 / 分谱 / PDF / PNG / MusicXML | ViewScore.vue:137-260 |
| MusicXML 导入 | C | 前端解析器丢变速 / 变拍 / 连音线 / 歌词 | core/musicxml.js:11-14、31-55 |
| OMR（识谱） | B+ | 自研 numpy 管线 + Audiveris + homr，逐页重试、对照图、体检 | engine/engine_omr.py:1-23；engine_omr_backends.py:763-813 |
| 音频 → MIDI | A- | 10+ 模型（basic / hFT / MuScriptor / YourMT3 / MIROS / Aria / Transkun / 钢琴）+ 智能修正 | ViewTranscribe.vue:578-590；engine/smart_midi.py:1-20 |
| 转录节拍 | B- | 只有 MuScriptor 有 beat grid；其余固定 BPM | engine_basic.py:134、183-203；engine_muscriptor.py:1018-1033 |
| 歌声合成（调教） | B+ | 双引擎、音素级覆盖、频谱底图、参数车道、效果链 | ViewSing.vue:3040-3210；stores/singer.ts:262-267 |
| 调教数据模型 | C | 音高曲线属于整轨、不随音符移动；音素时长只读 | stores/singer.ts:262-267、1069；ViewSing.vue:3148 |
| 混音 | C | 推子 / 声像 / 静音 / 独奏到**通道**级；主 EQ；无发送 / 无每轨 FX | PlayerBar.vue:335-357；synth.js:840-847 |
| 音频导出 | A- | LUFS 归一 + 总线限幅 + dither + BWF + 分轨 ZIP + DAWproject | ViewConvert.vue:39-56、248-404 |
| 音频导出格式 | C | 只有 WAV 16/24/float32 | core/export_options.js:10-12 |
| 快捷键体系 | D+ | 只读速查表 + 假「恢复默认」；全局键劫持编辑页 | SettingsPanel.vue:166、1004；App.vue:518-540 |
| 快捷键可配置 | **D** | 应用内快捷键不可改 | SettingsPanel.vue:1668-1676 |

---

## 3. P0：专业工作流阻断项

### F-01 卷帘里点音符不出声 —— 没有音符试听

**现象**：在钢琴卷帘里画一个音、点一个音、拖一个音，都没有声音。要听只能按空格从头/从当前位置播放。

**证据**：
- EditorCanvas 的指针按下（EditorCanvas.vue:1244-1319）没有任何发声道；整个组件没有 note-on 预览调用。
- 播放器对外只有 load / play / pause / seek / setLoop（core/player.js:53、186-266），没有单音发声接口。
- 唯一的「试听」能力在调教页的声库面板（components/sing/VoicebankPanel.vue:250）与调教页的音素试听（ViewSing.vue:3132-3133），MIDI 侧没有。

**影响**：这是 MIDI 编辑器最基本的反馈回路。没有它，用户无法在「不看谱、不听和声」的情况下判断自己画的是不是想要的音——音高、八度、和声冲突全靠事后回放，编辑节奏被切成「改一批 → 播一遍」。FL Studio / Studio One / Cubase / REAPER 全部是「按下即响」。

**修法**（1~2 天）：Synth 已有按音符发声的能力，加一个 previewNote(midi, vel, durMs) 走同一条音色解析（core/synth.js 的 program 解析），在 onDown / 画笔落音 / 拖动改音高 / 键盘上下移调时触发，加一个「试听开关」与音量系数。注意与 SF2 的通道状态解耦（别触发 program change）。

---

### F-02 多选拖动只移动一个音（同一文件的乐谱视图却是对的）

**现象**：框选 8 个音，按住其中一个往上拖，只有被按住的那一个动，其余 7 个留在原地。

**证据**：
- 卷帘视图：EditorCanvas.vue:1311 —— dragState 的 notes 固定为单元素数组（只含被按住的音），拖动分支只遍历 d.notes（EditorCanvas.vue:1350-1355）。
- 同一文件的乐谱视图：EditorCanvas.vue:1200-1201 —— notes 是整个 selection 的展开，即选区一起动。

这说明「多选一起拖」不是设计取舍，而是卷帘分支漏了。**影响**：转谱校对、移调、和声改写这些「选一片、整体挪」的动作全部退化成逐个拖。这是所有 DAW 使用频率最高的手势。

**修法**（半天）：把 1311 改成与 1200 一致（notes 取选区、orig 取对应快照），拖动时对所有 orig 施加同一个 dTick / dMidi；边缘命中时改成「拉伸整个选区」。顺手补 Ctrl+拖拽 = 复制拖动（现在没有）。

---

### F-03 任何一次音符编辑都会重置走带位置并把循环区间改成整曲

**现象**：设好 8~16 小节的循环，在循环里改一个音，循环没了（变成整曲循环）；暂停在 1:30 改一个音，按空格从曲首开始。

**证据链**：
1. 每次编辑收尾都走 afterEdit()，里面无条件 player.load(s)（EditorCanvas.vue:272-275）。
2. player.load 把 pausedTick 归零、循环清空（core/player.js:53）。
3. 紧接着 EditorCanvas.vue:275 只按 state.loop 把循环重设成 (true, 0, s.totalTicks) —— 用户用「选区循环」设的 [a,b]（ViewEdit.vue:914-923 → player.setLoop(true, a, b)）没有参与这次恢复。
4. 播放从 pausedTick 起（core/player.js:186-190），此时它是 0。

**影响**：这直接击穿「循环里打磨一个乐句」这个 MIDI 制作最核心的循环。用户每次改完都要重新设循环、重新定位，编辑成本随迭代次数线性上升。

**修法**（2~5 天，二选一）：
- 快修：afterEdit 里记住 (pausedTick, loopStart, loopEnd, playing) 再 load，再原样恢复；播放中编辑时不要 load，改用「增量重排」。
- 正解：给 Player 加一个 patchSong(changedTracks) 的增量接口，只重建受影响轨的事件表，保留 cursor / startTick / startSec。这也是后面「播放中编辑不掉音」的基础。

---

### F-04 撤销：整轨深拷贝 × 80、无标签，且两处「改完才存快照」导致撤不回来

**现象**：a) 撤销历史面板里每一步的时间都是同一秒、看不出改了什么；b) 用「逻辑编辑器」批量改力度、或用宏面板跑一条宏，按 Ctrl+Z 没有任何效果。

**证据**：
- 快照粒度：整轨 notes + ccs 的 JSON 深拷贝，上限 80（EditorCanvas.vue:247-248）。9 万音符的单轨约 3~4 MB/步，撑满 80 步是数百 MB 的常驻内存。
- 历史面板：historySnapshots() 返回 { ti, notes: 数量, at: Date.now() }（EditorCanvas.vue:1818-1820）——at 是**取用时**的时间，不是操作时间；也没有操作名。
- 时机错误 1：逻辑编辑器先改数据（ViewEdit.vue:1412-1455）再 pushStateForTrack（1456）。
- 时机错误 2：宏面板同样是先 applyMacroScript 再 pushStateForTrack（ViewEdit.vue:1483-1490、1502-1508）。
- pushStateForTrack 的语义是「存当前状态」（EditorCanvas.vue:1872-1884），所以这两个入口存下的是**改完之后**的状态，undo 恢复它等于什么都没做。

**影响**：批量工具是「不可撤销的破坏性操作」，用户不敢用；而这几个工具恰恰是专业用户最依赖的（逻辑编辑器对应 Cubase 的 Logical Editor）。

**修法**（3~5 天）：
1. 立刻修时机：三处 push 移到 mutate 之前（最小改动，半天）。
2. 给快照加 label（如「量化 1/16 · 37 音」）与真实时间戳，历史面板才有意义。
3. 中期改成命令式撤销（每条命令带 undo/redo 闭包，只存被改音符的 before/after），内存降两个数量级，并能做「撤销历史按轨过滤」。参考 OpenUtau 的 UndoGroup 与 REAPER 的 undo 语义（按操作名聚合）。

---

### F-05 编排页的片段不参与播放：移动、裁剪、静音都不出声

**现象**：在编排页把副歌片段往后挪 8 小节、把鼓轨静音、把片段裁短——按播放，听到的还是原曲，一点没变。

**证据**：
- 编排状态只写回 song.arrange（core/arrange.js:314-319），播放器读取的是 song.tracks 的原始音符（core/player.js:99-124）。
- 编排页的静音 / 独奏只改编排状态（ViewArrange.vue:460-466 → setTrackFlags，arrange.js:249-258），没有任何链路接到 app.tracks 或 player。
- clip → 秒的映射函数存在，但只被**导出**使用：core/arrange.js:352-367（clipsRenderJobs）唯一调用点是 ViewConvert.vue:342。

**影响**：编排页对「听」是纯装饰。这使「编排 → 试听 → 调整」的闭环断裂，用户只能靠导出音频来验证编曲，迭代成本极高。同类工具（Studio One 的 Arranger Track、Ableton 的 Session/Arrangement、Cubase 的 Arranger）都是「移动即听到」。

**修法**（1~2 周）：定义「编排视图 = 播放视图」：Player.prepare 时若存在 song.arrange 且有 clips，则按 clipsRenderJobs 把 clip 映射成事件（对每个 clip：源区间 [offsetTick, offsetTick+len] 的音符平移到 startTick），并应用 track 级 mute / solo。这同时解决 F-05 与「编排 M/S 无效」。注意保持「无 arrange 时行为不变」，避免影响老工程。

---

### F-06 内置音色（桌面版默认）下，CC / 表情 / 踏板 / 弯音全部静默丢弃

**现象**：画满 CC1 渐强、CC11 表情、CC64 踏板、弯音曲线，按播放——听起来和没画一样。换成 SF2 音色库才听得到。

**证据**：
- 播放器确实把 CC 与 bend 排进了事件表并逐条下发（core/player.js:126-157、170-183）。
- 但合成器的入口第一行就返回：core/synth.js:793-795 —— midiEvent(time, ev) 开头判断 sf2Ready / sf2，任一为空直接 return。
- 而桌面版默认是内置合成器：audio.js:33 的注释写明「桌面端默认内置合成器，网页端默认内置 GeneralUser.sf2」。

**影响**：用户花时间画的表情/踏板/弯音，在默认配置下**没有任何听觉反馈**，只有导出 MIDI 后才在别的 DAW 里生效。这会让用户判断「这个功能是假的」。对管弦乐写法（CC1/CC11 是命脉）尤其致命。

**修法**（3~5 天）：内置合成器侧实现最小可听子集——弯音（oscillator detune）、CC7/CC11（GainNode 增益）、CC64（note-off 延迟释放）、CC1（LFO 深度）。做不到全部就做这五个，并在 UI 上标明「当前音色不支持 XX」。同时把「未生效的 CC」在泳道上标灰，别让用户以为画上了就等于生效。

---

### F-07 乐谱视图无法表达跨小节时值：没有连音线、没有小节内临时记号、没有休止

**现象**：一个跨 3 小节的持续音，在五线谱里只画在第一小节；小节里先出现 F# 再出现 F 还原，两个音都带升号（还原号不出现）；除了「整小节空」以外没有任何休止符；没有连拍（beams），八分音符是一根根带符尾的独立音符。

**证据**：
- 时值只决定符头形状与符尾数量，不做跨小节拆分、不画连音线：EditorCanvas.vue:563-572（quarters → base/dot/flags）。
- x 坐标被夹在本小节内（scoreXOf 用 tick 所在小节的相对比例，EditorCanvas.vue:1131-1137），所以长音只出现在起始小节。
- 变音记号只按调号判断（acc = sp.acc - keyAcc(sp.letter)，EditorCanvas.vue:559-560），没有小节内的临时记号状态。
- 空小节只画一个全休止方块（EditorCanvas.vue:514-523），小节内的休止不画。

**影响**：这张谱不能给演奏者看，也不能当校对依据（「这里是不是少了一个休止」看不出来）。它只能当「音高分布图」。

**建议**：**不要**在 Canvas 上手写排版去做完整制谱（那是 Dorico/MuseScore 十年的工程量）。正确路径是：把「可编辑的五线谱」交给 Verovio 渲染 + 命中测试（Verovio 输出 SVG，节点带 xml:id，可以做点击/拖动），Canvas 只保留钢琴卷帘。若短期做不到，就把这张视图明确改名为「音高视图」，别叫「乐谱编辑」，避免用户拿它当制谱工具评价产品（见 P1-I1）。

---

### F-08 编辑页里按数字键 1~9 会切歌单并跳走；N / P 会换歌

**现象**：在调教页选中一个音，按 1~6 改时值——时值改了，同时侧栏切到第 N 个歌单、页面跳到曲库。在编辑页想按 N 做点什么，会切到下一首。

**证据**：
- 全局监听无条件处理数字键与 N/P/O：App.vue:518-540（数字键分支里 playlistStore.select + app.setView('music')；N/P 调 playNeighbor）。它只跳过输入框（isEditableTarget，App.vue:514），不知道当前在哪个视图。
- 调教页明确把 1~6 绑定为时值（ViewSing.vue:1077-1080），并且只 preventDefault，不阻止全局监听继续执行。
- 设置页的快捷键表还把「1-9 切换歌单」「N 下一首」列为通用键（SettingsPanel.vue:170-173）。

**影响**：这是一次输入就丢焦点/丢上下文的阻断级冲突。调教页的「数字键改时值」是它在文档里宣传的键盘流（ViewSing.vue:3032），实际不可用。

**修法**（半天）：App.vue 的全局键加「视图白名单」——编辑/调教/变谱/编排页生效时，把 1-9、N、P、O、L、M 让给页面；或统一走 core/commands.js 的命令表，由页面在自己的 area 里注册优先键（注册表已经支持 area 与冲突检测，ViewEdit.vue:573-611）。

---

## 4. P1：与专业工具差一个量级

### A. 手感与手势

**A1 拖动不吸附网格。** 移动分支直接用像素差换算 tick（EditorCanvas.vue:1345-1358），全程没有 snapTick；只有边缘拉伸才吸附（1362-1364）。DAW 的默认是「拖动吸附、按 Alt 临时关」。后果：拖过的音全部落在非整 tick 上，之后再量化就出现「越量越乱」。修法：move 分支对落点走 snapTick，加 Alt 反向。

**A2 卷帘没有标尺。** 画布上方没有小节/拍号标尺，没有点击定位、没有循环区间拖拽，也没有小节编号文本（draw 里只有竖线和 C 行音名：EditorCanvas.vue:687-730）。定位只能靠底部走带条或方向键。**在专业工具里，标尺是导航的主入口**（拖动播放头、框循环、双击加标记）。修法：在画布上方加 24px 标尺层，画小节号 + 拍线，支持点击定位、拖动播放头，Shift+拖 = 循环区间。

**A3 拉伸有 60 tick 的硬下限、没有「连奏拉伸」。** EditorCanvas.vue:1362-1364 写死 Math.max(o.start + 60, ...)；没有「拉到下一个音起点」的吸附（legato drag），也没有左侧拉伸时保持音尾不动的联动。

**A4 没有「按格子落音」的长度记忆。** 画笔落音长度固定 1 拍（EditorCanvas.vue:1280），不继承上一个音的长度、也不跟随当前网格；步进输入另有一套（1261-1276）。DAW 的惯例是「落音长度 = 当前网格值」。

**A5 悬停命中是 O(全轨音符)。** onHoverMove 每次都对整轨线性扫描（EditorCanvas.vue:1424-1429 → hitTest 1227-1242，双层循环含跨轨）。9 万音符时，鼠标每动一次就是 9 万次比较；而绘制已经用了二分（753-762）。修法：命中按 (tick 区间, midi) 建桶，或先二分定位视口再局部扫。

**A6 左侧没有可点击的钢琴键盘。** 只有 C 行音名文本（EditorCanvas.vue:723-730），不能点键试听、不能拖键选音域、不能折叠/展开八度（FL / Cubase 的键盘条是标准件）。

**A7 框选每次都先清空选区**（EditorCanvas.vue:1331），没有 Shift+框选追加；也没有「按时间范围选择」「反选」。选择能力目前只有：框选、全选、同音高（414-419）、近似和弦（ViewEdit.vue:1258-1268）。

### B. 快捷键

**B1 快捷键表只读，而且「恢复默认」是假的。** SettingsPanel.vue:166 注释直接写「只读展示」；resetKeys() 只弹一个 toast（SettingsPanel.vue:1004）；界面上的按钮（1668-1676）点了什么都不会发生。专业用户键位习惯差异极大（Cubase / FL / S1 三套肌肉记忆），不可改键位等于每次换工具都重新学。

**B2 速查表与实现矛盾。** 设置页写「Ctrl+拖拽 吸附到网格」「Shift+拖拽 吸附到音符」（SettingsPanel.vue:195-196）；实现里 Ctrl/Shift+点击是加选/减选（EditorCanvas.vue:1255），Shift+拖拽是**锁定音高**（EditorCanvas.vue:1348）。照着帮助按会得到相反的结果。

**B3 缺一批标准键位。** 现有：Ctrl+Z/Y/A/C/V/S、Delete、V/B/E、步进左右键、?（ViewEdit.vue:2139-2162）。缺：Ctrl+X（剪切）、Ctrl+D（重复）、Ctrl+Shift+Z（重做别名）、上下键移调 / Ctrl+上下八度、左右键微调、Q 量化、Alt+拖拽复制、Ctrl+E 导出、Home/End、逗号句号小节跳转、缩放选区。命令表只绑定了 6 个键（ViewEdit.vue:585 只把 hint 里带 + 的当 keys）。

**B4 方向键在调教卷帘里会「一边移音符一边移播放头」。** PianoRoll 用 window 级监听处理左右键移动音符（components/pianoroll/PianoRoll.vue:852-853），App.vue 的 window 级监听同时把它当快进/快退（App.vue:519-522）。两个都在冒泡阶段、都没检查 defaultPrevented，所以一次按键触发两件事。同类问题在 F-08。

### C. 量化 / 人性化

**C1 工具栏「量化」不可配置。** ViewEdit.vue:634 的 quantize() 调的是 EditorCanvas.quantizeSelected()，后者用当前吸附比例、**同时量化起点和终点**且强度 100%（EditorCanvas.vue:364-374）。没有「只量化起点 / 保留长度 / 只量化终点 / 强度百分比」。右键菜单里的量化（ViewEdit.vue:732-737）也只有 5 个固定网格。对照：Cubase 的 Quantize Panel 有五组独立参数；S1 的 Quantize 有 strength / swing / grid offset。

**C2「智能量化」的「强度」不是量化强度。** 代码里 target = ideal + offset * strength（ViewEdit.vue:1401-1403）——strength 只缩放 **groove 偏移量**，音符该吸多少到网格永远是 100%。界面上却叫「强度 60%」。用户预期是「只吸 60%」，实际是「groove 打 6 折、位置仍然硬吸」。这是语义级误导。

**C3 Groove 模板是 4 个写死的常数。** funk/jazz/rock/latin 各给一个 gridTicks * 0.18/0.24/0.12 的偏移（ViewEdit.vue:1395-1399）；提取的 groove 存进**全局 localStorage 单键**（1377）、不带轨道/工程、不含力度信息；没有「导入 .groove / MIDI 片段作为模板」，也没有 per-step 的表（真实 groove 是 16 个位置各有一个偏移量 + 一个力度系数）。

**C4 Swing 的数学与行业语义不符。** 公式是 ns = start + a * (g/2) * 0.5（core/midi-tools.js:244）：100% 时移动 0.25g，而三连音感的理想位置是前一个格点的 2/3 处，即偏移 g/6 ≈ 0.167g。也就是说这里的 100% 约等于「1.5 倍三连音」，而界面默认 33% 只有理想值的一半。DAW 里 swing 通常以 50%~75% 的**比例**表达（66% = 三连音），这里既不是比例也不是偏移量。

**C5 没有时间人性化。** MIDI 工具集里只有 velHumanize（力度，core/midi-tools.js:152-162），没有 timing humanize（±ms / ±tick、按拍位置加权）、没有「late/early 整体偏移」、没有 flam / roll 的精细控制。

**C6 strum 是「按选区序号」而不是「按和弦」。** core/midi-tools.js:256-265 对 arr 逐个加 i * step：选 8 个和弦 × 4 个音 = 32 个音，第 32 个音会被推迟 31 步（默认 20 tick ≈ 620 tick，超过一拍）。真实扫弦是**每个和弦内部**依次错开。

**C7 legato 是 O(n²)。** 对每个选中音，遍历整轨找下一个起点（core/midi-tools.js:191-196）——已排序却每次从头扫，选 5000 个音、轨上 2 万个音就是 1 亿次比较，界面上表现为「点了没反应」。

### D. 力度 / CC / 踏板 / 表情 / 弯音

**D1 工具栏「力度 +」实际是斜坡，且录进宏以后语义又变了。** velRamp 的公式是 n.vel + dir * i（EditorCanvas.vue:381-387）：第 i 个音加 3i。但按钮文案是「力度 +」，录制的命令是 vel_inc 3（ViewEdit.vue:647），而宏的 vel_inc 是**固定 +3**（core/macro.js:9、87-96）。于是同一个动作在界面上是斜坡、在宏里是偏移，录制的宏**复现不出**刚才的操作。修法：拆成 velOffset / velRamp 两个命令，按钮给固定偏移，斜坡走参数工具。

**D2 多选时检查器看不到、也改不了数值。** selInfo() 只在**恰好一个**音符时返回 midi/vel/start/len，多选返回 null（EditorCanvas.vue:1595-1605），检查器的力度滑杆因此变灰（ViewEdit.vue:2595 用 sel.vel 作判据）。DAW 的多选检查器给「混合值 + 拖动即统一」，这是批量改力度/时值最常用的入口。

**D3 CC 只有两条泳道，且曲线没有张力控制。** EditorCanvas.vue:44-45 定义 ccNumber / cc2Number，模板里只有两个 canvas（2003-2008）。ccMode 只有 free / line / curve 三档（46），**没有曲线张力（tension）**、没有「缩放/偏移整条 CC」、不能把轨道音量/声像自动化画成 CC7/CC10（这两个要回混音台推子，且是通道级）。

**D4 踏板只能「加一对起止」。** addPedal 在选区首尾插 CC64=127/0（EditorCanvas.vue:1792-1803），delPedal 按 tick 区间过滤（1804-1813）。不能看到踏板「区间条」、不能拖边界、不能做半踏板（0~127 连续）、不显示 Sostenuto / Soft（CC66/67）的区间语义——虽然 CC 列表里能选到它们（ViewEdit.vue:156-163）。

**D5 弯音只有一条通道级曲线。** PB 用 CC 泳道的 128 哨兵值实现（ViewEdit.vue:161-162、EditorCanvas.vue:871-920），只能编辑**整通道**弯音，没有 per-note pitch bend（MPE），也没有「弯音范围（RPN 0/1 或 semitones）设置」。界面上写着「±2 半音」（ViewEdit.vue:162）是硬编码假设——源文件里的 RPN 弯音范围不会被读也不会被写。

### E. 和弦 / 声部

**E1 没有「声部」（voice）概念。** 数据模型是 track → notes（core/midi.js:275-284），没有 voice / stem / 声部号；乐谱视图注释直接写「谱面排版本来就按一轨一行」（EditorCanvas.vue:99）。钢琴左右手、弦乐 divisi、合唱四部在数据里无处安放，只能靠多条 track 模拟，而 track 又不能新建（P1-L1）。

**E2 和弦轨是「分析出来的标签」，不参与编辑。** detectChordTrack 逐小节出和弦名（ViewEdit.vue:1144-1151），手改的名字只存在 chordManual 里；「写入 MIDI」只写 marker（ViewEdit.vue:1152-1165），不产生和弦音符、也不能像 Cubase Chord Track 那样驱动声部（用和弦轨生成/约束伴奏）。

**E3 跨轨编辑是「多轨同屏显示」，不是「多声部同谱」。** editTracks 只让其它轨一起显示、一起被框选（EditorCanvas.vue:96-106、752-790），其它轨被压灰且不可直接编辑（需切轨）。这对「对齐两条旋律」够用，对「写四部和声」不够。

### F. 撤销 / 历史（除 F-04 外）

**F1 编排页与编辑页是两套历史。** 编辑页是组件内的 undoStack（EditorCanvas.vue:229-230），编排页是 createTabbedHistoryRegistry（ViewArrange.vue:38-42、core/history_stack.js）。在编排页移动片段后切到编辑页按 Ctrl+Z，撤销的是编辑页的上一步（或什么都不发生），用户会认为「撤销坏了」。修法：把历史做成应用级单栈（按 tabKey 分段），或至少在切页时提示「当前页的撤销互不影响」。

**F2 撤销不恢复视图与选择。** undo() 里 selection.clear()（EditorCanvas.vue:304、313），视口也不动。DAW 的撤销会把视图带回被改的地方；大工程里「撤了但看不见改了什么」等于没有撤销。

**F3 快照不含轨道级状态。** tempoMap 单独存（234-243），但轨道名 / program / mute / 新增或删除的轨道不在快照里（pushState 只存 notes/ccs）。「智能伴奏」加 3 条轨靠全量快照 ti=-1 兜住（320），但普通的轨道属性修改无法撤销。

### G. 时间线 / 播放跟随

**G1 跟随播放只有一种策略。** followViewTick（core/editor_nav.js）在 draw 里滚动视口（EditorCanvas.vue:847-850），没有「连续滚动 / 翻页 / 居中 / 只跟到边界」几档，也没有「用户手动滚动时临时停止跟随、N 秒后恢复」。Cubase/S1 都有独立开关与行为选择。

**G2 播放头不可拖。** 画布上没有播放头的命中区域（draw 只画线，851-856）；要定位只能点底部走带条或方向键。

**G3 节拍器不可配。** metroClick 写死 1760/1175 Hz、重音只看拍（core/player.js:6-17）；没有「按拍号重音（6/8 重音在第 1、4 拍）」「count-in 小节数」「录音时才响」。

### H. 编排（除 F-05 外）

**H1 空白处拖拽没有任何反应。** 手势状态机会给出 INTENTS.MARQUEE（core/gesture.js:59），但 ViewArrange.onMove 只处理 PAN / 标尺 / dragCtx（ViewArrange.vue:354-374）——框选分支根本不存在，所以不能一次选多个片段、不能批量移动/删除。

**H2 片段不能复制粘贴。** 只有「复制片段」按钮 = 原位后面追加一个（ViewArrange.vue:423-432），没有 Ctrl+C/V、没有 Alt+拖拽复制、没有跨轨复制（移动可以，复制不行）。

**H3 轨道头不可交互。** .arr-heads 整体 pointer-events:none，只有 M/S 按钮例外（ViewArrange.vue:584-587）：不能点轨道头选中轨、不能双击改名、不能拖高度、不能调音量/声像。轨道名从 song 复制过来后**再也改不了**（arrange 侧没有 rename 入口，MIDI 侧也没有，P1-L1）。

**H4 16 轨上限。** defaultArrangeState 的 maxTracks 默认 16，且跳过没有音符的轨（core/arrange.js:331-343）。24 轨的管弦乐文件，第 17 轨以后在编排页**不存在**。

**H5 播放头靠 100ms 定时器重绘。** setInterval(() => { if (app.playing) draw(); }, 100)（ViewArrange.vue:507）——10fps 的播放头，且整块重画（含所有 clip 的迷你音符）。大工程会明显滞后；应改 rAF + 脏矩形。

**H6 没有 clip 级编辑能力。** 无循环次数 / 无淡化 / 无 gain / 无 automation 泳道 / 无 time-stretch（音频）/ 无 clip 颜色与命名编辑。作为「编排」它还停在「挪块」阶段。

### I. 制谱 / 转谱

**I1 乐谱页只读。** 整页交互只有 @click=onScoreClick 用于定位（ViewScore.vue:890），没有插入/删除/拖动/改时值/加连线/加力度/加歌词；「编辑」在卷帘的五线谱模式里（见 F-07）。用户会先入为主拿它和 MuseScore 比。

**I2 前端 MusicXML 解析器是简化版，且与引擎版并存。** ViewScore 的「导入 MusicXML」走 core/musicxml.js（ViewScore.vue:603），它：只读**第一个** divisions（core/musicxml.js:11）、只读**第一个** sound tempo（13-14）、只读**第一个** time（16-20）、不处理 tie / tuplet / slur / articulation / dynamics / lyric / repeat / 变拍（31-55），结束时把所有未闭合音符硬切成当前 cursor（53）。引擎侧另有一份正确的解析器（engine/engine_score2midi.py:13-22 明确列出 divisions 变化 / backup / chord / 连音线 / 变速规则）。结果：同一份 .musicxml 走「变谱页」和走「乐谱页导入」得到两份不同的 MIDI。

**I3 导出 MusicXML 时力度是「反推」的。** musicxml_out.js:183 按 velocity 映射出 dynamics 标记，用户并没有写过力度记号。往返一次就会「凭空多出力度」或者改变力度值——对制谱是错误语义，对 MIDI 是数据污染。

**I4 OMR / MusicXML 的结构信息在入库时被丢掉。** 识谱链路最终产出 MIDI（engine/engine_omr.py:21-22 的输出协议就是 MIDI），引擎里虽然解析了 MusicXML（engine_omr_backends.py:1769-1800「直接把 Audiveris 导出的 MusicXML 解析成内部结构」），但内部结构只有 notes/ccs/events。连音线被合并成长音（engine_score2midi.py:20）、力度记号被折成 velocity（401-441）、歌词只在「像力度记号」时才被用（253-255）。于是**谱面级校对不可能发生**——用户无法在谱上改一个连音线或一个休止。

**I5 Verovio 的「音符 ↔ tick」是按序号对齐的。** 单轨模式下把 SVG 里的 .note 依次配给按 (start, midi) 排序的音符数组（ViewScore.vue:215-233）。和弦、装饰音、跨行连音线、Verovio 自己插入的休止都会让序号错位，后果是「点谱上这个音，跳到另一个音」。总谱模式用 xml:id 查表（200-213）是对的，单轨模式应该也走这条路。

**I6 简谱 / TAB 按 1/16 网格硬量化。** core/score.js:62 把每个音吸附到 tpb/4 或 tpb/8 的网格；三连音、附点跨拍、自由速度全部失真。songToAbc 还被 import 进 ViewScore 但从未调用（ViewScore.vue:17），属于死代码。

### J. 调教（歌声合成）

**J1 音高曲线属于整条轨，而且不随音符移动。** pitchCurve 是轨级数组、坐标是绝对 beat（stores/singer.ts:262-267），UI 上明确标「作用于整条轨」（ViewSing.vue:3172-3173）；moveNotes 只改音符，不动 curve（stores/singer.ts:1069）。后果：调好一条曲线的颤音/滑音，只要把音符往前挪半拍，曲线就和音符错位，而且没有任何提示。SynthV / Vocaloid 的音高偏差是**按音符存**的，移动音符曲线跟着走。这是调教页最需要改的一条数据模型。

**J2 没有 per-note 音高模式与滑音控制。** 只有轨级 PIT 曲线 + 音分偏移（仅 DiffSinger，ViewSing.vue:3079-3080）。Vocaloid 的 PIT/PBS/PBW（弯音灵敏度/宽度）、SynthV 的 pitch mode（Sing/Rap）、portamento 时间都没有对应物。

**J3 音素时长不可编辑。** 音素条带能「看」边界与毫秒（ViewSing.vue:3139-3149），但界面自己写着「拖动边界改时长需要引擎支持逐音素时长」（3148）。辅音长度是调教里最常改的参数之一（咬字松紧），现在只能通过音素级表达式间接影响。

**J4 颤音只有三个参数。** 深度 / 速率 / 淡入（ViewSing.vue:3063-3077），没有起振延迟、没有相位、没有「前 30% 平直后渐入」的形状控制，也没有颤音预设（Vocaloid 的 vibrato preset 是常用件）。

**J5 参数可解释性：单位与默认值有了，作用域与代价没有。** tooltip 写了范围与默认（如 GENC -100~100、DYN -240~120，ViewSing.vue:3086-3112），这部分做得比多数国产工具好。缺的是：每个参数**作用在哪个层级**（音符 / 音素 / 轨）、**改了会不会被下游覆盖**（音素级 > 音符级 > 轨级的优先级只在注释里，3040-3160 的 UI 没有可视标记）、以及**听感方向**（「+20 会更亮还是更暗」）。建议每个参数加一行「作用域 + 优先级 + 一句话听感」。

**J6 渲染结果不可对比。** 渲染一次只能听一遍，没有 A/B（改前/改后）、没有「只渲染选中音符」、没有参数差异高亮。SynthV 的「渲染 → 局部重渲 → 对比」是调教的核心循环。

### K. 导出与互操作

**K1 MIDI 导出不带编排信息。** marker / region 只存在 song.arrange（core/arrange.js:304-319），导出只写和弦 marker（ViewEdit.vue:1152-1165）。「把编排的段落标记带给 Cubase」做不到。

**K2 没有「导出选区 / 循环区间」。** 三条导出路径都是整曲（ViewEdit.vue:1941、1980、2263）。音频导出有 range（ViewConvert.vue:34），MIDI 没有——而「把这一句发给别人」是高频需求。

**K3 音频只有 WAV。** core/export_options.js:10-12 只有 16/24/float32；没有 FLAC / MP3 / Ogg。视频导出已由主进程 ffmpeg 合成（ViewConvert.vue:1090 的界面说明；渲染侧走 WebCodecs / MediaRecorder，见 778-907），加音频编码（FLAC / MP3）的成本很低。

**K4 没有 MPE / MIDI 2.0，触后不可编辑。** 解析与导出都保留 poly/channel aftertouch（core/midi.js:71-72、190-193），但 UI 里没有任何编辑入口；弯音是通道级（D5）。现代表情演奏（SWAM / Vital / Serum MPE）无法在本工具里制作。

### L. 工程与轨道

**L1 不能新建 / 删除 / 重命名 / 重排轨道。** 全仓只有「智能伴奏」硬编码 push 三轨（ViewEdit.vue:1363-1365）；app store 只有 setTrackProgram（stores/app.ts:1289）；singer store 有完整 CRUD（stores/singer.ts:614、623、827），MIDI 侧没有。**影响**：从零开始写一首曲子这件事在产品里不存在，只能「导入一首 MIDI 再改」。这是定位级缺口。

**L2 不能编辑拍号。** sigMap 只被读取与导出（ViewEdit.vue:1941、1980、2263），没有任何 UI 写入点；变拍号能正确显示与播放（TimelineModel），但用户改不了。

**L3 marker / region 没有编辑 UI。** 只有编排页能加（ViewArrange.vue:467-483），编辑页看不到 marker，也不能在卷帘里拖标记。做影视配乐时的「对画面点」全靠编排页。

**L4 没有音频轨。** 编辑页只支持一条「参考音频」用于对齐（EditorCanvas.vue:43、793-823；ViewEdit.vue:1711-1724），不能放多条音频、不能录音频、不能做「MIDI + 人声」的工程。翻唱/调教产物要回到 DAW 才能和伴奏对。

**L5 混音的粒度是 MIDI 通道，不是轨道。** 推子/声像/静音/独奏最终落到通道（core/synth.js:840-847 的注释与实现），同一通道上的多条轨物理上分不开；界面也如实写了（PlayerBar.vue:335）。对 GM 文件可接受，对自制工程是硬限制。

### M. 转录 / 变谱

**M1 除 MuScriptor 外，转录结果是「固定 BPM 的绝对秒」。** engine_basic.py:134 的 midi_tempo 默认 120，auto_bpm 打开也只是**一个**全局 BPM（183-203），不写拍号、不写变速；hFT 路径没有 tempo 相关代码。后果：一段 rubato 钢琴或现场录音，转出来的 MIDI 小节线全错，量化即毁。只有 MuScriptor 带 beat grid（engine_muscriptor.py:1018-1033）。建议：把 beat_this 的节拍检测从「MuScriptor 专属」提升为「转录后处理公共步骤」，落成 tempoMap + 拍号。

**M2 智能修正（refine）只对文件，不对当前工程。** 入口只接受 midi 路径（ViewTranscribe.vue:1904-1920 → main/task-queue.js:153-174 → engine/smart_midi.py:262），编辑页没有「把我现在这首和参考音频对齐一下」。而 smart_midi 恰好有这个能力（对齐起音、力度秩变换、音高校验、可选量化，engine/smart_midi.py:8-13）。把它接进编辑页（选中区间 + 参考音频）是差异化很强的功能。

**M3 后处理会吃掉重复音。** merge_overlap 把同音高、间隔 ≤ gap_ms（默认 15~30ms）的音合并成一个长音（engine/midi_post.py:15-36）。快速重复音（轮指、双跳、trill）会被并成一条长音，且这个合并默认开启（piano 预设 merge_gap_ms=15，smart_midi.py:38-48）。

**M4 变谱页很强，但校对闭环短了一截。** 有对照图、逐页重试、体检、底图校对（ViewScoreConvert.vue:15-16、556-577），但校对只能进卷帘（钢琴卷帘），不能进谱面；也没有「与原谱逐小节对照」的双栏视图。

---

## 5. P2：打磨与结构债

| # | 问题 | 证据 |
|---|---|---|
| P2-1 | 死代码：songToAbc / renderPlan 无调用点 | ViewScore.vue:17；core/arrange.js:284 |
| P2-2 | 历史面板的时间戳是取用时生成的，全部相同 | EditorCanvas.vue:1818-1820 |
| P2-3 | 撤销深度 80 × 整轨深拷贝，内存无上限 | EditorCanvas.vue:247-248 |
| P2-4 | 跨轨编辑用 checkbox 而非在轨道列表里直接点选 | ViewEdit.vue:274-280 |
| P2-5 | 轨道检查器只有「勾选参与编辑 / 音色」，没有改名 / 删除 / 静音 | ViewEdit.vue:2626-2637 |
| P2-6 | 鼓组网格固定只画 8 小节，不能滚动 | ViewEdit.vue:1034、1054 |
| P2-7 | 五线谱模式的谱号「自动」按音域猜，不按声部/乐器 | EditorCanvas.vue:1080 |
| P2-8 | 简谱/TAB 与五线谱是两套独立实现，网格口径不同 | core/score.js:59-87 |
| P2-9 | 编排的 clip 名称默认等于轨名，无独立命名入口 | core/arrange.js:342 |
| P2-10 | 「智能伴奏」固定 3 轨 + 固定和声规则（三和弦 + 八分分解） | ViewEdit.vue:1334-1368 |
| P2-11 | 混音台注释承认「同通道多轨分不开」，但没有 UI 提示哪些轨共享通道 | PlayerBar.vue:335；core/synth.js:847 |
| P2-12 | 导出 WAV 估时按 44.1k 立体声估算，未跟随实际采样率 | ViewConvert.vue:75-84 |

---

## 6. 竞品能力对照（只列差距项）

| 能力 | FuFumidi | Cubase 13 | Studio One 6 | FL 21 | REAPER 7 | MuseScore 4 / Dorico 5 | SynthV 2 / Vocaloid 6 |
|---|---|---|---|---|---|---|---|
| 音符试听 | **无** | 有 | 有 | 有 | 有 | 有 | 有 |
| 多选拖动 | **只动一个** | 有 | 有 | 有 | 有 | 有 | 有 |
| 拖动吸附 / Alt 关闭 | 无 | 有 | 有 | 有 | 有 | 有 | 有 |
| 标尺 / 点击定位 / 循环拖拽 | **无** | 有 | 有 | 有 | 有 | 小节号可点 | 有 |
| 拍号编辑 | **无** | 有 | 有 | 有 | 有 | 有 | 有 |
| 轨道增删改排 | **无** | 有 | 有 | 有 | 有 | 有（声部） | 有 |
| 命令式撤销 + 命名步骤 | 快照 × 80 | 有 | 有 | 有 | 有（最强） | 有 | 有 |
| 量化参数组（强度/终点/网格偏移） | 部分 | 有 | 有 | 有 | 有 | 有 | n/a |
| Groove 模板导入 | 4 个常数 | 有 | 有 | 有 | 有（groove tool） | n/a | n/a |
| 时间人性化 | 无 | 有 | 有 | 有 | 有 | n/a | n/a |
| per-note pitch bend / MPE | 通道级 | 有（MPE） | 有 | 部分 | 有 | n/a | 有（PIT/PBS） |
| 五线谱编辑 | 草图级 | 有 | 有（Notion 集成） | 无 | 有 | **完整** | n/a |
| 总谱 / 分谱 / 排版 | 只读刻版 | 有 | 部分 | 无 | 无 | **完整（Dorico 最强）** | n/a |
| 识谱 OMR | 有（3 后端） | 有（PhotoScore 另购） | 无 | 无 | 无 | 有（MuseScore 内置） | n/a |
| 音频转 MIDI | **强**（10+ 模型） | 有（VariAudio） | 有（Melodyne 集成） | 无 | 有（ReaTune） | n/a | n/a |
| 音频轨 / 录音 | 无 | 有 | 有 | 有 | 有 | 有（MuseScore） | 有（伴奏轨） |
| 混音（每轨 FX / 发送） | 通道级 + 主 EQ | 完整 | 完整 | 完整 | 完整 | 基本 | 每轨 FX 链 |
| 导出格式 | WAV 3 档 + MP4 | 全 | 全 | 全 | 全 | PDF/PNG/MusicXML/MP3 | WAV |
| 快捷键可配置 | **无** | 有 | 有 | 有 | 有 | 有 | 有 |

结论：**引擎与格式层可以对标，交互与工程层需要补课**。要在同类里站住，不必赢 Cubase，只要把「卷帘手感 + 编排参与播放 + 制谱校对闭环」三件事做到 B 级，配合已有的转录/调教/OMR 强项，差异化就成立。

---

## 7. 升级路线

排序原则：先修「用了就会放弃」的（P0），再修「用久了会烦」的（P1 手感/快捷键），最后做结构性升级（编排入播放、制谱闭环）。每项都给验收标准，避免「改完说不清」。

### 期一（0~4 周）：从「能改」到「能用」

| 项 | 内容 | 验收 |
|---|---|---|
| 1 | 音符试听（F-01）：点击/落音/移调即响，带开关与音量 | 画 20 个音能逐个听出音高，不用按播放 |
| 2 | 多选拖动（F-02）+ Ctrl 拖拽复制 | 框选 8 音拖动，8 个一起动且相对位置不变 |
| 3 | 拖动吸附 + Alt 反向（A1） | 拖动落点永远在网格上；按住 Alt 可任意位置 |
| 4 | 走带与循环保持（F-03 快修） | 在循环里改 10 个音，播放位置与 [a,b] 不变 |
| 5 | 全局键让位（F-08、B4） | 调教页按 1~6 只改时值，不切歌单；卷帘按左右键播放头不动 |
| 6 | 撤销时机修复（F-04 第 1 步）+ 历史标签 | 逻辑编辑器/宏按一次 Ctrl+Z 完全还原；历史面板显示操作名与时间 |
| 7 | 标尺与点击定位（A2） | 卷帘上方有小节号与拍线；点击定位；Shift+拖画循环 |
| 8 | 内置音色的 CC 最小子集（F-06） | 默认音色下弯音、CC7、CC11、CC64、CC1 可听出变化 |

### 期二（4~12 周）：把骨架搭正

| 项 | 内容 | 验收 |
|---|---|---|
| 9 | 编排进入播放（F-05）+ 编排 M/S 生效 | 移动片段、静音轨、裁剪后，播放与导出都跟着变 |
| 10 | 撤销改为命令式（F-04 第 2 步） | 10 万音符工程连续 50 次编辑，撤销栈内存 < 50 MB；跨页可撤 |
| 11 | 轨道管理（L1）+ 拍号编辑（L2） | 新建/删除/改名/拖排轨道；在播放头插入拍号并即时重排小节 |
| 12 | 量化体系（C1~C4） | 量化面板：起点/终点/长度三开关 + 强度 + 网格偏移 + swing 比例（50~75%） |
| 13 | Groove 与时间人性化（C3、C5） | 能导入一个 MIDI 片段当 groove（含力度表）；timing humanize ±ms |
| 14 | CC 体系（D3、D4、D5） | 4 条任意 CC 泳道 + 曲线张力；踏板区间条可拖；弯音范围可设 |
| 15 | 快捷键可配置（B1、B2、B3） | 键位可改、可存两套、与命令表同源；帮助表由实现生成 |
| 16 | 编排交互补齐（H1~H5） | 框选多片段、Ctrl+C/V、Alt 拖拽复制、rAF 播放头、去掉 16 轨上限 |

### 期三（12 周+）：差异化与闭环

| 项 | 内容 | 验收 |
|---|---|---|
| 17 | 制谱校对闭环（I1~I5）：用 Verovio 出可点击的谱，或明确降级为「音高视图」 | 识谱结果能逐音在谱上核对并修正；或产品文案不再承诺「乐谱编辑」 |
| 18 | MusicXML 单一解析器（I2）：前端复用引擎解析结果 | 同一 .musicxml 在变谱页与乐谱页导入得到相同 MIDI（往返测试） |
| 19 | 转录公共节拍层（M1）：beat_this 覆盖全部模型 | 现场录音转出的 MIDI 小节线与音频对齐（±1 帧） |
| 20 | refine 进编辑页（M2） | 选中区间 + 参考音频 → 一键对齐/还原力度 |
| 21 | 调教音高曲线归属（J1、J2）：曲线挂到音符、随音符移动 | 移动音符后颤音仍在该音上；能画 per-note 弯音 |
| 22 | 音素时长（J3）+ 颤音形状（J4） | 拖音素边界改时长（引擎支持后）；颤音有起振延迟 |
| 23 | 互操作（K1~K3） | MIDI 导出带 marker；导出选区；FLAC/MP3 |
| 24 | 混音粒度（L5） | 同一通道多轨可分别调（需要每轨独立增益节点） |

### 不建议做（避免把预算烧在没有胜算的地方）

- **完整排版引擎**（Dorico/MuseScore 级）：除非产品定位改成制谱，否则把 Verovio 用到极致即可。
- **VST 宿主**：现在只有离线 pedalboard 试验（ViewConvert.vue:422），实时插件宿主是另一个产品的工程量。
- **音频 clip 时间伸缩 / 剪辑**：与「MIDI 工作流」定位冲突，交给 DAW。
- **MIDI 2.0 / UMP**：现阶段收益远小于 MPE 与 CC 体系的完善。

---

## 8. 参考与出处

**本次联网核对过的（2026-10-29）**：

- beat_this（节拍检测，CPJKU）—— https://github.com/CPJKU/beat_this
- DAWproject（Bitwig / PreSonus 交换格式）—— https://www.bitwig.com/de/support/technical_support/dawproject-file-format-faqs-62/
- MuScriptor 权重页（CC-BY-NC-4.0）—— https://huggingface.co/cocktailpeanut/muscriptor-large
- MuScriptor 仓库 —— https://github.com/muscriptor/muscriptor

**仓库内已有、可直接复用的参考实现**：

- Verovio 集成与刻版参数：frontend/src/views/ViewScore.vue:100-260
- 手势状态机（拖动/拉伸/框选/平移判定）：frontend/src/core/gesture.js
- 命令注册表（菜单/面板/快捷键/宏共用）：frontend/src/core/commands.js
- 编排纯逻辑与渲染计划：frontend/src/core/arrange.js
- MusicXML 正确解析规则（divisions 变化 / backup / chord / 连音线 / 变速）：engine/engine_score2midi.py:13-22
- 智能修正算法（起音对齐 / 力度秩变换 / 音高校验）：engine/smart_midi.py:54-260
- 质量门禁指标定义（note/onset/pedal F1）：docs/quality-baseline.md

**未联网核对、基于公开常识的对照**（★）：

- Cubase 13 的 Logical Editor / Quantize Panel / Arranger Track / Chord Track / MPE 支持
- Studio One 6 的 Arranger Track、Melodyne 集成、Scratch Pad
- FL Studio 21 的 Piano Roll（strum / chop / articulate / humanize）与 ghost notes
- REAPER 7 的 undo 历史（命名步骤 + 跨窗口）与 Groove Tool
- MuseScore 4 的声部（voice 1-4）、连音线、分谱；Dorico 5 的 condensing 与排版
- Vocaloid 6 的 PIT/PBS/PBW、SynthV 2 的 pitch mode / AI retake / 音素时长
- OpenUtau 的 part 模型、渲染器（CLASSIC / Worldline）与表达式体系

---

## 9. 复现清单（点一遍就能看到）

| # | 操作 | 预期（按本报告） | 若不符则本报告该条作废 |
|---|---|---|---|
| 1 | 编辑页画一个音，点它 | 无声 | 有试听音 → F-01 作废 |
| 2 | 框选 8 个音，拖其中一个 | 只动 1 个 | 8 个一起动 → F-02 作废 |
| 3 | 选区循环 4 小节，改一个音，看循环范围 | 变成整曲循环 | 仍是 4 小节 → F-03 作废 |
| 4 | 设循环，暂停在中段，改一个音，按空格 | 从曲首开始 | 从中段续播 → F-03 部分作废 |
| 5 | 逻辑编辑器把力度 <40 的全 +20，Ctrl+Z | 无变化 | 还原成功 → F-04 部分作废 |
| 6 | 编排页把片段右移 4 小节，播放 | 听不出变化 | 听得出 → F-05 作废 |
| 7 | 编排页点鼓轨 M，播放 | 鼓还在响 | 鼓消失 → F-05 部分作废 |
| 8 | 不装 SF2，画 CC11 从 0 到 127，播放 | 听不出变化 | 有渐强 → F-06 作废 |
| 9 | 乐谱视图放一个跨 2 小节的音 | 只画在第一小节 | 画成两个音 + 连音线 → F-07 作废 |
| 10 | 调教页选中音符按 1 | 时值改 1/32 且跳到曲库 | 只改时值 → F-08 作废 |
| 11 | 编辑页按 Shift+拖拽一个音 | 音高被锁（只改时间） | 吸附到别的音 → B2 作废 |
| 12 | 设置 → 快捷键 → 恢复默认快捷键 | 只弹 toast，无变化 | 真恢复 → B1 作废 |

---

## 附录 A：本次走查用到的检索式

便于复审时复现同一批结论：

- 试听 / audition / previewNote / note-on 接入点 → 0 命中（EditorCanvas）
- player.load( 的调用点 → 6 处，其中 EditorCanvas.vue:273 在 afterEdit 内
- setLoop( 的调用点 → 8 处，编辑页只有 ViewEdit.vue:920/928 与 EditorCanvas.vue:275
- pushStateForTrack( 的调用点 → 12 处，其中 3 处在 mutate 之后（ViewEdit.vue:1456/1490/1508）
- INTENTS.MARQUEE 的消费点 → 0（编排页只处理 PAN）
- tracks.push( 的调用点 → 只有 ViewEdit.vue:1363-1365（智能伴奏）与导入路径
- parseMusicXMLToSong 的调用点 → 只有 ViewScore.vue:603
- frontend/tests（64 个文件）中对 velRamp / 多选拖动 / 试听语义的用例 → 0

## 附录 B：与既有文档的关系

仓库里已有 docs/editor-upgrade-plan.md（P0-1 调内编辑、P1-1 音高曲线手绘等）与 docs/sing-editor-usability-plan.md。本报告的 F-01（试听）、F-02（多选拖动）、F-03（走带保持）、F-05（编排入播放）**不在**这两份计划里，属于新的缺口；F-04（撤销）与计划里的「阶段化」相邻但方向不同（计划是加功能，这里是修语义）。建议把 F-01~F-08 单独开一份「编辑手感 P0」清单，避免和功能计划混在一起被排到后面。
