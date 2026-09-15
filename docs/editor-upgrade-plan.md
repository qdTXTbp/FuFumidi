# FuFumidi 编辑器升级方案 v1

> 借鉴对象：**Synthesizer V Studio 2 Pro**（逐音符深度编辑）与 **Studio One Pro / Fender Studio Pro**（整体编辑工作流）
> 目标：补齐 FuFumidi 在「MIDI 编辑器 / UTAU 歌声编辑 / 播放器」三条线上的编辑能力
> 说明：本文只列**已具备可行落地路径**的项；每项给出数据模型、改动文件与验收标准

---

## 1. 现状盘点（升级基线）

| 模块 | 文件 | 已有能力 |
|---|---|---|
| 钢琴卷帘 | `frontend/src/components/EditorCanvas.vue` | 工具（pencil/erase/select）、吸附 `snapTick`、**`scaleSnapPitch`（音阶吸附雏形）**、撤销/重做、`addNote/deleteNotes/moveNotes/quantize/transpose/velRamp`、`selectSamePitch/copy/paste/duplicate`、**CC 轨道**（`drawCC/ccDown/ccPaint`、`ccNumber`）、幽灵选择提示 |
| 编辑页 | `frontend/src/views/ViewEdit.vue` | 量化、力度曲线弹窗、列表编辑器、CC1/CC2 双轨、**演奏法映射表**（`spitfire/vsl/eastwest` → CC 值与技法名）、智能量化+Groove、**逻辑编辑器**、**宏**（`core/macro.js`、`recordCmd`、自定义宏）、智能伴奏、鼓轨 |
| UTAU 曲谱 | `frontend/src/components/utau/UtauScore.vue` | canvas 卷帘（`pencil/select`、`snap`、播放光标、剪贴板、右键菜单） |
| UTAU 数据 | `frontend/src/stores/utau.ts` | `UtauNote{ startBeat,durBeat,pitch,lyric,velocity,volume,vibrato,vibDepth,vibFreq,flags }`；`flags` 注释为「预留，引擎后续支持」 |
| UTAU 引擎 | `engine/engine_utau.py` | oto.ini 解析、采样变调/重采样、zero crossing、`_fade_tail`、`_envelope`、**`_apply_vibrato`**、**`_stretch_vowel`** |
| 分析 | `frontend/src/core/analysis.js` | `detectChords`（已扩展为 11 类和弦 + 转位 + 置信门槛） |
| 乐谱 | `frontend/src/views/ViewScore.vue` | Verovio 刻版、指纹复用 |

**结论**：主编辑器底子好（CC/宏/量化已在），主要缺口是 ①调内编辑的完整闭环 ②UTAU 的逐音符参数编辑与音高曲线 ③整体工作流（三视图/和弦轨/编排）。

---

## 2. 可借鉴项总表

| 编号 | 借鉴项 | 来源 | 优先级 | 主要改动面 |
|---|---|---|---|---|
| P0-1 | 调内编辑（音阶高亮 + 约束 + 移动跟随） | Studio One | P0 | `EditorCanvas.vue` + `core/scale.js`(新) |
| P0-2 | 默认力度 / 音符着色方案 / 静音工具 | Studio One | P0 | `EditorCanvas.vue` |
| P0-3 | UTAU 逐音符参数车道（pitch/gender/breath/volume/vib） | SynthV | P0 | `UtauScore.vue` + `stores/utau.ts` + `engine_utau.py` |
| P1-1 | 音高曲线手绘（控制点 + 曲线，与自动结果共存） | SynthV | P1 | 新组件 + `stores/utau.ts` + 引擎 |
| P1-2 | 和弦轨（Chord Track） | Studio One + 已有分析 | P1 | `ViewEdit.vue` + `core/analysis.js` |
| P1-3 | 演奏法库（Sound Variations 式，可编辑条目） | Studio One | P1 | `ViewEdit.vue`（现有映射表升级） |
| P1-4 | 音素/发音编辑（含音素时值） | SynthV | P1 | `UtauScore.vue` + `engine_utau.py` |
| P1-5 | 一键重置（可预测性） | SynthV | P1 | 右键菜单 |
| P2-1 | 统一编辑器三视图（钢琴/鼓组/乐谱） | Studio One | P2 | `ViewEdit.vue` + `ViewScore.vue` |
| P2-2 | 编排轨 + 草稿区 | Studio One | P2 | 新面板 |
| P2-3 | 编辑组 / 宏可视化 | Studio One | P2 | `ViewEdit.vue` + `core/macro.js` |
| P2-4 | Launcher（Cells/Scenes/Playlists） | Studio One | P2 | 演奏页扩展 |
| P2-5 | 演绎式风格档位（2D 控件代多参数） | SynthV | P2 | UTAU 面板 |

