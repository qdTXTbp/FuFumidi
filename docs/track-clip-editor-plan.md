# FuFumidi 轨道 + 片段编辑器设计方案 v1

> 借鉴对象：**OpenUTAU**（轨道 / 片段 / 人声编辑轨道）+ **通用 DAW**（音频轨、片段裁剪、混音）
> 目标：把当前「单一音符序列」的工作台，升级为「多轨道 · 片段化 · 可局部渲染」的编曲式编辑器
> 状态：**设计稿，待确认后实施**（本文不含已落地代码）

---

## 1. 为什么要改

现状（`ViewDiffSinger.vue` / `stores/diffsinger.ts`）：

- 一个工程 = **一条** 音符序列（`notes[]`）+ 一个声库 + 一个 BPM；
- 只能整曲渲染，或按「拍位区间」渲染（`rangeStartBeat/rangeEndBeat`）；
- 没有轨道、没有片段，无法把「人声」和「伴奏/音频」放在一起编辑。

用户诉求：

1. 像编曲软件一样**管理轨道**；
2. 轨道上**创建片段（Clip）**；
3. 轨道类型区分**音频轨**与**人声轨（AI 人声编辑轨）**；
4. 支持**渲染单个音符**；
5. **选中范围后右键**→ 渲染范围内所有音符。

---

## 2. 核心概念

| 概念 | 说明 | 对应 OpenUTAU |
|---|---|---|
| Project（工程） | 顶层容器：BPM / 拍号 / 轨道列表 | `.ustx` |
| Track（轨道） | 一条横向泳道，有类型（voice / audio / instrument）、音量、静音、独奏 | `UTrack` |
| Clip（片段） | 轨道上的一块矩形，有起点 / 长度 / 内容偏移 | `UPart` |
| VoiceClip（人声片段） | 内容 = 音符序列 + 音高曲线 + 声库绑定，**是当前钢琴卷帘的宿主** | `UVoicePart` |
| AudioClip（音频片段） | 内容 = 一个 WAV/MP3 源 + 增益 + 淡入淡出 + 波形缩略 | `UWavePart` |

**轨道类型**

| kind | 中文名 | 内容 | 可渲染 |
|---|---|---|---|
| `voice` | 人声轨（AI 人声编辑轨） | VoiceClip（音符） | ✅ 走 DiffSinger / UTAU 引擎 |
| `audio` | 音频轨 | AudioClip（波形） | ❌ 只播放 / 只混音 |
| `instrument` | 乐器轨（可选，P2） | MidiClip（音符，走 SoundFont） | ✅ 走 sf2 渲染 |

---

## 3. 数据模型

新增 `frontend/src/core/project.ts`（纯数据 + 迁移函数，可单测）：

```ts
export type TrackKind = 'voice' | 'audio' | 'instrument';

export interface Project {
  id: string;
  name: string;
  bpm: number;
  tpb: number;                 // ticks per beat（沿用 MIDI 概念，默认 480）
  sig: { num: number; den: number };
  tracks: Track[];
  schemaVersion: number;       // = 2；用于旧工程迁移
}

export interface TrackBase {
  id: string;
  kind: TrackKind;
  name: string;
  color: string;
  muted: boolean;
  soloed: boolean;
  volume: number;              // 0..1
  pan: number;                 // -1..1
  clips: Clip[];
}

export interface VoiceTrack extends TrackBase {
  kind: 'voice';
  engine: 'diffsinger' | 'utau';
  voicebankDir: string;
  device: 'auto' | 'cpu' | 'cuda' | 'dml';
}

export interface AudioTrack extends TrackBase { kind: 'audio'; }

export interface ClipBase {
  id: string;
  trackId: string;
  name: string;
  startBeat: number;           // 时间轴起点
  lengthBeat: number;          // 显示长度
  contentOffsetBeat: number;   // 内容裁切偏移（左裁）
  color?: string;
}

export interface VoiceClip extends ClipBase {
  kind: 'voice';
  notes: DsNote[];             // 复用 stores/diffsinger.ts 的 DsNote
  pitchCurve: { beat: number; cents: number }[];   // 拍坐标（相对片段起点）
  rendered?: {                 // 渲染缓存（P4）
    revision: number;          // 内容版本号，内容变则 +1
    wavRef: string;            // 缓存文件引用
    durationMs: number;
  };
}

export interface AudioClip extends ClipBase {
  kind: 'audio';
  sourceName: string;
  sourceRef: string;           // 磁盘路径 / IndexedDB 键 / 曲库 songId
  durationSec: number;
  gain: number;                // 0..2
  fadeInBeat: number;
  fadeOutBeat: number;
  waveform?: number[];         // 峰值缩略（预计算，绘制用）
}

export type Clip = VoiceClip | AudioClip | MidiClip;
```

