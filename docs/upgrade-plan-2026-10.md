# FuFumidi 全面升级计划 —— 以「编辑操作界面大升级」为核心（音乐编辑 + 调教编辑）

> 生成时间：2026-10-06 ｜ 状态：执行中（M0 完成·M1 完成，见附录 B / C）
> 依据：本会话对「变谱」的实测、用户提供的 OMR / DAW / 歌声合成工具清单、当前源码能力盘点。
> 参考的同类软件编辑 UI：Synthesizer V Studio 2 音符与参数面板、Ableton Live 12 MIDI Tools（Transform / Generate）、
> FL Studio Piano Roll 与 Riff Machine、Cubase Key Editor（演奏技法 / 音符表情 / Logical Editor / List Editor）、
> Logic Step Editor、Studio One Note FX 与 Macro 工具条、REAPER 鼠标修饰键矩阵与鼓组映射、
> MuseScore 步进输入与调色板、OpenUtau / DiffScope 曲线与音素编辑、VOCALOID6 参数化表情。

## 0. 现状（实测与盘点）

### 0.1 编辑页（frontend/src/views/ViewEdit.vue，67 个动作）
界面：顶栏一排按钮（选择/画笔/橡皮/静音 · 钢琴/鼓组/乐谱 · 撤销/重做/删除/量化 · 全屏 · 更多 ▾）→ 迷你图 + 缩放条 → 和弦轨 → 卷帘画布 → 右侧单页检查器。
低频动作全在「更多 ▾」：剪贴板、力度、移调、音阶、和弦、智能伴奏、智能量化、逻辑编辑器、宏、键位、历史、CC 泳道、踏板与循环、歌词、音频吸附、视频、帮助。
问题：① 工具栏固定顺序，实测挤成 256px、音符区只剩 187px；② 检查器单页长列表；③ 逻辑编辑器/宏/智能量化/智能伴奏都是「一次执行的黑盒对话框」，无实时预览；④ 只有卷帘一种编辑视图，缺步进/列表视图与视图联动；⑤ 无音符着色规则、无鼓组映射命名；⑥ 快捷键不可视化/自定义；⑦ 长任务无统一入口。

### 0.2 调教页（frontend/src/views/ViewSing.vue + components/sing/VoicebankPanel.vue）
界面：页签（编辑器 / 声库 / 声库制作）→ 左轨道列表 → 卷帘 → 右侧（已选音符、音素级编辑、音高曲线表）。
参数现状：颤音=布尔开关；气声/gender=数字输入；音高曲线=点表。
问题：① 曲线无图形工具（画笔/直线/平滑/擦除/复制）；② 颤音不是包络；③ 音素无波形/频谱、无切分把手、无单音试听；④ 渲染只能整轨；⑤ 声库不能试听、别名表不可编辑、无音域热力图。

### 0.3 转谱（变谱）现状
经典后端（engine/engine_omr.py）：6 页《野蜂飞舞》每页 217~354 音、全曲 1329~1551 音，但变化音只认出 8~62 个、存在过检与拍号误判（用户导出 1.mid：182.9s、60 拍空洞）。
外部引擎：Audiveris 5.11 已解包可用；低清页面在 SCALE 步被判「无多行谱表」而整页丢弃 → **加入喂图前处理后可全流程跑通并导出 MusicXML**（见附录 A）。

## 1. 目标（编辑优先）
1. 音乐编辑：升级为 Cubase/FL 级别的编辑工作台（视图多、操作快、批量与表达强）。
2. 调教编辑：升级为 SynthV/DiffScope 级别的曲线与音素工作台。
3. 通用：任意窗口宽度工具栏不换行且动作全可达；常用链路 ≤5 次点击；无鼠标可走完导入→改音→播放→导出。
4. 每个功能：EN/JA 全语言、动效沿用既有语言（0.2~0.34s + cubic-bezier(.2,.7,.3,1)）、引擎侧 pytest、部署安装版实测。