---

## 3. 分期实施（含实现路径）

### P0-1 调内编辑（音阶约束闭环）

**借鉴**：Studio One 的 Scale Panel / 用户自定义音阶 / Filter Notes to Scale / 移动跟随音阶

**数据模型**
```ts
// frontend/src/core/scale.js（新增）
export interface ScaleSpec {
  root: number;                       // 0-11
  type: 'major'|'minor'|'dorian'|'mixolydian'|'lydian'|'locrian'|'pentatonic'|'custom';
  custom?: number[];                  // 自定义音级（半音偏移）
}
export function scalePitches(s: ScaleSpec): Set<number>;      // 返回 0-11 调内音级
export function snapToScale(midi: number, s: ScaleSpec): number;
```

**实现路径**
1. `core/scale.js`：音阶表 + `snapToScale` 纯函数（可单测）
2. `EditorCanvas.vue`：
   - 新增 `props.scaleSpec`、`props.scaleMode`（'off' | 'highlight' | 'constrain'）
   - `draw()`：`scaleMode !== 'off'` 时高亮调内音行（背景色带）
   - 现有 `scaleSnapPitch()` 改为：`scaleMode === 'constrain'` 才吸附，否则原逻辑
   - `moveNotes()`：拖动结束时若开启约束，逐音 `snapToScale`
3. `ViewEdit.vue`：工具栏加「音阶」选择器（含"自定义音阶"编辑弹窗），持久化 `localStorage['fufumidi_scale']`
4. 复用：`core/analysis.js` 已能给出调性（`rootPc`/`mode`）→ 提供「按分析结果自动设调」

**验收**
- `scaleMode='highlight'`：调内音行高亮
- `scaleMode='constrain'`：拖拽/新建音符只落在调内音；关闭后恢复自由
- 自定义音阶可保存/复用

---

### P0-2 默认力度 / 着色方案 / 静音工具

**借鉴**：Studio One 的默认力度、4 种音符着色、静音工具（快捷键 5）

**实现路径**
1. `EditorCanvas.vue`
   - `addNote()` 当前硬编码 `vel: 80` → 改用 `props.defaultVelocity`
   - `noteColor(i)` 改为按 `props.colorMode` 分派：`'track' | 'pitch' | 'velocity' | 'selection'`
   - 新增 `tool === 'mute'` 分支：点击切换 `note.muted`；`draw()` 对 muted 音符以 40% 透明度绘制
   - 播放器（`core/synth.js` 调度处）跳过 `muted` 音符；导出时可选「是否保留静音音符」
2. `ViewEdit.vue`：工具栏加入「默认力度」数字框、「着色」下拉、「静音」工具按钮，状态存 `localStorage['fufumidi_edit_prefs']`

**验收**：新建音符力度符合默认值；四种着色可切；静音音符不发声且半透明显示

---

### P0-3 UTAU 逐音符参数车道

**借鉴**：SynthV 的参数面板自动化（响度/张力/气声/性别/音高偏差）+ 参数车道

**数据模型**（`stores/utau.ts`）
```ts
export interface UtauNote {
  /* 现有字段保持不变 */
  params?: { pitch?: number; gender?: number; breath?: number; volume?: number; vibDepth?: number };
  muted?: boolean;
}
```

**实现路径**
1. `UtauScore.vue`：底部新增**参数车道**（复用 `EditorCanvas` 的 CC lane 交互思路）
   - `paramLaneMode: 'pitch'|'gender'|'breath'|'volume'|'vibDepth'|'none'`
   - 车道显示：以音符为单位的折线/柱状；拖动改值；框选批量设值