> **关键设计**：`VoiceClip.notes` 直接复用现有 `DsNote` 结构，`DiffsingerRender` 的 payload（`startBeat/durBeat/pitch/lyric/vibrato/...`）**完全不用改**。

---

## 4. 旧工程迁移（向后兼容）

现有 localStorage 键：`fufumidi_diffsinger_project_v1`。

迁移规则（`migrateProject()`）：

```
旧：{ bpm, voicebankDir, notes[], pitchCurve[] }
新：{
  bpm, tpb: 480, sig: {4,4}, schemaVersion: 2,
  tracks: [{
    kind: 'voice', engine: 'diffsinger', voicebankDir,
    clips: [{ kind: 'voice', startBeat: 0,
              lengthBeat: ceil(totalBeats)+4,
              notes, pitchCurve }]
  }]
}
```

- 迁移在 `store.init()` 中一次性执行，结果写回新键 `fufumidi_project_v2`；
- 旧键**保留不删**，作为回滚兜底；
- 任何缺失字段按默认值补齐（增量字段全部可选，老工程不炸）。

---

## 5. UI 结构

```
┌─────────────────────────────────────────────────────────────┐
│ 工具栏：BPM · 拍号 · 添加轨道▾ · 吸附 · 缩放 · 播放          │
├──────────┬──────────────────────────────────────────────────┤
│ 轨道头    │ 时间轴（小节 / 拍网格 + 播放头）                  │
│          │                                                  │
│ ● 人声1   │        ┌──────────┐    ┌────────┐               │
│  M S 🔊   │        │ VoiceClip│    │VoiceClip│              │
│  [声库]   │        └──────────┘    └────────┘               │
│          │                                                  │
│ ● 伴奏    │  ┌───────────────────────────────────┐          │
│  M S 🔊   │  │ AudioClip（波形缩略）              │          │
│          │  └───────────────────────────────────┘          │
├──────────┴──────────────────────────────────────────────────┤
│ 双击 VoiceClip → 打开钢琴卷帘（复用 PianoRoll.vue）           │
│ 右键 Clip → 渲染片段 / 渲染选中范围 / 重命名 / 裁剪 / 删除     │
└─────────────────────────────────────────────────────────────┘
```

**组件拆分**（`frontend/src/components/arrange/`）

| 组件 | 职责 |
|---|---|
| `ArrangeView.vue` | 编排视图骨架：轨道列表 + 时间轴滚动同步 |
| `TrackHeader.vue` | 单条轨道头：名称 / 类型图标 / M S / 音量 / 声库选择 |
| `ClipLane.vue` | 单条轨道的内容容器，负责 Clip 的命中、拖动、裁剪手柄 |
| `ClipBlock.vue` | 单个 Clip 的渲染（人声=音符缩略，音频=波形缩略） |
| `TimelineRuler.vue` | 顶部小节 / 拍标尺 + 播放头 + 框选范围 |

**复用**：`PianoRoll.vue` 保持不变，仅新增一个「宿主」层——双击 VoiceClip 时把它作为编辑目标，`rollApi` 直接读写该 Clip 的 `notes`。

---

## 6. 渲染粒度（本文的重点诉求）

需求：**单音符渲染** + **选中范围右键渲染**。

统一走一个 `renderTarget` 抽象：

```ts
type RenderTarget =
  | { kind: 'project' }                                   // 整工程
  | { kind: 'track';   trackId: string }                  // 整轨
  | { kind: 'clip';    clipId: string }                   // 整片段
  | { kind: 'range';   clipId: string; from: number; to: number }  // 片段内拍区间（框选范围）
  | { kind: 'notes';   clipId: string; noteIds: string[] };        // 指定音符（含单个）
```

**映射到现有引擎**（无需改引擎）：

| RenderTarget | 传给 `diffsinger:render` 的 payload |
|---|---|
| `project` | 汇总所有 voice 轨的 notes，按时间轴合并 |
| `track` / `clip` | 该 clip 的 notes，`range = null` |
| `range` | 该 clip 的 notes，`range = { startBeat: from, endBeat: to, contextSec: 0.5 }` |
| `notes` | **只取选中音符**，时间轴平移到 0，`range = null` |

> `notes` 模式即「渲染单个音符 / 渲染所选音符」：前端先筛出目标音符、整体减去最早起点，再交给引擎；渲染完在界面按原始拍位定位播放。

**右键菜单**（`ClipLane.vue` / `PianoRoll.vue` 共用一套动作）