## 2. 新版编辑工作台（信息架构重构，音乐与调教共用）
- 顶区：① 菜单条（文件/编辑/视图/工具/帮助，现有「更多 ▾」拆入）；② 上下文工具条（随视图切换，自适应溢出、永不换行）。
- 左区：轨道 / 段落 / 音符组（可折叠、宽度可拖、状态入工作区）。
- 中区：编辑画布（多视图 + 选择/滚动/缩放联动）。
- 右区：Inspector 分页（音符 / 轨道 / 参数 / 音素 / 技法），可收起、可左移、宽度记忆。
- 底栏：常驻状态栏 + 任务条。
- 落点：新增 components/editor/EditorShell.vue；ViewEdit.vue、ViewSing.vue 改为装配 Shell；EditorCanvas.vue / PianoRoll.vue 作为中区视图。

## 3. 音乐编辑 UI 大升级
### 3.1 参数化 MIDI 工具（头号项，借 Ableton Live 12 / Cubase Logical Editor / Studio One Note FX）
把逻辑编辑器 / 宏 / 智能量化 / 智能伴奏统一成两类：Transform（量化、摇摆、人性化、连奏断奏、密度、音域压缩、加倍和声、音阶吸附）与 Generate（节奏型、欧几里得、琶音、和弦排列、变奏、可回放 Seed）。
关键交互：参数面板 + 实时预览 + 试听/提交/撤销，可存预设。
落点：components/editor/MidiToolDialog.vue + core/midi-tools.js（纯函数可单测）+ engine/midi_tools.py（批处理/插件复用）。
验收：拖动参数即预览、Esc 还原、回车进撤销栈。

### 3.2 音符级快捷操作（借 FL 悬停工具条 / Studio One）
选中音符上方浮出迷你工具条（力度±、时值、静音、复制、删除、歌词/音素）；统一右键菜单（选择敏感、带快捷键提示）。
落点：EditorCanvas.vue 增加 hoverToolbar 图层；components/ui/ContextMenu.vue。

### 3.3 步进编辑器 + 列表编辑器 + 三视图联动（借 Logic / Cubase / Sekaiju）
StepEditor.vue（时间格 × 音高/参数行，方向键步进、数字键时值、回车插入）；ListView.vue（表格：起点/长度/音高/力度/歌词/技法，多列排序与批量编辑，与卷帘/乐谱选择同步）；切换视图保留滚动/缩放/选择。
落点：两个新组件 + stores/editorView.ts。

### 3.4 音符着色规则 + 鼓组映射命名（借 REAPER）
着色维度：轨道色 / 通道 / 力度 / 技法 / 音阶外音高亮 / 和弦音；鼓组视图可按音高命名并保存映射。
落点：core/note-color.js、core/drum-map.js（含 GM 预设与导入导出）。

### 3.5 音符工具补全（借 FL Slide / MuseScore / Cubase）
滑音工具、连音线、三连音/多连音输入、附点与休止输入、和弦 Stamp；乐谱视图同步这些能力。

### 3.6 跨轨编辑工作台（借 Studio One / Cubase）
多轨同屏框选、跨轨拖动/复制（轨道映射）、跨轨量化/静音、轨道组联动。

### 3.7 表达映射与技法条（借 Cubase）
ksMap 升级为「技法 → {键位、CC 曲线、力度系数、通道/音色}」；卷帘下方技法条（可画/拖/批量）；映射文件导入导出。
落点：core/expression-map.js + Inspector「技法」分页。

### 3.8 自动化泳道（借 Cubase / Studio One）
速度、拍号、轨道音量/声像、任意 CC 的自动化泳道（与 CC 泳道同组件）。

### 3.9 效率设施（借 REAPER 鼠标修饰键矩阵 / Cubase Command Search）
命令面板升级（模糊搜索 + 快捷键显示/编辑 + 最近使用 + 对选中对象执行）；鼠标修饰键矩阵；? 快捷键速查表与冲突检测、键位导入导出。