2. `stores/utau.ts`：`setParam(noteId, key, value)`、`setParamsForSelection(key, value)`；并入 undo/redo 栈
3. `engine_utau.py`：
   - 渲染入口接收 `params`：`render_note(..., params)`（签名已在调用链中，按需透传）
   - `pitch`：与 `note_to_hz` 结果叠加（音分偏移）
   - `vibDepth`：复用 `_apply_vibrato(x, sr, vib)` 的深度参数
   - `gender`：实现 `_apply_gender(x, sr, v)`（共振峰移位；可先用重采样 + 频谱搬移近似）
   - `breath`：实现 `_apply_breath(x, sr, v)`（混入带通噪声，高通 + 包络跟随）
4. 参数透传白名单：`main/engine.js` 的 `map` + `engine/music2midi.py` 的 `_resolve_params`

**验收**
- 改 gender 曲线后渲染音色可听辨变化
- 改 vibDepth 只影响颤音深度
- `pitch` 偏移不破坏音节边界（oto 拼接正常）

---

### P1-1 音高曲线手绘（控制点 + 曲线）

**借鉴**：SynthV 的 Smart Pitch Control（**AI 结果与手绘共存**，而非覆盖）

**数据模型**
```ts
pitchCurve?: { beat: number; cents: number }[];   // 归一化音高曲线（音分偏移）
```

**实现路径**
1. 新增共享组件 `frontend/src/components/PitchCurveLane.vue`（EditorCanvas 与 UtauScore 复用）
   - 两种子模式：`points`（拖控制点）/ `curve`（自由绘制）
2. `stores/utau.ts` 增加 `setPitchCurve(id, points)`、`clearPitchCurve(id)`
3. 引擎：`pitchCurve` 重采样为逐样本音高偏移，叠加到 `_pitch_resample` 的目标比率上
4. 渲染叠加顺序：`音符基频 → pitch 参数 → pitchCurve → vibrato`

**验收**：手绘曲线后渲染音高跟随；清空曲线回到自动结果；撤销可回退

---

### P1-2 和弦轨（Chord Track）

**借鉴**：Studio One Chord Track + 项目已有 `detectChords`

**实现路径**
1. `core/analysis.js`：`detectChords` 输出已含 `{name, root, suffix, bass, bars}` → 直接作为和弦轨初值
2. `ViewEdit.vue`：时间线上方新增**和弦轨**（只读展示 + 可手动覆盖某小节）
3. 联动：开启「约束到和弦音」时，`EditorCanvas` 的约束集合改为「当前小节和弦音 ∪ 音阶」
4. 可选增强：一键「按和弦轨生成伴奏」（复用现有「智能伴奏」逻辑）

**验收**：和弦轨显示与分析一致；可手动改某小节；约束模式下拖拽只落在和弦音

---

### P1-3 演奏法库（Sound Variations 式）

**借鉴**：Studio One Sound Variations

**现状**：`ViewEdit.vue` 已有 `spitfire/vsl/eastwest` 三张 CC→技法名映射表（硬编码）

**实现路径**
1. 抽出 `frontend/src/core/articulations.js`：内置三套 + 用户自定义（`localStorage['fufumidi_articulations']`）
2. `ViewEdit.vue`：演奏法选择器改为读取该库；支持「按音轨绑定」（记录在 track 上）
3. UTAU 侧映射：把技法库的等价项映射到 `UtauNote.flags`（当前为预留字段）

**验收**：可新增/编辑技法条目；选择技法后写入对应 CC 值；重启后保留

---

### P1-4 音素 / 发音编辑（UTAU）

**借鉴**：SynthV 的音素编辑 + 音素时值面板 + "按音符时长均匀分配音节"

**实现路径**
1. `engine_utau.py`：暴露「别名候选」查询（基于已解析的 `by_alias`）
2. `UtauScore.vue`：音符上方显示音素（由 lyric 经别名解析得到）；可切换候选别名
3. 多音节音符：新增「均匀分配元音时长」开关（引擎侧复用 `_stretch_vowel`）
4. 新增「音素时值」子面板：逐音素调时长/力度（先支持时长）

**验收**：可换别名并立即重渲染；开启均匀分配后元音时长一致

---

### P1-5 一键重置（可预测性）

**借鉴**：SynthV「重置音高」一次清空所有音高相关编辑

**实现路径**：`EditorCanvas.vue` / `UtauScore.vue` 右键菜单新增
- 「重置音高」：清 `pitchCurve` + `params.pitch` + `vibDepth`/`vibrato`
- 「重置全部参数」：清所有 `params`