```
右键（在片段上）           右键（在钢琴卷帘框选后）
├ 渲染整个片段             ├ 渲染选中音符（N 个）
├ 渲染选中范围…            ├ 渲染单个音符   ← 命中 1 个时显示
├ 从选中音符建立新片段      ├ 仅试听选中音符
├ 重命名                   ├ 编辑歌词
├ 裁剪到选区               ├ 删除
├ 分裂（在播放头处）        └ 撤销 / 重做
└ 删除
```

**渲染缓存**（P4）

- `VoiceClip.rendered.revision` 在音符 / 音高曲线 / 声库 / BPM 变化时 `+1`；
- 渲染前比较 revision，命中缓存直接复用 WAV，避免重复推理；
- 缓存文件落在数据根目录的 `cache/arrange/<clipId>-<rev>.wav`。

---

## 7. 与现有模块的衔接

| 现有模块 | 变更 |
|---|---|
| `stores/diffsinger.ts` | 从「管理 notes」升级为「管理 project.tracks/activeClip」；保留 notes 相关 action 作为 `activeClip.notes` 的代理 |
| `stores/utau.ts` | 同上（UTAU 轨复用同一 Track 模型，`engine: 'utau'`） |
| `PianoRoll.vue` | **不改**，通过 `rollApi` 适配器接 activeClip |
| `main/diffsinger.js` · `diffsinger:render` | **不改**（已经支持 notes + range） |
| `main/utau.js` · `utau:renderTrack` | **不改** |
| 新增 `main/arrange.js` | 混音导出：把多条轨的渲染 WAV 按时间轴叠加写成一个 WAV |
| 新增 `stores/project.ts` | 工程级状态（轨道 / 片段 / 选中 / 播放头），DiffSinger 与 UTAU 共用 |

---

## 8. 分期实施

| 阶段 | 内容 | 产出 | 风险 |
|---|---|---|---|
| **P1 数据模型** | `core/project.ts` + 迁移 + store 改造（单轨单片段） | 旧工程无感升级，界面不变 | 中 |
| **P2 编排外壳** | 轨道头 + Clip 时间轴（只读展示 + 拖动/裁剪） | 能看到多轨多片段 | 中 |
| **P3 片段编辑** | 双击 VoiceClip → PianoRoll 编辑该片段 | 人声编辑闭环 | 低 |
| **P4 渲染粒度** | RenderTarget 抽象 + 右键菜单 + 渲染缓存 | 单音符 / 范围渲染上线 | 低 |
| **P5 音频轨** | 导入音频 → AudioClip + 波形缩略 | 人声 + 伴奏同轨编辑 | 中 |
| **P6 混音导出** | `main/arrange.js` 多轨叠加导出 | 一键出成品 | 高（相位/削波） |

**建议先做 P4**：它不依赖轨道模型，可以直接在当前单序列界面上先落地「渲染单个音符」和「框选范围右键渲染」，快速满足最痛的编辑体验，再回头做 P1/P2 的轨道重构。

---

## 9. 验收标准

- 旧工程打开后自动迁移，音符 / 音高曲线 / 声库全部保留；
- 可新建 `voice` 与 `audio` 两类轨道，轨道可静音 / 独奏 / 调音量；
- 轨道上可创建、拖动、裁剪、分裂、删除片段；
- 双击 VoiceClip 进入钢琴卷帘，编辑即写回该片段；
- 右键可「渲染单个音符」「渲染选中范围」，且试听结果与整曲渲染对应区间一致；
- 选区内音符 → 渲染结果的时间轴与原工程对齐（不整体偏移）。

---

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 轨道重构触碰现有 DiffSinger/UTAU 工作台 | 高 | P1 阶段保持「单轨单片段」形态，界面零变化，先只换存储；每阶段独立开关 |
| 迁移丢数据 | 高 | 迁移前备份旧键；迁移函数可单测；旧键不删 |
| 多轨混音削波 / 相位问题 | 中 | 导出前做峰值归一 + 可选限幅；先只做「对轨叠加」不做自动母带 |
| 音频片段波形缩略内存占用 | 低 | 预计算固定长度峰值数组（如 2000 点），按需生成 |
| 渲染缓存与内容不一致 | 中 | 用 revision 号做强校验，revision 不符一律重渲染 |

---

## 11. 待确认项

1. **轨道类型**：除 `voice` / `audio` 外，是否需要 `instrument`（SoundFont 乐器轨）？
2. **片段与音符的边界**：片段是「音符的容器」还是「独立于音符的时间窗口」？本方案取前者（音符归属片段）。
3. **音频轨**的音频来源：曲库曲目 / 本地文件 / 渲染产物，三者是否都要支持？
4. **混音导出**是否本期就做，还是先只做「渲染 → 试听」？