## 4. 调教编辑 UI 大升级
### 4.1 参数曲线面板（头号项，借 Synthesizer V Studio 2 / DiffScope / VOCALOID6）
Inspector「参数」分页：每条曲线一行、可折叠、可 Solo、可锁定、可只显示有数据项；参数含音高偏差、颤音（深度/速率/相位）、响度、张力、气声、性别、发声。
曲线工具条：画笔、直线、贝塞尔、擦除、平滑、量化半音/节拍、复制到其它音/轨、叠加参考轨。
落点：components/sing/ParamPanel.vue + components/sing/CurveCanvas.vue；沿用轨道 curves/fx/pitchCurve 数据模型。

### 4.2 颤音编辑器（包络化，借 SynthV / VOCALOID Attack·Release）
布尔开关升级为速率/深度/相位三条包络 + 起音/收尾参数；双击音符开颤音、拖拽手柄调深度渐变。

### 4.3 音素编辑工作区（借 OpenUtau / DiffScope / vLabeler）
音素轨：波形 + 频谱底图、音素块与边界拖拽把手、双击改发音、右键换候选；单音试听（秒级）；音素时长整体拉伸。
验收：把「sh」边界前移 40ms 并立刻听到差异。

### 4.4 音符属性面板（借 SynthV 音符面板 / VOCALOID）
音高/时长/歌词/音素（含候选）/力度/颤音/气声/gender/语言与音色/别名；Tab 上下一个音、数字键改时值、↑↓ 半音、Ctrl+↑↓ 八度。

### 4.5 多轨与和声组（借 SynthV Group / OpenUtau）
组内统一编辑 + 组级参数覆盖。

### 4.6 增量渲染 + A/B（借 SynthV 渲染缓存）
按乐句哈希缓存，只重渲改动乐句；顶栏 A/B 槽位；任务条显示进度与缓存命中率。

### 4.7 oto.ini 编辑器（借 vLabeler / COPAIBA TOUCH）
波形 + offset/overlap/preutterance 三参数线 + 列表，Shift-JIS/UTF-8 切换，支持笔/触控。

## 5. 通用 UI 基础
工作区（stores/workspace.ts，收拢现有 7 份 localStorage，预置编曲/调教/校对/混音）；任务中心 + 状态栏；可发现性（模块内 3 步微引导、空状态行动号召、内置示例工程与示例谱、悬停提示带快捷键）；密度三档 + 全局 UI 缩放 0.9~1.3 + 深浅/跟随系统/高对比 + 色盲友好轨道配色。

## 6. 转谱（M0，先修好）
1. 多后端架构 engine/omr_backends.py（classical / audiveris / oemer-onnx，统一 schema + 降级 + 回报引擎名）。
2. 引擎分发：资源中心「识谱引擎」页签；Audiveris 走 MSI 免安装解包；oemer 权重走 HF/hf-mirror 或自建镜像。
3. **喂图前处理（已验证必要）**：3× 上采样 + 二值化 + 线条加粗，否则 Audiveris 在 SCALE 步丢弃整页（附录 A）。
4. 识谱校对视图：识别完先开临时工程，原谱页图作半透明底图对齐，用新版工作台直接改音。
5. 质量报告与警告码（backend-missing / ties-unsupported / tuplets-unsupported / multi-voice-merged …）。

## 7. 里程碑
| # | 内容 | 验收 |
| --- | --- | --- |
| M0 | 转谱修复：Audiveris 打通 + 校对视图形状 | ✅ 6 页 2062 音符 / 41.5 s（附录 B）；校对视图与资源中心入口待补 |
| M1 | 编辑工作台骨架（EditorShell/上下文工具条/Inspector 分页/状态栏/工作区） | ✅ 见附录 C：窄窗口不裁切、预设一键切换并重启保持、§ 与 ? 全部实测 |
| M2 | 参数化 MIDI 工具（Transform/Generate + 实时预览 + 预设） | 拖动即预览、Esc 还原、回车进撤销栈 |
| M3 | 音符级快捷操作（悬停条/右键菜单/修饰键矩阵/命令面板/快捷键速查） | 改力度·时值·静音 ≤2 次点击；无鼠标完成导入→改音→导出 |
| M4 | 步进编辑器 + 列表编辑器 + 三视图联动 + 着色/鼓组映射 | 切视图不丢选择；列表批量改 10 音即时反映 |
| M5 | 表达映射 + 技法条 + 自动化泳道 + 跨轨编辑 | 管弦乐示例按技法切换；速度自动化跑完全曲 |
| M6 | 调教参数曲线面板 + 曲线工具条 + 颤音编辑器 | 画「前平后颤 + 尾滑」并 A/B |
| M7 | 音素编辑工作区 + 音符属性面板 + 增量渲染/A-B | 改音素边界立刻听到差异；改一个音只重渲该乐句 |
| M8 | 多轨和声组 + oto.ini 编辑器 + 声库管理 2.0 | 打开 UTAU 声库→改 oto→立刻听出差异 |
| M9 | 密度/缩放/主题/色盲配色/触控笔 | 三档密度与缩放全站不破版 |