**验收**：重置后回到自动/默认结果，且可撤销

---

### P2 组（工作流层）

| 编号 | 项 | 实现要点 |
|---|---|---|
| P2-1 | 三视图统一 | `ViewEdit.vue` 内加视图切换（钢琴 / 鼓组 / 乐谱），乐谱复用 `ViewScore.vue` 的 Verovio 组件化封装 |
| P2-2 | 编排轨 + 草稿区 | 新面板：段落标记（Intro/A/B…）+ 草稿缓冲区（不影响主工程） |
| P2-3 | 编辑组 / 宏可视化 | 多轨联动选中；宏从"脚本文本"升级为"命令序列可视化编辑"（`core/macro.js` 已能解析） |
| P2-4 | Launcher | 演奏页扩展：Cells → Scenes → Playlists，支持循环触发 |
| P2-5 | 演绎式风格档位 | UTAU 用一个 2D 控件（稳定 ↔ 原生）映射到 `vibrato/vibDepth/tension` 组合 |

---

## 4. 信息来源

**Synthesizer V Studio 2 Pro（官方手册）**
- 钢琴卷帘：https://sv2.docs.dreamtonics.com/zh/pianoroll
- 音符面板（演绎/AI 重录/颤音/语言/音素）：https://sv2.docs.dreamtonics.com/zh/notes-panel
- 音高编辑（智能音高控制/重置/Smart Pitch Control）：https://sv2.docs.dreamtonics.com/zh/pitch
- 基本参数编辑（响度/张力/气声/性别/声区/音高偏差/颤音包络/发声/口型）：https://sv2.docs.dreamtonics.com/zh/parameters
- 用户手册主页：https://sv2.docs.dreamtonics.com/zh/home

**Studio One Pro / Fender Studio Pro（官方）**
- Features（v7 新特性）：https://www.presonus.com/pages/studio-one-pro-features
- 用户手册 v7.2（Note Editor / Sound Variations / Patterns / Score Editor / Automation / Arranger & Chord Track / Launcher）：https://pae-web.presonusmusic.com/downloads/products/pdf/UM_Studio-One-Pro_EN.pdf
- 7.1 Release Notes（Scale Panel / 用户音阶 / Filter Notes to Scale / 移动跟随音阶）：https://www.fmicassets.com/sites/presonus.com/img/misc/Studio-One-7-1-0_Release-Notes.pdf
- 中文功能介绍（钢琴卷帘工具 1–6 / 三视图 / 量化吸附 / 默认力度）：https://www.studioonechina.cn/normalfaq/so-tnseoc.html
- Fender Studio Pro 8 新功能（Launcher / 场景播放列表 / 全局移调 / AI 分轨）：https://www.studioonechina.cn/chanpin.html

---

## 5. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 改动 `EditorCanvas.vue`（编辑器核心）引入回归 | 高 | 每项独立开关（props 默认关闭）；配套 CDP 回归脚本（路由 + 编辑 + 乐谱切换） |
| `gender`/`breath` 需 DSP 实现 | 中高 | 先做近似实现（共振峰重采样 / 带通噪声），参数通道先跑通再迭代音质 |
| 音高曲线与 oto 拼接冲突 | 中 | 曲线作用于「拼接后」整音节，不参与 oto 边界计算 |
| 参数数据量增大影响持久化 | 低 | 参数以「非默认值才写入」的稀疏结构存 |
| 自定义音阶/演奏法库的兼容性 | 低 | 新增字段全部可选，旧工程按默认值解析 |

---

## 6. 建议落地顺序

1. **P0-2**（默认力度/着色/静音）—— 纯前端、零引擎改动，最快见效
2. **P0-1**（调内编辑）—— 同样纯前端，但与 `analysis.js` 联动，价值高
3. **P0-3**（UTAU 参数车道）—— 数据 + UI + 引擎三段，建议先只做 `volume/vibDepth/pitch`（引擎已支持），再补 `gender/breath`
4. **P1-1 → P1-4 → P1-5**（音高曲线 → 音素 → 重置）
5. **P1-2 / P1-3**（和弦轨 / 演奏法库）可并行
6. **P2** 按产品节奏排期