## 附录 C：M1 完成情况（编辑工作台骨架，2026-10-06 第三轮）

### C.1 新增/改动

| 文件 | 内容 |
| --- | --- |
| `frontend/src/stores/workspace.ts`（新） | 工作区布局单例：`inspOpen / inspW / rollH / viewMode / density`，迁移旧键 `fufumidi_edit_insp`、`_insp_w`、`fufumidi_roll_h`；四套预设 编曲 / 调教 / 校对 / 混音；写 `fufumidi.workspace` 与 `.preset` |
| `frontend/src/components/editor/EditorMenuBar.vue`（新） | DAW 式菜单条（点击开合 / 悬停切换 / Esc / 点外部关闭），`groups: MenuGroup[]` 由页面注入 |
| `frontend/src/views/ViewEdit.vue` | 菜单条 5 组（文件 7 项 / 编辑 10 项 / 视图 9 项 / 工具 16 项 / 帮助 4 项）；工作区预设 chip 与「快捷键」按钮；**上下文任务条**（选中后 14 个就地动作 + 宏录制计数）；检查器分页（音符 / 轨道 / 视图，0.22 s 进入动画）；状态栏补 视图 / 吸附 / 检查器开关 / `?`；快捷键一览弹窗（`?` 或 F1，4 组 19 行，只列代码里真实存在的手势） |

### C.2 顺带修掉的两个真问题（都在安装版上复现并验证）

1. **整页横向溢出、右侧被裁**：`.edit-view` 是 flex 项，全局 `.page` 的 `margin:0 auto` 让交叉轴自动外边距**取消了 stretch**，页面按 max-content 撑到 1233 px（视口只有 925 px），被 `.app-main` 的 `overflow-x:hidden` 裁掉 —— 工具条右侧的「更多」、状态栏右半、右上角小地图**一直在视口外**。修法：`width:100%; max-width:none; margin:0; min-width:0`。
2. **菜单弹层被下面的卡片盖住**：`.card` 带 `backdrop-filter`，每张卡自成层叠上下文，兄弟卡按 DOM 顺序绘制，于是 `.mb-pop` 的 `z-index:60` 只在菜单条这一层里有效。修法：菜单条卡片 `position:relative; z-index:40`。

另外把状态栏里**不成立**的手势说明（「Alt+拖拽 力度」——画布里没有这个绑定）换成真实手势。

### C.3 安装版实测（`E:\Midi\FuFumidi`，CDP 驱动）

- 布局：页面 925 px / 视口 1268 px，`fits: true`；工具条出现横向滚动且「更多」sticky 钉在右端。
- 菜单：5 组全部打开读取，禁用态正确（无选中时 复制 / 删除 / 力度曲线 等为灰）。
- 预设：校对 → 视图「乐谱」+ 检查器开；编曲 → 视图「钢琴卷帘」+ 检查器关；`localStorage.fufumidi.workspace.preset` 落盘。
- 检查器分页：音符 / 轨道 / 视图 三页切换，同时只渲染一页，页头正确（网格与显示）。
- 快捷键表：`?` 与 F1 均可开，4 组 19 行，Esc/遮罩可关。
- 上下文任务条：框选 28 个音符 → 「已选 28」+ 14 个按钮出现；取消选择回到提示态；标签单行（高 17 px，条高 34 px）。
- 更多面板：11 组，矩形在视口内，`elementFromPoint` 命中 `.ed-adv`（确实盖住任务条）。

### C.4 i18n

新增中文文案 66 条 + 状态栏提示 1 条，`I18N_MAP` 与 `I18N_JA` 各 67 条全部补齐（含只在模板里动态 `t()` 的快捷键表与预设提示 —— 这类字符串审计脚本扫不到，靠 `dyn-check` 单独比对）。审计结果维持基线：`missing EN 5 / JA 5`（全是含 `\n` 的既有条目误报）。

## 8. 风险与取舍
1. 工作台重构面大 → 增量重构（先插 Shell 与分页，再迁移「更多」里的动作），每步可回滚可部署。
2. 曲线性能 → 沿用现有 rAF + 只重绘数据层的画布架构。
3. Audiveris 81MB 且 AGPL → 以「用户自行下载的独立可执行文件 + 命令行调用」集成，不再分发其代码。
4. 低清输入有上限 → 校对视图 + 编辑工作台是必须的另一条腿。
5. 不做训练类（DiffTrainer 线），只做「导入第三方模型 / 导出声库数据集」的桥梁。

## 9. 待拍板
1. 工作台深度：固定分区 + 工作区预设（建议）还是也要面板可停靠/浮动？
2. MIDI 工具形态：Ableton 式预览即所得为主（建议）+ Logical Editor 进阶页签？
3. 调教参数：先做音高偏差 + 颤音两条（建议）还是七条一起？
4. 顺序：M0 转谱修复先（建议）还是先 M6 调教曲线？

---

## 附录 A：M0 实测进展（2026-10-06）

### A.1 Audiveris 卡点定位
原始 630×924 页面直接喂给 Audiveris 5.11（batch + export）：
```
INFO  StepMonitoring | LOAD → BINARY → SCALE
WARN  SheetStub 411  | page1 either this sheet contains no multi-line staves,
INFO  Sheet page1 flagged as invalid.
WARN  Book 2044      | Error processing stub StepException: Sheet ignored
      Caused by: StepException: Sheet ignored at ScaleStep.doit
INFO  Book 596       | Could not export since transcription did not complete successfully
```
→ **原因：低分辨率（谱线间距 ≈6px）让 SCALE 步估不出谱表 scale，整页被判无效**，不是安装或许可问题。`-force` 无法绕过。

### A.2 修法与结果
喂图前处理（E:\Midi\_sing_tmp\omr\prep_audiveris.py）：**3× LANCZOS 上采样 → 按背景亮度二值化 → 3×3 最小值滤波加粗**（输出 1890×2772，墨占比 0.176）。
再跑 Audiveris：**全流程通过**——
```
LOAD → BINARY → SCALE → GRID → HEADERS → STEM_SEEDS → BEAMS → LEDGERS → HEADS → STEMS →
REDUCTION → CUE_BEAMS → TEXTS → MEASURES → CHORDS → CURVES → SYMBOLS → LINKS → RHYTHMS → PAGE
PartwiseBuilder | Exporting sheet(s): [#1]
ScoreExporter   | Score p1_x3 exported to p1_x3.mxl
```
产物：`p1_x3.mxl`（4.8KB）+ `p1_x3.omr`（176KB）。

### A.3 转成 MIDI（复用现有 engine/engine_score2midi.py）
```
to-midi --in p1_x3.mxl --out p1_av.mid
→ tpb=480, bpm=120, notes=273, tracks=[Piano], range=[37,88]
MIDI 实测：长度 35.6s，音符 273，起始拍 134 个，最大空洞 2 拍（无长空洞），音域 37~88
```
对比经典后端同一页（217~354 音、变化音 8 个、无小节/时值结构）：**Audiveris 这条链路自带小节/时值/连音/休止结构**，是质变方向。

### A.4 已知问题（下一步）
1. 它把拍号读成 **6/4**（低清「2/4」数字被识别错）→ 说明低清页面即便跑通，**校对视图仍是必需的**（与 §6.4 一致）。
2. 只跑了单页；下一步做**六页批量预处理 + 后端封装**，并把 `prep_audiveris.py` 的能力并进 `engine/omr_backends.py` 的 audiveris 后端。
3. 还需接入资源中心（引擎分发）与 `omr-engine.json` 版本记录。
## 附录 B：M0 完成情况（2026-10-06 第二轮）

### B.1 多后端调度层（engine/engine_omr_backends.py）
- 三个后端一个出口：\`classical\`（自带，离线永远可用）/ \`audiveris\`（外部成熟 OMR）/ 预留 oemer；
  \`--backend auto\` 时「装了 Audiveris 就用它」，没装或失败**自动降级**并在结果里回报
  \`backend-missing\` / \`classical-fallback\` / \`audiveris-failed\` 这些**可翻译的警告码**。
- 喂图前处理（\`prep_image\`）：3× LANCZOS 上采样 + 阈值二值化 + 3×3 加粗 + 6000px 上限保护。
- **逐页导出 + 顺序拼接**：Audiveris CLI 是「一个输入文件一本书」，六页会导出六个 .mxl；
  只取第一个就会「六页只出一页的音符」（实测 273 音，和单页一样 ✗）。
  \`merge_midis()\` 按每页实际长度顺序拼接（保留各页速度表），修好后六页 **2062 音** ✔。
- 测试：\`engine/tests/test_omr_backends.py\` 6 条（预处理尺寸/二值化/尺寸上限、拼接偏移、
  显式路径优先、缺引擎回报可翻译代码、classical 兜底可用）。引擎全量 **170 通过 / 2 跳过**。

### B.2 实测对比（同一份 6 页《野蜂飞舞》，630×924）
| 后端 | 音符数（逐页） | 变化音 | 小节/时值结构 | 用时 |
| --- | --- | --- | --- | --- |
| classical | 1329~1551（217~354/页） | 8~62 个 | 需自行推断，拍号易错 | ~40s |
| **audiveris** | **2062**（273/345/392/419/381/252） | 由 MusicXML 还原 | 自带（含休止/连音/时值） | **41.5s** |

### B.3 应用内安装（这一块本来是「用户装不上就白搭」）
- 新增 \`main/omr.js\`：\`omr:status / install / remove / openDir\`，进度通过 \`omr:progress\` 推给界面；
- 安装方式 = 下载官方 MSI → **administrative install 免安装解包**（\`msiexec /a ... TARGETDIR\`）
  到数据根目录 \`<dataRoot>/omr/audiveris\`，不写注册表、卸载就是删目录；
- **下载要三级回退**（这台机器上的实测教训）：
  ① Electron net（Chromium 栈，会自动跟随 GitHub 302）实测 **4 分钟只下 1MB**；
  ② Node 直连同样卡住；
  ③ **PowerShell 的 Invoke-WebRequest（走系统代理 WinINET）81MB / 60 秒下完**。
  实现成 net → node → powershell 依次尝试，并对前两条加「15 秒无数据即判卡住」的看门狗；
  最终在应用里整个安装流程 **38 秒装完且立刻可用**（实测）。
- 「变谱」页在未安装时显示可操作横幅（「装上识谱增强引擎会好一个量级」+ 一键安装 + 进度），
  装好后显示「识谱增强引擎已就绪：Audiveris 5.11.0」。

### B.4 顺带修掉的两个真问题
1. **部署脚本丢新文件**：\`deploy-installed.cjs\` 只覆盖基线里**已有**的文件，
   新增的 \`main/omr.js\` 根本不进 asar → 安装版启动即弹
   \`Cannot find module './main/omr'\`。已改成「覆盖 + 新增」，并加了两道保险丝：
   跳过 \`*.asar/*.zip/*.exe/*.msi\` 与 >30MB 的文件；
2. 同一处还漏掉了 \`resources/\`（运行期 python/模型，实测 1.6GB）不在跳过名单里 →
   一放行新文件，asar 立刻从 85MB 涨到 **1764.6MB**。已加入 \`SKIP_DIRS\`。
